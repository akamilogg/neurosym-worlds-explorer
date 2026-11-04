import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BlobStore, normalizePackage, type JuniorPackage } from '../src/junior/package.ts';
import { SessionServer } from '../src/junior/sessions.ts';
import { ProcessWorker } from '../src/junior/worker.ts';
import { JobLedger } from '../src/junior/jobs.ts';
import { competenceProblems } from '../src/junior/competence.ts';
import { queryProblems, WeightLab, weightLabProblems, type LabLimits, type WeightLabConfig } from '../src/junior/weight-lab.ts';
import { isolatedBackend, proves, type IsolatedBackend } from '../src/junior/isolation.ts';
import {
  baseReader, bf16Bits, bf16Value, compose, composeVersion, construct, editsInTree, INCOMPLETE, programEdit, putEdit, readSafetensors, tensorF32, tensorI64, verifyEditSet,
  verifyPrograms, writeSafetensors, type RawTensor, type WeightBounds
} from '../src/junior/weights.ts';

/* SPEC-EDICION-PESOS §4, WE2: the weight laboratory reads the junior on diagnosis cases only, each query charged and
   bounded, in the junior's queue; the closed constructors verified by running them again; free programs only with an
   isolated backend that proves its isolation. */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'junior-wlab-'));
const python = ['python', 'python3'].find((p) => spawnSync(p, ['--version']).status === 0);
const bf16 = (shape: number[], values: number[]): RawTensor => ({ dtype: 'BF16', shape, bytes: new Uint8Array(Uint16Array.from(values.map(bf16Bits)).buffer) });
const DOWN = 'model.layers.4.mlp.down_proj', Q = 'model.layers.5.self_attn.q_proj', CHIP = 'model.layers.1.mlp.down_proj';
const H = { competence: 'protocol', mechanism: 'a direction that derails the answer', effect: 'answers that keep to the protocol' };
const LAX: WeightBounds = { per_module: { max_changed_fraction: 1, max_relative_norm: 10, max_representation: 1000, max_rank: 8, max_sparse_entries: 100 },
  total: { max_changed_fraction: 1, max_relative_norm: 10, max_representation: 1000 } };
const LIMITS: LabLimits = { max_cases: 3, max_new_tokens: 64, max_tokens: 2000, max_slice_entries: 4, max_singular: 2, max_top_logits: 3, max_positions: 8, max_heads: 2,
  max_modules: 2, max_directions: 2, timeout_ms: 20_000, max_memory_bytes: 1 << 30, max_response_bytes: 100_000 };

function fixture() {
  const dir = tmp();
  const store = new BlobStore(path.join(dir, 'blobs'));
  const base = path.join(dir, 'base');
  fs.mkdirSync(base);
  fs.writeFileSync(path.join(base, 'chipformer.json'), JSON.stringify({ chip_layers: 2 }));
  fs.writeFileSync(path.join(base, 'tokenizer.json'), '{}');
  fs.writeFileSync(path.join(base, 'model.safetensors'), writeSafetensors({
    [DOWN + '.weight']: bf16([2, 2], [3, 0, 0, 1]),
    [Q + '.weight']: bf16([2, 3], [1, 2, 3, 4, 5, 6]),
    [CHIP + '.weight']: bf16([2, 2], [1, 1, 1, 1])
  }));
  const pkg = normalizePackage({ format: 'junior-package@1', name: 'start', base: store.putTree(base), prompt: '',
    execution: { firmware: store.put('f'), tokenizer: store.put('{}'), chat_template: store.put('c'), driver: store.put('d'), verifier: store.put('v'), circuit: { chip_layers: 2 }, precision: 'bf16' } });
  return { dir, store, pkg };
}

const weightsOf = (store: BlobStore, pkg: JuniorPackage, module: string) =>
  Array.from(compose(editsInTree(store, pkg.adapter!), baseReader(store, pkg.base)).weights[module], bf16Value);

/* --- The manifest and the limits ----------------------------------------------------------------------------------- */

