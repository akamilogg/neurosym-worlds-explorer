import fs from 'node:fs';
import path from 'node:path';
import { hashString, stableStringify } from '../core/hash.ts';
import { LABS } from '../worlds/labs.ts';
import { runResults } from '../orchestra/results.ts';
import { checkPolicy, policyHash, verifyPolicyDecisions, type PolicyConfig, type ResearchPolicy } from '../learn/assisted/research-policy.ts';
import type { Evaluator, SearchManifest } from '../learn/evolve/engine.ts';
import { verifySearch } from '../learn/evolve/verify.ts';
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
  else {
    /* A trial launches only work the fund can reserve before it is dispatched (§11): its junior's tokens and its Judge's
       calls, each bounded here. Work no limit of the manifest bounds - branches, agents - is not launched from a trial. */
    const bounded = (k: string) => o.junior.args.includes(k) && Number(o.junior.args[o.junior.args.indexOf(k) + 1]) > 0;
    if (!bounded('--max-tokens')) errors.push('"junior.args": its --max-tokens, what each trial may spend at most - what is reserved for it before it is launched');
    if (!bounded('--max-judge-calls')) errors.push('"junior.args": its --max-judge-calls, the calls of the Judge each trial may make at most - what is reserved for it before it is launched');
    for (const k of ['--delegation-fund', '--agents', '--opening']) if (o.junior.args.includes(k)) errors.push('"junior.args": ' + k + ' - work the fund for trials cannot reserve (the Judge of its branches, its agents: no limit of the manifest bounds them); a condition with it is a batch\'s, not a trial\'s');
  }
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
  /** ended: it ran to its end; cancelled: stopped by the operator, partial; infra: the harness or a provider failed;
      unfunded: never launched, the fund for trials could not hold it. */
  readonly state: 'ended' | 'cancelled' | 'infra' | 'unfunded';
  /** Whether it solved its task by its case's criterion; null where it cannot say. */
  readonly solved: boolean | null;
  readonly stopped_by: string | null;
  /** The policy's own failures in it: decisions whose output broke the contract. */
  readonly policy_errors: number;
  readonly advice: number;
  readonly tokens: number | null;
  readonly why?: string;
}

/** What runs a trial's children. Its identity is the configuration they really run with - System 2's model, its endpoint's
    path and tuning, the Judge's model - beyond what the manifest fixes: part of every trial's identity, so a trial under
    another model is another trial, never the result of this one. */
export interface TrialLauncher {
  readonly identity: Readonly<Record<string, unknown>>;
  /** Runs one child: its journal at `out` - resuming `resume` when given, with `args` the trial's arguments, its controls
      among them (they are given again on a resumption: a resumed run takes its controls anew). */
  run(t: { readonly lab: string; readonly args: readonly string[]; readonly out: string; readonly resume?: string; readonly signal?: AbortSignal;
    /** System 2's connection for this launch, when the candidate brings its own (a junior's session): the launcher's otherwise. */
    readonly connection?: import('../runtime/lab-runner.ts').LabConnection }): Promise<{ readonly journal: string }>;
}

/** What a trial measures (SPEC-METAPOLITICA-APRENDIZAJE §6): a research policy, or a junior packaged. Its `config` names it
    with everything that configures it - part of every trial's id; its `label` is what the ledger records it as; its `args`
    go to the child after the case's and the junior's. `connect` gives a launch its own System 2 (a junior's session),
    told the launch and the record it resumes. */
export interface TrialCandidate {
  readonly config: string;
  readonly label: string;
  readonly args: readonly string[];
  connect?(t: { readonly trial: string; readonly launch: string; readonly resume?: string }): Promise<import('../runtime/lab-runner.ts').LabConnection>;
}

