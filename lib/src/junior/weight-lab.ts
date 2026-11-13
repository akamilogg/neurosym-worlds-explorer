import type { RunCapture } from './groups.ts';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { stableStringify } from '../core/hash.ts';
import type { CompetenceManifest } from './competence.ts';
import { measuringGroups } from './groups.ts';
import { JobLedger, JobRefused, type Job } from './jobs.ts';
import { executionHash, normalizePackage, type BlobId, type BlobStore, type JuniorPackage } from './package.ts';
import type { LabServed } from './sessions.ts';
import { construct, readSafetensors, type Authorship, type Hypothesis } from './weights.ts';
import type { ProgramLimits } from './isolation.ts';

/* ============================================================================
 * The WEIGHT LABORATORY (SPEC-EDICION-PESOS §4, WE2): what the strong model reads of the junior to propose edits. It only
 * reads - its `try` composes a candidate on a copy - and runs only DIAGNOSIS cases: cuts of the development runs the
 * manifest assigns to diagnosis groups, or texts the strong model writes. Never a probe that selects, never a case of
 * confirmation (E3): the groups and runs of diagnosis are disjoint from those of every case of the manifest.
 *
 * Every query is a job of the junior's ledger: it reserves one `lab_queries` and, when it runs the junior, the most
 * `lab_tokens` it may spend; it settles what it consumed (unknown when cut by its time: kept as uncertain). Asked again with
 * the same operation id it is the same query, never charged twice. Its arguments are checked against the manifest's
 * limits before it is sent; what it consumed (tokens, circuit steps, time, peak memory, size of its answer) is in its
 * receipt, and a query past a limit it could only be measured against (tokens, memory, size) has its answer withheld.
 * It runs in the server's one queue of the inference GPU, by the lab's own process.
 * ========================================================================== */

export interface LabLimits {
  /** Diagnosis cases in one query. */
  readonly max_cases: number;
  /** Tokens generated per case. */
  readonly max_new_tokens: number;
  /** Tokens in and out summed over the cases of one query: what it reserves of lab_tokens. */
  readonly max_tokens: number;
  readonly max_slice_entries: number;
  readonly max_singular: number;
  readonly max_top_logits: number;
  readonly max_positions: number;
  readonly max_heads: number;
  readonly max_modules: number;
  readonly max_directions: number;
  readonly timeout_ms: number;
  readonly max_memory_bytes: number;
  /** Bytes of the answer's JSON. */
  readonly max_response_bytes: number;
}

export interface WeightLabConfig {
  /** The diagnosis groups and their development runs (journals): the only cuts the lab runs. */
  readonly diagnosis: Readonly<Record<string, readonly string[]>>;
  readonly limits: LabLimits;
  /** The limits of a free program in the isolated backend (§4.4), when programs are allowed at all. */
  readonly program?: ProgramLimits;
}

const LIMITS: readonly (keyof LabLimits)[] = ['max_cases', 'max_new_tokens', 'max_tokens', 'max_slice_entries', 'max_singular', 'max_top_logits', 'max_positions', 'max_heads',
  'max_modules', 'max_directions', 'timeout_ms', 'max_memory_bytes', 'max_response_bytes'];
const PROGRAM: readonly ('timeout_ms' | 'memory_bytes' | 'cpu_seconds' | 'output_bytes')[] = ['timeout_ms', 'memory_bytes', 'cpu_seconds', 'output_bytes'];

/** Everything wrong with a manifest's weight laboratory: its limits, and diagnosis disjoint from selection and
    confirmation - no group shared with a case, no run shared with a probe's cut. */
