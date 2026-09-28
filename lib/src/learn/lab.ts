import type { World } from '../core/types.ts';
import type { CaseContext, CaseResult, Objective, Place } from './objective.ts';
import type { WorldInterface } from './prompt.ts';

/* ============================================================================
 * A LABORATORY (SPEC-OBJETIVO O9): everything a world brings to be investigated, as one
 * declaration. The runner (runtime/lab-runner.ts) does the rest the same way for every
 * laboratory: configuration, the Judge and System 2, the journal, the learner's
 * episodes and its instruments, the protocol, the operator's measures.
 *
 * What a laboratory declares, and nothing else:
 *   the world         how a spec is generated, and its family (`placeOf`)
 *   the senses        what is perceived at a point, and how that is described
 *   the episodes      how one runs, how its points are named and what each shows
 *   the actions       optionally, how System 2 starts an episode itself, and how a model's
 *                     answer is played forward (`simulate`)
 *   the objective     the form of the answer, the verdict and the criterion
 *   the operator's    the hidden truth, models that know nothing (baselines), and when an
 *                     answer agrees with what happened (the Judge ablation)
 *
 * The criterion, the family and the blind places are fixed by the laboratory and the
 * operator before System 2's first turn: System 2 never touches them (SPEC-OBJETIVO §10.3).
 * ========================================================================== */

/** A world option on the command line (e.g. --level), with its default and one line of help. */
export interface LabOption {
  readonly name: string;
  readonly default: string;
  readonly help: string;
}

/** The world's options as given (strings, defaults applied). */
export type LabOptions = Readonly<Record<string, string>>;

/** One point of a check: its name, the state perceived there, and what happened next (the laboratory's). */
export interface LabCase<P> {
  readonly point: string;
  readonly state: P;
}

/** What a laboratory's objective needs from the runner. */
export interface LabObjectiveHost<M, P extends Place, K> {
  casesIn(place: P, context: CaseContext): readonly K[];
  /** The model's answer at a point, as it gives it. */
  answer(model: M, state: unknown): Promise<unknown>;
  readonly regression?: boolean;
}

export interface Lab<S, P, E, K extends LabCase<P>, A = never> {
  /** The world's id, as models are written for it (e.g. "cells@1"). */
  readonly id: string;
  /** One paragraph for --help: what System 2 perceives and must answer. */
  readonly about: string;
  /** The world's own options. */
  readonly options: readonly LabOption[];
  /** Defaults of the common options that differ for this world (e.g. { every: '1' }). */
  readonly defaults?: Readonly<Record<string, string>>;

  /* --- The world ------------------------------------------------------------------------ */
  generate(seed: number, options: LabOptions): S;
  /** Place `index` of the family of `spec` (indexes from 1000 are the blind places). */
  placeOf(spec: S, index: number): S;
  /** The journal's name for a run (e.g. "cells-s1L2"). */
  runName(seed: number, options: LabOptions): string;
  /** One line for the console at the start. */
  headline(spec: S): string;
  /** What the journal keeps about a place (operator only). */
  placeInfo(spec: S): Record<string, unknown>;
  /** OPERATOR ONLY: the hidden truth, as statements the grader compares with the learner's words. */
  truth(spec: S): readonly { readonly id: string; readonly statement: string }[];
  /** The seed of the environment's exploration episodes. */
  explorationSeed(seed: number, options: LabOptions): number;

  /* --- The senses ----------------------------------------------------------------------- */
  world(): World<P, never>;
  perceive(point: P): unknown;
  readonly perceptDoc: string;
  /** The interface to the common prompt: the objective's lines and the instruments' parameters. */
  interface(options: { regression?: boolean }): WorldInterface;

  /* --- The episodes --------------------------------------------------------------------- */
  episode(spec: S, rnd: () => number): E;
  /** How many steps its index shows. */
  steps(episode: E): number;
  /** What the journal keeps of an exploration episode (operator only; the viewer reads it). */
  explored(episode: E): Record<string, unknown>;
  /** The point at a step, with what is shown there next to it (e.g. { the_next_row_was }); null if there is none. */
  at(episode: E, step: number): { readonly state: P; readonly shown: Record<string, unknown> } | null;
  /** The points of an episode a check is made of (`base`: the laboratory's spec). */
  cases(base: S, id: string, episode: E, every: number): K[];
  /** Every how many steps the learner's own points are taken (its table, its drafts' trials). */
  readonly ownEvery: number;
  /** `view`: the steps from..to, as the interface describes them. */
  view(episode: E, from: number, to: number): Record<string, unknown>;
  /** What a table shows next to its value at a case (e.g. { the_next_row_was } or { mark }). */
  shown(c: K): Record<string, unknown>;

  /* --- The actions (optional) ----------------------------------------------------------- */
  readonly act?: {
    parse(raw: Record<string, unknown>): A | string;
    /** The place it asks for (default: the first laboratory). */
    place(act: A): string | undefined;
    /** The episode it starts, or null when the environment refuses it (never saying why). */
    start(spec: S, act: A): E | null;
    /** What the learner is shown of the episode it started. */
    shown(episode: E): Record<string, unknown>;
  };
  readonly simulate?: {
    /** The state after `answer` is taken as what happened, or why it cannot be. */
    advance(state: P, answer: unknown): P | string;
    /** What was seen at a step of the episode, if anything. */
    seen(episode: E, step: number): unknown;
  };

  /* --- The objective and the operator --------------------------------------------------- */
  objective<M, PL extends Place & { readonly spec: S }>(host: LabObjectiveHost<M, PL, K>, options: LabOptions): Objective<M, PL, readonly K[], CaseResult>;
  /** Why an answer is not of the form asked, or null. */
  answerIssue(answer: unknown): string | null;
  /** OPERATOR ONLY: whether an answer agrees with what happened at a case (the Judge ablation), and the word for it. */
  agrees(answer: unknown, c: K): boolean;
  readonly agreement: string;
  /** OPERATOR ONLY: models that know nothing, as output code. If one holds too, the check could not tell. */
  baselines(spec: S): readonly { readonly name: string; readonly source: string }[];
  /** OPERATOR ONLY: how the grader is told what the learner saw, and how to read its model. */
  readonly grading: { readonly subject: string; readonly reading: string };
}

/** Any laboratory, for code that runs one without knowing its types. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyLab = Lab<any, any, any, any, any>;
