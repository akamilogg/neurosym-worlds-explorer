import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';
import type { FetchLike } from '../src/core/net.ts';
import { captureCut, checkAtCut, runProbes } from '../src/junior/probes.ts';
import { BlobStore, executionHash, normalizePackage } from '../src/junior/package.ts';
import { SessionServer, type JuniorWorker } from '../src/junior/sessions.ts';
import { serveJunior } from '../src/junior/http.ts';
import { JuniorSessionClient } from '../src/junior/client.ts';
import { competenceHash, competenceProblems, measure, type CompetenceManifest } from '../src/junior/competence.ts';

/* SPEC-METAPOLITICA-APRENDIZAJE §6.4, MA2: probes cut from a run by its own replay log, the answer checked by the harness's
   own contract at that point. */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'junior-probes-'));
type Message = { role: string; content: string };
const parts = (messages: Message[]) => messages.slice(1).map((m) => { try { return JSON.parse(m.content); } catch { return {}; } });

const LOOK = { investigate: [{ view: 'ep1', from: 0, to: 2 }] };
const PROPOSE = (round: number) => ({ rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]', validate: false,
  beliefs: [{ id: 'same', stance: round === 1 ? 'new' : 'keep', statement: 'the row repeats', evidence: [] }], lessons: ['l'], next_experiment: 'n' });

/** The stand-in System 2 of the source run: it looks once, then proposes. */
const standIn: FetchLike = async (_url, init) => {
  const ps = parts(JSON.parse(String(init.body)).messages);
  const first = ps[0] ?? {};
  const content = 'task' in first ? { rationale: 'r', beliefs: [{ id: 'same', stance: 'keep', why: 'w' }], lessons: ['l'], next_experiment: 'n' }
    : !ps.some((p) => p.investigation_step) ? LOOK : PROPOSE(first.round);
  const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
  return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
};

async function sourceRun(dir: string): Promise<string> {
  const r = await runLaboratory(cellsLab, { args: ['--seed', '1', '--level', '1', '--flat', '--no-grade', '--tools', 'view', '--attempts', '2', '--out', path.join(dir, 'src.json')],
    root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch: standIn, print: () => {} });
  return r.journal;
}

test('a cut: the run resumed to its question asks what it asked then; the answer is checked by the harness at that point', async () => {
  const dir = tmp();
  const run = await sourceRun(dir);
  const q0 = await captureCut(run, 0);
  assert.equal(q0.lab, 'cells');
  assert.ok(q0.content.system.length > 0);
  assert.equal((await captureCut(run, 0)).hash, q0.hash, 'the same cut, the same hash');
  await assert.rejects(captureCut(run, 99), /never answered question 99/);
  const ok = await checkAtCut(q0, JSON.stringify(LOOK), { id: 'protocol', version: 1 }, {});
  assert.deepEqual([ok.state, ok.pass], ['measured', true], ok.detail);
  const view = await checkAtCut(q0, JSON.stringify(LOOK), { id: 'request', version: 1 }, { request: 'view' });
  assert.equal(view.pass, true, view.detail);
  const act = await checkAtCut(q0, JSON.stringify(LOOK), { id: 'request', version: 1 }, { request: 'act' });
  assert.equal(act.pass, false, 'a view is not an act');
  const garbage = await checkAtCut(q0, 'I would like to look at the data.', { id: 'protocol', version: 1 }, {});
  assert.deepEqual([garbage.state, garbage.pass], ['measured', false], garbage.detail);
  // Question 1: after its investigation step, a proposal is checked.
  const q1 = await captureCut(run, 1);
  const proposed = await checkAtCut(q1, JSON.stringify(PROPOSE(1)), { id: 'proposal', version: 1 }, {});
  assert.equal(proposed.pass, true, proposed.detail);
  const tampered = await checkAtCut({ ...q1, hash: 'x' }, JSON.stringify(PROPOSE(1)), { id: 'proposal', version: 1 }, {});
  assert.deepEqual([tampered.state, tampered.detail], ['infra', 'the cut is not the one declared']);
});

