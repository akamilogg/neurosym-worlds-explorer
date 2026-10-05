import fs from 'node:fs';
import path from 'node:path';
import { ruleGradingSystem, type Lab, type LabContext, type LabOptions } from '../../learn/lab.ts';
import { mulberry32 } from '../grid/gen.ts';
import { DURATION_MS, SAVE_EVERY_MS, protocolOf, stimuliOf, tracesOf, type Family } from './stimuli.ts';
import { C302NAV_PERCEPT_DOC, PANEL, READOUT_CELLS, SIGNALS, UNIT, c302NavPointWorld, inputTraces, perceiveC302Nav, signalsOf,
  type C302NavEpisode, type C302NavPoint, type C302NavSpec, type NetworkChanges, type Signal, type Stimulus } from './world.ts';
import { answerPair, c302NavObjective, type C302NavCase } from './objective.ts';
import { c302NavInterface } from './interface.ts';

/* ============================================================================
 * c302-navigation@1 (SPEC-EUREKA-NAVEGACION §4): EurekaBench's navigation-goals as a world of
 * our harness. Its environment is OUTSIDE the harness: the c302 service (worlds/c302), which
 * simulates OpenWorm's model of the nervous system of C. elegans. Everything the laboratory
 * learns of the world it learns by asking the service (`ctx.effects`): each simulation is
 * asked once, under a key, and its answer is logged, so a resumed run replays it.
 *
 *   the places       the laboratory draws its drive from the irregular trains ("steps"); the
 *                    family's places from the periodic, rotating ones, never seen; a blind
 *                    place from either, by turns
 *   the episodes     9 s of the panel of 28 cells under a drive into AWCL and AWCR; the two
 *                    signals read from the calcium (world.ts)
 *   the act          a simulation of the learner's own: any stimuli into the panel, any cells
 *                    recorded, connections removed, scaled or of another sign, and the model's
 *                    parameters - or the wiring among the cells
 *   the truth        none of its own: the problem's insights, read from a local copy of
 *                    EurekaBench (--eureka), are the operator's grading only
 * ========================================================================== */

export interface C302NavAct {
  readonly stimuli?: readonly Stimulus[];
  readonly record?: readonly string[];
  readonly changes?: NetworkChanges;
  readonly duration_ms?: number;
  readonly wiring?: boolean;
  readonly place?: string;
}

const MAX_STIMULI = 60;
const VIEW_ROWS = 60;
const round = (x: number): number => Number(x.toPrecision(6));

/** Asks the service (through the run's effects: logged, and done once). */
function effects(ctx: LabContext | undefined) {
  if (!ctx?.effects) throw new Error('c302-navigation@1 needs the c302 service: run it through the laboratory runner (--service <url>)');
  return ctx.effects;
}

/** One simulation of the panel: the stimuli, the cells recorded besides the readout, the changes to the network. */
async function simulate(ctx: LabContext | undefined, stimuli: readonly Stimulus[], record: readonly string[], changes: NetworkChanges, durationMs = DURATION_MS)
  : Promise<{ t: number[]; calcium: Record<string, number[]> }> {
  const cells = [...new Set([...READOUT_CELLS, ...record])];
  const r = await effects(ctx).request('/simulate', { cells: PANEL, stimuli, record: cells, parameter_set: 'C1', duration_ms: durationMs, dt_ms: 0.05,
    save_every_ms: SAVE_EVERY_MS, ...changes }) as { t?: number[]; calcium?: Record<string, number[]> };
  if (!Array.isArray(r.t) || !r.calcium || !READOUT_CELLS.every((c) => Array.isArray(r.calcium![c]))) throw new Error('the c302 service answered no calcium');
  return { t: r.t, calcium: r.calcium };
}

/** An episode from what the service answered. */
function episodeOf(sim: { t: number[]; calcium: Record<string, number[]> }, inputs: Record<string, number[]>, extra: Partial<C302NavEpisode> = {}): C302NavEpisode {
  return { t: sim.t, inputs, signals: signalsOf(sim.calcium), calcium: Object.fromEntries(Object.entries(sim.calcium).map(([c, x]) => [c, x.map((v) => round(v * UNIT))])), ...extra };
}

/** An episode of the environment: a protocol of the place's family, from a seed. */
async function drawn(spec: C302NavSpec, seed: number, ctx: LabContext | undefined): Promise<C302NavEpisode> {
  const p = protocolOf(spec.family, seed);
  const tr = tracesOf(p);
  const sim = await simulate(ctx, stimuliOf(p), [], {});
  return episodeOf(sim, { AWCL: tr.AWCL, AWCR: tr.AWCR }, { protocol: { family: p.family, seed } });
}

const seedOf = (rnd: () => number): number => Math.floor(rnd() * 2 ** 31);

