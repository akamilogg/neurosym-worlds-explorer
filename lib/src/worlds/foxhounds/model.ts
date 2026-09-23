import {
  MOUSE_HOME_ROW, SIDE_CATS, SIDE_MOUSE, WINNER_DRAW, applyMove, legalMovesForSide, outcome, passTurn, stateKey,
  type FoxMove, type FoxState
} from './world.ts';

/* ============================================================================
 * The Mouse model and the oracle of foxhounds@1 (ported from the harness's
 * "THE MOUSE MODEL" and "TRUTH OF THE GAME ACTUALLY PLAYED" blocks).
 *
 * ONE concept, used in the three places that must agree: who plays the Mouse, the
 * single reply the Cats' search predicts (`respond`), and the truth the oracle
 * labels positions with. The planner is code only: it never reads the formula under
 * test and never calls the Judge, so its strength is independent of the evaluator.
 * ========================================================================== */

export const PLAN_NODE_BUDGET = 120000;
export const TRUTH_NODE_BUDGET = 120000;
export const MOUSE_DEPTH_MAX_LIMIT = 12;

/** Survival first (never volunteer into a trap), then progress toward row 0. */
export function mouseMoveScore(state: FoxState, move: FoxMove): number {
  const child = applyMove(state, move);
  const o = outcome(child);
  if (o.over && o.winner === SIDE_MOUSE) return 1000;
  const mobility = legalMovesForSide(child, SIDE_MOUSE).length;
  return (MOUSE_HOME_ROW - child.mouse[1]) * 10 + mobility * 3 - (mobility === 0 ? 900 : 0);
}

export function chooseGreedyMouseMove(state: FoxState): FoxMove | null {
  let best: { move: FoxMove; score: number } | null = null;
  for (const move of legalMovesForSide(state, SIDE_MOUSE)) {
    const score = mouseMoveScore(state, move);
    if (!best || score > best.score) best = { move, score };
  }
  return best ? best.move : null;
}

type PlanKind = 'mouse' | 'cats' | 'draw' | 'unknown';
interface PlanOutcome { kind: PlanKind; plies: number; move?: FoxMove }
interface PlanBudget { nodes: number; cap: number; exhausted: boolean; memo: Map<string, PlanOutcome> }

/* The Mouse prefers a proven escape (fastest), then an undecided line, then a draw, then a proven loss
   (longest survival); the Cats are the mirror. */
const PLAN_PREFERENCE: Record<'mouse' | 'cats', Record<PlanKind, number>> = {
  mouse: { mouse: 0, unknown: 1, draw: 2, cats: 3 },
  cats: { cats: 0, draw: 1, unknown: 2, mouse: 3 }
};

function prefers(side: string, candidate: PlanOutcome, best: PlanOutcome): boolean {
  const order = PLAN_PREFERENCE[side === SIDE_MOUSE ? 'mouse' : 'cats'];
  if (order[candidate.kind] !== order[best.kind]) return order[candidate.kind] < order[best.kind];
  if (candidate.kind === best.kind && (candidate.kind === 'mouse' || candidate.kind === 'cats')) {
    const fasterIsBetter = (candidate.kind === 'mouse') === (side === SIDE_MOUSE);
    return fasterIsBetter ? candidate.plies < best.plies : candidate.plies > best.plies;
  }
  return false;
}

