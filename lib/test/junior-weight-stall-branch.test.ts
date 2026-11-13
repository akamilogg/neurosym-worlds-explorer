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
import type { CompetenceManifest } from '../src/junior/competence.ts';
import { baseReader, bf16Bits, bf16Value, compose, editsInTree, writeSafetensors, type RawTensor, type WeightBounds } from '../src/junior/weights.ts';
import { branchProblems, runWeightBranch, type WeightBranchSpec } from '../src/junior/weight-branch.ts';
import { juniorLab, JuniorWorld, type JuniorSpec } from '../src/worlds/junior/lab.ts';

/* SPEC-EDICION-PESOS §6.6, WE5: the world tells a stall - facts, once - and never opens a search itself; the operator's
   search runs as a branch with a fund of its own, and its elites reach the researcher as versions and a delegated notice. */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'junior-wstall-'));
const python = ['python', 'python3'].find((p) => spawnSync(p, ['--version']).status === 0);
const bf16 = (shape: number[], values: number[]): RawTensor => ({ dtype: 'BF16', shape, bytes: new Uint8Array(Uint16Array.from(values.map(bf16Bits)).buffer) });
const DOWN = 'model.layers.4.mlp.down_proj', Q = 'model.layers.5.self_attn.q_proj';
const BOUNDS: WeightBounds = { per_module: { max_changed_fraction: 1, max_relative_norm: 3, max_representation: 1000, max_rank: 8, max_sparse_entries: 100 },
  total: { max_changed_fraction: 1, max_relative_norm: 3, max_representation: 1000 } };

async function fixture(o: { edits?: number } = {}) {
  const dir = tmp();
  const store = new BlobStore(path.join(dir, 'blobs'));
  const base = path.join(dir, 'base');
  fs.mkdirSync(base);
  fs.writeFileSync(path.join(base, 'chipformer.json'), JSON.stringify({ chip_layers: 2 }));
  fs.writeFileSync(path.join(base, 'tokenizer.json'), '{}');
  fs.writeFileSync(path.join(base, 'model.safetensors'), writeSafetensors({ [DOWN + '.weight']: bf16([2, 2], [3, 0, 0, 1]), [Q + '.weight']: bf16([2, 3], [1, 2, 3, 4, 5, 6]) }));
  const pkg = normalizePackage({ format: 'junior-package@1', name: 'start', base: store.putTree(base), prompt: '',
    execution: { firmware: store.put('f'), tokenizer: store.put('{}'), chat_template: store.put('c'), driver: store.put('d'), verifier: store.put('v'), circuit: { chip_layers: 2 }, precision: 'bf16' } });
  const probes = Array.from({ length: 6 }, (_, i) => ({ id: 'p' + i, kind: 'probe' as const, partition: 'development' as const, group: 'g-sel', component: i < 3 ? 'a' : 'b', lab: 'cells', mode: 'start' as const,
    cut: { run: path.join(dir, 'runs', 'sel.json'), question: 0, hash: 'h' + i }, competence: 'protocol', instruction: 'Answer (' + i + ').', checker: { id: 'protocol', version: 1 } }));
  const manifest: CompetenceManifest = {
    format: 'junior-competence-manifest@1', id: 'wstall', reference: executionHash(pkg),
    components: [
      { id: 'a', rung: 1, mode: 'start', extractor: { id: 'probe', version: 1 }, unit: 'share', direction: 'up', target: 1, bad: 0, tolerance: 0 },
      { id: 'b', rung: 1, mode: 'start', extractor: { id: 'probe', version: 1 }, unit: 'share', direction: 'up', target: 1, bad: 0, tolerance: 0 },
      { id: 'cells-L1', rung: 6, lab: 'cells', level: 'L1', extractor: { id: 'model_accepted', version: 1 }, unit: 'solved', direction: 'up', target: 1, bad: 0, tolerance: 0 }
    ],
    cases: [...probes, { id: 'i1', kind: 'investigation', lab: 'cells', args: ['--seed', '2'], partition: 'development', group: 'g-i1', components: ['cells-L1'] }],
    investigation_repetitions: 1, execution: {}, sampling: { seed: 1 }, promotion: { procedure: 'paired-cases@1', alpha: 0.05, permutations: 1000, seed: 1 },
    limits: { junior_args: ['--max-tokens', '100000', '--max-judge-calls', '100000'], probe_max_tokens: 500, timeout_ms: 60000 },
    weight_edits: BOUNDS,
    weight_search: { max_candidates: 6, min_control_seeds: 1, operators: { perturb: 1, reinit: 1, scale: 1 }, tolerance: { a: 0.01, b: 0.01, 'cells-L1': 0 }, layer_groups: [[2, 4], [5, 9]],
      perturb: 0.2, investigate_elites: false, stuck_after: 2 }
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'reference.json'), JSON.stringify(pkg));
  const server = new SessionServer({ root: path.join(dir, 'srv'), store, worker: new ProcessWorker({ python: [python ?? 'python'], backend: 'fake', work: path.join(dir, 'work') }) });
  const h = await serveJunior(server);
  /* The probes read the composed weights: a how far DOWN[0] is from 1, b how far Q's first row sums from 5. */
  const probesOf = async (p: JuniorPackage) => {
    const read = (m: string, n: number) => (p.adapter ? (compose(editsInTree(store, p.adapter), baseReader(store, p.base)).weights[m] ?? baseReader(store, p.base)(m + '.weight').bits) : baseReader(store, p.base)(m + '.weight').bits);
    const d0 = bf16Value(read(DOWN, 1)[0]), q = Array.from(read(Q, 3)).slice(0, 3).map(bf16Value);
    return { complete: true, components: [{ id: 'a', quality: Math.min(1, Math.abs(d0 - 1) / 3) }, { id: 'b', quality: Math.min(1, Math.abs(q[0] + q[1] + q[2] - 5) / 5) }] };
  };
  const make = (extra: Record<string, unknown> = {}) => new JuniorWorld({ manifest, base: pkg, blobs: path.join(dir, 'blobs'), server: h.url, dir: path.join(dir, 'world'), evaluations: 10, edits: o.edits ?? 5, ...extra });
  return { dir, store, pkg, manifest, h, server, probesOf, make, close: async () => { server.stop(); await h.close(); } };
}

