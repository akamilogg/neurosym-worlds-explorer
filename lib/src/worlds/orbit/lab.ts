import { judgmentHash } from '../../core/formula.ts';
import { asksJudge, lawFormula, pairOf, scoreOf, testPredictions, type Law, type PredictionSample, type Predictor, type TestResult, type Vec2 } from '../../core/predict.ts';
import type { Lab, LabContext, LabOperatorContext, LabOptions } from '../../learn/lab.ts';
import { GRADING_STRUCTURE, type AblationRecord } from '../../learn/operator.ts';
import { delegatedLaw, fitLawCodeOnly } from '../../learn/law-ablation.ts';
import { generateOrbit, launchNear } from './gen.ts';
import { fromPercept, launchable, simulate, toPercept, type OrbitSpec, type Trajectory } from './world.ts';
import { ORBIT_PERCEPT_DOC, readTable, tableSense } from './sense.ts';
import { answerable, answerAsDeparture, departureAsNext, observedNoiseVariance, orbitPointWorld, perceivePoint, predictionSamples, trialLaunches, type OrbitPoint } from './predict.ts';
import { accelSamples, fitNewton, lawSummary, relError, sampleLaunches } from './operator.ts';
import { describeOrbitTruth } from './describe.ts';
import { environmentOf, setupWithSources } from './family.ts';
import { orbitObjective } from './objective.ts';
import { orbitInterface, parseOrbitAct, type OrbitAct } from './interface.ts';

/* ============================================================================
 * orbit@1 as a LABORATORY (SPEC-OBJETIVO O9): bodies move under a law nobody told System 2,
 * which perceives only tables of positions and must write a LAW that answers the next row.
 *
 * The world is a FAMILY of setups governed by one principle (family.ts): the law's form,
 * exponent and strength stay; how many motionless bodies there are, where, and how the
 * table's axes are turned and shifted change. A check is made of launches in view and
 * beyond it (the extrapolation band), with the noise estimated from what is observed; the
 * criterion is a researcher's (objective.ts). The operator keeps measures of its own: the
 * best Newtonian law as the prior a model brings, the code-only / flat / delegated
 * ablations of the Judge, the cache of the Judge, and how much a law's observations
 * compress the points.
 * ========================================================================== */

/** A launch as the learner keeps it: its trajectory, its table as perceived, where it started (in the table's units). */
export interface OrbitEpisode {
  readonly trajectory: Trajectory;
  readonly table: string;
  readonly launch: { readonly x: number; readonly y: number; readonly vx: number; readonly vy: number; readonly m: number };
  /** The launched body's symbol (the same in every setup). */
  readonly probe: string;
  /** The --resolution the table was perceived with. */
  readonly resolution: number;
}

/** A point of a check: the prediction sample, named, with the noise estimated from its launch (the objective pools it). */
export type OrbitCase = PredictionSample<OrbitPoint> & {
  readonly point: string;
  readonly episode: string;
  readonly noise: { readonly variance: number; readonly weight: number };
};

const round2 = (n: number) => Number(n.toPrecision(6));
const varying = (o: LabOptions) => ({ varyStrength: o['vary-strength'] === 'true' });
const resolutionOf = (o: LabOptions) => Number(o.resolution) || 0;

/** A trajectory as the learner perceives it; `whole`: a launch beyond the observable region is shown whole. */
function episodeOf(spec: OrbitSpec, trajectory: Trajectory, resolution: number, whole = false): OrbitEpisode {
  const sense = tableSense(spec, { resolution, ...(whole ? { window: false } : {}) });
  const p = toPercept.pos(spec.frame, trajectory.launch.pos), v = toPercept.vel(spec.frame, trajectory.launch.vel);
  return { trajectory, table: sense.render(trajectory), probe: sense.probeGlyph, resolution,
    launch: { x: round2(p[0]), y: round2(p[1]), vx: round2(v[0]), vy: round2(v[1]), m: trajectory.launch.mass } };
}

