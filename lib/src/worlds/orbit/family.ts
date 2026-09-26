import { mulberry32 } from '../grid/gen.ts';
import type { OrbitSpec, Source, Vec2 } from './world.ts';

/* ============================================================================
 * A FAMILY of setups governed by one principle. A law is validated as a
 * researcher would validate it: by holding in setups it was not fitted on.
 *
 * What stays (the principle): the law's form, its exponent, its universal strength,
 * the dynamics' constants, the frame's scale and time unit, its mirror, and - for an
 * anisotropic law - the frame's rotation (the preferred direction belongs to the world).
 * What changes (the setup): how many sources there are (1 to 3), where they are, and
 * how the table's axes are turned and shifted; with `varyStrength`, each source's
 * strength too (stage 2: the law must infer it from what it observes).
 * ========================================================================== */

export interface FamilyOptions {
  /** Stage 2: each source gets a strength of its own, drawn per setup. */
  readonly varyStrength?: boolean;
}

/** The first setup index (from `from`) whose number of sources is `count`: to give the learner laboratories that differ. */
export function setupWithSources(base: OrbitSpec, count: number, from = 1, options: FamilyOptions = {}): number {
  for (let i = from; i < from + 200; i++) if (environmentOf(base, i, options).sources.length === count) return i;
  return from;
}

/** Setup `index` of the family of `base` (index 0 is the base world itself). Deterministic. */
export function environmentOf(base: OrbitSpec, index: number, options: FamilyOptions = {}): OrbitSpec {
  if (index === 0) return base;
  const rnd = mulberry32(base.seed * 92821 + base.level * 613 + index * 2654435761);
  const count = 1 + Math.floor(rnd() * 3);
  const sources: Source[] = [];
  /* Placed within half the observable region, clear of each other, and clear of the origin's neighbourhood where
     launches start rarely enough to matter. */
  for (let tries = 0; sources.length < count && tries < 200; tries++) {
    const r = 0.5 * base.window * Math.sqrt(rnd()), a = 2 * Math.PI * rnd();
    const pos: Vec2 = [r * Math.cos(a), r * Math.sin(a)];
    if (sources.some((s) => Math.hypot(s.pos[0] - pos[0], s.pos[1] - pos[1]) < 6 * base.collide)) continue;
    sources.push({ pos, mass: options.varyStrength ? Math.exp(Math.log(0.4) + rnd() * Math.log(2.5 / 0.4)) : 1 });
  }
  const isotropic = base.law.central.form !== 'anisotropic';
  return {
    ...base,
    id: base.id + '.e' + index,
    sources,
    frame: {
      ...base.frame,
      theta: isotropic ? 2 * Math.PI * rnd() : base.frame.theta,
      shift: [base.frame.shift[0] + (rnd() - 0.5) * 60, base.frame.shift[1] + (rnd() - 0.5) * 60]
    }
  };
}
