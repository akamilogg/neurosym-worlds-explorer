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
import type { CompetenceManifest } from '../src/junior/competence.ts';
import { juniorLab } from '../src/worlds/junior/lab.ts';
import { excerptOf, nativeToolCall } from '../src/worlds/junior/behavior.ts';

/* SPEC-METAPOLITICA-APRENDIZAJE §7.2: the investigator sees how the junior answered, not only the value, and a refused
   act says why. The text stays out of the point the model is graded on, and out of a reserved case. */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'junior-behavior-'));
const LOOK = { investigate: [{ view: 'ep1', from: 0, to: 1 }] };
const PROPOSE = { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => 0', validate: false,
  beliefs: [{ id: 'same', stance: 'new', statement: 's', evidence: [] }], lessons: ['l'], next_experiment: 'n' };
const TOOL = '<tool_call><function=view><parameter=episode>ep1</parameter></function></tool_call>' + 'X'.repeat(400);
const standIn: FetchLike = async () => {
  const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(LOOK) } }], usage: { total_tokens: 1 } });
  return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
};

test('an excerpt keeps both ends, and native tool-call syntax is the harness\'s, not JSON', () => {
  const short = excerptOf('{"investigate":[]}', 20);
  assert.equal(short.tail, null);
  assert.equal(short.head, '{"investigate":[]}');
  const long = excerptOf(TOOL, 160);
  assert.equal(long.head.length, 160);
  assert.equal(long.tail?.length, 160);
  assert.ok(long.head.startsWith('<tool_call>'));
  assert.ok(long.tail?.endsWith('X'));
  assert.equal(nativeToolCall(TOOL), true);
  assert.equal(nativeToolCall(JSON.stringify(LOOK)), false);
});

