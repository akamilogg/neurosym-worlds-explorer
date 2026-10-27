import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { platesLab } from '../src/worlds/plates/lab.ts';
import { WorldJournal } from '../src/living/world.ts';
import { ExternalWorld, SimulatedService, type ServiceGuarantees } from '../src/living/external.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';

/* SPEC-ACONTECIMIENTOS-DEL-MUNDO, H4: branches of a living world - a realization of their own, or a member of the same one -
   and a world outside the harness. Acceptance tests 10 and 14; 4 with a delegation; the tree's resources, closing and
   recovery; the simulated service. */

const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), name + '-'));
const lines = (f: string) => fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const MODEL = { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.frames[p.frames.length - 1].colony', validate: false, lessons: ['l'], next_experiment: 'n', beliefs: [] };
const reply = (content: unknown) => { const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } }); return { ok: true, status: 200, text: async () => text, headers: { get: () => null } }; };

/** Answers as each script says: the requester's, and its branch's (it is told it is a delegated investigation). */
const scripted = (requester: Record<number, unknown[]>, branch: Record<number, unknown[]>): FetchLike => async (_url, init) => {
  const body = String(init.body);
  const user = JSON.parse(userOf(JSON.parse(body)));
  if ('task' in user) return reply({ rationale: 'r', beliefs: [], lessons: ['l'], next_experiment: 'n' });
  const script = body.includes('A DELEGATED INVESTIGATION') ? branch : requester;
  const steps = script[user.round] ?? [MODEL];
  return reply(steps[Math.min((user.investigation ?? []).length, steps.length - 1)]);
};
const COMMON = ['--seed', '1', '--researcher', 'assisted', '--flat', '--no-grade', '--no-reflection', '--no-ablation', '--explore', '1', '--steps', '6',
  '--delegation-fund', '5000', '--delegation-tokens', '2000'];

test('10 and 4: an isolated branch acts in a realization of its own - the world as it was, its chance as asked - and nothing of it reaches its requester\'s', async () => {
  const dir = tmp('h4-isolated');
  const branches: Promise<unknown>[] = [];
  const fetch = scripted({ 1: [{ investigate: [{ act: { feed: 'A1', amount: 2 } }] }, { investigate: [{ delegate: { question: 'what does cleaning do here?', world: 'isolated', randomness: 'same' } }] }, MODEL], 2: [MODEL] },
    { 1: [{ investigate: [{ act: { clean: 'B2' } }] }, MODEL] });
  const r = await runLaboratory(platesLab, { args: [...COMMON, '--attempts', '2', '--out', path.join(dir, 'run.json')], root: dir, llm: { url: 'http://x.test/c', model: 's' }, fetch,
    delegate: (l) => { branches.push(runLaboratory(platesLab, { args: [...l.args, '--out', l.journal], root: dir, llm: { url: 'http://x.test/c', model: 's' }, fetch })); } });
  await Promise.all(branches);
  const events = JSON.parse(fs.readFileSync(r.journal, 'utf8')).events as Record<string, any>[];
  const asked = events.find((e) => e.type === 'delegation_requested')!;
  assert.equal(asked.world.mode, 'isolated');
  assert.equal(asked.world.randomness, 'same');
  /* Its realization: the requester's world at that revision, its lineage recorded. */
  const parent = lines(r.journal.replace(/\.json$/, '.world.jsonl'));
  const branchJournal = path.resolve(dir, asked.journal);
  const own = lines(branchJournal.replace(/\.json$/, '.world.jsonl'));
  assert.deepEqual(own[0].lineage, { session: 'world:plates-s1', revision: asked.world.revision, tick: asked.world.tick, by: asked.id, randomness: 'same' });
  const atFork = parent.find((e) => e.key === 'w' + asked.world.revision + '.commit')!;
  assert.equal(own[0].state, atFork.state, 'the very state its requester\'s world had');
  /* Its acts are its own world's; its requester's world never had them. */
  assert.ok(own.some((e) => e.key.endsWith('.prepare') && e.batches.some((b: any) => b.intents.some((i: any) => i.kind === 'clean'))));
  assert.ok(!parent.some((e) => e.key.endsWith('.prepare') && e.batches.some((b: any) => b.intents.some((i: any) => i.kind === 'clean'))), 'nothing of it in its requester\'s world');
  assert.ok(!own.some((e) => e.key === 'events'), 'no agenda of its requester\'s world copied');
});

