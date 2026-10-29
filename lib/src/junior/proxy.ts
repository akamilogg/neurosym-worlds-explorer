import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';

/* ============================================================================
 * The providers' PROXY (SPEC-METAPOLITICA-APRENDIZAJE §12, §13): it runs on the operator's machine, never the junior's.
 * The junior's machine holds no provider key: its harness calls this proxy with a token of its own, and the proxy calls
 * the provider with the operator's key, read from its own environment, never written, logged nor answered.
 *
 * Every call is paid from a BAG (the strong model's tokens, the Judge's calls...). Before it is forwarded, its most is
 * reserved: what the bag cannot hold is refused (402), never sent. After, it is settled with the provider's `usage`; an
 * answer without usage keeps its reservation as uncertain spending. Each call is a line of the ledger, on this machine;
 * on restart the bags are read back from it. A call still open when the proxy stopped stays reserved as uncertain.
 *
 * The routes are the provider's own under the upstream's name: POST /<upstream>/<path> goes to <upstream url>/<path>.
 * A harness on the junior's machine points its LLM_URL there and its LLM_KEY is its client token.
 * ========================================================================== */

export interface ProxyConfig {
  readonly upstreams: Readonly<Record<string, { readonly url: string; readonly key_env: string; readonly models?: readonly string[] }>>;
  readonly bags: Readonly<Record<string, { readonly tokens: number; readonly calls: number; readonly reserve_prompt_tokens?: number }>>;
  /** Client tokens, by their SHA-256 (the config never holds a token itself): which bag pays, which upstreams it may call. */
  readonly clients: Readonly<Record<string, { readonly bag: string; readonly upstreams: readonly string[] }>>;
  readonly ledger: string;
}

interface BagState { tokens: number; calls: number; reserved_tokens: number; reserved_calls: number; uncertain_tokens: number }

export const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');