/** What the next row of the last pair showed at a row, when the rows around it are seen. */
function observedNext(e: OrbitEpisode, i: number): Vec2 | null {
  const probe = readTable(e.table).series[e.probe];
  const xs = [probe.x[i - 1], probe.x[i], probe.x[i + 1]], ys = [probe.y[i - 1], probe.y[i], probe.y[i + 1]];
  if (i < 1 || [...xs, ...ys].some((v) => v === null || v === undefined)) return null;
  return [round2(xs[2]!), round2(ys[2]!)];
}

/** The point at a row of a launch (its table up to that row and the next), or null. */
function pointAt(e: OrbitEpisode, row: number): OrbitPoint | null {
  const lines = e.table.split('\n');
  return row < 0 || row + 1 >= lines.length ? null : { table: lines.slice(0, row + 2).join('\n'), row };
}

/** OPERATOR ONLY: the prior a model brings - the best Newtonian law, fitted on what the learner could see, against the truth. */
function newtonPrior(spec: OrbitSpec, seed: number): { in_view: number; beyond: number } {
  const view = accelSamples(spec, sampleLaunches(spec, 40, seed * 17 + 1, 'view'), 0, spec.window);
  const outer = accelSamples(spec, sampleLaunches(spec, 20, seed * 17 + 2, 'outer'), spec.window, Infinity);
  const newton = fitNewton(spec, view);
  return { in_view: round2(relError(view, newton)), beyond: round2(relError(outer, newton)) };
}

/** OPERATOR ONLY: the Judge's questions so far, live against answered from its cache (the same observation vector). */
const cacheOf = (o: LabOperatorContext<OrbitSpec, OrbitCase>) => {
  const e = o.stats().evaluator;
  return { live: e.judgeCalls, hits: e.vectorHits, not_asked_output_ignores_rules: e.judgeUnread, hit_rate: round2(e.vectorHits / Math.max(1, e.judgeCalls + e.vectorHits)) };
};

/** What the operator keeps of a whole check's result. */
const operatorOf = (r: TestResult) => ({ chi2: r.chi2, error: round2(r.error), median: round2(r.median), by_band: r.byBand, noise_floor: r.floor, hidden_law: r.reference,
  truth_error: r.truthError, scores: r.scores, points: r.samples.length });

const GRADER = 'You grade how well a learner recovered the hidden law of motion of an environment it could only perceive as tables of positions. '
  + 'The learner predicts d: how the next position of the launched body departs from repeating its last step. '
  + 'For each TRUE statement, decide from the learner\'s own law and words whether it stated it: "exact" (the same claim; numbers within about 10%), '
  + '"partial" (the right idea but incomplete, or numbers off by more than that), "wrong" (it states something that contradicts it), or "absent" (nothing about it). '
  + 'The learner answers the next row of the launched body\'s columns, so d = its answer - 2·p(now) + p(previous). Read its law as code: what its observations, rules and output compute is what it claims. Judge what it holds, not what it dropped. Quote the learner briefly as evidence. '
  + 'Separate the learner\'s FORCE LAW (how the pull depends on where the body is) from how it carries that pull over a row: integrating the motion within a row, or fitting the body\'s current velocity to do so, is kinematics, not a term of the law that depends on speed. '
  + 'Judge a formula\'s form over the whole range of distances: a different function that agrees with the true one only over part of the range (e.g. a softened power whose exponent drifts with distance) is "partial", not "exact". '
  + GRADING_STRUCTURE + ' '
  + 'Answer JSON: {"grades": [{"id": ..., "grade": "exact"|"partial"|"wrong"|"absent", "evidence": ...}], "false_beliefs": [claims of the learner that no true statement supports], "form": "compact"|"table"|"mixed", "form_evidence": ...}';

