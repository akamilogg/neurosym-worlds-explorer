import fs from 'node:fs';
import path from 'node:path';
import { ruleGradingSystem, type Lab, type LabContext, type LabOptions } from '../../learn/lab.ts';
import { mulberry32 } from '../grid/gen.ts';
import { DURATION_MS, SAVE_EVERY_MS, protocolOf, stimuliOf, tracesOf, type Family } from './stimuli.ts';
import { C302NAV_PERCEPT_DOC, NEUTRAL_CELLS, PANEL, READOUT_CELLS, UNIT, c302NavPointWorld, inputTraces, namingOf, perceiveC302Nav, signalsOf,
  type C302NavEpisode, type C302NavPoint, type C302NavSpec, type NamesMode, type Naming, type NetworkChanges, type Stimulus } from './world.ts';
import { REAL_SIGNALS, answerPair, c302NavObjective, type C302NavCase, type SignalNames } from './objective.ts';
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
 *   the names        real, or neutral (--names neutral, N3): then the learner never sees a real
 *                    name of a cell, connection, transmitter or signal (world.ts, `namingOf`); the
 *                    laboratory translates at its border, the service keeps the real ones
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

/** One simulation of the panel, in the real names: the stimuli, the cells recorded besides the readout, the changes. */
async function simulate(ctx: LabContext | undefined, stimuli: readonly Stimulus[], record: readonly string[], changes: NetworkChanges, durationMs = DURATION_MS)
  : Promise<{ t: number[]; calcium: Record<string, number[]> }> {
  const cells = [...new Set([...READOUT_CELLS, ...record])];
  const r = await effects(ctx).request('/simulate', { cells: PANEL, stimuli, record: cells, parameter_set: 'C1', duration_ms: durationMs, dt_ms: 0.05,
    save_every_ms: SAVE_EVERY_MS, ...changes }) as { t?: number[]; calcium?: Record<string, number[]> };
  if (!Array.isArray(r.t) || !r.calcium || !READOUT_CELLS.every((c) => Array.isArray(r.calcium![c]))) throw new Error('the c302 service answered no calcium');
  return { t: r.t, calcium: r.calcium };
}

const namesOf = (options: LabOptions | undefined): NamesMode => (options?.names === 'neutral' ? 'neutral' : 'real');
const namings = new Map<string, Naming>();
/** The names the learner is told in a run (its spec's). */
export function namingFor(spec: C302NavSpec): Naming {
  const key = spec.names + ':' + spec.namesSeed;
  if (!namings.has(key)) namings.set(key, namingOf(spec.names, spec.namesSeed));
  return namings.get(key)!;
}

/** An episode from what the service answered, in the learner's names. */
function episodeOf(naming: Naming, sim: { t: number[]; calcium: Record<string, number[]> }, inputs: Record<string, number[]>, extra: Partial<C302NavEpisode> = {}): C302NavEpisode {
  const s = signalsOf(sim.calcium);
  return { t: sim.t, inputs: Object.fromEntries(Object.entries(inputs).map(([c, x]) => [naming.cell(c), x])),
    signals: { [naming.signals[0]]: s.reorientation, [naming.signals[1]]: s.steering },
    calcium: Object.fromEntries(Object.entries(sim.calcium).map(([c, x]) => [naming.cell(c), x.map((v) => round(v * UNIT))])), ...extra };
}

/** An episode of the environment: a protocol of the place's family, from a seed. */
async function drawn(spec: C302NavSpec, seed: number, ctx: LabContext | undefined): Promise<C302NavEpisode> {
  const p = protocolOf(spec.family, seed);
  const tr = tracesOf(p);
  const sim = await simulate(ctx, stimuliOf(p), [], {});
  return episodeOf(namingFor(spec), sim, { AWCL: tr.AWCL, AWCR: tr.AWCR }, { protocol: { family: p.family, seed } });
}

