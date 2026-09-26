/* The physical-world experiment: System 2 in a world where bodies move under a law nobody told it, perceiving only
   tables of positions. It must write a LAW that predicts how each next position departs from repeating the last step.

     node --experimental-strip-types scripts/run-orbit.ts --seed 3 --level 1 [options]

   Endpoints and keys come from the environment (never from the command line, never written to the journal):
     JEV_URL (default https://api.typesafe.ai/v1/systemone), JEV_KEY
     LLM_URL (an OpenAI-compatible /chat/completions URL), LLM_KEY, LLM_MODEL
   Options:
     --seed N            the world (default 3; see calibrate-orbit.ts)
     --level N           1 a power other than 2; 2 a hidden mass; 3 a term in the velocity; 4 a pull that is not a power (default 1)
     --attempts N        proposal/test rounds (default 8)
     --explore N         launches the environment makes before the first proposal (default 4)
     --steps N           investigation answers System 2 may give per round before proposing (default 3)
     --launches N        bodies System 2 may launch itself per round (default 6)
     --sampling S        grid: the test launches are the same fixed lattice every round (the same points recur: cheap);
                         free: new test launches every round (default grid). With grid the learner has studied the test
                         launches by the time a law passes, so a law that passes is CONFIRMED on fresh launches it has
                         never seen (never shown to it) before it is accepted.
     --resolution X      round every perceived position to X, in the table's units (default 0: continuous)
     --test-view N       test launches from inside the observable region (default 6)
     --test-beyond N     test launches from beyond it: the extrapolation band (default 3)
     --every N           take every N-th usable row of a launch as a test point (default 8)
     --accept X          accept a law whose error is within X times what the HIDDEN LAW ITSELF scores on the same points
                         (or the noise floor, if larger), in both bands (default 1.2). The table's d is a second difference
                         over two rows, which departs from the law at an instant where the pull changes within a row: the
                         hidden law does not score 0 either. Both references are the operator's: System 2 only learns
                         whether it was accepted.
     --tools a,b,...     the instruments System 2 is given (default: all = view,inspect,launch,measure,simulate,table;
                         "none" = none of them): the BASELINE, as in run-grid.ts
     --delegated         also run the delegated arm of the ablation every round (the Judge reads the table; one call per point)
     --no-ablation       skip the code-only and flat arms
     --no-grade          skip the operator-only grading of the recovered law against the hidden one (one LLM call)
     --no-reflection     skip the final reflection round
     --flat              CONTROL: a Judge that knows nothing (every answer neutral); the LLM is still consulted
     --out FILE          the journal (default runs/orbit-s<seed>L<level>-<time>.json)

   System 2 learns ONLY from the tables it perceives, the bodies it launches, what its code measures and how its laws
   predicted. The journal also keeps OPERATOR-ONLY measurements (the hidden law, the noise floor, the error against the
   truth, the best Newtonian law, the ablations, the grading): they are for us, and never reach System 2 or Jev. */
import fs from 'node:fs';
import path from 'node:path';
import { Observer } from '../src/core/observer.ts';
import { Evaluator } from '../src/core/evaluate.ts';
import { JevJudge, JEV_DEFAULT_URL } from '../src/core/jev.ts';
import { parseJsonLoose, type ApiError } from '../src/core/net.ts';
import { lawFormula, Predictor, testPredictions, type Law, type PredictionSample, type TestResult, type Vec2 } from '../src/core/predict.ts';
import { hashString, stableStringify } from '../src/core/hash.ts';
import { nodeVmRunner } from '../src/runtime/node-vm.ts';
import { openAiChatClient } from '../src/learn/system2.ts';
import { replayOnEvidence } from '../src/learn/gates.ts';
import { parseReflection } from '../src/learn/explorer.ts';
import { LAW_TOOLS, lawExplorerPayload, lawExplorerSystem, ownLaw, parseLawTurn, type LawRequest, type LawTool } from '../src/learn/law-explorer.ts';
import { delegatedLaw, fitLawCodeOnly } from '../src/learn/law-ablation.ts';
import { Notebook } from '../src/learn/notebook.ts';
import { mulberry32 } from '../src/worlds/grid/gen.ts';
import { ORBIT_PERCEPT_DOC, fromPercept, generateOrbit, launchNear, launchable, readTable, simulate, tableSense, toPercept, type Trajectory } from '../src/worlds/orbit/index.ts';
import { orbitPointWorld, perceivePoint, predictionSamples, trialLaunches, type OrbitPoint } from '../src/worlds/orbit/predict.ts';
import { accelSamples, fitNewton, lawSummary, relError, sampleLaunches } from '../src/worlds/orbit/operator.ts';
import { describeOrbitTruth } from '../src/worlds/orbit/describe.ts';
import type { MeasureDecl } from '../src/core/types.ts';
import { ROOT } from '../test/support.ts';

