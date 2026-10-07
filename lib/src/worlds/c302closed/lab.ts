import type { World } from '../../core/types.ts';
import { hashString } from '../../core/hash.ts';
import { ruleGradingSystem, unknownFields, type Lab, type LabContext, type LabOptions } from '../../learn/lab.ts';
import type { Objective, Place } from '../../learn/objective.ts';
import { INVESTIGATION_TOOLS as INVESTIGATION, type WorldInterface } from '../../learn/prompt.ts';
import { objectiveLines } from '../../learn/objective.ts';
import { mulberry32 } from '../grid/gen.ts';
import { PANEL, inputTraces, namingOf, type NamesMode, type Naming, type NetworkChanges, type Stimulus } from '../c302nav/world.ts';
import { REAL_SIGNALS, answerPair, c302NavAnswer, c302NavObjective, c302NavVerdict, type C302NavCase, type C302NavResult, type SignalNames } from '../c302nav/objective.ts';
import { changesInWords, holdR2Of, insightsOf, parseC302NavAct, realAct } from '../c302nav/lab.ts';
import { C302_BODY, type BodySpec, type Episode, type FieldSpec, type Pose, type Signals } from './body.ts';
import { HORIZONS_MS, navigationCheck, signalsPoint, type HorizonResult, type SignalsPoint } from './navigation.ts';

/* ============================================================================
 * c302-navigation-closed@1 (SPEC-C302-LAZO-CERRADO, L2): c302nav in CLOSED LOOP. The same panel
 * of c302, simulated by NEURON in the c302 service (POST /closed-loop); its two signals move a
 * worm in an odor field, and the current into AWCL and AWCR comes in pulses from what the worm
 * smells where it is (body.ts, C302_BODY: ours, declared, verified by itself in L1).
 *
 *   the places    an odor source at the centre of a square arena; the laboratory's field is
 *                 exponential (5 mm), the family's of other lengths and shapes, never seen
 *   the episodes  20 s (--duration) from a start drawn around the source, the pulses' times
 *                 from the episode's seed
 *   two FACETS    "signals" (the default): c302nav's task - the two signals from the current
 *                 alone (the percept has nothing of the body, §5); "navigation": the learner's
 *                 model of the circuit is put in the loop with the body, from the true state at
 *                 a few points, and must beat three baselines at 50 ms, 500 ms and 2 s (§7)
 *   the act       an episode of its own: where the worm starts, where the source is and how it
 *                 spreads, how long, the cells recorded, the network's changes, the body blocked
 *                 (it smells and acts, and does not move) - or the current of an episode of its
 *                 own replayed in open loop on the same engine (§9)
 *   the names     real or neutral, as c302nav's; the truth: EurekaBench's insights (--eureka)
 * ========================================================================== */

export interface ClosedSpec {
  readonly seed: number;
  readonly place: string;
  readonly field: FieldSpec;
  readonly names: NamesMode;
  readonly namesSeed: number;
  /** The episode's length (ms) and the integration step (ms). */
  readonly durationMs: number;
  readonly dtMs: number;
}

/** An episode as it came, in the learner's names: per control step k the body at its start, the concentration at the nose,
    the current over it; the signals at t_0..t_n; the sharp turns; the calcium of the cells recorded at each step's end. */
export interface ClosedEpisode {
  readonly t: readonly number[];
  readonly x: readonly number[];
  readonly y: readonly number[];
  readonly heading: readonly number[];
  readonly c: readonly number[];
  readonly left: readonly number[];
  readonly right: readonly number[];
  readonly reorientation: readonly number[];
  readonly steering: readonly number[];
  readonly turns: readonly (readonly [number, number])[];
  readonly accumulated: readonly number[];
  readonly turnsMade: readonly number[];
  readonly calcium: Readonly<Record<string, readonly number[]>>;
  readonly end: { readonly t: number; readonly pose: Pose; readonly reached: boolean };
  readonly field: FieldSpec;
  readonly body: BodySpec;
  readonly start: Pose;
  /** What an act asked of the network, in the learner's names. */
  readonly changes?: NetworkChanges;
  readonly blocked?: boolean;
  /** The episode whose current it replays (open loop). */
  readonly replayOf?: string;
  /** The stimuli it was designed with (open loop, in the learner's names). */
  readonly designed?: readonly Stimulus[];
  readonly identity: string;
  /** The names the learner is told the two odor cells and the two signals by (the run's). */
  readonly names: { readonly left: string; readonly right: string; readonly signals: readonly [string, string] };
}

export interface ClosedAct {
  readonly start?: Pose;
  readonly source?: readonly [number, number];
  readonly length?: number;
  readonly duration_ms?: number;
  readonly record: readonly string[];
  readonly changes?: NetworkChanges;
  readonly seed?: number;
  readonly blocked?: boolean;
  readonly replay?: string;
  /** Stimuli designed by the learner into the two odor cells, in open loop (as c302nav's). */
  readonly stimuli?: readonly Stimulus[];
  readonly place?: string;
}

