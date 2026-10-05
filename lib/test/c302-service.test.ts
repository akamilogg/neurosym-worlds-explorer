import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createC302Service, serveC302 } from '../src/worlds/c302/service.ts';

/* SPEC-EUREKA-NAVEGACION §4.1: the c302 service - one simulation per request, at most so many at once, each request with
   an Idempotency-Key simulated once. A stand-in worker plays c302 (the real one needs Java and pyNeuroML). */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c302-'));
const stub = path.join(dir, 'worker.mjs');
fs.writeFileSync(stub, `
let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', async () => {
  const req = JSON.parse(raw);
  await new Promise((r) => setTimeout(r, req.wait_ms ?? 50));
  process.stdout.write('cect >>> chatter on stdout first\\n');
  const answer = req.crash ? { error: 'boom', bad_request: false }
    : (req.cells ?? []).includes('NOPE') ? { error: 'unknown cells: NOPE', bad_request: true }
    : { t: [0, 5, 10], calcium: { AVAL: [0, 1e-7, 2e-7] }, cells: ['AVAL'], n_connections: 3, seconds: 0.1 };
  process.stdout.write('\\n@@C302@@' + JSON.stringify(answer));
});
`);
const worker = [process.execPath, stub];

test('a simulation answered; the same key answered again without simulating, even while the first still runs', async () => {
  const s = createC302Service({ worker, concurrency: 2 });
  const body = { duration_ms: 10, cells: ['AVAL'], wait_ms: 150 };
  const [a, b] = await Promise.all([s.handle('POST', '/simulate', body, 'k1'), s.handle('POST', '/simulate', body, 'k1')]);
  assert.equal(a.status, 200);
  assert.deepEqual(a, b);
  assert.deepEqual((a.body as { calcium: Record<string, number[]> }).calcium.AVAL, [0, 1e-7, 2e-7], 'the worker\'s chatter on stdout is not the answer');
  await s.handle('POST', '/simulate', body, 'k1');
  assert.deepEqual(s.stats(), { simulations: 1, answered_again: 2, running: 0, waiting: 0 });
});

test('at most `concurrency` simulations at once; a bad request is said (and kept), a failure is not kept', async () => {
  const s = createC302Service({ worker, concurrency: 2 });
  const asked = [1, 2, 3, 4].map((k) => s.handle('POST', '/simulate', { duration_ms: 10, wait_ms: 200 }, 'c' + k));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(s.stats().running, 2);
  assert.equal(s.stats().waiting, 2);
  await Promise.all(asked);
  const bad = await s.handle('POST', '/simulate', { duration_ms: 10, cells: ['NOPE'] }, 'bad');
  assert.deepEqual([bad.status, (bad.body as { error: string }).error], [400, 'unknown cells: NOPE']);
  const crash = await s.handle('POST', '/simulate', { duration_ms: 10, crash: true }, 'crash');
  assert.equal(crash.status, 500);
  await s.handle('POST', '/simulate', { duration_ms: 10, crash: true }, 'crash');
  assert.equal(s.stats().simulations, 4 + 1 + 2, 'the failure was simulated again, the bad request was not');
  assert.equal((await s.handle('POST', '/simulate', {}, null)).status, 400, 'a duration is needed');
});

test('over HTTP, on 127.0.0.1', async () => {
  const srv = await serveC302({ worker, concurrency: 1 });
  try {
    const r = await fetch(srv.url + '/simulate', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'h1' }, body: JSON.stringify({ duration_ms: 10 }) });
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).cells, ['AVAL']);
    assert.equal((await (await fetch(srv.url + '/stats')).json()).simulations, 1);
  } finally { await srv.close(); }
});