test('10: a shared branch is a member of the same world - it acts in it and writes to its requester; a mode the run does not allow is refused; its world closes once it stopped', async () => {
  const dir = tmp('h4-shared');
  const fetch = scripted({ 1: [{ investigate: [{ delegate: { question: 'help me look', world: 'shared' } }] }, { investigate: [{ observe: true }] }, { investigate: [{ observe: true }] },
    { investigate: [{ observe: true }] }, { investigate: [{ observe: true }] }, MODEL], 2: [MODEL] },
    { 1: [{ investigate: [{ act: { feed: 'A2', amount: 1 } }] }, { investigate: [{ send: { to: 'researcher', text: 'the branch fed A2' } }] }, MODEL] });
  const r = await runLaboratory(platesLab, { args: [...COMMON, '--attempts', '2', '--branches', 'isolated,shared', '--messages', '2', '--window-calls', '2', '--out', path.join(dir, 'run.json')],
    root: dir, llm: { url: 'http://x.test/c', model: 's' }, fetch });
  const events = JSON.parse(fs.readFileSync(r.journal, 'utf8')).events as Record<string, any>[];
  const answered = events.find((e) => e.type === 'delegation_answered')!.answer;
  assert.equal(answered.world, 'shared');
  const member = answered.member;
  const world = lines(r.journal.replace(/\.json$/, '.world.jsonl'));
  assert.ok(world.some((e) => e.key === 'join.' + member), 'it joined the world');
  assert.ok(world.some((e) => e.key.endsWith('.prepare') && e.batches.some((b: any) => b.actor === member && b.intents.some((i: any) => i.kind === 'feed'))), 'it acted in this very world');
  assert.ok(world.some((e) => e.key.startsWith('m.message:') && e.from === member && e.to.actor === 'researcher'), 'it wrote to its requester');
  /* Its requester left first; the branch stopped; then the world closed. */
  const keys = world.map((e) => e.key);
  const left = keys.findIndex((k) => k.startsWith('retire.researcher@')), stopped = keys.findIndex((k) => k.startsWith('retire.' + member + '@')), closed = keys.findIndex((k) => k.startsWith('close@'));
  assert.ok(left >= 0 && stopped > left && closed > stopped, [left, stopped, closed].join(' '));
  /* A mode the run does not allow: refused, nothing replaced. */
  const dir2 = tmp('h4-refused');
  const f2 = scripted({ 1: [{ investigate: [{ delegate: { question: 'q', world: 'shared' } }, { delegate: { question: 'q', mode: 'evolve' } }] }, MODEL] }, {});
  const r2 = await runLaboratory(platesLab, { args: [...COMMON, '--attempts', '1', '--out', path.join(dir2, 'run.json')], root: dir2, llm: { url: 'http://x.test/c', model: 's' }, fetch: f2 });
  const step = (JSON.parse(fs.readFileSync(r2.journal, 'utf8')).events as Record<string, any>[]).find((e) => e.type === 'investigation')!;
  assert.match(step.results[0].error, /the mode "shared" is not available in this run \(it allows: isolated\)/);
  assert.match(step.results[1].error, /no living world to search in/);
});

