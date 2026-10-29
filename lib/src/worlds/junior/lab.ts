import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { unknownFields, type Lab, type LabContext } from '../../learn/lab.ts';
import { INVESTIGATION_TOOLS as INVESTIGATION, type WorldInterface } from '../../learn/prompt.ts';
import { objectiveLines, type AnswerForm, type Objective, type Place } from '../../learn/objective.ts';
import type { World } from '../../core/types.ts';
import { HOLDING, holdingShare, type LabProgress } from '../../learn/progress.ts';
import { ArtifactStore } from '../../artifacts/store.ts';
import { JuniorSessionClient } from '../../junior/client.ts';
import { competenceHash, competenceProblems, type CompetenceManifest, type Component, type Observation } from '../../junior/competence.ts';
import type { Evaluation } from '../../junior/evaluate.ts';
import { JobLedger, JobRefused } from '../../junior/jobs.ts';
import { BlobStore, checkClosed, executionHash, normalizePackage, type JuniorPackage } from '../../junior/package.ts';

/* ============================================================================
 * The world of a junior's COMPETENCE (SPEC-METAPOLITICA-APRENDIZAJE §6, §7.1): an artifact world whose artifact is the
 * junior. Its researcher - the strong model, configured as any researcher - changes the junior and runs its versions on
 * the development cases of the operator's manifest; nothing here knows what makes a junior better.
 *
 *   the artifact   the package's editable parts, versioned by content: prompt.md (its starting prompt) and decoding.json
 *   change         a patch on a version: a new junior, its reason written before anything of it is measured
 *   run            a version evaluated on the development cases (investigations as M2 trials, probes at their cuts): a
 *                  job of the world's ledger, reserved before it starts; an episode of observations
 *   exploration    the base and its BASELINE: no change is measured before it (§6.2)
 *   the model      at a point - one observation of a version at a case - the value it will measure, from what is known
 *                  before it (the version, the files it changed, the case, its component, its rung)
 *   the artifact's own verdict   paired-cases@1 against the reference junior (§6.5): promoted or not, never by how much
 *
 * The confirmation partition is never run here: it is the operator's, out of this machine (§9).
 * ========================================================================== */

const EDITABLE = ['prompt.md', 'decoding.json'] as const;

export class JuniorWorld {
  readonly manifest: CompetenceManifest;
  readonly manifestHash: string;
  readonly base: JuniorPackage;
  readonly blobs: BlobStore;
  readonly client: JuniorSessionClient;
  readonly dir: string;
  readonly store: ArtifactStore;
  readonly reference: string;
  readonly jobs: JobLedger;
  private readonly evaluations = new Map<string, Evaluation>();

  constructor(o: { manifest: CompetenceManifest; base: JuniorPackage; blobs: string; server: string; dir: string; evaluations: number; store?: ArtifactStore }) {
    const problems = competenceProblems(o.manifest);
    if (problems.length) throw new Error('the competence manifest: ' + problems.join('; '));
    this.manifest = o.manifest;
    this.manifestHash = competenceHash(o.manifest);
    this.base = normalizePackage(o.base);
    if (executionHash(this.base) !== o.manifest.reference) throw new Error('the base package is not the manifest\'s reference junior');
    this.blobs = new BlobStore(o.blobs);
    const closed = checkClosed(this.base, this.blobs);
    if (!closed.closed) throw new Error('the base package is not closed in ' + o.blobs);
    this.client = new JuniorSessionClient(o.server);
    this.dir = o.dir;
    fs.mkdirSync(o.dir, { recursive: true });
    this.store = o.store ?? new ArtifactStore(new Map([['prompt.md', this.base.prompt], ['decoding.json', JSON.stringify(this.base.decoding, null, 2) + '\n']]));
    this.reference = this.store.base;
    this.jobs = new JobLedger(path.join(o.dir, 'jobs.jsonl'), { evaluations: o.evaluations });
  }

  archive(): { base: JuniorPackage; manifest: CompetenceManifest; files: Record<string, string> } {
    return { base: this.base, manifest: this.manifest, files: Object.fromEntries(this.store.get(this.reference)!.files) };
  }

