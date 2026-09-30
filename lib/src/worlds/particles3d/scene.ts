import { mulberry32 } from '../grid/gen.ts';

/* ============================================================================
 * particles3d@1's scenes (SPEC-MUNDO-3D §3): what the harness asks Blender to simulate.
 *
 * A scene is Blender's: its engine settings, its force fields (in Blender's own terms: a
 * FORCE, a HARMONIC, a VORTEX...), and the particles, each with hidden properties (mass, a
 * charge). The harness never computes what Blender does with it: the service simulates, and
 * what it answers is the world. The harness only
 *
 *   - generates the scene from a seed, a level and a condition;
 *   - turns Blender's coordinates into what the learner perceives (a FRAME: axes turned,
 *     scaled and shifted, a time unit), and back for an act;
 *   - generates the FAMILY: the same laws (field kinds and parameters, engine, frame), with
 *     the sources elsewhere and, from level 4 on, the particles' hidden properties drawn anew.
 *
 * Conditions (§3.5): A, Blender's fields as they come (default parameters, no turn of the
 * axes, Blender's own time step): recognisable; B, the same fields with unusual parameters and
 * the axes turned; C, fields that answer no textbook formula (a texture's gradient, tube-shaped
 * fall-offs), the axes turned.
 * ========================================================================== */

export type Condition = 'A' | 'B' | 'C';
export type Vec3 = [number, number, number];

export interface FieldSpec {
  readonly type: 'FORCE' | 'HARMONIC' | 'VORTEX' | 'MAGNET' | 'CHARGE' | 'LENNARDJ' | 'DRAG' | 'TURBULENCE' | 'TEXTURE' | 'WIND';
  readonly location: Vec3;
  readonly rotation?: Vec3;
  readonly strength?: number;
  readonly flow?: number;
  readonly shape?: 'POINT' | 'LINE' | 'PLANE';
  readonly falloff?: { readonly type: 'SPHERE' | 'TUBE' | 'CONE'; readonly power: number; readonly min?: number };
  readonly linear?: number;
  readonly quadratic?: number;
  readonly size?: number;
  readonly noise?: number;
  readonly seed?: number;
  readonly texture?: 'CLOUDS' | 'VORONOI' | 'MARBLE' | 'WOOD' | 'STUCCI';
  readonly scale?: number;
}

/** A particle of the scene: its column's name in the tables, and what is hidden of it. */
export interface BodySpec {
  readonly name: string;
  readonly mass: number;
  readonly field?: { readonly type: 'CHARGE' | 'LENNARDJ'; readonly strength: number };
}

export interface EngineSpec {
  readonly integrator: 'EULER' | 'VERLET' | 'MIDPOINT' | 'RK4';
  readonly subframes: number;
  /** Blender's time per frame. */
  readonly timestep: number;
  readonly damping: number;
  readonly drag: number;
}

/** How Blender's coordinates are perceived: q = scale · R · w + shift; the table's time is row · tau. */
export interface FrameSpec {
  readonly rot: readonly number[];
  readonly scale: number;
  readonly shift: Vec3;
  readonly tau: number;
}

export interface SceneSpec {
  readonly seed: number;
  readonly level: number;
  readonly condition: Condition;
  /** The place in the family (0: the laboratory's world). */
  readonly place: number;
  readonly engine: EngineSpec;
  readonly fields: readonly FieldSpec[];
  /** One marker per field: a column that shows where the field's object is. */
  readonly markers: readonly { readonly name: string; readonly field: number }[];
  readonly bodies: readonly BodySpec[];
  readonly frame: FrameSpec;
  /** Frames of an episode. */
  readonly frames: number;
  /** Half the side of the box (in Blender's units) where sources are placed and particles start. */
  readonly region: number;
}

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
const pick = <T>(rnd: () => number, xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
const between = (rnd: () => number, a: number, b: number) => round4(a + rnd() * (b - a));
const sign = (rnd: () => number) => (rnd() < 0.5 ? -1 : 1);

/** A uniformly random rotation (from a random unit quaternion), as a row-major 3×3 matrix. */
function randomRotation(rnd: () => number): number[] {
  const u1 = rnd(), u2 = rnd() * 2 * Math.PI, u3 = rnd() * 2 * Math.PI;
  const a = Math.sqrt(1 - u1), b = Math.sqrt(u1);
  const [x, y, z, w] = [a * Math.sin(u2), a * Math.cos(u2), b * Math.sin(u3), b * Math.cos(u3)];
  return [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)].map((v) => Number(v.toFixed(12)));
}

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'.split('');

