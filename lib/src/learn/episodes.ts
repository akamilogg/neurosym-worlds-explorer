import { solveAgainstModel } from '../core/truth.ts';
import type { Outcome, World } from '../core/types.ts';
import type { LabelledPosition } from './experiments.ts';

/* ============================================================================
 * Episodes: games played for the learner, world-neutral.
 *
 *   playEpisode      one game, each side chosen by a caller-supplied function
 *   noisyOpponent    a deterministic opponent that errs with probability epsilon, seeded:
 *                    trial games against it differ from each other, yet replay exactly
 *   labelPositions   the truth of the maximizer's positions against the opponent model:
 *                    what probes are measured on
 * ========================================================================== */

export interface Episode<S, A> {
  readonly states: S[];
  readonly moves: (A | null)[];
  readonly outcome: Outcome;
}

export async function playEpisode<S, A>(world: World<S, A>, choose: (state: S, actor: string) => A | null | Promise<A | null>,
  options: { maxPlies?: number; start?: S } = {}): Promise<Episode<S, A>> {
  let state = options.start ?? world.initial();
  const states: S[] = [state];
  const moves: (A | null)[] = [];
  const cap = options.maxPlies ?? 400;
  for (let i = 0; i < cap; i++) {
    const outcome = world.outcome(state);
    if (outcome.over) return { states, moves, outcome };
    const actor = world.toMove(state);
    const legal = world.actions(state, actor);
    let move: A | null = null;
    if (legal.length) move = await choose(state, actor);
    if (move === null) {
      if (legal.length || !world.pass) break;
      state = world.pass(state);
    } else {
      state = world.step(state, move);
    }
    moves.push(move);
    states.push(state);
  }
  return { states, moves, outcome: world.outcome(state).over ? world.outcome(state) : { over: true, winner: null, reason: 'cap' } };
}

export function noisyOpponent<S, A>(world: World<S, A>, respond: (s: S) => A | null, epsilon: number, rnd: () => number) {
  return (state: S): A | null => {
    const moves = world.actions(state);
    if (!moves.length) return null;
    if (epsilon > 0 && rnd() < epsilon) return moves[Math.floor(rnd() * moves.length)];
    return respond(state);
  };
}

/** Label the states where `maximizer` is to move (known verdicts only; a draw counts as not won). */
export function labelPositions<S, A>(world: World<S, A>, states: readonly S[], maximizer: string, respond: (s: S) => A | null,
  options: { budget?: number; memo?: Map<string, { winner: string | null; plies: number; reason: string | null }> } = {}): LabelledPosition<S>[] {
  const out: LabelledPosition<S>[] = [];
  const seen = new Set<string>();
  for (const state of states) {
    if (world.outcome(state).over || world.toMove(state) !== maximizer) continue;
    const key = world.key(state);
    if (seen.has(key)) continue;
    seen.add(key);
    const verdict = solveAgainstModel(world, state, maximizer, respond, { budget: options.budget ?? 60000, memo: options.memo });
    if (!verdict.known) continue;
    out.push({ state, label: verdict.winner === maximizer ? 'win' : 'loss' });
  }
  return out;
}
