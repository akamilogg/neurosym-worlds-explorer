import { createHash } from 'node:crypto';
import { unknownFields, type Lab, type LabContext } from '../../learn/lab.ts';
import { INVESTIGATION_TOOLS as INVESTIGATION, type WorldInterface } from '../../learn/prompt.ts';
import { objectiveLines, type AnswerForm, type Objective, type Place } from '../../learn/objective.ts';
import type { World } from '../../core/types.ts';
import { ArtifactWorld, type Episode as RunsData } from '../../artifacts/world.ts';
import { processSandbox } from '../../artifacts/sandbox.ts';
import { dedupTask } from '../../artifacts/tasks/dedup.ts';
import type { ArtifactTask } from '../../artifacts/task.ts';

/* ============================================================================
 * The world of ARTIFACTS as a laboratory (SPEC-MUNDO-ARTEFACTOS, plan step 3): the researcher changes
 * an artifact and runs its versions, and its MODEL is of the artifact's behaviour - at a point, one
 * run of a version on a workload, it predicts the task's metric from what is known BEFORE the run
 * (§7): the workload's parameters and the version. What came (the metric, whether the run was
 * correct) is never in the point it predicts.
 *
 *   places     the task's families: its laboratories, the family (validation), the blind ones
 *   episodes   a VERSION (its files, read with `view`) or RUNS of a version on workloads
 *   acts       change (a patch: a new version) and run (a version on workloads of a laboratory)
 *   checks     the reference and the latest version, on fresh workloads
 *
 * Its own tests (SPEC-PRUEBAS-PROPIAS) need nothing more: a test's protocol is a run, and what its
 * model predicts there against a rival is a prediction of a change, registered before it runs. The
 * artifact's own verdict (§8) comes next, as a second protocol over `ArtifactWorld.check`.
 * ========================================================================== */

export interface ArtifactSpec { readonly world: ArtifactWorld; readonly family: string; readonly workloads: number }

/** What is known of a run before it runs (§7). */
export interface ArtifactPoint {
  readonly family: string;
  readonly workload: Readonly<Record<string, number | string | boolean>>;
  readonly version: string;
  /** The files that differ from the base, and every file's size. */
  readonly changed: readonly string[];
  readonly files: Readonly<Record<string, number>>;
}

export type ArtifactEpisode =
  | { readonly kind: 'version'; readonly version: string; readonly parent: string | null; readonly reason?: Reason; readonly lines: readonly { readonly file: string; readonly line: number; readonly text: string }[] }
  | ({ readonly kind: 'runs'; readonly points: readonly ArtifactPoint[] } & RunsData);

export interface ArtifactCase { readonly point: string; readonly state: ArtifactPoint; readonly came: { readonly metric: number | null; readonly correct: boolean } }

/** Why a change was made, written before anything of it is measured (SPEC-MUNDO-ARTEFACTOS §3): the hypothesis, and what it
    expects - or that it is exploratory, its expectation declared uncertain. */
export type Reason = { readonly why: string } & ({ readonly expect: string } | { readonly exploratory: true });

export type ArtifactAct =
  | { readonly change: { readonly from: string; readonly files: Readonly<Record<string, string | null>> } & Reason }
  | { readonly run: { readonly version: string; readonly workloads: number; readonly repetitions: number }; readonly place?: string };

const TASKS: Readonly<Record<string, (scale: number) => ArtifactTask>> = { dedup: (scale) => dedupTask({ scale }) };
/** The worlds of the specs generated in this process: the latest version made in each (what the checks run). */
const latest = new WeakMap<ArtifactWorld, string>();
const seedOf = (text: string): number => parseInt(createHash('sha256').update(text).digest('hex').slice(0, 8), 16);

