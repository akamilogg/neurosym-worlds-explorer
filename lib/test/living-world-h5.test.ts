import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { platesLab } from '../src/worlds/plates/lab.ts';
import { platesAdapter } from '../src/worlds/plates/world.ts';
import { LivingSession, WorldJournal, type ActorDecl } from '../src/living/world.ts';
import { livingIdentity, livingTimeline, readWorld, verifyWorld } from '../src/living/record.ts';
import { runLivingSession, type SessionPlan } from '../src/living/run-session.ts';
import { packRun, packSession, verifyPackage, verifySessionPackage } from '../src/runtime/package.ts';
import { groupResults, runResults, sessionResults } from '../src/orchestra/results.ts';
import { processTraces } from '../src/orchestra/traces.ts';
import { livingOf } from '../src/runtime/console.ts';
import type { ProgramDecl, SignalDecl } from '../src/living/events.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';

/* SPEC-ACONTECIMIENTOS-DEL-MUNDO, H5: results, console and package. Acceptance tests 13, 16 and 18; the hashes of §15.1;
   aggregation without double cost or pseudoreplication. */

const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), name + '-'));
const MODEL = { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.frames[p.frames.length - 1].colony', validate: false, lessons: ['l'], next_experiment: 'n', beliefs: [] };
const reply = (content: unknown) => { const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } }); return { ok: true, status: 200, text: async () => text, headers: { get: () => null } }; };
const researcher = (script: Record<number, unknown[]>): FetchLike => async (_url, init) => {
  const user = JSON.parse(userOf(JSON.parse(String(init.body))));
  if ('task' in user) return reply({ rationale: 'r', beliefs: [], lessons: ['l'], next_experiment: 'n' });
  const steps = script[user.round] ?? [MODEL];
  return reply(steps[Math.min((user.investigation ?? []).length, steps.length - 1)]);
};
const FLAT = ['--flat', '--no-grade', '--no-reflection', '--no-ablation'];

test('13 and 18 (a run alone): packed with its world, verified offline - its record holds together, its world derived again the same; the console tells what happened from what was perceived', async () => {
  const dir = tmp('h5-run');
  const r = await runLaboratory(platesLab, { args: ['--seed', '2', '--researcher', 'assisted', ...FLAT, '--explore', '2', '--attempts', '2', '--steps', '4', '--out', path.join(dir, 'run.json')], root: dir,
    llm: { url: 'http://x.test/c', model: 's' }, fetch: researcher({ 1: [{ investigate: [{ act: { feed: 'A1', amount: 2 } }] }, { investigate: [{ wait: 9 }] }, MODEL], 2: [MODEL] }) });
  const { dir: pkg, manifest } = packRun(r.journal, path.join(tmp('h5-pkg'), 'pkg'));
  assert.ok(manifest.files.some((f) => f.path === 'run.world.jsonl'), 'its world is in the package');
  const v = await verifyPackage(pkg);
  assert.ok(v.integrity.holds, JSON.stringify(v.integrity));
  assert.ok(v.reconstruction.holds, JSON.stringify(v.reconstruction));
  assert.equal(v.reconstruction.requests_refused, 0, 'nothing asked: every answer from the record');
  assert.ok(v.world?.holds, JSON.stringify(v.world));
  /* 18: the auditor sees what happened unperceived; the researcher's view never shows it. */
  const j = JSON.parse(fs.readFileSync(r.journal, 'utf8'));
  const auditor = livingOf(r.journal, j, 'auditor').timeline.map((l: { line: string }) => l.line);
  const perceived = livingOf(r.journal, j, 'actor').timeline.map((l: { line: string }) => l.line);
  assert.ok(auditor.some((l: string) => l.startsWith('happened')), 'the restricted record: what happened');
  assert.ok(!perceived.some((l: string) => l.startsWith('happened')), 'never in what it perceived');
  assert.ok(perceived.some((l: string) => l.includes('researcher:1 applied')), 'its own acts and their outcomes');
  /* A package altered: its world no longer holds together - said so. */
  const w = path.join(pkg, 'run.world.jsonl');
  const lines = fs.readFileSync(w, 'utf8').trim().split('\n');
  fs.writeFileSync(w, lines.filter((l) => !l.includes('"w2.prepare"')).join('\n') + '\n');
  assert.ok(!verifyWorld(readWorld(w)).holds);
});

