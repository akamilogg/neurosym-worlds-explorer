import { checkFormula, makeFormula } from './formula.ts';
import type { Evaluator, Evaluation } from './evaluate.ts';
import { OutputRunner, outputInputs, outputObservations, type OutputResult } from './output.ts';
import type { CodeRunner, CodeSpec, Formula, MeasureDecl, Rule } from './types.ts';

/* ============================================================================
 * Predict: the same model, used to ANSWER with a prediction instead of valuing a position.
 *
 *     V(s)   = Σ_i w_i · r_i(O(s))
 *     answer = output(p, { observations: O(s), rules: r_i, V })      (core/output.ts)
 *
 * A law is a model like any other: observations in code, rules the Judge answers from
 * them, weights over the rules, and optional output code. Nothing here imposes a shape
 * on the prediction (no directions, no magnitudes, no ranges): the learner builds it.
 * The WORLD says what an answer means - `answer` turns it into what is compared with what
 * happened (e.g. "the next value" into its departure from repeating the last step).
 *
 * The Judge is asked once per state, with every observation and every rule. Nothing
 * here knows a world: the world supplies the states, what is perceived of them, the
 * meaning of an answer and the samples to test on.
 * ========================================================================== */

export type Vec2 = readonly [number, number];

export type { CodeSpec };

export interface Law {
  readonly world: string;
  readonly observations: Readonly<Record<string, MeasureDecl>>;
  readonly rules: Readonly<Record<string, Rule>>;
  /** Weights over the rules: V(s) = Σ w_i r_i. */
  readonly weights: Readonly<Record<string, number>>;
  /** Optional code `(p, m) => answer`; without it the answer is V(s). */
  readonly output?: CodeSpec;
}

export interface LawCheck { readonly ok: boolean; readonly errors: string[]; readonly warnings: string[] }

/** The formula the Evaluator asks the Judge with: every observation and every rule, and the weights (V). The output
    runs after it, in the Predictor. */
export function lawFormula(law: Law): Formula {
  return makeFormula({ world: law.world, observations: law.observations, rules: law.rules, weights: law.weights });
}

/** Does the law ask the Judge? (No rules: it is code only, and the Judge is never consulted.) */
export const asksJudge = (law: Law): boolean => Object.keys(law.rules || {}).length > 0;

export function checkLaw(law: Law): LawCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!asksJudge(law) && !law.output) errors.push('a model needs rules or an output');
  if (asksJudge(law)) {
    const formula = checkFormula(lawFormula(law));
    errors.push(...formula.errors);
    warnings.push(...formula.warnings);
  }
  if (law.output && (law.output.kind !== 'code' || !String(law.output.source ?? '').trim())) errors.push('output needs code: (p, m) => answer');
  return { ok: errors.length === 0, errors, warnings };
}

export interface Prediction {
  /** What is compared with what happened (the world's reading of the answer). */
  readonly vector: Vec2;
  /** The model's answer, as it gave it. */
  readonly answer: unknown;
  /** Named intermediate values its output chose to show. */
  readonly parts: Readonly<Record<string, unknown>>;
  readonly observations: Readonly<Record<string, number | string>>;
  readonly rules: Readonly<Record<string, number>>;
  readonly V: number | null;
  /** The Judge's evaluation; null when the law has no rules, or its output read none of them (the Judge was not asked). */
  readonly evaluation: Evaluation | null;
}

/** An answer that is a pair of numbers: [x, y] (or { x, y }). */
export function pairOf(answer: unknown): Vec2 {
  const xy = Array.isArray(answer) ? answer : answer && typeof answer === 'object' ? [(answer as { x?: unknown }).x, (answer as { y?: unknown }).y] : [];
  const [x, y] = [Number(xy[0]), Number(xy[1])];
  if (!Number.isFinite(x) || !Number.isFinite(y) || xy.length < 2) throw new Error('the answer must be a pair of numbers [x, y] (it was ' + JSON.stringify(answer) + ')');
  return [x, y];
}

export interface Measured<S = unknown> {
  readonly state: S;
  readonly percept: unknown;
  readonly values: Readonly<Record<string, number>>;
  readonly texts: Readonly<Record<string, string>>;
}

