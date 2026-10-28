import fs from 'node:fs';
import path from 'node:path';
import { hashString, stableStringify } from '../core/hash.ts';
import { LABS } from '../worlds/labs.ts';
import { runResults } from '../orchestra/results.ts';
import { checkPolicy, policyHash, verifyPolicyDecisions, type PolicyConfig, type ResearchPolicy } from '../learn/assisted/research-policy.ts';
import type { Evaluator } from '../learn/evolve/engine.ts';
import type { Evaluation } from '../learn/evolve/policy.ts';
import type { CodeRunner } from '../core/types.ts';

/* ============================================================================
 * The META-LABORATORY (SPEC-METAPOLITICA-INVESTIGACION §8-§9, M2): research policies investigated with the harness's own
 * means. Its primitive is a RESEARCH TRIAL - a whole run of a junior with a frozen policy, in a world and realization fixed
 * beforehand - never a timing of a function nor a grade of the policy's prose.
 *
 * Its MANIFEST, the operator's alone, fixes the cases, their partitions (development, confirmation), the outcome each
 * counts (the world's own acceptance) and the junior's configuration; a candidate never edits it. Each trial is recorded
 * with an id before it is dispatched and its finishing once; a crash is reconciled with the child's own record (a trial
 * that ended is never run again, one cut short is resumed from its record), a cancellation reaches the child and keeps
 * what it did. Trials read no sibling.
 *
 * The EVALUATOR turns trials into the evolutionary engine's contract: a candidate is a policy (one file, policy.json), its
 * quality per kind of world q = 1 - the share of its trials that solved their task - lower better, compared worst kind
 * first by the engine as it is, each kind weighed by its trials, never by the points or windows they produce. A policy's
 * own failure (an output that breaks its contract) makes it incorrect; a failure of the infrastructure is kept apart and
 * measures nothing. Only development cases are measured; confirmation is the operator's, for a frozen candidate.
 * ========================================================================== */

type J = Record<string, any>;

export type Criterion = 'model_accepted' | 'artifact_accepted';
export interface MetaCase {
  readonly id: string;
  readonly lab: string;
  /** The world and its realization: what this case is (seed, level, task...). */
  readonly args: readonly string[];
  /** The kind of world it stands for: one component of the quality. Default: its laboratory. */
  readonly kind?: string;
  readonly partition: 'development' | 'confirmation';
  readonly criterion: Criterion;
}
export interface MetaManifest {
  readonly format: 'meta-lab@1';
  readonly id: string;
  /** The junior every trial runs: its researcher's arguments (attempts, budget, tools...), the same for every case. */
  readonly junior: { readonly args: readonly string[] };
  readonly cases: readonly MetaCase[];
  /** Trials of each case for a candidate (repetitions are not independent of their case). */
  readonly repetitions?: number;
  /** How a candidate's capture is made and its limits, the same for every candidate. */
  readonly policy?: Omit<PolicyConfig, 'policy'>;
}

export function manifestProblems(m: unknown): string[] {
  const o = m && typeof m === 'object' ? m as J : null;
  if (!o || o.format !== 'meta-lab@1') return ['"format": "meta-lab@1"'];
  const errors: string[] = [];
  if (typeof o.id !== 'string' || !/^[\w.-]+$/.test(o.id)) errors.push('"id": letters, digits, dots and dashes');
  if (!Array.isArray(o.junior?.args)) errors.push('"junior": {"args": [...]}');
  else if (o.junior.args.some((a: unknown) => typeof a === 'string' && /^--(research-policy|out|resume)$/.test(a))) errors.push('"junior.args": its policy, output and resumption are the trial\'s, not the manifest\'s');
  if (!Array.isArray(o.cases) || !o.cases.length) errors.push('"cases": at least one');
  const ids = new Set<string>();
  for (const [i, c] of (Array.isArray(o.cases) ? o.cases : []).entries()) {
    const at = 'case #' + i;
    if (typeof c?.id !== 'string' || !/^[\w.-]+$/.test(c.id) || ids.has(c.id)) errors.push(at + ': a unique "id"');
    ids.add(c?.id);
    if (!LABS[c?.lab]) errors.push(at + ': no laboratory "' + c?.lab + '" (' + Object.keys(LABS).join(', ') + ')');
    if (!Array.isArray(c?.args)) errors.push(at + ': "args" of its world');
    if (!['development', 'confirmation'].includes(c?.partition)) errors.push(at + ': "partition" is "development" or "confirmation"');
    if (!['model_accepted', 'artifact_accepted'].includes(c?.criterion)) errors.push(at + ': "criterion" is "model_accepted" or "artifact_accepted"');
  }
  if (o.repetitions !== undefined && !(Number.isInteger(o.repetitions) && o.repetitions > 0)) errors.push('"repetitions": a whole number above 0');
  return errors;
}

