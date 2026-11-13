import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BlobStore, executionHash, normalizePackage } from '../src/junior/package.ts';
import { adapterKind, baseReader, bf16Bits, writeSafetensors, readSafetensors, f32, type RawTensor } from '../src/junior/weights.ts';
import { readMask, verifyMask, wandaScores, type MaskBounds } from '../src/junior/mask.ts';
import { deletionProgram, deletionRecipeProblems, type DeletionRecipe } from '../src/junior/train.ts';
import { runMethodProgram, type ExecutionProfile } from '../src/junior/method-program.ts';
import type { Availability, IsolatedBackend } from '../src/junior/isolation.ts';
import { owes } from '../src/junior/confirm.ts';
import { realizationOf } from '../src/junior/groups.ts';
import { queryProblems, type LabLimits } from '../src/junior/weight-lab.ts';
import type { CompetenceManifest } from '../src/junior/competence.ts';
import { JuniorWorld } from '../src/worlds/junior/lab.ts';

/* SPEC-EDICION-PESOS §15.3 and §15.5, WE7: deletion@1 with SFT - the host's program that learns a mask, run on the general
   executor (method-program@1) under a training profile, its capacity measured first, starting from Wanda; and the
   laboratory's input_norms, from which Wanda's scores come. The backend here runs Python WITHOUT isolation, standing in to
   test the contract and the imitation's arithmetic; the isolation is proved by its own self-test, on Linux, and the real
   GPU run waits for the GPU isolation test. */

const python = ['python', 'python3'].find((p) => spawnSync(p, ['--version']).status === 0);
const LIB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'deletion-'));
const GATE4 = 'model.layers.4.mlp.gate_proj', GATE5 = 'model.layers.5.mlp.gate_proj', CIRCUIT = 'model.layers.1.mlp.gate_proj';
const bf16 = (shape: number[], values: number[]): RawTensor => ({ dtype: 'BF16', shape, bytes: new Uint8Array(Uint16Array.from(values.map(bf16Bits)).buffer) });

/* A base runner that runs the program as the isolated backend would, without its isolation: inputs/, out/, checkpoint/. */
const standIn = (intercept?: (job: Record<string, any>) => Record<string, Buffer> | null): Availability => ({ available: true, proof: { stand_in: true }, backend: { id: 'test-unisolated', async run(o: { code: string; inputs: Record<string, Buffer>; base: string; limits: { timeout_ms: number } }) {
  const job = JSON.parse(o.inputs['job.json'].toString('utf8'));
  const given = intercept?.(job);
  if (given) return { state: 'finished', outputs: given, reason: null, wall_ms: 1 };
  const work = tmp();
  fs.mkdirSync(path.join(work, 'inputs')); fs.mkdirSync(path.join(work, 'out'));
  fs.writeFileSync(path.join(work, 'program.py'), o.code);
  for (const [n, b] of Object.entries(o.inputs)) fs.writeFileSync(path.join(work, 'inputs', n), b);
  const r = spawnSync(python!, ['program.py'], { cwd: work, env: { ...process.env, JUNIOR_BASE: o.base, JUNIOR_CHECKPOINT: path.join(work, 'checkpoint') }, timeout: o.limits.timeout_ms });
  if (r.status !== 0) return { state: 'failed', outputs: {}, reason: String(r.stderr).slice(-600), wall_ms: 0 };
  const outputs = Object.fromEntries(fs.readdirSync(path.join(work, 'out')).map((f) => [f, fs.readFileSync(path.join(work, 'out', f))]));
  return { state: 'finished', outputs, reason: null, wall_ms: 1 };
} } as unknown as IsolatedBackend });

const PROFILE: ExecutionProfile = { id: 'train-cpu', dependencies: { python: '3' }, limits: { timeout_ms: 60_000, memory_bytes: 1 << 28, cpu_seconds: 60, output_bytes: 1 << 20 }, gpu: false };
const MASKS: MaskBounds = { per_module: { max_fraction: 0.5 }, total: { max_fraction: 0.5 } };
const recipe = (over: Partial<DeletionRecipe> = {}): DeletionRecipe => ({ format: 'junior-recipe@1', method: 'deletion@1', signal: 'sft', profile: 'train-cpu', layers: [4, 5],
  bounds: MASKS, init_fraction: 0.25, epochs: 2, batch: 2, max_length: 6, learning_rate: 0.5, beta: { start: 1, end: 20 }, seed: 1, mask: 'answer', admits: ['verified'], max_gpu_hours: 1, ...over });