export class Predictor<S> {
  readonly evaluator: Evaluator<S>;
  private readonly perceive: (state: S) => unknown;
  private readonly outputs: OutputRunner;
  private readonly toCompared: (answer: unknown, state: S, percept: unknown) => Vec2;

  /** `perceive` hands the output code what is perceived of a state: the same thing the observations' code reads.
      `answer` turns a model's answer into what is compared with what happened (default: the answer is that pair). */
  constructor(evaluator: Evaluator<S>, perceive: (state: S) => unknown,
    options: { runners?: readonly CodeRunner[]; answer?: (answer: unknown, state: S, percept: unknown) => Vec2 } = {}) {
    this.evaluator = evaluator;
    this.perceive = perceive;
    this.outputs = new OutputRunner(options.runners ?? []);
    this.toCompared = options.answer ?? ((a) => pairOf(a));
  }

  /** What a law's observations measure at a state, and what is perceived there: once, for answers without the Judge. */
  measured(law: Law, state: S): Measured<S> {
    const o = this.evaluator.observer.observe(state, law.observations);
    if (o.errors.length) throw new Error('an observation failed: ' + o.errors.map((e) => e.id + ': ' + e.error).join(' | '));
    return { state, percept: this.perceive(state), values: o.values, texts: o.texts };
  }

  /** The law's answer with GIVEN rule answers instead of the Judge's (an ablation), read as what is compared. */
  answerWith(law: Law, m: Measured<S>, rules: Readonly<Record<string, number>>): Vec2 {
    let V: number | null = null;
    if (asksJudge(law)) {
      V = 0;
      for (const [id, w] of Object.entries(law.weights)) V += w * Math.min(1, Math.max(0, rules[id] ?? 0.5));
      V = Math.min(1, Math.max(0, V));
    }
    const inputs = outputInputs(m.values, m.texts, rules, V);
    const answer = law.output ? this.outputs.run(law.output, m.percept, inputs).answer : V;
    return this.toCompared(answer, m.state, m.percept);
  }

  /** `measure`: observations to hand the output instead of the law's own (an ablation: the Judge reads something else,
      the output still reads what the learner measured). */
  async predict(law: Law, state: S, options: { signal?: AbortSignal; measure?: Readonly<Record<string, MeasureDecl>>; askRules?: boolean } = {}): Promise<Prediction> {
    const percept = this.perceive(state);
    /* An output that reads none of the rules answers alone: the Judge is not asked questions nobody reads. */
    if (law.output && asksJudge(law) && !options.askRules) {
      const o = this.evaluator.observer.observe(state, options.measure ?? law.observations);
      if (o.errors.length) throw new Error('an observation failed: ' + o.errors.map((e) => e.id + ': ' + e.error).join(' | '));
      const observations = outputObservations(o.values, o.texts ?? {});
      const alone = this.outputs.runIfJudgeUnread(law.output, percept, observations);
      if (alone) {
        this.evaluator.stats.judgeUnread++;
        return { vector: this.toCompared(alone.answer, state, percept), answer: alone.answer, parts: alone.parts,
          observations, rules: {}, V: null, evaluation: null };
      }
    }
    let evaluation: Evaluation | null = null;
    let values: Readonly<Record<string, number>> = {}, texts: Readonly<Record<string, string>> = {};
    const rules: Record<string, number | undefined> = {};
    let V: number | null = null;
    if (asksJudge(law)) {
      evaluation = await this.evaluator.eval(lawFormula(law), state, options.signal);
      ({ values, texts } = evaluation.observation);
      for (const id of Object.keys(evaluation.answers)) rules[id] = evaluation.answers[id]?.value;
      V = evaluation.value;
    }
    if (!asksJudge(law) || options.measure) {
      const o = this.evaluator.observer.observe(state, options.measure ?? law.observations);
      if (o.errors.length) throw new Error('an observation failed: ' + o.errors.map((e) => e.id + ': ' + e.error).join(' | '));
      ({ values, texts } = o);
    }
    const inputs = outputInputs(values, texts, rules, V);
    const out: OutputResult = law.output ? this.outputs.run(law.output, percept, inputs) : { answer: V, parts: {} };
    return { vector: this.toCompared(out.answer, state, percept), answer: out.answer, parts: out.parts,
      observations: inputs.observations, rules: inputs.rules, V, evaluation };
  }
}