export function weightLabProblems(raw: unknown, m: Pick<CompetenceManifest, 'cases'>): string[] {
  const w = raw as WeightLabConfig;
  const p: string[] = [];
  if (!w || typeof w !== 'object' || !w.diagnosis || typeof w.diagnosis !== 'object' || !w.limits) return ['"weight_lab": {"diagnosis": {group: [runs]}, "limits": {' + LIMITS.join(', ') + '}}'];
  for (const k of LIMITS) if (!Number.isInteger(w.limits[k]) || w.limits[k] <= 0) p.push('"weight_lab.limits.' + k + '": a whole number above 0');
  if (w.program) for (const k of PROGRAM) if (!Number.isInteger(w.program[k]) || w.program[k] <= 0) p.push('"weight_lab.program.' + k + '": a whole number above 0');
  /* The one rule of groups.ts: a diagnosis group is none that selects or confirms. */
  const caseGroups = measuringGroups({ cases: m.cases ?? [] });
  const probeRuns = new Set((m.cases ?? []).flatMap((c) => c.kind === 'probe' ? [path.resolve(c.cut.run)] : []));
  if (!Object.keys(w.diagnosis).length) p.push('"weight_lab.diagnosis": at least one group');
  for (const [g, runs] of Object.entries(w.diagnosis)) {
    if (caseGroups.has(g)) p.push('diagnosis group ' + g + ' is a group of the manifest\'s cases: diagnosis, selection and confirmation never share one');
    if (!Array.isArray(runs) || !runs.length || runs.some((r) => typeof r !== 'string')) { p.push('diagnosis group ' + g + ': its runs (journals)'); continue; }
    for (const r of runs) if (probeRuns.has(path.resolve(r))) p.push('diagnosis run ' + r + ' is cut by a probe that selects');
  }
  return p;
}

/** A diagnosis case as the strong model asks for it: a cut of a diagnosis run, or a text of its own. */
export type LabCase = { readonly cut: { readonly run: string; readonly question: number } } | { readonly text: { readonly system?: string; readonly user: string } };

export interface LabQuery {
  readonly query: 'modules' | 'weights.stats' | 'weights.slice' | 'forward' | 'activations' | 'attention' | 'try';
  readonly args?: Readonly<Record<string, unknown>>;
  readonly cases?: readonly LabCase[];
  /** For try: the candidate version whose set of edits runs on a copy. */
  readonly candidate?: JuniorPackage;
}

export interface LabReceipt {
  readonly operation_id: string;
  readonly query: string;
  readonly args: unknown;
  readonly execution: string;
  /** Each case by the hash of what the junior was given, with where it came from. */
  readonly cases: readonly { readonly hash: string; readonly source: 'cut' | 'text'; readonly run?: string; readonly question?: number; readonly group?: string; readonly capture?: RunCapture }[];
  readonly set: BlobId | null;
  readonly state: 'answered' | 'failed' | 'timeout' | 'over_limit';
  readonly reason: string | null;
  readonly usage: LabServed['usage'];
  readonly response_bytes: number;
  /** The answer, as a blob (withheld past a limit). */
  readonly result: BlobId | null;
  readonly files: Readonly<Record<string, BlobId>>;
  readonly queue_ms: number;
  readonly run_ms: number;
}

/** What runs the query: the server, or its client over HTTP. */
export interface LabService { lab(o: Parameters<import('./sessions.ts').SessionServer['lab']>[0]): Promise<LabServed> }
export type Cutter = (run: string, question: number) => Promise<{ content: { system: string; user: { parts: readonly string[] } }; hash: string; capture?: RunCapture | null }>;

const sha = (v: unknown): string => createHash('sha256').update(typeof v === 'string' ? v : stableStringify(v)).digest('hex');
const RUNS_JUNIOR = new Set(['forward', 'activations', 'attention', 'try']);

