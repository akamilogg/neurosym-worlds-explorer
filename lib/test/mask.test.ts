import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BlobStore, executionHash, normalizePackage } from '../src/junior/package.ts';
import { adapterKind, baseReader, bf16Bits, compose, composeVersion, putEdit, tensorF32, tensorI64, totalsOf, weightsMismatch, writeSafetensors, type RawTensor, type WeightBounds } from '../src/junior/weights.ts';
import { applyMask, asSparse, deletionsInTree, maskBoundsProblems, putMask, readMask, verifyMask, type MaskBounds } from '../src/junior/mask.ts';
import { importAdapter, importMask, runMethodProgram, type ExecutionProfile, type MethodProgram } from '../src/junior/method-program.ts';
import type { Availability, IsolatedBackend } from '../src/junior/isolation.ts';
import { owes } from '../src/junior/confirm.ts';
import { realizationOf } from '../src/junior/groups.ts';
import type { CompetenceManifest } from '../src/junior/competence.ts';
import { JuniorWorld } from '../src/worlds/junior/lab.ts';

/* SPEC-EDICION-PESOS §15.3 and §15.8, WE7a: the mask@1 adapter - per module the indices of its weight deleted (set to
   zero), measured as the sparse change of -W it is. Its acceptance: (1) a mask that deletes in the circuit or beyond its
   bound is no version; (2) applying it and composing its sparse change give the same weights, bit for bit, and the same
   measures; (3) a package with a mask declares trained, with what it learned from; (4) a version with a mask receives no
   edits nor another training. */

const python = ['python', 'python3'].find((p) => spawnSync(p, ['--version']).status === 0);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mask-'));
const GATE = 'model.layers.4.mlp.gate_proj', UP = 'model.layers.5.mlp.up_proj', CIRCUIT = 'model.layers.1.mlp.gate_proj';
/* Weights with signs, a zero, a negative zero and values only bf16 holds. */
const VALUES = [1.5, -2.25, 0, -0, 3.140625, -0.0078125, 7, -11, 0.5, 2, -3, 4, 1e-3, -1e-3, 100, -100];
const bf16 = (shape: number[], values: number[]): RawTensor => ({ dtype: 'BF16', shape, bytes: new Uint8Array(Uint16Array.from(values.map(bf16Bits)).buffer) });
function base(dir: string) {
  const store = new BlobStore(path.join(dir, 'blobs'));
  const b = path.join(dir, 'base');
  fs.mkdirSync(b);
  fs.writeFileSync(path.join(b, 'model.safetensors'), writeSafetensors({ [GATE + '.weight']: bf16([4, 4], VALUES), [UP + '.weight']: bf16([2, 4], VALUES.slice(0, 8)), [CIRCUIT + '.weight']: bf16([2, 2], [1, 2, 3, 4]) }));
  fs.writeFileSync(path.join(b, 'config.json'), JSON.stringify({ num_hidden_layers: 6 }));
  const pkg = normalizePackage({ format: 'junior-package@1', name: 'start', base: store.putTree(b), prompt: '',
    execution: { firmware: store.put('f'), tokenizer: store.put('{}'), chat_template: store.put('c'), driver: store.put('d'), verifier: store.put('v'), circuit: { chip_layers: 2 }, precision: 'bf16' } });
  return { store, pkg, baseDir: b };
}
const BOUNDS: MaskBounds = { per_module: { max_fraction: 0.5 }, total: { max_fraction: 0.5 } };
const DELETE = [{ module: GATE, indices: [0, 1, 2, 3, 9] }, { module: UP, indices: [1, 4] }];

