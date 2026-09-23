import { clamp, round } from './hash.ts';
import { ApiError } from './net.ts';
import { defaultTerminalValue, type Evaluation, type Evaluator } from './evaluate.ts';
import type { Formula, World } from './types.ts';

/* ============================================================================
 * Search over any World.
 *
 * Two profiles, ported from the harness:
 *   learning-fanout     every legal move of the maximizer at the root is launched at
 *                       once (Promise.all); nothing is pruned, because every judged
 *                       leaf is evidence for the learner.
 *   play-pv-alpha-beta  principal child first to set the window, then speculative
 *                       batches; siblings not yet started are skipped once the window
 *                       closes. Exact with respect to the frozen leaf scalar.
 *
 * Opponent: with `respond` (a deterministic model) the opponent's node has ONE child,
 * the move it will actually play; without it the opponent is adversarial (worst case).
 * A policy prior only ORDERS moves; no legal move is ever removed. Confidence is
 * evidence for the learner, never an alpha-beta bound.
 *
 * The engine runs on a SearchContext the caller may own and extend (a host keeps its
 * own bookkeeping on it) and reports through `SearchHooks`: the host decides how a leaf
 * is valued (default: Eval through an Evaluator) and observes every event.
 * ========================================================================== */

export const LEARNING_FANOUT = 'learning-fanout';
export const PLAY_PV_ALPHA_BETA = 'play-pv-alpha-beta';
export type SearchProfile = typeof LEARNING_FANOUT | typeof PLAY_PV_ALPHA_BETA;

export const TT_EXACT = 'exact';
export const TT_LOWER = 'lower';
export const TT_UPPER = 'upper';
export type Bound = typeof TT_EXACT | typeof TT_LOWER | typeof TT_UPPER;

export interface PathStep<S, A> { readonly state: S; readonly move: A }

export interface SearchNode<A> {
  value: number;
  pvConfidence: number | null;
  calibrated: number | null;
  bestMove: A | null;
  line: A[];
  samples: number[];
  /** The rules (not a judgment) fixed this value. */
  certain: boolean;
  terminal: boolean;
  depth: number;
  exact: boolean;
  ttBound?: Bound;
  source: string;
  [extra: string]: unknown;
}

export interface SearchContext<A> {
  /** Depth of this pass (the root's remaining depth). */
  depth: number;
  rootDepth: number;
  searchProfile: SearchProfile;
  parallelBatch: number;
  pruningBatch: number;
  policyDepth: number;
  signal: AbortSignal | null;
  tt: Map<string, SearchNode<A>>;
  valueHints: Map<string, number>;
  hintLine: A[];
  nodes: number;
  leafEvals: number;
  prunes: number;
  rootFanoutWidth: number;
  startedAt: number;
  [extra: string]: unknown;
}

export interface SearchEvents {
  node?(): void;
  transpositionHit?(): void;
  transpositionBoundHit?(): void;
  rootFanout?(width: number): void;
  pvPass?(): void;
  pvFirstBranch?(): void;
  prune?(remaining: number, certain: boolean): void;
}

export interface SearchHooks<S, A> {
  readonly world: World<S, A>;
  readonly maximizer: string;
  /** Values a non-terminal state at depth 0. */
  leaf(state: S, ctx: SearchContext<A>, path: ReadonlyArray<PathStep<S, A>>): Promise<SearchNode<A>>;
  /** A distribution over action keys that orders the moves (within ctx.policyDepth of the root). */
  prior?(state: S, ctx: SearchContext<A>): Promise<Readonly<Record<string, number>> | null>;
  /** The deterministic opponent's one reply; absent (or returning null) = adversarial node. */
  respond?(state: S, ctx: SearchContext<A>): A | null;
  /** Transposition key (default: world key + depth). */
  keyOf?(state: S, depth: number, ctx: SearchContext<A>): string;
  readonly events?: SearchEvents;
}

