import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { platesLab } from '../src/worlds/plates/lab.ts';
import { rebuildLivingSession, runLivingSession, type SessionPlan } from '../src/living/run-session.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';

/* SPEC-VALIDEZ-MEDIDA §9 (V15): a shared session in which a researcher was late to a window - sealed empty by its timeout, on
   the wall clock - rebuilt from its record. Its answers replayed come at once: the window must still be sealed without it. */

const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), name + '-'));
const MODEL = { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.frames[p.frames.length - 1].colony', validate: false, lessons: ['l'], next_experiment: 'n', beliefs: [] };
const reply = (content: unknown) => { const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } }); return { ok: true, status: 200, text: async () => text, headers: { get: () => null } }; };
const researcher = (script: Record<number, unknown[]>, delay = 0): FetchLike => async (_url, init) => {
  if (delay) await new Promise((r) => setTimeout(r, delay));
  const user = JSON.parse(userOf(JSON.parse(String(init.body))));
  if ('task' in user) return reply({ rationale: 'r', beliefs: [], lessons: ['l'], next_experiment: 'n' });
  const steps = script[user.round] ?? [MODEL];
  return reply(steps[Math.min((user.investigation ?? []).length, steps.length - 1)]);
};
const FLAT = ['--flat', '--no-grade', '--no-reflection', '--no-ablation'];
const offline: FetchLike = async () => { throw new Error('offline: a reconstruction asks nothing live'); };

test('V15: a session rebuilt from its record seals a member empty in the window the record says it missed, though its answer comes at once', async () => {
  const dir = tmp('living-rebuild-timeout');
  const plan: SessionPlan = { seed: 4, clock: { decision_interval: 3, horizon: 300 }, explore: 1, limits: { calls_per_window: 2, intents_per_window: 2, window_ms: 150 },
    actors: [{ id: 'a', kind: 'researcher', rounds: 2, steps: 2, acts: 1 } as never, { id: 'b', kind: 'researcher', rounds: 2, steps: 2, acts: 1 } as never] };
  const script = { 1: [{ investigate: [{ act: { feed: 'A1', amount: 1 } }] }, MODEL], 2: [{ investigate: [{ act: { feed: 'B2', amount: 1 } }] }, MODEL] };
  const first = await runLivingSession(platesLab, { plan, dir, name: 'one', root: dir, args: FLAT,
    connection: (id) => ({ llm: { url: 'http://x.test/c', model: 's' }, fetch: researcher(script, id === 'b' ? 500 : 0) }) });
  const keys = (file: string) => fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l).key as string);
  const timeouts = keys(first.world).filter((k) => /\.timeout$/.test(k));
  assert.ok(timeouts.length > 0, 'the slow member missed a window: ' + keys(first.world).join(' '));
  const again = path.join(dir, 'again');
  const r = await rebuildLivingSession(platesLab, { sessionFile: path.join(dir, 'one.session.json'), dir: again, name: 'two', root: dir,
    connection: () => ({ llm: { url: 'http://x.test/c', model: 's' }, fetch: offline }) });
  for (const [id, run] of Object.entries(r.runs)) {
    assert.notEqual(run.stoppedBy, 'diverged', id + ': ' + JSON.stringify(run));
    const events = JSON.parse(fs.readFileSync(run.journal!, 'utf8')).events as Record<string, any>[];
    assert.ok(!events.some((e) => e.type === 'world_diverged'), id + ': ' + JSON.stringify(events.filter((e) => e.type === 'world_diverged')));
  }
  assert.deepEqual(keys(r.world).filter((k) => /\.timeout$/.test(k)), timeouts, 'the same windows missed');
});

test('V17: a senior that fails in a shared session is kept in the session\'s record beside its researcher\'s run', async () => {
  const dir = tmp('living-senior-fails');
  const plan: SessionPlan = { seed: 3, clock: { decision_interval: 3, horizon: 120 }, explore: 1, limits: { calls_per_window: 2, intents_per_window: 2, window_ms: 20000 },
    actors: [{ id: 'a', kind: 'researcher', rounds: 1, steps: 2, acts: 1, senior: { max_orders: 1 } } as never, { id: 'b', kind: 'researcher', rounds: 1, steps: 2, acts: 1 } as never] };
  const script = { 1: [{ investigate: [{ observe: true }] }, MODEL] };
  const r = await runLivingSession(platesLab, { plan, dir, name: 's', root: dir, args: FLAT, connection: () => ({ llm: { url: 'http://x.test/c', model: 's' }, fetch: researcher(script) }),
    seniorLlm: () => { throw new Error('no senior LLM here'); } });
  const rec = JSON.parse(fs.readFileSync(path.join(dir, 's.session.json'), 'utf8'));
  assert.match(String(rec.runs.a.senior_error ?? r.runs.a.senior_error), /no senior LLM here/, JSON.stringify(rec.runs.a));
  assert.equal(rec.runs.b.senior_error, undefined);
});

test('V16: an agent reading a journal caught mid-write reads it again before it takes it for none', async () => {
  const { readJournal } = await import('../src/orchestra/agent-operator.ts');
  const dir = tmp('agent-read');
  const f = path.join(dir, 'run.json');
  fs.writeFileSync(f, '{"events": [{"type": "sta');
  setTimeout(() => fs.writeFileSync(f, JSON.stringify({ events: [{ type: 'start' }] })), 60);
  assert.deepEqual(await readJournal(f, 3, 50), { events: [{ type: 'start' }] });
  fs.writeFileSync(f, '{"never');
  assert.equal(await readJournal(f, 2, 10), null, 'one that never parses: none');
  assert.equal(await readJournal(path.join(dir, 'nowhere.json')), null);
});

test('V19: the generic living layer names nothing of one world - the adapter does - and plates@1 keeps its words', async () => {
  const { livingNaming } = await import('../src/worlds/labs.ts');
  for (const f of ['bridge.ts', 'record.ts', 'world.ts', 'run-session.ts']) {
    const code = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'living', f), 'utf8').split('\n').filter((l) => !/^\s*(\/\*|\*|\/\/)/.test(l)).join('\n');
    assert.doesNotMatch(code, /\bplate\b|\blayout\b|\.well\b/, f);
  }
  const n = livingNaming('plates@1');
  assert.equal(n.view, 'plate', 'its researcher still sees its plate');
  assert.deepEqual(n.realization, ['layout']);
  assert.equal(n.where?.({ kind: 'smudge', well: 'B2' }), 'B2');
  assert.deepEqual(livingNaming('another@1'), {});
});