/* --- Configuration ---------------------------------------------------------------- */

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
const flag = (name: string): boolean => argv.includes('--' + name);
function parseTools(value: string): LawTool[] {
  if (value === 'all') return [...LAW_TOOLS];
  if (value === 'none') return [];
  const asked = value.split(',').map((t) => t.trim()).filter(Boolean);
  const unknown = asked.filter((t) => !(LAW_TOOLS as readonly string[]).includes(t));
  if (unknown.length) { console.error('--tools: unknown ' + unknown.join(', ') + ' (tools: ' + LAW_TOOLS.join(', ') + ', or all / none)'); process.exit(2); }
  return LAW_TOOLS.filter((t) => asked.includes(t));
}
const cfg = {
  seed: Number(arg('seed', '3')),
  level: Number(arg('level', '1')),
  attempts: Number(arg('attempts', '8')),
  explore: Number(arg('explore', '4')),
  steps: Number(arg('steps', '3')),
  launches: Number(arg('launches', '6')),
  sampling: (arg('sampling', 'grid') === 'free' ? 'free' : 'grid') as 'grid' | 'free',
  resolution: Number(arg('resolution', '0')),
  testView: Number(arg('test-view', '6')),
  testBeyond: Number(arg('test-beyond', '3')),
  every: Number(arg('every', '8')),
  accept: Number(arg('accept', '1.2')),
  delegated: flag('delegated'),
  ablation: !flag('no-ablation'),
  grade: !flag('no-grade'),
  reflection: !flag('no-reflection'),
  flat: flag('flat'),
  tools: parseTools(arg('tools', 'all'))
};
const tools: ReadonlySet<LawTool> = new Set(cfg.tools);
const investigative = cfg.tools.length > 0;
const SYSTEM_PROMPT = lawExplorerSystem(tools);
const env = process.env;
if (!env.LLM_URL || !env.LLM_MODEL) { console.error('LLM_URL and LLM_MODEL are required (and LLM_KEY if the endpoint needs one).'); process.exit(2); }
if (!cfg.flat && !env.JEV_KEY) { console.error('JEV_KEY is required (or run the --flat control).'); process.exit(2); }

/* --- The world, as the operator knows it and as the learner perceives it ------------- */

const { spec, report } = generateOrbit(cfg.seed, cfg.level);
const sense = tableSense(spec, { resolution: cfg.resolution });
const world = orbitPointWorld();
const runner = nodeVmRunner({ timeoutMs: 2000 });
const observer = new Observer<OrbitPoint>(world, { kinds: ['code'], runners: [runner], perceive: (s) => perceivePoint(s) });

/* A Judge that knows nothing: the control a learned law must beat. */
const flatFetch = async (_u: string, init: { body?: string }) => {
  const body = JSON.parse(String(init.body));
  const answers: Record<string, unknown> = {};
  for (const [id, q] of Object.entries<any>(body.questions)) {
    answers[id] = q.type === 'choice' ? { type: 'choice', probabilities: Object.fromEntries(Object.keys(q.criteria).map((k, i) => [k, i === 0 ? 0.5 : 0.25])), confidence: 0.3 }
      : q.type === 'score' ? { type: 'score', score: Math.floor((q.criteria.length - 1) / 2), confidence: 0.3 } : { type: 'noul', noul: 0.5 };
  }
  const text = JSON.stringify({ answers });
  return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
};
const judge = new JevJudge(cfg.flat
  ? { url: JEV_DEFAULT_URL, apiKey: 'flat', fetch: flatFetch as never }
  : { url: env.JEV_URL || JEV_DEFAULT_URL, apiKey: env.JEV_KEY, model: env.JEV_MODEL, timeoutMs: 90000, retries: 4, retryNetwork: true, concurrency: 8 });
const evaluator = new Evaluator<OrbitPoint>(observer, judge, { maximizer: 'nature' });
const predictor = new Predictor<OrbitPoint>(evaluator, perceivePoint, { runners: [runner] });
const llm = openAiChatClient({ url: env.LLM_URL, apiKey: env.LLM_KEY, model: env.LLM_MODEL, jsonMode: true, temperature: 0.4, timeoutMs: 180000, retries: 1 });

/* --- The journal ------------------------------------------------------------------ */

const started = new Date();
const outFile = arg('out', path.join(ROOT, 'runs', 'orbit-s' + cfg.seed + 'L' + cfg.level + '-' + started.toISOString().replace(/[:.]/g, '-') + '.json'));
fs.mkdirSync(path.dirname(outFile), { recursive: true });
const truth = describeOrbitTruth(spec, sense);
const journal: Record<string, any> = {
  experiment: 'orbit@1', started: started.toISOString(), config: { ...cfg, llm_model: env.LLM_MODEL, jev_model: env.JEV_MODEL ?? null },
  hidden_from_the_learner: { spec, generator: report, law: lawSummary(spec), truth, glyphs: { sources: sense.sourceGlyphs, probe: sense.probeGlyph } },
  events: [] as unknown[]
};
const log = (type: string, data: Record<string, unknown> = {}): void => {
  journal.events.push({ t: Math.round((Date.now() - started.getTime()) / 1000), type, ...data });
  fs.writeFileSync(outFile, JSON.stringify(journal, null, 2));
};
const say = (text: string): void => console.log('[' + Math.round((Date.now() - started.getTime()) / 1000) + 's] ' + text);

/* --- The learner's own experience: its launches and the tests' ----------------------- */

interface StoredLaunch {
  readonly id: string;
  readonly round: number;
  /** "the environment", "you", or "the test of round N". */
  readonly by: string;
  readonly trajectory: Trajectory;
  /** The table as the learner perceives it (a test launch beyond the observable region is shown whole). */
  readonly table: string;
  readonly launch: { x: number; y: number; vx: number; vy: number; m: number };
}
const launches = new Map<string, StoredLaunch>();
let launchCounter = 0;
const round2 = (n: number) => Number(n.toPrecision(6));