/** The R² a model must reach per signal: "<reorientation>,<steering>". */
export function holdR2Of(options: LabOptions): Record<Signal, number> {
  const [r, s] = String(options['hold-r2'] ?? '').split(',').map(Number);
  return { reorientation: Number.isFinite(r) ? r : 0.5, steering: Number.isFinite(s) ? s : (Number.isFinite(r) ? r : 0.3) };
}

/** OPERATOR ONLY: the problem's insights, from the rubric of a local copy of EurekaBench (never vendored here). Each is a
    statement for the grader: what a mechanism should explain. */
export function insightsOf(eureka: string): { id: string; statement: string }[] {
  const file = [path.join(eureka, 'domains', 'neuroscience', 'navigation-goals', 'tests', 'rubric.yaml'), path.join(eureka, 'tests', 'rubric.yaml'), eureka]
    .find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
  if (!file) throw new Error('no rubric.yaml of navigation-goals under ' + eureka);
  const text = fs.readFileSync(file, 'utf8');
  const at = text.search(/^insights:/m);
  if (at < 0) return [];
  const out: { id: string; statement: string }[] = [];
  for (const m of text.slice(at).matchAll(/- id: (I\d+)\s*\n\s*criterion: (.+)\n(?:\s*kind: (\w+))?/g)) {
    out.push({ id: m[1], statement: (m[3] ? '[' + m[3] + '] ' : '') + m[2].trim() });
  }
  return out;
}

const CELL = new Set<string>(PANEL);
const CONNECTION = /^[A-Z0-9]+-[A-Z0-9]+(_GJ)?$/;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** An act's parameters, or why they cannot be read (the form only: the service may still refuse it). */
export function parseC302NavAct(raw: Record<string, unknown>): C302NavAct | string {
  const place = typeof raw.place === 'string' ? { place: raw.place } : {};
  if (raw.wiring === true) return { wiring: true, ...place };
  const stimuli: Stimulus[] = [];
  if (!Array.isArray(raw.stimuli) || raw.stimuli.length > MAX_STIMULI) return 'act needs "stimuli": a list of at most ' + MAX_STIMULI + ' stimuli (it may be empty), or "wiring": true';
  for (const s of raw.stimuli as Record<string, unknown>[]) {
    if (!s || typeof s.cell !== 'string' || !CELL.has(s.cell)) return 'a stimulus needs "cell": one of ' + PANEL.join(', ');
    if (!num(s.delay_ms) || !num(s.duration_ms) || !num(s.amplitude_pa) || s.delay_ms < 0 || s.duration_ms <= 0) return 'a stimulus needs numbers "delay_ms" (>= 0), "duration_ms" (> 0) and "amplitude_pa"';
    const kind = s.kind ?? 'pulse';
    if (kind !== 'pulse' && kind !== 'sine') return 'a stimulus is a "pulse" or a "sine"';
    if (kind === 'sine' && (!num(s.period_ms) || s.period_ms <= 0 || (s.phase_rad !== undefined && !num(s.phase_rad)))) return 'a sine needs "period_ms" > 0 (and a number "phase_rad")';
    stimuli.push({ cell: s.cell, ...(kind === 'sine' ? { kind, period_ms: s.period_ms as number, phase_rad: (s.phase_rad as number | undefined) ?? 0 } : {}),
      delay_ms: s.delay_ms, duration_ms: s.duration_ms, amplitude_pa: s.amplitude_pa });
  }
  const record = raw.record === undefined ? [] : raw.record;
  if (!Array.isArray(record) || !record.every((c) => typeof c === 'string' && CELL.has(c))) return '"record" is a list of cells: ' + PANEL.join(', ');
  const changes: Record<string, unknown> = {};
  if (raw.remove !== undefined) {
    if (!Array.isArray(raw.remove) || !raw.remove.every((c) => typeof c === 'string' && CONNECTION.test(c))) return '"remove" is a list of connections "<pre>-<post>" or "<pre>-<post>_GJ"';
    changes.remove_connections = raw.remove;
  }
  if (raw.scale !== undefined) {
    const e = raw.scale && typeof raw.scale === 'object' ? Object.entries(raw.scale as Record<string, unknown>) : null;
    if (!e || !e.every(([k, v]) => CONNECTION.test(k) && num(v) && v >= 0)) return '"scale" maps connections to factors >= 0';
    changes.connection_number_scaling = Object.fromEntries(e);
  }
  if (raw.polarity !== undefined) {
    const e = raw.polarity && typeof raw.polarity === 'object' ? Object.entries(raw.polarity as Record<string, unknown>) : null;
    if (!e || !e.every(([k, v]) => CONNECTION.test(k) && (v === 'exc' || v === 'inh'))) return '"polarity" maps chemical connections to "exc" or "inh"';
    changes.connection_polarity_override = Object.fromEntries(e);
  }
  if (raw.parameters !== undefined) {
    const e = raw.parameters && typeof raw.parameters === 'object' ? Object.entries(raw.parameters as Record<string, unknown>) : null;
    if (!e || !e.every(([, v]) => typeof v === 'string')) return '"parameters" maps names to values with their unit, as strings (e.g. "5ms")';
    changes.param_overrides = Object.fromEntries(e);
  }
  if (raw.duration_ms !== undefined && (!num(raw.duration_ms) || raw.duration_ms <= 0 || raw.duration_ms > DURATION_MS)) return '"duration_ms" is at most ' + DURATION_MS;
  return { stimuli, record: record as string[], ...(Object.keys(changes).length ? { changes: changes as NetworkChanges } : {}),
    ...(num(raw.duration_ms) ? { duration_ms: raw.duration_ms } : {}), ...place };
}

