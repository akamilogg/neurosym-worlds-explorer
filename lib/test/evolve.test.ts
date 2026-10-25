import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stableStringify } from '../src/core/hash.ts';
import { runSearch, TransportFailure, type Evaluator, type Mutator, type SearchEvent } from '../src/learn/evolve/engine.ts';
import { balanced, dispatched, evaluated, initialState, next, register, type Profile } from '../src/learn/evolve/policy.ts';
import { artifactEvaluator, qualityOf } from '../src/learn/evolve/artifacts.ts';
import { ArtifactWorld } from '../src/artifacts/world.ts';
import { processSandbox } from '../src/artifacts/sandbox.ts';
import { threesumSubquadraticTask } from '../src/artifacts/tasks/threesum.ts';
import type { Verdict } from '../src/artifacts/task.ts';

/* SPEC-DELEGACION-EVOLUTIVA H1: the native engine and its policy balanced@1, with a scripted mutator and deterministic
   measures - the real policy, no paid inference - and the artifact evaluator on a real ArtifactWorld. */

/** A program is one line: "name=X q=<quality>|none ok=yes|no|crash|unchecked [cell=C]". */
function fakeEvaluator(identity = 'fake@1'): Evaluator & { calls: number } {
  const versions = new Map<string, Record<string, string>>();
  const hashOf = (f: Record<string, string>) => createHash('sha256').update(stableStringify(f)).digest('hex').slice(0, 12);
  const startFiles = { 'main.py': 'name=A q=1 ok=yes' };
  versions.set(hashOf(startFiles), startFiles);
  const ev = {
    calls: 0,
    async identity() { return identity; },
    contract: () => ({ about: 'a fake task' }),
    start: () => ({ hash: hashOf(startFiles), files: startFiles }),
    validate: (files: Readonly<Record<string, string | null>>) => (Object.keys(files).some((p) => p.includes('..')) ? 'a path outside the artifact' : null),
    materialize(from: string, files: Readonly<Record<string, string | null>>) {
      const merged: Record<string, string> = { ...versions.get(from)! };
      for (const [k, v] of Object.entries(files)) { if (v === null) delete merged[k]; else merged[k] = v; }
      const h = hashOf(merged);
      versions.set(h, merged);
      return { hash: h, files: merged };
    },
    adopt(hash: string, files: Readonly<Record<string, string>>) { if (hashOf({ ...files }) !== hash) return 'content mismatch'; versions.set(hash, { ...files }); return null; },
    async evaluate(hash: string) {
      ev.calls++;
      const t = versions.get(hash)!['main.py'];
      const q = /q=(\S+)/.exec(t)?.[1], ok = /ok=(\w+)/.exec(t)?.[1], cell = /cell=(\w+)/.exec(t)?.[1] ?? null;
      return { executable: ok !== 'crash', correct: (ok === 'yes' ? 'yes' : ok === 'unchecked' ? 'unchecked' : 'no') as 'yes' | 'no' | 'unchecked',
        quality: [q === 'none' || q === undefined ? null : Number(q)], descriptor: cell, feedback: { q }, diagnostics: ok === 'yes' ? [] : ['wrong on workload w1'], evaluator: identity };
    }
  };
  return ev;
}

const answer = (main: string) => JSON.stringify({ files: { 'main.py': main }, why: 'w' });
const parentText = (ctx: any): string => ctx.parent?.files?.['main.py'] ?? ctx.program?.files?.['main.py'] ?? ctx.parents?.[0]?.files?.['main.py'] ?? '';
const nameOf = (ctx: any) => /name=(\S+)/.exec(parentText(ctx))?.[1] ?? null;
function scripted(rule: (ctx: any, n: number) => string | Error): Mutator & { calls: number; contexts: any[] } {
  const m = { calls: 0, contexts: [] as any[], async propose(ctx: unknown) {
    m.calls++; m.contexts.push(ctx);
    const r = rule(ctx, m.calls);
    if (r instanceof Error) throw r;
    return { text: r, tokens: 10 };
  } };
  return m;
}
const out = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-')), 'search.jsonl');
const run = (evaluator: Evaluator, mutator: Mutator, limits: { evaluations: number; attempts: number; tokens?: number }, extra: Partial<Parameters<typeof runSearch>[0]> = {}, profile: Profile = balanced(0.05)) =>
  runSearch({ evaluator, mutator, profile, question: 'find a better program', limits: { tokens: 1e9, ...limits }, out: out(), ...extra });
