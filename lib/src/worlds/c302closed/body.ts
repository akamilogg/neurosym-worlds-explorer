/* ============================================================================
 * The body and the field of c302nav in closed loop (SPEC-C302-LAZO-CERRADO §8, L1): ours, not
 * c302's, so they are declared here and verified by themselves - with synthetic circuits in place
 * of c302 - before anything is attributed to the circuit (C2).
 *
 *   the field   a point source; the concentration decays with the distance (exponential or
 *               gaussian, a length of the place); a square arena whose walls reflect
 *   smelling    the nose is at the tip of the head, which swings at a fixed frequency and
 *               amplitude; the total current into AWC is an increasing, saturating function of
 *               the concentration at the nose (2.5 to 6 pA); it is shared between the two sides
 *               as the head swings; no adaptation in the sensor (§12)
 *   acting      the reorientation becomes a non-negative rate, g·max(0, r − r0) capped; in the
 *               deterministic body (§6) the rate is accumulated and a sharp turn comes when it
 *               reaches a threshold, by a fixed angle to alternating sides; in the stochastic one
 *               a turn comes in a step with probability 1 − exp(−rate·Δ), by an angle drawn from
 *               a range, to a side drawn too; the steering bends the heading with a gain, capped
 *               at a maximum angular speed; the speed is constant
 *   arrival     the episode ends inside a radius of the source, or at its duration
 *
 * ONE STEP of control k (Δ = dt), in the fixed order of §5: (1) the state at t_k is observed - the
 * pose, the concentration at the nose, and the current applied over (t_{k−1}, t_k]; (2) the current
 * for (t_k, t_{k+1}] comes from the concentration at t_k; (3) the circuit advances to t_{k+1} and
 * gives its signals there; (4) the body moves from t_k to t_{k+1} by the signals at t_k - so the
 * signals at t_{k+1} move it from t_{k+1} to t_{k+2}, never the step they were read in.
 * ========================================================================== */

export type Vec2 = readonly [number, number];

export interface FieldSpec {
  /** Where the source is (mm). */
  readonly source: Vec2;
  /** The concentration at the source (arbitrary units). */
  readonly peak: number;
  /** How fast it decays with the distance (mm): exp(−d/L) or exp(−d²/2L²). */
  readonly length: number;
  readonly shape: 'exp' | 'gauss';
  /** The arena is the square [−a, a]² (mm); its walls reflect. */
  readonly arena: number;
  /** Uniform: the same concentration everywhere (a control, §8.2). */
  readonly uniform?: boolean;
}

export interface BodySpec {
  /** Constant speed (mm/s). */
  readonly speed: number;
  /** The head's swing: frequency (Hz) and amplitude (rad); the nose is `nose` mm ahead of the body's point. */
  readonly headHz: number;
  readonly headAmp: number;
  readonly nose: number;
  /** The total current into AWC: min + (max − min)·c/(c + half) (pA). */
  readonly current: { readonly min: number; readonly max: number; readonly half: number };
  /** How much of the total the swing moves between the sides: the left takes (1 + depth·sin φ)/2. */
  readonly split: number;
  /** The reorientation as a rate of sharp turns (per s): min(max, gain·max(0, r − r0)). */
  readonly rate: { readonly gain: number; readonly r0: number; readonly max: number };
  /** Deterministic: a turn when the accumulated rate reaches `threshold`; stochastic: with probability 1 − exp(−rate·Δ). */
  readonly mode: 'deterministic' | 'stochastic';
  readonly threshold: number;
  /** A sharp turn: by `angle` (deterministic), or by an angle in [min, max] (stochastic), in rad. */
  readonly turn: { readonly angle: number; readonly min: number; readonly max: number };
  /** The steering: dθ/dt = gain·s (rad/s, positive turns left), at most `maxRate`. */
  readonly steer: { readonly gain: number; readonly maxRate: number };
  /** The episode ends within this distance of the source (mm). */
  readonly arrival: number;
  /** 1, or −1 for the mirror image of the body (its swing and its turns go the other way): §8.2's reflection. */
  readonly chirality?: 1 | -1;
}

