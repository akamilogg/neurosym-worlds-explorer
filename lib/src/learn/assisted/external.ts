import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { stableStringify } from '../../core/hash.ts';

/* ============================================================================
 * EXTERNAL RESEARCH (SPEC-INVESTIGACION-EXTERNA §4, §5.2, §9, IE1): its configuration, who may read what on the web, and
 * how a page is acquired - each hop checked, each attempt counted, the bytes bounded - as one envelope the run's log keeps.
 *
 *   external-research@1   the operator's file (--external-research): the search provider, the web's access (`allowlist`
 *                         by default; `public` only written expressly), the bags (searches, fetches, bytes), the branches'.
 *   web-acquisition@1     what one `open` of a URL did: its redirects, its attempts, its status, its content type and its
 *                         body (whole, or cut at its bound and said so). Logged by the run's replay (channel "web"): a
 *                         resumed run is served the same acquisition and never asks the network again.
 *
 * Nothing here judges a document: it keeps what was read, where from, and at what cost.
 * ========================================================================== */

export interface ExternalBudget { readonly search_calls: number; readonly fetch_calls: number; readonly download_bytes: number }

export interface ExternalResearchConfig {
  readonly format: 'external-research@1';
  readonly search: { readonly provider: string; readonly max_results: number } | null;
  readonly web: { readonly access: 'allowlist' | 'public'; readonly allow: readonly string[]; readonly deny: readonly string[]; readonly max_document_bytes: number };
  readonly budget: ExternalBudget;
  readonly branches: { readonly inherit_sources: boolean; readonly budget: ExternalBudget | null };
  readonly execution: { readonly profiles: readonly unknown[] };
}

const PROVIDERS = new Set(['brave', 'fake']);
const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && Number.isFinite(n);
const isUrlPrefix = (s: string): boolean => /^https?:\/\/[^/\s]+/i.test(s);
const isDomain = (s: string): boolean => /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(s);

function budgetProblems(b: unknown, at: string): string[] {
  if (!b || typeof b !== 'object') return ['"' + at + '": {"search_calls", "fetch_calls", "download_bytes"}'];
  const p: string[] = [];
  for (const k of ['search_calls', 'fetch_calls', 'download_bytes'] as const) if (!isCount((b as Record<string, unknown>)[k])) p.push('"' + at + '.' + k + '": a whole number, 0 or more (0 disables it)');
  for (const k of Object.keys(b)) if (!['search_calls', 'fetch_calls', 'download_bytes'].includes(k)) p.push('"' + at + '.' + k + '": unknown');
  return p;
}

/** What is wrong with an external-research@1 configuration (empty when nothing). */
export function externalConfigProblems(raw: unknown): string[] {
  const c = raw as Record<string, any>;
  if (!c || typeof c !== 'object' || c.format !== 'external-research@1') return ['"format": "external-research@1"'];
  const p: string[] = [];
  for (const k of Object.keys(c)) if (!['format', 'search', 'web', 'budget', 'branches', 'execution'].includes(k)) p.push('"' + k + '": unknown');
  if (c.search !== undefined && c.search !== null) {
    if (typeof c.search !== 'object' || !PROVIDERS.has(c.search.provider)) p.push('"search.provider": brave (or fake, for tests)');
    if (!(Number.isInteger(c.search?.max_results) && c.search.max_results >= 1 && c.search.max_results <= 20)) p.push('"search.max_results": 1 to 20');
  }
  const w = c.web ?? {};
  if (typeof w !== 'object') p.push('"web": {"access", "allow", "deny", "max_document_bytes"}');
  if (w.access !== undefined && w.access !== 'allowlist' && w.access !== 'public') p.push('"web.access": "allowlist" (the default) or "public", written expressly');
  for (const k of ['allow', 'deny'] as const) {
    if (w[k] === undefined) continue;
    if (!Array.isArray(w[k]) || !w[k].every((x: unknown) => typeof x === 'string' && (isUrlPrefix(x) || isDomain(x)))) p.push('"web.' + k + '": domains or URL prefixes (https://...)');
  }
  if (w.max_document_bytes !== undefined && !(isCount(w.max_document_bytes) && w.max_document_bytes > 0)) p.push('"web.max_document_bytes": a whole number above 0');
  p.push(...budgetProblems(c.budget, 'budget'));
  if (c.branches !== undefined) {
    if (typeof c.branches !== 'object' || (c.branches.inherit_sources !== undefined && typeof c.branches.inherit_sources !== 'boolean')) p.push('"branches.inherit_sources": true or false');
    if (c.branches?.budget !== undefined && c.branches.budget !== null) p.push(...budgetProblems(c.branches.budget, 'branches.budget'));
  }
  if (c.execution !== undefined && (typeof c.execution !== 'object' || (c.execution.profiles !== undefined && !Array.isArray(c.execution.profiles)))) p.push('"execution.profiles": a list');
  return p;
}

