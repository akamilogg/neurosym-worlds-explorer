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
import type { Dataset, Example } from '../../junior/distill.ts';
import type { Mode } from '../../junior/competence.ts';
import { openAiChatClient, type ChatClient } from '../../learn/system2.ts';
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

const PARTS = ['prompt.md', 'decoding.json'] as const;
/** A file the junior is to hold in its memory from the start: memory/<name>. */
const MEMORY_FILE = /^memory\/[^/\\]{1,64}$/;
/** The memory published from a session (publish_memory): written by the world, never by a change. */
const PUBLISHED = 'memory.state.json';
const editable = (f: string): boolean => (PARTS as readonly string[]).includes(f) || MEMORY_FILE.test(f);

interface Published { readonly neural: string | null; readonly twin: string | null; readonly source: { readonly session: string; readonly run_id: string } }

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
  private readonly packages = new Map<string, JuniorPackage>();

  constructor(o: { manifest: CompetenceManifest; base: JuniorPackage; blobs: string; server: string; dir: string; evaluations: number; memoryBuilds?: number; distillations?: number; store?: ArtifactStore }) {
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
    this.jobs = new JobLedger(path.join(o.dir, 'jobs.jsonl'), { evaluations: o.evaluations, memory_builds: o.memoryBuilds ?? o.evaluations, distillations: o.distillations ?? 20 });
  }

  archive(): { base: JuniorPackage; manifest: CompetenceManifest; files: Record<string, string> } {
    return { base: this.base, manifest: this.manifest, files: Object.fromEntries(this.store.get(this.reference)!.files) };
  }

  /** A version's parts as they are written: its prompt, its decoding, the memory files it asks for, the memory it published. */
  private parts(version: string): { prompt: string; decoding: unknown; files: Record<string, string>; published: Published | null } | string {
    const v = this.store.get(version);
    if (!v) return 'no version ' + version;
    let decoding: unknown, published: Published | null = null;
    try { decoding = JSON.parse(v.files.get('decoding.json') ?? ''); } catch { return 'decoding.json is not JSON'; }
    if (v.files.has(PUBLISHED)) { try { published = JSON.parse(v.files.get(PUBLISHED)!); } catch { return PUBLISHED + ' is not JSON'; } }
    const files = Object.fromEntries([...v.files].filter(([f]) => MEMORY_FILE.test(f)).map(([f, t]) => [f.slice('memory/'.length), t]));
    return { prompt: v.files.get('prompt.md') ?? '', decoding, files, published };
  }

  private shell(version: string, prompt: string, decoding: unknown, memory: { neural: string | null; twin: string | null }): JuniorPackage {
    return normalizePackage({ ...this.base, prompt, decoding, memory,
      provenance: { parents: [executionHash(this.base)], reason: 'version ' + version + ' of the junior-competence world', sources: this.store.lineage(version).map((t) => t.from + '->' + t.to) } });
  }

  /** The junior a version is: the base package with its parts; its memory the base's, or the one it published, with the
      files it asks for written on top BY THE JUNIOR (memory.ts) - a job of the ledger, done once per memory asked. */
  async packageOf(version: string): Promise<JuniorPackage | string> {
    const known = this.packages.get(version);
    if (known) return known;
    const parts = this.parts(version);
    if (typeof parts === 'string') return parts;
    const start = parts.published ? { neural: parts.published.neural, twin: parts.published.twin } : this.base.memory;
    let pkg: JuniorPackage;
    try { pkg = this.shell(version, parts.prompt, parts.decoding, start); } catch (e) { return (e as Error).message; }
    if (Object.keys(parts.files).length) {
      const { buildMemory } = await import('../../junior/memory.ts');
      const operation = 'mem-' + createHash('sha256').update(executionHash(pkg) + ':' + JSON.stringify(Object.entries(parts.files).sort())).digest('hex').slice(0, 24);
      try {
        const writer = pkg;
        const { done } = this.jobs.start({ operation_id: operation, op: 'build_memory', inputs: { execution: executionHash(pkg), files: parts.files }, reserve: { memory_builds: 1 },
          run: async () => {
            const b = await buildMemory({ client: this.client, pkg: writer, files: parts.files, ledger: path.join(this.dir, 'memory.jsonl') });
            return 'error' in b ? { spent: { memory_builds: 1 }, failed: b.error + ': ' + b.attempts.map((a) => a.why).join(' | ') } : { spent: { memory_builds: 1 }, products: b };
          } });
        const job = await done;
        if (job.state !== 'completed') return 'its memory was not written: ' + (job.reason ?? job.state);
        const b = job.products as { state: { neural: string | null; twin: string | null } };
        pkg = this.shell(version, parts.prompt, parts.decoding, b.state);
      } catch (e) { return e instanceof JobRefused ? e.message : String((e as Error).message ?? e); }
    }
    this.packages.set(version, pkg);
    return pkg;
  }

  change(from: string, files: Readonly<Record<string, string | null>>, reason: unknown): { version: string; parent: string } | { error: string } {
    for (const [f, t] of Object.entries(files)) {
      if (!editable(f)) return { error: 'only prompt.md, decoding.json and memory/<name> files can be changed here' };
      if (t === null && !MEMORY_FILE.test(f)) return { error: f + ' is changed, never removed' };
    }
    const v = this.store.apply(from, { files }, reason);
    if (typeof v === 'string') return { error: v };
    const parts = this.parts(v.hash);
    if (typeof parts === 'string') return { error: parts };
    try { this.shell(v.hash, parts.prompt, parts.decoding, this.base.memory); } catch (e) { return { error: (e as Error).message }; }
    return { version: v.hash, parent: from };
  }

  /** A new version whose memory is the one a development session of this world ended with (§5.3, publish_memory): its
      origin kept. Only a session of an investigation this world evaluated may be published. */
  async publish(from: string, session: string, reason: unknown): Promise<{ version: string; parent: string; files: Record<string, string> } | { error: string }> {
    const parts = this.parts(from);
    if (typeof parts === 'string') return { error: parts };
    if (!this.developmentSessions().has(session)) return { error: 'session ' + session + ' is not one of the development investigations evaluated here' };
    let info;
    try { info = await this.client.info(session); } catch (e) { return { error: String((e as Error).message ?? e) }; }
    if (info.pending) return { error: 'session ' + session + ' has a question pending' };
    const published: Published = { neural: info.head.neural, twin: info.head.twin, source: { session, run_id: info.run_id } };
    const v = this.store.apply(from, { files: { [PUBLISHED]: JSON.stringify(published, null, 2) + '\n' } }, reason);
    if (typeof v === 'string') return { error: v };
    fs.appendFileSync(path.join(this.dir, 'publications.jsonl'), JSON.stringify({ from, session, published, version: v.hash }) + '\n');
    let files: Record<string, string> = {};
    try { files = await this.client.render(this.shell(v.hash, parts.prompt, parts.decoding, info.head), info.head.twin); } catch { /* shown when it can be read */ }
    return { version: v.hash, parent: from, files };
  }

  /** A publication made again from the world's own record of it (a run rebuilt): the same state, never asked again. */
  republish(from: string, session: string, reason: unknown): string | null {
    const file = path.join(this.dir, 'publications.jsonl');
    if (!fs.existsSync(file)) return null;
    for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
      let e: { from?: string; session?: string; published?: Published };
      try { e = JSON.parse(l); } catch { continue; }
      if (e.from !== from || e.session !== session || !e.published) continue;
      const v = this.store.apply(from, { files: { [PUBLISHED]: JSON.stringify(e.published, null, 2) + '\n' } }, reason);
      return typeof v === 'string' ? null : v.hash;
    }
    return null;
  }

  /** The record of a development investigation a junior ran here: its journal, the session of its last launch, its launches. */
  investigationRecord(execution: string, caseId: string): { record: string; session: string; launches: number } | null {
    const ledger = path.join(this.dir, 'trials', 'trials.jsonl');
    if (!fs.existsSync(ledger)) return null;
    let trial: string | null = null, record: string | null = null, launches = 0;
    for (const l of fs.readFileSync(ledger, 'utf8').split('\n')) {
      let e: Record<string, any>;
      try { e = JSON.parse(l); } catch { continue; }
      if (e.type === 'research_trial_requested' && e.case === caseId && e.config === 'junior:' + execution) trial = e.trial;
      if (trial && e.trial === trial && e.type === 'research_trial_reserved') launches++;
      if (trial && e.trial === trial && e.type === 'research_trial_finished') record = path.join(this.dir, 'trials', String(e.record));
    }
    if (!trial || !record || !launches) return null;
    return { record, session: (trial + '#' + (launches - 1)).replace(/[^\w.-]/g, '.').replace(/\.(\d+)$/, '.L$1'), launches };
  }

  /** An example distilled at a cut of a development investigation of a version (§8): a job of the ledger, from
      `distillations`. In cut mode the junior's memory at the cut is its own session's, before that question. */
  async distillAt(o: { version: string; case: string; question: number; mode: Mode; checker: { id: string; version: number }; request?: string; instruction?: string },
    teacher: { client: ChatClient; identity: Readonly<Record<string, unknown>> } | undefined, judge?: import('../../runtime/lab-runner.ts').LabConnection): Promise<Example | string> {
    if (!teacher) return 'no teacher is configured for this run (--teacher-url, --teacher-model)';
    const c = this.manifest.cases.find((x) => x.id === o.case);
    if (!c || c.kind !== 'investigation' || c.partition !== 'development') return 'case ' + o.case + ' is not a development investigation of the manifest';
    const pkg = await this.packageOf(o.version);
    if (typeof pkg === 'string') return pkg;
    const rec = this.investigationRecord(executionHash(pkg), o.case);
    if (!rec) return 'version ' + o.version + ' has not run case ' + o.case + ' here: evaluate it first';
    let snapshot: { neural: string | null; twin: string | null } | undefined;
    if (o.mode === 'cut') {
      if (rec.launches > 1) return 'that investigation was resumed: the junior\'s memory at a cut of it is not known here';
      if (o.question === 0) snapshot = pkg.memory;
      else {
        try {
          const r = await this.client.receipt(rec.session, 'chat:' + (o.question - 1));
          if (r.state !== 'published') return 'the session has no answer before question ' + o.question;
          snapshot = r.receipt.after;
        } catch (e) { return String((e as Error).message ?? e); }
      }
    }
    const { distill } = await import('../../junior/distill.ts');
    const req = { run: rec.record, question: o.question, group: c.group, mode: o.mode, ...(snapshot ? { snapshot } : {}), checker: o.checker,
      ...(o.request ? { request: o.request } : {}), ...(o.instruction ? { instruction: o.instruction } : {}) };
    try {
      const operation = 'dist-' + createHash('sha256').update(JSON.stringify([executionHash(pkg), req, teacher.identity])).digest('hex').slice(0, 24);
      const { done } = this.jobs.start({ operation_id: operation, op: 'distill', inputs: { execution: executionHash(pkg), req, teacher: teacher.identity }, reserve: { distillations: 1 },
        run: async (signal) => ({ spent: { distillations: 1 }, products: await distill({ dir: this.dir, req, pkg, client: this.client, teacher: teacher.client, teacherIdentity: teacher.identity, ...(judge ? { judge } : {}), signal }) }) });
      const job = await done;
      return job.state === 'completed' ? job.products as Example : 'the distillation ' + job.state + (job.reason ? ': ' + job.reason : '');
    } catch (e) { return e instanceof JobRefused ? e.message : String((e as Error).message ?? e); }
  }

  /** A dataset of examples distilled here, with the selection groups it shares (a training on it is refused while any is). */
  async dataset(ids: readonly string[], admits: readonly ('verified' | 'demonstration')[]): Promise<{ dataset: Dataset; overlap: string[] } | string> {
    const { makeDataset, selectionOverlap } = await import('../../junior/distill.ts');
    const ds = makeDataset(this.dir, ids, admits);
    if ('error' in ds) return ds.error;
    return { dataset: ds, overlap: selectionOverlap(ds, this.manifest) };
  }

  /** The sessions of the development investigations this world's evaluations ran: session to its case and junior. */
  developmentSessions(): Map<string, { case: string; execution: string }> {
    const out = new Map<string, { case: string; execution: string }>();
    const ledger = path.join(this.dir, 'trials', 'trials.jsonl');
    if (!fs.existsSync(ledger)) return out;
    const requested = new Map<string, { case: string; execution: string }>();
    for (const l of fs.readFileSync(ledger, 'utf8').split('\n')) {
      let e: Record<string, any>;
      try { e = JSON.parse(l); } catch { continue; }
      const c = this.manifest.cases.find((x) => x.id === e.case);
      if (e.type === 'research_trial_requested' && String(e.config).startsWith('junior:') && c?.partition === 'development') requested.set(e.trial, { case: e.case, execution: String(e.config).slice('junior:'.length) });
      if (e.type === 'research_trial_reserved' && requested.has(e.trial)) out.set(String(e.launch).replace(/[^\w.-]/g, '.').replace(/\.(\d+)$/, '.L$1'), requested.get(e.trial)!);
    }
    return out;
  }

  /** A version evaluated on the development cases: a job of the world's ledger (asked again, the same job), kept. */
  async evaluate(version: string, judge?: import('../../runtime/lab-runner.ts').LabConnection): Promise<Evaluation | string> {
    const cached = this.evaluations.get(version);
    if (cached) return cached;
    const pkg = await this.packageOf(version);
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

export interface JuniorSpec {
  readonly world: JuniorWorld;
  readonly judge?: import('../../runtime/lab-runner.ts').LabConnection;
  /** The strong model as teacher (§8), configured as any researcher: its client and its identity (model, endpoint path). */
  readonly teacher?: { readonly client: ChatClient; readonly identity: Readonly<Record<string, unknown>> };
}

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
      readonly components: readonly { readonly id: string; readonly deficit: number | null }[];
      /** Its development investigations' sessions, case to session: what publish_memory may take. */
      readonly sessions: Readonly<Record<string, string>> }
  /** What a distillation or a dataset produced: rows to read and what they add up to. */
  | { readonly kind: 'records'; readonly what: 'examples' | 'dataset'; readonly summary: Readonly<Record<string, unknown>>; readonly rows: readonly Readonly<Record<string, unknown>>[] };

