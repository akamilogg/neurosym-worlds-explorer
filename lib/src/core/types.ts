/* ============================================================================
 * The contracts of the library. Seven pieces, and only ONE of them knows the domain:
 *
 *   World     the rules of an environment (states, actors, actions, outcome) and a
 *             plain-data VIEW of each state. The only domain-specific piece.
 *   Observer  O(s): executes declared measures over (view, state, world). Two kinds:
 *               "code" - a function in a host language (Eval mode)
 *               "dsl"  - core@1 or a dialect registered by the experiment designer
 *   Judge     r_i(O(s)) in [0,1]: the semantic System 1 (Jev). It reads the measured
 *             facts through human-language rules; that is what keeps the mechanism legible.
 *   Composer  V(s) = SUM w_i * r_i, in code.
 *   (Actor, Truth, Learner live on top of these and are extracted in later phases.)
 *
 * The learned artifact is a Formula: plain JSON, portable to any host that registers
 * the measure kinds it declares. A host refuses - with a reason - what it cannot run.
 * ========================================================================== */

export type Scalar = number | string | boolean;

/** One thing in the world, as plain data. `type` groups entities (e.g. "cat", "mouse"). */
export interface Entity {
  readonly type: string;
  readonly id: string | number;
  readonly [attribute: string]: Scalar;
}

/** Everything a measure may read about a state without knowing the host's state shape. */
export interface View {
  readonly entities: ReadonlyArray<Entity>;
  readonly scalars: Readonly<Record<string, Scalar>>;
}

export interface Outcome {
  readonly over: boolean;
  readonly winner: string | null;
  readonly reason: string | null;
}

/** The rules of an environment. Pure functions: a state is never mutated. */
export interface World<S = unknown, A = unknown> {
  readonly id: string;
  readonly actors: readonly string[];
  initial(options?: Record<string, unknown>): S;
  toMove(state: S): string;
  actions(state: S, actor?: string): A[];
  step(state: S, action: A): S;
  /** A side with no legal action passes, when the world allows it. */
  pass?(state: S): S;
  outcome(state: S): Outcome;
  /** Canonical identity of a state (transpositions, caches). */
  key(state: S): string;
  view(state: S): View;
  /** Value of a finished state for `maximizer`: 1 won, 0 lost, 0.5 otherwise. Default derives it from outcome(). */
  terminalValue?(outcome: Outcome, maximizer: string): number;
  /** Human-language rules: what the Judge and System 2 read. */
  describeRules(): string;
  /** Canonical identity of an action: the option key of a policy question, the PV hint key. */
  actionKey(action: A): string;
  describeAction?(action: A): string;
  /** The full position as the Judge may read it (only sent when a question needs the board itself). */
  describeState?(state: S): Record<string, unknown>;
}

/* --- Measures ------------------------------------------------------------ */

export interface CodeSpec {
  readonly kind: 'code';
  /** Host language tag, e.g. "js". A host without a runner for it refuses the measure. */
  readonly lang: string;
  /** A function expression: `(ctx) => number` or `function (ctx) { ... }`. */
  readonly source: string;
}

export interface DslSpec {
  readonly kind: 'dsl';
  /** "core@1" or a designer dialect such as "foxhounds@1". */
  readonly dialect: string;
  /** Named-op dialects: the op and its arguments. */
  readonly op?: unknown;
  readonly args?: unknown;
  /** Expression dialects (core@1): the AST. */
  readonly expr?: unknown;
}

export type MeasureSpec = CodeSpec | DslSpec;
export type MeasureKind = MeasureSpec['kind'];

export interface MeasureDecl {
  readonly name?: string;
  /** Reproducible human definition: the Judge and the reader rely on it. */
  readonly definition?: string;
  readonly spec: MeasureSpec;
  /** Declared [min, max]. Required for code and expressions; op dialects bring their own. */
  readonly range?: readonly [number, number];
}

/** What a compiled measure receives. `state` is frozen; `world` exposes the rules only. */
export interface MeasureContext<S = unknown> {
  readonly view: View;
  readonly state: S;
  readonly world: World<S>;
}