/* --- Testing a law on samples ---------------------------------------------------- */

export interface PredictionSample<S> {
  readonly state: S;
  /** What was observed to happen (the world defines what a prediction is compared with). */
  readonly target: Vec2;
  /** Operator only: the same quantity without the noise of the perception. */
  readonly truth?: Vec2;
  /** Operator only: what the hidden law itself predicts here (it can differ from the truth when the target is not
      exactly what the law describes - e.g. a quantity over a whole interval, against a law at an instant). */
  readonly reference?: Vec2;
  /** e.g. 'view' / 'outer': errors are also reported per band. */
  readonly band?: string;
  /** A name the learner can cite (e.g. "launch3@12"). */
  readonly ref?: string;
  /** Which group the sample belongs to (e.g. the setup it was observed in), for criteria that must hold in each. */
  readonly group?: string;
}

export interface SampleResult {
  readonly ref?: string;
  readonly band?: string;
  readonly group?: string;
  readonly predicted: Vec2;
  readonly target: Vec2;
  /** |predicted - target| / |target|. */
  readonly error: number;
  /** The environment's verdict at this point, per axis: tanh((target - predicted) / |target|), in [-1, 1]. 0 means no
      difference along that axis; ±1 a miss as large as what happened, or larger. Relative to what happened at the point,
      so a point far away, where little happens, weighs as much as one close in. */
  readonly score: Vec2;
}

/** The per-point, per-axis verdict of a prediction against what happened. */
export function scoreOf(predicted: Vec2, target: Vec2): Vec2 {
  const size = Math.hypot(target[0], target[1]) || 1e-300;
  return [Math.tanh((target[0] - predicted[0]) / size), Math.tanh((target[1] - predicted[1]) / size)];
}

/** Quadratic mean of per-point scores (the length of each score vector): 0 when every point agreed. Operator side. */
export function scoreRms(scores: readonly Vec2[]): number {
  return scores.length ? Math.sqrt(scores.reduce((n, s) => n + s[0] ** 2 + s[1] ** 2, 0) / scores.length) : 0;
}

export interface TestResult {
  /** Relative RMS error over every sample: sqrt(Σ|p - t|² / Σ|t|²). 0 is perfect; predicting nothing scores 1. */
  readonly error: number;
  readonly byBand: Readonly<Record<string, number>>;
  /** The median of the per-sample errors: unlike the RMS, not dominated by the few samples with the largest targets. */
  readonly median: number;
  /** Operator only: the same error against the noise-free truth, when the samples carry it. */
  readonly truthError: number | null;
  /** Operator only: the error of the truth itself against what was observed - the noise floor, in the same metric. */
  readonly floor: number | null;
  /** Operator only: the error of the hidden law itself against what was observed, on the same samples. */
  readonly reference: number | null;
  /** Operator only: the quadratic mean of the per-point scores - of the law, of the hidden law, of the noise-free truth -
      overall and per band. Every point weighs the same, near or far. */
  readonly scores: { readonly law: number; readonly reference: number | null; readonly floor: number | null;
    readonly byBand: Readonly<Record<string, { law: number; reference: number | null; floor: number | null }>> };
  /** When the noise of what is observed is given (a variance per component, estimated from observables): the median over
      points of |observed - predicted|² / (2 (σ² + (ε |observed|)²)), overall and per band, ε a declared relative
      precision. About 1 or less when what is left is noise and the declared precision; a law off by more lies well
      above. Null without a noise estimate. */
  readonly chi2: { readonly median: number; readonly byBand: Readonly<Record<string, number>>;
    /** Per group (e.g. setup), per band. */
    readonly byGroup: Readonly<Record<string, Readonly<Record<string, number>>>> } | null;
  readonly samples: readonly SampleResult[];
  /** Samples whose prediction failed (a measure or a direction that threw), with the reason. */
  readonly failed: readonly { ref?: string; error: string }[];
}