export const orbitLab: Lab<OrbitSpec, OrbitPoint, OrbitEpisode, OrbitCase, OrbitAct> = {
  id: 'orbit@1',
  about: 'System 2 perceives tables of positions of bodies that move under a law nobody told it, and must write a LAW that answers the next row of the launched body. '
    + 'Its law is checked, validated and confirmed in a family of setups governed by one principle (worlds/orbit/family.ts), by a researcher\'s criterion: '
    + 'in each band, the median over points of |observed d - predicted d|² / (2 (σ² + (ε|d|)²)) at most --accept, σ estimated from the motionless bodies.',
  options: [
    { name: 'level', default: '1', help: '1 a power other than 2; 2 a hidden mass; 3 a term in the velocity; 4 a pull that is not a power' },
    { name: 'acts', default: '6', help: 'episodes System 2 may start itself per round with "act"', aliases: ['launches'] },
    { name: 'labs', default: '1', help: 'laboratory setups to start with (the base world, then setups with two and three bodies)' },
    { name: 'resolution', default: '0', help: 'round every perceived position to X, in the table\'s units (0: continuous)' },
    { name: 'sampling', default: 'free', help: 'free: new check launches every round; grid: the same fixed lattice every round (an experiment on cost)' },
    { name: 'test-view', default: '4', help: 'check launches per setup from inside the observable region' },
    { name: 'test-beyond', default: '2', help: 'check launches per setup from beyond it: the extrapolation band' },
    { name: 'accept', default: '2', help: 'the criterion: in each band, the median of the points\' terms at most X (the hidden law stays at or below 1)' },
    { name: 'precision', default: '0.01', help: 'the declared relative precision ε' }
  ],
  flags: [
    { name: 'vary-strength', help: 'stage 2: each body gets a strength of its own in every setup (the law must infer it)' },
    { name: 'delegated', help: 'also run the delegated arm of the ablation every round (the Judge reads the table; one call per point)' }
  ],
  defaults: { seed: '3', explore: '4', every: '8', family: '4', 'confirm-places': '3' },
  aliases: { 'confirm-setups': 'confirm-places' },
  regressionByDefault: false,

  /* --- The world ------------------------------------------------------------------------ */
  generate: (seed, o) => generateOrbit(seed, Number(o.level)).spec,
  placeOf: (spec, index, o) => environmentOf(spec, index, varying(o)),
  /* The laboratories to start with: the base world, then (with --labs > 1) setups with two and three bodies. The family to
     validate against: a finite set, with every number of bodies represented. */
  places: (spec, ctx) => ({
    laboratories: Array.from({ length: Math.max(1, Number(ctx.options.labs)) }, (_, k) => ({ id: 'lab' + (k + 1),
      spec: environmentOf(spec, k === 0 ? 0 : setupWithSources(spec, Math.min(3, k + 1), 1, varying(ctx.options)), varying(ctx.options)) })),
    family: Array.from({ length: ctx.family }, (_, j) => ({ id: 'setup' + (j + 1),
      spec: environmentOf(spec, setupWithSources(spec, [2, 3, 1][j % 3], 1000 + j * 50, varying(ctx.options)), varying(ctx.options)) }))
  }),
  /* Two sets of setups nobody has seen, never shown to the learner nor stored as its launches. */
  blindPlaces: (spec, set, round, ctx) => Array.from({ length: ctx.confirmPlaces }, (_, j) => {
    const k = (set === 1 ? 200000 : 100000) + round * 10 + j;
    return { id: 'blind' + k, spec: environmentOf(spec, k, varying(ctx.options)) };
  }),
  runName: (seed, o) => 'orbit-s' + seed + 'L' + o.level,
  headline: (spec) => 'level ' + spec.level + ' (' + lawSummary(spec) + ')',
  placeInfo: (spec) => ({ sources: spec.sources, frame: spec.frame }),
  truth: (spec, o) => describeOrbitTruth(spec, tableSense(spec, { resolution: resolutionOf(o) }), varying(o)),
  explorationSeed: (seed, o) => seed * 1013 + Number(o.level),

  /* --- The senses ----------------------------------------------------------------------- */
  world: orbitPointWorld,
  perceive: perceivePoint,
  perceptDoc: ORBIT_PERCEPT_DOC,
  interface: orbitInterface,
  /* A model answers the next row of the last pair; what is compared is how it departs from repeating the last step. */
  compare: (answer, point) => answerAsDeparture(answer, point),

  /* --- The episodes --------------------------------------------------------------------- */
  episode: (spec, rnd) => episodeOf(spec, simulate(spec, 'episode', launchNear(spec, rnd, 2 * spec.collide + rnd() * (spec.window - 2 * spec.collide), 1)), 0),
  /* The environment launches a few bodies in the laboratories before the first proposal. */
  explore: (labs, rnd, count, ctx) => {
    const out: { place: string; episode: OrbitEpisode }[] = [];
    const base = labs[0].spec;
    for (let i = 0; out.length < count && i < count * 40; i++) {
      const setup = labs[out.length % labs.length];
      const launch = launchNear(setup.spec, rnd, 2 * base.collide + rnd() * (base.window - 2 * base.collide), 1);
      if (!launchable(setup.spec, launch.pos)) continue;
      out.push({ place: setup.id, episode: episodeOf(setup.spec, simulate(setup.spec, 'ep' + (out.length + 1), launch), resolutionOf(ctx.options)) });
    }
    return out;
  },
  /* Fresh launches in the place: --test-view in view and --test-beyond beyond, new every round ('free') or a fixed lattice. */
  checkEpisodes: (spec, c, ctx) => {
    const base = c.purpose === 'check' ? c.round : c.purpose === 'validation' ? 5000 + c.round : (c.set === 1 ? 200000 : 100000) + c.round;
    return trialLaunches(spec, { sampling: ctx.options.sampling === 'grid' ? 'grid' : 'free', attempt: base * 16 + c.index,
      inView: Number(ctx.options['test-view']), beyond: Number(ctx.options['test-beyond']) })
      .map((tr) => episodeOf(spec, tr, resolutionOf(ctx.options), Math.hypot(tr.launch.pos[0], tr.launch.pos[1]) > spec.window));
  },
  steps: (e) => e.trajectory.states.length,
  indexInfo: (e) => ({ from: e.launch }),
  explored: (e, place) => ({ setup: place, from: e.launch, table: e.table }),
  at: (e, row) => {
    const state = pointAt(e, row);
    return state ? { state, shown: { the_next_row_showed: observedNext(e, row) } } : null;
  },
  cases: (spec, id, e, every) => {
    /* The noise of what is observed: the sources do not move, so the second differences of their columns are pure noise. */
    const noise = { variance: observedNoiseVariance(spec, [e.trajectory], { resolution: e.resolution }), weight: spec.sources.length };
    return predictionSamples(spec, [e.trajectory], { resolution: e.resolution, every })
      .map((s) => ({ ...s, ref: id + '@' + s.state.row, point: id + '@' + s.state.row, episode: id, noise }));
  },
  ownEvery: 4,
  /* A draft computes on its latest launches, at points where an answer can be asked (the last pair seen there and before). */
  trial: {
    points: (e) => {
      const n = e.table.split('\n').length - 2;
      return [2, Math.floor(n / 2), n - 1].map((row) => pointAt(e, row)).filter((p): p is OrbitPoint => !!p && answerable(p));
    },
    answers: 6
  },
  view: (e, from, to) => {
    const lines = e.table.split('\n');
    return { rows_in_table: lines.length - 1, table: [lines[0], ...lines.slice(1 + from, 2 + to)].join('\n') };
  },
  shown: (c) => ({ the_next_row_showed: departureAsNext(c.target, c.state).map(round2) }),
  /* observed next - answer = observed d - predicted d: the same numbers, in the learner's terms. */
  residual: (c, compared) => {
    const d = compared as Vec2;
    return { next_row_minus_your_answer: [c.target[0] - d[0], c.target[1] - d[1]].map(round2), verdict: scoreOf(d, c.target).map((v) => Math.round(v * 1000) / 1000) };
  },
  present: {
    rules: (rules) => Object.fromEntries(Object.entries(rules).map(([id, v]) => [id, round2(v)])),
    answer: (a) => pairOf(a).map(round2)
  },

  /* --- The actions ---------------------------------------------------------------------- */
  act: {
    parse: parseOrbitAct,
    place: (act) => act.setup,
    start: (spec, act, id, ctx) => {
      const pos = fromPercept.pos(spec.frame, [act.x, act.y]);
      if (!launchable(spec, pos)) return null;
      return episodeOf(spec, simulate(spec, id, { pos, vel: fromPercept.vel(spec.frame, [act.vx, act.vy]), mass: act.m }), resolutionOf(ctx.options));
    },
    shown: (e) => {
      const lines = e.table.split('\n');
      return { rows_in_table: lines.length - 1, table: lines.slice(0, 61).join('\n'), ...(lines.length > 61 ? { more: 'view it for the rest' } : {}) };
    },
    /* Echoed in the prompt's words: "place", not the host's name for it. */
    asWritten: ({ setup, ...rest }) => ({ ...rest, ...(setup ? { place: setup } : {}) })
  },
  simulate: {
    from: (point) => (point.row < 1 ? 'no such point (it needs a step with a step before it)' : null),
    /* The model's answer is the next row of the last pair; the other columns keep their last values, in the tables' format. */
    step: (point, answer, e, step) => {
      const now = readTable(point.table);
      const i = now.t.length - 1;
      const next: Vec2 = pairOf(answer);
      const t = now.t[i] + (now.t[i] - now.t[i - 1]);
      const others = now.symbols.filter((g) => g !== e.probe);
      const cells = [t.toFixed(3).padStart(10), ...others.flatMap((g) => [now.series[g].x[i], now.series[g].y[i]].map((v) => (v ?? 0).toFixed(6).padStart(13))),
        next[0].toFixed(6).padStart(13), next[1].toFixed(6).padStart(13)];
      const seen = readTable(e.table).series[e.probe];
      return { state: { table: point.table + '\n' + cells.join(''), row: i + 1 },
        shown: { simulated: next.map(round2), observed: seen.x[step] !== undefined && seen.x[step] !== null ? [seen.x[step], seen.y[step]] : null } };
    }
  },

  /* --- The objective and the operator --------------------------------------------------- */
  /* The researcher's criterion, per setup (objective.ts): the cases' noise estimates are pooled over the places run together. */
  objective: (host, o) => orbitObjective({
    casesIn: async (place, c) => {
      const cases = (await host.casesIn(place, c)) as readonly OrbitCase[];
      const noise = new Map(cases.map((k) => [k.episode, k.noise]));
      return { samples: cases, noise: [...noise.values()] };
    },
    predict: async (law, x) => (await host.compared(law, x)) as Vec2,
    launchOf: (episode) => (host.episode(episode) as OrbitEpisode | undefined)?.launch ?? null,
    operatorView: (r) => operatorOf(r),
    accept: Number(o.accept), precision: Number(o.precision), regression: host.regression
  }),
  answerIssue: (a) => { try { pairOf(a); return null; } catch (e) { return String((e as Error).message ?? e); } },
  /* Never asked: orbit ablates the Judge its own way (operator.ablate). */
  agrees: () => false,
  agreement: 'agreed',
  /* A law that knows nothing: the last step repeated. If it holds too, the check could not tell. */
  baselines: () => [{ name: 'the last step repeated',
    source: '(p) => { const g = p.symbols, i = p.t.length - 1, q = p.series[g[g.length - 1]]; return [2 * q.x[i] - q.x[i - 1], 2 * q.y[i] - q.y[i - 1]]; }' }],
  grading: { system: GRADER, event: 'operator_law_recovery', finalKey: 'final_law' },

  operator: {
    hidden: (spec, ctx) => {
      const { report } = generateOrbit(ctx.seed, spec.level);
      const sense = tableSense(spec, { resolution: resolutionOf(ctx.options) });
      return { generator: report, law: lawSummary(spec), glyphs: { sources: sense.sourceGlyphs, probe: sense.probeGlyph } };
    },
    start: (spec, ctx: LabContext) => ({ operator: { newton_prior: newtonPrior(spec, ctx.seed), stays_in_view: generateOrbit(ctx.seed, spec.level).report.staysInView } }),
    check: (c, o) => {
      const check = c.detail as TestResult | null;
      const law = c.law as Law;
      const vectors = new Set(c.cases.map((s) => o.observer.observe(s.state, lawFormula(law).observations).vector));
      const judge = o.stats().judge;
      return {
        ...(check ? { test: { error: check.error, median: check.median, score: check.scores.law } } : {}),
        journal: {
          jev: { calls: judge.calls, errors: judge.errors, check_calls: c.reused !== null ? 0 : c.cost.jev_calls, cache: cacheOf(o) },
          /* What Jev's cache is keyed on besides the observation vector: the law's observations and rules. */
          judgment_hash: judgmentHash(lawFormula(law)),
          /* How much the law's observations compress the check's points: distinct observation vectors against points. */
          abstraction: { points: c.cases.length, distinct_observations: vectors.size, points_per_observation: round2(c.cases.length / Math.max(1, vectors.size)) }
        },
        ...(check ? { say: '  [operator] hidden law ' + round2(check.scores.reference ?? 0) + ' vs law ' + round2(check.scores.law) } : {})
      };
    },
    /* The code-only arm (each rule a fitted reading of the observations, fitted on the learner's own points), the flat arm
       (a fitted constant per rule) and, with --delegated, the Judge reading the whole table. */
    ablate: async (c, o) => {
      const lawResult = c.detail as TestResult | null;
      if (!lawResult) return null;
      const law = c.law as Law;
      const predictor = o.predictor as unknown as Predictor<OrbitPoint, Vec2>;
      const byRef = new Map(c.cases.map((s) => [s.ref, s]));
      const samples = lawResult.samples.map((r) => byRef.get(r.ref)!).filter(Boolean);
      const fitOn = o.own() as OrbitCase[];
      const summary = (r: TestResult) => ({ error: round2(r.error), median: round2(r.median), truth_error: r.truthError !== null ? round2(r.truthError) : null, by_band: r.byBand, score: round2(r.scores.law) });
      const arms: Record<string, unknown> = { law: { error: round2(lawResult.error), median: round2(lawResult.median), truth_error: lawResult.truthError !== null ? round2(lawResult.truthError) : null,
        by_band: lawResult.byBand, score: round2(lawResult.scores.law), hidden_law_score: lawResult.scores.reference } };
      arms.judge_asked = asksJudge(law);
      arms.output_in_code = !!law.output;
      let record: AblationRecord | null = null;
      if (o.ablation && fitOn.length && asksJudge(law)) {
        const codeOnly = fitLawCodeOnly(predictor, law, fitOn);
        const flat = fitLawCodeOnly(predictor, law, fitOn, { flat: true });
        arms.code_only = { ...summary(await testPredictions(samples, codeOnly.predict)), coefficients: codeOnly.coefficients };
        arms.flat = summary(await testPredictions(samples, flat.predict));
        record = { round: c.round, model: lawResult.scores.law, withoutJudge: (arms.code_only as { score: number }).score, better: 'lower' };
      }
      if (o.ctx.options.delegated === 'true' && asksJudge(law)) {
        const d = delegatedLaw(law);
        arms.delegated = summary(await testPredictions(samples, async (s) => (await predictor.predict(d, s, { measure: law.observations })).compared));
      }
      o.log('ablation', { round: c.round, fitted_on_points: fitOn.length, arms });
      o.say('  ablation (score): law ' + round2(lawResult.scores.law) + (arms.code_only ? ', code only ' + (arms.code_only as { score: number }).score : '')
        + (arms.flat ? ', flat ' + (arms.flat as { score: number }).score : '') + (arms.delegated ? ', delegated ' + (arms.delegated as { score: number }).score : ''));
      return record;
    },
    ablates: (o) => o.delegated === 'true',
    /* The law whose verdicts were best, for the operator (System 2 builds on its latest, or any it names); the Judge's cache. */
    end: (records, o) => {
      const tested = records.filter((r) => r.test);
      const top = tested.reduce<(typeof tested)[number] | null>((a, b) => (!a || b.test!.score < a.test!.score ? b : a), null);
      const judge = o.stats().judge;
      return { best_for_the_operator: top ? { round: top.round, fingerprint: top.fingerprint, test: top.test } : null,
        jev: { calls: judge.calls, errors: judge.errors, cache: cacheOf(o) } };
    }
  }
};
