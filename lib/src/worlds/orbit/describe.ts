import type { OrbitSense } from './sense.ts';
import type { OrbitSpec } from './world.ts';

/* ============================================================================
 * OPERATOR ONLY. The hidden law of an orbit@1 world, stated in the learner's own
 * terms: the symbols of its tables, table units, and d - how the next position departs
 * from repeating the last step (what it predicts). It exists to GRADE what System 2
 * recovered at the end of a run; it must never reach System 2, the Judge, or anything
 * they read.
 *
 * In the learner's frame (scale s, rotation θ, mirror F) a pull a(r) of the true frame,
 * over one row of true time dt, departs the next position by d = s · dt² · a(r' / s),
 * where r' is the distance in table units: the time unit of the table cancels out.
 * That is the law at an instant; the d a table shows is a second difference over two
 * rows, which departs from it where the pull changes much within a row (close passes).
 * ========================================================================== */

export interface TruthStatement {
  readonly id: string;
  readonly statement: string;
}

const f = (n: number, digits = 3): string => Number(n.toPrecision(digits)).toString();

export function describeOrbitTruth(spec: OrbitSpec, sense: OrbitSense, options: { varyStrength?: boolean } = {}): TruthStatement[] {
  const { central, velocity } = spec.law;
  const s = spec.frame.scale, dt = spec.dt;
  const probe = sense.probeGlyph;
  const out: TruthStatement[] = [];
  out.push({ id: 'sources', statement: `In every setup, the bodies other than the launched one (${probe}) never move.` });
  const toward = central.k > 0 ? 'toward' : 'away from';
  const r = 'r (the distance from ' + probe + ' to that body, in table units)';
  /* The profile in table units: d = C · profile(r'), with the constants folded into C (a source of strength 1). */
  const base = s * dt * dt * central.k;
  const profile = central.form === 'power' ? f(base * Math.pow(s, central.p)) + ' · r^-' + f(central.p)
    : central.form === 'screened' ? f(base * Math.pow(s, central.p)) + ' · e^(-r / ' + f(s * (central.lambda ?? 1)) + ') · r^-' + f(central.p)
    : central.form === 'softened' ? f(base * Math.pow(s, central.p)) + ' · (r² + ' + f(s * (central.eps ?? 1)) + '²)^-' + f(central.p / 2)
    : f(base * Math.pow(s, central.p)) + ' · r^-' + f(central.p);
  const ownStrength = options.varyStrength || new Set(spec.sources.map((x) => x.mass)).size > 1;
  out.push({ id: 'central', statement: `Each motionless body pulls the launched body ${toward} itself: that part of d has size ` +
    (ownStrength ? 'M · ' + profile + ', M a strength of its own for each body,' : profile + ', the same for every body in every setup,') + ` where ${r}.` });
  out.push({ id: 'superposition', statement: 'With several motionless bodies, their parts of d add up (as vectors).' });
  out.push({ id: 'distance_power', statement: `That size falls with distance as a power of r with exponent -${f(central.p)} (not -2), the same power at every distance` +
    (central.form === 'screened' ? ', cut off further by an exponential factor' : central.form === 'softened' ? ', softened near the body (it stays finite as r goes to 0)' : '') + '.' });
  if (central.form === 'anisotropic') {
    const axis = spec.frame.flip ? spec.frame.theta - (central.axis ?? 0) : spec.frame.theta + (central.axis ?? 0);
    const deg = ((axis * 180 / Math.PI) % 180 + 180) % 180;
    out.push({ id: 'anisotropy', statement: `That size also depends on the direction from the body to ${probe}: it is multiplied by 1 + ${f(central.amp ?? 0)} · cos(2 (φ - ${f(deg)}°)), where φ is the angle of that direction in the table's axes. The world has a preferred axis, the same in every setup.` });
  }
  out.push({ id: 'launch_property', statement: central.massExp
    ? `The property m of the launched body matters: the size is multiplied by m^${f(central.massExp)}.`
    : 'The property m of the launched body does not matter.' });
  if (velocity) {
    /* The step per row u = |p(now) - p(previous)| ≈ s · dt · |v|, so c · |v|^e becomes c · s^(1-e) · dt^(2-e) · u^e. */
    const C = velocity.c * Math.pow(s, 1 - velocity.s) * Math.pow(dt, 2 - velocity.s);
    const u = 'u (the length of the last step, in table units)';
    out.push(velocity.kind === 'drag'
      ? { id: 'velocity_term', statement: `Another part of d points against the last step, with size ${f(C)} · u^${f(velocity.s)}, where ${u}.` }
      : { id: 'velocity_term', statement: `Another part of d points sideways to the last step (a quarter turn to the ${spec.frame.flip ? 'right' : 'left'} in the table's axes), with size ${f(C)} · u^${f(velocity.s)}, where ${u}.` });
  } else out.push({ id: 'velocity_term', statement: 'The pull does not depend on how fast the body moves: the law has no term in the velocity. (Carrying the pull over a row - integrating the motion within it - is kinematics, not such a term.)' });
  return out;
}