test('a candidate answers the manifest probes through its server, each once, its task visible; they become its components', async () => {
  const dir = tmp();
  const run = await sourceRun(dir);
  const q0 = await captureCut(run, 0);
  const store = new BlobStore(path.join(dir, 'blobs'));
  const base = path.join(dir, 'base');
  fs.mkdirSync(base);
  fs.writeFileSync(path.join(base, 'w'), 'w');
  const b = (s: string) => store.put(s);
  const pkg = normalizePackage({ format: 'junior-package@1', name: 'j', base: store.putTree(base), prompt: '',
    execution: { firmware: b('f'), tokenizer: b('t'), chat_template: b('c'), driver: b('d'), verifier: b('v'), circuit: {}, precision: 'bf16' } });
  const execution = executionHash(pkg);
  const seen: string[][] = [];
  const worker: JuniorWorker = { async run(job) {
    const ps = (job.content as { user: { parts: string[] } }).user.parts;
    seen.push(ps);
    return { served: job.execution, terminal: 'answered', text: JSON.stringify(LOOK), trace: '{}', ops: [], after: { neural: null, twin: null }, usage: null };
  } };
  const server = new SessionServer({ root: path.join(dir, 'junior'), store, worker });
  const h = await serveJunior(server);
  try {
    const probe = (id: string, component: string, checker: string) => ({ id, kind: 'probe' as const, partition: 'development' as const, group: 'g-src', component, lab: 'cells', mode: 'start' as const,
      cut: { run, question: 0, hash: q0.hash }, competence: component, instruction: 'Emit one valid request.', checker: { id: checker, version: 1 } });
    const m: CompetenceManifest = {
      format: 'junior-competence-manifest@1', id: 'probes', reference: execution,
      components: [
        { id: 'protocol-start', rung: 1, mode: 'start', extractor: { id: 'probe', version: 1 }, unit: 'share', direction: 'up', target: 1, bad: 0, tolerance: 0 },
        { id: 'act-start', rung: 2, mode: 'start', request: 'act', extractor: { id: 'probe', version: 1 }, unit: 'share', direction: 'up', target: 1, bad: 0, tolerance: 0 }
      ],
      cases: [probe('p-protocol', 'protocol-start', 'protocol'), probe('p-act', 'act-start', 'request')],
      investigation_repetitions: 1, execution: {}, sampling: { seed: 1 },
      promotion: { procedure: 'paired-cases@1', alpha: 0.05, permutations: 1000, seed: 1 },
      limits: { junior_args: ['--max-tokens', '1', '--max-judge-calls', '1'], probe_max_tokens: 500, timeout_ms: 60000 }
    };
    assert.deepEqual(competenceProblems(m), []);
    const ledger = path.join(dir, 'probes.jsonl');
    const client = new JuniorSessionClient(h.url);
    const obs = await runProbes(m, competenceHash(m), { pkg, execution, client, ledger });
    assert.deepEqual(obs.map((o) => [o.case, o.value]), [['p-protocol', 1], ['p-act', 0]]);
    assert.deepEqual(measure(m, 'development', 0, obs).vector, [0, 1]);
    assert.match(seen[0].at(-1)!, /evaluator_message.*Emit one valid request/, 'the task is visible, after the prefix');
    assert.equal(seen[0].length, q0.content.user.parts.length + 1);
    // Asked again: the ledger answers.
    await runProbes(m, competenceHash(m), { pkg, execution, client, ledger });
    assert.equal(seen.length, 2);
  } finally { server.stop(); await h.close(); }
});

