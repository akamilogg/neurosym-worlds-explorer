import { mulberry32 } from './gen.ts';
import { exists, type GridSpec, type GridState } from './world.ts';

/* ============================================================================
 * The predefined SENSE of grid@1: an ASCII picture of the state, computed
 * deterministically. It is all System 2 and Jev ever perceive of this world: no rules,
 * no legal moves, no names with meaning. Glyphs are drawn per seed from a neutral
 * pool, so nothing in the picture hints at a role.
 *
 *      0 1 2 3 4
 *   0  . # . # .
 *   1  . . . . .
 *   ...
 *   4  . . @ . .
 *   you: #   to move: #   move 3
 * ========================================================================== */

/* Symbols only: a letter glyph would also appear inside the words of the legend ("you", "to move"). */
const POOL = ['#', '@', '%', '&', '+', '*', '$', '=', '~', '^'];

export interface GridSense {
  readonly glyphA: string;
  readonly glyphB: string;
  /** Which of the 8 symmetries of the board the picture uses (0 = as stored). */
  readonly orientation: number;
  render(state: GridState): string;
}

/* The picture is drawn under one of the 8 symmetries of the rectangle (rotations and reflections), drawn per seed:
   "one side starts at the top and runs down" would otherwise be a cue shared by every game of the family. */
function orient(o: number, x: number, y: number, w: number, h: number): [number, number] {
  switch (o) {
    case 1: return [w - 1 - x, y];
    case 2: return [x, h - 1 - y];
    case 3: return [w - 1 - x, h - 1 - y];
    case 4: return [y, x];
    case 5: return [h - 1 - y, x];
    case 6: return [y, w - 1 - x];
    case 7: return [h - 1 - y, w - 1 - x];
    default: return [x, y];
  }
}

export function asciiSense(spec: GridSpec): GridSense {
  const rnd = mulberry32(spec.seed * 31 + 7);
  const pool = POOL.slice();
  const glyphA = pool.splice(Math.floor(rnd() * pool.length), 1)[0];
  const glyphB = pool.splice(Math.floor(rnd() * pool.length), 1)[0];
  const orientation = Math.floor(rnd() * 8);
  const transposed = orientation >= 4;
  const W = transposed ? spec.height : spec.width;
  const H = transposed ? spec.width : spec.height;
  return {
    glyphA,
    glyphB,
    orientation,
    render(state) {
      const cells: string[][] = Array.from({ length: H }, () => Array.from({ length: W }, () => ' '));
      for (let y = 0; y < spec.height; y++) {
        for (let x = 0; x < spec.width; x++) {
          const [X, Y] = orient(orientation, x, y, spec.width, spec.height);
          cells[Y][X] = state.a.some((p) => p[0] === x && p[1] === y) ? glyphA
            : state.b.some((p) => p[0] === x && p[1] === y) ? glyphB
            : exists(spec, x, y) ? '.' : ' ';
        }
      }
      const lines: string[] = ['    ' + Array.from({ length: W }, (_, x) => String(x)).join(' ')];
      cells.forEach((row, Y) => lines.push(String(Y).padStart(2) + '  ' + row.join(' ')));
      lines.push('you: ' + glyphA + '   to move: ' + (state.turn === 'A' ? glyphA : glyphB) + '   move ' + state.ply);
      return lines.join('\n');
    }
  };
}