function pointOf(world: ArtifactWorld, version: string, family: string, workload: ArtifactPoint['workload']): ArtifactPoint {
  const v = world.store.get(version)!, base = world.store.get(world.reference)!;
  const changed = [...new Set([...v.files.keys(), ...base.files.keys()])].filter((p) => v.files.get(p) !== base.files.get(p)).sort();
  return { family, workload, version, changed, files: Object.fromEntries([...v.files].map(([p, t]) => [p, t.length])) };
}

function runsEpisode(world: ArtifactWorld, data: RunsData): ArtifactEpisode {
  return { kind: 'runs', ...data, points: data.runs.map((r) => pointOf(world, data.version, data.family, r.workload.params)) };
}

function versionEpisode(world: ArtifactWorld, version: string, reason?: Reason): ArtifactEpisode {
  const v = world.store.get(version)!;
  const lines: { file: string; line: number; text: string }[] = [];
  for (const [file, text] of [...v.files].sort(([a], [b]) => (a < b ? -1 : 1))) text.split('\n').forEach((t, i) => lines.push({ file, line: i + 1, text: t }));
  return { kind: 'version', version, parent: v.parent, ...(reason ? { reason } : {}), lines };
}

const metricOf = (world: ArtifactWorld, r: RunsData['runs'][number]): number | null => r.outcome.metrics?.[world.task.objective.metric] ?? null;

/** The model's answer at a point: the task's metric for that run, a positive number. */
const ANSWER: AnswerForm = { form: ['YOUR ANSWER, at a point (one run of a version on a workload): the number the task measures there (see `metric`), predicted from what is known before the run.'], use: 'predict' };

function verdictForm(tolerance: number, regression?: boolean): string[] {
  return ['A VERDICT, at a point, is whether your answer was within ' + Math.round(tolerance * 100) + '% of what was measured there (a point where the run was not correct, or measured nothing, counts against you only if you answered there).',
    'Your model holds in a place when it is within that at four in five points of its check there, or more.' + (regression ? ' The points of your previous check in a laboratory are answered again there by this model, and must be too.' : '')];
}

interface ArtifactResult { readonly place: string; readonly point: string; readonly answer: unknown; readonly came: number | null; readonly within: boolean | null; readonly failed?: string }

function artifactObjective<M, P extends Place>(host: { casesIn(place: P, c: unknown): readonly ArtifactCase[] | Promise<readonly ArtifactCase[]>; answer(m: M, s: unknown): Promise<unknown>; regression?: boolean }, tolerance: number): Objective<M, P, readonly ArtifactCase[], ArtifactResult> {
  const enough = (rs: readonly ArtifactResult[]) => { const judged = rs.filter((r) => r.within !== null); return judged.length > 0 && judged.filter((r) => r.within).length >= 0.8 * judged.length; };
  return {
    answer: ANSWER,
    verdictForm: verdictForm(tolerance, host.regression),
    casesIn: (place, context) => host.casesIn(place, context),
    async run(model, cases) {
      const byPlace: ArtifactResult[][] = [];
      for (const { place, cases: points } of cases) {
        const rs: ArtifactResult[] = [];
        for (const c of points) {
          try {
            const answer = await host.answer(model, c.state);
            const within = c.came.metric === null || !c.came.correct ? null
              : typeof answer === 'number' && answer > 0 ? Math.abs(Math.log(answer / c.came.metric)) <= Math.log(1 + tolerance) : false;
            rs.push({ place: place.id, point: c.point, answer, came: c.came.metric, within });
          } catch (e) { rs.push({ place: place.id, point: c.point, answer: null, came: c.came.metric, within: false, failed: String((e as Error)?.message ?? e) }); }
        }
        byPlace.push(rs);
      }
      return { byPlace };
    },
    holds: (results, { rerun }) => enough(results) && (!rerun || enough(rerun.now)),
    view: (results) => ({ points: results.map((r) => r.failed ? { point: r.point, error: r.failed } : { point: r.point, your_answer: r.answer, measured: r.came, within: r.within }) }),
    rerunView: (rerun) => ({ points: rerun.now.length, your_model_holds_on_them: enough(rerun.now) }),
    operatorView: (results) => ({ within: results.filter((r) => r.within).length, judged: results.filter((r) => r.within !== null).length, points: results.length }),
    line: (results) => results.filter((r) => r.within).length + '/' + results.filter((r) => r.within !== null).length + ' within'
  };
}

