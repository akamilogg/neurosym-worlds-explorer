import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BlobStore, executionHash, exportPackage, normalizePackage, type JuniorPackage } from '../src/junior/package.ts';
import { importPackage } from '../src/junior/confirm.ts';
import { SessionServer } from '../src/junior/sessions.ts';
import { ProcessWorker } from '../src/junior/worker.ts';
import { competenceProblems } from '../src/junior/competence.ts';
import { recipeProblems } from '../src/junior/train.ts';
import {
  adapterKind, baseReader, bf16Bits, bf16Value, compose, composeVersion, construct, editsInTree, putEdit, readEditSet, readSafetensors, tensorF32, tensorI64,
  verifyEditSet, writeSafetensors, type EditDraft, type RawTensor, type WeightBounds
} from '../src/junior/weights.ts';

/* SPEC-EDICION-PESOS §3, WE1: an edit as a hypothesis on Qwen's modules only; a version composed from its start by
   compose@1 (fp32, one rounding), its tree holding every file to compose and verify it; the size measured on the
   composed intervention against the condition's bounds; the worker composing the same bits and saying so. */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'junior-weights-'));
const python = ['python', 'python3'].find((p) => spawnSync(p, ['--version']).status === 0);
const HERE = path.dirname(fileURLToPath(import.meta.url));

const bf16 = (shape: number[], values: number[]): RawTensor => ({ dtype: 'BF16', shape, bytes: new Uint8Array(Uint16Array.from(values.map(bf16Bits)).buffer) });
const DOWN = 'model.layers.4.mlp.down_proj', Q = 'model.layers.5.self_attn.q_proj', CHIP = 'model.layers.1.mlp.down_proj';
const H = { competence: 'protocol', mechanism: 'a direction that keeps the answer going', effect: 'fewer answers cut by the limit' };
const LAX: WeightBounds = { per_module: { max_changed_fraction: 1, max_relative_norm: 10, max_representation: 1000, max_rank: 8, max_sparse_entries: 100 },
  total: { max_changed_fraction: 1, max_relative_norm: 10, max_representation: 1000 } };

function fixture(weights: Record<string, RawTensor> = {}) {
  const dir = tmp();
  const store = new BlobStore(path.join(dir, 'blobs'));
  const base = path.join(dir, 'base');
  fs.mkdirSync(base);
  fs.writeFileSync(path.join(base, 'chipformer.json'), JSON.stringify({ chip_layers: 2 }));
  fs.writeFileSync(path.join(base, 'tokenizer.json'), '{}');
  fs.writeFileSync(path.join(base, 'model.safetensors'), writeSafetensors({
    [DOWN + '.weight']: bf16([2, 2], [1, 0, 0, 1]),
    [Q + '.weight']: bf16([2, 3], [256, 1, -0, 2, 3, 4]),
    [CHIP + '.weight']: bf16([2, 2], [1, 1, 1, 1]),
    ...weights
  }));
  const pkg = normalizePackage({ format: 'junior-package@1', name: 'start', base: store.putTree(base), prompt: '',
    execution: { firmware: store.put('f'), tokenizer: store.put('{}'), chat_template: store.put('c'), driver: store.put('d'), verifier: store.put('v'), circuit: { chip_layers: 2 }, precision: 'bf16' } });
  return { dir, store, pkg };
}

const sparse = (module: string, shape: [number, number], idx: number[], vals: number[], over: Partial<EditDraft> = {}): EditDraft =>
  ({ modules: [{ module, encoding: 'sparse', shape, tensors: { indices: tensorI64(idx), values: tensorF32([vals.length], vals) } }], hypothesis: H, origin: { kind: 'written' }, authorship: 'strong', ...over });
const lowrank = (module: string, shape: [number, number], B: number[], A: number[], r = 1): EditDraft =>
  ({ modules: [{ module, encoding: 'lowrank', shape, tensors: { B: tensorF32([shape[0], r], B), A: tensorF32([r, shape[1]], A) } }], hypothesis: H, origin: { kind: 'written' }, authorship: 'strong' });

