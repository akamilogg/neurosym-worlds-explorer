import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BlobStore, executionHash, normalizePackage, type JuniorPackage } from '../src/junior/package.ts';
import { SessionServer } from '../src/junior/sessions.ts';
import { serveJunior } from '../src/junior/http.ts';
import { ProcessWorker } from '../src/junior/worker.ts';
import { competenceHash, competenceProblems, needs, type CompetenceManifest, type Observation } from '../src/junior/competence.ts';
import type { Evaluation } from '../src/junior/evaluate.ts';
import { baseReader, bf16Bits, bf16Value, compose, editsInTree, readEdit, readEditSet, writeSafetensors, type RawTensor, type WeightBounds } from '../src/junior/weights.ts';
import { runWeightSearch, type SearchEvaluator, type WeightSearchConfig } from '../src/junior/weight-search.ts';
import { CONDITIONS, comparisonProblems, comparisonReport, planComparison, reportText, runControlEdits, runControlSearch, type WeightComparison } from '../src/junior/comparison.ts';
import { juniorLab, JuniorWorld, type JuniorSpec } from '../src/worlds/junior/lab.ts';

/* SPEC-EDICION-PESOS §8, WE6: the conditions A-F from one start and one budget, differing only in what each run may do;
   C and E made by the operator from B and D; the report - H1, H2, cost, diversity - from what they left, without a model. */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'junior-wcmp-'));
const python = ['python', 'python3'].find((p) => spawnSync(p, ['--version']).status === 0);
const bf16 = (shape: number[], values: number[]): RawTensor => ({ dtype: 'BF16', shape, bytes: new Uint8Array(Uint16Array.from(values.map(bf16Bits)).buffer) });
const DOWN = 'model.layers.4.mlp.down_proj', Q = 'model.layers.5.self_attn.q_proj';
const BOUNDS: WeightBounds = { per_module: { max_changed_fraction: 1, max_relative_norm: 3, max_representation: 1000, max_rank: 8, max_sparse_entries: 100 },
  total: { max_changed_fraction: 1, max_relative_norm: 3, max_representation: 1000 } };

