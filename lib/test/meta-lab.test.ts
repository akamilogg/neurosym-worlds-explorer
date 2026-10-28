import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { indexCorpus, independent, partition } from '../src/meta/corpus.ts';
import { Trials, inProcessLauncher, manifestProblems, policyEvaluator, qualityOf, trialResult, verifyTrials, type MetaManifest, type TrialLauncher } from '../src/meta/lab.ts';
import { inspectHistory } from '../src/meta/inspect.ts';
import { deliveredGuidance, Experience } from '../src/learn/assisted/experience.ts';
import { policyHash, type ResearchPolicy } from '../src/learn/assisted/research-policy.ts';
import { runSearch } from '../src/learn/evolve/engine.ts';
import { balanced } from '../src/learn/evolve/policy.ts';
import { nodeVmRunner } from '../src/runtime/node-vm.ts';
import type { Judge } from '../src/core/types.ts';
import type { FetchLike } from '../src/core/net.ts';

/* SPEC-METAPOLITICA-INVESTIGACION, M2: the corpus and its lineages, the help delivered as experience, research trials, the
   fixed evaluator and the evolutionary engine over policies, and their verification - with trials standing in. */

const runner = nodeVmRunner({ timeoutMs: 2000 });
const code = (source: string) => ({ kind: 'code' as const, lang: 'js', source });
const policy = (word: string): ResearchPolicy => ({ format: 'research-policy@1', contract: 'research-view@1', observations: {},
  composition: code(`(p) => p.events.some((e) => e.type === 'check') && !p.state.done
    ? { guidance: { kind: 'advise', focus: 'contrast', template: 't', arguments: {}, evidence: [], judgments: [] }, state: { done: true } }
    : { guidance: { kind: 'abstain', reason: 'no' }, state: p.state }`),
  state: { done: false }, templates: { t: { text: word + ': look for an observation that tells your alternatives apart.' } } });
const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), name));
const write = (f: string, v: unknown) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)); };

test('M2: the corpus indexed as it is - lineages whole, never split between partitions, never counted as more investigations', () => {
  const runs = path.join(tmp('corpus-'), 'runs');
  const journal = (extra: Record<string, unknown> = {}) => ({ experiment: 'cells@1', researcher: 'assisted', started: '2026-10-01T10:00:00.000Z', config: { seed: 1, level: 2, llm_model: 'm' }, argv: [],
    events: [{ type: 'operator_message', question: 3, messages: [{ id: 'd1', text: 'try', by: 'agent:senior', directive: true }, { id: 'r', text: 'branch', research_result: 'delegation:r1.1' }] }, { type: 'end', stoppedBy: 'budget' }], ...extra });
  write(path.join(runs, 'a.json'), journal());
  fs.writeFileSync(path.join(runs, 'a.replay.jsonl'), '');
  write(path.join(runs, 'a.finding.json'), { outcome: { status: 'accepted' } });
  write(path.join(runs, 'a2.json'), journal({ started: '2026-10-02T10:00:00.000Z', resumed: { from: 'a.json', from_started: '2026-10-01T10:00:00.000Z' } }));
  write(path.join(runs, 'a.branches', 'delegation-r1.1.json'), journal({ started: '2026-10-01T11:00:00.000Z' }));
  write(path.join(runs, 'a.agent-senior.json'), { format: 'agent@1' });
  write(path.join(runs, 'c.json'), journal({ experiment: 'orbit@1' }));
  const index = indexCorpus(runs);
  assert.deepEqual(index.entries.map((e) => e.id).sort(), ['a', 'a.branches/delegation-r1.1', 'a2', 'c'], 'the files beside a run are not runs');
  assert.deepEqual(index.lineages.a.slice().sort(), ['a', 'a.branches/delegation-r1.1', 'a2']);
  const a = index.entries.find((e) => e.id === 'a')!;
  assert.deepEqual(a.help.delivered, { 'agent:senior': 1 }, 'a branch\'s result is not help');
  assert.equal(a.help.senior, true);
  assert.equal(a.results.model_accepted, true);
  assert.deepEqual(a.material, { read: true, rebuild: true, rerun: true });
  assert.equal(index.entries.find((e) => e.id === 'a2')!.continues, 'a');
  assert.equal(index.entries.find((e) => e.id === 'a.branches/delegation-r1.1')!.branch_of, 'a');
  assert.deepEqual(partition(index, { a: 'experience', c: 'development' }), { experience: index.lineages.a, development: ['c'], confirmation: [] });
  assert.throws(() => partition(index, { a: 'experience', a2: 'development' }), /one lineage/);
  assert.equal(independent(index, ['a', 'a2', 'a.branches/delegation-r1.1', 'c']), 2, 'continuations and branches do not inflate the sample');
});

