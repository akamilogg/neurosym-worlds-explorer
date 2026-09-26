import { jsFunctionRunner } from './code-runner.ts';
import { checkFormula, compose, makeFormula } from './formula.ts';
import type { Evaluator, Evaluation } from './evaluate.ts';
import type { CodeRunner, Formula, MeasureDecl, Rule } from './types.ts';

/* ============================================================================
 * Predict: the same formula, used to PREDICT a vector instead of valuing a position.
 *
 *     â(s) = Σ_k  m_k(s) · d_k(s)
 *
 *   d_k(s)  a direction: code over what is perceived, returning [x, y] (normalised here)
 *   m_k(s)  a magnitude: V_k = Σ_i w_ik · r_ik(O(s)) ∈ [0,1], the familiar composition of the
 *           Judge's answers to rules that read observations, carried to the component's declared
 *           range, linearly or on a log scale (magnitudes may span several orders)
 *
 * Every component reads the SAME observations and the SAME rules: the Judge is asked once per
 * state, and each component composes the answers with its own weights. Nothing here knows a
 * world: the world supplies the states, what is perceived of them and the samples to test on.
 * ========================================================================== */

export type Vec2 = readonly [number, number];

export interface LawComponent {
  /** Code over the percept, `(p) => [x, y]`: which way this part of the prediction points. */
  readonly direction: { readonly kind: 'code'; readonly lang: string; readonly source: string };
  /** Weights over the law's rules (non-negative; the composition clamps to [0,1]). */
  readonly weights: Readonly<Record<string, number>>;
  /** Where V_k = 0 and V_k = 1 land. A log scale needs 0 < lo < hi. */
  readonly range: readonly [number, number];
  readonly scale: 'linear' | 'log';
  readonly definition?: string;
}

export interface Law {
  readonly world: string;
  readonly observations: Readonly<Record<string, MeasureDecl>>;
  readonly rules: Readonly<Record<string, Rule>>;
  readonly components: Readonly<Record<string, LawComponent>>;
}

export interface LawCheck { readonly ok: boolean; readonly errors: string[]; readonly warnings: string[] }

/** The formula the Evaluator asks the Judge with: every observation and every rule (the weights do not change what is
    asked, only how the answers compose). */
export function lawFormula(law: Law): Formula {
  const first = Object.values(law.components)[0];
  return makeFormula({ world: law.world, observations: law.observations, rules: law.rules, weights: first ? first.weights : {} });
}

export function checkLaw(law: Law): LawCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ids = Object.keys(law.components || {});
  if (!ids.length) errors.push('a law needs at least one component');
  const formula = checkFormula(lawFormula(law));
  errors.push(...formula.errors);
  warnings.push(...formula.warnings);
  for (const id of ids) {
    const c = law.components[id];
    if (!c.direction || c.direction.kind !== 'code' || !String(c.direction.source ?? '').trim()) errors.push('component "' + id + '": a direction needs code');
    const [lo, hi] = Array.isArray(c.range) ? c.range : [NaN, NaN];
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) errors.push('component "' + id + '": range must be [lo, hi] with hi > lo');
    else if (c.scale === 'log' && !(lo > 0)) errors.push('component "' + id + '": a log scale needs 0 < lo');
    if (c.scale !== 'linear' && c.scale !== 'log') errors.push('component "' + id + '": scale must be "linear" or "log"');
    const weights = Object.keys(c.weights || {});
    if (!weights.length) errors.push('component "' + id + '": it weighs no rule');
    for (const w of weights) if (!law.rules[w]) errors.push('component "' + id + '": weight "' + w + '" has no rule');
  }
  const weighed = new Set(ids.flatMap((id) => Object.keys(law.components[id].weights || {})));
  const idle = Object.keys(law.rules || {}).filter((r) => !weighed.has(r));
  if (idle.length) warnings.push('rule(s) no component weighs: ' + idle.join(', '));
  return { ok: errors.length === 0, errors, warnings };
}

/** Carry V ∈ [0,1] to the component's range. */
export function magnitudeOf(value: number, component: Pick<LawComponent, 'range' | 'scale'>): number {
  const v = Math.min(1, Math.max(0, value));
  const [lo, hi] = component.range;
  if (v === 0 || v === 1) return v === 0 ? lo : hi;
  return component.scale === 'log' ? Math.exp(Math.log(lo) + v * (Math.log(hi) - Math.log(lo))) : lo + v * (hi - lo);
}

export interface ComponentPrediction {
  readonly value: number;
  readonly magnitude: number;
  readonly direction: Vec2;
}

export interface Prediction {
  readonly vector: Vec2;
  readonly components: Readonly<Record<string, ComponentPrediction>>;
  readonly evaluation: Evaluation;
}

export class Predictor<S> {
  readonly evaluator: Evaluator<S>;
  private readonly perceive: (state: S) => unknown;
  private readonly runners = new Map<string, CodeRunner>();
  private readonly compiled = new Map<string, (p: unknown) => unknown>();

