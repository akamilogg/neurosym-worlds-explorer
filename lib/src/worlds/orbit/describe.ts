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
 * ========================================================================== */

export interface TruthStatement {
  readonly id: string;
  readonly statement: string;
}

const f = (n: number, digits = 3): string => Number(n.toPrecision(digits)).toString();

export function describeOrbitTruth(spec: OrbitSpec, sense: OrbitSense): TruthStatement[] {
  const { central, velocity } = spec.law;
  const s = spec.frame.scale, dt = spec.dt;
  const probe = sense.probeGlyph;
  const out: TruthStatement[] = [];
  const sources = sense.sourceGlyphs.join(' and ');
  out.push({ id: 'sources', statement: `The bodies ${sources} do not move; only the launched body ${probe} does.` });
  const toward = central.k > 0 ? 'toward' : 'away from';
  const r = 'r (the distance from ' + probe + ' to that body, in table units)';
  /* The profile in table units: d = C · profile(r'), with the constants folded into C. */
  const profile = (mass: number): string => {
    const base = s * dt * dt * central.k * mass;
    switch (central.form) {
      case 'power': return f(base * Math.pow(s, central.p)) + ' · r^-' + f(central.p);
      case 'screened': return f(base * Math.pow(s, central.p)) + ' · e^(-r / ' + f(s * (central.lambda ?? 1)) + ') · r^-' + f(central.p);
      case 'softened': return f(base * Math.pow(s, central.p)) + ' · (r² + ' + f(s * (central.eps ?? 1)) + '²)^-' + f(central.p / 2);
      case 'anisotropic': return f(base * Math.pow(s, central.p)) + ' · r^-' + f(central.p);
    }
  };
  spec.sources.forEach((src, i) => {
    out.push({ id: 'central_' + sense.sourceGlyphs[i], statement: `Part of d points ${toward} ${sense.sourceGlyphs[i]}, with size ${profile(src.mass)}, where ${r}.` });
  });
  out.push({ id: 'distance_power', statement: `That size falls with distance as a power of r with exponent -${f(central.p)} (not -2)` +
    (central.form === 'screened' ? ', cut off further by an exponential factor' : central.form === 'softened' ? ', softened near the body (it stays finite as r goes to 0)' : '') + '.' });
  if (central.form === 'anisotropic') {
    const axis = spec.frame.flip ? spec.frame.theta - (central.axis ?? 0) : spec.frame.theta + (central.axis ?? 0);
    const deg = ((axis * 180 / Math.PI) % 180 + 180) % 180;
    out.push({ id: 'anisotropy', statement: `That size also depends on the direction from the body to ${probe}: it is multiplied by 1 + ${f(central.amp ?? 0)} · cos(2 (φ - ${f(deg)}°)), where φ is the angle of that direction in the table's axes. The environment has a preferred axis.` });
  }
  if (spec.sources.length > 1) {
    const ratio = spec.sources[1].mass / spec.sources[0].mass;
    out.push({ id: 'source_strength', statement: `The two bodies differ in strength: ${sense.sourceGlyphs[1]} acts ${f(ratio)} times as strongly as ${sense.sourceGlyphs[0]} at the same distance, and the two parts add up.` });
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
  } else out.push({ id: 'velocity_term', statement: 'Nothing in d depends on how fast the body moves: there is no term in the step.' });
  return out;
}
