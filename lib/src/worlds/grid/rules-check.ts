import { orient, readPicture, type GridSense } from './sense.ts';
import { createGridWorld, outcomeOf, type GridSpec, type GridState } from './world.ts';
import { pictureDelta } from './describe.ts';

/* ============================================================================
 * The rules of a grid world, as a learner states them and as the world answers.
 *
 * A learner's rules are two functions over what it perceives (the same `p` its
 * observations read): moves(p) -> [[fromRow, fromCol, toRow, toCol], ...] for the side
 * about to move, in the picture's coordinates; ending(p) -> null while the game goes on,
 * else how it ended for the learner's side, -1..1 (1 won, 0 draw, -1 lost).
 *
 * The world's answer at a position is a fact, the same one a `try` gives, made
 * systematic: which of the predicted moves it does not allow, how many it allows that
 * were not predicted, and whether the predicted ending is the real one. Moves are
 * checked only where the game goes on; endings everywhere.
 * ========================================================================== */

export type PictureMove = readonly [number, number, number, number];

export interface RulesVerdict {
  /** Predicted moves the world does not allow (the learner's own claims, so they can be named). */
  readonly refused: readonly PictureMove[];
  /** How many moves the world allows that were not predicted (a count: the moves themselves are not handed over). */
  readonly missing: number;
  readonly ending: { readonly predicted: number | null; readonly actual: number | null; readonly right: boolean };
  /** Operator: the whole verdict agrees. */
  readonly correct: boolean;
}

/** The moves the world allows at a state, for the side to move, in the picture's coordinates. */
export function actualMoves(spec: GridSpec, sense: GridSense, state: GridState): PictureMove[] {
  if (outcomeOf(spec, state).over) return [];
  const at = (x: number, y: number) => orient(sense.orientation, x, y, spec.width, spec.height);
  return createGridWorld(spec).actions(state).map((m) => {
    const [fc, fr] = at(m.from[0], m.from[1]), [tc, tr] = at(m.to[0], m.to[1]);
    return [fr, fc, tr, tc] as const;
  });
}

/** How the game ended at a state for side A (the learner's), or null while it goes on. */
export function actualEnding(spec: GridSpec, state: GridState): number | null {
  const o = outcomeOf(spec, state);
  return o.over ? (o.winner === 'A' ? 1 : o.winner === 'B' ? -1 : 0) : null;
}

const key = (m: readonly number[]) => m.join(',');

/** The world's answer to a learner's predictions at one state. */
export function verdictAt(spec: GridSpec, sense: GridSense, state: GridState, predicted: { moves: readonly (readonly number[])[]; ending: number | null }): RulesVerdict {
  const over = outcomeOf(spec, state).over;
  const actual = actualMoves(spec, sense, state);
  const allowed = new Set(actual.map(key));
  const claimed = new Set((over ? [] : predicted.moves).map(key));
  const refused = over ? [] : predicted.moves.filter((m) => !allowed.has(key(m))).map((m) => [m[0], m[1], m[2], m[3]] as const);
  const missing = actual.filter((m) => !claimed.has(key(m))).length;
  const real = actualEnding(spec, state);
  const right = predicted.ending === null ? real === null : real !== null && Math.abs(predicted.ending - real) < 1e-9;
  return { refused, missing, ending: { predicted: predicted.ending, actual: real, right }, correct: refused.length === 0 && missing === 0 && right };
}

/** Run a learner's rules (compiled functions over the percept) at a state and ask the world. A rule that throws or answers
    in the wrong shape is a verdict too: it predicted nothing usable. */