test('WE7a (1): a mask that deletes in the circuit, beyond its bound or from a version that has an adapter is no version; a declared bound only tightens', () => {
  const { store, pkg } = base(tmp());
  assert.match(String((putMask(store, pkg, [{ module: CIRCUIT, indices: [0] }], { authorized: BOUNDS }) as { problems: string[] }).problems), /circuit/);
  assert.match(String((putMask(store, pkg, [{ module: GATE, indices: [0, 1, 2, 3, 4, 5, 6, 7, 8] }], { authorized: BOUNDS }) as { problems: string[] }).problems), /9 of 16 entries deleted, more than 0.5/);
  assert.match(String((putMask(store, pkg, DELETE, { authorized: { per_module: { max_fraction: 0.5 }, total: { max_fraction: 0.2 } } }) as { problems: string[] }).problems), /in total: 7 of 24/);
  assert.match(String((putMask(store, pkg, DELETE, { authorized: BOUNDS, declared: { per_module: { max_fraction: 0.9 }, total: { max_fraction: 0.5 } } }) as { problems: string[] }).problems), /laxer/);
  assert.match(String((putMask(store, pkg, DELETE, { authorized: null }) as { problems: string[] }).problems), /authorizes no masks/);
  assert.match(String((putMask(store, pkg, [{ module: GATE, indices: [3, 2] }], { authorized: BOUNDS }) as { problems: string[] }).problems), /strictly increasing/);
  assert.match(String((putMask(store, pkg, [{ module: GATE, indices: [16] }], { authorized: BOUNDS }) as { problems: string[] }).problems), /inside its 4x4/);
  const ok = putMask(store, pkg, DELETE, { authorized: BOUNDS });
  assert.ok('child' in ok, JSON.stringify(ok));
  assert.match(String((putMask(store, ok.child, [{ module: GATE, indices: [4] }], { authorized: BOUNDS }) as { problems: string[] }).problems), /already has an adapter \(mask\)/);
  /* The condition's bound itself, checked in its manifest. */
  assert.deepEqual(maskBoundsProblems({ per_module: { max_fraction: 2 }, total: { max_fraction: 0.5 } }), ['"masks".per_module.max_fraction: a fraction in [0, 1]']);
});

test('WE7a (2): applying the mask and composing its sparse change of -W give the same weights, bit for bit, and the same measures; verified from its own tree', () => {
  const { store, pkg } = base(tmp());
  const made = putMask(store, pkg, DELETE, { authorized: BOUNDS });
  assert.ok('child' in made);
  assert.equal(adapterKind(store, made.child), 'mask');
  const read = baseReader(store, pkg.base);
  const applied = applyMask(DELETE, read);
  const composed = compose([asSparse('x', DELETE, read)], read);
  for (const d of DELETE) {
    assert.deepEqual([...applied[d.module]], [...composed.weights[d.module]], d.module + ': bit for bit');
    for (const i of d.indices) assert.equal(applied[d.module][i], 0, 'deleted is +0, whatever its sign was');
  }
  /* The same measures as an edit of those values: deleting a zero changes nothing. */
  const mask = readMask(store, made.adapter)!;
  assert.equal(mask.summaries[GATE].changed, 3, 'five deleted: one was zero already (index 2) and -0 (index 3) is zero too');
  assert.equal(mask.summaries[GATE].sparse_entries, 5);
  assert.deepEqual(mask.totals, totalsOf(composed));
  /* The same measures as an edit carrying those values, composed the usual way. */
  const asEdit = putEdit(store, { modules: DELETE.map((d) => ({ module: d.module, encoding: 'sparse' as const, shape: (d.module === GATE ? [4, 4] : [2, 4]) as [number, number],
    tensors: { indices: tensorI64(d.indices), values: tensorF32([d.indices.length], d.indices.map((i) => -(d.module === GATE ? VALUES : VALUES.slice(0, 8))[i])) } })),
    hypothesis: { competence: 'c', mechanism: 'm', effect: 'e' }, origin: { kind: 'written' }, authorship: 'control' }, 2);
  assert.ok('id' in asEdit);
  const big: WeightBounds = { per_module: { max_changed_fraction: 1, max_relative_norm: 10, max_representation: 1000, max_rank: 8, max_sparse_entries: 100 }, total: { max_changed_fraction: 1, max_relative_norm: 10, max_representation: 1000 } };
  const v = composeVersion({ store, parent: pkg, add: [asEdit.id], authorized: big });
  assert.ok('set' in v, JSON.stringify(v));
  assert.deepEqual(v.set.summaries, mask.summaries, 'the measures of §3.3 coincide');
  assert.deepEqual(verifyMask(store, made.child), []);
  assert.deepEqual(verifyMask(store, made.child, { per_module: { max_fraction: 0.1 }, total: { max_fraction: 0.5 } }), ['the mask\'s bounds are laxer than the authorized ones']);
  assert.deepEqual(deletionsInTree(store, made.adapter), DELETE);
  /* What the worker says it served, checked against the mask's summaries. */
  const served = Object.fromEntries(Object.entries(mask.summaries).map(([m, s]) => [m, { base: s.base_digest, edited: s.digest }]));
  assert.equal(weightsMismatch(store, made.child, served), null);
  assert.match(String(weightsMismatch(store, made.child, { ...served, [GATE]: { base: served[GATE].base, edited: 'other' } })), /composed into other weights/);
});

