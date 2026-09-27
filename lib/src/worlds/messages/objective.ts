import type { AnswerForm, CaseContext, Objective, Place } from '../../learn/objective.ts';
import type { MessagePoint } from './world.ts';

/* ============================================================================
 * messages@1's objective: a task of PREDICTING a mark, 0 or 1, from a text.
 *
 *   answer     at any step, a number from 0 to 1 for the mark the environment gives there
 *   cases      the messages of episodes never seen, in a place
 *   verdict    per point, the mark, and whether the answer was on its side (at least 0.5 for
 *              a 1, below 0.5 for a 0)
 *   holds      at every point of the check but at most one, the answer was on the mark's
 *              side (one miss is allowed: a reader of meaning can misread one message); with
 *              the paired regression, also on the previous check's points
 * ========================================================================== */

export const MESSAGES_ANSWER: AnswerForm = {
  form: ['YOUR ANSWER, at any step of any episode: a number from 0 to 1, for the mark the environment gives that step - a mark is 0 or 1.'],
  use: 'predict'
};

export function messagesVerdict(options: { regression?: boolean } = {}): string[] {
  return ['A VERDICT, at a point, is the mark the environment gave there and whether your answer was on its side (at least 0.5 for a 1, below 0.5 for a 0).',
    'Your model holds in a place when, at every point of its check there but at most one, your answer was on the side of the mark.' + (options.regression ? ' The points of your previous check in a laboratory are answered again there by this model, and must be too.' : '')];
}

export interface MessagesCase { readonly point: string; readonly state: MessagePoint; readonly mark: 0 | 1 }

export interface MessagesResult {
  readonly place: string;
  readonly point: string;
  readonly mark: 0 | 1;
  /** The answer was on the side of the mark; false when it was not a number. */
  readonly agreed: boolean;
  /** Operator only: the answer as given (a number), or why there was none. */
  readonly answer: number | null;
  readonly failed?: string;
  /** Operator only (the trace): the text answered. */
  readonly text?: string;
}

export interface MessagesObjectiveHost<M, P extends Place> {
  casesIn(place: P, context: CaseContext): readonly MessagesCase[];
  answer(model: M, state: MessagePoint): Promise<unknown>;
  readonly regression?: boolean;
  /** Misses allowed in a place's check (default 1). */
  readonly tolerance?: number;
}

export const sideOf = (answer: unknown): 0 | 1 | null => (typeof answer === 'number' && Number.isFinite(answer) ? (answer >= 0.5 ? 1 : 0) : null);

export function messagesObjective<M, P extends Place>(host: MessagesObjectiveHost<M, P>): Objective<M, P, readonly MessagesCase[], MessagesResult> {
  const tolerance = host.tolerance ?? 1;
  const ok = (rs: readonly MessagesResult[]) => rs.length > 0 && rs.filter((r) => !r.agreed).length <= tolerance;
  return {
    answer: MESSAGES_ANSWER,
    verdictForm: messagesVerdict({ regression: host.regression }),
    casesIn: (place, context) => host.casesIn(place, context),
    async run(model, cases) {
      const byPlace: MessagesResult[][] = [];
      for (const { place, cases: points } of cases) {
        const rs: MessagesResult[] = [];
        for (const c of points) {
          try {
            const a = await host.answer(model, c.state);
            rs.push({ place: place.id, point: c.point, mark: c.mark, agreed: sideOf(a) === c.mark, answer: typeof a === 'number' && Number.isFinite(a) ? a : null, text: c.state.text });
          } catch (e) { rs.push({ place: place.id, point: c.point, mark: c.mark, agreed: false, answer: null, failed: String((e as Error)?.message ?? e), text: c.state.text }); }
        }
        byPlace.push(rs);
      }
      return { byPlace };
    },
    holds: (results, { rerun }) => ok(results) && (!rerun || ok(rerun.now)),
    view: (results) => ({ points: results.map((r) => ({ point: r.point, mark: r.mark, your_answer_was_on_its_side: r.agreed, ...(r.failed ? { error: r.failed } : r.answer === null ? { not_a_number: true } : {}) })) }),
    rerunView: (rerun) => ({ points: rerun.now.length, your_model_holds_on_them: ok(rerun.now) }),
    operatorView: (results) => ({ agreed: results.filter((r) => r.agreed).length, points: results.length, not_a_number: results.filter((r) => r.answer === null).length }),
    trace: (results) => results.slice(0, 24).map((r) => ({ point: r.point, text: r.text, answer: r.answer, mark: r.mark, agreed: r.agreed, ...(r.failed ? { error: r.failed.slice(0, 120) } : {}) })),
    line: (results, _p, rerun) => results.filter((r) => r.agreed).length + '/' + results.length + ' agreed' +
      (rerun ? ' (run again: ' + rerun.now.filter((r) => r.agreed).length + '/' + rerun.now.length + ')' : '')
  };
}
