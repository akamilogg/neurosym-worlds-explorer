import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReplayLog } from '../src/runtime/replay.ts';
import { budgetArgs, experimentArgs } from '../src/runtime/lab-runner.ts';
import { LawSession } from '../src/learn/law-session.ts';
import type { FetchLike } from '../src/core/net.ts';

/* SPEC-OBJETIVO O11: a run can be stopped (Ctrl+C, a budget) and resumed by replaying what came over the network. */

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'replay-')), 'run.replay.jsonl');
const init = (body: string) => ({ method: 'POST', headers: { Authorization: 'Bearer SECRET-KEY' }, body, signal: new AbortController().signal });

/** A network that answers with a counter, so a replayed answer can be told from a live one. */
function network(): { fetch: FetchLike; calls: () => number } {
  let n = 0;
  return {
    fetch: async (_url, i) => { n++; const text = JSON.stringify({ n, echo: i.body }); return { ok: true, status: 200, text: async () => text, headers: { get: () => null } }; },
    calls: () => n
  };
}

test('answers are logged as they arrive, and a resumed log serves them to the same requests, in order, before the network', async () => {
  const file = tmp();
  const first = network();
  const log = new ReplayLog(file);
  const llm = log.wrap('llm', first.fetch);
  const a1 = await (await llm('u', init('{"q":1}'))).text();
  const a2 = await (await llm('u', init('{"q":1}'))).text();
  const b = await (await log.wrap('jev', first.fetch)('u', init('{"q":1}'))).text();
  assert.deepEqual(log.stats(), { replayed: {}, live: { llm: 2, jev: 1 }, unused: 0 });

  const second = network();
  const resumed = new ReplayLog(file, { resume: true });
  assert.equal(resumed.pending(), 3);
  const llm2 = resumed.wrap('llm', second.fetch);
  assert.equal(await (await llm2('u', init('{"q":1}'))).text(), a1);
  assert.equal(await (await llm2('u', init('{"q":1}'))).text(), a2, 'the same request twice: its answers in order');
  assert.equal(await (await resumed.wrap('jev', second.fetch)('u', init('{"q":1}'))).text(), b, 'channels are apart');
  assert.equal(second.calls(), 0, 'nothing asked of the network while the log has the answer');
  await llm2('u', init('{"q":2}'));
  assert.equal(second.calls(), 1, 'then the network, live');
  assert.deepEqual(resumed.stats(), { replayed: { llm: 2, jev: 1 }, live: { llm: 1 }, unused: 0 });
});

test('the log never holds a request, its headers or a key; failed answers are not logged', async () => {
  const file = tmp();
  const log = new ReplayLog(file);
  await log.wrap('llm', network().fetch)('u', init('{"prompt":"hello"}'));
  const failing: FetchLike = async () => ({ ok: false, status: 503, text: async () => 'busy', headers: { get: () => null } });
  assert.equal((await log.wrap('llm', failing)('u', init('{"x":1}'))).ok, false);
  const text = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(text, /SECRET-KEY|Authorization|Bearer/);
  assert.equal(text.trim().split('\n').length, 1);
});

test('a resumed run that asks something else leaves logged answers unused: it is said to have diverged', async () => {
  const file = tmp();
  await new ReplayLog(file).wrap('llm', network().fetch)('u', init('{"q":1}'));
  const resumed = new ReplayLog(file, { resume: true });
  await resumed.wrap('llm', network().fetch)('u', init('{"q":"other"}'));
  assert.equal(resumed.stats().unused, 1);
  assert.equal(new ReplayLog(file).pending(), 0, 'a new run starts a new log');
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