export function relativeError(pairs: readonly { predicted: Vec2; target: Vec2 }[]): number {
  let err = 0, size = 0;
  for (const { predicted: p, target: t } of pairs) {
    err += (p[0] - t[0]) ** 2 + (p[1] - t[1]) ** 2;
    size += t[0] ** 2 + t[1] ** 2;
  }
  return size > 0 ? Math.sqrt(err / size) : 0;
}

function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Run a predictor (a law's, or an ablation's plain function) over samples. */
export async function testPredictions<S>(samples: readonly PredictionSample<S>[], predict: (state: S) => Promise<Vec2> | Vec2,
  options: { noiseVariance?: number; relativePrecision?: number } = {}): Promise<TestResult> {
  const results: SampleResult[] = [];
  const truthPairs: { predicted: Vec2; target: Vec2 }[] = [];
  const floorPairs: { predicted: Vec2; target: Vec2 }[] = [];
  const referencePairs: { predicted: Vec2; target: Vec2 }[] = [];
  const scored: PredictionSample<S>[] = [];
  const failed: { ref?: string; error: string }[] = [];
  for (const s of samples) {
    let predicted: Vec2;
    try { predicted = await predict(s.state); } catch (error) { failed.push({ ref: s.ref, error: String((error as Error)?.message ?? error) }); continue; }
    const size = Math.hypot(s.target[0], s.target[1]);
    results.push({ ref: s.ref, band: s.band, group: s.group, predicted, target: s.target,
      error: size > 0 ? Math.hypot(predicted[0] - s.target[0], predicted[1] - s.target[1]) / size : 0, score: scoreOf(predicted, s.target) });
    scored.push(s);
    if (s.truth) { truthPairs.push({ predicted, target: s.truth }); floorPairs.push({ predicted: s.truth, target: s.target }); }
    if (s.reference) referencePairs.push({ predicted: s.reference, target: s.target });
  }
  const bands = [...new Set(results.map((r) => r.band).filter((b): b is string => !!b))];
  const scoresOf = (idx: number[]) => ({
    law: scoreRms(idx.map((i) => results[i].score)),
    reference: idx.every((i) => scored[i].reference) && idx.length ? scoreRms(idx.map((i) => scoreOf(scored[i].reference!, scored[i].target))) : null,
    floor: idx.every((i) => scored[i].truth) && idx.length ? scoreRms(idx.map((i) => scoreOf(scored[i].truth!, scored[i].target))) : null
  });
  const all = results.map((_, i) => i);
  return {
    error: relativeError(results),
    byBand: Object.fromEntries(bands.map((b) => [b, relativeError(results.filter((r) => r.band === b))])),
    median: median(results.map((r) => r.error)),
    truthError: truthPairs.length ? relativeError(truthPairs) : null,
    floor: floorPairs.length ? relativeError(floorPairs) : null,
    reference: referencePairs.length ? relativeError(referencePairs) : null,
    scores: { ...scoresOf(all), byBand: Object.fromEntries(bands.map((b) => [b, scoresOf(all.filter((i) => results[i].band === b))])) },
    chi2: options.noiseVariance && options.noiseVariance > 0 ? (() => {
      const eps = options.relativePrecision ?? 0;
      const chi = (r: SampleResult) => ((r.target[0] - r.predicted[0]) ** 2 + (r.target[1] - r.predicted[1]) ** 2) /
        (2 * (options.noiseVariance! + (eps * Math.hypot(r.target[0], r.target[1])) ** 2));
      const groups = [...new Set(results.map((r) => r.group).filter((g): g is string => !!g))];
      const perBand = (rs: SampleResult[]) => Object.fromEntries(bands.filter((b) => rs.some((r) => r.band === b)).map((b) => [b, median(rs.filter((r) => r.band === b).map(chi))]));
      return { median: median(results.map(chi)), byBand: perBand(results), byGroup: Object.fromEntries(groups.map((g) => [g, perBand(results.filter((r) => r.group === g))])) };
    })() : null,
    samples: results,
    failed
  };
}
