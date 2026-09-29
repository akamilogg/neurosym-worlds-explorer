import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import type { FetchLike } from '../../core/net.ts';
import type { Judge } from '../../core/types.ts';

/* ============================================================================
 * SOURCES for the assisted researcher (SPEC-INVESTIGADOR-ASISTIDO §6.3, A6): documents it reads
 * BY ITSELF, where the operator allows.
 *
 * The operator only draws the limits: a list of ORIGINS it may read from (directories, URL
 * prefixes, domains). Nothing is loaded, cut, indexed or checked for it. The researcher has
 * primitive instruments:
 *
 *   {"list": "<origin>"}                          what documents an allowed directory holds
 *   {"open": "<document>", "from": n, "to": n}    lines of a document, read afresh every time
 *   {"find": "words", "in": "<document|origin>"}  the lines that hold all those words
 *   ... "select": "what you need"                 with many lines found, the Judge picks those
 *                                                 that speak to it (at the researcher's choice)
 *
 * Reading again is how it checks a source again: whether a document says the same, what to do
 * when it contradicts the world or another source, is its judgement. What a document says is
 * someone's word, and it may be wrong: the criterion never reads it (P4).
 *
 * Every read goes through the run's log (channel "source"), local files too: a resumed run is
 * answered what the run it resumes read, and from there on it reads live.
 * ========================================================================== */

/** Whether a string names a page on the web. */
export const isUrl = (where: string): boolean => /^https?:\/\//i.test(where);
const isDomain = (s: string): boolean => /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(s);

