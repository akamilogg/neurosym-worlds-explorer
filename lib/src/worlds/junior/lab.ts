import fs from 'node:fs';
import { appendRecord } from '../../junior/jsonl.ts';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { unknownFields, type Lab, type LabContext } from '../../learn/lab.ts';
import { INVESTIGATION_TOOLS as INVESTIGATION, type WorldInterface } from '../../learn/prompt.ts';
import { objectiveLines, type AnswerForm, type Objective, type Place } from '../../learn/objective.ts';
import type { World } from '../../core/types.ts';
import { HOLDING, holdingShare, type LabProgress } from '../../learn/progress.ts';
import { ArtifactStore } from '../../artifacts/store.ts';
import { JuniorSessionClient } from '../../junior/client.ts';
import { competenceHash, competenceProblems, measure, selectionManifest, withoutHoldout, type CompetenceManifest, type Component, type Observation } from '../../junior/competence.ts';
import type { Evaluation } from '../../junior/evaluate.ts';
import type { Dataset, Example } from '../../junior/distill.ts';
import type { Validity } from '../../junior/sessions.ts';
import type { Mode } from '../../junior/competence.ts';
import { openAiChatClient, type ChatClient } from '../../learn/system2.ts';
import { JobLedger, JobRefused } from '../../junior/jobs.ts';
import { BlobStore, checkClosed, executionHash, normalizePackage, type JuniorPackage } from '../../junior/package.ts';
import { WeightLab, type LabCase, type LabQuery, type LabReceipt } from '../../junior/weight-lab.ts';
import type { Availability } from '../../junior/isolation.ts';
import type { RawTensor, WeightBounds } from '../../junior/weights.ts';
import { currentRealizations, datasetCaptures, realizationOfCapture } from '../../junior/groups.ts';
import { profileProblems as profileProblemsOf } from '../../junior/method-program.ts';

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
/** The adapter a training produced (train): written by the world, never by a change. */
const ADAPTER = 'adapter.json';
/** The set of weight edits a version carries (edit, SPEC-EDICION-PESOS §5): written by the world, never by a change. */
const EDITS = 'edits.json';
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

  /** How trainings run here: the trainer's interpreter and backend, on the training GPU. */
  readonly training: { readonly python: readonly string[]; readonly backend: 'fake' | 'qwenputer' } | null;
  private readonly validities = new Map<string, Validity>();

  /** The weight laboratory (SPEC-EDICION-PESOS §4), when the manifest has one and the run pays for its queries. */
  readonly weightLab: WeightLab | null = null;
  /** The interpreter that runs the isolated backend's self-test and free programs, if programs are asked for. */
  private readonly labPython: readonly string[];
  private isolationP: Promise<Availability> | null = null;
  private readonly weightBranches: string | null;
  /** The execution profiles enabled for programs, and a backend given in place of the proved one (tests). */
  readonly programProfiles: readonly import('../../junior/method-program.ts').ExecutionProfile[];
  private readonly programAvailability: Availability | null;
  /** The deliveries of branches this instance holds (made or made again). */
  private readonly redelivered = new Set<string>();
  /** The evaluations of this run in their order, and the versions its checks promoted: what a stall is told from. */
  private readonly history: { version: string; deficits: Record<string, number | null> }[] = [];
  private readonly promoted = new Set<string>();
  private readonly probesStandIn: ((pkg: JuniorPackage) => Promise<{ complete: boolean; components: { id: string; quality: number | null }[] }>) | null;

  constructor(o: { manifest: CompetenceManifest; base: JuniorPackage; blobs: string; server: string; dir: string; evaluations: number; memoryBuilds?: number; distillations?: number; gpuHours?: number;
    training?: { python: readonly string[]; backend: 'fake' | 'qwenputer' }; store?: ArtifactStore;
    /** The execution profiles the operator enabled for programs (SPEC-INVESTIGACION-EXTERNA §8.1), and - tests only - a
        backend in place of the isolated one proved by its self-test. */
    programProfiles?: readonly import('../../junior/method-program.ts').ExecutionProfile[]; programAvailability?: Availability;
    labQueries?: number; labTokens?: number; edits?: number; searches?: number; labPython?: readonly string[]; cutter?: import('../../junior/weight-lab.ts').Cutter;
    /** Where the operator's weight-search branches leave their findings (SPEC-EDICION-PESOS §6.6): read, never written. */
    weightBranches?: string;
    /** A stand-in of the selection probes (the harness's tests of the search): each probe component's deficit. */
    probes?: (pkg: JuniorPackage) => Promise<{ complete: boolean; components: { id: string; quality: number | null }[] }> }) {
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
    this.jobs = new JobLedger(path.join(o.dir, 'jobs.jsonl'), { evaluations: o.evaluations, memory_builds: o.memoryBuilds ?? o.evaluations, distillations: o.distillations ?? 20, gpu_hours: o.gpuHours ?? 0,
      lab_queries: o.labQueries ?? 0, lab_tokens: o.labTokens ?? 0, edits: o.edits ?? 0,
      /* Searches the researcher may open (evolve): unbounded unless the run says (condition B of the comparison: none). */
      searches: o.searches ?? 1_000_000 });
    this.training = o.training ?? null;
    this.labPython = o.labPython ?? ['python3'];
    this.probesStandIn = o.probes ?? null;
    this.weightBranches = o.weightBranches ?? null;
    this.programProfiles = o.programProfiles ?? [];
    this.programAvailability = o.programAvailability ?? null;
    if (o.manifest.weight_lab && (o.labQueries ?? 0) > 0) {
      const config = o.manifest.weight_lab;
      const cutter = o.cutter ?? (async (run: string, question: number) => {
        const { captureCut } = await import('../../junior/probes.ts');
        const c = await captureCut(run, question);
        return { content: c.content, hash: c.hash, capture: c.capture };
      });
      this.weightLab = new WeightLab({ config, manifest: o.manifest, service: this.client, ledger: this.jobs, store: this.blobs, cutter });
    }
  }

  archive(): { base: JuniorPackage; manifest: CompetenceManifest; files: Record<string, string> } {
    return { base: this.base, manifest: this.manifest, files: Object.fromEntries(this.store.get(this.reference)!.files) };
  }

  /** A version's parts as they are written: its prompt, its decoding, the memory files it asks for, the memory it published. */
  private parts(version: string): { prompt: string; decoding: unknown; files: Record<string, string>; published: Published | null; adapter: string | null; trainedOn: string[]; realizations?: readonly string[]; learned?: 'trained' } | string {
    const v = this.store.get(version);
    if (!v) return 'no version ' + version;
    let decoding: unknown, published: Published | null = null;
    try { decoding = JSON.parse(v.files.get('decoding.json') ?? ''); } catch { return 'decoding.json is not JSON'; }
    if (v.files.has(PUBLISHED)) { try { published = JSON.parse(v.files.get(PUBLISHED)!); } catch { return PUBLISHED + ' is not JSON'; } }
    let adapter: string | null = null, trainedOn: string[] = [];
    /* The realizations of what it learned from (SPEC-VALIDEZ-MEDIDA §5.2): a training's, as it recorded them; a set of edits',
       from its genome. Undefined where they cannot be told: the confirmation refuses it. */
    let realizations: readonly string[] | undefined;
    let learned: 'trained' | undefined;
    if (v.files.has(ADAPTER)) {
      try {
        const a = JSON.parse(v.files.get(ADAPTER)!); adapter = String(a.adapter); trainedOn = ['dataset:' + a.dataset, 'training:' + a.job];
        /* Of the current identity, or made again from the captures of the runs it learned from, recorded when it was
           trained - never from the dataset's paths read again; else unknown. */
        realizations = currentRealizations(Array.isArray(a.realizations) ? a.realizations : undefined, a.captures);
      } catch { return ADAPTER + ' is not JSON'; }
    }
    if (v.files.has(EDITS)) {
      if (adapter !== null) return 'a version with a LoRA adapter and a set of edits: no recipe combines them';
      /* What it owes (P3, E4): the set of edits, and each edit of its genome. */
      try {
        const e = JSON.parse(v.files.get(EDITS)!); adapter = String(e.adapter); trainedOn = ['edit-set:' + e.adapter, ...((e.genome ?? []) as string[]).map((id) => 'edit:' + id)];
        /* A set a program learned from data (SPEC-INVESTIGACION-EXTERNA §8.2): a training, with its dataset and the realizations
           of what it learned from - never read from its format. */
        if (e.learned === 'trained') { learned = 'trained'; trainedOn = [...trainedOn, 'dataset:' + e.dataset, 'program:' + e.program]; realizations = currentRealizations(e.realizations, e.captures); }
        else realizations = this.genomeRealizations((e.genome ?? []) as string[]);
      } catch { return EDITS + ' is not JSON'; }
    }
    const files = Object.fromEntries([...v.files].filter(([f]) => MEMORY_FILE.test(f)).map(([f, t]) => [f.slice('memory/'.length), t]));
    return { prompt: v.files.get('prompt.md') ?? '', decoding, files, published, adapter, trainedOn, ...(realizations ? { realizations } : {}), ...(learned ? { learned } : {}) };
  }

  private realizationsFile(): string { return path.join(this.dir, 'realizations.jsonl'); }

  /** The searches that selected a version, by its lineage (SPEC-VALIDEZ-MEDIDA §4.3): an elite's record names its search
      (`search`), an operator's branch its branch (`branch`, read as `branch:<id>`), and whatever selected the version it
      was made from is kept in `searches` - by a later edit, a search from it and a branch's delivery alike. Empty: no
      search chose it. */
  searchesOf(version: string): string[] {
    const v = this.store.get(version);
    const text = v?.files.get(EDITS);
    if (!text) return [];
    try {
      const e = JSON.parse(text) as { search?: unknown; searches?: unknown; branch?: unknown };
      return [...new Set([...(typeof e.search === 'string' ? [e.search] : []), ...(typeof e.branch === 'string' ? ['branch:' + e.branch] : []),
        ...(Array.isArray(e.searches) ? e.searches.map(String) : [])])].sort();
    } catch { return []; }
  }

  /** The lineage a version made from `from` carries: what selected `from`, and what selects it now. */
  private lineageFrom(from: string, own: readonly string[] = []): { searches?: string[] } {
    const all = [...new Set([...this.searchesOf(from), ...own])].sort();
    return all.length ? { searches: all } : {};
  }

  /** The realizations a set of edits learned from: each edit's as recorded when it was constructed from the lab's receipts,
      an edit derived by an operator its parents', a written one none. Undefined when one of them cannot be told. */
  private genomeRealizations(genome: readonly string[]): readonly string[] | undefined {
    const recorded = new Map<string, { realizations?: string[]; unknown?: boolean; captures?: unknown[] }>();
    if (fs.existsSync(this.realizationsFile())) for (const l of fs.readFileSync(this.realizationsFile(), 'utf8').split('\n')) {
      try { const e = JSON.parse(l); if (typeof e.edit === 'string') recorded.set(e.edit, e); } catch { /* a cut line */ }
    }
    const out = new Set<string>();
    const seen = new Set<string>();
    const walk = (id: string): boolean => {
      if (seen.has(id)) return true;
      seen.add(id);
      const r = recorded.get(id);
      if (r?.unknown) return false;
      /* Of the current identity, or made again from the captures of the runs it was fed, recorded with it when it was made
         (never from their paths read again); else its origin is unknown. */
      if (r) {
        const current = currentRealizations(r.realizations, r.captures);
        if (!current) return false;
        for (const x of current) out.add(x);
      }
      let origin: { kind?: string; parents?: readonly string[] } = {};
      try { origin = (JSON.parse(this.blobs.get(id).toString('utf8')) as { origin?: typeof origin }).origin ?? {}; } catch { return r !== undefined; }
      /* A constructed edit reads what it was fed: where this world did not record it (an edit a branch made, one made before
         the record was kept) its origin is unknown - never taken for a clean one (VM4 review). */
      if (origin.kind === 'constructor' && !r) return false;
      return (origin.parents ?? []).every(walk);
    };
    return genome.every(walk) ? [...out].sort() : undefined;
  }

  private shell(version: string, prompt: string, decoding: unknown, memory: { neural: string | null; twin: string | null }, adapter: string | null = null, owes: readonly string[] = [], realizations?: readonly string[], learned?: 'trained'): JuniorPackage {
    /* Its provenance: its line in this world, and what it owes to others - the dataset and training of its adapter (P3) -
       with the realizations of what it learned from, where it learned anything (SPEC-VALIDEZ-MEDIDA §5.2). */
    return normalizePackage({ ...this.base, prompt, decoding, memory, adapter,
      provenance: { parents: [executionHash(this.base)], reason: 'version ' + version + ' of the junior-competence world', sources: [...this.store.lineage(version).map((t) => t.from + '->' + t.to), ...owes],
        ...(adapter !== null && realizations !== undefined ? { realizations } : {}), ...(learned ? { learned } : {}) } });
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
    try { pkg = this.shell(version, parts.prompt, parts.decoding, start, parts.adapter, parts.trainedOn, parts.realizations, parts.learned); } catch (e) { return (e as Error).message; }
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
        pkg = this.shell(version, parts.prompt, parts.decoding, b.state, parts.adapter, parts.trainedOn, parts.realizations, parts.learned);
      } catch (e) { return e instanceof JobRefused ? e.message : String((e as Error).message ?? e); }
    }
    this.packages.set(version, pkg);
    /* Kept where the operator finds it to export for confirmation (lab junior package <file> --export): never sent from here. */
    fs.mkdirSync(path.join(this.dir, 'packages'), { recursive: true });
    fs.writeFileSync(path.join(this.dir, 'packages', version + '.json'), JSON.stringify(pkg, null, 2));
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
    appendRecord(path.join(this.dir, 'publications.jsonl'), { from, session, published, version: v.hash }, { sync: true });
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

  /** An investigation of the training partition run by a version, once (SPEC-VALIDEZ-MEDIDA §5.1): a job of `evaluations`,
      its trial in the same ledger as the evaluations', never measured - only distilled at. */
  private async runTraining(pkg: JuniorPackage, caseId: string): Promise<string | null> {
    try {
      const operation = 'train-case-' + createHash('sha256').update(this.manifestHash + ':' + executionHash(pkg) + ':' + caseId).digest('hex').slice(0, 24);
      const { done } = this.jobs.start({ operation_id: operation, op: 'run', inputs: { execution: executionHash(pkg), case: caseId, manifest: this.manifestHash }, reserve: { evaluations: 1 },
        run: async (signal) => {
          const { juniorCandidate, juniorTrials } = await import('../../junior/trials.ts');
          const { inProcessLauncher } = await import('../../meta/lab.ts');
          const trials = juniorTrials(path.join(this.dir, 'trials'), this.manifest, inProcessLauncher({ root: this.dir, llm: { url: '', model: undefined } }));
          const ran = await trials.runCandidate(juniorCandidate({ pkg, execution: executionHash(pkg), client: this.client, timeoutMs: this.manifest.limits.timeout_ms }), 'training', signal, new Set([caseId]));
          return { spent: { evaluations: 1 }, products: ran.map((r) => r.result.state) };
        } });
      const job = await done;
      return job.state === 'completed' ? null : 'the training investigation ' + job.state + (job.reason ? ': ' + job.reason : '');
    } catch (e) { return e instanceof JobRefused ? e.message : String((e as Error).message ?? e); }
  }

  /** An example distilled at a cut of an investigation of a version (§8): a job of the ledger, from `distillations`. A
      case of the training partition is run here the first time it is asked for; one of development, only after an
      evaluation ran it - and a dataset of its examples is never trained on (it shares a group that selects). In cut mode
      the junior's memory at the cut is its own session's, before that question. */
  async distillAt(o: { version: string; case: string; question: number; mode: Mode; checker: { id: string; version: number }; request?: string; instruction?: string },
    teacher: { client: ChatClient; identity: Readonly<Record<string, unknown>> } | undefined, judge?: import('../../runtime/lab-runner.ts').LabConnection): Promise<Example | string> {
    if (!teacher) return 'no teacher is configured for this run (--teacher-url, --teacher-model)';
    const c = this.manifest.cases.find((x) => x.id === o.case);
    if (!c || c.kind !== 'investigation' || (c.partition !== 'development' && c.partition !== 'training')) return 'case ' + o.case + ' is not an investigation of the manifest\'s development or training partition';
    const pkg = await this.packageOf(o.version);
    if (typeof pkg === 'string') return pkg;
    if (c.partition === 'training' && !this.investigationRecord(executionHash(pkg), o.case)) {
      const failed = await this.runTraining(pkg, o.case);
      if (failed) return failed;
    }
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

  /** Whether a junior is valid to run (§10.1): its circuit's suite all exercised with no discrepancy, and its compiled
      parameters those of the base junior. A package without an adapter is the base's circuit; one with an adapter is
      checked, and what was found is kept. */
  async validity(pkg: JuniorPackage): Promise<true | string> {
    if (pkg.adapter === null) return true;
    const of = async (p: JuniorPackage): Promise<Validity | string> => {
      const k = executionHash(p);
      const known = this.validities.get(k);
      if (known) return known;
      try { const v = await this.client.validity(p); this.validities.set(k, v); appendRecord(path.join(this.dir, 'validity.jsonl'), { execution: k, ...v }); return v; }
      catch (e) { return String((e as Error).message ?? e); }
    };
    const [mine, base] = [await of(pkg), await of(this.base)];
    if (typeof mine === 'string') return 'its suite did not run: ' + mine;
    if (typeof base === 'string') return 'the base\'s suite did not run: ' + base;
    const missing = Object.entries(mine.exercised).filter(([, x]) => !x).map(([k]) => k);
    if (missing.length) return 'its suite did not exercise ' + missing.join(', ') + ': zero discrepancies on what was not exercised proves nothing';
    if (mine.mismatches) return mine.mismatches + ' discrepancies between the circuit and the reference';
    if (mine.circuit_digest !== base.circuit_digest) return 'its compiled parameters are not the base\'s';
    return true;
  }

  /** A child of a version trained on a dataset (§11, train): a job paid from gpu_hours; the child a version whose adapter
      is the training's, its line kept in the world's ledger. Refused before anything runs when the recipe reaches the
      circuit or the dataset shares groups with the selection probes. */
  async trainFrom(from: string, datasetId: string, recipe: unknown, reason: unknown): Promise<{ version?: string; state: string; reason: string | null; steps?: number | null; gpu_hours?: number | null; job?: string }> {
    const T = await import('../../junior/train.ts');
    if (T.isProgramRecipe(recipe)) return this.trainByProgram(from, datasetId, recipe, reason);
    if (!this.training) return { state: 'refused', reason: 'no trainer is configured for this run (--train-python)' };
    const parent = await this.packageOf(from);
    if (typeof parent === 'string') return { state: 'refused', reason: parent };
    const file = path.join(this.dir, 'datasets', datasetId + '.json');
    if (!/^[0-9a-f]{64}$/.test(datasetId) || !fs.existsSync(file)) return { state: 'refused', reason: 'no dataset ' + datasetId + ' here' };
    const dataset = JSON.parse(fs.readFileSync(file, 'utf8'));
    const { train, recipeProblems } = await import('../../junior/train.ts');
    const problems = recipeProblems(recipe, parent);
    if (problems.length) return { state: 'refused', reason: 'the recipe: ' + problems.join('; ') };
    const r = recipe as { max_gpu_hours: number };
    const training = this.training;
    try {
      const operation = 'train-' + createHash('sha256').update(JSON.stringify([executionHash(parent), datasetId, recipe])).digest('hex').slice(0, 24);
      const { done } = this.jobs.start({ operation_id: operation, op: 'train', inputs: { parent: executionHash(parent), dataset: datasetId, recipe }, reserve: { gpu_hours: r.max_gpu_hours },
        run: async (signal) => {
          const t = await train({ python: training.python, backend: training.backend, work: this.dir, store: this.blobs, parent, dataset, examplesDir: path.join(this.dir, 'examples'),
            recipe: recipe as never, manifest: this.manifest, signal });
          const spent = t.gpu_hours === null ? (t.state === 'refused' ? { gpu_hours: 0 } : null) : { gpu_hours: t.gpu_hours };
          return t.state === 'finished' ? { spent, products: t } : { spent, products: t, failed: t.state + ': ' + (t.reason ?? '') };
        } });
      const job = await done;
      const t = job.products as { state: string; reason: string | null; adapter: string | null; steps: number | null; gpu_hours: number | null; child?: JuniorPackage | null } | null;
      if (job.state !== 'completed' || !t || !t.adapter) return { state: t?.state ?? job.state, reason: t?.reason ?? job.reason, steps: t?.steps ?? null, gpu_hours: t?.gpu_hours ?? null };
      const learned = t.child?.provenance.realizations;
      /* With the captures they were made from (each example's, taken when it was cut): what they are made again from. */
      const captures = learned ? datasetCaptures(path.join(this.dir, 'examples'), dataset) : null;
      const record = { adapter: t.adapter, dataset: datasetId, recipe, parent: executionHash(parent), job: operation, ...(learned ? { realizations: learned } : {}), ...(captures ? { captures } : {}) };
      const v = this.store.apply(from, { files: { [ADAPTER]: JSON.stringify(record, null, 2) + '\n' } }, reason);
      if (typeof v === 'string') return { state: 'failed', reason: v };
      appendRecord(path.join(this.dir, 'trainings.jsonl'), { from, dataset: datasetId, recipe, record, version: v.hash }, { sync: true });
      return { version: v.hash, state: 'finished', reason: null, steps: t.steps, gpu_hours: t.gpu_hours };
    } catch (e) { return { state: 'refused', reason: e instanceof JobRefused ? e.message : String((e as Error).message ?? e) }; }
  }

  /** A training made again from the world's record of it (a run rebuilt): its adapter's line, never trained again. */
  retrain(from: string, datasetId: string, recipe: unknown, reason: unknown): string | null {
    const file = path.join(this.dir, 'trainings.jsonl');
    if (!fs.existsSync(file)) return null;
    for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
      let e: { from?: string; dataset?: string; recipe?: unknown; record?: unknown };
      try { e = JSON.parse(l); } catch { continue; }
      if (e.from !== from || e.dataset !== datasetId || JSON.stringify(e.recipe) !== JSON.stringify(recipe)) continue;
      const v = this.store.apply(from, { files: { [ADAPTER]: JSON.stringify(e.record, null, 2) + '\n' } }, reason);
      return typeof v === 'string' ? null : v.hash;
    }
    return null;
  }

  /** A query of the weight laboratory on a version (inspect_weights, SPEC-EDICION-PESOS §5): its operation id fixed by
      what it asks, so asked again it is the same query and never charged twice. */
  async inspectWeights(version: string, q: { query: LabQuery['query']; args?: Record<string, unknown>; cases?: readonly LabCase[]; candidate?: string }): Promise<LabReceipt | { refused: string }> {
    if (!this.weightLab) return { refused: 'this run has no weight laboratory: the manifest needs "weight_lab" and the run --lab-queries' };
    const pkg = await this.packageOf(version);
    if (typeof pkg === 'string') return { refused: pkg };
    let candidate: JuniorPackage | undefined;
    if (q.candidate !== undefined) {
      const c = await this.packageOf(q.candidate);
      if (typeof c === 'string') return { refused: c };
      candidate = c;
    }
    const operation = 'wlab-' + createHash('sha256').update(JSON.stringify([executionHash(pkg), q.query, q.args ?? {}, q.cases ?? [], candidate ? executionHash(candidate) : null])).digest('hex').slice(0, 24);
    return this.weightLab.query(pkg, { query: q.query, ...(q.args ? { args: q.args } : {}), ...(q.cases ? { cases: q.cases } : {}), ...(candidate ? { candidate } : {}) }, operation);
  }

  /** A training by PROGRAM (SPEC-INVESTIGACION-EXTERNA §8, IE5): the researcher's method run under a profile the operator
      enabled, where an isolated backend is proved; it reads the dataset's rows (mounted as dataset.jsonl) and whatever else
      it declares; what it makes is imported as an edit of the start, LEARNED FROM DATA (`learned: "trained"`), with the
      realizations of the runs its examples came from. A job of the world's ledger: asked again, the same job. */
  async trainByProgram(from: string, datasetId: string, recipe: import('../../junior/train.ts').ProgramRecipe, reason: unknown): Promise<{ version?: string; state: string; reason: string | null; job?: string }> {
    const parent = await this.packageOf(from);
    if (typeof parent === 'string') return { state: 'refused', reason: parent };
    const T = await import('../../junior/train.ts');
    const problems = T.recipeProblems(recipe, parent);
    if (problems.length) return { state: 'refused', reason: 'the recipe: ' + problems.join('; ') };
    if (!this.manifest.weight_edits) return { state: 'refused', reason: 'the condition authorizes no edits: a program\'s product is composed within its "weight_edits" bounds' };
    const file = path.join(this.dir, 'datasets', datasetId + '.json');
    if (!/^[0-9a-f]{64}$/.test(datasetId) || !fs.existsSync(file)) return { state: 'refused', reason: 'no dataset ' + datasetId + ' here' };
    const dataset = JSON.parse(fs.readFileSync(file, 'utf8')) as Dataset;
    const { selectionOverlap } = await import('../../junior/distill.ts');
    const shared = selectionOverlap(dataset, this.manifest);
    if (shared.length) return { state: 'refused', reason: 'the dataset shares groups with the cases that select or confirm juniors (' + shared.join(', ') + ')' };
    const rows = T.trainingRows(path.join(this.dir, 'examples'), dataset, recipe);
    if ('error' in rows) return { state: 'refused', reason: rows.error };
    /* What it learned from, by the captures of the runs its examples were cut from: none known, none admitted. */
    const captures = datasetCaptures(path.join(this.dir, 'examples'), dataset);
    if (!captures) return { state: 'refused', reason: 'an example of the dataset does not say which run it was cut from: what it would learn from cannot be told' };
    const M = await import('../../junior/method-program.ts');
    const inputs = { 'dataset.jsonl': Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + '\n') };
    const availability = this.programAvailability ?? await this.isolation();
    const W = await import('../../junior/weights.ts');
    const authorized = this.manifest.weight_edits;
    try {
      const operation = 'program-' + M.jobIdentity(recipe.program, inputs, executionHash(parent), this.programProfiles.find((p) => p.id === recipe.program.profile) ?? { id: recipe.program.profile, dependencies: {}, limits: { timeout_ms: 1, memory_bytes: 1, cpu_seconds: 1, output_bytes: 1 }, gpu: false }).slice(0, 24);
      const { done } = this.jobs.start({ operation_id: operation, op: 'train', inputs: { parent: executionHash(parent), dataset: datasetId, program: M.programId(recipe.program) }, reserve: { edits: 1 },
        run: async () => {
          const job = await M.runMethodProgram({ program: recipe.program, profiles: this.programProfiles, inputs, start: executionHash(parent), startDir: this.baseDir(parent.base), availability });
          if (job.state !== 'finished') return { spent: { edits: 0 }, products: job, failed: job.state + ': ' + (job.reason ?? '') };
          const backend = availability.available ? availability.backend.id : 'none';
          const made = M.importProduct(this.blobs, parent, job, { program: recipe.program, backend, hypothesis: { competence: 'trained', mechanism: 'a method by program: ' + M.programId(recipe.program).slice(0, 12), effect: 'as the evaluator measures' } });
          if ('problems' in made) return { spent: { edits: 0 }, products: { ...job, products: undefined }, failed: 'its product: ' + made.problems.join('; ') };
          const v = W.composeVersion({ store: this.blobs, parent, add: [made.id], authorized });
          if ('problems' in v) return { spent: { edits: 0 }, products: { ...job, products: undefined }, failed: v.problems.join('; ') };
          return { spent: { edits: 1 }, products: { job: job.job, edit: made.id, adapter: v.adapter, start: v.set.start, genome: v.set.genome, totals: v.set.totals } };
        } });
      const j = await done;
      const out = j.products as { job?: string; state?: string; reason?: string | null; adapter?: string; start?: string; genome?: string[]; totals?: unknown } | null;
      if (j.state !== 'completed' || !out?.adapter) return { state: out?.state === 'unavailable' ? 'unavailable' : out?.state === 'refused' ? 'refused' : 'failed', reason: j.reason ?? out?.reason ?? j.state, ...(out?.job ? { job: out.job } : {}) };
      const realizations = [...new Set(captures.map((c) => realizationOfCapture(c)))].sort();
      /* Learned from data, as the host says: a training whatever its format (§8.2); with what it learned from. */
      const record = { adapter: out.adapter, start: out.start, genome: out.genome, totals: out.totals, learned: 'trained', dataset: datasetId, program: M.programId(recipe.program), job: out.job, realizations, captures };
      const made = this.store.apply(from, { files: { [EDITS]: JSON.stringify(record, null, 2) + '\n' } }, reason);
      if (typeof made === 'string') return { state: 'failed', reason: made };
      appendRecord(path.join(this.dir, 'trainings.jsonl'), { from, dataset: datasetId, recipe: { method: 'program', program: M.programId(recipe.program) }, record, version: made.hash }, { sync: true });
      return { version: made.hash, state: 'finished', reason: null, job: out.job };
    } catch (e) { return { state: 'refused', reason: e instanceof JobRefused ? e.message : String((e as Error).message ?? e) }; }
  }

  /** The isolated backend for free programs, by its self-test, asked once per run. */
  isolation(): Promise<Availability> {
    this.isolationP ??= import('../../junior/isolation.ts').then((m) => m.isolatedBackend({ python: this.labPython }));
    return this.isolationP;
  }

  /** The base checkpoint as a folder a program reads (hard links where the disk allows). */
  private baseDir(base: string): string {
    const dir = path.join(this.dir, 'bases', base);
    if (fs.existsSync(path.join(dir, '.complete'))) return dir;
    const t = this.blobs.tree(base)!;
    for (const [rel, blob] of Object.entries(t.files)) {
      const target = path.join(dir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      try { fs.linkSync(this.blobs.pathOf(blob), target); } catch { fs.copyFileSync(this.blobs.pathOf(blob), target); }
    }
    fs.writeFileSync(path.join(dir, '.complete'), base);
    return dir;
  }

  /** The edit an act asks for, stored by its hash: written values, a closed constructor (its inputs from the lab's
      receipts or given), or a free program in the isolated backend. Nothing is charged here: a refused edit costs nothing. */
  async makeEdit(start: JuniorPackage, e: EditAsked, hypothesis: { competence: string; mechanism: string; effect: string }): Promise<{ id: string } | { problems: string[] }> {
    const W = await import('../../junior/weights.ts');
    const chip = Number((start.execution.circuit as Record<string, unknown>).chip_layers);
    if ('written' in e) {
      const read = W.baseReader(this.blobs, start.base);
      const modules: { module: string; encoding: 'lowrank' | 'sparse'; shape: [number, number]; tensors: Record<string, RawTensor> }[] = [];
      for (const m of e.written.modules) {
        let shape: [number, number];
        try { shape = read(m.module + '.weight').shape; } catch (err) { return { problems: [(err as Error).message] }; }
        if (m.encoding === 'lowrank') {
          const B = m.B ?? [], A = m.A ?? [];
          const r = A.length;
          if (B.length !== shape[0] || B.some((row) => !Array.isArray(row) || row.length !== r) || A.some((row) => !Array.isArray(row) || row.length !== shape[1]) || r < 1)
            return { problems: [m.module + ': B is ' + shape[0] + ' rows of r values and A r rows of ' + shape[1]] };
          modules.push({ module: m.module, encoding: 'lowrank', shape, tensors: { B: W.tensorF32([shape[0], r], B.flat()), A: W.tensorF32([r, shape[1]], A.flat()) } });
        } else {
          const idx = m.indices ?? [], val = m.values ?? [];
          if (idx.length !== val.length) return { problems: [m.module + ': as many indices as values'] };
          modules.push({ module: m.module, encoding: 'sparse', shape, tensors: { indices: W.tensorI64(idx), values: W.tensorF32([val.length], val) } });
        }
      }
      return W.putEdit(this.blobs, { modules, hypothesis, origin: { kind: 'written' }, authorship: 'strong' }, chip);
    }
    if ('construct' in e) {
      const inputs: Record<string, { from: string; file: string } | Buffer> = {};
      for (const [name, src] of Object.entries(e.construct.inputs ?? {})) {
        if ('from' in src) inputs[name] = { from: src.from, file: src.file };
        else inputs[name] = W.writeSafetensors(Object.fromEntries(Object.entries(src.tensors).map(([t, v]) => [t, W.tensorF32([v.length], v)])));
      }
      if (!this.weightLab) {
        const direct: Record<string, Buffer> = {};
        for (const [name, src] of Object.entries(inputs)) { if (!Buffer.isBuffer(src)) return { problems: ['this run has no weight laboratory to take ' + name + ' from'] }; direct[name] = src; }
        const built = W.construct(this.blobs, start, { constructor: e.construct.name, args: e.construct.args, inputs: direct, hypothesis, authorship: 'strong' });
        /* Fed only what the strong model wrote: it learned from no run, and says so. */
        if ('id' in built) appendRecord(this.realizationsFile(), { edit: built.id, realizations: [] }, { sync: true });
        return built;
      }
      const made = this.weightLab.construct(start, { constructor: e.construct.name, args: e.construct.args, inputs, hypothesis, authorship: 'strong' });
      /* What it learned from (SPEC-VALIDEZ-MEDIDA §5.2): the realizations of the diagnosis runs its receipts read. */
      if ('id' in made) {
        /* Each diagnosis case by the capture of its run taken when the lab cut it: a case without one has an unknown origin. */
        const cases = Object.values(inputs).flatMap((src) => (Buffer.isBuffer(src) ? [] : (this.weightLab!.receiptOf(src.from)?.cases ?? []).filter((c) => c.source === 'cut' && c.run)));
        const captures = cases.map((c) => c.capture ?? null);
        appendRecord(this.realizationsFile(), captures.some((c) => c === null) ? { edit: made.id, unknown: true, runs: cases.map((c) => c.run) }
          : { edit: made.id, realizations: [...new Set(captures.map((c) => realizationOfCapture(c!)))].sort(), captures }, { sync: true });
      }
      return made;
    }
    const a = await this.isolation();
    const limits = this.manifest.weight_lab?.program;
    if (!a.available) return { problems: ['origin "program": ' + a.reason] };
    if (!limits) return { problems: ['origin "program": the manifest fixes no "weight_lab.program" limits'] };
    const inputs = Object.fromEntries(Object.entries(e.program.inputs ?? {}).map(([k, v]) => [k, Buffer.from(v, 'utf8')]));
    return W.programEdit(this.blobs, start, { code: e.program.code, inputs, backend: a.backend, baseDir: this.baseDir(start.base), limits, hypothesis, authorship: 'strong' });
  }

  /** A child of a version with one edit more (edit, SPEC-EDICION-PESOS §5): the edit made, its genome composed from the
      start within the condition's bounds (and any stricter it declares), a job paid from `edits` only when a version is
      made. The child is a version whose set of edits sits in the adapter slot; before it is evaluated its circuit must
      pass the validity suite. */
  async editFrom(from: string, e: EditAsked, hypothesis: { competence: string; mechanism: string; effect: string }, declared: WeightBounds | undefined, reason: unknown, asked = askedKey(from, e, hypothesis, declared)):
    Promise<{ version?: string; state: string; reason: string | null; edit?: string; genome?: number; totals?: unknown }> {
    const parent = await this.packageOf(from);
    if (typeof parent === 'string') return { state: 'refused', reason: parent };
    const W = await import('../../junior/weights.ts');
    if (W.adapterKind(this.blobs, parent) === 'lora') return { state: 'refused', reason: 'the version has a LoRA adapter: combining a trained adapter with edits is another recipe, which does not exist' };
    if (!this.manifest.weight_edits) return { state: 'refused', reason: 'the condition authorizes no edits: its manifest fixes no "weight_edits" bounds' };
    const made = await this.makeEdit(parent, e, hypothesis);
    if ('problems' in made) return { state: 'refused', reason: made.problems.join('; ') };
    const authorized = this.manifest.weight_edits;
    try {
      const operation = 'edit-' + createHash('sha256').update(JSON.stringify([executionHash(parent), made.id, declared ?? null])).digest('hex').slice(0, 24);
      const { done } = this.jobs.start({ operation_id: operation, op: 'edit', inputs: { parent: executionHash(parent), edit: made.id, declared: declared ?? null }, reserve: { edits: 1 },
        run: async () => {
          const v = W.composeVersion({ store: this.blobs, parent, add: [made.id], authorized, ...(declared ? { declared } : {}) });
          if ('problems' in v) return { spent: { edits: 0 }, failed: v.problems.join('; ') };
          return { spent: { edits: 1 }, products: { adapter: v.adapter, start: v.set.start, genome: v.set.genome, totals: v.set.totals } };
        } });
      const job = await done;
      if (job.state !== 'completed') return { state: 'refused', reason: job.reason, edit: made.id };
      /* What selected its parent stays in its lineage: an edit of a search's elite is still a candidate a search selected. */
      const record = { ...(job.products as { adapter: string; start: string; genome: string[]; totals: unknown }), ...this.lineageFrom(from) };
      const v = this.store.apply(from, { files: { [EDITS]: JSON.stringify(record, null, 2) + '\n' } }, reason);
      if (typeof v === 'string') return { state: 'failed', reason: v, edit: made.id };
      appendRecord(path.join(this.dir, 'edits.jsonl'), { from, asked, edit: made.id, declared: declared ?? null, record, version: v.hash }, { sync: true });
      return { version: v.hash, state: 'finished', reason: null, edit: made.id, genome: record.genome.length, totals: record.totals };
    } catch (err) { return { state: 'refused', reason: err instanceof JobRefused ? err.message : String((err as Error).message ?? err) }; }
  }

  /** An edit made again from the world's record of it (a run rebuilt): its set's line, never composed again. */
  reedit(from: string, asked: string, reason: unknown): string | null {
    const file = path.join(this.dir, 'edits.jsonl');
    if (!fs.existsSync(file)) return null;
    for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
      let e: { from?: string; asked?: string; record?: unknown };
      try { e = JSON.parse(l); } catch { continue; }
      if (e.from !== from || e.asked !== asked) continue;
      const v = this.store.apply(from, { files: { [EDITS]: JSON.stringify(e.record, null, 2) + '\n' } }, reason);
      return typeof v === 'string' ? null : v.hash;
    }
    return null;
  }

  /** The probe components (rungs 1-4 with probe cases): what a search measures and its niches are made of. */
  probeComponents(): string[] {
    return this.manifest.components.filter((c) => c.rung <= 4 && this.manifest.cases.some((k) => k.kind === 'probe' && k.component === c.id)).map((c) => c.id);
  }

  /** A junior on the selection probes only (the search's step 2): a job of `evaluations`, one per junior, asked again the
      same. Each probe component's deficit, null where it is missing. Throws OutOfBudget when the bag cannot hold it. */
  async probesOf(pkg: JuniorPackage): Promise<{ complete: boolean; components: { id: string; quality: number | null }[] }> {
    const { OutOfBudget } = await import('../../junior/weight-search.ts');
    const comps = new Set(this.probeComponents());
    /* The probes a search selects on: without the holdout (SPEC-VALIDEZ-MEDIDA §4.3), which promotes its candidates. */
    const manifest: CompetenceManifest = selectionManifest(this.manifest);
    const { competenceHash: hashOf } = await import('../../junior/competence.ts');
    const manifestHash = hashOf(manifest);
    const operation = 'probes-' + createHash('sha256').update(manifestHash + ':' + executionHash(pkg)).digest('hex').slice(0, 24);
    let started;
    try {
      started = this.jobs.start({ operation_id: operation, op: 'probes', inputs: { execution: executionHash(pkg), manifest: manifestHash }, reserve: { evaluations: 1 },
        run: async (signal) => {
          if (this.probesStandIn) return { spent: { evaluations: 1 }, products: await this.probesStandIn(pkg) };
          const { evaluate } = await import('../../junior/evaluate.ts');
          const { inProcessLauncher } = await import('../../meta/lab.ts');
          const e = await evaluate({ dir: this.dir, manifest, manifestHash, pkg, client: this.client, partition: 'development', signal, launcher: inProcessLauncher({ root: this.dir, llm: { url: '', model: undefined } }) });
          return { spent: { evaluations: 1 }, products: { complete: e.measure.complete, components: e.measure.components.map((c) => ({ id: c.id, quality: c.quality })) } };
        } });
    } catch (e) { if (e instanceof JobRefused) throw new OutOfBudget('evaluations', e.message); throw e; }
    const job = await started.done;
    if (job.state !== 'completed' || !job.products) return { complete: false, components: [...comps].map((id) => ({ id, quality: null })) };
    return job.products as { complete: boolean; components: { id: string; quality: number | null }[] };
  }

  /** What a search asks of this world, from a start: each composed genome a job of `edits` (one per genome, asked again
      the same), its validity, its probes, and for its elites whole investigations. */
  searchEvaluator(start: JuniorPackage): import('../../junior/weight-search.ts').SearchEvaluator {
    const authorized = this.manifest.weight_edits;
    const comps = new Set(this.probeComponents());
    const probesManifest = selectionManifest(this.manifest);
    return {
      /* Its measures depend on the probes' manifest and on who measures them (the probes, or a stand-in of the tests). */
      identity: competenceHash(probesManifest) + (this.probesStandIn ? ':stand-in' : ''),
      compose: async (genome) => {
        const W = await import('../../junior/weights.ts');
        const { OutOfBudget } = await import('../../junior/weight-search.ts');
        if (!authorized) return { invalid: 'the condition authorizes no edits' };
        const operation = 'edit-search-' + createHash('sha256').update(JSON.stringify([executionHash(start), genome])).digest('hex').slice(0, 24);
        let started;
        try {
          started = this.jobs.start({ operation_id: operation, op: 'edit', inputs: { start: executionHash(start), genome }, reserve: { edits: 1 },
            run: async () => {
              const v = W.composeVersion({ store: this.blobs, parent: start, add: genome, authorized, reason: 'a candidate of a search' });
              return 'problems' in v ? { spent: { edits: 0 }, result: { invalid: v.problems.join('; ') } } : { spent: { edits: 1 }, result: { adapter: v.adapter } };
            } });
        } catch (e) { if (e instanceof JobRefused) throw new OutOfBudget('edits', e.message); throw e; }
        const job = await started.done;
        const r = job.result as { invalid?: string; adapter?: string } | null;
        if (!r || r.invalid) return { invalid: r?.invalid ?? job.reason ?? 'not composed' };
        /* Composed again from the record (the set is a pure function of its genome): never charged twice. */
        const v = W.composeVersion({ store: this.blobs, parent: start, add: genome, authorized, reason: 'a candidate of a search' });
        if ('problems' in v) return { invalid: v.problems.join('; ') };
        return { pkg: v.child, summaries: v.set.summaries, totals: v.set.totals };
      },
      valid: (pkg) => this.validity(pkg),
      probes: (pkg) => this.probesOf(pkg),
      investigate: async (pkg) => {
        const e = await this.evaluatePackage(pkg);
        return typeof e === 'string' ? { error: e } : { complete: e.measure.complete, components: e.measure.components.map((c) => ({ id: c.id, deficit: c.quality })) };
      }
    };
  }

  /** A search of juniors from a version (evolve, SPEC-EDICION-PESOS §6): the strong model's seeds made as edits, the
      search run within what the manifest authorizes, its elites made versions of this world (their set in edits.json)
      that the researcher adopts or not. Its record kept in searches/, resumed if asked again. */
  async evolveFrom(from: string, o: { seeds: readonly { edit: EditAsked; hypothesis: { competence: string; mechanism: string; effect: string } }[]; control_seeds: number; max_candidates: number;
    operators?: Readonly<Record<string, number>>; seed?: number }, reason: unknown, asked: string): Promise<{ state: string; reason: string | null; stoppedBy?: string; versions?: { version: string; niche: string; genome: number; deficits: unknown; origin: unknown }[]; counts?: Record<string, number> }> {
    const auth = this.manifest.weight_search;
    if (!auth) return { state: 'refused', reason: 'the condition authorizes no search: its manifest has no "weight_search"' };
    if (!this.manifest.weight_edits) return { state: 'refused', reason: 'the condition authorizes no edits: its manifest fixes no "weight_edits" bounds' };
    const start = await this.packageOf(from);
    if (typeof start === 'string') return { state: 'refused', reason: start };
    if (start.adapter !== null) return { state: 'refused', reason: 'a search starts from a version without an adapter (no LoRA, no set of edits): its genome is composed from it' };
    if (o.control_seeds < auth.min_control_seeds) return { state: 'refused', reason: 'at least ' + auth.min_control_seeds + ' control seeds (E6)' };
    if (o.max_candidates > auth.max_candidates) return { state: 'refused', reason: 'at most ' + auth.max_candidates + ' candidates' };
    if (!o.seeds.length) return { state: 'refused', reason: 'a search needs your seeds: distinct hypotheses, as edits' };
    if (!(this.jobs.bags().searches.free >= 1) && !fs.existsSync(path.join(this.dir, 'searches', asked + '.jsonl'))) return { state: 'refused', reason: 'this run may open no more searches (`searches`)' };
    const ids: string[] = [];
    for (const s of o.seeds) {
      const made = await this.makeEdit(start, s.edit, s.hypothesis);
      if ('problems' in made) return { state: 'refused', reason: 'a seed: ' + made.problems.join('; ') };
      ids.push(made.id);
    }
    const S = await import('../../junior/weight-search.ts');
    const W = await import('../../junior/weights.ts');
    const operators = Object.fromEntries(Object.entries(o.operators ?? auth.operators).filter(([k]) => k !== 'refine'));
    const config = { format: S.WEIGHT_SEARCH, seed: o.seed ?? 1, control_seeds: o.control_seeds, max_candidates: o.max_candidates, operators, tolerance: auth.tolerance,
      layer_groups: auth.layer_groups, perturb: auth.perturb, investigate_elites: auth.investigate_elites } as const;
    const problems = S.searchConfigProblems(config, this.probeComponents());
    if (problems.length) return { state: 'refused', reason: problems.join('; ') };
    fs.mkdirSync(path.join(this.dir, 'searches'), { recursive: true });
    let r;
    try {
      /* The search itself a job of `searches` (asked again, the same): its candidates pay their own bags. */
      const { done } = this.jobs.start({ operation_id: 'search-' + asked, op: 'evolve', inputs: { from, asked }, reserve: { searches: 1 },
        run: async () => ({ spent: { searches: 1 }, products: await S.runWeightSearch({ config, start, seeds: ids, store: this.blobs, components: this.probeComponents(), evaluator: this.searchEvaluator(start), out: path.join(this.dir, 'searches', asked + '.jsonl') }) }) });
      const job = await done;
      if (job.state !== 'completed') return { state: 'refused', reason: job.reason ?? job.state };
      r = job.products as Awaited<ReturnType<typeof S.runWeightSearch>>;
    } catch (e) { return { state: 'refused', reason: String((e as Error).message ?? e) }; }
    const versions: { version: string; niche: string; genome: number; deficits: unknown; origin: unknown; record: unknown }[] = [];
    for (const c of r.elites) {
      if (!c.genome.length) continue;
      const v = W.composeVersion({ store: this.blobs, parent: start, add: c.genome, authorized: this.manifest.weight_edits, reason: 'an elite of a search' });
      if ('problems' in v) continue;
      const record = { adapter: v.adapter, start: v.set.start, genome: v.set.genome, totals: v.set.totals, search: asked, niche: c.niche, origin: c.origin, ...this.lineageFrom(from) };
      const made = this.store.apply(from, { files: { [EDITS]: JSON.stringify(record, null, 2) + '\n' } }, { ...(reason as object), niche: c.niche });
      if (typeof made === 'string') continue;
      versions.push({ version: made.hash, niche: c.niche!, genome: c.genome.length, deficits: c.deficits, origin: c.origin, record });
    }
    appendRecord(path.join(this.dir, 'evolutions.jsonl'), { from, asked, stoppedBy: r.stoppedBy, versions: versions.map((v) => ({ version: v.version, niche: v.niche, record: v.record })) }, { sync: true });
    const counts: Record<string, number> = { candidates: r.candidates.length };
    for (const c of r.candidates) counts[c.state ?? 'unevaluated'] = (counts[c.state ?? 'unevaluated'] ?? 0) + 1;
    return { state: 'finished', reason: null, stoppedBy: r.stoppedBy, versions: versions.map(({ record: _r, ...v }) => v), counts };
  }

  /** A set of edits already composed (its record: adapter, start, genome, totals) made a version from `from`: the
      comparison's conditions without a researcher (C, E) adopt their candidates so. */
  adoptSet(from: string, record: Readonly<Record<string, unknown>>, reason: unknown): string | null {
    const v = this.store.apply(from, { files: { [EDITS]: JSON.stringify(record, null, 2) + '\n' } }, reason);
    return typeof v === 'string' ? null : v.hash;
  }

  /** A search's elites made versions again from the world's record of it (a run rebuilt): never searched again. */
  reevolve(from: string, asked: string): string[] {
    const file = path.join(this.dir, 'evolutions.jsonl');
    if (!fs.existsSync(file)) return [];
    for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
      let e: { from?: string; asked?: string; versions?: { niche: string; record: unknown }[] };
      try { e = JSON.parse(l); } catch { continue; }
      if (e.from !== from || e.asked !== asked) continue;
      return (e.versions ?? []).map((v) => this.store.apply(from, { files: { [EDITS]: JSON.stringify(v.record, null, 2) + '\n' } }, { niche: v.niche })).filter((v): v is Exclude<typeof v, string> => typeof v !== 'string').map((v) => v.hash);
    }
    return [];
  }

  /** A version evaluated on the development cases: a job of the world's ledger (asked again, the same job), kept. */
  async evaluate(version: string, judge?: import('../../runtime/lab-runner.ts').LabConnection): Promise<Evaluation | string> {
    const cached = this.evaluations.get(version);
    if (cached) return cached;
    const pkg = await this.packageOf(version);
    if (typeof pkg === 'string') return pkg;
    const e = await this.evaluatePackage(pkg, judge, version);
    if (typeof e !== 'string') {
      this.evaluations.set(version, e);
      this.noteEvaluation(version, Object.fromEntries(e.measure.components.map((c) => [c.id, c.quality])));
    }
    return e;
  }

  /** An evaluation of a version, in the order the run made it: what a stall is told from. */
  noteEvaluation(version: string, deficits: Record<string, number | null>): void { this.history.push({ version, deficits }); }

  /** A check's verdict, kept: a version promoted ends a stall. */
  notePromotion(version: string, promoted: boolean): void { if (promoted) this.promoted.add(version); }

  /** A STALL (SPEC-EDICION-PESOS §6.6), as facts: the last K evaluations of versions, none promoted, no component's
      deficit better than the best before them by more than its tolerance. Only where the run may open a search (the
      manifest authorizes one and edits are paid); each stall told once (kept in stalls.jsonl): the world never opens a
      search itself. */
  stall(): Record<string, unknown> | null {
    const auth = this.manifest.weight_search;
    if (!auth || !this.manifest.weight_edits || !(this.jobs.bags().edits?.limit > 0)) return null;
    const k = auth.stuck_after ?? 4;
    if (this.history.length < k + 1) return null;
    const window = this.history.slice(-k), before = this.history.slice(0, -k);
    if (window.some((h) => this.promoted.has(h.version))) return null;
    for (const comp of this.manifest.components) {
      const best = Math.min(...before.map((h) => h.deficits[comp.id]).filter((x): x is number => typeof x === 'number'));
      const tol = auth.tolerance[comp.id] ?? 0;
      if (window.some((h) => typeof h.deficits[comp.id] === 'number' && (h.deficits[comp.id] as number) < best - tol)) return null;
    }
    const id = window[0].version;
    const file = path.join(this.dir, 'stalls.jsonl');
    const told = fs.existsSync(file) && fs.readFileSync(file, 'utf8').split('\n').some((l) => { try { return JSON.parse(l).from === id; } catch { return false; } });
    if (told) return null;
    const notice = { stall: { evaluations: k, versions: window.map((h) => h.version), promoted: 0, deficits_moved: false,
      what_you_may_do: 'open a search of juniors with the act "evolve" from a version without an adapter; the world does not open one itself' } };
    appendRecord(file, { from: id, notice }, { sync: true });
    return notice;
  }

  /** COLLECTING the operator's weight-search branches that have ended (§6.6): each one taken once - a persistent marker in
      branches.jsonl, with everything its delivery is made of (the version it starts from, each elite's set) - and answered
      whole. It makes nothing: applying a delivery is apart (applyDelivery), so a run resumed applies what was collected at
      that act again (its answer recorded by the run) without collecting it twice. */
  collectBranches(): Delivery[] {
    if (!this.weightBranches || !fs.existsSync(this.weightBranches)) return [];
    const file = path.join(this.dir, 'branches.jsonl');
    const taken = new Set(fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').flatMap((l) => { try { return [JSON.parse(l).id as string]; } catch { return []; } }) : []);
    const out: Delivery[] = [];
    for (const f of fs.readdirSync(this.weightBranches).filter((n) => n.endsWith('.finding.json')).sort()) {
      let finding: { id?: string; from?: string; question?: string; stoppedBy?: string; elites?: { niche: string; record: unknown; deficits: unknown }[] };
      try { finding = JSON.parse(fs.readFileSync(path.join(this.weightBranches, f), 'utf8')); } catch { continue; }
      if (!finding.id || taken.has(finding.id) || typeof finding.from !== 'string' || !this.store.get(finding.from)) continue;
      const d: Delivery = { id: finding.id, from: finding.from, question: finding.question ?? null, stopped_by: finding.stoppedBy ?? null,
        elites: (finding.elites ?? []).map((e) => ({ niche: e.niche, record: e.record, deficits: e.deficits })) };
      appendRecord(file, d, { sync: true });
      out.push(d);
    }
    return out;
  }

  /** APPLYING a delivery: its elites made versions of this world from the version it started from (content-addressed: the
      same versions however often it is applied), and its notice - a delegated contribution, never an order nor an answer
      of the world. Live and when a run is resumed alike. */
  applyDelivery(d: Delivery): Record<string, unknown> {
    const versions: { version: string; niche: string; deficits: unknown }[] = [];
    if (this.store.get(d.from)) for (const e of d.elites) {
      /* A search selected it - the branch's - whatever its record says: its lineage registered when it is made here, joined
         to what selected the version it starts from, so its check promotes it on the holdout alone (SPEC-VALIDEZ-MEDIDA §4.3). */
      const record = { ...(e.record as Record<string, unknown>), ...this.lineageFrom(d.from, ['branch:' + d.id]) };
      const v = this.store.apply(d.from, { files: { [EDITS]: JSON.stringify(record, null, 2) + '\n' } }, { branch: d.id, niche: e.niche });
      if (typeof v !== 'string') versions.push({ version: v.hash, niche: e.niche, deficits: e.deficits });
    }
    this.redelivered.add(d.id);
    return { delegated: { branch: d.id, by: 'the operator', question: d.question, stopped_by: d.stopped_by, versions,
      note: 'a search of juniors the operator ran: its elites are versions you may run, adopt or leave' } };
  }

  /** Collected and applied at once (where no run records the collection: tools and tests). */
  deliverBranches(): Record<string, unknown>[] { return this.collectBranches().map((d) => this.applyDelivery(d)); }

  /** Deliveries of this world's record made again when a run is REBUILT from its events (no act is replayed there), each
      once, as soon as the version it starts from exists: what the researcher built on them is then made again on them. */
  redeliver(): string[] {
    const file = path.join(this.dir, 'branches.jsonl');
    if (!fs.existsSync(file)) return [];
    const made: string[] = [];
    for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
      let e: Delivery;
      try { e = JSON.parse(l); } catch { continue; }
      if (!e?.id || this.redelivered.has(e.id) || typeof e.from !== 'string' || !this.store.get(e.from) || !Array.isArray(e.elites)) continue;
      const n = this.applyDelivery(e) as { delegated: { versions: { version: string }[] } };
      made.push(...n.delegated.versions.map((v) => v.version));
    }
    return made;
  }

  /** A junior evaluated on the development cases, by its package (a version, or a candidate of a search). */
  async evaluatePackage(pkg: JuniorPackage, judge?: import('../../runtime/lab-runner.ts').LabConnection, version: string = executionHash(pkg)): Promise<Evaluation | string> {
    /* Valid to run (§10.1) before anything costly: a version whose circuit is not exact is kept, never evaluated. */
    const valid = await this.validity(pkg);
    if (valid !== true) return 'the version is not valid to run: ' + valid;
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
      return job.products as Evaluation;
    } catch (e) { return e instanceof JobRefused ? e.message : String((e as Error).message ?? e); }
  }
}