test('a stall is told once, as facts, where a search may be opened; a promotion or a deficit that moves is no stall; the world opens nothing', async () => {
  const f = await fixture();
  try {
    const w = f.make();
    w.noteEvaluation('v0', { a: 0.5, b: 0.5, 'cells-L1': 1 });
    w.noteEvaluation('v1', { a: 0.5, b: 0.505, 'cells-L1': 1 });
    assert.equal(w.stall(), null, 'not yet K after a first');
    w.noteEvaluation('v2', { a: 0.499, b: 0.5, 'cells-L1': 1 });
    const s = w.stall() as { stall: Record<string, unknown> } | null;
    assert.ok(s && s.stall.evaluations === 2 && s.stall.promoted === 0 && /evolve/.test(String(s.stall.what_you_may_do)), JSON.stringify(s));
    assert.deepEqual(s.stall.versions, ['v1', 'v2']);
    assert.equal(w.stall(), null, 'told once');
    // A promotion in the window, or a deficit that moves past its tolerance, is no stall.
    w.noteEvaluation('v3', { a: 0.5, b: 0.5, 'cells-L1': 1 });
    w.notePromotion('v3', true);
    assert.equal(w.stall(), null);
    w.noteEvaluation('v4', { a: 0.2, b: 0.5, 'cells-L1': 1 });
    w.noteEvaluation('v5', { a: 0.21, b: 0.5, 'cells-L1': 1 });
    assert.equal(w.stall(), null, 'a moved');
    // Published by the world after an act, through the researcher's channel.
    const published: unknown[] = [];
    w.noteEvaluation('v6', { a: 0.2, b: 0.5, 'cells-L1': 1 });
    w.noteEvaluation('v7', { a: 0.2, b: 0.5, 'cells-L1': 1 });
    await juniorLab.act!.start({ world: w } as JuniorSpec, { change: { from: w.reference, files: { 'prompt.md': 'x' }, why: 'w', expect: 'e' } }, 'c', { publish: (m: unknown) => published.push(m) } as never);
    assert.equal(published.length, 1);
    assert.match(JSON.stringify(published[0]), /"stall"/);
  } finally { await f.close(); }
  const g = await fixture({ edits: 0 });
  try {
    const w = g.make();
    for (const v of ['v0', 'v1', 'v2']) w.noteEvaluation(v, { a: 0.5, b: 0.5, 'cells-L1': 1 });
    assert.equal(w.stall(), null, 'a run that cannot open a search is not told of one');
  } finally { await g.close(); }
});

