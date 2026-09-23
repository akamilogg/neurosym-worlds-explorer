import { round } from './hash.ts';
import { checkFormula, compose, formulaHash, judgmentHash, materializeRules, policyRuleIds, valueRuleIds } from './formula.ts';
import { evaluationConfidence } from './jev.ts';
import { mergePolicyDistributions, type PolicyMerge } from './policy.ts';
import type { Observation } from './observer.ts';
import type { Formula, Judge, JudgeAnswer, JudgeRequest, MeasureDecl, Outcome, Rule, World } from './types.ts';

/** Anything that can measure O(s) in a world: the library's Observer, or a host's own measuring code. */
export interface ObserverLike<S> {
  readonly world: World<S>;
  observe(state: S, observations: Readonly<Record<string, MeasureDecl>>): Observation;
}

/** A live judgment the Evaluator just paid for (for host telemetry and logs). */
export interface JudgedEvent<S> {
  readonly kind: 'value' | 'policy';
  readonly key: string;
  readonly state: S;
  readonly request: JudgeRequest;
  readonly answers: Readonly<Record<string, JudgeAnswer>>;
  readonly latencyMs: number;
}

/* ============================================================================
 * Eval(formula, s): the one pipeline every consumer uses.
 *
 *   state --Observer--> O(s) --Judge (Jev)--> r_i --compose (code)--> V(s)
 *
 * A finished state is valued by the RULES (outcome), never by the Judge.
 * Judgments are cached under (judgmentHash, side to move, O(s) vector, context id):
 * two states that measure the same are the same question to the Judge. The run of
 * 21/09 shows why this matters: 10 567 leaves were judged with 2 989 live calls.
 * ========================================================================== */

export type Provenance = 'rules' | 'live' | 'cached-vector';

export interface Evaluation {
  /** V(s) for the maximizer, rounded to 4 decimals. */
  readonly value: number;
  readonly confidence: number | null;
  readonly observation: Observation;
  readonly answers: Readonly<Record<string, JudgeAnswer>>;
  readonly fallbacks: readonly string[];
  readonly formulaHash: string;
  readonly judgmentHash: string;
  readonly provenance: Provenance;
  readonly outcome: Outcome | null;
  /** The cache identity of the judgment (null for a finished state): hosts key their own memos on it. */
  readonly judgmentKey: string | null;
}

export interface EvaluatorOptions<S> {
  /** The actor V(s) is the value FOR (1 = this actor wins). Default: the world's first actor. */
  readonly maximizer?: string;
  /** Extra facts the Judge reads with every request (e.g. the opponent model). Its `id` joins the cache key:
      a judgment made against a different opponent is an answer about a different game. */
  readonly context?: (state: S) => { id: string; facts: Readonly<Record<string, unknown>> };
  readonly cacheLimit?: number;
  /** Measures that fail make the evaluation fail (default). `false` lets the Judge see the gap. */
  readonly strictMeasures?: boolean;
  /** Where judgments are kept (default: a private Map). A host passes its own to clear or inspect it. */
  readonly cache?: Map<string, Record<string, JudgeAnswer>>;
  /** Where merged policy priors are kept (default: a private Map). */
  readonly priorCache?: Map<string, PolicyMerge | null>;
  readonly onJudged?: (event: JudgedEvent<S>) => void;
}

export interface EvaluatorStats {
  evaluations: number;
  terminal: number;
  judgeCalls: number;
  vectorHits: number;
  fallbacks: number;
  priorCalls: number;
}

export class MeasurementError extends Error {
  readonly errors: Observation['errors'];
  constructor(errors: Observation['errors']) {
    super('the formula could not be measured on this state: ' + errors.map((e) => e.id + ': ' + e.error).join('; '));
    this.errors = errors;
  }
}

export function defaultTerminalValue(world: World<any, any>, outcome: Outcome, maximizer: string): number {
  if (world.terminalValue) return world.terminalValue(outcome, maximizer);
  if (outcome.winner === maximizer) return 1;
  if (outcome.winner !== null && world.actors.includes(outcome.winner)) return 0;
  return 0.5;
}