function base(dir: string) {
  const store = new BlobStore(path.join(dir, 'blobs'));
  const b = path.join(dir, 'base');
  fs.mkdirSync(b);
  fs.writeFileSync(path.join(b, 'chipformer.json'), JSON.stringify({ chip_layers: 2 }));
  fs.writeFileSync(path.join(b, 'model.safetensors'), writeSafetensors({
    [GATE4 + '.weight']: bf16([3, 4], [2, -0.5, 0.25, 4, -3, 1, 0.125, -2, 0.5, 6, -1, 0.0625]),
    [GATE5 + '.weight']: bf16([2, 4], [1, -1, 2, -2, 0.75, 3, -0.25, 5]),
    [CIRCUIT + '.weight']: bf16([2, 2], [1, 2, 3, 4])
  }));
  const pkg = normalizePackage({ format: 'junior-package@1', name: 'start', base: store.putTree(b), prompt: '',
    execution: { firmware: store.put('f'), tokenizer: store.put('{}'), chat_template: store.put('c'), driver: store.put('d'), verifier: store.put('v'), circuit: { chip_layers: 2 }, precision: 'bf16' } });
  return { store, pkg, baseDir: b };
}

test('WE7 (§15.5, acceptance 9): input_norms gives the sums of squares and the tokens of the direct computation, and Wanda\'s scores from them are the ones by hand', { skip: !python && 'no Python' }, () => {
  /* Toy inputs by hand: two tokens [1, 2] and [3, -1]: sums of squares [10, 5], 2 tokens. */
  const script = 'import sys, json; sys.path.insert(0, sys.argv[1]); import junior_lab as JL; print(json.dumps(JL.input_norms_pure([[1.0, 2.0], [3.0, -1.0]])))';
  const r = spawnSync(python!, ['-c', script, path.join(LIB, 'src', 'junior')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [[10, 5], 2]);
  /* Wanda: |W_ij| * ||X_j||, with W = [[1, -2], [0.5, 0]]. */
  const W = { shape: [2, 2] as [number, number], bits: Uint16Array.from([1, -2, 0.5, 0].map(bf16Bits)) };
  assert.deepEqual([...wandaScores(W, [10, 5])], [Math.sqrt(10), 2 * Math.sqrt(5), 0.5 * Math.sqrt(10), 0]);
  assert.throws(() => wandaScores(W, [1, 2, 3]), /3 channels/);
  /* The toy laboratory's query: its sums, against the same inputs summed directly. */
  const fake = 'import sys, json; sys.path.insert(0, sys.argv[1]); import junior_lab as JL, tempfile\n'
    + 'class M:\n    def values(self, n): return (3, 4), None\n'
    + 'case = {"system": "s", "user": "keeps to the protocol"}\n'
    + 'r, u, f = JL.fake_input_norms(M(), [case], {"modules": ["m"]}, {"max_positions": 8}, tempfile.mkdtemp())\n'
    + 'got = [v for v in __import__("array").array("f", JL.JW.read_safetensors(open(f["input_norms.safetensors"], "rb").read())["m"][2])]\n'
    + 'words = ("s" + chr(10) + "keeps to the protocol").split()\n'
    + 'direct = [0.0] * 4\n'
    + 'for t in range(len(words)):\n    x = JL._fake_vector("s" + chr(10) + "keeps to the protocol#" + str(t), 4)\n    direct = [d + v * v for d, v in zip(direct, x)]\n'
    + 'print(json.dumps({"tokens": r["m"]["tokens"], "got": got, "direct": direct}))';
  const q = spawnSync(python!, ['-c', fake, path.join(LIB, 'src', 'junior')], { encoding: 'utf8' });
  assert.equal(q.status, 0, q.stderr);
  const o = JSON.parse(q.stdout);
  assert.equal(o.tokens, 5, 'its model positions: the words of the case');
  o.got.forEach((v: number, j: number) => assert.ok(Math.abs(v - Math.fround(o.direct[j])) < 1e-6, 'channel ' + j));
  /* The query's arguments, checked against the limits before it is sent. */
  const LIMITS = { max_cases: 2, max_new_tokens: 8, max_tokens: 100, max_slice_entries: 4, max_singular: 2, max_top_logits: 2, max_positions: 8, max_heads: 2, max_modules: 2, max_directions: 2, timeout_ms: 1000, max_memory_bytes: 1, max_response_bytes: 1000 } as LabLimits;
  assert.deepEqual(queryProblems({ query: 'input_norms', cases: [{ text: { user: 'u' } }], args: { modules: [GATE4] } }, LIMITS), []);
  assert.match(queryProblems({ query: 'input_norms', cases: [{ text: { user: 'u' } }], args: { modules: [GATE4, GATE5, CIRCUIT] } }, LIMITS).join(), /modules/);
});

test('WE7: a deletion@1 recipe - never the circuit, its bounds never laxer than the condition\'s, its start within them, SFT only - and its program by content', () => {
  const { pkg } = base(tmp());
  assert.deepEqual(deletionRecipeProblems(recipe(), pkg, MASKS), []);
  assert.match(deletionRecipeProblems(recipe({ layers: [1, 4] }), pkg, MASKS).join(), /belong to the circuit/);
  assert.match(deletionRecipeProblems(recipe({ bounds: { per_module: { max_fraction: 0.9 }, total: { max_fraction: 0.5 } } }), pkg, MASKS).join(), /laxer than the condition/);
  assert.match(deletionRecipeProblems(recipe({ init_fraction: 0.75 }), pkg, MASKS).join(), /within its bound per module/);
  assert.match(deletionRecipeProblems(recipe({ signal: 'grpo' as 'sft' }), pkg, MASKS).join(), /GRPO/);
  assert.match(deletionRecipeProblems(recipe({ beta: { start: 2, end: 1 } }), pkg, MASKS).join(), /beta/);
  assert.match(deletionRecipeProblems(recipe(), normalizePackage({ ...pkg, adapter: 'a'.repeat(64) }), MASKS).join(), /already has an adapter/);
  /* The same recipe, the same program; its phase and backend are its parameters. */
  const a = deletionProgram(recipe(), 'train', 'fake'), b = deletionProgram(recipe(), 'train', 'fake');
  assert.deepEqual(a, b);
  assert.equal(deletionProgram(recipe(), 'capacity', 'fake').output_format, 'capacity@1');
  assert.equal(a.output_format, 'mask@1');
  assert.ok(a.files['main.py'].includes('deletion@1 with SFT'));
});

test('WE7: the program learns a mask from Wanda on its data - deterministic, the same job going on from its checkpoint; its capacity measured', { skip: !python && 'no Python' }, async () => {
  const dir = tmp();
  const { pkg, baseDir } = base(dir);
  const rows = Buffer.from(['the answer keeps to the protocol', 'answers in JSON at once', 'never thinks aloud first'].map((a, i) => JSON.stringify({ id: 'e' + i, system: 's', user: ['u'], calls: [], answer: a })).join('\n') + '\n');
  const go = (phase: 'capacity' | 'train', r = recipe()) => runMethodProgram({ program: deletionProgram(r, phase, 'fake'), profiles: [PROFILE], inputs: { 'dataset.jsonl': rows }, start: executionHash(pkg), startDir: baseDir, availability: standIn() });
  const cap = await go('capacity');
  assert.equal(cap.state, 'finished', String(cap.reason));
  assert.deepEqual(JSON.parse(cap.products!['capacity.json'].toString('utf8')), { state: 'fits', peak_bytes: 12 * 20, weights: 20 });
  const one = await go('train'), two = await go('train');
  assert.equal(one.state, 'finished', String(one.reason));
  const listed = JSON.parse(one.products!['modules.json'].toString('utf8'));
  assert.ok(listed.length >= 1 && listed.every((m: { module: string }) => m.module === GATE4 || m.module === GATE5));
  assert.deepEqual(two.products, one.products, 'the same job, the same mask');
  /* With no gradient step to change it, the mask is Wanda's lowest init_fraction of each module, thresholded at zero. */
  const still = await go('train', recipe({ learning_rate: 1e-12, init_fraction: 0.25 }));
  const lst = JSON.parse(still.products!['modules.json'].toString('utf8')) as { module: string; file: string }[];
  const read = baseReader(new BlobStore(path.join(dir, 'blobs')), pkg.base);
  const sumsq = (name: string, din: number) => {
    /* The same inputs the imitation draws, summed directly here. */
    const s = 'import sys, json; sys.path.insert(0, sys.argv[1]); import deletion_sft as D\n'
      + 'rows = [json.loads(l) for l in open(sys.argv[2]) if l.strip()]\n'
      + 'out = [0.0] * int(sys.argv[3])\n'
      + 'for xs in D.fake_inputs(rows, int(sys.argv[3]), 6):\n    for x in xs:\n        out = [o + v * v for o, v in zip(out, x)]\n'
      + 'print(json.dumps(out))';
    const f = path.join(dir, 'rows.jsonl'); fs.writeFileSync(f, rows);
    const r = spawnSync(python!, ['-c', s, path.join(LIB, 'src', 'junior', 'programs'), f, String(din)], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout) as number[];
  };
  for (const m of lst) {
    const W = read(m.module + '.weight');
    const scores = [...wandaScores(W, sumsq(m.module, W.shape[1]))];
    const k = Math.floor(0.25 * scores.length);
    const lowest = scores.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v || a.i - b.i).slice(0, k).map((x) => x.i).sort((a, b) => a - b);
    const idx = Array.from(readSafetensors(still.products![m.file]).indices.bytes.length ? new BigInt64Array(readSafetensors(still.products![m.file]).indices.bytes.slice().buffer) : [], Number);
    assert.deepEqual(idx, lowest, m.module + ': Wanda\'s lowest quarter');
  }
  void f32;
});

