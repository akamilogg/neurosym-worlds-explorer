import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { platesLab } from '../src/worlds/plates/lab.ts';
import { runLivingSession, type SessionPlan } from '../src/living/run-session.ts';
import { readManifest } from '../src/living/manifest.ts';
import { LABS } from '../src/worlds/labs.ts';
import { UserParts, type ChatClient } from '../src/learn/system2.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';

/* SPEC-ACONTECIMIENTOS-DEL-MUNDO, what the five milestones left open (§18.7): the senior in a shared session, and its own
   reactive activation (§9). */

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

test('a senior in a shared session: never a member of the world, it follows its junior\'s run - and, as declared, what reaches its junior wakes it', async () => {
  const dir = tmp('gap-senior');
  const asked: unknown[] = [];
  const senior: ChatClient = { complete: async (req) => {
    asked.push(req.user instanceof UserParts ? req.user.parts : req.user);
    return { content: JSON.stringify({ decision: 'wait', why: 'nothing to add yet' }), latencyMs: 0, raw: null };
  } };
  const plan: SessionPlan = { seed: 3, clock: { decision_interval: 3, horizon: 200 }, explore: 1,
    limits: { calls_per_window: 2, intents_per_window: 2, messages_per_window: 2, message_chars: 300, window_ms: 20000 },
    actors: [{ id: 'a', kind: 'researcher', rounds: 3, steps: 4, acts: 2, senior: { max_orders: 2, activation: { on_message: true, max: 1 } } } as never,
      { id: 'b', kind: 'researcher', rounds: 3, steps: 4, acts: 2 } as never] };
  const scripts: Record<string, Record<number, unknown[]>> = {
    a: { 1: [{ investigate: [{ observe: true }] }, { investigate: [{ observe: true }] }, { investigate: [{ observe: true }] }, MODEL], 2: [{ investigate: [{ observe: true }] }, { investigate: [{ observe: true }] }, MODEL], 3: [MODEL] },
    b: { 1: [{ investigate: [{ send: { to: 'a', text: 'A2 dies off by two each tick' } }] }, MODEL], 2: [MODEL], 3: [MODEL] }
  };
  const r = await runLivingSession(platesLab, { plan, dir, name: 'sen', root: dir, args: FLAT, seniorLlm: () => senior,
    connection: (actor) => ({ llm: { url: 'http://x.test/c', model: 's' }, fetch: researcher(scripts[actor], 150) }) });
  assert.ok(Object.values(r.runs).every((x) => !x.error), JSON.stringify(r.runs));
  const record = JSON.parse(fs.readFileSync(path.join(dir, 'sen.a.agent-senior.json'), 'utf8'));
  assert.equal(record.role, 'senior');
  assert.deepEqual(record.settings.activation, { on_message: true, max: 1 });
  /* Woken by b's message to its junior, once - its limit. */
  const woken = asked.filter((x) => JSON.stringify(x).includes('woken_by'));
  assert.equal(woken.length, 1, 'woken once, by what reached its junior');
  assert.ok(JSON.stringify(woken[0]).includes('message:'), 'by the message itself');
  /* Never a member of the world. */
  assert.deepEqual(Object.keys(r.summary.members as Record<string, unknown>).sort(), ['a', 'b']);
  /* b had none: nothing follows it. */
  assert.ok(!fs.existsSync(path.join(dir, 'sen.b.agent-senior.json')));
});

test('a manifest\'s senior: checked, and a shared session always', () => {
  const base = { format: 'living-world@1', adapter: 'plates@1', seed: 1, clock: { mode: 'simulated', decision_interval: 3, horizon: 60 }, limits: { calls_per_window: 2, intents_per_window: 2 } };
  const ok = readManifest({ ...base, actors: [{ id: 'a', kind: 'researcher', rounds: 1, steps: 2, acts: 1, senior: { max_orders: 2, activation: { on_message: true, max: 2 } } }] }, LABS);
  assert.ok(!('errors' in ok) && ok.args === null, 'its senior runs beside it in a session');
  const bad = readManifest({ ...base, actors: [{ id: 'a', kind: 'researcher', rounds: 1, steps: 2, acts: 1, senior: { activation: { on_message: true } } }] }, LABS);
  assert.ok('errors' in bad && bad.errors.some((e) => /"senior"/.test(e)));
});