const PLAN = (o: Partial<SessionPlan> = {}): SessionPlan => ({ seed: 4, clock: { decision_interval: 3, horizon: 200 }, explore: 1,
  limits: { calls_per_window: 2, intents_per_window: 2, messages_per_window: 2, message_chars: 300, window_ms: 20000, watchers: 1 },
  actors: [{ id: 'a', kind: 'researcher', rounds: 2, steps: 4, acts: 2 }, { id: 'b', kind: 'researcher', rounds: 2, steps: 4, acts: 2 }, { id: 'rival', kind: 'adversary', policy: 'adversary', actions: ['drain'] }],
  programs: [{ id: 'blight', trigger: { kind: 'at', tick: 5 }, effect: { type: 'contaminate' }, schedule: { max_firings: 1 }, exposure: 'sensors_only' }],
  ...o });
const SCRIPTS: Record<string, Record<number, unknown[]>> = {
  a: { 1: [{ investigate: [{ act: { feed: 'B2', amount: 2 } }] }, { investigate: [{ send: { to: 'b', text: 'I fed B2' } }] }, MODEL], 2: [MODEL] },
  b: { 1: [{ investigate: [{ observe: true }] }, { investigate: [{ observe: true }] }, { investigate: [{ read: 'inbox' }] }, MODEL], 2: [MODEL] }
};
const pair = (dir: string, plan = PLAN()) => {
  const fetchOf = (actor: string) => researcher(SCRIPTS[actor]);
  return runLivingSession(platesLab, { plan, dir, name: 'pair', root: dir, args: FLAT, connection: (actor) => ({ llm: { url: 'http://x.test/c', model: 's' }, fetch: fetchOf(actor) }) });
};

test('13: a shared session packed whole and rebuilt offline - its world derived again entry by entry, every researcher resumed from its own log, each recipient its own receipts', async () => {
  const dir = tmp('h5-session');
  const r = await pair(dir);
  assert.ok(Object.values(r.runs).every((x) => !x.error), JSON.stringify(r.runs));
  const { dir: pkg } = packSession(path.join(dir, 'pair.session.json'), path.join(tmp('h5-spkg'), 'pkg'));
  const v = await verifySessionPackage(pkg) as Record<string, any>;
  assert.ok(v.integrity.holds, JSON.stringify(v.integrity));
  assert.ok(v.world_record.holds, JSON.stringify(v.world_record.problems));
  assert.ok(v.reconstruction.holds, JSON.stringify(v.reconstruction));
  assert.equal(v.reconstruction.requests_refused, 0);
  assert.ok(readWorld(r.world).some((e) => /^r\.b\./.test(e.key)), 'b\'s receipts, recovered as its own');
});

test('16: the reserved evaluations are the same whatever happened in the world - messages, the operator\'s effects, watchers reach none of them', async () => {
  const alone = tmp('h5-16a');
  const a = await runLaboratory(platesLab, { args: ['--seed', '4', '--researcher', 'assisted', ...FLAT, '--explore', '1', '--attempts', '1', '--steps', '3', '--out', path.join(alone, 'run.json')], root: alone,
    llm: { url: 'http://x.test/c', model: 's' }, fetch: researcher({ 1: [MODEL] }) });
  const busy = tmp('h5-16b');
  const plan = PLAN({ actors: [{ id: 'a', kind: 'researcher', rounds: 1, steps: 3, acts: 2 } as never, { id: 'rival', kind: 'adversary', policy: 'adversary', actions: ['drain'] }],
    sensors: [{ actor: 'a', id: 'all', measure: '(o) => o.tick', every: 1, when: { above: 0 }, for: 50, notices: 3 }] });
  const s = await runLivingSession(platesLab, { plan, dir: busy, name: 'busy', root: busy, args: FLAT,
    connection: () => ({ llm: { url: 'http://x.test/c', model: 's' }, fetch: researcher({ 1: [{ investigate: [{ act: { feed: 'A1', amount: 3 } }] }, MODEL] }) }) });
  const traceOf = (file: string) => (JSON.parse(fs.readFileSync(file, 'utf8')).events as Record<string, any>[]).find((e) => e.type === 'check')!.laboratories.map((l: Record<string, unknown>) => l.trace);
  assert.deepEqual(traceOf(s.runs.a.journal!), traceOf(a.journal), 'the same reserved realizations, the same cases');
});

