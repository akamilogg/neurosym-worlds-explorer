import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { indexCorpus, independent, partition } from '../src/meta/corpus.ts';
import { Trials, inProcessLauncher, manifestProblems, measureOf, policyEvaluator, qualityOf, trialResult, verifyTrials, type MetaManifest, type TrialLauncher } from '../src/meta/lab.ts';
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

const manifest = (over: Partial<MetaManifest> = {}): MetaManifest => ({ format: 'meta-lab@1', id: 'm1', junior: { args: ['--attempts', '2', '--max-tokens', '100', '--max-judge-calls', '50'] },
  cases: [{ id: 'cells-a', lab: 'cells', args: ['--seed', '1'], partition: 'development', criterion: 'model_accepted' },
    { id: 'orbit-a', lab: 'orbit', args: ['--seed', '1'], partition: 'development', criterion: 'model_accepted' },
    { id: 'cells-hold', lab: 'cells', args: ['--seed', '9'], partition: 'confirmation', criterion: 'model_accepted' }], ...over });

/** Trials standing in: a child "solves" its case when its policy's words say "contrast" (read from the policy file it was
    given, or from the record it resumes), writes its record and finding; `ran` - the model it really ran with. */
function fakeLauncher(dir: string, calls: any[], o: { partialOn?: (t: any) => boolean; failBeforeRecord?: (t: any) => boolean; policyError?: boolean; identity?: Record<string, unknown>; ran?: string } = {}): TrialLauncher {
  const identity = o.identity ?? { llm_model: 'stand-in' };
  return { identity, async run(t) {
    calls.push(t);
    if (o.failBeforeRecord?.(t)) throw new Error('it failed before it made its record');
    const ledger = fs.readFileSync(path.join(dir, 'trials.jsonl'), 'utf8');
    assert.ok(ledger.includes('"research_trial_requested"') && ledger.includes('"research_trial_reserved"'), 'recorded and reserved before it is dispatched');
    const policyFile = t.resume ? null : t.args[t.args.indexOf('--research-policy') + 1];
    const words = policyFile ? fs.readFileSync(path.join(dir, policyFile), 'utf8') : fs.readFileSync(t.resume!, 'utf8');
    const solved = /contrast:/.test(words);
    const partial = o.partialOn?.(t) ?? false;
    const events = [{ type: 'check', round: 1, laboratories: [{ place: 'lab1', holds: solved }] },
      ...(o.policyError ? [{ type: 'research_policy_decided', failure: 'invalid_output' }] : []),
      { type: 'research_policy_delivered', message: 'm1' }, ...(partial ? [] : [{ type: 'end', stoppedBy: 'budget', replay: { live: { jev: 7 } }, console_usage: { llm_tokens_live: 100 } }])];
    write(t.out, { experiment: 'cells@1', started: 'x', config: { llm_model: o.ran ?? identity.llm_model }, events, policy_words: words });
    if (solved && !partial) write(t.out.replace(/\.json$/, '.finding.json'), { outcome: { status: 'accepted' } });
    if (t.signal?.aborted) return { journal: t.out };
    if (partial) throw new Error('the child died');
    return { journal: t.out };
  } };
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
  const once = await t2.run(policy('contrast'), 'development');
  assert.equal(once[0].result.state, 'infra', 'a child that died before its end: a failure of the infrastructure, no measure invented');
  assert.equal(once[0].result.solved, null);
  const again = await t2.run(policy('contrast'), 'development');
  assert.ok(cutCalls.some((c) => c.resume), 'resumed from its record, not started again');
  /* Its record is its continuation's, whole - its finding beside it: a success stays a success (an external review). */
  assert.deepEqual([again[0].result.state, again[0].result.solved], ['ended', true]);
  const record = t2.ledger().filter((e) => e.type === 'research_trial_finished' && e.trial === once[0].trial).at(-1)!.record;
  assert.match(record, /\.r1\.json$/);
  assert.equal(trialResult(path.join(cut, record), 'model_accepted').solved, true);
  assert.equal((await verifyTrials(cut, manifest(), runner)).holds, true);
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
  const v = await verifyTrials(dir, manifest(), runner);
  assert.equal(v.holds, true, v.problems.join('; '));
  assert.equal(v.trials, 2);
  /* Against another manifest - a case's seed changed - it does not hold (an external review). */
  const other = manifest({ cases: manifest().cases.map((c) => (c.id === 'cells-a' ? { ...c, args: ['--seed', '999'] } : c)) });
  const w = await verifyTrials(dir, other, runner);
  assert.equal(w.holds, false);
  assert.ok(w.problems.some((p) => /another manifest/.test(p)));
  const out = trials.ledger().find((e) => e.type === 'research_trial_requested')!.out;
  const f = path.join(dir, out);
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  j.events = j.events.filter((e: any) => e.type !== 'end');
  fs.writeFileSync(f, JSON.stringify(j));
  assert.equal((await verifyTrials(dir, manifest(), runner)).holds, false, 'a record changed after its finishing is found');
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
  const m = manifest({ junior: { args: ['--level', '1', '--flat', '--no-grade', '--tools', 'view', '--attempts', '2', '--max-tokens', '100000', '--max-judge-calls', '100000'] },
    cases: [{ id: 'cells-1', lab: 'cells', args: ['--seed', '1'], partition: 'development', criterion: 'model_accepted' }] });
  const trials = new Trials(dir, m, inProcessLauncher({ root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch: junior }));
  const silent: ResearchPolicy = { ...policy('x'), composition: code(`(p) => ({ guidance: { kind: 'abstain', reason: 'never' }, state: p.state })`) };
  const [a] = await trials.run(silent, 'development');
  const [b] = await trials.run(policy('contrast'), 'development');
  assert.equal(a.result.state, 'ended'); assert.equal(b.result.state, 'ended');
  assert.equal(a.result.advice, 0); assert.ok(b.result.advice >= 1);
  const checks = (t: string) => JSON.parse(fs.readFileSync(path.join(dir, 'trials', t + '.json'), 'utf8')).events.filter((e: any) => e.type === 'check').map(({ t: _t, ...e }: any) => e);
  assert.deepEqual(checks(b.trial), checks(a.trial), 'the same checks, the same verdicts: the policy never touches the protocol');
  const v = await verifyTrials(dir, m, runner);
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

/* --- An external review of M2 (28/10/2026), reconciled ------------------------------------------------------------------ */

test('M2 review: a trial is its effective configuration - another model is another trial; a child that ran with another is no result', async () => {
  const dir = tmp('meta-identity-'), calls: any[] = [];
  const a = await new Trials(dir, manifest(), fakeLauncher(dir, calls, { identity: { llm_model: 'small' } })).run(policy('contrast'), 'development');
  const b = await new Trials(dir, manifest(), fakeLauncher(dir, calls, { identity: { llm_model: 'large' } })).run(policy('contrast'), 'development');
  assert.equal(calls.length, 4, 'under another model, nothing of the first is taken: run again');
  assert.notEqual(a[0].trial, b[0].trial);
  const lying = tmp('meta-mismatch-'), lc: any[] = [];
  const [r] = await new Trials(lying, manifest(), fakeLauncher(lying, lc, { identity: { llm_model: 'small' }, ran: 'other' })).run(policy('contrast'), 'development');
  assert.equal(r.result.state, 'infra');
  assert.match(String(r.result.why), /ran with llm_model other/);
});

test('M2 review: a policy is named by its whole configuration - other limits, another file and another trial', async () => {
  const dir = tmp('meta-config-'), calls: any[] = [];
  await new Trials(dir, manifest({ policy: { limits: { advice: 1 } } }), fakeLauncher(dir, calls)).run(policy('contrast'), 'development');
  await new Trials(dir, manifest({ policy: { limits: { advice: 8 } } }), fakeLauncher(dir, calls)).run(policy('contrast'), 'development');
  const files = calls.map((c) => c.args[c.args.indexOf('--research-policy') + 1]);
  assert.equal(new Set(files).size, 2);
  const limits = [...new Set(files)].map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).limits.advice).sort((x, y) => x - y);
  assert.deepEqual(limits, [1, 8], 'each ran with its own limits');
});

