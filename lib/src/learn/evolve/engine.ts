import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { cloneJson, stableStringify } from '../../core/hash.ts';
import { parseJsonLoose } from '../../core/net.ts';
import { dispatched, evaluated, initialState, markStale, next, register, responded, staleActive, type Evaluation, type Plan, type Profile, type SearchState } from './policy.ts';

/* ============================================================================
 * The engine of an evolutionary search (SPEC-DELEGACION-EVOLUTIVA §12-§13, §17): the policy's plans carried out as
 * effects - a mutator's answer, an evaluation - each with a stable id and an intention logged before it is dispatched,
 * its result applied once. The branch's record is its event log: replayed, it rebuilds every selection, context, quota
 * and the delivery without a model or a measure; resumed, what has a receipt is never asked or measured again, and a
 * call whose answer is not known is never dispatched again.
 * ========================================================================== */

/** The engine's version, part of a generator's identity (SPEC-DELEGACION-EVOLUTIVA §15). */
export const EVOLVE_ENGINE = 'native@1';

export interface Evaluator {
  /** What its measures depend on (task, workloads, environment): evidence of another identity is stale. */
  identity(): Promise<string>;
  /** What the mutator is told of the task: what the artifact does, its files, what may not change. */
  contract(): unknown;
  start(): { hash: string; files: Readonly<Record<string, string>> };
  /** Why a patch is refused (paths outside the artifact, too many files...), or null. */
  validate(files: Readonly<Record<string, string | null>>): string | null;
  materialize(from: string, files: Readonly<Record<string, string | null>>): { hash: string; files: Readonly<Record<string, string>> } | { error: string };
  /** A program known by its content (imported from a sealed search): made known to the evaluator, refused if its content
      does not hash to it. An evaluator judges content, never a hash it happens to know. */
  adopt(hash: string, files: Readonly<Record<string, string>>): string | null;
  evaluate(hash: string): Promise<Evaluation>;
}

/** A failure to get an answer at all (the network, the provider): the infrastructure's, never the program's. */
export class TransportFailure extends Error {}

export interface Mutator {
  propose(context: unknown, signal?: AbortSignal): Promise<{ text: string; tokens: number | null }>;
}

export type SearchEvent = Record<string, any> & { readonly type: string };

/** A seed (§8): a program from an authorized source - its id in the run's catalog, where it comes from, its content, and
    whether its source knew the target task. Materialized and measured again in the branch's laboratory, a root of its
    own lineage; what it scored elsewhere is never its evidence here. */
export interface Seed {
  readonly id: string;
  readonly source: 'requester' | 'experience' | 'search';
  readonly hash: string;
  readonly files: Readonly<Record<string, string>>;
  readonly knows_task: boolean;
}

export interface SearchLimits {
  readonly evaluations: number; readonly attempts: number; readonly tokens: number;
  /** Seconds of the machine its evaluations may take in all (each measured, and served from the record on a replay). */
  readonly machineSeconds?: number;
}

export interface SearchManifest {
  readonly format: 'evolution-search@1';
  readonly profile: Profile;
  readonly evaluator: string;
  readonly question: string;
  readonly state: SearchState;
  readonly events: string;
  readonly cost: Cost;
  /** What the searches it continues spent: kept apart, never charged again. */
  readonly inherited: Cost;
  readonly stoppedBy: string;
  readonly hash: string;
}

export interface Cost { readonly attempts: number; readonly evaluations: number; readonly tokens: number; readonly tokens_unknown: number; readonly machine_seconds?: number }

export interface SearchOptions {
  readonly evaluator: Evaluator;
  readonly mutator: Mutator;
  readonly profile: Profile;
  readonly question: string;
  readonly limits: SearchLimits;
  /** Where its events are written (the whole record, the replayed ones too). */
  readonly out: string;
  /** A record to rebuild from: answers and measures served from it by id, never asked again. */
  readonly recorded?: readonly SearchEvent[];
  /** Whether it may go on live once the record is used up (a resumption), or stops there (a verification). */
  readonly live?: boolean;
  /** A sealed search to continue from (§13.1): another branch, its state imported, its cost not charged again. */
  readonly continueFrom?: SearchManifest;
  /** Seeds to start from besides the start (§8). */
  readonly seeds?: readonly Seed[];
  /** The most a mutator's context may hold, in characters: a context that does not fit is refused, never cut (§7.2). */
  readonly maxContext?: number;
  /** When its time is up (the branch's wall time), and the clock: not checked when a record is only verified. */
  readonly deadline?: number;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
}

