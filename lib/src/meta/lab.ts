import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { hashString, stableStringify } from '../core/hash.ts';
import { LABS } from '../worlds/labs.ts';
import { realizationOf } from '../junior/groups.ts';
import { runResults } from '../orchestra/results.ts';
import { checkPolicy, legacyPolicyHash, policyHash, verifyPolicyDecisions, type PolicyConfig, type ResearchPolicy } from '../learn/assisted/research-policy.ts';
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
  /** training: run only to be learned from (a junior's distillation), never measured. */
  readonly partition: 'development' | 'confirmation' | 'training';
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
  /** How many times a trial a provider failed is tried again, each attempt reserved (SPEC-VALIDEZ-MEDIDA §3.2). Default 2. */
  readonly infra_retries?: number;
}

export const DEFAULT_INFRA_RETRIES = 2;

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
    if (!['development', 'confirmation', 'training'].includes(c?.partition)) errors.push(at + ': "partition" is "development", "confirmation" or "training"');
    if (!['model_accepted', 'artifact_accepted'].includes(c?.criterion)) errors.push(at + ': "criterion" is "model_accepted" or "artifact_accepted"');
  }
  /* One world in one realization is one case: the same world in development and in confirmation would confirm on what was
     developed on (SPEC-VALIDEZ-MEDIDA §3.4). Compared by the world its arguments make - its trial's: the case's, then the
     junior's - never by how they are written. */
  const where = new Map<string, { id: string; partition: string }>();
  const juniorArgs = Array.isArray(o.junior?.args) ? (o.junior.args as unknown[]).map(String) : [];
  for (const c of (Array.isArray(o.cases) ? o.cases : []) as J[]) {
    if (!Array.isArray(c?.args) || !LABS[c?.lab]) continue;
    const key = realizationOf(c.lab, [...c.args.map(String), ...juniorArgs]);
    const seen = where.get(key);
    if (seen && seen.partition !== c.partition) errors.push('cases "' + seen.id + '" and "' + c.id + '": the same world and realization (' + c.lab + ') in ' + seen.partition + ' and ' + c.partition);
    if (!seen) where.set(key, { id: c.id, partition: c.partition });
  }
  if (o.repetitions !== undefined && !(Number.isInteger(o.repetitions) && o.repetitions > 0)) errors.push('"repetitions": a whole number above 0');
  if (o.infra_retries !== undefined && !(Number.isInteger(o.infra_retries) && o.infra_retries >= 0)) errors.push('"infra_retries": a whole number, 0 or more');
  return errors;
}

/** SHA-256 in hexadecimal: the identity of a manifest, a trial, a policy's file (SPEC-VALIDEZ-MEDIDA §3.3). A 32-bit hash
    named them before; two different contents under one name would have served one as the other. */
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
/** The first 24 hexadecimals: enough for a name. */
const short = (text: string): string => sha256(text).slice(0, 24);

export const manifestHash = (m: MetaManifest): string => sha256(stableStringify(m));
/** The manifest's hash as ledgers written before SHA-256 recorded it: read, never written. */
const legacyManifestHash = (m: MetaManifest): string => hashString(stableStringify(m));

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
  /** For infra: whose failure it was (SPEC-VALIDEZ-MEDIDA §3.1) - a provider's (an HTTP status of the service, the network,
      the Judge), the harness's (its child crashed, diverged, ran under another configuration), or one that cannot be told
      (a timeout with no answer of the service in the run to compare with), counted apart. */
  readonly cause?: 'provider' | 'harness' | 'indeterminate';
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
  /** Its config as ledgers written before SHA-256 named it: their trials are read as this candidate's, never written. */
  readonly legacyConfig?: string;
  readonly label: string;
  readonly args: readonly string[];
  connect?(t: { readonly trial: string; readonly launch: string; readonly resume?: string }): Promise<import('../runtime/lab-runner.ts').LabConnection>;
}

/** A child's result, read from its record only - its journal and the files beside it (its finding): the world's own
    acceptance, by its case's criterion. */