test('a whole evaluation: investigations and probes measured, kept; promotion from what was measured; lab junior cut', async () => {
  const { evaluate, promoteEvaluations, prepareManifest } = await import('../src/junior/evaluate.ts');
  const { inProcessLauncher } = await import('../src/meta/lab.ts');
  const { labCli } = await import('../src/runtime/cli.ts');
  const dir = tmp();
  const run = await sourceRun(dir);
  const lines: string[] = [];
  assert.equal(await labCli(['junior', 'cut', run, '0'], { root: dir, out: (l: string) => { lines.push(l); } } as never), 0);
  const hash = lines[0].split(' ')[1];
  const store = new BlobStore(path.join(dir, 'blobs'));
  const base = path.join(dir, 'base');
  fs.mkdirSync(base);
  fs.writeFileSync(path.join(base, 'w'), 'w');
  const b = (s: string) => store.put(s);
  const pkg = normalizePackage({ format: 'junior-package@1', name: 'j', base: store.putTree(base), prompt: '',
    execution: { firmware: b('f'), tokenizer: b('t'), chat_template: b('c'), driver: b('d'), verifier: b('v'), circuit: {}, precision: 'bf16' } });
  const execution = executionHash(pkg);
  const worker: JuniorWorker = { async run(job) {
    const ps = (job.content as { user: { parts: string[] } }).user.parts.map((p) => { try { return JSON.parse(p); } catch { return {}; } });
    const first = ps[0] ?? {};
    const answer = 'task' in first ? { rationale: 'r', beliefs: [{ id: 'same', stance: 'keep', why: 'w' }], lessons: ['l'], next_experiment: 'n' } : !ps.some((p) => p.investigation_step) ? LOOK : PROPOSE(first.round);
    return { served: job.execution, terminal: 'answered', text: JSON.stringify(answer), trace: '{}', ops: [], after: { neural: null, twin: null }, usage: null };
  } };
  const server = new SessionServer({ root: path.join(dir, 'junior'), store, worker });
  const h = await serveJunior(server);
  try {
    const m: CompetenceManifest = {
      format: 'junior-competence-manifest@1', id: 'whole', reference: execution,
      components: [
        { id: 'protocol-start', rung: 1, mode: 'start', extractor: { id: 'probe', version: 1 }, unit: 'share', direction: 'up', target: 1, bad: 0, tolerance: 0, protected: true },
        { id: 'cells-L1', rung: 6, lab: 'cells', level: 'L1', extractor: { id: 'model_accepted', version: 1 }, unit: 'solved', direction: 'up', target: 1, bad: 0, tolerance: 0 }
      ],
      cases: [
        { id: 'p0', kind: 'probe', partition: 'development', group: 'g-src', component: 'protocol-start', lab: 'cells', mode: 'start', cut: { run, question: 0, hash }, competence: 'protocol', instruction: 'Answer in the protocol.', checker: { id: 'protocol', version: 1 } },
        { id: 'i1', kind: 'investigation', lab: 'cells', args: ['--seed', '2'], partition: 'development', group: 'g-i1', components: ['cells-L1'] }
      ],
      investigation_repetitions: 1, execution: {}, sampling: { seed: 1 },
      promotion: { procedure: 'paired-cases@1', alpha: 0.05, permutations: 1000, seed: 1 },
      limits: { junior_args: ['--level', '1', '--flat', '--no-grade', '--tools', 'view', '--attempts', '2', '--max-tokens', '100000', '--max-judge-calls', '100000'], probe_max_tokens: 500, timeout_ms: 60000 }
    };
    const prepared = await prepareManifest(m);
    assert.deepEqual(prepared.problems, []);
    const e = await evaluate({ dir: path.join(dir, 'eval'), manifest: m, manifestHash: prepared.hash, pkg, client: new JuniorSessionClient(h.url), launcher: inProcessLauncher({ root: dir, llm: { url: '', model: undefined } }) });
    assert.equal(e.measure.complete, true, JSON.stringify(e.measure.components.map((c) => c.missing)));
    assert.equal(e.measure.components[0].quality, 0, 'it answered in the protocol at the cut');
    assert.equal(fs.readdirSync(path.join(dir, 'eval', 'evaluations')).length, 1);
    assert.equal(promoteEvaluations(m, prepared.hash, e, e).verdict, 'inconclusive', 'the same junior is no improvement on itself');
    assert.match(promoteEvaluations(m, 'other', e, e).why, /another manifest/);
    const bad = await prepareManifest({ ...m, cases: [{ ...(m.cases[0] as object), cut: { run, question: 0, hash: 'f'.repeat(64) } } as never, m.cases[1]] });
    assert.match(bad.problems.join(), /not the one declared/);
  } finally { server.stop(); await h.close(); }
});
