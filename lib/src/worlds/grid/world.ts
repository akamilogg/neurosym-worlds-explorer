import type { Entity, Outcome, View, World } from '../../core/types.ts';

/* ============================================================================
 * grid@1 - a seeded FAMILY of two-player board games nobody has seen before.
 *
 * A seed draws: board size and shape, how many pieces each side has and how they
 * move, where they start, what makes each side win, and the move limit. Pieces block
 * each other; there are no captures. Side "A" moves first and is the side the learner
 * plays (the maximizer); side "B" is played by a deterministic planner.
 *
 * Win conditions (drawn per seed):
 *   A: "trap"  - B cannot move              | "tag"  - an A piece stands next to a B piece
 *   B: "reach" - a B piece stands on the goal edge | "survive" - the move limit is reached
 * Nothing here is ever described to the learner in words: it perceives the ASCII sense.
 * ========================================================================== */

export type Vec = readonly [number, number];
export type Side = 'A' | 'B';

export interface SideSpec {
  readonly count: number;
  readonly moves: readonly Vec[];
  readonly start: readonly Vec[];
}

export interface GridSpec {
  readonly id: string;
  readonly seed: number;
  readonly width: number;
  readonly height: number;
  /** "checker": only squares with (x + y) odd exist. */
  readonly shape: 'full' | 'checker';
  readonly A: SideSpec;
  readonly B: SideSpec;
  readonly winA: 'trap' | 'tag';
  readonly winB: 'reach' | 'survive';
  /** The goal edge row for "reach". */
  readonly goalRow: number;
  readonly maxPlies: number;
}

export interface GridState {
  readonly a: readonly Vec[];
  readonly b: readonly Vec[];
  readonly turn: Side;
  readonly ply: number;
}

export interface GridMove {
  readonly side: Side;
  readonly piece: number;
  readonly from: Vec;
  readonly to: Vec;
}

export function exists(spec: GridSpec, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= spec.width || y >= spec.height) return false;
  return spec.shape === 'full' || (x + y) % 2 === 1;
}

const occupied = (s: GridState, x: number, y: number): boolean =>
  s.a.some((p) => p[0] === x && p[1] === y) || s.b.some((p) => p[0] === x && p[1] === y);

export function movesFor(spec: GridSpec, s: GridState, side: Side): GridMove[] {
  const pieces = side === 'A' ? s.a : s.b;
  const vectors = side === 'A' ? spec.A.moves : spec.B.moves;
  const out: GridMove[] = [];
  pieces.forEach((p, piece) => {
    for (const [dx, dy] of vectors) {
      const x = p[0] + dx, y = p[1] + dy;
      if (!exists(spec, x, y) || occupied(s, x, y)) continue;
      out.push({ side, piece, from: [p[0], p[1]], to: [x, y] });
    }
  });
  return out;
}

export function outcomeOf(spec: GridSpec, s: GridState): Outcome {
  if (spec.winB === 'reach' && s.b.some((p) => p[1] === spec.goalRow)) return { over: true, winner: 'B', reason: 'reach' };
  if (spec.winA === 'tag' && s.a.some((a) => s.b.some((b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])) === 1))) {
    return { over: true, winner: 'A', reason: 'tag' };
  }
  if (spec.winA === 'trap' && movesFor(spec, s, 'B').length === 0) return { over: true, winner: 'A', reason: 'trap' };
  if (s.ply >= spec.maxPlies) return spec.winB === 'survive' ? { over: true, winner: 'B', reason: 'survive' } : { over: true, winner: 'draw', reason: 'limit' };
  return { over: false, winner: null, reason: null };
}

export function stepGrid(s: GridState, m: GridMove): GridState {
  const move = (list: readonly Vec[]) => list.map((p, i) => (i === m.piece ? [m.to[0], m.to[1]] as Vec : [p[0], p[1]] as Vec));
  return { a: m.side === 'A' ? move(s.a) : s.a.map((p) => [p[0], p[1]] as Vec), b: m.side === 'B' ? move(s.b) : s.b.map((p) => [p[0], p[1]] as Vec),
    turn: s.turn === 'A' ? 'B' : 'A', ply: s.ply + 1 };
}

export function gridKey(s: GridState): string {
  const list = (l: readonly Vec[]) => l.map((p) => p[0] + ',' + p[1]).sort().join('|');
  return 'A[' + list(s.a) + ']B[' + list(s.b) + ']T' + s.turn;
}

export function createGridWorld(spec: GridSpec): World<GridState, GridMove> {
  return {
    id: 'grid@1:' + spec.id,
    actors: ['A', 'B'],
    initial: () => ({ a: spec.A.start.map((p) => [p[0], p[1]] as Vec), b: spec.B.start.map((p) => [p[0], p[1]] as Vec), turn: 'A', ply: 0 }),
    toMove: (s) => s.turn,
    actions: (s, actor) => movesFor(spec, s, (actor ?? s.turn) as Side),
    step: stepGrid,
    pass: (s) => ({ a: s.a.map((p) => [p[0], p[1]] as Vec), b: s.b.map((p) => [p[0], p[1]] as Vec), turn: s.turn === 'A' ? 'B' : 'A', ply: s.ply + 1 }),
    outcome: (s) => outcomeOf(spec, s),
    key: gridKey,
    view: (s): View => {
      const entities: Entity[] = [
        ...s.a.map((p, i) => ({ type: 'A', id: 'A' + i, x: p[0], y: p[1] })),
        ...s.b.map((p, i) => ({ type: 'B', id: 'B' + i, x: p[0], y: p[1] }))
      ];
      return { entities, scalars: { ply: s.ply, turn: s.turn, width: spec.width, height: spec.height } };
    },
    /* Deliberately empty: the learner is told NOTHING about the rules. */
    describeRules: () => '',
    actionKey: (m) => m.side + m.piece + ':' + m.from.join(',') + '>' + m.to.join(','),
    describeAction: (m) => m.from.join(',') + '>' + m.to.join(',')
  };
}
