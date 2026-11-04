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
import { competenceProblems, type CompetenceManifest } from '../src/junior/competence.ts';
import {
  baseReader, bf16Bits, bf16Value, compose, composeVersion, editsInTree, putEdit, readEdit, readSafetensors, tensorF32, tensorI64, writeSafetensors, type RawTensor, type WeightBounds
} from '../src/junior/weights.ts';
import { archiveOf, better, EDIT_OPERATORS, nicheOf, OutOfBudget, runWeightSearch, searchConfigProblems, type Candidate, type SearchEvaluator, type WeightSearchConfig } from '../src/junior/weight-search.ts';
import { juniorLab, JuniorWorld, type JuniorSpec } from '../src/worlds/junior/lab.ts';

/* SPEC-EDICION-PESOS §6, WE4: the search of juniors - genomes on a fixed start, the strong model's distinct seeds with
   random controls of the same size, code operators that bring new material, a cascade (invalid, unmeasured, measured), an
   archive by niches with its quality rule, rebuilt without a model and resumed without charging twice. */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'junior-wsearch-'));
const python = ['python', 'python3'].find((p) => spawnSync(p, ['--version']).status === 0);
const bf16 = (shape: number[], values: number[]): RawTensor => ({ dtype: 'BF16', shape, bytes: new Uint8Array(Uint16Array.from(values.map(bf16Bits)).buffer) });
const DOWN = 'model.layers.4.mlp.down_proj', DOWN5 = 'model.layers.5.mlp.down_proj', Q = 'model.layers.5.self_attn.q_proj';
const H = { competence: 'protocol', mechanism: 'a direction that derails the answer', effect: 'more answers in the protocol' };
const BOUNDS: WeightBounds = { per_module: { max_changed_fraction: 1, max_relative_norm: 3, max_representation: 1000, max_rank: 8, max_sparse_entries: 100 },
  total: { max_changed_fraction: 1, max_relative_norm: 3, max_representation: 1000 } };
const CONFIG: WeightSearchConfig = { format: 'weight-search@1', seed: 7, control_seeds: 2, max_candidates: 14, operators: { scale: 1, drop: 1, combine: 1, retarget: 1, sparsify: 1, perturb: 2, reinit: 2 },
  tolerance: { a: 0.01, b: 0.01 }, layer_groups: [[2, 4], [5, 9]], perturb: 0.2, investigate_elites: false };

function fixture() {
  const dir = tmp();
  const store = new BlobStore(path.join(dir, 'blobs'));
  const base = path.join(dir, 'base');
  fs.mkdirSync(base);
  fs.writeFileSync(path.join(base, 'chipformer.json'), JSON.stringify({ chip_layers: 2 }));
  fs.writeFileSync(path.join(base, 'tokenizer.json'), '{}');
  fs.writeFileSync(path.join(base, 'model.safetensors'), writeSafetensors({
    [DOWN + '.weight']: bf16([2, 2], [3, 0, 0, 1]), [DOWN5 + '.weight']: bf16([2, 2], [2, 0, 0, 2]), [Q + '.weight']: bf16([2, 3], [1, 2, 3, 4, 5, 6]),
    ['model.layers.1.mlp.down_proj.weight']: bf16([2, 2], [1, 1, 1, 1])
  }));
  const pkg = normalizePackage({ format: 'junior-package@1', name: 'start', base: store.putTree(base), prompt: '',
    execution: { firmware: store.put('f'), tokenizer: store.put('{}'), chat_template: store.put('c'), driver: store.put('d'), verifier: store.put('v'), circuit: { chip_layers: 2 }, precision: 'bf16' } });
  const put = (modules: { module: string; encoding: 'lowrank' | 'sparse'; shape: [number, number]; tensors: Record<string, RawTensor> }[], competence = 'protocol') => {
    const r = putEdit(store, { modules, hypothesis: { ...H, competence }, origin: { kind: 'written' }, authorship: 'strong' }, 2);
    assert.ok('id' in r, JSON.stringify(r));
    return r.id;
  };
  const sparseDown = put([{ module: DOWN, encoding: 'sparse', shape: [2, 2], tensors: { indices: tensorI64([0, 3]), values: tensorF32([2], [-1, 0.5]) } }]);
  const lowQ = put([{ module: Q, encoding: 'lowrank', shape: [2, 3], tensors: { B: tensorF32([2, 1], [0.5, -0.5]), A: tensorF32([1, 3], [1, 1, 1]) } }], 'requests');
  return { dir, store, pkg, seeds: [sparseDown, lowQ] };
}