test('M2 review: the fund for trials - reserved before each launch, settled after; a launch it cannot hold is never made', async () => {
  const dir = tmp('meta-fund-'), calls: any[] = [];
  const trials = new Trials(dir, manifest(), fakeLauncher(dir, calls), { fund: 150 });
  const ran = await trials.run(policy('contrast'), 'development');
  assert.deepEqual(ran.map((t) => t.result.state), ['ended', 'unfunded'], 'the second would not fit: never launched, and it stops there');
  assert.equal(calls.length, 1);
  assert.equal(trials.spent(), 100, 'what the first spent, settled');
  assert.ok(manifestProblems(manifest({ junior: { args: ['--attempts', '2'] } })).some((p) => /max-tokens/.test(p)), 'a trial\'s limit is what is reserved: the manifest fixes it');
  let told = false;
  const ev = policyEvaluator(new Trials(tmp('meta-fund2-'), manifest(), fakeLauncher(dir, []), { fund: 50 }), policy('plain'), { onUnfunded: () => { told = true; } });
  const e = await ev.evaluate(policyHash(policy('plain')));
  assert.ok(told, 'the search is told to stop');
  assert.ok(e.diagnostics.some((d) => /not a measure/.test(d)));
});

test('M2 review: a trial resumed runs under its controls again - its limits of tokens and time are not lost', async () => {
  const { controlArgs, runLaboratory } = await import('../src/runtime/lab-runner.ts');
  const { cellsLab } = await import('../src/worlds/cells/lab.ts');
  assert.deepEqual(controlArgs(['--seed', '1', '--max-tokens', '100', '--max-minutes', '1', '--out', 'x', '--resume', 'y', '--level', '2']), ['--max-tokens', '100', '--max-minutes', '1']);
  const dir = tmp('meta-controls-');
  const args = ['--seed', '1', '--level', '1', '--flat', '--no-grade', '--tools', 'view', '--attempts', '3', '--researcher', 'assisted', '--max-tokens', '100', '--max-minutes', '1'];
  const first = await runLaboratory(cellsLab, { args: [...args, '--out', path.join(dir, 'a.json')], root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch: junior, print: () => {} });
  const launcher = inProcessLauncher({ root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch: junior });
  const { journal } = await launcher.run({ lab: 'cells', args, out: path.join(dir, 'b.json'), resume: first.journal });
  assert.deepEqual(JSON.parse(fs.readFileSync(journal, 'utf8')).limits, { max_tokens: 100, max_minutes: 1 });
});