/** Everything wrong with a query against the limits, before it is sent. */
export function queryProblems(q: LabQuery, l: LabLimits): string[] {
  const a = (q.args ?? {}) as Record<string, any>;
  const p: string[] = [];
  const int = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
  const casesOk = () => {
    const n = q.cases?.length ?? 0;
    if (n < 1 || n > l.max_cases) p.push('between 1 and ' + l.max_cases + ' diagnosis cases');
  };
  const positions = (v: unknown) => {
    if (v === undefined || v === 'last' || v === 'generated') return;
    if (!Array.isArray(v) || !v.length || v.length > l.max_positions || v.some((x) => !Number.isInteger(x) || x < 0)) p.push('"positions": last, generated, or at most ' + l.max_positions + ' indices');
  };
  const inner = (name: string, args: Record<string, any>) => {
    if (name === 'forward') {
      casesOk();
      if (args.max_new_tokens !== undefined && !int(args.max_new_tokens, 1, l.max_new_tokens)) p.push('"max_new_tokens": 1 to ' + l.max_new_tokens);
      if (args.top_logits !== undefined && !int(args.top_logits, 0, l.max_top_logits)) p.push('"top_logits": 0 to ' + l.max_top_logits);
    } else if (name === 'activations') {
      casesOk();
      if (!Array.isArray(args.modules) || !args.modules.length || args.modules.length > l.max_modules || args.modules.some((m: unknown) => typeof m !== 'string')) p.push('"modules": 1 to ' + l.max_modules + ' names');
      positions(args.positions);
      if (args.directions !== undefined && !int(args.directions, 1, l.max_directions)) p.push('"directions": 1 to ' + l.max_directions);
      if (args.max_new_tokens !== undefined && !int(args.max_new_tokens, 1, l.max_new_tokens)) p.push('"max_new_tokens": 1 to ' + l.max_new_tokens);
    } else p.push('no query ' + name + ' here');
  };
  switch (q.query) {
    case 'modules': break;
    case 'weights.stats':
      if (typeof a.module !== 'string') p.push('"module"');
      if (a.singular !== undefined && !int(a.singular, 0, l.max_singular)) p.push('"singular": 0 to ' + l.max_singular);
      break;
    case 'weights.slice': {
      const ok = (r: unknown) => Array.isArray(r) && r.length === 2 && Number.isInteger(r[0]) && Number.isInteger(r[1]) && r[0] >= 0 && r[1] > r[0];
      if (typeof a.module !== 'string' || !ok(a.rows) || !ok(a.cols)) p.push('"module", "rows" [from, to) and "cols" [from, to)');
      else if ((a.rows[1] - a.rows[0]) * (a.cols[1] - a.cols[0]) > l.max_slice_entries) p.push('a slice of at most ' + l.max_slice_entries + ' entries');
      break;
    }
    case 'forward': case 'activations': inner(q.query, a); break;
    case 'attention':
      casesOk();
      if ((q.cases?.length ?? 0) > 1) p.push('attention reads one case');
      if (!Number.isInteger(a.layer) || a.layer < 0) p.push('"layer"');
      if (!Array.isArray(a.heads) || !a.heads.length || a.heads.length > l.max_heads || a.heads.some((h: unknown) => !Number.isInteger(h) || (h as number) < 0)) p.push('"heads": 1 to ' + l.max_heads);
      positions(a.positions);
      break;
    case 'try':
      if (!q.candidate) p.push('"candidate": the version whose edits it tries');
      if (a.inner !== 'forward' && a.inner !== 'activations') p.push('"inner": forward or activations');
      else inner(a.inner, (a.args ?? {}) as Record<string, any>);
      break;
    default: p.push('no query ' + String((q as { query: unknown }).query) + ': modules, weights.stats, weights.slice, forward, activations, attention or try');
  }
  return p;
}

export class WeightLab {
  private readonly cuts = new Map<string, { content: { system: string; user: { parts: readonly string[] } }; hash: string; capture?: RunCapture | null }>();
  private readonly o: { readonly config: WeightLabConfig; readonly manifest: Pick<CompetenceManifest, 'cases'>; readonly service: LabService; readonly ledger: JobLedger; readonly store: BlobStore; readonly cutter: Cutter };
  constructor(o: WeightLab['o']) { this.o = o; }

