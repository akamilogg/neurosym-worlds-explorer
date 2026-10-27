import type { AnswerForm, CaseContext, Objective, Place } from '../../learn/objective.ts';
import type { PlatesFrame } from './world.ts';

/* ============================================================================
 * plates@1's objective: PREDICTING the plate's colonies one tick ahead.
 *
 *   answer     at any step of any episode, the NEXT colony layer, in the form of `colony`
 *   cases      points of realizations of their own of a place (reserved: never the world it acts in)
 *   verdict    per point, the wells where the answer differs from the layer that came
 *   holds      at every point of the check the answer was the layer that came
 * ========================================================================== */

export interface PlatesPoint { readonly frames: readonly PlatesFrame[] }

export const PLATES_ANSWER: AnswerForm = {
  form: ['YOUR ANSWER, at any step of any episode: the NEXT colony layer of the plate, written as `colony` is (rows of digits joined by "/").'],
  use: 'predict'
};

export const PLATES_VERDICT = [
  'A VERDICT, at a point, is the list of wells (e.g. "B4") where your answer differs from the colony layer that came next; an empty list means your answer was that layer. An answer that is not a layer of that form is said to be so.',
  'Your model holds in a place when, at every point of its check there, the verdict is an empty list.'
];

export interface PlatesCase { readonly point: string; readonly state: PlatesPoint; readonly next: string }

export interface PlatesResult {
  readonly place: string;
  readonly point: string;
  readonly differsAt: readonly string[] | null;
  readonly failed?: string;
  readonly before?: string;
  readonly answer?: unknown;
  readonly came?: string;
}

const ROWS = 'ABCDEFGH';

/** The wells where an answer differs from the layer that came, or null when it is not a layer of that form. */
export function wellsDiffering(answer: unknown, next: string): string[] | null {
  if (typeof answer !== 'string') return null;
  const a = answer.trim().split('/'), b = next.split('/');
  if (a.length !== b.length || a.some((row, r) => row.length !== b[r].length || !/^[0-9]+$/.test(row))) return null;
  const out: string[] = [];
  b.forEach((row, r) => { for (let c = 0; c < row.length; c++) if (a[r][c] !== row[c]) out.push(ROWS[r] + (c + 1)); });
  return out;
}

export interface PlatesObjectiveHost<M, P extends Place> {
  casesIn(place: P, context: CaseContext): readonly PlatesCase[] | Promise<readonly PlatesCase[]>;
  answer(model: M, state: PlatesPoint): Promise<unknown>;
}

const TRACE = 24;

export function platesObjective<M, P extends Place>(host: PlatesObjectiveHost<M, P>): Objective<M, P, readonly PlatesCase[], PlatesResult> {
  const exact = (rs: readonly PlatesResult[]) => rs.length > 0 && rs.every((r) => r.differsAt !== null && r.differsAt.length === 0);
  return {
    answer: PLATES_ANSWER,
    verdictForm: PLATES_VERDICT,
    casesIn: (place, context) => host.casesIn(place, context),
    async run(model, cases) {
      const byPlace: PlatesResult[][] = [];
      for (const { place, cases: points } of cases) {
        const rs: PlatesResult[] = [];
        for (const c of points) {
          const seen = { before: c.state.frames[c.state.frames.length - 1].colony, came: c.next };
          try { const answer = await host.answer(model, c.state); rs.push({ place: place.id, point: c.point, differsAt: wellsDiffering(answer, c.next), ...seen, answer }); }
          catch (e) { rs.push({ place: place.id, point: c.point, differsAt: null, failed: String((e as Error)?.message ?? e), ...seen }); }
        }
        byPlace.push(rs);
      }
      return { byPlace };
    },
    holds: (results) => exact(results),
    view: (results) => ({ points: results.map((r) => r.failed ? { point: r.point, error: r.failed }
      : r.differsAt === null ? { point: r.point, not_a_layer_of_that_form: true } : { point: r.point, differs_at: r.differsAt }) }),
    operatorView: (results) => ({ exact: results.filter((r) => r.differsAt?.length === 0).length, points: results.length,
      wells_wrong: results.reduce((n, r) => n + (r.differsAt?.length ?? 0), 0), not_a_layer: results.filter((r) => r.differsAt === null).length }),
    trace: (results) => results.slice(0, TRACE).map((r) => ({ point: r.point, before: r.before, answer: typeof r.answer === 'string' ? r.answer : r.failed ? null : JSON.stringify(r.answer ?? null).slice(0, 80), came: r.came,
      ...(r.failed ? { error: r.failed.slice(0, 120) } : {}) })),
    line: (results) => results.filter((r) => r.differsAt?.length === 0).length + '/' + results.length + ' exact'
  };
}