function fixture() {
  const dir = tmp();
  const store = new BlobStore(path.join(dir, 'blobs'));
  const base = path.join(dir, 'base');
  fs.mkdirSync(base);
  fs.writeFileSync(path.join(base, 'chipformer.json'), JSON.stringify({ chip_layers: 2 }));
  fs.writeFileSync(path.join(base, 'tokenizer.json'), '{}');
  fs.writeFileSync(path.join(base, 'model.safetensors'), writeSafetensors({ [DOWN + '.weight']: bf16([2, 2], [3, 0, 0, 1]), [Q + '.weight']: bf16([2, 3], [1, 2, 3, 4, 5, 6]) }));
  const pkg = normalizePackage({ format: 'junior-package@1', name: 'start', base: store.putTree(base), prompt: '',
    execution: { firmware: store.put('f'), tokenizer: store.put('{}'), chat_template: store.put('c'), driver: store.put('d'), verifier: store.put('v'), circuit: { chip_layers: 2 }, precision: 'bf16' } });
  /* Eight cases a component: a paired sign test can then reach 1/256. */
  const probes = Array.from({ length: 16 }, (_, i) => ({ id: 'p' + i, kind: 'probe' as const, partition: 'development' as const, group: 'g-sel', component: i < 8 ? 'a' : 'b', lab: 'cells', mode: 'start' as const,
    cut: { run: path.join(dir, 'runs', 'sel.json'), question: 0, hash: 'h' + i }, competence: 'protocol', instruction: 'Answer (' + i + ').', checker: { id: 'protocol', version: 1 } }));
  const investigations = Array.from({ length: 8 }, (_, i) => ({ id: 'i' + i, kind: 'investigation' as const, lab: 'cells', args: ['--seed', String(i)], partition: 'development' as const, group: 'g-i' + i, components: ['cells-L1'] }));
  const manifest: CompetenceManifest = {
    format: 'junior-competence-manifest@1', id: 'wcmp', reference: executionHash(pkg),
    components: [
      { id: 'a', rung: 1, mode: 'start', extractor: { id: 'probe', version: 1 }, unit: 'share', direction: 'up', target: 1, bad: 0, tolerance: 0 },
      { id: 'b', rung: 1, mode: 'start', extractor: { id: 'probe', version: 1 }, unit: 'share', direction: 'up', target: 1, bad: 0, tolerance: 0 },
      { id: 'cells-L1', rung: 6, lab: 'cells', level: 'L1', extractor: { id: 'model_accepted', version: 1 }, unit: 'solved', direction: 'up', target: 1, bad: 0, tolerance: 0 }
    ],
    cases: [...probes, ...investigations], investigation_repetitions: 1, execution: {}, sampling: { seed: 1 }, promotion: { procedure: 'paired-cases@1', alpha: 0.05, permutations: 1000, seed: 1 },
    limits: { junior_args: ['--max-tokens', '100000', '--max-judge-calls', '100000'], probe_max_tokens: 500, timeout_ms: 60000 },
    weight_edits: BOUNDS,
    weight_search: { max_candidates: 6, min_control_seeds: 1, operators: { perturb: 1, reinit: 1, scale: 1 }, tolerance: { a: 0.01, b: 0.01 }, layer_groups: [[2, 4], [5, 9]], perturb: 0.2, investigate_elites: false }
  };
  assert.deepEqual(competenceProblems(manifest), []);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'reference.json'), JSON.stringify(pkg));
  const comparison: WeightComparison = { format: 'weight-comparison@1', id: 'cmp', competence: path.join(dir, 'manifest.json'), reference: path.join(dir, 'reference.json'), blobs: path.join(dir, 'blobs'),
    server: 'http://127.0.0.1:1', work: path.join(dir, 'cmp'), repetitions: 1, seed: 5,
    budget: { evaluations: 20, edits: 20, lab_queries: 10, lab_tokens: 10_000, searches: 2, distillations: 4, gpu_hours: 1 }, researcher: ['--researcher', 'assisted'],
    training: { python: 'python3', backend: 'fake' } };
  return { dir, store, pkg, manifest, comparison };
}

/** An evaluation whose every needed observation has the value its component is given. */
function evaluation(m: CompetenceManifest, pkg: JuniorPackage, values: Record<string, number>): Evaluation {
  const observations: Observation[] = [];
  for (const [comp, cases] of needs(m, 'development', 0)) for (const [caseId, reps] of cases) for (let rep = 0; rep < reps; rep++)
    observations.push({ component: comp, case: caseId, rep, value: values[comp] ?? 0, state: 'measured' });
  return { format: 'junior-evaluation@1', manifest: competenceHash(m), execution: executionHash(pkg), partition: 'development', temperature: 0, observations, measure: null as never };
}

test('the plan: every condition from one budget, differing only in what its run may do; C after B, E after D', () => {
  const f = fixture();
  assert.match(comparisonProblems({ ...f.comparison, conditions: ['A', 'C'] }).join(), /C is made from B/);
  assert.match(comparisonProblems({ ...f.comparison, conditions: ['E'] }).join(), /E is made from D/);
  assert.match(comparisonProblems({ ...f.comparison, training: undefined }).join(), /F trains/);
  const plan = planComparison(f.comparison);
  assert.deepEqual(plan.map((r) => r.condition), [...CONDITIONS]);
  const arg = (c: string, k: string) => { const a = plan.find((r) => r.condition === c)!.args!; return a[a.indexOf(k) + 1]; };
  for (const c of ['A', 'B', 'D', 'F']) assert.equal(arg(c, '--evaluations'), '20', 'the same evaluations for ' + c);
  assert.deepEqual(['A', 'B', 'D', 'F'].map((c) => arg(c, '--edits')), ['0', '20', '20', '0']);
  assert.deepEqual(['A', 'B', 'D', 'F'].map((c) => arg(c, '--searches')), ['0', '0', '2', '0']);
  assert.deepEqual(['A', 'B', 'D', 'F'].map((c) => arg(c, '--gpu-hours')), ['0', '0', '0', '1']);
  assert.ok(plan.find((r) => r.condition === 'B')!.args!.includes('--researcher'), 'the researcher\'s arguments the same for every run');
  assert.deepEqual(plan.find((r) => r.condition === 'C')!.after, { condition: 'B', rep: 0 });
  assert.deepEqual(plan.find((r) => r.condition === 'E')!.after, { condition: 'D', rep: 0 });
  // B is never told it may open a search; D is.
  const told = (searches: string) => JSON.stringify(juniorLab.interface!({ world: { tolerance: '0.25', edits: '20', searches } } as never));
  assert.ok(!told('0').includes('"evolve"') && told('0').includes('inspect_weights'));
  assert.ok(told('2').includes('evolve'));
});