const clock = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function createSearchContext<A>(options: {
  depth: number; rootDepth?: number; searchProfile?: SearchProfile; parallelBatch?: number; pruningBatch?: number;
  policyDepth?: number; signal?: AbortSignal | null; hintLine?: A[];
}): SearchContext<A> {
  return {
    depth: options.depth,
    rootDepth: options.rootDepth ?? options.depth,
    searchProfile: options.searchProfile ?? LEARNING_FANOUT,
    parallelBatch: Math.max(1, options.parallelBatch ?? 8),
    pruningBatch: Math.max(1, options.pruningBatch ?? 2),
    policyDepth: clamp(options.policyDepth ?? 1, 0, 3),
    signal: options.signal ?? null,
    tt: new Map(),
    valueHints: new Map(),
    hintLine: options.hintLine ? options.hintLine.slice() : [],
    nodes: 0,
    leafEvals: 0,
    prunes: 0,
    rootFanoutWidth: 0,
    startedAt: clock()
  };
}

/** Worst-case-weighted confidence of a line: the least trustworthy sample dominates. */
export function calibrateConfidence(samples: readonly number[], depthRemaining: number): number | null {
  const usable = (samples || []).filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (!usable.length) return null;
  const floor = Math.min(...usable);
  const avg = usable.reduce((a, b) => a + b, 0) / usable.length;
  const penalty = 1 - 0.02 * Math.max(0, depthRemaining || 0);
  return round(clamp((0.65 * floor + 0.35 * avg) * penalty, 0, 1), 4);
}

/** A cut node is only a proof about one edge of the window: it never overwrites an exact value. */
export function storeTransposition<A>(ctx: SearchContext<A>, key: string, node: SearchNode<A>): SearchNode<A> {
  const previous = ctx.tt.get(key);
  if (previous) {
    if (previous.ttBound === TT_EXACT && node.ttBound !== TT_EXACT) return previous;
    if (previous.ttBound === node.ttBound && node.ttBound === TT_LOWER && previous.value >= node.value) return previous;
    if (previous.ttBound === node.ttBound && node.ttBound === TT_UPPER && previous.value <= node.value) return previous;
  }
  ctx.tt.set(key, node);
  return node;
}

export function probeTransposition<A>(ctx: SearchContext<A>, key: string, alpha: number, beta: number, events?: SearchEvents):
  { hit: boolean; alpha: number; beta: number; result: SearchNode<A> | null } {
  const cached = ctx.tt.get(key);
  if (!cached) return { hit: false, alpha, beta, result: null };
  events?.transpositionHit?.();
  if (cached.ttBound === TT_EXACT || cached.exact === true) return { hit: true, alpha, beta, result: cached };
  if (cached.ttBound === TT_LOWER) alpha = Math.max(alpha, cached.value);
  else if (cached.ttBound === TT_UPPER) beta = Math.min(beta, cached.value);
  events?.transpositionBoundHit?.();
  return { hit: true, alpha, beta, result: alpha >= beta ? cached : null };
}

export function siblingBatchWidth<S, A>(state: S, depth: number, moves: readonly A[], ctx: SearchContext<A>, hooks: Pick<SearchHooks<S, A>, 'world' | 'maximizer'>): number {
  const count = Math.max(1, (moves || []).length);
  if (ctx.searchProfile === PLAY_PV_ALPHA_BETA) return Math.max(1, Math.min(count, ctx.pruningBatch));
  if (hooks.world.toMove(state) === hooks.maximizer && depth === ctx.rootDepth) return count;
  return Math.max(1, Math.min(count, ctx.parallelBatch));
}

