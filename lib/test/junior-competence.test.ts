import test from 'node:test';
import assert from 'node:assert/strict';
import { competenceProblems, deficit, measure, promote, seedOf, signFlipP, type CompetenceManifest, type Observation } from '../src/junior/competence.ts';

/* SPEC-METAPOLITICA-APRENDIZAJE §6.3-§6.5, MA2: the manifest, the deficits, the components and paired-cases@1. */

const H = 'a'.repeat(64);

function manifest(over: Partial<CompetenceManifest> = {}): CompetenceManifest {
  const probe = (id: string, lab: string, component = 'requests-act', mode: 'start' | 'cut' = 'start') => ({
    id, kind: 'probe' as const, partition: 'development' as const, group: 'g-' + id, component, lab, mode,
    cut: { run: 'runs/' + lab + '.json', question: 2, hash: H }, competence: 'a valid act', instruction: 'Emit one valid act request.', checker: { id: 'request', version: 1 }
  });
  return {
    format: 'junior-competence-manifest@1', id: 'pilot', reference: H,
    components: [
      { id: 'requests-act', rung: 2, mode: 'start', request: 'act', extractor: { id: 'probe', version: 1 }, unit: 'share', direction: 'up', target: 1, bad: 0, tolerance: 0, protected: true },
      { id: 'cells-L1', rung: 6, lab: 'cells', level: 'L1', extractor: { id: 'accepted', version: 1 }, unit: 'solved', direction: 'up', target: 1, bad: 0, tolerance: 0 }
    ],
    cases: [
      probe('p1', 'cells'), probe('p2', 'grid'),
      { id: 'i1', kind: 'investigation', lab: 'cells', args: ['--level', '1'], partition: 'development', group: 'g-i1', components: ['cells-L1'] },
      { id: 'c1', kind: 'investigation', lab: 'cells', args: ['--level', '1', '--seed', '9'], partition: 'confirmation', group: 'g-c1', components: ['cells-L1'] }
    ],
    investigation_repetitions: 1,
    execution: { harness: 'test' },
    sampling: { seed: 7 },
    promotion: { procedure: 'paired-cases@1', alpha: 0.05, permutations: 10000, seed: 1 },
    limits: { junior_args: ['--max-tokens', '100000', '--max-judge-calls', '50'], probe_max_tokens: 2000, timeout_ms: 600000 },
    ...over
  };
}

test('the manifest is refused before any inference: what it lacks and what would let a world weigh more', () => {
  assert.deepEqual(competenceProblems(manifest()), []);
  const m = manifest();
  const lop = { ...m, cases: [...m.cases, { ...(m.cases[0] as object), id: 'p3', group: 'g-p3' } as never] };
  assert.match(competenceProblems(lop).join(), /every world gives it as many probes \(cells 2, grid 1\)/);
  const conf = { ...m, cases: [{ ...(m.cases[0] as object), partition: 'confirmation' } as never, ...m.cases.slice(1)] };
  assert.match(competenceProblems(conf).join(), /a probe comes from development only/);
  const method = { ...m, components: [...m.components, { ...m.components[1], id: 'method', rung: 5 } as never] };
  assert.match(competenceProblems(method).join(), /rung 5, is diagnostic/);
  const shared = { ...m, cases: [...m.cases.slice(0, 3), { ...(m.cases[3] as object), group: 'g-i1' } as never] };
  assert.match(competenceProblems(shared).join(), /group g-i1 is in both partitions/);
  const incoherent = { ...m, components: [{ ...m.components[0], direction: 'down' as const }, m.components[1]] };
  assert.match(competenceProblems(incoherent).join(), /direction/);
  const unbounded = { ...m, limits: { ...m.limits, junior_args: [] } };
  assert.match(competenceProblems(unbounded).join(), /--max-tokens and --max-judge-calls/);
  const noSnapshot = { ...m, components: [{ ...m.components[0], mode: 'cut' as const }, m.components[1]], cases: m.cases.map((c) => (c.kind === 'probe' ? { ...c, mode: 'cut' as const } : c)) };
  assert.match(competenceProblems(noSnapshot).join(), /declares the "snapshot"/);
});