  /** `perceive` hands a direction's code what is perceived of a state: the same thing the observations' code reads. */
  constructor(evaluator: Evaluator<S>, perceive: (state: S) => unknown, options: { runners?: readonly CodeRunner[] } = {}) {
    this.evaluator = evaluator;
    this.perceive = perceive;
    for (const r of [jsFunctionRunner(), ...(options.runners ?? [])]) this.runners.set(r.lang, r);
  }

  /** A component's direction on what is perceived of a state (no Judge involved): to check a law before it is used. */
  directionOf(component: LawComponent, percept: unknown): Vec2 {
    const { lang, source } = component.direction;
    const key = lang + '|' + source;
    let fn = this.compiled.get(key);
    if (!fn) {
      const runner = this.runners.get(lang);
      if (!runner) throw new Error('no runner for language "' + lang + '"');
      fn = runner.compile(source) as unknown as (p: unknown) => unknown;
      this.compiled.set(key, fn);
    }
    const out = fn(percept) as unknown;
    const xy = Array.isArray(out) ? out : out && typeof out === 'object' ? [(out as { x?: unknown }).x, (out as { y?: unknown }).y] : [];
    const [x, y] = [Number(xy[0]), Number(xy[1])];
    const n = Math.hypot(x, y);
    if (!Number.isFinite(n) || n === 0) throw new Error('a direction must return a non-zero [x, y]');
    return [x / n, y / n];
  }

  async predict(law: Law, state: S, signal?: AbortSignal): Promise<Prediction> {
    const evaluation = await this.evaluator.eval(lawFormula(law), state, signal);
    const scalar: Record<string, number | undefined> = {};
    for (const id of Object.keys(evaluation.answers)) scalar[id] = evaluation.answers[id]?.value;
    const percept = this.perceive(state);
    const components: Record<string, ComponentPrediction> = {};
    let vector: Vec2 = [0, 0];
    for (const [id, c] of Object.entries(law.components)) {
      const value = compose(scalar, c.weights).value;
      const magnitude = magnitudeOf(value, c);
      const direction = this.directionOf(c, percept);
      components[id] = { value, magnitude, direction };
      vector = [vector[0] + magnitude * direction[0], vector[1] + magnitude * direction[1]];
    }
    return { vector, components, evaluation };
  }
}

/* --- Testing a law on samples ---------------------------------------------------- */

export interface PredictionSample<S> {
  readonly state: S;
  /** What was observed to happen (the world defines what a prediction is compared with). */
  readonly target: Vec2;
  /** Operator only: the same quantity without the noise of the perception. */
  readonly truth?: Vec2;
  /** e.g. 'view' / 'outer': errors are also reported per band. */
  readonly band?: string;
  /** A name the learner can cite (e.g. "launch3@12"). */
  readonly ref?: string;
}

export interface SampleResult {
  readonly ref?: string;
  readonly band?: string;
  readonly predicted: Vec2;
  readonly target: Vec2;
  /** |predicted - target| / |target|. */
  readonly error: number;
}

export interface TestResult {
  /** Relative RMS error over every sample: sqrt(Σ|p - t|² / Σ|t|²). 0 is perfect; predicting nothing scores 1. */
  readonly error: number;
  readonly byBand: Readonly<Record<string, number>>;
  /** The median of the per-sample errors: unlike the RMS, not dominated by the few samples with the largest targets. */
  readonly median: number;
  /** Operator only: the same error against the noise-free truth, when the samples carry it. */
  readonly truthError: number | null;
  /** Operator only: the error of the truth itself against what was observed - what a perfect law scores on these
      samples (the noise floor, in the same metric). */
  readonly floor: number | null;
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
export async function testPredictions<S>(samples: readonly PredictionSample<S>[], predict: (state: S) => Promise<Vec2> | Vec2): Promise<TestResult> {
  const results: SampleResult[] = [];
  const truthPairs: { predicted: Vec2; target: Vec2 }[] = [];
  const floorPairs: { predicted: Vec2; target: Vec2 }[] = [];
  const failed: { ref?: string; error: string }[] = [];
  for (const s of samples) {
    let predicted: Vec2;
    try { predicted = await predict(s.state); } catch (error) { failed.push({ ref: s.ref, error: String((error as Error)?.message ?? error) }); continue; }
    const size = Math.hypot(s.target[0], s.target[1]);
    results.push({ ref: s.ref, band: s.band, predicted, target: s.target,
      error: size > 0 ? Math.hypot(predicted[0] - s.target[0], predicted[1] - s.target[1]) / size : 0 });
    if (s.truth) { truthPairs.push({ predicted, target: s.truth }); floorPairs.push({ predicted: s.truth, target: s.target }); }
  }
  const bands = [...new Set(results.map((r) => r.band).filter((b): b is string => !!b))];
  return {
    error: relativeError(results),
    byBand: Object.fromEntries(bands.map((b) => [b, relativeError(results.filter((r) => r.band === b))])),
    median: median(results.map((r) => r.error)),
    truthError: truthPairs.length ? relativeError(truthPairs) : null,
    floor: floorPairs.length ? relativeError(floorPairs) : null,
    samples: results,
    failed
  };
}