function store(id: string, round: number, by: string, trajectory: Trajectory, whole = false): StoredLaunch {
  const table = (whole ? tableSense(spec, { resolution: cfg.resolution, window: false }) : sense).render(trajectory);
  const p = toPercept.pos(spec.frame, trajectory.launch.pos), v = toPercept.vel(spec.frame, trajectory.launch.vel);
  const s: StoredLaunch = { id, round, by, trajectory, table, launch: { x: round2(p[0]), y: round2(p[1]), vx: round2(v[0]), vy: round2(v[1]), m: trajectory.launch.mass } };
  launches.set(id, s);
  return s;
}

/** "launch3@12": the table of launch3 up to row 12. */
function resolve(ref: string): OrbitPoint | null {
  const m = /^([a-z][a-z0-9-]*)@(\d+)$/.exec(ref.trim());
  const l = m ? launches.get(m[1]) : undefined;
  if (!m || !l) return null;
  const row = Number(m[2]);
  const lines = l.table.split('\n');
  if (row < 0 || row + 1 >= lines.length) return null;
  return { table: lines.slice(0, row + 2).join('\n'), row };
}

/** The observed d at a point, when the rows around it are seen. */
function observedD(ref: string): Vec2 | null {
  const m = /^(.+)@(\d+)$/.exec(ref.trim());
  const l = m ? launches.get(m[1]) : undefined;
  if (!m || !l) return null;
  const i = Number(m[2]);
  const probe = readTable(l.table).bodies[sense.probeGlyph];
  const xs = [probe.x[i - 1], probe.x[i], probe.x[i + 1]], ys = [probe.y[i - 1], probe.y[i], probe.y[i + 1]];
  if (i < 1 || [...xs, ...ys].some((v) => v === null || v === undefined)) return null;
  return [round2(xs[2]! - 2 * xs[1]! + xs[0]!), round2(ys[2]! - 2 * ys[1]! + ys[0]!)];
}

/** The index of launches, as the notebook shows it. */
const launchIndex = () => [...launches.values()].map((l) => ({ launch: l.id, round: l.round, launched_by: l.by, from: l.launch, rows: l.trajectory.states.length }));

function explore(): void {
  const rnd = mulberry32(cfg.seed * 1013 + cfg.level);
  for (let i = 0; launchCounter < cfg.explore && i < cfg.explore * 20; i++) {
    const launch = launchNear(spec, rnd, 2 * spec.collide + rnd() * (spec.window - 2 * spec.collide), 1);
    if (!launchable(spec, launch.pos)) continue;
    const id = 'launch' + (++launchCounter);
    store(id, 0, 'the environment', simulate(spec, id, launch));
    log('exploration_launch', { launch: id });
  }
}

/* --- Laws, rounds and the scoreboard ------------------------------------------------- */

interface LawRecord {
  readonly round: number;
  readonly law: Law;
  readonly fingerprint: string;
  test: { error: number; median: number } | null;
  readonly lessons: string[];
  readonly nextExperiment: string;
}
const laws: LawRecord[] = [];
const fingerprint = (law: Law) => hashString(stableStringify(ownLaw(law))).slice(0, 10);
const best = (): LawRecord | null => laws.filter((l) => l.test).reduce<LawRecord | null>((a, b) => (!a || b.test!.error < a.test!.error ? b : a), null);
const lawOfRound = (round: number): Law | null => laws.find((l) => l.round === round)?.law ?? null;

function scoreboard(): unknown {
  const rows = laws.filter((l) => l.test).map((l) => ({ round: l.round, fingerprint: l.fingerprint, error: round2(l.test!.error), median: round2(l.test!.median) }));
  if (!rows.length) return null;
  const b = best()!;
  return { by_round: rows, best: rows.find((r) => r.round === b.round), latest: rows[rows.length - 1] };
}

const notebook = new Notebook();
let unaddressed: string[] = [];
function notebookBrief(): Record<string, unknown> {
  const { games: _g, rounds: _r, ...own } = notebook.brief(unaddressed) as Record<string, unknown>;
  const last = laws[laws.length - 1];
  return {
    ...own,
    launches: launchIndex(),
    laws: laws.map((l) => ({ round: l.round, fingerprint: l.fingerprint, law: ownLaw(l.law), test: l.test })),
    ...(last ? { your_last_lessons: last.lessons, your_planned_next_experiment: last.nextExperiment } : {})
  };
}

/* --- The test of a law -------------------------------------------------------------- */

let lastTest: unknown = null;
const testPoints = new Map<number, PredictionSample<OrbitPoint>[]>();

/** The test launches of a round: stored as the learner's to study afterwards, their points named "<launch>@<row>". */
function testSamples(round: number): PredictionSample<OrbitPoint>[] {
  if (testPoints.has(round)) return testPoints.get(round)!;
  const trajectories = trialLaunches(spec, { sampling: cfg.sampling, attempt: round, inView: cfg.testView, beyond: cfg.testBeyond });
  const samples: PredictionSample<OrbitPoint>[] = [];
  trajectories.forEach((tr, k) => {
    const id = 'test' + round + '-' + (k + 1);
    const outer = Math.hypot(tr.launch.pos[0], tr.launch.pos[1]) > spec.window;
    store(id, round, 'the test of round ' + round, tr, outer);
    for (const s of predictionSamples(spec, [tr], { resolution: cfg.resolution, every: cfg.every })) samples.push({ ...s, ref: id + '@' + s.state.row });
  });
  testPoints.set(round, samples);
  return samples;
}

async function testLaw(law: Law, round: number): Promise<{ result: TestResult; calls: number }> {
  const samples = testSamples(round);
  const before = judge.stats.calls;
  const result = await testPredictions(samples, async (s) => (await predictor.predict(law, s)).vector);
  return { result, calls: judge.stats.calls - before };
}

