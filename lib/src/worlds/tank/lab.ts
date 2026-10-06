import { ruleGradingSystem, unknownFields, type Lab, type LabContext } from '../../learn/lab.ts';
import { TANK_PERCEPT_DOC, perceiveTank, tankPointWorld, type TankEpisode, type TankPoint, type TankSpec } from './world.ts';
import { offBy, tankObjective, type TankCase } from './objective.ts';
import { tankInterface } from './interface.ts';
import { TANK_TRUTH } from './service.ts';

/* ============================================================================
 * tank@1 as a LABORATORY whose environment is OUTSIDE the harness (SPEC-OBJETIVO O12): a
 * service in a process of its own (service.ts, scripts/tank-service.ts) that keeps state and
 * acts. Everything the laboratory learns of the world it learns by asking the service
 * (`ctx.effects`): each request carries a key that makes it happen once, and what the
 * service answered is logged like System 2's answers - so a run that is stopped and resumed
 * replays the service's answers instead of acting again, and a step the service took just
 * before the run stopped is not taken twice. The laboratory never computes the rule.
 * ========================================================================== */

/** An act: the inputs to give, in order, from a start the learner may choose. */
export interface TankAct { readonly inputs: readonly number[]; readonly start?: number; readonly place?: string }

const STEPS = 12;

/** Asks the service (through the run's effects: logged, and done once). */
function effects(ctx: LabContext | undefined) {
  if (!ctx?.effects) throw new Error('tank@1 needs its service: run it through the laboratory runner (--service <url>)');
  return ctx.effects;
}

/** A whole episode, run by the service: a new tank in the place, then each input. Null if the service refused it. */
async function runEpisode(spec: TankSpec, ctx: LabContext | undefined, inputs: readonly number[], start?: number): Promise<TankEpisode | null> {
  const e = effects(ctx);
  const opened = await e.request('/episode', { place: spec.place, ...(start !== undefined ? { start } : {}) }) as { episode?: string; level?: number; refused?: boolean };
  if (opened.refused || typeof opened.episode !== 'string' || typeof opened.level !== 'number') return null;
  const rows: { input: number | null; value: number }[] = [{ input: null, value: opened.level }];
  for (const input of inputs) {
    /* The service's words: an inflow into a tank, and its level. */
    const r = await e.request('/step', { episode: opened.episode, inflow: input }) as { level?: number; refused?: boolean };
    if (r.refused || typeof r.level !== 'number') return null;
    rows.push({ input, value: r.level });
  }
  return { rows };
}

/** The environment's inputs for an episode: drawn from its own seed. */
const inputsFrom = (rnd: () => number): number[] => Array.from({ length: STEPS }, () => Math.floor(rnd() * 10));

export const tankLab: Lab<TankSpec, TankPoint, TankEpisode, TankCase, TankAct> = {
  id: 'tank@1',
  about: 'System 2 perceives a value step by step, and the input given at each step, and must write a model that answers the next value (the service behind it is a tank: an inflow and its level). '
    + 'The environment is a service outside the harness (scripts/tank-service.ts) that keeps state and acts; a run stopped and resumed never makes it act twice.',
  options: [
    { name: 'service', default: 'http://127.0.0.1:18300', help: 'where the service is (start it with scripts/tank-service.ts)' },
    { name: 'acts', default: '3', help: 'episodes System 2 may start itself per round' }
  ],
  defaults: { every: '1' },
  external: { url: (o) => o.service },

  generate: (seed) => ({ seed, place: 'p0', steps: STEPS }),
  placeOf: (spec, index) => ({ ...spec, place: 'p' + index }),
  /* A team shares the one service: its members' episodes are drawn in the order they ask for them. */
  teams: true,
  runName: (seed) => 'tank-s' + seed,
  headline: (spec) => '(the service\'s place ' + spec.place + ')',
  placeInfo: (spec) => ({ place: spec.place }),
  truth: () => TANK_TRUTH,
  explorationSeed: (seed) => seed * 1013 + 11,

  world: tankPointWorld,
  perceive: perceiveTank,
  perceptDoc: TANK_PERCEPT_DOC,
  interface: tankInterface,

  episode: async (spec, rnd, ctx) => {
    const e = await runEpisode(spec, ctx, inputsFrom(rnd));
    if (!e) throw new Error('the service refused an episode of the environment');
    return e;
  },
  steps: (e) => e.rows.length - 1,
  explored: (e) => ({ rows: e.rows }),
  at: (e, step) => (step >= 0 && step + 1 < e.rows.length
    ? { state: { rows: e.rows.slice(0, step + 1), next_input: e.rows[step + 1].input! }, shown: { the_next_value_was: e.rows[step + 1].value } } : null),
  cases: (_spec, id, e, every) => Array.from({ length: e.rows.length - 1 }, (_, t) => t).filter((t) => t % every === 0)
    .map((t) => ({ point: id + '@' + t, state: { rows: e.rows.slice(0, t + 1), next_input: e.rows[t + 1].input! }, next: e.rows[t + 1].value })),
  ownEvery: 1,
  view: (e, from, to) => ({ steps: e.rows.length - 1, rows: e.rows.slice(from, to + 1).map((r, i) => ({ step: from + i, ...r })) }),
  shown: (c) => ({ the_next_value_was: c.next }),

  act: {
    parse: (raw) => {
      const unknown = unknownFields(raw, ['inputs', 'start', 'place']);
      if (unknown) return unknown;
      const inputs = Array.isArray(raw.inputs) ? raw.inputs : null;
      if (!inputs || !inputs.length || inputs.length > STEPS || !inputs.every((x) => typeof x === 'number')) return 'act needs "inputs": a list of 1 to ' + STEPS + ' numbers';
      return { inputs: inputs as number[], ...(typeof raw.start === 'number' ? { start: raw.start } : {}), ...(typeof raw.place === 'string' ? { place: raw.place } : {}) };
    },
    place: (act) => act.place,
    /* The service answers only whether it accepted: never why not. */
    start: (spec, act, _id, ctx) => runEpisode(spec, ctx, act.inputs, act.start),
    shown: (e) => ({ rows: e.rows }),
    examples: () => [{ inputs: [1, 2, 3] }, { inputs: [9, 9], start: 50 }],
    /* Its interface says so: without "start", the environment chooses where the tank starts. */
    varies: (act) => (act.start === undefined ? 'the level it starts at' : null)
  },

  objective: (host) => tankObjective(host),
  answerIssue: (a) => (typeof a === 'number' && Number.isFinite(a) ? null : 'the answer must be a number (it was ' + JSON.stringify(a)?.slice(0, 60) + ')'),
  agrees: (a, c) => offBy(a, c.next) === 0,
  agreement: 'exact',
  baselines: () => [
    { name: 'the same value again', source: '(p) => p.rows[p.rows.length - 1].value' },
    { name: 'the value plus the input', source: '(p) => p.rows[p.rows.length - 1].value + p.next_input' }
  ],
  grading: { system: ruleGradingSystem(
    'of an environment it could only perceive as a value and the input given at each step (the service behind it is a tank: the input is an inflow, the value its level)',
    'Read its model as code: what its observations, rules and output compute is what it claims.') }
};
