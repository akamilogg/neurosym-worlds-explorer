import { createPlanner, solveAgainstModel } from '../../core/truth.ts';
import { bFallback, mulberry32 } from './gen.ts';
import { createGridWorld, exists, type GridSpec, type GridState, type Vec } from './world.ts';

/* ============================================================================
 * OPERATOR-SIDE: starting positions the learner has never played, for the
 * generalization phase. Same rules, same pieces, different squares: each side
 * starts somewhere in its own starting band (A on the first two rows, B on the
 * last two), never in the original setup.
 *
 * The truth is used ONLY to keep the test fair - a variant is kept when A can still
 * force the win against the opponent, and not trivially - never to tell the learner
 * anything. What the learner gets from a variant is a game, like any other.
 * ========================================================================== */

export function variantStarts(spec: GridSpec, options: { count: number; level: number; seed?: number; minPlies?: number; budget?: number; maxDraws?: number }): GridState[] {
  const world = createGridWorld(spec);
  const planner = createPlanner(world, 'B', options.level, { fallback: bFallback(spec) });
  const rnd = mulberry32((options.seed ?? spec.seed) * 2654435761 + options.level * 97 + 13);
  const band = (rows: number[]) => rows.flatMap((y) => Array.from({ length: spec.width }, (_, x) => [x, y] as Vec)).filter(([x, y]) => exists(spec, x, y));
  const aCells = band([0, 1]);
  const bCells = band([spec.height - 1, spec.height - 2]);
  const original = world.key(world.initial());
  const pick = (cells: Vec[], n: number, taken: Set<string>): Vec[] | null => {
    const pool = cells.filter(([x, y]) => !taken.has(x + ',' + y));
    const out: Vec[] = [];
    while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
    return out.length === n ? out : null;
  };
  const found: GridState[] = [];
  const seen = new Set<string>([original]);
  for (let draw = 0; draw < (options.maxDraws ?? 400) && found.length < options.count; draw++) {
    const a = pick(aCells, spec.A.count, new Set());
    if (!a) break;
    const b = pick(bCells, spec.B.count, new Set(a.map(([x, y]) => x + ',' + y)));
    if (!b) break;
    const s: GridState = { a, b, turn: 'A', ply: 0 };
    const key = world.key(s);
    if (seen.has(key)) continue;
    seen.add(key);
    if (world.outcome(s).over || !world.actions(s, 'A').length || !world.actions(s, 'B').length) continue;
    const verdict = solveAgainstModel(world, s, 'A', (x) => planner.respond(x), { budget: options.budget ?? 60000 });
    if (!verdict.known || verdict.winner !== 'A' || (verdict.plies ?? 0) < (options.minPlies ?? 6)) continue;
    found.push(s);
  }
  return found;
}
