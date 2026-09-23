import { clamp, round } from './hash.ts';
import { defaultTerminalValue, type Evaluation, type Evaluator } from './evaluate.ts';
import type { Formula } from './types.ts';

/* ============================================================================
 * Search over any World, valuing leaves ONLY through Eval(formula, s).
 *
 * Two profiles, ported from the harness:
 *   learning-fanout     every legal move of the maximizer at the root is launched at
 *                       once (Promise.all); nothing is pruned, because every judged
 *                       leaf is evidence for the learner.
 *   play-pv-alpha-beta  principal child first to set the window, then speculative
 *                       batches; siblings not yet started are skipped once the window
 *                       closes. Exact with respect to the frozen scalar Eval(R, s).
 *
 * Opponent: with `respond` (a deterministic model) the opponent's node has ONE child,
 * the move it will actually play; without it the opponent is adversarial (worst case).
 * The Judge's policy prior only ORDERS moves; no legal move is ever removed.
 * Confidence is evidence for the learner, never an alpha-beta bound.
 * ========================================================================== */

export const LEARNING_FANOUT = 'learning-fanout';
export const PLAY_PV_ALPHA_BETA = 'play-pv-alpha-beta';
export type SearchProfile = typeof LEARNING_FANOUT | typeof PLAY_PV_ALPHA_BETA;

const EXACT = 'exact', LOWER = 'lower', UPPER = 'upper';
type Bound = typeof EXACT | typeof LOWER | typeof UPPER;

export interface PathStep<S, A> { readonly state: S; readonly move: A }

export interface LeafRecord<S, A> {
  readonly state: S;
  readonly path: ReadonlyArray<PathStep<S, A>>;
  readonly evaluation: Evaluation;
}

export interface SearchNode<A> {
  value: number;
  confidence: number | null;
  calibrated: number | null;
  bestMove: A | null;
  line: A[];
  samples: number[];
  /** The rules (not a judgment) fixed this value. */
  certain: boolean;
  terminal: boolean;
  depth: number;
  exact: boolean;
  bound: Bound;
  source: 'terminal' | 'stalemate' | 'leaf' | 'search';
}

export interface SearchOptions<S, A> {
  readonly formula: Formula;
  readonly depth: number;
  /** Deterministic opponent model. Absent => adversarial opponent. */
  readonly respond?: (state: S) => A | null;
  readonly profile?: SearchProfile;
  /** Inner-level sibling batch in learning (default 8). */
  readonly parallelBatch?: number;
  /** Speculative sibling batch after the principal child in play (default 2). */
  readonly pruningBatch?: number;
  /** Levels from the root that ask the Judge for a policy prior (default 1; 0 = off). */
  readonly policyDepth?: number;
  readonly signal?: AbortSignal;
  /** Every judged leaf with the line that reached it (the learner's evidence). */
  readonly onLeaf?: (leaf: LeafRecord<S, A>) => void;
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
  readonly elapsedMs: number;
}

export interface SearchResult<A> {
  readonly best: SearchNode<A>;
  readonly passes: SearchPass<A>[];
}

const clock = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Worst-case-weighted confidence of a line: the least trustworthy sample dominates. */
export function calibrateConfidence(samples: readonly number[], depthRemaining: number): number | null {
  const usable = samples.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (!usable.length) return null;
  const floor = Math.min(...usable);
  const avg = usable.reduce((a, b) => a + b, 0) / usable.length;
  const penalty = 1 - 0.02 * Math.max(0, depthRemaining || 0);
  return round(clamp((0.65 * floor + 0.35 * avg) * penalty, 0, 1), 4);
}

class Pass<S, A> {
  readonly tt = new Map<string, SearchNode<A>>();
  readonly valueHints = new Map<string, number>();
  readonly stats: SearchStats = { nodes: 0, leaves: 0, prunes: 0, skipped: 0, ttHits: 0, ttBoundHits: 0, rootFanout: 0, priorCalls: 0 };
  readonly ev: Evaluator<S>;
  readonly opts: SearchOptions<S, A>;
  readonly rootDepth: number;
  readonly hintLine: readonly A[];
  readonly profile: SearchProfile;
  constructor(ev: Evaluator<S>, opts: SearchOptions<S, A>, rootDepth: number, hintLine: readonly A[], profile: SearchProfile) {
    this.ev = ev;
    this.opts = opts;
    this.rootDepth = rootDepth;
    this.hintLine = hintLine;
    this.profile = profile;
  }