const sha = (v: unknown): string => createHash('sha256').update(stableStringify(v)).digest('hex').slice(0, 16);

/** The answer the mutator is asked for: the files it changes (whole), and why - a declaration, never taken as a fact. */
export const ANSWER_FORMAT = { files: { '<path>': '<the whole new text of the file, or null to remove it>' }, why: '<what you changed and what you expect of it>' };

/** What a mutator is given for a plan (§7.2): the task, the operator, and what the operator needs - a restart never the
    code of the dominant line. Fixed before the call, its hash recorded. */
export function contextOf(s: SearchState, plan: Plan, contract: unknown, question: string): Record<string, unknown> {
  const view = (h: string) => {
    const c = s.candidates[h];
    return { program: h, files: c.files, correct: c.evaluation?.correct ?? 'unchecked', quality: c.evaluation?.quality ?? null, stale: c.stale,
      measures: c.evaluation?.feedback ?? null, diagnostics: c.diagnostics.slice(-s.profile.diagnostics) };
  };
  const base = { task: contract, question, operator: plan.operator, answer_format: ANSWER_FORMAT,
    note: 'Why you change something is recorded as your declaration, not as a measured fact. Measures are of the exploration workloads only.' };
  const triedKey = (h: string) => plan.operator + ':' + [...(s.candidates[h]?.roots ?? [])].sort().join('+');
  switch (plan.operator) {
    case 'local': case 'rewrite':
      return { ...base, parent: view(plan.parents[0]), already_tried: s.tried[triedKey(plan.parents[0])] ?? [] };
    case 'repair':
      return { ...base, program: view(plan.parents[0]), keep: 'what the task requires of every answer (its contract): fix what fails, do not change what it answers where it is right' };
    case 'recombination':
      return { ...base, parents: plan.parents.map(view), note2: 'Combining them is not assumed to be better: take what the measures of each suggest.', already_tried: s.tried[triedKey(plan.parents[0])] ?? [] };
    case 'restart':
      return { ...base, fresh: 'Write a program from scratch for the task: no earlier program is shown to you.',
        ...(plan.recovery === 'generation' ? { recent_failures: s.generation.diagnostics.slice() } : {}) };
  }
}

/** A mutator's text as a patch: its files (each whole text or null), or why it is refused. */
export function parseAnswer(text: string): { files: Record<string, string | null>; why: string } | { invalid: string } {
  let v: unknown;
  try { v = parseJsonLoose(text); } catch { return { invalid: 'the answer is not JSON' }; }
  const files = (v as { files?: unknown })?.files;
  if (!files || typeof files !== 'object' || Array.isArray(files) || !Object.keys(files).length) return { invalid: 'the answer has no "files" object with at least one file' };
  for (const [k, x] of Object.entries(files as Record<string, unknown>)) if (typeof x !== 'string' && x !== null) return { invalid: 'file "' + k + '" is neither a text nor null' };
  return { files: files as Record<string, string | null>, why: String((v as { why?: unknown }).why ?? '') };
}