export const manifestHash = (m: MetaManifest): string => hashString(stableStringify(m));

/* --- Trials -------------------------------------------------------------------------------------------------------------- */

export interface TrialResult {
  /** ended: it ran to its end; cancelled: stopped by the operator, partial; infra: the harness or a provider failed. */
  readonly state: 'ended' | 'cancelled' | 'infra';
  /** Whether it solved its task by its case's criterion; null where it cannot say (cancelled, infra). */
  readonly solved: boolean | null;
  readonly stopped_by: string | null;
  /** The policy's own failures in it: decisions whose output broke the contract. */
  readonly policy_errors: number;
  readonly advice: number;
  readonly tokens: number | null;
  readonly why?: string;
}

/** Runs one child: its journal at `out` (resuming `resume` when given). The default runs it in this process. */
export type TrialLauncher = (t: { readonly lab: string; readonly args: readonly string[]; readonly out: string; readonly resume?: string; readonly signal?: AbortSignal }) => Promise<{ readonly journal: string }>;

/** A child's result, read from its record only: the world's own acceptance, by its case's criterion. */
export function trialResult(journalFile: string, criterion: Criterion): TrialResult {
  let j: J;
  try { j = JSON.parse(fs.readFileSync(journalFile, 'utf8')); } catch { return { state: 'infra', solved: null, stopped_by: null, policy_errors: 0, advice: 0, tokens: null, why: 'no record' }; }
  const events = (j.events ?? []) as J[];
  const end = [...events].reverse().find((e) => e.type === 'end');
  const policyErrors = events.filter((e) => e.type === 'research_policy_decided' && e.failure === 'invalid_output').length;
  const advice = events.filter((e) => e.type === 'research_policy_delivered' && e.message).length;
  const tokens = typeof end?.console_usage?.llm_tokens_live === 'number' ? end.console_usage.llm_tokens_live : null;
  if (!end) return { state: 'cancelled', solved: null, stopped_by: null, policy_errors: policyErrors, advice, tokens, why: 'it did not end' };
  const stoppedBy = String(end.stoppedBy ?? '');
  if (stoppedBy === 'cancelled') return { state: 'cancelled', solved: null, stopped_by: stoppedBy, policy_errors: policyErrors, advice, tokens };
  if (stoppedBy === 'diverged' || stoppedBy.startsWith('error')) return { state: 'infra', solved: null, stopped_by: stoppedBy, policy_errors: policyErrors, advice, tokens };
  const o1 = runResults(journalFile).o1_predictive_acceptance;
  const solved = criterion === 'model_accepted' ? o1.model : o1.artifact ?? false;
  return { state: 'ended', solved, stopped_by: stoppedBy, policy_errors: policyErrors, advice, tokens };
}

/** The trials of a meta-laboratory: their ledger (requested before dispatch, finished once) and their children. */
export class Trials {
  readonly dir: string;
  readonly manifest: MetaManifest;
  private readonly launch: TrialLauncher;
  private readonly ledgerFile: string;