test('diagnosis is disjoint from selection and confirmation: no group of a case, no run a probe cuts', () => {
  const cases = [{ id: 'p', kind: 'probe', group: 'g-sel', cut: { run: 'runs/a.json', question: 1, hash: 'h' } }, { id: 'i', kind: 'investigation', group: 'g-conf' }] as never;
  const ok: WeightLabConfig = { diagnosis: { 'g-diag': ['runs/b.json'] }, limits: LIMITS };
  assert.deepEqual(weightLabProblems(ok, { cases }), []);
  assert.match(weightLabProblems({ ...ok, diagnosis: { 'g-sel': ['runs/b.json'] } }, { cases }).join(), /never share/);
  assert.match(weightLabProblems({ ...ok, diagnosis: { 'g-conf': ['runs/b.json'] } }, { cases }).join(), /never share/);
  assert.match(weightLabProblems({ ...ok, diagnosis: { 'g-diag': ['runs/a.json'] } }, { cases }).join(), /cut by a probe/);
  assert.match(weightLabProblems({ ...ok, limits: { ...LIMITS, max_cases: 0 } }, { cases }).join(), /max_cases/);
  assert.ok(competenceProblems({ format: 'junior-competence-manifest@1', cases, weight_lab: { diagnosis: { 'g-sel': ['x'] }, limits: LIMITS } }).some((p) => /never share/.test(p)));
});

test('a query outside its limits is refused before it is sent', () => {
  const text = { text: { user: 'hi' } };
  assert.deepEqual(queryProblems({ query: 'weights.slice', args: { module: DOWN, rows: [0, 2], cols: [0, 2] } }, LIMITS), []);
  assert.match(queryProblems({ query: 'weights.slice', args: { module: DOWN, rows: [0, 3], cols: [0, 2] } }, LIMITS).join(), /at most 4 entries/);
  assert.match(queryProblems({ query: 'forward', cases: [text, text, text, text] }, LIMITS).join(), /between 1 and 3/);
  assert.match(queryProblems({ query: 'forward', cases: [text], args: { top_logits: 9 } }, LIMITS).join(), /top_logits/);
  assert.match(queryProblems({ query: 'activations', cases: [text], args: { modules: [DOWN, Q, CHIP] } }, LIMITS).join(), /modules/);
  assert.match(queryProblems({ query: 'attention', cases: [text], args: { layer: 3, heads: [0, 1, 2] } }, LIMITS).join(), /heads/);
  assert.match(queryProblems({ query: 'try', args: { inner: 'forward' }, cases: [text] }, LIMITS).join(), /candidate/);
  assert.match(queryProblems({ query: 'weights.stats', args: { module: DOWN, singular: 5 } }, LIMITS).join(), /singular/);
});

/* --- The lab on the fake worker ------------------------------------------------------------------------------------ */

function labOn(f: ReturnType<typeof fixture>, o: { limits?: Partial<LabLimits>; bags?: Record<string, number>; probeHash?: string } = {}) {
  const worker = new ProcessWorker({ python: [python!], backend: 'fake', work: path.join(f.dir, 'work') });
  const labWorker = new ProcessWorker({ python: [python!], backend: 'fake', work: path.join(f.dir, 'lab-work') });
  const server = new SessionServer({ root: path.join(f.dir, 'srv'), store: f.store, worker, labWorker });
  const ledger = new JobLedger(path.join(f.dir, 'jobs.jsonl'), o.bags ?? { lab_queries: 20, lab_tokens: 100_000 });
  const diagRun = path.join(f.dir, 'runs', 'diag.json');
  const cases = [{ id: 'p', kind: 'probe', group: 'g-sel', cut: { run: path.join(f.dir, 'runs', 'sel.json'), question: 1, hash: o.probeHash ?? 'probe-hash' } }] as never;
  const lab = new WeightLab({ config: { diagnosis: { 'g-diag': [diagRun] }, limits: { ...LIMITS, ...o.limits } }, manifest: { cases }, service: server, ledger, store: f.store,
    cutter: async (run, question) => ({ content: { system: 'S', user: { parts: ['the cut of ' + path.basename(run) + ' at ' + question] } }, hash: question === 9 ? 'probe-hash' : 'cut-' + question }) });
  return { server, ledger, lab, diagRun };
}