/** A stand-in of the world: its probes read the composed weights - component a how far DOWN[0] is from 1, b how far Q's
    first row sums from 5 - so better candidates exist and are found; it counts what it charges. */
function standIn(f: ReturnType<typeof fixture>, o: { probesBudget?: number; missing?: (pkg: JuniorPackage) => boolean } = {}) {
  const calls = { compose: 0, probes: 0, probed: new Set<string>() };
  const weightsOf = (pkg: JuniorPackage, m: string, n: number) => {
    if (!pkg.adapter) return Array.from(baseReader(f.store, pkg.base)(m + '.weight').bits, bf16Value).slice(0, n);
    const c = compose(editsInTree(f.store, pkg.adapter), baseReader(f.store, pkg.base));
    return c.weights[m] ? Array.from(c.weights[m], bf16Value).slice(0, n) : Array.from(baseReader(f.store, pkg.base)(m + '.weight').bits, bf16Value).slice(0, n);
  };
  const ev: SearchEvaluator = {
    async compose(genome) {
      calls.compose++;
      const v = composeVersion({ store: f.store, parent: f.pkg, add: genome, authorized: BOUNDS });
      return 'problems' in v ? { invalid: v.problems.join('; ') } : { pkg: v.child, summaries: v.set.summaries, totals: v.set.totals };
    },
    async valid() { return true; },
    async probes(pkg) {
      if (o.probesBudget !== undefined && calls.probes >= o.probesBudget) throw new OutOfBudget('evaluations', 'the bag is empty');
      calls.probes++;
      calls.probed.add(executionHash(pkg));
      const d0 = weightsOf(pkg, DOWN, 1)[0], q = weightsOf(pkg, Q, 3);
      const a = Math.min(1, Math.abs(d0 - 1) / 3), b = Math.min(1, Math.abs(q[0] + q[1] + q[2] - 5) / 5);
      return { complete: !o.missing?.(pkg), components: [{ id: 'a', quality: a }, { id: 'b', quality: o.missing?.(pkg) ? null : b }] };
    }
  };
  return { ev, calls };
}

test('a search without control seeds is refused when it is configured; its seeds must be distinct hypotheses', async () => {
  const f = fixture();
  assert.match(searchConfigProblems({ ...CONFIG, control_seeds: 0 }, ['a', 'b']).join(), /E6/);
  assert.match(searchConfigProblems({ ...CONFIG, tolerance: { a: 0.01 } }, ['a', 'b']).join(), /tolerance/);
  const { ev } = standIn(f);
  await assert.rejects(runWeightSearch({ config: { ...CONFIG, control_seeds: 0 }, start: f.pkg, seeds: f.seeds, store: f.store, components: ['a', 'b'], evaluator: ev, out: path.join(f.dir, 's.jsonl') }), /E6/);
  const twin = putEdit(f.store, { modules: [{ module: DOWN, encoding: 'sparse', shape: [2, 2], tensors: { indices: tensorI64([1]), values: tensorF32([1], [1]) } }], hypothesis: H, origin: { kind: 'written' }, authorship: 'strong' }, 2);
  assert.ok('id' in twin);
  await assert.rejects(runWeightSearch({ config: CONFIG, start: f.pkg, seeds: [f.seeds[0], twin.id], store: f.store, components: ['a', 'b'], evaluator: ev, out: path.join(f.dir, 't.jsonl') }), /same hypothesis/);
});