/** Order without any local heuristic: the Judge's prior, the previous PV, finished lines, then known values. */
export function orderMoves<S, A>(state: S, moves: A[], ctx: SearchContext<A>, prior: Readonly<Record<string, number>> | null,
  hooks: Pick<SearchHooks<S, A>, 'world' | 'maximizer'>): A[] {
  const world = hooks.world;
  const hintRank = new Map<string, number>();
  (ctx.hintLine || []).forEach((m, i) => hintRank.set(world.actionKey(m), i));
  const maximizing = world.toMove(state) === hooks.maximizer;
  const scored = moves.map((move, index) => {
    const child = world.step(state, move);
    const key = world.actionKey(move);
    const known = ctx.valueHints ? ctx.valueHints.get(world.key(child)) : undefined;
    const p = prior ? prior[key] : undefined;
    return {
      move, index,
      policy: typeof p === 'number' ? p : null,
      hint: hintRank.get(key) ?? Number.MAX_SAFE_INTEGER,
      terminalFirst: world.outcome(child).over ? 1 : 0,
      value: typeof known === 'number' ? known : null
    };
  });
  scored.sort((a, b) => {
    if (a.policy !== null && b.policy !== null && a.policy !== b.policy) return b.policy - a.policy;
    if ((a.policy === null) !== (b.policy === null)) return a.policy === null ? 1 : -1;
    if (a.hint !== b.hint) return a.hint - b.hint;
    if (a.terminalFirst !== b.terminalFirst) return b.terminalFirst - a.terminalFirst;
    if (a.value !== null && b.value !== null && a.value !== b.value) return maximizing ? b.value - a.value : a.value - b.value;
    return a.index - b.index;
  });
  return scored.map((s) => s.move);
}

export async function minimax<S, A>(hooks: SearchHooks<S, A>, ctx: SearchContext<A>, state: S, depth: number,
  alpha: number, beta: number, path: ReadonlyArray<PathStep<S, A>>): Promise<SearchNode<A>> {
  const world = hooks.world;
  const events = hooks.events;
  ctx.nodes++;
  events?.node?.();
  if (ctx.signal?.aborted) throw new ApiError('aborted', 'Search aborted.');
  const stateId = world.key(state);
  const key = hooks.keyOf ? hooks.keyOf(state, depth, ctx) : stateId + '|d' + depth;
  const outcome = world.outcome(state);
  if (outcome.over) {
    const sunk: SearchNode<A> = {
      value: defaultTerminalValue(world, outcome, hooks.maximizer), pvConfidence: 1, calibrated: 1, bestMove: null, line: [],
      samples: [1], certain: true, terminal: true, depth: 0, exact: true, ttBound: TT_EXACT, source: 'terminal'
    };
    storeTransposition(ctx, key, sunk);
    ctx.valueHints.set(stateId, sunk.value);
    return sunk;
  }
  const probe = probeTransposition(ctx, key, alpha, beta, events);
  alpha = probe.alpha;
  beta = probe.beta;
  if (probe.result) return probe.result;

  if (depth <= 0) {
    ctx.leafEvals++;
    const leaf = await hooks.leaf(state, ctx, path);
    leaf.ttBound = TT_EXACT;
    storeTransposition(ctx, key, leaf);
    return leaf;
  }

  const maximizing = world.toMove(state) === hooks.maximizer;
  const withinPolicy = ctx.policyDepth > 0 && ctx.rootDepth - depth < ctx.policyDepth;
  const prior = withinPolicy && hooks.prior ? await hooks.prior(state, ctx) : null;
  let legal = world.actions(state);
  if (!maximizing && hooks.respond && legal.length > 1) {
    const predicted = hooks.respond(state, ctx);
    if (predicted) legal = [predicted];
  }
  const moves = orderMoves(state, legal, ctx, prior, hooks);
  const pruning = ctx.searchProfile === PLAY_PV_ALPHA_BETA;
  const batchWidth = siblingBatchWidth(state, depth, moves, ctx, hooks);
  if (!pruning && maximizing && depth === ctx.rootDepth && moves.length > 1) {
    ctx.rootFanoutWidth = moves.length;
    events?.rootFanout?.(moves.length);
  }
  if (pruning && depth === ctx.rootDepth) events?.pvPass?.();

  let best: SearchNode<A> | null = null;
  let a = alpha, b = beta, cut = false;
  for (let i = 0; i < moves.length;) {
    if (ctx.signal?.aborted) throw new ApiError('aborted', 'Search aborted.');
    const width = pruning && i === 0 ? 1 : batchWidth;
    const batch = moves.slice(i, i + width);
    if (pruning && i === 0 && moves.length > 1) events?.pvFirstBranch?.();
    const children = await Promise.all(batch.map((move) => {
      const child = world.step(state, move);
      return minimax(hooks, ctx, child, depth - 1, a, b, path.concat([{ state: child, move }]));
    }));
    children.forEach((child, j) => {
      if (best === null || (maximizing ? child.value > best.value : child.value < best.value)) {
        best = {
          value: child.value, pvConfidence: child.pvConfidence, calibrated: child.calibrated, certain: child.certain === true,
          source: child.source, depth: child.depth, bestMove: batch[j], line: [batch[j], ...child.line],
          samples: child.samples.slice(), terminal: false, exact: true
        };
      }
      if (maximizing) a = Math.max(a, best!.value);
      else b = Math.min(b, best!.value);
    });
    i += batch.length;
    const remaining = moves.length - i;
    if (pruning && a >= b && remaining > 0 && best) {
      ctx.prunes++;
      events?.prune?.(remaining, (best as SearchNode<A>).certain === true);
      cut = true;
      break;
    }
  }

  if (best === null) {
    /* No legal move and not finished: a neutral value fixed by the rules, never a judgment. */
    const stalled: SearchNode<A> = {
      value: 0.5, pvConfidence: 0.5, calibrated: 0.5, bestMove: null, line: [], samples: [0.5], certain: true,
      terminal: false, depth, exact: true, ttBound: TT_EXACT, source: 'stalemate'
    };
    storeTransposition(ctx, key, stalled);
    return stalled;
  }
  const chosen = best as SearchNode<A>;
  const node: SearchNode<A> = {
    value: round(chosen.value, 4),
    pvConfidence: chosen.pvConfidence === null ? null : round(chosen.pvConfidence, 4),
    calibrated: calibrateConfidence(chosen.samples, ctx.depth - depth + 1),
    bestMove: chosen.bestMove, line: chosen.line, samples: chosen.samples, certain: chosen.certain === true,
    terminal: false, depth, exact: !cut, ttBound: cut ? (maximizing ? TT_LOWER : TT_UPPER) : TT_EXACT, source: 'search'
  };
  storeTransposition(ctx, key, node);
  ctx.valueHints.set(stateId, node.value);
  return node;
}