test('the tree recovered: a requester stopped by its budget, reconstructed - its shared branch resumed from its own record, the same world', async () => {
  const dir = tmp('h4-recover');
  const fetch = scripted({ 1: [{ investigate: [{ delegate: { question: 'help', world: 'shared' } }] }, { investigate: [{ observe: true }] }, { investigate: [{ observe: true }] }, { investigate: [{ observe: true }] }, MODEL], 2: [MODEL] },
    { 1: [{ investigate: [{ act: { feed: 'A2', amount: 1 } }] }, { investigate: [{ observe: true }] }, MODEL] });
  const first = await runLaboratory(platesLab, { args: [...COMMON, '--attempts', '2', '--branches', 'shared', '--window-calls', '2', '--max-tokens', '400', '--out', path.join(dir, 'run.json')],
    root: dir, llm: { url: 'http://x.test/c', model: 's' }, fetch });
  const before = JSON.parse(fs.readFileSync(first.journal, 'utf8'));
  assert.equal(before.events.find((e: any) => e.type === 'end').stoppedBy, 'token_budget');
  const out = path.join(dir, 'again.json');
  const again = await runLaboratory(platesLab, { args: ['--resume', first.journal, '--out', out], root: dir, llm: { url: 'http://x.test/c', model: 's' }, fetch, stopAsRecorded: 'token_budget' });
  const events = JSON.parse(fs.readFileSync(again.journal, 'utf8')).events as Record<string, any>[];
  assert.ok(events.some((e) => e.type === 'delegation_state' && e.resumed), 'its shared branch resumed from its record');
  assert.ok(!events.some((e) => e.type === 'world_diverged'), JSON.stringify(events.filter((e) => e.type === 'world_diverged').map((e) => e.key)));
  const a = lines(first.journal.replace(/\.json$/, '.world.jsonl')).find((e) => e.key.startsWith('close@'))!;
  const b = lines(out.replace(/\.json$/, '.world.jsonl')).find((e) => e.key.startsWith('close@'))!;
  assert.equal(b.state, a.state, 'the same world');
  /* Reconstructed again: its branch resumed under a record of its own once more - never the one it resumes. */
  const out2 = path.join(dir, 'again2.json');
  const twice = await runLaboratory(platesLab, { args: ['--resume', first.journal, '--out', out2], root: dir, llm: { url: 'http://x.test/c', model: 's' }, fetch, stopAsRecorded: 'token_budget' });
  const e2 = JSON.parse(fs.readFileSync(twice.journal, 'utf8')).events as Record<string, any>[];
  const resumed = e2.filter((e) => e.type === 'delegation_state' && e.resumed);
  assert.equal(resumed.length, 1);
  assert.ok(!e2.some((e) => e.type === 'world_diverged' || e.type === 'delegation_branch_failed'), JSON.stringify(e2.filter((e) => /diverged|failed/.test(e.type))));
  const firstResumed = events.find((e) => e.type === 'delegation_state' && e.resumed)!.journal;
  assert.notEqual(resumed[0].journal, firstResumed, 'a record of its own each time');
  assert.equal(lines(out2.replace(/\.json$/, '.world.jsonl')).find((e) => e.key.startsWith('close@'))!.state, a.state);
});

/* --- 14: a world outside the harness --------------------------------------------------------------------------------------- */

const G = (g: Partial<ServiceGuarantees>): ServiceGuarantees => ({ idempotent: false, lookup: false, pause: false, retention: 100, ...g });
const external = (service: SimulatedService, file: string | null = null) => new ExternalWorld({ transport: service, guarantees: service.guarantees, journal: new WorldJournal(file), actor: 'r' });

test('14: an answer lost - asked again under its id where the service is idempotent, reconciled by lookup where it can say, uncertain where neither: never sent again', async () => {
  const lostOnce = (route: string, n: number) => route === '/act' && n === 1;
  const idem = new SimulatedService({ guarantees: G({ idempotent: true }), lose: lostOnce });
  const a = await external(idem).act([{ feed: 'A1' }]);
  assert.equal(a.state, 'applied');
  assert.equal(idem.done.length, 1, 'done once, though asked twice');
  const look = new SimulatedService({ guarantees: G({ lookup: true }), lose: lostOnce });
  const b = await external(look).act([{ feed: 'A1' }]);
  assert.equal(b.state, 'applied');
  assert.equal(look.done.length, 1);
  const blind = new SimulatedService({ guarantees: G({}), lose: lostOnce });
  const dir = tmp('h4-14');
  const w = external(blind, path.join(dir, 'x.jsonl'));
  const c = await w.act([{ feed: 'A1' }]);
  assert.equal(c.state, 'uncertain');
  assert.equal(blind.done.length, 1, 'never sent again: it was done once, and the harness does not pretend to know');
  assert.equal(w.summary().reproduction, 'limited');
  assert.ok(lines(path.join(dir, 'x.jsonl')).some((e) => e.key === 'x.op.' + c.op && e.state === 'uncertain'));
  assert.deepEqual(lines(path.join(dir, 'x.jsonl'))[0].promises, { exactly_once: false, reconciled: false, pause: false }, 'its promises: only what the service declares');
});

