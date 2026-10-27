import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { platesLab } from '../src/worlds/plates/lab.ts';
import { platesAdapter, platesLaws, platesState, platesTick } from '../src/worlds/plates/world.ts';
import { LivingSession, WorldJournal } from '../src/living/world.ts';
import { LivingBridge } from '../src/living/bridge.ts';
import { readManifest } from '../src/living/manifest.ts';
import { LABS } from '../src/worlds/labs.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';

/* SPEC-ACONTECIMIENTOS-DEL-MUNDO, H1: one persistent world, the assisted researcher in its loop, the bridge with its
   Objective, the session's journal and its resources. Acceptance tests 1, 4 (without delegating), 12 (transitions and the
   deliveries of one actor's observations) and 17 (without retiring actors); a round across several windows, queries that
   advance nothing, a proposal without acting; the conversation only grows. */

const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), name + '-'));
const session = (dir: string | null, o: { interval?: number; horizon?: number; calls?: number; from?: string; file?: string } = {}) => new LivingSession({
  adapter: platesAdapter as never, id: 'world:test', config: { layout: 7 }, seed: 7, actors: ['researcher'],
  clock: { decision_interval: o.interval ?? 3, horizon: o.horizon ?? 100 }, limits: { calls_per_window: o.calls ?? 4, intents_per_window: 4 },
  journal: new WorldJournal(o.file ?? (dir ? path.join(dir, 'w.world.jsonl') : null), { ...(o.from ? { from: o.from } : {}) }) });
const lines = (f: string) => fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('the plate: its laws by tick, deterministic, contamination never perceived, marks of no consequence', () => {
  const laws = platesLaws(3);
  const a = platesState(laws, 11, { contaminated: 2, arrivals: false });
  const b = platesState(laws, 11, { contaminated: 2, arrivals: false });
  assert.deepEqual(platesTick(a, []).state, platesTick(b, []).state, 'the same state and intents: the same next state');
  const frame = platesAdapter.observe(a, 'researcher') as unknown as Record<string, unknown>;
  assert.deepEqual(Object.keys(frame).sort(), ['colony', 'marks', 'nutrient', 'tick'], 'the projection, never the state: no contamination in it');
  /* A contaminated well falls by two; the same plate without its contamination does not. */
  const i = a.contaminated.findIndex(Boolean);
  const clean = { ...a, contaminated: a.contaminated.map(() => false) };
  assert.equal(platesTick(a, []).state.colony[i], Math.max(0, a.colony[i] - 2));
  assert.ok(platesTick(clean, []).state.colony[i] >= a.colony[i] - 1);
  /* Marks change nothing: the same plate with every mark flipped grows the same. */
  const marked = { ...a, marks: a.marks.map((m) => !m) };
  assert.deepEqual(platesTick(marked, []).state.colony, platesTick(a, []).state.colony);
});

test('1: the world goes on while its actor waits; a well changes and is seen again in the same persistent state', () => {
  const s = session(tmp('living-1'));
  const before = s.observe('researcher');
  assert.equal(s.observe('researcher').tick, before.tick, 'observing advances nothing');
  assert.equal(s.wait('researcher', 5).accepted, true);
  const windows = [];
  while (s.actorState('researcher') === 'waiting') windows.push(s.runWindow()!);
  assert.deepEqual(windows.map((w) => [w.from, w.to]), [[0, 3], [3, 5]], 'windows of the interval, the last cut where it wakes');
  const after = s.observe('researcher');
  assert.equal(after.tick, 5);
  assert.equal(after.revision, 2);
  assert.notDeepEqual((after.view as { colony: string }).colony, (before.view as { colony: string }).colony, 'the plate changed');
  assert.equal(windows[1].segments.get('researcher')!.frames.length, 3, 'it watched its stretch: the frame before and one per tick');
  /* The same session goes on from there: an act lands on the state it left, not on a new one. */
  const r = s.seal('researcher', [{ kind: 'feed', params: { well: 'A1', amount: 3 } }]);
  assert.equal(r[0].accepted, true);
  const w = s.runWindow()!;
  assert.equal(w.from, 5);
  assert.equal(w.outcomes[0].outcome, 'applied');
});