/** The execution profiles of a file (a list of them), each checked: an operator's configuration, never the researcher's. */
export function programProfilesOf(file: string): import('../../junior/method-program.ts').ExecutionProfile[] {
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error('--program-profiles: ' + file + ' is not JSON (' + String((e as Error).message ?? e) + ')'); }
  const list = Array.isArray(raw) ? raw : (raw as { profiles?: unknown })?.profiles;
  if (!Array.isArray(list)) throw new Error('--program-profiles: a list of profiles');
  for (const p of list) { const e = profileProblemsOf(p); if (e.length) throw new Error('--program-profiles: ' + e.join('; ')); }
  return list as import('../../junior/method-program.ts').ExecutionProfile[];
}

/** What an operator's branch delivered: everything its versions are made of. */
export interface Delivery {
  readonly id: string;
  readonly from: string;
  readonly question: string | null;
  readonly stopped_by: string | null;
  readonly elites: readonly { readonly niche: string; readonly record: unknown; readonly deficits: unknown }[];
}

/** The edit an act asks for: values written, a closed constructor, or a free program. */
export type EditAsked =
  | { readonly written: { readonly modules: readonly { readonly module: string; readonly encoding: 'lowrank' | 'sparse'; readonly B?: number[][]; readonly A?: number[][]; readonly indices?: number[]; readonly values?: number[] }[] } }
  | { readonly construct: { readonly name: string; readonly args: Record<string, unknown>; readonly inputs?: Readonly<Record<string, { readonly from: string; readonly file: string } | { readonly tensors: Readonly<Record<string, number[]>> }>> } }
  | { readonly program: { readonly code: string; readonly inputs?: Readonly<Record<string, string>> } };