test('M2: the help a researcher was delivered, read as experience - author, cut, words and response; only where it is given', async () => {
  const j = { events: [
    { type: 'investigation', round: 2 },
    { type: 'operator_message', question: 5, messages: [{ id: 'd1', text: 'check the edges', by: 'agent:senior', directive: true }, { id: 'rr', text: 'x', research_result: 'b' }] },
    { type: 'directive_report', id: 'd1', done: 'checked them' },
    { type: 'operator_message', question: 7, messages: [{ id: 'research-policy:rp-q7', text: 'contrast', by: 'agent:research-policy', advice: { focus: 'contrast', evidence: ['e1'] } }] },
    { type: 'proposal', round: 3, rationale: 'two mechanisms now' }] };
  const g = deliveredGuidance(j) as any;
  assert.deepEqual(g.delivered.map((x: any) => [x.author, x.kind, x.question, x.round, x.cut]), [['agent:senior', 'directive', 5, 2, 1], ['agent:research-policy', 'advice', 7, 2, 3]]);
  assert.deepEqual(g.delivered[0].response.report, { done: 'checked them' });
  assert.deepEqual(g.delivered[1].response.next, { type: 'proposal', round: 3, words: 'two mechanisms now' });
  assert.deepEqual(deliveredGuidance({ events: [] }), { delivered: [], none: 'this record holds no help delivered to its researcher' });
  const runs = [{ label: 'exp1', journal: j, sameWorld: true }];
  assert.match(String(((await new Experience(runs).run({ experience: 'guidance', run: 'exp1' })) as any).error), /not given/);
  assert.equal(((await new Experience(runs, { guidance: true }).run({ experience: 'guidance', run: 'exp1' })) as any).delivered.length, 2);
});

const manifest = (over: Partial<MetaManifest> = {}): MetaManifest => ({ format: 'meta-lab@1', id: 'm1', junior: { args: ['--attempts', '2'] },
  cases: [{ id: 'cells-a', lab: 'cells', args: ['--seed', '1'], partition: 'development', criterion: 'model_accepted' },
    { id: 'orbit-a', lab: 'orbit', args: ['--seed', '1'], partition: 'development', criterion: 'model_accepted' },
    { id: 'cells-hold', lab: 'cells', args: ['--seed', '9'], partition: 'confirmation', criterion: 'model_accepted' }], ...over });

/** Trials standing in: a child "solves" its case when its policy's words say "contrast" (read from the policy file it was
    given), writes its record and finding; `hook` sees each call. */
function fakeLauncher(dir: string, calls: any[], o: { partialOn?: (t: any) => boolean; policyError?: boolean } = {}): TrialLauncher {
  return async (t) => {
    calls.push(t);
    const ledger = fs.readFileSync(path.join(dir, 'trials.jsonl'), 'utf8');
    assert.ok(ledger.includes('"research_trial_requested"'), 'recorded before it is dispatched');
    const policyFile = t.resume ? null : t.args[t.args.indexOf('--research-policy') + 1];
    const words = policyFile ? fs.readFileSync(path.join(dir, policyFile), 'utf8') : fs.readFileSync(t.resume!, 'utf8');
    const solved = /contrast:/.test(words);
    const partial = o.partialOn?.(t) ?? false;
    const events = [{ type: 'check', round: 1, laboratories: [{ place: 'lab1', holds: solved }] },
      ...(o.policyError ? [{ type: 'research_policy_decided', failure: 'invalid_output' }] : []),
      { type: 'research_policy_delivered', message: 'm1' }, ...(partial ? [] : [{ type: 'end', stoppedBy: 'budget', console_usage: { llm_tokens_live: 100 } }])];
    write(t.out, { experiment: 'cells@1', started: 'x', config: {}, events, ...(policyFile ? { policy_words: words } : {}) });
    if (solved && !partial) write(t.out.replace(/\.json$/, '.finding.json'), { outcome: { status: 'accepted' } });
    if (t.signal?.aborted) return { journal: t.out };
    if (partial) throw new Error('the child died');
    return { journal: t.out };
  };
}

