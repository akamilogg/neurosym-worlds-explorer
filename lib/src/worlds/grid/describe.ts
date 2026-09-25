import { orient, type GridSense } from './sense.ts';
import type { GridSpec, Vec } from './world.ts';

/* ============================================================================
 * OPERATOR ONLY. The hidden rules of a grid game, stated in the coordinates of
 * the picture System 2 perceives (column = left to right, row = top to bottom,
 * glyphs as drawn). It exists to GRADE what System 2 recovered at the end of a
 * run; it must never reach System 2, the Judge, or anything they read.
 * ========================================================================== */

export interface TruthStatement {
  readonly id: string;
  readonly statement: string;
}

const NAMES: Record<string, string> = {
  '0,-1': 'up', '0,1': 'down', '-1,0': 'left', '1,0': 'right',
  '-1,-1': 'up-left', '1,-1': 'up-right', '-1,1': 'down-left', '1,1': 'down-right'
};

/** A board vector as the picture shows it: [column change, row change]. */
export function pictureDelta(spec: GridSpec, sense: GridSense, [dx, dy]: Vec): Vec {
  const [x0, y0] = orient(sense.orientation, 0, 0, spec.width, spec.height);
  const [x1, y1] = orient(sense.orientation, dx, dy, spec.width, spec.height);
  return [x1 - x0, y1 - y0];
}

export function describeGridTruth(spec: GridSpec, sense: GridSense): TruthStatement[] {
  const A = sense.glyphA, B = sense.glyphB;
  const moves = (vs: readonly Vec[]) => vs.map((v) => NAMES[pictureDelta(spec, sense, v).join(',')]).sort().join(', ');
  const out: TruthStatement[] = [
    { id: 'moves_you', statement: `Your pieces (${A}) move one square per turn, only in these picture directions: ${moves(spec.A.moves)}; the target square must exist and be empty (no captures, no jumps).` },
    { id: 'moves_other', statement: `The other player's pieces (${B}) move one square per turn, only in these picture directions: ${moves(spec.B.moves)}; the target square must exist and be empty.` }
  ];
  if (spec.shape === 'checker') out.push({ id: 'board', statement: 'Only half the squares exist (a checkerboard pattern); the blank ones cannot be entered.' });
  out.push(spec.winA === 'tag'
    ? { id: 'win_you', statement: `You win as soon as one of your pieces (${A}) is on any of the 8 squares around a piece of the other player (${B}), diagonals included.` }
    : { id: 'win_you', statement: `You win when the other player (${B}) has no legal move (it is trapped).` });
  if (spec.winB === 'reach') {
    const transposed = sense.orientation >= 4;
    const [X, Y] = orient(sense.orientation, 0, spec.goalRow, spec.width, spec.height);
    out.push({ id: 'win_other', statement: `The other player wins as soon as one of its pieces (${B}) reaches picture ${transposed ? 'column ' + X : 'row ' + Y}.` });
  } else {
    out.push({ id: 'win_other', statement: `The other player wins if the game reaches move ${spec.maxPlies} without you having won (it only has to survive).` });
  }
  if (spec.winB !== 'survive') out.push({ id: 'draw', statement: `If the game reaches move ${spec.maxPlies} with no winner, it is a draw.` });
  return out;
}