/* The operator's control of a living world (§16): its course, its members, its word - each recorded with who and why. */

import { LivingSession, WorldJournal } from '../src/living/world.ts';
import { platesAdapter } from '../src/worlds/plates/world.ts';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { send } from '../src/runtime/control.ts';

const world = (file: string | null) => new LivingSession({ adapter: platesAdapter as never, id: 'w', config: { layout: 5 }, seed: 5, actors: ['a', 'b'], clock: { decision_interval: 3, horizon: 120 },
  limits: { calls_per_window: 2, intents_per_window: 2, actors: 4 }, journal: new WorldJournal(file) });
const step = (s: LivingSession<unknown, unknown>) => { for (const m of s.members()) if (m.kind === 'researcher' && m.state === 'ready') s.seal(m.id, []); s.settle(); };

test('the operator\'s control: pause and resume, a member joining and leaving, the operator\'s word and pin, the status reviewed - each recorded', () => {
  const dir = tmp('gap-ops');
  const file = path.join(dir, 's.world.jsonl');
  const s = world(file);
  assert.equal(s.control({ id: 'o1', op: 'pause', by: 'operator', why: 'to look' }), null);
  step(s);
  assert.equal(s.window, 0, 'paused: nothing advances');
  assert.match(String(s.control({ id: 'o0', op: 'pause', by: 'operator' })), /cannot be paused/);
  assert.equal(s.control({ id: 'o2', op: 'resume', by: 'operator' }), null);
  step(s);
  assert.equal(s.window, 1, 'resumed: the world goes on');
  assert.match(String(s.control({ id: 'x', op: 'join', actor: { id: 'r2', kind: 'researcher' }, by: 'operator' })), /shared branch/);
  assert.equal(s.control({ id: 'o3', op: 'join', actor: { id: 'eater', kind: 'policy', policy: 'consumer', actions: ['drain'] }, by: 'operator', why: 'competition' }), null);
  assert.equal(s.control({ id: 'o4', op: 'say', to: 'global', text: 'look at row C', by: 'operator' }), null);
  assert.equal(s.control({ id: 'o5', op: 'pin', to: 'a', key: 'hint', text: 'wells drain', by: 'operator' }), null);
  step(s);
  assert.ok(s.members().some((m) => m.id === 'eater'), 'joined as the window opened');
  assert.ok(s.inbox('b').messages.some((m) => m.from === 'operator' && m.kind === 'notice' && m.body.text === 'look at row C'));
  assert.ok(s.inbox('a').messages.some((m) => m.from === 'operator' && m.kind === 'pin' && m.body.key === 'hint'));
  assert.equal(s.control({ id: 'o6', op: 'retire', target: 'eater', by: 'operator' }), null);
  step(s);
  assert.equal(s.members().find((m) => m.id === 'eater')!.state, 'stopped');
  const status = JSON.parse(fs.readFileSync(path.join(dir, 's.world.status.json'), 'utf8'));
  assert.equal(status.window, s.window);
  assert.ok(Array.isArray(status.pending) && Array.isArray(status.scheduled) && Array.isArray(status.sealed));
  assert.equal(s.control({ id: 'o7', op: 'close', by: 'operator', why: 'enough' }), null);
  assert.equal(s.status, 'completed');
  const keys = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l).key);
  for (const k of ['o1', 'o2', 'o3', 'o4', 'o5', 'o6', 'o7']) assert.ok(keys.includes('prog.' + k), k + ' recorded');
});