/** An act in the learner's names, in the real ones; null when it names something this run does not have. */
function realAct(naming: Naming, act: C302NavAct): C302NavAct | null {
  const stimuli = (act.stimuli ?? []).map((x) => ({ ...x, cell: naming.real(x.cell) }));
  const record = (act.record ?? []).map((c) => naming.real(c));
  const ch = act.changes ?? {};
  const keyed = (o: Readonly<Record<string, unknown>> | undefined) => Object.entries(o ?? {}).map(([k, v]) => [naming.realConnection(k), v] as const);
  const remove = (ch.remove_connections ?? []).map((c) => naming.realConnection(c));
  const scale = keyed(ch.connection_number_scaling), polarity = keyed(ch.connection_polarity_override);
  if (stimuli.some((x) => !x.cell) || record.some((c) => !c) || remove.some((c) => !c) || [...scale, ...polarity].some(([k]) => !k)) return null;
  const changes = {
    ...(ch.remove_connections ? { remove_connections: remove as string[] } : {}),
    ...(ch.connection_number_scaling ? { connection_number_scaling: Object.fromEntries(scale) as Record<string, number> } : {}),
    ...(ch.connection_polarity_override ? { connection_polarity_override: Object.fromEntries(polarity) as Record<string, string> } : {}),
    ...(ch.param_overrides ? { param_overrides: ch.param_overrides } : {})
  };
  return { ...act, stimuli: stimuli as Stimulus[], record: record as string[], ...(act.changes ? { changes } : {}) };
}

const seedOf = (rnd: () => number): number => Math.floor(rnd() * 2 ** 31);

/** The R² a model must reach per signal: "<reorientation>,<steering>". */
export function holdR2Of(options: LabOptions): [number, number] {
  const [r, s] = String(options['hold-r2'] ?? '').split(',').map((x) => (x.trim() === '' ? NaN : Number(x)));
  return [Number.isFinite(r) ? r : 0.5, Number.isFinite(s) ? s : (Number.isFinite(r) ? r : 0.3)];
}

/** OPERATOR ONLY: the problem's insights, from the rubric of a local copy of EurekaBench (never vendored here). Each is a
    statement for the grader: what a mechanism should explain. */
export function insightsOf(eureka: string): { id: string; statement: string }[] {
  const file = [path.join(eureka, 'domains', 'neuroscience', 'navigation-goals', 'tests', 'rubric.yaml'), path.join(eureka, 'tests', 'rubric.yaml'), eureka]
    .find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
  if (!file) throw new Error('no rubric.yaml of navigation-goals under ' + eureka);
  /* Its lines as they come, whatever their ending (a Windows checkout ends them with CR LF, and `.` never matches a CR). */
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
  const at = text.search(/^insights:/m);
  if (at < 0) return [];
  const out: { id: string; statement: string }[] = [];
  for (const m of text.slice(at).matchAll(/- id: (I\d+)\s*\n\s*criterion: (.+)\n(?:\s*kind: (\w+))?/g)) {
    out.push({ id: m[1], statement: (m[3] ? '[' + m[3] + '] ' : '') + m[2].trim() });
  }
  return out;
}

