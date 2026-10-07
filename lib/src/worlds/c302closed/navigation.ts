import { Sensor, move, type BodySpec, type BodyState, type Episode, type FieldSpec, type Pose, type Signals } from './body.ts';
import { mulberry32 } from '../grid/gen.ts';

/* ============================================================================
 * The three contracts before the closed-loop laboratory (SPEC-C302-LAZO-CERRADO §5, §6, §7).
 *
 * §5 THE PERCEPT. The facet of signals perceives what c302nav's does - the time, and the current
 * that came into each odor cell up to now - and the changes an act made: never the body (where it
 * is, where it heads, what it smells), since its recent course nearly reveals the signals it
 * should predict. Indexed as c302nav's: the current shown at t_k is the one that acted over
 * (t_{k−1}, t_k]; the signals at t_k are what came of it.
 *
 * §7 THE NAVIGATION. Predicting the next step forces no understanding of the loop: at a constant
 * speed and 5 ms, extrapolating is almost always right. So the learner's model - a model of the
 * CIRCUIT, the same answer as the signals' facet - is put in the loop: from the true state at a
 * point, the body (declared, ours) is driven by the model's own signals, never seeing the real
 * body again, for each horizon (50 ms, 500 ms, 2 s by default); where it ends is compared with
 * where the worm was. Three baselines that know nothing are driven the same way: straight on,
 * the recent angular velocity kept, and sharp turns at the episode's mean rate so far. The model
 * holds when it does better than every baseline at every horizon. Around the sharp turns: whether
 * the rollout turned within the horizon when the worm did, and how far apart in time.
 *
 * §6 CHANCE. In the stochastic body a point prediction against one draw is unfair: the model and
 * the baselines are rolled out in R replicas (their own draws), and scored by the energy score -
 * mean ‖X_i − y‖ − ½ mean ‖X_i − X_j‖ - which is the distance itself with one replica (the
 * deterministic body).
 * ========================================================================== */

/** What the facet of signals perceives at a step of an episode (in the names the run gives the two odor cells). */
export interface SignalsPoint {
  readonly step: number;
  readonly t: readonly number[];
  readonly inputs: Readonly<Record<string, readonly number[]>>;
  readonly changes?: Readonly<Record<string, unknown>>;
}

export interface Names { readonly left: string; readonly right: string }

/** §5: the percept of the facet of signals at step k - nothing of the body, nothing after t_k. */
export function signalsPoint(e: Episode, k: number, names: Names, dtMs: number, changes?: Readonly<Record<string, unknown>>): SignalsPoint {
  const t0 = e.steps[0]?.t ?? 0;
  const came = (side: 'left' | 'right') => Array.from({ length: k + 1 }, (_, j) => (j === 0 ? 0 : e.steps[j - 1][side]));
  return { step: k, t: Array.from({ length: k + 1 }, (_, j) => t0 + j * dtMs), inputs: { [names.left]: came('left'), [names.right]: came('right') }, ...(changes ? { changes } : {}) };
}

/** The signals at t_k (what the facet of signals is asked), as the circuit gave them. */
export const signalsAt = (e: Episode, k: number, initial: Signals): Signals => (k === 0 ? initial : e.steps[k - 1].signals);

/** A model of the circuit, as the harness asks it: the signals at a point. */
export type ModelAnswer = (p: SignalsPoint) => Promise<Signals | null>;

export const HORIZONS_MS = [50, 500, 2000] as const;

export interface RolloutContext {
  readonly field: FieldSpec;
  readonly body: BodySpec;
  readonly dtMs: number;
  readonly names: Names;
  readonly changes?: Readonly<Record<string, unknown>>;
}

/** The body driven from step k of a true episode for `horizonMs` by signals from `next` - given the percept so far, the
    signals at its end - from the true state at t_k, never seeing the real body again. The first step moves by the signals
    at t_k (`now`). Null when the driver could not answer. */
