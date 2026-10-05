import type { AnswerForm, CaseContext, Objective, Place } from '../../learn/objective.ts';
import { SIGNALS, type C302NavPoint, type Signal } from './world.ts';

/* ============================================================================
 * c302-navigation@1's objective (SPEC-EUREKA-NAVEGACION §4.4): a task of PREDICTING two
 * signals from the drive alone.
 *
 *   answer     at any step, the two signals there: { reorientation, steering }
 *   cases      steps (one every `every`) of episodes never seen, drawn from the place's family
 *              and simulated by the c302 service
 *   verdict    per point and per signal, tanh((what came - the answer) / s), s the spread
 *              (standard deviation) of that signal over the point's episode
 *   holds      in the place, for each signal, the R² of the answers against what came, pooled
 *              over the place's points, is at least the operator's threshold, and no point threw;
 *              with the paired regression, also on the previous check's points
 * ========================================================================== */

export const C302NAV_ANSWER: AnswerForm = {
  form: ['YOUR ANSWER, at any step of any episode: the two signals at that step, {"reorientation": <number>, "steering": <number>}, in the units the episodes show them.'],
  use: 'predict'
};

export function c302NavVerdict(options: { regression?: boolean } = {}): string[] {
  return ['A VERDICT, at a point, is a pair of numbers from -1 to 1, one per signal (reorientation, then steering); 0 on one means your answer was what came there. What the rest of the range means is for you to work out.',
    ...(options.regression ? ['The points of your previous check in a laboratory are also answered again there by this model: you learn whether your model still holds on them.'] : [])];
}

export interface C302NavCase {
  readonly point: string;
  readonly state: C302NavPoint;
  /** What came there, per signal, and the spread of each over the point's episode. */
  readonly came: Readonly<Record<Signal, number>>;
  readonly spread: Readonly<Record<Signal, number>>;
}

export interface C302NavResult {
  readonly place: string;
  readonly point: string;
  /** Per signal, tanh((came - answer) / spread); null when the answer was not of the form. */
  readonly verdict: readonly [number, number] | null;
  readonly failed?: string;
  /** Operator only (the trace and the criterion). */
  readonly answer?: unknown;
  readonly came: Readonly<Record<Signal, number>>;
}

export interface C302NavObjectiveHost<M, P extends Place> {
  casesIn(place: P, context: CaseContext): readonly C302NavCase[] | Promise<readonly C302NavCase[]>;
  answer(model: M, state: C302NavPoint): Promise<unknown>;
  /** Per signal, the R² a model must reach in a place. */
  readonly holdR2: Readonly<Record<Signal, number>>;
  readonly regression?: boolean;
}

/** The answer's two numbers, or null when it is not of the form. */
export function answerPair(a: unknown): Record<Signal, number> | null {
  if (!a || typeof a !== 'object') return null;
  const o = a as Record<string, unknown>;
  return SIGNALS.every((s) => typeof o[s] === 'number' && Number.isFinite(o[s])) ? { reorientation: o.reorientation as number, steering: o.steering as number } : null;
}

/** The R² of answers against what came, pooled over points; null without spread or without answers. */
export function r2(pairs: readonly { readonly answer: number; readonly came: number }[]): number | null {
  if (!pairs.length) return null;
  const m = pairs.reduce((s, p) => s + p.came, 0) / pairs.length;
  const tot = pairs.reduce((s, p) => s + (p.came - m) ** 2, 0);
  if (!(tot > 0)) return null;
  return 1 - pairs.reduce((s, p) => s + (p.came - p.answer) ** 2, 0) / tot;
}

/** Per signal, the R² over the results (a point without an answer of the form counts as answering 0). */
export function r2BySignal(results: readonly C302NavResult[]): Record<Signal, number | null> {
  const of = (s: Signal) => r2(results.map((r) => ({ answer: answerPair(r.answer)?.[s] ?? 0, came: r.came[s] })));
  return { reorientation: of('reorientation'), steering: of('steering') };
}

const round3 = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 1000);

export function c302NavObjective<M, P extends Place>(host: C302NavObjectiveHost<M, P>): Objective<M, P, readonly C302NavCase[], C302NavResult> {
  const holdsOn = (rs: readonly C302NavResult[]) => {
    if (!rs.length || rs.some((r) => r.verdict === null)) return false;
    const by = r2BySignal(rs);
    return SIGNALS.every((s) => by[s] !== null && by[s]! >= host.holdR2[s]);
  };
  return {
    answer: C302NAV_ANSWER,
    verdictForm: c302NavVerdict({ regression: host.regression }),
    casesIn: (place, context) => host.casesIn(place, context),
    async run(model, cases) {
      const byPlace: C302NavResult[][] = [];
      for (const { place, cases: points } of cases) {
        const rs: C302NavResult[] = [];
        for (const c of points) {
          try {
            const a = await host.answer(model, c.state);
            const p = answerPair(a);
            rs.push({ place: place.id, point: c.point, answer: a, came: c.came,
              verdict: p ? [Math.tanh((c.came.reorientation - p.reorientation) / c.spread.reorientation), Math.tanh((c.came.steering - p.steering) / c.spread.steering)] : null });
          } catch (e) { rs.push({ place: place.id, point: c.point, verdict: null, failed: String((e as Error)?.message ?? e), came: c.came }); }
        }
        byPlace.push(rs);
      }
      return { byPlace };
    },
    holds: (results, { rerun }) => holdsOn(results) && (!rerun || holdsOn(rerun.now)),
    view(results) {
      /* Facts only: per episode, the verdict at each of its points. */
      const byEpisode = new Map<string, unknown[]>();
      for (const r of results) {
        const id = r.point.split('@')[0];
        byEpisode.set(id, [...(byEpisode.get(id) ?? []), { point: r.point,
          ...(r.failed ? { error: r.failed.slice(0, 160) } : r.verdict ? { verdict: r.verdict.map((v) => round3(v)) } : { not_of_the_form: true }) }]);
      }
      return { episodes: [...byEpisode.entries()].map(([episode, points]) => ({ episode, points })) };
    },
    rerunView: (rerun) => ({ points: rerun.now.length, your_model_holds_on_them: holdsOn(rerun.now) }),
    operatorView: (results) => ({ r2: Object.fromEntries(Object.entries(r2BySignal(results)).map(([k, v]) => [k, round3(v)])), points: results.length,
      failed: results.filter((r) => r.failed).length, not_of_the_form: results.filter((r) => !r.failed && r.verdict === null).length }),
    trace: (results) => results.slice(0, 40).map((r) => ({ point: r.point, answer: r.answer, came: r.came, ...(r.failed ? { error: r.failed.slice(0, 120) } : {}) })),
    line: (results, _p, rerun) => {
      const by = r2BySignal(results);
      return 'R² reorientation ' + round3(by.reorientation) + ', steering ' + round3(by.steering) + (rerun ? ' (run again: ' + (holdsOn(rerun.now) ? 'holds' : 'does not hold') + ')' : '');
    }
  };
}