function put(store: BlobStore, d: EditDraft): string {
  const r = putEdit(store, d, 2);
  assert.ok('id' in r, JSON.stringify(r));
  return r.id;
}

function weightsOf(store: BlobStore, pkg: JuniorPackage, module: string): number[] {
  const c = compose(editsInTree(store, pkg.adapter!), baseReader(store, pkg.base));
  return Array.from(c.weights[module], bf16Value);
}

test('safetensors written by the harness: the same tensors give the same bytes, read back as written', () => {
  const t = { b: tensorF32([2], [1.5, -2]), a: tensorI64([3, 7]) };
  const one = writeSafetensors(t), two = writeSafetensors({ a: t.a, b: t.b });
  assert.deepEqual(one, two);
  assert.equal(one.readBigUInt64LE(0) % 8n, 0n, 'the header padded to 8 bytes');
  const back = readSafetensors(one);
  assert.deepEqual(Array.from(new Float32Array(back.b.bytes.slice().buffer)), [1.5, -2]);
  assert.deepEqual(back.a.shape, [2]);
});

test('compose@1 accumulates in fp32 and rounds once: 256 + 0.75 + 0.75 is 258, not 256; the same genome twice gives the same summaries', () => {
  const { store, pkg } = fixture();
  assert.equal(bf16Value(bf16Bits(256.75)), 256, 'one step at a time would lose each increment');
  const a = put(store, sparse(Q, [2, 3], [0], [0.75]));
  const b = put(store, sparse(Q, [2, 3], [0], [0.75], { hypothesis: { ...H, effect: 'the same again' } }));
  const v = composeVersion({ store, parent: pkg, add: [a, b], authorized: LAX });
  assert.ok('child' in v, JSON.stringify(v));
  assert.equal(weightsOf(store, v.child, Q)[0], 258);
  const again = composeVersion({ store, parent: pkg, add: [a, b], authorized: LAX });
  assert.ok('child' in again);
  assert.deepEqual(again.set.summaries, v.set.summaries);
  assert.equal(again.adapter, v.adapter, 'the same version is the same tree');
  assert.equal(v.set.start, executionHash(pkg), 'the start, by its execution hash');
  assert.equal(adapterKind(store, v.child), 'edits');
});

test('an edit in the circuit, without its hypothesis, or a free program is refused before any version exists', () => {
  const { store } = fixture();
  const inCircuit = putEdit(store, sparse(CHIP, [2, 2], [0], [1]), 2);
  assert.ok('problems' in inCircuit && /circuit/.test(inCircuit.problems.join()));
  const noHypothesis = putEdit(store, sparse(DOWN, [2, 2], [0], [1], { hypothesis: { competence: 'x', mechanism: '', effect: 'y' } }), 2);
  assert.ok('problems' in noHypothesis && /hypothesis/.test(noHypothesis.problems.join()));
  const program = putEdit(store, sparse(DOWN, [2, 2], [0], [1], { origin: { kind: 'program' } }), 2);
  assert.ok('problems' in program && /isolated backend/.test(program.problems.join()));
  const unsorted = putEdit(store, sparse(DOWN, [2, 2], [2, 1], [1, 1]), 2);
  assert.ok('problems' in unsorted && /increasing/.test(unsorted.problems.join()));
  const notFinite = putEdit(store, lowrank(DOWN, [2, 2], [1, NaN], [1, 1]), 2);
  assert.ok('problems' in notFinite && /finite/.test(notFinite.problems.join()));
});