function artifactInterface(task: ArtifactTask, tolerance: number, regression?: boolean): WorldInterface {
  const o = task.objective;
  return {
    tools: ['view', 'inspect', 'act', 'measure', 'table'],
    features: ['check'],
    lines: [
      'THE ARTIFACT: ' + task.about + '. You change it and run its versions; the version you start from is the base, also the reference every version is compared with.',
      '`metric`: ' + o.metric + ' (' + (o.direction === 'min' ? 'lower' : 'higher') + ' is better).',
      ...objectiveLines({ answer: ANSWER, verdictForm: verdictForm(tolerance, regression) }),
      'THE ARTIFACT\'S OWN VERDICT, apart from your model\'s: with your answer you may put forward a version - "artifact": "<version>" - and it is run against the reference, interleaved, on fresh workloads of each of your laboratories. '
        + 'Per place you are told whether it holds there: every run correct, ' + (o.direction === 'min' ? 'lower' : 'higher') + ' `' + o.metric + '` than the reference by at least ' + Math.round(o.margin * 100) + '% with ' + Math.round(o.confidence * 100) + '% confidence (or, where a place asks only that, not worse), and no constraint broken - never by how much. '
        + 'Where it holds in every laboratory, "validate_artifact": true takes it to places you have not seen and then to blind ones, as a model is taken. The artifact and your model are accepted apart: one may be accepted and the other not. Every version you put forward is judged against the reference, so more than one may be accepted: the last accepted is your product.',
      [INVESTIGATION, 'Requests:'],
      [['view'], '  {"view": "<episode>", "from": <step>, "to": <step>}   a stretch of one of your episodes (at most 60 rows): of a VERSION, its files\' lines; of RUNS, each run - the workload, the version, what was measured and whether it was correct'],
      [['act'], '  {"act": {"change": {"from": "<version>", "files": {"<path>": "<the file\'s whole new text>" | null}, "why": "<the hypothesis it tests>", "expect": "<what you expect of it>" | "exploratory": true}}}   a new version: the given files replaced (or removed, with null); you get it as an episode of its lines and its version name. '
        + 'Its reason is written with it, before anything of it is measured: why, and what you expect - or, when you cannot say, that it is exploratory. '
        + 'Or {"act": {"run": {"version": "<version>", "workloads": <1-4>, "repetitions": <1-3>}, "place": "<laboratory>"}}   that version on fresh workloads of one of your laboratories (default: the first): an episode of runs, each judged correct or not against the reference on the same workload. '
        + 'It may be refused, and you are not told why. At most `acts_left` this round.'],
      [['inspect'], '  {"inspect": "<episode>@<step>", "model": <round> | <draft> }   what a model answered at a run, part by part, and what was measured there'],
      [['measure'], '  {"measure": {"source": "(p) => ...", "range": [min, max]}, "on": ["<episode>@<step>", ...]}'],
      [['table'], '  {"table": {"source": "(p) => ...", "range": [min, max]}, "on": "episodes" | "checks"}   the runs of your own episodes, or of the checks, each with the value of the code and what was measured there']
    ]
  };
}

export const PERCEPT_DOC = 'At a point - one run of a version on a workload - your code receives p = { family, workload, version, changed, files }: what is known BEFORE the run. `p.workload` the workload\'s parameters; `p.version` the version\'s name; `p.changed` the files that differ from the base; `p.files` every file\'s size. What the run measured is never in its own point.';