test('the lab reads the junior: modules, statistics and slices, the circuit readable but never editable', { skip: !python && 'no Python' }, async () => {
  const f = fixture();
  const { server, ledger, lab } = labOn(f);
  try {
    const mods = await lab.query(f.pkg, { query: 'modules' }, 'q1');
    assert.ok(!('refused' in mods) && mods.state === 'answered', JSON.stringify(mods));
    const list = (lab.answer(mods) as { modules: { name: string; editable: boolean }[] }).modules;
    assert.deepEqual(list.map((m) => [m.name, m.editable]), [[CHIP, false], [DOWN, true], [Q, true]]);
    const stats = await lab.query(f.pkg, { query: 'weights.stats', args: { module: DOWN, singular: 2 } }, 'q2');
    assert.ok(!('refused' in stats));
    const s = lab.answer(stats) as { norm: number; singular: number[] };
    assert.ok(Math.abs(s.norm - Math.sqrt(10)) < 1e-9 && Math.abs(s.singular[0] - 3) < 1e-6 && Math.abs(s.singular[1] - 1) < 1e-6, JSON.stringify(s));
    const slice = await lab.query(f.pkg, { query: 'weights.slice', args: { module: Q, rows: [1, 2], cols: [0, 3] } }, 'q3');
    assert.ok(!('refused' in slice));
    assert.deepEqual((lab.answer(slice) as { values: number[][] }).values, [[4, 5, 6]]);
    assert.equal(ledger.bags().lab_queries.spent, 3);
    assert.equal(ledger.bags().lab_tokens.spent, 0, 'reading weights spends no tokens');
  } finally { server.stop(); }
});

test('forward on diagnosis cases only, each query charged once with its receipt; a probe\'s cut and a run outside diagnosis are refused', { skip: !python && 'no Python' }, async () => {
  const f = fixture();
  const { server, ledger, lab, diagRun } = labOn(f);
  try {
    const r = await lab.query(f.pkg, { query: 'forward', cases: [{ text: { user: 'hello' } }, { cut: { run: diagRun, question: 2 } }], args: { top_logits: 2 } }, 'fw');
    assert.ok(!('refused' in r) && r.state === 'answered', JSON.stringify(r));
    assert.deepEqual(r.cases.map((c) => c.source), ['text', 'cut']);
    assert.equal(r.cases[1].group, 'g-diag');
    const answers = (lab.answer(r) as { cases: { text: string; top: unknown[] }[] }).cases;
    assert.match(answers[0].text, /^answer [0-9a-f]{8}/);
    assert.equal((answers[0].top[0] as unknown[]).length, 2);
    const tokens = r.usage!.tokens_in + r.usage!.tokens_out;
    assert.deepEqual([ledger.bags().lab_queries.spent, ledger.bags().lab_tokens.spent], [1, tokens]);
    const again = await lab.query(f.pkg, { query: 'forward', cases: [{ text: { user: 'hello' } }, { cut: { run: diagRun, question: 2 } }], args: { top_logits: 2 } }, 'fw');
    assert.deepEqual(again, r, 'asked again, the same receipt');
    assert.deepEqual([ledger.bags().lab_queries.spent, ledger.bags().lab_tokens.spent], [1, tokens], 'never charged twice');
    const outside = await lab.query(f.pkg, { query: 'forward', cases: [{ cut: { run: path.join(f.dir, 'runs', 'sel.json'), question: 1 } }] }, 'sel');
    assert.ok('refused' in outside && /not a diagnosis run/.test(outside.refused));
    const probe = await lab.query(f.pkg, { query: 'forward', cases: [{ cut: { run: diagRun, question: 9 } }] }, 'probe');
    assert.ok('refused' in probe && /probe that selects/.test(probe.refused));
    assert.equal(ledger.bags().lab_queries.spent, 1, 'a refused query costs nothing');
  } finally { server.stop(); }
});

