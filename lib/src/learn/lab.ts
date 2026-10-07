import type { World } from '../core/types.ts';
import { GRADING_STRUCTURE, type AblationRecord } from './operator.ts';
import type { CaseContext, CaseResult, Objective, Place } from './objective.ts';
import type { WorldInterface } from './prompt.ts';

/* ============================================================================
 * A LABORATORY (SPEC-OBJETIVO O9): everything a world brings to be investigated, as one
 * declaration. The runner (runtime/lab-runner.ts) does the rest the same way for every
 * laboratory: configuration, the Judge and System 2, the journal, the learner's
 * episodes and its instruments, the protocol, the operator's measures, stopping and
 * resuming, the finding.
 *
 * What a laboratory declares:
 *   the world         how a spec is generated, and its family (`placeOf`, or `places` and
 *                     `blindPlaces` when it names them itself)
 *   the senses        what is perceived at a point, and how that is described
 *   the episodes      how one runs, how its points are named and what each shows
 *   the actions       optionally, how System 2 starts an episode itself, and how a model's
 *                     answer is played forward (`simulate`)
 *   the objective     the form of the answer, the verdict and the criterion
 *   the operator's    models that know nothing (baselines), when an answer agrees with what
 *                     happened (the Judge ablation), and, optionally, measures of its own
 *                     (`operator`) and a truth to grade the learner against (`truth`)
 *
 * What a laboratory must have is a world it can observe or act on, and a family of places
 * where a model is checked: the criterion is decided from what the world answered, never
 * from a truth. A TRUTH is optional: only a world someone wrote (the synthetic ones) has
 * one; it lets the operator grade how much of it the learner recovered, and nothing else
 * depends on it. A real laboratory - someone else's service, an experiment - declares none.
 *
 * Optional parts have a default that is what cells@1 and messages@1 need; orbit@1 declares
 * more of them. The criterion, the family and the blind places are fixed by the laboratory
 * and the operator before System 2's first turn: System 2 never touches them (§10.3).
 * ========================================================================== */

/** A world option on the command line (e.g. --level), with its default and one line of help. */
export interface LabOption {
  readonly name: string;
  readonly default: string;
  readonly help: string;
  /** Other names it is accepted under (an earlier runner's). */
  readonly aliases?: readonly string[];
}

/** A world flag on the command line (e.g. --vary-strength): "true" when given, else "false". */
export interface LabFlag {
  readonly name: string;
  readonly help: string;
}

/** The world's options and flags as given (strings, defaults applied; a flag is "true" or "false"). */
export type LabOptions = Readonly<Record<string, string>>;

/** What a laboratory's hooks are told of the run's configuration. */
export interface LabContext {
  readonly seed: number;
  readonly options: LabOptions;
  readonly family: number;
  readonly every: number;
  readonly checkEpisodes: number;
  readonly confirmPlaces: number;
  readonly explore: number;
  /** For a laboratory whose environment is outside (`Lab.external`): asks it. Each request is done once - it carries a key
      the environment answers again without acting - and what it answered is logged, so a resumed run replays it instead of
      acting again (SPEC-OBJETIVO O12). */
  readonly effects?: { request(route: string, body: unknown): Promise<unknown> };
  /** An episode of the learner's by its name (an act that builds on an earlier one, e.g. replaying its current), or undefined. */
  readonly episodeOf?: (id: string) => unknown;
}

/** One point of a check: its name, the state perceived there, and what happened next (the laboratory's). */
export interface LabCase<P> {
  readonly point: string;
  readonly state: P;
}

/** What a laboratory's objective needs from the runner. */
export interface LabObjectiveHost<M, P extends Place, K> {
  casesIn(place: P, context: CaseContext): readonly K[] | Promise<readonly K[]>;
  /** The model's answer at a point, as it gives it. */
  answer(model: M, state: unknown): Promise<unknown>;
  /** The model's answer at a point, read as what is compared with what happened (`Lab.compare`). */
  compared(model: M, state: unknown): Promise<unknown>;
  /** The facet in force (`Lab.facets`), or null: what of the answer counts. It may change during an assisted run. */
  focus(): string | null;
  /** A stored episode of the learner's, by name. */
  episode(id: string): unknown;
  readonly regression?: boolean;
}