const clock = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class Evaluator<S = unknown> {
  readonly observer: ObserverLike<S>;
  readonly judge: Judge;
  readonly maximizer: string;
  readonly stats: EvaluatorStats = { evaluations: 0, terminal: 0, judgeCalls: 0, vectorHits: 0, fallbacks: 0, priorCalls: 0 };
  private readonly cache: Map<string, Record<string, JudgeAnswer>>;
  private readonly inflight = new Map<string, Promise<Record<string, JudgeAnswer>>>();
  private readonly priors: Map<string, PolicyMerge | null>;
  private readonly options: EvaluatorOptions<S>;

  constructor(observer: ObserverLike<S>, judge: Judge, options: EvaluatorOptions<S> = {}) {
    this.observer = observer;
    this.judge = judge;
    this.options = options;
    this.cache = options.cache ?? new Map();
    this.priors = options.priorCache ?? new Map();
    this.maximizer = options.maximizer ?? observer.world.actors[0];
  }

  get world(): World<S> { return this.observer.world; }

  /** Forget every judgment (e.g. the opponent changed: a new measurement world). */
  reset(): void {
    this.cache.clear();
    this.priors.clear();
  }

  private assertUsable(formula: Formula): void {
    const check = checkFormula(formula);
    if (!check.ok) throw new Error('invalid formula: ' + check.errors.join('; '));
    if (formula.world !== this.world.id) throw new Error('formula learned in ' + formula.world + ' cannot be evaluated in ' + this.world.id);
  }

  private remember(key: string, answers: Record<string, JudgeAnswer>): void {
    if (this.cache.size >= (this.options.cacheLimit ?? 20000)) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(key, answers);
  }

  private async ask(key: string, kind: 'value' | 'policy', state: S, request: JudgeRequest, signal?: AbortSignal): Promise<{ answers: Record<string, JudgeAnswer>; live: boolean }> {
    const cached = this.cache.get(key);
    if (cached) { this.stats.vectorHits++; return { answers: cached, live: false }; }
    let pending = this.inflight.get(key);
    const live = !pending;
    if (!pending) {
      const started = clock();
      pending = this.judge.judge(request, signal).then((answers) => {
        this.options.onJudged?.({ kind, key, state, request, answers, latencyMs: Math.round(clock() - started) });
        return answers;
      });
      this.inflight.set(key, pending);
      this.stats.judgeCalls++;
    } else this.stats.vectorHits++;
    try {
      const answers = await pending;
      this.remember(key, answers);
      return { answers, live };
    } finally {
      if (live) this.inflight.delete(key);
    }
  }

  async eval(formula: Formula, state: S, signal?: AbortSignal): Promise<Evaluation> {
    this.assertUsable(formula);
    this.stats.evaluations++;
    const world = this.world;
    const observation = this.observer.observe(state, formula.observations);
    const fHash = formulaHash(formula);
    const jHash = judgmentHash(formula);
    const outcome = world.outcome(state);
    if (outcome.over) {
      this.stats.terminal++;
      return { value: defaultTerminalValue(world, outcome, this.maximizer), confidence: 1, observation, answers: {}, fallbacks: [],
        formulaHash: fHash, judgmentHash: jHash, provenance: 'rules', outcome, judgmentKey: null };
    }
    if (observation.errors.length && this.options.strictMeasures !== false) throw new MeasurementError(observation.errors);
    const side = world.toMove(state);
    const context = this.options.context ? this.options.context(state) : { id: '', facts: {} };
    const ids = valueRuleIds(formula);
    const key = jHash + '|' + side + '|' + context.id + '|' + observation.vector;
    const { answers, live } = await this.ask(key, 'value', state, {
      world: world.id,
      rulesOfTheWorld: world.describeRules(),
      sideToMove: side,
      measurements: observation.values,
      questions: materializeRules(formula.rules, observation.values, ids),
      ...(observation.errors.length ? { measurementErrors: observation.errors.map((e) => e.id + ': ' + e.error) } : {}),
      context: { ...context.facts, judgment_hash: jHash }
    }, signal);
    const scalar: Record<string, number | undefined> = {};
    for (const id of Object.keys(answers)) scalar[id] = answers[id]?.value;
    const composition = compose(scalar, formula.weights);
    this.stats.fallbacks += composition.fallbacks.length;
    return {
      value: round(composition.value, 4), confidence: evaluationConfidence(answers, formula.rules), observation, answers,
      fallbacks: composition.fallbacks, formulaHash: fHash, judgmentHash: jHash, provenance: live ? 'live' : 'cached-vector', outcome: null,
      judgmentKey: key
    };
  }

  /** The Judge's merged distribution over the legal actions of `state`, or null when the formula declares
      no policy rule that applies to the side to move. Orders a search; never removes an action. */
  async prior(formula: Formula, state: S, signal?: AbortSignal): Promise<PolicyMerge | null> {
    this.assertUsable(formula);
    const policyIds = policyRuleIds(formula);
    if (!policyIds.length) return null;
    const world = this.world;
    const context = this.options.context ? this.options.context(state) : { id: '', facts: {} };
    const jHash = judgmentHash(formula);
    const memo = jHash + '|' + world.key(state) + '|' + context.id;
    if (this.priors.has(memo)) return this.priors.get(memo)!;
    if (world.outcome(state).over) { this.priors.set(memo, null); return null; }
    const side = world.toMove(state);
    const observation = this.observer.observe(state, formula.observations);
    const questions: Record<string, Rule> = materializeRules(formula.rules, observation.values, valueRuleIds(formula));
    for (const id of policyIds) {
      const rule = formula.rules[id];
      const subject = rule.subject ?? 'side_to_move';
      const actor = subject === 'side_to_move' ? side : subject;
      if (subject !== 'side_to_move' && actor !== side) continue;
      const actions = world.actions(state, actor);
      if (!actions.length) continue;
      const criteria: Record<string, null> = {};
      for (const a of actions) criteria[world.actionKey(a)] = null;
      questions[id] = { ...materializeRules({ [id]: rule }, observation.values)[id], type: 'choice', criteria };
    }
    if (!Object.keys(questions).some((id) => policyIds.includes(id))) { this.priors.set(memo, null); return null; }
    this.stats.priorCalls++;
    const { answers } = await this.ask(memo + '|policy', 'policy', state, {
      world: world.id, rulesOfTheWorld: world.describeRules(), sideToMove: side,
      measurements: observation.values, questions,
      ...(observation.errors.length ? { measurementErrors: observation.errors.map((e) => e.id + ': ' + e.error) } : {}),
      position: world.describeState ? world.describeState(state, context.facts) : { view: observation.view },
      context: { ...context.facts, judgment_hash: jHash }
    }, signal);
    const weighted = policyIds.some((id) => formula.rules[id].aggregate === 'weighted_mean');
    const merge = mergePolicyDistributions(policyIds.map((id) => answers[id]?.distribution ? { id, distribution: answers[id].distribution! } : null),
      weighted ? 'weighted_mean' : 'single', formula.policy_weights);
    this.priors.set(memo, merge);
    return merge;
  }
}
