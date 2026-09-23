import type { Entity, Outcome, View, World } from '../../core/types.ts';

/* ============================================================================
 * foxhounds@1 - "El Gato y el Ratón" as a World. A faithful port of the harness's
 * rules engine (fox-hounds-harness.html, RULES ENGINE block); the parity test
 * compares both on random playouts.
 * x = column 0..7, y = row 0..7 (0 = Cat home row and Mouse goal).
 * ========================================================================== */

export const FOXHOUNDS_ID = 'foxhounds@1';
export const BOARD_SIZE = 8;
export const CAT_HOME_ROW = 0;
export const MOUSE_HOME_ROW = BOARD_SIZE - 1;
export const CAT_START_COLS = [1, 3, 5, 7] as const;
export const MOUSE_START_COLS = [0, 2, 4, 6] as const;
export const SIDE_CATS = 'cats';
export const SIDE_MOUSE = 'mouse';
export const WINNER_DRAW = 'draw';
export const DIAGONALS = [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const;
export const CAT_FORWARD_DY = 1;
export const MAX_PLIES = 200;

export type Square = readonly [number, number];
export type Side = typeof SIDE_CATS | typeof SIDE_MOUSE;

export interface FoxState {
  readonly cats: readonly Square[];
  readonly mouse: Square;
  readonly turn: Side;
  readonly ply: number;
}

export interface FoxMove {
  readonly piece: Side;
  readonly catIndex: number;
  readonly from: Square;
  readonly to: Square;
}

export const RULES_OF_THE_GAME = 'Four Cats against one Mouse on an 8x8 board; only dark squares can be occupied ' +
  '(x + y must be odd). Cats start on row 0 at columns 1,3,5,7 and move one square diagonally FORWARD only ' +
  '(y increases toward 7). The Mouse starts on row 7 on an even column and moves one square diagonally FORWARD ' +
  'or BACKWARD. Cats win when the Mouse has no legal move (it is trapped). The Mouse wins by reaching row 0, ' +
  'or by getting above every Cat (mouse.y smaller than the smallest Cat row).';

export function inBounds(x: number, y: number): boolean { return x >= 0 && x < BOARD_SIZE && y >= 0 && y < BOARD_SIZE; }
export function isDarkSquare(x: number, y: number): boolean { return ((x + y) % 2) === 1; }
const occKey = (x: number, y: number): string => x + ':' + y;

export function occupancy(state: FoxState): Map<string, Side> {
  const map = new Map<string, Side>();
  for (const c of state.cats) map.set(occKey(c[0], c[1]), SIDE_CATS);
  map.set(occKey(state.mouse[0], state.mouse[1]), SIDE_MOUSE);
  return map;
}
export function isOccupied(state: FoxState, x: number, y: number): boolean { return occupancy(state).has(occKey(x, y)); }

/** Row of the Cat closest to row 0 (the last line of defence). */
export function minCatRow(state: FoxState): number {
  return state.cats.length ? Math.min(...state.cats.map((c) => c[1])) : BOARD_SIZE;
}
/** Row of the most advanced Cat (the front of the line). */
export function maxCatRow(state: FoxState): number {
  return state.cats.length ? Math.max(...state.cats.map((c) => c[1])) : -1;
}

export function legalMovesForSide(state: FoxState, side: Side): FoxMove[] {
  const occ = occupancy(state);
  const moves: FoxMove[] = [];
  if (side === SIDE_CATS) {
    state.cats.forEach((cat, index) => {
      for (const [dx, dy] of DIAGONALS) {
        if (dy !== CAT_FORWARD_DY) continue;
        const nx = cat[0] + dx, ny = cat[1] + dy;
        if (!inBounds(nx, ny) || !isDarkSquare(nx, ny) || occ.has(occKey(nx, ny))) continue;
        moves.push({ piece: SIDE_CATS, catIndex: index, from: [cat[0], cat[1]], to: [nx, ny] });
      }
    });
    return moves;
  }
  for (const [dx, dy] of DIAGONALS) {
    const nx = state.mouse[0] + dx, ny = state.mouse[1] + dy;
    if (!inBounds(nx, ny) || !isDarkSquare(nx, ny) || occ.has(occKey(nx, ny))) continue;
    moves.push({ piece: SIDE_MOUSE, catIndex: -1, from: [state.mouse[0], state.mouse[1]], to: [nx, ny] });
  }
  return moves;
}

/** A square a Cat could step onto next move (Cats attack forward diagonals only). */
export function isSquareAttackedByCats(state: FoxState, square: Square): boolean {
  const [tx, ty] = square;
  if (!inBounds(tx, ty) || !isDarkSquare(tx, ty)) return false;
  if (isOccupied(state, tx, ty)) return false;
  return state.cats.some((c) => c[1] === ty - 1 && Math.abs(c[0] - tx) === 1);
}

export function applyMove(state: FoxState, move: FoxMove): FoxState {
  const cats = state.cats.map((c) => [c[0], c[1]] as Square);
  let mouse: Square = [state.mouse[0], state.mouse[1]];
  if (move.piece === SIDE_CATS) cats[move.catIndex] = [move.to[0], move.to[1]];
  else mouse = [move.to[0], move.to[1]];
  return { cats, mouse, turn: state.turn === SIDE_CATS ? SIDE_MOUSE : SIDE_CATS, ply: state.ply + 1 };
}

export function passTurn(state: FoxState): FoxState {
  return {
    cats: state.cats.map((c) => [c[0], c[1]] as Square), mouse: [state.mouse[0], state.mouse[1]],
    turn: state.turn === SIDE_CATS ? SIDE_MOUSE : SIDE_CATS, ply: state.ply + 1
  };
}

export function outcome(state: FoxState): Outcome {
  const mouseY = state.mouse[1];
  if (!state.cats.length) return { over: true, winner: SIDE_MOUSE, reason: 'no_cats_on_board' };
  if (mouseY === CAT_HOME_ROW) return { over: true, winner: SIDE_MOUSE, reason: 'mouse_reached_row_0' };
  if (mouseY < minCatRow(state)) return { over: true, winner: SIDE_MOUSE, reason: 'mouse_bypassed_cats' };
  if (legalMovesForSide(state, SIDE_MOUSE).length === 0) return { over: true, winner: SIDE_CATS, reason: 'mouse_trapped' };
  if (state.ply >= MAX_PLIES) return { over: true, winner: WINNER_DRAW, reason: 'ply_cap_stalemate' };
  return { over: false, winner: null, reason: null };
}

/** Canonical, order-independent key (identical to the harness's stateKey). */
export function stateKey(state: FoxState): string {
  const cats = state.cats.map((c) => c[0] + ',' + c[1]).sort().join('|');
  return 'C[' + cats + ']M' + state.mouse[0] + ',' + state.mouse[1] + 'T' + state.turn;
}

/** The plain-data view: the harness's position array, with `type` naming the entity group. */
export function foxView(state: FoxState): View {
  const entities: Entity[] = state.cats.map((c, index) => ({ type: 'cat', id: index, index, x: c[0], y: c[1] }));
  entities.push({ type: 'mouse', id: 0, index: 0, x: state.mouse[0], y: state.mouse[1] });
  return { entities, scalars: { ply: state.ply, turn: state.turn, board_size: BOARD_SIZE } };
}

export const foxhounds: World<FoxState, FoxMove> = {
  id: FOXHOUNDS_ID,
  actors: [SIDE_CATS, SIDE_MOUSE],
  initial(options) {
    const requested = Number(options?.mouseStartCol);
    const col = (MOUSE_START_COLS as readonly number[]).includes(requested) ? requested : MOUSE_START_COLS[0];
    return { cats: CAT_START_COLS.map((x) => [x, CAT_HOME_ROW] as Square), mouse: [col, MOUSE_HOME_ROW], turn: SIDE_CATS, ply: 0 };
  },
  toMove: (state) => state.turn,
  actions: (state, actor) => legalMovesForSide(state, (actor ?? state.turn) as Side),
  step: applyMove,
  pass: passTurn,
  outcome,
  key: stateKey,
  view: foxView,
  describeRules: () => RULES_OF_THE_GAME,
  describeAction(move) {
    const actor = move.piece === SIDE_CATS ? 'cat#' + (move.catIndex + 1) : 'mouse';
    return actor + ' (' + move.from.join(',') + ')->(' + move.to.join(',') + ')';
  }
};