/** The configuration with its defaults written out: access `allowlist`, nothing allowed, 10 MB a document. */
export function normalizeExternalConfig(raw: unknown): ExternalResearchConfig {
  const problems = externalConfigProblems(raw);
  if (problems.length) throw new Error('the external research configuration: ' + problems.join('; '));
  const c = raw as Record<string, any>;
  return {
    format: 'external-research@1',
    search: c.search ? { provider: c.search.provider, max_results: c.search.max_results } : null,
    web: { access: c.web?.access === 'public' ? 'public' : 'allowlist', allow: [...(c.web?.allow ?? [])], deny: [...(c.web?.deny ?? [])], max_document_bytes: c.web?.max_document_bytes ?? 10 * 1024 * 1024 },
    budget: { search_calls: c.budget.search_calls, fetch_calls: c.budget.fetch_calls, download_bytes: c.budget.download_bytes },
    branches: { inherit_sources: c.branches?.inherit_sources !== false, budget: c.branches?.budget ? { ...c.branches.budget } : null },
    execution: { profiles: [...(c.execution?.profiles ?? [])] }
  };
}

/** Reads a configuration file. */
export function readExternalConfig(file: string): ExternalResearchConfig {
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error('--external-research: ' + file + ' is not JSON (' + String((e as Error).message ?? e) + ')'); }
  return normalizeExternalConfig(raw);
}

/** Its identity (§4.2): the configuration in force, by hash - part of a run's and a trial's. */
export const externalConfigHash = (c: ExternalResearchConfig): string => createHash('sha256').update(stableStringify(c)).digest('hex');

/* --- Who may read what -------------------------------------------------------------------------------------------- */

const matches = (url: URL, origin: string): boolean => {
  if (isUrlPrefix(origin)) return url.href.startsWith(origin);
  const host = url.hostname.toLowerCase(), o = origin.toLowerCase();
  return host === o || host.endsWith('.' + o);
};

/** Whether a host is one of the machine's, a private network's or an intranet's: never public. */
export function privateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || /\.(local|internal|lan|home|corp|intranet|test|invalid|example)$/.test(h)) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b] = h.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (h.includes(':')) return h === '::' || h === '::1' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('::ffff:');
  return !h.includes('.');
}

export type Permission = { readonly ok: true } | { readonly ok: false; readonly state: 'not_allowed'; readonly why: string; readonly domain: string };

/** Whether the configuration lets a URL be read (each hop of a redirect is asked again): `deny` first; then `public`
    allows any public address, `allowlist` the origins listed. */
export function webPermission(where: string, web: ExternalResearchConfig['web']): Permission {
  let url: URL;
  try { url = new URL(where); } catch { return { ok: false, state: 'not_allowed', why: 'not a URL', domain: '' }; }
  const domain = url.hostname.toLowerCase();
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, state: 'not_allowed', why: 'only web addresses (http, https) are read here', domain };
  if (url.username || url.password) return { ok: false, state: 'not_allowed', why: 'an address with credentials is never read', domain };
  if (web.deny.some((d) => matches(url, d))) return { ok: false, state: 'not_allowed', why: 'the operator denies ' + domain, domain };
  if (web.access === 'public') return privateHost(domain) ? { ok: false, state: 'not_allowed', why: domain + ' is not a public address: the public web never reaches the machine, its network or an intranet', domain } : { ok: true };
  return web.allow.some((a) => matches(url, a)) ? { ok: true }
    : { ok: false, state: 'not_allowed', why: domain + ' is not among the origins the operator allows (the operator may add it)', domain };
}

/* --- Acquiring a page --------------------------------------------------------------------------------------------- */

/** One HTTP request, its redirects never followed by itself: what came, its headers by lower-case name, its body up to
    `maxBytes` (cut there, and said so). */
export type WebTransport = (url: string, o: { readonly signal: AbortSignal; readonly maxBytes: number }) =>
  Promise<{ readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly bytes: Uint8Array; readonly truncated: boolean }>;

