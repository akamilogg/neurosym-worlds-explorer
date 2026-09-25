import { searchBestMove, PLAY_PV_ALPHA_BETA } from '../core/search.ts';
import type { Evaluator } from '../core/evaluate.ts';
import type { Formula, World } from '../core/types.ts';

/* ============================================================================
 * The learner's own exploration, kept so the learner can look back at it.
 *
 * Everything here comes from what the learner's search did with the learner's
 * formula - never from anything that knows the rules better than it does:
 *
 *   choices   the positions its search considered at the root of one of its turns,
 *             each with the value its formula gave it LOOKING AHEAD (the search's
 *             backed-up value) and without looking ahead (the formula's direct value)
 *   endings   finished games its search ran into inside its own horizon after each
 *             choice (it explored them; the world said who won)
 *   surprise  how much the search's value of the learner's position dropped from one
 *             of its turns to the next: where its own prediction was most wrong
 * ========================================================================== */

export interface ChoiceRecord<S> {
  readonly state: S;
  /** What the search expected from this choice, looking ahead (for the learner: 1 = win). */
  readonly lookahead: number;
  /** The formula's value of the position itself, without looking ahead. */
  readonly direct: number;
  /** Behind `direct`: what each rule answered and what each code observation measured (empty on a finished game). */
  readonly rules: Readonly<Record<string, number>>;
  readonly measures: Readonly<Record<string, number | string>>;
  /** Finished games found inside the horizon after this choice: won by the learner / by the other side. */
  readonly endingsWon: number;
  readonly endingsLost: number;
  readonly chosen: boolean;
}

export interface TurnRecord<S> {
  readonly turn: number;
  readonly state: S;
  /** The search's value of this position for the learner (the chosen choice's look-ahead value). */
  readonly value: number;
  readonly choices: readonly ChoiceRecord<S>[];
}

/** Count finished games reachable within `plies` (the learner's own horizon), by winner. */
function endingsWithin<S, A>(world: World<S, A>, state: S, plies: number, maximizer: string, cap = 4000): { won: number; lost: number } {
  let won = 0, lost = 0, seen = 0;
  const walk = (s: S, left: number): void => {
    if (seen++ > cap) return;
    const o = world.outcome(s);
    if (o.over) { if (o.winner === maximizer) won++; else if (o.winner !== null && world.actors.includes(o.winner)) lost++; return; }
    if (left <= 0) return;
    const moves = world.actions(s);
    if (!moves.length) { if (world.pass) walk(world.pass(s), left - 1); return; }
    for (const m of moves) walk(world.step(s, m), left - 1);
  };
  walk(state, plies);
  return { won, lost };
}

/** Record one of the learner's turns: every root choice its search had, as its search saw it. The values are the
    same Evaluator's (its cache makes this cheap: the search already judged most of these positions). */
export async function recordTurn<S, A>(evaluator: Evaluator<S>, world: World<S, A>, state: S, chosen: A,
  options: { formula: Formula; depth: number; maximizer: string; turn: number }): Promise<TurnRecord<S>> {
  const choices: ChoiceRecord<S>[] = [];
  const key = (m: A) => (world.actionKey ? world.actionKey(m) : JSON.stringify(m));
  for (const m of world.actions(state, options.maximizer)) {
    const child = world.step(state, m);
    const ev = await evaluator.eval(options.formula, child);
    const direct = ev.value;
    const rules = Object.fromEntries(Object.entries(ev.answers).map(([id, a]) => [id, Math.round(a.value * 10000) / 10000]));
    const measures: Record<string, number | string> = Object.fromEntries(Object.entries(options.formula.observations)
      .filter(([id, d]) => d.spec.kind === 'code' && Number.isFinite(ev.observation.values[id]))
      .map(([id]) => [id, Math.round(ev.observation.values[id] * 10000) / 10000]));
    Object.assign(measures, ev.observation.texts ?? {});
    const lookahead = options.depth > 1 && !world.outcome(child).over
      ? (await searchBestMove<S, A>(evaluator, child, { formula: options.formula, depth: options.depth - 1, profile: PLAY_PV_ALPHA_BETA })).best.value
      : direct;
    const endings = endingsWithin(world, child, Math.max(0, options.depth - 1), options.maximizer);
    choices.push({ state: child, lookahead, direct, rules, measures, endingsWon: endings.won, endingsLost: endings.lost, chosen: key(m) === key(chosen) });
  }
  const pick = choices.find((c) => c.chosen);
  return { turn: options.turn, state, value: pick ? pick.lookahead : NaN, choices };
}

export interface Surprise { readonly turn: number; readonly next: number | 'end'; readonly value_before: number; readonly value_after: number; readonly drop: number }

/** The learner's turns where its own search's value fell the most before its next turn - or before the end of the
    game, whose value is its result (1 won, 0 lost, 0.5 otherwise). */
export function surprises<S>(turns: readonly TurnRecord<S>[], finalValue: number | null, top = 3): Surprise[] {
  const out: Surprise[] = [];
  const points: { turn: number | 'end'; value: number }[] = turns.map((t) => ({ turn: t.turn, value: t.value }));
  if (finalValue !== null) points.push({ turn: 'end', value: finalValue });
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i], b = points[i + 1];
    if (!Number.isFinite(a.value) || !Number.isFinite(b.value) || a.turn === 'end') continue;
    const drop = Math.round((a.value - b.value) * 1000) / 1000;
    if (drop > 0) out.push({ turn: a.turn, next: b.turn, value_before: a.value, value_after: b.value, drop });
  }
  return out.sort((x, y) => y.drop - x.drop).slice(0, top);
}