/** A child's result, read from its record only - its journal and the files beside it (its finding): the world's own
    acceptance, by its case's criterion. */
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
  if (stoppedBy === 'diverged' || stoppedBy === 'llm_error' || stoppedBy.startsWith('error')) return { state: 'infra', solved: null, stopped_by: stoppedBy, policy_errors: policyErrors, advice, tokens };
  /* A trial measures the policy under the configuration it is named by: where a provider failed it, it measures nothing - a
     check computed without the Judge's answers is no verdict, and a proposal System 2 never answered is a round the junior
     lost to the provider, not to its method. */
  const judgeErrors = Number(end.jev?.errors) || 0;
  const lost = events.filter((e) => e.type === 'proposal_failed').length;
  if (judgeErrors || lost) return { state: 'infra', solved: null, stopped_by: stoppedBy, policy_errors: policyErrors, advice, tokens,
    why: [judgeErrors ? judgeErrors + ' call(s) of the Judge failed' : '', lost ? lost + ' proposal(s) System 2 never answered' : ''].filter(Boolean).join('; ') + ': a failure of the providers, no measure' };
  const o1 = runResults(journalFile).o1_predictive_acceptance;
  const solved = criterion === 'model_accepted' ? o1.model : o1.artifact ?? false;
  return { state: 'ended', solved, stopped_by: stoppedBy, policy_errors: policyErrors, advice, tokens };
}

/** The tokens a trial's junior may spend at most: its --max-tokens, which the manifest must fix - what is reserved. */
export function juniorMaxTokens(m: MetaManifest): number {
  const i = m.junior.args.indexOf('--max-tokens');
  return i >= 0 ? Number(m.junior.args[i + 1]) : NaN;
}

/** The calls of the Judge a trial may make at most: its --max-judge-calls, which the manifest must fix - what is reserved. */
export function juniorMaxJudgeCalls(m: MetaManifest): number {
  const i = m.junior.args.indexOf('--max-judge-calls');
  return i >= 0 ? Number(m.junior.args[i + 1]) : NaN;
}

const rel = (dir: string, f: string) => path.relative(dir, f).split(path.sep).join('/');

/** The trials of a meta-laboratory: their ledger (requested before dispatch, each launch reserved from the fund and
    settled, finished once) and their children. `fund`: the tokens its trials may spend in all, `judgeFund` the calls of the
    Judge they may make in all - each reserved before a launch, a launch they cannot hold never made. */
export class Trials {
  readonly dir: string;
  readonly manifest: MetaManifest;
  private readonly launcher: TrialLauncher;
  private readonly ledgerFile: string;
  private readonly fund: number | null;
  private readonly judgeFund: number | null;

  constructor(dir: string, manifest: MetaManifest, launcher: TrialLauncher, o: { fund?: number; judgeFund?: number } = {}) {
    const problems = manifestProblems(manifest);
    if (problems.length) throw new Error('the manifest: ' + problems.join('; '));
    this.dir = dir; this.manifest = manifest; this.launcher = launcher;
    this.fund = o.fund ?? null;
    this.judgeFund = o.judgeFund ?? null;
    this.ledgerFile = path.join(dir, 'trials.jsonl');
    fs.mkdirSync(path.join(dir, 'trials'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'policies'), { recursive: true });
  }

  ledger(): J[] { return fs.existsSync(this.ledgerFile) ? fs.readFileSync(this.ledgerFile, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : []; }
  private write(e: J): void { fs.appendFileSync(this.ledgerFile, JSON.stringify({ at: new Date().toISOString(), ...e }) + '\n'); }

  /** What its trials spent of the fund: what each launch settled, and what launches not settled yet hold reserved - the
      tokens, or the calls of the Judge. */
  spent(ledger = this.ledger(), what: 'tokens' | 'judge_calls' = 'tokens'): number {
    const settled = new Set<string>();
    let n = 0;
    for (const e of ledger) if (e.type === 'research_trial_settled') { settled.add(e.launch); n += Number(e[what]) || 0; }
    for (const e of ledger) if (e.type === 'research_trial_reserved' && !settled.has(e.launch)) n += Number(e[what]) || 0;
    return n;
  }

  /** What its trials' results depend on beyond the policy: this manifest and the configuration its children run with. */
  identity(): string {
    return 'meta:' + this.manifest.id + ':' + manifestHash(this.manifest) + ':' + hashString(stableStringify(this.launcher.identity));
  }

  /** A policy with how its capture is made and its limits, as the manifest fixes them: named by the hash of all of it. */
  private policyFile(policy: ResearchPolicy): { file: string; hash: string } {
    const config = { policy, ...(this.manifest.policy ?? {}) };
    const hash = hashString(stableStringify(config));
    const file = path.join(this.dir, 'policies', hash + '.json');
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(config, null, 2));
    return { file, hash };
  }

  /** A trial's identity: the manifest, the case, the repetition, the policy with its configuration, and the configuration its
      children really run with - the same trial is never run twice, another is never taken for it. */
  trialId(config: string, c: MetaCase, rep: number): string {
    return 't-' + hashString(stableStringify([manifestHash(this.manifest), c.id, rep, config, this.launcher.identity]));
  }