test('the bags bound the lab, an answer past its size is withheld but charged, and a query past its time is stopped, its tokens uncertain', { skip: !python && 'no Python' }, async () => {
  const f = fixture();
  const small = labOn(f, { bags: { lab_queries: 1, lab_tokens: 100_000 } });
  try {
    assert.ok(!('refused' in await small.lab.query(f.pkg, { query: 'modules' }, 'a')));
    const none = await small.lab.query(f.pkg, { query: 'modules' }, 'b');
    assert.ok('refused' in none && /lab_queries/.test(none.refused));
  } finally { small.server.stop(); }
  const g = fixture();
  const tight = labOn(g, { limits: { max_response_bytes: 10, timeout_ms: 1500 } });
  try {
    const big = await tight.lab.query(g.pkg, { query: 'modules' }, 'big');
    assert.ok(!('refused' in big) && big.state === 'over_limit' && big.result === null, JSON.stringify(big));
    assert.equal(tight.ledger.bags().lab_queries.spent, 1);
    const slow = await tight.lab.query(g.pkg, { query: 'forward', cases: [{ text: { user: 'sleep 5' } }] }, 'slow');
    assert.ok(!('refused' in slow) && slow.state === 'timeout', JSON.stringify(slow));
    assert.equal(tight.ledger.get('slow')!.state, 'completed');
    assert.equal(tight.ledger.bags().lab_tokens.uncertain, LIMITS.max_tokens, 'what it consumed cannot be told: its reservation stays');
    const after = await tight.lab.query(g.pkg, { query: 'forward', cases: [{ text: { user: 'quick' } }] }, 'after');
    assert.ok(!('refused' in after) && after.state === 'over_limit' && after.usage !== null, 'a new process serves the next query (its answer, again too large, withheld)');
  } finally { tight.server.stop(); }
});

test('activations recorded, a mean_difference built from them, composed and verified with the files in its tree; try runs a candidate on a copy', { skip: !python && 'no Python' }, async () => {
  const f = fixture();
  const { server, lab } = labOn(f);
  try {
    const a = await lab.query(f.pkg, { query: 'activations', cases: [{ text: { user: 'keeps to the protocol' } }, { text: { user: 'answers in JSON' } }], args: { modules: [DOWN] } }, 'acts-a');
    const b = await lab.query(f.pkg, { query: 'activations', cases: [{ text: { user: 'thinks aloud first' } }], args: { modules: [DOWN] } }, 'acts-b');
    assert.ok(!('refused' in a) && !('refused' in b) && a.files['activations.safetensors'], JSON.stringify(a));
    const acts = readSafetensors(f.store.get(a.files['activations.safetensors']))[DOWN];
    assert.deepEqual(acts.shape, [2, 2]);
    const made = lab.construct(f.pkg, { constructor: 'mean_difference@1', args: { module: DOWN, a: ['a.safetensors'], b: ['b.safetensors'], alpha: -1 },
      inputs: { 'a.safetensors': { from: 'acts-a', file: 'activations.safetensors' }, 'b.safetensors': { from: 'acts-b', file: 'activations.safetensors' } }, hypothesis: H, authorship: 'strong' });
    assert.ok('id' in made, JSON.stringify(made));
    const v = composeVersion({ store: f.store, parent: f.pkg, add: [made.id], authorized: LAX });
    assert.ok('child' in v, JSON.stringify(v));
    assert.deepEqual(verifyEditSet(f.store, v.child), [], 'the constructor run again with the activations that travel in the tree');
    assert.ok('problems' in lab.construct(f.pkg, { constructor: 'mean_difference@1', args: { module: DOWN, a: ['a'], b: ['b'], alpha: -1 },
      inputs: { a: { from: 'nope', file: 'activations.safetensors' }, b: { from: 'acts-b', file: 'activations.safetensors' } }, hypothesis: H, authorship: 'strong' }));
    const plain = await lab.query(f.pkg, { query: 'forward', cases: [{ text: { user: 'hello' } }] }, 'plain');
    const tried = await lab.query(f.pkg, { query: 'try', candidate: v.child, args: { inner: 'forward', args: {} }, cases: [{ text: { user: 'hello' } }] }, 'tried');
    assert.ok(!('refused' in plain) && !('refused' in tried) && tried.state === 'answered', JSON.stringify(tried));
    assert.notEqual((lab.answer(tried) as { cases: { text: string }[] }).cases[0].text, (lab.answer(plain) as { cases: { text: string }[] }).cases[0].text, 'the candidate answers with its weights');
    const back = await lab.query(f.pkg, { query: 'forward', cases: [{ text: { user: 'hello' } }] }, 'back');
    assert.ok(!('refused' in back));
    assert.equal((lab.answer(back) as { cases: { text: string }[] }).cases[0].text, (lab.answer(plain) as { cases: { text: string }[] }).cases[0].text, 'the junior itself untouched');
    const noSet = await lab.query(f.pkg, { query: 'try', candidate: f.pkg, args: { inner: 'forward', args: {} }, cases: [{ text: { user: 'x' } }] }, 'noset');
    assert.ok('refused' in noSet && /no set of edits/.test(noSet.refused));
  } finally { server.stop(); }
});