test('M2 review: a search is never overwritten, needs a fund for its trials, and is rebuilt by verify', async () => {
  const { labCli } = await import('../src/runtime/cli.ts');
  const root = tmp('meta-search-cli-'), lines: string[] = [];
  write(path.join(root, 'm.json'), manifest());
  write(path.join(root, 'p.json'), policy('plain'));
  assert.equal(await labCli(['meta', 'search', 'm.json', 'p.json'], { root, out: (l: string) => lines.push(l), env: {} } as never), 2);
  assert.ok(lines.some((l) => /needs --trial-tokens/.test(l)));
  /* A search sealed in the meta-laboratory's searches: rebuilt with no model nor measure, its evaluations from its trials. */
  const dir = tmp('meta-search-verify-'), calls: any[] = [];
  const trials = new Trials(dir, manifest(), fakeLauncher(dir, calls));
  const mutator = { propose: async () => ({ text: JSON.stringify({ files: { 'policy.json': JSON.stringify(policy('contrast')) }, why: 'w' }), tokens: 10 }) };
  fs.mkdirSync(path.join(dir, 'searches'));
  const out = path.join(dir, 'searches', 's1.jsonl');
  const { manifest: sealed } = await runSearch({ evaluator: policyEvaluator(trials, policy('plain')), mutator, profile: balanced(0), question: 'q', limits: { evaluations: 2, attempts: 3, tokens: 1000 }, out });
  fs.writeFileSync(out.replace(/\.jsonl$/, '.manifest.json'), JSON.stringify(sealed));
  const v = await verifyTrials(dir, manifest(), runner);
  assert.equal(v.searches, 1);
  assert.equal(v.holds, true, v.problems.join('; '));
  const tampered = fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((e) => (e.type === 'evaluation' ? { ...e, result: { ...e.result, quality: [0, 0] } } : e));
  fs.writeFileSync(out, tampered.map((e) => JSON.stringify(e)).join('\n') + '\n');
  assert.equal((await verifyTrials(dir, manifest(), runner)).holds, false);
});

