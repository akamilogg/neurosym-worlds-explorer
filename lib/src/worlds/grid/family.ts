import { mulberry32 } from './gen.ts';
import { createGridWorld, exists, movesFor, outcomeOf, stepGrid, type GridSpec, type GridState, type Vec } from './world.ts';

/* ============================================================================
 * A FAMILY of boards under one set of rules. The rules a learner discovers are
 * validated as a researcher would validate them: by holding on boards they were
 * not fitted on.
 *
 * What stays (the rules): how each side moves, how each side wins, the board's shape
 * (full or checkered), the move limit, and - through the seed - the picture's
 * orientation and symbols ("forward" is a direction of the world).
 * What changes (the board): its width and height (5 to 8), how many pieces each side
 * has (2 to 4, and 1 to 2), and where they start within their bands.
 * Each board must be playable: both sides can move and win in random play, and it is
 * not decided in a couple of moves.
 * ========================================================================== */

export interface BoardReport {
  readonly randomAWinRate: number;
  readonly meanRandomLength: number;
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

function sample<T>(rnd: () => number, list: readonly T[], n: number): T[] {
  const pool = list.slice();
  const out: T[] = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
  return out;
}

/** Board `index` of the family of `base` (index 0 is the base game itself), with its playability report. Deterministic. */
export function boardOf(base: GridSpec, index: number, options: { maxAttempts?: number } = {}): { spec: GridSpec; report: BoardReport } {
  if (index === 0) return { spec: base, report: { randomAWinRate: NaN, meanRandomLength: NaN, attempts: 0 } };
  for (let attempt = 0; attempt < (options.maxAttempts ?? 60); attempt++) {
    const rnd = mulberry32(base.seed * 48271 + index * 2654435761 + attempt * 7919 + 5);
    const width = 5 + Math.floor(rnd() * 4), height = 5 + Math.floor(rnd() * 4);
    const cellsOn = (row: number) => Array.from({ length: width }, (_, x) => x).filter((x) => exists({ width, height, shape: base.shape } as GridSpec, x, row));
    const aCells = cellsOn(0), bCells = cellsOn(height - 1);
    const aCount = Math.min(aCells.length, 2 + Math.floor(rnd() * 3)), bCount = Math.min(bCells.length, 1 + Math.floor(rnd() * 2));
    const spec: GridSpec = {
      ...base,
      id: base.id + '.b' + index,
      width, height,
      A: { ...base.A, count: aCount, start: sample(rnd, aCells, aCount).sort((p, q) => p - q).map((x) => [x, 0] as Vec) },
      B: { ...base.B, count: bCount, start: sample(rnd, bCells, bCount).map((x) => [x, height - 1] as Vec) }
    };
    if (spec.A.start.length < 2 || !spec.B.start.length) continue;
    const s0 = createGridWorld(spec).initial();
    if (outcomeOf(spec, s0).over || !movesFor(spec, s0, 'A').length || !movesFor(spec, s0, 'B').length) continue;
    const play = mulberry32(base.seed + index * 31 + attempt);
    let aWins = 0, bWins = 0, length = 0;
    const games = 80;
    for (let g = 0; g < games; g++) {
      const r = randomPlay(spec, play);
      length += r.plies;
      if (r.winner === 'A') aWins++; else if (r.winner === 'B') bWins++;
    }
    const rate = aWins / games;
    if (rate < 0.05 || rate > 0.95 || bWins === 0 || length / games < 6) continue;
    return { spec, report: { randomAWinRate: Math.round(rate * 100) / 100, meanRandomLength: Math.round((length / games) * 10) / 10, attempts: attempt + 1 } };
  }
  throw new Error('no playable board ' + index + ' in the family of ' + base.id);
}