export function trialResult(journalFile: string, criterion: Criterion): TrialResult {
  let j: J;
  try { j = JSON.parse(fs.readFileSync(journalFile, 'utf8')); } catch { return { state: 'infra', solved: null, stopped_by: null, policy_errors: 0, advice: 0, tokens: null, why: 'no record', cause: 'harness' }; }
  const events = (j.events ?? []) as J[];
  const end = [...events].reverse().find((e) => e.type === 'end');
  const policyErrors = events.filter((e) => e.type === 'research_policy_decided' && e.failure === 'invalid_output').length;
  const advice = events.filter((e) => e.type === 'research_policy_delivered' && e.message).length;
  const tokens = typeof end?.console_usage?.llm_tokens_live === 'number' ? end.console_usage.llm_tokens_live : null;
  if (!end) return { state: 'cancelled', solved: null, stopped_by: null, policy_errors: policyErrors, advice, tokens, why: 'it did not end' };
  const stoppedBy = String(end.stoppedBy ?? '');
  if (stoppedBy === 'cancelled') return { state: 'cancelled', solved: null, stopped_by: stoppedBy, policy_errors: policyErrors, advice, tokens };
  if (stoppedBy === 'llm_error') return { state: 'infra', solved: null, stopped_by: stoppedBy, policy_errors: policyErrors, advice, tokens, cause: 'provider', why: 'the service refused the account' };
  if (stoppedBy === 'judge_unavailable') return { state: 'infra', solved: null, stopped_by: stoppedBy, policy_errors: policyErrors, advice, tokens, cause: 'provider', why: 'its Judge did not answer: its checks were void' };
  if (stoppedBy === 'diverged' || stoppedBy.startsWith('error')) return { state: 'infra', solved: null, stopped_by: stoppedBy, policy_errors: policyErrors, advice, tokens, cause: 'harness' };
  /* A trial measures the candidate under the configuration it is named by. Where a provider failed it, it measures nothing:
     a check computed without the Judge's answers is no verdict, and a proposal the service never answered is a round lost
     to the provider. But a candidate that does not answer within its time while the same service answers its other
     requests (a junior that runs out its time) failed by itself: its trial ended, and is read as it ended. Only what cannot
     be told either way is left apart, as infra counted on its own (SPEC-VALIDEZ-MEDIDA §3.1). */
  /* The Judge's failures, its refusals of the model's own questions aside: those measured the model (VM5 review). */
  const judgeErrors = Math.max(0, (Number(end.jev?.errors) || 0) - (Number(end.jev?.refused) || 0));
  const answers = Number(end.console_usage?.llm_answers) || 0;
  const causes = events.filter((e) => e.type === 'proposal_failed').map((e) => failureCause(e, answers));
  const provider = causes.filter((c) => c === 'provider').length, unknown = causes.filter((c) => c === 'indeterminate').length;
  if (judgeErrors || provider) return { state: 'infra', solved: null, stopped_by: stoppedBy, policy_errors: policyErrors, advice, tokens, cause: 'provider',
    why: [judgeErrors ? judgeErrors + ' call(s) of the Judge failed' : '', provider ? provider + ' proposal(s) the service failed to answer' : ''].filter(Boolean).join('; ') + ': a failure of the providers, no measure' };
  if (unknown) return { state: 'infra', solved: null, stopped_by: stoppedBy, policy_errors: policyErrors, advice, tokens, cause: 'indeterminate',
    why: unknown + ' proposal(s) unanswered whose cause cannot be told (no answer of the service in this run to tell a slow candidate from a slow service): no measure' };
  const o1 = runResults(journalFile).o1_predictive_acceptance;
  /* A run that ended and left no finding cannot say what it reached: the harness's failure, no measure. */
  if (o1.model === null) return { state: 'infra', solved: null, stopped_by: stoppedBy, policy_errors: policyErrors, advice, tokens, cause: 'harness', why: 'it ended without its finding' };
  const solved = criterion === 'model_accepted' ? o1.model : o1.artifact ?? false;
  return { state: 'ended', solved, stopped_by: stoppedBy, policy_errors: policyErrors, advice, tokens,
    ...(causes.length ? { why: causes.length + ' proposal(s) not answered within the candidate\'s time while the service answered it: its own' } : {}) };
}

