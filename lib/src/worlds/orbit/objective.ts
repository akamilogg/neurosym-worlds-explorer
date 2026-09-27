import { testPredictions, type PredictionSample, type TestResult, type Vec2 } from '../../core/predict.ts';
import type { AnswerForm, CaseContext, Objective, Place } from '../../learn/objective.ts';
import type { OrbitPoint } from './predict.ts';

/* ============================================================================
 * orbit@1's objective (SPEC-OBJETIVO §4): a task of PREDICTING.
 *
 *   answer     at any row, the pair the last pair of columns will show in the next row
 *   cases      points of launches never seen, in view and beyond it, in each place
 *   verdict    per point and per axis, tanh((observed - predicted) / |observed|)
 *   holds      in each band, the median over the place's points of
 *              |observed d - predicted d|² / (2 (σ² + (ε|d|)²)) is at most `accept`, and no
 *              point threw. σ² is estimated from observables only (the sources do not move:
 *              the second differences of their columns are pure noise), pooled over the
 *              places run together; ε is the declared precision. Never the hidden law.
 *   regression (optional) the previous check's points, predicted again with the new model,
 *              must hold by the same criterion.
 *
 * The launches are drawn and kept by the host; the objective compares and judges. What
 * the hidden law would have scored is the operator's, in the journal only.
 * ========================================================================== */

export const ORBIT_ANSWER: AnswerForm = {
  form: ['YOUR ANSWER, at any row of any episode: the pair [x, y] the LAST pair of columns will show in the NEXT row, in the units of the table.'],
  use: 'predict'
};

/** The verdict's form; with the paired regression, what System 2 learns of it. */
export function orbitVerdict(options: { regression?: boolean } = {}): string[] {
  return ['A VERDICT is a pair of numbers from -1 to 1, one per column of the pair (x, then y); 0 on one means no difference in it between your answer and what happened there. What the rest of the range means is for you to work out.',
    ...(options.regression ? ['The points of your previous check in a laboratory are also answered again there by this model: you learn whether your model still holds on them.'] : [])];
}

/** The points of a place's check, and the noise estimated from what is observed there (a variance, with its weight). */
export interface OrbitCases {
  readonly samples: readonly PredictionSample<OrbitPoint>[];
  readonly noise: readonly { readonly variance: number; readonly weight: number }[];
}

/** One point of a check. */
export interface OrbitPointResult {
  readonly place: string;
  /** "<episode>@<row>". */
  readonly point: string;
  readonly band?: string;
  /** The environment's verdict (facts: what System 2 is shown). */
  readonly verdict: Vec2;
  /** Its term of the criterion, or null without a noise estimate. */
  readonly chi: number | null;
  /** When the model threw at this point. */
  readonly failed?: string;
}

export interface OrbitObjectiveHost<M, P extends Place> {
  casesIn(place: P, context: CaseContext): OrbitCases;
  /** The model's prediction at a point, read as what is compared with what happened. */
  predict(model: M, state: OrbitPoint): Promise<Vec2>;
  /** Where the episode of a point started, as System 2 is shown it. */
  launchOf(episode: string): unknown;
  /** Operator only: what to keep of a whole run's result. */
  operatorView?(result: TestResult): Record<string, unknown>;
  readonly accept: number;
  readonly precision: number;
  readonly regression?: boolean;
}

function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Per band, the median of the criterion's terms over some points. */
export function orbitBands(results: readonly OrbitPointResult[]): Record<string, number> {
  const scored = results.filter((r) => !r.failed && r.chi !== null);
  const bands = [...new Set(scored.map((r) => r.band ?? ''))];
  return Object.fromEntries(bands.map((b) => [b, median(scored.filter((r) => (r.band ?? '') === b).map((r) => r.chi!))]));
}

export function orbitObjective<M, P extends Place>(host: OrbitObjectiveHost<M, P>): Objective<M, P, OrbitCases, OrbitPointResult> {
  const holdsOn = (results: readonly OrbitPointResult[]) => {
    const bands = orbitBands(results);
    return Object.keys(bands).length > 0 && !results.some((r) => r.failed) && Object.values(bands).every((m) => m <= host.accept);
  };
  return {
    answer: ORBIT_ANSWER,
    verdictForm: orbitVerdict({ regression: host.regression }),
    casesIn: (place, context) => host.casesIn(place, context),
    async run(model, cases) {
      /* One pooled noise estimate over the places run together, as the criterion reads it. */
      const parts = cases.flatMap((c) => c.cases.noise);
      const weight = parts.reduce((n, x) => n + x.weight, 0);
      const noise = weight ? parts.reduce((n, x) => n + x.variance * x.weight, 0) / weight : 0;
      const samples = cases.flatMap(({ place, cases: k }) => k.samples.map((s) => ({ ...s, group: place.id })));
      const result = await testPredictions(samples, (s) => host.predict(model, s), { noiseVariance: noise, relativePrecision: host.precision });
      const chi = (r: { predicted: Vec2; target: Vec2 }) => noise > 0
        ? ((r.target[0] - r.predicted[0]) ** 2 + (r.target[1] - r.predicted[1]) ** 2) / (2 * (noise + (host.precision * Math.hypot(r.target[0], r.target[1])) ** 2)) : null;
      const failedAt = new Map(result.failed.map((f) => [f.ref, f.error]));
      const byRef = new Map(result.samples.map((r) => [r.ref, r]));
      const byPlace = cases.map(({ place, cases: k }) => k.samples.map((s): OrbitPointResult => {
        const r = byRef.get(s.ref);
        return r ? { place: place.id, point: s.ref!, ...(s.band ? { band: s.band } : {}), verdict: r.score, chi: chi(r) }
          : { place: place.id, point: s.ref!, ...(s.band ? { band: s.band } : {}), verdict: [0, 0], chi: null, failed: failedAt.get(s.ref) ?? 'no prediction' };
      }));
      return { byPlace, detail: cases.map(() => result), ...(host.operatorView ? { operator: host.operatorView(result) } : {}) };
    },
    holds: (results, { rerun }) => holdsOn(results) && (!rerun || holdsOn(rerun.now)),
    view(results) {
      /* Facts only: per episode, the verdict at each of its points (a point where the model threw has none). */
      const byEpisode = new Map<string, { point: string; verdict: number[] }[]>();
      for (const r of results.filter((x) => !x.failed)) {
        const id = r.point.split('@')[0];
        byEpisode.set(id, [...(byEpisode.get(id) ?? []), { point: r.point, verdict: r.verdict.map((v) => Math.round(v * 1000) / 1000) }]);
      }
      return { episodes: [...byEpisode.entries()].map(([episode, points]) => ({ episode, from: host.launchOf(episode), points })) };
    },
    rerunView: (rerun) => ({ points: rerun.now.length, your_model_holds_on_them: holdsOn(rerun.now) }),
    operatorView: (results) => ({ chi2_by_band: orbitBands(results), points: results.length, failed: results.filter((r) => r.failed).length }),
    line: (results, _place, rerun) => Object.entries(orbitBands(results)).map(([b, m]) => (b ? b + ' ' : '') + Number(m.toPrecision(4))).join(', ') +
      (rerun ? ' (run again: ' + (holdsOn(rerun.now) ? 'holds' : 'does not hold') + ')' : '')
  };
}