test('a run\'s world controlled through its inbox: the operator\'s word received as help, its pin kept before it; closed, the researcher stops', async () => {
  const dir = tmp('gap-run-ops');
  const out = path.join(dir, 'run.json');
  const script = Object.fromEntries(Array.from({ length: 40 }, (_, k) => [k + 1, [{ investigate: [{ observe: true }] }, { investigate: [{ observe: true }] }, MODEL]]));
  const running = runLaboratory(platesLab, { args: ['--seed', '1', '--researcher', 'assisted', ...FLAT, '--explore', '1', '--attempts', '40', '--steps', '3', '--out', out], root: dir,
    llm: { url: 'http://x.test/c', model: 's' }, fetch: researcher(script, 120) });
  while (!fs.existsSync(out)) await new Promise((r) => setTimeout(r, 50));
  send(out, { kind: 'world', op: 'say', to: 'researcher', text: 'the marks mean nothing', by: 'operator' });
  send(out, { kind: 'world', op: 'pin', to: 'researcher', key: 'note', text: 'watch row B', by: 'operator' });
  /* Once its word was received, the world is closed. */
  const seen = () => { try { return JSON.stringify(JSON.parse(fs.readFileSync(out, 'utf8')).events).includes('world_help'); } catch { return false; } };
  while (!seen()) await new Promise((r) => setTimeout(r, 100));
  send(out, { kind: 'world', op: 'close', by: 'operator', why: 'the pilot is over' });
  const r = await running;
  const events = JSON.parse(fs.readFileSync(r.journal, 'utf8')).events as Record<string, any>[];
  assert.equal(r.stoppedBy, 'world_closed');
  assert.ok(events.some((e) => e.type === 'world_help' && e.text === 'the marks mean nothing'), 'help, counted');
  assert.ok(events.some((e) => e.type === 'channel_delivered' && (e.delivered.pinned ?? []).some((p: any) => p.key === 'operator:note')), 'its pin kept before it');
  assert.ok(events.filter((e) => e.type === 'operator_command' && e.kind === 'world').length >= 3);
});

test('a shared session controlled through its own inbox: what came of each order written back', async () => {
  const dir = tmp('gap-session-ops');
  const plan: SessionPlan = { seed: 3, clock: { decision_interval: 3, horizon: 300 }, explore: 1, limits: { calls_per_window: 2, intents_per_window: 2, window_ms: 20000 },
    actors: [{ id: 'a', kind: 'researcher', rounds: 30, steps: 3, acts: 1 } as never, { id: 'b', kind: 'researcher', rounds: 30, steps: 3, acts: 1 } as never] };
  const script = Object.fromEntries(Array.from({ length: 30 }, (_, k) => [k + 1, [{ investigate: [{ observe: true }] }, MODEL]]));
  const running = runLivingSession(platesLab, { plan, dir, name: 'ops', root: dir, args: FLAT, connection: () => ({ llm: { url: 'http://x.test/c', model: 's' }, fetch: researcher(script, 80) }) });
  while (!fs.existsSync(path.join(dir, 'ops.a.json'))) await new Promise((r) => setTimeout(r, 50));
  fs.appendFileSync(path.join(dir, 'ops.inbox.jsonl'), JSON.stringify({ id: 'o1', op: 'say', to: 'global', text: 'from the operator' }) + '\n' + JSON.stringify({ id: 'o2', op: 'retire', target: 'nobody' }) + '\n');
  const acked = () => { try { return fs.readFileSync(path.join(dir, 'ops.orders.jsonl'), 'utf8').trim().split('\n').length >= 2; } catch { return false; } };
  while (!acked()) await new Promise((r) => setTimeout(r, 100));
  fs.appendFileSync(path.join(dir, 'ops.inbox.jsonl'), JSON.stringify({ id: 'o3', op: 'close', why: 'enough' }) + '\n');
  const r = await running;
  const acks = fs.readFileSync(path.join(dir, 'ops.orders.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(acks.find((x) => x.id === 'o1').accepted, true);
  assert.match(acks.find((x) => x.id === 'o2').refused, /no member "nobody"/);
  assert.ok(Object.values(r.runs).every((x) => x.stoppedBy === 'world_closed'), JSON.stringify(r.runs));
});

import { rebuildLivingSession } from '../src/living/run-session.ts';

test('a shared session continued from its record: its world derived again, then going on - more rounds where they ran out, a session of its own', async () => {
  const dir = tmp('gap-continue');
  const plan: SessionPlan = { seed: 6, clock: { decision_interval: 3, horizon: 300 }, explore: 1, limits: { calls_per_window: 2, intents_per_window: 2, window_ms: 20000 },
    actors: [{ id: 'a', kind: 'researcher', rounds: 1, steps: 3, acts: 1 } as never, { id: 'b', kind: 'researcher', rounds: 1, steps: 3, acts: 1 } as never] };
  const script = { 1: [{ investigate: [{ act: { feed: 'A1', amount: 1 } }] }, MODEL], 2: [{ investigate: [{ observe: true }] }, MODEL] };
  const conn = () => ({ llm: { url: 'http://x.test/c', model: 's' }, fetch: researcher(script) });
  const first = await runLivingSession(platesLab, { plan, dir, name: 'one', root: dir, args: FLAT, connection: conn });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'one.session.json'), 'utf8')).state, 'ended');
  const next = path.join(dir, 'next');
  const r = await rebuildLivingSession(platesLab, { sessionFile: path.join(dir, 'one.session.json'), dir: next, name: 'two', root: dir, mode: 'continue', moreRounds: 1, connection: conn });
  assert.ok(Object.values(r.runs).every((x) => x.stoppedBy === 'budget'), JSON.stringify(r.runs));
  for (const id of ['a', 'b']) {
    const events = JSON.parse(fs.readFileSync(r.runs[id].journal!, 'utf8')).events as Record<string, any>[];
    assert.ok(!events.some((e) => e.type === 'world_diverged'), id + ': ' + JSON.stringify(events.filter((e) => e.type === 'world_diverged')));
    assert.ok(events.some((e) => e.type === 'proposal' && e.round === 2), id + ' went on to its second round');
  }
  const rec = JSON.parse(fs.readFileSync(path.join(next, 'two.session.json'), 'utf8'));
  assert.equal(rec.continued_from, '../one.session.json');
  assert.equal(rec.plan.actors[0].rounds, 2);
  assert.ok(Number(r.summary.tick) > Number(first.summary.tick), 'the world went on');
});