test('M2: trials recorded before dispatch, finished once, never run twice; a crash reconciled from the child\'s record; a cancellation kept', async () => {
  assert.deepEqual(manifestProblems(manifest()), []);
  assert.ok(manifestProblems(manifest({ junior: { args: ['--research-policy', 'x'] } })).length, 'its policy is the trial\'s');
  assert.ok(manifestProblems(manifest({ cases: [{ id: 'x', lab: 'nowhere', args: [], partition: 'development', criterion: 'model_accepted' }] })).length);
  const dir = tmp('trials-'), calls: any[] = [];
  const trials = new Trials(dir, manifest(), fakeLauncher(dir, calls));
  const ran = await trials.run(policy('contrast'), 'development');
  assert.deepEqual(ran.map((t) => [t.case, t.result.state, t.result.solved]), [['cells-a', 'ended', true], ['orbit-a', 'ended', true]], 'development only');
  assert.equal(calls.length, 2);
  assert.notEqual(ran[0].trial, ran[1].trial);
  await trials.run(policy('contrast'), 'development');
  assert.equal(calls.length, 2, 'a trial that ended is never run again');
  /* A crash after the child ended and before its finishing was written: read from the child, never run again. */
  const lines = fs.readFileSync(path.join(dir, 'trials.jsonl'), 'utf8').split('\n').filter(Boolean);
  fs.writeFileSync(path.join(dir, 'trials.jsonl'), lines.filter((l) => !(l.includes('finished') && l.includes(ran[1].trial))).join('\n') + '\n');
  await trials.run(policy('contrast'), 'development');
  assert.equal(calls.length, 2);
  assert.ok(trials.ledger().some((e) => e.type === 'research_trial_finished' && e.trial === ran[1].trial && e.reconciled));
  /* A child cut short: its record kept, the trial resumed from it. */
  const cut = tmp('trials-cut-'), cutCalls: any[] = [];
  let first = true;
  const t2 = new Trials(cut, manifest(), fakeLauncher(cut, cutCalls, { partialOn: () => { const p = first; first = false; return p; } }));
  const once = await t2.run(policy('plain'), 'development');
  assert.equal(once[0].result.state, 'infra', 'a child that died before its end: a failure of the infrastructure, no measure invented');
  assert.equal(once[0].result.solved, null);
  await t2.run(policy('plain'), 'development');
  assert.ok(cutCalls.some((c) => c.resume), 'resumed from its record, not started again');
  assert.equal(trialResult(path.join(cut, 'trials', once[0].trial + '.json'), 'model_accepted').state, 'ended');
  /* Cancelled: the signal reaches the child, what it did is kept. */
  const cancelled = tmp('trials-cancel-'), cc: any[] = [];
  const controller = new AbortController(); controller.abort();
  const t3 = new Trials(cancelled, manifest(), fakeLauncher(cancelled, cc, { partialOn: () => true }));
  const c3 = await t3.run(policy('plain'), 'development', controller.signal);
  assert.equal(c3.length, 1, 'no trial after a cancellation');
  assert.equal(cc[0].signal, controller.signal);
  assert.equal(c3[0].result.state, 'cancelled');
  assert.ok(fs.existsSync(path.join(cancelled, 'trials', c3[0].trial + '.json')), 'its partial record kept');
});