test('perturb and reinit bring material no parent had, deterministic given their seed; retarget moves an edit to the next layer of its kind', () => {
  const f = fixture();
  const parent = f.seeds[1];
  const p1 = EDIT_OPERATORS.perturb(f.store, 2, parent, 11, 0.2), p2 = EDIT_OPERATORS.perturb(f.store, 2, parent, 11, 0.2), p3 = EDIT_OPERATORS.perturb(f.store, 2, parent, 12, 0.2);
  assert.ok(p1 && p1 === p2 && p1 !== p3 && p1 !== parent);
  const r1 = EDIT_OPERATORS.reinit(f.store, 2, parent, 5);
  assert.ok(r1 && r1 === EDIT_OPERATORS.reinit(f.store, 2, parent, 5));
  const tB = (id: string) => Array.from(new Float32Array(readSafetensors(f.store.get(readEdit(f.store, id).modules[0].sha256)).B.bytes.slice().buffer));
  assert.notDeepEqual(tB(p1!), tB(parent));
  assert.notDeepEqual(tB(r1!), tB(parent));
  const norm = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  assert.ok(Math.abs(norm(tB(r1!)) - norm(tB(parent))) < 1e-5, 'reinit keeps the factor\'s norm');
  const o = readEdit(f.store, p1!).origin;
  assert.deepEqual(o.kind === 'operator' ? [o.operator, o.parents, o.seed] : null, ['perturb', [parent], 11]);
  assert.equal(readEdit(f.store, p1!).authorship, 'search');
  const moved = [1, 2, 3, 4, 5].map((s) => EDIT_OPERATORS.retarget(f.store, 2, f.seeds[0], s, baseReader(f.store, f.pkg.base))).find(Boolean);
  assert.ok(moved && readEdit(f.store, moved).modules[0].module === DOWN5, 'layer 4 to 5 (3 is absent)');
});

test('the search: seeds, controls of the same size, operators; every measured candidate in a niche, invalid ones kept unevaluated, the archive rebuilt from the record', async () => {
  const f = fixture();
  const { ev, calls } = standIn(f);
  const out = path.join(f.dir, 'search.jsonl');
  const r = await runWeightSearch({ config: CONFIG, start: f.pkg, seeds: f.seeds, store: f.store, components: ['a', 'b'], evaluator: ev, out });
  assert.equal(r.stoppedBy, 'max_candidates');
  const kinds = r.candidates.map((c) => c.origin.kind);
  assert.equal(kinds.filter((k) => k === 'start').length, 1);
  assert.equal(kinds.filter((k) => k === 'strong').length, 2);
  assert.equal(kinds.filter((k) => k === 'control').length, 2);
  assert.ok(kinds.filter((k) => k === 'operator').length >= 5, kinds.join());
  // Controls: authored as such, the composed relative norm of their strong seed, module by module.
  const events = fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const totals = (id: string) => events.find((e) => e.type === 'evaluated' && e.id === id)?.totals;
  for (const c of r.candidates.filter((x) => x.origin.kind === 'control')) {
    assert.equal(readEdit(f.store, c.genome[0]).authorship, 'control');
    const strong = r.candidates.find((x) => x.origin.kind === 'strong' && x.genome[0] === c.origin.parents![0])!;
    assert.ok(Math.abs(totals(c.id).relative_norm - totals(strong.id).relative_norm) < 1e-3, 'the same size as ' + strong.id);
  }
  // Every measured candidate has a niche; the start's is "=="; the elites are the best of their niche by the rule.
  const start = r.candidates.find((c) => c.origin.kind === 'start')!;
  assert.equal(start.niche, '==@none');
  for (const c of r.candidates) assert.equal(Boolean(c.niche), c.state === 'measured', c.id + ' ' + c.state);
  for (const e of r.elites) for (const c of r.candidates) if (c.niche === e.niche) assert.ok(better(e, c, ['a', 'b']) <= 0);
  assert.ok(new Set(r.elites.map((e) => e.niche)).size === r.elites.length && r.elites.length >= 2, 'niches kept apart: ' + r.elites.map((e) => e.niche).join(' '));
  // Invalid candidates (out of the bounds) are kept with their reason and never measured.
  const invalid = r.candidates.filter((c) => c.state === 'invalid');
  for (const c of invalid) assert.ok(c.reason);
  assert.equal(calls.probes, r.candidates.filter((c) => c.state === 'measured' || c.state === 'unmeasured').length, 'the probes ran for every valid candidate and for no invalid one');
  // The archive from the record alone.
  const again = archiveOf(events, CONFIG, ['a', 'b']);
  assert.deepEqual([...again.elites.values()].map((c) => c.id).sort(), r.elites.map((c) => c.id).sort());
});