/** A field of a kind, with parameters as the condition has them (location and rotation are drawn by the caller). */
function fieldOf(kind: FieldSpec['type'], c: Condition, rnd: () => number): Omit<FieldSpec, 'location'> {
  const odd = c !== 'A';
  const power = () => ({ type: (c === 'C' ? pick(rnd, ['TUBE', 'CONE'] as const) : 'SPHERE') as 'SPHERE' | 'TUBE' | 'CONE', power: between(rnd, 0.6, 2.8), min: between(rnd, 0.1, 0.3) });
  const turn = (): Vec3 => [between(rnd, 0, Math.PI), between(rnd, 0, Math.PI), between(rnd, 0, Math.PI)];
  switch (kind) {
    case 'FORCE': return { type: kind, strength: sign(rnd) * between(rnd, 3, 8), ...(odd ? { falloff: power() } : {}) };
    case 'HARMONIC': return { type: kind, strength: between(rnd, 1, 3), ...(odd ? { falloff: power() } : {}) };
    case 'WIND': return { type: kind, strength: between(rnd, 1, 3), rotation: turn() };
    case 'VORTEX': return { type: kind, strength: sign(rnd) * between(rnd, 2, 5), rotation: odd ? turn() : [0, 0, 0], ...(odd ? { falloff: power() } : {}) };
    case 'MAGNET': return { type: kind, strength: sign(rnd) * between(rnd, 2, 5), rotation: odd ? turn() : [0, 0, 0] };
    case 'DRAG': return odd ? { type: kind, linear: between(rnd, 0.2, 1.2), quadratic: between(rnd, 0.1, 0.8) } : { type: kind, linear: between(rnd, 0.5, 1.5), quadratic: 0 };
    case 'CHARGE': return { type: kind, strength: sign(rnd) * between(rnd, 2, 5), ...(odd ? { falloff: power() } : {}) };
    case 'TURBULENCE': return { type: kind, strength: between(rnd, 2, 5), size: between(rnd, 0.8, 2), seed: 1 + Math.floor(rnd() * 100), ...(odd ? { noise: between(rnd, 0, 1) } : {}) };
    case 'TEXTURE': return { type: kind, strength: between(rnd, 3, 8), texture: pick(rnd, ['CLOUDS', 'VORONOI', 'MARBLE', 'WOOD', 'STUCCI'] as const), scale: between(rnd, 0.6, 2) };
    default: return { type: kind, strength: 1 };
  }
}

/** The kinds of field of a level, as the condition has them. */
function kindsOf(level: number, c: Condition, rnd: () => number): FieldSpec['type'][] {
  const primary: FieldSpec['type'] = c === 'C' ? 'TEXTURE' : 'FORCE';
  const second = pick(rnd, ['HARMONIC', 'WIND'] as const);
  const moving = pick(rnd, ['DRAG', 'VORTEX', 'MAGNET'] as const);
  switch (level) {
    case 1: return [primary];
    case 2: return rnd() < 0.5 ? [primary, second] : [primary, second, 'FORCE'];
    case 3: return [primary, moving];
    case 4: return [c === 'C' ? 'TEXTURE' : 'HARMONIC', 'CHARGE'];
    case 5: return ['HARMONIC'];
    default: return ['HARMONIC', 'TURBULENCE'];
  }
}

const bodyCount = (level: number) => (level <= 3 ? 3 : level === 4 ? 4 : level === 5 ? 5 : 8);

/** The hidden properties of the particles: none before level 4; then masses, and charges (level 4: in a charged field;
    from level 5: the particles' own fields, so they pull on each other). Drawn anew in each place of the family. */
function bodiesOf(names: readonly string[], level: number, rnd: () => number): BodySpec[] {
  return names.map((name) => {
    if (level < 4) return { name, mass: 1 };
    const mass = between(rnd, 0.5, 3);
    const q = sign(rnd) * between(rnd, level >= 6 ? 2 : 0.5, level >= 6 ? 4 : 1.5);
    /* Strong charges (level 6) meet closely: Blender may then throw a particle out of the scene (it is gone from then on). */
    const own = level >= 4 ? { type: (level >= 5 && rnd() < 0.3 ? 'LENNARDJ' : 'CHARGE') as 'CHARGE' | 'LENNARDJ', strength: q } : undefined;
    return { name, mass, ...(own ? { field: own } : {}) };
  });
}

const placeRnd = (seed: number, level: number, c: Condition, place: number) => mulberry32(seed * 7919 + level * 104729 + 'ABC'.indexOf(c) * 1301 + place * 15485863);
const somewhere = (rnd: () => number, r: number): Vec3 => [between(rnd, -r, r), between(rnd, -r, r), between(rnd, -r, r)];