test('C: B\'s twins from B\'s exact start, of B\'s COMPOSED size - edits that cancel matched as they compose; its product by the rule', async () => {
  const f = fixture();
  const world = (dir: string) => new JuniorWorld({ manifest: f.manifest, base: f.pkg, blobs: f.comparison.blobs, server: 'http://127.0.0.1:1', dir, evaluations: 20, edits: 20, searches: 0 });
  // B, as a researcher would leave it: its prompt changed first, then three edits - two on DOWN that cancel, one on Q.
  const B = world(path.join(f.comparison.work, 'B-0', 'world'));
  const H = { competence: 'protocol', mechanism: 'm', effect: 'e' };
  const p = B.change(B.reference, { 'prompt.md': 'Answer in JSON only.' }, { why: 'w', expect: 'e' });
  assert.ok(!('error' in p));
  const e1 = await B.editFrom(p.version, { written: { modules: [{ module: DOWN, encoding: 'sparse', indices: [0], values: [1] }] } }, H, undefined, { why: 'w' });
  const e2 = await B.editFrom(e1.version!, { written: { modules: [{ module: DOWN, encoding: 'sparse', indices: [0], values: [-1] }] } }, { ...H, effect: 'undo' }, undefined, { why: 'w' });
  const e3 = await B.editFrom(e2.version!, { written: { modules: [{ module: Q, encoding: 'lowrank', B: [[0.5], [-0.5]], A: [[1, 1, 1]] }] } }, H, undefined, { why: 'w' });
  assert.ok(e1.version && e2.version && e3.version, JSON.stringify([e1, e2, e3]));
  const bPkg = await B.packageOf(e3.version!);
  assert.ok(typeof bPkg !== 'string');
  const bSet = readEditSet(f.store, bPkg.adapter!)!;
  assert.equal(bSet.summaries[DOWN].relative_norm, 0, 'B\'s two edits on DOWN cancel');
  const evaluate = async (_w: JuniorWorld, pkg: JuniorPackage) => evaluation(f.manifest, pkg, executionHash(pkg) === executionHash(f.pkg) ? {} : { a: 1 });
  const r = await runControlEdits(f.comparison, 0, { world, evaluate });
  assert.equal(r.state, 'ended', JSON.stringify(r.skipped));
  assert.notEqual(r.product, executionHash(f.pkg), 'a twin was promoted by the rule');
  const product = normalizePackage(JSON.parse(fs.readFileSync((r as unknown as { package: string }).package, 'utf8')));
  assert.ok(product.adapter, 'its package kept where the operator exports it from');
  assert.equal(product.prompt, 'Answer in JSON only.', 'from B\'s exact start: its prompt kept');
  const set = readEditSet(f.store, product.adapter!)!;
  assert.equal(set.genome.length, 3, 'the twin of B\'s last version: three controls');
  for (const id of set.genome) assert.equal(readEdit(f.store, id).authorship, 'control');
  // The same COMPOSED size, module by module, as B's: zero where B's edits cancel.
  for (const m of [DOWN, Q]) assert.ok(Math.abs(set.summaries[m].relative_norm - bSet.summaries[m].relative_norm) < 1e-3, m + ': ' + set.summaries[m].relative_norm + ' vs ' + bSet.summaries[m].relative_norm);
  assert.equal(set.summaries[DOWN].changed, 0);
  assert.ok((r.cost.edits ?? 0) >= 2);
  // Asked again, read from its result: nothing made or measured again.
  assert.deepEqual(await runControlEdits(f.comparison, 0, { world, evaluate: async () => { throw new Error('never again'); } }), r);
});