/** What System 2 learns of a test: per launch, its error and where it started; the points it missed most. Facts only. */
function describeTest(round: number, r: TestResult): unknown {
  const byLaunch = new Map<string, { predicted: Vec2; target: Vec2 }[]>();
  for (const s of r.samples) {
    const id = s.ref!.split('@')[0];
    byLaunch.set(id, [...(byLaunch.get(id) ?? []), { predicted: s.predicted, target: s.target }]);
  }
  const rel = (pairs: { predicted: Vec2; target: Vec2 }[]) => {
    let e = 0, n = 0;
    for (const { predicted: p, target: t } of pairs) { e += (p[0] - t[0]) ** 2 + (p[1] - t[1]) ** 2; n += t[0] ** 2 + t[1] ** 2; }
    return n > 0 ? round2(Math.sqrt(e / n)) : 0;
  };
  return {
    round, error: round2(r.error), median: round2(r.median), points: r.samples.length,
    by_launch: [...byLaunch.entries()].map(([id, pairs]) => {
      const l = launches.get(id)!;
      return { launch: id, from: l.launch, started_in_the_region_you_observe: Math.hypot(l.trajectory.launch.pos[0], l.trajectory.launch.pos[1]) <= spec.window, points: pairs.length, error: rel(pairs) };
    }),
    missed_most: [...r.samples].sort((a, b) => b.error - a.error).slice(0, 5).map((s) => ({ point: s.ref, predicted_d: s.predicted.map(round2), observed_d: s.target.map(round2), error: round2(s.error) })),
    ...(r.failed.length ? { failed: r.failed.slice(0, 5) } : {})
  };
}

/** Does a result meet the acceptance criterion: within --accept times what the hidden law itself scores on the same
    points (or the noise floor, if larger), per band? */
function meetsCriterion(result: TestResult, samples: readonly PredictionSample<OrbitPoint>[]): boolean {
  if (result.floor === null || result.failed.length) return false;
  return ['view', 'outer'].every((band) => {
    if (!result.samples.some((s) => s.band === band)) return true;
    const own = samples.filter((s) => s.band === band);
    return (result.byBand[band] ?? Infinity) <= cfg.accept * Math.max(referenceOf(own, 'truth'), referenceOf(own, 'reference'));
  });
}

/** With --sampling grid the learner has studied the test launches: a law that passes them is confirmed on fresh launches
    it has never seen, drawn once per round and never shown to it (nor stored as its launches). */
async function confirmBlind(law: Law, round: number): Promise<{ ok: boolean; result: TestResult; calls: number }> {
  const trajectories = trialLaunches(spec, { sampling: 'free', attempt: 100000 + round, inView: cfg.testView, beyond: cfg.testBeyond });
  const samples = predictionSamples(spec, trajectories, { resolution: cfg.resolution, every: cfg.every });
  const before = judge.stats.calls;
  const result = await testPredictions(samples, async (s) => (await predictor.predict(law, s)).vector);
  return { ok: meetsCriterion(result, samples), result, calls: judge.stats.calls - before };
}

/* --- Operator-only measures ---------------------------------------------------------- */

/** The prior a model brings: the best Newtonian law, fitted on what the learner could see, judged against the truth. */
const newtonPrior = (() => {
  const view = accelSamples(spec, sampleLaunches(spec, 40, cfg.seed * 17 + 1, 'view'), 0, spec.window);
  const outer = accelSamples(spec, sampleLaunches(spec, 20, cfg.seed * 17 + 2, 'outer'), spec.window, Infinity);
  const newton = fitNewton(spec, view);
  return { in_view: round2(relError(view, newton)), beyond: round2(relError(outer, newton)) };
})();

/** How much the law's observations compress the test points: distinct observation vectors against points. */
function abstractionOf(law: Law, samples: readonly PredictionSample<OrbitPoint>[]): Record<string, number> {
  const vectors = new Set(samples.map((s) => observer.observe(s.state, lawFormula(law).observations).vector));
  return { points: samples.length, distinct_observations: vectors.size, points_per_observation: round2(samples.length / Math.max(1, vectors.size)) };
}

/** Points of the learner's own launches (not the tests'): what the code-only arm is fitted on, out of the test sample. */
function ownSamples(): PredictionSample<OrbitPoint>[] {
  return [...launches.values()].filter((l) => !l.id.startsWith('test')).flatMap((l) =>
    predictionSamples(spec, [l.trajectory], { resolution: cfg.resolution, every: 4 }).map((s) => ({ ...s, ref: l.id + '@' + s.state.row })));
}

async function ablate(law: Law, round: number, lawResult: TestResult): Promise<void> {
  const samples = testSamples(round);
  const fitOn = ownSamples();
  const arms: Record<string, unknown> = { law: { error: round2(lawResult.error), median: round2(lawResult.median), truth_error: lawResult.truthError !== null ? round2(lawResult.truthError) : null, by_band: lawResult.byBand } };
  const summary = (r: TestResult) => ({ error: round2(r.error), median: round2(r.median), truth_error: r.truthError !== null ? round2(r.truthError) : null, by_band: r.byBand });
  arms.carried_by = Object.fromEntries(Object.entries(law.components).map(([id, c]) => [id, c.magnitude ? 'code' : 'judge']));
  if (cfg.ablation && fitOn.length) {
    const codeOnly = fitLawCodeOnly(observer, perceivePoint, law, fitOn);
    const flat = fitLawCodeOnly(observer, perceivePoint, law, fitOn, { flat: true });
    arms.code_only = { ...summary(await testPredictions(samples, codeOnly.predict)), coefficients: codeOnly.coefficients };
    arms.flat = summary(await testPredictions(samples, flat.predict));
  }
  if (cfg.delegated) {
    const d = delegatedLaw(law);
    arms.delegated = summary(await testPredictions(samples, async (s) => (await predictor.predict(d, s)).vector));
  }
  log('ablation', { round, fitted_on_points: fitOn.length, arms });
  say('  ablation: law ' + round2(lawResult.error) + (arms.code_only ? ', code only ' + (arms.code_only as { error: number }).error : '') + (arms.flat ? ', flat ' + (arms.flat as { error: number }).error : '') +
    (arms.delegated ? ', delegated ' + (arms.delegated as { error: number }).error : ''));
}