test('17 (no actor retired): a pause freezes the clock; closing keeps what was in course; the horizon stops the world, never loops', () => {
  const dir = tmp('living-17');
  const s = session(dir, { horizon: 7 });
  s.seal('researcher', [{ kind: 'clean', params: { well: 'B2' } }]);
  s.pause();
  assert.equal(s.runWindow(), null, 'paused: no window');
  s.resume();
  /* Resumed, the window that waited is applied at once. An interval of 3 ticks and a cleaning of 2: done within it. Then one
     more act, then the horizon. */
  assert.equal(s.window, 1);
  assert.equal(s.windowRecord(1)!.outcomes[0].completes_at, 2);
  s.seal('researcher', [{ kind: 'clean', params: { well: 'C3' } }]);
  s.runWindow();
  s.seal('researcher', [{ kind: 'clean', params: { well: 'D4' } }]);
  const last = s.runWindow()!;
  assert.deepEqual([last.from, last.to], [6, 7], 'the last window ends at the horizon');
  assert.equal(s.ended, true);
  assert.equal(s.seal('researcher', [{ kind: 'feed', params: { well: 'A1', amount: 1 } }])[0].reason?.includes('horizon'), true);
  assert.equal(s.runWindow(), null);
  const closed = s.close('budget');
  assert.equal(closed.status, 'completed');
  assert.deepEqual((closed.pending as { kind: string }[]).map((p) => p.kind), ['clean'], 'the cleaning begun at tick 6 is kept as pending');
  const entries = lines(path.join(dir, 'w.world.jsonl'));
  assert.ok(entries.some((e) => e.key === 'pause@w0.1') && entries.some((e) => e.key === 'resume@w0.1'));
  assert.match(entries[entries.length - 1].key, /^close@w3\.t7\.w-[0-9a-z]+$/, 'under where it closed, and by which stretch of execution');
});

test('12: a crash before or after a transition or a delivery - derived again, nothing twice, nothing lost; a divergence said so', () => {
  const dir = tmp('living-12');
  const first = path.join(dir, 'a.world.jsonl');
  const play = (file: string, from?: string) => {
    const s = session(null, { file, ...(from ? { from } : {}) });
    for (let k = 0; k < 4; k++) {
      s.seal('researcher', [{ kind: 'feed', params: { well: 'A' + (k + 1), amount: 2 } }]);
      const w = s.runWindow()!;
      s.delivered('researcher', 'w' + w.window, { episode: 'act' + k });
    }
    return s;
  };
  play(first);
  const all = lines(first);
  /* It crashed after preparing window 3, before committing it: its record ends there. */
  const cut = all.findIndex((e) => e.key === 'w3.prepare');
  fs.writeFileSync(first, all.slice(0, cut + 1).map((e) => JSON.stringify(e)).join('\n') + '\n');
  const second = path.join(dir, 'b.world.jsonl');
  const s = play(second, first);
  const keys = lines(second).map((e) => e.key);
  assert.equal(new Set(keys).size, keys.length, 'no entry twice');
  assert.deepEqual(keys, all.map((e) => e.key), 'every transition and delivery, once');
  assert.ok(s.journal.carried.includes('w3.prepare') && !s.journal.carried.includes('w3.commit'), 'the prepared transition found, its commit written now');
  assert.equal(s.journal.diverged.length, 0);
  /* Derived differently: a divergence, never a silent overwrite. */
  const third = path.join(dir, 'c.world.jsonl');
  const d = session(null, { file: third, from: second });
  d.seal('researcher', [{ kind: 'feed', params: { well: 'D6', amount: 1 } }]);
  d.runWindow();
  assert.deepEqual(d.journal.diverged.map((x) => x.key), ['w1.prepare', 'w1.commit']);
});