test('review 2: each twin is made from the package B edited - prompt and decoding changed between edits kept - only its weights replaced', async () => {
  const f = fixture();
  const world = (dir: string) => new JuniorWorld({ manifest: f.manifest, base: f.pkg, blobs: f.comparison.blobs, server: 'http://127.0.0.1:1', dir, evaluations: 20, edits: 20, searches: 0 });
  const B = world(path.join(f.comparison.work, 'B-0', 'world'));
  const H = { competence: 'protocol', mechanism: 'm', effect: 'e' };
  // edit -> change prompt and decoding -> edit again.
  const e1 = await B.editFrom(B.reference, { written: { modules: [{ module: DOWN, encoding: 'sparse', indices: [0], values: [-1] }] } }, H, undefined, { why: 'w' });
  const decoding = JSON.stringify({ temperature: 0, max_tokens: 1234, max_circuit_tokens: 60000, forced_format: null });
  const c = B.change(e1.version!, { 'prompt.md': 'A prompt changed between edits.', 'decoding.json': decoding }, { why: 'w', expect: 'e' });
  assert.ok(!('error' in c));
  const e2 = await B.editFrom(c.version, { written: { modules: [{ module: Q, encoding: 'lowrank', B: [[0.5], [-0.5]], A: [[1, 1, 1]] }] } }, H, undefined, { why: 'w' });
  assert.ok(e1.version && e2.version);
  const r = await runControlEdits(f.comparison, 0, { world, evaluate: async (_w, pkg) => evaluation(f.manifest, pkg, {}) }) as unknown as { twins: { twin_of: string; package: string }[] };
  assert.equal(r.twins.length, 2);
  for (const t of r.twins) {
    const twin = normalizePackage(JSON.parse(fs.readFileSync(t.package, 'utf8')));
    const of = await B.packageOf(t.twin_of);
    assert.ok(typeof of !== 'string');
    assert.deepEqual([twin.prompt, twin.decoding, twin.memory, twin.base], [of.prompt, of.decoding, of.memory, of.base], 'everything but its weights is the version it twins');
    const ts = readEditSet(f.store, twin.adapter!)!, bs = readEditSet(f.store, of.adapter!)!;
    for (const m of Object.keys(bs.summaries)) assert.ok(Math.abs(ts.summaries[m].relative_norm - bs.summaries[m].relative_norm) < 1e-3, m);
  }
  const second = normalizePackage(JSON.parse(fs.readFileSync(r.twins.find((t) => t.twin_of === e2.version)!.package, 'utf8')));
  assert.equal(second.prompt, 'A prompt changed between edits.');
  assert.equal(second.decoding.max_tokens, 1234);
});

