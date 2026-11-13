import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BlobStore, executionHash, normalizePackage } from '../src/junior/package.ts';
import type { Availability, IsolatedBackend } from '../src/junior/isolation.ts';
import { importAdapter, importProduct, loraProblems, baseDimsOf, runMethodProgram, type ExecutionProfile, type MethodProgram } from '../src/junior/method-program.ts';
import { owes } from '../src/junior/confirm.ts';
import { realizationOf } from '../src/junior/groups.ts';
import { JuniorWorld } from '../src/worlds/junior/lab.ts';
import type { CompetenceManifest } from '../src/junior/competence.ts';

/* SPEC-INVESTIGACION-EXTERNA §8.2, IE5: a LoRA adapter a program made, imported as the adapter of a child of the start -
   checked from its config and its tensors' header (read without its data): a plain LoRA, only layers past the circuit, its
   rank the config's, its shapes the base's. The backend here hands back what the program would have written: the contract
   and the import are tested, not the isolation (proved by its own self-test, on Linux). */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'program-lora-'));
/** A safetensors file of zeros: its header says what each tensor is. */
function st(tensors: Record<string, { dtype?: string; shape: number[] }>): Buffer {
  let off = 0;
  const hdr: Record<string, unknown> = {};
  for (const [n, t] of Object.entries(tensors)) {
    const bytes = t.shape.reduce((a, b) => a * b, 1) * (t.dtype === 'F32' ? 4 : 2);
    hdr[n] = { dtype: t.dtype ?? 'BF16', shape: t.shape, data_offsets: [off, off + bytes] };
    off += bytes;
  }
  let h = Buffer.from(JSON.stringify(hdr));
  h = Buffer.concat([h, Buffer.alloc((8 - (h.length % 8)) % 8, 0x20)]);
  const len = Buffer.alloc(8); len.writeBigUInt64LE(BigInt(h.length));
  return Buffer.concat([len, h, Buffer.alloc(off)]);
}
/* A base of 6 layers (the circuit's first 2): hidden 4, intermediate 8, 2 heads of 2, 1 key-value head. */
const CONFIG = { num_hidden_layers: 6, hidden_size: 4, intermediate_size: 8, num_attention_heads: 2, num_key_value_heads: 1, head_dim: 2 };
const MLP = new Set(['gate_proj', 'up_proj', 'down_proj']);
const L = (layer: number, mod: string, ab: 'A' | 'B') => 'base_model.model.model.layers.' + layer + '.' + (MLP.has(mod) ? 'mlp' : 'self_attn') + '.' + mod + '.lora_' + ab + '.weight';
const GOOD = { [L(4, 'down_proj', 'A')]: { shape: [2, 8] }, [L(4, 'down_proj', 'B')]: { shape: [4, 2] }, [L(5, 'k_proj', 'A')]: { shape: [2, 4] }, [L(5, 'k_proj', 'B')]: { shape: [2, 2] } };
const cfg = (over: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({ peft_type: 'LORA', r: 2, lora_alpha: 4, target_modules: ['down_proj', 'k_proj'], bias: 'none', modules_to_save: null, ...over }));
const products = (weights: Buffer = st(GOOD), config: Buffer = cfg()): Record<string, Buffer> => ({ 'adapter_config.json': config, 'adapter_model.safetensors': weights });

function base(dir: string) {
  const store = new BlobStore(path.join(dir, 'blobs'));
  const b = path.join(dir, 'base');
  fs.mkdirSync(b);
  fs.writeFileSync(path.join(b, 'config.json'), JSON.stringify(CONFIG));
  fs.writeFileSync(path.join(b, 'chipformer.json'), JSON.stringify({ chip_layers: 2 }));
  const pkg = normalizePackage({ format: 'junior-package@1', name: 'start', base: store.putTree(b), prompt: '',
    execution: { firmware: store.put('f'), tokenizer: store.put('{}'), chat_template: store.put('c'), driver: store.put('d'), verifier: store.put('v'), circuit: { chip_layers: 2 }, precision: 'bf16' } });
  return { store, pkg, baseDir: b };
}
/** A backend that answers what the program would have written in out/. */
const handing = (out: Record<string, Buffer>): Availability => ({ available: true, proof: { stand_in: true }, backend: { id: 'test-handing', async run() {
  return { state: 'finished', outputs: { ...out, 'result.json': Buffer.from(JSON.stringify({ format: 'lora-adapter', products: Object.keys(out) })) }, reason: null, wall_ms: 1 };
} } as unknown as IsolatedBackend });
const PROFILE: ExecutionProfile = { id: 'cpu-small', dependencies: { python: '3' }, limits: { timeout_ms: 30_000, memory_bytes: 1 << 28, cpu_seconds: 30, output_bytes: 1 << 20 }, gpu: false };
const program = (over: Partial<MethodProgram> = {}): MethodProgram => ({ format: 'method-program@1', entrypoint: 'main.py', files: { 'main.py': '# a LoRA trained as the paper says' },
  profile: 'cpu-small', inputs: ['dataset.jsonl'], parameters: {}, seed: 1, output_format: 'lora-adapter', ...over });