export async function rollout(ctx: RolloutContext, e: Episode, k: number, horizonMs: number, now: Signals, next: (p: SignalsPoint) => Promise<Signals | null>, rnd: () => number): Promise<Pose | null> {
  const start = e.steps[k];
  let state: BodyState = { pose: start.pose, accumulated: start.accumulated, turns: start.turns };
  let signals = now;
  /* The same sensor: inside a pulse, what that pulse carries. */
  const sensor = new Sensor(ctx.body, start.t + horizonMs, ctx.body.sensing ? { left: start.left, right: start.right } : undefined, start.t);
  const base = signalsPoint(e, k, ctx.names, ctx.dtMs, ctx.changes);
  const t = [...base.t], left = [...base.inputs[ctx.names.left]], right = [...base.inputs[ctx.names.right]];
  for (let j = 0; j < Math.round(horizonMs / ctx.dtMs); j++) {
    const tj = start.t + j * ctx.dtMs;
    const current = sensor.current(ctx.field, state.pose, tj);
    state = move(ctx.body, ctx.field, state, signals, ctx.dtMs, rnd);
    t.push(tj + ctx.dtMs); left.push(current.left); right.push(current.right);
    const s = await next({ step: k + j + 1, t, inputs: { [ctx.names.left]: left, [ctx.names.right]: right }, ...(ctx.changes ? { changes: ctx.changes } : {}) });
    if (!s) return null;
    signals = s;
  }
  return state.pose;
}

/** §6: the energy score of samples against what came (the distance, with one sample). */
export function energyScore(samples: readonly Pose[], y: Pose): number {
  const d = (a: Pose, b: Pose) => Math.hypot(a.x - b.x, a.y - b.y);
  const first = samples.reduce((s, x) => s + d(x, y), 0) / samples.length;
  let second = 0;
  for (const a of samples) for (const b of samples) second += d(a, b);
  return first - 0.5 * second / (samples.length * samples.length);
}

/** The baselines of §7, as drivers of the body: they know the body's past up to the point, never the circuit. */
export function baselines(ctx: RolloutContext, e: Episode, k: number): Record<string, Signals> {
  const dt = ctx.dtMs / 1000, b = ctx.body;
  /* The angular velocity of the last 500 ms, as a steering. */
  const back = Math.min(k, Math.round(500 / ctx.dtMs));
  const turnsIn = e.steps.slice(k - back, k).reduce((s, x) => s + (x.turn ?? 0), 0);
  const omega = back ? (e.steps[k].pose.heading - e.steps[k - back].pose.heading - turnsIn) / (back * dt) : 0;
  /* The episode's mean rate of sharp turns so far, as a reorientation. */
  const made = e.steps.slice(0, k).filter((x) => x.turn !== undefined).length;
  const rate = k ? made / (k * dt) : 0;
  return {
    straight: { reorientation: b.rate.r0, steering: 0 },
    keep_angular_velocity: { reorientation: b.rate.r0, steering: omega / b.steer.gain },
    turns_at_mean_rate: { reorientation: b.rate.r0 + rate / b.rate.gain, steering: 0 }
  };
}

export interface HorizonResult {
  readonly horizon: number;
  /** The model's score and each baseline's (median over the points), lower is better; null where the model never answered. */
  readonly model: number | null;
  readonly baselines: Readonly<Record<string, number>>;
  /** Around the sharp turns: of the points where the worm turned within the horizon, in how many the rollout did too, and
      the median distance in time between the two (ms). */
  readonly turns: { readonly worm: number; readonly rollout_too: number; readonly timing_ms: number | null };
}