import { runBatch } from '../src/orchestra/batch.ts';

test('a batch of shared sessions: each session one observation of its condition, its members apart; checked before anything is spent; a session cut short continued', async () => {
  const dir = tmp('gap-batch');
  const manifest = { format: 'living-world@1', adapter: 'plates@1', seed: 2, flat: true, clock: { mode: 'simulated', decision_interval: 3, horizon: 120 }, explore: 1,
    limits: { calls_per_window: 2, intents_per_window: 2, messages_per_window: 1, message_chars: 200, window_ms: 20000 },
    actors: [{ id: 'a', kind: 'researcher', rounds: 1, steps: 2, acts: 1 }, { id: 'b', kind: 'researcher', rounds: 1, steps: 2, acts: 1 }] };
  fs.writeFileSync(path.join(dir, 'pair.json'), JSON.stringify(manifest));
  const fetch = researcher({ 1: [{ investigate: [{ observe: true }] }, MODEL] });
  const def = { id: 'living', concurrency: 1, runs: [{ id: 's1', lab: 'plates', condition: 'pair', session: 'pair.json' }, { id: 's2', lab: 'plates', condition: 'pair', session: 'pair.json' }] };
  const report = await runBatch(def as never, { root: dir, dir: path.join(dir, 'batch'), llm: { url: 'http://x.test/c', model: 's' }, fetch });
  assert.ok(report.runs.every((r) => /^session: a budget, b budget$/.test(r.status)), JSON.stringify(report.runs.map((r) => r.status)));
  const sessions = (report.results as Record<string, any>).sessions.pair as Record<string, any>[];
  assert.equal(sessions.length, 2, 'two sessions, two observations - not four runs');
  assert.match(sessions[0].unit, /the session/);
  assert.equal(report.results!.groups.length, 0, 'no session run counted as a run apart');
  /* Refused before anything is spent. */
  fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ ...manifest, limits: { calls_per_window: 2, intents_per_window: 2 } }));
  await assert.rejects(runBatch({ id: 'bad', runs: [{ id: 'x', lab: 'plates', condition: 'c', session: 'bad.json' }] } as never, { root: dir, dir: path.join(dir, 'bad'), llm: { url: 'http://x.test/c', model: 's' }, fetch }), /window_ms/);
  /* A session cut short (its record says it was running): continued from it in a folder of its own. */
  const rec = path.join(dir, 'batch', 's1', 'session.session.json');
  fs.writeFileSync(rec, JSON.stringify({ ...JSON.parse(fs.readFileSync(rec, 'utf8')), state: 'running' }));
  const again = await runBatch(def as never, { root: dir, dir: path.join(dir, 'batch'), llm: { url: 'http://x.test/c', model: 's' }, fetch });
  assert.match(String(again.runs[0].journal), /s1\.r1/);
  assert.ok(again.runs.every((r) => r.status.startsWith('session:')), JSON.stringify(again.runs.map((r) => r.status)));
});

