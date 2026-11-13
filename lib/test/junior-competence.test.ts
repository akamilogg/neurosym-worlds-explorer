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

/* ===== SPEC-VALIDEZ-MEDIDA, VM2: a promotion that lets nothing get worse, and a manifest that says whether it can decide ===== */

/** Two probe components, `n` cases each, all of one world; paired-cases@2 unless said. */
function powered(n: number, over: Partial<CompetenceManifest> = {}, procedure: 'paired-cases@1' | 'paired-cases@2' = 'paired-cases@2'): CompetenceManifest {
  const probe = (id: string, component: string, checker: string) => ({ id, kind: 'probe' as const, partition: 'development' as const, group: 'g-' + id, component, lab: 'cells', mode: 'start' as const,
    cut: { run: 'runs/cells.json', question: 1, hash: H }, competence: 'c', instruction: 'Do it.', checker: { id: checker, version: 1 } });
  return {
    format: 'junior-competence-manifest@1', id: 'vm2', reference: H,
    components: [
      { id: 'format', rung: 1, mode: 'start', extractor: { id: 'probe', version: 1 }, unit: 'share', direction: 'up', target: 1, bad: 0, tolerance: 0 },
      { id: 'rules', rung: 3, mode: 'start', extractor: { id: 'probe', version: 1 }, unit: 'share', direction: 'up', target: 1, bad: 0, tolerance: 0 }
    ],
    cases: [...Array.from({ length: n }, (_, i) => probe('f' + i, 'format', 'protocol')), ...Array.from({ length: n }, (_, i) => probe('r' + i, 'rules', 'rules'))],
    investigation_repetitions: 1, execution: { harness: 'test' }, sampling: { seed: 7 },
    promotion: { procedure, alpha: 0.05, permutations: 10000, seed: 1 },
    limits: { junior_args: ['--max-tokens', '100000', '--max-judge-calls', '50'], probe_max_tokens: 2000, timeout_ms: 600000 },
    ...over
  } as CompetenceManifest;
}
/** A measure of `powered`: each case of a component at the deficit given. */
const at = (m: CompetenceManifest, f: number | number[], r: number | number[]) => measure(m, 'development', 0, m.cases.map((c, i) => {
  const k = c as { component: string };
  const v = k.component === 'format' ? f : r;
  const d = Array.isArray(v) ? v[i % v.length] : v;
  return obs(k.component, c.id, 1 - d);
}));

test('VM2: paired-cases@2 - a component that is not protected and gets worse beyond its tolerance is not_promoted; @1 keeps its verdict', () => {
  const m2 = powered(8);
  const p = promote(m2, at(m2, 1, 0), at(m2, 0, 1));
  assert.equal(p.verdict, 'not_promoted', p.why);
  assert.match(p.why, /rules/);
  const m1 = powered(8, {}, 'paired-cases@1');
  assert.equal(promote(m1, at(m1, 1, 0), at(m1, 0, 1)).verdict, 'promoted', '@1 reads as it read: only protected components block');
});

test('VM2: paired-cases@2 - a fall within the tolerance that the test finds significant also blocks; each component carries its power', () => {
  const m = powered(8, { components: powered(8).components.map((c) => (c.id === 'rules' ? { ...c, tolerance: 0.5 } : c)) });
  const p = promote(m, at(m, 1, 0), at(m, 0, 0.3));
  assert.equal(p.verdict, 'not_promoted', 'eight cases of eight 0.3 worse: within its tolerance on the mean, significant by the test');
  const rules = p.components.find((c) => c.id === 'rules')!;
  assert.equal(rules.regresses, true);
  assert.deepEqual([rules.n, rules.min_p], [8, 1 / 256]);
  assert.equal(promote(m, at(m, 1, 0), at(m, 0, [0.3, 0, 0, 0])).verdict, 'promoted', 'two cases of eight worse: neither beyond its tolerance nor significant');
});

test('VM2: a manifest says whether it can decide - none of its components can improve: refused, saying how many cases each lacks; some cannot: accepted, warned', async () => {
  const { competenceWarnings } = await import('../src/junior/competence.ts');
  const weak = powered(3);
  assert.ok(competenceProblems(weak).some((p) => /no component can be promoted/.test(p) && /format: 3 cases.*6/.test(p)), competenceProblems(weak).join('; '));
  assert.deepEqual(competenceProblems(powered(6)), [], 'six cases: 2^-6 is under 0.05 / 2');
  const mixed = powered(6, { cases: [...powered(6).cases.filter((c) => (c as { component: string }).component === 'format'), ...powered(2).cases.filter((c) => (c as { component: string }).component === 'rules')] });
  assert.deepEqual(competenceProblems(mixed), []);
  assert.ok(competenceWarnings(mixed).some((w) => /rules/.test(w) && /2 cases/.test(w) && /4 more/.test(w)), competenceWarnings(mixed).join('; '));
  assert.ok(competenceWarnings(powered(3, {}, 'paired-cases@1')).length, 'under @1 the same lack is told, never refused');
  assert.deepEqual(competenceProblems(powered(3, {}, 'paired-cases@1')), []);
});