const pointWorld = (): World<ArtifactPoint, never> => ({
  id: 'artifacts@1', actors: ['nature'],
  initial: () => { throw new Error('artifacts@1 has no initial state: points come from runs'); },
  toMove: () => 'nature', actions: () => [], step: (s) => s, outcome: () => ({ over: false, winner: null, reason: null }),
  key: (s) => s.version + '|' + JSON.stringify(s.workload), view: () => ({ entities: [], scalars: {} }), describeRules: () => '', actionKey: () => ''
});

export const artifactsLab: Lab<ArtifactSpec, ArtifactPoint, ArtifactEpisode, ArtifactCase, ArtifactAct> = {
  id: 'artifacts@1',
  about: 'System 2 changes an artifact and runs its versions, and writes a model of its behaviour: the metric of a run, from what is known before it.',
  options: [
    { name: 'artifact', default: 'dedup', help: 'the artifact and its task: ' + Object.keys(TASKS).join(', ') },
    { name: 'scale', default: '1', help: 'the size of every workload, relative' },
    { name: 'acts', default: '3', help: 'changes and runs System 2 may make per round' },
    { name: 'tolerance', default: '0.25', help: 'how far from what was measured an answer may be, relative' },
    { name: 'workloads', default: '2', help: 'fresh workloads per family in a check' }
  ],
  generate: (seed, o) => {
    const make = TASKS[o.artifact];
    if (!make) throw new Error('--artifact: no artifact task "' + o.artifact + '" (' + Object.keys(TASKS).join(', ') + ')');
    const task = make(Number(o.scale) || 1);
    const lab = task.families.find((f) => f.role === 'laboratory');
    if (!lab) throw new Error('the task has no laboratory family');
    return { world: new ArtifactWorld(task, processSandbox()), family: lab.id, workloads: Math.max(1, Math.floor(Number(o.workloads) || 2)) };
  },
  placeOf: (spec, index) => { const fam = spec.world.task.families.filter((f) => f.role === 'family'); return { ...spec, family: fam[index % Math.max(1, fam.length)]?.id ?? spec.family }; },
  places: (spec) => ({
    laboratories: spec.world.task.families.filter((f) => f.role === 'laboratory').map((f) => ({ id: f.id, spec: { ...spec, family: f.id } })),
    family: spec.world.task.families.filter((f) => f.role === 'family').map((f) => ({ id: f.id, spec: { ...spec, family: f.id } }))
  }),
  blindPlaces: (spec, set) => spec.world.task.families.filter((f) => f.role === 'blind').map((f) => ({ id: f.id + '-' + set, spec: { ...spec, family: f.id } })),
  runName: (seed, o) => 'artifacts-' + o.artifact + '-s' + seed,
  headline: (spec) => spec.world.task.id + ' (base ' + spec.world.reference + ')',
  placeInfo: (spec) => ({ family: spec.family }),
  explorationSeed: (seed) => seed * 4973 + 7,

  world: pointWorld,
  perceive: (p) => p,
  perceptDoc: PERCEPT_DOC,
  interface: (options) => artifactInterface(TASKS[options.world?.artifact ?? 'dedup']?.(Number(options.world?.scale) || 1) ?? dedupTask(), Number(options.world?.tolerance) || 0.25, options.regression),

  /* Exploration: the base, to read, and the base on the first laboratory's workloads. */
  episode: async (spec, rnd, ctx) => {
    const data = await spec.world.run(spec.world.reference, spec.family, spec.workloads, Math.floor(rnd() * 1e9), 1, ctx?.recorded);
    if ('error' in data) throw new Error(data.error);
    return runsEpisode(spec.world, data);
  },
  explore: async (laboratories, rnd, _count, ctx) => {
    const { id, spec } = laboratories[0];
    const data = await spec.world.run(spec.world.reference, spec.family, spec.workloads, Math.floor(rnd() * 1e9), 1, ctx.recorded);
    if ('error' in data) throw new Error(data.error);
    return [{ place: id, episode: versionEpisode(spec.world, spec.world.reference) }, { place: id, episode: runsEpisode(spec.world, data) }];
  },
  /* A check: the reference and the latest version, on fresh workloads of the place. */
  checkEpisodes: async (spec, c, ctx) => {
    const versions = [...new Set([spec.world.reference, latest.get(spec.world) ?? spec.world.reference])];
    const out: ArtifactEpisode[] = [];
    for (const v of versions) {
      const data = await spec.world.run(v, spec.family, spec.workloads, seedOf(c.purpose + c.round + ':' + (c.set ?? 0) + ':' + c.index + ':' + spec.family + ':' + v), 1, ctx.recorded);
      if (!('error' in data)) out.push(runsEpisode(spec.world, data));
    }
    return out;
  },
  /* The artifact's own verdict (SPEC-MUNDO-ARTEFACTOS §8): a version it puts forward against the reference, interleaved, on
     fresh workloads of the place. System 2 is told the facts - correct or not where, better or not, which constraint
     broke - never the ratio: what it measures is its own (its runs). */
  artifact: {
    known: (spec, version) => spec.world.store.get(version) !== null,
    async check(spec, version, c, ctx) {
      const fam = spec.world.task.families.find((f) => f.id === spec.family);
      const [r] = await spec.world.check(version, [spec.family], spec.workloads, seedOf('artifact:' + c.purpose + c.round + ':' + (c.set ?? 0) + ':' + c.index + ':' + spec.family + ':' + version), ctx.recorded);
      const v = r.verdict;
      const broken = v.constraints.filter((x) => !x.ok).map((x) => x.metric);
      return {
        holds: v.holds,
        view: { requires: fam?.requires ?? 'better', correct: v.correct, ...(v.incorrect.length ? { incorrect: v.incorrect } : {}),
          [fam?.requires === 'not_worse' ? 'not_worse' : 'better']: v.better, ...(broken.length ? { constraints_broken: broken } : {}) },
        journal: { family: spec.family, requires: fam?.requires ?? 'better', ...v, environment: r.environment }
      };
    }
  },
  steps: (e) => (e.kind === 'version' ? e.lines.length - 1 : e.runs.length - 1),
  indexInfo: (e) => (e.kind === 'version' ? { version: e.version, lines: e.lines.length } : { version: e.version, family: e.family, runs: e.runs.length, correct: e.runs.filter((r) => r.correct).length }),
  explored: (e) => (e.kind === 'version' ? { version: e.version } : { version: e.version, family: e.family, runs: e.runs.map((r) => ({ workload: r.workload.id, metrics: r.outcome.metrics, correct: r.correct })) }),
  at: (e, step) => (e.kind === 'runs' && step >= 0 && step < e.runs.length
    ? { state: e.points[step], shown: { measured: e.runs[step].outcome.metrics, correct: e.runs[step].correct } } : null),
  cases: (spec, id, e, every) => (e.kind !== 'runs' ? [] : e.runs.map((r, i) => ({ point: id + '@' + i, state: e.points[i], came: { metric: metricOf(spec.world, r), correct: r.correct } })).filter((_, i) => i % every === 0)),
  ownEvery: 1,
  view: (e, from, to) => (e.kind === 'version'
    ? { version: e.version, parent: e.parent, ...(e.reason ? { reason: e.reason } : {}), steps: e.lines.length - 1, rows: e.lines.slice(from, Math.min(to, from + 59) + 1).map((l, i) => ({ step: from + i, file: l.file, line: l.line, text: l.text })) }
    : { version: e.version, family: e.family, steps: e.runs.length - 1, isolated: e.isolated, environment: e.environment?.fingerprint,
      rows: e.runs.slice(from, Math.min(to, from + 59) + 1).map((r, i) => ({ step: from + i, workload: r.workload.params, repetition: r.repetition, measured: r.outcome.metrics, correct: r.correct, ...(r.why ? { why: r.why } : {}) })) }),
  shown: (c) => ({ measured: c.came.metric, correct: c.came.correct }),

  act: {
    parse: (raw) => {
      const unknown = unknownFields(raw, ['change', 'run', 'place']);
      if (unknown) return unknown;
      const c = raw.change as Record<string, unknown> | undefined, r = raw.run as Record<string, unknown> | undefined;
      if (c && typeof c === 'object') {
        const form = '"change": {"from": "<version>", "files": {"<path>": "<text>" | null}, "why": "<the hypothesis>", "expect": "<what you expect>" | "exploratory": true}';
        const extra = unknownFields(c, ['from', 'files', 'why', 'expect', 'exploratory']);
        if (extra) return extra;
        if (typeof c.from !== 'string' || !c.files || typeof c.files !== 'object') return form;
        if (typeof c.why !== 'string' || !c.why.trim()) return 'a change says why: ' + form;
        const expect = typeof c.expect === 'string' && c.expect.trim() ? c.expect : null;
        if (!expect && c.exploratory !== true) return 'a change says what it expects, or that it is exploratory: ' + form;
        return { change: { from: c.from, files: c.files as Record<string, string | null>, why: c.why, ...(expect ? { expect } : { exploratory: true as const }) } };
      }
      if (r && typeof r === 'object') {
        if (typeof r.version !== 'string') return '"run": {"version": "<version>", "workloads": <1-4>, "repetitions": <1-3>}';
        return { run: { version: r.version, workloads: Math.min(4, Math.max(1, Math.floor(Number(r.workloads) || 2))), repetitions: Math.min(3, Math.max(1, Math.floor(Number(r.repetitions) || 1))) },
          ...(typeof raw.place === 'string' ? { place: raw.place } : {}) };
      }
      return 'act needs "change" or "run"';
    },
    place: (a) => ('place' in a ? a.place : undefined),
    async start(spec, a, id, ctx?: LabContext) {
      if ('change' in a) {
        const made = spec.world.change(a.change.from, { files: a.change.files });
        if ('error' in made) return null;
        latest.set(spec.world, made.version);
        const { from: _f, files: _x, ...reason } = a.change;
        return versionEpisode(spec.world, made.version, reason);
      }
      const data = await spec.world.run(a.run.version, spec.family, a.run.workloads, seedOf(id + ':' + a.run.version + ':' + spec.family), a.run.repetitions, ctx?.recorded);
      return 'error' in data ? null : runsEpisode(spec.world, data);
    },
    shown: (e) => (e.kind === 'version' ? { version: e.version, parent: e.parent, lines: e.lines.length } : { version: e.version, family: e.family, runs: e.runs.length, correct: e.runs.filter((r) => r.correct).length }),
    asWritten: (a) => a,
    /* A run measures time: the same run twice measures twice. */
    varies: (a) => ('run' in a ? 'it measures time: the same run twice measures twice' : null),
    /* An experiment is a version run in a family (what its own tests call new or a replication). */
    identity: (spec, a) => ('run' in a ? a.run.version + '|' + spec.family : null),
    examples: (spec) => [{ run: { version: spec.world.reference, workloads: 2 } }, { change: { from: spec.world.reference, files: { 'NOTE.md': 'an example file' }, why: 'a note changes nothing it runs', expect: 'the same time' } }]
  },
  episodeIdentity: (_spec, e) => (e.kind === 'runs' ? e.version + '|' + e.family : null),

  objective: (host, options) => artifactObjective(host as never, Number(options.tolerance) || 0.25),
  answerIssue: (a) => (typeof a === 'number' && Number.isFinite(a) && a > 0 ? null : 'the answer must be a positive number (it was ' + JSON.stringify(a)?.slice(0, 60) + ')'),
  agrees: (a, c) => c.came.metric !== null && typeof a === 'number' && a > 0 && Math.abs(Math.log(a / c.came.metric)) <= Math.log(1.25),
  agreement: 'within 25%',
  baselines: () => []
};