export const CONTROL_MS = 5;
/** A designed open-loop episode's length by default (c302nav's). */
export const DESIGNED_MS = 9000;
const ARENA = 15;
const VIEW_ROWS = 60;
const namesOf = (o: LabOptions | undefined): NamesMode => (o?.names === 'neutral' ? 'neutral' : 'real');
const namingFor = (spec: ClosedSpec): Naming => namingOf(spec.names, spec.namesSeed);
const seedOf = (rnd: () => number): number => Math.floor(rnd() * 2 ** 31);
const signalNames = (n: Naming): SignalNames => n.signals as unknown as SignalNames;
const odorNames = (n: Naming) => ({ left: n.cell('AWCL'), right: n.cell('AWCR') });

function effects(ctx: LabContext | undefined) {
  if (!ctx?.effects) throw new Error('c302-navigation-closed@1 needs the c302 service with NEURON: run it through the laboratory runner (--service <url>)');
  return ctx.effects;
}

/** A start around the source: 6 to 9 mm away, heading anywhere. */
function startFrom(rnd: () => number, field: FieldSpec): Pose {
  const a = rnd() * 2 * Math.PI, d = 6 + 3 * rnd();
  return { x: field.source[0] + d * Math.cos(a), y: field.source[1] + d * Math.sin(a), heading: rnd() * 2 * Math.PI - Math.PI };
}

const canonical = (o: unknown): string => JSON.stringify(o, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));

/** One episode in the service, in the real names; answered in the learner's. */
async function episodeIn(spec: ClosedSpec, ctx: LabContext | undefined, o: { field: FieldSpec; start: Pose; seed: number; durationMs?: number; record?: readonly string[];
  changes?: NetworkChanges; learnerChanges?: NetworkChanges; blocked?: boolean; replay?: { left: readonly number[]; right: readonly number[]; of: string };
  designed?: { readonly learner: readonly Stimulus[]; readonly real: readonly Stimulus[] } }): Promise<ClosedEpisode | null> {
  const naming = namingFor(spec);
  const body: BodySpec = { ...C302_BODY, sensing: { ...C302_BODY.sensing!, seed: o.seed } };
  const durationMs = o.durationMs ?? spec.durationMs;
  const base = { cells: PANEL, parameter_set: 'C1', dt_ms: spec.dtMs, control_ms: CONTROL_MS, duration_ms: durationMs, record: o.record ?? [], ...(o.changes ?? {}) };
  let r: Record<string, any>;
  try {
    r = await effects(ctx).request('/closed-loop', o.replay ? { ...base, replay: { left: o.replay.left, right: o.replay.right } }
      : { ...base, field: o.field, body, start: o.start, seed: o.seed, ...(o.blocked ? { blocked: true } : {}) }) as Record<string, any>;
  } catch (e) {
    /* Refused, or the integration diverged: the learner is told only that it was refused. */
    const status = (e as { details?: { status?: number } })?.details?.status;
    if (status === 400 || status === 422) return null;
    throw e;
  }
  if (!Array.isArray(r.reorientation)) throw new Error('the c302 service answered no closed loop');
  const n = r.reorientation.length - 1;
  const fill = (k: string, v: number) => (Array.isArray(r[k]) ? r[k] as number[] : Array.from({ length: n }, () => v));
  const identity = o.designed ? designedIdentity(o.designed.real, durationMs, o.changes)
    : canonical({ field: o.field, start: o.start, seed: o.seed, duration_ms: durationMs, changes: o.changes ?? null, blocked: Boolean(o.blocked), replay: o.replay?.of ?? null });
  return {
    t: r.t ?? Array.from({ length: n + 1 }, (_, k) => k * CONTROL_MS), x: fill('x', o.start.x), y: fill('y', o.start.y), heading: fill('heading', o.start.heading),
    c: fill('c', 0), left: r.left ?? [], right: r.right ?? [], reorientation: r.reorientation, steering: r.steering, turns: r.turns ?? [],
    accumulated: fill('accumulated', 0), turnsMade: fill('turns_made', 0),
    calcium: Object.fromEntries(Object.entries((r.calcium ?? {}) as Record<string, number[]>).map(([c, x]) => [naming.cell(c), x.map((v) => Number((v * 1e8).toPrecision(6)))])),
    end: r.end ?? { t: n * CONTROL_MS, pose: o.start, reached: false }, field: o.field, body, start: o.start,
    ...(o.learnerChanges ? { changes: o.learnerChanges } : {}), ...(o.blocked ? { blocked: true } : {}), ...(o.designed ? { designed: o.designed.learner } : o.replay ? { replayOf: o.replay.of } : {}), identity,
    names: { ...odorNames(naming), signals: [naming.signals[0], naming.signals[1]] }
  };
}

/** A designed open-loop experiment, canonical: its stimuli (in any order, with their defaults), its length, its changes. */
function designedIdentity(stimuli: readonly Stimulus[], durationMs: number, changes: NetworkChanges | undefined): string {
  const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
  const s = stimuli.map((x) => JSON.stringify({ cell: x.cell, kind: x.kind ?? 'pulse', delay_ms: r6(x.delay_ms), duration_ms: r6(x.duration_ms), amplitude_pa: r6(x.amplitude_pa),
    ...(x.kind === 'sine' ? { period_ms: r6(x.period_ms!), phase_rad: r6(x.phase_rad ?? 0) } : {}) })).sort();
  return canonical({ designed: s, duration_ms: r6(durationMs), changes: changes ?? null });
}