test('a missing datum never counts as zero: an incomplete measure leaves the candidate unmeasured, without a niche', async () => {
  const f = fixture();
  const { ev } = standIn(f, { missing: (pkg) => pkg.adapter !== null && readEditSetGenome(f.store, pkg).includes(f.seeds[1]) });
  const r = await runWeightSearch({ config: { ...CONFIG, max_candidates: 0 }, start: f.pkg, seeds: f.seeds, store: f.store, components: ['a', 'b'], evaluator: ev, out: path.join(f.dir, 'm.jsonl') });
  const q = r.candidates.find((c) => c.origin.kind === 'strong' && c.genome[0] === f.seeds[1])!;
  assert.equal(q.state, 'unmeasured');
  assert.equal(q.niche, undefined);
  assert.equal(nicheOf({ deficits: { a: 0.1, b: null }, location: 'g0:down_proj' }, { a: 0.5, b: 0.5 }, ['a', 'b'], { a: 0, b: 0 }), null);
  const c = (id: string, d: number[], norm: number, changed: number, seq: number): Candidate => ({ id, genome: ['x'], origin: { kind: 'operator' }, seq, deficits: { a: d[0], b: d[1] }, totals: { relative_norm: norm, changed } as never });
  assert.ok(better(c('x', [0.2, 0.5], 1, 1, 0), c('y', [0.4, 0.4], 0, 0, 1), ['a', 'b']) > 0, 'the worst component first');
  assert.ok(better(c('x', [0.2, 0.5], 0.5, 9, 3), c('y', [0.5, 0.2], 1, 1, 1), ['a', 'b']) < 0, 'then the smaller norm');
  assert.ok(better(c('x', [0.2, 0.5], 1, 1, 3), c('y', [0.5, 0.2], 1, 1, 1), ['a', 'b']) > 0, 'then the one made earlier');
});

function readEditSetGenome(store: BlobStore, pkg: JuniorPackage): string[] {
  const t = store.tree(pkg.adapter!)!;
  return JSON.parse(store.get(t.files['set.json']).toString('utf8')).genome;
}

test('a bag that runs out stops the search with its archive kept; resumed, what it measured is never measured again', async () => {
  const f = fixture();
  const out = path.join(f.dir, 'budget.jsonl');
  const first = standIn(f, { probesBudget: 4 });
  const r1 = await runWeightSearch({ config: CONFIG, start: f.pkg, seeds: f.seeds, store: f.store, components: ['a', 'b'], evaluator: first.ev, out });
  assert.equal(r1.stoppedBy, 'budget: evaluations');
  assert.ok(r1.elites.length >= 1, 'its archive kept');
  const measured = r1.candidates.filter((c) => c.state).map((c) => c.id);
  const second = standIn(f);
  const r2 = await runWeightSearch({ config: CONFIG, start: f.pkg, seeds: f.seeds, store: f.store, components: ['a', 'b'], evaluator: second.ev, out });
  assert.equal(r2.stoppedBy, 'max_candidates');
  assert.equal(second.calls.probes, r2.candidates.filter((c) => c.state && c.state !== 'invalid').length - measured.filter((id) => r1.candidates.find((c) => c.id === id)!.state !== 'invalid').length,
    'only what was not measured before is measured now');
  for (const id of measured) assert.ok(r2.candidates.some((c) => c.id === id));
});

/* --- In the junior's world ----------------------------------------------------------------------------------------- */