test('a researcher\'s delegation declared in the manifest; a shared branch promoted by the operator goes on when its requester ends', async () => {
  const dir = tmp('gap-promote');
  const plan: SessionPlan = { seed: 4, clock: { decision_interval: 3, horizon: 400 }, explore: 1, limits: { calls_per_window: 2, intents_per_window: 2, window_ms: 20000 },
    actors: [{ id: 'a', kind: 'researcher', rounds: 2, steps: 3, acts: 1, delegation: { fund: 5000, tokens: 3000, rounds: 3, branches: ['shared'] } } as never] };
  const requester = { 1: [{ investigate: [{ delegate: { question: 'help', world: 'shared' } }] }, { investigate: [{ observe: true }] }, MODEL], 2: [MODEL] };
  const branch = { 1: [{ investigate: [{ observe: true }] }, MODEL], 2: [{ investigate: [{ observe: true }] }, MODEL], 3: [MODEL] };
  const fetch: FetchLike = async (url, init) => (String(init.body).includes('A DELEGATED INVESTIGATION') ? researcher(branch, 200) : researcher(requester, 200))(url, init);
  const running = runLivingSession(platesLab, { plan, dir, name: 'p', root: dir, args: FLAT, connection: () => ({ llm: { url: 'http://x.test/c', model: 's' }, fetch }) });
  const journal = path.join(dir, 'p.a.json');
  const asked = () => { try { return JSON.stringify(JSON.parse(fs.readFileSync(journal, 'utf8')).events).includes('"world":"shared"'); } catch { return false; } };
  while (!asked()) await new Promise((r) => setTimeout(r, 100));
  const member = (JSON.parse(fs.readFileSync(journal, 'utf8')).events as Record<string, any>[]).find((e) => e.type === 'delegation_answered')!.answer.member;
  send(journal, { kind: 'world', op: 'promote', target: member, budget: 3000, by: 'operator' });
  const r = await running;
  const events = JSON.parse(fs.readFileSync(r.runs.a.journal!, 'utf8')).events as Record<string, any>[];
  assert.ok(events.some((e) => e.type === 'delegation_promoted' && e.actor === member), JSON.stringify(events.filter((e) => /operator_command/.test(e.type))));
  assert.ok(!events.some((e) => e.type === 'delegation_cancel_asked'), 'its requester\'s end did not stop it');
  const branchJournal = path.resolve(dir, events.find((e) => e.type === 'delegation_requested')!.journal);
  assert.equal([...JSON.parse(fs.readFileSync(branchJournal, 'utf8')).events].reverse().find((e: Record<string, any>) => e.type === 'end').stoppedBy, 'budget', 'it went on to its own end');
});

