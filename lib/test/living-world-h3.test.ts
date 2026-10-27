import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { platesAdapter, type PlatesFrame } from '../src/worlds/plates/world.ts';
import { platesLab } from '../src/worlds/plates/lab.ts';
import { LivingSession, WorldJournal, type ActorDecl } from '../src/living/world.ts';
import { stagnant, type ProgramDecl, type SignalDecl, type WatchDecl } from '../src/living/events.ts';
import { runLivingSession, type SessionPlan } from '../src/living/run-session.ts';
import { readManifest } from '../src/living/manifest.ts';
import { LABS } from '../src/worlds/labs.ts';
import { nodeVmRunner } from '../src/runtime/node-vm.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';

/* SPEC-ACONTECIMIENTOS-DEL-MUNDO, H3: watchers, the reactive researcher and every trigger of the operator's. Acceptance tests
   3, 7 and 8; a signal fixed by the operator told apart from one the researcher reports or provokes; no activation twice,
   no advance for free. */

const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), name + '-'));
const lines = (f: string) => fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const compile = (source: string) => { const fn = nodeVmRunner({ timeoutMs: 500 }).compile(source); return (input: unknown) => fn(input as never); };
function world(actors: readonly (string | ActorDecl)[], o: { programs?: ProgramDecl[]; signals?: SignalDecl[]; sensors?: (WatchDecl & { actor: string })[]; file?: string | null; from?: string; watchers?: number } = {}) {
  return new LivingSession({ adapter: platesAdapter as never, id: 'world:h3', config: { layout: 5, arrivals: false }, seed: 5, actors,
    clock: { decision_interval: 3, horizon: 300 }, limits: { calls_per_window: 4, intents_per_window: 3, watchers: o.watchers ?? 2 },
    journal: new WorldJournal(o.file ?? null, o.from ? { from: o.from } : {}), compile,
    ...(o.programs ? { programs: o.programs } : {}), ...(o.signals ? { signals: o.signals } : {}), ...(o.sensors ? { sensors: o.sensors } : {}) });
}
const plate = (s: LivingSession<unknown, unknown>) => s.observe(s.members()[0].id).view as PlatesFrame;
const flat = (layer: string) => layer.replace(/\//g, '');
const nameOf = (i: number) => 'ABCD'[Math.floor(i / 6)] + (i % 6 + 1);
const step = (s: LivingSession<unknown, unknown>, n = 1) => { for (let k = 0; k < n; k++) { for (const m of s.members()) if (m.kind === 'researcher' && m.state === 'ready') s.seal(m.id, []); s.settle(); } };
const SMUDGE = { type: 'smudge', params: { well: 'A1' } } as const;

test('3: what happens may go unperceived; a watcher of its own sees its consequences and wakes it - never told the cause', async () => {
  const probe = world(['a']);
  const i = flat(plate(probe).colony).split('').findIndex((c) => Number(c) >= 4);
  const contaminate: ProgramDecl = { id: 'blight', trigger: { kind: 'at', tick: 4 }, effect: { type: 'contaminate', params: { well: nameOf(i) } }, schedule: { max_firings: 1 }, exposure: 'sensors_only' };
  /* Unwatched: it happens, and nothing reaches the researcher. */
  const blind = world(['a'], { programs: [contaminate] });
  step(blind, 4);
  assert.deepEqual(blind.inbox('a').messages, [], 'no notice: a happening is not an announcement');
  assert.ok(blind.summary().interventions && (blind.summary().interventions as { agenda: number }).agenda === 1);
  /* Watched: its watcher measures the colony there; asleep, it is woken by the reading. */
  const dir = tmp('h3-3');
  const s = world([{ id: 'a', kind: 'researcher', activation: { on_observation: true, max: 2 } }], { programs: [contaminate], file: path.join(dir, 'w.world.jsonl') });
  const w = s.watch('a', { id: 'colony_there', measure: '(o) => Number(o.frame.colony.replace(/\\//g, "")[' + i + '])', every: 1, when: { below: 3 }, for: 100, notices: 1 });
  assert.deepEqual(w, { version: 1 });
  assert.equal(s.wait('a', 60, undefined, ['observation']).accepted, true);
  await s.awake('a');
  assert.ok(s.tick < 60, 'woken before its time (tick ' + s.tick + ')');
  const [reading] = s.inbox('a').messages;
  assert.equal(reading.kind, 'reading');
  assert.equal(reading.from, 'instrument:colony_there');
  assert.ok(typeof reading.body.measured === 'number' && reading.body.measured < 3);
  assert.ok(!JSON.stringify(reading).includes('contamin'), 'what was measured, never why');
  assert.ok(lines(path.join(dir, 'w.world.jsonl')).some((e) => e.key.startsWith('wake.a.')));
  /* A wake the world does not allow it is refused. */
  const t = world(['a']);
  assert.match(t.wait('a', 5, undefined, ['message']).reason!, /nothing of message may wake you/);
});

test('7: every trigger fires a recorded effect - instant, recurrence, round, interaction, state, stagnation, by hand; a missing sample is no stagnation; a sustained condition fires once', () => {
  const dir = tmp('h3-7');
  const file = path.join(dir, 'w.world.jsonl');
  const programs: ProgramDecl[] = [
    { id: 'at5', trigger: { kind: 'at', tick: 5 }, effect: SMUDGE, schedule: { max_firings: 1 }, exposure: 'sensors_only' },
    { id: 'every4', trigger: { kind: 'every', ticks: 4 }, effect: SMUDGE, schedule: { max_firings: 3 }, exposure: 'sensors_only' },
    { id: 'round2', trigger: { kind: 'round', actor: 'a', round: 2 }, effect: SMUDGE, schedule: { max_firings: 1 }, exposure: 'sensors_only' },
    { id: 'fed', trigger: { kind: 'interaction', actor: 'a', action: 'feed' }, effect: SMUDGE, schedule: { max_firings: 5 }, exposure: 'sensors_only' },
    { id: 'always', trigger: { kind: 'state', predicate: '(s) => s.tick >= 0' }, effect: SMUDGE, schedule: { max_firings: 5 }, exposure: 'sensors_only' },
    { id: 'stuck', trigger: { kind: 'stagnation', signal: 'progress', window: 2, predicate: 'no_improvement' }, effect: SMUDGE, schedule: { max_firings: 5 }, exposure: 'sensors_only' },
    { id: 'hand', trigger: { kind: 'manual' }, effect: SMUDGE, schedule: { max_firings: 1 }, exposure: 'announce_action', announcement: 'a mark was made on A1' }
  ];
  const signals: SignalDecl[] = [{ id: 'progress', producer: 'checks', actor: 'a', unit: 'exact share', direction: 'higher', tolerance: 0 }];
  const s = world(['a'], { programs, signals, file });
  step(s, 2);
  s.round('a', 2);
  s.seal('a', [{ kind: 'feed', params: { well: 'B2', amount: 1 } }]); s.settle();
  /* Missing samples: not evaluable, nothing fires. */
  s.sample('progress', 'r1', 0.5, { harness: true }); s.sample('progress', 'r2', null, { harness: true }); s.sample('progress', 'r3', 0.4, { harness: true });
  step(s);
  assert.ok(!lines(file).some((e) => e.key === 'fire.f.stuck.1'), 'a missing sample in the window: no stagnation');
  s.sample('progress', 'r4', 0.3, { harness: true }); s.sample('progress', 'r5', 0.5, { harness: true });
  step(s);
  assert.equal(s.control({ id: 'o1', op: 'fire', target: 'hand', by: 'operator', why: 'to see' }), null);
  step(s, 4);
  const fired = lines(file).filter((e) => e.key.startsWith('fire.')).map((e) => e.program);
  for (const id of ['at5', 'every4', 'round2', 'fed', 'always', 'stuck', 'hand']) assert.ok(fired.includes(id), id + ' fired: ' + fired.join(' '));
  assert.equal(fired.filter((x) => x === 'always').length, 1, 'a condition that holds all along fires once');
  assert.equal(fired.filter((x) => x === 'every4').length, 3, 'a recurrence, up to its limit');
  const applied = lines(file).flatMap((e) => e.effects ?? []);
  assert.ok(applied.length >= fired.length - 1 && applied.every((x: any) => x.applied || x.refused));
  assert.ok(s.inbox('a').messages.some((m) => m.kind === 'announcement' && m.from === 'operator'), 'announce_action: the operator\'s announcement, as the operator\'s');
  assert.ok(lines(file).some((e) => e.key === 'prog.o1' && e.order.by === 'operator'), 'the operator\'s change recorded, with who and why');
  /* A condition that fails and holds again fires again (rearmed), once each time. */
  const flip: ProgramDecl = { id: 'flip', trigger: { kind: 'state', predicate: '(s) => s.tick % 6 < 3' }, effect: SMUDGE, schedule: { max_firings: 9 }, exposure: 'sensors_only' };
  const f = world(['a'], { programs: [flip], file: path.join(dir, 'f.jsonl') });
  step(f, 6);
  const flips = lines(path.join(dir, 'f.jsonl')).filter((e) => e.key.startsWith('fire.f.flip')).length;
  assert.ok(flips >= 2 && flips <= 3, 'rearmed each time its condition came back: ' + flips);
  assert.equal(stagnant(signals[0], [0.5, null, 0.4], 2), null);
  assert.equal(stagnant(signals[0], [0.5, 0.4, 0.3], 2), true);
  assert.equal(stagnant(signals[0], [0.5, 0.4, 0.6], 2), false);
});

test('8: a firing\'s parameters come from its program\'s own stream - its k-th firing the same whenever it fires; modes and labels kept apart', () => {
  const drawn = (when: number) => {
    const program: ProgramDecl = { id: 'pulse', trigger: { kind: 'round', actor: 'a', round: 1 }, effect: { type: 'contaminate' }, schedule: { max_firings: 1 }, exposure: 'sensors_only' };
    const s = world(['a'], { programs: [program] });
    step(s, when);
    s.round('a', 1);
    step(s, 2);
    return (s.summary().interventions as Record<string, any>);
  };
  const dir = tmp('h3-8');
  const paramsAt = (when: number) => {
    const file = path.join(dir, 'p' + when + '.jsonl');
    const s = world(['a'], { programs: [{ id: 'pulse', trigger: { kind: 'round', actor: 'a', round: 1 }, effect: { type: 'contaminate' }, schedule: { max_firings: 1 }, exposure: 'sensors_only' }], file });
    step(s, when); s.round('a', 1); step(s, 2);
    return lines(file).find((e) => e.key === 'fire.f.pulse.1');
  };
  const a = paramsAt(1), b = paramsAt(7);
  assert.notEqual(a.at, b.at, 'fired at different times');
  assert.deepEqual(a.params, b.params, 'the same parameters: its own stream, not the trigger\'s');
  assert.equal(drawn(1).reactive, 1);
  /* Modes and labels: the agenda, a reaction to a fixed signal, a self-reported one, a requested surprise, the operator's hand. */
  const programs: ProgramDecl[] = [
    { id: 'agenda', trigger: { kind: 'at', tick: 1 }, effect: SMUDGE, schedule: { max_firings: 1 }, exposure: 'sensors_only' },
    { id: 'fixed', trigger: { kind: 'stagnation', signal: 'checks', window: 1, predicate: 'no_improvement' }, effect: SMUDGE, schedule: { max_firings: 1 }, exposure: 'sensors_only' },
    { id: 'self', trigger: { kind: 'stagnation', signal: 'mine', window: 1, predicate: 'no_improvement' }, effect: SMUDGE, schedule: { max_firings: 1 }, exposure: 'sensors_only' },
    { id: 'asked', trigger: { kind: 'request', actor: 'a' }, effect: SMUDGE, schedule: { max_firings: 1 }, exposure: 'sensors_only' },
    { id: 'hand', trigger: { kind: 'manual' }, effect: SMUDGE, schedule: { max_firings: 1 }, exposure: 'sensors_only' }
  ];
  const signals: SignalDecl[] = [{ id: 'checks', producer: 'checks', actor: 'a', unit: 'share', direction: 'higher', tolerance: 0 }, { id: 'mine', producer: 'self_reported', actor: 'a', unit: 'share', direction: 'higher', tolerance: 0 }];
  const file = path.join(dir, 'labels.jsonl');
  const s = world(['a'], { programs, signals, file });
  assert.match(String(s.sample('checks', 'x', 1, { actor: 'a' })), /not yours to report/, 'the operator\'s signal: never the researcher\'s to set');
  for (const [k, v] of [['r1', 0.5], ['r2', 0.5]] as const) { s.sample('checks', k, v, { harness: true }); s.sample('mine', k, v, { actor: 'a' }); }
  assert.equal(s.ask('a', 'asked'), null);
  assert.match(String(s.ask('a', 'hand')), /not one you may ask for/);
  s.control({ id: 'o', op: 'fire', target: 'hand', by: 'operator' });
  step(s, 3);
  const labels = Object.fromEntries(lines(file).filter((e) => e.key.startsWith('fire.')).map((e) => [e.program, e.mode + '/' + e.label]));
  assert.deepEqual(labels, { agenda: 'agenda/operator_fixed', fixed: 'reactive/operator_fixed', self: 'reactive/self_reported', asked: 'reactive/requested_surprise', hand: 'directed/directed' });
});

test('no activation twice, no advance for free: one wake a window at most, within its limit; a wake changes nothing of the clock', async () => {
  const s = world([{ id: 'a', kind: 'researcher', activation: { on_observation: true, cooldown_windows: 1, max: 1 } }]);
  /* A watcher that tells it every tick. */
  s.watch('a', { id: 'tick', measure: '(o) => o.tick', every: 1, when: { above: -1 }, for: 100, notices: 10, cooldown: 0 });
  s.wait('a', 30, undefined, ['observation']);
  await s.awake('a');
  const first = s.tick;
  assert.equal(first, 3, 'woken at the end of the first window, not in the middle of it');
  s.receive('a', s.inbox('a').messages.map((m) => m.id), 'delivered');
  s.wait('a', 30, undefined, ['observation']);
  await s.awake('a');
  assert.equal(s.tick, first + 30, 'its one activation spent: only its time wakes it');
  assert.equal((s.summary().members as Record<string, any>).a.calls, 0, 'waking spent no decision of its');
  s.close('end');
});

test('the operator\'s changes during the run: applied as the next window opens, recorded; a run that continues the record applies them where they were', () => {
  const dir = tmp('h3-orders');
  const first = path.join(dir, 'a.jsonl');
  const play = (file: string, from?: string, live = true) => {
    const s = world(['a'], { file, ...(from ? { from } : {}) });
    step(s, 2);
    if (live) assert.equal(s.control({ id: 'o1', op: 'add', program: { id: 'later', trigger: { kind: 'every', ticks: 2 }, effect: { type: 'nutrient_pulse', params: { amount: 1 } }, schedule: { max_firings: 2 }, exposure: 'sensors_only' }, by: 'operator', why: 'feed the plate' }), null);
    step(s, 3);
    return s.close('end');
  };
  const a = play(first);
  assert.equal(((a.interventions as Record<string, any>).programs.later.firings), 2);
  assert.equal((a.interventions as Record<string, any>).directed, 2, 'what an operator added during the run: its direction');
  /* The same record continued, with no live order: its change applied where it was - the same world. */
  const b = play(path.join(dir, 'b.jsonl'), first, false);
  assert.equal(b.state, a.state);
  assert.match(String(world(['a']).control({ id: 'x', op: 'disable', target: 'nobody', by: 'operator' })), /no program "nobody"/);
});

/* --- A researcher with its watchers, its waits and its signal, in its loop ------------------------------------------------ */

const MODEL = { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.frames[p.frames.length - 1].colony', validate: false, lessons: ['l'], next_experiment: 'n', beliefs: [] };
const reply = (content: unknown) => { const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } }); return { ok: true, status: 200, text: async () => text, headers: { get: () => null } }; };