/** The episode as the reference body's (navigation.ts reads it so). */
export function bodyEpisode(e: ClosedEpisode): Episode {
  const turnAt = new Map(e.turns.map(([k, a]) => [k, a]));
  return {
    steps: e.left.map((_, k) => ({ t: k * CONTROL_MS, pose: { x: e.x[k], y: e.y[k], heading: e.heading[k] }, c: e.c[k], left: e.left[k], right: e.right[k],
      signals: { reorientation: e.reorientation[k + 1], steering: e.steering[k + 1] }, accumulated: e.accumulated[k], turns: e.turnsMade[k],
      ...(turnAt.has(k) ? { turn: turnAt.get(k)! } : {}) })),
    end: e.end
  };
}

/** The percept at step k: the time and the current that came, nothing of the body (§5). */
export function pointOf(e: ClosedEpisode, k: number): SignalsPoint {
  const came = (side: readonly number[]) => Array.from({ length: k + 1 }, (_, j) => (j === 0 ? 0 : side[j - 1]));
  return { step: k, t: Array.from({ length: k + 1 }, (_, j) => j * CONTROL_MS), inputs: { [e.names.left]: came(e.left), [e.names.right]: came(e.right) },
    ...(e.changes ? { changes: changesInWords(e.changes) } : {}) };
}
const signalsAt = (e: ClosedEpisode, k: number): Record<string, number> => ({ [e.names.signals[0]]: e.reorientation[k], [e.names.signals[1]]: e.steering[k] });
const spreadOf = (x: readonly number[]): number => {
  const m = x.reduce((s, v) => s + v, 0) / x.length;
  const sd = Math.sqrt(x.reduce((s, v) => s + (v - m) ** 2, 0) / x.length);
  return sd > 0 ? sd : 1;
};

/** The act's form (its network part is c302nav's), or why it cannot be read. */
export function parseClosedAct(raw: Record<string, unknown>): ClosedAct | string {
  const unknown = unknownFields(raw, ['start', 'source', 'length', 'duration_ms', 'record', 'remove', 'scale', 'polarity', 'parameters', 'seed', 'blocked', 'replay', 'stimuli', 'place']);
  if (unknown) return unknown;
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const net = parseC302NavAct({ stimuli: [], ...Object.fromEntries(['record', 'remove', 'scale', 'polarity', 'parameters'].filter((k) => raw[k] !== undefined).map((k) => [k, raw[k]])) });
  if (typeof net === 'string') return net;
  const place = typeof raw.place === 'string' ? { place: raw.place } : {};
  const common = { record: net.record ?? [], ...(net.changes ? { changes: net.changes } : {}), ...place };
  if (raw.stimuli !== undefined) {
    if (raw.replay !== undefined || raw.start !== undefined || raw.source !== undefined || raw.length !== undefined || raw.blocked !== undefined || raw.seed !== undefined)
      return 'designed stimuli take no body, field, seed or replay: only the stimuli, the duration, the cells recorded and the network\'s changes';
    const designed = parseC302NavAct({ stimuli: raw.stimuli, ...Object.fromEntries(['record', 'remove', 'scale', 'polarity', 'parameters', 'duration_ms'].filter((k) => raw[k] !== undefined).map((k) => [k, raw[k]])) });
    if (typeof designed === 'string') return designed;
    if (!designed.stimuli?.length) return '"stimuli" is a list of at least one stimulus into the two odor cells';
    return { stimuli: designed.stimuli, ...(designed.duration_ms !== undefined ? { duration_ms: designed.duration_ms } : {}), ...common };
  }
  if (raw.replay !== undefined) {
    if (typeof raw.replay !== 'string') return '"replay" names an episode of yours in closed loop, whose current is given again in open loop';
    if (raw.start !== undefined || raw.source !== undefined || raw.length !== undefined || raw.blocked !== undefined || raw.seed !== undefined) return 'a replay takes no body, field or seed: only the episode, the cells recorded and the network\'s changes';
    return { replay: raw.replay, ...common };
  }
  const s = raw.start as Record<string, unknown> | undefined;
  if (s !== undefined && !(s && num(s.x) && num(s.y) && num(s.heading) && Math.abs(s.x) <= ARENA && Math.abs(s.y) <= ARENA)) return '"start" is {"x", "y", "heading"} (mm, rad), inside the arena (|x|, |y| <= ' + ARENA + ')';
  const src = raw.source as unknown[] | undefined;
  if (src !== undefined && !(Array.isArray(src) && src.length === 2 && src.every((v) => num(v) && Math.abs(v as number) <= ARENA))) return '"source" is [x, y] (mm), inside the arena';
  if (raw.length !== undefined && !(num(raw.length) && raw.length >= 2 && raw.length <= 10)) return '"length" (how far the odor spreads, mm) is between 2 and 10';
  if (raw.duration_ms !== undefined && !(num(raw.duration_ms) && raw.duration_ms > 0 && raw.duration_ms <= 60000)) return '"duration_ms" is at most 60000';
  if (raw.seed !== undefined && !Number.isInteger(raw.seed)) return '"seed" is an integer (the pulses\' times)';
  if (raw.blocked !== undefined && typeof raw.blocked !== 'boolean') return '"blocked" is true or false';
  return { ...(s ? { start: { x: s.x as number, y: s.y as number, heading: s.heading as number } } : {}), ...(src ? { source: [src[0] as number, src[1] as number] as const } : {}),
    ...(num(raw.length) ? { length: raw.length } : {}), ...(num(raw.duration_ms) ? { duration_ms: raw.duration_ms } : {}), ...(Number.isInteger(raw.seed) ? { seed: raw.seed as number } : {}),
    ...(raw.blocked === true ? { blocked: true } : {}), ...common };
}