test('WE7: in the junior\'s world, deletion@1 trains a version with a mask - capacity first, bounds kept, learned from data; one that does not fit or that deletes past its bounds is no version', { skip: !python && 'no Python' }, async () => {
  const dir = tmp();
  const { pkg } = base(dir);
  const manifest = { format: 'junior-competence-manifest@1', id: 'deletion', reference: executionHash(pkg),
    components: [{ id: 'a', rung: 1, mode: 'start', extractor: { id: 'probe', version: 1 }, unit: 'share', direction: 'up', target: 1, bad: 0, tolerance: 0 }],
    cases: [{ id: 'p0', kind: 'probe', partition: 'development', group: 'g-sel', component: 'a', lab: 'cells', mode: 'start', cut: { run: 'x.json', question: 0, hash: 'h' }, competence: 'protocol', instruction: 'i', checker: { id: 'protocol', version: 1 } }],
    investigation_repetitions: 1, execution: {}, sampling: { seed: 1 }, promotion: { procedure: 'paired-cases@1', alpha: 0.05, permutations: 1000, seed: 1 },
    limits: { junior_args: ['--max-tokens', '1000', '--max-judge-calls', '10'], probe_max_tokens: 500, timeout_ms: 60000 }, masks: MASKS
  } as unknown as CompetenceManifest;
  let capacityAsked = 0;
  const world = (sub: string, intercept?: (job: Record<string, any>) => Record<string, Buffer> | null) => new JuniorWorld({ manifest, base: pkg, blobs: path.join(dir, 'blobs'), server: 'http://127.0.0.1:9', dir: path.join(dir, sub), evaluations: 4,
    gpuHours: 10, training: { python: [python!], backend: 'fake' }, programProfiles: [PROFILE], programAvailability: standIn((job) => { if (job.parameters.phase === 'capacity') capacityAsked++; return intercept?.(job) ?? null; }) });
  const capture = { experiment: 'cells@1', argv: ['--seed', '3', '--level', '1'], run_id: 'r3' };
  const ds = 'd'.repeat(64);
  const seed = (sub: string) => {
    fs.mkdirSync(path.join(dir, sub, 'examples'), { recursive: true });
    fs.mkdirSync(path.join(dir, sub, 'datasets'), { recursive: true });
    ['the answer keeps to the protocol', 'answers in JSON at once'].forEach((a, i) => fs.writeFileSync(path.join(dir, sub, 'examples', 'e' + i + '.json'), JSON.stringify({ id: 'e' + i, state: 'verified', target: a, group: 'g-train',
      input: { system: 's', user: { parts: ['u'] } }, teacher: { memory: { calls: [] } }, cut: { run: 'r.json', question: 0, hash: 'h', capture } })));
    fs.writeFileSync(path.join(dir, sub, 'datasets', ds + '.json'), JSON.stringify({ id: ds, examples: ['e0', 'e1'], groups: ['g-train'], admits: ['verified'] }));
  };
  seed('w');
  const w = world('w');
  const t = await w.trainFrom(w.reference, ds, recipe(), { why: 'delete what gets in the way of the protocol' });
  assert.equal(t.state, 'finished', String(t.reason));
  assert.equal(capacityAsked, 1, 'its capacity measured first');
  const child = await w.packageOf(t.version!);
  assert.ok(typeof child !== 'string', String(child));
  assert.equal(adapterKind(w.blobs, child), 'mask');
  assert.deepEqual(verifyMask(w.blobs, child, MASKS), []);
  assert.deepEqual(readMask(w.blobs, child.adapter!)!.bounds, MASKS);
  assert.equal(child.provenance.learned, 'trained');
  assert.deepEqual(child.provenance.realizations, [realizationOf('cells', capture.argv)]);
  assert.equal(owes(child).trained, true);
  assert.ok(w.jobs.bags().gpu_hours.spent >= 0 && w.jobs.bags().gpu_hours.limit === 10, 'paid in GPU hours');
  const ledger = fs.readFileSync(path.join(dir, 'w', 'trainings.jsonl'), 'utf8');
  assert.match(ledger, /"method":"deletion@1"/, 'the recipe recorded as it was asked');
  /* Asked again: the same job, never trained again. */
  const again = await w.trainFrom(w.reference, ds, recipe(), { why: 'again' });
  assert.equal(again.version, t.version);
  /* Its capacity says it does not fit: refused, nothing trained. */
  seed('n');
  const n = world('n', (job) => job.parameters.phase === 'capacity' ? { 'capacity.json': Buffer.from(JSON.stringify({ state: 'does_not_fit', reason: 'peak 30 GB' })), 'result.json': Buffer.from(JSON.stringify({ format: 'capacity@1', products: ['capacity.json'] })) } : null);
  const no = await n.trainFrom(n.reference, ds, recipe(), { why: 'w' });
  assert.notEqual(no.state, 'finished');
  assert.match(String(no.reason), /does_not_fit|does not fit/);
  /* Past its total bound at the threshold: no version. */
  seed('b');
  const b = world('b');
  const past = await b.trainFrom(b.reference, ds, recipe({ bounds: { per_module: { max_fraction: 0.5 }, total: { max_fraction: 0.05 } }, init_fraction: 0.5, learning_rate: 1e-12 }), { why: 'w' });
  assert.notEqual(past.state, 'finished');
  assert.match(String(past.reason), /more than its bounds allow/);
  /* No trainer, or the condition authorizes no masks: refused before anything runs. */
  const none = new JuniorWorld({ manifest: { ...manifest, masks: undefined } as CompetenceManifest, base: pkg, blobs: path.join(dir, 'blobs'), server: 'http://127.0.0.1:9', dir: path.join(dir, 'x'), evaluations: 4, programProfiles: [PROFILE], programAvailability: standIn() });
  assert.match(String((await none.trainFrom(none.reference, ds, recipe(), { why: 'w' })).reason), /authorizes no masks/);
});
