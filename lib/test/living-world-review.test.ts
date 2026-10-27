import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { platesLab } from '../src/worlds/plates/lab.ts';
import { platesAdapter, type PlatesFrame } from '../src/worlds/plates/world.ts';
import { LivingSession, WorldJournal, type ActorDecl } from '../src/living/world.ts';
import { LivingBridge, actorSlug, sharedName } from '../src/living/bridge.ts';
import { runLivingSession } from '../src/living/run-session.ts';
import { readManifest } from '../src/living/manifest.ts';
import { LABS } from '../src/worlds/labs.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';
import { nodeVmRunner } from '../src/runtime/node-vm.ts';

/* An external review of H2 (27/10/2026), reconciled: a continuation closes where it closes, never as the run it continues;
   a window waits only so long for a member asleep too; the order of a window's publications is the window's, never who
   published first; a researcher alone keeps its id and its permissions; an answer rests on the revision it was asked on,
   whatever it reads meanwhile; an author's shared material keeps its author; the senior's branches refused in a living world. */

const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), name + '-'));
const lines = (f: string) => fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const world = (actors: readonly (string | ActorDecl)[], limits: Record<string, number> = {}, file: string | null = null) => new LivingSession({ adapter: platesAdapter as never, id: 'world:r', config: { layout: 5 }, seed: 5, actors,
  clock: { decision_interval: 3, horizon: 120 }, limits: { calls_per_window: 4, intents_per_window: 3, messages_per_window: 3, message_chars: 300, ...limits }, journal: new WorldJournal(file) });
const MODEL = { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.frames[p.frames.length - 1].colony', validate: false, lessons: ['l'], next_experiment: 'n', beliefs: [] };
const reply = (content: unknown) => { const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } }); return { ok: true, status: 200, text: async () => text, headers: { get: () => null } }; };
const researcher = (script: Record<number, unknown[]>): FetchLike => async (_url, init) => {
  const user = JSON.parse(userOf(JSON.parse(String(init.body))));
  if ('task' in user) return reply({ rationale: 'r', beliefs: [], lessons: ['l'], next_experiment: 'n' });
  const steps = script[user.round] ?? [MODEL];
  return reply(steps[Math.min((user.investigation ?? []).length, steps.length - 1)]);
};
const COMMON = ['--seed', '1', '--researcher', 'assisted', '--flat', '--no-grade', '--no-reflection', '--no-ablation', '--explore', '1', '--steps', '4'];

test('1: a continuation closes where it closes - never kept as the run it continues closed, never a divergence', async () => {
  const dir = tmp('rev-1');
  const script = { 1: [{ investigate: [{ act: { feed: 'A1', amount: 1 } }] }, MODEL], 2: [{ investigate: [{ wait: 4 }] }, MODEL] };
  const first = await runLaboratory(platesLab, { args: [...COMMON, '--attempts', '1', '--out', path.join(dir, 'run.json')], root: dir, llm: { url: 'http://x.test/c', model: 's' }, fetch: researcher(script) });
  const out = path.join(dir, 'more.json');
  const more = await runLaboratory(platesLab, { args: ['--resume', first.journal, '--attempts', '2', '--out', out], root: dir, llm: { url: 'http://x.test/c', model: 's' }, fetch: researcher(script) });
  const events = JSON.parse(fs.readFileSync(more.journal, 'utf8')).events as Record<string, any>[];
  assert.ok(!events.some((e) => e.type === 'world_diverged'), JSON.stringify(events.filter((e) => e.type === 'world_diverged')));
  const before = lines(first.journal.replace(/\.json$/, '.world.jsonl')).find((e) => e.key.startsWith('close@'))!;
  const closes = lines(out.replace(/\.json$/, '.world.jsonl')).filter((e) => e.key.startsWith('close@'));
  assert.equal(closes.length, 1);
  assert.ok(closes[0].tick > before.tick, 'it closed further on (' + closes[0].tick + ' after ' + before.tick + ')');
  assert.equal(events.find((e) => e.type === 'end')!.world.tick, closes[0].tick);
});