/** What a search asked, by its content: the key of its record (and of its search's file). */
export function evolveKey(ev: Record<string, any>): string {
  return createHash('sha256').update(JSON.stringify([ev.from, (ev.seeds ?? []).map((s: Record<string, any>) => editOf(s)), ev.control_seeds, ev.max_candidates, ev.operators ?? null, ev.seed ?? null])).digest('hex').slice(0, 24);
}

/** What an edit act asked, by its content: the key of its record when a run is rebuilt. */
export function askedKey(from: string, e: EditAsked, hypothesis: unknown, declared: unknown): string {
  return createHash('sha256').update(JSON.stringify([from, e, hypothesis, declared ?? null])).digest('hex').slice(0, 24);
}

export interface JuniorSpec {
  readonly world: JuniorWorld;
  /** Where the operator puts the confirmation summaries published for this run (§9): read-only, summaries only. */
  readonly confirmations?: string;
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
  | { readonly kind: 'records'; readonly what: 'examples' | 'dataset' | 'training' | 'confirmations' | 'weights' | 'edit' | 'evolution'; readonly summary: Readonly<Record<string, unknown>>; readonly rows: readonly Readonly<Record<string, unknown>>[] };

export interface JuniorCase { readonly point: string; readonly state: JuniorPoint; readonly came: { readonly value: number | null } }

type Reason = { readonly why: string; readonly because?: readonly string[] } & ({ readonly expect: string } | { readonly exploratory: true });
export type JuniorAct =
  | { readonly change: { readonly from: string; readonly files: Readonly<Record<string, string>> } & Reason }
  | { readonly run: { readonly version: string } }
  | { readonly publish_memory: { readonly from: string; readonly session: string } & Reason }
  | { readonly distill: { readonly version: string; readonly case: string; readonly question: number; readonly mode: Mode; readonly checker: string; readonly request?: string; readonly instruction?: string } }
  | { readonly dataset: { readonly examples: readonly string[]; readonly admits: readonly ('verified' | 'demonstration')[] } }
  | { readonly train: { readonly from: string; readonly dataset: string; readonly recipe: Readonly<Record<string, unknown>> } & Reason }
  | { readonly confirmations: Readonly<Record<string, never>> }
  | { readonly inspect_weights: { readonly version: string; readonly query: LabQuery['query']; readonly args?: Record<string, unknown>; readonly cases?: readonly LabCase[]; readonly candidate?: string } }
  | { readonly edit: { readonly from: string; readonly edit: EditAsked; readonly competence: string; readonly bounds?: WeightBounds } & Reason }
  | { readonly evolve: { readonly from: string; readonly seeds: readonly Record<string, unknown>[]; readonly control_seeds: number; readonly max_candidates: number; readonly operators?: Readonly<Record<string, number>>; readonly seed?: number } & Reason };

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
  /* The holdout's answers are never shown: what the researcher selects on stays apart from what promotes it (§4.3). */
  const held = new Set(w.manifest.holdout ?? []);
  const shown = withoutHoldout(w.manifest);
  const observations = e.observations.filter((o) => !held.has(o.case));
  const measured = held.size ? measure(shown, e.partition, e.temperature, observations) : e.measure;
  e = { ...e, observations, measure: measured };
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

/** A count from an option: absent or empty is its default; an explicit 0 is 0 (never the default by falsiness). */
export function count(v: unknown, fallback: number): number {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(0, n) : fallback;
}

/** The edit an act asks for, or null when it asks for none or more than one. */
function editOf(raw: Record<string, any>): { edit: EditAsked; hypothesis: { competence: string; mechanism: string; effect: string } } | null {
  /* As the researcher wrote it, or as parsed (its edit nested under "edit"). */
  const ed = raw.edit && typeof raw.edit === 'object' ? { ...raw, ...raw.edit } : raw;
  const kinds = ['written', 'construct', 'program'].filter((k) => ed[k] && typeof ed[k] === 'object');
  if (kinds.length !== 1) return null;
  const k = kinds[0];
  let edit: EditAsked;
  if (k === 'written') {
    if (!Array.isArray(ed.written.modules) || !ed.written.modules.length || ed.written.modules.some((m: Record<string, unknown>) => typeof m?.module !== 'string' || (m.encoding !== 'lowrank' && m.encoding !== 'sparse'))) return null;
    edit = { written: { modules: ed.written.modules } };
  } else if (k === 'construct') {
    if (typeof ed.construct.name !== 'string' || !ed.construct.args || typeof ed.construct.args !== 'object') return null;
    edit = { construct: { name: ed.construct.name, args: ed.construct.args, ...(ed.construct.inputs ? { inputs: ed.construct.inputs } : {}) } };
  } else {
    if (typeof ed.program.code !== 'string' || !ed.program.code.trim()) return null;
    edit = { program: { code: ed.program.code, ...(ed.program.inputs ? { inputs: ed.program.inputs } : {}) } };
  }
  return { edit, hypothesis: hypothesisOf(ed) };
}

/** A seed of a search as the act evolve (or an operator's branch) gives it: one edit with its competence and why. */
export function editOfSeed(s: Record<string, unknown>): ReturnType<typeof editOf> {
  if (typeof s?.competence !== 'string' || !s.competence.trim() || typeof s.why !== 'string' || !s.why.trim()) return null;
  return editOf(s as Record<string, any>);
}

/** An edit's hypothesis (E1), from its act: the competence it corrects, the mechanism it supposes (its why), its effect. */
function hypothesisOf(ed: Record<string, any>): { competence: string; mechanism: string; effect: string } {
  return { competence: String(ed.competence ?? ''), mechanism: String(ed.why ?? ''), effect: typeof ed.expect === 'string' && ed.expect.trim() ? ed.expect : 'exploratory' };
}

/** What an act gives as its reason, as a change does. */
function reasonOf(ed: Record<string, any>): Record<string, unknown> {
  const { from: _f, written: _w, construct: _c, program: _p, bounds: _b, ...reason } = ed;
  return reason;
}

/** The acts of weight editing, told only to a run that pays for them (SPEC-EDICION-PESOS §5). */
const WEIGHT_ACTS = 'Or {"act": {"inspect_weights": {"version": "<version>", "query": "modules" | "weights.stats" | "weights.slice" | "forward" | "activations" | "attention" | "try", "args": {...}, "cases": [{"cut": {"run": "<diagnosis run>", "question": <n>}} | {"text": {"system": "...", "user": "..."}}], "candidate": "<version, for try>"}}}   '
  + 'a reading of the junior\'s weights: its modules (the circuit\'s readable, never editable), a module\'s statistics ("module", "singular": k) or a slice ("module", "rows": [from, to], "cols": [from, to]); or the junior run on DIAGNOSIS cases only - cuts of the diagnosis runs, or texts you write: "forward" ("max_new_tokens", "top_logits"), "activations" ("modules", "positions": "last" | "generated" | [...], "directions"), "attention" ("layer", "heads"), "try" ("inner": forward | activations, "args", and a "candidate" version whose edits run on a copy). Each query costs one of `lab_queries`, and the tokens it runs of `lab_tokens`; its answer is withheld past the lab\'s limits; asked again it is the same. '
  + 'Or {"act": {"edit": {"from": "<version>", "written": {"modules": [{"module": "<name>", "encoding": "lowrank", "B": [[...] per output row], "A": [[...] per rank]} | {"module": "<name>", "encoding": "sparse", "indices": [...], "values": [...]}]} '
  + '| "construct": {"name": "project_out@1" | "add_direction@1" | "mean_difference@1" | "top_singular@1" | "scale_rows@1" | "scale_cols@1", "args": {...}, "inputs": {"<file>": {"from": "<operation of an inspect_weights>", "file": "activations.safetensors"} | {"tensors": {"<name>": [...]}}}} '
  + '| "program": {"code": "...", "inputs": {...}}, "competence": "<what it corrects>", "why": "<the mechanism you suppose>", "expect": "<the effect you expect>" | "exploratory": true, "bounds": {stricter bounds}}}}   '
  + 'a child junior with one edit more to its weights, on Qwen\'s modules only, composed from its start; refused out of the condition\'s bounds. A program runs only where an isolated backend proves itself. It costs one of `edits`; before it is evaluated its circuit must pass the validity suite. ';

/** The act that opens a search of juniors: told only to a run that may open one (condition B of the comparison may not). */
const EVOLVE_ACT = 'Or {"act": {"evolve": {"from": "<version without an adapter>", "seeds": [<edits as above, each with its "competence", "why", "expect">, ...], "control_seeds": <n>, "max_candidates": <n>, "operators": {"scale" | "drop" | "combine" | "retarget" | "sparsify" | "perturb" | "reinit": <weight>}, "seed": <n>, "why": "...", "expect": "..." | "exploratory": true}}}   '
  + 'a search of juniors: your seeds - DISTINCT hypotheses, in other modules or by other means - with random controls of the same size, varied by code operators (perturb and reinit bring directions nobody proposed), each candidate checked (bounds, circuit), measured on the selection probes, and kept by niche - which probe components it improves and where it acts. Its elites come back as versions you may run, adopt or leave; each candidate composed costs one of `edits`, each measured one of `evaluations`.';

/** Its own methods as programs (SPEC-INVESTIGACION-EXTERNA §8, IE5): told only where the operator enabled profiles. */
const programAct = (profiles: readonly string[]): string => 'Or, as the recipe of a train, YOUR OWN METHOD as a program: {"format": "junior-recipe@1", "method": "program", "admits": ["verified"], "program": {"format": "method-program@1", "entrypoint": "<file>", "files": {"<file>": "<its code>"}, "profile": "' + profiles.join('" | "') + '", "inputs": ["dataset.jsonl", ...], "parameters": {...}, "seed": <n>, "output_format": "weight-edit-set@1", "cites": ["src:..."]}}   '
  + 'the program reads inputs/dataset.jsonl (the dataset\'s rows) and inputs/job.json, the start\'s weights read-only, and writes out/result.json ({"format", "products"}) and its products (out/modules.json and the safetensors of a set of edits). It runs only where an isolated backend is proved, without network; what it makes is imported as an edit LEARNED FROM DATA, and the evaluator - never the program - says what it is worth. ';

function juniorInterface(tolerance: number, weights = false, searches = true, profiles: readonly string[] = []): WorldInterface {
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
        + 'Or {"act": {"distill": {"version": "<version evaluated>", "case": "<an investigation of development or training>", "question": <n, from 0>, "mode": "start" | "cut", "checker": "protocol" | "request" | "rules" | "proposal", "request": "<kind>", "instruction": "<a visible task>"}}}   '
        + 'the junior and the teacher answer from the same point of that investigation (cut: with the junior\'s memory there; start: with its initial memory), each in a copy; the checker, fixed before the teacher answers, judges both: an EXAMPLE, verified when the teacher passes where the junior fails, unverified when both pass, rejected when the teacher fails. Each costs one of `distillations`. '
        + 'Or {"act": {"dataset": {"examples": ["<example id>", ...], "admits": ["verified"]}}}   a dataset of examples, by its content, with the groups of runs it comes from and those it shares with the probes that select juniors. '
        + 'Or {"act": {"train": {"from": "<version>", "dataset": "<dataset id>", "recipe": {"format": "junior-recipe@1", "method": "lora" | "qlora", "layers": [<Qwen layers, past the circuit\'s>], "modules": ["q_proj", ...], "rank", "alpha", "dropout", "learning_rate", "epochs", "batch", "max_length", "seed", "mask": "answer", "admits": ["verified"], "max_gpu_hours"}, "why": "...", "expect": "..." | "exploratory": true}}}   '
        + 'a child junior with a LoRA adapter trained on that dataset; its circuit is never trained. Its capacity is measured first; it costs its GPU hours; a dataset that shares groups with the selecting probes is refused. Before it is evaluated, its circuit must pass the validity suite. '
        + (weights ? WEIGHT_ACTS + (searches ? EVOLVE_ACT : '') + ' ' : '')
        + (profiles.length ? programAct(profiles) : '')
        + 'Or {"act": {"confirmations": {}}}   the confirmations the operator made of your juniors, out of this machine, on cases you never see: for each, the verdict against the reference and which components improve or regress - nothing more. At most `acts_left` this round.'],
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
      /* The branches delivered before this act, made again before it (it may build on them). */
      spec.world.redeliver();
      const c = r?.act?.change;
      if (c && typeof c.from === 'string' && c.files) {
        const { from: _f, files: _x, ...reason } = c;
        const made = spec.world.change(c.from, c.files, reason);
        if (!('error' in made)) latest.set(spec.world, made.version);
      }
      /* A training, from the world's record of its adapter. */
      const tr = r?.act?.train;
      if (tr && typeof tr.from === 'string' && typeof tr.dataset === 'string' && tr.recipe) {
        const { from: _f, dataset: _d, recipe: _r, ...reason } = tr;
        const made = spec.world.retrain(tr.from, tr.dataset, tr.recipe, reason);
        if (made) latest.set(spec.world, made);
      }
      /* An edit, from the world's record of its set: never composed again. */
      const ed = r?.act?.edit;
      if (ed && typeof ed.from === 'string') {
        const asked = editOf(ed);
        if (asked) {
          const made = spec.world.reedit(ed.from, askedKey(ed.from, asked.edit, asked.hypothesis, ed.bounds), reasonOf(ed));
          if (made) latest.set(spec.world, made);
        }
      }
      /* A search, from the world's record of its elites: never searched again. */
      const evo = r?.act?.evolve;
      if (evo && typeof evo.from === 'string') {
        const made = spec.world.reevolve(evo.from, evolveKey(evo));
        if (made.length) latest.set(spec.world, made[made.length - 1]);
      }
      /* A publication, from the world's record of the state it published. */
      const pm = r?.act?.publish_memory;
      if (pm && typeof pm.from === 'string' && typeof pm.session === 'string') {
        const { from: _f, session: _s, ...reason } = pm;
        const made = spec.world.republish(pm.from, pm.session, { ...reason, published_from: pm.session });
        if (made) latest.set(spec.world, made);
      }
    }
    /* And those delivered after the last act. */
    spec.world.redeliver();
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
    { name: 'confirmations', default: '', help: 'where the operator puts the confirmation summaries of this run\'s juniors (read-only)' },
    { name: 'gpu-hours', default: '0', help: 'GPU hours of training the run may spend in all (0: no training)' },
    { name: 'train-python', default: '', help: 'the trainer\'s interpreter on the training GPU (none: no training)' },
    { name: 'train-backend', default: 'qwenputer', help: 'the trainer\'s backend: qwenputer, or fake for tests' },
    { name: 'lab-queries', default: '0', help: 'queries to the weight laboratory the run may make in all (0: none; the manifest needs weight_lab)' },
    { name: 'lab-tokens', default: '0', help: 'tokens the weight laboratory\'s queries may run in all' },
    { name: 'edits', default: '0', help: 'edited versions of the junior the run may make in all (0: none; the manifest needs weight_edits)' },
    { name: 'searches', default: '', help: 'searches of juniors (evolve) the run may open in all (empty: no limit; 0: none)' },
    { name: 'weight-branches', default: '', help: 'where the weight-search branches of the operator leave their findings: their elites delivered to the researcher as versions (read-only)' },
    { name: 'program-profiles', default: '', help: 'a file of execution profiles the operator enables for the researcher\'s own methods as programs (SPEC-INVESTIGACION-EXTERNA §8); none: no program recipes' },
    { name: 'lab-python', default: 'python3', help: 'the interpreter of the isolated backend for free programs (its self-test decides whether they run)' },
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
      distillations: count(o.distillations, 20), gpuHours: Math.max(0, Number(o['gpu-hours']) || 0),
      ...(o['train-python'] ? { training: { python: [o['train-python']], backend: (o['train-backend'] === 'fake' ? 'fake' : 'qwenputer') as 'fake' | 'qwenputer' } } : {}), ...(store ? { store } : {}),
      labQueries: Math.max(0, Math.floor(Number(o['lab-queries']) || 0)), labTokens: Math.max(0, Math.floor(Number(o['lab-tokens']) || 0)), edits: Math.max(0, Math.floor(Number(o.edits) || 0)),
      labPython: [o['lab-python'] || 'python3'], ...(o.searches !== undefined && o.searches !== '' ? { searches: Math.max(0, Math.floor(Number(o.searches) || 0)) } : {}), ...(o['weight-branches'] ? { weightBranches: path.resolve(o['weight-branches']) } : {}),
      ...(o['program-profiles'] ? { programProfiles: programProfilesOf(path.resolve(o['program-profiles'])) } : {}) });
    const env = process.env;
    const judge = env.JEV_KEY ? { url: env.JEV_URL || 'https://openrouter.ai/api/v1/chat/completions', key: env.JEV_KEY, ...(env.JEV_MODEL ? { model: env.JEV_MODEL } : {}) } : undefined;
    /* The teacher, configured as any researcher: its endpoint and model given, its key from the environment (the proxy's
       client token on the junior's machine), never recorded. */
    const teacherUrl = o['teacher-url'] || env.TEACHER_LLM_URL, teacherModel = o['teacher-model'] || env.TEACHER_LLM_MODEL;
    const teacher = teacherUrl && teacherModel ? { client: openAiChatClient({ url: teacherUrl, apiKey: env.TEACHER_LLM_KEY, model: teacherModel, jsonMode: true, temperature: 0.3, timeoutMs: 180000, retries: 1 }),
      identity: { model: teacherModel, path: (() => { try { return new URL(teacherUrl).pathname; } catch { return null; } })() } } : undefined;
    return { world, ...(judge ? { judge } : {}), ...(teacher ? { teacher } : {}), ...(o.confirmations ? { confirmations: path.resolve(o.confirmations) } : {}) };
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
  interface: (options) => juniorInterface(Number(options.world?.tolerance) || 0.25, Number(options.world?.edits) > 0 || Number(options.world?.['lab-queries']) > 0, String(options.world?.searches ?? '') !== '0',
    options.world?.['program-profiles'] ? programProfilesOf(String(options.world['program-profiles'])).map((p) => p.id) : []),

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
    async check(spec, version, _context, ctx) {
      const ref = await spec.world.evaluate(spec.world.reference, spec.judge);
      const cand = await spec.world.evaluate(version, spec.judge);
      if (typeof ref === 'string' || typeof cand === 'string') return { holds: false, view: { verdict: 'inconclusive', why: 'not evaluated' }, journal: { error: typeof ref === 'string' ? ref : cand } };
      /* One rule whatever path presents a candidate (SPEC-VALIDEZ-MEDIDA §4.3): one a search selected - by its lineage - is
         promoted on the holdout alone, and never without one. */
      const { promoteCandidate } = await import('../../junior/evaluate.ts');
      const p = promoteCandidate(spec.world.manifest, spec.world.manifestHash, ref, cand, { fromSearch: spec.world.searchesOf(version).length > 0 });
      spec.world.notePromotion(version, p.verdict === 'promoted');
      const stall = spec.world.stall();
      if (stall) ctx?.publish?.({ kind: 'notice', body: stall });
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

  /* Its acts' kinds (SPEC-VALIDEZ-MEDIDA §6.1): each makes a version, an evaluation, a dataset or a search - an experiment -
     but a query of the weight laboratory reads the weights, and the confirmations are summaries it reads. */
  requests: { change: 'experiment', run: 'experiment', publish_memory: 'experiment', distill: 'experiment', dataset: 'experiment', train: 'experiment',
    edit: 'experiment', evolve: 'experiment', inspect_weights: 'observation', confirmations: 'recall' },

  act: {
    parse: (raw) => {
      const unknown = unknownFields(raw, ['change', 'run', 'publish_memory', 'distill', 'dataset', 'train', 'confirmations', 'inspect_weights', 'edit', 'evolve']);
      if (unknown) return unknown;
      if (raw.confirmations !== undefined) return { confirmations: {} };
      const iw = raw.inspect_weights as Record<string, unknown> | undefined;
      if (iw && typeof iw === 'object') {
        const form = '"inspect_weights": {"version": "<version>", "query": "modules" | "weights.stats" | "weights.slice" | "forward" | "activations" | "attention" | "try", "args": {...}, "cases": [{"cut": {"run": "<diagnosis run>", "question": <n>}} | {"text": {"system": "...", "user": "..."}}], "candidate": "<version, for try>"}';
        const extra = unknownFields(iw, ['version', 'query', 'args', 'cases', 'candidate']);
        if (extra) return extra;
        if (typeof iw.version !== 'string' || typeof iw.query !== 'string' || (iw.args !== undefined && (typeof iw.args !== 'object' || iw.args === null || Array.isArray(iw.args)))
          || (iw.cases !== undefined && !Array.isArray(iw.cases)) || (iw.candidate !== undefined && typeof iw.candidate !== 'string')) return form;
        return { inspect_weights: { version: iw.version, query: iw.query as LabQuery['query'], ...(iw.args ? { args: iw.args as Record<string, unknown> } : {}),
          ...(iw.cases ? { cases: iw.cases as LabCase[] } : {}), ...(iw.candidate ? { candidate: iw.candidate as string } : {}) } };
      }
      const ev = raw.evolve as Record<string, unknown> | undefined;
      if (ev && typeof ev === 'object') {
        const form = '"evolve": {"from": "<version without an adapter>", "seeds": [{"written" | "construct" | "program": ..., "competence": "...", "why": "...", "expect": "..."}, ...], "control_seeds": <n>, "max_candidates": <n>, "operators": {"scale": w, ...}, "seed": <n>, "why": "...", "expect": "..." | "exploratory": true}';
        const extra = unknownFields(ev, ['from', 'seeds', 'control_seeds', 'max_candidates', 'operators', 'seed', 'why', 'expect', 'exploratory', 'because']);
        if (extra) return extra;
        if (typeof ev.from !== 'string' || !Array.isArray(ev.seeds) || !ev.seeds.length || !Number.isInteger(ev.control_seeds) || !Number.isInteger(ev.max_candidates)) return form;
        if (typeof ev.why !== 'string' || !ev.why.trim()) return 'a search says why: ' + form;
        const expect = typeof ev.expect === 'string' && ev.expect.trim() ? ev.expect : null;
        if (!expect && ev.exploratory !== true) return 'a search says what it expects, or that it is exploratory: ' + form;
        for (const s of ev.seeds as Record<string, unknown>[]) {
          if (!s || typeof s !== 'object' || !editOf(s)) return 'each seed is one edit (written, construct or program): ' + form;
          if (typeof s.competence !== 'string' || !s.competence.trim() || typeof s.why !== 'string' || !s.why.trim()) return 'each seed says its competence and why (its hypothesis): ' + form;
        }
        return { evolve: { from: ev.from, seeds: ev.seeds as Record<string, unknown>[], control_seeds: ev.control_seeds as number, max_candidates: ev.max_candidates as number,
          ...(ev.operators && typeof ev.operators === 'object' ? { operators: ev.operators as Record<string, number> } : {}), ...(Number.isInteger(ev.seed) ? { seed: ev.seed as number } : {}),
          why: ev.why, ...(expect ? { expect } : { exploratory: true as const }) } };
      }
      const ed = raw.edit as Record<string, unknown> | undefined;
      if (ed && typeof ed === 'object') {
        const form = '"edit": {"from": "<version>", "written": {"modules": [...]} | "construct": {"name": "<constructor>", "args": {...}, "inputs": {...}} | "program": {"code": "...", "inputs": {...}}, "competence": "<what it corrects>", "why": "<the mechanism you suppose>", "expect": "<the effect you expect>" | "exploratory": true, "bounds": {stricter bounds, optional}}';
        const extra = unknownFields(ed, ['from', 'written', 'construct', 'program', 'competence', 'why', 'expect', 'exploratory', 'because', 'bounds']);
        if (extra) return extra;
        if (typeof ed.from !== 'string') return form;
        if (typeof ed.why !== 'string' || !ed.why.trim()) return 'an edit says why (the mechanism it supposes): ' + form;
        if (typeof ed.competence !== 'string' || !ed.competence.trim()) return 'an edit says the competence it corrects: ' + form;
        const expect = typeof ed.expect === 'string' && ed.expect.trim() ? ed.expect : null;
        if (!expect && ed.exploratory !== true) return 'an edit says what it expects, or that it is exploratory: ' + form;
        const asked = editOf(ed);
        if (!asked) return 'an edit is one of written, construct or program: ' + form;
        const because = Array.isArray(ed.because) && ed.because.length && ed.because.every((b) => typeof b === 'string') ? { because: [...new Set(ed.because as string[])] } : {};
        return { edit: { from: ed.from, edit: asked.edit, competence: ed.competence, why: ed.why, ...because, ...(expect ? { expect } : { exploratory: true as const }),
          ...(ed.bounds && typeof ed.bounds === 'object' ? { bounds: ed.bounds as WeightBounds } : {}) } };
      }
      const tr = raw.train as Record<string, unknown> | undefined;
      if (tr && typeof tr === 'object') {
        const form = '"train": {"from": "<version>", "dataset": "<dataset id>", "recipe": {junior-recipe@1}, "why": "<the hypothesis>", "expect": "<what you expect>" | "exploratory": true}';
        const extra = unknownFields(tr, ['from', 'dataset', 'recipe', 'why', 'expect', 'exploratory', 'because']);
        if (extra) return extra;
        if (typeof tr.from !== 'string' || typeof tr.dataset !== 'string' || !tr.recipe || typeof tr.recipe !== 'object') return form;
        if (typeof tr.why !== 'string' || !tr.why.trim()) return 'a training says why: ' + form;
        const expect = typeof tr.expect === 'string' && tr.expect.trim() ? tr.expect : null;
        if (!expect && tr.exploratory !== true) return 'a training says what it expects, or that it is exploratory: ' + form;
        return { train: { from: tr.from, dataset: tr.dataset, recipe: tr.recipe as Record<string, unknown>, why: tr.why, ...(expect ? { expect } : { exploratory: true as const }) } };
      }
      const d = raw.distill as Record<string, unknown> | undefined, ds = raw.dataset as Record<string, unknown> | undefined;
      if (d && typeof d === 'object') {
        const form = '"distill": {"version": "<version>", "case": "<an investigation of development or training>", "question": <its question, from 0>, "mode": "start" | "cut", "checker": "protocol" | "request" | "rules" | "proposal", "request": "<kind, for checker request>", "instruction": "<a visible task, optional>"}';
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
      return 'act needs "change", "run", "publish_memory", "distill", "dataset", "train", "inspect_weights", "edit", "evolve" or "confirmations"';
    },
    place: () => undefined,
    async start(spec, a, id, ctx?: LabContext) {
      const episode = await (async (): Promise<JuniorEpisode | null> => {
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
      if ('confirmations' in a) {
        /* The operator's confirmations of this run's juniors: the summaries published, nothing else - no case, no trace. */
        const { readSummaries } = await import('../../junior/confirm.ts');
        const versions = new Map<string, string>();
        for (const f of fs.existsSync(path.join(spec.world.dir, 'packages')) ? fs.readdirSync(path.join(spec.world.dir, 'packages')) : []) {
          try { versions.set(executionHash(JSON.parse(fs.readFileSync(path.join(spec.world.dir, 'packages', f), 'utf8'))), f.replace(/\.json$/, '')); } catch { /* not a package */ }
        }
        const rows = readSummaries(spec.confirmations ?? '').map((s) => ({ ...s, version: versions.get(s.candidate) ?? null }));
        return { kind: 'records', what: 'confirmations', summary: { confirmations: rows.length, promoted: rows.filter((r) => r.verdict === 'promoted').length }, rows };
      }
      if ('inspect_weights' in a) {
        const q = a.inspect_weights;
        const r = await spec.world.inspectWeights(q.version, { query: q.query, ...(q.args ? { args: q.args } : {}), ...(q.cases ? { cases: q.cases } : {}), ...(q.candidate ? { candidate: q.candidate } : {}) });
        if ('refused' in r) return { kind: 'records', what: 'weights', summary: { query: q.query, state: 'refused', reason: r.refused }, rows: [] };
        const answer = spec.world.weightLab!.answer(r);
        return { kind: 'records', what: 'weights', summary: { query: r.query, operation: r.operation_id, state: r.state, ...(r.reason ? { reason: r.reason } : {}),
          tokens: r.usage ? r.usage.tokens_in + r.usage.tokens_out : null, circuit_steps: r.usage?.circuit_steps ?? null, files: Object.keys(r.files), cases: r.cases },
          rows: answer === null ? [] : [{ answer: answer as Record<string, unknown> }] };
      }
      if ('evolve' in a) {
        const { from, seeds, control_seeds, max_candidates, operators, seed, ...reason } = a.evolve;
        const asked = evolveKey(a.evolve);
        const made = seeds.map((s) => editOf(s)!).filter(Boolean);
        const t = await spec.world.evolveFrom(from, { seeds: made, control_seeds, max_candidates, ...(operators ? { operators } : {}), ...(seed !== undefined ? { seed } : {}) }, reason, asked);
        if (t.versions?.length) latest.set(spec.world, t.versions[t.versions.length - 1].version);
        return { kind: 'records', what: 'evolution', summary: { state: t.state, ...(t.reason ? { reason: t.reason } : {}), ...(t.stoppedBy ? { stopped_by: t.stoppedBy } : {}), ...(t.counts ? { counts: t.counts } : {}),
          elites: t.versions?.length ?? 0 }, rows: (t.versions ?? []).map((v) => ({ version: v.version, niche: v.niche, genome: v.genome, deficits: v.deficits as Record<string, unknown>, origin: v.origin as Record<string, unknown> })) };
      }
      if ('edit' in a) {
        const { from, edit, competence, bounds, ...reason } = a.edit;
        const hypothesis = hypothesisOf(a.edit);
        const t = await spec.world.editFrom(from, edit, hypothesis, bounds, { ...reason, competence });
        if (t.version) latest.set(spec.world, t.version);
        return { kind: 'records', what: 'edit', summary: { state: t.state, ...(t.version ? { version: t.version } : {}), ...(t.reason ? { reason: t.reason } : {}), ...(t.edit ? { edit: t.edit } : {}),
          ...(t.genome !== undefined ? { genome: t.genome } : {}), ...(t.totals ? { totals: t.totals } : {}) }, rows: [] };
      }
      if ('train' in a) {
        const { from: _f, dataset: _d, recipe: _r, ...reason } = a.train;
        const t = await spec.world.trainFrom(a.train.from, a.train.dataset, a.train.recipe, reason);
        if (t.version) latest.set(spec.world, t.version);
        return { kind: 'records', what: 'training', summary: { state: t.state, ...(t.version ? { version: t.version } : {}), ...(t.reason ? { reason: t.reason } : {}), steps: t.steps ?? null, gpu_hours: t.gpu_hours ?? null, ...(t.job ? { job: t.job } : {}) }, rows: [] };
      }
      if ('dataset' in a) {
        const r = await spec.world.dataset(a.dataset.examples, a.dataset.admits);
        if (typeof r === 'string') return null;
        return { kind: 'records', what: 'dataset', summary: { dataset: r.dataset.id, examples: r.dataset.examples.length, admits: r.dataset.admits, proportions: r.dataset.proportions, groups: r.dataset.groups,
          shares_selection_groups: r.overlap }, rows: r.dataset.examples.map((id) => ({ example: id })) };
      }
      const run = (a as { run: { version: string } }).run;
      const e = await spec.world.evaluate(run.version, spec.judge);
      return typeof e === 'string' ? null : evaluationEpisode(spec.world, run.version, e);
      })();
      /* After the act: what the operator's branches delivered - collected once, its answer recorded by the run at this act
         (none is an answer too), applied the same live and when the run is resumed - and a stall if there is one: facts,
         published as the world. */
      const collect = async () => spec.world.collectBranches();
      const deliveries = ctx?.recorded ? await ctx.recorded('/weight-branches', { act: id }, collect) : await collect();
      for (const d of deliveries) {
        const n = spec.world.applyDelivery(d);
        ctx?.publish?.({ kind: 'notice', body: n });
      }
      const stall = spec.world.stall();
      if (stall) ctx?.publish?.({ kind: 'notice', body: stall });
      return episode;
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