/** What the laboratory's own operator measures are given (all operator-only: never shown to System 2). */
export interface LabOperatorContext<S, K> {
  readonly spec: S;
  readonly ctx: LabContext;
  /** The run's flags that concern the operator. */
  readonly ablation: boolean;
  /** Answers a model gives, as given and as compared; with `measure`, the Judge reads other observations (an ablation). */
  readonly predictor: import('../core/predict.ts').Predictor<unknown, unknown>;
  readonly observer: import('../core/observer.ts').Observer<unknown>;
  log(type: string, data?: Record<string, unknown>): void;
  say(text: string): void;
  /** The cases of the learner's own episodes (what an ablation may be fitted on). */
  own(): readonly K[];
  /** The Judge's and the evaluator's counters (calls, cache hits, evaluations it was not asked). */
  stats(): { readonly judge: import('../core/jev.ts').JevStats; readonly evaluator: import('../core/evaluate.ts').EvaluatorStats };
}

export interface Lab<S, P, E, K extends LabCase<P>, A = never> {
  /** The world's id, as models are written for it (e.g. "cells@1"). */
  readonly id: string;
  /** Whether a run of it may be a member of a team (`--team`, SPEC-INVESTIGACION-PARALELA §5). */
  readonly teams?: boolean;
  /** One paragraph for --help: what System 2 perceives and must answer. */
  readonly about: string;
  /** The world's own options and flags. */
  readonly options: readonly LabOption[];
  readonly flags?: readonly LabFlag[];
  /** Defaults of the common options that differ for this world (e.g. { every: '1' }). */
  readonly defaults?: Readonly<Record<string, string>>;
  /** Other names the common options are accepted under (e.g. { 'confirm-setups': 'confirm-places' }). */
  readonly aliases?: Readonly<Record<string, string>>;
  /** Whether the paired regression is on unless --no-regression (true), or off unless --regression (false). */
  readonly regressionByDefault?: boolean;
  /** An environment OUTSIDE the harness, reached over HTTP at this address: the runner gives the laboratory `ctx.effects`. */
  readonly external?: { url(options: LabOptions): string; /** How long one request may take (default 15 s): a simulation can take minutes. */ readonly timeoutMs?: number };
  /** FACETS of the task (SPEC-INVESTIGADOR-ASISTIDO §6.2): what of the world the answer is about, when not all of it is the
      goal. `--focus <id>` picks one at the start (it defines the task, like a level, for either researcher); the assisted
      researcher may be given another during the run. The interface says what counts, the objective checks only that. */
  readonly facets?: readonly { readonly id: string; readonly help: string }[];

  /* --- The world ------------------------------------------------------------------------ */
  generate(seed: number, options: LabOptions): S;
  /** Place `index` of the family of `spec`. */
  placeOf(spec: S, index: number, options: LabOptions): S;
  /** The places to start with, when the laboratory names them (default: lab1, then place1..N of the family). */
  places?(spec: S, ctx: LabContext): { readonly laboratories: readonly { id: string; spec: S }[]; readonly family: readonly { id: string; spec: S }[] };
  /** The places of a blind confirmation set (default: blind1, blind2, ... from index 1000 on). */
  blindPlaces?(spec: S, set: number, round: number, ctx: LabContext): readonly { id: string; spec: S }[];
  /** The journal's name for a run (e.g. "cells-s1L2"). */
  runName(seed: number, options: LabOptions): string;
  /** One line for the console at the start. */
  headline(spec: S): string;
  /** What the journal keeps about a place (operator only). */
  placeInfo(spec: S): Record<string, unknown>;
  /** OPERATOR ONLY, optional: the rule the world was written with, as statements the grader compares with the learner's
      words. Only a world someone wrote has one; without it the learner's recovery is not graded, and nothing else changes. */
  truth?(spec: S, options: LabOptions): readonly { readonly id: string; readonly statement: string }[];
  /** The seed of the environment's exploration episodes. */
  explorationSeed(seed: number, options: LabOptions): number;

  /* --- The senses ----------------------------------------------------------------------- */
  world(): World<P, never>;
  perceive(point: P): unknown;
  readonly perceptDoc: string;
  /** The interface to the common prompt: the objective's lines and the instruments' parameters (and, with a facet, what
      counts). `world`: the run's world options, when its words depend on them (e.g. neutral names). */
  interface(options: { regression?: boolean; focus?: string | null; world?: LabOptions }): WorldInterface;
  /** How a model's answer is read as what is compared with what happened (default: as given). */
  compare?(answer: unknown, state: P): unknown;