test('14: delays, gaps and a pause it does not support - read by cursor, what was lost named, the world going on without the researcher', async () => {
  const s = new SimulatedService({ guarantees: G({ retention: 5 }), delayMs: 5 });
  const w = external(s);
  s.advance(3);
  assert.equal((await w.read()).events.length, 3);
  const paused = await w.pause();
  assert.equal(paused.paused, false);
  assert.match(String(paused.why), /goes on without the researcher/);
  s.advance(12);
  const back = await w.resume();
  assert.deepEqual(back.lost, { from: 4, to: 10 }, 'what it no longer kept, named');
  assert.equal(back.events.length, 5);
  assert.equal(w.summary().reproduction, 'limited');
  /* A service that can be paused: nothing goes on, nothing is lost. */
  const p = new SimulatedService({ guarantees: G({ pause: true, retention: 5 }) });
  const v = external(p);
  assert.equal((await v.pause()).paused, true);
  p.advance(12);
  const r = await v.resume();
  assert.equal(r.lost, undefined);
  assert.equal(v.summary().reproduction, 'complete');
});

/* A review of H4 (27/10/2026), reconciled: an operation's id never repeats across sessions; what was observed kept whole
   before the cursor moves; a repeat answered with an error leaves the operation uncertain. */

test('14: two sessions with one service never share an operation id: each operation done as asked', async () => {
  const s = new SimulatedService({ guarantees: G({ idempotent: true }) });
  const a = await external(s).act([{ feed: 'A1' }]);
  const b = await external(s).act([{ clean: 'B2' }]);
  assert.notEqual(a.op, b.op);
  assert.equal(b.state, 'applied');
  assert.equal((b.result as { repeated?: boolean }).repeated, undefined, 'not the answer of another operation');
  assert.equal(s.done.length, 2);
});

test('14: what was observed is kept whole in the record before the cursor moves - a client resumed recovers it, its session and its counters', async () => {
  const dir = tmp('h4-events');
  const file = path.join(dir, 'x.jsonl');
  const s = new SimulatedService({ guarantees: G({ idempotent: true, retention: 3 }) });
  const w = external(s, file);
  s.advance(3);
  await w.read();
  await w.act([{ feed: 'A1' }]);
  const kept = lines(file).filter((e) => e.key.startsWith('x.events.')).flatMap((e) => e.events);
  assert.equal(kept.length, 3);
  assert.deepEqual(kept[0].body, { tick: 1 });
  /* Its process lost; the service keeps no more of them. Resumed from its record: nothing observed is lost. */
  s.advance(10);
  const again = new ExternalWorld({ transport: s, guarantees: s.guarantees, journal: new WorldJournal(file), actor: 'r' });
  assert.equal(again.session, w.session);
  assert.equal(again.seen.length, 3);
  const next = await again.act([{ clean: 'B2' }]);
  assert.match(next.op, /:op2$/, 'its counter goes on');
  assert.equal(next.state, 'applied');
});

test('14: a repeat answered with an error leaves the operation uncertain - never applied by default', async () => {
  let n = 0;
  const flaky = { request: async (route: string) => {
    n++;
    if (route === '/act' && n === 1) throw new Error('timeout');
    return { status: 503, body: { error: 'unavailable' } };
  } };
  const w = new ExternalWorld({ transport: flaky, guarantees: G({ idempotent: true }), journal: new WorldJournal(null), actor: 'r' });
  const r = await w.act([{ feed: 'A1' }]);
  assert.equal(r.state, 'uncertain');
  assert.equal(w.summary().reproduction, 'limited');
});