/* --- The closed constructors ---------------------------------------------------------------------------------------- */

test('the closed constructors check their arguments, fix their arithmetic and are verified by running them again', () => {
  const f = fixture();
  const ctor = (name: string, args: Record<string, unknown>, inputs: Record<string, Buffer> = {}) => construct(f.store, f.pkg, { constructor: name, args, inputs, hypothesis: H, authorship: 'strong' });
  const top = ctor('top_singular@1', { module: DOWN, k: 1, alpha: -1 });
  assert.ok('id' in top, JSON.stringify(top));
  const v1 = composeVersion({ store: f.store, parent: f.pkg, add: [top.id], authorized: LAX });
  assert.ok('child' in v1);
  assert.deepEqual(weightsOf(f.store, v1.child, DOWN), [0, 0, 0, 1], 'diag(3, 1) without its first singular direction');
  const rows = ctor('scale_rows@1', { module: Q, rows: [1], alpha: -0.5 });
  const cols = ctor('scale_cols@1', { module: Q, cols: [0, 2], alpha: 1 });
  assert.ok('id' in rows && 'id' in cols);
  const v2 = composeVersion({ store: f.store, parent: f.pkg, add: [rows.id, cols.id], authorized: LAX });
  assert.ok('child' in v2);
  assert.deepEqual(weightsOf(f.store, v2.child, Q), [2, 2, 6, 6, 2.5, 9], "each from the start: row 1 halved, columns 0 and 2 doubled, summed");
  const uv = writeSafetensors({ u: tensorF32([2], [0, 2]), v: tensorF32([2], [3, 4]) });
  const add = ctor('add_direction@1', { module: DOWN, alpha: 5 }, { 'uv.safetensors': uv });
  assert.ok('id' in add, JSON.stringify(add));
  const v3 = composeVersion({ store: f.store, parent: f.pkg, add: [add.id], authorized: LAX });
  assert.ok('child' in v3);
  assert.deepEqual(weightsOf(f.store, v3.child, DOWN), [3, 0, 3, 5], 'u and v normalized: 5·[0,1]ᵀ·[0.6,0.8]');
  for (const v of [v1, v2, v3]) assert.deepEqual(verifyEditSet(f.store, (v as { child: JuniorPackage }).child), []);
  // Wrong arguments refuse the edit.
  assert.ok('problems' in ctor('top_singular@1', { module: DOWN, k: 3, alpha: -1 }));
  assert.ok('problems' in ctor('scale_rows@1', { module: Q, rows: [1, 0], alpha: 2 }));
  assert.ok('problems' in ctor('scale_cols@1', { module: Q, cols: [0], alpha: 0 }));
  assert.ok('problems' in ctor('add_direction@1', { module: DOWN, alpha: 1 }, { 'uv.safetensors': writeSafetensors({ u: tensorF32([2], [0, 0]), v: tensorF32([2], [1, 0]) }) }));
  assert.ok('problems' in ctor('mean_difference@1', { module: DOWN, a: ['x'], b: ['x'], alpha: -1 }, { x: writeSafetensors({ [DOWN]: tensorF32([1, 2], [1, 2]) }) }));
  const same = writeSafetensors({ [DOWN]: tensorF32([1, 2], [1, 2]) });
  assert.match(JSON.stringify(ctor('mean_difference@1', { module: DOWN, a: ['x'], b: ['y'], alpha: -1 }, { x: same, y: same })), /null vector/);
  assert.ok('problems' in ctor('top_singular@1', { module: CHIP, k: 1, alpha: -1 }), 'never the circuit');
  // The same constructor with the same inputs gives the same edit.
  const again = ctor('top_singular@1', { module: DOWN, k: 1, alpha: -1 });
  assert.ok('id' in again && again.id === top.id);
});

/* --- Free programs -------------------------------------------------------------------------------------------------- */