const logOf = (events: SearchEvent[]) => events.filter((e) => e.type === 'candidate');

test('H1.1 several steps across: B and C, correct and worse than A, are developed until D improves A', async () => {
  const first = new Set<string>();
  const once = (k: string) => (first.has(k) ? false : (first.add(k), true));
  const mutator = scripted((ctx, n) => {
    const p = nameOf(ctx);
    if (p === 'A' && once('A')) return answer('name=B q=1.5 ok=yes');
    if (p === 'B' && once('B')) return answer('name=C q=1.3 ok=yes');
    if (p === 'C' && once('C')) return answer('name=D q=0.5 ok=yes');
    return answer('name=J' + n + ' q=' + (3 + n) + ' ok=yes');
  });
  const { manifest } = await run(fakeEvaluator(), mutator, { evaluations: 60, attempts: 60 });
  const s = manifest.state;
  const byName = (x: string) => Object.values(s.candidates).find((c) => c.files['main.py'].startsWith('name=' + x + ' '))!;
  const [A, B, C, D] = ['A', 'B', 'C', 'D'].map(byName);
  assert.ok(D, 'D found');
  assert.deepEqual([B.parents, C.parents, D.parents], [[A.hash], [B.hash], [C.hash]]);
  assert.equal(s.elites[0], D.hash, 'D the first elite');
  for (const h of [B.hash, C.hash]) assert.ok(s.log.some((e) => e.event === 'development_admitted' && e.hash === h), 'developed though worse than A');
  assert.ok(s.log.some((e) => e.event === 'development_done'), 'a slot freed when its quota is used');

  /* Capacity: a queue that is full leaves the newest unadmitted, recorded - never the next one to be served. */
  const tight = { ...balanced(0.05), pending: 1, development: 1 };
  const many = await run(fakeEvaluator(), scripted((_c, n) => answer('name=K' + n + ' q=' + (2 + n) + ' ok=yes')), { evaluations: 12, attempts: 12 }, {}, tight);
  assert.ok(many.manifest.state.log.some((e) => e.event === 'not_admitted' && e.why === 'admission_capacity'));
});

test('H1.2 correctness, quality and acceptance apart: a fast wrong one never an elite, repaired within its quota', async () => {
  const seen: string[] = [];
  const mutator = scripted((ctx, n) => {
    const p = nameOf(ctx);
    seen.push(ctx.operator + ':' + p);
    if (p === 'A') {
      const k = seen.filter((x) => x.endsWith(':A')).length;
      if (k === 1) return answer('name=F q=0.1 ok=no');
      if (k === 2) return answer('name=U q=0.2 ok=unchecked');
      if (k === 3) return answer('name=N q=none ok=yes');
      if (k === 4) return answer('name=A q=1 ok=yes');
    }
    if (p === 'F') return answer('name=F2 q=0.1 ok=no');
    if (p === 'F2') return answer('name=F3 q=0.1 ok=no');
    return answer('name=J' + n + ' q=' + (3 + n) + ' ok=yes');
  });
  const { manifest } = await run(fakeEvaluator(), mutator, { evaluations: 30, attempts: 30 });
  const s = manifest.state;
  const named = (x: string) => Object.values(s.candidates).find((c) => c.files['main.py'].startsWith('name=' + x + ' '));
  const [F, U, N, A] = ['F', 'U', 'N', 'A'].map((x) => named(x)!);
  assert.ok(!s.elites.includes(F.hash), 'fast and wrong: never an elite');
  assert.ok(s.log.some((e) => e.event === 'repair_admitted' && e.hash === F.hash));
  assert.ok(s.log.some((e) => e.event === 'repair_done' && e.origin === F.hash), 'its quota used, its slot freed');
  assert.ok(!s.log.some((e) => e.event === 'repair_admitted' && e.hash === named('F2')?.hash), 'a repair still wrong continues on the same slot');
  assert.ok(!s.elites.includes(U.hash) && !s.log.some((e) => e.event === 'development_admitted' && e.hash === U.hash), 'unchecked is not success');
  assert.ok(s.log.some((e) => e.event === 'development_admitted' && e.hash === N.hash), 'no quality, correctness checked: developed');
  assert.equal(s.log.filter((e) => e.event === 'development_admitted' && e.hash === A.hash).length, 1, 'a duplicate never renews a quota');
  assert.ok(s.log.some((e) => e.event === 'duplicate' && e.hash === A.hash));
});