test('the bridge: the acts of a step one batch, applied after it; a query after an act not answered; queries counted for the window', async () => {
  const s = session(null, { calls: 2 });
  const logged: Record<string, any>[] = [];
  const stored: string[] = [];
  const bridge = new LivingBridge<{ kind: string; well: string }>({ session: s, actor: 'researcher', intent: (a) => ({ kind: a.kind, params: { well: a.well } }), asWritten: (a) => ({ [a.kind]: a.well }),
    shown: (seg) => ({ frames: seg.frames.length }), store: (_seg, _r, by, answer) => { const n = (by === 'you' ? 'act' : 'ep') + (stored.length + 1); stored.push(n); answer?.(n); return n; },
    material: () => 'none', own: () => false, deliver: () => {}, log: (type, data) => logged.push({ type, ...data }), say: () => {} });
  const budget = { acts: 4 };
  /* Queries only: counted; at the second the window goes on without anything of its. */
  await bridge.endStep(1, [bridge.observe()]);
  assert.equal(s.tick, 0);
  await bridge.endStep(1, [bridge.observe()]);
  assert.equal(s.tick, 3, 'its limit of calls: the window went on');
  assert.equal(logged.at(-1)?.by, 'calls');
  /* Two acts, one batch: their results exist only when the step ends. Each answer is asked on the world as it is then. */
  bridge.decide();
  const a = bridge.act({ kind: 'clean', well: 'B2' }, budget), b = bridge.act({ kind: 'inoculate', well: 'A1' }, budget);
  assert.ok(bridge.sealing);
  const answers = await bridge.endStep(1, [a, b]) as Record<string, any>[];
  assert.equal(answers[0].name, 'act1');
  assert.deepEqual(answers[0].ticks, [3, 6]);
  assert.ok(answers.every((x) => x.accepted ? x.name === 'act1' : typeof x.reason === 'string'), 'the same stretch for the same batch; a refusal says why');
  assert.equal(budget.acts, 4 - answers.filter((x) => x.accepted).length);
  /* A wait across windows: one stretch. */
  bridge.decide();
  const w = bridge.wait(5, budget);
  const [waited] = await bridge.endStep(1, [w]) as Record<string, any>[];
  assert.deepEqual(waited.ticks, [6, 11]);
  assert.equal(waited.frames, 6);
  assert.deepEqual(logged.filter((e) => e.by === 'wait').map((e) => [e.from, e.to]), [[6, 9], [9, 11]], 'every window it slept through, logged');
  /* A refused wait seals nothing: the next answer may still act. */
  const [bad] = await bridge.endStep(1, [bridge.wait(0, budget)]) as Record<string, any>[];
  assert.equal(bad.accepted, false);
  assert.equal(s.tick, 11);
});

/* --- The assisted researcher in its loop ------------------------------------------------------------------------------- */

const MODEL = { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.frames[p.frames.length - 1].colony', validate: false, lessons: ['l'], next_experiment: 'n', beliefs: [] };
const reply = (content: unknown) => { const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } }); return { ok: true, status: 200, text: async () => text, headers: { get: () => null } }; };

/** Round 1: looks twice, acts (two acts, one batch), waits, asks a view after an act, then proposes; round 2 closes. */
const SCRIPT: Record<number, unknown[]> = {
  1: [{ investigate: [{ observe: true }] }, { investigate: [{ observe: true }] },
    { investigate: [{ act: { feed: 'A1', amount: 2 } }, { act: { clean: 'B2' } }] },
    { investigate: [{ wait: 4 }] },
    { investigate: [{ act: { feed: 'C3', amount: 1 } }, { view: 'ep1', from: 0, to: 2 }] },
    MODEL],
  2: [{ close_round: { why: 'the stretch I watched shows nothing new to model' } }]
};

