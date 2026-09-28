import type { AnswerForm, CaseContext, Objective, Place } from '../../learn/objective.ts';
import type { TankPoint } from './world.ts';

/* ============================================================================
 * tank@1's objective: a task of PREDICTING a number.
 *
 *   answer     at any step, the value shown after the next input
 *   cases      the steps of episodes never seen, in a place (run by the service)
 *   verdict    per point, how far the answer was from the level that came (level - answer)
 *   holds      at every point of the check the answer was that level (rounded to a whole
 *              number); with the paired regression, also on the previous check's points
 * ========================================================================== */

export const TANK_ANSWER: AnswerForm = {
  form: ['YOUR ANSWER, at any step of any episode: the value shown after the next input, a number.'],
  use: 'predict'
};

export function tankVerdict(options: { regression?: boolean } = {}): string[] {
  return ['A VERDICT, at a point, is the value that came minus your answer (rounded to a whole number); 0 means your answer was that value.',
    'Your model holds in a place when, at every point of its check there, the verdict is 0.' + (options.regression ? ' The points of your previous check in a laboratory are answered again there by this model, and must be too.' : '')];
}

export interface TankCase { readonly point: string; readonly state: TankPoint; readonly next: number }

export interface TankResult {
  readonly place: string;
  readonly point: string;
  /** The level that came minus the answer, rounded; null when the answer was not a number. */
  readonly off: number | null;
  readonly failed?: string;
  /** Operator only (the trace). */
  readonly answer?: unknown;
  readonly came?: number;
}

export interface TankObjectiveHost<M, P extends Place> {
  casesIn(place: P, context: CaseContext): readonly TankCase[] | Promise<readonly TankCase[]>;
  answer(model: M, state: TankPoint): Promise<unknown>;
  readonly regression?: boolean;
}

/** How far an answer is from the level that came, or null when it is not a number. */
export const offBy = (answer: unknown, next: number): number | null => (typeof answer === 'number' && Number.isFinite(answer) ? next - Math.round(answer) : null);

export function tankObjective<M, P extends Place>(host: TankObjectiveHost<M, P>): Objective<M, P, readonly TankCase[], TankResult> {
  const ok = (rs: readonly TankResult[]) => rs.length > 0 && rs.every((r) => r.off === 0);
  return {
    answer: TANK_ANSWER,
    verdictForm: tankVerdict({ regression: host.regression }),
    casesIn: (place, context) => host.casesIn(place, context),
    async run(model, cases) {
      const byPlace: TankResult[][] = [];
      for (const { place, cases: points } of cases) {
        const rs: TankResult[] = [];
        for (const c of points) {
          try {
            const a = await host.answer(model, c.state);
            rs.push({ place: place.id, point: c.point, off: offBy(a, c.next), answer: a, came: c.next });
          } catch (e) { rs.push({ place: place.id, point: c.point, off: null, failed: String((e as Error)?.message ?? e), came: c.next }); }
        }
        byPlace.push(rs);
      }
      return { byPlace };
    },
    holds: (results, { rerun }) => ok(results) && (!rerun || ok(rerun.now)),
    view: (results) => ({ points: results.map((r) => ({ point: r.point, ...(r.failed ? { error: r.failed } : r.off === null ? { not_a_number: true } : { verdict: r.off }) })) }),
    rerunView: (rerun) => ({ points: rerun.now.length, your_model_holds_on_them: ok(rerun.now) }),
    operatorView: (results) => ({ exact: results.filter((r) => r.off === 0).length, points: results.length, not_a_number: results.filter((r) => r.off === null).length }),
    trace: (results) => results.slice(0, 24).map((r) => ({ point: r.point, answer: r.answer, came: r.came, ...(r.failed ? { error: r.failed.slice(0, 120) } : {}) })),
    line: (results, _p, rerun) => results.filter((r) => r.off === 0).length + '/' + results.length + ' exact'
      + (rerun ? ' (run again: ' + rerun.now.filter((r) => r.off === 0).length + '/' + rerun.now.length + ')' : '')
  };
}
