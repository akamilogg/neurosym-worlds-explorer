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
import { BlobStore, executionHash, normalizePackage } from '../src/junior/package.ts';
import { SessionServer, type JuniorWorker, type WorkerResult } from '../src/junior/sessions.ts';
import { serveJunior } from '../src/junior/http.ts';
import { JuniorSessionClient } from '../src/junior/client.ts';
import { ProcessWorker } from '../src/junior/worker.ts';
import { distill, makeDataset, selectionOverlap } from '../src/junior/distill.ts';
import type { CompetenceManifest } from '../src/junior/competence.ts';
import { juniorLab } from '../src/worlds/junior/lab.ts';

/* SPEC-METAPOLITICA-APRENDIZAJE §8, §8.1, MA4: distillation from a cut - the teacher's memory served by the reference
   simulator on a copy, the examples accepted by the harness's checker, datasets by content and their overlap. */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'junior-distill-'));
const LOOK = { investigate: [{ view: 'ep1', from: 0, to: 2 }] };
const PROPOSE = (round: number) => ({ rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]', validate: false,
  beliefs: [{ id: 'same', stance: round === 1 ? 'new' : 'keep', statement: 'the row repeats', evidence: [] }], lessons: ['l'], next_experiment: 'n' });
const standIn: FetchLike = async () => {
  const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(LOOK) } }], usage: { total_tokens: 1 } });
  return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
};

/** A junior whose memory is a JSON twin; it answers investigations like the stand-in, and at a distillation's cut (an
    evaluator's task, or none) answers off the protocol unless `good` is set. */
function toy(good = false): JuniorWorker {
  return {
    async run(job): Promise<WorkerResult> {
      const parts = ((job.content as { user: { parts: string[] } }).user.parts).map((p) => { try { return JSON.parse(p); } catch { return {}; } });
      const first = parts[0] ?? {};
      const inTrial = !parts.some((p) => p.evaluator_message) && !String((job.content as { system: string }).system).includes('distill-me');
      const text = !inTrial && !good ? 'Let me think first.'
        : JSON.stringify('task' in first ? { rationale: 'r', beliefs: [{ id: 'same', stance: 'keep', why: 'w' }], lessons: ['l'], next_experiment: 'n' } : !parts.some((p) => p.investigation_step) ? LOOK : PROPOSE(first.round));
      const twin = Buffer.from(job.state.twin ? job.store.get(job.state.twin) : Buffer.from('{}'));
      return { served: job.execution, terminal: 'answered', text, trace: '{}', ops: [], after: { neural: Buffer.concat([Buffer.from('n:'), twin]), twin }, usage: null };
    },
    async memoryCall(job) {
      const mem: Record<string, string> = job.twin ? JSON.parse(job.twin.toString('utf8')) : {};
      const c = job.call;
      const result = c.op === 'put' ? ((mem[c.name!] = c.text!), 'ok') : c.op === 'get' ? (mem[c.name!] ?? 'not found') : c.op === 'list' ? (Object.keys(mem).join('\n') || 'empty') : 'ok';
      return { result, twin: Buffer.from(JSON.stringify(mem)) };
    },
    async render(job) { return job.twin ? JSON.parse(job.twin.toString('utf8')) : {}; }
  };
}

/** A teacher that asks its memory once, then answers `answer`. */
function teacher(answer: unknown, seen: unknown[][] = []): ChatClient {
  let n = 0;
  return { async complete({ user }) {
    seen.push([...(user as { parts: unknown[] }).parts]);
    const content = n++ === 0 ? JSON.stringify({ memory_call: { op: 'put', name: 'plan', text: 'look first' } }) : typeof answer === 'string' ? answer : JSON.stringify(answer);
    return { content, latencyMs: 1, raw: null };
  } };
}

async function fixture(dir: string, worker: JuniorWorker) {
  const src = await runLaboratory(cellsLab, { args: ['--seed', '1', '--level', '1', '--flat', '--no-grade', '--tools', 'view', '--attempts', '1', '--out', path.join(dir, 'src.json')],
    root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch: standIn, print: () => {} });
  const store = new BlobStore(path.join(dir, 'blobs'));
  const base = path.join(dir, 'base');
  fs.mkdirSync(base);
  fs.writeFileSync(path.join(base, 'w'), 'w');
  const b = (s: string) => store.put(s);
  const twin = store.put('{"note":"x"}'), neural = store.put('n:{"note":"x"}');
  const pkg = normalizePackage({ format: 'junior-package@1', name: 'j', base: store.putTree(base), prompt: '', memory: { neural, twin },
    execution: { firmware: b('f'), tokenizer: b('t'), chat_template: b('c'), driver: b('d'), verifier: b('v'), circuit: {}, precision: 'bf16' } });
  const server = new SessionServer({ root: path.join(dir, 'junior'), store, worker });
  const h = await serveJunior(server);
  return { src: src.journal, store, pkg, server, h, client: new JuniorSessionClient(h.url) };
}