async function plates(dir: string, extra: string[] = [], script = SCRIPT, out = path.join(dir, 'run.json')) {
  const asked: Record<string, any>[] = [];
  const systems = new Set<string>();
  const conversations: { role: string; content: string }[][] = [];
  const fetch: FetchLike = async (_url, init) => {
    const b = JSON.parse(String(init.body));
    systems.add(b.messages[0].content);
    conversations.push(b.messages);
    const user = JSON.parse(userOf(b));
    asked.push(user);
    if ('task' in user) return reply({ rationale: 'r', beliefs: [], lessons: ['l'], next_experiment: 'n' });
    const steps = script[user.round] ?? [MODEL];
    return reply(steps[Math.min((user.investigation ?? []).length, steps.length - 1)]);
  };
  const r = await runLaboratory(platesLab, { args: ['--seed', '1', '--researcher', 'assisted', '--flat', '--no-grade', '--no-reflection', '--no-ablation', '--explore', '2', '--attempts', '2', '--steps', '6', ...extra, '--out', out],
    root: dir, llm: { url: 'http://x.test/c', model: 's' }, fetch });
  return { journal: r.journal, asked, systems, conversations, events: JSON.parse(fs.readFileSync(r.journal, 'utf8')).events as Record<string, any>[], world: r.journal.replace(/\.json$/, '.world.jsonl') };
}

test('the assisted researcher in a living world: a round across windows, queries that advance nothing, its acts one batch, a proposal without acting checked elsewhere', async () => {
  const dir = tmp('living-run');
  const { asked, events, world, journal, systems, conversations } = await plates(dir);
  /* Its conversation only grows: one system prompt for the run; in a round, each question the previous one with parts added -
     the windows, their acts' results and the stretches it watched included. */
  assert.equal(systems.size, 1);
  for (let k = 1; k < conversations.length; k++) {
    const before = conversations[k - 1], after = conversations[k];
    if (JSON.stringify(after[1]) !== JSON.stringify(before[1])) continue;
    assert.ok(after.length > before.length && before.every((m, i) => JSON.stringify(m) === JSON.stringify(after[i])), 'question ' + k + ' extends the one before');
  }
  const round1 = asked.filter((u) => u.round === 1 && !('task' in u));
  const step = (k: number) => round1[round1.length - 1].investigation[k].results;
  /* Two observations, the same tick: queries advance nothing. */
  assert.equal(step(0)[0].tick, step(1)[0].tick);
  assert.equal(step(0)[0].tick, 6, 'two windows of the environment before its first round');
  /* Two acts: one batch, applied after the step, with what came of each. */
  const [fed, cleaned] = step(2);
  assert.equal(fed.name, cleaned.name);
  assert.deepEqual(fed.ticks, [6, 9]);
  assert.equal(fed.outcome, 'applied');
  assert.equal(cleaned.done_at_tick, 8);
  /* A wait: the world goes on, it watched. */
  assert.deepEqual(step(3)[0].ticks, [9, 13]);
  /* A query after an act in the same answer: not answered. */
  assert.match(step(4)[1].error, /not answered: it comes after an act/);
  /* The round crossed windows: of its acts, its wait (two), its last act, its proposal. */
  const windows = events.filter((e) => e.type === 'world_window');
  assert.deepEqual(windows.filter((e) => e.round === 1).map((e) => e.by), ['acts', 'wait', 'wait', 'acts', 'proposal']);
  assert.deepEqual(windows.filter((e) => e.round === 2).map((e) => e.by), ['closed']);
  /* Its check: in realizations of their own, never the shared world. */
  const check = events.find((e) => e.type === 'check');
  assert.ok(check, 'its proposal was checked');
  const index = (JSON.parse(fs.readFileSync(journal, 'utf8')).episodes ?? events.find((e) => e.type === 'end')!.episodes) as Record<string, any>[];
  assert.ok(index.some((e) => e.episode.startsWith('check1-') && e.realization === 'reserved'));
  assert.ok(index.some((e) => e.episode === 'act3' && e.world === 'shared'));
  /* The session's journal: every window prepared then committed, once; deliveries; closed with its state. */
  const entries = lines(world);
  const keys = entries.map((e) => e.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const w of windows) assert.ok(keys.indexOf('w' + w.window + '.prepare') < keys.indexOf('w' + w.window + '.commit'));
  assert.ok(keys.filter((k) => k.startsWith('d.researcher.')).length >= 5, 'its stretches delivered: two of the environment, three of its own');
  const end = events.find((e) => e.type === 'end')!;
  assert.equal(end.world.status, 'completed');
  assert.equal(end.world.tick, entries.find((e) => e.key.startsWith('close@'))!.tick);
  /* What happened in the world (its contaminations, its smudges) stays in its restricted record, never in the researcher's. */
  assert.ok(!JSON.stringify(asked).includes('contamination'));
});