const rows = Buffer.from(JSON.stringify({ id: 'e1', system: 's', user: ['u'], calls: [], answer: 'a' }) + '\n');

test('IE5: a LoRA adapter is checked from its config and its header - the circuit, other modules, other ranks, shapes and anything saved whole refused', () => {
  const dims = baseDimsOf(CONFIG);
  assert.deepEqual(dims, { layers: 6, hidden: 4, intermediate: 8, q: 4, kv: 2 });
  assert.deepEqual(loraProblems(products(), 2, dims), []);
  assert.match(loraProblems(products(st({ ...GOOD, [L(1, 'down_proj', 'A')]: { shape: [2, 8] }, [L(1, 'down_proj', 'B')]: { shape: [4, 2] } })), 2, dims).join(), /circuit/);
  assert.match(loraProblems(products(st({ ...GOOD, [L(4, 'q_proj', 'A')]: { shape: [2, 4] }, [L(4, 'q_proj', 'B')]: { shape: [4, 2] } })), 2, dims).join(), /q_proj is not among its target_modules/);
  assert.match(loraProblems(products(st({ [L(4, 'down_proj', 'A')]: { shape: [3, 8] }, [L(4, 'down_proj', 'B')]: { shape: [4, 3] } })), 2, dims).join(), /rank is not r 2/);
  assert.match(loraProblems(products(st({ [L(4, 'down_proj', 'A')]: { shape: [2, 4] }, [L(4, 'down_proj', 'B')]: { shape: [4, 2] } })), 2, dims).join(), /do not fit the base down_proj \(8 in, 4 out\)/);
  assert.match(loraProblems(products(st({ ...GOOD, 'base_model.model.lm_head.weight': { shape: [4, 4] } })), 2, dims).join(), /lm_head.weight: not a lora_A or lora_B/);
  assert.match(loraProblems(products(st({ [L(4, 'down_proj', 'A')]: { shape: [2, 8] } })), 2, dims).join(), /go together/);
  assert.match(loraProblems(products(undefined, cfg({ modules_to_save: ['lm_head'] })), 2, dims).join(), /saves no module whole/);
  assert.match(loraProblems(products(undefined, cfg({ peft_type: 'IA3' })), 2, dims).join(), /another method/);
  assert.match(loraProblems(products(undefined, cfg({ target_modules: ['embed_tokens'] })), 2, dims).join(), /target_modules/);
  assert.match(loraProblems({ ...products(), 'extra.bin': Buffer.from('x') }, 2, dims).join(), /not the adapter: extra.bin/);
  assert.match(loraProblems(products(Buffer.from('nope')), 2, dims).join(), /safetensors/);
  /* Without the base's dimensions, its layers and rank still checked. */
  assert.deepEqual(loraProblems(products(), 2, null), []);
});

test('IE5: a program\'s LoRA imported as the adapter of a child of the start - never as an edit, never on a start that has one', async () => {
  const dir = tmp();
  const { store, pkg, baseDir } = base(dir);
  const job = await runMethodProgram({ program: program(), profiles: [PROFILE], inputs: { 'dataset.jsonl': rows }, start: executionHash(pkg), startDir: baseDir, availability: handing(products()) });
  assert.equal(job.state, 'finished', String(job.reason));
  const a = importAdapter(store, pkg, job);
  assert.ok('adapter' in a, JSON.stringify(a));
  assert.deepEqual(Object.keys(store.tree(a.adapter)!.files).sort(), ['adapter_config.json', 'adapter_model.safetensors']);
  assert.match((importProduct(store, pkg, job, { program: program(), backend: 'x', hypothesis: { competence: 'c', mechanism: 'm', effect: 'e' } }) as { problems: string[] }).problems[0], /not an edit/);
  assert.match((importAdapter(store, normalizePackage({ ...pkg, adapter: a.adapter }), job) as { problems: string[] }).problems[0], /already has an adapter/);
  const bad = await runMethodProgram({ program: program(), profiles: [PROFILE], inputs: { 'dataset.jsonl': rows }, start: executionHash(pkg), startDir: baseDir,
    availability: handing(products(st({ [L(0, 'down_proj', 'A')]: { shape: [2, 8] }, [L(0, 'down_proj', 'B')]: { shape: [4, 2] } }))) });
  assert.match((importAdapter(store, pkg, bad) as { problems: string[] }).problems.join(), /circuit/);
});

