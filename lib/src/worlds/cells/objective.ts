import type { AnswerForm, CaseContext, Objective, Place } from '../../learn/objective.ts';
import type { CellsPoint } from './world.ts';

/* ============================================================================
 * cells@1's objective: a task of PREDICTING, whose answer is neither a number nor a pair.
 *
 *   answer     at any step of any episode, the NEXT row, as a string of symbols
 *   cases      points of episodes never seen, in a place
 *   verdict    per point, the positions where the answer differs from the row that came
 *              (an answer that is not a row of that length is said to be so)
 *   holds      at every point of the check the answer was the row that came; with the
 *              paired regression, also at every point of the previous check
 * ========================================================================== */

export const CELLS_ANSWER: AnswerForm = {
  form: ['YOUR ANSWER, at any step of any episode: the NEXT row, as a string of symbols.'],
  use: 'predict'
};

export function cellsVerdict(options: { regression?: boolean } = {}): string[] {
  return ['A VERDICT, at a point, is the list of positions (0 is the first character) where your answer differs from the row that came next; an empty list means your answer was that row. An answer that is not a string of the length of that row is said to be so.',
    'Your model holds in a place when, at every point of its check there, the verdict is an empty list.' + (options.regression ? ' The points of your previous check in a laboratory are answered again there by this model, and must be too.' : '')];
}

/** One point of a check: where, and the row that came next there (the host's; never shown before the check). */
export interface CellsCase { readonly point: string; readonly state: CellsPoint; readonly next: string }

export interface CellsResult {
  readonly place: string;
  readonly point: string;
  /** Positions where the answer differs; null when the answer is not a row of that length. */
  readonly differsAt: readonly number[] | null;
  /** Operator only: the model threw here. */
  readonly failed?: string;
  /** Operator only (the trace): the row before, the answer, and the row that came. */
  readonly before?: string;
  readonly answer?: unknown;
  readonly came?: string;
}

export interface CellsObjectiveHost<M, P extends Place> {
  casesIn(place: P, context: CaseContext): readonly CellsCase[] | Promise<readonly CellsCase[]>;
  /** The model's answer at a point, as it gives it. */
  answer(model: M, state: CellsPoint): Promise<unknown>;
  readonly regression?: boolean;
}

/** Where an answer differs from the row that came, or null when it is not a row of that length. */
export function differences(answer: unknown, next: string): number[] | null {
  if (typeof answer !== 'string' || answer.length !== next.length) return null;
  const out: number[] = [];
  for (let i = 0; i < next.length; i++) if (answer[i] !== next[i]) out.push(i);
  return out;
}

/** Cases per place kept in the journal's trace. */
const TRACE = 24;

export function cellsObjective<M, P extends Place>(host: CellsObjectiveHost<M, P>): Objective<M, P, readonly CellsCase[], CellsResult> {
  const exact = (rs: readonly CellsResult[]) => rs.length > 0 && rs.every((r) => r.differsAt !== null && r.differsAt.length === 0);
  return {
    answer: CELLS_ANSWER,
    verdictForm: cellsVerdict({ regression: host.regression }),
    casesIn: (place, context) => host.casesIn(place, context),
    async run(model, cases) {
      const byPlace: CellsResult[][] = [];
      for (const { place, cases: points } of cases) {
        const rs: CellsResult[] = [];
        for (const c of points) {
          const seen = { before: c.state.rows[c.state.rows.length - 1], came: c.next };
          try { const answer = await host.answer(model, c.state); rs.push({ place: place.id, point: c.point, differsAt: differences(answer, c.next), ...seen, answer }); }
          catch (e) { rs.push({ place: place.id, point: c.point, differsAt: null, failed: String((e as Error)?.message ?? e), ...seen }); }
        }
        byPlace.push(rs);
      }
      return { byPlace };
    },
    holds: (results, { rerun }) => exact(results) && (!rerun || exact(rerun.now)),
    view: (results) => ({ points: results.map((r) => r.failed ? { point: r.point, error: r.failed }
      : r.differsAt === null ? { point: r.point, not_a_row_of_that_length: true } : { point: r.point, differs_at: r.differsAt }) }),
    rerunView: (rerun) => ({ points: rerun.now.length, your_model_holds_on_them: exact(rerun.now) }),
    operatorView: (results) => ({ exact: results.filter((r) => r.differsAt?.length === 0).length, points: results.length,
      cells_wrong: results.reduce((n, r) => n + (r.differsAt?.length ?? 0), 0), not_a_row: results.filter((r) => r.differsAt === null).length }),
    trace: (results) => results.slice(0, TRACE).map((r) => ({ point: r.point, before: r.before, answer: typeof r.answer === 'string' ? r.answer : r.failed ? null : JSON.stringify(r.answer ?? null).slice(0, 80), came: r.came, ...(r.failed ? { error: r.failed.slice(0, 120) } : {}) })),
    line: (results, _p, rerun) => results.filter((r) => r.differsAt?.length === 0).length + '/' + results.length + ' exact' +
      (rerun ? ' (run again: ' + rerun.now.filter((r) => r.differsAt?.length === 0).length + '/' + rerun.now.length + ')' : '')
  };
}