  /** A cut or a text resolved to what the junior is given; a cut outside the diagnosis runs, or one that is a probe's
      very cut, is refused. */
  private async resolve(c: LabCase): Promise<{ content: unknown; meta: LabReceipt['cases'][number] } | string> {
    if ('text' in c) {
      if (!c.text || typeof c.text.user !== 'string' || !c.text.user) return 'a text case needs its "user" text';
      const content = { system: c.text.system ?? '', user: { parts: [c.text.user] } };
      return { content, meta: { hash: sha(content), source: 'text' } };
    }
    const run = path.resolve(String(c.cut?.run));
    const group = Object.entries(this.o.config.diagnosis).find(([, runs]) => runs.some((r) => path.resolve(r) === run))?.[0];
    if (!group) return 'the run ' + c.cut?.run + ' is not a diagnosis run: the lab runs only cuts of the diagnosis groups';
    const key = run + '#' + c.cut.question;
    let cut = this.cuts.get(key);
    if (!cut) { cut = await this.o.cutter(run, c.cut.question); this.cuts.set(key, cut); }
    if ((this.o.manifest.cases ?? []).some((k) => k.kind === 'probe' && k.cut.hash === cut!.hash)) return 'that cut is a probe that selects: never run by the lab';
    return { content: cut.content, meta: { hash: sha(cut.content), source: 'cut', run: c.cut.run, question: c.cut.question, group, ...(cut.capture ? { capture: cut.capture } : {}) } };
  }

  /** One query: refused before anything runs when it is not within the limits, its cases not of diagnosis, or its bags
      cannot hold it; otherwise a job of the ledger with its receipt. */
  async query(pkg: JuniorPackage, q: LabQuery, operation_id: string): Promise<LabReceipt | { refused: string }> {
    const l = this.o.config.limits;
    const problems = queryProblems(q, l);
    if (problems.length) return { refused: problems.join('; ') };
    const p = normalizePackage(pkg);
    const cases: { content: unknown; meta: LabReceipt['cases'][number] }[] = [];
    for (const c of q.cases ?? []) {
      const r = await this.resolve(c);
      if (typeof r === 'string') return { refused: r };
      cases.push(r);
    }
    let set: BlobId | null = null;
    if (q.query === 'try') {
      const cand = normalizePackage(q.candidate);
      if (cand.base !== p.base) return { refused: 'the candidate composes on another base than the junior diagnosed' };
      const t = cand.adapter ? this.o.store.tree(cand.adapter) : null;
      if (!t || !t.files['set.json']) return { refused: 'the candidate carries no set of edits to try' };
      set = cand.adapter;
    }
    const runs = RUNS_JUNIOR.has(q.query);
    const inputs = { query: q.query, args: q.args ?? {}, cases: cases.map((c) => c.meta.hash), set, execution: executionHash(p) };
    let started;
    try {
      started = this.o.ledger.start({ operation_id, op: 'lab:' + q.query, inputs, reserve: { lab_queries: 1, ...(runs ? { lab_tokens: l.max_tokens } : {}) },
        run: async () => {
          const served = await this.o.service.lab({ pkg: p, query: q.query, args: { ...(q.args ?? {}) }, cases: cases.map((c) => c.content), set, limits: l });
          const receipt = this.receipt(operation_id, q, inputs.execution, cases.map((c) => c.meta), set, served);
          const tokens = served.usage ? served.usage.tokens_in + served.usage.tokens_out : null;
          /* A query cut by its time cannot say what it consumed: its reservation stays, as uncertain. */
          const spent = served.state === 'timeout' || (runs && tokens === null) ? null : { lab_queries: 1, ...(runs ? { lab_tokens: tokens ?? 0 } : {}) };
          return { products: receipt, result: { state: receipt.state }, spent, ...(served.state === 'failed' ? { failed: served.reason ?? 'failed' } : {}) };
        } });
    } catch (e) {
      if (e instanceof JobRefused) return { refused: e.message };
      throw e;
    }
    const job = await started.done;
    return (job.products as LabReceipt | null) ?? this.lost(job, q, inputs.execution, cases.map((c) => c.meta), set);
  }