test('2: a window waits only so long for its members, one of them asleep: the other is a timeout, the world goes on', async () => {
  const s = world(['a', 'b'], { window_ms: 20 });
  assert.equal(s.wait('a', 6).accepted, true);
  await new Promise((r) => setTimeout(r, 90));
  assert.ok(s.tick > 0, 'the world went on');
  assert.deepEqual(s.windowRecord(1)!.timeouts, ['b']);
  s.close('end');
});

test('3: the order of a window\'s publications is the window\'s: who published first changes nothing of the world', () => {
  const play = (aFirst: boolean) => {
    const s = world(['a', 'b', { id: 'adv', kind: 'adversary', policy: 'adversary', actions: ['drain'], params: { amount: 3 } }], { intents_per_window: 2 });
    const say = { a: 'A1 A2', b: 'B1 B2' } as const;
    for (const who of aFirst ? ['a', 'b'] as const : ['b', 'a'] as const) assert.equal(s.send(who, { actor: 'adv' }, 'notice', { text: say[who] }).accepted, true);
    for (let k = 0; k < 3; k++) { s.seal('a', []); s.seal('b', []); s.settle(); }
    return { state: s.summary().state, outcomes: [1, 2, 3].map((n) => s.windowRecord(n)!.outcomes), ids: s.history('a').messages.map((m) => m.id) };
  };
  assert.deepEqual(play(true), play(false));
});

test('4: a researcher alone keeps its id and its permissions - a manifest\'s, never the world\'s defaults', async () => {
  const m = readManifest({ format: 'living-world@1', adapter: 'plates@1', seed: 1, clock: { mode: 'simulated', decision_interval: 3, horizon: 60 },
    limits: { calls_per_window: 4, intents_per_window: 4 }, actors: [{ id: 'alice', kind: 'researcher', rounds: 1, steps: 3, acts: 2, actions: [] }] }, LABS);
  assert.ok(!('errors' in m) && m.args);
  assert.ok(m.args.join(' ').includes('--actor alice --actions none'));
  const dir = tmp('rev-4');
  const r = await runLaboratory(platesLab, { args: [...m.args, '--flat', '--no-grade', '--no-reflection', '--no-ablation', '--explore', '1', '--out', path.join(dir, 'run.json')], root: dir,
    llm: { url: 'http://x.test/c', model: 's' }, fetch: researcher({ 1: [{ investigate: [{ act: { feed: 'A1', amount: 1 } }] }, MODEL] }) });
  const j = JSON.parse(fs.readFileSync(r.journal, 'utf8'));
  assert.equal(j.world.actor, 'alice');
  const step = j.events.find((e: any) => e.type === 'investigation');
  assert.match(step.results[0].reason, /you may not "feed"/);
  const manifest = lines(r.journal.replace(/\.json$/, '.world.jsonl'))[0];
  assert.deepEqual(manifest.actors, [{ id: 'alice', kind: 'researcher', actions: [] }]);
});

test('5: an answer rests on the revision it was asked on - reading the world within it changes nothing of that', async () => {
  const s = world(['a', 'b'], { window_ms: 10 });
  const bridge = new LivingBridge<{ kind: string; well: string }>({ session: s, actor: 'a', intent: (x) => ({ kind: x.kind, params: { well: x.well, amount: 1 } }), asWritten: (x) => x,
    shown: () => ({}), store: () => 'act1', material: () => 'none', own: () => false, deliver: () => {}, log: () => {}, say: () => {} });
  bridge.decide();
  /* While it thinks, the world goes on without it: b sealed, a's time ran out. */
  s.seal('b', []);
  s.settle();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(s.revision, 1);
  const seen = bridge.observe();
  assert.equal(seen.revision, 1);
  const [act] = await bridge.endStep(1, [seen, bridge.act({ kind: 'feed', well: 'A1' }, { acts: 2 })]).then((r) => r.slice(1)) as Record<string, any>[];
  assert.equal(act.accepted, false);
  assert.match(act.reason, /late: you decided on revision 0/);
  s.close('end');
});

test('6: an author\'s shared material keeps its author: one name for each, never two authors under one', () => {
  const names = ['Alice', 'alice', 'a_b', 'a-b', 'ab', 'A-b', 'a.b'].map((id) => sharedName(id, 'act1'));
  assert.equal(new Set(names).size, names.length, names.join(' '));
  for (const n of names) assert.match(n, /^[a-z][a-z0-9-]*$/);
  assert.ok(names.every((n) => n.endsWith('--act1')));
});