test('deficits both ways; seeds the same for every candidate', () => {
  assert.equal(deficit({ target: 1, bad: 0 }, 0.75), 0.25);
  assert.equal(deficit({ target: 0, bad: 10 }, 4), 0.4);
  assert.equal(deficit({ target: 0, bad: 10 }, 40), 1);
  assert.equal(deficit({ target: 1, bad: 0 }, 2), 0);
  assert.throws(() => deficit({ target: 1, bad: 0 }, NaN), /not finite/);
  assert.equal(seedOf(manifest(), 'p1', 0), seedOf(manifest(), 'p1', 0));
  assert.notEqual(seedOf(manifest(), 'p1', 0), seedOf(manifest(), 'p1', 1));
});

const obs = (component: string, c: string, value: number | null, rep = 0, state: Observation['state'] = 'measured'): Observation => ({ component, case: c, rep, value, state });

test('a component is the mean of its cases; anything missing leaves it without quality, never zero deficit', () => {
  const m = manifest();
  const whole = measure(m, 'development', 0, [obs('requests-act', 'p1', 1), obs('requests-act', 'p2', 0), obs('cells-L1', 'i1', 1)]);
  assert.equal(whole.complete, true);
  assert.deepEqual(whole.vector, [0.5, 0]);
  const sampled = measure(m, 'development', 0.7, [obs('requests-act', 'p1', 1), obs('requests-act', 'p2', 0), obs('cells-L1', 'i1', 1)]);
  assert.equal(sampled.complete, false, 'sampling asks four answers of each probe');
  assert.match(sampled.components[0].missing.join(), /p1#1 not run/);
  const infra = measure(m, 'development', 0, [obs('requests-act', 'p1', 1), obs('requests-act', 'p2', null, 0, 'infra'), obs('cells-L1', 'i1', 1)]);
  assert.equal(infra.vector, null);
  assert.equal(infra.components[0].quality, null);
  // Four answers with one probe of 3 opportunities met and one of 1: the case is the unit.
  const four = measure(m, 'development', 0.7, [0, 1, 2, 3].flatMap((r) => [obs('requests-act', 'p1', r < 3 ? 1 : 0, r), obs('requests-act', 'p2', r < 1 ? 1 : 0, r)]).concat([obs('cells-L1', 'i1', 0)]));
  assert.equal(four.components[0].quality, (0.25 + 0.75) / 2);
});

test('the sign-flip test: exact on few cases, seeded on many', () => {
  assert.equal(signFlipP([1, 1, 1, 1, 1], 1000, 1), 1 / 32);
  assert.equal(signFlipP([0, 0], 1000, 1), 1);
  const many = Array.from({ length: 30 }, () => 0.5);
  assert.equal(signFlipP(many, 2000, 3), signFlipP(many, 2000, 3));
  assert.ok(signFlipP(many, 2000, 3) < 0.01);
});

test('paired-cases@1: a clear improvement, a protected regression another improvement cannot buy, an improvement that does not hold', () => {
  const probes = Array.from({ length: 6 }, (_, i) => ({ id: 'p' + i, kind: 'probe' as const, partition: 'development' as const, group: 'g' + i, component: 'requests-act', lab: 'cells', mode: 'start' as const,
    cut: { run: 'r', question: i, hash: H }, competence: 'act', instruction: 'Emit one valid act.', checker: { id: 'request', version: 1 } }));
  const runs = Array.from({ length: 6 }, (_, i) => ({ id: 'i' + i, kind: 'investigation' as const, lab: 'cells', args: [], partition: 'development' as const, group: 'h' + i, components: ['cells-L1'] }));
  const m = manifest({ cases: [...probes, ...runs] });
  const of = (p: number[], w: number[]) => measure(m, 'development', 0, [...p.map((v, i) => obs('requests-act', 'p' + i, v)), ...w.map((v, i) => obs('cells-L1', 'i' + i, v))]);
  const ref = of([0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0]);
  assert.equal(promote(m, ref, of([1, 1, 1, 1, 1, 1], [0, 0, 0, 0, 0, 0])).verdict, 'promoted');
  const refGood = of([1, 1, 1, 1, 1, 1], [0, 0, 0, 0, 0, 0]);
  const traded = promote(m, refGood, of([1, 1, 1, 1, 1, 0], [1, 1, 1, 1, 1, 1]));
  assert.equal(traded.verdict, 'not_promoted', 'requests-act is protected: one probe lost is a regression whatever the worlds gain');
  assert.equal(promote(m, ref, of([1, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0])).verdict, 'inconclusive');
  assert.equal(promote(m, ref, measure(m, 'development', 0, [])).verdict, 'inconclusive');
});