test('IE5: in the junior\'s world, a recipe by program that makes a LoRA - a version whose adapter is the program\'s, learned from data as the host says, with the realizations of its examples', async () => {
  const dir = tmp();
  const { pkg } = base(dir);
  const manifest = { format: 'junior-competence-manifest@1', id: 'prog', reference: executionHash(pkg),
    components: [{ id: 'a', rung: 1, mode: 'start', extractor: { id: 'probe', version: 1 }, unit: 'share', direction: 'up', target: 1, bad: 0, tolerance: 0 }],
    cases: [{ id: 'p0', kind: 'probe', partition: 'development', group: 'g-sel', component: 'a', lab: 'cells', mode: 'start', cut: { run: 'x.json', question: 0, hash: 'h' }, competence: 'protocol', instruction: 'i', checker: { id: 'protocol', version: 1 } }],
    investigation_repetitions: 1, execution: {}, sampling: { seed: 1 }, promotion: { procedure: 'paired-cases@1', alpha: 0.05, permutations: 1000, seed: 1 },
    limits: { junior_args: ['--max-tokens', '1000', '--max-judge-calls', '10'], probe_max_tokens: 500, timeout_ms: 60000 }
  } as unknown as CompetenceManifest;
  const w = new JuniorWorld({ manifest, base: pkg, blobs: path.join(dir, 'blobs'), server: 'http://127.0.0.1:9', dir: path.join(dir, 'world'), evaluations: 4, edits: 4,
    programProfiles: [PROFILE], programAvailability: handing(products()) });
  const capture = { experiment: 'cells@1', argv: ['--seed', '3', '--level', '1'], run_id: 'r3' };
  fs.mkdirSync(path.join(dir, 'world', 'examples'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'world', 'datasets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'world', 'examples', 'e1.json'), JSON.stringify({ id: 'e1', state: 'verified', target: 'a', group: 'g-train',
    input: { system: 's', user: { parts: ['u'] } }, teacher: { memory: { calls: [] } }, cut: { run: 'r.json', question: 0, hash: 'h', capture } }));
  const ds = 'e'.repeat(64);
  fs.writeFileSync(path.join(dir, 'world', 'datasets', ds + '.json'), JSON.stringify({ id: ds, examples: ['e1'], groups: ['g-train'], admits: ['verified'] }));
  const t = await w.trainFrom(w.reference, ds, { format: 'junior-recipe@1', method: 'program', program: program(), admits: ['verified'] }, { why: 'a LoRA as a paper trains it' });
  assert.equal(t.state, 'finished', String(t.reason));
  const child = await w.packageOf(t.version!);
  assert.ok(typeof child !== 'string', String(child));
  assert.ok(child.adapter, 'its adapter is the program\'s');
  assert.equal(child.provenance.learned, 'trained');
  assert.deepEqual(child.provenance.realizations, [realizationOf('cells', capture.argv)]);
  assert.equal(owes(child).trained, true);
});

test('IE5: checkpoint/ - kept for the job whatever its end, given back only to the same job identity; one over its bound leaves the one before', async () => {
  const { checkpointIn, checkpointOut } = await import('../src/junior/isolation.ts');
  const dir = tmp();
  const { pkg, baseDir } = base(dir);
  const seen: { checkpoint?: string; step: number }[] = [];
  /* A program that stops at its first run (out of time) having checkpointed, and goes on from there at the next. */
  const resuming: Availability = { available: true, proof: { stand_in: true }, backend: { id: 'test-resuming', async run(o: { checkpoint?: string }) {
    const work = tmp();
    checkpointIn(o.checkpoint, work);
    const f = path.join(work, 'checkpoint', 'step.json');
    const step = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).step : 0;
    seen.push({ ...(o.checkpoint ? { checkpoint: o.checkpoint } : {}), step });
    fs.writeFileSync(f, JSON.stringify({ step: step + 1 }));
    checkpointOut(work, o.checkpoint, 1000);
    if (step === 0) return { state: 'timeout', outputs: {}, reason: 'its time ran out', wall_ms: 1 };
    return { state: 'finished', outputs: { ...products(), 'result.json': Buffer.from(JSON.stringify({ format: 'lora-adapter', products: ['adapter_config.json', 'adapter_model.safetensors'] })) }, reason: null, wall_ms: 1 };
  } } as unknown as IsolatedBackend };
  const go = (p: MethodProgram) => runMethodProgram({ program: p, profiles: [PROFILE], inputs: { 'dataset.jsonl': rows }, start: executionHash(pkg), startDir: baseDir, availability: resuming, checkpoints: path.join(dir, 'ck') });
  assert.equal((await go(program())).state, 'timeout');
  const again = await go(program());
  assert.equal(again.state, 'finished', 'the same job went on from its checkpoint');
  assert.equal(seen[1].step, 1);
  assert.equal(seen[0].checkpoint, seen[1].checkpoint);
  /* Another identity (its seed): another job, from nothing. */
  assert.equal((await go(program({ seed: 2 }))).state, 'timeout');
  assert.notEqual(seen[2].checkpoint, seen[0].checkpoint);
  assert.equal(seen[2].step, 0);
  /* Over its bound: the one before stays. */
  const host = path.join(dir, 'bound'), work = tmp();
  fs.mkdirSync(host); fs.writeFileSync(path.join(host, 'a'), 'before');
  checkpointIn(host, work);
  fs.writeFileSync(path.join(work, 'checkpoint', 'a'), 'x'.repeat(50));
  assert.match(String(checkpointOut(work, host, 10)), /more than 10 bytes/);
  assert.equal(fs.readFileSync(path.join(host, 'a'), 'utf8'), 'before');
  assert.equal(checkpointOut(work, host, 100), null);
  assert.equal(fs.readFileSync(path.join(host, 'a'), 'utf8'), 'x'.repeat(50));
});
