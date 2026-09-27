/* ============================================================================
 * The OBJECTIVE: the progress metric an operator defines for a task (SPEC-OBJETIVO §3).
 *
 * An environment connects with four things: its world (state and dynamics), its senses
 * (what is perceived), its actions (the parameters of its instruments: WorldInterface in
 * prompt.ts) and its objective:
 *
 *   1. the ANSWER - its FORM, told to System 2 in the interface, never how to build it;
 *   2. the CASES a model is checked on, in a place, never seen by System 2 before;
 *   3. the VERDICT - facts per case, shown as they are (no statistic over them);
 *   4. the CRITERION - whether the model holds in a place, from those facts only (never
 *      from the hidden truth), with the previous check's cases run again when the
 *      protocol asks for it (the paired regression).
 *
 * Operator-only measures (truth, noise floor, reference) come back apart and go to the
 * journal only. The protocol that uses an objective is the same for every world
 * (protocol.ts).
 * ========================================================================== */

export type Role = 'laboratory' | 'family' | 'confirmation';

/** A place a model can be checked in: a laboratory (the learner's), a board or setup of the family, or a blind one. The
    protocol changes its role (a family place where the model does not hold becomes a laboratory) and marks it seen. */
export interface Place {
  readonly id: string;
  role: Role;
  /** Its cases are the learner's to study (a laboratory, or a place where it was validated). */
  seen: boolean;
}

/** Why cases are drawn or run: a check in the laboratories, a validation in the family, a blind confirmation, or the
    previous check's cases run again with a new model (the paired regression), or a model that knows nothing run on the
    same cases (the operator's baseline: never the learner's). */
export type Purpose = 'check' | 'validation' | 'blind' | 'rerun' | 'baseline';

export interface CaseContext {
  readonly round: number;
  readonly attempt: number;
  readonly purpose: Exclude<Purpose, 'rerun'>;
  /** The place's position among the places drawn together. */
  readonly index: number;
  /** In a blind confirmation: which set (0, 1, ...). */
  readonly set?: number;
}

export interface RunContext {
  readonly round: number;
  readonly attempt: number;
  readonly purpose: Purpose;
}

/** One case's result: the world adds its facts (a score, a verdict per point...). */
export interface CaseResult {
  readonly place: string;
}

/** What a run returns: per place (in the order given), the results of its cases, and what the operator keeps. */
export interface RunOutput<R> {
  readonly byPlace: readonly (readonly R[])[];
  /** Operator only, over the whole run (e.g. the error of the hidden law on the same cases). */
  readonly operator?: Record<string, unknown>;
  /** Anything the host wants back per place (e.g. what an operator's ablation replays). Never shown. */
  readonly detail?: readonly unknown[];
}

/** The previous check's cases in a place, run again with the new model: their results then and now, in the same order. */
export interface Rerun<R> {
  readonly before: readonly R[];
  readonly now: readonly R[];
}

export interface AnswerForm {
  /** Interface lines: the FORM of the answer only ("a number from 0 to 1 for a point"). */
  readonly form: readonly string[];
  /** How the environment uses an answer: compared with what happened, or handed to a controller that acts. */
  readonly use: 'predict' | 'act';
}

/** What the operator defines for a task. M: a model; P: a place; K: the cases drawn in one place; R: one case's result. */
export interface Objective<M, P extends Place, K, R extends CaseResult> {
  readonly answer: AnswerForm;
  /** Interface lines: what a verdict IS, never what it means for the model. */
  readonly verdictForm: readonly string[];
  /** Fresh cases in a place. For a check or a validation they become the learner's (it can study them afterwards); blind
      cases never do. */
  casesIn(place: P, context: CaseContext): K;
  /** Runs a model on the cases of several places at once (a world may pool across them, e.g. a noise estimate). */
  run(model: M, cases: readonly { readonly place: P; readonly cases: K }[], context: RunContext): Promise<RunOutput<R>>;
  /** The operator's criterion: does the model hold in this place? From the facts of its cases (and, with the paired
      regression, of the previous check's cases run again) - never from the hidden truth. */
  holds(results: readonly R[], context: { readonly place: P; readonly rerun?: Rerun<R> }): boolean;
  /** The facts System 2 is shown for a place: one verdict per case, as they are. */
  view(results: readonly R[], place: P): Record<string, unknown>;
  /** The facts System 2 is shown of the paired regression in a place. */
  rerunView?(rerun: Rerun<R>, place: P): unknown;
  /** Operator only, per place: for the journal. */
  operatorView?(results: readonly R[], place: P): Record<string, unknown>;
  /** Operator only, per place: what the model answered and what happened, case by case (a few), for the journal and
      its viewer. Never shown. */
  trace?(results: readonly R[], place: P): readonly unknown[];
  /** One line for the console. */
  line?(results: readonly R[], place: P, rerun?: Rerun<R>): string;
}

/** The interface lines an objective contributes to the common prompt: the answer's form, then the verdict's. */
export const objectiveLines = (o: { readonly answer: AnswerForm; readonly verdictForm: readonly string[] }): string[] => [...o.answer.form, ...o.verdictForm];