test('the operator\'s search as a branch: its own fund, its lifecycle files, its elites delivered to the researcher as versions and a delegated notice; ended, never run again', { skip: !python && 'no Python' }, async () => {
  const f = await fixture();
  try {
    const researcher = f.make({ weightBranches: path.join(f.dir, 'branches') });
    const startPkg = await researcher.packageOf(researcher.reference);
    assert.ok(typeof startPkg !== 'string');
    fs.writeFileSync(path.join(f.dir, 'start.json'), JSON.stringify(startPkg));
    const spec: WeightBranchSpec = { format: 'weight-search-branch@1', id: 'wb1', question: 'what lowers a without raising b?', from: researcher.reference, start: path.join(f.dir, 'start.json'),
      manifest: path.join(f.dir, 'manifest.json'), reference: path.join(f.dir, 'reference.json'), blobs: path.join(f.dir, 'blobs'), server: f.h.url,
      seeds: [{ written: { modules: [{ module: DOWN, encoding: 'sparse', indices: [0], values: [-1.5] }] }, competence: 'protocol', why: 'DOWN[0] too strong', expect: 'a improves' },
        { construct: { name: 'top_singular@1', args: { module: Q, k: 1, alpha: -0.2 } }, competence: 'requests', why: 'Q\'s first direction dominates', expect: 'b improves' }],
      control_seeds: 1, max_candidates: 5, seed: 2, fund: { edits: 20, evaluations: 20 } };
    assert.deepEqual(branchProblems(spec), []);
    assert.match(branchProblems({ ...spec, control_seeds: 0 }).join(), /E6/);
    fs.writeFileSync(path.join(f.dir, 'wb1.json'), JSON.stringify(spec));
    const branches = path.join(f.dir, 'branches');
    const finding = await runWeightBranch(path.join(f.dir, 'wb1.json'), branches, { probes: f.probesOf, heartbeatMs: 50 });
    assert.ok(finding.elites.length >= 1, JSON.stringify(finding));
    for (const ext of ['.json', '.status.json', '.finding.json', '.search.jsonl']) assert.ok(fs.existsSync(path.join(branches, 'wb1' + ext)), ext);
    assert.ok(finding.cost.edits > 0 && finding.cost.evaluations > 0);
    assert.equal(researcher.jobs.bags().edits.spent, 0, 'the researcher\'s bags untouched: the branch has a fund of its own');
    // Delivered after the researcher's next act: its elites made versions of the researcher's world, a delegated notice.
    const published: Record<string, any>[] = [];
    await juniorLab.act!.start({ world: researcher } as JuniorSpec, { change: { from: researcher.reference, files: { 'prompt.md': 'y' }, why: 'w', expect: 'e' } }, 'c', { publish: (m: Record<string, any>) => published.push(m) } as never);
    const delegated = published.find((m) => m.body?.delegated)?.body.delegated;
    assert.ok(delegated && delegated.branch === 'wb1' && delegated.versions.length === finding.elites.length, JSON.stringify(published));
    for (const v of delegated.versions) {
      const p = await researcher.packageOf(v.version);
      assert.ok(typeof p !== 'string' && p.adapter, 'a version of the researcher\'s world, its set in the adapter slot');
    }
    assert.deepEqual(researcher.deliverBranches(), [], 'delivered once');
    // Ended: run again, it answers its finding without searching.
    const again = await runWeightBranch(path.join(f.dir, 'wb1.json'), branches, { probes: async () => { throw new Error('never measured again'); } });
    assert.deepEqual(again, finding);
  } finally { await f.close(); }
});