/* --- Investigation ------------------------------------------------------------------ */

const lawOf = (ref: number | Law | null): Law | null => (ref === null ? best()?.law ?? laws[laws.length - 1]?.law ?? null : typeof ref === 'number' ? lawOfRound(ref) : ref);

/** A law's observations and directions must compute on points of the learner's own launches before anything uses it. */
function checkOnPoints(law: Law): string[] {
  const points = [...launches.values()].filter((l) => !l.id.startsWith('test')).slice(-4).flatMap((l) => {
    const n = l.table.split('\n').length - 2;
    return [2, Math.floor(n / 2), n - 1].map((row) => resolve(l.id + '@' + row)).filter((p): p is OrbitPoint => !!p);
  });
  const errors = replayOnEvidence(observer, law.observations, points.map((state) => ({ state }))).errors.slice(0, 4).map((e) => (e.observation ?? '') + ': ' + e.error);
  for (const [id, c] of Object.entries(law.components)) {
    for (const p of points.slice(0, 6)) {
      try { predictor.directionOf(c, perceivePoint(p)); } catch (e) { errors.push('direction of ' + id + ': ' + String((e as Error).message ?? e)); break; }
    }
  }
  return errors;
}

async function runRequest(req: LawRequest, budget: { launches: number }): Promise<unknown> {
  const kind = (['view', 'inspect', 'launch', 'measure', 'simulate', 'table'] as const).find((k) => k in req)!;
  if (!tools.has(kind)) return { [kind]: (req as Record<string, unknown>)[kind], error: '"' + kind + '" is not available in this experiment' };
  if ('view' in req) {
    const l = launches.get(req.view);
    if (!l) return { view: req.view, error: 'no such launch' };
    const lines = l.table.split('\n');
    return { view: l.id, rows_in_table: lines.length - 1, table: [lines[0], ...lines.slice(1 + Math.max(0, req.from), 2 + Math.max(0, req.to))].join('\n') };
  }
  if ('launch' in req) {
    if (budget.launches <= 0) return { launch: req.launch, error: 'no launches left this round' };
    const pos = fromPercept.pos(spec.frame, [req.launch.x, req.launch.y]);
    /* The environment answers only whether it launched: never why not. */
    if (!launchable(spec, pos)) return { launch: req.launch, launched: false };
    budget.launches--;
    const id = 'launch' + (++launchCounter);
    const l = store(id, currentRound, 'you', simulate(spec, id, { pos, vel: fromPercept.vel(spec.frame, [req.launch.vx, req.launch.vy]), mass: req.launch.m }));
    const lines = l.table.split('\n');
    return { launch: req.launch, launched: true, name: id, rows_in_table: lines.length - 1, table: lines.slice(0, 41).join('\n'), ...(lines.length > 41 ? { more: 'view it for the rest' } : {}) };
  }
  if ('measure' in req) {
    const decl: MeasureDecl = { spec: { kind: 'code', lang: 'js', source: req.measure.source }, ...(req.measure.range ? { range: req.measure.range } : {}) };
    return { measure: req.measure.source, values: req.on.map((ref) => {
      const p = resolve(ref);
      if (!p) return { point: ref, error: 'no such point' };
      const o = observer.observe(p, { m: decl });
      const err = o.errors.find((e) => e.id === 'm');
      return err ? { point: ref, error: err.error } : { point: ref, value: o.values.m ?? o.texts.m };
    }) };
  }
  if ('inspect' in req) {
    const law = lawOf(req.law);
    const p = resolve(req.inspect);
    if (!law) return { inspect: req.inspect, error: 'there is no law yet: name a draft' };
    if (!p) return { inspect: req.inspect, error: 'no such point' };
    const failures = typeof req.law === 'object' && req.law ? checkOnPoints(law) : [];
    if (failures.length) return { inspect: req.inspect, error: 'your draft failed on points of your launches: ' + failures.join(' | ') };
    try {
      const pr = await predictor.predict(law, p);
      return {
        inspect: req.inspect, predicted_d: pr.vector.map(round2), observed_d: observedD(req.inspect),
        components: Object.fromEntries(Object.entries(pr.components).map(([id, c]) => [id, { direction: c.direction.map(round2),
          ...(c.value === null ? { magnitude_from: 'your code' } : { judge_value: round2(c.value) }), magnitude: round2(c.magnitude) }])),
        ...(pr.evaluation ? {
          each_rule_answered: Object.fromEntries(Object.entries(pr.evaluation.answers).map(([id, a]) => [id, round2(a.value)])),
          your_observations_measured: { ...pr.evaluation.observation.values, ...pr.evaluation.observation.texts }
        } : { the_judge_was_not_asked: true })
      };
    } catch (e) { return { inspect: req.inspect, error: String((e as Error).message ?? e) }; }
  }
  if ('simulate' in req) {
    const law = lawOf(req.law);
    const start = resolve(req.simulate);
    if (!law) return { simulate: req.simulate, error: 'there is no law yet: name a draft' };
    if (!start || start.row < 1) return { simulate: req.simulate, error: 'no such point (it needs a row with a row before it)' };
    const failures = typeof req.law === 'object' && req.law ? checkOnPoints(law) : [];
    if (failures.length) return { simulate: req.simulate, error: 'your draft failed on points of your launches: ' + failures.join(' | ') };
    const [id] = req.simulate.split('@');
    const observed = readTable(launches.get(id)!.table);
    const lines = start.table.split('\n');
    const rows: unknown[] = [];
    try {
      for (let k = 0; k < req.rows; k++) {
        const now = readTable(lines.join('\n'));
        const i = now.t.length - 1;
        const pr = await predictor.predict(law, { table: lines.join('\n'), row: i });
        const probe = now.bodies[sense.probeGlyph];
        if (probe.x[i] === null || probe.x[i - 1] === null) break;
        const next: Vec2 = [2 * probe.x[i]! - probe.x[i - 1]! + pr.vector[0], 2 * probe.y[i]! - probe.y[i - 1]! + pr.vector[1]];
        const t = now.t[i] + (now.t[i] - now.t[i - 1]);
        /* The other bodies keep their last seen positions; the launched body moves as the law says. */
        const cells = [t.toFixed(2).padStart(10), ...sense.sourceGlyphs.flatMap((g) => [now.bodies[g].x[i], now.bodies[g].y[i]].map((v) => (v ?? 0).toFixed(4).padStart(10))),
          next[0].toFixed(4).padStart(10), next[1].toFixed(4).padStart(10)];
        lines.push(cells.join(''));
        const seen = observed.bodies[sense.probeGlyph];
        rows.push({ row: i + 1, simulated: next.map(round2), observed: seen.x[i + 1] !== undefined && seen.x[i + 1] !== null ? [seen.x[i + 1], seen.y[i + 1]] : null });
      }
    } catch (e) { return { simulate: req.simulate, error: String((e as Error).message ?? e), rows }; }
    return { simulate: req.simulate, rows };
  }
  /* table: the points of its launches or of the tests, the code's value, and the residual of its best law there. */
  const law = best()?.law ?? laws[laws.length - 1]?.law ?? null;
  const decl: MeasureDecl = { spec: { kind: 'code', lang: 'js', source: req.table.source }, range: req.table.range };
  const samples = req.on === 'tests' ? [...testPoints.values()].flat().slice(-60) : ownSamples().slice(-60);
  const rows: unknown[] = [];
  for (const s of samples) {
    const o = observer.observe(s.state, { m: decl });
    const err = o.errors.find((e) => e.id === 'm');
    let residual: unknown = null;
    if (law) {
      try {
        const pr = await predictor.predict(law, s.state);
        const r: Vec2 = [s.target[0] - pr.vector[0], s.target[1] - pr.vector[1]];
        residual = { d_minus_predicted: r.map(round2), relative_size: round2(Math.hypot(r[0], r[1]) / Math.max(1e-300, Math.hypot(s.target[0], s.target[1]))) };
      } catch (e) { residual = { error: String((e as Error).message ?? e) }; }
    }
    rows.push({ point: s.ref, ...(err ? { error: err.error } : { value: o.values.m }), observed_d: s.target.map(round2), residual });
  }
  return { table: req.table.source, on: req.on, residuals_of: law ? 'your best law' : 'no law yet', rows };
}