test('E: D\'s first search again, its seeds only the size of its controls - none of them evaluated', { skip: !python && 'no Python' }, async () => {
  const f = fixture();
  const server = new SessionServer({ root: path.join(f.dir, 'srv'), store: f.store, worker: new ProcessWorker({ python: [python!], backend: 'fake', work: path.join(f.dir, 'work') }) });
  const h = await serveJunior(server);
  const probes = async (p: JuniorPackage) => {
    const read = (m: string) => (p.adapter ? (compose(editsInTree(f.store, p.adapter), baseReader(f.store, p.base)).weights[m] ?? baseReader(f.store, p.base)(m + '.weight').bits) : baseReader(f.store, p.base)(m + '.weight').bits);
    const d0 = bf16Value(read(DOWN)[0]), q = Array.from(read(Q)).slice(0, 3).map(bf16Value);
    return { complete: true, components: [{ id: 'a', quality: Math.min(1, Math.abs(d0 - 1) / 3) }, { id: 'b', quality: Math.min(1, Math.abs(q[0] + q[1] + q[2] - 5) / 5) }] };
  };
  const world = (dir: string) => new JuniorWorld({ manifest: f.manifest, base: f.pkg, blobs: f.comparison.blobs, server: h.url, dir, evaluations: 30, edits: 30, searches: 2, probes });
  try {
    // D, as a researcher would leave it: one search, its record in its world.
    const D = world(path.join(f.comparison.work, 'D-0', 'world'));
    const spec: JuniorSpec = { world: D };
    const evolve = { evolve: { from: D.reference, why: 'w', expect: 'e', control_seeds: 1, max_candidates: 3, seed: 3,
      seeds: [{ written: { modules: [{ module: DOWN, encoding: 'sparse', indices: [0], values: [-1.5] }] }, competence: 'protocol', why: 'w', expect: 'e' }] } };
    // D's search starts from a version whose prompt it changed: E must start there too.
    const changed = D.change(D.reference, { 'prompt.md': 'Answer in JSON only.' }, { why: 'w', expect: 'e' });
    assert.ok(!('error' in changed));
    const done = await juniorLab.act!.start(spec, { evolve: { ...evolve.evolve, from: changed.version } } as never, 'e', {} as never);
    assert.ok(done && done.kind === 'records' && done.summary.state === 'finished', JSON.stringify(done));
    const r = await runControlSearch(f.comparison, 0, { world, evaluate: async (_w, p) => evaluation(f.manifest, p, {}) });
    const events = fs.readFileSync(path.join(f.comparison.work, 'E-0', 'search.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const dStarted = fs.readdirSync(path.join(f.comparison.work, 'D-0', 'world', 'searches')).map((x) => fs.readFileSync(path.join(f.comparison.work, 'D-0', 'world', 'searches', x), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.type === 'search_started'))[0];
    const eStarted = events.find((e) => e.type === 'search_started');
    assert.ok(eStarted.controls_only);
    assert.equal(eStarted.start_execution, dStarted.start_execution, 'from D\'s exact start');
    assert.equal(eStarted.start_package.prompt, 'Answer in JSON only.');
    const kinds = events.filter((e) => e.type === 'candidate').map((e) => e.origin.kind);
    assert.ok(!kinds.includes('strong') && kinds.includes('control'), kinds.join());
    assert.equal(r.condition, 'E');
    /* Its candidates came out of a search and its manifest has no holdout: none is called promoted (SPEC-VALIDEZ-MEDIDA §4.3). */
    assert.equal((r as { rule?: string }).rule, 'best of N in selection');
    assert.ok(((r as { checked?: { verdict: string }[] }).checked ?? []).every((c) => c.verdict !== 'promoted'), JSON.stringify((r as { checked?: unknown }).checked));
  } finally { server.stop(); await h.close(); }
});

test('the report from what the runs left: H1 pair by pair, H2 as transfer from probes to worlds, cost, diversity', async () => {
  const f = fixture();
  const m = { ...f.comparison };
  const reference = 'vref';
  const write = (file: string, v: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v)); };
  const mh = competenceHash(f.manifest);
  const refEval = evaluation(f.manifest, f.pkg, {});
  /* A researcher's run: its journal (the version accepted), the version's package, its evaluation, its ledger. */
  const run = (c: string, values: Record<string, number> | null, spent: Record<string, number>) => {
    const w = path.join(m.work, c + '-0');
    const version = values ? 'v' + c : reference;
    const pkg = normalizePackage({ ...f.pkg, prompt: values ? 'prompt of ' + c : f.pkg.prompt });
    write(path.join(w, 'journal.json'), { events: [...(values ? [{ type: 'artifact_accepted', version }] : []), { type: 'end', stoppedBy: 'budget' }] });
    write(path.join(w, 'world', 'packages', version + '.json'), pkg);
    write(path.join(w, 'world', 'evaluations', mh.slice(0, 16) + '-' + executionHash(pkg).slice(0, 16) + '-development.json'), evaluation(f.manifest, pkg, values ?? {}));
    write(path.join(w, 'world', 'jobs.jsonl'), JSON.stringify({ kind: 'finished', spent }) + '\n');
  };
  run('A', null, { evaluations: 3 });
  run('B', { a: 1, 'cells-L1': 1 }, { evaluations: 5, edits: 4 });
  run('D', { a: 1 }, { evaluations: 6, edits: 9, searches: 1 });
  run('F', { b: 1 }, { evaluations: 4, gpu_hours: 1 });
  write(path.join(m.work, 'C-0', 'result.json'), { condition: 'C', state: 'ended', product: reference, evaluation: refEval, cost: { edits: 4, evaluations: 5 } });
  write(path.join(m.work, 'E-0', 'result.json'), { condition: 'E', state: 'ended', product: reference, evaluation: refEval, cost: { edits: 9, evaluations: 6 }, rule: 'best of N in selection' });
  const config: WeightSearchConfig = { format: 'weight-search@1', seed: 1, control_seeds: 1, max_candidates: 2, operators: { perturb: 1 }, tolerance: { a: 0.01, b: 0.01 }, layer_groups: [[2, 4], [5, 9]], perturb: 0.2, investigate_elites: false };
  const searchEvents = [
    { type: 'search_started', config, components: ['a', 'b'] },
    { type: 'candidate', id: 's', genome: [], origin: { kind: 'start' }, seq: 0 }, { type: 'evaluated', id: 's', state: 'measured', deficits: { a: 0.5, b: 0.5 }, location: 'none' },
    { type: 'candidate', id: 'x', genome: ['e1'], origin: { kind: 'strong' }, seq: 1 }, { type: 'evaluated', id: 'x', state: 'measured', deficits: { a: 0.2, b: 0.5 }, location: 'g0:down_proj', totals: { relative_norm: 0.1, changed: 1 } },
    { type: 'candidate', id: 'y', genome: ['e2'], origin: { kind: 'operator', operator: 'perturb', parents: ['x'] }, seq: 2 }, { type: 'evaluated', id: 'y', state: 'measured', deficits: { a: 0.5, b: 0.2 }, location: 'g0:down_proj', totals: { relative_norm: 0.1, changed: 1 } }
  ];
  const r = comparisonReport(m, { manifest: f.manifest, manifestHash: mh, reference, referenceEvaluation: refEval, searches: (c) => (c === 'D' ? [searchEvents] : []) });
  assert.equal(r.h1.B_vs_C!.improved, 1, JSON.stringify(r.h1.B_vs_C));
  assert.equal(r.h1.D_vs_E!.improved, 1);
  assert.deepEqual([r.h2.A.probes_improved, r.h2.A.worlds_improved], [0, 0]);
  assert.deepEqual([r.h2.B.probes_improved, r.h2.B.worlds_improved, r.h2.B.transferred], [1, 1, 1], 'B\'s probe gain reached the worlds');
  assert.deepEqual([r.h2.D.probes_improved, r.h2.D.worlds_improved, r.h2.D.transferred], [1, 0, 0], 'D\'s did not');
  assert.deepEqual(r.cost.D, { evaluations: 6, edits: 9, searches: 1 });
  assert.deepEqual(r.diversity.D, { searches: 1, niches: 3, from_new_material: 1 });
  assert.match(reportText(r), /B against C: 1 better/);
  /* VM2 (SPEC-VALIDEZ-MEDIDA §4.3): E's product, chosen without a holdout, is told as the best of N in selection. */
  assert.deepEqual(r.rules, { C: ['development'], E: ['best of N in selection'] });
  assert.match(reportText(r), /E: best of N in selection \(.*not promoted\)/);
});
