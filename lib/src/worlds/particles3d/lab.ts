import { hashString } from '../../core/hash.ts';
import type { Law } from '../../core/predict.ts';
import { GRADING_STRUCTURE } from '../../learn/operator.ts';
import type { Lab, LabContext, LabOptions } from '../../learn/lab.ts';
import { mulberry32 } from '../grid/gen.ts';
import { describeSceneTruth, fromPercept, generateScene, insideReach, placeScene, randomStarts, serviceScene, tooClose, velocityFromPercept, type Condition, type SceneSpec, type Start, type Vec3 } from './scene.ts';
import { P3_PERCEPT_DOC, observedNoiseVariance, p3PointWorld, perceiveEpisode, perceiveP3, pointAt, tableText, type P3Episode, type P3Point } from './world.ts';
import { HORIZONS, appendRow, p3Objective, readAnswer, type P3Case } from './objective.ts';
import { p3Interface, parseP3Act, type P3Act } from './interface.ts';

/* ============================================================================
 * particles3d@1 as a LABORATORY (SPEC-MUNDO-3D): particles in 3D under force fields, simulated
 * by BLENDER - an environment outside the harness (lib/blender/particles_service.py, started
 * with scripts/particles3d-service.ts). System 2 perceives tables of positions and must write
 * a LAW that answers the next row; the check asks it along horizons, from its own answers.
 *
 * Every episode is a request to the service, through the run's effects: logged like System
 * 2's answers, so a resumed run is answered what the first one was. The harness never
 * computes the world: what Blender answered is the world (M2). System 2 is never told that
 * the world is Blender, nor what the columns are (M1).
 *
 * Operator only: the world's own predictability at each check episode (the start perturbed,
 * Blender asked again), the scene as the truth the grader reads, and the words of a known
 * engine or of textbook physics in the learner's laws (how it uses what it already knows).
 * ========================================================================== */

const sig = (n: number) => Number(n.toPrecision(6));
const optionsOf = (o: LabOptions) => ({ noise: Math.max(0, Number(o.noise) || 0) });

function effects(ctx: LabContext | undefined) {
  if (!ctx?.effects) throw new Error('particles3d@1 needs its Blender service: start it (scripts/particles3d-service.ts) and run through the laboratory runner (--service <url>)');
  return ctx.effects;
}

/** What Blender did with a scene: the position of every particle at every frame (Blender's coordinates). */
async function simulateIn(spec: SceneSpec, starts: readonly Start[], ctx: LabContext | undefined): Promise<(number[] | null)[][]> {
  const r = await effects(ctx).request('/simulate', { scene: serviceScene(spec, starts), frames: spec.frames, bound: 100 * spec.region }) as { rows?: (number[] | null)[][]; error?: string };
  /* A particle the engine threw to infinity shows as gone (null) from then on. */
  if (!Array.isArray(r.rows)) throw new Error('the Blender service did not simulate: ' + (r.error ?? JSON.stringify(r).slice(0, 120)));
  return r.rows;
}

/** OPERATOR ONLY: the world's own predictability from these starts - the first frame at which the same scene, from the
    starts perturbed about as much as perception blurs them, is more than 2 % of the box away (§5.2). */
async function predictability(spec: SceneSpec, starts: readonly Start[], rows: readonly (readonly (number[] | null)[])[], noise: number, rnd: () => number, ctx: LabContext | undefined): Promise<number> {
  const delta = Math.max(noise, 1e-4) * spec.region;
  const moved = starts.map((s) => {
    const u = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5], n = Math.hypot(...u) || 1;
    return { ...s, location: s.location.map((v, a) => v + (delta * u[a]) / n) as Vec3 };
  });
  const other = await simulateIn(spec, moved, ctx);
  for (let f = 0; f < rows.length; f++) {
    /* Apart: more than 2 % of the box between the two, or one of them gone and not the other. */
    const apart = rows[f].some((p, j) => { const q = other[f]?.[j] ?? null; return (p === null) !== (q === null) || (!!p && !!q && Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) > 0.02 * spec.region); });
    if (apart) return f;
  }
  return rows.length;
}