  /* --- The episodes --------------------------------------------------------------------- */
  episode(spec: S, rnd: () => number, ctx?: LabContext): E | Promise<E>;
  /** The environment's exploration (default: `explore` episodes of `episode` in the first laboratory). */
  explore?(laboratories: readonly { id: string; spec: S }[], rnd: () => number, count: number, ctx: LabContext): readonly { place: string; episode: E }[] | Promise<readonly { place: string; episode: E }[]>;
  /** The episodes of a check in a place (default: `checkEpisodes` of `episode`, drawn from the runner's seed). */
  checkEpisodes?(spec: S, context: CaseContext, ctx: LabContext): readonly E[] | Promise<readonly E[]>;
  /** How many steps its index shows, and what else the index says of it (e.g. where it started). */
  steps(episode: E): number;
  indexInfo?(episode: E): Record<string, unknown>;
  /** What the journal keeps of an exploration episode (operator only; the viewer reads it). */
  explored(episode: E, place: string): Record<string, unknown>;
  /** The point at a step, with what is shown there next to it (e.g. { the_next_row_was }); null if there is none. */
  at(episode: E, step: number): { readonly state: P; readonly shown: Record<string, unknown> } | null;
  /** The points of an episode a check is made of, in the place it ran in. */
  cases(spec: S, id: string, episode: E, every: number): K[];
  /** Every how many steps the learner's own points are taken (its table, an ablation's fit). */
  readonly ownEvery: number;
  /** Where a draft is tried before anything uses it (default: the learner's latest points), and on how many its answer. */
  readonly trial?: { points(episode: E): P[]; readonly answers: number };
  /** `view`: the steps from..to, as the interface describes them. */
  view(episode: E, from: number, to: number): Record<string, unknown>;
  /** What a table shows next to its value at a case (e.g. { the_next_row_was } or { mark }). */
  shown(c: K): Record<string, unknown>;
  /** Optional: what a table shows of the learner's latest model at a case, from its compared answer (e.g. its residual). */
  residual?(c: K, compared: unknown): Record<string, unknown>;
  /** How `inspect` shows a model's answer and its rules' answers (default: as they are). */
  readonly present?: { answer?(answer: unknown): unknown; rules?(rules: Readonly<Record<string, number>>): unknown };

  /* --- The actions (optional) ----------------------------------------------------------- */
  readonly act?: {
    parse(raw: Record<string, unknown>): A | string;
    /** The place it asks for (default: the first laboratory). */
    place(act: A): string | undefined;
    /** The episode it starts (named `id`), or null when the environment refuses it (never saying why). */
    start(spec: S, act: A, id: string, ctx: LabContext): E | null | Promise<E | null>;
    /** What the learner is shown of the episode it started. */
    shown(episode: E): Record<string, unknown>;
    /** How an act is echoed back in the prompt's words (default: as parsed). */
    asWritten?(act: A): unknown;
    /** Acts of the interface's form the environment accepts in `spec`, one for each kind it has (an intervention among
        them, where there is one): what the instrument's contract runs (SPEC-CALIBRACION-INSTRUMENTOS §3). */
    examples(spec: S): readonly Record<string, unknown>[];
    /** What of the episode an act starts may differ between two runs of it, as its interface tells the learner, or null
        when nothing may (SPEC-CALIBRACION-INSTRUMENTOS I4; default: nothing). */
    varies?(act: A): string | null;
    /** The physical experiment an act asks for, canonical (two acts that differ only in their JSON's order, the defaults
        written out or the cells recorded are the same experiment), comparable with `episodeIdentity`; null when it names
        what this run does not have (SPEC-PRUEBAS-PROPIAS §4.2). */
    identity?(spec: S, act: A): string | null;
  };
  readonly simulate?: {
    /** Why a simulation cannot start at this point, or null. */
    from?(state: P): string | null;
    /** One step: the state after `answer` is taken as what happened, and what is shown of it (with what was seen at
        `step` of the episode); or why it cannot be. */
    step(state: P, answer: unknown, episode: E, step: number): { readonly state: P; readonly shown: Record<string, unknown> } | string;
  };

