import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BlobStore, executionHash, normalizePackage } from '../src/junior/package.ts';
import { SessionServer } from '../src/junior/sessions.ts';
import { serveJunior } from '../src/junior/http.ts';
import { ProcessWorker } from '../src/junior/worker.ts';
import { owes } from '../src/junior/confirm.ts';
import type { CompetenceManifest } from '../src/junior/competence.ts';
import type { LabLimits } from '../src/junior/weight-lab.ts';
import { bf16Bits, readEditSet, verifyEditSet, writeSafetensors, type RawTensor, type WeightBounds } from '../src/junior/weights.ts';
import { juniorLab, JuniorWorld, type JuniorAct, type JuniorSpec } from '../src/worlds/junior/lab.ts';

/* SPEC-EDICION-PESOS §5, WE3: the lever in the junior's world - inspect_weights reads the junior through the lab, edit
   makes a child with one edit more, paid from `edits` only when a version is made; the confirmation declares `edited`. */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'junior-wedit-'));
const python = ['python', 'python3'].find((p) => spawnSync(p, ['--version']).status === 0);
const bf16 = (shape: number[], values: number[]): RawTensor => ({ dtype: 'BF16', shape, bytes: new Uint8Array(Uint16Array.from(values.map(bf16Bits)).buffer) });
const DOWN = 'model.layers.4.mlp.down_proj', CHIP = 'model.layers.1.mlp.down_proj';
const BOUNDS: WeightBounds = { per_module: { max_changed_fraction: 1, max_relative_norm: 10, max_representation: 1000, max_rank: 4, max_sparse_entries: 2 },
  total: { max_changed_fraction: 1, max_relative_norm: 10, max_representation: 1000 } };
const LIMITS: LabLimits = { max_cases: 2, max_new_tokens: 64, max_tokens: 2000, max_slice_entries: 16, max_singular: 2, max_top_logits: 2, max_positions: 8, max_heads: 2,
  max_modules: 2, max_directions: 2, timeout_ms: 20_000, max_memory_bytes: 1 << 30, max_response_bytes: 100_000 };

async function fixture(o: { edits?: boolean } = {}) {
  const dir = tmp();
  const store = new BlobStore(path.join(dir, 'blobs'));
  const base = path.join(dir, 'base');
  fs.mkdirSync(base);
  fs.writeFileSync(path.join(base, 'chipformer.json'), JSON.stringify({ chip_layers: 2 }));
  fs.writeFileSync(path.join(base, 'tokenizer.json'), '{}');
  fs.writeFileSync(path.join(base, 'model.safetensors'), writeSafetensors({ [DOWN + '.weight']: bf16([2, 2], [3, 0, 0, 1]), [CHIP + '.weight']: bf16([2, 2], [1, 1, 1, 1]) }));
  const pkg = normalizePackage({ format: 'junior-package@1', name: 'start', base: store.putTree(base), prompt: 'Be brief.',
    execution: { firmware: store.put('f'), tokenizer: store.put('{}'), chat_template: store.put('c'), driver: store.put('d'), verifier: store.put('v'), circuit: { chip_layers: 2 }, precision: 'bf16' } });
  const probes = Array.from({ length: 6 }, (_, i) => ({ id: 'p' + i, kind: 'probe' as const, partition: 'development' as const, group: 'g-sel', component: 'protocol-start', lab: 'cells', mode: 'start' as const,
    cut: { run: path.join(dir, 'runs', 'sel.json'), question: 0, hash: 'h' + i }, competence: 'protocol', instruction: 'Answer in the protocol (' + i + ').', checker: { id: 'protocol', version: 1 } }));
  const manifest: CompetenceManifest = {
    format: 'junior-competence-manifest@1', id: 'wedit', reference: executionHash(pkg),
    components: [
      { id: 'protocol-start', rung: 1, mode: 'start', extractor: { id: 'probe', version: 1 }, unit: 'share', direction: 'up', target: 1, bad: 0, tolerance: 0, protected: true },
      { id: 'cells-L1', rung: 6, lab: 'cells', level: 'L1', extractor: { id: 'model_accepted', version: 1 }, unit: 'solved', direction: 'up', target: 1, bad: 0, tolerance: 0 }
    ],
    cases: [...probes, { id: 'i1', kind: 'investigation', lab: 'cells', args: ['--seed', '2'], partition: 'development', group: 'g-i1', components: ['cells-L1'] }],
    investigation_repetitions: 1, execution: {}, sampling: { seed: 1 },
    promotion: { procedure: 'paired-cases@1', alpha: 0.05, permutations: 1000, seed: 1 },
    limits: { junior_args: ['--max-tokens', '100000', '--max-judge-calls', '100000'], probe_max_tokens: 500, timeout_ms: 60000 },
    ...(o.edits === false ? {} : { weight_edits: BOUNDS }),
    weight_lab: { diagnosis: { 'g-diag': [path.join(dir, 'runs', 'diag.json')] }, limits: LIMITS }
  };
  const server = new SessionServer({ root: path.join(dir, 'srv'), store, worker: new ProcessWorker({ python: [python!], backend: 'fake', work: path.join(dir, 'work') }),
    labWorker: new ProcessWorker({ python: [python!], backend: 'fake', work: path.join(dir, 'lab-work') }) });
  const h = await serveJunior(server);
  const make = () => new JuniorWorld({ manifest, base: pkg, blobs: path.join(dir, 'blobs'), server: h.url, dir: path.join(dir, 'world'), evaluations: 2,
    labQueries: 10, labTokens: 10_000, edits: 3, cutter: async () => { throw new Error('no cut in these tests'); } });
  const world = make();
  const spec: JuniorSpec = { world };
  const act = async (a: JuniorAct) => juniorLab.act!.start(spec, a, 'x', {} as never);
  return { dir, store, pkg, server, h, world, spec, act, make, close: async () => { server.stop(); await h.close(); } };
}