export function validateProxyConfig(raw: unknown): ProxyConfig {
  const c = raw as ProxyConfig;
  if (!c || typeof c !== 'object') throw new Error('the proxy config must be an object');
  for (const k of ['upstreams', 'bags', 'clients'] as const) if (!c[k] || typeof c[k] !== 'object') throw new Error('the proxy config needs ' + k);
  if (typeof c.ledger !== 'string' || !c.ledger) throw new Error('the proxy config needs ledger (a file)');
  for (const [n, u] of Object.entries(c.upstreams)) {
    if (!/^[A-Za-z0-9_-]+$/.test(n)) throw new Error('upstream ' + n + ': a name of letters, digits, - and _');
    if (!/^https?:\/\//.test(u.url) || typeof u.key_env !== 'string') throw new Error('upstream ' + n + ' needs url and key_env');
  }
  for (const [n, b] of Object.entries(c.bags)) if (!(b.tokens >= 0) || !(b.calls >= 0)) throw new Error('bag ' + n + ' needs tokens and calls (>= 0)');
  for (const [h, cl] of Object.entries(c.clients)) {
    if (!/^[0-9a-f]{64}$/.test(h)) throw new Error('clients are named by the SHA-256 of their token, never the token');
    if (!c.bags[cl.bag]) throw new Error('client ' + h.slice(0, 8) + ' pays from an unknown bag ' + cl.bag);
    for (const u of cl.upstreams) if (!c.upstreams[u]) throw new Error('client ' + h.slice(0, 8) + ' names an unknown upstream ' + u);
  }
  return c;
}

export class ProviderProxy {
  private readonly c: ProxyConfig;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetch: typeof globalThis.fetch;
  private readonly bags = new Map<string, BagState>();
  private seq = 0;

  constructor(config: unknown, o: { env?: NodeJS.ProcessEnv; fetch?: typeof globalThis.fetch } = {}) {
    this.c = validateProxyConfig(config);
    this.env = o.env ?? process.env;
    this.fetch = o.fetch ?? globalThis.fetch;
    for (const [u, up] of Object.entries(this.c.upstreams)) if (!this.env[up.key_env]) throw new Error('upstream ' + u + ': its key ' + up.key_env + ' is not in the proxy\'s environment');
    for (const n of Object.keys(this.c.bags)) this.bags.set(n, { tokens: 0, calls: 0, reserved_tokens: 0, reserved_calls: 0, uncertain_tokens: 0 });
    this.replay();
  }

  /** Bags from the ledger: settled calls spent; a reservation never settled spent as uncertain (it may have run). */
  private replay(): void {
    fs.mkdirSync(path.dirname(this.c.ledger), { recursive: true });
    if (!fs.existsSync(this.c.ledger)) return;
    const open = new Map<string, { bag: string; tokens: number }>();
    for (const row of fs.readFileSync(this.c.ledger, 'utf8').split('\n')) {
      if (!row.trim()) continue;
      let l: Record<string, unknown>;
      try { l = JSON.parse(row); } catch { continue; }
      const b = this.bags.get(String(l.bag));
      if (!b) continue;
      if (l.kind === 'reserve') { open.set(String(l.id), { bag: String(l.bag), tokens: Number(l.tokens) }); this.seq = Math.max(this.seq, Number(String(l.id).split('-')[0]) || 0); }
      if (l.kind === 'settle') {
        open.delete(String(l.id));
        b.calls += Number(l.calls ?? 1);
        b.tokens += Number(l.tokens ?? 0);
        if (l.uncertain) b.uncertain_tokens += Number(l.tokens ?? 0);
      }
    }
    for (const [id, r] of open) {
      const b = this.bags.get(r.bag)!;
      b.calls += 1; b.tokens += r.tokens; b.uncertain_tokens += r.tokens;
      this.write({ kind: 'settle', id, bag: r.bag, tokens: r.tokens, calls: 1, uncertain: true, reason: 'the proxy stopped while it was open' });
    }
  }

  private write(line: Record<string, unknown>): void {
    const fd = fs.openSync(this.c.ledger, 'a');
    try { fs.writeSync(fd, JSON.stringify({ at: new Date().toISOString(), ...line }) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }

  /** What each bag holds: its limits, spent, reserved and uncertain. */
  status(): Record<string, { limit: { tokens: number; calls: number }; spent: { tokens: number; calls: number }; reserved: { tokens: number; calls: number }; uncertain_tokens: number }> {
    return Object.fromEntries([...this.bags].map(([n, b]) => [n, { limit: { tokens: this.c.bags[n].tokens, calls: this.c.bags[n].calls }, spent: { tokens: b.tokens, calls: b.calls },
      reserved: { tokens: b.reserved_tokens, calls: b.reserved_calls }, uncertain_tokens: b.uncertain_tokens }]));
  }

  async handle(method: string, route: string, headers: Readonly<Record<string, string | undefined>>, raw: string): Promise<{ status: number; body: unknown }> {
    const auth = headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const client = token ? this.c.clients[tokenHash(token)] : undefined;
    if (!client) return { status: 401, body: { error: { message: 'unknown client token' } } };
    if (method === 'GET' && route === '/status') return { status: 200, body: { [client.bag]: this.status()[client.bag] } };
    const m = /^\/([A-Za-z0-9_-]+)(\/.*)$/.exec(route);
    if (method !== 'POST' || !m) return { status: 404, body: { error: { message: 'POST /<upstream>/<path>, or GET /status' } } };
    const [, name, rest] = m;
    const up = this.c.upstreams[name];
    if (!up || !client.upstreams.includes(name)) return { status: 403, body: { error: { message: 'this client may not call ' + name } } };
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { return { status: 400, body: { error: { message: 'not JSON' } } }; }
    if (body.stream) return { status: 400, body: { error: { message: 'streaming is not proxied: its spending could not be settled' } } };
    if (up.models && !up.models.includes(String(body.model))) return { status: 403, body: { error: { message: 'model ' + body.model + ' is not allowed on ' + name } } };
    const most = Number(body.max_completion_tokens ?? body.max_tokens);
    if (!(most > 0)) return { status: 400, body: { error: { message: 'a call through the proxy names its max_tokens: its most is reserved before it is sent' } } };
    const lim = this.c.bags[client.bag], b = this.bags.get(client.bag)!;
    const reserve = most + (lim.reserve_prompt_tokens ?? 0) + Math.ceil(raw.length / 2);
    if (b.tokens + b.reserved_tokens + reserve > lim.tokens || b.calls + b.reserved_calls + 1 > lim.calls)
      return { status: 402, body: { error: { message: 'the bag ' + client.bag + ' cannot hold this call', code: 'budget' }, bag: this.status()[client.bag] } };
    const id = (++this.seq) + '-' + process.pid;
    b.reserved_tokens += reserve; b.reserved_calls += 1;
    this.write({ kind: 'reserve', id, bag: client.bag, upstream: name, model: body.model ?? null, tokens: reserve });
    let tokens = reserve, uncertain = true, status = 502, answer: unknown = { error: { message: 'the provider did not answer' } };
    try {
      const r = await this.fetch(up.url.replace(/\/$/, '') + rest, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + this.env[up.key_env] }, body: raw });
      status = r.status;
      const text = await r.text();
      try { answer = JSON.parse(text); } catch { answer = { error: { message: 'the provider answered no JSON' } }; }
      const usage = (answer as { usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number } }).usage;
      const total = usage ? Number(usage.total_tokens ?? (Number(usage.prompt_tokens ?? 0) + Number(usage.completion_tokens ?? 0))) : NaN;
      if (Number.isFinite(total)) { tokens = total; uncertain = false; }
      else if (status >= 400 && status < 500) { tokens = 0; uncertain = false; }
    } catch (e) {
      answer = { error: { message: 'the provider could not be reached: ' + String((e as Error)?.message ?? e).replaceAll(String(this.env[up.key_env]), '***') } };
    } finally {
      b.reserved_tokens -= reserve; b.reserved_calls -= 1;
      b.tokens += tokens; b.calls += 1;
      if (uncertain) b.uncertain_tokens += tokens;
      this.write({ kind: 'settle', id, bag: client.bag, tokens, calls: 1, uncertain, status });
    }
    return { status, body: answer };
  }
}

/** The proxy over HTTP. It listens where the operator says: the address the junior's machine can reach, nothing wider. */
export function serveProxy(proxy: ProviderProxy, o: { port?: number; host?: string } = {}): Promise<{ url: string; close(): Promise<void> }> {
  const host = o.host ?? '127.0.0.1';
  const h = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
      void proxy.handle(req.method ?? 'GET', (req.url ?? '/').split('?')[0], headers, raw)
        .then((r) => res.writeHead(r.status, { 'content-type': 'application/json' }).end(JSON.stringify(r.body)));
    });
  });
  h.requestTimeout = 0;
  return new Promise((resolve) => {
    h.listen(o.port ?? 0, host, () => {
      const a = h.address() as { port: number };
      resolve({ url: 'http://' + host + ':' + a.port, close: () => new Promise((r) => { h.closeAllConnections(); h.close(() => r()); }) });
    });
  });
}