  /** The junior a version is: the base package with its editable parts, its provenance the version's line. */
  packageOf(version: string): JuniorPackage | string {
    const v = this.store.get(version);
    if (!v) return 'no version ' + version;
    let decoding: unknown;
    try { decoding = JSON.parse(v.files.get('decoding.json') ?? ''); } catch { return 'decoding.json is not JSON'; }
    try {
      return normalizePackage({ ...this.base, prompt: v.files.get('prompt.md') ?? '', decoding,
        provenance: { parents: [executionHash(this.base)], reason: 'version ' + version + ' of the junior-competence world', sources: this.store.lineage(version).map((t) => t.from + '->' + t.to) } });
    } catch (e) { return (e as Error).message; }
  }

  change(from: string, files: Readonly<Record<string, string | null>>, reason: unknown): { version: string; parent: string } | { error: string } {
    for (const f of Object.keys(files)) if (!EDITABLE.includes(f as typeof EDITABLE[number])) return { error: 'only ' + EDITABLE.join(' and ') + ' can be changed here' };
    if (Object.values(files).some((t) => t === null)) return { error: 'the junior\'s parts are changed, never removed' };
    const v = this.store.apply(from, { files }, reason);
    if (typeof v === 'string') return { error: v };
    const pkg = this.packageOf(v.hash);
    if (typeof pkg === 'string') return { error: pkg };
    return { version: v.hash, parent: from };
  }

  /** A version evaluated on the development cases: a job of the world's ledger (asked again, the same job), kept. */
  async evaluate(version: string, judge?: import('../../runtime/lab-runner.ts').LabConnection): Promise<Evaluation | string> {
    const cached = this.evaluations.get(version);
    if (cached) return cached;
    const pkg = this.packageOf(version);
    if (typeof pkg === 'string') return pkg;
    try {
      /* One job per junior evaluated: the baseline, a run and a check of the same version are the same evaluation. */
      const operation = 'eval-' + createHash('sha256').update(this.manifestHash + ':' + executionHash(pkg)).digest('hex').slice(0, 24);
      const { done } = this.jobs.start({ operation_id: operation, op: 'run', inputs: { version, execution: executionHash(pkg), manifest: this.manifestHash }, reserve: { evaluations: 1 },
        run: async (signal) => {
          /* Loaded when used: the laboratories' registry is among their imports (no cycle at load). */
          const { evaluate } = await import('../../junior/evaluate.ts');
          const { inProcessLauncher } = await import('../../meta/lab.ts');
          const e = await evaluate({ dir: this.dir, manifest: this.manifest, manifestHash: this.manifestHash, pkg, client: this.client, partition: 'development', signal,
            launcher: inProcessLauncher({ root: this.dir, llm: { url: '', model: undefined }, ...(judge ? { judge } : {}) }), ...(judge ? { judge } : {}) });
          return { spent: { evaluations: 1 }, result: { complete: e.measure.complete }, products: e };
        } });
      const job = await done;
      if (job.state !== 'completed') return 'the evaluation ' + job.state + (job.reason ? ': ' + job.reason : '');
      const e = job.products as Evaluation;
      this.evaluations.set(version, e);
      return e;
    } catch (e) { return e instanceof JobRefused ? e.message : String((e as Error).message ?? e); }
  }
}

export interface JuniorSpec { readonly world: JuniorWorld; readonly judge?: import('../../runtime/lab-runner.ts').LabConnection }

/** What is known of an observation before it is made. */
export interface JuniorPoint {
  readonly version: string;
  readonly changed: readonly string[];
  readonly case: string;
  readonly component: string;
  readonly rung: number;
  readonly lab: string;
  readonly kind: 'investigation' | 'probe';
  readonly rep: number;
}

export type JuniorEpisode =
  | { readonly kind: 'version'; readonly version: string; readonly parent: string | null; readonly reason?: unknown; readonly lines: readonly { readonly file: string; readonly line: number; readonly text: string }[] }
  | { readonly kind: 'evaluation'; readonly version: string; readonly execution: string; readonly complete: boolean; readonly points: readonly JuniorPoint[]; readonly observations: readonly Observation[];
      readonly components: readonly { readonly id: string; readonly deficit: number | null }[] };