test('the bounds fall on the composed intervention: two edits inside them each, out of them together, are refused', () => {
  const { store, pkg } = fixture();
  const quarter: WeightBounds = { ...LAX, per_module: { ...LAX.per_module, max_changed_fraction: 0.25 } };
  const a = put(store, sparse(DOWN, [2, 2], [1], [0.5]));
  const b = put(store, sparse(DOWN, [2, 2], [2], [0.5]));
  assert.ok('child' in composeVersion({ store, parent: pkg, add: [a], authorized: quarter }));
  assert.ok('child' in composeVersion({ store, parent: pkg, add: [b], authorized: quarter }));
  const both = composeVersion({ store, parent: pkg, add: [a, b], authorized: quarter });
  assert.ok('problems' in both && /out of bounds/.test(both.problems.join()), JSON.stringify(both));
  assert.ok('problems' in composeVersion({ store, parent: pkg, add: [a], authorized: null }), 'no bounds authorized, no edits');
  const laxer = composeVersion({ store, parent: pkg, add: [a], authorized: quarter, declared: LAX });
  assert.ok('problems' in laxer && /laxer/.test(laxer.problems.join()));
  const stricter = composeVersion({ store, parent: pkg, add: [a, b], authorized: LAX, declared: quarter });
  assert.ok('problems' in stricter, 'a candidate is held to the stricter bounds it declares');
});

test('the three sizes are measured on the composition: a rank-1 change counts every entry it changes', () => {
  const { store, pkg } = fixture();
  const a = put(store, lowrank(DOWN, [2, 2], [1, 1], [0.5, 0.5]));
  const v = composeVersion({ store, parent: pkg, add: [a], authorized: LAX });
  assert.ok('child' in v);
  const s = v.set.summaries[DOWN];
  assert.deepEqual([s.entries, s.changed, s.representation, s.rank_bound], [4, 4, 4, 1]);
  assert.ok(Math.abs(s.relative_norm - 1 / Math.SQRT2) < 1e-6, String(s.relative_norm));
  // An edit and its opposite: stored twice over, nothing changed.
  const back = put(store, lowrank(DOWN, [2, 2], [-1, -1], [0.5, 0.5]));
  const none = composeVersion({ store, parent: pkg, add: [a, back], authorized: LAX });
  assert.ok('child' in none);
  assert.deepEqual([none.set.summaries[DOWN].changed, none.set.summaries[DOWN].representation, none.set.summaries[DOWN].relative_norm], [0, 8, 0]);
});

test('edit on an edited version: a child whose genome extends the parent\'s, composed from the start; a parent with a LoRA is refused', () => {
  const { dir, store, pkg } = fixture();
  const a = put(store, sparse(Q, [2, 3], [0], [0.75]));
  const b = put(store, sparse(Q, [2, 3], [0], [0.75], { hypothesis: { ...H, effect: 'again' } }));
  const first = composeVersion({ store, parent: pkg, add: [a], authorized: LAX });
  assert.ok('child' in first);
  assert.equal(weightsOf(store, first.child, Q)[0], 256, 'one increment alone rounds back to 256');
  const second = composeVersion({ store, parent: first.child, add: [b], authorized: LAX });
  assert.ok('child' in second);
  assert.deepEqual(second.set.genome, [a, b]);
  assert.equal(second.set.start, first.set.start, 'the same start');
  assert.equal(weightsOf(store, second.child, Q)[0], 258, 'recomposed from the start, never applied on the parent\'s weights');
  assert.deepEqual(second.child.provenance.parents, [executionHash(first.child)]);
  const lora = path.join(dir, 'lora');
  fs.mkdirSync(lora);
  fs.writeFileSync(path.join(lora, 'adapter_config.json'), '{}');
  const withLora = normalizePackage({ ...pkg, adapter: store.putTree(lora) });
  const refused = composeVersion({ store, parent: withLora, add: [a], authorized: LAX });
  assert.ok('problems' in refused && /LoRA/.test(refused.problems.join()));
  assert.ok(recipeProblems({ format: 'junior-recipe@1' }, second.child).length, 'and a training on an edited version is refused too');
});