/* A second review of H2 (27/10/2026), reconciled: one file for each researcher wherever capitals are one; a closing told
   apart by its stretch of execution, even where the clock did not move; no message accepted that no window will carry. */

test('one journal for each researcher, even where the file system does not tell capitals apart', async () => {
  assert.notEqual(actorSlug('Alice').toLowerCase(), actorSlug('alice').toLowerCase());
  const dir = tmp('rev2-files');
  const r = await runLivingSession(platesLab, { dir, name: 'pair', root: dir, args: ['--flat', '--no-grade', '--no-reflection', '--no-ablation'],
    plan: { seed: 1, clock: { decision_interval: 3, horizon: 60 }, explore: 1, limits: { calls_per_window: 2, intents_per_window: 2, window_ms: 20000 },
      actors: [{ id: 'Alice', kind: 'researcher', rounds: 1, steps: 2, acts: 1 }, { id: 'alice', kind: 'researcher', rounds: 1, steps: 2, acts: 1 }] },
    connection: () => ({ llm: { url: 'http://x.test/c', model: 's' }, fetch: researcher({ 1: [MODEL] }) }) });
  const files = [r.runs.Alice.journal!, r.runs.alice.journal!];
  assert.notEqual(files[0].toLowerCase(), files[1].toLowerCase());
  assert.deepEqual(files.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')).world.actor).sort(), ['Alice', 'alice']);
});

test('a continuation where the clock did not move closes as itself: never the closing of the run it continues', async () => {
  const dir = tmp('rev2-close');
  const script = { 1: [{ investigate: [{ observe: true }] }, MODEL], 2: [{ investigate: [{ observe: true }] }, { investigate: [{ observe: true }] }, MODEL] };
  const args = ['--seed', '1', '--researcher', 'assisted', '--flat', '--no-grade', '--no-reflection', '--no-ablation', '--explore', '1', '--steps', '4', '--horizon', '3'];
  const first = await runLaboratory(platesLab, { args: [...args, '--attempts', '1', '--out', path.join(dir, 'run.json')], root: dir, llm: { url: 'http://x.test/c', model: 's' }, fetch: researcher(script) });
  const out = path.join(dir, 'more.json');
  const more = await runLaboratory(platesLab, { args: ['--resume', first.journal, '--attempts', '2', '--out', out], root: dir, llm: { url: 'http://x.test/c', model: 's' }, fetch: researcher(script) });
  const events = JSON.parse(fs.readFileSync(more.journal, 'utf8')).events as Record<string, any>[];
  assert.ok(!events.some((e) => e.type === 'world_diverged'), JSON.stringify(events.filter((e) => e.type === 'world_diverged')));
  const before = lines(first.journal.replace(/\.json$/, '.world.jsonl')).filter((e) => e.key.startsWith('close@'));
  const after = lines(out.replace(/\.json$/, '.world.jsonl')).filter((e) => e.key.startsWith('close@'));
  assert.equal(after.length, 1);
  assert.equal(after[0].tick, before[0].tick, 'the clock did not move');
  assert.notEqual(after[0].key, before[0].key);
});

test('at the horizon a message is refused: no window will carry it', () => {
  const s = new LivingSession({ adapter: platesAdapter as never, id: 'h', config: { layout: 5 }, seed: 5, actors: ['a', 'b'], clock: { decision_interval: 2, horizon: 2 },
    limits: { calls_per_window: 2, intents_per_window: 2, messages_per_window: 2, message_chars: 100 }, journal: new WorldJournal(null) });
  s.seal('a', []); s.seal('b', []); s.settle();
  assert.equal(s.ended, true);
  assert.match((s.send('a', { actor: 'b' }, 'notice', { text: 'late' }) as { reason: string }).reason, /horizon/);
});

/* A review of H3 (27/10/2026), reconciled: each watcher its own consistent inputs, whatever others measure; a wait refused
   seals nothing; a watcher registered again takes a place of its own; a closing told apart by where its record is too. */

test('watchers: two identical ones read the same capture and the same previous - never one another\'s', () => {
  const s = new LivingSession({ adapter: platesAdapter as never, id: 'w', config: { layout: 5 }, seed: 5, actors: ['a'], clock: { decision_interval: 1, horizon: 20 },
    limits: { calls_per_window: 2, intents_per_window: 2, watchers: 2 }, journal: new WorldJournal(null),
    compile: (src) => { const fn = nodeVmRunner({ timeoutMs: 500 }).compile(src); return (i: unknown) => fn(i as never); } });
  const d = { measure: '(o) => o.previous ? o.frame.tick - o.previous.tick : -1', every: 1, when: { above: 0 }, for: 10, notices: 5, cooldown: 0 };
  s.watch('a', { id: 'one', ...d }); s.watch('a', { id: 'two', ...d });
  for (let k = 0; k < 3; k++) { s.seal('a', []); s.settle(); }
  const by = (id: string) => s.inbox('a').messages.filter((m) => m.from === 'instrument:' + id).map((m) => [m.body.tick, m.body.measured]);
  assert.deepEqual(by('one'), by('two'));
  assert.ok(by('one').length >= 2 && by('one').every(([, v]) => v === 1));
});

test('a wait refused seals nothing: the next act of the window is taken', () => {
  const s = new LivingSession({ adapter: platesAdapter as never, id: 'w', config: { layout: 5 }, seed: 5, actors: ['a'], clock: { decision_interval: 3, horizon: 20 },
    limits: { calls_per_window: 2, intents_per_window: 2 }, journal: new WorldJournal(null) });
  assert.equal(s.wait('a', 5, undefined, ['message']).accepted, false);
  assert.equal(s.seal('a', [{ kind: 'feed', params: { well: 'A1', amount: 1 } }])[0].accepted, true);
});

test('a watcher stopped and registered again takes a place of its own within the limit', () => {
  const s = new LivingSession({ adapter: platesAdapter as never, id: 'w', config: { layout: 5 }, seed: 5, actors: ['a'], clock: { decision_interval: 3, horizon: 20 },
    limits: { calls_per_window: 2, intents_per_window: 2, watchers: 1 }, journal: new WorldJournal(null),
    compile: (src) => { const fn = nodeVmRunner({ timeoutMs: 500 }).compile(src); return (i: unknown) => fn(i as never); } });
  const d = { measure: '(o) => 1', every: 1, when: { above: 0 }, for: 10, notices: 1 };
  assert.ok('version' in s.watch('a', { id: 'one', ...d }));
  assert.equal(s.unwatch('a', 'one'), true);
  assert.ok('version' in s.watch('a', { id: 'two', ...d }));
  assert.match((s.watch('a', { id: 'one', ...d }) as { refused: string }).refused, /at most 1 watchers/);
  assert.ok('version' in s.watch('a', { id: 'two', ...d }), 'a new version of one measuring: its own place');
});

test('a continuation into another folder, under the same name, where the clock did not move, closes as itself', async () => {
  const root = tmp('rev3-folders');
  fs.mkdirSync(path.join(root, 'a')); fs.mkdirSync(path.join(root, 'b'));
  const script = { 1: [{ investigate: [{ observe: true }] }, MODEL], 2: [{ investigate: [{ observe: true }] }, { investigate: [{ observe: true }] }, MODEL] };
  const args = ['--seed', '1', '--researcher', 'assisted', '--flat', '--no-grade', '--no-reflection', '--no-ablation', '--explore', '1', '--steps', '4', '--horizon', '3'];
  const first = await runLaboratory(platesLab, { args: [...args, '--attempts', '1', '--out', path.join(root, 'a', 'run.json')], root, llm: { url: 'http://x.test/c', model: 's' }, fetch: researcher(script) });
  const out = path.join(root, 'b', 'run.json');
  const more = await runLaboratory(platesLab, { args: ['--resume', first.journal, '--attempts', '2', '--out', out], root, llm: { url: 'http://x.test/c', model: 's' }, fetch: researcher(script) });
  const events = JSON.parse(fs.readFileSync(more.journal, 'utf8')).events as Record<string, any>[];
  assert.ok(!events.some((e) => e.type === 'world_diverged'), JSON.stringify(events.filter((e) => e.type === 'world_diverged')));
});