export interface JuniorCase { readonly point: string; readonly state: JuniorPoint; readonly came: { readonly value: number | null } }

type Reason = { readonly why: string; readonly because?: readonly string[] } & ({ readonly expect: string } | { readonly exploratory: true });
export type JuniorAct =
  | { readonly change: { readonly from: string; readonly files: Readonly<Record<string, string>> } & Reason }
  | { readonly run: { readonly version: string } };

const latest = new WeakMap<JuniorWorld, string>();

function changedOf(w: JuniorWorld, version: string): string[] {
  const v = w.store.get(version)!, b = w.store.get(w.reference)!;
  return EDITABLE.filter((f) => v.files.get(f) !== b.files.get(f));
}

function versionEpisode(w: JuniorWorld, version: string, reason?: unknown, parent?: string): JuniorEpisode {
  const v = w.store.get(version)!;
  const lines: { file: string; line: number; text: string }[] = [];
  for (const file of EDITABLE) (v.files.get(file) ?? '').split('\n').forEach((t, i) => lines.push({ file, line: i + 1, text: t }));
  return { kind: 'version', version, parent: parent ?? v.parent, ...(reason ? { reason } : {}), lines };
}

function evaluationEpisode(w: JuniorWorld, version: string, e: Evaluation): JuniorEpisode {
  const comps = new Map<string, Component>(w.manifest.components.map((c) => [c.id, c]));
  const changed = changedOf(w, version);
  const points = e.observations.map((o) => {
    const c = w.manifest.cases.find((x) => x.id === o.case)!;
    return { version, changed, case: o.case, component: o.component, rung: comps.get(o.component)!.rung, lab: c.lab, kind: c.kind, rep: o.rep };
  });
  return { kind: 'evaluation', version, execution: e.execution, complete: e.measure.complete, points, observations: e.observations,
    components: e.measure.components.map((c) => ({ id: c.id, deficit: c.quality })) };
}

const ANSWER: AnswerForm = { form: ['YOUR ANSWER, at a point (one observation of a version of the junior at a case): the value it will measure there, in its component\'s unit (a share or solved: 0 to 1), predicted from what is known before.'], use: 'predict' };

function verdictForm(tolerance: number): string[] {
  return ['A VERDICT, at a point, is whether your answer was within ' + tolerance + ' of what was measured there (a point that measured nothing counts against you only if you answered there).',
    'Your model holds in a place when it is within that at four in five points of its check there, or more.'];
}

interface Result { readonly place: string; readonly point: string; readonly answer: unknown; readonly came: number | null; readonly within: boolean | null; readonly failed?: string }

function juniorObjective<M, P extends Place>(host: { casesIn(place: P, c: unknown): readonly JuniorCase[] | Promise<readonly JuniorCase[]>; answer(m: M, s: unknown): Promise<unknown> }, tolerance: number): Objective<M, P, readonly JuniorCase[], Result> {
  const enough = (rs: readonly Result[]) => { const judged = rs.filter((r) => r.within !== null); return judged.length > 0 && judged.filter((r) => r.within).length >= 0.8 * judged.length; };
  return {
    answer: ANSWER,
    verdictForm: verdictForm(tolerance),
    casesIn: (place, context) => host.casesIn(place, context),
    async run(model, cases) {
      const byPlace: Result[][] = [];
      for (const { place, cases: points } of cases) {
        const rs: Result[] = [];
        for (const c of points) {
          try {
            const answer = await host.answer(model, c.state);
            const within = c.came.value === null ? null : typeof answer === 'number' && Number.isFinite(answer) ? Math.abs(answer - c.came.value) <= tolerance : false;
            rs.push({ place: place.id, point: c.point, answer, came: c.came.value, within });
          } catch (e) { rs.push({ place: place.id, point: c.point, answer: null, came: c.came.value, within: false, failed: String((e as Error)?.message ?? e) }); }
        }
        byPlace.push(rs);
      }
      return { byPlace };
    },
    holds: (results) => enough(results),
    view: (results) => ({ points: results.map((r) => r.failed ? { point: r.point, error: r.failed } : { point: r.point, your_answer: r.answer, measured: r.came, within: r.within }) }),
    operatorView: (results) => ({ within: results.filter((r) => r.within).length, judged: results.filter((r) => r.within !== null).length, points: results.length }),
    line: (results) => results.filter((r) => r.within).length + '/' + results.filter((r) => r.within !== null).length + ' within'
  };
}