test('junior-competence@1: a run shows how the junior answered; a refusal says why; the grade and the holdout do not see the text', async () => {
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
  const pkg = normalizePackage({ format: 'junior-package@1', name: 'j', base: store.putTree(base), prompt: '',
    execution: { firmware: b('f'), tokenizer: b('t'), chat_template: b('c'), driver: b('d'), verifier: b('v'), circuit: {}, precision: 'bf16' } });
  const worker: JuniorWorker = { async run(job): Promise<WorkerResult> {
    /* The system message names `investigation_step` as a word of the protocol: only the user parts say whether one came back. */
    const user = ((job.content as { user?: { parts?: string[] } }).user?.parts ?? []).join('\n');
    const usage = { prompt_tokens: 10, text_tokens: 4, circuit_tokens: 7, gpu_ms: 3 };
    const answer = (text: string, ops: WorkerResult['ops'] = []): WorkerResult => ({ served: job.execution, terminal: 'answered', text, trace: '{}', ops, after: { neural: null, twin: null }, usage });
    if (user.includes('HOLD-OUT-SECRET')) return answer('SECRET_HOLD_OUT ' + 'Z'.repeat(80));
    if (user.includes('evaluator_message')) return answer(TOOL);
    /* The first question of an investigation has no step back yet: answer with the native call. The next, with JSON. */
    if (!user.includes('investigation_step')) return user.includes('your_previous_answer_was_refused') ? answer(JSON.stringify(LOOK)) : answer(TOOL, [{ op: 'get', name: 'protocol' }]);
    return answer(JSON.stringify(PROPOSE));
  } };
  const server = new SessionServer({ root: path.join(dir, 'junior'), store, worker });
  const h = await serveJunior(server);
  try {
    const probe = (id: string, instruction: string) => ({ id, kind: 'probe' as const, partition: 'development' as const, group: 'g-src', component: 'protocol-start', lab: 'cells', mode: 'start' as const,
      cut: { run: src.journal, question: 0, hash: q0.hash }, competence: 'protocol', instruction, checker: { id: 'protocol', version: 1 } });
    const m: CompetenceManifest = {
      format: 'junior-competence-manifest@1', id: 'behavior', reference: executionHash(pkg),
      components: [
        { id: 'protocol-start', rung: 1, mode: 'start', extractor: { id: 'probe', version: 1 }, unit: 'share', direction: 'up', target: 1, bad: 0, tolerance: 0, protected: true },
        { id: 'cells-L1', rung: 6, lab: 'cells', level: 'L1', extractor: { id: 'model_accepted', version: 1 }, unit: 'solved', direction: 'up', target: 1, bad: 0, tolerance: 0 }
      ],
      cases: [probe('p0', 'Answer in the protocol.'), probe('pHold', 'HOLD-OUT-SECRET do not show this.'),
        { id: 'i1', kind: 'investigation', lab: 'cells', args: ['--seed', '2'], partition: 'development', group: 'g-i1', components: ['cells-L1'] }],
      holdout: ['pHold'],
      investigation_repetitions: 1, execution: {}, sampling: { seed: 1 },
      promotion: { procedure: 'paired-cases@1', alpha: 0.05, permutations: 1000, seed: 1 },
      limits: { junior_args: ['--level', '1', '--flat', '--no-grade', '--tools', 'view', '--attempts', '1', '--steps', '2', '--max-tokens', '100000', '--max-judge-calls', '100000'], probe_max_tokens: 500, timeout_ms: 60000 }
    };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
    const spec = juniorLab.generate(1, { manifest: path.join(dir, 'manifest.json'), package: path.join(dir, 'package.json'), blobs, server: h.url, work: path.join(dir, 'work'), evaluations: '2' } as never);
    const lines = JSON.stringify(juniorLab.interface!({ world: {} }));
    assert.match(lines, /not text in the prompt/);
    assert.match(lines, /any version you already have/);
    assert.match(lines, /view_trial/);
    assert.match(lines, /not emptied between runs/);

    const noTeacher = await juniorLab.act!.start(spec, { distill: { version: spec.world.reference, case: 'i1', question: 0, mode: 'start', checker: 'protocol' } }, 'd0', {} as never);
    assert.ok(noTeacher && noTeacher.kind === 'records' && noTeacher.what === 'refused' && /no teacher/.test(String(noTeacher.summary.reason)));

    const explored = await juniorLab.explore!([{ id: 'development', spec }], Math.random, 1, {} as never);
    const baseline = explored[1].episode;
    assert.ok(baseline.kind === 'evaluation');
    assert.ok(!JSON.stringify(baseline).includes('SECRET_HOLD_OUT'), 'the holdout\'s text is not in the episode');
    const shown0 = juniorLab.act!.shown(baseline);
    assert.ok(!JSON.stringify(shown0).includes('SECRET_HOLD_OUT'));
    const at = juniorLab.at!(baseline, 0)!;
    assert.ok(!JSON.stringify(at).includes('tool_call'), 'a point of the model does not carry the junior\'s text');
    assert.ok(!('behavior' in (at.state as object)));
    const graded = juniorLab.cases!(spec, 'ep', baseline, 1);
    assert.ok(!JSON.stringify(graded).includes('<tool_call>'));
    assert.ok(!JSON.stringify(graded).includes('head'));
    const index = juniorLab.indexInfo!(baseline) as { behavior: { native_tool_call: number } };
    assert.ok(index.behavior.native_tool_call >= 1);
    assert.ok(!JSON.stringify(index).includes('<tool_call>'), 'the index carries the counts, not the text');

    const v = await juniorLab.act!.start(spec, { change: { from: spec.world.reference, files: { 'prompt.md': 'Answer with JSON.' }, why: 'the protocol, with an example', expect: 'a request' } }, 'a1', {} as never);
    assert.ok(v && v.kind === 'version');
    const child = await juniorLab.act!.start(spec, { change: { from: v.version, files: { 'prompt.md': 'Answer with JSON, as {"investigate":[{"view":"ep1","from":0,"to":1}]}.' }, why: 'continue from this version, not the base', expect: 'the same protocol' } }, 'a2', {} as never);
    assert.ok(child && child.kind === 'version' && child.parent === v.version, 'a change starts from the version named, not only the base');

    const spent = spec.world.jobs.bags().evaluations.spent;
    const run = await juniorLab.act!.start(spec, { run: { version: child.version } }, 'a3', {} as never);
    assert.ok(run && run.kind === 'evaluation');
    const body = JSON.stringify(juniorLab.act!.shown(run));
    assert.match(body, /<tool_call>/);
    assert.ok(!body.includes('SECRET_HOLD_OUT'));
    const inv = run.behavior.find((c) => c.case === 'i1')!;
    assert.ok(inv.questions >= 2, JSON.stringify(inv));
    assert.ok(inv.native_tool_call >= 1, JSON.stringify(inv));
    assert.ok(inv.investigations >= 1);
    assert.ok(inv.protocol_ok >= 1);
    assert.ok(inv.tokens !== null && inv.tokens > 0);
    assert.ok(inv.circuit_tokens !== null && inv.circuit_tokens > 0);
    assert.ok(inv.ms !== null && inv.ms >= 0);
    const first = inv.answers.find((a) => a.native_tool_call)!;
    assert.equal(first.head.length, 160);
    assert.ok(first.tail && first.tail.endsWith('X'));
    assert.equal(first.memory_ops, 1);
    const p0 = run.behavior.find((c) => c.case === 'p0')!;
    assert.equal(p0.native_tool_call, 1);
    assert.equal(p0.protocol_ok, 0);
    assert.equal(run.behavior.some((c) => c.case === 'pHold'), false);
    const viewed = JSON.stringify(juniorLab.view!(run, 0, 0));
    assert.match(viewed, /tool_call/);
    assert.equal(spec.world.jobs.bags().evaluations.spent, spent + 1);

    const again = await juniorLab.act!.start(spec, { view_trial: { version: child.version, case: 'i1' } }, 'a4', {} as never);
    assert.ok(again && again.kind === 'records' && again.what === 'trial');
    assert.match(JSON.stringify(juniorLab.act!.shown(again)), /<tool_call>/);
    assert.equal(spec.world.jobs.bags().evaluations.spent, spent + 1, 'reading a trial spends no evaluation');
    const hidden = await juniorLab.act!.start(spec, { view_trial: { version: child.version, case: 'pHold' } }, 'a5', {} as never);
    assert.ok(hidden && hidden.kind === 'records' && hidden.what === 'refused' && /reserved/.test(String(hidden.summary.reason)));
    assert.ok(!JSON.stringify(hidden).includes('SECRET_HOLD_OUT'));

    const other = await juniorLab.act!.start(spec, { change: { from: child.version, files: { 'prompt.md': 'Once more.' }, why: 'another version', expect: 'the bag is spent' } }, 'a6', {} as never);
    assert.ok(other && other.kind === 'version');
    const full = await juniorLab.act!.start(spec, { run: { version: other.version } }, 'a7', {} as never);
    assert.ok(full && full.kind === 'records' && full.what === 'refused');
    assert.match(String(full.summary.reason), /evaluations needs 1, 0 free/);
    assert.match(String(full.summary.reason), /not reset between runs/);
  } finally { server.stop(); await h.close(); }
});
