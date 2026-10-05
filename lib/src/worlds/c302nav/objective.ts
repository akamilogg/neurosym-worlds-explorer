import type { AnswerForm, CaseContext, Objective, Place } from '../../learn/objective.ts';
import type { C302NavPoint } from './world.ts';

/* ============================================================================
 * c302-navigation@1's objective (SPEC-EUREKA-NAVEGACION §4.4): a task of PREDICTING two
 * signals from the drive alone.
 *
 *   answer     at any step, the two signals there, by their names ({ reorientation, steering },
 *              or { s1, s2 } with neutral names)
 *   cases      steps (one every `every`) of episodes never seen, drawn from the place's family
 *              and simulated by the c302 service
 *   verdict    per point and per signal, tanh((what came - the answer) / s), s the spread
 *              (standard deviation) of that signal over the point's episode
 *   holds      in the place, for each signal, the R² of the answers against what came, pooled
 *              over the place's points, is at least the operator's threshold, and no point threw;
 *              with the paired regression, also on the previous check's points
 * ========================================================================== */

/** The two signals' names, as the learner is told them. */
export type SignalNames = readonly [string, string];
export const REAL_SIGNALS: SignalNames = ['reorientation', 'steering'];

export const c302NavAnswer = (signals: SignalNames = REAL_SIGNALS): AnswerForm => ({
  form: ['YOUR ANSWER, at any step of any episode: the two signals at that step, {"' + signals[0] + '": <number>, "' + signals[1] + '": <number>}, in the units the episodes show them.'],
  use: 'predict'
});

export function c302NavVerdict(options: { regression?: boolean; signals?: SignalNames } = {}): string[] {
  const [a, b] = options.signals ?? REAL_SIGNALS;
  return ['A VERDICT, at a point, is a pair of numbers from -1 to 1, one per signal (' + a + ', then ' + b + '); 0 on one means your answer was what came there. What the rest of the range means is for you to work out.',
    ...(options.regression ? ['The points of your previous check in a laboratory are also answered again there by this model: you learn whether your model still holds on them.'] : [])];
}

export interface C302NavCase {
  readonly point: string;
  readonly state: C302NavPoint;
  /** What came there, per signal, and the spread of each over the point's episode. */
  readonly came: Readonly<Record<string, number>>;
  readonly spread: Readonly<Record<string, number>>;
}

export interface C302NavResult {
  readonly place: string;
  readonly point: string;
  /** Per signal, tanh((came - answer) / spread); null when the answer was not of the form. */
  readonly verdict: readonly [number, number] | null;
  readonly failed?: string;
  /** Operator only (the trace and the criterion). */
  readonly answer?: unknown;
  readonly came: Readonly<Record<string, number>>;
}

export interface C302NavObjectiveHost<M, P extends Place> {
  casesIn(place: P, context: CaseContext): readonly C302NavCase[] | Promise<readonly C302NavCase[]>;
  answer(model: M, state: C302NavPoint): Promise<unknown>;
  /** Per signal, the R² a model must reach in a place. */
  readonly holdR2: readonly [number, number];
  readonly signals: SignalNames;
  readonly regression?: boolean;
}

/** The answer's two numbers, by the signals' names, or null when it is not of the form. */
export function answerPair(a: unknown, signals: SignalNames): Record<string, number> | null {
  if (!a || typeof a !== 'object') return null;
  const o = a as Record<string, unknown>;
  return signals.every((s) => typeof o[s] === 'number' && Number.isFinite(o[s])) ? Object.fromEntries(signals.map((s) => [s, o[s] as number])) : null;
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
export function r2BySignal(results: readonly C302NavResult[], signals: SignalNames): Record<string, number | null> {
  return Object.fromEntries(signals.map((s) => [s, r2(results.map((r) => ({ answer: answerPair(r.answer, signals)?.[s] ?? 0, came: r.came[s] })))]));
}

const round3 = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 1000);

export function c302NavObjective<M, P extends Place>(host: C302NavObjectiveHost<M, P>): Objective<M, P, readonly C302NavCase[], C302NavResult> {
  const holdsOn = (rs: readonly C302NavResult[]) => {
    if (!rs.length || rs.some((r) => r.verdict === null)) return false;
    const by = r2BySignal(rs, host.signals);
    return host.signals.every((s, i) => by[s] !== null && by[s]! >= host.holdR2[i]);
  };
  return {
    answer: c302NavAnswer(host.signals),
    verdictForm: c302NavVerdict({ regression: host.regression, signals: host.signals }),
    casesIn: (place, context) => host.casesIn(place, context),
    async run(model, cases) {
      const byPlace: C302NavResult[][] = [];
      for (const { place, cases: points } of cases) {
        const rs: C302NavResult[] = [];
        for (const c of points) {
          try {
            const a = await host.answer(model, c.state);
            const p = answerPair(a, host.signals);
            const [x, y] = host.signals;
            rs.push({ place: place.id, point: c.point, answer: a, came: c.came,
              verdict: p ? [Math.tanh((c.came[x] - p[x]) / c.spread[x]), Math.tanh((c.came[y] - p[y]) / c.spread[y])] : null });
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
    operatorView: (results) => ({ r2: Object.fromEntries(Object.entries(r2BySignal(results, host.signals)).map(([k, v]) => [k, round3(v)])), points: results.length,
      failed: results.filter((r) => r.failed).length, not_of_the_form: results.filter((r) => !r.failed && r.verdict === null).length }),
    trace: (results) => results.slice(0, 40).map((r) => ({ point: r.point, answer: r.answer, came: r.came, ...(r.failed ? { error: r.failed.slice(0, 120) } : {}) })),
    line: (results, _p, rerun) => {
      const by = r2BySignal(results, host.signals);
      return 'R² ' + host.signals.map((s) => s + ' ' + round3(by[s])).join(', ') + (rerun ? ' (run again: ' + (holdsOn(rerun.now) ? 'holds' : 'does not hold') + ')' : '');
    }
  };
}