export interface JuniorCase { readonly point: string; readonly state: JuniorPoint; readonly came: { readonly value: number | null } }

type Reason = { readonly why: string; readonly because?: readonly string[] } & ({ readonly expect: string } | { readonly exploratory: true });
export type JuniorAct =
  | { readonly change: { readonly from: string; readonly files: Readonly<Record<string, string>> } & Reason }
  | { readonly run: { readonly version: string } }
  | { readonly publish_memory: { readonly from: string; readonly session: string } & Reason }
  | { readonly distill: { readonly version: string; readonly case: string; readonly question: number; readonly mode: Mode; readonly checker: string; readonly request?: string; readonly instruction?: string } }
  | { readonly dataset: { readonly examples: readonly string[]; readonly admits: readonly ('verified' | 'demonstration')[] } };

const latest = new WeakMap<JuniorWorld, string>();

function changedOf(w: JuniorWorld, version: string): string[] {
  const v = w.store.get(version)!, b = w.store.get(w.reference)!;
  return [...new Set([...v.files.keys(), ...b.files.keys()])].filter((f) => v.files.get(f) !== b.files.get(f)).sort();
}

/** A version to read: its files' lines, and the memory it published read as files (`memory (published)/<name>`). */
function versionEpisode(w: JuniorWorld, version: string, reason?: unknown, parent?: string, published?: Readonly<Record<string, string>>): JuniorEpisode {
  const v = w.store.get(version)!;
  const lines: { file: string; line: number; text: string }[] = [];
  for (const [file, text] of [...v.files].sort(([a], [b]) => (a < b ? -1 : 1))) text.split('\n').forEach((t, i) => lines.push({ file, line: i + 1, text: t }));
  for (const [name, text] of Object.entries(published ?? {})) text.split('\n').forEach((t, i) => lines.push({ file: 'memory (published)/' + name, line: i + 1, text: t }));
  return { kind: 'version', version, parent: parent ?? v.parent, ...(reason ? { reason } : {}), lines };
}