test('project_out normalizes its direction: W = I and d = [2, 0] give diag(0, 1), d̂ = [1, 0] recorded; a null, infinite or misshapen d is refused', () => {
  const { store, pkg } = fixture();
  const d = (v: number[]) => ({ 'd.safetensors': writeSafetensors({ d: tensorF32([v.length], v) }) });
  const made = construct(store, pkg, { constructor: 'project_out@1', args: { module: DOWN }, inputs: d([2, 0]), hypothesis: H, authorship: 'strong' });
  assert.ok('id' in made, JSON.stringify(made));
  const v = composeVersion({ store, parent: pkg, add: [made.id], authorized: LAX });
  assert.ok('child' in v, JSON.stringify(v));
  assert.deepEqual(weightsOf(store, v.child, DOWN), [0, 0, 0, 1]);
  const edit = JSON.parse(store.get(made.id).toString('utf8'));
  const recorded = readSafetensors(store.get(edit.origin.inputs['d.safetensors']));
  assert.deepEqual(Array.from(new Float32Array(recorded.d_hat.bytes.slice().buffer)), [1, 0]);
  for (const bad of [[0, 0], [Infinity, 0], [1, 0, 0]]) {
    const r = construct(store, pkg, { constructor: 'project_out@1', args: { module: DOWN }, inputs: d(bad), hypothesis: H, authorship: 'strong' });
    assert.ok('problems' in r, String(bad));
  }
});

test('a version exported, imported into an empty store and recomposed without the run: the same summaries, its constructors verified with the inputs in its tree', () => {
  const { dir, store, pkg } = fixture();
  const built = construct(store, pkg, { constructor: 'project_out@1', args: { module: DOWN }, inputs: { 'd.safetensors': writeSafetensors({ d: tensorF32([2], [0, 3]) }) }, hypothesis: H, authorship: 'strong' });
  assert.ok('id' in built);
  const w = put(store, lowrank(Q, [2, 3], [0.5, -0.25], [1, 2, 3]));
  const v = composeVersion({ store, parent: pkg, add: [built.id, w], authorized: LAX });
  assert.ok('child' in v, JSON.stringify(v));
  assert.deepEqual(verifyEditSet(store, v.child), []);
  exportPackage(v.child, store, path.join(dir, 'export'));
  const empty = new BlobStore(path.join(dir, 'elsewhere'));
  const imported = importPackage(path.join(dir, 'export'), empty);
  assert.deepEqual(verifyEditSet(empty, imported), [], 'everything it needs travelled in its tree');
  assert.deepEqual(readEditSet(empty, imported.adapter!)!.summaries, v.set.summaries);
  // A tree that does not carry a constructor's input cannot verify it.
  const t = store.tree(v.adapter)!;
  const files = Object.fromEntries(Object.entries(t.files).filter(([k]) => !k.includes('/inputs/')));
  const stripped = normalizePackage({ ...v.child, adapter: store.put(JSON.stringify({ format: 'blob-tree@1', files })) });
  assert.match(verifyEditSet(store, stripped).join(), /does not travel in the tree/);
  // A summary that is not what the genome composes into is found.
  const set = { ...v.set, summaries: { ...v.set.summaries, [Q]: { ...v.set.summaries[Q], digest: '0'.repeat(64) } } };
  const lying = normalizePackage({ ...v.child, adapter: store.put(JSON.stringify({ format: 'blob-tree@1', files: { ...t.files, 'set.json': store.put(JSON.stringify(set)) } })) });
  assert.match(verifyEditSet(store, lying).join(), /other weights than the set says/);
});

test('the competence manifest\'s bounds are checked with it', () => {
  const problems = competenceProblems({ format: 'junior-competence-manifest@1', weight_edits: { per_module: { max_changed_fraction: 2 }, total: {} } });
  assert.ok(problems.some((p) => p.includes('weight_edits')), problems.join('\n'));
});