/** The objective of a facet: c302nav's for the signals; the model in the loop for the navigation. */
export interface ClosedResult { readonly facet: 'signals' | 'navigation'; readonly place: string; readonly point: string; readonly signals?: C302NavResult; readonly holds?: boolean; readonly horizons?: readonly HorizonResult[] }

function closedObjective<M, P extends Place & { readonly spec?: ClosedSpec }>(host: { casesIn: any; answer(m: M, s: SignalsPoint): Promise<unknown>; focus?(): string | null; episode?(id: string): unknown; regression?: boolean },
  options: LabOptions): Objective<M, P, readonly C302NavCase[], ClosedResult> {
  const naming = namingOf(namesOf(options), 0);
  const signals = signalNames(naming);
  const sig = c302NavObjective<M, P>({ casesIn: host.casesIn, answer: (m, s) => host.answer(m, s as SignalsPoint), holdR2: holdR2Of(options), signals, ...(host.regression ? { regression: true } : {}) });
  const navPoints = Math.max(1, Math.floor(Number(options['nav-points']) || 2));
  const facet = (): 'signals' | 'navigation' => (host.focus?.() === 'navigation' ? 'navigation' : 'signals');
  const nav = (rs: readonly ClosedResult[]) => rs.length > 0 && rs.every((r) => r.holds);
  return {
    answer: c302NavAnswer(signals),
    verdictForm: c302NavVerdict({ signals, ...(host.regression ? { regression: true } : {}) }),
    casesIn: (place, context) => sig.casesIn(place, context),
    async run(model, cases, context) {
      if (facet() === 'signals') {
        const out = await sig.run(model, cases, context);
        return { ...out, byPlace: out.byPlace.map((rs) => rs.map((r) => ({ facet: 'signals' as const, place: r.place, point: r.point, signals: r }))) };
      }
      const byPlace: ClosedResult[][] = [];
      for (const { place, cases: points } of cases) {
        const rs: ClosedResult[] = [];
        const episodes = [...new Set(points.map((c) => c.point.split('@')[0]))];
        for (const id of episodes) {
          const e = host.episode?.(id) as ClosedEpisode | undefined;
          if (!e || !e.left.length) continue;
          const steps = points.filter((c) => c.point.startsWith(id + '@')).map((c) => c.state.step).filter((k) => k + 2000 / CONTROL_MS < e.left.length);
          const chosen = Array.from({ length: Math.min(navPoints, steps.length) }, (_, i) => steps[Math.floor((i + 0.5) * steps.length / Math.min(navPoints, steps.length))]);
          const names = { left: e.names.left, right: e.names.right };
          const model2 = async (p: SignalsPoint): Promise<Signals | null> => {
            const pair = answerPair(await host.answer(model, p), signals);
            return pair ? { reorientation: pair[signals[0]], steering: pair[signals[1]] } : null;
          };
          const check = await navigationCheck({ field: e.field, body: e.body, dtMs: CONTROL_MS, names, ...(e.changes ? { changes: changesInWords(e.changes) } : {}) },
            bodyEpisode(e), { reorientation: e.reorientation[0], steering: e.steering[0] }, chosen, model2);
          rs.push({ facet: 'navigation', place: place.id, point: id, holds: check.holds, horizons: check.horizons });
        }
        byPlace.push(rs);
      }
      return { byPlace };
    },
    holds: (results, ctx) => (results[0]?.facet === 'navigation' || (!results.length && facet() === 'navigation') ? nav(results)
      : sig.holds(results.map((r) => r.signals!), ctx.rerun ? { ...ctx, rerun: { before: ctx.rerun.before.map((r) => r.signals!), now: ctx.rerun.now.map((r) => r.signals!) } } : { place: ctx.place })),
    view(results, place) {
      if (results[0]?.facet !== 'navigation') return sig.view(results.map((r) => r.signals!), place);
      /* Facts only: per episode and horizon, whether the model in the loop did better than each baseline, and the turns. */
      return { episodes: results.map((r) => ({ episode: r.point, your_model_holds_here: r.holds,
        horizons: (r.horizons ?? []).map((h) => ({ horizon_ms: h.horizon, answered: h.model !== null,
          better_than: Object.fromEntries(Object.entries(h.baselines).map(([b, s]) => [b, h.model !== null && h.model < s])),
          sharp_turns: { the_worm_made: h.turns.worm, your_model_made_too: h.turns.rollout_too } })) })) };
    },
    rerunView: (rerun, place) => (rerun.now[0]?.facet === 'navigation' ? { episodes: rerun.now.length, your_model_holds_on_them: nav(rerun.now) }
      : sig.rerunView!({ before: rerun.before.map((r) => r.signals!), now: rerun.now.map((r) => r.signals!) }, place)),
    operatorView: (results, place) => (results[0]?.facet === 'navigation' ? { navigation: results.map((r) => ({ episode: r.point, holds: r.holds, horizons: r.horizons })) }
      : sig.operatorView!(results.map((r) => r.signals!), place)),
    trace: (results, place) => (results[0]?.facet === 'navigation' ? [] : sig.trace!(results.map((r) => r.signals!), place)),
    line: (results, place, rerun) => (results[0]?.facet === 'navigation'
      ? 'navigation: ' + results.map((r) => r.point + (r.holds ? ' holds' : ' does not hold') + ' [' + (r.horizons ?? []).map((h) => h.horizon + 'ms ' + (h.model === null ? '-' : h.model.toFixed(3)) + ' vs ' + Object.values(h.baselines).map((b) => b.toFixed(3)).join('/')).join('; ') + ']').join(', ')
      : sig.line!(results.map((r) => r.signals!), place, rerun ? { before: rerun.before.map((r) => r.signals!), now: rerun.now.map((r) => r.signals!) } : undefined))
  } as Objective<M, P, readonly C302NavCase[], ClosedResult>;
}