function evaluationEpisode(w: JuniorWorld, version: string, e: Evaluation): JuniorEpisode {
  const comps = new Map<string, Component>(w.manifest.components.map((c) => [c.id, c]));
  const changed = changedOf(w, version);
  const points = e.observations.map((o) => {
    const c = w.manifest.cases.find((x) => x.id === o.case)!;
    return { version, changed, case: o.case, component: o.component, rung: comps.get(o.component)!.rung, lab: c.lab, kind: c.kind, rep: o.rep };
  });
  const sessions = Object.fromEntries([...w.developmentSessions()].filter(([, s]) => s.execution === e.execution).map(([sid, s]) => [s.case, sid]));
  return { kind: 'evaluation', version, execution: e.execution, complete: e.measure.complete, points, observations: e.observations,
    components: e.measure.components.map((c) => ({ id: c.id, deficit: c.quality })), sessions };
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
        + 'A file "memory/<name>" asks for a file the junior holds in its own memory from the start (null removes the request): the junior writes it itself, in a session of its own, before the version is evaluated; if what it wrote is not exactly what was asked, the version cannot be evaluated and you are told so. Each memory written costs one of `memory_builds`. '
        + 'Or {"act": {"run": {"version": "<version>"}}}   that version evaluated on every development case: an episode of observations, with the session of each investigation. An evaluation costs one of `evaluations`; asked again for the same version it is the same. '
        + 'Or {"act": {"publish_memory": {"from": "<version>", "session": "<a session of an evaluation>", "why": "...", "expect": "..." | "exploratory": true}}}   a new version whose memory is the one the junior ended that investigation with: you read it as files in the version. '
        + 'Or {"act": {"distill": {"version": "<version evaluated>", "case": "<a development investigation>", "question": <n, from 0>, "mode": "start" | "cut", "checker": "protocol" | "request" | "rules" | "proposal", "request": "<kind>", "instruction": "<a visible task>"}}}   '
        + 'the junior and the teacher answer from the same point of that investigation (cut: with the junior\'s memory there; start: with its initial memory), each in a copy; the checker, fixed before the teacher answers, judges both: an EXAMPLE, verified when the teacher passes where the junior fails, unverified when both pass, rejected when the teacher fails. Each costs one of `distillations`. '
        + 'Or {"act": {"dataset": {"examples": ["<example id>", ...], "admits": ["verified"]}}}   a dataset of examples, by its content, with the groups of runs it comes from and those it shares with the probes that select juniors. At most `acts_left` this round.'],
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
      if (c && typeof c.from === 'string' && c.files) {
        const { from: _f, files: _x, ...reason } = c;
        const made = spec.world.change(c.from, c.files, reason);
        if (!('error' in made)) latest.set(spec.world, made.version);
      }
      /* A publication, from the world's record of the state it published. */
      const pm = r?.act?.publish_memory;
      if (pm && typeof pm.from === 'string' && typeof pm.session === 'string') {
        const { from: _f, session: _s, ...reason } = pm;
        const made = spec.world.republish(pm.from, pm.session, { ...reason, published_from: pm.session });
        if (made) latest.set(spec.world, made);
      }
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
    { name: 'tolerance', default: '0.25', help: 'how far from what was measured an answer may be' },
    { name: 'distillations', default: '20', help: 'distillations from a cut the run may make in all' },
    { name: 'teacher-url', default: '', help: 'the teacher\'s endpoint (or TEACHER_LLM_URL; its key from TEACHER_LLM_KEY)' },
    { name: 'teacher-model', default: '', help: 'the teacher\'s model (or TEACHER_LLM_MODEL)' }
  ],
  generate: (_seed, o, archived) => {
    const a = archived as ReturnType<JuniorWorld['archive']> | undefined;
    const read = (f: string, what: string) => { if (!f) throw new Error('--' + what + ' is needed'); return JSON.parse(fs.readFileSync(path.resolve(f), 'utf8')); };
    const manifest = a ? a.manifest : read(o.manifest, 'manifest') as CompetenceManifest;
    const base = a ? a.base : read(o.package, 'package') as JuniorPackage;
    if (!o.blobs) throw new Error('--blobs is needed');
    const dir = path.resolve(o.work || path.join('runs', 'junior-competence', competenceHash(manifest).slice(0, 12)));
    const store = a ? new ArtifactStore(new Map(Object.entries(a.files))) : undefined;
    const world = new JuniorWorld({ manifest, base, blobs: path.resolve(o.blobs), server: o.server, dir, evaluations: Math.max(1, Math.floor(Number(o.evaluations) || 10)),
      distillations: Math.max(0, Math.floor(Number(o.distillations) || 20)), ...(store ? { store } : {}) });
    const env = process.env;
    const judge = env.JEV_KEY ? { url: env.JEV_URL || 'https://openrouter.ai/api/v1/chat/completions', key: env.JEV_KEY, ...(env.JEV_MODEL ? { model: env.JEV_MODEL } : {}) } : undefined;
    /* The teacher, configured as any researcher: its endpoint and model given, its key from the environment (the proxy's
       client token on the junior's machine), never recorded. */
    const teacherUrl = o['teacher-url'] || env.TEACHER_LLM_URL, teacherModel = o['teacher-model'] || env.TEACHER_LLM_MODEL;
    const teacher = teacherUrl && teacherModel ? { client: openAiChatClient({ url: teacherUrl, apiKey: env.TEACHER_LLM_KEY, model: teacherModel, jsonMode: true, temperature: 0.3, timeoutMs: 180000, retries: 1 }),
      identity: { model: teacherModel, path: (() => { try { return new URL(teacherUrl).pathname; } catch { return null; } })() } } : undefined;
    return { world, ...(judge ? { judge } : {}), ...(teacher ? { teacher } : {}) };
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
  steps: (e) => (e.kind === 'version' ? e.lines.length - 1 : e.kind === 'records' ? e.rows.length - 1 : e.observations.length - 1),
  indexInfo: (e) => (e.kind === 'version' ? { version: e.version, lines: e.lines.length } : e.kind === 'records' ? { what: e.what, rows: e.rows.length, ...e.summary } : { version: e.version, observations: e.observations.length, complete: e.complete }),
  explored: (e) => (e.kind === 'version' ? { version: e.version } : e.kind === 'records' ? { what: e.what, ...e.summary } : { version: e.version, execution: e.execution, components: e.components }),
  at: (e, step) => (e.kind === 'evaluation' && step >= 0 && step < e.observations.length
    ? { state: e.points[step], shown: { measured: e.observations[step].value, state: e.observations[step].state } } : null),
  cases: (_spec, id, e, every) => (e.kind !== 'evaluation' ? [] : e.observations.map((o, i) => ({ point: id + '@' + i, state: e.points[i], came: { value: o.value } })).filter((_, i) => i % every === 0)),
  ownEvery: 1,
  view: (e, from, to) => (e.kind === 'records' ? { what: e.what, ...e.summary, steps: e.rows.length - 1, rows: e.rows.slice(from, Math.min(to, from + 59) + 1).map((r, i) => ({ step: from + i, ...r })) }
    : e.kind === 'version'
    ? { version: e.version, parent: e.parent, ...(e.reason ? { reason: e.reason } : {}), steps: e.lines.length - 1, rows: e.lines.slice(from, Math.min(to, from + 59) + 1).map((l, i) => ({ step: from + i, file: l.file, line: l.line, text: l.text })) }
    : { version: e.version, complete: e.complete, components: e.components, steps: e.observations.length - 1,
      rows: e.observations.slice(from, Math.min(to, from + 59) + 1).map((o, i) => ({ step: from + i, case: o.case, component: o.component, rung: e.points[from + i].rung, rep: o.rep, measured: o.value, state: o.state, ...(o.why ? { why: o.why } : {}) })) }),
  shown: (c) => ({ measured: c.came.value }),

  act: {
    parse: (raw) => {
      const unknown = unknownFields(raw, ['change', 'run', 'publish_memory', 'distill', 'dataset']);
      if (unknown) return unknown;
      const d = raw.distill as Record<string, unknown> | undefined, ds = raw.dataset as Record<string, unknown> | undefined;
      if (d && typeof d === 'object') {
        const form = '"distill": {"version": "<version>", "case": "<a development investigation>", "question": <its question, from 0>, "mode": "start" | "cut", "checker": "protocol" | "request" | "rules" | "proposal", "request": "<kind, for checker request>", "instruction": "<a visible task, optional>"}';
        const extra = unknownFields(d, ['version', 'case', 'question', 'mode', 'checker', 'request', 'instruction']);
        if (extra) return extra;
        if (typeof d.version !== 'string' || typeof d.case !== 'string' || !Number.isInteger(d.question) || (d.question as number) < 0 || (d.mode !== 'start' && d.mode !== 'cut')
          || !['protocol', 'request', 'rules', 'proposal'].includes(String(d.checker)) || (d.checker === 'request' && typeof d.request !== 'string')) return form;
        return { distill: { version: d.version, case: d.case, question: d.question as number, mode: d.mode, checker: String(d.checker),
          ...(typeof d.request === 'string' ? { request: d.request } : {}), ...(typeof d.instruction === 'string' && d.instruction.trim() ? { instruction: d.instruction } : {}) } };
      }
      if (ds && typeof ds === 'object') {
        const extra = unknownFields(ds, ['examples', 'admits']);
        if (extra) return extra;
        const admits = ds.admits === undefined ? ['verified'] : ds.admits;
        if (!Array.isArray(ds.examples) || !ds.examples.every((x) => typeof x === 'string') || !Array.isArray(admits) || !admits.every((a) => a === 'verified' || a === 'demonstration'))
          return '"dataset": {"examples": ["<example id>", ...], "admits": ["verified"] | ["verified", "demonstration"]}';
        return { dataset: { examples: ds.examples as string[], admits: admits as ('verified' | 'demonstration')[] } };
      }
      const c = raw.change as Record<string, unknown> | undefined, r = raw.run as Record<string, unknown> | undefined;
      const pm = raw.publish_memory as Record<string, unknown> | undefined;
      if (pm && typeof pm === 'object') {
        const form = '"publish_memory": {"from": "<version>", "session": "<session of an evaluation>", "why": "<the hypothesis>", "expect": "<what you expect>" | "exploratory": true}';
        const extra = unknownFields(pm, ['from', 'session', 'why', 'expect', 'exploratory', 'because']);
        if (extra) return extra;
        if (typeof pm.from !== 'string' || typeof pm.session !== 'string') return form;
        if (typeof pm.why !== 'string' || !pm.why.trim()) return 'a publication says why: ' + form;
        const expect = typeof pm.expect === 'string' && pm.expect.trim() ? pm.expect : null;
        if (!expect && pm.exploratory !== true) return 'a publication says what it expects, or that it is exploratory: ' + form;
        const because = Array.isArray(pm.because) && pm.because.length && pm.because.every((b) => typeof b === 'string') ? { because: [...new Set(pm.because as string[])] } : {};
        return { publish_memory: { from: pm.from, session: pm.session, why: pm.why, ...because, ...(expect ? { expect } : { exploratory: true as const }) } };
      }
      if (c && typeof c === 'object') {
        const form = '"change": {"from": "<version>", "files": {"prompt.md" | "decoding.json" | "memory/<name>": "<text>"}, "why": "<the hypothesis>", "expect": "<what you expect>" | "exploratory": true}';
        const extra = unknownFields(c, ['from', 'files', 'why', 'expect', 'exploratory', 'because']);
        if (extra) return extra;
        if (typeof c.from !== 'string' || !c.files || typeof c.files !== 'object' || Object.entries(c.files).some(([f, t]) => typeof t !== 'string' && !(t === null && f.startsWith('memory/')))) return form;
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
      return 'act needs "change", "run", "publish_memory", "distill" or "dataset"';
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
      if ('publish_memory' in a) {
        const { from: _f, session: _s, ...reason } = a.publish_memory;
        const made = await spec.world.publish(a.publish_memory.from, a.publish_memory.session, { ...reason, published_from: a.publish_memory.session });
        if ('error' in made) return null;
        latest.set(spec.world, made.version);
        return versionEpisode(spec.world, made.version, reason, made.parent, made.files);
      }
      if ('distill' in a) {
        const ex = await spec.world.distillAt({ ...a.distill, checker: { id: a.distill.checker, version: 1 } }, spec.teacher, spec.judge);
        if (typeof ex === 'string') return null;
        return { kind: 'records', what: 'examples', summary: { example: ex.id, state: ex.state, group: ex.group, junior_passed: ex.junior.outcome?.pass ?? null, teacher_passed: ex.teacher.outcome?.pass ?? null, memory_calls: ex.teacher.memory.calls.length },
          rows: [{ example: ex.id, state: ex.state, cut: ex.cut, competence: ex.competence, junior: { answer: ex.junior.answer, outcome: ex.junior.outcome }, teacher: { answer: ex.teacher.answer, outcome: ex.teacher.outcome, memory_calls: ex.teacher.memory.calls } }] };
      }
      if ('dataset' in a) {
        const r = await spec.world.dataset(a.dataset.examples, a.dataset.admits);
        if (typeof r === 'string') return null;
        return { kind: 'records', what: 'dataset', summary: { dataset: r.dataset.id, examples: r.dataset.examples.length, admits: r.dataset.admits, proportions: r.dataset.proportions, groups: r.dataset.groups,
          shares_selection_groups: r.overlap }, rows: r.dataset.examples.map((id) => ({ example: id })) };
      }
      const e = await spec.world.evaluate(a.run.version, spec.judge);
      return typeof e === 'string' ? null : evaluationEpisode(spec.world, a.run.version, e);
    },
    shown: (e) => (e.kind === 'version' ? { version: e.version, parent: e.parent, lines: e.lines.length } : e.kind === 'records' ? { what: e.what, ...e.summary } : { version: e.version, observations: e.observations.length, complete: e.complete, components: e.components, sessions: e.sessions }),
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