/** Whose failure a proposal_failed is: from the facts the runner records with it (its kind, its status), or - in a record
    written before them - from its error's words. A timeout is the candidate's only where the service answered in the run. */
function failureCause(e: J, answers: number): 'candidate' | 'provider' | 'indeterminate' {
  const words = String(e.error ?? '');
  const status = typeof e.status === 'number' ? e.status : Number(/HTTP (\d{3})/.exec(words)?.[1]) || null;
  const kind = typeof e.kind === 'string' ? e.kind
    : status !== null ? 'http' : /aborted after \d+ ms|did not finish within/i.test(words) ? 'timeout' : null;
  if (kind === 'timeout') return answers > 0 ? 'candidate' : 'indeterminate';
  /* A body read whole with no answer in it (no status: the service answered, the model said nothing) is the candidate's
     where the service answered the run, as a timeout is (VM1 review); a body that could not be read is the provider's. */
  if (kind === 'parse' && typeof e.status !== 'number' && !/HTTP \d{3}/.test(words)) return answers > 0 ? 'candidate' : 'indeterminate';
  if (kind === 'network' || kind === 'parse') return 'provider';
  if (kind === 'http' && status !== null && (status < 400 || [401, 402, 403, 408, 429].includes(status) || status >= 500)) return 'provider';
  return 'indeterminate';
}

