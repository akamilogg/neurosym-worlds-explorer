import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BlobStore, executionHash, normalizePackage } from '../src/junior/package.ts';
import { isolatedBackend, type Availability, type IsolatedBackend } from '../src/junior/isolation.ts';
import { importProduct, jobIdentity, methodProgramProblems, programId, runMethodProgram, type ExecutionProfile, type MethodProgram } from '../src/junior/method-program.ts';
import { owes } from '../src/junior/confirm.ts';
import { realizationOf } from '../src/junior/groups.ts';
import { writeSafetensors, type RawTensor, bf16Bits, type WeightBounds } from '../src/junior/weights.ts';
import { JuniorWorld } from '../src/worlds/junior/lab.ts';
import type { CompetenceManifest } from '../src/junior/competence.ts';

/* SPEC-INVESTIGACION-EXTERNA §8, IE5: a method the researcher writes as a program - not a native recipe - run under a profile
   the operator enabled, only where an isolated backend is proved; its product imported and what it learned written by the host.
   The backend of these tests runs Python WITHOUT isolation, standing in to test the contract and the import only; the
   isolation itself is proved by its own self-test, on Linux. */

const python = ['python', 'python3'].find((p) => spawnSync(p, ['--version']).status === 0);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'method-program-'));
const standIn: IsolatedBackend = {
  id: 'test-unisolated',
  async run(o) {
    const work = tmp();
    fs.mkdirSync(path.join(work, 'inputs')); fs.mkdirSync(path.join(work, 'out'));
    fs.writeFileSync(path.join(work, 'program.py'), o.code);
    for (const [n, b] of Object.entries(o.inputs)) fs.writeFileSync(path.join(work, 'inputs', n), b);
    const r = spawnSync(python!, ['program.py'], { cwd: work, env: { ...process.env, JUNIOR_BASE: o.base }, timeout: o.limits.timeout_ms });
    if (r.status !== 0) return { state: 'failed', outputs: {}, reason: String(r.stderr).slice(-300), wall_ms: 0 };
    const outputs = Object.fromEntries(fs.readdirSync(path.join(work, 'out')).map((f) => [f, fs.readFileSync(path.join(work, 'out', f))]));
    return { state: 'finished', outputs, reason: null, wall_ms: 1 };
  }
};
const available: Availability = { available: true, backend: standIn, proof: { stand_in: true } };
const PROFILE: ExecutionProfile = { id: 'cpu-small', dependencies: { python: '3' }, limits: { timeout_ms: 30_000, memory_bytes: 1 << 28, cpu_seconds: 30, output_bytes: 1 << 20 }, gpu: false };
const DOWN = 'model.layers.4.mlp.down_proj';
/* A method nobody registered: one entry per row of its data, -scale each, on DOWN[0]; it writes a set of edits. */
const CODE = [
  'import json, struct',
  'rows = [json.loads(l) for l in open("inputs/dataset.jsonl") if l.strip()]',
  'job = json.load(open("inputs/job.json"))',
  'helper = open("inputs/prog.notes.txt").read()',
  'v = -float(job["parameters"]["scale"]) * len(rows)',
  'hdr = {"indices": {"dtype": "I64", "shape": [1], "data_offsets": [0, 8]}, "values": {"dtype": "F32", "shape": [1], "data_offsets": [8, 12]}}',
  'h = json.dumps(hdr).encode(); h += b" " * ((8 - len(h) % 8) % 8)',
  'open("out/m.safetensors", "wb").write(struct.pack("<Q", len(h)) + h + struct.pack("<q", 0) + struct.pack("<f", v))',
  'json.dump([{"module": "' + DOWN + '", "encoding": "sparse", "shape": [2, 2], "file": "m.safetensors"}], open("out/modules.json", "w"))',
  'json.dump({"format": "weight-edit-set@1", "products": ["modules.json", "m.safetensors"]}, open("out/result.json", "w"))'
].join('\n');
const program = (over: Partial<MethodProgram> = {}): MethodProgram => ({ format: 'method-program@1', entrypoint: 'main.py', files: { 'main.py': CODE, 'notes.txt': 'adapted from src:S1#L2-3' },
  profile: 'cpu-small', inputs: ['dataset.jsonl'], parameters: { scale: 0.5 }, seed: 1, output_format: 'weight-edit-set@1', cites: ['src:S1#L2-3'], ...over });