test('H1.3 reacting before evaluating: five answers with nothing new to run start the restarts, free of the dominant code', async () => {
  const mutator = scripted((_ctx, n) => (n <= 3 ? 'not json' : n <= 5 ? answer('name=A q=1 ok=yes') : answer('name=R' + n + ' q=4 ok=yes')));
  const { events, manifest } = await run(fakeEvaluator(), mutator, { evaluations: 20, attempts: 9 });
  const plans = events.filter((e) => e.type === 'attempt_planned');
  assert.deepEqual(plans.slice(5, 7).map((p) => [p.plan.operator, p.plan.recovery]), [['restart', 'generation'], ['restart', 'generation']]);
  for (const p of plans.slice(5, 7)) {
    assert.ok(!('parent' in p.context) && !('parents' in p.context) && !('program' in p.context));
    assert.ok(!JSON.stringify(p.context).includes('name=A'), 'not the dominant code');
    assert.equal(p.context.recent_failures.length, 5, 'the concrete failures');
  }
  assert.equal(manifest.stoppedBy, 'attempts', 'restarts end with the resources too');

  /* A transport failure is the infrastructure's: no miss, no quota consumed. */
  const flaky = scripted((_c, n) => (n === 1 ? new TransportFailure('connection reset') : answer('name=B' + n + ' q=2 ok=yes')));
  const r = await run(fakeEvaluator(), flaky, { evaluations: 3, attempts: 1 });
  assert.ok(r.events.some((e) => e.type === 'attempt_failed' && e.transport));
  const A = r.manifest.state.candidates[r.manifest.state.order[0]];
  assert.equal(r.manifest.state.development.find((d) => d.hash === A.hash)?.quota, 2, 'its quota untouched');
  assert.equal(r.manifest.state.generation.misses, 0, 'never a miss of generation');
});

test('H1.4 the feedback used, and stagnation recognized: two blocks without progress change the selection', async () => {
  const mutator = scripted((ctx, n) => (n === 1 ? '{"files": 3}' : answer('name=J' + n + ' q=' + (3 + n) + ' ok=yes')));
  const profile = { ...balanced(0.05), block: 2, blocksWithoutProgress: 2 };
  const { events } = await run(fakeEvaluator(), mutator, { evaluations: 14, attempts: 14 }, {}, profile);
  const plans = events.filter((e) => e.type === 'attempt_planned');
  const fromA = plans.slice(1).find((p) => p.context.parent?.files?.['main.py']?.startsWith('name=A '));
  assert.ok(fromA && fromA.context.parent.diagnostics.some((d: string) => /refused/.test(d)), 'the diagnostic that belongs to it');
  const rec = plans.filter((p) => p.plan.recovery === 'development');
  assert.deepEqual(rec.slice(0, 5).map((p) => p.plan.turn + ':' + p.plan.operator), ['development:rewrite', 'restart:restart', 'development:rewrite', 'restart:restart', 'development:rewrite']);

  /* Both at once: the generation's first, the development's paused. */
  const s = initialState(balanced(0.05));
  s.generation.restartsLeft = 1; s.progress.recovery = 0;
  const plan = next(s);
  assert.equal(plan.recovery, 'generation');
  dispatched(s, plan);
  assert.equal(s.progress.recovery, 0, 'paused, not consumed');
  assert.equal(next(s).recovery, 'development');
});