/** The world of its points, for models written for it. */
function closedPointWorld(): World<SignalsPoint, never> {
  return {
    id: 'c302-navigation-closed@1', actors: ['nature'],
    initial: () => { throw new Error('c302-navigation-closed@1 has no initial state: points come from episodes'); },
    toMove: () => 'nature', actions: () => [], step: (s: SignalsPoint) => s, outcome: () => ({ over: false, winner: null, reason: null }),
    key: (s: SignalsPoint) => hashString(JSON.stringify(s)), view: () => ({ entities: [], scalars: {} }), describeRules: () => '', actionKey: () => ''
  } as unknown as World<SignalsPoint, never>;
}

export const CLOSED_PERCEPT_DOC = 'At a point of an episode your code receives p = { step, t, inputs }: `p.t` is the time of each step from the start up to this one (ms, every '
  + CONTROL_MS + ' ms; `p.t[p.step]` is now), and `p.inputs` the current that came into each of the two odor cells over each of those steps (pA), by the name of the cell: '
  + '`p.inputs[<cell>][p.step]` is the current that acted over the step that ends now. Nothing after this step, and nothing of the worm\'s body: where it is, where it heads, what it smells. '
  + 'In an episode of yours that changed the network, `p.changes` says what it changed as you wrote it; otherwise there is no `p.changes`.';

const BODY_WORDS = 'THE WORM (the apparatus; it is not what you investigate). It goes at ' + C302_BODY.speed + ' mm/s in a square arena whose walls reflect, '
  + 'with an odor source in it whose concentration falls with the distance. Its head swings at ' + C302_BODY.headHz + ' Hz; the odor is smelled at the nose, in PULSES '
  + '(each 60 to 400 ms long, 100 to 900 ms apart): each pulse brings into the two odor cells a current fixed when it starts - the more odor at the nose then, the more current in all '
  + '(from 2.5 to 6 pA), shared between the two sides as the head is swung then - and held until it ends; between pulses, none. The first signal is a rate of sharp turns '
  + '(none below ' + C302_BODY.rate.r0 + '; a turn of ' + C302_BODY.turn.angle + ' rad, to alternating sides, each time the rate accumulates to 1); the second bends the course gradually '
  + '(' + C302_BODY.steer.gain + ' rad/s per unit of the signal; the worm turns at most ' + C302_BODY.steer.maxRate + ' rad/s however large the signal is - the cap is the body\'s, the signal has none; positive turns left). The signals at the end of a step move the worm over the next one.';

export function closedInterface(options: { regression?: boolean; names?: NamesMode; focus?: string | null } = {}): WorldInterface {
  const naming = namingOf(options.names ?? 'real', 0);
  const nav = options.focus === 'navigation';
  return {
    tools: ['view', 'inspect', 'act', 'measure', 'table'],
    features: ['check'],
    lines: [
      ...objectiveLines({ answer: c302NavAnswer(naming.signals as unknown as SignalNames), verdictForm: c302NavVerdict({ ...options, signals: naming.signals as unknown as SignalNames }) }),
      BODY_WORDS,
      nav ? 'WHAT COUNTS NOW: the navigation. Your model of the two signals is put in the loop with the worm: from where the worm truly was at a few points of an episode, its own signals move the worm, '
        + 'pulse after pulse, without seeing the real worm again, for ' + HORIZONS_MS.join(', ') + ' ms. It holds when, at every horizon, it ends closer to where the worm went than three explanations that know nothing: '
        + 'going straight on, keeping the recent angular velocity, and turning at the episode\'s mean rate.'
        : 'WHAT COUNTS: the two signals at each point, from the current alone (as in an open loop), on episodes in which the worm moved.',
      [INVESTIGATION, 'Requests:'],
      [['view'], '  {"view": "<episode>", "from": <step>, "to": <step>}   the rows of a stretch of one of your episodes (at most 60): the time, where the worm was and where it headed, the odor at its nose, the current into each odor cell, the two signals, its sharp turns, and the calcium of the cells recorded'],
      [['act'], '  {"act": {"start": {"x": <mm>, "y": <mm>, "heading": <rad>}, "source": [<x>, <y>], "length": <2 to 10 mm>, "duration_ms": <up to 60000>, "seed": <n>, "blocked": true | false, "record": ["<cell>", ...], '
        + '"remove": ["<connection>", ...], "scale": {"<connection>": <factor>}, "polarity": {"<connection>": "exc" | "inh"}, "parameters": {"<name>": "<value with its unit>"}, "place": "<laboratory>"}}   an episode of yours; everything is optional. '
        + '"seed" sets the pulses\' times; "blocked": the worm smells and its circuit acts, and it does not move. Or {"act": {"replay": "<episode of yours>", "record": [...], <changes>}}: the current of that episode given again, step by step, with the worm out of the loop. '
        + 'Or {"act": {"stimuli": [<stimulus>, ...], "duration_ms": <up to 60000; default ' + DESIGNED_MS + '>, "record": [...], <changes>}}: a current you design into the two odor cells, with the worm out of the loop - a stimulus is {"cell": "' + naming.cell('AWCL') + '" | "' + naming.cell('AWCR') + '", "delay_ms": <n>, "duration_ms": <n>, "amplitude_pa": <n>} (a square pulse) or the same with "kind": "sine", "period_ms": <n>, "phase_rad": <n>. '
        + 'The cells are ' + naming.cells.join(', ') + '. A connection is "<pre>-<post>" (chemical) or "<pre>-<post>_GJ" (gap junction). You get the episode ("act<n>"); view it. It may be refused, and you are not told why. At most `acts_left` this round.'],
      [['inspect'], '  {"inspect": "<episode>@<step>", "model": <round> | <draft> }   what a model answered at that point, part by part, and the signals that came'],
      [['measure'], '  {"measure": {"source": "(p) => ...", "range": [min, max]}, "on": ["<episode>@<step>", ...]}'],
      [['table'], '  {"table": {"source": "(p) => ...", "range": [min, max]}, "on": "episodes" | "checks"}   the points of your own episodes, or of the checks, each with the value of the code and the signals that came']
    ]
  };
}