test('a free program needs an isolated backend that proves itself: refused here without one, its self-test read strictly', async () => {
  assert.deepEqual(await isolatedBackend({ python: ['python'], platform: 'win32' }), { available: false, reason: 'isolation needs Linux namespaces and Landlock; this machine is win32' });
  assert.equal(proves({ landlock_abi: 3, network: 'refused: OSError', write_outside: 'refused: PermissionError', write_base: 'refused: PermissionError', write_inside: 'done', read_base: 'done' }), null);
  assert.match(proves({ landlock_abi: 3, network: 'done', write_outside: 'refused: PermissionError', write_base: 'refused: PermissionError', write_inside: 'done', read_base: 'done' })!, /no network/);
  assert.match(proves({ landlock_abi: 0, error: 'this kernel has no Landlock' })!, /Landlock/);
  const f = fixture();
  const refused = await programEdit(f.store, f.pkg, { code: 'print(1)', inputs: {}, backend: null, baseDir: '.', limits: { timeout_ms: 1, memory_bytes: 1, cpu_seconds: 1, output_bytes: 1 }, hypothesis: H, authorship: 'strong' });
  assert.ok('problems' in refused && /isolated backend/.test(refused.problems.join()));
  assert.ok('problems' in putEdit(f.store, { modules: [{ module: DOWN, encoding: 'sparse', shape: [2, 2], tensors: { indices: tensorI64([0]), values: tensorF32([1], [1]) } }], hypothesis: H, authorship: 'strong',
    origin: { kind: 'program', backend: 'x', base: f.pkg.base, inputs: {} } }, 2), 'nor stored as such past programEdit');
});

test('a program edit records its code as an input; verified only by running it again in its backend, incomplete without one', async () => {
  const f = fixture();
  const limits = { timeout_ms: 1000, memory_bytes: 1 << 28, cpu_seconds: 5, output_bytes: 1 << 20 };
  /* A stand-in of an isolated backend: it "runs" the program by reading its one instruction, a value for entry 0. */
  const backend = (scale: number): IsolatedBackend => ({ id: 'stand-in@1', async run(o) {
    const v = Number(/value=(\S+)/.exec(o.code)![1]) * scale;
    return { state: 'finished', reason: null, wall_ms: 1, outputs: {
      'modules.json': Buffer.from(JSON.stringify([{ module: DOWN, encoding: 'sparse', shape: [2, 2], file: 'd.safetensors' }])),
      'd.safetensors': writeSafetensors({ indices: tensorI64([0]), values: tensorF32([1], [v]) }) } };
  } });
  const made = await programEdit(f.store, f.pkg, { code: 'value=0.5', inputs: { 'notes.txt': Buffer.from('n') }, backend: backend(1), baseDir: '.', limits, hypothesis: H, authorship: 'strong' });
  assert.ok('id' in made, JSON.stringify(made));
  const v = composeVersion({ store: f.store, parent: f.pkg, add: [made.id], authorized: LAX });
  assert.ok('child' in v, JSON.stringify(v));
  const plain = verifyEditSet(f.store, v.child);
  assert.equal(plain.length, 1);
  assert.ok(plain[0].startsWith(INCOMPLETE), plain[0]);
  assert.deepEqual(await verifyPrograms(f.store, v.child, backend(1), '.', limits), []);
  assert.match((await verifyPrograms(f.store, v.child, backend(2), '.', limits)).join(), /does not give its values/);
});

test('on a Linux machine whose isolation proves itself, a program runs with no network and writes only in its folder', { skip: process.platform !== 'linux' && 'not Linux' }, async () => {
  const a = await isolatedBackend({ python: [python ?? 'python3'] });
  if (!a.available) { assert.ok(a.reason.length > 0); return; }
  const base = tmp();
  fs.writeFileSync(path.join(base, 'w'), 'weights');
  const r = await a.backend.run({ code: 'import socket\ntry:\n  socket.create_connection(("1.1.1.1", 53), 2)\n  open("out/net", "w").write("reached")\nexcept OSError:\n  open("out/net", "w").write("refused")\n',
    inputs: {}, base, limits: { timeout_ms: 20_000, memory_bytes: 1 << 30, cpu_seconds: 10, output_bytes: 1 << 20 } });
  assert.equal(r.state, 'finished', r.reason ?? '');
  assert.equal(r.outputs.net.toString(), 'refused');
});
