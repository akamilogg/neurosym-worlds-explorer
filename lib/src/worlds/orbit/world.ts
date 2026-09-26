/* ============================================================================
 * orbit@1 - bodies moving under a law of motion that nobody told the learner.
 *
 * Fixed SOURCES pull (or push) free PROBES; probes do not act on each other.
 * The law is drawn per seed (gen.ts) and is, on purpose, NOT the one a model
 * knows: a power other than 2, a dependence on the probe's own mass, a term in
 * the velocity, a screened or anisotropic pull. Everything here is in the TRUE
 * frame; what the learner perceives is a rotated, scaled, shifted table of
 * positions (sense.ts), never these numbers.
 * ========================================================================== */

export type Vec2 = readonly [number, number];

/** How the pull of a source falls with distance r. */
export type LawForm = 'power' | 'screened' | 'softened' | 'anisotropic';

export interface CentralTerm {
  /** Strength: a = k · M · m^massExp · f(r) · g(angle), toward the source (away if k < 0). */
  readonly k: number;
  /** The power of the distance: f(r) = r^-p (and the base of the other forms). */
  readonly p: number;
  readonly form: LawForm;
  /** screened: f(r) = e^(-r/lambda) · r^-p. */
  readonly lambda?: number;
  /** softened: f(r) = (r² + eps²)^(-p/2). */
  readonly eps?: number;
  /** anisotropic: g = 1 + amp · cos(2 (angle - axis)), angle of the probe as seen from the source. */
  readonly amp?: number;
  readonly axis?: number;
  /** The probe's own mass enters as m^massExp (0: it does not; 0 is the principle of equivalence). */
  readonly massExp: number;
}

export interface VelocityTerm {
  /** drag: -c |v|^s v̂ (against the motion); deflect: c |v|^s v̂⊥ (a quarter turn to the left of the motion). */
  readonly kind: 'drag' | 'deflect';
  readonly c: number;
  readonly s: number;
}

export interface OrbitLaw {
  readonly central: CentralTerm;
  readonly velocity: VelocityTerm | null;
}

export interface Source {
  readonly pos: Vec2;
  readonly mass: number;
}

/** The learner's frame: perceived = scale · R(theta) · F · true + shift, perceived time = timeScale · true time. */
export interface Frame {
  readonly theta: number;
  /** Mirror the y axis before rotating. */
  readonly flip: boolean;
  readonly scale: number;
  readonly shift: Vec2;
  readonly timeScale: number;
}

export interface OrbitSpec {
  readonly id: string;
  readonly seed: number;
  /** 1: a power other than 2; 2: a hidden mass; 3: a term in the velocity; 4: a pull that is not a power. */
  readonly level: number;
  readonly law: OrbitLaw;
  readonly sources: readonly Source[];
  readonly frame: Frame;
  /** Probes are seen only within this distance of the origin (the observable region). */
  readonly window: number;
  /** A probe closer than this to a source is stopped (a collision). */
  readonly collide: number;
  /** A probe beyond this distance of the origin is stopped (it escaped). */
  readonly escape: number;
  /** Time between two rows of the table (true time), integrator substeps per row, rows per launch. */
  readonly dt: number;
  readonly substeps: number;
  readonly steps: number;
  /** Standard deviation of the perceived positions, in true units (sense.ts scales it). */
  readonly noise: number;
}

export interface Launch {
  readonly pos: Vec2;
  readonly vel: Vec2;
  /** The probe's mass (only matters when the law says so). */
  readonly mass: number;
}

export interface OrbitSample {
  readonly t: number;
  readonly pos: Vec2;
  readonly vel: Vec2;
}

export interface Trajectory {
  readonly id: string;
  readonly launch: Launch;
  readonly states: readonly OrbitSample[];
  readonly ended: 'steps' | 'collided' | 'escaped';
}

const add = (a: Vec2, b: Vec2, k = 1): Vec2 => [a[0] + k * b[0], a[1] + k * b[1]];
const norm = (a: Vec2): number => Math.hypot(a[0], a[1]);

/** The radial profile f(r) · g(angle) of the central term, for a probe at offset d from the source. */
export function centralProfile(term: CentralTerm, d: Vec2): number {
  const r = norm(d);
  const base = term.form === 'softened' ? Math.pow(r * r + (term.eps ?? 1) ** 2, -term.p / 2) : Math.pow(r, -term.p);
  const screen = term.form === 'screened' ? Math.exp(-r / (term.lambda ?? 1)) : 1;
  const angle = term.form === 'anisotropic' ? 1 + (term.amp ?? 0) * Math.cos(2 * (Math.atan2(d[1], d[0]) - (term.axis ?? 0))) : 1;
  return base * screen * angle;
}

