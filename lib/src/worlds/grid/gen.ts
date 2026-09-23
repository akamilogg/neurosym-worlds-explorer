import { createPlanner, solveAgainstModel } from '../../core/truth.ts';
import { createGridWorld, exists, movesFor, outcomeOf, stepGrid, type GridMove, type GridSpec, type GridState, type Vec } from './world.ts';

/* ============================================================================
 * The generator: seed -> a game worth learning.
 *
 * A drawn spec is kept only if (1) both sides can move and both can win in random
 * play, (2) it is not decided in a couple of moves, and (3) side A can FORCE a win
 * against the B planner the curriculum starts with - otherwise there is nothing
 * for the learner to find. Seeds are retried deterministically until one passes.
 * ========================================================================== */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DIRS: Vec[] = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

function pick<T>(rnd: () => number, list: readonly T[]): T { return list[Math.floor(rnd() * list.length)]; }
function sample<T>(rnd: () => number, list: readonly T[], n: number): T[] {
  const pool = list.slice();
  const out: T[] = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
  return out;
}

/** One raw draw (not yet filtered). */
export function drawSpec(seed: number, attempt = 0): GridSpec {
  const rnd = mulberry32(seed * 7919 + attempt * 104729 + 17);
  const width = 5 + Math.floor(rnd() * 4);
  const height = 5 + Math.floor(rnd() * 4);
  /* The checkerboard is rarer on purpose: diagonal pieces on dark squares is exactly what a model would recognise. */
  const shape = rnd() < 0.8 ? 'full' : 'checker';
  const diagonalOnly = shape === 'checker';
  const dirs = diagonalOnly ? DIRS.filter(([dx, dy]) => dx !== 0 && dy !== 0) : DIRS;
  /* A starts on row 0 and B on the last row; A's moves lean forward (+y) so the game advances. */
  const forward = dirs.filter(([, dy]) => dy > 0);
  const aMoves = [...sample(rnd, forward, Math.max(1, Math.min(forward.length, 1 + Math.floor(rnd() * forward.length)))),
    ...sample(rnd, dirs.filter(([, dy]) => dy === 0), rnd() < 0.3 ? 1 : 0)];
  const bMoves = sample(rnd, dirs, Math.max(2, Math.min(dirs.length, 2 + Math.floor(rnd() * (dirs.length - 1)))));
  const cellsOn = (row: number) => Array.from({ length: width }, (_, x) => x).filter((x) => exists({ width, height, shape } as GridSpec, x, row));
  const aCount = Math.min(cellsOn(0).length, 2 + Math.floor(rnd() * 3));
  const bCount = rnd() < 0.8 ? 1 : 2;
  const aStart = sample(rnd, cellsOn(0), aCount).sort((p, q) => p - q).map((x) => [x, 0] as Vec);
  const bStart = sample(rnd, cellsOn(height - 1), Math.min(bCount, cellsOn(height - 1).length)).map((x) => [x, height - 1] as Vec);
  const winA = rnd() < 0.6 ? 'trap' : 'tag';
  const winB = rnd() < 0.7 ? 'reach' : 'survive';
  return {
    id: 's' + seed + (attempt ? '.' + attempt : ''), seed, width, height, shape,
    A: { count: aStart.length, moves: aMoves, start: aStart },
    B: { count: bStart.length, moves: bMoves, start: bStart },
    winA, winB, goalRow: 0, maxPlies: 2 * (height + 6 + Math.floor(rnd() * 8))
  };
}

/** The B planner's fallback when its horizon proves nothing: head for its goal edge, keep room to move. */
export function bFallback(spec: GridSpec) {
  return (state: GridState, moves: GridMove[]): GridMove | null => {
    let best: GridMove | null = null;
    let bestScore = -Infinity;
    for (const m of moves) {
      const next = { ...state, b: state.b.map((p, i) => (i === m.piece ? m.to : p)) as Vec[] };
      const room = movesFor(spec, next as GridState, 'B').length;
      const progress = spec.winB === 'reach' ? -m.to[1] : 0;
      const score = progress * 10 + room * 3 - (room === 0 ? 100 : 0);
      if (score > bestScore) { bestScore = score; best = m; }
    }
    return best;
  };
}

export interface SpecReport {
  readonly randomAWinRate: number;
  readonly meanRandomLength: number;
  readonly forcedWinPlies: number | null;
  readonly attempts: number;
}

function randomPlay(spec: GridSpec, rnd: () => number): { winner: string | null; plies: number } {
  let s: GridState = createGridWorld(spec).initial();
  for (let i = 0; i < spec.maxPlies + 2; i++) {
    const o = outcomeOf(spec, s);
    if (o.over) return { winner: o.winner, plies: s.ply };
    const moves = movesFor(spec, s, s.turn);
    s = moves.length ? stepGrid(s, moves[Math.floor(rnd() * moves.length)]) : { ...s, turn: s.turn === 'A' ? 'B' : 'A', ply: s.ply + 1 };
  }
  return { winner: null, plies: s.ply };
}

/** Draw specs from `seed` until one passes the filters. */
export function generateSpec(seed: number, options: { plannerDepth?: number; maxAttempts?: number; oracleBudget?: number } = {}):
  { spec: GridSpec; report: SpecReport } {
  const depth = options.plannerDepth ?? 2;
  for (let attempt = 0; attempt < (options.maxAttempts ?? 400); attempt++) {
    const spec = drawSpec(seed, attempt);
    if (!spec.B.start.length || spec.A.start.length < 2) continue;
    const world = createGridWorld(spec);
    const s0 = world.initial();
    if (world.outcome(s0).over || !world.actions(s0, 'A').length || !world.actions(s0, 'B').length) continue;
    const rnd = mulberry32(seed + attempt);
    let aWins = 0, total = 0, length = 0, bWins = 0;
    for (let g = 0; g < 120; g++) {
      const r = randomPlay(spec, rnd);
      total++; length += r.plies;
      if (r.winner === 'A') aWins++; else if (r.winner === 'B') bWins++;
    }
    const rate = aWins / total;
    if (rate < 0.1 || rate > 0.9 || bWins === 0 || length / total < 6) continue;
    const planner = createPlanner(world, 'B', depth, { fallback: bFallback(spec) });
    const verdict = solveAgainstModel(world, s0, 'A', (s) => planner.respond(s), { budget: options.oracleBudget ?? 150000 });
    if (!verdict.known || verdict.winner !== 'A' || (verdict.plies ?? 0) < 8) continue;
    return { spec, report: { randomAWinRate: Math.round(rate * 100) / 100, meanRandomLength: Math.round((length / total) * 10) / 10,
      forcedWinPlies: verdict.plies, attempts: attempt + 1 } };
  }
  throw new Error('no playable game found for seed ' + seed);
}