test('WE7a (2): the worker\'s pure Python applies the mask to the same digests the mask records', { skip: !python && 'no Python' }, () => {
  const dir = tmp();
  const { store, pkg, baseDir } = base(dir);
  const made = putMask(store, pkg, DELETE, { authorized: BOUNDS });
  assert.ok('child' in made);
  const adapterDir = path.join(dir, 'adapter');
  store.materialize(made.adapter, adapterDir);
  const script = 'import sys, json; sys.path.insert(0, sys.argv[1]); import junior_weights as JW; print(json.dumps(JW.pure_digests(sys.argv[2], sys.argv[3], 2)))';
  const r = spawnSync(python!, ['-c', script, path.resolve('src/junior'), adapterDir, baseDir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const digests = JSON.parse(r.stdout.trim());
  const mask = readMask(store, made.adapter)!;
  assert.deepEqual(digests, Object.fromEntries(Object.entries(mask.summaries).map(([m, s]) => [m, { base: s.base_digest, edited: s.digest }])));
});

/* A backend that answers what a program would have written. */
const handing = (out: Record<string, Buffer>, format: string): Availability => ({ available: true, proof: { stand_in: true }, backend: { id: 'test-handing', async run() {
  return { state: 'finished', outputs: { ...out, 'result.json': Buffer.from(JSON.stringify({ format, products: Object.keys(out) })) }, reason: null, wall_ms: 1 };
} } as unknown as IsolatedBackend });
const maskProducts = (deletions: { module: string; indices: number[] }[]) => ({
  'modules.json': Buffer.from(JSON.stringify(deletions.map((d, i) => ({ module: d.module, file: 'm' + i + '.safetensors' })))),
  ...Object.fromEntries(deletions.map((d, i) => ['m' + i + '.safetensors', writeSafetensors({ indices: tensorI64(d.indices) })]))
});
const PROFILE: ExecutionProfile = { id: 'cpu-small', dependencies: { python: '3' }, limits: { timeout_ms: 30_000, memory_bytes: 1 << 28, cpu_seconds: 30, output_bytes: 1 << 20 }, gpu: false };
const program = (over: Partial<MethodProgram> = {}): MethodProgram => ({ format: 'method-program@1', entrypoint: 'main.py', files: { 'main.py': '# learns which weights to delete' },
  profile: 'cpu-small', inputs: ['dataset.jsonl'], parameters: {}, seed: 1, output_format: 'mask@1', ...over });

test('WE7a (3, 4): a program\'s mask imported in the junior\'s world - a version that declares trained, with its realizations; it receives no edits, no other training, no LoRA', async () => {
  const dir = tmp();
  const { store, pkg, baseDir } = base(dir);
  /* Imported directly: within the condition's bounds, refused beyond them. */
  const rows = Buffer.from(JSON.stringify({ id: 'e1', system: 's', user: ['u'], calls: [], answer: 'a' }) + '\n');
  const job = await runMethodProgram({ program: program(), profiles: [PROFILE], inputs: { 'dataset.jsonl': rows }, start: executionHash(pkg), startDir: baseDir, availability: handing(maskProducts(DELETE), 'mask@1') });
  assert.equal(job.state, 'finished', String(job.reason));
  assert.ok('adapter' in await importMask(store, pkg, job, BOUNDS));
  assert.match(String(((await importMask(store, pkg, job, { per_module: { max_fraction: 0.1 }, total: { max_fraction: 1 } })) as { problems: string[] }).problems), /more than 0.1/);
  /* In the world: the condition authorizes masks. */
  const manifest = { format: 'junior-competence-manifest@1', id: 'mask', reference: executionHash(pkg),
    components: [{ id: 'a', rung: 1, mode: 'start', extractor: { id: 'probe', version: 1 }, unit: 'share', direction: 'up', target: 1, bad: 0, tolerance: 0 }],
    cases: [{ id: 'p0', kind: 'probe', partition: 'development', group: 'g-sel', component: 'a', lab: 'cells', mode: 'start', cut: { run: 'x.json', question: 0, hash: 'h' }, competence: 'protocol', instruction: 'i', checker: { id: 'protocol', version: 1 } }],
    investigation_repetitions: 1, execution: {}, sampling: { seed: 1 }, promotion: { procedure: 'paired-cases@1', alpha: 0.05, permutations: 1000, seed: 1 },
    limits: { junior_args: ['--max-tokens', '1000', '--max-judge-calls', '10'], probe_max_tokens: 500, timeout_ms: 60000 }, masks: BOUNDS,
    weight_edits: { per_module: { max_changed_fraction: 1, max_relative_norm: 3, max_representation: 1000, max_rank: 8, max_sparse_entries: 100 }, total: { max_changed_fraction: 1, max_relative_norm: 3, max_representation: 1000 } }
  } as unknown as CompetenceManifest;
  const w = new JuniorWorld({ manifest, base: pkg, blobs: path.join(dir, 'blobs'), server: 'http://127.0.0.1:9', dir: path.join(dir, 'world'), evaluations: 4, edits: 4,
    programProfiles: [PROFILE], programAvailability: handing(maskProducts(DELETE), 'mask@1') });
  const capture = { experiment: 'cells@1', argv: ['--seed', '3', '--level', '1'], run_id: 'r3' };
  fs.mkdirSync(path.join(dir, 'world', 'examples'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'world', 'datasets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'world', 'examples', 'e1.json'), JSON.stringify({ id: 'e1', state: 'verified', target: 'a', group: 'g-train',
    input: { system: 's', user: { parts: ['u'] } }, teacher: { memory: { calls: [] } }, cut: { run: 'r.json', question: 0, hash: 'h', capture } }));
  const ds = 'f'.repeat(64);
  fs.writeFileSync(path.join(dir, 'world', 'datasets', ds + '.json'), JSON.stringify({ id: ds, examples: ['e1'], groups: ['g-train'], admits: ['verified'] }));
  const t = await w.trainFrom(w.reference, ds, { format: 'junior-recipe@1', method: 'program', program: program(), admits: ['verified'] }, { why: 'delete what gets in the way' });
  assert.equal(t.state, 'finished', String(t.reason));
  const child = await w.packageOf(t.version!);
  assert.ok(typeof child !== 'string', String(child));
  assert.equal(adapterKind(w.blobs, child), 'mask');
  assert.equal(child.provenance.learned, 'trained', 'a mask comes out of a training: trained, never edited');
  assert.deepEqual(child.provenance.realizations, [realizationOf('cells', capture.argv)]);
  assert.equal(owes(child).trained, true);
  assert.deepEqual(verifyMask(w.blobs, child, BOUNDS), []);
  /* (4) Nothing more on it: no edits, no other training, no LoRA. */
  const e = await w.editFrom(t.version!, { kind: 'written', modules: [] } as never, { competence: 'c', mechanism: 'm', effect: 'e' }, undefined, { why: 'w' });
  assert.match(String(e.reason), /a version with a mask receives no edits/);
  assert.match(String((composeVersion({ store: w.blobs, parent: child, add: ['x'], authorized: manifest.weight_edits }) as { problems: string[] }).problems), /receives no edits/);
  const again = await w.trainFrom(t.version!, ds, { format: 'junior-recipe@1', method: 'program', program: program({ seed: 2 }), admits: ['verified'] }, { why: 'again' });
  assert.equal(again.state, 'refused');
  assert.match(String(again.reason), /already has an adapter/);
  const lora = await runMethodProgram({ program: program({ output_format: 'lora-adapter' }), profiles: [PROFILE], inputs: { 'dataset.jsonl': rows }, start: executionHash(child), startDir: baseDir,
    availability: handing({ 'adapter_config.json': Buffer.from('{}'), 'adapter_model.safetensors': Buffer.alloc(16) }, 'lora-adapter') });
  assert.match(String((importAdapter(w.blobs, child, lora) as { problems: string[] }).problems), /already has an adapter/);
  /* A condition without "masks": refused before anything runs. */
  const none = new JuniorWorld({ manifest: { ...manifest, masks: undefined } as CompetenceManifest, base: pkg, blobs: path.join(dir, 'blobs'), server: 'http://127.0.0.1:9', dir: path.join(dir, 'world2'), evaluations: 4, edits: 4,
    programProfiles: [PROFILE], programAvailability: handing(maskProducts(DELETE), 'mask@1') });
  const refused = await none.trainFrom(none.reference, ds, { format: 'junior-recipe@1', method: 'program', program: program(), admits: ['verified'] }, { why: 'w' });
  assert.match(String(refused.reason), /authorizes no masks/);
});