test('a stop in the branch\'s inbox is obeyed before its next candidate', { skip: !python && 'no Python' }, async () => {
  const f = await fixture();
  try {
    const w = f.make();
    const startPkg = await w.packageOf(w.reference);
    fs.writeFileSync(path.join(f.dir, 'start.json'), JSON.stringify(startPkg));
    const spec: WeightBranchSpec = { format: 'weight-search-branch@1', id: 'wb2', question: 'q', from: w.reference, start: path.join(f.dir, 'start.json'), manifest: path.join(f.dir, 'manifest.json'),
      reference: path.join(f.dir, 'reference.json'), blobs: path.join(f.dir, 'blobs'), server: f.h.url,
      seeds: [{ written: { modules: [{ module: DOWN, encoding: 'sparse', indices: [0], values: [-1.5] }] }, competence: 'protocol', why: 'w', expect: 'e' }],
      control_seeds: 1, max_candidates: 6, fund: { edits: 20, evaluations: 20 } };
    fs.writeFileSync(path.join(f.dir, 'wb2.json'), JSON.stringify(spec));
    const branches = path.join(f.dir, 'branches');
    fs.mkdirSync(branches, { recursive: true });
    fs.writeFileSync(path.join(branches, 'wb2.inbox.jsonl'), JSON.stringify({ stop: true }) + '\n');
    const finding = await runWeightBranch(path.join(f.dir, 'wb2.json'), branches, { probes: f.probesOf, heartbeatMs: 50 });
    assert.equal(finding.stoppedBy, 'cancelled');
  } finally { await f.close(); }
});

/* --- A review of WE2-WE6 (04/11/2026) ----------------------------------------------------------------------------------- */

test('review: a run rebuilt makes the delivered versions again, and what the researcher built on them', { skip: !python && 'no Python' }, async () => {
  const f = await fixture();
  try {
    const branches = path.join(f.dir, 'branches');
    const researcher = f.make({ weightBranches: branches });
    const startPkg = await researcher.packageOf(researcher.reference);
    fs.writeFileSync(path.join(f.dir, 'start.json'), JSON.stringify(startPkg));
    const spec: WeightBranchSpec = { format: 'weight-search-branch@1', id: 'wb3', question: 'q', from: researcher.reference, start: path.join(f.dir, 'start.json'), manifest: path.join(f.dir, 'manifest.json'),
      reference: path.join(f.dir, 'reference.json'), blobs: path.join(f.dir, 'blobs'), server: f.h.url,
      seeds: [{ written: { modules: [{ module: DOWN, encoding: 'sparse', indices: [0], values: [-1.5] }] }, competence: 'protocol', why: 'w', expect: 'e' }],
      control_seeds: 1, max_candidates: 3, seed: 2, fund: { edits: 20, evaluations: 20 } };
    fs.writeFileSync(path.join(f.dir, 'wb3.json'), JSON.stringify(spec));
    await runWeightBranch(path.join(f.dir, 'wb3.json'), branches, { probes: f.probesOf, heartbeatMs: 50 });
    const first = { change: { from: researcher.reference, files: { 'prompt.md': 'y' }, why: 'w', expect: 'e' } };
    const published: Record<string, any>[] = [];
    await juniorLab.act!.start({ world: researcher } as JuniorSpec, first, 'c1', { publish: (m: Record<string, any>) => published.push(m) } as never);
    const delivered = published.find((m) => m.body?.delegated)!.body.delegated.versions[0].version as string;
    const second = { change: { from: delivered, files: { 'prompt.md': 'built on the delivered junior' }, why: 'w', expect: 'e' } };
    const child = await juniorLab.act!.start({ world: researcher } as JuniorSpec, second, 'c2', {} as never);
    assert.ok(child && child.kind === 'version');
    // The run rebuilt from its events: the delivered version and its child exist again.
    const again = { world: f.make({ weightBranches: branches }) };
    juniorLab.rebuild!(again as never, [{ type: 'investigation', requests: [{ act: first }] }, { type: 'investigation', requests: [{ act: second }] }] as never);
    assert.ok(again.world.store.get(delivered), 'the delivered version made again');
    assert.ok(again.world.store.get(child.version), 'and the version built on it');
    assert.deepEqual(again.world.deliverBranches(), [], 'never delivered twice');
  } finally { await f.close(); }
});