/** Bounded proof search: the outcome the side to move can prove within `depth` plies. */
export function solveLookahead(position: FoxState, depth: number, budget: PlanBudget): PlanOutcome {
  const key = stateKey(position) + '|p' + position.ply + '|m' + depth;
  const memoized = budget.memo.get(key);
  if (memoized) return memoized;
  const settle = (value: PlanOutcome): PlanOutcome => { budget.memo.set(key, value); return value; };
  const o = outcome(position);
  if (o.over) return settle({ kind: o.winner === SIDE_MOUSE ? 'mouse' : o.winner === SIDE_CATS ? 'cats' : 'draw', plies: 0 });
  if (depth <= 0) return settle({ kind: 'unknown', plies: 0 });
  const side = position.turn;
  const moves = legalMovesForSide(position, side);
  if (!moves.length) {
    if (side === SIDE_CATS) {
      const passed = solveLookahead(passTurn(position), depth - 1, budget);
      return settle({ kind: passed.kind, plies: passed.plies + 1 });
    }
    return settle({ kind: 'cats', plies: 0 });
  }
  budget.nodes++;
  if (budget.nodes > budget.cap) { budget.exhausted = true; return settle({ kind: 'unknown', plies: 0 }); }
  let best: PlanOutcome | null = null;
  for (const move of moves) {
    const child = solveLookahead(applyMove(position, move), depth - 1, budget);
    const candidate: PlanOutcome = { kind: child.kind, plies: child.plies + 1, move };
    if (best === null || prefers(side, candidate, best)) best = candidate;
    if (best.kind === (side === SIDE_MOUSE ? 'mouse' : 'cats')) break;
  }
  return settle(best ?? { kind: 'unknown', plies: 0 });
}

export interface MouseModelStats { planCalls: number; cacheHits: number; exhausted: number }

export interface MouseModel {
  readonly id: string;
  readonly depth: number;
  readonly stats: MouseModelStats;
  /** The one move the Mouse plays here (null when trapped). Deterministic and memoised. */
  respond(state: FoxState): FoxMove | null;
  /** What the Judge is told about the opponent: the opponent is part of the position. */
  describe(): Record<string, unknown>;
}

export function createMouseModel(depth: number, options: { cacheLimit?: number; nodeBudget?: number } = {}): MouseModel {
  const d = Math.max(0, Math.min(MOUSE_DEPTH_MAX_LIMIT, Math.round(depth)));
  const cache = new Map<string, FoxMove | null>();
  const limit = options.cacheLimit ?? 40000;
  const stats: MouseModelStats = { planCalls: 0, cacheHits: 0, exhausted: 0 };
  return {
    id: d > 0 ? 'planner' + d : 'greedy',
    depth: d,
    stats,
    respond(state) {
      if (d <= 0) return chooseGreedyMouseMove(state);
      const key = stateKey(state) + '|p' + state.ply + '|m' + d;
      if (cache.has(key)) { stats.cacheHits++; return cache.get(key)!; }
      stats.planCalls++;
      const budget: PlanBudget = { nodes: 0, cap: options.nodeBudget ?? PLAN_NODE_BUDGET, exhausted: false, memo: new Map() };
      const planned = solveLookahead(state, d, budget);
      if (budget.exhausted) stats.exhausted++;
      const move = planned.kind !== 'unknown' && planned.move ? planned.move : chooseGreedyMouseMove(state);
      if (cache.size >= limit) { const oldest = cache.keys().next(); if (!oldest.done) cache.delete(oldest.value); }
      cache.set(key, move);
      return move;
    },
    describe() {
      if (d > 0) {
        return {
          policy: 'planner', side: SIDE_MOUSE, depth: d,
          description: 'deterministic planner: it explores its own moves and every Cat reply ' + d +
            ' plies ahead IN CODE (never the rule set, never Jev) and prefers a proven escape (fastest), then any undecided line, then a draw, then a proven loss (longest survival). It is deterministic, so the same position always produces the same Mouse move.',
          predictable: true
        };
      }
      return {
        policy: 'greedy', side: SIDE_MOUSE,
        description: 'deterministic 1-ply planner: it never plays a move that lets the Cats trap it, ' +
          'then maximises progress toward row 0 (progress x10) plus surviving mobility (x3). It is ' +
          'deterministic, so the same position always produces the same Mouse move.',
        predictable: true
      };
    }
  };
}