export const DEFAULT_BODY: BodySpec = {
  speed: 0.2, headHz: 0.5, headAmp: 0.6, nose: 0.5,
  current: { min: 2.5, max: 6, half: 0.5 }, split: 0.5,
  rate: { gain: 1, r0: 0, max: 2 }, mode: 'deterministic', threshold: 1,
  turn: { angle: 2, min: 1.5, max: 2.6 }, steer: { gain: 1, maxRate: 1 }, arrival: 0.5
};

export interface Pose { readonly x: number; readonly y: number; readonly heading: number }

/** What a circuit gives at a step: the two signals. */
export interface Signals { readonly reorientation: number; readonly steering: number }

/** A circuit closed on the body: the current into the two sides over a step in, its signals at the end of it out. */
export interface Circuit {
  /** Its signals before anything has come in (what moves the body over its first step). */
  readonly initial: Signals;
  step(left: number, right: number, dtMs: number): Signals;
}

/** The concentration at a point. */
export function concentration(field: FieldSpec, p: Vec2): number {
  if (field.uniform) return field.peak;
  const d = Math.hypot(p[0] - field.source[0], p[1] - field.source[1]);
  return field.peak * (field.shape === 'gauss' ? Math.exp(-(d * d) / (2 * field.length * field.length)) : Math.exp(-d / field.length));
}

/** The head's phase at a time, and where the nose is. The swing starts at an extreme (−π/2): started from the middle, what
    it bends the heading by while the body goes would not average out - a constant bias of the course measured in a uniform
    field (§8.2), an artefact of the body, corrected here. */
export const phaseAt = (body: BodySpec, tMs: number): number => 2 * Math.PI * body.headHz * tMs / 1000 - Math.PI / 2;
export function noseAt(body: BodySpec, pose: Pose, tMs: number): Vec2 {
  const head = pose.heading + (body.chirality ?? 1) * body.headAmp * Math.sin(phaseAt(body, tMs));
  return [pose.x + body.nose * Math.cos(head), pose.y + body.nose * Math.sin(head)];
}

/** The current into AWCL and AWCR over the next step, from the concentration at the nose now (pA). */
export function sense(body: BodySpec, c: number, tMs: number): { left: number; right: number } {
  const total = body.current.min + (body.current.max - body.current.min) * c / (c + body.current.half);
  const s = (body.chirality ?? 1) * body.split * Math.sin(phaseAt(body, tMs));
  return { left: total * (1 + s) / 2, right: total * (1 - s) / 2 };
}

/** The rate of sharp turns a reorientation signal stands for (per s): never negative, capped. */
export const turnRate = (body: BodySpec, r: number): number => Math.min(body.rate.max, body.rate.gain * Math.max(0, r - body.rate.r0));

export interface Step {
  /** The time at the start of the step (ms), the pose and the concentration at the nose then. */
  readonly t: number;
  readonly pose: Pose;
  readonly c: number;
  /** The current over the step (pA), and the circuit's signals at its end. */
  readonly left: number;
  readonly right: number;
  readonly signals: Signals;
  /** A sharp turn made during the step's motion (its angle, rad). */
  readonly turn?: number;
  /** The deterministic body's state at the start of the step: the turn rate accumulated, the turns made. */
  readonly accumulated: number;
  readonly turns: number;
}

export interface Episode {
  readonly steps: readonly Step[];
  readonly end: { readonly t: number; readonly pose: Pose; readonly reached: boolean };
  /** The deterministic body's state at the end: what a rollout from here goes on with. */
  readonly accumulated?: number;
  readonly turns?: number;
}

/** One episode in closed loop: the body in the field, driven by the circuit, step by step in the order of §5. `blocked`: the
    circuit still smells and acts, the body does not move (§9's act with the body blocked). `rnd`: the stochastic body's draws. */