/** An episode from the environment's starts (drawn from `rnd`), perceived. */
async function environmentEpisode(spec: SceneSpec, rnd: () => number, ctx: LabContext | undefined, withHorizon: boolean): Promise<P3Episode> {
  const starts = randomStarts(spec, rnd);
  const rows = await simulateIn(spec, starts, ctx);
  const noise = optionsOf(ctx?.options ?? {}).noise;
  const e = perceiveEpisode(spec, starts, rows, noise, rnd, 'the environment');
  return withHorizon ? { ...e, horizon: await predictability(spec, starts, rows, noise, rnd, ctx) } : e;
}

/** The words of a known engine, and of textbook physics, in a text (operator only: how the learner uses what it knows). */
const ENGINE_WORDS = /\b(blender|bullet|effector|force[ _-]?field|particle[ _-]?system|point[ _-]?cache|rk4|runge|midpoint|verlet|subframe|timestep)\b/gi;
const PHYSICS_WORDS = /\b(newton\w*|gravit\w*|coulomb|charge[sd]?|lennard|jones|harmonic|hooke|spring|vortex|magnet\w*|lorentz|drag|stokes|viscous|turbulen\w*|wind|damping|inverse[ _-]?square)\b/gi;
export function priorWords(text: string): { engine: string[]; physics: string[] } {
  const uniq = (m: RegExpMatchArray | null) => [...new Set((m ?? []).map((w) => w.toLowerCase()))];
  return { engine: uniq(text.match(ENGINE_WORDS)), physics: uniq(text.match(PHYSICS_WORDS)) };
}

const GRADER = 'You grade how well a learner recovered the dynamics of a 3D environment it could only perceive as tables of positions (a first column of time, then x, y, z per named column). '
  + 'The environment is a physics engine; some columns are particles, others mark where the sources of force fields are. The learner answers the next row of every column. '
  + 'For each TRUE statement, decide from the learner\'s own law and words whether it stated it: "exact" (the same claim; numbers within about 10 % once the table\'s axes, scale and time unit are allowed for), '
  + '"partial" (the right idea but incomplete, or numbers further off), "wrong" (it contradicts it), or "absent". Read its law as code: what its observations, rules and output compute is what it claims. '
  + 'The table\'s axes may be turned, scaled and shifted from the engine\'s, and its time unit is not the engine\'s: judge the form of a law, not the engine\'s own numbers. '
  + 'Integrating the motion within a row is kinematics, not a force. Judge what it holds, not what it dropped. Quote the learner briefly as evidence. '
  + GRADING_STRUCTURE + ' '
  + 'Answer JSON: {"grades": [{"id": ..., "grade": "exact"|"partial"|"wrong"|"absent", "evidence": ...}], "false_beliefs": [claims no true statement supports], "form": "compact"|"table"|"mixed", "form_evidence": ...}';

/** The last step repeated, for every column: a law that knows nothing. */
const LAST_STEP = '(p) => { const o = {}; const i = p.t.length - 1; for (const n of p.names) { const s = p.series[n]; if (s.x[i] === null) continue; const b = i > 0 && s.x[i - 1] !== null ? i - 1 : i; o[n] = [2 * s.x[i] - s.x[b], 2 * s.y[i] - s.y[b], 2 * s.z[i] - s.z[b]]; } return o; }';
const STAYS = '(p) => { const o = {}; const i = p.t.length - 1; for (const n of p.names) { const s = p.series[n]; if (s.x[i] !== null) o[n] = [s.x[i], s.y[i], s.z[i]]; } return o; }';

/** A row of an episode, by column name. */
const rowByName = (e: { names: readonly string[] }, row: readonly (readonly number[] | null)[] | undefined) =>
  row ? Object.fromEntries(e.names.map((n, j) => [n, row[j]])) : null;