  /** Where a trial's record is now: the latest of its first run and its continuations that exists (a continuation that never
      made its record is an intention that failed, kept in the ledger - never a record), or null. */
  recordOf(id: string, ledger = this.ledger()): string | null {
    const chain = [path.join('trials', id + '.json'), ...ledger.filter((e) => e.type === 'research_trial_resumed' && e.trial === id).map((e) => String(e.out))];
    return chain.map((f) => path.join(this.dir, f)).filter((f) => fs.existsSync(f)).at(-1) ?? null;
  }

  /** Runs (or reconciles) every trial of a policy on the cases of a partition, in order; answers each result. It stops at
      a cancellation, and at a trial the fund cannot hold. */
  async run(policy: ResearchPolicy, partition: 'development' | 'confirmation', signal?: AbortSignal): Promise<{ trial: string; case: string; rep: number; kind: string; result: TrialResult }[]> {
    const errors = checkPolicy(policy);
    if (errors.length) throw new Error('the policy: ' + errors.join('; '));
    const { file, hash } = this.policyFile(policy);
    return this.runCandidate({ config: hash, label: policyHash(policy), args: ['--researcher', 'assisted', '--research-policy', rel(this.dir, file)] }, partition, signal);
  }

  /** Every trial of a candidate on the cases of a partition, in order (`only`: those cases alone); the same reservations,
      ledger and reconciliation whatever the candidate is. */
  async runCandidate(candidate: TrialCandidate, partition: 'development' | 'confirmation', signal?: AbortSignal, only?: ReadonlySet<string>): Promise<{ trial: string; case: string; rep: number; kind: string; result: TrialResult }[]> {
    const out: { trial: string; case: string; rep: number; kind: string; result: TrialResult }[] = [];
    for (const c of this.manifest.cases.filter((x) => x.partition === partition && (!only || only.has(x.id)))) {
      for (let rep = 0; rep < (this.manifest.repetitions ?? 1); rep++) {
        const id = this.trialId(candidate.config, c, rep);
        const result = await this.one(id, candidate, c, rep, signal);
        out.push({ trial: id, case: c.id, rep, kind: c.kind ?? c.lab, result });
        if (signal?.aborted || result.state === 'unfunded') return out;
      }
    }
    return out;
  }

