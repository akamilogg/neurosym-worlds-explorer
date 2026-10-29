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
import { SessionServer, type JuniorWorker, type WorkerResult } from '../src/junior/sessions.ts';
import { serveJunior } from '../src/junior/http.ts';
import { JuniorSessionClient } from '../src/junior/client.ts';
import { buildMemory, memoryDiff } from '../src/junior/memory.ts';
import type { CompetenceManifest } from '../src/junior/competence.ts';
import { juniorLab } from '../src/worlds/junior/lab.ts';

/* SPEC-METAPOLITICA-APRENDIZAJE §5.3, §7, MA3: the initial memory written by the junior itself and checked by its reference,
   and the memory of a development investigation published into a new junior. */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'junior-memory-'));
const LOOK = { investigate: [{ view: 'ep1', from: 0, to: 2 }] };
const PROPOSE = (round: number) => ({ rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]', validate: false,
  beliefs: [{ id: 'same', stance: round === 1 ? 'new' : 'keep', statement: 'the row repeats', evidence: [] }], lessons: ['l'], next_experiment: 'n' });

const standIn: FetchLike = async () => {
  const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(LOOK) } }], usage: { total_tokens: 1 } });
  return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
};

/** A junior whose memory is real state with its twin (a JSON map). It writes the files it is asked to (garbling one named
    "bad"); in an investigation it notes that it has seen one; at a probe it keeps to the protocol only if its memory holds
    a note `protocol` or `seen`. */
function memoryJunior(): JuniorWorker {
  return {
    async run(job): Promise<WorkerResult> {
      const mem: Record<string, string> = job.state.twin ? JSON.parse(job.store.get(job.state.twin).toString('utf8')) : {};
      const parts = ((job.content as { user: { parts: string[] } }).user.parts).map((p) => { try { return JSON.parse(p); } catch { return {}; } });
      let text: string;
      const writing = parts.find((p) => p.files && p.task);
      if (writing) {
        for (const [n, t] of Object.entries(writing.files as Record<string, string>)) mem[n] = n === 'bad' ? t + ' (garbled)' : t;
        text = 'DONE';
      } else if (parts.some((p) => p.evaluator_message)) {
        text = mem.protocol || mem.seen ? JSON.stringify(LOOK) : 'Let me think first.';
      } else {
        mem.seen = '1';
        const first = parts[0] ?? {};
        text = JSON.stringify('task' in first ? { rationale: 'r', beliefs: [{ id: 'same', stance: 'keep', why: 'w' }], lessons: ['l'], next_experiment: 'n' }
          : !parts.some((p) => p.investigation_step) ? LOOK : PROPOSE(first.round));
      }
      const twin = Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(mem).sort())));
      return { served: job.execution, terminal: 'answered', text, trace: '{}', ops: [], after: { neural: Buffer.concat([Buffer.from('n:'), twin]), twin }, usage: null };
    },
    async render(job) { return job.twin ? JSON.parse(job.twin.toString('utf8')) : {}; }
  };
}

