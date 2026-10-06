import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ============================================================================
 * The c302 service (SPEC-EUREKA-NAVEGACION §4.1): OpenWorm's model of the nervous system of
 * C. elegans, simulated in a process of its own, for the laboratories built on it.
 *
 *   POST /simulate   one simulation: the network (its cells), the stimuli, changes to the wiring
 *                    and to the model's parameters; it answers the calcium of the cells asked for,
 *                    every save_every_ms. Each request with an Idempotency-Key is simulated once:
 *                    asked again (a resumed run), it is answered what it was answered, and asked
 *                    again while it is still running, it waits for the same simulation.
 *   POST /wiring     the connections among the cells of a network (chemical with their transmitter, gap
 *                    junctions, and the number of contacts of each).
 *   GET  /stats      simulations run, answered again, running and waiting.
 *
 * It belongs to no problem: which cells, which stimuli and what is read from the calcium are the
 * laboratory's. The simulation itself is simulate.py (c302, pyNeuroML, Java), one process per
 * request, at most `concurrency` at once.
 * ========================================================================== */

export interface C302Request {
  readonly cells?: readonly string[] | null;
  readonly stimuli?: readonly Record<string, unknown>[];
  readonly record?: readonly string[] | null;
  readonly parameter_set?: string;
  readonly duration_ms: number;
  readonly dt_ms?: number;
  readonly save_every_ms?: number;
  readonly remove_connections?: readonly string[];
  readonly connection_number_scaling?: Readonly<Record<string, number>>;
  readonly connection_polarity_override?: Readonly<Record<string, string>>;
  readonly param_overrides?: Readonly<Record<string, string>>;
}

export interface C302Answer { readonly t?: number[]; readonly calcium?: Record<string, number[]>; readonly cells?: string[]; readonly n_connections?: number; readonly seconds?: number; readonly error?: string; readonly bad_request?: boolean;
  /** The integration diverged: the simulation of that request does not complete (an answer of the model, not a failure of the service). */
  readonly unstable?: boolean }

export interface C302Service {
  handle(method: string, route: string, body: Record<string, unknown>, key: string | null): Promise<{ status: number; body: unknown }>;
  stats(): { simulations: number; answered_again: number; running: number; waiting: number };
}

const MARK = '@@C302@@';
export const SIMULATE_PY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'simulate.py');

/** Runs one simulation in a process of its own: the worker reads the request on stdin and ends its output with the answer. */
export function runWorker(command: readonly string[], request: unknown, timeoutMs: number): Promise<C302Answer> {
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); resolve({ error: 'the simulation took longer than ' + Math.round(timeoutMs / 1000) + ' s', bad_request: false }); }, timeoutMs);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ error: 'the worker did not start: ' + e.message, bad_request: false }); });
    child.on('close', () => {
      clearTimeout(timer);
      const at = out.lastIndexOf(MARK);
      if (at < 0) { resolve({ error: 'the worker gave no answer' + (err ? ': ' + err.slice(-400) : ''), bad_request: false }); return; }
      try { resolve(JSON.parse(out.slice(at + MARK.length))); } catch { resolve({ error: 'the worker\'s answer is not JSON', bad_request: false }); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export function createC302Service(options: { worker: readonly string[]; concurrency?: number; timeoutMs?: number }): C302Service {
  const limit = Math.max(1, options.concurrency ?? 4);
  const timeoutMs = options.timeoutMs ?? 30 * 60_000;
  const done = new Map<string, { status: number; body: unknown }>();
  const inFlight = new Map<string, Promise<{ status: number; body: unknown }>>();
  const queue: (() => void)[] = [];
  let running = 0, simulations = 0, again = 0;
  const slot = async (): Promise<void> => {
    if (running < limit) { running++; return; }
    await new Promise<void>((r) => queue.push(r));
    running++;
  };
  const free = (): void => { running--; queue.shift()?.(); };
  const simulate = async (body: Record<string, unknown>): Promise<{ status: number; body: unknown }> => {
    if (!body.wiring && !(Number(body.duration_ms) > 0)) return { status: 400, body: { error: 'duration_ms is needed' } };
    await slot();
    try {
      simulations++;
      const a = await runWorker(options.worker, body, timeoutMs);
      /* 400: the request cannot be simulated; 422: it was, and the integration diverged (deterministic: kept like an answer);
         500: the service failed (not kept: asked again, it is tried again). */
      return a.error ? { status: a.bad_request ? 400 : a.unstable ? 422 : 500, body: { error: a.error, ...(a.unstable ? { unstable: true } : {}) } } : { status: 200, body: a };
    } finally { free(); }
  };
  return {
    async handle(method, route, body, key) {
      if (method === 'GET' && route === '/stats') return { status: 200, body: this.stats() };
      if (method !== 'POST' || (route !== '/simulate' && route !== '/wiring')) return { status: 404, body: { error: 'POST /simulate, POST /wiring, GET /stats' } };
      if (route === '/wiring') body = { ...body, wiring: true };
      if (key && done.has(key)) { again++; return done.get(key)!; }
      if (key && inFlight.has(key)) { again++; return inFlight.get(key)!; }
      const p = simulate(body);
      if (key) inFlight.set(key, p);
      const r = await p;
      if (key) { inFlight.delete(key); if (r.status < 500) done.set(key, r); }
      return r;
    },
    stats: () => ({ simulations, answered_again: again, running, waiting: queue.length })
  };
}

/** The service over HTTP, on 127.0.0.1. `port` 0: any free port. */
export function serveC302(options: { port?: number; host?: string; worker: readonly string[]; concurrency?: number; timeoutMs?: number }): Promise<{ url: string; service: C302Service; close(): Promise<void> }> {
  const service = createC302Service(options);
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { res.writeHead(400).end('{"error":"not JSON"}'); return; }
      const key = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : null;
      void service.handle(req.method ?? 'GET', (req.url ?? '/').split('?')[0], body, key)
        .then((r) => res.writeHead(r.status, { 'content-type': 'application/json' }).end(JSON.stringify(r.body)));
    });
  });
  /* A simulation can take many minutes: the connection waits for it. */
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  return new Promise((resolve) => {
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
      const a = server.address() as { port: number };
      resolve({ url: 'http://' + (options.host ?? '127.0.0.1') + ':' + a.port, service, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}
