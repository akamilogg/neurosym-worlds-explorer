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
     --launches N        episodes System 2 may start itself per round with the "act" request (default 6)
     --resolution X      round every perceived position to X, in the table's units (default 0: continuous)
     --sampling S        free: new check launches every round (default: they are unseen, as the protocol asks); grid: the
                         same fixed lattice of launches every round, so the same points recur and Jev's cache can hit - the
                         check is then no longer on unseen launches after the first round (an experiment on cost)
     --test-view N       check launches per setup from inside the observable region (default 4)
     --test-beyond N     check launches per setup from beyond it: the extrapolation band (default 2)
     --every N           take every N-th usable row of a launch as a test point (default 8; with fewer points per setup
                         a few close passes can decide a setup's median, even for the hidden law)
     --accept X          accept a law whose residuals are compatible with the noise of what is observed and a declared
                         precision: in each band, the median over points of |observed d - predicted d|² / (2 (σ² + (ε|d|)²))
                         at most X (default 2; the hidden law itself stays at or below 1), on the test and on both
                         confirmation sets. σ is estimated from observables only - the sources do not move, so the second
                         differences of their columns are pure noise - never from the hidden law, which stays an
                         operator's measure in the journal. System 2 only learns whether it was accepted.
     --precision E       the declared relative precision ε (default 0.01: a law within about 1-2% of the truth passes; far
                         from the source the noise dominates, close in the precision)

   What System 2 learns of a test is the ENVIRONMENT'S VERDICT at every point of every test launch: a vector with one
   number per axis of the table, tanh((observed d - predicted d) / |observed d|), in [-1, 1]. It is never given an error,
   a mean, a ranking or a "best law": what the verdicts mean, and which of its laws to build on, is for it to work out.
     --tools a,b,...     the instruments System 2 is given (default: all = view,inspect,act,measure,simulate,table - "launch" is
                         accepted for act;
                         "none" = none of them): the BASELINE, as in run-grid.ts
     --delegated         also run the delegated arm of the ablation every round (the Judge reads the table; one call per point)
     --no-ablation       skip the code-only and flat arms
     --no-grade          skip the operator-only grading of the recovered law against the hidden one (one LLM call)
     --no-reflection     skip the final reflection round
     --quick             a QUICK run, to see whether a change makes the exploration promising: the run stops the first time
                         System 2 asks to validate (it judges its law good), with no validation in the family and no blind
                         confirmation. The law is printed and kept in the journal; the check in its laboratory still runs
                         every round (it is what System 2 learns from). Implies --no-ablation and --no-reflection; the
                         grading still runs (--no-grade to skip it). The prompt is the full protocol's, so the exploration
                         is the one a full run would see up to that point.
     --flat              CONTROL: a Judge that knows nothing (every answer neutral); the LLM is still consulted
     --out FILE          the journal (default runs/orbit-s<seed>L<level>-<time>.json)

   The world is a FAMILY of setups governed by one principle (worlds/orbit/family.ts): the law's form, exponent and
   strength stay; how many motionless bodies there are, where, and how the table's axes are turned and shifted change
   from setup to setup. The protocol is a researcher's (SPEC-MUNDO-FISICO §8.6):
     1. System 2 starts with ONE laboratory setup. Every round its law is CHECKED there, on launches it has not seen.
     2. When IT decides its law holds, it asks to validate ("validate": true). If the law holds in all its laboratories,
        it is checked in a finite family of setups it has not seen - and again in its laboratories (regression).
     3. A setup where the law does not hold becomes one of its laboratories: it can launch there and study it.
     4. When the law holds in every setup of the family, a blind confirmation in setups never shown decides acceptance.
     --labs N            laboratory setups to start with (default 1: the base world)
     --family N          setups in the family to validate against (default 4; with 1 to 3 bodies)
     --validations N     how many times System 2 may validate (default 3; asking before the law holds in its
                         laboratories is refused and costs nothing)
     --confirm-setups N  setups per blind confirmation set, two sets (default 3)
     --vary-strength     stage 2: each body gets a strength of its own in every setup (the law must infer it)

   System 2 learns ONLY from the tables it perceives, the bodies it launches, what its code measures and how its laws
   predicted. The journal also keeps OPERATOR-ONLY measurements (the hidden law, the noise floor, the error against the
   truth, the best Newtonian law, the ablations, the grading): they are for us, and never reach System 2 or Jev. */
import fs from 'node:fs';
import path from 'node:path';
import { Observer } from '../src/core/observer.ts';
import { Evaluator } from '../src/core/evaluate.ts';
import { JevJudge, JEV_DEFAULT_URL } from '../src/core/jev.ts';
import { parseJsonLoose, type ApiError } from '../src/core/net.ts';
import { judgmentHash } from '../src/core/formula.ts';
import { asksJudge, lawFormula, pairOf, Predictor, scoreOf, testPredictions, type Law, type PredictionSample, type TestResult, type Vec2 } from '../src/core/predict.ts';
import { hashString, stableStringify } from '../src/core/hash.ts';
import { nodeVmRunner } from '../src/runtime/node-vm.ts';
import { openAiChatClient } from '../src/learn/system2.ts';
import { replayOnEvidence } from '../src/learn/gates.ts';
import { parseReflection } from '../src/learn/explorer.ts';
import { reflectionTask, toolOf } from '../src/learn/prompt.ts';
import { LAW_TOOLS, lawExplorerPayload, lawExplorerSystem, ownLaw, parseLawTurn, type LawRequest, type LawTool } from '../src/learn/law-explorer.ts';
import { delegatedLaw, fitLawCodeOnly } from '../src/learn/law-ablation.ts';
import { Notebook } from '../src/learn/notebook.ts';
import { mulberry32 } from '../src/worlds/grid/gen.ts';
import { ORBIT_PERCEPT_DOC, fromPercept, generateOrbit, launchNear, launchable, readTable, simulate, tableSense, toPercept, type Trajectory } from '../src/worlds/orbit/index.ts';
import { answerAsDeparture, departureAsNext, observedNoiseVariance, orbitPointWorld, perceivePoint, predictionSamples, trialLaunches, type OrbitPoint } from '../src/worlds/orbit/predict.ts';
import { accelSamples, fitNewton, lawSummary, relError, sampleLaunches } from '../src/worlds/orbit/operator.ts';
import { describeOrbitTruth } from '../src/worlds/orbit/describe.ts';
import { environmentOf, setupWithSources } from '../src/worlds/orbit/family.ts';
import type { OrbitSpec } from '../src/worlds/orbit/index.ts';
import type { MeasureDecl } from '../src/core/types.ts';
import { ROOT } from '../test/support.ts';

/* --- Configuration ---------------------------------------------------------------- */

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
const flag = (name: string): boolean => argv.includes('--' + name);
function parseTools(value: string): LawTool[] {
  if (value === 'all') return [...LAW_TOOLS];
  if (value === 'none') return [];
  const asked = value.split(',').map((t) => t.trim()).filter(Boolean).map((t) => toolOf(t) ?? t);
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
  resolution: Number(arg('resolution', '0')),
  sampling: (arg('sampling', 'free') === 'grid' ? 'grid' : 'free') as 'grid' | 'free',
  testView: Number(arg('test-view', '4')),
  testBeyond: Number(arg('test-beyond', '2')),
  every: Number(arg('every', '8')),
  accept: Number(arg('accept', '2')),
  precision: Number(arg('precision', '0.01')),
  delegated: flag('delegated'),
  quick: flag('quick'),
  ablation: !flag('no-ablation') && !flag('quick'),
  grade: !flag('no-grade'),
  reflection: !flag('no-reflection') && !flag('quick'),
  flat: flag('flat'),
  tools: parseTools(arg('tools', 'all')),
  labs: Math.max(1, Number(arg('labs', '1'))),
  family: Math.max(1, Number(arg('family', '4'))),
  validations: Math.max(1, Number(arg('validations', '3'))),
  confirmSetups: Math.max(1, Number(arg('confirm-setups', '3'))),
  varyStrength: flag('vary-strength')
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

/* The family's setups by name: lab<k> are the learner's (index 0 is the base world); tests and confirmations draw
   setups it never saw. The launched body keeps its symbol in every setup. */
interface Setup { readonly id: string; readonly spec: OrbitSpec; role: 'laboratory' | 'family' | 'confirmation'; seen: boolean }
const setups = new Map<string, Setup>();
function setupOf(id: string, index: number, role: Setup['role']): Setup {
  if (!setups.has(id)) setups.set(id, { id, spec: environmentOf(spec, index, { varyStrength: cfg.varyStrength }), role, seen: role === 'laboratory' });
  return setups.get(id)!;
}
/* The laboratories to start with: the base world, then (with --labs > 1) setups with two and three bodies. */
for (let k = 0; k < cfg.labs; k++) setupOf('lab' + (k + 1), k === 0 ? 0 : setupWithSources(spec, Math.min(3, k + 1), 1, { varyStrength: cfg.varyStrength }), 'laboratory');
/* The family to validate against: a finite set, with every number of bodies represented. Unseen until a validation. */
for (let j = 0; j < cfg.family; j++) setupOf('setup' + (j + 1), setupWithSources(spec, [2, 3, 1][j % 3], 1000 + j * 50, { varyStrength: cfg.varyStrength }), 'family');
const senseOf = (s: OrbitSpec, whole = false) => tableSense(s, { resolution: cfg.resolution, ...(whole ? { window: false } : {}) });
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
const evaluator = new Evaluator<OrbitPoint>(observer, judge, { maximizer: 'nature', runners: [runner] });
const predictor = new Predictor<OrbitPoint>(evaluator, perceivePoint, { runners: [runner], answer: (a, point) => answerAsDeparture(a, point) });
const llm = openAiChatClient({ url: env.LLM_URL, apiKey: env.LLM_KEY, model: env.LLM_MODEL, jsonMode: true, temperature: 0.4, timeoutMs: 180000, retries: 1 });

/* --- The journal ------------------------------------------------------------------ */

const started = new Date();
const outFile = arg('out', path.join(ROOT, 'runs', 'orbit-s' + cfg.seed + 'L' + cfg.level + '-' + started.toISOString().replace(/[:.]/g, '-') + '.json'));
fs.mkdirSync(path.dirname(outFile), { recursive: true });
const truth = describeOrbitTruth(spec, sense, { varyStrength: cfg.varyStrength });
const journal: Record<string, any> = {
  experiment: 'orbit@1', started: started.toISOString(), config: { ...cfg, llm_model: env.LLM_MODEL, jev_model: env.JEV_MODEL ?? null },
  hidden_from_the_learner: { spec, generator: report, law: lawSummary(spec), truth, glyphs: { sources: sense.sourceGlyphs, probe: sense.probeGlyph },
    setups: [...setups.values()].map((s) => ({ id: s.id, role: s.role, sources: s.spec.sources, frame: s.spec.frame })) },
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
  /** The setup it was launched in. */
  readonly setup: string;
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

function store(id: string, setup: Setup, round: number, by: string, trajectory: Trajectory, whole = false): StoredLaunch {
  const frame = setup.spec.frame;
  const table = senseOf(setup.spec, whole).render(trajectory);
  const p = toPercept.pos(frame, trajectory.launch.pos), v = toPercept.vel(frame, trajectory.launch.vel);
  const s: StoredLaunch = { id, setup: setup.id, round, by, trajectory, table, launch: { x: round2(p[0]), y: round2(p[1]), vx: round2(v[0]), vy: round2(v[1]), m: trajectory.launch.mass } };
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

/** What the next row of the last pair showed at a point, when the rows around it are seen. */
function observedNext(ref: string): Vec2 | null {
  const m = /^(.+)@(\d+)$/.exec(ref.trim());
  const l = m ? launches.get(m[1]) : undefined;
  if (!m || !l) return null;
  const i = Number(m[2]);
  const probe = readTable(l.table).series[sense.probeGlyph];
  const xs = [probe.x[i - 1], probe.x[i], probe.x[i + 1]], ys = [probe.y[i - 1], probe.y[i], probe.y[i + 1]];
  if (i < 1 || [...xs, ...ys].some((v) => v === null || v === undefined)) return null;
  return [round2(xs[2]!), round2(ys[2]!)];
}

/** The index of launches, as the notebook shows it. */
const launchIndex = () => [...launches.values()].map((l) => ({ episode: l.id, place: l.setup, round: l.round, by: l.by, from: l.launch, steps: l.trajectory.states.length }));

/* The environment launches a few bodies in each laboratory setup before the first proposal. */
function explore(): void {
  const rnd = mulberry32(cfg.seed * 1013 + cfg.level);
  const labs = [...setups.values()].filter((s) => s.role === 'laboratory');
  for (let i = 0; launchCounter < cfg.explore && i < cfg.explore * 40; i++) {
    const setup = labs[launchCounter % labs.length];
    const launch = launchNear(setup.spec, rnd, 2 * spec.collide + rnd() * (spec.window - 2 * spec.collide), 1);
    if (!launchable(setup.spec, launch.pos)) continue;
    const id = 'ep' + (++launchCounter);
    store(id, setup, 0, 'the environment', simulate(setup.spec, id, launch));
    log('exploration_launch', { launch: id, setup: setup.id });
  }
}

/* --- Laws and rounds ------------------------------------------------------------- */

interface LawRecord {
  readonly round: number;
  readonly law: Law;
  readonly fingerprint: string;
  /** Operator only: the test's error and score, never shown to System 2. */
  test: { error: number; median: number; score: number } | null;
  accepted: boolean;
  /** System 2 asked to validate this law against the family. */
  readonly validate: boolean;
  readonly lessons: string[];
  readonly nextExperiment: string;
}
const laws: LawRecord[] = [];
const fingerprint = (law: Law) => hashString(stableStringify(ownLaw(law))).slice(0, 10);
/** Operator only: the law whose verdicts were best. System 2 builds on its latest law, or any it names. */
const bestForOperator = (): LawRecord | null => laws.filter((l) => l.test).reduce<LawRecord | null>((a, b) => (!a || b.test!.score < a.test!.score ? b : a), null);
const latest = (): LawRecord | null => laws[laws.length - 1] ?? null;
const lawOfRound = (round: number): Law | null => laws.find((l) => l.round === round)?.law ?? null;

const notebook = new Notebook();
let unaddressed: string[] = [];
function notebookBrief(): Record<string, unknown> {
  const { episodes: _g, models: _r, ...own } = notebook.brief(unaddressed) as Record<string, unknown>;
  const last = laws[laws.length - 1];
  return {
    ...own,
    episodes: launchIndex(),
    models: laws.map((l) => ({ round: l.round, fingerprint: l.fingerprint, model: ownLaw(l.law), accepted: l.accepted })),
    ...(last ? { your_last_lessons: last.lessons, your_planned_next_experiment: last.nextExperiment } : {})
  };
}

/* --- Checks: in the laboratories every round; in the family when System 2 validates -------------------- */

let lastTest: unknown = null;
/** Operator: the main evaluator's cumulative questions to Jev, live against answered from the cache (same observation vector). */
const cacheStats = () => ({ live: evaluator.stats.judgeCalls, hits: evaluator.stats.vectorHits,
  hit_rate: round2(evaluator.stats.vectorHits / Math.max(1, evaluator.stats.judgeCalls + evaluator.stats.vectorHits)) });
/** Every point checked so far, by round: the rows `table` can show "on tests". */
const testPoints = new Map<number, PredictionSample<OrbitPoint>[]>();
let validationsLeft = cfg.validations;

interface CheckSet { readonly samples: PredictionSample<OrbitPoint>[]; readonly noise: number }

/** Fresh launches in some setups: --test-view in view and --test-beyond beyond, per setup. With `name`, they are stored as the
    learner's launches ("<name>-<k>", in their setup) to study afterwards; without, they stay unseen (blind confirmation). */
function launchesIn(list: readonly Setup[], attempt: number, round: number, name?: (setup: Setup) => string): CheckSet {
  const samples: PredictionSample<OrbitPoint>[] = [];
  const all: { spec: OrbitSpec; tr: Trajectory }[] = [];
  list.forEach((setup, j) => {
    trialLaunches(setup.spec, { sampling: cfg.sampling, attempt: attempt * 16 + j, inView: cfg.testView, beyond: cfg.testBeyond }).forEach((tr, k) => {
      const id = name ? name(setup) + '-' + (k + 1) : setup.id + '/' + k;
      if (name) store(id, setup, round, 'the check of round ' + round, tr, Math.hypot(tr.launch.pos[0], tr.launch.pos[1]) > spec.window);
      all.push({ spec: setup.spec, tr });
      for (const s of predictionSamples(setup.spec, [tr], { resolution: cfg.resolution, every: cfg.every })) samples.push({ ...s, ref: id + '@' + s.state.row, group: setup.id });
    });
  });
  if (name) testPoints.set(round, [...(testPoints.get(round) ?? []), ...samples]);
  return { samples, noise: pooledNoise(all) };
}

function pooledNoise(all: readonly { spec: OrbitSpec; tr: Trajectory }[]): number {
  let sum = 0, n = 0;
  for (const { spec: s, tr } of all) { const v = observedNoiseVariance(s, [tr], { resolution: cfg.resolution }); sum += v * s.sources.length; n += s.sources.length; }
  return n ? sum / n : 0;
}

async function evaluate(law: Law, set: CheckSet): Promise<{ result: TestResult; calls: number; set: CheckSet }> {
  const before = judge.stats.calls;
  const result = await testPredictions(set.samples, async (x) => (await predictor.predict(law, x)).vector, { noiseVariance: set.noise, relativePrecision: cfg.precision });
  return { result, calls: judge.stats.calls - before, set };
}

/** The criterion, a researcher's, per setup: in each band, the law's residuals are compatible with the noise of what is
    observed and a declared precision - the median over points of |observed d - predicted d|² / (2 (σ² + (ε|d|)²)) is at
    most --accept, σ estimated from the motionless sources. Nothing hidden enters it; every point weighs the same. */
function heldIn(result: TestResult, setupIds: readonly string[], set: CheckSet): Record<string, boolean> {
  /* A point where the law threw counts against its setup. */
  const groupOf = new Map(set.samples.map((x) => [x.ref, x.group]));
  const failed = new Set(result.failed.map((f) => groupOf.get(f.ref)));
  return Object.fromEntries(setupIds.map((id) => {
    const bands = result.chi2?.byGroup[id];
    return [id, !!bands && !failed.has(id) && Object.values(bands).every((m) => m <= cfg.accept)];
  }));
}
const allHeld = (held: Record<string, boolean>) => Object.values(held).every(Boolean);

/** A blind confirmation: two sets of setups nobody has seen, never shown to the learner nor stored as its launches. */
async function confirmBlind(law: Law, round: number): Promise<{ ok: boolean; sets: { result: TestResult; ok: boolean }[]; calls: number }> {
  let calls = 0;
  const sets: { result: TestResult; ok: boolean }[] = [];
  for (const offset of [100000, 200000]) {
    const list = Array.from({ length: cfg.confirmSetups }, (_, j) => ({ id: 'blind' + (offset + round * 10 + j), spec: environmentOf(spec, offset + round * 10 + j, { varyStrength: cfg.varyStrength }), role: 'confirmation' as const, seen: false }));
    const e = await evaluate(law, launchesIn(list, offset + round, round));
    calls += e.calls;
    sets.push({ result: e.result, ok: allHeld(heldIn(e.result, list.map((x) => x.id), e.set)) });
  }
  return { ok: sets.every((x) => x.ok), sets, calls };
}

/** What System 2 learns of a check: per setup, whether the law holds there, and the verdict at every point. Facts only. */
function describeCheck(result: TestResult, held: Record<string, boolean>): unknown {
  const byLaunch = new Map<string, { point: string; verdict: number[] }[]>();
  for (const x of result.samples) {
    const id = x.ref!.split('@')[0];
    byLaunch.set(id, [...(byLaunch.get(id) ?? []), { point: x.ref!, verdict: x.score.map((v) => Math.round(v * 1000) / 1000) }]);
  }
  return Object.entries(held).map(([setup, holds]) => ({ place: setup, your_model_holds_here: holds,
    episodes: [...byLaunch.entries()].filter(([id]) => launches.get(id)?.setup === setup).map(([id, points]) => ({ episode: id, from: launches.get(id)!.launch, points })) }));
}

/** What the operator keeps of a test result. */
const operatorView = (r: TestResult) => ({ chi2: r.chi2, error: round2(r.error), median: round2(r.median), by_band: r.byBand, noise_floor: r.floor, hidden_law: r.reference,
  truth_error: r.truthError, scores: r.scores, points: r.samples.length });
const chi2Text = (r: TestResult) => (r.chi2 ? Object.entries(r.chi2.byGroup).map(([g, bands]) => g + ' ' + Object.values(bands).map((m) => round2(m)).join('/')).join(', ') : '-');
const labs = () => [...setups.values()].filter((x) => x.role === 'laboratory');

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
  return [...launches.values()].filter((l) => l.by === 'you' || l.by === 'the environment').flatMap((l) =>
    predictionSamples(setups.get(l.setup)!.spec, [l.trajectory], { resolution: cfg.resolution, every: 4 }).map((s) => ({ ...s, ref: l.id + '@' + s.state.row })));
}

async function ablate(law: Law, round: number, lawResult: TestResult): Promise<void> {
  const samples = lawResult.samples.map((r) => testPoints.get(round)!.find((x) => x.ref === r.ref)!).filter(Boolean);
  const fitOn = ownSamples();
  const arms: Record<string, unknown> = { law: { error: round2(lawResult.error), median: round2(lawResult.median), truth_error: lawResult.truthError !== null ? round2(lawResult.truthError) : null, by_band: lawResult.byBand, score: round2(lawResult.scores.law), hidden_law_score: lawResult.scores.reference } };
  const summary = (r: TestResult) => ({ error: round2(r.error), median: round2(r.median), truth_error: r.truthError !== null ? round2(r.truthError) : null, by_band: r.byBand, score: round2(r.scores.law) });
  arms.judge_asked = asksJudge(law);
  arms.output_in_code = !!law.output;
  if (cfg.ablation && fitOn.length && asksJudge(law)) {
    const codeOnly = fitLawCodeOnly(predictor, law, fitOn);
    const flat = fitLawCodeOnly(predictor, law, fitOn, { flat: true });
    arms.code_only = { ...summary(await testPredictions(samples, codeOnly.predict)), coefficients: codeOnly.coefficients };
    arms.flat = summary(await testPredictions(samples, flat.predict));
  }
  if (cfg.delegated && asksJudge(law)) {
    const d = delegatedLaw(law);
    arms.delegated = summary(await testPredictions(samples, async (s) => (await predictor.predict(d, s, { measure: law.observations })).vector));
  }
  log('ablation', { round, fitted_on_points: fitOn.length, arms });
  say('  ablation (score): law ' + round2(lawResult.scores.law) + (arms.code_only ? ', code only ' + (arms.code_only as { score: number }).score : '') + (arms.flat ? ', flat ' + (arms.flat as { score: number }).score : '') +
    (arms.delegated ? ', delegated ' + (arms.delegated as { score: number }).score : ''));
}

/* --- Investigation ------------------------------------------------------------------ */

const lawOf = (ref: number | Law | null): Law | null => (ref === null ? latest()?.law ?? null : typeof ref === 'number' ? lawOfRound(ref) : ref);

/** A law's observations and output must compute on points of the learner's own episodes before anything uses it (the output
    is tried with every rule answering 0.5: no Judge call). */
function checkOnPoints(law: Law): string[] {
  const points = [...launches.values()].filter((l) => l.by === 'you' || l.by === 'the environment').slice(-4).flatMap((l) => {
    const n = l.table.split('\n').length - 2;
    return [2, Math.floor(n / 2), n - 1].map((row) => resolve(l.id + '@' + row)).filter((p): p is OrbitPoint => !!p);
  });
  const errors = replayOnEvidence(observer, law.observations, points.map((state) => ({ state }))).errors.slice(0, 4).map((e) => (e.observation ?? '') + ': ' + e.error);
  if (!errors.length) {
    const neutral = Object.fromEntries(Object.keys(law.rules).map((id) => [id, 0.5]));
    for (const p of points.slice(0, 6)) {
      try { predictor.answerWith(law, predictor.measured(law, p), neutral); } catch (e) { errors.push('output: ' + String((e as Error).message ?? e)); break; }
    }
  }
  return errors;
}

async function runRequest(req: LawRequest, budget: { launches: number }): Promise<unknown> {
  const kind = (['view', 'inspect', 'act', 'measure', 'simulate', 'table'] as const).find((k) => k in req)!;
  if (!tools.has(kind)) return { [kind]: (req as Record<string, unknown>)[kind], error: '"' + kind + '" is not available in this experiment' };
  if ('view' in req) {
    const l = launches.get(req.view);
    if (!l) return { view: req.view, error: 'no such episode' };
    const lines = l.table.split('\n');
    return { view: l.id, rows_in_table: lines.length - 1, table: [lines[0], ...lines.slice(1 + Math.max(0, req.from), 2 + Math.max(0, req.to))].join('\n') };
  }
  if ('act' in req) {
    if (budget.launches <= 0) return { act: req.act, error: 'no acts left this round' };
    const setup = setups.get(req.act.setup ?? 'lab1');
    if (!setup || setup.role !== 'laboratory') return { act: req.act, error: 'you can act only in your laboratories: ' + [...setups.values()].filter((s) => s.role === 'laboratory').map((s) => s.id).join(', ') };
    const pos = fromPercept.pos(setup.spec.frame, [req.act.x, req.act.y]);
    /* The environment answers only whether it accepted: never why not. */
    if (!launchable(setup.spec, pos)) return { act: req.act, accepted: false };
    budget.launches--;
    const id = 'act' + (++launchCounter);
    const l = store(id, setup, currentRound, 'you', simulate(setup.spec, id, { pos, vel: fromPercept.vel(setup.spec.frame, [req.act.vx, req.act.vy]), mass: req.act.m }));
    const lines = l.table.split('\n');
    return { act: req.act, accepted: true, name: id, rows_in_table: lines.length - 1, table: lines.slice(0, 61).join('\n'), ...(lines.length > 61 ? { more: 'view it for the rest' } : {}) };
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
    if (!law) return { inspect: req.inspect, error: 'there is no model yet: name a draft' };
    if (!p) return { inspect: req.inspect, error: 'no such point' };
    const failures = typeof req.law === 'object' && req.law ? checkOnPoints(law) : [];
    if (failures.length) return { inspect: req.inspect, error: 'your draft failed on points of your episodes: ' + failures.join(' | ') };
    try {
      const pr = await predictor.predict(law, p);
      return {
        inspect: req.inspect, your_observations_measured: pr.observations,
        ...(pr.evaluation ? { each_rule_answered: Object.fromEntries(Object.entries(pr.rules).map(([id, v]) => [id, round2(v)])), V: pr.V } : { the_judge_was_not_asked: true }),
        your_answer: pairOf(pr.answer).map(round2), ...(Object.keys(pr.parts).length ? { your_output_also_returned: pr.parts } : {}),
        the_next_row_showed: observedNext(req.inspect)
      };
    } catch (e) { return { inspect: req.inspect, error: String((e as Error).message ?? e) }; }
  }
  if ('simulate' in req) {
    const law = lawOf(req.law);
    const start = resolve(req.simulate);
    if (!law) return { simulate: req.simulate, error: 'there is no model yet: name a draft' };
    if (!start || start.row < 1) return { simulate: req.simulate, error: 'no such point (it needs a step with a step before it)' };
    const failures = typeof req.law === 'object' && req.law ? checkOnPoints(law) : [];
    if (failures.length) return { simulate: req.simulate, error: 'your draft failed on points of your episodes: ' + failures.join(' | ') };
    const [id] = req.simulate.split('@');
    const observed = readTable(launches.get(id)!.table);
    const lines = start.table.split('\n');
    const rows: unknown[] = [];
    try {
      for (let k = 0; k < req.rows; k++) {
        const now = readTable(lines.join('\n'));
        const i = now.t.length - 1;
        const pr = await predictor.predict(law, { table: lines.join('\n'), row: i });
        /* The model's answer is the next row of the last pair. */
        const next: Vec2 = pairOf(pr.answer);
        const t = now.t[i] + (now.t[i] - now.t[i - 1]);
        /* The same format as the tables: the other columns keep their last values, then the model's answer. */
        const others = now.symbols.filter((g) => g !== sense.probeGlyph);
        const cells = [t.toFixed(3).padStart(10), ...others.flatMap((g) => [now.series[g].x[i], now.series[g].y[i]].map((v) => (v ?? 0).toFixed(6).padStart(13))),
          next[0].toFixed(6).padStart(13), next[1].toFixed(6).padStart(13)];
        lines.push(cells.join(''));
        const seen = observed.series[sense.probeGlyph];
        rows.push({ step: i + 1, simulated: next.map(round2), observed: seen.x[i + 1] !== undefined && seen.x[i + 1] !== null ? [seen.x[i + 1], seen.y[i + 1]] : null });
      }
    } catch (e) { return { simulate: req.simulate, error: String((e as Error).message ?? e), steps: rows }; }
    return { simulate: req.simulate, steps: rows };
  }
  /* table: the points of its launches or of the tests, the code's value, and the residual of its latest law there. */
  const law = latest()?.law ?? null;
  const decl: MeasureDecl = { spec: { kind: 'code', lang: 'js', source: req.table.source }, range: req.table.range };
  const samples = req.on === 'checks' ? [...testPoints.values()].flat().slice(-60) : ownSamples().slice(-60);
  const rows: unknown[] = [];
  for (const s of samples) {
    const o = observer.observe(s.state, { m: decl });
    const err = o.errors.find((e) => e.id === 'm');
    let residual: unknown = null;
    if (law) {
      try {
        const pr = await predictor.predict(law, s.state);
        /* observed next - answer = observed d - predicted d: the same numbers, in the learner's terms. */
        const r: Vec2 = [s.target[0] - pr.vector[0], s.target[1] - pr.vector[1]];
        residual = { next_row_minus_your_answer: r.map(round2), verdict: scoreOf(pr.vector, s.target).map((v) => Math.round(v * 1000) / 1000) };
      } catch (e) { residual = { error: String((e as Error).message ?? e) }; }
    }
    rows.push({ point: s.ref, ...(err ? { error: err.error } : { value: o.values.m }), the_next_row_showed: departureAsNext(s.target, s.state).map(round2), residual });
  }
  return { table: req.table.source, on: req.on, residuals_of: law ? 'your latest model' : 'no model yet', rows };
}

/* --- Consulting System 2 ------------------------------------------------------------- */

const REFLECTION_TASK = reflectionTask(investigative);

let currentRound = 0;
let llmFatal: string | null = null;

async function consult(mode: 'propose' | 'reflect'): Promise<LawRecord | null> {
  if (llmFatal) return null;
  currentRound++;
  const round = currentRound;
  const b = latest();
  let refused: string[] = [];
  const investigation: unknown[] = [];
  let steps = 0, refusals = 0;
  const budget = { launches: cfg.launches };
  while (refusals < 3 && steps <= cfg.steps + 3) {
    const stepsLeft = investigative ? Math.max(0, cfg.steps - steps) : 0;
    const payload = lawExplorerPayload({
      round, perceptDoc: ORBIT_PERCEPT_DOC, notebook: notebookBrief(), law: b?.law ?? null, lawRound: b?.round ?? null,
      setups: [...setups.values()].filter((x) => x.role !== 'confirmation' && (x.role === 'laboratory' || x.seen)).map((x) => ({ place: x.id, role: x.role === 'laboratory' ? 'your laboratory: you can act here' : 'a place where your model was validated' })),
      validationsLeft,
      lastTest, ...(investigative ? { investigation, stepsLeft } : {}), ...(tools.has('act') ? { launchesLeft: budget.launches } : {}),
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
      /* Echoed in the prompt's words, and a draft as it wrote it, never as the host's objects. */
      const modelOf = (l: number | Law | null) => (l !== null && typeof l === 'object' ? ownLaw(l) : l);
      const asWritten = turn.requests.map((r) => 'simulate' in r ? { simulate: r.simulate, model: modelOf(r.law), steps: r.rows }
        : 'inspect' in r ? { inspect: r.inspect, model: modelOf(r.law) }
        : 'act' in r ? { act: (({ setup, ...rest }) => ({ ...rest, ...(setup ? { place: setup } : {}) }))(r.act) } : r);
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
      refused = ['your model failed on points of your episodes: ' + failures.join(' | ')]; refusals++;
      log('proposal_refused', { round, errors: refused, content });
      say('  refused: ' + refused[0].slice(0, 200));
      continue;
    }
    const p = parsed.proposal;
    const stances = notebook.applyStances(round, p.beliefs);
    unaddressed = stances.unaddressed;
    const record: LawRecord = { round, law: p.law, fingerprint: fingerprint(p.law), test: null, accepted: false, validate: p.validate, lessons: p.lessons, nextExperiment: p.nextExperiment };
    laws.push(record);
    log('proposal', { round, investigation_steps: investigation.length, rationale: p.rationale, beliefs: p.beliefs, notes: turn.notes, law: ownLaw(p.law),
      fingerprint: record.fingerprint, lessons: p.lessons, next_experiment: p.nextExperiment, warnings: [...p.warnings, ...stances.warnings, ...noteWarnings] });
    say('  proposes: ' + Object.keys(p.law.observations).length + ' observations, ' + Object.keys(p.law.rules).length + ' rules' + (p.law.output ? ', output in code' : '') +
      '; beliefs ' + p.beliefs.map((x) => x.id + ':' + x.stance).join(' '));
    return record;
  }
  log('no_proposal', { round, refusals });
  return null;
}

/* --- Operator-only grading ------------------------------------------------------------ */

async function gradeRecovery(): Promise<void> {
  const final = accepted ?? latest();
  const brief = notebook.brief();
  const learned = { final_law: final ? ownLaw(final.law) : null, beliefs: brief.beliefs_held, dropped: brief.beliefs_dropped, notes: brief.notes, reflections: notebook.reflections };
  const system = 'You grade how well a learner recovered the hidden law of motion of an environment it could only perceive as tables of positions. '
    + 'The learner predicts d: how the next position of the launched body departs from repeating its last step. '
    + 'For each TRUE statement, decide from the learner\'s own law and words whether it stated it: "exact" (the same claim; numbers within about 10%), '
    + '"partial" (the right idea but incomplete, or numbers off by more than that), "wrong" (it states something that contradicts it), or "absent" (nothing about it). '
    + 'The learner answers the next row of the launched body\'s columns, so d = its answer - 2·p(now) + p(previous). Read its law as code: what its observations, rules and output compute is what it claims. Judge what it holds, not what it dropped. Quote the learner briefly as evidence. '
    + 'Separate the learner\'s FORCE LAW (how the pull depends on where the body is) from how it carries that pull over a row: integrating the motion within a row, or fitting the body\'s current velocity to do so, is kinematics, not a term of the law that depends on speed. '
    + 'Judge a formula\'s form over the whole range of distances: a different function that agrees with the true one only over part of the range (e.g. a softened power whose exponent drifts with distance) is "partial", not "exact". '
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
/** --quick: the law System 2 judged good, where the run stopped. */
let satisfied: LawRecord | null = null;
for (let attempt = 1; attempt <= cfg.attempts && !llmFatal; attempt++) {
  const record = await consult('propose');
  if (!record) { if (llmFatal) break; continue; }
  const round = record.round;
  /* 1. The check in the laboratories, on launches there it has not seen. */
  const inLabs = labs();
  const labCheck = await evaluate(record.law, launchesIn(inLabs, round, round, (x) => 'check' + round + '-' + x.id));
  const labHeld = heldIn(labCheck.result, inLabs.map((x) => x.id), labCheck.set);
  record.test = { error: labCheck.result.error, median: labCheck.result.median, score: labCheck.result.scores.law };
  let validation: Record<string, unknown> | null = null;
  let validationView: unknown = null;
  let ok = false;
  /* --quick: System 2 judges its law good; stop here, before any validation, to analyze the run. */
  const quickStop = cfg.quick && record.validate;
  /* 2. The validation, when System 2 asks for it and its law holds where it was born. */
  if (record.validate && !quickStop) {
    if (!allHeld(labHeld)) validationView = { refused: 'your model does not yet hold in every one of your laboratories: nothing was spent' };
    else if (validationsLeft <= 0) validationView = { refused: 'you have no validations left' };
    else {
      validationsLeft--;
      const family = [...setups.values()].filter((x) => x.role === 'family');
      for (const x of family) x.seen = true;
      const famCheck = family.length ? await evaluate(record.law, launchesIn(family, 5000 + round, round, (x) => 'valid' + round + '-' + x.id)) : null;
      const famHeld = famCheck ? heldIn(famCheck.result, family.map((x) => x.id), famCheck.set) : {};
      /* A setup where the law does not hold becomes a laboratory. */
      const becameLabs = family.filter((x) => !famHeld[x.id]).map((x) => { x.role = 'laboratory'; return x.id; });
      validationView = { validated_in: famCheck ? describeCheck(famCheck.result, famHeld) : [], ...(becameLabs.length ? { now_your_laboratories: becameLabs } : {}) };
      validation = { family: famCheck ? { held: famHeld, ...operatorView(famCheck.result) } : null, became_laboratories: becameLabs };
      say('  validation (' + (cfg.validations - validationsLeft) + '/' + cfg.validations + '): family ' + (famCheck ? chi2Text(famCheck.result) : '-') + (becameLabs.length ? '; now laboratories: ' + becameLabs.join(', ') : ''));
      /* 3. It holds everywhere: the blind confirmation decides. */
      if (!becameLabs.length) {
        const c = await confirmBlind(record.law, round);
        ok = c.ok;
        validation.blind_confirmation = { confirmed: c.ok, sets: c.sets.map((x) => ({ ok: x.ok, ...operatorView(x.result) })), jev_calls: c.calls };
        say('  holds in every setup of the family; blind confirmation: ' + c.sets.map((x) => '[' + chi2Text(x.result) + ']').join(' ') + (c.ok ? ' CONFIRMED' : ' NOT confirmed'));
      }
    }
  }
  record.accepted = ok;
  lastTest = { round, laboratories: describeCheck(labCheck.result, labHeld), ...(validationView ? { validation: validationView } : {}), accepted: ok, validations_left: validationsLeft };
  log('check', { round, laboratories: { held: labHeld, ...operatorView(labCheck.result) }, asked_to_validate: record.validate, ...(validation ? { validation } : validationView ? { validation: validationView } : {}), accepted: ok,
    jev: { calls: judge.stats.calls, errors: judge.stats.errors, check_calls: labCheck.calls, calls_per_point: round2(labCheck.calls / Math.max(1, labCheck.result.samples.length)), cache: cacheStats() },
    /* What Jev's cache is keyed on besides the observation vector: the law's observations and rules. Unchanged across rounds,
       recurring points (--sampling grid) can hit; changed, nothing from earlier rounds can. */
    judgment_hash: judgmentHash(lawFormula(record.law)),
    abstraction: abstractionOf(record.law, testPoints.get(round) ?? []) });
  say('  check in the laboratories: ' + chi2Text(labCheck.result) + ' (accept <= ' + cfg.accept + '; operator: hidden law ' + round2(labCheck.result.scores.reference ?? 0) + ' vs law ' + round2(labCheck.result.scores.law) + ')' +
    (record.validate && !validation && !quickStop ? '; validation refused' : '') + (ok ? '  ACCEPTED' : ''));
  if (quickStop) {
    satisfied = record;
    log('quick_stop', { round, held_in_laboratories: labHeld, law: ownLaw(record.law) });
    say('  --quick: System 2 judges its law good in round ' + round + ' (in its laboratories: ' + (allHeld(labHeld) ? 'holds' : 'does NOT hold') + '); stopping without validation');
    break;
  }
  if (cfg.ablation || cfg.delegated) await ablate(record.law, round, labCheck.result);
  if (ok) { accepted = record; log('accepted', { round }); break; }
}

if (cfg.reflection && !llmFatal) {
  say('reflection round: the law is final; System 2 looks back');
  await consult('reflect');
}
if (cfg.grade && !llmFatal) await gradeRecovery();
const final = accepted ?? latest();
const top = bestForOperator();
log('end', {
  stoppedBy: llmFatal ? 'llm_error' : accepted ? 'accepted' : satisfied ? 'quick_stop' : 'budget', ...(llmFatal ? { llm_error: llmFatal } : {}),
  final: final ? { round: final.round, fingerprint: final.fingerprint, test: final.test, law: ownLaw(final.law) } : null,
  best_for_the_operator: top ? { round: top.round, fingerprint: top.fingerprint, test: top.test } : null,
  notebook, launches: launchIndex(), jev: { calls: judge.stats.calls, errors: judge.stats.errors, cache: cacheStats() }
});
if (satisfied) say('the law System 2 judged good (round ' + satisfied.round + '):\n' + JSON.stringify(ownLaw(satisfied.law), null, 2));
say('done: ' + (accepted ? 'accepted in round ' + accepted.round : satisfied ? 'stopped by --quick in round ' + satisfied.round : 'not accepted; best score ' + (top?.test ? round2(top.test.score) : '-')) + '; journal ' + outFile);