/* --- The convenience entry point: iterative deepening with Eval leaves ---- */

export interface LeafRecord<S, A> {
  readonly state: S;
  readonly path: ReadonlyArray<PathStep<S, A>>;
  readonly evaluation: Evaluation;
}

export interface SearchOptions<S, A> {
  readonly formula: Formula;
  readonly depth: number;
  /** Deterministic opponent model. Absent => adversarial opponent. */
  readonly respond?: (state: S) => A | null;
  readonly profile?: SearchProfile;
  readonly parallelBatch?: number;
  readonly pruningBatch?: number;
  readonly policyDepth?: number;
  readonly signal?: AbortSignal;
  /** Every judged leaf with the line that reached it (the learner's evidence). */
  readonly onLeaf?: (leaf: LeafRecord<S, A>) => void;
  readonly events?: SearchEvents;
}

export interface SearchStats {
  nodes: number;
  leaves: number;
  prunes: number;
  skipped: number;
  ttHits: number;
  ttBoundHits: number;
  rootFanout: number;
  priorCalls: number;
}

export interface SearchPass<A> {
  readonly depth: number;
  readonly result: SearchNode<A>;
  readonly stats: SearchStats;
  readonly ctx: SearchContext<A>;
  readonly elapsedMs: number;
}

export interface SearchResult<A> {
  readonly best: SearchNode<A>;
  readonly passes: SearchPass<A>[];
}

