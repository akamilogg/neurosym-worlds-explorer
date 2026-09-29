import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReplayDivergence, ReplayLog, readReplayLog } from '../src/runtime/replay.ts';
import { budgetArgs, experimentArgs } from '../src/runtime/lab-runner.ts';
import { LawSession } from '../src/learn/law-session.ts';
import type { FetchLike } from '../src/core/net.ts';

/* SPEC-OBJETIVO O11: a run can be stopped (Ctrl+C, a budget) and resumed by replaying what came over the network - in a
   run of its own, derived from the one it resumes, which stays as it was. */

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'replay-'));
const init = (body: string) => ({ method: 'POST', headers: { Authorization: 'Bearer SECRET-KEY' }, body, signal: new AbortController().signal });

/** A network that answers with a counter, so a replayed answer can be told from a live one. */
function network(): { fetch: FetchLike; calls: () => number } {
  let n = 0;
  return {
    fetch: async (_url, i) => { n++; const text = JSON.stringify({ n, echo: i.body }); return { ok: true, status: 200, text: async () => text, headers: { get: () => null } }; },
    calls: () => n
  };
}

test('a resumed run serves the logged answers to the same requests, in order and per channel, before the network', async () => {
  const d = dir(), first = path.join(d, 'a.jsonl'), second = path.join(d, 'b.jsonl');
  const net = network();
  const log = new ReplayLog(first);
  const llm = log.wrap('llm', net.fetch);
  const a1 = await (await llm('u', init('{"q":1}'))).text();
  const a2 = await (await llm('u', init('{"q":1}'))).text();
  const b = await (await log.wrap('jev', net.fetch)('u', init('{"q":1}'))).text();
  assert.deepEqual(log.stats(), { replayed: {}, live: { llm: 2, jev: 1 }, unused: 0 });

  const again = network();
  const resumed = new ReplayLog(second, { from: first });
  assert.equal(resumed.pending(), 3);
  const llm2 = resumed.wrap('llm', again.fetch);
  assert.equal(await (await llm2('u', init('{"q":1}'))).text(), a1);
  assert.equal(await (await llm2('u', init('{"q":1}'))).text(), a2, 'the same request twice: its answers in order');
  assert.equal(await (await resumed.wrap('jev', again.fetch)('u', init('{"q":1}'))).text(), b, 'channels are apart');
  assert.equal(again.calls(), 0, 'nothing asked of the network while the log has the answer');
  await llm2('u', init('{"q":2}'));
  assert.equal(again.calls(), 1, 'then the network, live');
  assert.deepEqual(resumed.stats(), { replayed: { llm: 2, jev: 1 }, live: { llm: 1 }, unused: 0 });
  assert.equal(readReplayLog(first).length, 3, 'the log resumed is left as it was');
  assert.equal(readReplayLog(second).length, 4, 'the new log holds every answer it used: it can be resumed in turn');
});

test('a line cut by a hard stop is dropped, and the answers after it are not lost (the resumed run writes elsewhere)', async () => {
  const d = dir(), first = path.join(d, 'a.jsonl'), second = path.join(d, 'b.jsonl'), third = path.join(d, 'c.jsonl');
  await new ReplayLog(first).wrap('llm', network().fetch)('u', init('q1'));
  fs.appendFileSync(first, '{"channel":"llm","key":"cut');
  const r1 = new ReplayLog(second, { from: first });
  await r1.wrap('llm', network().fetch)('u', init('q1'));
  await r1.wrap('llm', network().fetch)('u', init('q2'));
  const r2 = new ReplayLog(third, { from: second });
  assert.equal(r2.pending(), 2, 'q1 replayed and q2 live are both there');
});

test('a resumed run never writes into the log it resumes', () => {
  const d = dir(), first = path.join(d, 'a.jsonl');
  new ReplayLog(first);
  assert.throws(() => new ReplayLog(first, { from: first }), /log of its own/);
});

test('a request the log does not answer while answers wait there is a divergence: the network is not asked', async () => {
  const d = dir(), first = path.join(d, 'a.jsonl');
  const log = new ReplayLog(first);
  await log.wrap('llm', network().fetch)('u', init('{"q":1}'));
  await log.wrap('llm', network().fetch)('u', init('{"q":2}'));
  const net = network();
  let told: unknown = null;
  const resumed = new ReplayLog(path.join(d, 'b.jsonl'), { from: first, stallMs: 30, onDiverge: (x) => { told = x; } });
  await assert.rejects(resumed.wrap('llm', net.fetch)('u', init('{"q":"other"}')), ReplayDivergence);
  assert.equal(net.calls(), 0);
  assert.deepEqual(told, { channel: 'llm', pending: 2 });
  assert.deepEqual(resumed.stats().diverged, { channel: 'llm', pending: 2 });
  await assert.rejects(resumed.wrap('llm', net.fetch)('u', init('{"q":1}')).then(() => { throw new Error('served'); }), /served|diverged/);
});

