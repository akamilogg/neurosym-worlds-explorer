import http from 'node:http';
import { hashString } from '../../core/hash.ts';

/* ============================================================================
 * tank@1's SERVICE: an environment OUTSIDE the harness (SPEC-OBJETIVO O12). It runs in a
 * process of its own, keeps state, and acts: every step it is asked to take changes a
 * tank's level, and it counts the steps it has taken. The harness reaches it only over
 * HTTP; the hidden rule lives here and nowhere in the laboratory.
 *
 *   POST /episode {place, start?}      a new tank in a place, at `start` or at a level the
 *                                      service chooses -> {episode, level} (or {refused})
 *   POST /step {episode, inflow}       one step: the inflow goes in, the tank drains ->
 *                                      {level} (or {refused})
 *   GET  /stats                        how many steps and episodes it has executed, and how
 *                                      many requests it answered again without acting
 *
 * EXACTLY ONCE: a request that carries an `Idempotency-Key` it has already answered is
 * answered again with the same response, and nothing is done a second time. A laboratory
 * that is interrupted and resumed asks again what it asked before; a request the service
 * had already acted on when the run stopped is not acted on twice.
 * ========================================================================== */

export const TANK_CAPACITY = 60;

/** The hidden rule: the inflow goes in, a quarter of the level (rounded down) drains out, the tank holds 0 to 60. */
export function tankStep(level: number, inflow: number): number {
  return Math.max(0, Math.min(TANK_CAPACITY, level + inflow - Math.floor(level / 4)));
}

/** OPERATOR ONLY: the hidden rule, as statements the grader compares with the learner's words. */
export const TANK_TRUTH: readonly { readonly id: string; readonly statement: string }[] = [
  { id: 'inflow', statement: 'The inflow of a step is added to the level.' },
  { id: 'drain', statement: 'Each step a quarter of the current level, rounded down, drains out.' },
  { id: 'bounds', statement: 'The level stays between 0 and 60: what would go above 60 or below 0 is cut.' },
  { id: 'memory', statement: 'The next level depends only on the current level and the inflow, not on earlier steps or on the place.' }
];

export interface TankService {
  /** Answers one request (route, body, idempotency key): what the HTTP server does, without the network. */
  handle(method: string, route: string, body: Record<string, unknown>, key: string | null): { status: number; body: unknown };
  stats(): { steps: number; episodes: number; answered_again: number };
}

export function createTankService(options: { seed?: number } = {}): TankService {
  const seed = options.seed ?? 1;
  const tanks = new Map<string, { place: string; level: number }>();
  const perPlace = new Map<string, number>();
  const done = new Map<string, { status: number; body: unknown }>();
  let steps = 0, episodes = 0, again = 0;
  const act = (route: string, body: Record<string, unknown>): { status: number; body: unknown } => {
    if (route === '/episode') {
      const place = typeof body.place === 'string' ? body.place : '';
      if (!place) return { status: 400, body: { error: 'place is required' } };
      const n = (perPlace.get(place) ?? 0) + 1;
      perPlace.set(place, n);
      let level: number;
      if (body.start === undefined || body.start === null) level = parseInt(hashString(seed + '|' + place + '|' + n), 36) % (TANK_CAPACITY + 1);
      else if (Number.isInteger(body.start) && (body.start as number) >= 0 && (body.start as number) <= TANK_CAPACITY) level = body.start as number;
      else return { status: 200, body: { refused: true } };
      const id = 'e' + (++episodes);
      tanks.set(id, { place, level });
      return { status: 200, body: { episode: id, level } };
    }
    if (route === '/step') {
      const tank = typeof body.episode === 'string' ? tanks.get(body.episode) : undefined;
      if (!tank) return { status: 404, body: { error: 'no such episode' } };
      if (!Number.isInteger(body.inflow) || (body.inflow as number) < 0 || (body.inflow as number) > 9) return { status: 200, body: { refused: true } };
      tank.level = tankStep(tank.level, body.inflow as number);
      steps++;
      return { status: 200, body: { level: tank.level } };
    }
    return { status: 404, body: { error: 'no such route' } };
  };
  return {
    handle(method, route, body, key) {
      if (method === 'GET' && route === '/stats') return { status: 200, body: this.stats() };
      if (method !== 'POST') return { status: 405, body: { error: 'POST' } };
      if (key && done.has(key)) { again++; return done.get(key)!; }
      const r = act(route, body);
      if (key && r.status < 500) done.set(key, r);
      return r;
    },
    stats: () => ({ steps, episodes, answered_again: again })
  };
}

/** The service over HTTP. `port` 0: any free port (the address says which). */
export function serveTank(options: { port?: number; host?: string; seed?: number } = {}): Promise<{ url: string; service: TankService; close(): Promise<void> }> {
  const service = createTankService({ seed: options.seed });
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { res.writeHead(400).end('{"error":"not JSON"}'); return; }
      const key = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : null;
      const r = service.handle(req.method ?? 'GET', (req.url ?? '/').split('?')[0], body, key);
      res.writeHead(r.status, { 'content-type': 'application/json' }).end(JSON.stringify(r.body));
    });
  });
  return new Promise((resolve) => {
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
      const a = server.address() as { port: number };
      resolve({ url: 'http://' + (options.host ?? '127.0.0.1') + ':' + a.port, service, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}