test('§15.1: the identity of a living condition - the same in any folder, changed by what changes it, the realization apart, adapted when the operator changed it', () => {
  const programs: ProgramDecl[] = [{ id: 'p', trigger: { kind: 'every', ticks: 4 }, effect: { type: 'smudge' }, schedule: { max_firings: 2 }, exposure: 'sensors_only' },
    { id: 'q', trigger: { kind: 'stagnation', signal: 's', window: 2, predicate: 'no_improvement' }, effect: { type: 'smudge' }, schedule: { max_firings: 1 }, exposure: 'sensors_only' }];
  const signals: SignalDecl[] = [{ id: 's', producer: 'checks', actor: 'Ana', unit: 'share', direction: 'higher', tolerance: 0 }];
  const actors: ActorDecl[] = [{ id: 'Ana', kind: 'researcher' }, { id: 'rival', kind: 'adversary', policy: 'adversary', params: { amount: 3 }, actions: ['drain'] }];
  const identity = (o: { dir?: string; seed?: number; actors?: ActorDecl[]; programs?: ProgramDecl[]; signals?: SignalDecl[]; control?: boolean } = {}) => {
    const file = path.join(o.dir ?? tmp('h5-id'), 'w.world.jsonl');
    const ss = o.signals ?? signals, as = (o.actors ?? actors);
    const s = new LivingSession({ adapter: platesAdapter as never, id: 'world:x', config: { layout: o.seed ?? 1 }, seed: o.seed ?? 1, actors: as, clock: { decision_interval: 3, horizon: 30 },
      limits: { calls_per_window: 2, intents_per_window: 2 }, journal: new WorldJournal(file), programs: o.programs ?? programs, signals: ss.map((x) => ({ ...x, actor: as[0].id })) });
    if (o.control) { s.control({ id: 'o', op: 'disable', target: 'p', by: 'operator' }); s.seal(as[0].id, []); s.settle(); }
    s.close('end');
    return livingIdentity(readWorld(file));
  };
  const base = identity();
  /* The same condition in another folder, its researcher named otherwise: the same hashes. */
  const elsewhere = identity({ actors: [{ id: 'Bea', kind: 'researcher' }, actors[1]] });
  assert.deepEqual([elsewhere.generator, elsewhere.condition, elsewhere.realization], [base.generator, base.condition, base.realization]);
  /* Its signal: the generator's. */
  const signal = identity({ signals: [{ ...signals[0], tolerance: 0.1 }] });
  assert.notEqual(signal.generator, base.generator); assert.equal(signal.condition, base.condition);
  /* A rule of its agenda, a policy of another actor: the condition's. */
  const rule = identity({ programs: [{ ...programs[0], trigger: { kind: 'every', ticks: 5 } }, programs[1]] });
  assert.notEqual(rule.condition, base.condition); assert.equal(rule.generator, base.generator);
  const policy = identity({ actors: [actors[0], { ...actors[1], params: { amount: 2 } }] });
  assert.notEqual(policy.condition, base.condition);
  /* Its permissions: the generator's. */
  const perms = identity({ actors: [{ ...actors[0], actions: ['feed'] }, actors[1]] });
  assert.notEqual(perms.generator, base.generator);
  /* Another seed: the same generator and condition, another realization. */
  const seed = identity({ seed: 7 });
  assert.deepEqual([seed.generator, seed.condition], [base.generator, base.condition]);
  assert.notEqual(seed.realization, base.realization);
  /* Changed by the operator during the run: adapted, never grouped as the condition fixed at the start. */
  assert.equal(base.adapted, false);
  assert.equal(identity({ control: true }).adapted, true);
});

test('K1, K2, K4, K5: results and traces of a living world - the session the unit, its cost once, its condition and interventions in its group, its process described', async () => {
  const dir = tmp('h5-results');
  const r = await pair(dir);
  const sr = sessionResults(path.join(dir, 'pair.session.json')) as Record<string, any>;
  assert.match(sr.unit, /the session/);
  assert.equal(sr.members.length, 2, 'its two researchers apart - not two observations');
  const sum = sr.members.reduce((n: number, m: any) => n + (m.cost.tokens.junior ?? 0), 0);
  assert.equal(sr.cost.tokens_total_at_least, sum, 'each member\'s cost once');
  assert.ok(sr.cost.world.windows > 0 && sr.cost.world.interventions.firings === 1, JSON.stringify(sr.cost.world));
  assert.deepEqual(sr.identity.interventions, ['operator_fixed']);
  const one = runResults(r.runs.a.journal!);
  assert.ok(one.cost.world && (one.cost.world as Record<string, unknown>).of, 'a member\'s run says the world\'s cost is the session\'s');
  const groups = groupResults([{ condition: 'pair', journal: r.runs.a.journal! }]);
  assert.ok(groups[0].group.world_condition && groups[0].group.adapted === false);
  assert.deepEqual(groups[0].group.interventions, ['operator_fixed']);
  const t = processTraces(r.runs.a.journal!) as unknown as Record<string, any>;
  assert.ok(t.world.windows > 0 && t.world.messages_sent === 1 && t.world.batches >= 1, JSON.stringify(t.world));
  assert.equal((processTraces(r.runs.b.journal!) as unknown as Record<string, any>).world.received >= 1, true);
});