const bf16 = (shape: number[], values: number[]): RawTensor => ({ dtype: 'BF16', shape, bytes: new Uint8Array(Uint16Array.from(values.map(bf16Bits)).buffer) });
function base(dir: string) {
  const store = new BlobStore(path.join(dir, 'blobs'));
  const b = path.join(dir, 'base');
  fs.mkdirSync(b);
  fs.writeFileSync(path.join(b, 'chipformer.json'), JSON.stringify({ chip_layers: 2 }));
  fs.writeFileSync(path.join(b, 'model.safetensors'), writeSafetensors({ [DOWN + '.weight']: bf16([2, 2], [3, 0, 0, 1]) }));
  const pkg = normalizePackage({ format: 'junior-package@1', name: 'start', base: store.putTree(b), prompt: '',
    execution: { firmware: store.put('f'), tokenizer: store.put('{}'), chat_template: store.put('c'), driver: store.put('d'), verifier: store.put('v'), circuit: { chip_layers: 2 }, precision: 'bf16' } });
  return { store, pkg, baseDir: b };
}
const rows = Buffer.from(JSON.stringify({ id: 'e1', system: 's', user: ['u'], calls: [], answer: 'a' }) + '\n' + JSON.stringify({ id: 'e2', system: 's', user: ['u'], calls: [], answer: 'b' }) + '\n');

test('IE5: method-program@1 - its identity is its content; its inputs exactly those it declares; job.json and its other files mounted; result.json read and checked', { skip: !python && 'no Python' }, async () => {
  assert.deepEqual(methodProgramProblems(program()), []);
  assert.match(methodProgramProblems({ ...program(), entrypoint: 'nope.py' }).join(), /entrypoint/);
  assert.notEqual(programId(program()), programId(program({ files: { 'main.py': CODE + '\n# edited', 'notes.txt': 'x' } })), 'an edit of the program is another identity');
  const dir = tmp();
  const { pkg, baseDir } = base(dir);
  const go = (p: MethodProgram, inputs: Record<string, Buffer> = { 'dataset.jsonl': rows }, availability: Availability = available, profiles = [PROFILE]) =>
    runMethodProgram({ program: p, profiles, inputs, start: executionHash(pkg), startDir: baseDir, availability });
  const ok = await go(program());
  assert.equal(ok.state, 'finished', String(ok.reason));
  assert.deepEqual(Object.keys(ok.products!).sort(), ['m.safetensors', 'modules.json']);
  assert.equal(ok.job, jobIdentity(program(), { 'dataset.jsonl': rows }, executionHash(pkg), PROFILE));
  assert.notEqual((await go(program({ seed: 2 }))).job, ok.job, 'another seed, another job: a checkpoint never resumes another identity');
  assert.match(String((await go(program(), { 'dataset.jsonl': rows, 'secret.txt': Buffer.from('x') })).reason), /exactly those it declares/);
  assert.match(String((await go(program({ profile: 'gpu-big' }))).reason), /no profile gpu-big/);
  assert.equal((await go(program({ profile: 'gpu' }), undefined, undefined, [{ ...PROFILE, id: 'gpu', gpu: true }])).state, 'unavailable', 'a GPU profile runs no acquired program yet');
  assert.equal((await go(program(), undefined, { available: false, reason: 'not Linux' })).state, 'unavailable');
  const lies = await go(program({ files: { 'main.py': 'import json\njson.dump({"format": "weight-edit-set@1", "products": ["m.safetensors"]}, open("out/result.json", "w"))', 'notes.txt': '' } }));
  assert.match(String(lies.reason), /listed and not written/, 'a program that says it made what it did not');
});

test('IE5: its product imported as an edit, checked like any (the circuit refused); a mask is not an edit - it has its own import', { skip: !python && 'no Python' }, async () => {
  const dir = tmp();
  const { store, pkg, baseDir } = base(dir);
  const job = await runMethodProgram({ program: program(), profiles: [PROFILE], inputs: { 'dataset.jsonl': rows }, start: executionHash(pkg), startDir: baseDir, availability: available });
  const made = importProduct(store, pkg, job, { program: program(), backend: standIn.id, hypothesis: { competence: 'c', mechanism: 'm', effect: 'e' } });
  assert.ok('id' in made, JSON.stringify(made));
  const circuit = program({ files: { 'main.py': CODE.replace(DOWN, 'model.layers.1.mlp.down_proj'), 'notes.txt': '' } });
  const bad = await runMethodProgram({ program: circuit, profiles: [PROFILE], inputs: { 'dataset.jsonl': rows }, start: executionHash(pkg), startDir: baseDir, availability: available });
  const refused = importProduct(store, pkg, bad, { program: circuit, backend: standIn.id, hypothesis: { competence: 'c', mechanism: 'm', effect: 'e' } });
  assert.ok('problems' in refused && /circuit|chip/.test(refused.problems.join()), JSON.stringify(refused));
  const mask = importProduct(store, pkg, { ...job, format: 'mask@1' }, { program: program(), backend: 'x', hypothesis: { competence: 'c', mechanism: 'm', effect: 'e' } });
  assert.ok('problems' in mask && /not an edit: it is imported as the adapter of a child \(importMask\)/.test(mask.problems[0]), JSON.stringify(mask));
});