test('4 (without delegating): a researcher may ignore the world\'s surprises, or contrast them - nothing asks it to', async () => {
  /* It never looks: it proposes at once, every round. The world goes on all the same, and nothing of it is pressed on it. */
  const dir = tmp('living-ignore');
  const ignoring = await plates(dir, [], { 1: [MODEL], 2: [MODEL] });
  assert.ok(ignoring.events.filter((e) => e.type === 'world_window' && e.by === 'proposal').length === 2);
  assert.ok(!ignoring.asked.some((u) => JSON.stringify(u).includes('surprise') || JSON.stringify(u).includes('anomal')), 'no notice pushed at it');
  /* It contrasts: cleans a well and watches. */
  const dir2 = tmp('living-contrast');
  const contrasting = await plates(dir2, [], { 1: [{ investigate: [{ act: { clean: 'A2' } }] }, { investigate: [{ wait: 3 }] }, MODEL], 2: [MODEL] });
  assert.ok(contrasting.events.some((e) => e.type === 'world_window' && e.by === 'wait'));
});

test('a living world refuses what it cannot be: the unknown-world researcher, tests of its own', async () => {
  const dir = tmp('living-refused');
  await assert.rejects(runLaboratory(platesLab, { args: ['--seed', '1', '--flat', '--out', path.join(dir, 'r.json')], root: dir, llm: { url: 'http://x.test/c', model: 's' }, fetch: (async () => reply(MODEL)) as never }), /only the assisted researcher/);
  await assert.rejects(runLaboratory(platesLab, { args: ['--seed', '1', '--flat', '--researcher', 'assisted', '--own-tests', '1', '--out', path.join(dir, 'r.json')], root: dir, llm: { url: 'http://x.test/c', model: 's' }, fetch: (async () => reply(MODEL)) as never }), /never started afresh/);
});

test('12 in a run: stopped mid-way, resumed - its world derived again against the record it continues, nothing twice, the same world as a run never stopped', async () => {
  const whole = tmp('living-whole');
  const a = await plates(whole);
  const dir = tmp('living-resume');
  const stopped = await plates(dir, ['--max-tokens', '500']);
  assert.equal(stopped.events.find((e) => e.type === 'end')!.stoppedBy, 'token_budget');
  /* It crashed too: its world's record lost its last commit. */
  const entries = lines(stopped.world);
  const lastCommit = entries.map((e) => e.key).lastIndexOf(entries.filter((e) => /\.commit$/.test(e.key)).at(-1)!.key);
  fs.writeFileSync(stopped.world, entries.slice(0, lastCommit).map((e) => JSON.stringify(e)).join('\n') + '\n');
  const fetch: FetchLike = async (_url, init) => {
    const user = JSON.parse(userOf(JSON.parse(String(init.body))));
    if ('task' in user) return reply({ rationale: 'r', beliefs: [], lessons: ['l'], next_experiment: 'n' });
    const steps = SCRIPT[user.round] ?? [MODEL];
    return reply(steps[Math.min((user.investigation ?? []).length, steps.length - 1)]);
  };
  const out = path.join(dir, 'continued.json');
  const r = await runLaboratory(platesLab, { args: ['--resume', path.join(dir, 'run.json'), '--out', out], root: dir, llm: { url: 'http://x.test/c', model: 's' }, fetch });
  const events = JSON.parse(fs.readFileSync(r.journal, 'utf8')).events as Record<string, any>[];
  assert.ok(!events.some((e) => e.type === 'world_diverged'));
  const world = lines(out.replace(/\.json$/, '.world.jsonl'));
  const keys = world.map((e) => e.key);
  assert.equal(new Set(keys).size, keys.length, 'nothing twice');
  assert.equal(events.find((e) => e.type === 'end')!.world.state, a.events.find((e) => e.type === 'end')!.world.state, 'the same world as the run never stopped');
});

