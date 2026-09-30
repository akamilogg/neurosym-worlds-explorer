import { hashString } from '../../core/hash.ts';
import type { World } from '../../core/types.ts';
import { toPercept, type SceneSpec, type Start } from './scene.ts';

/* ============================================================================
 * particles3d@1 as the learner perceives it: a TABLE per episode. Its first column is time;
 * then three columns (x, y, z) for every object that shows: the particles, and one marker
 * per source of a field (a column that does not move, but for the noise of perception). The
 * columns have neutral names (letters); nothing says which are markers, what a field is, nor
 * that the world is Blender. A value is null where an object is not there (yet).
 *
 * The positions are Blender's, through the scene's frame (axes turned, scaled, shifted; the
 * time unit), with gaussian noise of perception drawn from the episode's own seed.
 * ========================================================================== */

/** An episode as perceived: the times, the columns, and per row the position of each column (or null). */
export interface P3Episode {
  readonly t: readonly number[];
  readonly names: readonly string[];
  readonly rows: readonly (readonly (readonly number[] | null)[])[];
  /** How it started: 'the environment', or the learner's act (in the percept's units). */
  readonly from: unknown;
  /** OPERATOR ONLY: which columns are particles (the rest are markers), and the rows (from the start) up to which a law
      could predict at all - the world's own predictability, measured by perturbing the start (SPEC-MUNDO-3D §5.2). */
  readonly bodies: readonly string[];
  readonly horizon?: number;
}

/** A point: the table up to a row (the past and the present, never what comes next). */
export interface P3Point {
  readonly t: readonly number[];
  readonly names: readonly string[];
  readonly rows: readonly (readonly (readonly number[] | null)[])[];
}

/** What the learner's code reads of a point. */
export interface P3Percept {
  readonly t: readonly number[];
  readonly names: readonly string[];
  readonly series: Readonly<Record<string, { readonly x: readonly (number | null)[]; readonly y: readonly (number | null)[]; readonly z: readonly (number | null)[] }>>;
}

export const P3_PERCEPT_DOC = 'At a point of an episode your code receives p = { t, names, series }: `p.t` is the first column (time), oldest first, up to the present row; '
  + '`p.names` the other columns\' names; `p.series[name]` = { x, y, z }, the three columns of that name, oldest first (a value is null where nothing was there).';

export function perceiveP3(point: P3Point): P3Percept {
  const series: Record<string, { x: (number | null)[]; y: (number | null)[]; z: (number | null)[] }> = {};
  point.names.forEach((n, j) => {
    series[n] = { x: point.rows.map((r) => r[j]?.[0] ?? null), y: point.rows.map((r) => r[j]?.[1] ?? null), z: point.rows.map((r) => r[j]?.[2] ?? null) };
  });
  return { t: point.t, names: point.names, series };
}

export function p3PointWorld(): World<P3Point, never> {
  return {
    id: 'particles3d@1',
    actors: ['nature'],
    initial: () => { throw new Error('particles3d@1 has no initial state: points come from episodes'); },
    toMove: () => 'nature',
    actions: () => [],
    step: (s) => s,
    outcome: () => ({ over: false, winner: null, reason: null }),
    key: (s) => hashString(JSON.stringify([s.t.length, s.rows])),
    view: () => ({ entities: [], scalars: {} }),
    describeRules: () => '',
    actionKey: () => ''
  };
}

const sig = (n: number) => Number(n.toPrecision(7));

/** A standard normal draw. */
function gauss(rnd: () => number): number {
  const u = Math.max(rnd(), 1e-12), v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** The noise of perception, in the table's units: `noise` (relative to the box) times the frame's scale. */
export const noiseOf = (spec: SceneSpec, noise: number) => noise * spec.region * spec.frame.scale;

/** What Blender answered, as perceived: the frame, the noise, the markers, the columns in order of their names. */
export function perceiveEpisode(spec: SceneSpec, starts: readonly Start[], rows: readonly (readonly (readonly number[] | null)[])[], noise: number, rnd: () => number, from: unknown): P3Episode {
  const sd = noiseOf(spec, noise);
  const names = [...spec.markers.map((m) => m.name), ...starts.map((s) => s.name)].sort();
  const markerAt = new Map(spec.markers.map((m) => [m.name, spec.fields[m.field].location]));
  const bodyIndex = new Map(starts.map((s, i) => [s.name, i]));
  const noisy = (w: readonly number[]) => toPercept(spec.frame, w).map((v) => sig(v + sd * gauss(rnd)));
  return {
    t: rows.map((_, i) => sig(i * spec.frame.tau)),
    names,
    rows: rows.map((row) => names.map((n) => {
      const m = markerAt.get(n);
      if (m) return noisy(m);
      const w = row[bodyIndex.get(n)!];
      return w ? noisy(w) : null;
    })),
    from,
    bodies: starts.map((s) => s.name)
  };
}

/** The point at a row: the table up to it. */
export const pointAt = (e: P3Episode, row: number): P3Point => ({ t: e.t.slice(0, row + 1), names: e.names, rows: e.rows.slice(0, row + 1) });

/** A table as text: a header, then one line per row (for `view` and the journal). */
export function tableText(e: { readonly t: readonly number[]; readonly names: readonly string[]; readonly rows: readonly (readonly (readonly number[] | null)[])[] }, from = 0, to = e.t.length - 1): string {
  const head = ['t'.padStart(10), ...e.names.flatMap((n) => ['x', 'y', 'z'].map((a) => (n + '.' + a).padStart(13)))].join('');
  const lines = [];
  for (let i = from; i <= Math.min(to, e.t.length - 1); i++) {
    lines.push([String(e.t[i]).padStart(10), ...e.rows[i].flatMap((v) => (v ? v.map((x) => String(x).padStart(13)) : ['null', 'null', 'null'].map((x) => x.padStart(13))))].join(''));
  }
  return [head, ...lines].join('\n');
}

/** The variance of perception, estimated from what is observed: the markers do not move, so the second differences of
    their columns are pure noise (variance 6σ² for independent draws). */
export function observedNoiseVariance(e: P3Episode): number {
  const markers = e.names.filter((n) => !e.bodies.includes(n));
  const d2: number[] = [];
  for (const n of markers) {
    const j = e.names.indexOf(n);
    for (let i = 1; i + 1 < e.rows.length; i++) for (let a = 0; a < 3; a++) {
      const [p, q, r] = [e.rows[i - 1][j]?.[a], e.rows[i][j]?.[a], e.rows[i + 1][j]?.[a]];
      if (p !== undefined && q !== undefined && r !== undefined) d2.push(r - 2 * q + p);
    }
  }
  if (!d2.length) return 0;
  const mean = d2.reduce((s, v) => s + v, 0) / d2.length;
  return d2.reduce((s, v) => s + (v - mean) ** 2, 0) / d2.length / 6;
}