function juniorInterface(tolerance: number): WorldInterface {
  return {
    tools: ['view', 'inspect', 'act', 'measure', 'table'],
    features: ['check'],
    lines: [
      'THE JUNIOR: a small model with a memory of its own, run as the researcher of other worlds of this harness. You change its starting prompt and its decoding, and run its versions on the development cases the operator fixed: investigations in whole worlds and probes, single answers asked at a point of a run under a visible task. The version you start from is the base, also the reference every version is compared with; its evaluation is your baseline.',
      'Each observation measures one competence of the ladder: 1 protocol (an answer accepted at once), 2 requests (a request of a kind answered without error), 3 the harness\'s rules, 4 a checkable model, 6 a world solved. A component is the mean deficit of its cases, 0 at its target, 1 at its unfavourable reference.',
      ...objectiveLines({ answer: ANSWER, verdictForm: verdictForm(tolerance) }),
      'THE JUNIOR\'S OWN VERDICT, apart from your model\'s: with your answer you may put forward a version - "artifact": "<version>" - and it is compared with the reference case by case (paired-cases@1): promoted when a component improves beyond chance and no protected one gets worse beyond its tolerance. You are told the verdict and which components improve or regress - never by how much. The last version promoted is your product.',
      [INVESTIGATION, 'Requests:'],
      [['view'], '  {"view": "<episode>", "from": <step>, "to": <step>}   a stretch of one of your episodes (at most 60 rows): of a VERSION, its files\' lines; of an EVALUATION, each observation - the case, its component, its rung, what was measured'],
      [['act'], '  {"act": {"change": {"from": "<version>", "files": {"prompt.md" | "decoding.json": "<the file\'s whole new text>"}, "why": "<the hypothesis it tests>", "expect": "<what you expect of it>" | "exploratory": true}}}   a new junior; its reason is written with it, before anything of it is measured. '
        + 'Or {"act": {"run": {"version": "<version>"}}}   that version evaluated on every development case: an episode of observations. An evaluation costs one of `evaluations`; asked again for the same version it is the same. At most `acts_left` this round.'],
      [['inspect'], '  {"inspect": "<episode>@<step>", "model": <round> | <draft> }   what a model answered at an observation, part by part, and what was measured there'],
      [['measure'], '  {"measure": {"source": "(p) => ...", "range": [min, max]}, "on": ["<episode>@<step>", ...]}'],
      [['table'], '  {"table": {"source": "(p) => ...", "range": [min, max]}, "on": "episodes" | "checks"}   the observations of your episodes, or of the checks, each with the value of the code and what was measured']
    ]
  };
}

export const PERCEPT_DOC = 'At a point - one observation of a version of the junior at a case - your code receives p = { version, changed, case, component, rung, lab, kind, rep }: what is known BEFORE it is measured. `p.changed` the files of the junior that differ from the base; `p.kind` investigation or probe.';

const pointWorld = (): World<JuniorPoint, never> => ({
  id: 'junior-competence@1', actors: ['nature'],
  initial: () => { throw new Error('junior-competence@1 has no initial state: points come from evaluations'); },
  toMove: () => 'nature', actions: () => [], step: (s) => s, outcome: () => ({ over: false, winner: null, reason: null }),
  key: (s) => s.version + '|' + s.case + '|' + s.rep, view: () => ({ entities: [], scalars: {} }), describeRules: () => '', actionKey: () => ''
});