  private receipt(operation_id: string, q: LabQuery, execution: string, cases: LabReceipt['cases'], set: BlobId | null, served: LabServed): LabReceipt {
    const l = this.o.config.limits;
    const text = served.result === null ? '' : JSON.stringify(served.result);
    const bytes = Buffer.byteLength(text);
    const over: string[] = [];
    if (served.usage) {
      if (served.usage.tokens_in + served.usage.tokens_out > l.max_tokens) over.push((served.usage.tokens_in + served.usage.tokens_out) + ' tokens, more than ' + l.max_tokens);
      if (served.usage.peak_bytes > l.max_memory_bytes) over.push('a peak of ' + served.usage.peak_bytes + ' bytes, more than ' + l.max_memory_bytes);
    }
    if (bytes > l.max_response_bytes) over.push('an answer of ' + bytes + ' bytes, more than ' + l.max_response_bytes);
    const withheld = served.state === 'answered' && over.length > 0;
    return {
      operation_id, query: q.query, args: q.args ?? {}, execution, cases, set,
      state: withheld ? 'over_limit' : served.state, reason: withheld ? 'past its limits: ' + over.join('; ') + '; its answer is withheld' : served.reason,
      usage: served.usage, response_bytes: bytes, result: served.state === 'answered' && !withheld ? this.o.store.put(text) : null,
      files: withheld ? {} : served.files, queue_ms: served.queue_ms, run_ms: served.run_ms
    };
  }

  private lost(job: Job, q: LabQuery, execution: string, cases: LabReceipt['cases'], set: BlobId | null): LabReceipt {
    return { operation_id: job.operation_id, query: q.query, args: q.args ?? {}, execution, cases, set, state: 'failed', reason: job.reason ?? job.state,
      usage: null, response_bytes: 0, result: null, files: {}, queue_ms: 0, run_ms: 0 };
  }

  /** The answer of a receipt, read back (null when withheld or failed). */
  answer(r: LabReceipt): unknown { return r.result ? JSON.parse(this.o.store.get(r.result).toString('utf8')) : null; }

  /** The receipt of a query of this lab, by its operation id (from the ledger: never run again). */
  receiptOf(operation_id: string): LabReceipt | null {
    const j = this.o.ledger.get(operation_id);
    return j && j.op.startsWith('lab:') ? (j.products as LabReceipt | null) : null;
  }

  /** An edit by a closed constructor, its inputs taken from files the lab recorded: {name: {from: operation id, file}}
      or bytes given directly (a direction written by the strong model). Activations come only from answered receipts of
      this lab, so from diagnosis cases. */
  construct(start: JuniorPackage, o: { constructor: string; args: Record<string, unknown>; inputs: Record<string, { from: string; file: string } | Buffer>; hypothesis: Hypothesis; authorship: Authorship }): { id: string } | { problems: string[] } {
    const inputs: Record<string, Buffer> = {};
    for (const [name, src] of Object.entries(o.inputs)) {
      if (Buffer.isBuffer(src)) { inputs[name] = src; continue; }
      const r = this.receiptOf(src.from);
      if (!r || r.state !== 'answered') return { problems: ['no answered query ' + src.from + ' of this lab'] };
      if (r.execution !== executionHash(normalizePackage(start)) && r.set === null) return { problems: ['query ' + src.from + ' read another junior than the start'] };
      const blob = r.files[src.file];
      if (!blob) return { problems: ['query ' + src.from + ' wrote no ' + src.file] };
      inputs[name] = this.o.store.get(blob);
      try { readSafetensors(inputs[name]); } catch (e) { return { problems: [name + ': ' + (e as Error).message] }; }
    }
    return construct(this.o.store, start, { constructor: o.constructor, args: o.args, inputs, hypothesis: o.hypothesis, authorship: o.authorship });
  }
}