/* --- Consulting System 2 ------------------------------------------------------------- */

const REFLECTION_TASK = 'REFLECTION ROUND. Your law is final: do not propose one. Look back at your launches and tests' + (investigative ? ' (you may investigate first)' : '') + ' and '
  + 'answer with {"rationale": ..., "beliefs": [stances on every belief you hold, and any new ones], "notes": [...], "lessons": [...], "next_experiment": ...}: '
  + 'what you now believe about this environment - what moves the launched body and how, in terms you could check - citing your evidence.';

let currentRound = 0;
let llmFatal: string | null = null;

async function consult(mode: 'propose' | 'reflect'): Promise<LawRecord | null> {
  if (llmFatal) return null;
  currentRound++;
  const round = currentRound;
  const b = best();
  let refused: string[] = [];
  const investigation: unknown[] = [];
  let steps = 0, refusals = 0;
  const budget = { launches: cfg.launches };
  while (refusals < 3 && steps <= cfg.steps + 3) {
    const stepsLeft = investigative ? Math.max(0, cfg.steps - steps) : 0;
    const payload = lawExplorerPayload({
      round, perceptDoc: ORBIT_PERCEPT_DOC, notebook: notebookBrief(), scoreboard: scoreboard(), law: b?.law ?? null, lawRound: b?.round ?? null,
      lastTest, ...(investigative ? { investigation, stepsLeft } : {}), ...(tools.has('launch') ? { launchesLeft: budget.launches } : {}),
      refused, task: mode === 'reflect' ? REFLECTION_TASK : null
    });
    say('round ' + round + (steps ? ' step ' + steps : '') + ': consulting System 2 (' + Math.round(JSON.stringify(payload).length / 1024) + ' KB)');
    steps++;
    let content = '';
    try {
      content = (await llm.complete({ system: SYSTEM_PROMPT, user: payload })).content;
    } catch (error) {
      const status = (error as ApiError)?.details?.status;
      if (status === 401 || status === 402 || status === 403) {
        llmFatal = String((error as Error)?.message || error);
        log('llm_fatal', { round, status, error: llmFatal });
        say('the LLM service refused the account (HTTP ' + status + '): stopping');
        return null;
      }
      refusals++;
      log('proposal_failed', { round, error: String((error as Error)?.message || error) });
      continue;
    }
    const turn = parseLawTurn(content, { world: world.id, round });
    const known = (ref: string) => launches.has(ref.trim()) || resolve(ref) !== null;
    const noteWarnings = [...notebook.applyNotes(round, turn.notes, known), ...notebook.applyMethods(round, turn.methods)];
    if (turn.notes.length) say('  notes: ' + turn.notes.map((n) => n.do + ' ' + n.id).join(', '));
    if (turn.methods.length) { say('  methods: ' + turn.methods.map((m) => m.do + ' ' + m.id).join(', ')); log('methods', { round, methods: turn.methods }); }
    if (turn.kind === 'investigate') {
      if (stepsLeft <= 0) { refused = [investigative ? 'no investigation steps left this round: answer with your proposal now' : 'there is no investigating in this experiment: answer with your proposal']; refusals++; continue; }
      const results: unknown[] = [];
      for (const r of turn.requests) results.push(await runRequest(r, budget));
      /* A draft travels back as it wrote it, never as the host's law object. */
      const asWritten = turn.requests.map((r) => ('law' in r && r.law !== null && typeof r.law === 'object' ? { ...r, law: ownLaw(r.law) } : r));
      investigation.push({ step: investigation.length + 1, requests: asWritten, results, ...(turn.warnings.length || noteWarnings.length ? { warnings: [...turn.warnings, ...noteWarnings] } : {}) });
      log('investigation', { round, requests: asWritten, results, warnings: [...turn.warnings, ...noteWarnings], notes: turn.notes });
      say('  investigates: ' + turn.requests.map((r, i) => {
        const res = results[i] as { error?: string; launched?: boolean; name?: string };
        const k = Object.keys(r)[0];
        return k + (res?.error ? ' (' + res.error.slice(0, 60) + ')' : k === 'launch' ? (res.launched ? ' -> ' + res.name : ' refused') : '');
      }).join('; '));
      refused = [];
      continue;
    }
    if (mode === 'reflect') {
      const r = parseReflection(content, round);
      if (!r.ok) { refused = r.errors; refusals++; log('reflection_refused', { round, errors: r.errors, content }); continue; }
      const stances = notebook.applyStances(round, r.reflection.beliefs);
      unaddressed = stances.unaddressed;
      notebook.recordReflection(round, r.reflection.rationale, r.reflection.lessons, r.reflection.nextExperiment);
      log('reflection', { round, investigation_steps: investigation.length, rationale: r.reflection.rationale, beliefs: r.reflection.beliefs, notes: turn.notes,
        lessons: r.reflection.lessons, next_experiment: r.reflection.nextExperiment, stance_warnings: stances.warnings, note_warnings: noteWarnings });
      for (const l of r.reflection.lessons) say('  lesson: ' + l);
      return null;
    }
    const parsed = turn.parse;
    if (!parsed.ok) {
      refused = parsed.errors; refusals++;
      log('proposal_refused', { round, errors: parsed.errors, content });
      say('  refused: ' + parsed.errors.slice(0, 3).join(' | '));
      continue;
    }
    const failures = checkOnPoints(parsed.proposal.law);
    if (failures.length) {
      refused = ['your law failed on points of your launches: ' + failures.join(' | ')]; refusals++;
      log('proposal_refused', { round, errors: refused, content });
      say('  refused: ' + refused[0].slice(0, 200));
      continue;
    }
    const p = parsed.proposal;
    const stances = notebook.applyStances(round, p.beliefs);
    unaddressed = stances.unaddressed;
    const record: LawRecord = { round, law: p.law, fingerprint: fingerprint(p.law), test: null, lessons: p.lessons, nextExperiment: p.nextExperiment };
    laws.push(record);
    log('proposal', { round, investigation_steps: investigation.length, rationale: p.rationale, beliefs: p.beliefs, notes: turn.notes, law: ownLaw(p.law),
      fingerprint: record.fingerprint, lessons: p.lessons, next_experiment: p.nextExperiment, warnings: [...p.warnings, ...stances.warnings, ...noteWarnings] });
    say('  proposes: ' + Object.keys(p.law.observations).length + ' observations, ' + Object.keys(p.law.rules).length + ' rules, ' + Object.keys(p.law.components).length +
      ' components; beliefs ' + p.beliefs.map((x) => x.id + ':' + x.stance).join(' '));
    return record;
  }
  log('no_proposal', { round, refusals });
  return null;
}