test('review: an explicit 0 is 0 - a condition that may not distill gets no distillations', async () => {
  const f = await fixture();
  try {
    const made = juniorLab.generate(1, { manifest: path.join(f.dir, 'manifest.json'), package: path.join(f.dir, 'reference.json'), blobs: path.join(f.dir, 'blobs'), server: f.h.url,
      work: path.join(f.dir, 'gen'), evaluations: '4', distillations: '0' } as never);
    assert.equal(made.world.jobs.bags().distillations.limit, 0);
    const dflt = juniorLab.generate(1, { manifest: path.join(f.dir, 'manifest.json'), package: path.join(f.dir, 'reference.json'), blobs: path.join(f.dir, 'blobs'), server: f.h.url,
      work: path.join(f.dir, 'gen2'), evaluations: '4' } as never);
    assert.equal(dflt.world.jobs.bags().distillations.limit, 20, 'absent: the default');
  } finally { await f.close(); }
});

test('review 2: a run resumed (its acts replayed) applies what was delivered at that act again - the same versions, notices and spending, nothing measured', { skip: !python && 'no Python' }, async () => {
  const f = await fixture();
  try {
    const branches = path.join(f.dir, 'branches');
    const live = f.make({ weightBranches: branches });
    const startPkg = await live.packageOf(live.reference);
    fs.writeFileSync(path.join(f.dir, 'start.json'), JSON.stringify(startPkg));
    const spec: WeightBranchSpec = { format: 'weight-search-branch@1', id: 'wb4', question: 'q', from: live.reference, start: path.join(f.dir, 'start.json'), manifest: path.join(f.dir, 'manifest.json'),
      reference: path.join(f.dir, 'reference.json'), blobs: path.join(f.dir, 'blobs'), server: f.h.url,
      seeds: [{ written: { modules: [{ module: DOWN, encoding: 'sparse', indices: [0], values: [-1.5] }] }, competence: 'protocol', why: 'w', expect: 'e' }],
      control_seeds: 1, max_candidates: 3, seed: 2, fund: { edits: 20, evaluations: 20 } };
    fs.writeFileSync(path.join(f.dir, 'wb4.json'), JSON.stringify(spec));
    await runWeightBranch(path.join(f.dir, 'wb4.json'), branches, { probes: f.probesOf, heartbeatMs: 50 });
    /* The run's record of what the world computed at each act (LabContext.recorded): kept live, served on resumption. */
    const record = new Map<string, string>();
    const ctx = (mode: 'live' | 'resume', published: unknown[]) => ({
      publish: (m: unknown) => published.push(m),
      recorded: async <T>(route: string, body: unknown, compute: () => Promise<T>): Promise<T> => {
        const k = route + JSON.stringify(body);
        if (mode === 'resume') { assert.ok(record.has(k), 'recorded at ' + k); return JSON.parse(record.get(k)!) as T; }
        const v = await compute();
        record.set(k, JSON.stringify(v));
        return v;
      }
    }) as never;
    const first = { change: { from: live.reference, files: { 'prompt.md': 'y' }, why: 'w', expect: 'e' } };
    const pubLive: Record<string, any>[] = [];
    await juniorLab.act!.start({ world: live } as JuniorSpec, first, 'a1', ctx('live', pubLive));
    const delivered = pubLive.find((m) => m.body?.delegated)!.body.delegated.versions[0].version as string;
    const second = { change: { from: delivered, files: { 'prompt.md': 'built on it' }, why: 'w', expect: 'e' } };
    const childLive = await juniorLab.act!.start({ world: live } as JuniorSpec, second, 'a2', ctx('live', pubLive));
    assert.ok(childLive && childLive.kind === 'version');
    // Resumed: a new instance of the same world replays the same acts, each served what the run recorded.
    const resumed = f.make({ weightBranches: branches });
    const pubResumed: Record<string, any>[] = [];
    await juniorLab.act!.start({ world: resumed } as JuniorSpec, first, 'a1', ctx('resume', pubResumed));
    const childResumed = await juniorLab.act!.start({ world: resumed } as JuniorSpec, second, 'a2', ctx('resume', pubResumed));
    assert.ok(childResumed && childResumed.kind === 'version', 'the act on the delivered version is accepted again');
    assert.equal(childResumed.version, childLive.version);
    assert.ok(resumed.store.get(delivered));
    assert.deepEqual(pubResumed, pubLive, 'the same notices at the same acts');
    assert.deepEqual(resumed.jobs.bags(), live.jobs.bags(), 'the same spending: nothing measured again');
    assert.deepEqual(resumed.collectBranches(), [], 'never collected twice');
  } finally { await f.close(); }
});