test('a living-world@1 manifest: checked whole before anything is spent; nothing unlimited by default; what is not built refused', () => {
  const ok = { format: 'living-world@1', adapter: 'plates@1', seed: 1, clock: { mode: 'simulated', decision_interval: 3, horizon: 300 },
    limits: { calls_per_window: 4, intents_per_window: 4 }, actors: [{ id: 'researcher', kind: 'researcher', rounds: 6, steps: 5, acts: 3 }] };
  const m = readManifest(ok, LABS);
  assert.ok(!('errors' in m));
  assert.equal(m.lab, 'plates');
  assert.deepEqual(m.args!.slice(0, 2), ['--researcher', 'assisted']);
  assert.ok(m.args!.join(' ').includes('--interval 3 --horizon 300 --window-calls 4 --window-intents 4 --attempts 6 --steps 5 --acts 3'));
  const refused = (x: Record<string, unknown>) => { const r = readManifest({ ...ok, ...x }, LABS); return 'errors' in r ? r.errors.join(' | ') : ''; };
  assert.match(refused({ limits: undefined }), /nothing is unlimited by default/);
  assert.match(refused({ clock: { mode: 'realtime', decision_interval: 3, horizon: 300 } }), /only "simulated"/);
  assert.match(refused({ adapter: 'cells@1' }), /not a living world/);
  /* Several members (H2): a shared session - a window that waits only so long, policies the world has, actions given explicitly. */
  assert.match(refused({ actors: [ok.actors[0], { ...ok.actors[0], id: 'other' }] }), /window_ms/);
  assert.match(refused({ actors: [ok.actors[0], { id: 'rival', kind: 'adversary', policy: 'nobody', actions: ['drain'] }] }), /"policy" is one of the world's: consumer, adversary, population/);
  assert.match(refused({ actors: [ok.actors[0], { id: 'rival', kind: 'policy', policy: 'consumer' }] }), /given explicitly/);
  assert.match(refused({ actors: [{ id: 'rival', kind: 'policy', policy: 'consumer', actions: ['drain'] }] }), /at least one researcher/);
  assert.match(refused({ limits: { ...ok.limits, messages_per_window: 2 } }), /go together/);
  const shared = readManifest({ ...ok, limits: { ...ok.limits, window_ms: 60000, messages_per_window: 2, message_chars: 400 },
    actors: [ok.actors[0], { ...ok.actors[0], id: 'other' }, { id: 'rival', kind: 'adversary', policy: 'adversary', actions: ['drain'] }] }, LABS);
  assert.ok(!('errors' in shared) && shared.args === null && shared.plan.actors.length === 3, 'a shared session: a plan, no run of its own');
  assert.match(refused({ budget: 3 }), /no field "budget"/);
});

test('plates I1 and I2: what the world echoes of an act is what the learner can write again; a field it does not know is refused', () => {
  for (const x of platesLab.act!.examples(platesLab.generate(1, { interval: '3', horizon: '600', 'window-calls': '4', 'window-intents': '4', acts: '4' }))) {
    const act = platesLab.act!.parse(x);
    assert.notEqual(typeof act, 'string', JSON.stringify(x));
    assert.deepEqual(platesLab.act!.parse(JSON.parse(JSON.stringify(platesLab.act!.asWritten!(act as never)))), act);
    assert.match(String(platesLab.act!.parse({ ...x, not_a_field: 1 })), /not_a_field/);
  }
  assert.match(String(platesLab.act!.parse({ feed: 'A1' })), /amount/);
  assert.match(String(platesLab.act!.parse({ feed: 'A1', clean: 'B2', amount: 1 })), /one of/);
});