  private async one(id: string, candidate: TrialCandidate, c: MetaCase, rep: number, signal?: AbortSignal): Promise<TrialResult> {
    const policy = candidate.label, config = candidate.config;
    let ledger = this.ledger();
    const finished = ledger.find((e) => e.type === 'research_trial_finished' && e.trial === id && e.result.state === 'ended');
    if (finished) return finished.result;
    const args = [...c.args, ...this.manifest.junior.args, ...candidate.args];
    /* A child with a record: its end read as it is (never run again), or resumed from it where it was cut. */
    const record = this.recordOf(id, ledger);
    let resume: string | undefined;
    if (record) {
      /* A record under another configuration is another trial's: never taken as this one's result, never resumed into it. */
      const mismatch = configurationMismatch(record, this.launcher.identity);
      const r = trialResult(record, c.criterion);
      if (mismatch) {
        const infra: TrialResult = { ...r, state: 'infra', solved: null, why: mismatch };
        this.write({ type: 'research_trial_finished', trial: id, record: rel(this.dir, record), result: infra, reconciled: true });
        return infra;
      }
      if (r.state === 'ended') { this.write({ type: 'research_trial_finished', trial: id, record: rel(this.dir, record), result: r, reconciled: true }); return r; }
      resume = record;
    }
    if (!ledger.some((e) => e.type === 'research_trial_requested' && e.trial === id))
      this.write({ type: 'research_trial_requested', trial: id, case: c.id, rep, policy, config, manifest: manifestHash(this.manifest), identity: this.launcher.identity,
        lab: c.lab, args, out: rel(this.dir, path.join(this.dir, 'trials', id + '.json')) });
    /* Its launch reserved from the fund before it is dispatched: what its junior may spend at most, and its Judge's calls. */
    ledger = this.ledger();
    const reserve = juniorMaxTokens(this.manifest), reserveJudge = juniorMaxJudgeCalls(this.manifest);
    const short = this.fund !== null && this.spent(ledger) + reserve > this.fund
      ? 'the fund for trials (' + this.fund + ' tokens) cannot hold its reserve (' + reserve + '): ' + this.spent(ledger) + ' spent or held'
      : this.judgeFund !== null && this.spent(ledger, 'judge_calls') + reserveJudge > this.judgeFund
        ? 'the fund for trials (' + this.judgeFund + ' calls of the Judge) cannot hold its reserve (' + reserveJudge + '): ' + this.spent(ledger, 'judge_calls') + ' made or held' : null;
    if (short) {
      const r: TrialResult = { state: 'unfunded', solved: null, stopped_by: null, policy_errors: 0, advice: 0, tokens: null, why: short };
      this.write({ type: 'research_trial_refused', trial: id, reason: r.why });
      return r;
    }
    /* A continuation never written over a record: the next name free - one whose launch failed before it made its record
       keeps its intention in the ledger, and its name. */
    const resumedOuts = new Set(ledger.filter((e) => e.type === 'research_trial_resumed' && e.trial === id).map((e) => String(e.out)));
    let target = path.join(this.dir, 'trials', id + '.json');
    for (let k = resumedOuts.size + 1; resume; k++) {
      target = path.join(this.dir, 'trials', id + '.r' + k + '.json');
      if (!fs.existsSync(target) && !resumedOuts.has(rel(this.dir, target))) break;
    }
    if (fs.existsSync(target)) throw new Error('trial ' + id + ': ' + target + ' exists and is not what is resumed - nothing is written over a record');
    const launch = id + '#' + ledger.filter((e) => e.type === 'research_trial_reserved' && e.trial === id).length;
    this.write({ type: 'research_trial_reserved', trial: id, launch, tokens: reserve, judge_calls: reserveJudge });
    if (resume) this.write({ type: 'research_trial_resumed', trial: id, from: rel(this.dir, resume), out: rel(this.dir, target) });
    let result: TrialResult;
    let journal = target;
    try {
      const connection = candidate.connect ? await candidate.connect({ trial: id, launch, ...(resume ? { resume } : {}) }) : undefined;
      journal = (await this.launcher.run({ lab: c.lab, args, out: target, ...(resume ? { resume } : {}), ...(signal ? { signal } : {}), ...(connection ? { connection } : {}) })).journal;
      result = trialResult(journal, c.criterion);
      /* Its child must have run with the configuration the trial is named by: another model is another trial. */
      const mismatch = configurationMismatch(journal, this.launcher.identity);
      if (mismatch) result = { ...result, state: 'infra', solved: null, why: mismatch };
    } catch (e) { result = { state: 'infra', solved: null, stopped_by: null, policy_errors: 0, advice: 0, tokens: null, why: String((e as Error).message ?? e).slice(0, 300) }; }
    if (signal?.aborted && result.state !== 'ended') result = { ...result, state: 'cancelled' };
    /* What this launch spent: the live tokens of its process and its Judge's live calls; unknown, what it held. */
    const live = liveTokens(journal), judged = liveJudgeCalls(journal);
    this.write({ type: 'research_trial_settled', trial: id, launch, tokens: live ?? reserve, judge_calls: judged ?? reserveJudge,
      ...(live === null || judged === null ? { unknown: [...(live === null ? ['tokens'] : []), ...(judged === null ? ['judge_calls'] : [])] } : {}) });
    this.write({ type: 'research_trial_finished', trial: id, record: rel(this.dir, journal), result });
    return result;
  }
}

/** The tokens a run spent live in its process (a continuation's replayed history aside), or null where unknown. */
function liveTokens(journalFile: string): number | null {
  try {
    const j = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
    const end = [...(j.events ?? [])].reverse().find((e: J) => e.type === 'end');
    if (end?.console_usage?.usage_unknown) return null;
    return typeof end?.console_usage?.llm_tokens_live === 'number' ? end.console_usage.llm_tokens_live : null;
  } catch { return null; }
}

/** The calls of the Judge a run made live in its process (its replayed history aside), or null where unknown. */
function liveJudgeCalls(journalFile: string): number | null {
  try {
    const j = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
    const end = [...(j.events ?? [])].reverse().find((e: J) => e.type === 'end');
    if (!end) return null;
    return j.config?.flat ? 0 : Number(end.replay?.live?.jev ?? 0);
  } catch { return null; }
}