/** Whether a record ran to its end (an end event in it), whatever its result. */
function endedRecord(journalFile: string): boolean {
  try { return ((JSON.parse(fs.readFileSync(journalFile, 'utf8')).events ?? []) as J[]).some((e) => e.type === 'end'); } catch { return false; }
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
    /* meta@2: its measure needs every trial ended (SPEC-VALIDEZ-MEDIDA §3.2); evaluations under "meta:" were measured by the
       rule before, and are verified by it. */
    return 'meta@2:' + this.manifest.id + ':' + manifestHash(this.manifest) + ':' + short(stableStringify(this.launcher.identity));
  }

  /** A policy with how its capture is made and its limits, as the manifest fixes them: named by the hash of all of it. A
      file of that name with other content is an error - two policies never share a file, one is never served for another. */
  private policyFile(policy: ResearchPolicy): { file: string; hash: string; legacy: string } {
    const config = { policy, ...(this.manifest.policy ?? {}) };
    const text = JSON.stringify(config, null, 2);
    const hash = short(stableStringify(config));
    const file = path.join(this.dir, 'policies', hash + '.json');
    if (!fs.existsSync(file)) fs.writeFileSync(file, text);
    else if (fs.readFileSync(file, 'utf8') !== text) throw new Error('policies/' + hash + '.json exists with other content than this policy: never served for it');
    return { file, hash, legacy: hashString(stableStringify(config)) };
  }

  /** A trial's identity: the manifest, the case, the repetition, the policy with its configuration, and the configuration its
      children really run with - the same trial is never run twice, another is never taken for it. */
  trialId(config: string, c: MetaCase, rep: number): string {
    return 't-' + short(stableStringify([manifestHash(this.manifest), c.id, rep, config, this.launcher.identity]));
  }
  /** The same trial's id in ledgers written before SHA-256. */
  private legacyTrialId(config: string, c: MetaCase, rep: number): string {
    return 't-' + hashString(stableStringify([legacyManifestHash(this.manifest), c.id, rep, config, this.launcher.identity]));
  }

  /** Where a trial's record is now: the latest of its first run, its continuations and its new attempts that exists, in the
      order the ledger made them (a launch that never made its record is an intention that failed, kept in the ledger -
      never a record), or null. */
  recordOf(id: string, ledger = this.ledger()): string | null {
    const chain = [path.join('trials', id + '.json'), ...ledger.filter((e) => (e.type === 'research_trial_resumed' || e.type === 'research_trial_retried') && e.trial === id).map((e) => String(e.out))];
    return chain.map((f) => path.join(this.dir, f)).filter((f) => fs.existsSync(f)).at(-1) ?? null;
  }

  /** Runs (or reconciles) every trial of a policy on the cases of a partition, in order; answers each result. It stops at
      a cancellation, and at a trial the fund cannot hold. */
  async run(policy: ResearchPolicy, partition: 'development' | 'confirmation', signal?: AbortSignal): Promise<{ trial: string; case: string; rep: number; kind: string; result: TrialResult }[]> {
    const errors = checkPolicy(policy);
    if (errors.length) throw new Error('the policy: ' + errors.join('; '));
    const { file, hash, legacy } = this.policyFile(policy);
    return this.runCandidate({ config: hash, legacyConfig: legacy, label: policyHash(policy), args: ['--researcher', 'assisted', '--research-policy', rel(this.dir, file)] }, partition, signal);
  }

  /** Every trial of a candidate on the cases of a partition, in order (`only`: those cases alone); the same reservations,
      ledger and reconciliation whatever the candidate is. */
  async runCandidate(candidate: TrialCandidate, partition: 'development' | 'confirmation' | 'training', signal?: AbortSignal, only?: ReadonlySet<string>): Promise<{ trial: string; case: string; rep: number; kind: string; result: TrialResult }[]> {
    const out: { trial: string; case: string; rep: number; kind: string; result: TrialResult }[] = [];
    const ledger = this.ledger();
    for (const c of this.manifest.cases.filter((x) => x.partition === partition && (!only || only.has(x.id)))) {
      for (let rep = 0; rep < (this.manifest.repetitions ?? 1); rep++) {
        /* A trial a ledger began before SHA-256 keeps its id there: continued under it, never begun again under the new one. */
        const legacy = this.legacyTrialId(candidate.legacyConfig ?? candidate.config, c, rep);
        const id = ledger.some((e) => e.type === 'research_trial_requested' && e.trial === legacy) ? legacy : this.trialId(candidate.config, c, rep);
        const result = await this.one(id, candidate, c, rep, signal);
        out.push({ trial: id, case: c.id, rep, kind: c.kind ?? c.lab, result });
        if (signal?.aborted || result.state === 'unfunded') return out;
      }
    }
    return out;
  }

  /** A trial: launched, reconciled, resumed or tried again until it ends, its retries are spent, the fund cannot hold it or
      it is cancelled. */
  private async one(id: string, candidate: TrialCandidate, c: MetaCase, rep: number, signal?: AbortSignal): Promise<TrialResult> {
    for (;;) {
      const { result, again } = await this.attempt(id, candidate, c, rep, signal);
      if (!again) return result;
    }
  }

  private async attempt(id: string, candidate: TrialCandidate, c: MetaCase, rep: number, signal?: AbortSignal): Promise<{ result: TrialResult; again: boolean }> {
    const policy = candidate.label, config = candidate.config;
    let ledger = this.ledger();
    const finished = ledger.find((e) => e.type === 'research_trial_finished' && e.trial === id && e.result.state === 'ended');
    if (finished) return { result: finished.result, again: false };
    const args = [...c.args, ...this.manifest.junior.args, ...candidate.args];
    const retries = this.manifest.infra_retries ?? DEFAULT_INFRA_RETRIES;
    const tried = ledger.filter((e) => e.type === 'research_trial_retried' && e.trial === id).length;
    /* A child with a record: its end read as it is (never run again), resumed from it where it was cut, or - where it ran to
       its end under a provider's failure, with nothing to resume - tried again under a record of its own, the one that fell
       kept (SPEC-VALIDEZ-MEDIDA §3.2). */
    const record = this.recordOf(id, ledger);
    let resume: string | undefined;
    let fresh = false;
    if (record) {
      /* A record under another configuration is another trial's: never taken as this one's result, never resumed into it. */
      const mismatch = configurationMismatch(record, this.launcher.identity);
      const r = trialResult(record, c.criterion);
      if (mismatch) {
        const infra: TrialResult = { ...r, state: 'infra', solved: null, why: mismatch, cause: 'harness' };
        this.write({ type: 'research_trial_finished', trial: id, record: rel(this.dir, record), result: infra, reconciled: true });
        return { result: infra, again: false };
      }
      if (r.state === 'ended') { this.write({ type: 'research_trial_finished', trial: id, record: rel(this.dir, record), result: r, reconciled: true }); return { result: r, again: false }; }
      if (r.state === 'infra' && endedRecord(record)) {
        if (tried >= retries) {
          /* Its retries spent: it stays as it fell, and nothing more is launched nor reserved for it. */
          const last = [...ledger].reverse().find((e) => e.type === 'research_trial_finished' && e.trial === id);
          if (last && last.record === rel(this.dir, record)) return { result: last.result, again: false };
          this.write({ type: 'research_trial_finished', trial: id, record: rel(this.dir, record), result: r, reconciled: true });
          return { result: r, again: false };
        }
        fresh = true;
      } else resume = record;
    }
    if (!ledger.some((e) => e.type === 'research_trial_requested' && e.trial === id))
      this.write({ type: 'research_trial_requested', trial: id, case: c.id, rep, policy, config, manifest: manifestHash(this.manifest), identity: this.launcher.identity,
        lab: c.lab, args, out: rel(this.dir, path.join(this.dir, 'trials', id + '.json')) });
    /* Its launch reserved from the fund before it is dispatched: what its junior may spend at most, and its Judge's calls. */
    ledger = this.ledger();
    const reserve = juniorMaxTokens(this.manifest), reserveJudge = juniorMaxJudgeCalls(this.manifest);
    const lacking = this.fund !== null && this.spent(ledger) + reserve > this.fund
      ? 'the fund for trials (' + this.fund + ' tokens) cannot hold its reserve (' + reserve + '): ' + this.spent(ledger) + ' spent or held'
      : this.judgeFund !== null && this.spent(ledger, 'judge_calls') + reserveJudge > this.judgeFund
        ? 'the fund for trials (' + this.judgeFund + ' calls of the Judge) cannot hold its reserve (' + reserveJudge + '): ' + this.spent(ledger, 'judge_calls') + ' made or held' : null;
    if (lacking) {
      const r: TrialResult = { state: 'unfunded', solved: null, stopped_by: null, policy_errors: 0, advice: 0, tokens: null, why: lacking };
      this.write({ type: 'research_trial_refused', trial: id, reason: r.why });
      return { result: r, again: false };
    }
    /* A continuation or a new attempt never written over a record: the next name free - one whose launch failed before it
       made its record keeps its intention in the ledger, and its name. */
    const outs = new Set(ledger.filter((e) => (e.type === 'research_trial_resumed' || e.type === 'research_trial_retried') && e.trial === id).map((e) => String(e.out)));
    let target = path.join(this.dir, 'trials', id + '.json');
    const resumed = ledger.filter((e) => e.type === 'research_trial_resumed' && e.trial === id).length;
    for (let k = (fresh ? tried : resumed) + 1; resume || fresh; k++) {
      target = path.join(this.dir, 'trials', id + (fresh ? '.a' : '.r') + k + '.json');
      if (!fs.existsSync(target) && !outs.has(rel(this.dir, target))) break;
    }
    if (fs.existsSync(target)) throw new Error('trial ' + id + ': ' + target + ' exists and is not what is resumed - nothing is written over a record');
    const launch = id + '#' + ledger.filter((e) => e.type === 'research_trial_reserved' && e.trial === id).length;
    this.write({ type: 'research_trial_reserved', trial: id, launch, tokens: reserve, judge_calls: reserveJudge });
    if (resume) this.write({ type: 'research_trial_resumed', trial: id, from: rel(this.dir, resume), out: rel(this.dir, target) });
    if (fresh) this.write({ type: 'research_trial_retried', trial: id, attempt: tried + 1, of: retries, from: rel(this.dir, record!), out: rel(this.dir, target) });
    let result: TrialResult;
    let journal = target;
    try {
      const connection = candidate.connect ? await candidate.connect({ trial: id, launch, ...(resume ? { resume } : {}) }) : undefined;
      journal = (await this.launcher.run({ lab: c.lab, args, out: target, ...(resume ? { resume } : {}), ...(signal ? { signal } : {}), ...(connection ? { connection } : {}) })).journal;
      result = trialResult(journal, c.criterion);
      /* Its child must have run with the configuration the trial is named by: another model is another trial. */
      const mismatch = configurationMismatch(journal, this.launcher.identity);
      if (mismatch) result = { ...result, state: 'infra', solved: null, why: mismatch, cause: 'harness' };
    } catch (e) { result = { state: 'infra', solved: null, stopped_by: null, policy_errors: 0, advice: 0, tokens: null, why: String((e as Error).message ?? e).slice(0, 300), cause: 'harness' }; }
    if (signal?.aborted && result.state !== 'ended') { const { cause: _cause, ...rest } = result; result = { ...rest, state: 'cancelled' }; }
    /* What this launch spent: the live tokens of its process and its Judge's live calls; unknown, what it held. */
    const live = liveTokens(journal), judged = liveJudgeCalls(journal);
    this.write({ type: 'research_trial_settled', trial: id, launch, tokens: live ?? reserve, judge_calls: judged ?? reserveJudge,
      ...(live === null || judged === null ? { unknown: [...(live === null ? ['tokens'] : []), ...(judged === null ? ['judge_calls'] : [])] } : {}) });
    this.write({ type: 'research_trial_finished', trial: id, record: rel(this.dir, journal), result });
    /* Ended under a failure that is not its own: tried again by the next attempt, which reads its retries. A launch that
       made no record, a cancellation or a child under a configuration not the trial's is not tried again here. */
    const again = result.state === 'infra' && !signal?.aborted && endedRecord(journal) && !configurationMismatch(journal, this.launcher.identity);
    return { result, again };
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
export function qualityOf(trials: readonly { kind: string; result: TrialResult }[]): { kinds: string[]; quality: (number | null)[]; correct: boolean; infra: number; infra_indeterminate: number; trials: number } {
  const kinds = [...new Set(trials.map((t) => t.kind))].sort();
  const quality = kinds.map((k) => {
    const said = trials.filter((t) => t.kind === k && t.result.state === 'ended');
    return said.length ? Math.round((1 - said.filter((t) => t.result.solved).length / said.length) * 1e6) / 1e6 : null;
  });
  return { kinds, quality, correct: trials.every((t) => t.result.policy_errors === 0), infra: trials.filter((t) => t.result.state === 'infra').length,
    infra_indeterminate: trials.filter((t) => t.result.state === 'infra' && t.result.cause === 'indeterminate').length, trials: trials.length };
}

/** An evaluation of a candidate from its trials: a measure only when every trial it needs ran to its end (SPEC-VALIDEZ-MEDIDA
    §3.2). One that fell in the infrastructure, was cut short by the fund or a cancellation, or was never reached leaves it
    incomplete: its correctness unchecked, no quality, never competing with complete ones. Leaving the trials that fell out
    of the denominator would reward a candidate whose hard trials fall - a selection on survivors a search exploits. */
export function measureOf(trials: readonly { kind: string; result: TrialResult }[], needed: number): { complete: boolean; correct: 'yes' | 'no' | 'unchecked'; quality: (number | null)[] | null; q: ReturnType<typeof qualityOf> } {
  const q = qualityOf(trials);
  const complete = trials.length >= needed && trials.every((t) => t.result.state === 'ended');
  return complete ? { complete, correct: q.correct ? 'yes' : 'no', quality: q.quality, q } : { complete, correct: 'unchecked', quality: null, q };
}

/** The measure evaluations under the "meta:" identity were taken with - trials that fell in the infrastructure left out of
    the denominator. Kept only to verify those records by the rule they were made under, never to measure. */
function legacyMeasureOf(trials: readonly { kind: string; result: TrialResult }[], needed: number): { correct: 'yes' | 'no' | 'unchecked'; quality: (number | null)[] | null } {
  const q = qualityOf(trials);
  const complete = trials.length >= needed && trials.every((t) => t.result.state !== 'unfunded' && t.result.state !== 'cancelled');
  return complete ? { correct: q.correct ? 'yes' : 'no', quality: q.quality } : { correct: 'unchecked', quality: null };
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
      /* The share of its trials that fell, with the evaluation (SPEC-VALIDEZ-MEDIDA §3.2): shares that differ between
         candidates more than chance would are the sign that a failure was attributed wrongly. */
      return { executable: true, correct: m.correct, quality: m.quality, descriptor: null,
        feedback: { kinds: q.kinds, quality: m.quality, ...(m.complete ? {} : { incomplete: true }), infra: q.infra, infra_indeterminate: q.infra_indeterminate,
          infra_rate: ran.length ? Math.round(q.infra / ran.length * 1e6) / 1e6 : null,
          trials: ran.map((t) => ({ case: t.case, rep: t.rep, state: t.result.state, solved: t.result.solved, advice: t.result.advice, policy_errors: t.result.policy_errors, ...(t.result.cause ? { cause: t.result.cause } : {}) })) },
        diagnostics: [...(m.complete ? [] : ['incomplete: ' + ran.filter((t) => t.result.state === 'ended').length + ' of its ' + needed + ' trials ran to their end (the rest fell in the infrastructure with their retries spent, the fund could not hold them, or a cancellation) - not a measure']),
          ...(q.correct ? [] : ['an output of the policy broke its contract']), ...(q.infra ? [q.infra + ' trial(s) failed in the infrastructure' + (q.infra_indeterminate ? ' (' + q.infra_indeterminate + ' of a cause that cannot be told)' : '') + ': they measure nothing, and the evaluation with them'] : [])],
        evaluator: identity,
        evidence: ran.map((t) => ({ trial: t.trial, case: t.case, rep: t.rep, kind: t.kind, result: t.result })) };
    }
  };
}