test('the reactive researcher in its loop: it registers a watcher, waits to be woken, reports its progress, asks for a surprise - each recorded apart from help', async () => {
  const dir = tmp('h3-run');
  const systems: string[] = [];
  const asked: Record<string, any>[] = [];
  const script: Record<number, unknown[]> = {
    1: [{ investigate: [{ watch: { id: 'marks', measure: '(o) => (o.frame.marks.match(/\\*/g) || []).length', every: 1, when: { changes_by: 1 }, for: 200, notices: 3 } }] },
      { investigate: [{ wait: 40, wake_on: ['observation'] }] },
      { investigate: [{ progress: { signal: 'mine', value: 0.2 } }, { perturb: 'stir' }] },
      MODEL],
    2: [MODEL]
  };
  const fetch: FetchLike = async (_url, init) => {
    const b = JSON.parse(String(init.body));
    systems.push(b.messages[0].content);
    const user = JSON.parse(userOf(b));
    asked.push(user);
    if ('task' in user) return reply({ rationale: 'r', beliefs: [], lessons: ['l'], next_experiment: 'n' });
    const steps = script[user.round] ?? [MODEL];
    return reply(steps[Math.min((user.investigation ?? []).length, steps.length - 1)]);
  };
  const plan: SessionPlan = { seed: 3, clock: { decision_interval: 3, horizon: 300 }, explore: 1,
    limits: { calls_per_window: 3, intents_per_window: 3, watchers: 2 },
    actors: [{ id: 'r', kind: 'researcher', rounds: 2, steps: 6, acts: 3, activation: { on_observation: true, max: 3 } } as never],
    programs: [{ id: 'marker', trigger: { kind: 'every', ticks: 5, from: 8 }, effect: { type: 'smudge' }, schedule: { max_firings: 4 }, exposure: 'sensors_only' },
      { id: 'stir', trigger: { kind: 'request', actor: 'r' }, effect: { type: 'nutrient_pulse', params: { amount: 1 } }, schedule: { max_firings: 1 }, exposure: 'sensors_only' }],
    signals: [{ id: 'mine', producer: 'self_reported', actor: 'r', unit: 'share', direction: 'higher', tolerance: 0 }, { id: 'checks', producer: 'checks', actor: 'r', unit: 'exact share', direction: 'higher', tolerance: 0 }] };
  const r = await runLivingSession(platesLab, { plan, dir, name: 'reactive', root: dir, args: ['--flat', '--no-grade', '--no-reflection', '--no-ablation'],
    connection: () => ({ llm: { url: 'http://x.test/c', model: 's' }, fetch }) });
  assert.equal(r.runs.r.error, undefined, String(r.runs.r.error));
  assert.ok(systems[0].includes('"watch"') && systems[0].includes('"wake_on"') && systems[0].includes('"progress"') && systems[0].includes('"perturb"'), 'its interface says what it may do, as granted');
  const steps = asked.filter((u) => u.round === 1).at(-1)!.investigation as Record<string, any>[];
  assert.equal(steps[0].results[0].watch, 'registered');
  const waited = steps[1].results[0];
  assert.ok(waited.woken_at_tick !== undefined && waited.woken_at_tick < waited.ticks[0] + 40, 'woken by its watcher: ' + JSON.stringify(waited.ticks));
  assert.equal(steps[2].results[0].progress, 'recorded');
  assert.equal(steps[2].results[1].perturb, 'asked');
  const world = lines(r.world);
  assert.ok(world.some((e) => e.key.startsWith('s.checks.r')), 'its checks, a sample of the operator\'s signal');
  assert.ok(world.some((e) => e.key === 'fire.f.stir.1' && e.label === 'requested_surprise'));
  const events = JSON.parse(fs.readFileSync(r.runs.r.journal!, 'utf8')).events as Record<string, any>[];
  assert.ok(!events.some((e) => e.type === 'operator_command'), 'no help was spent');
  const interventions = (r.summary.interventions as Record<string, any>);
  assert.ok(interventions.agenda >= 1 && interventions.labels.requested_surprise === 1);
});