/** The spread of a signal over an episode (its standard deviation; 1 when it does not move). */
const spreadOf = (x: readonly number[]): number => {
  const m = x.reduce((s, v) => s + v, 0) / x.length;
  const sd = Math.sqrt(x.reduce((s, v) => s + (v - m) ** 2, 0) / x.length);
  return sd > 0 ? sd : 1;
};

const pointAt = (e: C302NavEpisode, step: number): C302NavPoint => ({ step, t: e.t.slice(0, step + 1),
  inputs: Object.fromEntries(Object.entries(e.inputs).map(([c, x]) => [c, x.slice(0, step + 1)])) });
const signalsAt = (e: C302NavEpisode, step: number): Record<Signal, number> => ({ reorientation: e.signals.reorientation[step], steering: e.signals.steering[step] });

export const c302NavLab: Lab<C302NavSpec, C302NavPoint, C302NavEpisode, C302NavCase, C302NavAct> = {
  id: 'c302-navigation@1',
  about: 'System 2 perceives the current injected into the cells of a simulated nervous system (the panel of 28 cells of c302, OpenWorm\'s model of C. elegans) and two signals read from their calcium, step by step over 9 s, '
    + 'and must write a model that answers both signals from the drive alone. It may simulate episodes of its own: any stimuli, any cells recorded, connections removed, scaled or of another sign, the model\'s parameters, or ask for the wiring. '
    + 'The environment is the c302 service (scripts/c302-service.ts) outside the harness; EurekaBench\'s navigation-goals (SPEC-EUREKA-NAVEGACION).',
  options: [
    { name: 'service', default: 'http://127.0.0.1:18600', help: 'where the c302 service is (start it with scripts/c302-service.ts)' },
    { name: 'acts', default: '2', help: 'simulations System 2 may ask for itself per round' },
    { name: 'hold-r2', default: '0.5,0.3', help: 'the R² a model must reach in a place, per signal: "<reorientation>,<steering>"' },
    { name: 'eureka', default: '', help: 'OPERATOR ONLY: a local copy of EurekaBench, whose rubric gives the insights the learner is graded against' }
  ],
  defaults: { every: '20', explore: '3', 'check-episodes': '2', family: '2', 'confirm-places': '1' },
  /* A simulation takes minutes, and may wait for others in the service's queue. */
  external: { url: (o) => o.service, timeoutMs: 40 * 60_000 },

  generate: (seed) => ({ seed, place: 'steps', family: 'steps' }),
  /* The family's places draw from the drive never seen; the blind ones from either, by turns. */
  placeOf: (spec, index) => {
    const family: Family = index >= 1000 ? (index % 2 ? 'rotating' : 'steps') : 'rotating';
    return { seed: spec.seed * 1009 + index, place: family + '-' + index, family };
  },
  runName: (seed) => 'c302nav-s' + seed,
  headline: (spec) => '(c302, panel of 28 cells, drive ' + spec.family + ')',
  placeInfo: (spec) => ({ family: spec.family, seed: spec.seed }),
  truth: (_spec, options) => (options.eureka ? insightsOf(options.eureka) : []),
  explorationSeed: (seed) => seed * 1013 + 17,

  world: c302NavPointWorld,
  perceive: perceiveC302Nav,
  perceptDoc: C302NAV_PERCEPT_DOC,
  interface: c302NavInterface,

  episode: (spec, rnd, ctx) => drawn(spec, seedOf(rnd), ctx),
  /* Simulations take minutes: those drawn together are asked together (their keys in the order they were drawn). */
  explore: async (laboratories, rnd, count, ctx) => {
    const seeds = Array.from({ length: count }, () => seedOf(rnd));
    const lab = laboratories[0];
    return (await Promise.all(seeds.map((s) => drawn(lab.spec, s, ctx)))).map((episode) => ({ place: lab.id, episode }));
  },
  checkEpisodes: (spec, c, ctx) => {
    const rnd = mulberry32(ctx.seed * 7717 + c.round * 101 + c.index * 7 + (c.purpose === 'validation' ? 5000 : c.purpose === 'blind' ? 100000 * (1 + (c.set ?? 0)) : 0));
    const seeds = Array.from({ length: ctx.checkEpisodes }, () => seedOf(rnd));
    return Promise.all(seeds.map((s) => drawn(spec, s, ctx)));
  },
  steps: (e) => Math.max(0, e.t.length - 1),
  indexInfo: (e) => (e.wiring ? { wiring: true } : { stimulated: Object.keys(e.inputs), recorded: Object.keys(e.calcium), ...(e.changes ? { changes: e.changes } : {}) }),
  explored: (e, place) => ({ place, protocol: e.protocol, steps: e.t.length - 1 }),
  at: (e, step) => (step >= 0 && step < e.t.length ? { state: pointAt(e, step), shown: { the_signals_were: signalsAt(e, step) } } : null),
  cases: (_spec, id, e, every) => {
    if (!e.t.length) return [];
    const spread = { reorientation: spreadOf(e.signals.reorientation), steering: spreadOf(e.signals.steering) };
    return e.t.map((_, k) => k).filter((k) => k % every === 0).map((k) => ({ point: id + '@' + k, state: pointAt(e, k), came: signalsAt(e, k), spread }));
  },
  ownEvery: 20,
  trial: { points: (e) => (e.t.length ? [0, 200, 900, e.t.length - 1].filter((k) => k < e.t.length).map((k) => pointAt(e, k)) : []), answers: 4 },
  view: (e, from, to) => {
    if (e.wiring) return { wiring: e.wiring };
    const last = Math.min(to, from + VIEW_ROWS - 1, e.t.length - 1);
    const rows = [];
    for (let k = from; k <= last; k++) {
      rows.push({ step: k, t: e.t[k], inputs: Object.fromEntries(Object.entries(e.inputs).map(([c, x]) => [c, x[k]])),
        ...signalsAt(e, k), calcium: Object.fromEntries(Object.entries(e.calcium).map(([c, x]) => [c, x[k]])) });
    }
    return { steps: e.t.length - 1, rows };
  },
  shown: (c) => ({ the_signals_were: c.came }),

  act: {
    parse: parseC302NavAct,
    place: (act) => act.place,
    async start(_spec, act, _id, ctx) {
      try {
        if (act.wiring) {
          const w = await effects(ctx).request('/wiring', { cells: PANEL }) as { connections?: unknown };
          return Array.isArray(w.connections) ? { t: [], inputs: {}, signals: { reorientation: [], steering: [] }, calcium: {}, wiring: w.connections } : null;
        }
        const duration = act.duration_ms ?? DURATION_MS;
        const sim = await simulate(ctx, act.stimuli ?? [], act.record ?? [], act.changes ?? {}, duration);
        return episodeOf(sim, inputTraces(act.stimuli ?? [], sim.t), act.changes ? { changes: act.changes } : {});
      } catch (e) {
        /* The service refused it (a request it cannot simulate): the learner is told only that it was refused. */
        if ((e as { details?: { status?: number } })?.details?.status === 400) return null;
        throw e;
      }
    },
    shown: (e) => (e.wiring ? { wiring: e.wiring } : { steps: e.t.length - 1, stimulated: Object.keys(e.inputs), recorded: Object.keys(e.calcium) })
  },

  objective: (host, options) => c302NavObjective({ casesIn: host.casesIn, answer: (m, s) => host.answer(m, s), holdR2: holdR2Of(options), regression: host.regression }),
  answerIssue: (a) => (answerPair(a) ? null : 'the answer must be {"reorientation": <number>, "steering": <number>} (it was ' + JSON.stringify(a)?.slice(0, 80) + ')'),
  /* The Judge ablation's agreement: both signals within a tenth of their spread over the episode. */
  agrees: (a, c) => { const p = answerPair(a); return !!p && SIGNALS.every((s) => Math.abs(p[s] - c.came[s]) <= 0.1 * c.spread[s]); },
  agreement: 'within a tenth of the spread',
  baselines: () => [
    { name: 'nothing moves', source: '(p) => ({ reorientation: 0, steering: 0 })' },
    { name: 'the drive now', source: '(p) => { const l = (p.inputs.AWCL || [])[p.step] || 0, r = (p.inputs.AWCR || [])[p.step] || 0; return { reorientation: l + r, steering: l - r }; }' }
  ],
  grading: { system: ruleGradingSystem(
    'of a simulated nervous system (c302, the panel of 28 cells of C. elegans) driven through its two odor-sensing cells: what turns the drive into the two action signals (reorientation, steering), what persists between them and what moves it. The true statements are questions a mechanism should answer; a learner states one when its model or words give that answer',
    'Read its model as code and words: what its observations, rules and output compute, and what its notes and rules say of the mechanism, is what it claims.') }
};