  get world() { return this.ev.world as unknown as import('./types.ts').World<S, A>; }

  store(key: string, node: SearchNode<A>): void {
    const previous = this.tt.get(key);
    if (previous) {
      if (previous.bound === EXACT && node.bound !== EXACT) return;
      if (previous.bound === node.bound && node.bound === LOWER && previous.value >= node.value) return;
      if (previous.bound === node.bound && node.bound === UPPER && previous.value <= node.value) return;
    }
    this.tt.set(key, node);
  }

  probe(key: string, alpha: number, beta: number): { alpha: number; beta: number; result: SearchNode<A> | null } {
    const cached = this.tt.get(key);
    if (!cached) return { alpha, beta, result: null };
    this.stats.ttHits++;
    if (cached.bound === EXACT) return { alpha, beta, result: cached };
    if (cached.bound === LOWER) alpha = Math.max(alpha, cached.value);
    else beta = Math.min(beta, cached.value);
    this.stats.ttBoundHits++;
    return { alpha, beta, result: alpha >= beta ? cached : null };
  }

  order(state: S, moves: A[], prior: Readonly<Record<string, number>> | null): A[] {
    const world = this.world;
    const hintRank = new Map<string, number>();
    this.hintLine.forEach((m, i) => hintRank.set(world.actionKey(m), i));
    const maximizing = world.toMove(state) === this.ev.maximizer;
    const scored = moves.map((move, index) => {
      const child = world.step(state, move);
      const key = world.actionKey(move);
      const known = this.valueHints.get(world.key(child));
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

  async leaf(state: S, path: ReadonlyArray<PathStep<S, A>>): Promise<SearchNode<A>> {
    this.stats.leaves++;
    const evaluation = await this.ev.eval(this.opts.formula, state, this.opts.signal);
    this.opts.onLeaf?.({ state, path, evaluation });
    const confidence = evaluation.confidence === null ? null : round(clamp(evaluation.confidence, 0, 1), 4);
    return {
      value: round(clamp(evaluation.value, 0, 1), 4), confidence, calibrated: confidence, bestMove: null, line: [],
      samples: confidence === null ? [] : [confidence], certain: false, terminal: false, depth: 0, exact: true,
      bound: EXACT, source: 'leaf'
    };
  }

  async minimax(state: S, depth: number, alpha: number, beta: number, path: ReadonlyArray<PathStep<S, A>>): Promise<SearchNode<A>> {
    const world = this.world;
    this.stats.nodes++;
    if (this.opts.signal?.aborted) throw new Error('search aborted');
    const stateId = world.key(state);
    const key = stateId + '|d' + depth;
    const outcome = world.outcome(state);
    if (outcome.over) {
      const sunk: SearchNode<A> = {
        value: defaultTerminalValue(world, outcome, this.ev.maximizer), confidence: 1, calibrated: 1, bestMove: null, line: [],
        samples: [1], certain: true, terminal: true, depth: 0, exact: true, bound: EXACT, source: 'terminal'
      };
      this.store(key, sunk);
      this.valueHints.set(stateId, sunk.value);
      return sunk;
    }
    const probe = this.probe(key, alpha, beta);
    alpha = probe.alpha;
    beta = probe.beta;
    if (probe.result) return probe.result;

    if (depth <= 0) {
      const leaf = await this.leaf(state, path);
      this.store(key, leaf);
      return leaf;
    }

    const maximizing = world.toMove(state) === this.ev.maximizer;
    const policyDepth = clamp(this.opts.policyDepth ?? 1, 0, 3);
    let prior: Readonly<Record<string, number>> | null = null;
    if (policyDepth > 0 && this.rootDepth - depth < policyDepth) {
      const merge = await this.ev.prior(this.opts.formula, state, this.opts.signal);
      if (merge) { prior = merge.prior; this.stats.priorCalls++; }
    }
    let legal = world.actions(state);
    if (!maximizing && this.opts.respond && legal.length > 1) {
      const predicted = this.opts.respond(state);
      if (predicted) legal = [predicted];
    }
    const moves = this.order(state, legal, prior);
    const pruning = this.profile === PLAY_PV_ALPHA_BETA;
    const count = Math.max(1, moves.length);
    const batchWidth = pruning
      ? Math.max(1, Math.min(count, this.opts.pruningBatch ?? 2))
      : (maximizing && depth === this.rootDepth ? count : Math.max(1, Math.min(count, this.opts.parallelBatch ?? 8)));
    if (!pruning && maximizing && depth === this.rootDepth && moves.length > 1) this.stats.rootFanout = moves.length;

    let best: SearchNode<A> | null = null;
    let a = alpha, b = beta, cut = false;
    for (let i = 0; i < moves.length;) {
      if (this.opts.signal?.aborted) throw new Error('search aborted');
      const width = pruning && i === 0 ? 1 : batchWidth;
      const batch = moves.slice(i, i + width);
      const children = await Promise.all(batch.map((move) => {
        const child = world.step(state, move);
        return this.minimax(child, depth - 1, a, b, path.concat([{ state: child, move }]));
      }));
      children.forEach((child, j) => {
        if (best === null || (maximizing ? child.value > best.value : child.value < best.value)) {
          best = {
            ...child, bestMove: batch[j], line: [batch[j], ...child.line], samples: child.samples.slice(),
            certain: child.certain === true
          };
        }
        if (maximizing) a = Math.max(a, best!.value);
        else b = Math.min(b, best!.value);
      });
      i += batch.length;
      const remaining = moves.length - i;
      if (pruning && a >= b && remaining > 0 && best) {
        this.stats.prunes++;
        this.stats.skipped += remaining;
        cut = true;
        break;
      }
    }

    if (best === null) {
      const stalled: SearchNode<A> = {
        value: 0.5, confidence: 0.5, calibrated: 0.5, bestMove: null, line: [], samples: [0.5], certain: true,
        terminal: false, depth, exact: true, bound: EXACT, source: 'stalemate'
      };
      this.store(key, stalled);
      return stalled;
    }
    const chosen = best as SearchNode<A>;
    const node: SearchNode<A> = {
      value: round(chosen.value, 4),
      confidence: chosen.confidence === null ? null : round(chosen.confidence, 4),
      calibrated: calibrateConfidence(chosen.samples, this.opts.depth - depth + 1),
      bestMove: chosen.bestMove, line: chosen.line, samples: chosen.samples, certain: chosen.certain === true,
      terminal: false, depth, exact: !cut, bound: cut ? (maximizing ? LOWER : UPPER) : EXACT, source: 'search'
    };
    this.store(key, node);
    this.valueHints.set(stateId, node.value);
    return node;
  }
}

/** Iterative deepening: each pass is a full search ordered by the previous pass's principal variation. */
export async function searchBestMove<S, A>(evaluator: Evaluator<S>, state: S, options: SearchOptions<S, A>): Promise<SearchResult<A>> {
  const maxDepth = clamp(Math.round(options.depth), 1, 12);
  const profile: SearchProfile = options.profile ?? (options.respond ? LEARNING_FANOUT : PLAY_PV_ALPHA_BETA);
  const passes: SearchPass<A>[] = [];
  let hintLine: A[] = [];
  for (let depth = 1; depth <= maxDepth; depth++) {
    const started = clock();
    const pass = new Pass<S, A>(evaluator, { ...options, depth }, depth, hintLine, profile);
    const result = await pass.minimax(state, depth, -Infinity, Infinity, []);
    passes.push({ depth, result, stats: pass.stats, elapsedMs: Math.round(clock() - started) });
    hintLine = result.line.slice();
    if (options.signal?.aborted) break;
  }
  return { best: passes[passes.length - 1].result, passes };
}
