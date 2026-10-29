import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';
import type { FetchLike } from '../src/core/net.ts';
import type { ChatClient } from '../src/learn/system2.ts';
import { BlobStore, executionHash, normalizePackage, type JuniorPackage } from '../src/junior/package.ts';
import { SessionServer, type JuniorWorker, type WorkerResult } from '../src/junior/sessions.ts';
import { serveJunior } from '../src/junior/http.ts';
import { JuniorSessionClient } from '../src/junior/client.ts';
import { distill, makeDataset, type Dataset } from '../src/junior/distill.ts';
import { recipeProblems, train, type Recipe } from '../src/junior/train.ts';
import type { CompetenceManifest } from '../src/junior/competence.ts';
import { juniorLab } from '../src/worlds/junior/lab.ts';

/* SPEC-METAPOLITICA-APRENDIZAJE §10, §11, MA5: LoRA on Qwen only, a training as a recoverable job, its capacity measured
   first, a dataset sharing selection groups refused, and a trained junior valid to run only with its circuit intact. */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'junior-train-'));
const python = ['python', 'python3'].find((p) => spawnSync(p, ['--version']).status === 0);
const LOOK = { investigate: [{ view: 'ep1', from: 0, to: 2 }] };
const PROPOSE = (round: number) => ({ rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]', validate: false,
  beliefs: [{ id: 'same', stance: round === 1 ? 'new' : 'keep', statement: 'the row repeats', evidence: [] }], lessons: ['l'], next_experiment: 'n' });
const standIn: FetchLike = async () => {
  const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(LOOK) } }], usage: { total_tokens: 1 } });
  return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
};

const recipe = (over: Partial<Recipe> = {}): Recipe => ({ format: 'junior-recipe@1', method: 'lora', layers: [20, 21], modules: ['q_proj', 'v_proj'], rank: 8, alpha: 16, dropout: 0.05,
  learning_rate: 1e-4, epochs: 2, batch: 1, max_length: 4096, seed: 7, mask: 'answer', admits: ['verified'], max_gpu_hours: 1, ...over });

/** A junior that answers off the protocol at a task (unless trained: an adapter), like the stand-in in investigations;
    its validity read from its adapter's config (whether its training reached the circuit). */
function toy(store: () => BlobStore): JuniorWorker {
  const trained = (pkg: JuniorPackage) => pkg.adapter !== null;
  return {
    async run(job): Promise<WorkerResult> {
      const parts = ((job.content as { user: { parts: string[] } }).user.parts).map((p) => { try { return JSON.parse(p); } catch { return {}; } });
      const first = parts[0] ?? {};
      const task = parts.some((p) => p.evaluator_message);
      const text = task && !trained(job.pkg) ? 'Let me think first.'
        : JSON.stringify('task' in first ? { rationale: 'r', beliefs: [{ id: 'same', stance: 'keep', why: 'w' }], lessons: ['l'], next_experiment: 'n' } : !parts.some((p) => p.investigation_step) ? LOOK : PROPOSE(first.round));
      return { served: job.execution, terminal: 'answered', text, trace: '{}', ops: [], after: { neural: Buffer.from('n'), twin: Buffer.from('{}') }, usage: null };
    },
    async memoryCall(job) { return { result: 'ok', twin: job.twin ?? Buffer.from('{}') }; },
    async render() { return {}; },
    async validity(job) {
      let touches = false;
      if (job.pkg.adapter) {
        const t = store().tree(job.pkg.adapter)!;
        touches = JSON.parse(store().get(t.files['adapter_config.json']).toString('utf8')).touches_circuit === true;
      }
      return { exercised: { calc: true, put: true, get: true, delete: true, restore: true }, mismatches: 0, circuit_digest: touches ? 'touched' : 'intact', details: [] };
    }
  };
}

async function fixture(dir: string) {
  const src = await runLaboratory(cellsLab, { args: ['--seed', '1', '--level', '1', '--flat', '--no-grade', '--tools', 'view', '--attempts', '1', '--out', path.join(dir, 'src.json')],
    root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch: standIn, print: () => {} });
  const store = new BlobStore(path.join(dir, 'blobs'));
  const base = path.join(dir, 'base');
  fs.mkdirSync(base);
  fs.writeFileSync(path.join(base, 'w'), 'w');
  const b = (s: string) => store.put(s);
  const pkg = normalizePackage({ format: 'junior-package@1', name: 'j', base: store.putTree(base), prompt: '',
    execution: { firmware: b('f'), tokenizer: b('t'), chat_template: b('c'), driver: b('d'), verifier: b('v'), circuit: { chip_layers: 12 }, precision: 'bf16' } });
  const server = new SessionServer({ root: path.join(dir, 'junior'), store, worker: toy(() => store) });
  const h = await serveJunior(server);
  return { src: src.journal, store, pkg, server, h, client: new JuniorSessionClient(h.url) };
}