/** The laboratory's world: seed, level (1 to 6) and condition. */
export function generateScene(seed: number, level: number, condition: Condition): SceneSpec {
  const rnd = mulberry32(seed * 104723 + level * 7919 + 'ABC'.indexOf(condition) * 31);
  const region = 3;
  const kinds = kindsOf(level, condition, rnd);
  /* Level 6 keeps the particles together (a strong spring) so that they meet again and again: chaos. */
  const fields = kinds.map((k) => (level >= 6 && k === 'HARMONIC' ? { ...fieldOf(k, condition, rnd), strength: between(rnd, 4, 7) } : fieldOf(k, condition, rnd)));
  const names = [...LETTERS].sort(() => rnd() - 0.5).slice(0, kinds.length + bodyCount(level));
  const engine: EngineSpec = condition === 'A'
    ? { integrator: 'MIDPOINT', subframes: 0, timestep: 0.04, damping: 0, drag: 0 }
    : { integrator: pick(rnd, ['EULER', 'VERLET', 'MIDPOINT', 'RK4'] as const), subframes: Math.floor(rnd() * 4), timestep: pick(rnd, [0.02, 0.04, 0.05]), damping: between(rnd, 0, 0.03), drag: between(rnd, 0, 0.1) };
  const frame: FrameSpec = condition === 'A'
    ? { rot: IDENTITY, scale: 1, shift: [0, 0, 0], tau: engine.timestep }
    : { rot: randomRotation(rnd), scale: round4(10 ** (rnd() * 1.4 - 0.4)), shift: [0, 0, 0], tau: pick(rnd, [0.1, 0.25, 0.5, 1]) };
  const base: SceneSpec = {
    seed, level, condition, place: 0, engine, frame, region,
    fields: fields.map((f) => ({ ...f, location: [0, 0, 0] as Vec3 })),
    markers: kinds.map((_, i) => ({ name: names[i], field: i })),
    bodies: bodiesOf(names.slice(kinds.length), level, rnd),
    frames: level >= 6 ? 240 : 90
  };
  return placeScene(base, 0);
}

/** Place `index` of the family: the same laws, engine and frame; the sources elsewhere, the table's origin elsewhere
    (condition A keeps Blender's), and, from level 4 on, the particles' hidden properties drawn anew. */
export function placeScene(spec: SceneSpec, index: number): SceneSpec {
  const rnd = placeRnd(spec.seed, spec.level, spec.condition, index);
  const fields = spec.fields.map((f) => ({ ...f, location: somewhere(rnd, spec.region / 2) }));
  const shift: Vec3 = spec.condition === 'A' ? [0, 0, 0] : [between(rnd, -5, 5), between(rnd, -5, 5), between(rnd, -5, 5)].map((v) => round4(v * spec.frame.scale)) as Vec3;
  const bodies = spec.level >= 4 && index > 0 ? bodiesOf(spec.bodies.map((b) => b.name), spec.level, rnd) : spec.bodies;
  return { ...spec, place: index, fields, bodies, frame: { ...spec.frame, shift } };
}

/* --- The frame: Blender's coordinates and the learner's ----------------------------------------------- */

const mul = (m: readonly number[], v: readonly number[]): Vec3 => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
const mulT = (m: readonly number[], v: readonly number[]): Vec3 => [m[0] * v[0] + m[3] * v[1] + m[6] * v[2], m[1] * v[0] + m[4] * v[1] + m[7] * v[2], m[2] * v[0] + m[5] * v[1] + m[8] * v[2]];

export const toPercept = (f: FrameSpec, w: readonly number[]): Vec3 => mul(f.rot, w).map((v, i) => f.scale * v + f.shift[i]) as Vec3;
export const fromPercept = (f: FrameSpec, q: readonly number[]): Vec3 => mulT(f.rot, q.map((v, i) => (v - f.shift[i]) / f.scale));
/** A velocity the learner gives (its units per unit of the table's time) in Blender's (units per second). */
export const velocityFromPercept = (f: FrameSpec, e: EngineSpec, v: readonly number[]): Vec3 => mulT(f.rot, v).map((x) => (x * f.tau) / (f.scale * e.timestep)) as Vec3;

/* --- What Blender is asked -------------------------------------------------------------------------------- */

export interface Start { readonly name: string; readonly location: Vec3; readonly velocity: Vec3 }

/** The scene of an episode, in the service's terms: the fields, and the particles that start as given. */
export function serviceScene(spec: SceneSpec, starts: readonly Start[]): Record<string, unknown> {
  const byName = new Map(spec.bodies.map((b) => [b.name, b]));
  return {
    engine: spec.engine,
    fields: spec.fields,
    particles: starts.map((s) => {
      const b = byName.get(s.name)!;
      return { location: s.location, velocity: s.velocity, mass: b.mass, ...(b.field ? { field: b.field } : {}) };
    })
  };
}