/** The hooks that value leaves with Eval(formula, s) through an Evaluator. `stats.current` is the pass being counted. */
export function evaluatorHooks<S, A>(evaluator: Evaluator<S>, options: SearchOptions<S, A>, stats: { current: SearchStats }): SearchHooks<S, A> {
  const world = evaluator.world as unknown as World<S, A>;
  const user = options.events;
  return {
    world,
    maximizer: evaluator.maximizer,
    async leaf(state, ctx, path) {
      stats.current.leaves++;
      const evaluation = await evaluator.eval(options.formula, state, ctx.signal ?? undefined);
      options.onLeaf?.({ state, path, evaluation });
      const confidence = evaluation.confidence === null ? null : round(clamp(evaluation.confidence, 0, 1), 4);
      return {
        value: round(clamp(evaluation.value, 0, 1), 4), pvConfidence: confidence, calibrated: confidence, bestMove: null, line: [],
        samples: confidence === null ? [] : [confidence], certain: false, terminal: false, depth: 0, exact: true, source: evaluation.provenance
      };
    },
    async prior(state, ctx) {
      const merge = await evaluator.prior(options.formula, state, ctx.signal ?? undefined);
      if (merge) stats.current.priorCalls++;
      return merge ? merge.prior : null;
    },
    respond: options.respond ? (state) => options.respond!(state) : undefined,
    events: {
      node: () => { stats.current.nodes++; user?.node?.(); },
      transpositionHit: () => { stats.current.ttHits++; user?.transpositionHit?.(); },
      transpositionBoundHit: () => { stats.current.ttBoundHits++; user?.transpositionBoundHit?.(); },
      rootFanout: (w) => { stats.current.rootFanout = w; user?.rootFanout?.(w); },
      pvPass: () => user?.pvPass?.(),
      pvFirstBranch: () => user?.pvFirstBranch?.(),
      prune: (remaining, certain) => { stats.current.prunes++; stats.current.skipped += remaining; user?.prune?.(remaining, certain); }
    }
  };
}

/** Iterative deepening over caller-supplied hooks: each pass is ordered by the previous pass's PV. */
export async function deepen<S, A>(hooks: SearchHooks<S, A>, state: S, options: {
  depth: number;
  makeContext: (passDepth: number, hintLine: A[]) => SearchContext<A>;
  onPass?: (pass: { depth: number; result: SearchNode<A>; ctx: SearchContext<A> }) => void;
}): Promise<{ result: SearchNode<A>; ctx: SearchContext<A> }> {
  const maxDepth = clamp(Math.round(options.depth), 1, 12);
  let outcome: { result: SearchNode<A>; ctx: SearchContext<A> } | null = null;
  let hintLine: A[] = [];
  for (let depth = 1; depth <= maxDepth; depth++) {
    const ctx = options.makeContext(depth, hintLine);
    const result = await minimax(hooks, ctx, state, depth, -Infinity, Infinity, []);
    outcome = { result, ctx };
    options.onPass?.({ depth, result, ctx });
    hintLine = result.line.slice();
    if (ctx.signal?.aborted) break;
  }
  return outcome!;
}

const newStats = (): SearchStats => ({ nodes: 0, leaves: 0, prunes: 0, skipped: 0, ttHits: 0, ttBoundHits: 0, rootFanout: 0, priorCalls: 0 });

/** The library entry point: iterative deepening, leaves valued by Eval(formula, s). */
export async function searchBestMove<S, A>(evaluator: Evaluator<S>, state: S, options: SearchOptions<S, A>): Promise<SearchResult<A>> {
  const profile: SearchProfile = options.profile ?? (options.respond ? LEARNING_FANOUT : PLAY_PV_ALPHA_BETA);
  const passes: SearchPass<A>[] = [];
  const stats = { current: newStats() };
  await deepen(evaluatorHooks<S, A>(evaluator, options, stats), state, {
    depth: options.depth,
    makeContext: (depth, hintLine) => {
      stats.current = newStats();
      return createSearchContext<A>({ depth, rootDepth: depth, searchProfile: profile, parallelBatch: options.parallelBatch,
        pruningBatch: options.pruningBatch, policyDepth: options.policyDepth, signal: options.signal ?? null, hintLine });
    },
    onPass: ({ depth, result, ctx }) => passes.push({ depth, result, ctx, stats: stats.current, elapsedMs: Math.round(clock() - ctx.startedAt) })
  });
  return { best: passes[passes.length - 1].result, passes };
}