const teacher = (answer: unknown): ChatClient => ({ async complete() { return { content: JSON.stringify(answer), latencyMs: 1, raw: null }; } });

test('a recipe never reaches the circuit', () => {
  const store = new BlobStore(path.join(tmp(), 'b'));
  const base = normalizePackage({ format: 'junior-package@1', name: 'j', base: store.put('t'), prompt: '',
    execution: { firmware: store.put('f'), tokenizer: store.put('t'), chat_template: store.put('c'), driver: store.put('d'), verifier: store.put('v'), circuit: { chip_layers: 12 }, precision: 'bf16' } });
  assert.deepEqual(recipeProblems(recipe(), base), []);
  assert.match(recipeProblems(recipe({ layers: [3, 20] }), base).join(), /3 are the circuit's \(its first 12\)/);
  assert.match(recipeProblems(recipe({ modules: ['chip_head' as never] }), base).join(), /"modules"/);
  assert.match(recipeProblems(recipe(), { ...base, execution: { ...base.execution, circuit: {} } }).join(), /chip_layers/);
  assert.match(recipeProblems(recipe({ admits: ['unverified' as never] }), base).join(), /admits/);
});

test('a training: capacity first, refused when it does not fit or shares selection groups, resumed from its checkpoint, its adapter published by hash', { skip: !python && 'no Python' }, async () => {
  const dir = tmp();
  const f = await fixture(dir);
  try {
    const ex = await distill({ dir, req: { run: f.src, question: 0, group: 'g-train', mode: 'start', checker: { id: 'protocol', version: 1 }, instruction: 'Answer in the protocol.' },
      pkg: f.pkg, client: f.client, teacher: teacher(LOOK), teacherIdentity: { model: 'strong' } });
    assert.equal(ex.state, 'verified');
    const ds = makeDataset(dir, [ex.id]) as Dataset;
    const m = { cases: [{ kind: 'probe', partition: 'development', group: 'g-select' }] } as unknown as CompetenceManifest;
    const common = { python: [python!], backend: 'fake' as const, work: path.join(dir, 'work'), store: f.store, parent: f.pkg, dataset: ds, examplesDir: path.join(dir, 'examples'), manifest: m };
    const big = await train({ ...common, recipe: recipe({ batch: 65 }) });
    assert.deepEqual([big.state, big.adapter], ['refused', null]);
    assert.match(big.reason!, /more than the 24 GB/);
    const shared = await train({ ...common, manifest: { cases: [{ kind: 'probe', partition: 'development', group: 'g-train' }] } as unknown as CompetenceManifest, recipe: recipe() });
    assert.match(shared.reason!, /shares groups with the probes that select juniors \(g-train\)/);
    // Stopped at step 1 of 2: no adapter; asked again it goes on from its checkpoint and finishes.
    const { createHash } = await import('node:crypto');
    const { stableStringify } = await import('../src/core/hash.ts');
    const key = createHash('sha256').update(stableStringify({ parent: executionHash(f.pkg), dataset: ds.id, recipe: recipe() })).digest('hex');
    const tdir = path.join(dir, 'work', 'trainings', key.slice(0, 24));
    fs.mkdirSync(tdir, { recursive: true });
    fs.writeFileSync(path.join(tdir, 'STOP_AT'), '1');
    const cut = await train({ ...common, recipe: recipe() });
    assert.deepEqual([cut.state, cut.adapter, cut.steps], ['stopped', null, 1]);
    fs.rmSync(path.join(tdir, 'STOP_AT'));
    const done = await train({ ...common, recipe: recipe() });
    assert.equal(done.state, 'finished', done.reason ?? '');
    assert.equal(done.steps, 2, 'it went on from step 1');
    assert.ok(done.adapter && f.store.tree(done.adapter));
    assert.equal(done.child!.adapter, done.adapter);
    assert.deepEqual(done.child!.provenance.parents, [executionHash(f.pkg)]);
    assert.ok(done.child!.provenance.sources.includes('dataset:' + ds.id));
  } finally { f.server.stop(); await f.h.close(); }
});

test('junior-competence@1: distill, dataset, train, a child valid to run, evaluated; a circuit touched is not valid', { skip: !python && 'no Python' }, async () => {
  const dir = tmp();
  const f = await fixture(dir);
  try {
    const q = await (await import('../src/junior/probes.ts')).captureCut(f.src, 0);
    const probes = Array.from({ length: 6 }, (_, i) => ({ id: 'p' + i, kind: 'probe' as const, partition: 'development' as const, group: 'g-src', component: 'protocol-start', lab: 'cells', mode: 'start' as const,
      cut: { run: f.src, question: 0, hash: q.hash }, competence: 'protocol', instruction: 'Answer in the protocol (' + i + ').', checker: { id: 'protocol', version: 1 } }));
    const m: CompetenceManifest = {
      format: 'junior-competence-manifest@1', id: 'train', reference: executionHash(f.pkg),
      components: [
        { id: 'protocol-start', rung: 1, mode: 'start', extractor: { id: 'probe', version: 1 }, unit: 'share', direction: 'up', target: 1, bad: 0, tolerance: 0, protected: true },
        { id: 'cells-L1', rung: 6, lab: 'cells', level: 'L1', extractor: { id: 'model_accepted', version: 1 }, unit: 'solved', direction: 'up', target: 1, bad: 0, tolerance: 0 }
      ],
      cases: [...probes, { id: 'i1', kind: 'investigation', lab: 'cells', args: ['--seed', '2'], partition: 'development', group: 'g-i1', components: ['cells-L1'] }],
      investigation_repetitions: 1, execution: {}, sampling: { seed: 1 },
      promotion: { procedure: 'paired-cases@1', alpha: 0.05, permutations: 1000, seed: 1 },
      limits: { junior_args: ['--level', '1', '--flat', '--no-grade', '--tools', 'view', '--attempts', '2', '--max-tokens', '100000', '--max-judge-calls', '100000'], probe_max_tokens: 500, timeout_ms: 60000 }
    };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(f.pkg));
    const made = juniorLab.generate(1, { manifest: path.join(dir, 'manifest.json'), package: path.join(dir, 'package.json'), blobs: path.join(dir, 'blobs'), server: f.h.url, work: path.join(dir, 'work'),
      evaluations: '4', distillations: '3', 'gpu-hours': '2', 'train-python': python!, 'train-backend': 'fake' } as never);
    const spec = { ...made, teacher: { client: teacher(LOOK), identity: { model: 'strong' } } };
    await juniorLab.explore!([{ id: 'development', spec }], Math.random, 1, {} as never);
    const ex = await juniorLab.act!.start(spec, { distill: { version: spec.world.reference, case: 'i1', question: 0, mode: 'start', checker: 'protocol', instruction: 'Answer in the protocol.' } }, 'a1', {} as never);
    assert.ok(ex && ex.kind === 'records' && ex.summary.state === 'verified', JSON.stringify(ex));
    const ds = await juniorLab.act!.start(spec, { dataset: { examples: [String(ex.summary.example)], admits: ['verified'] } }, 'a2', {} as never);
    assert.ok(ds && ds.kind === 'records');
    const reaching = await juniorLab.act!.start(spec, { train: { from: spec.world.reference, dataset: String(ds.summary.dataset), recipe: recipe({ layers: [2] }) as never, why: 'w', expect: 'e' } }, 'a3', {} as never);
    assert.ok(reaching && reaching.kind === 'records' && reaching.summary.state === 'refused' && /circuit/.test(String(reaching.summary.reason)));
    const t = await juniorLab.act!.start(spec, { train: { from: spec.world.reference, dataset: String(ds.summary.dataset), recipe: recipe() as never, why: 'the teacher\'s protocol', expect: 'answers accepted' } }, 'a4', {} as never);
    assert.ok(t && t.kind === 'records' && t.summary.state === 'finished', JSON.stringify(t));
    const child = String(t.summary.version);
    const run = await juniorLab.act!.start(spec, { run: { version: child } }, 'a5', {} as never);
    assert.ok(run && run.kind === 'evaluation' && run.components[0].deficit === 0, 'the trained junior keeps to the protocol');
    assert.equal((await juniorLab.artifact!.check(spec, child, { round: 1, purpose: 'check', index: 0 }, {} as never)).holds, true);
    // A child whose circuit was touched: kept, never evaluated.
    const bad = path.join(dir, 'bad-adapter');
    fs.mkdirSync(bad);
    fs.writeFileSync(path.join(bad, 'adapter_config.json'), JSON.stringify({ touches_circuit: true }));
    const touched = normalizePackage({ ...f.pkg, adapter: f.store.putTree(bad) });
    assert.match(String(await spec.world.validity(touched)), /compiled parameters are not the base's/);
    // Rebuilt from the record: the trained version exists again, never trained again.
    const again = juniorLab.generate(1, { manifest: path.join(dir, 'manifest.json'), package: path.join(dir, 'package.json'), blobs: path.join(dir, 'blobs'), server: f.h.url, work: path.join(dir, 'work'), evaluations: '4' } as never);
    juniorLab.rebuild!(again, [{ type: 'investigation', requests: [{ act: { train: { from: spec.world.reference, dataset: String(ds.summary.dataset), recipe: recipe(), why: 'the teacher\'s protocol', expect: 'answers accepted' } } }] }]);
    assert.ok(again.world.store.get(child));
  } finally { f.server.stop(); await f.h.close(); }
});