/* A cell by either naming: whether this run has it is for the act's start to say (it refuses, never saying why). */
const CELL = new Set<string>([...PANEL, ...NEUTRAL_CELLS]);
const CONNECTION = /^[A-Z0-9]+-[A-Z0-9]+(_GJ)?$/;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** An act's parameters, or why they cannot be read (the form only: the service may still refuse it). */
export function parseC302NavAct(raw: Record<string, unknown>): C302NavAct | string {
  const place = typeof raw.place === 'string' ? { place: raw.place } : {};
  if (raw.wiring === true) return { wiring: true, ...place };
  const stimuli: Stimulus[] = [];
  if (!Array.isArray(raw.stimuli) || raw.stimuli.length > MAX_STIMULI) return 'act needs "stimuli": a list of at most ' + MAX_STIMULI + ' stimuli (it may be empty), or "wiring": true';
  for (const s of raw.stimuli as Record<string, unknown>[]) {
    if (!s || typeof s.cell !== 'string' || !CELL.has(s.cell)) return 'a stimulus needs "cell": one of the cells';
    if (!num(s.delay_ms) || !num(s.duration_ms) || !num(s.amplitude_pa) || s.delay_ms < 0 || s.duration_ms <= 0) return 'a stimulus needs numbers "delay_ms" (>= 0), "duration_ms" (> 0) and "amplitude_pa"';
    const kind = s.kind ?? 'pulse';
    if (kind !== 'pulse' && kind !== 'sine') return 'a stimulus is a "pulse" or a "sine"';
    if (kind === 'sine' && (!num(s.period_ms) || s.period_ms <= 0 || (s.phase_rad !== undefined && !num(s.phase_rad)))) return 'a sine needs "period_ms" > 0 (and a number "phase_rad")';
    stimuli.push({ cell: s.cell, ...(kind === 'sine' ? { kind, period_ms: s.period_ms as number, phase_rad: (s.phase_rad as number | undefined) ?? 0 } : {}),
      delay_ms: s.delay_ms, duration_ms: s.duration_ms, amplitude_pa: s.amplitude_pa });
  }
  const record = raw.record === undefined ? [] : raw.record;
  if (!Array.isArray(record) || !record.every((c) => typeof c === 'string' && CELL.has(c))) return '"record" is a list of cells';
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
const signalsAt = (e: C302NavEpisode, step: number): Record<string, number> => Object.fromEntries(Object.entries(e.signals).map(([s, x]) => [s, x[step]]));

export const c302NavLab: Lab<C302NavSpec, C302NavPoint, C302NavEpisode, C302NavCase, C302NavAct> = {
  id: 'c302-navigation@1',
  about: 'System 2 perceives the current injected into the cells of a simulated nervous system (the panel of 28 cells of c302, OpenWorm\'s model of C. elegans) and two signals read from their calcium, step by step over 9 s, '
    + 'and must write a model that answers both signals from the drive alone. It may simulate episodes of its own: any stimuli, any cells recorded, connections removed, scaled or of another sign, the model\'s parameters, or ask for the wiring. '
    + 'With --names neutral it never sees a real name. The environment is the c302 service (scripts/c302-service.ts) outside the harness; EurekaBench\'s navigation-goals (SPEC-EUREKA-NAVEGACION).',
  options: [
    { name: 'service', default: 'http://127.0.0.1:18600', help: 'where the c302 service is (start it with scripts/c302-service.ts)' },
    { name: 'acts', default: '2', help: 'simulations System 2 may ask for itself per round' },
    { name: 'hold-r2', default: '0.5,0.3', help: 'the R² a model must reach in a place, per signal: "<reorientation>,<steering>"' },
    { name: 'names', default: 'real', help: 'how cells, connections, transmitters and signals are named to the learner: "real", or "neutral" (drawn from the seed; no real name is ever shown)' },
    { name: 'eureka', default: '', help: 'OPERATOR ONLY: a local copy of EurekaBench, whose rubric gives the insights the learner is graded against' }
  ],
  defaults: { every: '20', explore: '3', 'check-episodes': '2', family: '2', 'confirm-places': '1' },
  /* A simulation takes minutes, and may wait for others in the service's queue. */
  external: { url: (o) => o.service, timeoutMs: 40 * 60_000 },

  generate: (seed, options) => ({ seed, place: 'steps', family: 'steps', names: namesOf(options), namesSeed: seed }),
  /* The family's places draw from the drive never seen; the blind ones from either, by turns. The names stay the run's. */
  placeOf: (spec, index) => {
    const family: Family = index >= 1000 ? (index % 2 ? 'rotating' : 'steps') : 'rotating';
    return { ...spec, seed: spec.seed * 1009 + index, place: family + '-' + index, family };
  },
  runName: (seed, options) => 'c302nav-s' + seed + (namesOf(options) === 'neutral' ? '-neutral' : ''),
  headline: (spec) => '(c302, panel of 28 cells, drive ' + spec.family + ', ' + spec.names + ' names)',
  placeInfo: (spec) => ({ family: spec.family, seed: spec.seed }),
  truth: (_spec, options) => (options.eureka ? insightsOf(options.eureka) : []),
  explorationSeed: (seed) => seed * 1013 + 17,

  world: c302NavPointWorld,
  perceive: perceiveC302Nav,
  perceptDoc: C302NAV_PERCEPT_DOC,
  interface: (o) => c302NavInterface({ regression: o.regression, names: namesOf(o.world) }),

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
    const spread = Object.fromEntries(Object.entries(e.signals).map(([s, x]) => [s, spreadOf(x)]));
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
    async start(spec, asked, _id, ctx) {
      const naming = namingFor(spec);
      try {
        if (asked.wiring) {
          const w = await effects(ctx).request('/wiring', { cells: PANEL }) as { connections?: { name: string; pre: string; post: string; kind: string; neurotransmitter: string | null; number: number }[] };
          if (!Array.isArray(w.connections)) return null;
          const wiring = w.connections.map((c) => ({ name: naming.connection(c.name), pre: naming.cell(c.pre), post: naming.cell(c.post), kind: c.kind,
            transmitter: c.neurotransmitter === null ? null : naming.transmitter(c.neurotransmitter), number: c.number }));
          /* With neutral names, in the order of the names (c302's order would tell the real ones apart). */
          if (naming.mode === 'neutral') wiring.sort((a, b) => a.name.localeCompare(b.name));
          return { t: [], inputs: {}, signals: Object.fromEntries(naming.signals.map((s) => [s, []])), calcium: {}, wiring };
        }
        /* In the real names, for the service; refused when it names what this run does not have. */
        const act = realAct(naming, asked);
        if (!act) return null;
        const sim = await simulate(ctx, act.stimuli ?? [], act.record ?? [], act.changes ?? {}, act.duration_ms ?? DURATION_MS);
        return episodeOf(naming, sim, inputTraces(act.stimuli ?? [], sim.t), asked.changes ? { changes: asked.changes } : {});
      } catch (e) {
        /* The service refused it (a request it cannot simulate): the learner is told only that it was refused. */
        if ((e as { details?: { status?: number } })?.details?.status === 400) return null;
        throw e;
      }
    },
    shown: (e) => (e.wiring ? { wiring: e.wiring } : { steps: e.t.length - 1, stimulated: Object.keys(e.inputs), recorded: Object.keys(e.calcium) })
  },

  objective: (host, options) => c302NavObjective({ casesIn: host.casesIn, answer: (m, s) => host.answer(m, s), holdR2: holdR2Of(options),
    signals: namingOf(namesOf(options), 0).signals, regression: host.regression }),
  /* Of the form in either naming: which names count is the run's objective's. */
  answerIssue: (a) => (answerPair(a, REAL_SIGNALS) || answerPair(a, namingOf('neutral', 0).signals) ? null
    : 'the answer must be an object with a number for each of the two signals, by their names (it was ' + JSON.stringify(a)?.slice(0, 80) + ')'),
  /* The Judge ablation's agreement: both signals within a tenth of their spread over the episode. */
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
    'of a simulated nervous system (c302, the panel of 28 cells of C. elegans) driven through its two odor-sensing cells: what turns the drive into the two action signals (reorientation, steering), what persists between them and what moves it. The true statements are questions a mechanism should answer; a learner states one when its model or words give that answer',
    'Read its model as code and words: what its observations, rules and output compute, and what its notes and rules say of the mechanism, is what it claims. When it was given neutral names, `learner_names` says what each of its names is.') }
};