const H = { competence: 'protocol', why: 'the first output direction derails the answer', expect: 'more answers in the protocol' };

test('inspect_weights reads the junior through the lab, charged once; refused with its reason where the run has no lab', { skip: !python && 'no Python' }, async () => {
  const f = await fixture();
  try {
    const r = await f.act({ inspect_weights: { version: f.world.reference, query: 'modules' } });
    assert.ok(r && r.kind === 'records' && r.what === 'weights' && r.summary.state === 'answered', JSON.stringify(r));
    assert.ok(JSON.stringify(r.rows).includes(DOWN));
    await f.act({ inspect_weights: { version: f.world.reference, query: 'modules' } });
    assert.equal(f.world.jobs.bags().lab_queries.spent, 1, 'asked again, the same query');
    const bad = await f.act({ inspect_weights: { version: f.world.reference, query: 'weights.slice', args: { module: DOWN, rows: [0, 9], cols: [0, 9] } } });
    assert.ok(bad && bad.kind === 'records' && bad.summary.state === 'refused' && /at most 16/.test(String(bad.summary.reason)));
    const nolab = new JuniorWorld({ manifest: f.world.manifest, base: f.pkg, blobs: path.join(f.dir, 'blobs'), server: f.h.url, dir: path.join(f.dir, 'nolab'), evaluations: 1 });
    assert.match(JSON.stringify(await nolab.inspectWeights(nolab.reference, { query: 'modules' })), /no weight laboratory/);
  } finally { await f.close(); }
});

test('edit makes a child whose set sits in the adapter slot, paid from edits; an edited child of it extends its genome; the confirmation says edited, not trained', { skip: !python && 'no Python' }, async () => {
  const f = await fixture();
  try {
    const e1 = await f.act({ edit: { from: f.world.reference, edit: { written: { modules: [{ module: DOWN, encoding: 'sparse', indices: [3], values: [1] }] } }, ...H } });
    assert.ok(e1 && e1.kind === 'records' && e1.what === 'edit' && e1.summary.state === 'finished', JSON.stringify(e1));
    const v1 = String(e1.summary.version);
    const p1 = await f.world.packageOf(v1);
    assert.ok(typeof p1 !== 'string' && p1.adapter);
    assert.deepEqual(verifyEditSet(f.store, p1), []);
    assert.deepEqual(owes(p1), { distilled: false, trained: false, edited: true, initial_memory: false, forced_format: false });
    assert.equal(f.world.jobs.bags().edits.spent, 1);
    assert.equal(await f.world.validity(p1), true, 'its circuit passes the validity suite');
    const e2 = await f.act({ edit: { from: v1, edit: { construct: { name: 'top_singular@1', args: { module: DOWN, k: 1, alpha: -0.5 } } }, ...H } });
    assert.ok(e2 && e2.kind === 'records' && e2.summary.state === 'finished', JSON.stringify(e2));
    const p2 = await f.world.packageOf(String(e2.summary.version));
    assert.ok(typeof p2 !== 'string');
    assert.equal(readEditSet(f.store, p2.adapter!)!.genome.length, 2);
    assert.equal(e2.summary.genome, 2);
    // A change of an edited version keeps its weights; a training on it is refused.
    const c = await f.act({ change: { from: v1, files: { 'prompt.md': 'Answer in JSON.' }, why: 'w', expect: 'e' } });
    assert.ok(c && c.kind === 'version');
    const pc = await f.world.packageOf(c.version);
    assert.ok(typeof pc !== 'string' && pc.adapter === p1.adapter);
  } finally { await f.close(); }
});