/** The transport of the network: fetch without following redirects, the body read up to its bound. */
export const networkTransport: WebTransport = async (url, o) => {
  const r = await fetch(url, { method: 'GET', redirect: 'manual', signal: o.signal, headers: { 'User-Agent': 'research-harness/1 (+external-research@1)', Accept: 'text/html, text/plain, text/markdown, application/pdf;q=0.8, */*;q=0.5' } });
  const headers: Record<string, string> = {};
  r.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  const chunks: Uint8Array[] = [];
  let size = 0, truncated = false;
  if (r.body) {
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.length > o.maxBytes) { chunks.push(value.slice(0, o.maxBytes - size)); size = o.maxBytes; truncated = true; await reader.cancel(); break; }
      chunks.push(value); size += value.length;
    }
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.length; }
  return { status: r.status, headers, bytes, truncated };
};

export interface Attempt { readonly url: string; readonly status?: number; readonly error?: string; readonly bytes: number; readonly waited_ms?: number }

/** What one `open` of a URL did, kept whole by the run's log. */
export interface Acquisition {
  readonly format: 'web-acquisition@1';
  readonly requested: string;
  readonly final: string;
  readonly redirects: readonly { readonly from: string; readonly to: string; readonly status: number }[];
  /** Every HTTP request sent - each one a unit of `fetch_calls`, failed or not. */
  readonly attempts: readonly Attempt[];
  readonly state: 'acquired' | 'not_allowed' | 'http_error' | 'network_error' | 'budget_exhausted' | 'too_many_redirects';
  readonly status: number | null;
  readonly content_type: string | null;
  readonly truncated: boolean;
  /** The body, base64 (what was received, up to its bound). */
  readonly body_b64: string | null;
  readonly why?: string;
  readonly domain?: string;
  readonly retrieved: string;
}

const TRANSIENT = (s: number): boolean => s === 408 || s === 425 || s === 429 || s >= 500;
const REDIRECT = (s: number): boolean => [301, 302, 303, 307, 308].includes(s);

/** Acquires a URL: each hop's permission asked again, each request sent counted, at most `maxSends` of them (the bag's
    rest), transient failures tried again at most twice (Retry-After respected within `maxWaitMs`), the body bounded by
    `maxBytes`. Never throws: what happened is the envelope. */
export async function acquire(requested: string, o: { readonly transport: WebTransport; readonly permit: (url: string) => Permission; readonly maxSends: number; readonly maxBytes: number;
  readonly signal?: AbortSignal; readonly maxWaitMs?: number; readonly now?: () => Date; readonly sleep?: (ms: number) => Promise<void> }): Promise<Acquisition> {
  const now = o.now ?? (() => new Date());
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts: Attempt[] = [];
  const redirects: { from: string; to: string; status: number }[] = [];
  const base = { format: 'web-acquisition@1' as const, requested, redirects, attempts, retrieved: now().toISOString() };
  const ended = (x: Partial<Acquisition> & Pick<Acquisition, 'state'>, final: string): Acquisition => ({ ...base, final, status: null, content_type: null, truncated: false, body_b64: null, ...x });
  let url = requested;
  let waited = 0;
  for (let hop = 0; hop <= 5; hop++) {
    const allowed = o.permit(url);
    if (!allowed.ok) return ended({ state: 'not_allowed', why: allowed.why, domain: allowed.domain }, url);
    let tries = 0;
    for (;;) {
      if (attempts.length >= o.maxSends) return ended({ state: 'budget_exhausted', why: 'no fetches left in the bag (fetch_calls)' }, url);
      tries++;
      let r: Awaited<ReturnType<WebTransport>>;
      try {
        r = await o.transport(url, { signal: o.signal ?? AbortSignal.timeout(60_000), maxBytes: o.maxBytes });
      } catch (e) {
        attempts.push({ url, error: String((e as Error)?.message ?? e).slice(0, 200), bytes: 0 });
        if (tries < 3) { await sleep(Math.min(1000 * tries, Math.max(0, (o.maxWaitMs ?? 20_000) - waited))); continue; }
        return ended({ state: 'network_error', why: attempts[attempts.length - 1].error }, url);
      }
      const attempt: Attempt = { url, status: r.status, bytes: r.bytes.length };
      if (TRANSIENT(r.status) && tries < 3) {
        const after = Number(r.headers['retry-after']);
        const wait = Math.min(Number.isFinite(after) ? after * 1000 : 1000 * tries, Math.max(0, (o.maxWaitMs ?? 20_000) - waited));
        attempts.push({ ...attempt, waited_ms: wait });
        waited += wait;
        await sleep(wait);
        continue;
      }
      attempts.push(attempt);
      if (REDIRECT(r.status) && r.headers.location) {
        let to: string;
        try { to = new URL(r.headers.location, url).href; } catch { return ended({ state: 'http_error', status: r.status, why: 'a redirect to no address' }, url); }
        redirects.push({ from: url, to, status: r.status });
        url = to;
        break;
      }
      if (r.status < 200 || r.status >= 300) return ended({ state: 'http_error', status: r.status, why: 'HTTP ' + r.status, content_type: r.headers['content-type'] ?? null }, url);
      return { ...base, final: url, state: 'acquired', status: r.status, content_type: r.headers['content-type'] ?? null, truncated: r.truncated, body_b64: Buffer.from(r.bytes).toString('base64') };
    }
  }
  return ended({ state: 'too_many_redirects', why: 'more than 5 redirects' }, url);
}