/* --- Operator-only grading ------------------------------------------------------------ */

async function gradeRecovery(): Promise<void> {
  const final = best();
  const brief = notebook.brief();
  const learned = { final_law: final ? ownLaw(final.law) : null, beliefs: brief.beliefs_held, dropped: brief.beliefs_dropped, notes: brief.notes, reflections: notebook.reflections };
  const system = 'You grade how well a learner recovered the hidden law of motion of an environment it could only perceive as tables of positions. '
    + 'The learner predicts d: how the next position of the launched body departs from repeating its last step. '
    + 'For each TRUE statement, decide from the learner\'s own law and words whether it stated it: "exact" (the same claim; numbers within about 10%), '
    + '"partial" (the right idea but incomplete, or numbers off by more than that), "wrong" (it states something that contradicts it), or "absent" (nothing about it). '
    + 'Read the learner\'s law as code: what its components and observations compute is what it claims. Judge what it holds, not what it dropped. Quote the learner briefly as evidence. '
    + 'Answer JSON: {"grades": [{"id": ..., "grade": "exact"|"partial"|"wrong"|"absent", "evidence": ...}], "false_beliefs": [claims of the learner that no true statement supports]}';
  try {
    const content = (await llm.complete({ system, user: JSON.stringify({ true_statements: truth, learner: learned }) })).content;
    const parsed = parseJsonLoose(content) as { grades?: { id: string; grade: string; evidence?: string }[]; false_beliefs?: unknown[] } | null;
    const grades = (parsed?.grades ?? []).filter((g) => truth.some((t) => t.id === g.id));
    const points = grades.reduce((n, g) => n + (g.grade === 'exact' ? 1 : g.grade === 'partial' ? 0.5 : 0), 0);
    const score = Math.round(points / truth.length * 100) / 100;
    log('operator_law_recovery', { truth, grades, false_beliefs: parsed?.false_beliefs ?? [], score, grader_model: env.LLM_MODEL });
    say('operator: law recovery ' + score + ' (' + grades.map((g) => g.id + ':' + g.grade).join(' ') + ')');
  } catch (e) {
    log('operator_law_recovery', { truth, error: String((e as Error).message ?? e) });
  }
}