test('the teacher at a cut: its memory a copy served by the simulator; verified, unverified and rejected by the checker fixed first', async () => {
  const dir = tmp();
  const f = await fixture(dir, toy());
  try {
    const req = { run: f.src, question: 0, group: 'g-src', mode: 'start' as const, checker: { id: 'protocol', version: 1 }, instruction: 'Answer in the protocol.' };
    const seen: unknown[][] = [];
    const v = await distill({ dir, req, pkg: f.pkg, client: f.client, teacher: teacher(LOOK, seen), teacherIdentity: { model: 'strong' } });
    assert.equal(v.state, 'verified');
    assert.equal(v.target, JSON.stringify(LOOK));
    assert.deepEqual(v.teacher.memory.calls.map((c) => [c.op, c.name, c.result]), [['put', 'plan', 'ok']]);
    assert.deepEqual(await f.client.render(f.pkg, v.teacher.memory.calls[0].twin_after), { note: 'x', plan: 'look first' }, 'the teacher wrote in its copy');
    assert.deepEqual(await f.client.render(f.pkg, f.pkg.memory.twin), { note: 'x' }, 'the junior\'s memory is untouched');
    assert.match(JSON.stringify(seen[1].at(-1)), /memory_result/);
    assert.equal(v.junior.outcome?.pass, false);
    assert.equal(v.span, 'decisions', 'its answer needed a memory call: the call is a decision, its result context');
    /* Review 5: the row a training reads keeps the call and what it read, never the answer alone. */
    const { trainingRows } = await import('../src/junior/train.ts');
    const rows = trainingRows(path.join(dir, 'examples'), makeDataset(dir, [v.id]) as never, { admits: ['verified'] } as never);
    assert.ok(!('error' in rows));
    assert.deepEqual(rows[0].calls, [{ op: 'put', name: 'plan', text: 'look first', result: 'ok' }]);
    assert.equal(rows[0].answer, JSON.stringify(LOOK));
    const again = await distill({ dir, req, pkg: f.pkg, client: f.client, teacher: teacher('never asked'), teacherIdentity: { model: 'strong' } });
    assert.equal(again.id, v.id, 'the same request is made once');
    const r = await distill({ dir, req: { ...req, question: 0, group: 'g-other' }, pkg: f.pkg, client: f.client, teacher: teacher('I would look at the data.'), teacherIdentity: { model: 'strong' } });
    assert.deepEqual([r.state, r.target], ['rejected', null]);
    const broken: ChatClient = { async complete() { throw new Error('provider down'); } };
    const u = await distill({ dir, req: { ...req, group: 'g-3' }, pkg: f.pkg, client: f.client, teacher: broken, teacherIdentity: { model: 'strong' } });
    assert.equal(u.state, 'unverified');
    assert.match(u.teacher.why ?? '', /provider down/);
    // Datasets: verified only, by content; the groups it shares with selection named.
    assert.match(String((makeDataset(dir, [v.id, r.id]) as { error: string }).error), /rejected/);
    assert.match(String((makeDataset(dir, [v.id], ['unverified' as never]) as { error: string }).error), /never unverified/);
    const ds = makeDataset(dir, [v.id]);
    assert.ok(!('error' in ds));
    assert.equal(makeDataset(dir, [v.id]) && (makeDataset(dir, [v.id]) as { id: string }).id, ds.id);
    assert.deepEqual(ds.groups, ['g-src']);
    const m = { cases: [{ kind: 'probe', partition: 'development', group: 'g-src' }, { kind: 'investigation', partition: 'development', group: 'g-i1' }] } as unknown as CompetenceManifest;
    assert.deepEqual(selectionOverlap(ds, m), ['g-src']);
  } finally { f.server.stop(); await f.h.close(); }
  // Both pass: nothing proves the teacher's is better.
  const dir2 = tmp();
  const g = await fixture(dir2, toy(true));
  try {
    const both = await distill({ dir: dir2, req: { run: g.src, question: 0, group: 'g', mode: 'start', checker: { id: 'protocol', version: 1 }, instruction: 'Answer in the protocol.' }, pkg: g.pkg, client: g.client, teacher: teacher(LOOK), teacherIdentity: { model: 'strong' } });
    assert.deepEqual([both.state, both.target], ['unverified', null]);
  } finally { g.server.stop(); await g.h.close(); }
});

const python = ['python', 'python3'].find((p) => spawnSync(p, ['--version']).status === 0);