test('evolve in the junior\'s world: within what the manifest authorizes, each candidate paid from edits and evaluations, its elites made versions; rebuilt without searching again', { skip: !python && 'no Python' }, async () => {
  const f = fixture();
  const probes = Array.from({ length: 6 }, (_, i) => ({ id: 'p' + i, kind: 'probe' as const, partition: 'development' as const, group: 'g-sel', component: i < 3 ? 'a' : 'b', lab: 'cells', mode: 'start' as const,
    cut: { run: path.join(f.dir, 'runs', 'sel.json'), question: 0, hash: 'h' + i }, competence: 'protocol', instruction: 'Answer (' + i + ').', checker: { id: 'protocol', version: 1 } }));
  const manifest: CompetenceManifest = {
    format: 'junior-competence-manifest@1', id: 'wsearch', reference: executionHash(f.pkg),
    components: [
      { id: 'a', rung: 1, mode: 'start', extractor: { id: 'probe', version: 1 }, unit: 'share', direction: 'up', target: 1, bad: 0, tolerance: 0 },
      { id: 'b', rung: 1, mode: 'start', extractor: { id: 'probe', version: 1 }, unit: 'share', direction: 'up', target: 1, bad: 0, tolerance: 0 },
      { id: 'cells-L1', rung: 6, lab: 'cells', level: 'L1', extractor: { id: 'model_accepted', version: 1 }, unit: 'solved', direction: 'up', target: 1, bad: 0, tolerance: 0 }
    ],
    cases: [...probes, { id: 'i1', kind: 'investigation', lab: 'cells', args: ['--seed', '2'], partition: 'development', group: 'g-i1', components: ['cells-L1'] }],
    investigation_repetitions: 1, execution: {}, sampling: { seed: 1 }, promotion: { procedure: 'paired-cases@1', alpha: 0.05, permutations: 1000, seed: 1 },
    limits: { junior_args: ['--max-tokens', '100000', '--max-judge-calls', '100000'], probe_max_tokens: 500, timeout_ms: 60000 },
    weight_edits: BOUNDS,
    weight_search: { max_candidates: 8, min_control_seeds: 1, operators: { perturb: 1, reinit: 1, scale: 1, drop: 1 }, tolerance: { a: 0.01, b: 0.01 }, layer_groups: [[2, 4], [5, 9]], perturb: 0.2, investigate_elites: false }
  };
  assert.deepEqual(competenceProblems(manifest), []);
  assert.ok(competenceProblems({ ...manifest, weight_search: { ...manifest.weight_search!, min_control_seeds: 0 } }).some((p) => /E6/.test(p)));
  const server = new SessionServer({ root: path.join(f.dir, 'srv'), store: f.store, worker: new ProcessWorker({ python: [python!], backend: 'fake', work: path.join(f.dir, 'work') }) });
  const h = await serveJunior(server);
  const { ev } = standIn(f);
  const make = () => new JuniorWorld({ manifest, base: f.pkg, blobs: path.join(f.dir, 'blobs'), server: h.url, dir: path.join(f.dir, 'world'), evaluations: 30, edits: 30, probes: (pkg) => ev.probes(pkg) as never });
  try {
    const world = make();
    const spec: JuniorSpec = { world };
    const evolve = { evolve: { from: world.reference, why: 'two hypotheses and what chance does', expect: 'a niche that improves a without b', control_seeds: 1, max_candidates: 6, seed: 3,
      seeds: [{ written: { modules: [{ module: DOWN, encoding: 'sparse', indices: [0, 3], values: [-1, 0.5] }] }, competence: 'protocol', why: 'the first output too strong', expect: 'a improves' },
        { construct: { name: 'top_singular@1', args: { module: Q, k: 1, alpha: -0.3 } }, competence: 'requests', why: 'its first direction dominates', expect: 'b improves' }] } } as const;
    const r = await juniorLab.act!.start(spec, evolve as never, 'e', {} as never);
    assert.ok(r && r.kind === 'records' && r.what === 'evolution' && r.summary.state === 'finished', JSON.stringify(r));
    assert.ok((r.summary.elites as number) >= 1 && r.rows.every((row) => world.store.get(String(row.version))), 'its elites are versions of the world');
    const counts = r.summary.counts as Record<string, number>;
    assert.equal(world.jobs.bags().evaluations.spent, (counts.measured ?? 0) + (counts.unmeasured ?? 0));
    assert.ok(world.jobs.bags().edits.spent >= 3, 'each composed candidate paid from edits');
    const elite = await world.packageOf(String(r.rows[0].version));
    assert.ok(typeof elite !== 'string' && elite.adapter && elite.provenance.sources.some((s) => s.startsWith('edit-set:')));
    // Out of what the manifest authorizes.
    const tooMany = await juniorLab.act!.start(spec, { evolve: { ...evolve.evolve, max_candidates: 99 } } as never, 'e2', {} as never);
    assert.ok(tooMany && tooMany.kind === 'records' && /at most 8/.test(String(tooMany.summary.reason)));
    // Rebuilt: the same versions from the world's record, nothing searched or charged again.
    const again = { world: make() };
    juniorLab.rebuild!(again as never, [{ type: 'investigation', requests: [{ act: evolve }] }] as never);
    for (const row of r.rows) assert.ok(again.world.store.get(String(row.version)));
    assert.equal(again.world.jobs.bags().edits.spent, world.jobs.bags().edits.spent);
  } finally { server.stop(); await h.close(); }
});