export type MeasureFn<S = unknown> = (ctx: MeasureContext<S>) => number;

export type Compiled<S = unknown> =
  | { ok: true; kind: MeasureKind; fn: MeasureFn<S>; range: readonly [number, number] | null; hash: string; warnings: string[] }
  | { ok: false; kind: string | null; error: string; hash: string };

/** A designer vocabulary. `compile` turns the dialect's payload into a measure function. */
export interface Dialect {
  readonly id: string;
  /** Worlds this dialect understands; absent = any world. */
  readonly worlds?: readonly string[];
  /** Human/LLM-facing documentation of the vocabulary. */
  describe(): string;
  compile(spec: DslSpec, env: CompileEnv): Compiled;
}

/** Runs source code of one language as a measure function. */
export interface CodeRunner {
  readonly lang: string;
  compile(source: string): MeasureFn;
}

/** What a dialect may use while compiling: other dialects (core@1 can call named ops). */
export interface CompileEnv {
  resolve(spec: MeasureSpec, range?: readonly [number, number]): Compiled;
}

/* --- The Judge (System 1) ----------------------------------------------- */

export type QuestionType = 'choice' | 'score' | 'noul';
export type QuestionRole = 'value' | 'policy';

/** A human-language rule. `{{id}}` in the texts becomes the measured value of observation `id`. */
export interface Rule {
  readonly type: QuestionType;
  readonly used_as?: QuestionRole;
  /** For choice questions: the option whose probability is the rule's value. */
  readonly option?: string;
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string | null>> | readonly string[];
  /** Policy rules: whose actions are the options ("side_to_move" or an actor id). */
  readonly subject?: string;
  /** Policy rules: how several policy rules merge ("single" | "weighted_mean"). */
  readonly aggregate?: string;
  readonly [extra: string]: unknown;
}

export interface JudgeRequest {
  readonly world: string;
  readonly rulesOfTheWorld: string;
  readonly sideToMove: string;
  readonly measurements: Readonly<Record<string, number>>;
  /** The rules with every {{id}} already replaced by its measured value. Policy rules arrive
      materialised: one criterion per legal action key, each with a null rubric. */
  readonly questions: Readonly<Record<string, Rule>>;
  /** Present only when a question denotes concrete actions: the Judge then needs the position itself.
      Value-only requests are judged from the measurements alone (that is what makes the vector cache valid). */
  readonly position?: Readonly<Record<string, unknown>>;
  readonly context?: Readonly<Record<string, unknown>>;
}

export interface JudgeAnswer {
  /** The rule's value in [0,1]. For a policy rule: the probability of its argmax. */
  readonly value: number;
  readonly confidence: number | null;
  /** Policy rules: probability per action key. */
  readonly distribution?: Readonly<Record<string, number>>;
  readonly raw?: unknown;
}

export interface Judge {
  readonly id: string;
  judge(request: JudgeRequest, signal?: AbortSignal): Promise<Record<string, JudgeAnswer>>;
}

/* --- The artifact --------------------------------------------------------- */

export const FORMULA_FORMAT = 'neurosym.formula';
export const FORMULA_FORMAT_VERSION = 1;

export interface Formula {
  readonly format: typeof FORMULA_FORMAT;
  readonly format_version: number;
  /** World id the formula was learned in, e.g. "foxhounds@1". */
  readonly world: string;
  /** O(s): what is measured, and how. */
  readonly observations: Readonly<Record<string, MeasureDecl>>;
  /** r_i: what Jev is asked about the measured facts. */
  readonly rules: Readonly<Record<string, Rule>>;
  /** w_i over the VALUE rules. */
  readonly weights: Readonly<Record<string, number>>;
  readonly policy_weights?: Readonly<Record<string, number>>;
  readonly confidence_floor?: number;
  /** Bookkeeping: never part of the formula's identity. */
  readonly meta?: Readonly<Record<string, unknown>>;
}
