import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { serveConsole, CONSOLE_PAGE } from '../src/runtime/console.ts';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';


/* SPEC-INVESTIGADOR-ASISTIDO A3: the console - a local page over the control API. */

const draft = { observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]' };
const answer = (body: string): string => {
  const b = JSON.parse(body);
  const sys = b.messages[0].content as string, user = userOf(b);
  const content = sys.startsWith('You grade') ? { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' }
    : /"task"/.test(user) ? { rationale: 'r', beliefs: [{ id: 'b', stance: 'confirm', why: 'w' }], lessons: ['l'], next_experiment: 'n' }
    : !JSON.parse(user).investigation && JSON.parse(user).round % 2 === 1 ? { investigate: [{ view: 'ep1', from: 0, to: 3 }] }
    : { rationale: 'r', ...draft, validate: false, beliefs: [{ id: 'b', stance: 'new', statement: 'the same row again' }], lessons: ['l'] };
  return JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
};
const stub: FetchLike = async (_u, init) => { const text = answer(String(init.body)); return { ok: true, status: 200, text: async () => text, headers: { get: () => null } }; };

/** A request to the console, addressed to it by the name it answers to (or another, to see it refused). */
function call(url: string, method = 'GET', body?: unknown, host?: string): Promise<{ status: number; json: any; text: string }> {
  const u = new URL(url);
  return new Promise((ok, fail) => {
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: { 'content-type': 'application/json', ...(host ? { host } : {}) } }, (res) => {
      let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => { let json: any = null; try { json = JSON.parse(t); } catch { /* html */ } ok({ status: res.statusCode ?? 0, json, text: t }); });
    });
    req.on('error', fail);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

test('the console lists runs and shows one: its state, events, model, check, beliefs and both findings', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-'));
  const r = await runLaboratory(cellsLab, { args: ['--seed', '1', '--level', '1', '--attempts', '2', '--flat', '--no-grade', '--out', path.join(root, 'runs', 'one.json')], root,
    llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch: stub });
  const c = await serveConsole({ root, port: 0, synthesis: async (j) => '<html>synthesis of ' + (j as { experiment: string }).experiment + '</html>' });
  try {
    const page = await call(c.url + '/');
    assert.equal(page.status, 200);
    assert.equal(page.text, CONSOLE_PAGE);
    assert.match(page.text, /no acepta mensajes, foco ni fuentes/, 'the page says why the pure researcher takes no help');
    const runs = (await call(c.url + '/api/runs')).json;
    assert.deepEqual(runs.map((x: { run: string; researcher: string; state: string }) => [x.run, x.researcher, x.state]), [['one', 'unknown-world', 'ended']]);
    const v = (await call(c.url + '/api/runs/one')).json;
    assert.equal(v.status.stoppedBy, r.stoppedBy);
    assert.ok(v.events.length > 5 && v.events.every((e: { line: string }) => typeof e.line === 'string'));
    assert.equal(v.model.law.output, draft.output);
    assert.equal(v.check.places[0].place, 'lab1');
    assert.equal(v.beliefs[0].statement, 'the same row again');
    assert.match(v.finding.operator, /^cells@1/);
    assert.match(v.finding.researcher, /^cells@1/);
    assert.equal((await call(c.url + '/api/runs/one?since=' + v.total)).json.events.length, 0, 'only what is new');
    assert.equal((await call(c.url + '/view/one')).text, '<html>synthesis of cells@1</html>');
    assert.equal((await call(c.url + '/api/labs')).json.map((l: { name: string }) => l.name).join(','), 'cells,messages,orbit,grid,tank,particles3d');
  } finally { await c.close(); }
});

test('the console is local and careful: other hosts, other folders, ended runs and unknown labs are refused', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-'));
  await runLaboratory(cellsLab, { args: ['--seed', '1', '--level', '1', '--attempts', '1', '--flat', '--no-grade', '--no-reflection', '--out', path.join(root, 'runs', 'one.json')], root,
    llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch: stub });
  const c = await serveConsole({ root, port: 0 });
  try {
    assert.equal((await call(c.url + '/api/runs', 'GET', undefined, 'evil.example:80')).status, 403, 'a name rebound to it is refused');
    assert.equal((await call(c.url + '/api/runs/..%2F..%2Fetc')).status, 404, 'only runs of its folder');
    assert.equal((await call(c.url + '/api/runs/one/orders', 'POST', { kind: 'message', text: 'hi' })).status, 409, 'an ended run reads no orders');
    assert.equal((await call(c.url + '/api/runs', 'POST', { lab: 'nowhere' })).status, 400);
    assert.equal((await call(c.url + '/view/one')).status, 404, 'no synthesis without a builder');
  } finally { await c.close(); }
});

test('from the console: a run is started, followed, its help refused, stopped and resumed', { timeout: 180000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-'));
  const server = http.createServer((req, res) => { let b = ''; req.on('data', (x) => { b += x; }); req.on('end', () => setTimeout(() => res.end(answer(b)), 300)); });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  const env = { ...process.env, LLM_URL: 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1/chat/completions', LLM_MODEL: 'stand-in', LLM_KEY: '', JEV_KEY: '' };
  const c = await serveConsole({ root, port: 0, env });
  const until = async (ok: () => Promise<boolean>, ms = 60000) => { const t = Date.now(); while (!(await ok())) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((x) => setTimeout(x, 250)); } };
  try {
    const started = await call(c.url + '/api/runs', 'POST', { lab: 'cells', researcher: 'unknown-world', args: ['--seed', '1', '--level', '1', '--attempts', '8', '--flat', '--no-grade', '--no-reflection'] });
    assert.equal(started.status, 201);
    const run = started.json.run;
    await until(async () => (await call(c.url + '/api/runs/' + run)).json?.status?.state === 'running');
    const help = await call(c.url + '/api/runs/' + run + '/orders', 'POST', { kind: 'message', text: 'look at step 0' });
    assert.equal(help.status, 202);
    await until(async () => (await call(c.url + '/api/runs/' + run + '/orders/' + help.json.id)).json.state !== 'pending');
    assert.match((await call(c.url + '/api/runs/' + run + '/orders/' + help.json.id)).json.reason, /learns only from what the world answers/);
    const halt = await call(c.url + '/api/runs/' + run + '/orders', 'POST', { kind: 'stop' });
    await until(async () => (await call(c.url + '/api/runs/' + run)).json.status.state === 'ended');
    assert.equal((await call(c.url + '/api/runs/' + run + '/orders/' + halt.json.id)).json.state, 'accepted');
    assert.equal((await call(c.url + '/api/runs/' + run)).json.status.stoppedBy, 'cancelled');
    const resumed = await call(c.url + '/api/runs/' + run + '/resume', 'POST', {});
    assert.equal(resumed.status, 201);
    await until(async () => (await call(c.url + '/api/runs/' + resumed.json.run)).json?.status?.state === 'ended');
    assert.equal((await call(c.url + '/api/runs')).json.length, 2);
  } finally { await c.close(); server.close(); }
});