async function drawn(spec: ClosedSpec, seed: number, ctx: LabContext | undefined): Promise<ClosedEpisode> {
  const rnd = mulberry32(seed);
  const e = await episodeIn(spec, ctx, { field: spec.field, start: startFrom(rnd, spec.field), seed });
  if (!e) throw new Error('the c302 service refused an episode of the environment');
  return e;
}

export const closedLab: Lab<ClosedSpec, SignalsPoint, ClosedEpisode, C302NavCase, ClosedAct> = {
  id: 'c302-navigation-closed@1',
  about: 'c302nav in closed loop (SPEC-C302-LAZO-CERRADO): the panel of 28 cells of c302, simulated by NEURON step by step, its two signals moving a worm in an odor field, the current into its odor cells '
    + 'coming in pulses from what it smells where it is. Facet "signals" (default): the two signals from the current alone; facet "navigation": the learner\'s model of the circuit put in the loop with the worm. '
    + 'The environment is the c302 service (scripts/c302-service.ts) with NEURON (NEURONHOME).',
  options: [
    { name: 'service', default: 'http://127.0.0.1:18600', help: 'where the c302 service is (start it with scripts/c302-service.ts, in an environment with NEURON)' },
    { name: 'acts', default: '2', help: 'episodes System 2 may ask for itself per round' },
    { name: 'hold-r2', default: '0.5,0.3', help: 'the facet of signals: the R² a model must reach in a place, per signal' },
    { name: 'nav-points', default: '2', help: 'the facet of navigation: the points of each episode the model is put in the loop from (each costs about a thousand of its answers)' },
    { name: 'duration', default: '20000', help: 'the environment\'s episodes (ms)' },
    { name: 'dt', default: '0.05', help: 'NEURON\'s integration step (ms): 0.025 is closer to jNeuroML (L0)' },
    { name: 'names', default: 'real', help: 'how cells, connections and signals are named to the learner: "real", or "neutral"' },
    { name: 'eureka', default: '', help: 'OPERATOR ONLY: a local copy of EurekaBench, whose rubric gives the insights the learner is graded against' }
  ],
  facets: [
    { id: 'signals', help: 'the two signals at each point, from the current alone (the default)' },
    { id: 'navigation', help: 'the learner\'s model of the circuit in the loop with the worm, against three baselines, at several horizons' }
  ],
  defaults: { every: '20', explore: '2', 'check-episodes': '2', family: '2', 'confirm-places': '1' },
  external: { url: (o) => o.service, timeoutMs: 60 * 60_000 },

  generate: (seed, options) => ({ seed, place: 'exp-5', field: { source: [0, 0], peak: 1, length: 5, shape: 'exp', arena: ARENA }, names: namesOf(options), namesSeed: seed,
    durationMs: Math.max(1000, Math.min(60000, Number(options.duration) || 20000)), dtMs: Math.max(0.01, Math.min(0.1, Number(options.dt) || 0.05)) }),
  /* The family's fields: other lengths, and gaussian ones; never the laboratory's. */
  placeOf: (spec, index) => {
    const lengths = [3, 4, 6, 8], shape = index % 2 ? 'gauss' as const : 'exp' as const, length = lengths[index % lengths.length];
    return { ...spec, seed: spec.seed * 1009 + index, place: shape + '-' + length + '-' + index, field: { ...spec.field, shape, length } };
  },
  runName: (seed, options) => 'c302closed-s' + seed + (namesOf(options) === 'neutral' ? '-neutral' : ''),
  headline: (spec) => '(c302 in closed loop with NEURON, field ' + spec.field.shape + ' ' + spec.field.length + ' mm, ' + spec.names + ' names)',
  placeInfo: (spec) => ({ field: spec.field, seed: spec.seed }),
  truth: (_spec, options) => (options.eureka ? insightsOf(options.eureka) : []),
  explorationSeed: (seed) => seed * 1013 + 29,

  world: closedPointWorld,
  perceive: (p) => p,
  perceptDoc: CLOSED_PERCEPT_DOC,
  interface: (o) => closedInterface({ regression: o.regression, names: namesOf(o.world), focus: o.focus ?? null }),

  episode: (spec, rnd, ctx) => drawn(spec, seedOf(rnd), ctx),
  explore: async (laboratories, rnd, count, ctx) => {
    const seeds = Array.from({ length: count }, () => seedOf(rnd));
    const lab = laboratories[0];
    return (await Promise.all(seeds.map((s) => drawn(lab.spec, s, ctx)))).map((episode) => ({ place: lab.id, episode }));
  },
  checkEpisodes: (spec, c, ctx) => {
    const rnd = mulberry32(ctx.seed * 7717 + c.round * 101 + c.index * 7 + (c.purpose === 'validation' ? 5000 : c.purpose === 'blind' ? 100000 * (1 + (c.set ?? 0)) : 0));
    return Promise.all(Array.from({ length: ctx.checkEpisodes }, () => seedOf(rnd)).map((s) => drawn(spec, s, ctx)));
  },
  steps: (e) => Math.max(0, e.left.length - 1),
  indexInfo: (e) => ({ ...(e.replayOf || e.designed ? {} : { reached: e.end.reached, sharp_turns: e.turns.length }), ...(e.blocked ? { blocked: true } : {}), ...(e.replayOf ? { replays: e.replayOf } : {}),
    ...(e.designed ? { designed: e.designed } : {}),
    ...(e.changes ? { changes: changesInWords(e.changes) } : {}), recorded: Object.keys(e.calcium) }),
  explored: (e, place) => ({ place, start: e.start, reached: e.end.reached, steps: e.left.length }),
  at: (e, step) => (step >= 0 && step < e.left.length ? { state: pointOf(e, step), shown: { the_signals_were: signalsAt(e, step) } } : null),
  cases: (_spec, id, e, every) => {
    if (!e.left.length) return [];
    const spread = { [e.names.signals[0]]: spreadOf(e.reorientation), [e.names.signals[1]]: spreadOf(e.steering) };
    const moves = { [e.names.signals[0]]: e.reorientation.some((v) => v !== e.reorientation[0]), [e.names.signals[1]]: e.steering.some((v) => v !== e.steering[0]) };
    return e.left.map((_, k) => k).filter((k) => k % every === 0).map((k) => ({ point: id + '@' + k, state: pointOf(e, k), came: signalsAt(e, k), spread, moves }));
  },
  ownEvery: 20,
  view: (e, from, to) => {
    const last = Math.min(to, from + VIEW_ROWS - 1, e.left.length - 1);
    const turnAt = new Map(e.turns.map(([k, a]) => [k, a]));
    const rows = [];
    for (let k = from; k <= last; k++) {
      rows.push({ step: k, t: e.t[k], ...(e.replayOf || e.designed ? {} : { x: e.x[k], y: e.y[k], heading: e.heading[k], odor: e.c[k] }), inputs: { left: e.left[k], right: e.right[k] },
        signals: [e.reorientation[k], e.steering[k]], ...(turnAt.has(k) ? { sharp_turn: turnAt.get(k) } : {}),
        calcium: Object.fromEntries(Object.entries(e.calcium).map(([c, x]) => [c, x[k]])) });
    }
    return { steps: e.left.length - 1, rows };
  },
  shown: (c) => ({ the_signals_were: c.came }),

  act: {
    parse: parseClosedAct,
    place: (act) => act.place,
    async start(spec, asked, id, ctx) {
      const naming = namingFor(spec);
      const real = realAct(naming, { stimuli: [], record: asked.record, ...(asked.changes ? { changes: asked.changes } : {}) });
      if (!real) return null;
      const changes = real.changes, record = real.record ?? [];
      if (asked.stimuli) {
        /* Open loop, designed: the current over each control step, as c302nav samples a stimulus (on at t when start < t <= end). */
        const stim = asked.stimuli.map((x) => ({ ...x, cell: naming.real(x.cell) ?? '' }));
        if (stim.some((x) => x.cell !== 'AWCL' && x.cell !== 'AWCR')) return null;
        const durationMs = asked.duration_ms ?? DESIGNED_MS;
        const n = Math.round(durationMs / CONTROL_MS);
        const traces = inputTraces(stim as Stimulus[], Array.from({ length: n }, (_, k) => (k + 1) * CONTROL_MS));
        const zeros = Array.from({ length: n }, () => 0);
        return episodeIn(spec, ctx, { field: spec.field, start: { x: 0, y: 0, heading: 0 }, seed: 0, durationMs, record, ...(changes ? { changes, learnerChanges: asked.changes } : {}),
          replay: { left: traces.AWCL ?? zeros, right: traces.AWCR ?? zeros, of: 'designed' }, designed: { learner: asked.stimuli, real: stim as Stimulus[] } });
      }
      if (asked.replay) {
        const of = ctx.episodeOf?.(asked.replay) as ClosedEpisode | undefined;
        if (!of || !of.left || of.replayOf || of.designed) return null;
        return episodeIn(spec, ctx, { field: of.field, start: of.start, seed: 0, record, ...(changes ? { changes, learnerChanges: asked.changes } : {}), replay: { left: of.left, right: of.right, of: asked.replay } });
      }
      const field: FieldSpec = { ...spec.field, ...(asked.source ? { source: [asked.source[0], asked.source[1]] as [number, number] } : {}), ...(asked.length ? { length: asked.length } : {}) };
      const seed = asked.seed ?? (parseInt(hashString(id + ':' + spec.place).slice(0, 8), 16) || 1);
      return episodeIn(spec, ctx, { field, start: asked.start ?? startFrom(mulberry32(seed), field), seed, durationMs: asked.duration_ms ?? spec.durationMs, record,
        ...(changes ? { changes, learnerChanges: asked.changes } : {}), ...(asked.blocked ? { blocked: true } : {}) });
    },
    shown: (e) => ({ steps: e.left.length - 1, ...(e.replayOf || e.designed ? { open_loop: true } : { reached: e.end.reached, sharp_turns: e.turns.length }), ...(e.replayOf ? { replays: e.replayOf } : {}), recorded: Object.keys(e.calcium) }),
    asWritten: (a) => ({ ...(a.stimuli ? { stimuli: a.stimuli } : {}), ...(a.replay ? { replay: a.replay } : {}), ...(a.start ? { start: a.start } : {}), ...(a.source ? { source: a.source } : {}), ...(a.length !== undefined ? { length: a.length } : {}),
      ...(a.duration_ms !== undefined ? { duration_ms: a.duration_ms } : {}), ...(a.seed !== undefined ? { seed: a.seed } : {}), ...(a.blocked ? { blocked: true } : {}),
      ...(a.record.length ? { record: a.record } : {}), ...(a.changes ? changesInWords(a.changes) : {}), ...(a.place ? { place: a.place } : {}) }),
    examples: (spec) => {
      const n = namingFor(spec);
      return [{ start: { x: 7, y: 0, heading: 3 } }, { start: { x: -6, y: 4, heading: -0.5 }, seed: 3, duration_ms: 3000, record: [n.cell('AIYL')], remove: [n.connection('AWCL-AIYL')] },
        { start: { x: 5, y: 5, heading: 0 }, blocked: true, duration_ms: 2000 },
        { stimuli: [{ cell: n.cell('AWCL'), delay_ms: 200, duration_ms: 1500, amplitude_pa: 3.5 }, { cell: n.cell('AWCR'), kind: 'sine', delay_ms: 0, duration_ms: 2000, amplitude_pa: 2, period_ms: 500 }], duration_ms: 3000 }];
    },
    identity: (spec, a) => {
      if (a.replay) return null;
      if (a.stimuli) {
        const naming = namingFor(spec);
        const stim = a.stimuli.map((x) => ({ ...x, cell: naming.real(x.cell) ?? '' }));
        const real = realAct(naming, { stimuli: [], record: a.record, ...(a.changes ? { changes: a.changes } : {}) });
        return real && stim.every((x) => x.cell === 'AWCL' || x.cell === 'AWCR') ? designedIdentity(stim as Stimulus[], a.duration_ms ?? DESIGNED_MS, real.changes) : null;
      }
      const real = realAct(namingFor(spec), { stimuli: [], record: a.record, ...(a.changes ? { changes: a.changes } : {}) });
      return real ? canonical({ source: a.source ?? spec.field.source, length: a.length ?? spec.field.length, start: a.start ?? null, seed: a.seed ?? null, duration_ms: a.duration_ms ?? spec.durationMs, changes: real.changes ?? null, blocked: Boolean(a.blocked) }) : null;
    }
  },
  episodeIdentity: (_spec, e) => e.identity,

  objective: (host, options) => closedObjective(host as never, options),
  answerIssue: (a) => (answerPair(a, REAL_SIGNALS) || answerPair(a, namingOf('neutral', 0).signals as unknown as SignalNames) ? null
    : 'the answer must be an object with a number for each of the two signals, by their names (it was ' + JSON.stringify(a)?.slice(0, 80) + ')'),
  agrees: (a, c) => {
    const names = Object.keys(c.came) as unknown as SignalNames;
    const p = answerPair(a, names);
    return !!p && names.every((s) => Math.abs(p[s] - c.came[s]) <= 0.1 * c.spread[s]);
  },
  agreement: 'within a tenth of the spread',
  baselines: () => [
    { name: 'nothing moves', source: '(p) => ({ reorientation: 0, steering: 0, s1: 0, s2: 0 })' },
    { name: 'the drive now', source: '(p) => { const x = Object.values(p.inputs).map((v) => v[p.step] || 0); const tot = x.reduce((a, b) => a + b, 0), d = (x[0] || 0) - (x[1] || 0); return { reorientation: tot, steering: d, s1: tot, s2: d }; }' }
  ],
  grading: { glossary: (spec) => namingFor(spec).glossary(), system: ruleGradingSystem(
    'of a simulated nervous system (c302, the panel of 28 cells of C. elegans) in closed loop with a worm in an odor field: what turns the odor drive into the two action signals (reorientation, steering), what persists between them, what moves it, and how the loop takes the worm towards the odor. The true statements are questions a mechanism should answer; a learner states one when its model or words give that answer',
    'Read its model as code and words: what its observations, rules and output compute, and what its notes and rules say of the mechanism, is what it claims. When it was given neutral names, `learner_names` says what each of its names is.') }
};