test('a signal a judge produces: asked each round, its inputs, rule, answer and cost kept with each sample; a stagnation read from it', async () => {
  const dir = tmp('gap-judge');
  const plan: SessionPlan = { seed: 5, clock: { decision_interval: 3, horizon: 300 }, explore: 1, limits: { calls_per_window: 2, intents_per_window: 2 },
    actors: [{ id: 'a', kind: 'researcher', rounds: 3, steps: 2, acts: 1 } as never],
    signals: [{ id: 'progress', producer: 'judge', actor: 'a', unit: 'level', direction: 'higher', tolerance: 0,
      judge: { instructions: 'How far does the last check go towards a model that holds?', criteria: ['nowhere', 'part of the way', 'all the way'], inputs: ['check', 'beliefs'] } }],
    programs: [{ id: 'nudge', trigger: { kind: 'stagnation', signal: 'progress', window: 1, predicate: 'no_improvement' }, effect: { type: 'nutrient_pulse', params: { amount: 1 } }, schedule: { max_firings: 1 }, exposure: 'sensors_only' }] };
  const r = await runLivingSession(platesLab, { plan, dir, name: 'j', root: dir, args: FLAT, connection: () => ({ llm: { url: 'http://x.test/c', model: 's' }, fetch: researcher({ 1: [MODEL] }) }) });
  const world = fs.readFileSync(r.world, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const samples = world.filter((e) => String(e.key).startsWith('s.progress.'));
  assert.ok(samples.length >= 2, JSON.stringify(samples));
  assert.ok(samples.every((s) => s.judged?.rule?.criteria?.length === 3 && 'last_check' in s.judged.inputs && 'beliefs' in s.judged.inputs && typeof s.judged.judge_calls === 'number'));
  assert.ok(world.some((e) => e.key === 'fire.f.nudge.1' && e.label === 'operator_fixed'), 'a stagnation read from the judge\'s signal');
});

import { packSession, verifySessionPackage } from '../src/runtime/package.ts';

test('a world in real time: it goes on by the wall clock - who did not seal is absent, a decision on a passed revision late; never reproduced, said so', async () => {
  const s = new LivingSession({ adapter: platesAdapter as never, id: 'rt', config: { layout: 5 }, seed: 5, actors: ['a'], clock: { decision_interval: 2, horizon: 60, mode: 'realtime', tick_ms: 15 },
    limits: { calls_per_window: 2, intents_per_window: 2 }, journal: new WorldJournal(null) });
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(s.window >= 3, 'the world went on with nobody deciding: ' + s.window);
  assert.deepEqual(s.windowRecord(1)!.timeouts, ['a']);
  assert.match(s.seal('a', [{ kind: 'feed', params: { well: 'A1', amount: 1 } }], 0)[0].reason!, /late/);
  s.close('end');
  assert.throws(() => new LivingSession({ adapter: platesAdapter as never, id: 'x', config: {}, seed: 1, actors: ['a'], clock: { decision_interval: 2, horizon: 10, mode: 'realtime' },
    limits: { calls_per_window: 1, intents_per_window: 1 }, journal: new WorldJournal(null) }), /tick_ms/);
  /* A researcher in it, in its loop; its package checked, never reconstructed. */
  const dir = tmp('gap-rt');
  const plan: SessionPlan = { seed: 2, clock: { decision_interval: 3, horizon: 120, mode: 'realtime', tick_ms: 20 }, explore: 1, limits: { calls_per_window: 3, intents_per_window: 2 },
    actors: [{ id: 'a', kind: 'researcher', rounds: 2, steps: 3, acts: 1 } as never] };
  const r = await runLivingSession(platesLab, { plan, dir, name: 'rt', root: dir, args: FLAT,
    connection: () => ({ llm: { url: 'http://x.test/c', model: 's' }, fetch: researcher({ 1: [{ investigate: [{ act: { feed: 'A1', amount: 1 } }] }, MODEL], 2: [MODEL] }, 60) }) });
  assert.equal(r.runs.a.stoppedBy, 'budget', JSON.stringify(r.runs));
  const { dir: pkg } = packSession(path.join(dir, 'rt.session.json'), path.join(tmp('gap-rt-pkg'), 'pkg'));
  const v = await verifySessionPackage(pkg) as Record<string, any>;
  assert.ok(v.world_record.holds, JSON.stringify(v.world_record.problems));
  assert.match(v.reconstruction.not_reproducible, /real time/);
  await assert.rejects(rebuildLivingSession(platesLab, { sessionFile: path.join(dir, 'rt.session.json'), dir: path.join(dir, 'again'), name: 'x', root: dir, connection: () => ({ llm: { url: 'http://x.test/c', model: 's' } }) }), /never reproduced/);
});