test('VM2: the confirmation service refuses a paired-cases@2 manifest whose reserved cases can decide nothing', async () => {
  const { ConfirmationService } = await import('../src/junior/confirm.ts');
  const os = await import('node:os'), fs = await import('node:fs'), path = await import('node:path');
  const inv = (id: string, partition: 'development' | 'confirmation') => ({ id, kind: 'investigation' as const, lab: 'cells', args: ['--seed', id], partition, group: 'g-' + id, components: ['cells-L1'] });
  const base = manifest({ promotion: { procedure: 'paired-cases@2' as never, alpha: 0.05, permutations: 10000, seed: 1 } });
  const confirming = { ...base, components: [base.components[1]], cases: [...Array.from({ length: 6 }, (_, i) => inv('d' + i, 'development')), inv('c1', 'confirmation'), inv('c2', 'confirmation')] };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2-confirm-'));
  assert.throws(() => new ConfirmationService({ root, manifest: confirming, client: {} as never, launcher: {} as never }), /confirmation.*cannot be promoted|can decide nothing/);
  const enough = { ...confirming, cases: [...confirming.cases, ...Array.from({ length: 4 }, (_, i) => inv('c' + (i + 3), 'confirmation'))] };
  assert.doesNotThrow(() => new ConfirmationService({ root, manifest: enough, client: {} as never, launcher: {} as never }));
});