/* --- A second external review of M2 (28/10/2026), reconciled ------------------------------------------------------------ */

test('M2 review 2: an incomplete evaluation is kept as it is - unchecked, no quality, never an elite', async () => {
  const r = (state: 'ended' | 'unfunded', solved: boolean | null) => ({ kind: 'cells', result: { state, solved, stopped_by: null, policy_errors: 0, advice: 0, tokens: null } });
  assert.deepEqual([measureOf([r('ended', true), r('unfunded', null)], 2).correct, measureOf([r('ended', true), r('unfunded', null)], 2).quality], ['unchecked', null]);
  assert.equal(measureOf([r('ended', true)], 2).complete, false, 'trials never reached: incomplete too');
  assert.deepEqual(measureOf([r('ended', true), r('ended', false)], 2).quality, [0.5]);
  /* A search whose first evaluation the fund cuts short: kept, and no elite. */
  const dir = tmp('meta-incomplete-'), calls: any[] = [];
  const controller = new AbortController();
  const trials = new Trials(dir, manifest(), fakeLauncher(dir, calls), { fund: 150 });
  const mutator = { propose: async () => ({ text: JSON.stringify({ files: { 'policy.json': JSON.stringify(policy('contrast')) }, why: 'w' }), tokens: 10 }) };
  const { manifest: sealed, events } = await runSearch({ evaluator: policyEvaluator(trials, policy('contrast'), { signal: controller.signal, onUnfunded: () => controller.abort() }), mutator,
    profile: balanced(0), signal: controller.signal, question: 'q', limits: { evaluations: 3, attempts: 3, tokens: 1000 }, out: path.join(dir, 's.jsonl') });
  const ev = events.filter((e) => e.type === 'evaluation');
  assert.equal(ev.length, 1);
  assert.deepEqual([ev[0].result.correct, ev[0].result.quality], ['unchecked', null]);
  assert.deepEqual(sealed.state.elites, [], 'an incomplete evaluation never competes');
  assert.equal(sealed.stoppedBy, 'cancelled');
});

test('M2 review 2: a search is never resumed under another configuration - its measures are not this one\'s', async () => {
  const dir = tmp('meta-resume-identity-');
  const small = new Trials(dir, manifest(), fakeLauncher(dir, [], { identity: { llm_model: 'small' } }));
  const large = new Trials(dir, manifest(), fakeLauncher(dir, [], { identity: { llm_model: 'large' } }));
  assert.notEqual(small.identity(), large.identity(), 'the evaluator\'s identity is the trials\' configuration');
  const mutator = { propose: async () => ({ text: JSON.stringify({ files: { 'policy.json': JSON.stringify(policy('contrast')) }, why: 'w' }), tokens: 10 }) };
  const out = path.join(dir, 's.jsonl');
  await runSearch({ evaluator: policyEvaluator(small, policy('plain')), mutator, profile: balanced(0), question: 'q', limits: { evaluations: 1, attempts: 1, tokens: 1000 }, out });
  const recorded = fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  await assert.rejects(runSearch({ evaluator: policyEvaluator(large, policy('plain')), mutator, profile: balanced(0), question: 'q', limits: { evaluations: 3, attempts: 3, tokens: 1000 },
    out: path.join(dir, 's2.jsonl'), recorded, live: true }), /measured by evaluator/);
});