/** The environment's starts: every particle, somewhere in the box away from the sources, moving slowly. */
export function randomStarts(spec: SceneSpec, rnd: () => number): Start[] {
  return spec.bodies.map((b) => {
    let location = somewhere(rnd, spec.region);
    for (let k = 0; k < 20 && tooClose(spec, location); k++) location = somewhere(rnd, spec.region);
    return { name: b.name, location, velocity: [between(rnd, -0.8, 0.8), between(rnd, -0.8, 0.8), between(rnd, -0.8, 0.8)] };
  });
}

/** Whether a start is on top of a source (where a field may be singular). */
export const tooClose = (spec: SceneSpec, w: readonly number[]): boolean => spec.fields.some((f) => Math.hypot(w[0] - f.location[0], w[1] - f.location[1], w[2] - f.location[2]) < 0.15 * spec.region);
export const insideReach = (spec: SceneSpec, w: readonly number[]): boolean => w.every((v) => Math.abs(v) <= 3 * spec.region);

/* --- The truth (operator only) ------------------------------------------------------------------------------ */

const FIELD_WORDS: Record<FieldSpec['type'], string> = {
  FORCE: 'a central force along the line to the source (Blender FORCE field)',
  HARMONIC: 'a spring-like pull toward the source, growing with distance (Blender HARMONIC field)',
  WIND: 'a uniform push along one fixed direction (Blender WIND field)',
  VORTEX: 'a swirl around the source\'s axis, perpendicular to the radius (Blender VORTEX field)',
  MAGNET: 'a force perpendicular to the particle\'s velocity, depending on it (Blender MAGNETIC field)',
  DRAG: 'a force opposing the velocity (Blender DRAG field: linear and quadratic terms)',
  CHARGE: 'a central force whose sign depends on the particle\'s own hidden charge (Blender CHARGE field)',
  LENNARDJ: 'a Lennard-Jones interaction (Blender LENNARDJ field)',
  TURBULENCE: 'a deterministic noise field varying in space (Blender TURBULENCE field)',
  TEXTURE: 'the gradient of a procedural texture, varying in space with no simple formula (Blender TEXTURE field)'
};

/** OPERATOR ONLY: the scene as statements the grader compares with the learner's words. */
export function describeSceneTruth(spec: SceneSpec): { id: string; statement: string }[] {
  const out = spec.fields.map((f, i) => ({ id: 'field' + (i + 1), statement: 'Marker ' + spec.markers[i].name + ' is the source of ' + FIELD_WORDS[f.type]
    + (f.strength !== undefined ? ', strength ' + f.strength : '') + (f.falloff ? ', fall-off ' + f.falloff.type.toLowerCase() + ' with power ' + f.falloff.power + (f.falloff.min ? ' (no effect closer than ' + f.falloff.min + ')' : '') : f.type === 'FORCE' || f.type === 'HARMONIC' || f.type === 'CHARGE' ? ', no fall-off with distance' : '')
    + (f.linear !== undefined ? ', linear ' + f.linear + ', quadratic ' + f.quadratic : '') + '.' }));
  out.push({ id: 'superposition', statement: 'The effects of the fields add up; every particle feels every field.' });
  if (spec.level >= 4) out.push({ id: 'hidden_mass', statement: 'Each particle has a hidden mass (between 0.5 and 3) that divides the forces on it; it differs between places.' });
  if (spec.bodies.some((b) => b.field?.type === 'CHARGE')) out.push({ id: 'hidden_charge', statement: 'Each particle carries a hidden charge with a sign: like charges repel, unlike attract' + (spec.level >= 5 ? ', particle on particle' : ', in the charged field and, weakly, particle on particle (in Blender a charge is also a source)') + '.' });
  if (spec.bodies.some((b) => b.field?.type === 'LENNARDJ')) out.push({ id: 'lennard_jones', statement: 'Some particles carry a Lennard-Jones field: repulsive very close, attractive a little further.' });
  out.push({ id: 'integration', statement: 'Positions are advanced by Blender\'s ' + spec.engine.integrator.toLowerCase() + ' integrator' + (spec.engine.subframes ? ' with ' + spec.engine.subframes + ' subframes' : '') + (spec.engine.damping ? ', velocity damping ' + spec.engine.damping + ' per step' : '') + (spec.engine.drag ? ', air drag ' + spec.engine.drag : '') + '.' });
  return out;
}
