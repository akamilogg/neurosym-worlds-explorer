import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';
import type { FetchLike } from '../src/core/net.ts';
import { BlobStore, executionHash, exportPackage, normalizePackage } from '../src/junior/package.ts';
import { SessionServer, type JuniorWorker, type WorkerResult } from '../src/junior/sessions.ts';
import { serveJunior } from '../src/junior/http.ts';
import { JuniorSessionClient } from '../src/junior/client.ts';
import { ConfirmationService, importPackage, readSummaries } from '../src/junior/confirm.ts';
import type { CompetenceManifest } from '../src/junior/competence.ts';
import { inProcessLauncher } from '../src/meta/lab.ts';
import { juniorLab } from '../src/worlds/junior/lab.ts';

/* SPEC-METAPOLITICA-APRENDIZAJE §9, MA6: confirmation out of the junior's machine - frozen packages imported and checked,
   evaluated by the operator's own server on reserved cases, the operator's report apart from the summary published. */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'junior-confirm-'));
const LOOK = { investigate: [{ view: 'ep1', from: 0, to: 2 }] };
const PROPOSE = (round: number) => ({ rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]', validate: false,
  beliefs: [{ id: 'same', stance: round === 1 ? 'new' : 'keep', statement: 'the row repeats', evidence: [] }], lessons: ['l'], next_experiment: 'n' });

/** A junior that investigates like the stand-in when its prompt says so, and answers nothing usable otherwise. */
const toy: JuniorWorker = {
  async run(job): Promise<WorkerResult> {
    const parts = ((job.content as { user: { parts: string[] } }).user.parts).map((p) => { try { return JSON.parse(p); } catch { return {}; } });
    const first = parts[0] ?? {};
    const text = !job.pkg.prompt.includes('JSON') ? 'Let me think first.'
      : JSON.stringify('task' in first ? { rationale: 'r', beliefs: [{ id: 'same', stance: 'keep', why: 'w' }], lessons: ['l'], next_experiment: 'n' } : !parts.some((p) => p.investigation_step) ? LOOK : PROPOSE(first.round));
    return { served: job.execution, terminal: 'answered', text, trace: '{}', ops: [], after: { neural: Buffer.from('n'), twin: Buffer.from('{}') }, usage: null };
  }
};

function packages(store: BlobStore) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'junior-confirm-base-'));
  fs.writeFileSync(path.join(base, 'w'), 'w');
  const b = (s: string) => store.put(s);
  const reference = normalizePackage({ format: 'junior-package@1', name: 'ref', base: store.putTree(base), prompt: 'Be brief.',
    execution: { firmware: b('f'), tokenizer: b('t'), chat_template: b('c'), driver: b('d'), verifier: b('v'), circuit: {}, precision: 'bf16' } });
  const candidate = normalizePackage({ ...reference, name: 'cand', prompt: 'Answer only with the JSON the protocol asks for.', provenance: { parents: [executionHash(reference)], reason: 'trained', sources: ['dataset:abc'] } });
  return { reference, candidate };
}

function confirmationManifest(reference: string, n: number): CompetenceManifest {
  return {
    format: 'junior-competence-manifest@1', id: 'confirmation', reference,
    components: [{ id: 'cells-L1', rung: 6, lab: 'cells', level: 'L1', extractor: { id: 'model_accepted', version: 1 }, unit: 'solved', direction: 'up', target: 1, bad: 0, tolerance: 0 }],
    cases: Array.from({ length: n }, (_, i) => ({ id: 'reserved-' + i, kind: 'investigation' as const, lab: 'cells', args: ['--seed', String(100 + i)], partition: 'confirmation' as const, group: 'r' + i, components: ['cells-L1'] })),
    investigation_repetitions: 1, execution: {}, sampling: { seed: 1 },
    promotion: { procedure: 'paired-cases@1', alpha: 0.05, permutations: 1000, seed: 1 },
    limits: { junior_args: ['--level', '1', '--flat', '--no-grade', '--tools', 'view', '--attempts', '2', '--max-tokens', '100000', '--max-judge-calls', '100000'], probe_max_tokens: 500, timeout_ms: 60000 }
  };
}