test('M2 review 2: a continuation that never made its record - the last record that exists resumed, never written over', async () => {
  const dir = tmp('meta-failed-continuation-'), calls: any[] = [];
  let n = 0;
  const trials = new Trials(dir, manifest({ cases: [manifest().cases[0]] }), fakeLauncher(dir, calls, { partialOn: () => n++ === 0, failBeforeRecord: (t) => t.out.endsWith('.r1.json') }));
  const [first] = await trials.run(policy('contrast'), 'development');
  assert.equal(first.result.state, 'infra', 'cut short');
  const original = fs.readFileSync(path.join(dir, 'trials', first.trial + '.json'), 'utf8');
  const [second] = await trials.run(policy('contrast'), 'development');
  assert.equal(second.result.state, 'infra', 'its continuation failed before it made its record');
  assert.ok(!fs.existsSync(path.join(dir, 'trials', first.trial + '.r1.json')));
  const [third] = await trials.run(policy('contrast'), 'development');
  assert.equal(fs.readFileSync(path.join(dir, 'trials', first.trial + '.json'), 'utf8'), original, 'the first record never written over');
  assert.match(calls[2].resume, new RegExp(first.trial + '\\.json$'), 'resumed from the last record that exists');
  assert.match(calls[2].out, /\.r2\.json$/, 'into a name of its own');
  assert.deepEqual([third.result.state, third.result.solved], ['ended', true]);
  assert.ok(trials.ledger().some((e) => e.type === 'research_trial_resumed' && /\.r1\.json$/.test(e.out)), 'the failed intention kept in the ledger');
});

test('M2 review 2: the fund reserves every work of a trial - the Judge\'s calls too; work it cannot bound is never launched', async () => {
  for (const k of ['--delegation-fund', '--agents', '--opening'])
    assert.ok(manifestProblems(manifest({ junior: { args: ['--max-tokens', '100', '--max-judge-calls', '50', k, '900'] } })).some((p) => p.includes(k)), k + ' refused');
  assert.ok(manifestProblems(manifest({ junior: { args: ['--max-tokens', '100'] } })).some((p) => /max-judge-calls/.test(p)));
  const dir = tmp('meta-judge-fund-'), calls: any[] = [];
  const trials = new Trials(dir, manifest(), fakeLauncher(dir, calls), { fund: 1000, judgeFund: 55 });
  const ran = await trials.run(policy('contrast'), 'development');
  assert.deepEqual(ran.map((t) => t.result.state), ['ended', 'unfunded'], 'the second\'s calls of the Judge would not fit');
  assert.match(String(ran[1].result.why), /calls of the Judge/);
  assert.equal(trials.spent(undefined, 'judge_calls'), 7, 'settled at what its Judge was called live');
  assert.equal(trials.spent(), 100);
});

test('M2 review 2: a record under another model is never taken on a retry - it stays a failure of the infrastructure', async () => {
  const dir = tmp('meta-mismatch-retry-'), calls: any[] = [];
  const trials = new Trials(dir, manifest(), fakeLauncher(dir, calls, { identity: { llm_model: 'small' }, ran: 'other' }));
  const [a] = await trials.run(policy('contrast'), 'development');
  assert.equal(a.result.state, 'infra');
  const [b] = await trials.run(policy('contrast'), 'development');
  assert.deepEqual([b.result.state, b.result.solved], ['infra', null], 'not read as ended and solved');
  assert.equal(calls.filter((c) => c.out.includes(a.trial)).length, 1, 'nor resumed into this trial');
});

test('M2 review 2: verify refuses a search whose trials are not in the ledger', async () => {
  const dir = tmp('meta-verify-ledger-'), calls: any[] = [];
  const trials = new Trials(dir, manifest(), fakeLauncher(dir, calls));
  fs.mkdirSync(path.join(dir, 'searches'));
  const out = path.join(dir, 'searches', 's1.jsonl');
  const mutator = { propose: async () => ({ text: JSON.stringify({ files: { 'policy.json': JSON.stringify(policy('contrast')) }, why: 'w' }), tokens: 10 }) };
  const { manifest: sealed } = await runSearch({ evaluator: policyEvaluator(trials, policy('plain')), mutator, profile: balanced(0), question: 'q', limits: { evaluations: 1, attempts: 1, tokens: 1000 }, out });
  fs.writeFileSync(out.replace(/\.jsonl$/, '.manifest.json'), JSON.stringify(sealed));
  assert.equal((await verifyTrials(dir, manifest(), runner)).holds, true);
  fs.writeFileSync(path.join(dir, 'trials.jsonl'), '');
  const v = await verifyTrials(dir, manifest(), runner);
  assert.equal(v.holds, false);
  assert.ok(v.problems.some((p) => /not in the ledger of trials/.test(p)));
});

