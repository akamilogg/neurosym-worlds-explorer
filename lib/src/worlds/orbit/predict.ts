import { hashString } from '../../core/hash.ts';
import { pairOf, type PredictionSample, type Vec2 } from '../../core/predict.ts';
import type { World } from '../../core/types.ts';
import { mulberry32 } from '../grid/gen.ts';
import { launchNear } from './gen.ts';
import { readTable, tableSense, type OrbitSenseOptions } from './sense.ts';
import { acceleration, simulate, toPercept, type OrbitSpec, type Trajectory } from './world.ts';

/* ============================================================================
 * What a prediction is in orbit@1, and what the trial tests it on.
 *
 * A POINT is the table of one launch as perceived up to a row (the past and the
 * present, never the next row): it holds nothing hidden, so what the learner's code
 * reads of it is exactly what it perceives.
 *
 * The TARGET at row i is how the next position departs from repeating the last step:
 *     d(i) = p(i+1) - 2 p(i) + p(i-1)          (read from the table itself, noise included)
 * It is a definition over what is perceived, not a law: what the learner predicts,
 * a law of motion must explain. The operator also keeps the same quantity without
 * noise (the truth: the same second difference of the noise-free positions) to report
 * how far the noise alone puts even a perfect law. It is NOT a · Δt²: over one row a
 * body moves, and near a source the pull changes along the way; that difference is
 * part of what the learner has to predict, not noise. The REFERENCE is what the hidden law
 * itself predicts (a · Δt² at the row): a learner that recovers the law scores about that.
 * ========================================================================== */

export interface OrbitPoint {
  /** The launch's table, header and rows 0..row. */
  readonly table: string;
  readonly row: number;
}

/** orbit@1 as the Observer and the Evaluator see it: one actor, nothing ever ends, no actions, and a state that is
    only what is perceived. */
export function orbitPointWorld(): World<OrbitPoint, never> {
  return {
    id: 'orbit@1',
    actors: ['nature'],
    initial: () => { throw new Error('orbit@1 has no initial state: points come from launches'); },
    toMove: () => 'nature',
    actions: () => [],
    step: (s) => s,
    outcome: () => ({ over: false, winner: null, reason: null }),
    key: (s) => hashString(s.table),
    view: () => ({ entities: [], scalars: {} }),
    describeRules: () => '',
    actionKey: () => ''
  };
}

/** What a learner's code (observations and directions) reads of a point: the table, as columns. */
export const perceivePoint = (point: OrbitPoint) => readTable(point.table);

export interface TrialOptions {
  /** 'grid': the same fixed lattice of launches every attempt (the same points recur; cheap). 'free': new launches every
      attempt. The experiment flag --sampling. */
  readonly sampling: 'grid' | 'free';
  readonly attempt: number;
  /** Launches from inside the observable region, and from beyond it (the extrapolation band). */
  readonly inView: number;
  readonly beyond: number;
}

/** The trial's launches. The learner never saw them; 'free' draws new ones per attempt. */
export function trialLaunches(spec: OrbitSpec, options: TrialOptions): Trajectory[] {
  const out: Trajectory[] = [];
  const bands: [string, number, number, number][] = [['view', 2 * spec.collide, spec.window, options.inView], ['outer', spec.window, 1.6 * spec.window, options.beyond]];
  for (const [band, lo, hi, count] of bands) {
    for (let i = 0; i < count; i++) {
      const mass = spec.level === 2 && spec.law.central.massExp !== 0 ? 0.5 + 1.5 * ((i * 0.618) % 1) : 1;
      if (options.sampling === 'grid') {
        /* A lattice: radii evenly across the band, angles by the golden ratio, the same speed factor. */
        const r = lo + (hi - lo) * (i + 0.5) / count;
        const rnd = mulberry32(spec.seed * 1000 + i + (band === 'outer' ? 500 : 0));
        const launch = launchNear(spec, rnd, r, mass);
        out.push(simulate(spec, 'trial-' + band + '-' + i, launch));
      } else {
        const rnd = mulberry32(spec.seed * 1009 + options.attempt * 7919 + i + (band === 'outer' ? 500 : 0));
        out.push(simulate(spec, 'trial' + options.attempt + '-' + band + '-' + i, launchNear(spec, rnd, lo + (hi - lo) * rnd(), mass)));
      }
    }
  }
  return out;
}

/** The noise of one component of d, estimated ONLY from what is observed: the sources do not move, so the second
    differences of their columns in the same tables are pure noise (and rounding, with --resolution). A researcher's error
    bar, not the truth: it uses no hidden quantity. */