test('confirmation on the operator\'s machine: imported and checked, evaluated by its own server, its report kept, only the summary published', async () => {
  /* The junior's machine: its packages, exported closed. */
  const junior = tmp();
  const jstore = new BlobStore(path.join(junior, 'blobs'));
  const { reference, candidate } = packages(jstore);
  exportPackage(reference, jstore, path.join(junior, 'export-ref'));
  exportPackage(candidate, jstore, path.join(junior, 'export-cand'));
  /* The operator's machine: its own store and server, its own manifest of reserved cases. */
  const op = tmp();
  const server = new SessionServer({ root: path.join(op, 'junior'), store: new BlobStore(path.join(op, 'blobs')), worker: toy });
  const h = await serveJunior(server);
  try {
    const m = confirmationManifest(executionHash(reference), 2);
    assert.throws(() => new ConfirmationService({ root: op, manifest: { ...m, cases: m.cases.map((c) => ({ ...c, partition: 'development' as const })) }, client: new JuniorSessionClient(h.url),
      launcher: inProcessLauncher({ root: op, llm: { url: '', model: undefined } }) }), /no confirmation case/);
    const svc = new ConfirmationService({ root: op, manifest: m, client: new JuniorSessionClient(h.url), launcher: inProcessLauncher({ root: op, llm: { url: '', model: undefined } }), maxExposures: 1 });
    // An export altered on the way is refused.
    const tampered = path.join(junior, 'export-tampered');
    fs.cpSync(path.join(junior, 'export-cand'), tampered, { recursive: true });
    fs.writeFileSync(new BlobStore(path.join(tampered, 'blobs')).pathOf(candidate.execution.firmware), 'another firmware');
    assert.throws(() => importPackage(tampered, new BlobStore(path.join(tmp(), 'b'))), /does not match its hash/);
    await assert.rejects(svc.confirm(path.join(junior, 'export-cand'), path.join(junior, 'export-cand')), /not the manifest's reference/);
    const r = await svc.confirm(path.join(junior, 'export-cand'), path.join(junior, 'export-ref'));
    assert.ok(['promoted', 'not_promoted', 'inconclusive'].includes(r.verdict));
    assert.ok(r.summary, 'a whole measure is published');
    const summary = JSON.parse(fs.readFileSync(r.summary, 'utf8'));
    assert.deepEqual(Object.keys(summary).sort(), ['candidate', 'components', 'format', 'id', 'manifest', 'provenance', 'reference', 'verdict']);
    assert.doesNotMatch(JSON.stringify(summary), /reserved-|--seed|journal|twin/, 'no case, trace or memory leaves');
    assert.deepEqual(summary.provenance, { distilled: true, trained: false, initial_memory: false, forced_format: false });
    const report = JSON.parse(fs.readFileSync(r.report, 'utf8'));
    assert.deepEqual(report.cases, ['reserved-0', 'reserved-1']);
    assert.equal(report.candidate.observations.length, 2);
    /* Its own store holds what it ran: it never read the junior's. */
    assert.ok(new BlobStore(path.join(op, 'blobs')).intact(candidate.execution.firmware));
    // Exposed once: with at most one exposure, the reserved cases are development now.
    await assert.rejects(svc.confirm(path.join(junior, 'export-cand'), path.join(junior, 'export-ref')), /exposed 1 times: they are development now/);
    assert.equal(readSummaries(path.join(op, 'outbox')).length, 1);
  } finally { server.stop(); await h.close(); }
});

test('junior-competence@1: the researcher reads the confirmations of its juniors - the summaries, nothing more', async () => {
  const dir = tmp();
  const standIn: FetchLike = async () => {
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(LOOK) } }], usage: { total_tokens: 1 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
  await runLaboratory(cellsLab, { args: ['--seed', '1', '--level', '1', '--flat', '--no-grade', '--tools', 'view', '--attempts', '1', '--out', path.join(dir, 'src.json')],
    root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch: standIn, print: () => {} });
  const store = new BlobStore(path.join(dir, 'blobs'));
  const { reference } = packages(store);
  const server = new SessionServer({ root: path.join(dir, 'junior'), store, worker: toy });
  const h = await serveJunior(server);
  try {
    const m = { ...confirmationManifest(executionHash(reference), 1), cases: [{ id: 'i1', kind: 'investigation' as const, lab: 'cells', args: ['--seed', '2'], partition: 'development' as const, group: 'g', components: ['cells-L1'] }] };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(reference));
    const outbox = path.join(dir, 'confirmations');
    fs.mkdirSync(outbox);
    fs.writeFileSync(path.join(outbox, 's1.json'), JSON.stringify({ format: 'confirmation-summary@1', id: 's1', manifest: 'm', candidate: executionHash(reference), reference: executionHash(reference),
      verdict: 'inconclusive', components: [{ id: 'cells-L1', improves: false, regresses: false, p: 0.5 }], provenance: { distilled: false }, cases: ['secret-case'] }));
    fs.writeFileSync(path.join(outbox, 'note.json'), JSON.stringify({ format: 'something else', secret: 'x' }));
    const spec = juniorLab.generate(1, { manifest: path.join(dir, 'manifest.json'), package: path.join(dir, 'package.json'), blobs: path.join(dir, 'blobs'), server: h.url, work: path.join(dir, 'work'), evaluations: '2', confirmations: outbox } as never);
    await juniorLab.explore!([{ id: 'development', spec }], Math.random, 1, {} as never);
    assert.ok(fs.existsSync(path.join(dir, 'work', 'packages', spec.world.reference + '.json')), 'the package is where the operator exports it from');
    const e = await juniorLab.act!.start(spec, juniorLab.act!.parse({ confirmations: {} }) as never, 'a1', {} as never);
    assert.ok(e && e.kind === 'records' && e.what === 'confirmations');
    assert.equal(e.rows.length, 1);
    assert.equal(e.rows[0].version, spec.world.reference);
    assert.doesNotMatch(JSON.stringify(e.rows), /secret|"p":/, 'only a summary\'s own fields reach the researcher');
  } finally { server.stop(); await h.close(); }
});