/* Its mountains (SPEC-VISTA-ESCALADA): the model's check, and the junior's verdict - how many components improve. */
export const JUNIOR_PROGRESS: LabProgress = {
  metrics: [
    HOLDING,
    { id: 'components_improved', label: 'componentes que mejoran frente a la referencia', unit: 'proporción', direction: 'higher', range: [0, 1], source: 'artifact_check' }
  ],
  sample(metric, event) {
    if (metric === HOLDING.id) return event.type === 'artifact_check' ? null : holdingShare(event);
    if (event.type !== 'artifact_check' || metric !== 'components_improved') return null;
    const cs = (Array.isArray(event.laboratories) ? event.laboratories : []).flatMap((p: Record<string, any>) => p.components ?? []);
    return cs.length ? cs.filter((c: Record<string, any>) => c.improves).length / cs.length : null;
  }
};

export const juniorLab: Lab<JuniorSpec, JuniorPoint, JuniorEpisode, JuniorCase, JuniorAct> = {
  id: 'junior-competence@1',
  progress: JUNIOR_PROGRESS,
  goesOnAfterAcceptance: true,
  archive: (spec) => spec.world.archive(),
  rebuild: (spec, events) => {
    for (const e of events) if (e.type === 'investigation') for (const r of (e.requests ?? []) as Record<string, any>[]) {
      const c = r?.act?.change;
      if (!c || typeof c.from !== 'string' || !c.files) continue;
      const { from: _f, files: _x, ...reason } = c;
      const made = spec.world.change(c.from, c.files, reason);
      if (!('error' in made)) latest.set(spec.world, made.version);
    }
  },
  lineage: (spec, product) => spec.world.store.lineage(product).map((t) => ({ change: t.change, from: t.from, to: t.to, ...(t.reason !== undefined ? { reason: t.reason } : {}) })),
  about: 'System 2 changes a junior researcher (its prompt and decoding) and evaluates its versions on fixed development cases, and writes a model of its competence: what each observation will measure.',
  options: [
    { name: 'manifest', default: '', help: 'the operator\'s junior-competence-manifest@1' },
    { name: 'package', default: '', help: 'the reference junior-package@1 (the manifest\'s reference)' },
    { name: 'blobs', default: '', help: 'the blob store holding the package' },
    { name: 'server', default: 'http://127.0.0.1:18700', help: 'the junior\'s server' },
    { name: 'work', default: '', help: 'where evaluations, trials and the job ledger are kept (default: beside the run)' },
    { name: 'evaluations', default: '10', help: 'evaluations of versions the run may make in all' },
    { name: 'acts', default: '2', help: 'changes and runs System 2 may make per round' },
    { name: 'tolerance', default: '0.25', help: 'how far from what was measured an answer may be' }
  ],
  generate: (_seed, o, archived) => {
    const a = archived as ReturnType<JuniorWorld['archive']> | undefined;
    const read = (f: string, what: string) => { if (!f) throw new Error('--' + what + ' is needed'); return JSON.parse(fs.readFileSync(path.resolve(f), 'utf8')); };
    const manifest = a ? a.manifest : read(o.manifest, 'manifest') as CompetenceManifest;
    const base = a ? a.base : read(o.package, 'package') as JuniorPackage;
    if (!o.blobs) throw new Error('--blobs is needed');
    const dir = path.resolve(o.work || path.join('runs', 'junior-competence', competenceHash(manifest).slice(0, 12)));
    const store = a ? new ArtifactStore(new Map(Object.entries(a.files))) : undefined;
    const world = new JuniorWorld({ manifest, base, blobs: path.resolve(o.blobs), server: o.server, dir, evaluations: Math.max(1, Math.floor(Number(o.evaluations) || 10)), ...(store ? { store } : {}) });
    const env = process.env;
    const judge = env.JEV_KEY ? { url: env.JEV_URL || 'https://openrouter.ai/api/v1/chat/completions', key: env.JEV_KEY, ...(env.JEV_MODEL ? { model: env.JEV_MODEL } : {}) } : undefined;
    return { world, ...(judge ? { judge } : {}) };
  },
  placeOf: (spec) => spec,
  places: (spec) => ({ laboratories: [{ id: 'development', spec }], family: [{ id: 'development-again', spec }] }),
  blindPlaces: () => [],
  runName: (seed, o) => 'junior-competence-' + path.basename(o.manifest || 'manifest', '.json') + '-s' + seed,
  headline: (spec) => 'junior ' + spec.world.manifest.reference.slice(0, 12) + ' under ' + spec.world.manifest.id,
  placeInfo: () => ({ partition: 'development' }),
  explorationSeed: (seed) => seed * 7919 + 3,

  world: pointWorld,
  perceive: (p) => p,
  perceptDoc: PERCEPT_DOC,
  interface: (options) => juniorInterface(Number(options.world?.tolerance) || 0.25),

  episode: async (spec) => {
    const e = await spec.world.evaluate(spec.world.reference, spec.judge);
    if (typeof e === 'string') throw new Error('the baseline could not be evaluated: ' + e);
    return evaluationEpisode(spec.world, spec.world.reference, e);
  },
  /* Exploration: the base, to read, and its baseline (§6.2) - measured before any change. */
  explore: async (laboratories) => {
    const { id, spec } = laboratories[0];
    const e = await spec.world.evaluate(spec.world.reference, spec.judge);
    if (typeof e === 'string') throw new Error('the baseline could not be evaluated: ' + e);
    return [{ place: id, episode: versionEpisode(spec.world, spec.world.reference) }, { place: id, episode: evaluationEpisode(spec.world, spec.world.reference, e) }];
  },
  /* A check of the model: the reference's evaluation and the latest version's (each made once, then kept). */
  checkEpisodes: async (spec) => {
    const versions = [...new Set([spec.world.reference, latest.get(spec.world) ?? spec.world.reference])];
    const out: JuniorEpisode[] = [];
    for (const v of versions) {
      const e = await spec.world.evaluate(v, spec.judge);
      if (typeof e === 'string') throw new Error('a check could not run: ' + e);
      out.push(evaluationEpisode(spec.world, v, e));
    }
    return out;
  },
  artifact: {
    known: (spec, version) => spec.world.store.get(version) !== null,
    async check(spec, version) {
      const ref = await spec.world.evaluate(spec.world.reference, spec.judge);
      const cand = await spec.world.evaluate(version, spec.judge);
      if (typeof ref === 'string' || typeof cand === 'string') return { holds: false, view: { verdict: 'inconclusive', why: 'not evaluated' }, journal: { error: typeof ref === 'string' ? ref : cand } };
      const { promoteEvaluations } = await import('../../junior/evaluate.ts');
      const p = promoteEvaluations(spec.world.manifest, spec.world.manifestHash, ref, cand);
      return {
        holds: p.verdict === 'promoted',
        view: { verdict: p.verdict, components: p.components.map((c) => ({ id: c.id, improves: c.improves, regresses: c.regresses })) },
        journal: { ...p, reference: ref.execution, candidate: cand.execution, manifest: spec.world.manifestHash }
      };
    }
  },
  steps: (e) => (e.kind === 'version' ? e.lines.length - 1 : e.observations.length - 1),
  indexInfo: (e) => (e.kind === 'version' ? { version: e.version, lines: e.lines.length } : { version: e.version, observations: e.observations.length, complete: e.complete }),
  explored: (e) => (e.kind === 'version' ? { version: e.version } : { version: e.version, execution: e.execution, components: e.components }),
  at: (e, step) => (e.kind === 'evaluation' && step >= 0 && step < e.observations.length
    ? { state: e.points[step], shown: { measured: e.observations[step].value, state: e.observations[step].state } } : null),
  cases: (_spec, id, e, every) => (e.kind !== 'evaluation' ? [] : e.observations.map((o, i) => ({ point: id + '@' + i, state: e.points[i], came: { value: o.value } })).filter((_, i) => i % every === 0)),
  ownEvery: 1,
  view: (e, from, to) => (e.kind === 'version'
    ? { version: e.version, parent: e.parent, ...(e.reason ? { reason: e.reason } : {}), steps: e.lines.length - 1, rows: e.lines.slice(from, Math.min(to, from + 59) + 1).map((l, i) => ({ step: from + i, file: l.file, line: l.line, text: l.text })) }
    : { version: e.version, complete: e.complete, components: e.components, steps: e.observations.length - 1,
      rows: e.observations.slice(from, Math.min(to, from + 59) + 1).map((o, i) => ({ step: from + i, case: o.case, component: o.component, rung: e.points[from + i].rung, rep: o.rep, measured: o.value, state: o.state, ...(o.why ? { why: o.why } : {}) })) }),
  shown: (c) => ({ measured: c.came.value }),

  act: {
    parse: (raw) => {
      const unknown = unknownFields(raw, ['change', 'run']);
      if (unknown) return unknown;
      const c = raw.change as Record<string, unknown> | undefined, r = raw.run as Record<string, unknown> | undefined;
      if (c && typeof c === 'object') {
        const form = '"change": {"from": "<version>", "files": {"prompt.md" | "decoding.json": "<text>"}, "why": "<the hypothesis>", "expect": "<what you expect>" | "exploratory": true}';
        const extra = unknownFields(c, ['from', 'files', 'why', 'expect', 'exploratory', 'because']);
        if (extra) return extra;
        if (typeof c.from !== 'string' || !c.files || typeof c.files !== 'object' || Object.values(c.files).some((t) => typeof t !== 'string')) return form;
        if (typeof c.why !== 'string' || !c.why.trim()) return 'a change says why: ' + form;
        const expect = typeof c.expect === 'string' && c.expect.trim() ? c.expect : null;
        if (!expect && c.exploratory !== true) return 'a change says what it expects, or that it is exploratory: ' + form;
        const because = Array.isArray(c.because) && c.because.length && c.because.every((b) => typeof b === 'string') ? { because: [...new Set(c.because as string[])] } : {};
        return { change: { from: c.from, files: c.files as Record<string, string>, why: c.why, ...because, ...(expect ? { expect } : { exploratory: true as const }) } };
      }
      if (r && typeof r === 'object') {
        if (typeof r.version !== 'string') return '"run": {"version": "<version>"}';
        return { run: { version: r.version } };
      }
      return 'act needs "change" or "run"';
    },
    place: () => undefined,
    async start(spec, a, _id, _ctx?: LabContext) {
      if ('change' in a) {
        const { from: _f, files: _x, ...reason } = a.change;
        const made = spec.world.change(a.change.from, a.change.files, reason);
        if ('error' in made) return null;
        latest.set(spec.world, made.version);
        return versionEpisode(spec.world, made.version, reason, made.parent);
      }
      const e = await spec.world.evaluate(a.run.version, spec.judge);
      return typeof e === 'string' ? null : evaluationEpisode(spec.world, a.run.version, e);
    },
    shown: (e) => (e.kind === 'version' ? { version: e.version, parent: e.parent, lines: e.lines.length } : { version: e.version, observations: e.observations.length, complete: e.complete, components: e.components }),
    asWritten: (a) => a,
    identity: (_spec, a) => ('run' in a ? a.run.version : null),
    examples: (spec) => [{ run: { version: spec.world.reference } }, { change: { from: spec.world.reference, files: { 'prompt.md': 'Answer only with the JSON the protocol asks for.' }, why: 'the protocol stated first', expect: 'more answers accepted at once' } }]
  },
  episodeIdentity: (_spec, e) => (e.kind === 'evaluation' ? e.version : null),

  objective: (host, options) => juniorObjective(host as never, Number(options.tolerance) || 0.25),
  answerIssue: (a) => (typeof a === 'number' && Number.isFinite(a) ? null : 'the answer must be a number (it was ' + JSON.stringify(a)?.slice(0, 60) + ')'),
  agrees: (a, c) => c.came.value !== null && typeof a === 'number' && Math.abs(a - c.came.value) <= 0.25,
  agreement: 'within 0.25',
  baselines: () => []
};
