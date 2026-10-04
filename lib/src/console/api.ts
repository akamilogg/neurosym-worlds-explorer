import type http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ResearchStore, assertId, hash, read, write, type Json, type Profile } from './store.ts';
import { Analysts } from './analyst.ts';
import { Actions } from './actions.ts';
import { RESEARCH_PAGE } from './page.ts';

export function researchConsole(root: string, env?: NodeJS.ProcessEnv) {
  const store = new ResearchStore(root);
  fs.mkdirSync(store.dir, { recursive: true });
  const lock = path.join(store.dir, 'owner.json');
  const owner = read(lock);
  if (owner) {
    let alive = false;
    try { process.kill(owner.pid, 0); alive = true; } catch { /* stale owner */ }
    if (alive) throw new Error('Another console owns this workspace; use its existing endpoint');
    fs.unlinkSync(lock);
  }
  const fd = fs.openSync(lock, 'wx'); fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); fs.closeSync(fd);
  const analysts = new Analysts(store, env), actions = new Actions(store, analysts, env);
  const token = randomUUID();
  const body = (req: http.IncomingMessage): Promise<Json> => new Promise((resolve, reject) => {
    let raw = ''; req.on('data', c => { raw += c; if (raw.length > 1_000_000) { reject(new Error('Request too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(new Error('Invalid JSON')); } }); req.on('error', reject);
  });
  async function handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== '/research' && !url.pathname.startsWith('/api/research/')) return false;
    const send = (status: number, value: unknown, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'" });
      res.end(type === 'application/json' ? JSON.stringify(value) : String(value));
    };
    try {
      if (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host) { send(403, { error: 'Only same-origin requests' }); return true; }
      if (url.pathname === '/research') { send(200, RESEARCH_PAGE, 'text/html'); return true; }
      const route = url.pathname.slice('/api/research/'.length), method = req.method;
      if (method !== 'GET' && req.headers['x-console-token'] !== token) { send(403, { error: 'Console session token required' }); return true; }
      if (method === 'GET' && route === 'session') send(200, { token, team: false, reason: 'El tablón depende de PB1–PB2; no se simula con mensajes automáticos.' });
      else if (method === 'GET' && route === 'catalogue') send(200, { entities: store.catalogue(), budget: analysts.ledger(), orders: actions.list() });
      else if (method === 'GET' && route === 'events') {
        const ids = JSON.parse(url.searchParams.get('ids') ?? '[]');
        const profile = (url.searchParams.get('profile') ?? 'operator') as Profile;
        const s = store.capture(ids, profile, {}, false);
        send(200, { ...s, events: s.events.slice(-1000), total: s.events.length, costs: store.costs(ids) });
      } else if (method === 'POST' && route === 'snapshots') {
        const b = await body(req); send(201, store.capture(b.entities, b.profile, b.positions ?? {}));
      } else if (method === 'GET' && route.startsWith('snapshots/')) {
        const parts = route.split('/'), s = store.snapshot(parts[1]);
        if (parts[2] === 'export') send(200, store.export(s), 'text/html');
        else if (parts[2] === 'events') send(200, store.evidence(s, url.searchParams.get('q') ?? '', url.searchParams.get('type') ?? '', Number(url.searchParams.get('offset') ?? 0)));
        else if (parts[2] === 'event') {
          const event = s.events.find(e => e.id === url.searchParams.get('id')); send(event ? 200 : 404, event ?? { error: 'Not in this snapshot' });
        } else send(200, s);
      } else if (method === 'POST' && route === 'query') {
        const b = await body(req); send(200, store.query(store.snapshot(b.snapshot), String(b.question ?? '')));
      } else if (method === 'GET' && route === 'analyses') send(200, analysts.list());
      else if (method === 'GET' && route === 'annotations') {
        const s = store.snapshot(String(url.searchParams.get('snapshot'))), dir = path.join(store.dir, 'annotations');
        send(200, fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => read(path.join(dir, f)))
          .filter(a => a && a.snapshot === s.id && s.events.some(e => e.id === a.event)) : []);
      }
      else if (method === 'POST' && route === 'analyses') {
        const b = await body(req); assertId(b.key);
        const file = path.join(store.dir, 'analysis-requests', b.key + '.json'), prior = read(file);
        if (prior) { if (prior.fingerprint !== hash(b)) throw new Error('Idempotency key already used for another analysis'); send(200, analysts.get(prior.id)); }
        else { const a = analysts.start(b as any); write(file, { id: a.id, fingerprint: hash(b) }); send(202, a); }
      } else if (method === 'POST' && route.startsWith('analyses/')) {
        const [, id, op] = route.split('/'); send(200, op === 'resume' ? analysts.resume(id) : op === 'stop' ? analysts.stop(id) : (() => { throw new Error('Unknown analysis action'); })());
      } else if (method === 'POST' && route === 'budget') send(200, analysts.setBudget(Number((await body(req)).limit)));
      else if (method === 'POST' && route === 'orders') send(202, actions.send(await body(req)));
      else if (method === 'GET' && route === 'orders') send(200, actions.list());
      else if (method === 'POST' && route === 'annotations') {
        const b = await body(req); assertId(b.key); const s = store.snapshot(b.snapshot);
        if (!s.events.some(e => e.id === b.event) || !String(b.text ?? '').trim()) throw new Error('Annotation needs an event in the snapshot and text');
        const file = path.join(store.dir, 'annotations', b.key + '.json');
        if (!read(file)) write(file, { id: b.key, snapshot: s.id, event: b.event, text: String(b.text), at: new Date().toISOString(), by: 'human:console' });
        send(201, read(file));
      } else send(404, { error: 'No such research route' });
    } catch (e) { send(400, { error: String((e as Error).message) }); }
    return true;
  }
  return { handle, close: () => { analysts.close(); if (read(lock)?.pid === process.pid) fs.unlinkSync(lock); } };
}
