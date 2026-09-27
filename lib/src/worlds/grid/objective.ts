import { actionAccuracy, type ActionSample } from '../../learn/experiments.ts';
import type { AnswerForm, CaseContext, Objective, Place, RunContext } from '../../learn/objective.ts';

/* ============================================================================
 * The grid's objective (SPEC-OBJETIVO §4): a task of ACTING.
 *
 *   answer     a number from 0 to 1 for a point; a search that looks a few steps ahead
 *              uses it to choose the learner's steps
 *   cases      episodes from the place's usual start and from starts never played, each
 *              with its own seed for what the learner does not control
 *   verdict    the score each episode ended with (1, 0, -1)
 *   holds      every episode of the check scored 1, and none of the previous check's
 *              episodes, run again with this model, scored less than before
 *
 * The episodes are played by the host (it keeps them as the learner's, with what its
 * search did); the objective only reads their scores. The truth's view of each step is
 * the operator's (turns still winning, the step that threw the win, action accuracy).
 * ========================================================================== */

export const GRID_ANSWER: AnswerForm = {
  form: ['YOUR ANSWER, for a point: a number from 0 to 1 - how good the point is for you (outside that range it is cut). The steps that are yours are chosen by a search that looks a few steps ahead and uses your answer for each point it imagines.'],
  use: 'act'
};

export const GRID_VERDICT: readonly string[] = [
  'At the end of each episode you learn how it ended for you: a score from -1 to 1.',
  'In a check, the VERDICT on an episode is the score it ended with. The episodes of your previous check in a laboratory are also run again there with this model, from the same starts and with everything you do not control the same: you learn how many changed score, each way. Your model holds in a place when every episode of its check there scored 1 and none of those run again scored less than before.'
];

/** One episode of a check. */
export interface GridEpisode {
  readonly place: string;
  /** The episode as the learner can name it (absent when it was not kept: a rerun, a blind confirmation). */
  readonly episode?: string;
  readonly score: number;
  /** Operator only: the learner's turns while the position was still won, the turn that threw the win, the truth's view
      of each of its steps. */
  readonly held?: number | null;
  readonly critical?: number | null;
  readonly samples?: readonly ActionSample[];
}

export interface GridObjectiveHost<M, P extends Place, K> {
  /** The episodes of a check in a place (their starts and seeds). */
  casesIn(place: P, context: CaseContext): K;
  /** Plays a model on those episodes in a place. `record`: the episodes become the learner's. */
  play(model: M, place: P, cases: K, context: RunContext & { readonly record: boolean }): Promise<{ readonly episodes: readonly GridEpisode[]; readonly detail?: unknown }>;
}

const worse = (before: readonly GridEpisode[], now: readonly GridEpisode[]) => now.filter((x, i) => x.score < before[i].score).length;

export function gridObjective<M, P extends Place, K>(host: GridObjectiveHost<M, P, K>): Objective<M, P, K, GridEpisode> {
  return {
    answer: GRID_ANSWER,
    verdictForm: GRID_VERDICT,
    casesIn: (place, context) => host.casesIn(place, context),
    async run(model, cases, context) {
      const byPlace: GridEpisode[][] = [];
      const detail: unknown[] = [];
      /* A check's and a validation's episodes are the learner's; a rerun's and a blind confirmation's are not. */
      const record = context.purpose === 'check' || context.purpose === 'validation';
      for (const { place, cases: k } of cases) {
        const played = await host.play(model, place, k, { ...context, record });
        byPlace.push([...played.episodes]);
        detail.push(played.detail);
      }
      return { byPlace, detail };
    },
    holds: (results, { rerun }) => results.length > 0 && results.every((r) => r.score === 1) && (!rerun || worse(rerun.before, rerun.now) === 0),
    view: (results) => ({ episodes: results.map((r) => (r.episode ? { episode: r.episode, score: r.score } : { score: r.score })) }),
    rerunView(rerun) {
      const changed = rerun.now.map((x, i) => ({ episode: rerun.before[i].episode, before: rerun.before[i].score, now: x.score })).filter((x) => x.now !== x.before);
      return { went_up: changed.filter((x) => x.now > x.before).length, went_down: changed.filter((x) => x.now < x.before).length, changed };
    },
    operatorView: (results) => ({ wins: results.filter((r) => r.score === 1).length, total: results.length,
      action_accuracy: actionAccuracy(results.flatMap((r) => r.samples ?? [])), turns_still_winning: results.map((r) => r.held ?? null), critical: results.map((r) => r.critical ?? null) }),
    line: (results, _place, rerun) => results.filter((r) => r.score === 1).length + '/' + results.length +
      (rerun ? ' (run again: +' + rerun.now.filter((x, i) => x.score > rerun.before[i].score).length + ' -' + worse(rerun.before, rerun.now) + ')' : '')
  };
}
