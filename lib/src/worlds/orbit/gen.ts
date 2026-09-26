import { mulberry32 } from '../grid/gen.ts';
import { acceleration, launchable, simulate, type CentralTerm, type Frame, type Launch, type OrbitSpec, type Source, type Vec2, type VelocityTerm } from './world.ts';

/* ============================================================================
 * The generator: (seed, level) -> a law worth discovering.
 *
 *   L1  a power of the distance other than 2 (never within 1.9..2.1 of Newton)
 *   L2  L1 plus a hidden mass: two sources of different mass, or the probe's own
 *       mass in the law (no principle of equivalence)
 *   L3  L1 plus a term in the velocity: a drag, or a sideways deflection
 *   L4  a pull that is not a power: screened, softened, or anisotropic
 *
 * Units are set so a probe at distance 5 of a unit source circles at speed ~1;
 * the learner never sees them (sense.ts draws its own frame per seed).
 * A drawn law is kept only if enough probes stay long enough in view.
 * ========================================================================== */

const R_REF = 5;
const A_REF = 0.2;

const between = (rnd: () => number, lo: number, hi: number): number => lo + rnd() * (hi - lo);
const logBetween = (rnd: () => number, lo: number, hi: number): number => Math.exp(between(rnd, Math.log(lo), Math.log(hi)));
/** Uniform on [lo, hi] without the band [gapLo, gapHi]. */
function avoiding(rnd: () => number, lo: number, hi: number, gapLo: number, gapHi: number): number {
  const width = (gapLo - lo) + (hi - gapHi);
  const u = rnd() * width;
  return u < gapLo - lo ? lo + u : gapHi + (u - (gapLo - lo));
}

/** One raw draw (not yet filtered). */
export function drawOrbit(seed: number, level: number, attempt = 0): OrbitSpec {
  if (![1, 2, 3, 4].includes(level)) throw new Error('level must be 1..4');
  /* WHICH law (the variant of the level) depends on the seed alone; a retry redraws only its parameters, so the
     filter below cannot tilt the family toward the variants that pass it more easily. */
  const variant = mulberry32(seed * 7919 + level * 131)();
  const rnd = mulberry32(seed * 7919 + level * 131 + attempt * 104729 + 3);
  const p = avoiding(rnd, 1.5, 3, 1.9, 2.1);
  let central: CentralTerm = { k: A_REF * Math.pow(R_REF, p), p, form: 'power', massExp: 0 };
  let sources: Source[] = [{ pos: [0, 0], mass: 1 }];
  let velocity: VelocityTerm | null = null;
  if (level === 2) {
    if (variant < 0.5) {
      const d = between(rnd, 1.5, 2.5);
      sources = [{ pos: [-d, 0], mass: 1 }, { pos: [d, 0], mass: rnd() < 0.5 ? between(rnd, 0.3, 0.7) : between(rnd, 1.5, 3) }];
    } else {
      central = { ...central, massExp: (rnd() < 0.5 ? -1 : 1) * between(rnd, 0.3, 1) };
    }
  } else if (level === 3) {
    velocity = { kind: variant < 0.5 ? 'drag' : 'deflect', c: between(rnd, 0.04, 0.08), s: between(rnd, 0, 2) };
  } else if (level === 4) {
    const form = (['screened', 'softened', 'anisotropic'] as const)[Math.floor(variant * 3)];
    central = form === 'screened' ? { ...central, form, lambda: between(rnd, 4, 9) }
      : form === 'softened' ? { ...central, form, eps: between(rnd, 1, 2.5) }
      : { ...central, form, amp: between(rnd, 0.3, 0.6), axis: between(rnd, 0, Math.PI) };
    /* Keep the reference speed: rescale k so the pull at distance 5 (along x) is still A_REF. */
    const at5 = acceleration({ law: { central: { ...central, k: 1 }, velocity: null }, sources: [{ pos: [0, 0], mass: 1 }] } as unknown as OrbitSpec, [R_REF, 0], [0, 0], 1);
    central = { ...central, k: A_REF / Math.hypot(at5[0], at5[1]) };
  }
  const frame: Frame = {
    theta: between(rnd, 0, 2 * Math.PI),
    flip: rnd() < 0.5,
    scale: logBetween(rnd, 0.3, 30),
    shift: [between(rnd, -50, 50), between(rnd, -50, 50)],
    timeScale: logBetween(rnd, 0.2, 5)
  };
  return {
    id: 'o' + seed + 'L' + level + (attempt ? '.' + attempt : ''), seed, level,
    law: { central, velocity }, sources, frame,
    /* A row every 0.125 (four substeps of 1/32): fine enough that a second difference over two rows is the law at an
       instant, up to the noise, even in close passes; the noise is set low enough that a law of the wrong form shows
       beyond it, far from the source too. */
    window: 10, collide: 0.8, escape: 25, dt: 0.125, substeps: 4, steps: 240, noise: 0.00001
  };
}

/** A launch from distance r of the origin at a random angle, with a speed near the circular one and a mostly
    sideways direction: the kind of launch that stays in view. Operator side (calibration, trial launches). */
export function launchNear(spec: OrbitSpec, rnd: () => number, r: number, mass = 1): Launch {
  const angle = between(rnd, 0, 2 * Math.PI);
  const pos: Vec2 = [r * Math.cos(angle), r * Math.sin(angle)];
  const a = acceleration({ ...spec, law: { ...spec.law, velocity: null } }, pos, [0, 0], mass);
  const circular = Math.sqrt(Math.hypot(a[0], a[1]) * r);
  const speed = circular * between(rnd, 0.6, 1.3);
  const heading = angle + (rnd() < 0.5 ? 1 : -1) * Math.PI / 2 + between(rnd, -0.7, 0.7);
  return { pos, vel: [speed * Math.cos(heading), speed * Math.sin(heading)], mass };
}

export interface OrbitReport {
  /** Share of sample launches that stay in view for at least a quarter of their rows. */
  readonly staysInView: number;
  readonly attempts: number;
}

/** Draw laws from (seed, level) until one leaves enough probes in view to study. */
export function generateOrbit(seed: number, level: number, options: { maxAttempts?: number } = {}): { spec: OrbitSpec; report: OrbitReport } {
  for (let attempt = 0; attempt < (options.maxAttempts ?? 50); attempt++) {
    const spec = drawOrbit(seed, level, attempt);
    const rnd = mulberry32(seed * 31 + level + attempt);
    let good = 0;
    const tries = 24;
    for (let i = 0; i < tries; i++) {
      const launch = launchNear(spec, rnd, between(rnd, 2 * spec.collide, spec.window), level === 2 ? between(rnd, 0.5, 2) : 1);
      if (!launchable(spec, launch.pos)) continue;
      const tr = simulate(spec, 'check' + i, launch);
      const inView = tr.states.filter((s) => Math.hypot(s.pos[0], s.pos[1]) <= spec.window).length;
      if (inView >= spec.steps / 4) good++;
    }
    const share = good / tries;
    if (share >= 0.5) return { spec, report: { staysInView: Math.round(share * 100) / 100, attempts: attempt + 1 } };
  }
  throw new Error('no usable law found for seed ' + seed + ' at level ' + level);
}