async function setup(dir: string, withInvestigation: boolean) {
  const src = await runLaboratory(cellsLab, { args: ['--seed', '1', '--level', '1', '--flat', '--no-grade', '--tools', 'view', '--attempts', '1', '--out', path.join(dir, 'src.json')],
    root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch: standIn, print: () => {} });
  const q0 = await captureCut(src.journal, 0);
  const blobs = path.join(dir, 'blobs');
  const store = new BlobStore(blobs);
  const base = path.join(dir, 'base');
  fs.mkdirSync(base);
  fs.writeFileSync(path.join(base, 'w'), 'w');
  const b = (s: string) => store.put(s);
  const pkg = normalizePackage({ format: 'junior-package@1', name: 'j', base: store.putTree(base), prompt: '',
    execution: { firmware: b('f'), tokenizer: b('t'), chat_template: b('c'), driver: b('d'), verifier: b('v'), circuit: {}, precision: 'bf16' } });
  const server = new SessionServer({ root: path.join(dir, 'junior'), store, worker: memoryJunior() });
  const h = await serveJunior(server);
  const probes = Array.from({ length: 6 }, (_, i) => ({ id: 'p' + i, kind: 'probe' as const, partition: 'development' as const, group: 'g-src', component: 'protocol-start', lab: 'cells', mode: 'start' as const,
    cut: { run: src.journal, question: 0, hash: q0.hash }, competence: 'protocol', instruction: 'Answer in the protocol (' + i + ').', checker: { id: 'protocol', version: 1 } }));
  const m: CompetenceManifest = {
    format: 'junior-competence-manifest@1', id: 'memory', reference: executionHash(pkg),
    components: [
      { id: 'protocol-start', rung: 1, mode: 'start', extractor: { id: 'probe', version: 1 }, unit: 'share', direction: 'up', target: 1, bad: 0, tolerance: 0, protected: true },
      ...(withInvestigation ? [{ id: 'cells-L1', rung: 6 as const, lab: 'cells', level: 'L1', extractor: { id: 'model_accepted', version: 1 }, unit: 'solved', direction: 'up' as const, target: 1, bad: 0, tolerance: 0 }] : [])
    ],
    cases: [...probes, ...(withInvestigation ? [{ id: 'i1', kind: 'investigation' as const, lab: 'cells', args: ['--seed', '2'], partition: 'development' as const, group: 'g-i1', components: ['cells-L1'] }] : [])],
    investigation_repetitions: 1, execution: {}, sampling: { seed: 1 },
    promotion: { procedure: 'paired-cases@1', alpha: 0.05, permutations: 1000, seed: 1 },
    limits: { junior_args: ['--level', '1', '--flat', '--no-grade', '--tools', 'view', '--attempts', '2', '--max-tokens', '100000', '--max-judge-calls', '100000'], probe_max_tokens: 500, timeout_ms: 60000 }
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  const spec = juniorLab.generate(1, { manifest: path.join(dir, 'manifest.json'), package: path.join(dir, 'package.json'), blobs, server: h.url, work: path.join(dir, 'work'), evaluations: '5' } as never);
  return { spec, server, h, pkg, store };
}

test('memory written by the junior itself: accepted only when its reference reads exactly what was asked', async () => {
  const dir = tmp();
  const { server, h, pkg } = await setup(dir, false);
  try {
    const client = new JuniorSessionClient(h.url);
    const ledger = path.join(dir, 'memory.jsonl');
    const ok = await buildMemory({ client, pkg, files: { protocol: 'Answer with the JSON the protocol asks for.' }, ledger });
    assert.ok(!('error' in ok), JSON.stringify(ok));
    assert.deepEqual(ok.files, { protocol: 'Answer with the JSON the protocol asks for.' });
    const again = await buildMemory({ client, pkg, files: { protocol: 'Answer with the JSON the protocol asks for.' }, ledger });
    assert.ok(!('error' in again) && again.session === ok.session, 'the same memory asked is written once');
    const bad = await buildMemory({ client, pkg, files: { bad: 'x' }, ledger });
    assert.ok('error' in bad && bad.attempts.length === 2 && /bad differs/.test(bad.attempts[0].why));
    assert.deepEqual(memoryDiff({ a: '1' }, { a: '1', b: '2' }), ['extra b']);
  } finally { server.stop(); await h.close(); }
});

test('junior-competence@1: a memory file is a lever; a memory not written as asked cannot be evaluated', async () => {
  const dir = tmp();
  const { spec, server, h } = await setup(dir, false);
  try {
    const base = await juniorLab.explore!([{ id: 'development', spec }], Math.random, 1, {} as never);
    assert.ok(base[1].episode.kind === 'evaluation' && base[1].episode.components[0].deficit === 1);
    const v = await juniorLab.act!.start(spec, { change: { from: spec.world.reference, files: { 'memory/protocol': 'Answer with the JSON the protocol asks for.' }, why: 'a reminder in memory', expect: 'answers accepted' } }, 'a1', {} as never);
    assert.ok(v && v.kind === 'version' && v.lines.some((l) => l.file === 'memory/protocol'));
    const run = await juniorLab.act!.start(spec, { run: { version: v!.version } }, 'a2', {} as never);
    assert.ok(run && run.kind === 'evaluation' && run.components[0].deficit === 0, 'the memory, not the prompt, made the difference');
    const pkg = await spec.world.packageOf(v!.version);
    assert.ok(typeof pkg !== 'string' && pkg.prompt === '' && pkg.memory.twin !== null);
    assert.equal((await juniorLab.artifact!.check(spec, v!.version, { round: 1, purpose: 'check', index: 0 }, {} as never)).holds, true);
    const bad = await juniorLab.act!.start(spec, { change: { from: spec.world.reference, files: { 'memory/bad': 'x' }, why: 'w', expect: 'e' } }, 'a3', {} as never);
    assert.ok(bad && bad.kind === 'version');
    assert.equal(await juniorLab.act!.start(spec, { run: { version: bad.version } }, 'a4', {} as never), null);
    assert.match(String(await spec.world.evaluate(bad.version)), /its memory was not written/);
    assert.equal(await juniorLab.act!.start(spec, { change: { from: spec.world.reference, files: { 'memory.state.json': '{}' }, why: 'w', expect: 'e' } }, 'a5', {} as never), null, 'a published memory is never a change');
  } finally { server.stop(); await h.close(); }
});

test('publish_memory: what the junior kept from a development investigation becomes a junior of its own, rebuilt from the record', async () => {
  const dir = tmp();
  const { spec, server, h } = await setup(dir, true);
  try {
    const explored = await juniorLab.explore!([{ id: 'development', spec }], Math.random, 1, {} as never);
    const baseline = explored[1].episode;
    assert.ok(baseline.kind === 'evaluation');
    const session = baseline.sessions.i1;
    assert.ok(session, 'the investigation\'s session is shown');
    assert.equal(await juniorLab.act!.start(spec, { publish_memory: { from: spec.world.reference, session: 'not-ours', why: 'w', expect: 'e' } }, 'a0', {} as never), null);
    const parsed = juniorLab.act!.parse({ publish_memory: { from: spec.world.reference, session, why: 'what it learned helps', expect: 'the protocol kept' } });
    assert.ok(typeof parsed !== 'string');
    const v = await juniorLab.act!.start(spec, parsed, 'a1', {} as never);
    assert.ok(v && v.kind === 'version' && v.lines.some((l) => l.file === 'memory (published)/seen'));
    const run = await juniorLab.act!.start(spec, { run: { version: v!.version } }, 'a2', {} as never);
    assert.ok(run && run.kind === 'evaluation' && run.components[0].deficit === 0);
    // Rebuilt from the record: the same version, the state from the world's own ledger.
    const again = juniorLab.generate(1, { manifest: path.join(dir, 'manifest.json'), package: path.join(dir, 'package.json'), blobs: path.join(dir, 'blobs'), server: h.url, work: path.join(dir, 'work'), evaluations: '5' } as never);
    juniorLab.rebuild!(again, [{ type: 'investigation', requests: [{ act: parsed }] }]);
    assert.ok(again.world.store.get(v!.version), 'the published version exists again');
  } finally { server.stop(); await h.close(); }
});