test('a manifest with programs, signals, sensors and activation: checked whole; a shared session, never a run of its own', () => {
  const base = { format: 'living-world@1', adapter: 'plates@1', seed: 1, clock: { mode: 'simulated', decision_interval: 3, horizon: 300 }, limits: { calls_per_window: 4, intents_per_window: 4, watchers: 1 },
    actors: [{ id: 'r', kind: 'researcher', rounds: 2, steps: 4, acts: 2, activation: { on_observation: true, max: 2 } }] };
  const ok = readManifest({ ...base, programs: [{ id: 'p', trigger: { kind: 'at', tick: 3 }, effect: { type: 'smudge' }, schedule: { max_firings: 1 }, exposure: 'sensors_only' }],
    signals: [{ id: 's', producer: 'checks', actor: 'r', unit: 'u', direction: 'higher', tolerance: 0 }],
    sensors: [{ actor: 'r', id: 'w', measure: '(o) => 1', every: 1, when: { above: 0 }, for: 10, notices: 1 }] }, LABS);
  assert.ok(!('errors' in ok) && ok.args === null && ok.plan.programs?.length === 1);
  const refused = (x: Record<string, unknown>) => { const r = readManifest({ ...base, ...x }, LABS); return 'errors' in r ? r.errors.join(' | ') : ''; };
  assert.match(refused({ programs: [{ id: 'p', trigger: { kind: 'at', tick: 3 }, effect: { type: 'smudge' }, schedule: {}, exposure: 'sensors_only' }] }), /nothing fires without a limit/);
  assert.match(refused({ programs: [{ id: 'p', trigger: { kind: 'stagnation', signal: 'none', window: 2, predicate: 'no_improvement' }, effect: { type: 'smudge' }, schedule: { max_firings: 1 }, exposure: 'sensors_only' }] }), /names a declared signal/);
  assert.match(refused({ programs: [{ id: 'p', trigger: { kind: 'at', tick: 3 }, effect: { type: 'earthquake' }, schedule: { max_firings: 1 }, exposure: 'sensors_only' }] }), /one of the world's: contaminate, nutrient_pulse, smudge/);
  assert.match(refused({ actors: [{ ...base.actors[0], activation: { on_observation: true } }] }), /"activation"/);
});