export async function runSearch(o: SearchOptions): Promise<{ manifest: SearchManifest; events: SearchEvent[] }> {
  const identity = await o.evaluator.identity();
  const events: SearchEvent[] = [];
  fs.writeFileSync(o.out, '');
  const log = (e: SearchEvent) => { events.push(e); fs.appendFileSync(o.out, JSON.stringify(e) + '\n'); };
  /* The record served by id: what was answered or measured, and what was planned (a plan without its answer is a call
     whose answer is not known). */
  const rec = new Map<string, SearchEvent[]>();
  for (const e of o.recorded ?? []) { const k = e.type + '|' + (e.attempt ?? e.evaluation ?? ''); rec.set(k, [...(rec.get(k) ?? []), e]); }
  const recorded = (type: string, id: string) => rec.get(type + '|' + id)?.[0];

  let state: SearchState;
  const inherited: Cost = o.continueFrom ? addCost(o.continueFrom.inherited, o.continueFrom.cost) : { attempts: 0, evaluations: 0, tokens: 0, tokens_unknown: 0 };
  if (o.continueFrom) {
    const m = o.continueFrom;
    if (m.format !== 'evolution-search@1') throw new Error('not a sealed search: ' + String((m as { format?: unknown }).format));
    if (stableStringify(m.profile) !== stableStringify(o.profile)) throw new Error('a search continues only with the same profile (' + m.profile.id + '); another one is a new search, from a start');
    if (sha({ ...m, hash: undefined }) !== m.hash) throw new Error('the sealed search does not hash to what it says: its content changed');
    state = cloneJson(m.state);
    for (const h of state.order) {
      const why = o.evaluator.adopt(h, state.candidates[h].files);
      if (why) throw new Error('the sealed search holds ' + h + ', which its evaluator cannot take: ' + why);
    }
  } else state = initialState(o.profile);
  log({ type: 'search_started', profile: o.profile, evaluator: identity, question: o.question, limits: o.limits, ...(o.continueFrom ? { continues: o.continueFrom.hash } : {}),
    ...(o.seeds?.length ? { seeds: o.seeds } : {}) });
  if (o.continueFrom && o.continueFrom.evaluator !== identity) log({ type: 'evidence_stale', from: o.continueFrom.evaluator, to: identity, candidates: markStale(state, identity) });

  const cost = { attempts: 0, evaluations: 0, tokens: 0, tokens_unknown: 0, machine_seconds: 0 };
  const verifying = Boolean(o.recorded) && !o.live;
  let evalSeq = 0, stoppedBy = '';
  const stop = (why: string) => { stoppedBy = why; };

  /* An evaluation: served from the record by id, or measured (a planned one without its result is simply measured: it
     changes nothing outside the branch). */
  const evaluate = async (hash: string, plan: Plan | null, reevaluation: boolean): Promise<boolean> => {
    if (cost.evaluations >= o.limits.evaluations) { stop('evaluations'); return false; }
    if (o.limits.machineSeconds !== undefined && cost.machine_seconds >= o.limits.machineSeconds) { stop('machine_seconds'); return false; }
    const id = 'evaluation:' + (++evalSeq) + (o.continueFrom ? '@' + o.continueFrom.hash : '');
    log({ type: 'evaluation_planned', evaluation: id, hash, reevaluation });
    cost.evaluations++;
    const done = recorded('evaluation', id);
    if (done && done.hash !== hash) throw new Error('replay diverged at ' + id + ': it evaluated ' + done.hash + ', now ' + hash);
    if (!done && o.recorded && !o.live) { stop('record_end'); return false; }
    const began = Date.now();
    const e: Evaluation = done ? done.result : await o.evaluator.evaluate(hash);
    const seconds = done ? Number(done.seconds) || 0 : (Date.now() - began) / 1000;
    cost.machine_seconds += seconds;
    log({ type: 'evaluation', evaluation: id, hash, result: e, seconds });
    evaluated(state, hash, e, { plan, reevaluation });
    return true;
  };

  if (!o.continueFrom) {
    const s = o.evaluator.start();
    register(state, { hash: s.hash, files: s.files, parents: [], origin: 'start', root: true });
    log({ type: 'candidate', origin: 'start', hash: s.hash, files: s.files, result: 'new' });
    await evaluate(s.hash, null, false);
  }

  /* Its seeds: each made known by its content (refused if it does not hash to what it says), a root of its own, measured
     here like any candidate - a seed already known (the start, or another seed) is not measured twice. */
  for (const seed of o.seeds ?? []) {
    if (stoppedBy) break;
    const why = o.evaluator.adopt(seed.hash, seed.files);
    if (why) { log({ type: 'seed_refused', seed: seed.id, hash: seed.hash, why }); continue; }
    const { duplicate } = register(state, { hash: seed.hash, files: seed.files, parents: [], origin: 'seed:' + seed.id, root: true });
    log({ type: 'candidate', origin: 'seed', seed: seed.id, source: seed.source, knows_task: seed.knows_task, hash: seed.hash, result: duplicate ? 'duplicate' : 'new', ...(duplicate ? {} : { files: seed.files }) });
    if (!duplicate) await evaluate(seed.hash, null, false);
  }

  while (!stoppedBy) {
    if (o.signal?.aborted) { stop('cancelled'); break; }
    if (cost.tokens >= o.limits.tokens) { stop('tokens'); break; }
    if (o.deadline !== undefined && !verifying && (o.now?.() ?? Date.now()) >= o.deadline) { stop('wall_time'); break; }
    /* Stale evidence the search would go on from is measured again first, in registration order. */
    const stale = staleActive(state);
    if (stale.length) { await evaluate(stale[0], null, true); continue; }
    if (cost.attempts >= o.limits.attempts) { stop('attempts'); break; }
    if (cost.evaluations >= o.limits.evaluations) { stop('evaluations'); break; }
    const plan = next(state);
    const context = contextOf(state, plan, o.evaluator.contract(), o.question);
    const contextHash = sha(context);
    const planned = recorded('attempt_planned', plan.attempt);
    if (planned && (planned.context_hash !== contextHash || stableStringify(planned.plan) !== stableStringify(plan))) {
      throw new Error('replay diverged at ' + plan.attempt + ': the policy planned otherwise than its record');
    }
    if (!planned && o.recorded && !o.live) { stop('record_end'); break; }
    log({ type: 'attempt_planned', attempt: plan.attempt, plan, context_hash: contextHash, context });
    dispatched(state, plan);
    cost.attempts++;
    /* A context too large is refused whole: a required file is never cut to make it fit. */
    if (o.maxContext && stableStringify(context).length > o.maxContext) {
      const why = 'its context does not fit (' + stableStringify(context).length + ' characters, at most ' + o.maxContext + '): refused, nothing cut';
      log({ type: 'candidate', attempt: plan.attempt, result: 'invalid', why });
      responded(state, plan, { kind: 'invalid', why });
      continue;
    }
    /* The answer: from the record, or asked - unless the record planned it and never saw its answer: then it is not
       known whether the call was made, and it is never made again. */
    const answered = recorded('attempt_answered', plan.attempt), failed = recorded('attempt_failed', plan.attempt);
    let answer: { text: string; tokens: number | null } | null = null;
    if (answered) answer = { text: answered.text, tokens: answered.tokens };
    else if (failed) { log(failed); responded(state, plan, { kind: 'transport', why: failed.why }); continue; }
    else if (planned) { log({ type: 'attempt_uncertain', attempt: plan.attempt }); responded(state, plan, { kind: 'uncertain' }); continue; }
    else {
      try { answer = await o.mutator.propose(context, o.signal); }
      catch (e) {
        if (o.signal?.aborted) { log({ type: 'attempt_uncertain', attempt: plan.attempt }); responded(state, plan, { kind: 'uncertain' }); stop('cancelled'); break; }
        const why = String((e as Error)?.message ?? e).slice(0, 200);
        log({ type: 'attempt_failed', attempt: plan.attempt, why, transport: e instanceof TransportFailure });
        responded(state, plan, { kind: 'transport', why });
        continue;
      }
    }
    log({ type: 'attempt_answered', attempt: plan.attempt, text: answer.text, tokens: answer.tokens });
    if (answer.tokens === null) cost.tokens_unknown++; else cost.tokens += answer.tokens;
    const parsed = parseAnswer(answer.text);
    const refused = 'invalid' in parsed ? parsed.invalid : o.evaluator.validate(parsed.files);
    if (refused || 'invalid' in parsed) {
      log({ type: 'candidate', attempt: plan.attempt, result: 'invalid', why: refused });
      responded(state, plan, { kind: 'invalid', why: refused! });
      continue;
    }
    const made = o.evaluator.materialize(plan.parents[0] ?? o.evaluator.start().hash, parsed.files);
    if ('error' in made) {
      log({ type: 'candidate', attempt: plan.attempt, result: 'invalid', why: made.error });
      responded(state, plan, { kind: 'invalid', why: made.error });
      continue;
    }
    const { duplicate } = register(state, { hash: made.hash, files: made.files, parents: plan.parents, origin: plan.attempt, root: plan.operator === 'restart' });
    log({ type: 'candidate', attempt: plan.attempt, hash: made.hash, result: duplicate ? 'duplicate' : 'new', ...(duplicate ? {} : { files: made.files, why: parsed.why }) });
    responded(state, plan, duplicate ? { kind: 'duplicate', hash: made.hash } : { kind: 'new', hash: made.hash });
    if (!duplicate) await evaluate(made.hash, plan, false);
  }
  const body = { format: 'evolution-search@1' as const, profile: o.profile, evaluator: identity, question: o.question, state: cloneJson(state),
    events: sha(events), cost, inherited, stoppedBy };
  const manifest: SearchManifest = { ...body, hash: sha(body) };
  log({ type: 'search_finished', stoppedBy, manifest: manifest.hash });
  return { manifest, events };
}

const addCost = (a: Cost, b: Cost): Cost => ({ attempts: a.attempts + b.attempts, evaluations: a.evaluations + b.evaluations, tokens: a.tokens + b.tokens, tokens_unknown: a.tokens_unknown + b.tokens_unknown,
  machine_seconds: (a.machine_seconds ?? 0) + (b.machine_seconds ?? 0) });