  constructor(dir: string, manifest: MetaManifest, launch: TrialLauncher) {
    const problems = manifestProblems(manifest);
    if (problems.length) throw new Error('the manifest: ' + problems.join('; '));
    this.dir = dir; this.manifest = manifest; this.launch = launch;
    this.ledgerFile = path.join(dir, 'trials.jsonl');
    fs.mkdirSync(path.join(dir, 'trials'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'policies'), { recursive: true });
  }

  ledger(): J[] { return fs.existsSync(this.ledgerFile) ? fs.readFileSync(this.ledgerFile, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : []; }
  private write(e: J): void { fs.appendFileSync(this.ledgerFile, JSON.stringify({ at: new Date().toISOString(), ...e }) + '\n'); }

  /** A trial's identity: the manifest, the case, the repetition, the policy - the same trial is never run twice. */
  trialId(policy: string, c: MetaCase, rep: number): string { return 't-' + hashString(stableStringify([manifestHash(this.manifest), c.id, rep, policy])); }

  /** Runs (or reconciles) every trial of a policy on the cases of a partition, in order; answers each result. */
  async run(policy: ResearchPolicy, partition: 'development' | 'confirmation', signal?: AbortSignal): Promise<{ trial: string; case: string; rep: number; kind: string; result: TrialResult }[]> {
    const errors = checkPolicy(policy);
    if (errors.length) throw new Error('the policy: ' + errors.join('; '));
    const hash = policyHash(policy);
    const policyFile = path.join(this.dir, 'policies', hash + '.json');
    if (!fs.existsSync(policyFile)) fs.writeFileSync(policyFile, JSON.stringify({ policy, ...(this.manifest.policy ?? {}) }, null, 2));
    const out: { trial: string; case: string; rep: number; kind: string; result: TrialResult }[] = [];
    for (const c of this.manifest.cases.filter((x) => x.partition === partition)) {
      for (let rep = 0; rep < (this.manifest.repetitions ?? 1); rep++) {
        const id = this.trialId(hash, c, rep);
        out.push({ trial: id, case: c.id, rep, kind: c.kind ?? c.lab, result: await this.one(id, hash, policyFile, c, rep, signal) });
        if (signal?.aborted) return out;
      }
    }
    return out;
  }

  private async one(id: string, hash: string, policyFile: string, c: MetaCase, rep: number, signal?: AbortSignal): Promise<TrialResult> {
    const ledger = this.ledger();
    const finished = ledger.find((e) => e.type === 'research_trial_finished' && e.trial === id && e.result.state === 'ended');
    if (finished) return finished.result;
    const out = path.join(this.dir, 'trials', id + '.json');
    const args = [...c.args, ...this.manifest.junior.args, '--researcher', 'assisted', '--research-policy', path.relative(this.dir, policyFile).split(path.sep).join('/')];
    /* A child with a record: its end read as it is (never run again), or resumed from it where it was cut. */
    let resume: string | undefined;
    if (fs.existsSync(out)) {
      const r = trialResult(out, c.criterion);
      if (r.state === 'ended') { this.write({ type: 'research_trial_finished', trial: id, result: r, reconciled: true }); return r; }
      resume = out;
    }
    if (!ledger.some((e) => e.type === 'research_trial_requested' && e.trial === id))
      this.write({ type: 'research_trial_requested', trial: id, case: c.id, rep, policy: hash, manifest: manifestHash(this.manifest), lab: c.lab, args, out: path.relative(this.dir, out).split(path.sep).join('/') });
    let result: TrialResult;
    try {
      const target = resume ? path.join(this.dir, 'trials', id + '.r' + ledger.filter((e) => e.type === 'research_trial_resumed' && e.trial === id).length + '.json') : out;
      if (resume) this.write({ type: 'research_trial_resumed', trial: id, from: path.basename(resume), out: path.basename(target) });
      const { journal } = await this.launch({ lab: c.lab, args: resume ? [] : args, out: target, ...(resume ? { resume } : {}), ...(signal ? { signal } : {}) });
      /* A continuation becomes the trial's record: one trial, never two. */
      if (resume && journal !== out) fs.copyFileSync(journal, out);
      result = trialResult(out, c.criterion);
    } catch (e) { result = { state: 'infra', solved: null, stopped_by: null, policy_errors: 0, advice: 0, tokens: null, why: String((e as Error).message ?? e).slice(0, 300) }; }
    if (signal?.aborted && result.state !== 'ended') result = { ...result, state: 'cancelled' };
    this.write({ type: 'research_trial_finished', trial: id, result });
    return result;
  }
}

/** A default launcher: the child in this process, through the harness's own runner, in the meta-laboratory's folder. */
export function inProcessLauncher(o: { root: string; llm: import('../runtime/lab-runner.ts').LabConnection; judge?: import('../runtime/lab-runner.ts').LabConnection; fetch?: import('../core/net.ts').FetchLike }): TrialLauncher {
  return async (t) => {
    const { runLaboratory } = await import('../runtime/lab-runner.ts');
    const r = await runLaboratory(LABS[t.lab], { args: t.resume ? ['--resume', t.resume, '--out', t.out] : [...t.args, '--out', t.out], root: o.root, llm: o.llm,
      ...(o.judge ? { judge: o.judge } : {}), ...(o.fetch ? { fetch: o.fetch } : {}), ...(t.signal ? { signal: t.signal } : {}), print: () => {} });
    return { journal: r.journal };
  };
}

/* --- Quality ------------------------------------------------------------------------------------------------------------- */

/** The quality of a candidate from its trials (§9): per kind of world, 1 - the share solved among its trials that could
    say (ended); a kind with none that could say has no component (null: the engine reads it as the worst). Its vector keeps
    the kinds' names. Correct: no output of its own broke the contract. */
export function qualityOf(trials: readonly { kind: string; result: TrialResult }[]): { kinds: string[]; quality: (number | null)[]; correct: boolean; infra: number; trials: number } {
  const kinds = [...new Set(trials.map((t) => t.kind))].sort();
  const quality = kinds.map((k) => {
    const said = trials.filter((t) => t.kind === k && t.result.state === 'ended');
    return said.length ? Math.round((1 - said.filter((t) => t.result.solved).length / said.length) * 1e6) / 1e6 : null;
  });
  return { kinds, quality, correct: trials.every((t) => t.result.policy_errors === 0), infra: trials.filter((t) => t.result.state === 'infra').length, trials: trials.length };
}

/** The evaluator of an evolutionary search over policies: a candidate is one file, policy.json; it is measured by its
    trials on the development cases, and the evidence is the trials themselves. The engine stays the only authority over the
    population and its resources. */
export function policyEvaluator(trials: Trials, start: ResearchPolicy, signal?: AbortSignal): Evaluator {
  const known = new Map<string, ResearchPolicy>();
  const parse = (files: Readonly<Record<string, string>>): ResearchPolicy | string => {
    const keys = Object.keys(files);
    if (keys.length !== 1 || keys[0] !== 'policy.json') return 'a policy is one file, policy.json';
    let p: unknown;
    try { p = JSON.parse(files['policy.json']); } catch { return 'policy.json is not JSON'; }
    const errors = checkPolicy(p);
    return errors.length ? errors.join('; ') : p as ResearchPolicy;
  };
  const register = (p: ResearchPolicy) => { const h = policyHash(p); known.set(h, p); return { hash: h, files: { 'policy.json': JSON.stringify(p, null, 2) } }; };
  const first = register(start);
  return {
    identity: async () => 'meta:' + trials.manifest.id + ':' + manifestHash(trials.manifest),
    contract: () => ({ about: 'a research policy (research-policy@1): observations in code over a capture of a junior\'s course, rules the Judge answers, a composition (p, m) => ({ guidance, state }) that advises develop, contrast or reframe, or abstains; its templates are the only words it gives',
      files: ['policy.json'], keep: 'its format and contract; evidence only from its capture; it never acts in the world',
      measured_by: 'whole runs of a junior with the policy frozen, on the manifest\'s development cases: per kind of world, the share that did NOT solve their task (lower is better)' }),
    start: () => first,
    validate: (files) => { const p = parse(Object.fromEntries(Object.entries(files).filter(([, v]) => v !== null)) as Record<string, string>); return typeof p === 'string' ? p : null; },
    materialize(_from, files) {
      const p = parse(Object.fromEntries(Object.entries(files).filter(([, v]) => v !== null)) as Record<string, string>);
      return typeof p === 'string' ? { error: p } : register(p);
    },
    adopt(hash, files) {
      const p = parse(files);
      if (typeof p === 'string') return p;
      return policyHash(p) === hash ? (register(p), null) : 'its content hashes to ' + policyHash(p);
    },
    async evaluate(hash): Promise<Evaluation & { evidence?: unknown }> {
      const p = known.get(hash);
      if (!p) return { executable: false, correct: 'no', quality: null, descriptor: null, feedback: null, diagnostics: ['unknown policy ' + hash], evaluator: 'meta:' + trials.manifest.id + ':' + manifestHash(trials.manifest) };
      const ran = await trials.run(p, 'development', signal);
      const q = qualityOf(ran);
      return { executable: true, correct: q.correct ? 'yes' : 'no', quality: q.quality, descriptor: null,
        feedback: { kinds: q.kinds, quality: q.quality, trials: ran.map((t) => ({ case: t.case, rep: t.rep, state: t.result.state, solved: t.result.solved, advice: t.result.advice, policy_errors: t.result.policy_errors })) },
        diagnostics: [...(q.correct ? [] : ['an output of the policy broke its contract']), ...(q.infra ? [q.infra + ' trial(s) failed in the infrastructure: they measure nothing'] : [])],
        evaluator: 'meta:' + trials.manifest.id + ':' + manifestHash(trials.manifest),
        evidence: ran.map((t) => ({ trial: t.trial, case: t.case, rep: t.rep, kind: t.kind, result: t.result })) };
    }
  };
}

/* --- Verification -------------------------------------------------------------------------------------------------------- */

/** A meta-laboratory verified from its record alone (§11): every trial's result read again from its child's record, and
    every decision of its policy rebuilt from its capture and the Judge's recorded answers - no inference, no new run. */
export function verifyTrials(dir: string, manifest: MetaManifest, runner: CodeRunner): { holds: boolean; trials: number; decisions: number; problems: string[] } {
  const t = new Trials(dir, manifest, async () => { throw new Error('a verification runs nothing'); });
  const problems: string[] = [];
  let decisions = 0, count = 0;
  const finished = new Map<string, J>();
  for (const e of t.ledger()) if (e.type === 'research_trial_finished') finished.set(e.trial, e);
  for (const e of t.ledger().filter((x) => x.type === 'research_trial_requested')) {
    count++;
    const f = finished.get(e.trial);
    if (!f) { problems.push(e.trial + ': requested, never finished'); continue; }
    const c = manifest.cases.find((x) => x.id === e.case);
    if (!c) { problems.push(e.trial + ': its case is not in the manifest'); continue; }
    const file = path.join(dir, e.out);
    const again = trialResult(file, c.criterion);
    if (stableStringify({ ...again, why: undefined }) !== stableStringify({ ...f.result, why: undefined })) problems.push(e.trial + ': its record says otherwise now');
    try {
      const v = verifyPolicyDecisions(JSON.parse(fs.readFileSync(file, 'utf8')), runner);
      if (v) { decisions += v.decisions; problems.push(...v.problems.map((p) => e.trial + ': ' + p)); }
    } catch { if (f.result.state !== 'infra') problems.push(e.trial + ': no record to read'); }
  }
  return { holds: !problems.length, trials: count, decisions, problems };
}
