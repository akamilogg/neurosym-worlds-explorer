import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';
import type { FetchLike } from '../src/core/net.ts';
import { captureCut } from '../src/junior/probes.ts';
import { BlobStore, executionHash, normalizePackage } from '../src/junior/package.ts';
import { SessionServer, type JuniorWorker } from '../src/junior/sessions.ts';
import { serveJunior } from '../src/junior/http.ts';
import type { CompetenceManifest } from '../src/junior/competence.ts';
import { juniorLab } from '../src/worlds/junior/lab.ts';
import { LABS } from '../src/worlds/labs.ts';

/* SPEC-METAPOLITICA-APRENDIZAJE §6, §7.1, MA2: the world whose artifact is the junior - its baseline, its changes, its runs
   as jobs and its verdict against the reference. */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'junior-world-'));
const LOOK = { investigate: [{ view: 'ep1', from: 0, to: 2 }] };

const standIn: FetchLike = async () => {
  const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(LOOK) } }], usage: { total_tokens: 1 } });
  return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
};

test('junior-competence@1: the baseline explored first, a change makes a junior, a run evaluates it once, paired-cases@1 judges it', async () => {
  assert.equal(LABS.junior, juniorLab);
  const dir = tmp();
  const src = await runLaboratory(cellsLab, { args: ['--seed', '1', '--level', '1', '--flat', '--no-grade', '--tools', 'view', '--attempts', '1', '--out', path.join(dir, 'src.json')],
    root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch: standIn, print: () => {} });
  const q0 = await captureCut(src.journal, 0);
  const blobs = path.join(dir, 'blobs');
  const store = new BlobStore(blobs);
  const base = path.join(dir, 'base');
  fs.mkdirSync(base);
  fs.writeFileSync(path.join(base, 'w'), 'w');
  const b = (s: string) => store.put(s);
  const pkg = normalizePackage({ format: 'junior-package@1', name: 'j', base: store.putTree(base), prompt: 'Be brief.',
    execution: { firmware: b('f'), tokenizer: b('t'), chat_template: b('c'), driver: b('d'), verifier: b('v'), circuit: {}, precision: 'bf16' } });
  /* A junior that keeps to the protocol only when its starting prompt tells it to. */
  const asked: string[] = [];
  const worker: JuniorWorker = { async run(job) {
    asked.push(job.pkg.prompt);
    const text = job.pkg.prompt.includes('JSON') ? JSON.stringify(LOOK) : 'Let me think about the data first.';
    return { served: job.execution, terminal: 'answered', text, trace: '{}', ops: [], after: { neural: null, twin: null }, usage: null };
  } };
  const server = new SessionServer({ root: path.join(dir, 'junior'), store, worker });
  const h = await serveJunior(server);
  try {
    const probes = Array.from({ length: 6 }, (_, i) => ({ id: 'p' + i, kind: 'probe' as const, partition: 'development' as const, group: 'g-src', component: 'protocol-start', lab: 'cells', mode: 'start' as const,
      cut: { run: src.journal, question: 0, hash: q0.hash }, competence: 'protocol', instruction: 'Answer in the protocol (' + i + ').', checker: { id: 'protocol', version: 1 } }));
    const m: CompetenceManifest = {
      format: 'junior-competence-manifest@1', id: 'world', reference: executionHash(pkg),
      components: [{ id: 'protocol-start', rung: 1, mode: 'start', extractor: { id: 'probe', version: 1 }, unit: 'share', direction: 'up', target: 1, bad: 0, tolerance: 0, protected: true }],
      cases: probes, investigation_repetitions: 1, execution: {}, sampling: { seed: 1 },
      promotion: { procedure: 'paired-cases@1', alpha: 0.05, permutations: 1000, seed: 1 },
      limits: { junior_args: ['--max-tokens', '1', '--max-judge-calls', '1'], probe_max_tokens: 500, timeout_ms: 60000 }
    };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
    const spec = juniorLab.generate(1, { manifest: path.join(dir, 'manifest.json'), package: path.join(dir, 'package.json'), blobs, server: h.url, work: path.join(dir, 'work'), evaluations: '3' } as never);
    const explored = await juniorLab.explore!([{ id: 'development', spec }], Math.random, 1, {} as never);
    assert.deepEqual(explored.map((e) => e.episode.kind), ['version', 'evaluation']);
    const baseline = explored[1].episode;
    assert.ok(baseline.kind === 'evaluation' && baseline.complete && baseline.components[0].deficit === 1, 'the base junior answers nothing in the protocol');
    const act = juniorLab.act!.parse({ change: { from: spec.world.reference, files: { 'prompt.md': 'Answer only with the JSON the protocol asks for.' }, why: 'the protocol first', expect: 'answers accepted' } });
    assert.ok(typeof act !== 'string');
    const v = await juniorLab.act!.start(spec, act, 'a1', {} as never);
    assert.ok(v && v.kind === 'version');
    assert.equal(typeof juniorLab.act!.parse({ change: { from: spec.world.reference, files: { 'secret.txt': 'x' }, why: 'w', expect: 'e' } }), 'object');
    assert.equal(await juniorLab.act!.start(spec, { change: { from: spec.world.reference, files: { 'secret.txt': 'x' }, why: 'w', expect: 'e' } }, 'a2', {} as never), null, 'only the junior\'s editable parts change');
    const run = await juniorLab.act!.start(spec, { run: { version: v!.version } }, 'a3', {} as never);
    assert.ok(run && run.kind === 'evaluation' && run.components[0].deficit === 0);
    const before = asked.length;
    await juniorLab.act!.start(spec, { run: { version: v!.version } }, 'a4', {} as never);
    assert.equal(asked.length, before, 'the same version evaluated again is the same evaluation');
    assert.equal(spec.world.jobs.bags().evaluations.spent, 2, 'two juniors evaluated: the base and the change');
    const verdict = await juniorLab.artifact!.check(spec, v!.version, { round: 1, purpose: 'check', index: 0 }, {} as never);
    assert.equal(verdict.holds, true, JSON.stringify(verdict.view));
    assert.equal((verdict.view as { verdict: string }).verdict, 'promoted');
    const same = await juniorLab.artifact!.check(spec, spec.world.reference, { round: 1, purpose: 'check', index: 0 }, {} as never);
    assert.equal(same.holds, false);
  } finally { server.stop(); await h.close(); }
});