/** Where a child's record says it ran with other than what the trial is named by (System 2's model, the Judge's), or null. */
export function configurationMismatch(journalFile: string, identity: Readonly<Record<string, unknown>>): string | null {
  let c: J;
  try { c = JSON.parse(fs.readFileSync(journalFile, 'utf8')).config ?? {}; } catch { return null; }
  for (const [k, field] of [['llm_model', 'llm_model'], ['judge_model', 'jev_model']] as const) {
    if (identity[k] !== undefined && identity[k] !== null && c[field] !== undefined && c[field] !== identity[k]) return 'its child ran with ' + field + ' ' + c[field] + ', the trial is of ' + identity[k];
  }
  return null;
}

/** A default launcher: the child in this process, through the harness's own runner, in the meta-laboratory's folder. Its
    identity: System 2's model, endpoint path and tuning, and the Judge's model - never a key. */
export function inProcessLauncher(o: { root: string; llm: import('../runtime/lab-runner.ts').LabConnection; judge?: import('../runtime/lab-runner.ts').LabConnection; fetch?: import('../core/net.ts').FetchLike }): TrialLauncher {
  const pathOf = (u?: string) => { try { return u ? new URL(u).pathname : null; } catch { return null; } };
  const tuning = (c: J) => Object.fromEntries(Object.entries(c).filter(([k]) => ['temperature', 'reasoningEffort', 'maxTokens', 'jsonMode', 'extraBody', 'provider'].includes(k)));
  return {
    identity: { llm_model: o.llm.model ?? null, llm_path: pathOf(o.llm.url), llm_tuning: tuning(o.llm as J), judge_model: o.judge?.model ?? null },
    async run(t) {
      const { runLaboratory, controlArgs } = await import('../runtime/lab-runner.ts');
      const r = await runLaboratory(LABS[t.lab], { args: t.resume ? ['--resume', t.resume, ...controlArgs(t.args), '--out', t.out] : [...t.args, '--out', t.out], root: o.root, llm: t.connection ?? o.llm,
        ...(o.judge ? { judge: o.judge } : {}), ...(o.fetch ? { fetch: o.fetch } : {}), ...(t.signal ? { signal: t.signal } : {}), print: () => {} });
      return { journal: r.journal };
    }
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

/** An evaluation of a candidate from its trials: a measure only when every trial it needs was run - one cut short (a trial
    the fund could not hold, a cancellation, trials never reached) is kept as it is, incomplete: its correctness unchecked,
    no quality, never competing with complete ones. */
export function measureOf(trials: readonly { kind: string; result: TrialResult }[], needed: number): { complete: boolean; correct: 'yes' | 'no' | 'unchecked'; quality: (number | null)[] | null; q: ReturnType<typeof qualityOf> } {
  const q = qualityOf(trials);
  const complete = trials.length >= needed && trials.every((t) => t.result.state !== 'unfunded' && t.result.state !== 'cancelled');
  return complete ? { complete, correct: q.correct ? 'yes' : 'no', quality: q.quality, q } : { complete, correct: 'unchecked', quality: null, q };
}

/* A candidate is one file, policy.json: what holds to the contract, by its content's hash. */
function policyOfFiles(files: Readonly<Record<string, string | null>>): ResearchPolicy | string {
  const keys = Object.keys(files).filter((k) => files[k] !== null);
  if (keys.length !== 1 || keys[0] !== 'policy.json') return 'a policy is one file, policy.json';
  let p: unknown;
  try { p = JSON.parse(String(files['policy.json'])); } catch { return 'policy.json is not JSON'; }
  const errors = checkPolicy(p);
  return errors.length ? errors.join('; ') : p as ResearchPolicy;
}
const candidateOf = (p: ResearchPolicy) => ({ hash: policyHash(p), files: { 'policy.json': JSON.stringify(p, null, 2) } });

/** The trials an evaluation needs: every development case, every repetition. */
export const trialsPerEvaluation = (m: MetaManifest): number => m.cases.filter((c) => c.partition === 'development').length * (m.repetitions ?? 1);

/** The evaluator of an evolutionary search over policies: a candidate is one file, policy.json; it is measured by its
    trials on the development cases, and the evidence is the trials themselves. The engine stays the only authority over the
    population and its resources; the trials' tokens are the fund's. `onUnfunded`: told when a trial could not be held -
    the search is to stop there, and what was not measured is not a measure. */
export function policyEvaluator(trials: Trials, start: ResearchPolicy, o: { signal?: AbortSignal; onUnfunded?: () => void } = {}): Evaluator {
  const known = new Map<string, ResearchPolicy>();
  const register = (p: ResearchPolicy) => { known.set(policyHash(p), p); return candidateOf(p); };
  const first = register(start);
  const identity = trials.identity();
  return {
    identity: async () => identity,
    contract: () => ({ about: 'a research policy (research-policy@1): observations in code over a capture of a junior\'s course, rules the Judge answers, a composition (p, m) => ({ guidance, state }) that advises develop, contrast or reframe, or abstains; its templates are the only words it gives',
      files: ['policy.json'], keep: 'its format and contract; evidence only from its capture; it never acts in the world',
      measured_by: 'whole runs of a junior with the policy frozen, on the manifest\'s development cases: per kind of world, the share that did NOT solve their task (lower is better)' }),
    start: () => first,
    validate: (files) => { const p = policyOfFiles(files); return typeof p === 'string' ? p : null; },
    materialize(_from, files) { const p = policyOfFiles(files); return typeof p === 'string' ? { error: p } : register(p); },
    adopt(hash, files) {
      const p = policyOfFiles(files);
      if (typeof p === 'string') return p;
      return policyHash(p) === hash ? (register(p), null) : 'its content hashes to ' + policyHash(p);
    },
    async evaluate(hash): Promise<Evaluation & { evidence?: unknown }> {
      const p = known.get(hash);
      if (!p) return { executable: false, correct: 'no', quality: null, descriptor: null, feedback: null, diagnostics: ['unknown policy ' + hash], evaluator: identity };
      const ran = await trials.run(p, 'development', o.signal);
      if (ran.some((t) => t.result.state === 'unfunded')) o.onUnfunded?.();
      const needed = trialsPerEvaluation(trials.manifest);
      const m = measureOf(ran, needed), q = m.q;
      return { executable: true, correct: m.correct, quality: m.quality, descriptor: null,
        feedback: { kinds: q.kinds, quality: m.quality, ...(m.complete ? {} : { incomplete: true }), trials: ran.map((t) => ({ case: t.case, rep: t.rep, state: t.result.state, solved: t.result.solved, advice: t.result.advice, policy_errors: t.result.policy_errors })) },
        diagnostics: [...(m.complete ? [] : ['incomplete: ' + ran.filter((t) => t.result.state !== 'unfunded' && t.result.state !== 'cancelled').length + ' of its ' + needed + ' trials run to their end (the fund could not hold the rest, or a cancellation) - not a measure']),
          ...(q.correct ? [] : ['an output of the policy broke its contract']), ...(q.infra ? [q.infra + ' trial(s) failed in the infrastructure: they measure nothing'] : [])],
        evaluator: identity,
        evidence: ran.map((t) => ({ trial: t.trial, case: t.case, rep: t.rep, kind: t.kind, result: t.result })) };
    }
  };
}

/** An evaluator that measures nothing, for a search over policies rebuilt from its record: its identity, contract and start
    as the record has them, its candidates made again by their content. */
export function recordedPolicyEvaluator(events: readonly J[], startFiles: Readonly<Record<string, string>>, start: string): Evaluator {
  const started = events.find((e) => e.type === 'search_started');
  return {
    identity: async () => String(started?.evaluator ?? ''),
    contract: () => events.find((e) => e.type === 'attempt_planned')?.context?.task ?? null,
    start: () => ({ hash: start, files: startFiles }),
    validate: (files) => { const p = policyOfFiles(files); return typeof p === 'string' ? p : null; },
    materialize(_from, files) { const p = policyOfFiles(files); return typeof p === 'string' ? { error: p } : candidateOf(p); },
    adopt(hash, files) { const p = policyOfFiles(files); return typeof p === 'string' ? p : policyHash(p) === hash ? null : 'its content hashes to ' + policyHash(p); },
    evaluate: async () => { throw new Error('verification is offline: a measure the record does not hold is not taken'); }
  };
}

/* --- Verification -------------------------------------------------------------------------------------------------------- */

/** A meta-laboratory verified from its record alone, against the manifest given (§11): every trial recorded under this
    manifest and with its case's arguments as they are now, its result read again from its child's record, every decision
    of its policy rebuilt from its capture and the Judge's recorded answers; every search sealed here rebuilt - its
    selection, quotas and cost - and each of its evaluations computed again from its trials. No inference, no new run. */
export async function verifyTrials(dir: string, manifest: MetaManifest, runner: CodeRunner): Promise<{ holds: boolean; trials: number; decisions: number; searches: number; problems: string[] }> {
  const problems: string[] = [];
  const ledgerFile = path.join(dir, 'trials.jsonl');
  const ledger: J[] = fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const hash = manifestHash(manifest);
  let decisions = 0, count = 0;
  const finished = new Map<string, J>();
  for (const e of ledger) if (e.type === 'research_trial_finished') finished.set(e.trial, e);
  const requested = new Set(ledger.filter((e) => e.type === 'research_trial_requested').map((e) => String(e.trial)));
  for (const e of ledger.filter((x) => x.type === 'research_trial_requested')) {
    count++;
    if (e.manifest !== hash) { problems.push(e.trial + ': recorded under another manifest (' + e.manifest + '), not this one (' + hash + ')'); continue; }
    const c = manifest.cases.find((x) => x.id === e.case);
    if (!c) { problems.push(e.trial + ': its case is not in the manifest'); continue; }
    const expected = [...c.args, ...manifest.junior.args];
    if (stableStringify((e.args as string[]).slice(0, expected.length)) !== stableStringify(expected)) problems.push(e.trial + ': its arguments are not its case\'s in this manifest');
    const f = finished.get(e.trial);
    if (!f) { problems.push(e.trial + ': requested, never finished'); continue; }
    if (f.result.state === 'unfunded') continue;
    const file = path.join(dir, f.record ?? e.out);
    const again = trialResult(file, c.criterion);
    const mismatch = configurationMismatch(file, e.identity ?? {});
    const read = mismatch ? { ...again, state: 'infra', solved: null } : again;
    if (stableStringify({ ...read, why: undefined }) !== stableStringify({ ...f.result, why: undefined })) problems.push(e.trial + ': its record says otherwise now');
    try {
      const v = verifyPolicyDecisions(JSON.parse(fs.readFileSync(file, 'utf8')), runner);
      if (v) { decisions += v.decisions; problems.push(...v.problems.map((p) => e.trial + ': ' + p)); }
    } catch { if (f.result.state !== 'infra') problems.push(e.trial + ': no record to read'); }
  }
  /* Its searches: each rebuilt from its record with no model nor measure, and each evaluation computed again from its trials. */
  const searchesDir = path.join(dir, 'searches');
  const manifests = fs.existsSync(searchesDir) ? fs.readdirSync(searchesDir).filter((f) => f.endsWith('.manifest.json')) : [];
  const sealed = new Map<string, SearchManifest>();
  for (const m of manifests) { const x = JSON.parse(fs.readFileSync(path.join(searchesDir, m), 'utf8')) as SearchManifest; sealed.set(x.hash, x); }
  for (const m of manifests) {
    const events = path.join(searchesDir, m.replace(/\.manifest\.json$/, '.jsonl'));
    const v = await verifySearch(events, path.join(searchesDir, m), (h) => sealed.get(h) ?? null, undefined, recordedPolicyEvaluator);
    if (!v.holds) problems.push('search ' + m + ': ' + v.why);
    for (const e of fs.readFileSync(events, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x: J) => x.type === 'evaluation' && Array.isArray(x.evidence))) {
      const again = measureOf(e.evidence, trialsPerEvaluation(manifest));
      if (stableStringify(again.quality) !== stableStringify(e.result.quality) || again.correct !== e.result.correct) problems.push('search ' + m + ', ' + e.evaluation + ': computed again from its trials, not the quality recorded');
      /* Every trial it rests on must be in this ledger, requested and finished as it says: evidence with no trial is none. */
      for (const t of e.evidence as J[]) {
        const f = finished.get(t.trial);
        if (!requested.has(String(t.trial)) || !f) problems.push('search ' + m + ', ' + e.evaluation + ': trial ' + t.trial + ' is not in the ledger of trials');
        else if (stableStringify(f.result) !== stableStringify(t.result)) problems.push('search ' + m + ', ' + e.evaluation + ': trial ' + t.trial + ' is not as the ledger finished it');
      }
    }
  }
  return { holds: !problems.length, trials: count, decisions, searches: manifests.length, problems };
}