/* --- The run ----------------------------------------------------------------------- */

say('orbit@1 seed ' + cfg.seed + ' level ' + cfg.level + ' (' + lawSummary(spec) + '); journal ' + outFile);
log('start', { operator: { newton_prior: newtonPrior, stays_in_view: report.staysInView } });
explore();
let accepted: LawRecord | null = null;
for (let attempt = 1; attempt <= cfg.attempts && !llmFatal; attempt++) {
  const record = await consult('propose');
  if (!record) { if (llmFatal) break; continue; }
  const { result, calls } = await testLaw(record.law, record.round);
  record.test = { error: result.error, median: result.median };
  lastTest = describeTest(record.round, result);
  const samples = testSamples(record.round);
  const passed = meetsCriterion(result, samples);
  let confirmation: Record<string, unknown> | null = null;
  let ok = passed;
  if (passed && cfg.sampling === 'grid') {
    const c = await confirmBlind(record.law, record.round);
    ok = c.ok;
    confirmation = { confirmed: c.ok, error: round2(c.result.error), by_band: c.result.byBand, floor: c.result.floor, hidden_law: c.result.reference, truth_error: c.result.truthError, points: c.result.samples.length, jev_calls: c.calls };
    log('confirmation', { round: record.round, ...confirmation });
    say('  passed the grid test; blind confirmation on fresh launches: error ' + round2(c.result.error) + ' (noise floor ' + (c.result.floor !== null ? round2(c.result.floor) : '-') + ', hidden law ' + (c.result.reference !== null ? round2(c.result.reference) : '-') + ')' + (c.ok ? ' CONFIRMED' : ' NOT confirmed'));
  }
  log('test', { round: record.round, error: result.error, median: result.median, by_band: result.byBand, points: result.samples.length, failed: result.failed.length,
    operator: { floor: result.floor, hidden_law: result.reference, truth_error: result.truthError, passed_test: passed, ...(confirmation ? { blind_confirmation: confirmation } : {}), accepted: ok },
    jev: { calls: judge.stats.calls, errors: judge.stats.errors, test_calls: calls, calls_per_point: round2(calls / Math.max(1, result.samples.length)) },
    abstraction: abstractionOf(record.law, samples) });
  say('  test: error ' + round2(result.error) + ' (median ' + round2(result.median) + '; noise floor ' + (result.floor !== null ? round2(result.floor) : '-') + ', hidden law ' + (result.reference !== null ? round2(result.reference) : '-') + ', vs truth ' +
    (result.truthError !== null ? round2(result.truthError) : '-') + '), Jev calls ' + calls + (ok ? '  ACCEPTED' : ''));
  if (cfg.ablation || cfg.delegated) await ablate(record.law, record.round, result);
  if (ok) { accepted = record; log('accepted', { round: record.round }); break; }
}

/** The error of the noise-free truth ('truth': the noise floor) or of the hidden law ('reference') on these samples. */
function referenceOf(samples: readonly PredictionSample<OrbitPoint>[], which: 'truth' | 'reference'): number {
  let e = 0, n = 0;
  for (const s of samples) { const r = s[which]; if (!r) continue; e += (r[0] - s.target[0]) ** 2 + (r[1] - s.target[1]) ** 2; n += s.target[0] ** 2 + s.target[1] ** 2; }
  return n > 0 ? Math.sqrt(e / n) : 0;
}

if (cfg.reflection && !llmFatal) {
  say('reflection round: the law is final; System 2 looks back');
  await consult('reflect');
}
if (cfg.grade && !llmFatal) await gradeRecovery();
const final = best();
log('end', {
  stoppedBy: llmFatal ? 'llm_error' : accepted ? 'accepted' : 'budget', ...(llmFatal ? { llm_error: llmFatal } : {}),
  best: final ? { round: final.round, fingerprint: final.fingerprint, test: final.test, law: ownLaw(final.law) } : null,
  notebook, launches: launchIndex(), jev: { calls: judge.stats.calls, errors: judge.stats.errors }
});
say('done: ' + (accepted ? 'accepted in round ' + accepted.round : 'best error ' + (final?.test ? round2(final.test.error) : '-')) + '; journal ' + outFile);
