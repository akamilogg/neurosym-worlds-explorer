import { Observer } from '../../core/observer.ts';
import { Evaluator } from '../../core/evaluate.ts';
import { makeFormula } from '../../core/formula.ts';
import { searchBestMove, PLAY_PV_ALPHA_BETA } from '../../core/search.ts';
import { createPlanner } from '../../core/truth.ts';
import { noisyOpponent, playEpisode } from '../../learn/episodes.ts';
import { winningMoves } from '../../learn/experiments.ts';
import { bFallback } from './gen.ts';
import { mulberry32 } from './gen.ts';
import { createGridWorld, movesFor, type GridMove, type GridSpec, type GridState } from './world.ts';
import type { Formula, Judge } from '../../core/types.ts';

/* ============================================================================
 * OPERATOR-SIDE ONLY. Nothing in this file may ever reach System 2 or the Judge.
 *
 * The CEILING of a generated game: a heuristic that KNOWS the rules (written from
 * the spec: how each side wins), searching at the experiment's depth. If even it
 * cannot win, no formula the learner writes can, and the game measures nothing.
 * A game is worth running only when this heuristic wins and the flat control does not.
 *
 * It is deliberately plain - one term per win condition - so a pass means "a sensible
 * reading of the position suffices", not "a clever evaluator exists".
 * ========================================================================== */

/** V(s) for side A in [0,1], from the spec (the rules), never from the picture. */
export function informedValue(spec: GridSpec, s: GridState): number {
  const clamp = (x: number) => Math.max(0, Math.min(1, x));
  const cheb = (p: readonly number[], q: readonly number[]) => Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]));
  let attack: number;
  if (spec.winA === 'trap') {
    /* Fewer moves left to B is closer to trapping it. */
    attack = 1 - movesFor(spec, s, 'B').length / Math.max(1, spec.B.count * spec.B.moves.length);
  } else {
    const d = Math.min(...s.a.flatMap((a) => s.b.map((b) => cheb(a, b))));
    attack = 1 - clamp((d - 1) / Math.max(1, Math.max(spec.width, spec.height) - 1));
  }
  let defence: number;
  if (spec.winB === 'reach') {
    /* B far from its goal row, and A pieces standing between B and that row. */
    const dist = Math.min(...s.b.map((b) => Math.abs(b[1] - spec.goalRow))) / Math.max(1, spec.height - 1);
    const between = s.a.filter((a) => s.b.some((b) => Math.abs(a[1] - spec.goalRow) < Math.abs(b[1] - spec.goalRow))).length / Math.max(1, s.a.length);
    defence = 0.6 * dist + 0.4 * between;
  } else {
    /* B wins by lasting: the clock runs against A. */
    defence = 1 - s.ply / Math.max(1, spec.maxPlies);
  }
  return clamp(0.55 * attack + 0.45 * defence);
}

/** An evaluator whose V(s) is the informed value (a native measure read by a local judge: no network). */
export function informedEvaluator(spec: GridSpec): { evaluator: Evaluator<GridState>; formula: Formula } {
  const world = createGridWorld(spec);
  const observer = new Observer<GridState>(world, {
    kinds: ['code'],
    runners: [{ lang: 'native', compile: () => (ctx) => informedValue(spec, ctx.state as GridState) }]
  });
  const judge: Judge = { id: 'informed', async judge(r) { return { v: { value: r.measurements.h, confidence: null } }; } };
  const formula = makeFormula({ world: world.id, observations: { h: { spec: { kind: 'code', lang: 'native', source: 'informed' }, range: [0, 1] } },
    rules: { v: { type: 'noul', used_as: 'value', instructions: '{{h}}', criteria: { yes: '', no: '' } } }, weights: { v: 1 }, meta: { source: 'informed' } });
  return { evaluator: new Evaluator<GridState>(observer, judge, { maximizer: 'A' }), formula };
}

export interface Ceiling {
  readonly wins: number;
  readonly total: number;
  /** A's turns played while the position was still won, per game. */
  readonly turnsStillWinning: number[];
}

/** Play the informed heuristic against the opponent level, as the experiment would play the learner's formula. */
export async function ceilingOf(spec: GridSpec, options: { depth: number; level: number; epsilon: number; games?: number; seedBase?: number }): Promise<Ceiling> {
  const world = createGridWorld(spec);
  const { evaluator, formula } = informedEvaluator(spec);
  const planner = createPlanner(world, 'B', options.level, { fallback: bFallback(spec) });
  let wins = 0;
  const held: number[] = [];
  for (let g = 0; g < (options.games ?? 4); g++) {
    const opponent = noisyOpponent(world, (s) => planner.respond(s), options.epsilon, mulberry32((options.seedBase ?? spec.seed * 7717) + g * 7));
    let kept = 0, thrown = false;
    const ep = await playEpisode(world, async (s, actor) => {
      if (actor === 'B') return opponent(s);
      const move = (await searchBestMove<GridState, GridMove>(evaluator, s, { formula, depth: options.depth, profile: PLAY_PV_ALPHA_BETA })).best.bestMove ?? world.actions(s)[0];
      const keep = winningMoves(world, s, 'A', (x) => planner.respond(x), 40000);
      if (!thrown && keep && keep.length) {
        if (keep.some((m) => world.actionKey!(m) === world.actionKey!(move))) kept++;
        else thrown = true;
      }
      return move;
    });
    if (ep.outcome.winner === 'A') wins++;
    held.push(kept);
  }
  return { wins, total: options.games ?? 4, turnsStillWinning: held };
}

/** How tight the forced win is: along one perfect line, the moves that keep it over the legal moves, per A turn. */
export function tightness(spec: GridSpec, level: number): { perTurn: string[]; minShare: number } {
  const world = createGridWorld(spec);
  const planner = createPlanner(world, 'B', level, { fallback: bFallback(spec) });
  let s = world.initial();
  const perTurn: string[] = [];
  let minShare = 1;
  for (let i = 0; i < 80 && !world.outcome(s).over; i++) {
    if (s.turn === 'A') {
      const legal = movesFor(spec, s, 'A');
      const keep = winningMoves(world, s, 'A', (x) => planner.respond(x), 60000) ?? [];
      if (!legal.length || !keep.length) break;
      perTurn.push(keep.length + '/' + legal.length);
      minShare = Math.min(minShare, keep.length / legal.length);
      s = world.step(s, keep[0]);
    } else {
      const m = planner.respond(s);
      s = m ? world.step(s, m) : world.pass!(s);
    }
  }
  return { perTurn, minShare };
}
