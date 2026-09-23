import { clamp } from '../../core/hash.ts';
import { opDialect, type OpDef } from '../../core/dialect.ts';
import {
  DIAGONALS, FOXHOUNDS_ID, SIDE_MOUSE, inBounds, isDarkSquare, isSquareAttackedByCats, legalMovesForSide,
  maxCatRow, minCatRow, occupancy, type FoxState
} from './world.ts';

/* ============================================================================
 * foxhounds@1 dialect - the harness's OBSERVATION_OPS catalogue, moved out of the
 * core. It is the experiment DESIGNER's vocabulary: several ops (mouse_routes,
 * covered_mouse_moves) encode strategic knowledge of the game, which is exactly why
 * it is a plugin and not the library. An experiment that wants the features to be
 * discovered admits only "code" (or only core@1) and leaves this dialect out.
 * ========================================================================== */

export const FOXHOUNDS_DIALECT_ID = 'foxhounds@1';

const ops: Record<string, OpDef<FoxState>> = {
  cat_row_spread: {
    name: 'row spread', range: [0, 7],
    definition: 'max(cat row) minus min(cat row): how far the line has stretched lengthwise',
    fn: ({ state }) => { const rows = state.cats.map((c) => c[1]); return Math.max(...rows) - Math.min(...rows); }
  },
  cat_front_row: {
    name: 'front row', range: [0, 7], definition: 'the row of the most advanced Cat',
    fn: ({ state }) => maxCatRow(state)
  },
  cat_rear_row: {
    name: 'rear row', range: [0, 7], definition: 'the row of the least advanced Cat',
    fn: ({ state }) => minCatRow(state)
  },
  cats_on_front_row: {
    name: 'cats on the front row', range: [0, 4],
    definition: 'how many of the four Cats stand on the row of the most advanced Cat',
    fn: ({ state }) => { const row = maxCatRow(state); return state.cats.filter((c) => c[1] === row).length; }
  },
  cat_count_left_behind: {
    name: 'cats left behind', range: [0, 3],
    definition: 'how many Cats are NOT on the front row (4 minus cats_on_front_row)',
    fn: ({ state }) => { const row = maxCatRow(state); return state.cats.filter((c) => c[1] !== row).length; }
  },
  front_row_gap: {
    name: 'gap in the front row', range: [0, 6],
    definition: 'the longest run of empty dark squares between two Cats of the front row (0 when fewer than two Cats are there); dark squares on one row are two columns apart',
    fn: ({ state }) => {
      const row = maxCatRow(state);
      const cols = state.cats.filter((c) => c[1] === row).map((c) => c[0]).sort((a, b) => a - b);
      if (cols.length < 2) return 0;
      let longest = 0;
      for (let i = 1; i < cols.length; i++) longest = Math.max(longest, (cols[i] - cols[i - 1]) / 2 - 1);
      return longest;
    }
  },
  cat_adjacent_pairs: {
    name: 'adjacent Cat pairs', range: [0, 6],
    definition: 'how many pairs of Cats touch diagonally (a chain of four has three, a tight block more)',
    fn: ({ state }) => {
      let pairs = 0;
      for (let i = 0; i < state.cats.length; i++) {
        for (let j = i + 1; j < state.cats.length; j++) {
          if (Math.abs(state.cats[i][0] - state.cats[j][0]) === 1 && Math.abs(state.cats[i][1] - state.cats[j][1]) === 1) pairs++;
        }
      }
      return pairs;
    }
  },
  mouse_row: {
    name: 'Mouse row', range: [0, 7], definition: 'the Mouse row: 0 is its goal, 7 is its start',
    fn: ({ state }) => state.mouse[1]
  },
  mouse_mobility: {
    name: 'Mouse mobility', range: [0, 4], definition: 'how many legal moves the Mouse has right now',
    fn: ({ state }) => legalMovesForSide(state, SIDE_MOUSE).length
  },
  covered_mouse_moves: {
    name: 'covered Mouse exits', range: [0, 4],
    definition: 'how many of the Mouse legal moves land on a square the Cats attack',
    fn: ({ state }) => legalMovesForSide(state, SIDE_MOUSE).filter((m) => isSquareAttackedByCats(state, m.to)).length
  },
  mouse_routes: {
    name: 'Mouse routes', range: [0, 8], args: { cap: { min: 1, max: 8, default: 3 } },
    definition: 'how many distinct monotone paths the Mouse has from its square to row 0 (one row up per step, dark squares only) that avoid every square the Cats attack; the count stops at `cap`',
    fn: ({ state }, args) => {
      const cap = clamp(Math.round(args.cap), 1, 8);
      const upSteps = DIAGONALS.filter((d) => d[1] === -1).map((d) => d[0]);
      const occupied = occupancy(state);
      const memo = new Map<string, number>();
      const count = (x: number, y: number): number => {
        if (y === 0) return 1;
        const key = x + ',' + y;
        const known = memo.get(key);
        if (known !== undefined) return known;
        let total = 0;
        for (const dx of upSteps) {
          const nx = x + dx, ny = y - 1;
          if (!inBounds(nx, ny) || !isDarkSquare(nx, ny)) continue;
          if (occupied.has(nx + ':' + ny)) continue;
          if (isSquareAttackedByCats(state, [nx, ny])) continue;
          total += count(nx, ny);
          if (total >= cap) { total = cap; break; }
        }
        const settled = Math.min(total, cap);
        memo.set(key, settled);
        return settled;
      };
      return Math.min(count(state.mouse[0], state.mouse[1]), cap);
    }
  },
  cat_mouse_row_gap: {
    name: 'Cat/Mouse row gap', range: [-7, 7],
    definition: 'rearmost Cat row minus Mouse row: positive means every Cat is behind the Mouse',
    fn: ({ state }) => minCatRow(state) - state.mouse[1]
  }
};

export const foxhoundsDialect = opDialect<FoxState>(FOXHOUNDS_DIALECT_ID, ops, [FOXHOUNDS_ID]);
export const FOXHOUNDS_OPS: Readonly<Record<string, OpDef<FoxState>>> = ops;