const median = (x: readonly number[]): number | null => {
  if (!x.length) return null;
  const s = [...x].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** §7: the model in the loop at the given points of an episode, against the baselines, at each horizon. `replicas` > 1 for
    the stochastic body (§6). The model holds when, at every horizon, its median score is below every baseline's. */
export async function navigationCheck(ctx: RolloutContext, e: Episode, initial: Signals, points: readonly number[], model: ModelAnswer,
  o: { horizons?: readonly number[]; replicas?: number; seed?: number } = {}): Promise<{ holds: boolean; horizons: HorizonResult[] }> {
  const horizons = o.horizons ?? HORIZONS_MS, replicas = Math.max(1, o.replicas ?? (ctx.body.mode === 'stochastic' ? 8 : 1));
  const out: HorizonResult[] = [];
  for (const h of horizons) {
    const n = Math.round(h / ctx.dtMs);
    const scores: number[] = [], base: Record<string, number[]> = {};
    let worm = 0, both = 0;
    const timing: number[] = [];
    for (const k of points) {
      if (k + n > e.steps.length) continue;
      const truth = k + n < e.steps.length ? e.steps[k + n].pose : e.end.pose;
      const now = await model(signalsPoint(e, k, ctx.names, ctx.dtMs, ctx.changes));
      const samples: Pose[] = [];
      for (let r = 0; r < replicas && now; r++) {
        const end = await rollout(ctx, e, k, h, now, model, mulberry32((o.seed ?? 1) * 7919 + k * 31 + r));
        if (!end) { samples.length = 0; break; }
        samples.push(end);
      }
      if (samples.length) scores.push(energyScore(samples, truth));
      for (const [name, s] of Object.entries(baselines(ctx, e, k))) {
        const bs: Pose[] = [];
        for (let r = 0; r < replicas; r++) bs.push((await rollout(ctx, e, k, h, s, async () => s, mulberry32((o.seed ?? 1) * 104729 + k * 31 + r)))!);
        (base[name] ??= []).push(energyScore(bs, truth));
      }
      /* Around the sharp turns, in the deterministic body: the rollout's own turns, counted by a replay with a recorder. */
      const wormTurn = e.steps.slice(k, k + n).findIndex((x) => x.turn !== undefined);
      if (wormTurn >= 0 && now) {
        worm++;
        const at = await firstTurnOf(ctx, e, k, h, now, model);
        if (at !== null) { both++; timing.push(Math.abs(at - wormTurn) * ctx.dtMs); }
      }
    }
    out.push({ horizon: h, model: median(scores), baselines: Object.fromEntries(Object.entries(base).map(([k, v]) => [k, median(v)!])),
      turns: { worm, rollout_too: both, timing_ms: median(timing) } });
  }
  const holds = out.length > 0 && out.every((r) => r.model !== null && Object.values(r.baselines).every((b) => r.model! < b));
  return { holds, horizons: out };
}

/** The step of a rollout's first sharp turn within the horizon, or null (one replica, the first draw). */
async function firstTurnOf(ctx: RolloutContext, e: Episode, k: number, horizonMs: number, now: Signals, model: ModelAnswer): Promise<number | null> {
  const start = e.steps[k];
  let state: BodyState = { pose: start.pose, accumulated: start.accumulated, turns: start.turns };
  let signals = now;
  const rnd = mulberry32(k * 31 + 7919);
  const sensor = new Sensor(ctx.body, start.t + horizonMs, ctx.body.sensing ? { left: start.left, right: start.right } : undefined, start.t);
  const base = signalsPoint(e, k, ctx.names, ctx.dtMs, ctx.changes);
  const t = [...base.t], left = [...base.inputs[ctx.names.left]], right = [...base.inputs[ctx.names.right]];
  for (let j = 0; j < Math.round(horizonMs / ctx.dtMs); j++) {
    const tj = start.t + j * ctx.dtMs;
    const current = sensor.current(ctx.field, state.pose, tj);
    const moved = move(ctx.body, ctx.field, state, signals, ctx.dtMs, rnd);
    if (moved.turn !== undefined) return j;
    state = moved;
    t.push(tj + ctx.dtMs); left.push(current.left); right.push(current.right);
    const s = await model({ step: k + j + 1, t, inputs: { [ctx.names.left]: left, [ctx.names.right]: right }, ...(ctx.changes ? { changes: ctx.changes } : {}) });
    if (!s) return null;
    signals = s;
  }
  return null;
}