export const particles3dLab: Lab<SceneSpec, P3Point, P3Episode, P3Case, P3Act> = {
  id: 'particles3d@1',
  about: 'System 2 perceives tables of positions of objects in 3D that move under forces nobody told it, and must write a LAW that answers the next row. '
    + 'The world is simulated by Blender, a service outside the harness (lib/blender/particles_service.py, started with scripts/particles3d-service.ts); System 2 is never told so. '
    + 'The law is checked along horizons, from its own answers, up to the world\'s own predictability (SPEC-MUNDO-3D).',
  options: [
    { name: 'level', default: '1', help: '1 one field; 2 several fields; 3 a force that depends on the velocity; 4 hidden masses and charges; 5 particles that pull on each other; 6 chaos' },
    { name: 'condition', default: 'A', help: 'A Blender\'s fields as they come (recognisable); B unusual parameters, axes turned; C fields with no textbook formula, axes turned' },
    { name: 'service', default: 'http://127.0.0.1:18500', help: 'where the Blender service is (start it with scripts/particles3d-service.ts)' },
    { name: 'noise', default: '0.0001', help: 'the noise of perception, relative to the size of the box' },
    { name: 'acts', default: '4', help: 'episodes System 2 may start itself per round' },
    { name: 'accept', default: '2', help: 'the criterion: at every horizon, the median of the points\' terms at most X' },
    { name: 'precision', default: '0.01', help: 'the declared relative precision ε' }
  ],
  defaults: { seed: '1', explore: '3', every: '10', family: '3', 'confirm-places': '2' },
  regressionByDefault: false,
  external: { url: (o) => o.service },

  /* --- The world ------------------------------------------------------------------------ */
  generate: (seed, o) => {
    const level = Math.min(6, Math.max(1, Number(o.level) || 1));
    const condition = (['A', 'B', 'C'].includes(String(o.condition).toUpperCase()) ? String(o.condition).toUpperCase() : 'A') as Condition;
    return generateScene(seed, level, condition);
  },
  placeOf: (spec, index) => placeScene(spec, index),
  runName: (seed, o) => 'particles3d-s' + seed + 'L' + o.level + String(o.condition).toUpperCase(),
  headline: (spec) => 'level ' + spec.level + ', condition ' + spec.condition + ' (' + spec.fields.map((f) => f.type.toLowerCase()).join(' + ') + '; ' + spec.bodies.length + ' particles)',
  placeInfo: (spec) => ({ fields: spec.fields.map((f, i) => ({ marker: spec.markers[i].name, type: f.type, at: f.location })), bodies: spec.bodies, frame: spec.frame }),
  truth: (spec) => describeSceneTruth(spec),
  explorationSeed: (seed, o) => seed * 1013 + Number(o.level) * 17 + String(o.condition).charCodeAt(0),

  /* --- The senses ----------------------------------------------------------------------- */
  world: p3PointWorld,
  perceive: perceiveP3,
  perceptDoc: P3_PERCEPT_DOC,
  interface: p3Interface,
  compare: (answer, point) => {
    const a = readAnswer(answer, point.names);
    if (typeof a === 'string') throw new Error(a);
    return a;
  },

  /* --- The episodes --------------------------------------------------------------------- */
  episode: (spec, rnd, ctx) => environmentEpisode(spec, rnd, ctx, false),
  /* Fresh episodes in the place, from the environment's starts, each with the world's own predictability (operator). */
  checkEpisodes: async (spec, c, ctx) => {
    const rnd = mulberry32(hashString([spec.seed, spec.place, c.purpose, c.round, c.index, c.set ?? 0].join(':')).split('').reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7));
    const out: P3Episode[] = [];
    for (let k = 0; k < ctx.checkEpisodes; k++) out.push(await environmentEpisode(spec, rnd, ctx, true));
    return out;
  },
  steps: (e) => e.rows.length - 1,
  indexInfo: (e) => ({ from: e.from, columns: e.names }),
  explored: (e, place) => ({ place, from: e.from, table: tableText(e) }),
  at: (e, row) => (row >= 0 && row + 1 < e.rows.length ? { state: pointAt(e, row), shown: { the_next_row_showed: rowByName(e, e.rows[row + 1]) } } : null),
  cases: (_spec, id, e, every) => {
    /* A check episode asks every horizon within 80 % of the world's predictability there; the learner's own, the next row. */
    const within = e.horizon !== undefined ? HORIZONS.filter((h) => h === 1 || h <= 0.8 * e.horizon!) : [1];
    const noise = observedNoiseVariance(e);
    const out: P3Case[] = [];
    for (let r = 4; r + 1 < e.rows.length; r += Math.max(1, every)) {
      const horizons = within.filter((h) => r + h < e.rows.length);
      if (!horizons.length) continue;
      out.push({ point: id + '@' + r, episode: id, row: r, state: pointAt(e, r), horizons, bodies: e.bodies, noise,
        targets: Object.fromEntries(horizons.map((h) => [h, e.rows[r + h]])) });
    }
    return out;
  },
  ownEvery: 3,
  trial: {
    points: (e) => [3, Math.floor(e.rows.length / 2), e.rows.length - 2].filter((r) => r >= 1 && r + 1 < e.rows.length).map((r) => pointAt(e, r)),
    answers: 3
  },
  view: (e, from, to) => ({ rows_in_table: e.rows.length, table: tableText(e, from, Math.min(to, from + 59)) }),
  shown: (c) => ({ the_next_row_showed: c.targets[1] ? rowByName(c.state, c.targets[1]) : null }),
  residual: (c, compared) => {
    const next = c.targets[1];
    const a = compared as Record<string, number[]>;
    if (!next) return {};
    return { next_row_minus_your_answer: Object.fromEntries(c.state.names.map((n, j) => [n, next[j] && a[n] ? next[j]!.map((v, k) => sig(v - a[n][k])) : null])) };
  },

  /* --- The actions ---------------------------------------------------------------------- */
  act: {
    parse: parseP3Act,
    place: (act) => act.place,
    /* Refused (never saying why) when a name is not a particle, or a start is out of reach or on top of a source. */
    start: async (spec, act, id, ctx) => {
      const names = new Set(spec.bodies.map((b) => b.name));
      const starts: Start[] = [];
      for (const l of act.launch) {
        if (!names.has(l.name)) return null;
        const location = fromPercept(spec.frame, [l.x, l.y, l.z]);
        if (!insideReach(spec, location) || tooClose(spec, location)) return null;
        starts.push({ name: l.name, location, velocity: velocityFromPercept(spec.frame, spec.engine, [l.vx, l.vy, l.vz]) });
      }
      const rows = await simulateIn(spec, starts, ctx);
      const rnd = mulberry32(parseInt(hashString(id + ':' + spec.place).slice(0, 8), 16) || 1);
      return perceiveEpisode(spec, starts, rows, optionsOf(ctx.options).noise, rnd, act.launch);
    },
    shown: (e) => ({ rows_in_table: e.rows.length, table: tableText(e, 0, 60), ...(e.rows.length > 61 ? { more: 'view it for the rest' } : {}) }),
    asWritten: (act) => act
  },
  simulate: {
    from: (point) => (point.rows.length < 2 ? 'no such point (it needs a row with a row before it)' : null),
    step: (point, answer, e, step) => {
      const a = readAnswer(answer, point.names);
      if (typeof a === 'string') return a;
      return { state: appendRow(point, a), shown: { simulated: a, observed: rowByName(e, e.rows[step]) } };
    }
  },

  /* --- The objective and the operator --------------------------------------------------- */
  objective: (host, o) => p3Objective({
    casesIn: async (place, c) => (await host.casesIn(place, c)) as readonly P3Case[],
    answer: (law, state) => host.answer(law, state),
    accept: Number(o.accept), precision: Number(o.precision), regression: host.regression
  }),
  answerIssue: (a) => {
    if (!a || typeof a !== 'object' || Array.isArray(a) || !Object.keys(a).length) return 'the answer must be an object: {"<column>": [x, y, z], ...}';
    const bad = Object.entries(a as Record<string, unknown>).find(([, v]) => !Array.isArray(v) || v.length !== 3 || !v.every((x) => typeof x === 'number' && Number.isFinite(x)));
    return bad ? 'column ' + bad[0] + ' must be [x, y, z] (numbers)' : null;
  },
  agrees: () => false,
  agreement: 'agreed',
  baselines: () => [{ name: 'the last step repeated', source: LAST_STEP }, { name: 'nothing moves', source: STAYS }],
  grading: { system: GRADER, event: 'operator_law_recovery', finalKey: 'final_law' },

  operator: {
    hidden: (spec) => ({ scene: spec, truth: describeSceneTruth(spec) }),
    check: (c) => {
      const cases = c.cases as readonly P3Case[];
      const asked = [...new Set(cases.flatMap((k) => k.horizons))].sort((a, b) => a - b);
      const words = priorWords(JSON.stringify(c.law as Law));
      return {
        journal: { horizons_asked: asked, prior_words_in_law: words },
        ...(words.engine.length ? { say: '  [operator] the law names ' + words.engine.join(', ') } : {})
      };
    },
    /* No Judge ablation of its own yet: a law here is expected to be code (SPEC-MUNDO-3D §6). */
    ablate: async () => null
  }
};