test('IE5: what a package learned is the host\'s word - a set of edits learned from data is a training for the confirmation, whatever its format', () => {
  const dir = tmp();
  const { store, pkg } = base(dir);
  const edited = normalizePackage({ ...pkg, adapter: store.put('set'), provenance: { parents: [], reason: 'r', sources: ['edit-set:x'] } });
  assert.deepEqual([owes(edited).trained, owes(edited).edited], [false, true], 'a package of before: read from its format');
  const learnedFromData = normalizePackage({ ...edited, provenance: { ...edited.provenance, learned: 'trained' } });
  assert.deepEqual([owes(learnedFromData).trained, owes(learnedFromData).edited], [true, false]);
  assert.throws(() => normalizePackage({ ...edited, provenance: { ...edited.provenance, learned: 'magic' } }), /trained" or "edited/);
});

test('IE5: in the junior\'s world, a recipe by program - the researcher\'s own method - makes a version learned from data, with the realizations of its examples; refused without an isolated backend', { skip: !python && 'no Python' }, async () => {
  const dir = tmp();
  const { pkg } = base(dir);
  const manifest = { format: 'junior-competence-manifest@1', id: 'prog', reference: executionHash(pkg),
    components: [{ id: 'a', rung: 1, mode: 'start', extractor: { id: 'probe', version: 1 }, unit: 'share', direction: 'up', target: 1, bad: 0, tolerance: 0 }],
    cases: [{ id: 'p0', kind: 'probe', partition: 'development', group: 'g-sel', component: 'a', lab: 'cells', mode: 'start', cut: { run: 'x.json', question: 0, hash: 'h' }, competence: 'protocol', instruction: 'i', checker: { id: 'protocol', version: 1 } }],
    investigation_repetitions: 1, execution: {}, sampling: { seed: 1 }, promotion: { procedure: 'paired-cases@1', alpha: 0.05, permutations: 1000, seed: 1 },
    limits: { junior_args: ['--max-tokens', '1000', '--max-judge-calls', '10'], probe_max_tokens: 500, timeout_ms: 60000 },
    weight_edits: { per_module: { max_changed_fraction: 1, max_relative_norm: 3, max_representation: 1000, max_rank: 8, max_sparse_entries: 100 }, total: { max_changed_fraction: 1, max_relative_norm: 3, max_representation: 1000 } } as WeightBounds
  } as unknown as CompetenceManifest;
  const make = (availability: Availability) => new JuniorWorld({ manifest, base: pkg, blobs: path.join(dir, 'blobs'), server: 'http://127.0.0.1:9', dir: path.join(dir, 'world'), evaluations: 4, edits: 4,
    programProfiles: [PROFILE], programAvailability: availability });
  const w = make(available);
  /* Its examples, cut from a run of seed 3, as distillation keeps them (with the capture of their run). */
  const capture = { experiment: 'cells@1', argv: ['--seed', '3', '--level', '1'], run_id: 'r3' };
  fs.mkdirSync(path.join(dir, 'world', 'examples'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'world', 'datasets'), { recursive: true });
  for (const [id, answer] of [['e1', 'a'], ['e2', 'b']]) fs.writeFileSync(path.join(dir, 'world', 'examples', id + '.json'), JSON.stringify({ id, state: 'verified', target: answer, group: 'g-train',
    input: { system: 's', user: { parts: ['u'] } }, teacher: { memory: { calls: [] } }, cut: { run: 'r.json', question: 0, hash: 'h', capture } }));
  const ds = 'd'.repeat(64);
  fs.writeFileSync(path.join(dir, 'world', 'datasets', ds + '.json'), JSON.stringify({ id: ds, examples: ['e1', 'e2'], groups: ['g-train'], admits: ['verified'] }));
  const recipe = { format: 'junior-recipe@1' as const, method: 'program' as const, program: program(), admits: ['verified' as const] };
  const t = await w.trainFrom(w.reference, ds, recipe, { why: 'a method I read about' });
  assert.equal(t.state, 'finished', String(t.reason));
  const child = await w.packageOf(t.version!);
  assert.ok(typeof child !== 'string');
  assert.equal(child.provenance.learned, 'trained', 'the host wrote what it learned');
  assert.deepEqual(child.provenance.realizations, [realizationOf('cells', capture.argv)]);
  assert.equal(owes(child).trained, true);
  assert.equal(w.jobs.bags().edits.spent, 1);
  /* Without an isolated backend: unavailable, nothing spent. */
  const none = make({ available: false, reason: 'this machine is win32' });
  const u = await none.trainFrom(none.reference, ds, { ...recipe, program: program({ seed: 9 }) }, { why: 'w' });
  assert.deepEqual([u.state, /win32/.test(String(u.reason))], ['unavailable', true]);
});

test('IE5: the isolated backend is never assumed - on this machine it is available only if its self-test proves it', async () => {
  const a = await isolatedBackend({ python: [python ?? 'python3'] });
  if (process.platform !== 'linux') assert.equal(a.available, false);
  else assert.ok(a.available || /did not prove|namespaces/.test(a.reason));
});