test('the worker composes the same bits in Python, says them, and is believed only when they are the set\'s', { skip: !python && 'no Python' }, async () => {
  const { dir, store, pkg } = fixture();
  const a = put(store, lowrank(Q, [2, 3], [0.1, -3], [0.3, 7, -1e-3], 1));
  const b = put(store, sparse(Q, [2, 3], [0, 2, 5], [0.75, 1e-8, -4]));
  const c = put(store, lowrank(DOWN, [2, 2], [1, 2, 3, 4], [0.5, 0.25, -1, 0.125], 2));
  const v = composeVersion({ store, parent: pkg, add: [a, b, c], authorized: LAX });
  assert.ok('child' in v, JSON.stringify(v));
  const server = new SessionServer({ root: path.join(dir, 'srv'), store, worker: new ProcessWorker({ python: [python!], backend: 'fake', work: path.join(dir, 'work') }) });
  try {
    const s = server.open({ run_id: 'r', pkg: v.child, session_id: 's' });
    const r = await server.ask('s', { request_id: 'q', content: { user: 'hello' }, expected: s.head_id });
    assert.equal(r.served, executionHash(v.child), r.reason ?? '');
    const valid = await server.validity({ pkg: v.child });
    assert.equal((valid as { mismatches?: number }).mismatches, 0, JSON.stringify(valid));
    // A set whose summary is not what the worker composes: what it serves is not believed.
    const t = store.tree(v.adapter)!;
    const set = { ...v.set, summaries: { ...v.set.summaries, [DOWN]: { ...v.set.summaries[DOWN], digest: '0'.repeat(64) } } };
    const lying = normalizePackage({ ...v.child, name: 'lying', adapter: store.put(JSON.stringify({ format: 'blob-tree@1', files: { ...t.files, 'set.json': store.put(JSON.stringify(set)) } })) });
    const s2 = server.open({ run_id: 'r', pkg: lying, session_id: 's2' });
    const r2 = await server.ask('s2', { request_id: 'q', content: { user: 'hello' }, expected: s2.head_id });
    assert.equal(r2.served, 'unverified');
    assert.match(r2.reason ?? '', /composed into other weights/);
  } finally { server.stop(); }
  // The pure composer alone, against the harness's reference, digest by digest.
  const tree = path.join(dir, 'tree');
  store.materialize(v.adapter, tree);
  const baseDir = path.join(dir, 'basecopy');
  store.materialize(pkg.base, baseDir);
  const out = spawnSync(python!, ['-c', 'import sys, json; sys.path.insert(0, sys.argv[1]); import junior_weights as JW; print(json.dumps(JW.compose_pure(sys.argv[2], sys.argv[3], 2)))',
    path.join(HERE, '..', 'src', 'junior'), tree, baseDir], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const py = JSON.parse(out.stdout);
  for (const [m, s] of Object.entries(v.set.summaries)) assert.deepEqual(py[m], { base: s.base_digest, edited: s.digest }, m);
});

test('the fake worker finds a set that reaches the circuit, written by hand past the harness', { skip: !python && 'no Python' }, async () => {
  const { dir, store, pkg } = fixture();
  const a = put(store, sparse(DOWN, [2, 2], [0], [1]));
  const v = composeVersion({ store, parent: pkg, add: [a], authorized: LAX });
  assert.ok('child' in v);
  // The same edit, renamed into the circuit's layer and its set rewritten: never made by composeVersion.
  const edit = JSON.parse(store.get(a).toString('utf8'));
  edit.modules[0].module = CHIP;
  const bad = store.put(JSON.stringify(edit));
  const files: Record<string, string> = { 'set.json': store.put(JSON.stringify({ ...v.set, genome: [bad] })), ['edits/' + bad + '/edit.json']: bad, ['edits/' + bad + '/m0.safetensors']: edit.modules[0].sha256 };
  const touched = normalizePackage({ ...v.child, adapter: store.put(JSON.stringify({ format: 'blob-tree@1', files })) });
  const server = new SessionServer({ root: path.join(dir, 'srv'), store, worker: new ProcessWorker({ python: [python!], backend: 'fake', work: path.join(dir, 'work') }) });
  try {
    await server.validity({ pkg: v.child });
    await assert.rejects(server.validity({ pkg: touched }), /reach the circuit/);
  } finally { server.stop(); }
});

/* --- An external review of WE1 (04/11/2026). ------------------------------------------------------------------------- */

test('review: finite factors whose composition is not finite are refused - an overflow, and +Infinity and -Infinity summed into NaN', () => {
  const { store, pkg } = fixture();
  const up = put(store, sparse(Q, [2, 3], [0], [3e38]));
  const up2 = put(store, sparse(Q, [2, 3], [0], [3e38], { hypothesis: { ...H, effect: 'up again' } }));
  const down = put(store, lowrank(Q, [2, 3], [-1e30, 0], [1e30, 0, 0]));
  const over = composeVersion({ store, parent: pkg, add: [up, up2], authorized: LAX });
  assert.ok('problems' in over && /not finite/.test(over.problems.join()), JSON.stringify(over));
  const nan = composeVersion({ store, parent: pkg, add: [up, up2, down], authorized: { ...LAX, per_module: { ...LAX.per_module, max_relative_norm: 0 } } });
  assert.ok('problems' in nan && /not finite/.test(nan.problems.join()), JSON.stringify(nan));
  // 3.4e38 is finite in fp32 (its largest is 3.4028e38) and beyond bf16's (3.3895e38): it rounds to +Infinity.
  const bf16Overflow = put(store, sparse(Q, [2, 3], [0], [3.4e38]));
  const r = composeVersion({ store, parent: pkg, add: [bf16Overflow], authorized: LAX });
  assert.ok('problems' in r && /not finite/.test(r.problems.join()), 'a sum finite in fp32 that bf16 cannot hold: ' + JSON.stringify(r));
});

test('review: the verifier computes every measure again and applies the set\'s bounds: a set that lies about its size, or keeps the wrong circuit, is found', () => {
  const { store, pkg } = fixture();
  const a = put(store, lowrank(DOWN, [2, 2], [1, 1], [0.5, 0.5]));
  const v = composeVersion({ store, parent: pkg, add: [a], authorized: LAX });
  assert.ok('child' in v);
  const t = store.tree(v.adapter)!;
  const rewrite = (set: unknown) => normalizePackage({ ...v.child, adapter: store.put(JSON.stringify({ format: 'blob-tree@1', files: { ...t.files, 'set.json': store.put(JSON.stringify(set)) } })) });
  const zero = { ...v.set.summaries[DOWN], changed: 0, relative_norm: 0 };
  const lying = rewrite({ ...v.set, summaries: { [DOWN]: zero }, totals: { ...v.set.totals, changed: 0, changed_fraction: 0, relative_norm: 0 },
    bounds: { ...LAX, per_module: { ...LAX.per_module, max_relative_norm: 0 }, total: { ...LAX.total, max_relative_norm: 0 } } });
  const found = verifyEditSet(store, lying).join('\n');
  assert.match(found, /measures are not the ones the set records/);
  assert.match(found, /totals are not the ones/);
  assert.match(found, /out of its bounds/);
  assert.match(verifyEditSet(store, rewrite({ ...v.set, chip_layers: 0 })).join(), /circuit has 0 layers/);
  assert.match(verifyEditSet(store, rewrite({ ...v.set, bounds: { per_module: {}, total: {} } })).join(), /the set's bounds/);
  const strict = { ...LAX, per_module: { ...LAX.per_module, max_rank: 0 } };
  assert.match(verifyEditSet(store, v.child, strict).join(), /laxer than the authorized/);
  assert.deepEqual(verifyEditSet(store, v.child, LAX), []);
});

test('review: the rank is bounded over the composition: two rank-1 edits that compose into I are refused under max_rank 1', () => {
  const { store, pkg } = fixture();
  const one: WeightBounds = { ...LAX, per_module: { ...LAX.per_module, max_rank: 1 } };
  const e1 = put(store, lowrank(DOWN, [2, 2], [1, 0], [1, 0]));
  const e2 = put(store, lowrank(DOWN, [2, 2], [0, 1], [0, 1]));
  assert.ok('child' in composeVersion({ store, parent: pkg, add: [e1], authorized: one }));
  const both = composeVersion({ store, parent: pkg, add: [e1, e2], authorized: one });
  assert.ok('problems' in both && /sum rank 2/.test(both.problems.join()), JSON.stringify(both));
  const lax = composeVersion({ store, parent: pkg, add: [e1, e2], authorized: LAX });
  assert.ok('child' in lax);
  assert.equal(lax.set.summaries[DOWN].rank_bound, 2, 'the bound declared: the sum of the ranks');
});