test('M2: the fixed evaluator - per kind of world, the share not solved; a policy\'s own error is its; infrastructure measures nothing', () => {
  const r = (kind: string, solved: boolean | null, state: 'ended' | 'infra' | 'cancelled' = 'ended', errors = 0) => ({ kind, result: { state, solved, stopped_by: null, policy_errors: errors, advice: 0, tokens: null } });
  assert.deepEqual(qualityOf([r('cells', true), r('cells', false), r('orbit', true)]), { kinds: ['cells', 'orbit'], quality: [0.5, 0], correct: true, infra: 0, trials: 3 });
  assert.deepEqual(qualityOf([r('cells', null, 'infra'), r('orbit', true)]).quality, [null, 0], 'a kind with nothing that could say has no component');
  assert.equal(qualityOf([r('cells', true, 'ended', 1)]).correct, false);
});

test('M2: the evolutionary engine develops policies with this evaluator - the only authority over population and resources', async () => {
  const dir = tmp('meta-search-'), calls: any[] = [];
  const trials = new Trials(dir, manifest(), fakeLauncher(dir, calls));
  const evaluator = policyEvaluator(trials, policy('plain'));
  assert.ok(evaluator.validate({ 'policy.json': '{}' }), 'what does not hold to the contract is refused');
  assert.ok(evaluator.validate({ 'other.txt': 'x' }));
  /* A mutator standing in: it rewrites the advice's words. */
  const better = JSON.stringify(policy('contrast'));
  const mutator = { propose: async () => ({ text: JSON.stringify({ files: { 'policy.json': better }, why: 'say contrast' }), tokens: 10 }) };
  const { manifest: sealed, events } = await runSearch({ evaluator, mutator, profile: balanced(0), question: 'q', limits: { evaluations: 2, attempts: 3, tokens: 1000 }, out: path.join(dir, 'search.jsonl') });
  const evaluated = events.filter((e) => e.type === 'evaluation');
  assert.equal(evaluated.length, 2);
  const best = evaluated.find((e) => e.hash === policyHash(policy('contrast')))!;
  assert.deepEqual(best.result.quality, [0, 0], 'the better policy measured: it solved both kinds');
  assert.deepEqual(evaluated.find((e) => e.hash === policyHash(policy('plain')))!.result.quality, [1, 1]);
  assert.ok(JSON.stringify(sealed.state).includes(policyHash(policy('contrast'))));
  assert.ok(calls.every((c) => !c.args.join(' ').includes('cells-hold') && !c.args.includes('9')), 'confirmation is never measured by the search');
  assert.equal(calls.length, 4, 'two candidates, each on its two development cases');
});

test('M2: verified from its record alone - every trial read again, every decision rebuilt, nothing run', async () => {
  const dir = tmp('meta-verify-'), calls: any[] = [];
  const trials = new Trials(dir, manifest(), fakeLauncher(dir, calls));
  await trials.run(policy('contrast'), 'development');
  const v = verifyTrials(dir, manifest(), runner);
  assert.equal(v.holds, true, v.problems.join('; '));
  assert.equal(v.trials, 2);
  const out = trials.ledger().find((e) => e.type === 'research_trial_requested')!.out;
  const f = path.join(dir, out);
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  j.events = j.events.filter((e: any) => e.type !== 'end');
  fs.writeFileSync(f, JSON.stringify(j));
  assert.equal(verifyTrials(dir, manifest(), runner).holds, false, 'a record changed after its finishing is found');
});

test('M2: a policy read against a run already made inspects its decisions - never a trial, never an improvement', async () => {
  const j = { experiment: 'cells@1', started: 'x', events: [{ type: 'exploration_episode', episode: 'ep1' }, { type: 'investigation', round: 1, requests: [{ view: 'ep1' }] },
    { type: 'check', round: 1, laboratories: [{ place: 'lab1', holds: false }] }, { type: 'proposal', round: 2, rationale: 'r' }, { type: 'reflection', round: 2, rationale: 'r' }] };
  const never: Judge = { id: 'none', judge: async () => { throw new Error('no Judge'); } };
  const r = await inspectHistory({ policy: policy('contrast') }, j, never, runner);
  assert.equal(r.counterfactual, false);
  assert.match(r.reading, /never received it/);
  assert.deepEqual(r.decisions.map((d) => [d.cut, (d.guidance as any)?.kind ?? d.failure]), [[1, 'abstain'], [3, 'advise'], [4, 'abstain']], 'before each answer, its state carried');
});