test('VM2: the holdout - probe cases a search never selects on, and the only ones a candidate of a search is promoted on', async () => {
  const { selectionManifest, holdoutManifest } = await import('../src/junior/competence.ts');
  /* Six cases a component: a holdout that can promote (a smaller one is refused under @2 - VM2 review). */
  const held = ['f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'r6', 'r7', 'r8', 'r9', 'r10', 'r11'];
  const m = powered(12, { holdout: held });
  assert.deepEqual(competenceProblems(m), []);
  assert.ok(competenceProblems(powered(8, { holdout: ['nowhere'] })).some((p) => /holdout/.test(p)));
  assert.ok(competenceProblems(powered(8, { holdout: ['f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7'] })).some((p) => /holdout/.test(p) && /format/.test(p)), 'a component keeps cases to select on');
  const sel = selectionManifest(m);
  assert.deepEqual(sel.cases.map((c) => c.id).filter((id) => held.includes(id)), [], 'a search selects on none of them');
  const hold = holdoutManifest(m)!;
  assert.deepEqual(hold.cases.map((c) => c.id).sort(), [...held].sort());
  assert.equal(holdoutManifest(powered(8)), null, 'without a holdout there is none');
});

test('VM2: a candidate of a search is promoted on the holdout alone - a gain on the cases it was selected on is not one', async () => {
  const { promoteEvaluations, promoteOnHoldout } = await import('../src/junior/evaluate.ts');
  const { competenceHash } = await import('../src/junior/competence.ts');
  const m = powered(8, { holdout: ['f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'r6', 'r7'] });
  const hash = competenceHash(m);
  const ev = (execution: string, better: (id: string) => boolean) => ({ format: 'junior-evaluation@1' as const, manifest: hash, execution, partition: 'development' as const, temperature: 0,
    observations: m.cases.map((c) => obs((c as { component: string }).component, c.id, better(c.id) ? 1 : 0)), measure: null as never });
  const reference = ev(H, () => false);
  /* Better on format's cases f6 and f7 - the ones a search selected on - and nowhere else. */
  const selected = ev('b'.repeat(64), (id) => id === 'f6' || id === 'f7');
  assert.equal(promoteOnHoldout(powered(8), hash, reference, selected), null, 'without a holdout there is no promotion of a search\'s candidate');
  assert.notEqual(promoteOnHoldout(m, hash, reference, selected)!.verdict, 'promoted', 'nothing gained on the holdout');
  /* Better on every format case, the holdout's among them. */
  const real = ev('c'.repeat(64), (id) => id.startsWith('f'));
  const p = promoteOnHoldout(m, hash, reference, real)!;
  assert.equal(p.verdict, 'promoted', p.why);
  assert.deepEqual(p.components.map((c) => [c.id, c.n]), [['format', 6], ['rules', 2]], 'measured on the holdout\'s cases');
  assert.equal(promoteEvaluations(m, hash, reference, real).components.find((c) => c.id === 'format')!.n, 8, 'the same evaluations on all of development');
});

test('VM2 review: promoted on the holdout, a candidate still answers for every component outside it - one it sinks on development blocks it', async () => {
  const { promoteEvaluations, promoteOnHoldout } = await import('../src/junior/evaluate.ts');
  const { competenceHash } = await import('../src/junior/competence.ts');
  const inv = (id: string, seed: string) => ({ id, kind: 'investigation' as const, lab: 'cells', args: ['--seed', seed], partition: 'development' as const, group: 'g-' + id, components: ['cells-L1'] });
  const p = powered(12);
  const m = { ...p, components: [p.components[0], { id: 'cells-L1', rung: 6, lab: 'cells', level: 'L1', extractor: { id: 'accepted', version: 1 }, unit: 'solved', direction: 'up', target: 1, bad: 0, tolerance: 0 }],
    cases: [...p.cases.filter((c) => (c as { component: string }).component === 'format'), ...Array.from({ length: 6 }, (_, i) => inv('d' + i, String(10 + i)))],
    holdout: ['f6', 'f7', 'f8', 'f9', 'f10', 'f11'] } as CompetenceManifest;
  assert.deepEqual(competenceProblems(m), []);
  const hash = competenceHash(m);
  const ev = (execution: string, f: number, w: number) => ({ format: 'junior-evaluation@1' as const, manifest: hash, execution, partition: 'development' as const, temperature: 0, measure: null as never,
    observations: m.cases.map((c) => obs(c.kind === 'probe' ? 'format' : 'cells-L1', c.id, c.kind === 'probe' ? f : w)) });
  const reference = ev(H, 0, 1), sinks = ev('b'.repeat(64), 1, 0);
  assert.equal(promoteEvaluations(m, hash, reference, sinks).verdict, 'not_promoted');
  const held = promoteOnHoldout(m, hash, reference, sinks)!;
  assert.equal(held.verdict, 'not_promoted', held.why);
  assert.match(held.why, /cells-L1/);
  const keeps = ev('c'.repeat(64), 1, 1);
  assert.equal(promoteOnHoldout(m, hash, reference, keeps)!.verdict, 'promoted', 'better on the holdout, nothing worse elsewhere');
});

test('VM2 review: a holdout that can promote nothing is refused under @2 and told under @1; the warnings reach whoever prepares the manifest', async () => {
  const { competenceWarnings } = await import('../src/junior/competence.ts');
  const small = powered(12, { holdout: ['f10', 'f11', 'r10', 'r11'] });
  assert.ok(competenceProblems(small).some((p) => /holdout/.test(p) && /can be promoted/.test(p)), competenceProblems(small).join('; '));
  const told = powered(12, { holdout: ['f10', 'f11', 'r10', 'r11'] }, 'paired-cases@1');
  assert.deepEqual(competenceProblems(told), []);
  assert.ok(competenceWarnings(told).some((w) => /holdout/.test(w) && /format/.test(w)), competenceWarnings(told).join('; '));
  const { prepareManifest } = await import('../src/junior/evaluate.ts');
  const prepared = await prepareManifest(powered(3, {}, 'paired-cases@1'));
  assert.ok(prepared.warnings.length > 0, 'prepared with its warnings');
});

test('VM2 review 2: one rule promotes a candidate whatever path presents it - one a search selected, on the holdout or never', async () => {
  const { promoteCandidate, promoteOnHoldout } = await import('../src/junior/evaluate.ts');
  const { competenceHash, withoutHoldout } = await import('../src/junior/competence.ts');
  const held = ['f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'r6', 'r7', 'r8', 'r9', 'r10', 'r11'];
  const m = powered(12, { holdout: held });
  const hash = competenceHash(m);
  const ev = (execution: string, better: (id: string) => boolean) => ({ format: 'junior-evaluation@1' as const, manifest: hash, execution, partition: 'development' as const, temperature: 0, measure: null as never,
    observations: m.cases.map((c) => obs((c as { component: string }).component, c.id, better(c.id) ? 1 : 0)) });
  const reference = ev(H, (id) => held.includes(id));
  /* Better on every case it was selected on, worse on every reserved one. */
  const selected = ev('b'.repeat(64), (id) => !held.includes(id));
  const { promoteEvaluations } = await import('../src/junior/evaluate.ts');
  assert.equal(promoteCandidate(m, hash, reference, selected, { fromSearch: false }).verdict, promoteEvaluations(m, hash, reference, selected).verdict, 'a candidate of no search: all of development');
  const bySearch = promoteCandidate(m, hash, reference, selected, { fromSearch: true });
  assert.equal(bySearch.verdict, promoteOnHoldout(m, hash, reference, selected)!.verdict, 'the researcher\'s check and the operator\'s rule agree');
  assert.equal(bySearch.verdict, 'not_promoted');
  const none = powered(12);
  const noHold = promoteCandidate(none, competenceHash(none), { ...reference, manifest: competenceHash(none) }, { ...selected, manifest: competenceHash(none) }, { fromSearch: true });
  assert.notEqual(noHold.verdict, 'promoted', 'without a holdout a search\'s candidate is never promoted');
  assert.match(noHold.why, /best of N in selection/);
  /* What the researcher is shown leaves the reserved cases out. */
  assert.deepEqual(withoutHoldout(m).cases.filter((c) => held.includes(c.id)), []);
});