/* --- A review of WE2-WE6 (04/11/2026) ----------------------------------------------------------------------------------- */

test('review: a cancelled search measures nothing more - neither its population nor its elites\' investigations', async () => {
  const f = fixture();
  const { ev, calls } = standIn(f);
  let investigated = 0;
  const stop = new AbortController();
  stop.abort();
  const r = await runWeightSearch({ config: { ...CONFIG, investigate_elites: true }, start: f.pkg, seeds: f.seeds, store: f.store, components: ['a', 'b'],
    evaluator: { ...ev, investigate: async () => { investigated++; return {}; } }, out: path.join(f.dir, 'cancelled.jsonl'), signal: stop.signal });
  assert.equal(r.stoppedBy, 'cancelled');
  assert.deepEqual([calls.probes, calls.compose, investigated], [0, 0, 0]);
});

test('review: a record of another search - another start - is never served to this one', async () => {
  const f = fixture();
  const out = path.join(f.dir, 'other.jsonl');
  await runWeightSearch({ config: { ...CONFIG, max_candidates: 2 }, start: f.pkg, seeds: f.seeds, store: f.store, components: ['a', 'b'], evaluator: standIn(f).ev, out });
  const otherPrompt = normalizePackage({ ...f.pkg, prompt: 'Another junior.' });
  await assert.rejects(runWeightSearch({ config: { ...CONFIG, max_candidates: 2 }, start: otherPrompt, seeds: f.seeds, store: f.store, components: ['a', 'b'], evaluator: standIn(f).ev, out }), /another search/);
  await assert.rejects(runWeightSearch({ config: { ...CONFIG, max_candidates: 2 }, start: f.pkg, seeds: f.seeds, store: f.store, components: ['a', 'b'], evaluator: { ...standIn(f).ev, identity: 'other probes' }, out }), /another search/);
});

test('review: a record cut by a stop resumes - its fragment recovered, what it holds never rewritten', async () => {
  const f = fixture();
  const out = path.join(f.dir, 'cut.jsonl');
  await runWeightSearch({ config: CONFIG, start: f.pkg, seeds: f.seeds, store: f.store, components: ['a', 'b'], evaluator: standIn(f, { probesBudget: 3 }).ev, out });
  const before = fs.readFileSync(out, 'utf8');
  fs.appendFileSync(out, '{"type":"evaluated","id":"x","sta');
  const second = standIn(f);
  const r = await runWeightSearch({ config: CONFIG, start: f.pkg, seeds: f.seeds, store: f.store, components: ['a', 'b'], evaluator: second.ev, out });
  assert.equal(r.stoppedBy, 'max_candidates');
  assert.ok(fs.readFileSync(out, 'utf8').startsWith(before), 'appended, never rewritten');
  const lines = fs.readFileSync(out, 'utf8').split('\n').filter(Boolean);
  assert.ok(lines.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }), 'every line whole');
  assert.equal(lines.filter((l) => JSON.parse(l).type === 'search_started').length, 1);
});
