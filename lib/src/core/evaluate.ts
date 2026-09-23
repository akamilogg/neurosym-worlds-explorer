import { checkFormula, compose, formulaHash, judgmentHash, materializeRules, valueRuleIds } from './formula.ts';
import type { Observation, Observer } from './observer.ts';
import type { Formula, Judge, JudgeAnswer } from './types.ts';

/* ============================================================================
 * Eval(formula, s): the one pipeline every consumer uses.
 *
 *   state --Observer--> O(s) --Judge (Jev)--> r_i --compose (code)--> V(s)
 *
 * Judgments are cached under (judgmentHash, side to move, O(s) vector): two states
 * that measure the same are the same question to the Judge. The run of 21/09 shows
 * why this matters: 10 567 leaves were judged with 2 989 live calls.
 * ========================================================================== */

export type Provenance = 'live' | 'cached-vector';

export interface Evaluation {
  readonly value: number;
  readonly observation: Observation;
  readonly answers: Readonly<Record<string, JudgeAnswer>>;
  readonly fallbacks: readonly string[];
  readonly formulaHash: string;
  readonly judgmentHash: string;
  readonly provenance: Provenance;
}

export interface EvaluatorOptions {
  readonly cacheLimit?: number;
  /** Measures that fail make the evaluation fail (default). `false` lets the Judge see the gap. */
  readonly strictMeasures?: boolean;
}

export interface EvaluatorStats {
  evaluations: number;
  judgeCalls: number;
  vectorHits: number;
  fallbacks: number;
}

export class MeasurementError extends Error {
  readonly errors: Observation['errors'];
  constructor(errors: Observation['errors']) {
    super('the formula could not be measured on this state: ' + errors.map((e) => e.id + ': ' + e.error).join('; '));
    this.errors = errors;
  }
}

export class Evaluator<S = unknown> {
  readonly observer: Observer<S>;
  readonly judge: Judge;
  readonly stats: EvaluatorStats = { evaluations: 0, judgeCalls: 0, vectorHits: 0, fallbacks: 0 };
  private readonly cache = new Map<string, Record<string, JudgeAnswer>>();
  private readonly inflight = new Map<string, Promise<Record<string, JudgeAnswer>>>();
  private readonly options: EvaluatorOptions;

  constructor(observer: Observer<S>, judge: Judge, options: EvaluatorOptions = {}) {
    this.observer = observer;
    this.judge = judge;
    this.options = options;
  }

  async eval(formula: Formula, state: S, signal?: AbortSignal): Promise<Evaluation> {
    const check = checkFormula(formula);
    if (!check.ok) throw new Error('invalid formula: ' + check.errors.join('; '));
    if (formula.world !== this.observer.world.id) {
      throw new Error('formula learned in ' + formula.world + ' cannot be evaluated in ' + this.observer.world.id);
    }
    this.stats.evaluations++;
    const world = this.observer.world;
    const observation = this.observer.observe(state, formula.observations);
    if (observation.errors.length && this.options.strictMeasures !== false) throw new MeasurementError(observation.errors);

    const fHash = formulaHash(formula);
    const jHash = judgmentHash(formula);
    const side = world.toMove(state);
    const key = jHash + '|' + side + '|' + observation.vector;
    let provenance: Provenance = 'cached-vector';
    let answers = this.cache.get(key);
    if (answers) this.stats.vectorHits++;
    else {
      let pending = this.inflight.get(key);
      if (!pending) {
        provenance = 'live';
        const ids = valueRuleIds(formula);
        pending = this.judge.judge({
          world: world.id,
          rulesOfTheWorld: world.describeRules(),
          sideToMove: side,
          measurements: observation.values,
          questions: materializeRules(formula.rules, observation.values, ids),
          context: { judgment_hash: jHash }
        }, signal);
        this.inflight.set(key, pending);
        this.stats.judgeCalls++;
      } else this.stats.vectorHits++;
      try {
        answers = await pending;
      } finally {
        this.inflight.delete(key);
      }
      if (this.cache.size >= (this.options.cacheLimit ?? 20000)) {
        const oldest = this.cache.keys().next();
        if (!oldest.done) this.cache.delete(oldest.value);
      }
      this.cache.set(key, answers);
    }
    const scalar: Record<string, number | undefined> = {};
    for (const id of Object.keys(answers)) scalar[id] = answers[id]?.value;
    const composition = compose(scalar, formula.weights);
    this.stats.fallbacks += composition.fallbacks.length;
    return {
      value: composition.value, observation, answers, fallbacks: composition.fallbacks,
      formulaHash: fHash, judgmentHash: jHash, provenance
    };
  }
}