test('requests that run together may reach the log in another order: one without an answer waits for the others', async () => {
  const d = dir(), first = path.join(d, 'a.jsonl');
  const log = new ReplayLog(first);
  for (const q of ['1', '2', '3']) await log.wrap('jev', network().fetch)('u', init(q));
  /* The first run was cut while "4" was in flight: "1".."3" were answered. Resumed, "4" is asked before "2" and "3". */
  const net = network();
  const resumed = new ReplayLog(path.join(d, 'b.jsonl'), { from: first, stallMs: 200 });
  const jev = resumed.wrap('jev', net.fetch);
  const four = jev('u', init('4'));
  await jev('u', init('1'));
  await new Promise((r) => setTimeout(r, 20));
  await jev('u', init('2'));
  await jev('u', init('3'));
  assert.ok((await four).ok);
  assert.equal(net.calls(), 1, 'only "4" went live, once nothing was waiting');
  assert.equal(resumed.stats().diverged, undefined);
});

test('the log never holds a request, its headers or a key; failed answers are not logged', async () => {
  const file = path.join(dir(), 'a.jsonl');
  const log = new ReplayLog(file);
  await log.wrap('llm', network().fetch)('u', init('{"prompt":"hello"}'));
  const failing: FetchLike = async () => ({ ok: false, status: 503, text: async () => 'busy', headers: { get: () => null } });
  assert.equal((await log.wrap('llm', failing)('u', init('{"x":1}'))).ok, false);
  const text = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(text, /SECRET-KEY|Authorization|Bearer/);
  assert.equal(text.trim().split('\n').length, 1);
});

test('a resumed run repeats the experiment\'s arguments and takes the budgets given now', () => {
  const given = ['--seed', '2', '--level', '3', '--out', 'runs/x.json', '--max-tokens', '5000', '--flat'];
  assert.deepEqual(experimentArgs(given), ['--seed', '2', '--level', '3', '--flat']);
  assert.deepEqual(budgetArgs(['--resume', 'runs/x.json', '--max-minutes', '30', '--seed', '9']), ['--max-minutes', '30']);
});

test('a session the host halts asks System 2 nothing more, and says why', async () => {
  let asked = 0;
  const events: { type: string; data?: Record<string, unknown> }[] = [];
  let stop: string | null = null;
  const session = new LawSession<never>({
    llm: { complete: async () => { asked++; return { content: JSON.stringify({ investigate: [{ view: 'e' }] }), latencyMs: 0, raw: null }; } },
    system: 'S', world: 'w@1', perceptDoc: 'P', steps: 3, investigative: true,
    parseAct: () => 'no act', runRequest: async () => { stop = 'cancelled'; return { viewed: true }; },
    known: () => true, failures: () => [], episodes: () => [], places: () => [], validationsLeft: () => 3, lastCheck: () => null,
    log: (type, data) => { events.push({ type, data }); }, say: () => {}, halt: () => stop
  });
  assert.equal(await session.consult('propose'), null);
  assert.equal(asked, 1, 'the answer in flight is kept; the next question is not asked');
  assert.equal(session.halted, 'cancelled');
  assert.deepEqual(events.map((e) => e.type), ['investigation', 'halted']);
  assert.equal(events[1].data?.reason, 'cancelled');
  assert.equal(await session.consult('reflect', 't'), null);
  assert.equal(asked, 1);
});

/* After the third external audit: a request is known by its method, path and parameters too; a resume needs its log. */

test('a request is its method, path, parameters and body: another request is not given the answer of the first', async () => {
  const d = dir(), first = path.join(d, 'a.jsonl');
  const at = (method: string, body = '{"x":1}') => ({ method, headers: {}, body, signal: new AbortController().signal });
  await new ReplayLog(first).wrap('env', network().fetch)('http://service.test/first?place=p1', at('POST'));
  for (const [url, method] of [['http://service.test/different?place=p1', 'PUT'], ['http://service.test/first?place=p1', 'PUT'],
    ['http://service.test/second?place=p1', 'POST'], ['http://service.test/first?place=p2', 'POST']] as const) {
    const net = network();
    const resumed = new ReplayLog(path.join(d, 'b.jsonl'), { from: first, stallMs: 30 });
    await assert.rejects(resumed.wrap('env', net.fetch)(url, at(method)), ReplayDivergence, method + ' ' + url);
    assert.equal(net.calls(), 0, 'and the network is not asked');
  }
});

test('the same request is still the same when the service moved or a credential in its URL rotated', async () => {
  const d = dir(), first = path.join(d, 'a.jsonl');
  const at = { method: 'POST', headers: {}, body: '{"x":1}', signal: new AbortController().signal };
  const answer = await (await new ReplayLog(first).wrap('env', network().fetch)('http://127.0.0.1:18300/step?place=p1&key=OLD', at)).text();
  const net = network();
  const resumed = new ReplayLog(path.join(d, 'b.jsonl'), { from: first });
  assert.equal(await (await resumed.wrap('env', net.fetch)('http://127.0.0.1:18400/step?key=NEW&place=p1', at)).text(), answer);
  assert.equal(net.calls(), 0);
  assert.doesNotMatch(fs.readFileSync(first, 'utf8'), /OLD|place=|step/, 'the log holds no URL');
});

test('a resume without the log of the run it resumes is an error, never an empty history', () => {
  const d = dir();
  assert.throws(() => new ReplayLog(path.join(d, 'b.jsonl'), { from: path.join(d, 'missing.jsonl') }), /missing/);
});
