import { mulberry32 } from '../grid/gen.ts';
import { toPercept, type OrbitSpec, type Trajectory, type Vec2 } from './world.ts';

/* ============================================================================
 * The predefined SENSE of orbit@1: a table of positions over time, in the
 * learner's own frame (rotated, mirrored, scaled and shifted per seed, with its
 * own time unit), with noise on every position. It is all System 2 ever
 * perceives of this world: no velocities, no accelerations, no masses of the
 * sources, no names with meaning. Symbols are drawn per seed from a neutral pool.
 *
 *         t          # x          # y          @ x          @ y
 *     0.000    12.411302    -3.070215     0.020117     0.000304
 *     0.518    12.362841    -2.510933     0.019904    -0.000213
 *     ...
 *
 * A probe outside the observable region is not seen: its cells read "·".
 * ========================================================================== */

const POOL = ['#', '@', '%', '&', '+', '*', '$', '=', '~', '^'];
const HIDDEN = '·';

export interface OrbitSenseOptions {
  /** Round every perceived position to a multiple of this (0: continuous). An experiment flag (--resolution). */
  readonly resolution?: number;
  /** false: show the probe outside the observable region too (the operator's view, or a trial's extrapolation band). */
  readonly window?: boolean;
}

export interface OrbitSense {
  /** One symbol per source, in the order of spec.sources, and the probe's. */
  readonly sourceGlyphs: readonly string[];
  readonly probeGlyph: string;
  render(trajectory: Trajectory): string;
}

/** A deterministic 32-bit hash of a string (FNV-1a), to seed the noise of one trajectory. */
function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

function gaussian(rnd: () => number): number {
  const u = Math.max(rnd(), 1e-12), v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function tableSense(spec: OrbitSpec, options: OrbitSenseOptions = {}): OrbitSense {
  const rnd = mulberry32(spec.seed * 53 + 11);
  const pool = POOL.slice();
  /* The launched body first, then the sources in order: the same symbols in every setup of a family (setups share the
     seed), however many sources each one has. */
  const probeGlyph = pool.splice(Math.floor(rnd() * pool.length), 1)[0];
  const sourceGlyphs = spec.sources.map(() => pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
  const resolution = options.resolution ?? 0;
  const windowed = options.window ?? true;
  const sigma = spec.noise * spec.frame.scale;
  const decimals = resolution > 0 ? Math.max(0, Math.ceil(-Math.log10(resolution) - 1e-9)) : 6;
  const cell = (v: number): string => (resolution > 0 ? Math.round(v / resolution) * resolution : v).toFixed(decimals).padStart(13);
  return {
    sourceGlyphs,
    probeGlyph,
    render(trajectory) {
      /* The same trajectory always reads the same: the noise is seeded by the world and the trajectory's name. */
      const noise = mulberry32(hash32(spec.id + '|' + trajectory.id));
      const seen = (p: Vec2): [number, number] => {
        const q = toPercept.pos(spec.frame, p);
        return [q[0] + sigma * gaussian(noise), q[1] + sigma * gaussian(noise)];
      };
      const glyphs = [...sourceGlyphs, probeGlyph];
      const lines = ['         t' + glyphs.map((g) => (g + ' x').padStart(13) + (g + ' y').padStart(13)).join('')];
      for (const s of trajectory.states) {
        const cells = [toPercept.time(spec.frame, s.t).toFixed(3).padStart(10)];
        for (const src of spec.sources) { const q = seen(src.pos); cells.push(cell(q[0]), cell(q[1])); }
        if (!windowed || Math.hypot(s.pos[0], s.pos[1]) <= spec.window) { const q = seen(s.pos); cells.push(cell(q[0]), cell(q[1])); }
        else cells.push(HIDDEN.padStart(13), HIDDEN.padStart(13));
        lines.push(cells.join(''));
      }
      return lines.join('\n');
    }
  };
}

/** What a perception-only measure may read: the table itself and the same table as columns. No law, no velocities,
    no masses of the sources. A position outside the observable region is null. */
export interface OrbitPercept {
  readonly table: string;
  readonly t: readonly number[];
  /** Per symbol, its x and y column. */
  readonly bodies: Readonly<Record<string, { readonly x: readonly (number | null)[]; readonly y: readonly (number | null)[] }>>;
  readonly symbols: readonly string[];
}

export function readTable(table: string): OrbitPercept {
  const lines = table.split('\n').filter((l) => l.trim());
  const header = lines[0].trim().split(/\s+/).slice(1);
  const symbols: string[] = [];
  for (let i = 0; i + 1 < header.length; i += 4) symbols.push(header[i]);
  const t: number[] = [];
  const cols = symbols.map(() => ({ x: [] as (number | null)[], y: [] as (number | null)[] }));
  for (const line of lines.slice(1)) {
    const cells = line.trim().split(/\s+/);
    t.push(Number(cells[0]));
    symbols.forEach((_, i) => {
      const x = cells[1 + 2 * i], y = cells[2 + 2 * i];
      cols[i].x.push(x === HIDDEN ? null : Number(x));
      cols[i].y.push(y === HIDDEN ? null : Number(y));
    });
  }
  return { table, t, symbols, bodies: Object.fromEntries(symbols.map((g, i) => [g, cols[i]])) };
}

/** What the learner is told about the object its code receives: the shape of the table, nothing about the world. */
export const ORBIT_PERCEPT_DOC = [
  'An observation is a JavaScript function `(p) => number` (or, without a range, `(p) => text`); a direction is `(p) => [x, y]`.',
  '`p` is one table you perceive, up to its CURRENT row (the last one; later rows are never included), already read for you:',
  '  p.table    the table exactly as shown (a string)',
  '  p.t        the time of each row (numbers)',
  '  p.symbols  one symbol per body, in the order of the columns; the LAST one is the body you launched',
  '  p.bodies   p.bodies[symbol].x[row] and .y[row]: its position at each row, or null where it is not seen',
  'The current row is p.t.length - 1.'
].join('\n');