  /* --- The objective and the operator --------------------------------------------------- */
  objective<M, PL extends Place & { readonly spec: S }>(host: LabObjectiveHost<M, PL, K>, options: LabOptions): Objective<M, PL, unknown, CaseResult>;
  /** How the protocol names places to System 2 (default: the protocol's words). */
  readonly roleWords?: { readonly laboratory: string; readonly validated: string };
  /** Why an answer is not of the form asked, or null. */
  answerIssue(answer: unknown): string | null;
  /** OPERATOR ONLY: whether an answer agrees with what happened at a case (the common Judge ablation), and the word for it.
      A laboratory with an ablation of its own (`operator.ablate`) never has it asked. */
  agrees(answer: unknown, c: K): boolean;
  readonly agreement: string;
  /** OPERATOR ONLY: models that know nothing, as output code. If one holds too, the check could not tell. */
  baselines(spec: S): readonly { readonly name: string; readonly source: string }[];
  /** Explanations the LEARNER may see and name as a rival of its model in a test of its own (SPEC-PRUEBAS-PROPIAS §4.3):
      simple, known ones, as output code - never the operator's baselines. */
  rivals?(spec: S): readonly { readonly name: string; readonly about: string; readonly source: string }[];
  /** The physical experiment an episode of the environment was (its stimuli, interventions and duration, canonical; not what
      was observed of it), comparable with `act.identity`; null when it cannot be said (SPEC-PRUEBAS-PROPIAS §4.2). */
  episodeIdentity?(spec: S, episode: E): string | null;
  /** OPERATOR ONLY, with a `truth`: the grader's system prompt, the journal event its grade goes to, and what the
      learner's final model is called there. */
  readonly grading?: { readonly system: string; readonly event?: string; readonly finalKey?: string;
    /** When the learner was given names of its own for the world's things: what each is (kept with the truth, and given
        to the grader as `learner_names`). */
    glossary?(spec: S, options: LabOptions): Readonly<Record<string, string>> };
  /** OPERATOR ONLY: measures of the laboratory's own, in place of or besides the common ones. */
  readonly operator?: {
    /** What the journal's hidden part and its start keep besides the common. */
    hidden?(spec: S, ctx: LabContext): Record<string, unknown>;
    start?(spec: S, ctx: LabContext): Record<string, unknown>;
    /** What a check's event keeps besides the common, and a line for the console; `detail` is the objective's own
        result for the first laboratory; `test` is kept on the law's record (the end's final and best). */
    check?(c: { readonly law: unknown; readonly round: number; readonly reused: number | null; readonly detail: unknown; readonly cost: Readonly<Record<string, number>>; readonly cases: readonly K[] },
      o: LabOperatorContext<S, K>): { journal?: Record<string, unknown>; say?: string; test?: Record<string, number> };
    /** The Judge ablation, in place of the common one (every rule at 0.5, `agrees`). Null: nothing was ablated. */
    ablate?(c: { readonly law: unknown; readonly round: number; readonly detail: unknown; readonly cases: readonly K[] }, o: LabOperatorContext<S, K>): Promise<AblationRecord | null>;
    /** Whether its ablation runs even with --no-ablation (e.g. an arm asked for by a flag). */
    ablates?(options: LabOptions): boolean;
    /** What the end keeps besides the common: `records` are the laws proposed, with what `check` kept of each. */
    end?(records: readonly { round: number; fingerprint: string; test: Record<string, number> | null }[], o: LabOperatorContext<S, K>): Record<string, unknown>;
  };
}

/* ============================================================================
 * A laboratory with a LOOP OF ITS OWN (the grid): its model is not a law whose answers are
 * compared with what happened, but a formula a search plays with; its instruments, its
 * check and its curriculum are its own. It declares its options and its tools, and runs
 * with the SERVICES every laboratory shares: the command line, System 2 and the Judge with
 * their answers logged (so the run can be stopped and resumed), the journal, the budgets,
 * the finding. What System 2 sees in it is its own, unchanged.
 * ========================================================================== */

/** The common configuration, as the command line gave it. */
export interface LabRunConfig {
  readonly seed: number;
  readonly attempts: number;
  readonly explore: number;
  readonly steps: number;
  readonly family: number;
  readonly validations: number;
  readonly confirmPlaces: number;
  readonly regression: boolean;
  readonly tools: readonly string[];
  readonly quick: boolean;
  readonly ablation: boolean;
  readonly grade: boolean;
  readonly reflection: boolean;
  readonly flat: boolean;
}