/* --- An external review of 0bec9b3 (13/11/2026) -------------------------------------------------------------------------- */

test('review 0bec9b3: a branch\'s elite is a candidate a search selected - delivered, edited and checked, it is promoted on the holdout alone and never without one', { skip: !python && 'no Python' }, async () => {
  const f = await fixture();
  try {
    const branches = path.join(f.dir, 'branches');
    const researcher = f.make({ weightBranches: branches });
    const startPkg = await researcher.packageOf(researcher.reference);
    fs.writeFileSync(path.join(f.dir, 'start.json'), JSON.stringify(startPkg));
    const spec: WeightBranchSpec = { format: 'weight-search-branch@1', id: 'wb5', question: 'q', from: researcher.reference, start: path.join(f.dir, 'start.json'), manifest: path.join(f.dir, 'manifest.json'),
      reference: path.join(f.dir, 'reference.json'), blobs: path.join(f.dir, 'blobs'), server: f.h.url,
      seeds: [{ written: { modules: [{ module: DOWN, encoding: 'sparse', indices: [0], values: [-1.5] }] }, competence: 'protocol', why: 'w', expect: 'e' }],
      control_seeds: 1, max_candidates: 3, seed: 2, fund: { edits: 20, evaluations: 20 } };
    fs.writeFileSync(path.join(f.dir, 'wb5.json'), JSON.stringify(spec));
    await runWeightBranch(path.join(f.dir, 'wb5.json'), branches, { probes: f.probesOf, heartbeatMs: 50 });
    const [d] = researcher.deliverBranches() as { delegated: { versions: { version: string }[] } }[];
    const delivered = d.delegated.versions[0].version;
    assert.deepEqual(researcher.searchesOf(delivered), ['branch:wb5'], 'its search registered when the delivery is made');
    const child = await researcher.editFrom(delivered, { written: { modules: [{ module: Q, encoding: 'sparse', indices: [0], values: [0.5] }] } },
      { competence: 'requests', mechanism: 'm', effect: 'e' }, undefined, { why: 'built on the elite' });
    assert.ok(child.version, JSON.stringify(child));
    assert.deepEqual(researcher.searchesOf(child.version!), ['branch:wb5'], 'and kept by a later edit');
    /* Checked: evaluations made up (the candidate better on every case), the rule the check applies read from its record. */
    const check = async (world: JuniorWorld, version: string) => {
      const ev = (execution: string, value: number) => ({ format: 'junior-evaluation@1' as const, manifest: world.manifestHash, execution, partition: 'development' as const, temperature: 0, measure: null as never,
        observations: world.manifest.cases.map((c) => ({ component: c.kind === 'probe' ? (c as { component: string }).component : 'cells-L1', case: c.id, rep: 0, value, state: 'measured' as const })) });
      (world as unknown as { evaluate: (v: string) => Promise<unknown> }).evaluate = async (v: string) => v === world.reference ? ev(f.manifest.reference, 0) : ev('c'.repeat(64), 1);
      return (await juniorLab.artifact!.check({ world } as JuniorSpec, version, {} as never, {} as never)) as unknown as { journal: { verdict: string; why: string } };
    };
    for (const v of [delivered, child.version!]) assert.match((await check(researcher, v)).journal.why, /best of N in selection/, 'no holdout: never promoted');
    const held = new JuniorWorld({ manifest: { ...f.manifest, holdout: ['p2', 'p5'] }, base: f.pkg, blobs: path.join(f.dir, 'blobs'), server: f.h.url, dir: path.join(f.dir, 'held'), evaluations: 10, edits: 5, store: researcher.store });
    const { promoteOnHoldout } = await import('../src/junior/evaluate.ts');
    for (const v of [delivered, child.version!]) {
      const r = (await check(held, v)).journal;
      assert.doesNotMatch(r.why, /best of N in selection/);
      const evs = await Promise.all([held.reference, v].map((x) => (held as unknown as { evaluate: (v: string) => Promise<never> }).evaluate(x)));
      const expected = promoteOnHoldout(held.manifest, held.manifestHash, evs[0], evs[1])!;
      assert.deepEqual([r.verdict, r.why], [expected.verdict, expected.why], 'on the holdout alone');
    }
  } finally { await f.close(); }
});