test('H1.5 measured without falsifying the objective: the slope where growth is judged; a better descendant takes its cell', () => {
  const v = (x: Partial<Verdict>): { family: string; verdict: Verdict } => ({ family: 'f', verdict: { holds: false, correct: true, incorrect: [], ratio: null, interval: null, better: false, constraints: [], why: '', ...x } as Verdict });
  assert.deepEqual(qualityOf([v({ growth: { slope: -0.3, interval: [-0.4, -0.2], sizes: [1, 2], fixed: { reference: 1, candidate: 1 } }, ratio: 0.5, interval: [0.4, 0.6] }), v({ ratio: 0.5, interval: [0.4, 0.7] }), v({})]),
    [-0.2, 0.7, null], 'the slope, never the time; absent stays absent');
  const s = initialState(balanced(0.05));
  const e = (q: number, cell: string) => ({ executable: true, correct: 'yes' as const, quality: [q], descriptor: cell, feedback: null, diagnostics: [], evaluator: 'x' });
  register(s, { hash: 'a', files: {}, parents: [], origin: 'start', root: true });
  evaluated(s, 'a', e(1, 'x'), { plan: null, reevaluation: false });
  register(s, { hash: 'b', files: {}, parents: ['a'], origin: 'attempt:1', root: false });
  evaluated(s, 'b', e(0.5, 'x'), { plan: null, reevaluation: false });
  assert.equal(s.cells.x.occupants[0], 'b', 'no premium for having opened the cell');
  register(s, { hash: 'c', files: {}, parents: [], origin: 'attempt:2', root: true });
  evaluated(s, 'c', e(2, 'x'), { plan: null, reevaluation: false });
  assert.deepEqual(s.cells.x.occupants, ['b', 'c'], 'the best, and the most recent of another lineage');
});

test('H1.6 rebuilt and continued: replay identical without a model or a measure; a continuation imports, never renews', async () => {
  const rule = (_ctx: any, n: number) => (n % 4 === 0 ? 'not json' : answer('name=J' + n + ' q=' + (n % 3 ? 2 + n / 10 : 0.9 - n / 100) + ' ok=' + (n % 5 ? 'yes' : 'no')));
  const first = await run(fakeEvaluator(), scripted(rule), { evaluations: 15, attempts: 15 });
  const ev = fakeEvaluator(), mu = scripted(() => { throw new Error('never asked'); });
  const again = await run(ev, mu, { evaluations: 15, attempts: 15 }, { recorded: first.events, live: false });
  assert.equal(mu.calls + ev.calls, 0, 'nothing asked, nothing measured');
  assert.equal(stableStringify(again.manifest.state), stableStringify(first.manifest.state), 'the same selection, cursors, quotas');
  assert.deepEqual(again.events.filter((e) => e.type === 'attempt_planned').map((e) => e.context_hash), first.events.filter((e) => e.type === 'attempt_planned').map((e) => e.context_hash));

  /* A continuation: its cursors go on, its quotas are not given again, what it cost is kept apart. */
  const sealed = JSON.parse(JSON.stringify(first.manifest));
  const cont = await run(fakeEvaluator(), scripted((_c, n) => answer('name=K' + n + ' q=5 ok=yes')), { evaluations: 3, attempts: 3 }, { continueFrom: first.manifest });
  assert.equal(cont.manifest.state.attempts, first.manifest.state.attempts + cont.manifest.cost.attempts, 'its attempts go on');
  assert.deepEqual(cont.manifest.inherited, first.manifest.cost, 'its earlier cost apart');
  assert.equal(cont.manifest.cost.attempts, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(first.manifest)), sealed, 'its origin unchanged');
  /* Another evaluator: the evidence stale, measured again before selecting, no quota renewed. */
  const other = fakeEvaluator('fake@2');
  const moved = await run(other, scripted((_c, n) => answer('name=M' + n + ' q=5 ok=yes')), { evaluations: 40, attempts: 1 }, { continueFrom: first.manifest });
  assert.ok(moved.events.some((e) => e.type === 'evidence_stale'));
  const re = moved.events.filter((e) => e.type === 'evaluation_planned' && e.reevaluation);
  assert.ok(re.length > 0 && moved.events.findIndex((e) => e.type === 'attempt_planned') > moved.events.indexOf(re[re.length - 1]), 'measured again first');
  /* Content changed: refused. */
  await assert.rejects(run(fakeEvaluator(), scripted(() => 'x'), { evaluations: 1, attempts: 1 }, { continueFrom: { ...first.manifest, question: 'tampered' } }), /does not hash/);
});