/* The stand-in junior, its models asking the Judge a rule. */
const judged: FetchLike = async (url, init) => {
  const r = await junior(url, init);
  const body = JSON.parse(await r.text());
  const content = JSON.parse(body.choices[0].message.content);
  if ('output' in content) { content.observations = { n: { definition: 'the rows', source: '(p) => p.rows.length', range: [0, 100] } }; content.rules = { alive: { type: 'noul', used_as: 'value', instructions: 'Are {{n}} rows many?', criteria: { yes: 'y', no: 'n' } } }; content.weights = { alive: 1 }; }
  const text = JSON.stringify({ ...body, choices: [{ message: { content: JSON.stringify(content) } }] });
  return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
};

test('M2 review 2: --max-judge-calls bounds a run - it stops before asking System 2 again once its Judge was called that often', async () => {
  const { runLaboratory } = await import('../src/runtime/lab-runner.ts');
  const { cellsLab } = await import('../src/worlds/cells/lab.ts');
  const dir = tmp('meta-judge-limit-');
  const r = await runLaboratory(cellsLab, { args: ['--seed', '1', '--level', '1', '--flat', '--no-grade', '--tools', 'view', '--attempts', '3', '--researcher', 'assisted', '--max-judge-calls', '1', '--out', path.join(dir, 'a.json')],
    root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch: judged, print: () => {} });
  const j = JSON.parse(fs.readFileSync(r.journal, 'utf8'));
  assert.equal(j.limits.max_judge_calls, 1);
  const end = j.events.filter((e: any) => e.type === 'end').at(-1);
  assert.equal(end.stoppedBy, 'judge_budget');
});

test('M2 pilot: a trial its providers failed measures nothing - the Judge unanswered, System 2 unanswered, or its run stopped by them', () => {
  const dir = tmp('meta-providers-');
  const at = (name: string, events: unknown[]) => { const f = path.join(dir, name + '.json'); write(f, { experiment: 'cells@1', config: {}, events }); return f; };
  const check = { type: 'check', round: 1, laboratories: [{ place: 'lab1', holds: false }] };
  assert.equal(trialResult(at('fine', [check, { type: 'end', stoppedBy: 'budget', jev: { calls: 9, errors: 0 } }]), 'model_accepted').state, 'ended');
  const judge = trialResult(at('judge', [check, { type: 'end', stoppedBy: 'budget', jev: { calls: 9, errors: 3 } }]), 'model_accepted');
  assert.deepEqual([judge.state, judge.solved], ['infra', null], 'a check without the Judge\'s answers is no verdict');
  assert.match(String(judge.why), /3 call\(s\) of the Judge failed/);
  const llm = trialResult(at('llm', [{ type: 'proposal_failed', round: 1, error: 'HTTP 429 Too Many Requests' }, check, { type: 'end', stoppedBy: 'budget', jev: { calls: 9, errors: 0 } }]), 'model_accepted');
  assert.match(String(llm.why), /1 proposal\(s\) System 2 never answered/);
  assert.equal(trialResult(at('fatal', [{ type: 'end', stoppedBy: 'llm_error' }]), 'model_accepted').state, 'infra');
});

test('M2 pilot: the situated policy does not take its first question for one in a round it advised', async () => {
  const p = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'examples', 'research-policies', 'situated.json'), 'utf8'));
  const never: Judge = { id: 'none', judge: async () => { throw new Error('no Judge'); } };
  const r = await inspectHistory({ policy: p }, { experiment: 'cells@1', started: 'x', events: [{ type: 'exploration_episode', episode: 'ep1' }, { type: 'investigation', round: 0, requests: [{ view: 'ep1' }] }] }, never, runner);
  assert.ok(r.decisions.length > 0);
  assert.ok(r.decisions.every((d) => !/advised already/.test(JSON.stringify(d.guidance ?? ''))), JSON.stringify(r.decisions.map((d) => d.guidance)));
});
