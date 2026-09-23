import type { World } from './types.ts';

/* ============================================================================
 * Truth and opponents for ANY finite two-player World (generalised from the
 * foxhounds@1 Mouse model and oracle).
 *
 *   planner   a bounded PROOF search for one side: prefers a proven win (fastest),
 *             then an undecided line, then a draw, then a proven loss (slowest);
 *             an undecided horizon falls back to a deterministic heuristic.
 *   oracle    the maximizer chooses perfectly, the opponent plays its model's ONE
 *             reply: the verdict is a fact about the game actually played. Out of
 *             budget => unknown, never a draw.
 * ========================================================================== */

export type PlanKind = 'win' | 'loss' | 'draw' | 'unknown';
export interface PlanOutcome<A> { kind: PlanKind; plies: number; move?: A }

const ORDER: Record<PlanKind, number> = { win: 0, unknown: 1, draw: 2, loss: 3 };

function prefers<A>(candidate: PlanOutcome<A>, best: PlanOutcome<A>): boolean {
  if (ORDER[candidate.kind] !== ORDER[best.kind]) return ORDER[candidate.kind] < ORDER[best.kind];
  if (candidate.kind === 'win') return candidate.plies < best.plies;
  if (candidate.kind === 'loss') return candidate.plies > best.plies;
  return false;
}

export interface Planner<S, A> {
  readonly id: string;
  readonly side: string;
  readonly depth: number;
  respond(state: S): A | null;
}

/** A proof-search planner for `side`. `fallback` chooses when the horizon proves nothing. */
export function createPlanner<S, A>(world: World<S, A>, side: string, depth: number, options: {
  fallback?: (state: S, moves: A[]) => A | null; nodeBudget?: number; cacheLimit?: number;
} = {}): Planner<S, A> {
  const cap = options.nodeBudget ?? 120000;
  const cache = new Map<string, A | null>();
  const limit = options.cacheLimit ?? 40000;
  const kindFor = (winner: string | null): PlanKind => winner === side ? 'win' : (winner === null || winner === 'draw' || !world.actors.includes(winner) ? 'draw' : 'loss');
  const solve = (state: S, d: number, budget: { nodes: number; memo: Map<string, PlanOutcome<A>> }): PlanOutcome<A> => {
    const key = world.key(state) + '|d' + d;
    const known = budget.memo.get(key);
    if (known) return known;
    const settle = (v: PlanOutcome<A>): PlanOutcome<A> => { budget.memo.set(key, v); return v; };
    const o = world.outcome(state);
    if (o.over) return settle({ kind: kindFor(o.winner), plies: 0 });
    if (d <= 0) return settle({ kind: 'unknown', plies: 0 });
    const toMove = world.toMove(state);
    const moves = world.actions(state);
    if (!moves.length) {
      if (!world.pass) return settle({ kind: 'unknown', plies: 0 });
      const passed = solve(world.pass(state), d - 1, budget);
      return settle({ kind: passed.kind, plies: passed.plies + 1 });
    }
    budget.nodes++;
    if (budget.nodes > cap) return settle({ kind: 'unknown', plies: 0 });
    /* The side to move picks what is best FOR IT: flip the kinds when the opponent is to move. */
    const mine = toMove === side;
    let best: PlanOutcome<A> | null = null;
    for (const move of moves) {
      const child = solve(world.step(state, move), d - 1, budget);
      const seen: PlanOutcome<A> = { kind: mine ? child.kind : flip(child.kind), plies: child.plies + 1, move };
      if (best === null || prefers(seen, best)) best = seen;
      if (best.kind === 'win') break;
    }
    const chosen = best!;
    return settle({ kind: mine ? chosen.kind : flip(chosen.kind), plies: chosen.plies, move: chosen.move });
  };
  return {
    id: 'planner' + depth + ':' + side,
    side,
    depth,
    respond(state) {
      const moves = world.actions(state, side);
      if (!moves.length) return null;
      const key = world.key(state) + '|d' + depth;
      if (cache.has(key)) return cache.get(key)!;
      const planned = depth > 0 ? solve(state, depth, { nodes: 0, memo: new Map() }) : { kind: 'unknown' as PlanKind, plies: 0 };
      const move = planned.kind !== 'unknown' && planned.move ? planned.move : (options.fallback ? options.fallback(state, moves) : moves[0]);
      if (cache.size >= limit) { const oldest = cache.keys().next(); if (!oldest.done) cache.delete(oldest.value); }
      cache.set(key, move);
      return move;
    }
  };
}

function flip(kind: PlanKind): PlanKind {
  return kind === 'win' ? 'loss' : kind === 'loss' ? 'win' : kind;
}

export interface Verdict {
  readonly winner: string | null;
  readonly plies: number | null;
  readonly reason: string | null;
  readonly known: boolean;
  readonly exhausted: boolean;
  readonly nodes: number;
}

/** The truth of a position: the maximizer chooses perfectly, every other side plays `respond`. */
export function solveAgainstModel<S, A>(world: World<S, A>, state: S, maximizer: string, respond: (s: S) => A | null,
  options: { budget?: number; memo?: Map<string, { winner: string | null; plies: number; reason: string | null }> } = {}): Verdict {
  const budget = options.budget ?? 120000;
  const memo = options.memo ?? new Map();
  let nodes = 0;
  let exhausted = false;
  type R = { winner: string | null; plies: number; reason: string | null };
  const better = (c: R, b: R): boolean =>
    (c.winner === maximizer && b.winner !== maximizer) ||
    (c.winner === maximizer && b.winner === maximizer && c.plies < b.plies) ||
    (c.winner !== maximizer && b.winner !== maximizer && isDraw(c.winner) && !isDraw(b.winner)) ||
    (c.winner !== maximizer && b.winner !== maximizer && !isDraw(c.winner) && !isDraw(b.winner) && c.plies > b.plies);
  const isDraw = (w: string | null): boolean => w === null || w === 'draw' || !world.actors.includes(w);
  const solve = (s: S): R | null => {
    const key = world.key(s) + '|p' + (world.view(s).scalars.ply ?? '');
    if (memo.has(key)) return memo.get(key)!;
    if (++nodes > budget) { exhausted = true; return null; }
    const o = world.outcome(s);
    if (o.over) { const r = { winner: o.winner, plies: 0, reason: o.reason }; memo.set(key, r); return r; }
    const moves = world.actions(s);
    if (!moves.length) {
      if (!world.pass) { exhausted = true; return null; }
      const passed = solve(world.pass(s));
      if (!passed) return null;
      const r = { ...passed, plies: passed.plies + 1 };
      memo.set(key, r);
      return r;
    }
    if (world.toMove(s) !== maximizer) {
      const move = respond(s);
      if (!move) { exhausted = true; return null; }
      const child = solve(world.step(s, move));
      if (!child) return null;
      const r = { ...child, plies: child.plies + 1 };
      memo.set(key, r);
      return r;
    }
    let best: R | null = null;
    for (const move of moves) {
      const child = solve(world.step(s, move));
      if (!child) return null;
      const c = { ...child, plies: child.plies + 1 };
      if (best === null || better(c, best)) best = c;
      if (best.winner === maximizer && best.plies === 1) break;
    }
    memo.set(key, best!);
    return best;
  };
  const result = solve(state);
  return { winner: result ? result.winner : null, plies: result ? result.plies : null, reason: result ? result.reason : null,
    known: !!result && result.winner !== null, exhausted, nodes };
}