/* --- What a document says ----------------------------------------------------------------------------------------- */

export interface Extracted { readonly kind: 'text' | 'html' | 'pdf'; readonly text: string; readonly links: readonly { readonly text: string; readonly url: string }[]; readonly extractor: string; readonly warnings: readonly string[] }

/** An extractor of PDFs the environment declares: its text by page, and its version. Absent: PDFs are `unsupported_media`. */
export type PdfExtractor = (bytes: Uint8Array) => Promise<{ readonly pages: readonly string[]; readonly version: string }>;

const decode = (b: Uint8Array): string => new TextDecoder('utf-8', { fatal: false }).decode(b);
const entities = (s: string): string => s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');

/** The text of an HTML page (scripts and styles left out, blocks as lines) and its links resolved against its final URL. */
export function extractHtml(html: string, final: string): { text: string; links: { text: string; url: string }[] } {
  const links: { text: string; url: string }[] = [];
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!href || /^(javascript|mailto|data):/i.test(href) || href.startsWith('#')) continue;
    let url: string;
    try { url = new URL(entities(href), final).href; } catch { continue; }
    links.push({ text: entities(m[4].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 200), url });
  }
  const text = entities(html.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|pre|blockquote|section|article)>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ').split('\n').map((l) => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text, links };
}

export const EXTRACTOR = 'harness-extract@1';

/** What a body says, by its content type: text and HTML here; a PDF by the environment's extractor, or unsupported. */
export async function extract(bytes: Uint8Array, contentType: string | null, final: string, pdf?: PdfExtractor): Promise<Extracted | { unsupported: string }> {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
  const head = decode(bytes.slice(0, 2048));
  if (type === 'application/pdf' || head.startsWith('%PDF-')) {
    if (!pdf) return { unsupported: 'a PDF, and this environment declares no PDF extractor: look for an HTML version of it' };
    const r = await pdf(bytes);
    return { kind: 'pdf', text: r.pages.map((p, i) => '[page ' + (i + 1) + ']\n' + p).join('\n'), links: [], extractor: 'pdf:' + r.version, warnings: [] };
  }
  if (type === 'text/html' || type === 'application/xhtml+xml' || (!type && /<html|<body|<!doctype html/i.test(head))) {
    const e = extractHtml(decode(bytes), final);
    return { kind: 'html', ...e, extractor: EXTRACTOR, warnings: /<script[^>]*src=|id="(root|app|__next)"/i.test(decode(bytes)) && e.text.length < 200 ? ['the page seems to need a browser to show its text: this reader runs no scripts'] : [] };
  }
  if (!type || type.startsWith('text/') || /json|xml|markdown|yaml|csv/.test(type)) {
    const text = decode(bytes);
    if (/\u0000/.test(text.slice(0, 4096))) return { unsupported: 'binary content (' + (type || 'no content type') + ')' };
    return { kind: 'text', text, links: [], extractor: EXTRACTOR, warnings: [] };
  }
  return { unsupported: type + ' is not read here (text, HTML' + (pdf ? ', PDF' : '') + ')' };
}

/** The environment's PDF extractor (PDF_EXTRACTOR: a command): it reads the PDF on its standard input and writes
    {"pages": ["..."], "version": "..."} on its output. Undefined where the environment declares none. */
export function environmentPdfExtractor(command: string | undefined = process.env.PDF_EXTRACTOR): PdfExtractor | undefined {
  if (!command) return undefined;
  return async (bytes) => {
    const r = spawnSync(command, { input: Buffer.from(bytes), shell: true, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error('the PDF extractor failed: ' + String(r.stderr ?? '').slice(0, 200));
    const out = JSON.parse(String(r.stdout)) as { pages?: unknown; version?: unknown };
    if (!Array.isArray(out.pages) || typeof out.version !== 'string') throw new Error('the PDF extractor answered no {"pages", "version"}');
    return { pages: out.pages.map(String), version: out.version };
  };
}