/** What the runner gives a laboratory with a loop of its own. */
export interface LabServices {
  readonly cfg: LabRunConfig;
  readonly options: LabOptions;
  /** System 2 (its answers logged for --resume) and what it has cost. */
  readonly llm: import('./system2.ts').ChatClient;
  readonly llmUse: { readonly calls: number; readonly tokens: number };
  /** The Judge (the flat one with --flat; its answers logged for --resume). */
  readonly judge: import('../core/jev.ts').JevJudge;
  /** A runner for the learner's code. */
  codeRunner(): import('../core/types.ts').CodeRunner;
  /** The journal (the laboratory adds its hidden part and its objective) and its events. */
  readonly journal: Record<string, any>;
  log(type: string, data?: Record<string, unknown>): void;
  say(text: string): void;
  /** Asked before each question to System 2: a reason to stop now (cancelled, a budget spent), or null. */
  halt(): string | null;
  /** The assisted researcher (SPEC-INVESTIGADOR-ASISTIDO), absent for the unknown-world one: `llm` then carries the operator's
      messages; `memory`, whether it has a selective memory (§13), and the Judge as the selector of its `find`. */
  readonly assisted?: { readonly memory: boolean; readonly selector?: import('./assisted/sources.ts').LineSelector;
    /** The records of earlier runs it may read (SPEC-INVESTIGADOR-ASISTIDO §12), and in which mode the operator gave them. */
    readonly experience?: { readonly reader: import('./assisted/experience.ts').Experience; readonly mode: import('./assisted/experience.ts').ExperienceMode; readonly scope: import('./assisted/experience.ts').ExperienceScope } };
  /** The assisted researcher's opening (SPEC-ORQUESTADOR §3.3.4): waits, after the first episodes, for its senior's first
      hypothesis (when the run was told to); it goes with the first question. */
  awaitOpening?(): Promise<void>;
  /** A continuation (`--resume <journal> --attempts N`): the attempts after which the run's history had an ending - its
      reflection and its grading, replayed where they were before the rounds it was given since. */
  readonly endings?: readonly number[];
  /** A member of a team (SPEC-INVESTIGACION-PARALELA §5): the team's board, its id there, and its reader of the board
      (reads through the run's log, channel "peer"). The runner ends it on the board when the run ends. */
  readonly team?: { readonly board: import('./assisted/board.ts').TeamBoard; readonly member: string; readonly channel: import('./assisted/board.ts').PeerChannel };
}

/** What a loop of its own ends with: why, and what the journal's end keeps besides the common. `final` is the model the
    finding reports (in the learner's own words). */
export interface LabRunEnd {
  readonly stoppedBy: string;
  readonly halted?: string | null;
  readonly end: Record<string, unknown>;
}

export interface GameLab {
  readonly kind: 'game';
  readonly id: string;
  readonly about: string;
  readonly options: readonly LabOption[];
  readonly flags?: readonly LabFlag[];
  readonly defaults?: Readonly<Record<string, string>>;
  readonly aliases?: Readonly<Record<string, string>>;
  readonly regressionByDefault?: boolean;
  /** Its instruments, as --tools names them. */
  readonly tools: readonly string[];
  /** Its options that are help, only the assisted researcher takes (given another value than their default). */
  readonly assistedOptions?: readonly string[];
  /** Whether a run of it may be a member of a team (`--team`, SPEC-INVESTIGACION-PARALELA §5). */
  readonly teams?: boolean;
  runName(seed: number, options: LabOptions): string;
  run(services: LabServices): Promise<LabRunEnd>;
}

/** Why an act carrying a field its world does not know is not read (SPEC-CALIBRACION-INSTRUMENTOS I2), or null: accepted
    and ignored, the learner would believe it changed what was never changed. `what` names the object (e.g. "a stimulus"). */
export function unknownFields(raw: Readonly<Record<string, unknown>>, fields: readonly string[], what = 'act'): string | null {
  const unknown = Object.keys(raw).filter((k) => !fields.includes(k));
  return unknown.length ? what + ' has no field ' + unknown.map((k) => '"' + k + '"').join(', ') + ': its fields are ' + fields.join(', ') : null;
}

/** Any laboratory, for code that runs one without knowing its types. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LawLab = Lab<any, any, any, any, any>;
export type AnyLab = LawLab | GameLab;
export const isGameLab = (lab: AnyLab): lab is GameLab => (lab as GameLab).kind === 'game';

/** The grader's system prompt for a hidden RULE (cells, messages): who the learner was and how to read its model. */
export function ruleGradingSystem(subject: string, reading: string): string {
  return 'You grade how well a learner recovered the hidden rule ' + subject + '. '
    + 'For each TRUE statement, decide from the learner\'s own model and words whether it stated it: "exact", "partial" (the right idea but incomplete), "wrong" (it contradicts it) or "absent". '
    + reading + ' Judge what it holds, not what it dropped. Quote the learner briefly as evidence. '
    + GRADING_STRUCTURE + ' '
    + 'Answer JSON: {"grades": [{"id": ..., "grade": "exact"|"partial"|"wrong"|"absent", "evidence": ...}], "false_beliefs": [claims of the learner that a true statement contradicts], "form": "compact"|"table"|"mixed", "form_evidence": ...}';
}