test('the memory simulator through the Python worker (fake backend): a copy changed, the state given never', { skip: !python && 'no Python' }, async () => {
  const dir = tmp();
  const store = new BlobStore(path.join(dir, 'blobs'));
  const server = new SessionServer({ root: dir, store, worker: new ProcessWorker({ python: [python!], backend: 'fake', work: path.join(dir, 'work') }) });
  try {
    const base = path.join(dir, 'base');
    fs.mkdirSync(base);
    fs.writeFileSync(path.join(base, 'w'), 'w');
    const b = (s: string) => store.put(s);
    const pkg = normalizePackage({ format: 'junior-package@1', name: 'j', base: store.putTree(base), prompt: '',
      execution: { firmware: b('f'), tokenizer: b('t'), chat_template: b('c'), driver: b('d'), verifier: b('v'), circuit: {}, precision: 'bf16' } });
    const put = await server.memoryCall({ pkg, twin: null, call: { op: 'put', name: 'a', text: 'one' } });
    assert.equal(put.result, 'ok');
    assert.equal((await server.memoryCall({ pkg, twin: put.twin, call: { op: 'get', name: 'a' } })).result, 'one');
    assert.equal((await server.memoryCall({ pkg, twin: null, call: { op: 'get', name: 'a' } })).result, 'not found');
    await assert.rejects(server.memoryCall({ pkg, twin: null, call: { op: 'format' as never } }), /one of put/);
    assert.equal(executionHash(pkg).length, 64);
  } finally { server.stop(); }
});

test('junior-competence@1: distill at a cut of a development investigation the world ran, then a dataset of what verified', async () => {
  const dir = tmp();
  const f = await fixture(dir, toy());
  try {
    const m: CompetenceManifest = {
      format: 'junior-competence-manifest@1', id: 'distill', reference: executionHash(f.pkg),
      components: [{ id: 'cells-L1', rung: 6, lab: 'cells', level: 'L1', extractor: { id: 'model_accepted', version: 1 }, unit: 'solved', direction: 'up', target: 1, bad: 0, tolerance: 0 }],
      cases: [{ id: 'i1', kind: 'investigation', lab: 'cells', args: ['--seed', '2'], partition: 'development', group: 'g-i1', components: ['cells-L1'] }],
      investigation_repetitions: 1, execution: {}, sampling: { seed: 1 },
      promotion: { procedure: 'paired-cases@1', alpha: 0.05, permutations: 1000, seed: 1 },
      limits: { junior_args: ['--level', '1', '--flat', '--no-grade', '--tools', 'view', '--attempts', '2', '--max-tokens', '100000', '--max-judge-calls', '100000'], probe_max_tokens: 500, timeout_ms: 60000 }
    };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(f.pkg));
    const made = juniorLab.generate(1, { manifest: path.join(dir, 'manifest.json'), package: path.join(dir, 'package.json'), blobs: path.join(dir, 'blobs'), server: f.h.url, work: path.join(dir, 'work'), evaluations: '3', distillations: '2' } as never);
    assert.equal(await juniorLab.act!.start(made, { distill: { version: made.world.reference, case: 'i1', question: 1, mode: 'cut', checker: 'proposal' } }, 'a0', {} as never), null, 'no teacher configured: nothing is distilled');
    const spec = { ...made, teacher: { client: teacher(PROPOSE(1)), identity: { model: 'strong' } } };
    await juniorLab.explore!([{ id: 'development', spec }], Math.random, 1, {} as never);
    const parsed = juniorLab.act!.parse({ distill: { version: spec.world.reference, case: 'i1', question: 1, mode: 'cut', checker: 'proposal', instruction: 'distill-me: propose your model now.' } });
    assert.ok(typeof parsed !== 'string', String(parsed));
    const ex = await juniorLab.act!.start(spec, parsed, 'a1', {} as never);
    assert.ok(ex && ex.kind === 'records' && ex.what === 'examples', JSON.stringify(ex));
    assert.equal(ex.summary.state, 'verified', JSON.stringify(ex.rows));
    assert.equal(ex.summary.group, 'g-i1');
    const ds = await juniorLab.act!.start(spec, { dataset: { examples: [String(ex.summary.example)], admits: ['verified'] } }, 'a2', {} as never);
    assert.ok(ds && ds.kind === 'records' && ds.what === 'dataset');
    assert.deepEqual(ds.summary.shares_selection_groups, []);
    assert.equal(await juniorLab.act!.start(spec, { distill: { version: spec.world.reference, case: 'nope', question: 0, mode: 'start', checker: 'protocol' } }, 'a3', {} as never), null);
  } finally { f.server.stop(); await f.h.close(); }
});