export function checkRulesAt(spec: GridSpec, sense: GridSense, state: GridState,
  rules: { moves: (p: unknown) => unknown; ending: (p: unknown) => unknown }): RulesVerdict & { error?: string } {
  const p = readPicture(sense.render(state));
  let moves: number[][] = [], ending: number | null = null, error: string | undefined;
  try {
    const m = rules.moves(p);
    if (!Array.isArray(m) || !m.every((x) => Array.isArray(x) && x.length === 4 && x.every((v) => Number.isInteger(v)))) throw new Error('moves must return [[fromRow, fromCol, toRow, toCol], ...]');
    moves = m as number[][];
    const e = rules.ending(p);
    if (e !== null && e !== undefined && (typeof e !== 'number' || !Number.isFinite(e) || e < -1 || e > 1)) throw new Error('ending must return null or a number from -1 to 1');
    ending = e === undefined ? null : e as number | null;
  } catch (err) { error = String((err as Error)?.message ?? err); }
  return { ...verdictAt(spec, sense, state, { moves, ending }), ...(error ? { error } : {}) };
}

/* --- Operator only: the true rules, written as a learner would write them ------------------------ */

/** The edge of the picture a side must reach (for "reach"), as the learner sees it: 'top' | 'bottom' | 'left' | 'right'. */
export function goalEdge(spec: GridSpec, sense: GridSense): 'top' | 'bottom' | 'left' | 'right' {
  const a = orient(sense.orientation, 0, spec.goalRow, spec.width, spec.height), b = orient(sense.orientation, spec.width - 1, spec.goalRow, spec.width, spec.height);
  if (a[1] === b[1]) return a[1] === 0 ? 'top' : 'bottom';
  return a[0] === 0 ? 'left' : 'right';
}

/** OPERATOR ONLY: the hidden rules as code over the picture, relative to the board that is seen - what a learner that
    recovered them would write. For calibration: they must hold on every board of the family. Never shown to the learner. */
export function trueRulesSource(spec: GridSpec, sense: GridSense): { moves: string; ending: string } {
  const deltas = (vs: GridSpec['A']['moves']) => JSON.stringify(vs.map((v) => { const [dc, dr] = pictureDelta(spec, sense, v); return [dr, dc]; }));
  const A = JSON.stringify(sense.glyphA), B = JSON.stringify(sense.glyphB);
  const movesOf = 'function movesOf(p, g, ds) { const out = []; for (let r = 0; r < p.height; r++) for (let c = 0; c < p.width; c++) { if (p.cells[r][c] !== g) continue;'
    + ' for (const [dr, dc] of ds) { const R = r + dr, C = c + dc; if (R >= 0 && R < p.height && C >= 0 && C < p.width && p.cells[R][C] === ".") out.push([r, c, R, C]); } } return out; }';
  const moves = '(p) => { ' + movesOf + ' return p.toMove === ' + A + ' ? movesOf(p, ' + A + ', ' + deltas(spec.A.moves) + ') : movesOf(p, ' + B + ', ' + deltas(spec.B.moves) + '); }';
  const edge = goalEdge(spec, sense);
  const onEdge = edge === 'top' ? 'r === 0' : edge === 'bottom' ? 'r === p.height - 1' : edge === 'left' ? 'c === 0' : 'c === p.width - 1';
  const lines = ['(p) => { ' + movesOf,
    ' const at = (g) => { const out = []; for (let r = 0; r < p.height; r++) for (let c = 0; c < p.width; c++) if (p.cells[r][c] === g) out.push([r, c]); return out; };',
    ' const a = at(' + A + '), b = at(' + B + ');'];
  if (spec.winB === 'reach') lines.push(' if (b.some(([r, c]) => ' + onEdge + ')) return -1;');
  if (spec.winA === 'tag') lines.push(' if (a.some(([r, c]) => b.some(([R, C]) => Math.max(Math.abs(r - R), Math.abs(c - C)) === 1))) return 1;');
  if (spec.winA === 'trap') lines.push(' if (movesOf(p, ' + B + ', ' + deltas(spec.B.moves) + ').length === 0) return 1;');
  lines.push(' if (p.move >= ' + spec.maxPlies + ') return ' + (spec.winB === 'survive' ? '-1' : '0') + ';', ' return null; }');
  return { moves, ending: lines.join('') };
}