/** The opponent the Judge is told about when a human plays the Mouse. */
export const HUMAN_MOUSE = Object.freeze({
  policy: 'human', side: SIDE_MOUSE,
  description: 'a human is playing this side: the harness cannot predict the move, so judge against the WORST case for the Cats',
  predictable: false
});

export interface Verdict {
  readonly winner: string | null;
  readonly plies: number | null;
  readonly reason: string | null;
  readonly known: boolean;
  readonly exhausted: boolean;
  readonly nodes: number;
  readonly budget: number;
  readonly covers: string;
  readonly opponent: string;
}

/** The truth of the game actually played: the Cats choose perfectly, the Mouse plays the MODEL's one
    reply. Out of budget => winner null, never a draw ("I could not solve it" is not "nobody wins"). */
export function solveAgainstModel(state: FoxState, model: MouseModel, options: { budget?: number; memo?: Map<string, unknown> } = {}): Verdict {
  const budget = options.budget ?? TRUTH_NODE_BUDGET;
  const memo = options.memo ?? new Map();
  let nodes = 0;
  let exhausted = false;
  type R = { winner: string | null; plies: number; reason: string | null };
  const solve = (position: FoxState): R | null => {
    const key = stateKey(position) + '|p' + position.ply + '|m' + model.depth;
    if (memo.has(key)) return memo.get(key) as R;
    nodes++;
    if (nodes > budget) { exhausted = true; return null; }
    const o = outcome(position);
    if (o.over) { const r = { winner: o.winner, plies: 0, reason: o.reason }; memo.set(key, r); return r; }
    if (position.turn === SIDE_MOUSE) {
      const move = model.respond(position);
      if (!move) { const r = { winner: SIDE_CATS, plies: 0, reason: 'mouse_trapped' }; memo.set(key, r); return r; }
      const child = solve(applyMove(position, move));
      if (child === null) { exhausted = true; return null; }
      const r = { winner: child.winner, plies: child.plies + 1, reason: child.reason };
      memo.set(key, r);
      return r;
    }
    const moves = legalMovesForSide(position, SIDE_CATS);
    if (!moves.length) {
      const passed = solve(passTurn(position));
      if (passed === null) { exhausted = true; return null; }
      memo.set(key, passed);
      return passed;
    }
    let best: R | null = null;
    for (const move of moves) {
      const child = solve(applyMove(position, move));
      if (child === null) { exhausted = true; return null; }
      const c = { winner: child.winner, plies: child.plies + 1, reason: child.reason };
      const better = best === null ||
        (c.winner === SIDE_CATS && best.winner !== SIDE_CATS) ||
        (c.winner === SIDE_CATS && best.winner === SIDE_CATS && c.plies < best.plies) ||
        (c.winner === WINNER_DRAW && best.winner === SIDE_MOUSE);
      if (better) best = c;
      if (best!.winner === SIDE_CATS && best!.plies === 1) break;
    }
    memo.set(key, best);
    return best;
  };
  const result = solve(state);
  return {
    winner: result ? result.winner : null,
    plies: result ? result.plies : null,
    reason: result ? result.reason : null,
    known: !!result && result.winner !== null,
    exhausted, nodes, budget,
    covers: 'terminal verdicts and the ply cap against the Mouse model (threefold repetition is NOT modelled)',
    opponent: model.id
  };
}

/** The oracle as a capability: cached per (state, ply, model). */
export function createOracle(model: MouseModel, options: { budget?: number; cacheLimit?: number } = {}) {
  const cache = new Map<string, Verdict>();
  const limit = options.cacheLimit ?? 6000;
  return {
    model,
    verdict(state: FoxState): Verdict {
      const key = stateKey(state) + '|p' + state.ply + '|m' + model.depth;
      const hit = cache.get(key);
      if (hit) return hit;
      const v = solveAgainstModel(state, model, { budget: options.budget });
      if (cache.size >= limit) { const oldest = cache.keys().next(); if (!oldest.done) cache.delete(oldest.value); }
      cache.set(key, v);
      return v;
    }
  };
}
