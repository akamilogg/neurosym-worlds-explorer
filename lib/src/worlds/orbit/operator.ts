import { mulberry32 } from '../grid/gen.ts';
import { launchNear } from './gen.ts';
import { acceleration, launchable, simulate, type OrbitSpec, type Trajectory, type Vec2 } from './world.ts';

/* ============================================================================
 * OPERATOR ONLY. What the operator knows about a law and the learner must not:
 * the true accelerations, the best a Newtonian law can do, how much the noise of
 * the perception alone blurs an acceleration, and a plain statement of the law.
 * Used by the calibration and, later, by the journal's operator measures; never
 * shown to System 2 or the Judge.
 * ========================================================================== */

export interface AccelSample {
  readonly pos: Vec2;
  readonly vel: Vec2;
  readonly mass: number;
  readonly acc: Vec2;
}

export type Band = 'view' | 'outer';

/** Launches from inside the observable region ('view', distance 2·collide .. window) or from beyond it
    ('outer', window .. 1.6·window: the extrapolation band). */
export function sampleLaunches(spec: OrbitSpec, count: number, seed: number, band: Band): Trajectory[] {
  const rnd = mulberry32(seed);
  const out: Trajectory[] = [];
  const [lo, hi] = band === 'view' ? [2 * spec.collide, spec.window] : [spec.window, 1.6 * spec.window];
  for (let i = 0; out.length < count && i < count * 20; i++) {
    const mass = spec.level === 2 && spec.law.central.massExp !== 0 ? 0.5 + 1.5 * rnd() : 1;
    const launch = launchNear(spec, rnd, lo + (hi - lo) * rnd(), mass);
    if (band === 'view' && !launchable(spec, launch.pos)) continue;
    out.push(simulate(spec, band + i, launch));
  }
  return out;
}

/** The true acceleration at every row of the trajectories whose distance from the origin falls in [lo, hi]. */
export function accelSamples(spec: OrbitSpec, trajectories: readonly Trajectory[], lo: number, hi: number): AccelSample[] {
  const out: AccelSample[] = [];
  for (const tr of trajectories) {
    for (const s of tr.states) {
      const r = Math.hypot(s.pos[0], s.pos[1]);
      if (r < lo || r > hi) continue;
      out.push({ pos: s.pos, vel: s.vel, mass: tr.launch.mass, acc: acceleration(spec, s.pos, s.vel, tr.launch.mass) });
    }
  }
  return out;
}

/** Relative RMS error of a predicted acceleration: sqrt(Σ|â - a|² / Σ|a|²). 0 is perfect; 1 is predicting nothing. */
export function relError(samples: readonly AccelSample[], predict: (s: AccelSample) => Vec2): number {
  let err = 0, size = 0;
  for (const s of samples) {
    const p = predict(s);
    err += (p[0] - s.acc[0]) ** 2 + (p[1] - s.acc[1]) ** 2;
    size += s.acc[0] ** 2 + s.acc[1] ** 2;
  }
  return size > 0 ? Math.sqrt(err / size) : 0;
}

/** The best NEWTONIAN law on these samples: a = Σ_j K_j r̂_j / r_j², one strength per source, fitted by least squares
    (the prior a model brings). Returns the predictor. */
export function fitNewton(spec: OrbitSpec, samples: readonly AccelSample[]): (s: AccelSample) => Vec2 {
  const basis = (pos: Vec2): Vec2[] => spec.sources.map((src) => {
    const d: Vec2 = [pos[0] - src.pos[0], pos[1] - src.pos[1]];
    const r = Math.hypot(d[0], d[1]);
    return [-d[0] / (r * r * r), -d[1] / (r * r * r)];
  });
  const n = spec.sources.length;
  const A = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const b = new Array<number>(n).fill(0);
  for (const s of samples) {
    const phi = basis(s.pos);
    for (let i = 0; i < n; i++) {
      b[i] += phi[i][0] * s.acc[0] + phi[i][1] * s.acc[1];
      for (let j = 0; j < n; j++) A[i][j] += phi[i][0] * phi[j][0] + phi[i][1] * phi[j][1];
    }
  }
  const K = solve(A, b);
  return (s) => basis(s.pos).reduce<Vec2>((acc, phi, j) => [acc[0] + K[j] * phi[0], acc[1] + K[j] * phi[1]], [0, 0]);
}

/** Gaussian elimination with partial pivoting (tiny systems). */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-300) continue;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => (Math.abs(row[i]) < 1e-300 ? 0 : row[n] / row[i]));
}

/** How much the perception alone blurs an acceleration read from three consecutive rows (central difference:
    sqrt(6)·sigma/dt²), relative to the RMS acceleration of the samples. sigma combines the noise and, when the table
    is rounded to `resolution` (in the LEARNER's units, so it weighs more on a seed drawn at a small scale), the
    rounding error res/sqrt(12). */
export function noiseFloor(spec: OrbitSpec, samples: readonly AccelSample[], resolution = 0): number {
  const rms = Math.sqrt(samples.reduce((n, s) => n + s.acc[0] ** 2 + s.acc[1] ** 2, 0) / Math.max(1, samples.length));
  const rounding = resolution / spec.frame.scale / Math.sqrt(12);
  const sigma = Math.sqrt(spec.noise ** 2 + rounding ** 2);
  return rms > 0 ? (Math.sqrt(6) * sigma / (spec.dt * spec.dt)) / rms : 0;
}

/** The law in plain words, in the TRUE frame (the operator's summary; the grader will state it in the learner's frame). */
export function lawSummary(spec: OrbitSpec): string {
  const c = spec.law.central;
  const f = (n: number, d = 2) => n.toFixed(d);
  const profile = c.form === 'power' ? 'r^-' + f(c.p)
    : c.form === 'screened' ? 'e^(-r/' + f(c.lambda ?? 0) + ')·r^-' + f(c.p)
    : c.form === 'softened' ? '(r²+' + f(c.eps ?? 0) + '²)^-' + f(c.p / 2)
    : 'r^-' + f(c.p) + '·(1+' + f(c.amp ?? 0) + '·cos 2(θ-' + f(c.axis ?? 0) + '))';
  const parts = [spec.sources.length > 1 ? 'sources of mass ' + spec.sources.map((s) => f(s.mass)).join(' and ') : 'one source',
    'pull ' + profile + (c.massExp ? ' · m^' + f(c.massExp) : '')];
  const v = spec.law.velocity;
  if (v) parts.push((v.kind === 'drag' ? 'drag ' : 'deflect ') + f(v.c, 3) + '·|v|^' + f(v.s));
  return parts.join('; ');
}