test('an edit out of the bounds, in the circuit, as a program without isolation, or where the condition authorizes none is refused, and costs nothing', { skip: !python && 'no Python' }, async () => {
  const f = await fixture();
  try {
    const wide = await f.act({ edit: { from: f.world.reference, edit: { written: { modules: [{ module: DOWN, encoding: 'sparse', indices: [0, 1, 2], values: [1, 1, 1] }] } }, ...H } });
    assert.ok(wide && wide.kind === 'records' && wide.summary.state === 'refused' && /out of bounds/.test(String(wide.summary.reason)), JSON.stringify(wide));
    const circuit = await f.act({ edit: { from: f.world.reference, edit: { written: { modules: [{ module: CHIP, encoding: 'sparse', indices: [0], values: [1] }] } }, ...H } });
    assert.ok(circuit && circuit.kind === 'records' && /circuit/.test(String(circuit.summary.reason)));
    const program = await f.act({ edit: { from: f.world.reference, edit: { program: { code: 'pass' } }, ...H } });
    assert.ok(program && program.kind === 'records' && program.summary.state === 'refused' && /program/.test(String(program.summary.reason)), JSON.stringify(program));
    assert.equal(f.world.jobs.bags().edits.spent, 0);
    const stricter = await f.act({ edit: { from: f.world.reference, edit: { written: { modules: [{ module: DOWN, encoding: 'sparse', indices: [3], values: [1] }] } }, ...H,
      bounds: { ...BOUNDS, per_module: { ...BOUNDS.per_module, max_changed_fraction: 0.1 } } } });
    assert.ok(stricter && stricter.kind === 'records' && stricter.summary.state === 'refused', 'held to the stricter bounds it declares');
  } finally { await f.close(); }
  const g = await fixture({ edits: false });
  try {
    const none = await g.act({ edit: { from: g.world.reference, edit: { written: { modules: [{ module: DOWN, encoding: 'sparse', indices: [3], values: [1] }] } }, ...H } });
    assert.ok(none && none.kind === 'records' && /authorizes no edits/.test(String(none.summary.reason)));
  } finally { await g.close(); }
});

test('a constructor fed by the lab\'s activations, tried on a copy before it is made; a run rebuilt makes the version again without composing it', { skip: !python && 'no Python' }, async () => {
  const f = await fixture();
  try {
    const a = await f.act({ inspect_weights: { version: f.world.reference, query: 'activations', cases: [{ text: { user: 'keeps to the protocol' } }], args: { modules: [DOWN] } } });
    const b = await f.act({ inspect_weights: { version: f.world.reference, query: 'activations', cases: [{ text: { user: 'thinks aloud first' } }], args: { modules: [DOWN] } } });
    assert.ok(a && a.kind === 'records' && b && b.kind === 'records');
    const edit: JuniorAct = { edit: { from: f.world.reference, ...H, edit: { construct: { name: 'mean_difference@1', args: { module: DOWN, a: ['a.safetensors'], b: ['b.safetensors'], alpha: -1 },
      inputs: { 'a.safetensors': { from: String(a.summary.operation), file: 'activations.safetensors' }, 'b.safetensors': { from: String(b.summary.operation), file: 'activations.safetensors' } } } } } };
    const made = await f.act(edit);
    assert.ok(made && made.kind === 'records' && made.summary.state === 'finished', JSON.stringify(made));
    const version = String(made.summary.version);
    const tried = await f.act({ inspect_weights: { version: f.world.reference, query: 'try', candidate: version, args: { inner: 'forward', args: {} }, cases: [{ text: { user: 'hello' } }] } });
    assert.ok(tried && tried.kind === 'records' && tried.summary.state === 'answered', JSON.stringify(tried));
    // Rebuilt from the run's events: the same version, from the world's record, never charged again.
    const again = { world: f.make() };
    juniorLab.rebuild!(again as never, [{ type: 'investigation', requests: [{ act: edit }] }] as never);
    assert.ok(again.world.store.get(version), 'the edited version exists again');
    assert.equal(again.world.jobs.bags().edits.spent, 1);
  } finally { await f.close(); }
});

test('the acts of weight editing are told only to a run that pays for them', () => {
  const plain = JSON.stringify(juniorLab.interface!({ world: { tolerance: '0.25' } } as never));
  const paid = JSON.stringify(juniorLab.interface!({ world: { tolerance: '0.25', edits: '2' } } as never));
  assert.ok(!plain.includes('inspect_weights'));
  assert.ok(paid.includes('inspect_weights') && paid.includes('one of `edits`'));
});