export function runEpisode(o: { field: FieldSpec; body: BodySpec; circuit: Circuit; start: Pose; durationMs: number; dtMs: number; rnd?: () => number; blocked?: boolean;
  /** Where in time it starts (ms): a rollout from a point of an episode keeps the head's swing in phase. */
  t0Ms?: number;
  /** The turn rate accumulated so far (the deterministic body), and how many turns it made (their sides alternate). */
  accumulated?: number; turns?: number }): Episode {
  const { field, body, circuit, dtMs } = o;
  let pose = o.start, signals = circuit.initial, accumulated = o.accumulated ?? 0, turns = o.turns ?? 0;
  const steps: Step[] = [];
  const n = Math.round(o.durationMs / dtMs);
  const arrived = (p: Pose) => !field.uniform && Math.hypot(p.x - field.source[0], p.y - field.source[1]) <= body.arrival;
  for (let k = 0; k < n; k++) {
    const t = (o.t0Ms ?? 0) + k * dtMs;
    if (arrived(pose)) return { steps, end: { t, pose, reached: true }, accumulated, turns };
    const before = pose, accBefore = accumulated, turnsBefore = turns;
    /* (1) observed at t_k; (2) the current over the step, from the concentration at the nose now. */
    const c = concentration(field, noseAt(body, pose, t));
    const { left, right } = sense(body, c, t);
    /* (3) the circuit advances over the step: its signals at t_{k+1}. */
    const next = circuit.step(left, right, dtMs);
    /* (4) the body moves over the step by the signals at t_k. */
    let turn: number | undefined;
    if (!o.blocked) {
      const moved = move(body, field, { pose, accumulated, turns }, signals, dtMs, o.rnd ?? Math.random);
      ({ pose, accumulated, turns } = moved);
      turn = moved.turn;
    }
    steps.push({ t, pose: before, c, left, right, signals: next, accumulated: accBefore, turns: turnsBefore, ...(turn !== undefined ? { turn } : {}) });
    signals = next;
  }
  return { steps, end: { t: (o.t0Ms ?? 0) + n * dtMs, pose, reached: arrived(pose) }, accumulated, turns };
}

/** The body's state between steps: where it is, and (the deterministic body) the turn rate accumulated and the turns made. */
export interface BodyState { readonly pose: Pose; readonly accumulated: number; readonly turns: number }

/** One step of the body's motion (§5, 4): from its state, by the signals at the start of the step. */
export function move(body: BodySpec, field: FieldSpec, state: BodyState, signals: Signals, dtMs: number, rnd: () => number): BodyState & { readonly turn?: number } {
  const chi = body.chirality ?? 1;
  let { accumulated, turns } = state;
  let turn: number | undefined;
  const rate = turnRate(body, signals.reorientation);
  const dt = dtMs / 1000;
  if (body.mode === 'deterministic') {
    accumulated += rate * dt;
    if (accumulated >= body.threshold) { accumulated -= body.threshold; turn = chi * (turns++ % 2 === 0 ? 1 : -1) * body.turn.angle; }
  } else if (rate > 0 && rnd() < 1 - Math.exp(-rate * dt)) {
    turn = (rnd() < 0.5 ? 1 : -1) * (body.turn.min + (body.turn.max - body.turn.min) * rnd());
  }
  const omega = Math.max(-body.steer.maxRate, Math.min(body.steer.maxRate, body.steer.gain * signals.steering));
  const heading = state.pose.heading + (turn ?? 0) + omega * dt;
  const pose = reflect(field.arena, { x: state.pose.x + body.speed * dt * Math.cos(heading), y: state.pose.y + body.speed * dt * Math.sin(heading), heading });
  return { pose, accumulated, turns, ...(turn !== undefined ? { turn } : {}) };
}

/** A pose kept inside the square arena: a wall it crossed sends it back, its heading mirrored. */
export function reflect(a: number, p: Pose): Pose {
  let { x, y, heading } = p;
  if (x > a) { x = 2 * a - x; heading = Math.PI - heading; } else if (x < -a) { x = -2 * a - x; heading = Math.PI - heading; }
  if (y > a) { y = 2 * a - y; heading = -heading; } else if (y < -a) { y = -2 * a - y; heading = -heading; }
  return { x, y, heading };
}