/** An evaluator that measures nothing, for a search over policies rebuilt from its record: its identity, contract and start
    as the record has them, its candidates made again by their content. */
export function recordedPolicyEvaluator(events: readonly J[], startFiles: Readonly<Record<string, string>>, start: string): Evaluator {
  const started = events.find((e) => e.type === 'search_started');
  /* A search recorded before policies were named by SHA-256 is rebuilt under the names it recorded. */
  const nameOf = /^[0-9a-f]{24}$/.test(start) ? policyHash : legacyPolicyHash;
  const candidateOf = (p: ResearchPolicy) => ({ hash: nameOf(p), files: { 'policy.json': JSON.stringify(p, null, 2) } });
  return {
    identity: async () => String(started?.evaluator ?? ''),
    contract: () => events.find((e) => e.type === 'attempt_planned')?.context?.task ?? null,
    start: () => ({ hash: start, files: startFiles }),
    validate: (files) => { const p = policyOfFiles(files); return typeof p === 'string' ? p : null; },
    materialize(_from, files) { const p = policyOfFiles(files); return typeof p === 'string' ? { error: p } : candidateOf(p); },
    adopt(hash, files) { const p = policyOfFiles(files); return typeof p === 'string' ? p : nameOf(p) === hash ? null : 'its content hashes to ' + nameOf(p); },
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
  /* A last line cut by a stop is no entry: read past it, as the ledger itself is. */
  const ledger: J[] = fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : [];
  const hash = manifestHash(manifest), legacyHash = legacyManifestHash(manifest);
  let decisions = 0, count = 0;
  const finished = new Map<string, J>();
  for (const e of ledger) if (e.type === 'research_trial_finished') finished.set(e.trial, e);
  const requested = new Set(ledger.filter((e) => e.type === 'research_trial_requested').map((e) => String(e.trial)));
  for (const e of ledger.filter((x) => x.type === 'research_trial_requested')) {
    count++;
    if (e.manifest !== hash && e.manifest !== legacyHash) { problems.push(e.trial + ': recorded under another manifest (' + e.manifest + '), not this one (' + hash + ')'); continue; }
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
    const read = mismatch ? { ...again, state: 'infra', solved: null, cause: 'harness' } : again;
    /* A result recorded before causes were told is compared without one. */
    const told = (r: J) => ({ ...r, why: undefined, cause: f.result.cause === undefined ? undefined : r.cause });
    if (stableStringify(told(read)) !== stableStringify(told(f.result))) problems.push(e.trial + ': its record says otherwise now');
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
      /* Each evaluation by the rule it was measured under: its evaluator's identity says which. */
      const again = String(e.result?.evaluator ?? '').startsWith('meta@2:') ? measureOf(e.evidence, trialsPerEvaluation(manifest)) : legacyMeasureOf(e.evidence, trialsPerEvaluation(manifest));
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