/* --- A candidate does not change the checks (with the harness's own runs) --------------------------------------------- */

type Message = { role: string; content: string };
const parts = (m: Message[]): Record<string, any>[] => m.slice(1).map((x) => { try { return JSON.parse(x.content); } catch { return {}; } });
const junior: FetchLike = async (_url, init) => {
  const messages = JSON.parse(String(init.body)).messages as Message[];
  const grading = messages[0].content.startsWith('You grade');
  const ps = parts(messages), first = ps[0] ?? {};
  const content = grading ? { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' }
    : 'task' in first ? { rationale: 'r', beliefs: [{ id: 'same', stance: 'keep', why: 'w' }], lessons: ['l'], next_experiment: 'n' }
    : !ps.some((p) => p.investigation_step) ? { investigate: [{ view: 'ep1', from: 0, to: 2 }] }
    : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]', validate: false,
      beliefs: [{ id: 'same', stance: first.round === 1 ? 'new' : 'keep', statement: 'the row repeats', evidence: [] }], lessons: ['l'], next_experiment: 'n' };
  const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
  return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
};

test('M2: with the harness\'s own runs, a candidate does not change the checks - only what the junior is advised', async () => {
  const dir = tmp('meta-real-');
  const m = manifest({ junior: { args: ['--level', '1', '--flat', '--no-grade', '--tools', 'view', '--attempts', '2'] },
    cases: [{ id: 'cells-1', lab: 'cells', args: ['--seed', '1'], partition: 'development', criterion: 'model_accepted' }] });
  const trials = new Trials(dir, m, inProcessLauncher({ root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch: junior }));
  const silent: ResearchPolicy = { ...policy('x'), composition: code(`(p) => ({ guidance: { kind: 'abstain', reason: 'never' }, state: p.state })`) };
  const [a] = await trials.run(silent, 'development');
  const [b] = await trials.run(policy('contrast'), 'development');
  assert.equal(a.result.state, 'ended'); assert.equal(b.result.state, 'ended');
  assert.equal(a.result.advice, 0); assert.ok(b.result.advice >= 1);
  const checks = (t: string) => JSON.parse(fs.readFileSync(path.join(dir, 'trials', t + '.json'), 'utf8')).events.filter((e: any) => e.type === 'check').map(({ t: _t, ...e }: any) => e);
  assert.deepEqual(checks(b.trial), checks(a.trial), 'the same checks, the same verdicts: the policy never touches the protocol');
  const v = verifyTrials(dir, m, runner);
  assert.equal(v.holds, true, v.problems.join('; '));
  assert.ok(v.decisions > 0);
});

test('M2: lab meta - the corpus indexed, a manifest refused before anything runs, a meta-laboratory verified', async () => {
  const { labCli } = await import('../src/runtime/cli.ts');
  const root = tmp('meta-cli-'), lines: string[] = [];
  write(path.join(root, 'runs', 'a.json'), { experiment: 'cells@1', started: 'x', config: { seed: 1 }, events: [{ type: 'end', stoppedBy: 'budget' }] });
  const ctx = { root, out: (l: string) => lines.push(l), env: {} } as never;
  assert.equal(await labCli(['meta', 'index'], ctx), 0);
  assert.ok(fs.existsSync(path.join(root, 'runs', 'meta', 'corpus.json')));
  assert.match(lines[0], /^1 runs in 1 lineages/);
  write(path.join(root, 'bad.json'), { format: 'meta-lab@1', id: 'x', junior: { args: [] }, cases: [] });
  assert.equal(await labCli(['meta', 'trials', 'bad.json', 'p.json'], ctx), 2);
  assert.ok(lines.some((l) => /refused, nothing was run/.test(l)));
  write(path.join(root, 'm.json'), manifest());
  assert.equal(await labCli(['meta', 'verify', 'm.json'], ctx), 0, 'a meta-laboratory with no trials yet holds');
});