/** The TRUE acceleration of a probe. */
export function acceleration(spec: OrbitSpec, pos: Vec2, vel: Vec2, mass: number): Vec2 {
  const { central, velocity } = spec.law;
  let a: Vec2 = [0, 0];
  const massFactor = Math.pow(mass, central.massExp);
  for (const src of spec.sources) {
    const d: Vec2 = [pos[0] - src.pos[0], pos[1] - src.pos[1]];
    const r = norm(d);
    if (r === 0) continue;
    const magnitude = central.k * src.mass * massFactor * centralProfile(central, d);
    a = add(a, [-d[0] / r, -d[1] / r], magnitude);
  }
  if (velocity) {
    const speed = norm(vel);
    if (speed > 0) {
      const m = velocity.c * Math.pow(speed, velocity.s);
      const u: Vec2 = [vel[0] / speed, vel[1] / speed];
      a = add(a, velocity.kind === 'drag' ? [-u[0], -u[1]] : [-u[1], u[0]], m);
    }
  }
  return a;
}

function rk4(spec: OrbitSpec, pos: Vec2, vel: Vec2, mass: number, h: number): { pos: Vec2; vel: Vec2 } {
  const f = (p: Vec2, v: Vec2) => ({ dp: v, dv: acceleration(spec, p, v, mass) });
  const k1 = f(pos, vel);
  const k2 = f(add(pos, k1.dp, h / 2), add(vel, k1.dv, h / 2));
  const k3 = f(add(pos, k2.dp, h / 2), add(vel, k2.dv, h / 2));
  const k4 = f(add(pos, k3.dp, h), add(vel, k3.dv, h));
  return {
    pos: [pos[0] + (h / 6) * (k1.dp[0] + 2 * k2.dp[0] + 2 * k3.dp[0] + k4.dp[0]), pos[1] + (h / 6) * (k1.dp[1] + 2 * k2.dp[1] + 2 * k3.dp[1] + k4.dp[1])],
    vel: [vel[0] + (h / 6) * (k1.dv[0] + 2 * k2.dv[0] + 2 * k3.dv[0] + k4.dv[0]), vel[1] + (h / 6) * (k1.dv[1] + 2 * k2.dv[1] + 2 * k3.dv[1] + k4.dv[1])]
  };
}

const collides = (spec: OrbitSpec, pos: Vec2): boolean => spec.sources.some((s) => norm([pos[0] - s.pos[0], pos[1] - s.pos[1]]) < spec.collide);

/** Can a probe be launched from here? Inside the observable region and clear of every source. */
export function launchable(spec: OrbitSpec, pos: Vec2): boolean {
  return norm(pos) <= spec.window && !collides(spec, pos);
}

/** Launch a probe (true frame) and follow it for `steps` rows, or until it collides or escapes. */
export function simulate(spec: OrbitSpec, id: string, launch: Launch, steps = spec.steps): Trajectory {
  let pos = launch.pos, vel = launch.vel;
  const states: OrbitSample[] = [{ t: 0, pos, vel }];
  const h = spec.dt / spec.substeps;
  let ended: Trajectory['ended'] = 'steps';
  outer: for (let i = 1; i <= steps; i++) {
    for (let j = 0; j < spec.substeps; j++) {
      ({ pos, vel } = rk4(spec, pos, vel, launch.mass, h));
      if (collides(spec, pos)) { ended = 'collided'; break outer; }
      if (norm(pos) > spec.escape) { ended = 'escaped'; break outer; }
    }
    states.push({ t: i * spec.dt, pos, vel });
  }
  return { id, launch, states, ended };
}

/* --- The learner's frame ------------------------------------------------------------ */

function rotate(f: Frame, v: Vec2): Vec2 {
  const y = f.flip ? -v[1] : v[1];
  const c = Math.cos(f.theta), s = Math.sin(f.theta);
  return [c * v[0] - s * y, s * v[0] + c * y];
}
function unrotate(f: Frame, v: Vec2): Vec2 {
  const c = Math.cos(f.theta), s = Math.sin(f.theta);
  const x = c * v[0] + s * v[1], y = -s * v[0] + c * v[1];
  return [x, f.flip ? -y : y];
}

export const toPercept = {
  pos: (f: Frame, p: Vec2): Vec2 => add(f.shift, rotate(f, p), f.scale),
  vel: (f: Frame, v: Vec2): Vec2 => { const r = rotate(f, v); return [r[0] * f.scale / f.timeScale, r[1] * f.scale / f.timeScale]; },
  acc: (f: Frame, a: Vec2): Vec2 => { const r = rotate(f, a); const k = f.scale / (f.timeScale * f.timeScale); return [r[0] * k, r[1] * k]; },
  time: (f: Frame, t: number): number => t * f.timeScale
};

export const fromPercept = {
  pos: (f: Frame, p: Vec2): Vec2 => unrotate(f, [(p[0] - f.shift[0]) / f.scale, (p[1] - f.shift[1]) / f.scale]),
  vel: (f: Frame, v: Vec2): Vec2 => unrotate(f, [v[0] * f.timeScale / f.scale, v[1] * f.timeScale / f.scale]),
  time: (f: Frame, t: number): number => t / f.timeScale
};