/** The text of an HTML page, roughly: without scripts, styles and tags. */
export const textOfHtml = (html: string): string => html
  .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  .replace(/[ \t]+/g, ' ').split('\n').map((l) => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();

const TEXT = /\.(md|markdown|txt|text|rst|csv|tsv|json|jsonl|html?|tex|org|adoc|ya?ml|xml)$/i;
const MAX_BYTES = 2 * 1024 * 1024;
const fold = (s: string): string => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
const answer = (ok: boolean, status: number, text: string) => ({ ok, status, text: async () => text, headers: { get: () => null } });

/** How sources are fetched: a page over the network; a file (a file: URL) from the disk, and a directory as the list of
    its text files. The run wraps it with its log, so that every read is recorded. */
export function sourceFetch(network: FetchLike): FetchLike {
  return async (url, init) => {
    if (!url.startsWith('file:')) return network(url, init);
    const at = fileURLToPath(url);
    if (!fs.existsSync(at)) return answer(false, 404, 'no such file or directory');
    if (fs.statSync(at).isDirectory()) {
      const files: string[] = [];
      const walk = (dir: string): void => {
        for (const e of fs.readdirSync(dir).sort()) {
          if (e.startsWith('.')) continue;
          const p = path.join(dir, e);
          if (fs.statSync(p).isDirectory()) walk(p);
          else if (TEXT.test(e)) files.push(path.relative(at, p).split(path.sep).join('/'));
        }
      };
      walk(at);
      return answer(true, 200, JSON.stringify({ directory: files.slice(0, 500) }));
    }
    if (fs.statSync(at).size > MAX_BYTES) return answer(false, 413, 'larger than 2 MB');
    return answer(true, 200, fs.readFileSync(at, 'utf8'));
  };
}

/** Picks, of many lines, those that speak to what the researcher needs: a score in [0, 1] each (0: they do not). */
export type LineSelector = (need: string, lines: readonly string[]) => Promise<readonly number[]>;

/** What the Judge is asked of each line: how much it speaks to what is needed - not whether it is right. */
export const SELECT_LEVELS = ['it does not speak to it', 'it touches it in passing', 'it speaks to part of it', 'it speaks directly to it'] as const;

/** The Judge as the selector of `find`: one score question per line, in calls of `batch`. It sees what is needed and the
    lines only, never the world. */
export function judgeSelector(judge: Judge, batch = 12): LineSelector {
  return async (need, lines) => {
    const scores: number[] = [];
    for (let at = 0; at < lines.length; at += batch) {
      const part = lines.slice(at, at + batch);
      const texts: Record<string, string> = { need };
      const questions: Record<string, { type: 'score'; instructions: string; criteria: readonly string[] }> = {};
      part.forEach((line, i) => {
        texts['text_' + (i + 1)] = line;
        questions['text_' + (i + 1)] = { type: 'score', criteria: SELECT_LEVELS,
          instructions: 'How much does text_' + (i + 1) + ' speak to what is needed? Judge what it is about, not whether it is right.' };
      });
      const answers = await judge.judge({ world: 'sources', rulesOfTheWorld: '', sideToMove: '', measurements: {}, texts, questions });
      part.forEach((_, i) => scores.push(answers['text_' + (i + 1)]?.value ?? NaN));
    }
    return scores;
  };
}

/** A selection the Judge made, for the journal (the operator's): what was needed, how many lines it scored, and how. */
export interface SelectionRecord { readonly need: string; readonly lines: number; readonly scores?: readonly number[]; readonly error?: string }

export interface SourcesOptions {
  /** The origins the operator allows: directories or files (absolute paths), URL prefixes, or domains. */
  readonly allow: readonly string[];
  /** How documents are fetched (`sourceFetch`, wrapped by the run's log). */
  readonly fetch: FetchLike;
  /** The selector of `find` (the Judge); none in a run without one. */
  readonly selector?: LineSelector;
  readonly onSelect?: (record: SelectionRecord) => void;
}

type Place = { readonly url: string; readonly name: string; readonly local: string | null };

export class Sources {
  private readonly allowed: string[] = [];
  private readonly options: SourcesOptions;

  constructor(options: SourcesOptions) {
    this.options = options;
    for (const a of options.allow) this.allow(a);
  }

  /** One origin more (the operator's). */
  allow(origin: string): void { if (!this.allowed.includes(origin)) this.allowed.push(origin); }
  origins(): string[] { return [...this.allowed]; }

  /** Whether the origins allow a path or a URL: a path inside an allowed directory (or that file), a URL under an allowed
      prefix or on an allowed domain (or one of its subdomains). */
  permitted(where: string): boolean {
    if (isUrl(where)) {
      let host: string;
      try { host = new URL(where).hostname.toLowerCase(); } catch { return false; }
      return this.allowed.some((a) => (isUrl(a) ? where.startsWith(a) : isDomain(a) && (host === a.toLowerCase() || host.endsWith('.' + a.toLowerCase()))));
    }
    if (!path.isAbsolute(where)) return false;
    const real = realOf(where);
    return this.allowed.some((a) => {
      if (isUrl(a) || !path.isAbsolute(a)) return false;
      const rel = path.relative(realOf(a), real);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
  }

  /** A name as the researcher wrote it: a URL, an absolute path, or a path within an allowed directory. */
  private placeOf(name: string): Place | { error: string } {
    const n = name.trim();
    const refused = { error: n + ' is not in an origin you may read (origins: ' + this.allowed.join(', ') + ')' };
    if (isUrl(n)) return this.permitted(n) ? { url: n, name: n, local: null } : refused;
    const candidates = path.isAbsolute(n) ? [n] : this.allowed.filter((a) => path.isAbsolute(a)).map((a) => path.join(a, n));
    const at = candidates.find((c) => this.permitted(c) && fs.existsSync(c)) ?? candidates.find((c) => this.permitted(c));
    return at ? { url: pathToFileURL(at).href, name: n, local: at } : refused;
  }

  private async fetchText(place: Place): Promise<{ text: string } | { error: string }> {
    try {
      const response = await this.options.fetch(place.url, { method: 'GET', headers: {}, signal: AbortSignal.timeout(30000) });
      const text = await response.text();
      if (!response.ok) return { error: place.name + ': ' + (response.status === 404 ? 'not found' : 'HTTP ' + response.status + ' ' + text.slice(0, 80)) };
      return { text };
    } catch (e) { return { error: place.name + ': ' + String((e as Error)?.message ?? e) }; }
  }

  /** The lines of a document (an HTML page as its text), and a hash of what was read. */
  private async linesOf(place: Place): Promise<{ lines: string[]; hash: string } | { error: string }> {
    const got = await this.fetchText(place);
    if ('error' in got) return got;
    if (place.local && got.text.startsWith('{"directory":')) return { error: place.name + ' is a directory: list it' };
    const text = /\.html?$/i.test(place.url) || /<html|<body|<p[ >]/i.test(got.text.slice(0, 2000)) ? textOfHtml(got.text) : got.text;
    return { lines: text.replace(/\r\n?/g, '\n').split('\n'), hash: createHash('sha256').update(got.text).digest('hex').slice(0, 12) };
  }

  /** The documents of an allowed directory. A web origin cannot be listed: its documents are named by their URLs. */
  async list(name: string): Promise<{ list: string; documents?: string[]; error?: string }> {
    const place = this.placeOf(name);
    if ('error' in place) return { list: name, error: place.error };
    if (!place.local) return { list: name, error: 'a page on the web cannot be listed: open it by its URL' };
    const got = await this.fetchText(place);
    if ('error' in got) return { list: name, error: got.error };
    let files: string[] | undefined;
    try { files = (JSON.parse(got.text) as { directory?: string[] }).directory; } catch { /* a document */ }
    if (!files) return { list: name, error: name + ' is a document: open it' };
    const base = name.replace(/[\\/]+$/, '');
    return { list: name, documents: files.map((f) => base + '/' + f) };
  }

  /** Lines `from` to `to` (1-based, at most 200) of a document, numbered; how many it has; a hash of what was read. */
  async open(name: string, from = 1, to = from + 119): Promise<unknown> {
    const place = this.placeOf(name);
    if ('error' in place) return { open: name, error: place.error };
    const got = await this.linesOf(place);
    if ('error' in got) return { open: name, error: got.error };
    const a = Math.max(1, Math.floor(from)), b = Math.min(got.lines.length, Math.max(a, Math.floor(to)), a + 199);
    return { open: name, lines: [a, b], of: got.lines.length, hash: got.hash,
      text: got.lines.slice(a - 1, b).map((l, i) => (a + i) + ': ' + (l.length > 400 ? l.slice(0, 400) + '...' : l)).join('\n') };
  }

  /** The lines that hold every word, in a document or in the documents of an allowed directory - and, with `select`, those
      of them that the selector (the Judge) says speak to what is needed. */
  async find(words: string, within: string, select?: string): Promise<unknown> {
    const terms = fold(words).split(/\s+/).filter(Boolean);
    const head = { find: words, in: within, ...(select ? { select } : {}) };
    if (!terms.length) return { ...head, error: 'no words to find' };
    const listed = await this.list(within);
    const docs = listed.documents ?? [within];
    const found: { doc: string; line: number; text: string }[] = [];
    for (const doc of docs.slice(0, 200)) {
      const place = this.placeOf(doc);
      if ('error' in place) return { ...head, error: place.error };
      const got = await this.linesOf(place);
      if ('error' in got) { if (docs.length === 1) return { ...head, error: got.error }; continue; }
      got.lines.forEach((l, i) => { if (terms.every((t) => fold(l).includes(t))) found.push({ doc, line: i + 1, text: l.length > 300 ? l.slice(0, 300) + '...' : l }); });
    }
    const SHOWN = 40;
    if (select) {
      if (!this.options.selector) return { ...head, matches: found.length, lines: found.slice(0, SHOWN), note: 'there is no Judge in this run: "select" is not available' };
      const pool = found.slice(0, 240);
      try {
        const scores = pool.length ? await this.options.selector(select, pool.map((f) => f.text)) : [];
        if (scores.length !== pool.length || (pool.length && scores.every((s) => !Number.isFinite(s)))) throw new Error('the Judge gave no scores');
        this.options.onSelect?.({ need: select, lines: pool.length, scores });
        const picked = pool.map((f, i) => ({ f, s: Number.isFinite(scores[i]) ? scores[i] : 0 })).filter((x) => x.s > 0).sort((x, y) => y.s - x.s).slice(0, 20).map((x) => x.f);
        return { ...head, matches: found.length, selected: picked.length, lines: picked,
          ...(found.length > pool.length ? { note: 'the Judge saw the first ' + pool.length + ' of ' + found.length + ' lines' } : {}) };
      } catch (e) {
        const error = String((e as Error)?.message ?? e);
        this.options.onSelect?.({ need: select, lines: pool.length, error });
        return { ...head, matches: found.length, lines: found.slice(0, SHOWN), note: 'the Judge could not select (' + error.slice(0, 80) + '): the first lines found' };
      }
    }
    return { ...head, matches: found.length, lines: found.slice(0, SHOWN),
      ...(found.length > SHOWN ? { note: found.length + ' lines hold these words: the first ' + SHOWN + ' are shown. Use other words, or add "select": "what you need" and the Judge picks the lines that speak to it.' } : {}) };
  }

  /** Whether an investigation request is one of these instruments. */
  static accepts(q: Record<string, unknown>): boolean { return typeof q.list === 'string' || typeof q.open === 'string' || typeof q.find === 'string'; }

  /** One of these instruments, answered. */
  run(q: Record<string, unknown>): Promise<unknown> {
    if (typeof q.list === 'string') return this.list(q.list);
    if (typeof q.open === 'string') return this.open(q.open, Number.isFinite(q.from) ? Number(q.from) : 1, Number.isFinite(q.to) ? Number(q.to) : undefined);
    const within = typeof q.in === 'string' ? q.in : '';
    if (!within) return Promise.resolve({ find: q.find, error: '"in": the document or the directory to look in' });
    return this.find(String(q.find), within, typeof q.select === 'string' && q.select.trim() ? q.select : undefined);
  }
}

function realOf(p: string): string {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}

/** Whether an origin can be allowed: a URL prefix, a domain, or a directory or file that exists (by its absolute path). */
export function originProblem(origin: string): string | null {
  if (isUrl(origin) || isDomain(origin)) return null;
  if (!path.isAbsolute(origin)) return origin + ' is neither a URL, a domain nor an absolute path';
  return fs.existsSync(origin) ? null : 'no file or directory ' + origin;
}