export function observedNoiseVariance(spec: OrbitSpec, trajectories: readonly Trajectory[], options: OrbitSenseOptions = {}): number {
  const sense = tableSense(spec, { resolution: options.resolution, window: false });
  let sum = 0, n = 0;
  for (const tr of trajectories) {
    const t = readTable(sense.render(tr));
    for (const g of sense.sourceGlyphs) for (const axis of ['x', 'y'] as const) {
      const c = t.series[g][axis];
      for (let i = 1; i + 1 < c.length; i++) { const d = c[i + 1]! - 2 * c[i]! + c[i - 1]!; sum += d * d; n++; }
    }
  }
  return n ? sum / n : 0;
}

export interface SampleOptions extends OrbitSenseOptions {
  /** Take every k-th usable row (default 8), to keep the number of questions to the Judge bounded. */
  readonly every?: number;
}

/** The prediction samples of some launches: one per usable row (the probe seen at rows i-1, i and i+1). The trial's
    launches beyond the observable region are rendered with window: false, or there would be nothing to predict there. */
export function predictionSamples(spec: OrbitSpec, trajectories: readonly Trajectory[], options: SampleOptions = {}): PredictionSample<OrbitPoint>[] {
  const out: PredictionSample<OrbitPoint>[] = [];
  const every = Math.max(1, options.every ?? 8);
  const dtSeen = toPercept.time(spec.frame, spec.dt);
  for (const tr of trajectories) {
    const outer = Math.hypot(tr.launch.pos[0], tr.launch.pos[1]) > spec.window;
    const sense = tableSense(spec, { resolution: options.resolution, window: outer ? false : options.window });
    const lines = sense.render(tr).split('\n');
    const probe = readTable(lines.join('\n')).series[sense.probeGlyph];
    let taken = 0;
    for (let i = 1; i + 1 < tr.states.length; i++) {
      const xs = [probe.x[i - 1], probe.x[i], probe.x[i + 1]], ys = [probe.y[i - 1], probe.y[i], probe.y[i + 1]];
      if ([...xs, ...ys].some((v) => v === null)) continue;
      if (taken++ % every !== 0) continue;
      const [p0, p1, p2] = [i - 1, i, i + 1].map((k) => toPercept.pos(spec.frame, tr.states[k].pos));
      const a = toPercept.acc(spec.frame, acceleration(spec, tr.states[i].pos, tr.states[i].vel, tr.launch.mass));
      out.push({
        state: { table: lines.slice(0, i + 2).join('\n'), row: i },
        target: [xs[2]! - 2 * xs[1]! + xs[0]!, ys[2]! - 2 * ys[1]! + ys[0]!],
        truth: [p2[0] - 2 * p1[0] + p0[0], p2[1] - 2 * p1[1] + p0[1]],
        reference: [a[0] * dtSeen * dtSeen, a[1] * dtSeen * dtSeen],
        band: outer ? 'outer' : 'view',
        ref: tr.id + '@' + i
      });
    }
  }
  return out;
}

/* --- A model's answer, and what is compared ------------------------------------------ */

/** The last pair of the table at its current row and the row before (null where the table shows no number). */
function lastPair(point: OrbitPoint): { now: [number | null, number | null]; before: [number | null, number | null] } {
  const t = readTable(point.table);
  const s = t.series[t.symbols[t.symbols.length - 1]];
  const i = t.t.length - 1;
  return { now: [s.x[i] ?? null, s.y[i] ?? null], before: [i > 0 ? s.x[i - 1] ?? null : null, i > 0 ? s.y[i - 1] ?? null : null] };
}

/** Whether a model can be asked for an answer at a point: the last pair shows numbers in its row and the row before. */
export function answerable(point: OrbitPoint): boolean {
  const { now, before } = lastPair(point);
  return ![...now, ...before].some((v) => v === null);
}

/** A model's ANSWER - the pair the last columns will show in the next row - read as what is compared with what happened:
    its departure from repeating the last step, d = answer - 2·p(now) + p(before). The learner is never told this reading. */
export function answerAsDeparture(answer: unknown, point: OrbitPoint): Vec2 {
  const [x, y] = pairOf(answer);
  const { now, before } = lastPair(point);
  if ([...now, ...before].some((v) => v === null)) throw new Error('the last pair shows no number in this row or the one before');
  return [x - 2 * now[0]! + before[0]!, y - 2 * now[1]! + before[1]!];
}

/** The inverse: what the next row shows (or a model answers), from a departure d at a point. */
export function departureAsNext(d: Vec2, point: OrbitPoint): Vec2 {
  const { now, before } = lastPair(point);
  return [d[0] + 2 * now[0]! - before[0]!, d[1] + 2 * now[1]! - before[1]!];
}