test('H1.7 closed at any point: a cancellation keeps what was done; an answer not known is never asked again', async () => {
  const controller = new AbortController();
  const m = scripted((_c, n) => { if (n === 3) controller.abort(); return answer('name=J' + n + ' q=2 ok=yes'); });
  const c = await run(fakeEvaluator(), m, { evaluations: 50, attempts: 50 }, { signal: controller.signal });
  assert.equal(c.manifest.stoppedBy, 'cancelled');
  assert.ok(c.manifest.cost.attempts >= 3 && c.manifest.state.order.length >= 3, 'what was done, visible');

  /* A crash after a plan, before its answer: resumed, that call is uncertain and never made again; an evaluation planned
     without its result is measured. */
  const full = await run(fakeEvaluator(), scripted((_c, n) => answer('name=J' + n + ' q=2 ok=yes')), { evaluations: 6, attempts: 6 });
  const cut = full.events.findIndex((e) => e.type === 'attempt_planned' && e.attempt === 'attempt:2');
  const crashed = full.events.slice(0, cut + 1);
  const resumedMutator = scripted((_c, n) => answer('name=L' + n + ' q=2 ok=yes'));
  const resumed = await run(fakeEvaluator(), resumedMutator, { evaluations: 6, attempts: 6 }, { recorded: crashed, live: true });
  assert.ok(resumed.events.some((e) => e.type === 'attempt_uncertain' && e.attempt === 'attempt:2'));
  assert.equal(resumedMutator.calls, resumed.events.filter((e) => e.type === 'attempt_answered' && e.attempt !== 'attempt:1').length, 'asked only for the attempts after it');
  assert.ok(!resumed.events.some((e) => e.type === 'attempt_answered' && e.attempt === 'attempt:2'), 'never answered after the crash');
  const cutEval = full.events.findIndex((e) => e.type === 'evaluation_planned' && e.evaluation === 'evaluation:2');
  const measured = fakeEvaluator();
  await run(measured, scripted((_c, n) => answer('name=P' + n + ' q=2 ok=yes')), { evaluations: 2, attempts: 1 }, { recorded: full.events.slice(0, cutEval + 1), live: true });
  assert.ok(measured.calls >= 1, 'the evaluation without its result is measured');
});

test('H1 the artifact evaluator: the harness\'s world, laboratories only, the task\'s quality, plain paths', async () => {
  const world = new ArtifactWorld(threesumSubquadraticTask({ scale: 0.05 }), processSandbox());
  assert.throws(() => artifactEvaluator(world, { families: ['ladder-late'], workloads: 1, seed: 3 }), /laboratories only/);
  const ev = artifactEvaluator(world, { families: ['ladder'], workloads: 1, seed: 3 });
  assert.match(String(ev.validate({ '../x.py': 'y' })), /plain relative path/);
  assert.equal(ev.validate({ 'main.py': 'y' }), null);
  const start = ev.start();
  const e = await ev.evaluate(start.hash);
  assert.equal(e.correct, 'yes');
  assert.equal(e.quality!.length, 1, 'one component per family');
  assert.match(await ev.identity(), /threesum-subquadratic@1/);
  const made = ev.materialize(start.hash, { 'main.py': 'open("out.txt", "w").write("no\\n")\n' });
  assert.ok('hash' in made);
  const wrong = await ev.evaluate((made as { hash: string }).hash);
  assert.equal(wrong.correct, 'no', 'a fixed answer caught by the oracle');
  assert.ok(wrong.diagnostics.length > 0);
});

test('H1 a context that does not fit is refused, never cut', async () => {
  const m = scripted(() => answer('name=B q=2 ok=yes'));
  const { events } = await run(fakeEvaluator(), m, { evaluations: 3, attempts: 2 }, { maxContext: 50 });
  assert.equal(m.calls, 0, 'never asked with a cut context');
  assert.ok(events.filter((e) => e.type === 'candidate' && /does not fit/.test(e.why ?? '')).length === 2);
});

