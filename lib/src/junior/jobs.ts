import fs from 'node:fs';
import { appendRecord } from './jsonl.ts';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { stableStringify } from '../core/hash.ts';

/* ============================================================================
 * The ledger of JOBS of the junior's world (SPEC-METAPOLITICA-APRENDIZAJE §7.1, §13): run, distill, train... each long
 * operation a job with its operation_id, given by the harness before it is launched.
 *
 * Asked again with the same id and inputs it is the same job, never a second; the same id with other inputs is refused.
 * A job reserves from its bags what it may spend at most before it starts; a job its bags cannot hold is refused and never
 * launched. It settles what it spent; what it cannot say stays reserved as uncertain. `completed` says the operation ended,
 * not that the junior did well: its verdict is in its result.
 *
 * Cancelling asks the job to stop: it stays running until its worker returns (what it did is kept); a job cut by a stop of
 * the ledger's process is `uncertain` when the ledger is read again - its reservation held, never replaced by another job
 * while it might still run. Consulting a job never charges it again.
 * ========================================================================== */

export type JobState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'uncertain';
export type Bags = Readonly<Record<string, number>>;

export interface Job {
  readonly operation_id: string;
  readonly op: string;
  readonly inputs_hash: string;
  readonly inputs: unknown;
  readonly reserve: Bags;
  state: JobState;
  spent: Bags | null;
  uncertain: Bags | null;
  products: unknown;
  result: unknown;
  reason: string | null;
  cancel_requested: boolean;
}

export interface JobOutcome { readonly products?: unknown; readonly result?: unknown; readonly spent: Bags | null; readonly failed?: string }

export class JobRefused extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

const hashOf = (v: unknown): string => createHash('sha256').update(stableStringify(v)).digest('hex');

export class JobLedger {
  readonly file: string;
  private readonly limits: Bags;
  private readonly jobs = new Map<string, Job>();
  private readonly running = new Map<string, { abort: AbortController; done: Promise<Job> }>();

  constructor(file: string, limits: Bags) {
    this.file = file;
    this.limits = limits;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.read();
  }

  private write(line: Record<string, unknown>): void {
    appendRecord(this.file, { at: new Date().toISOString(), ...line }, { sync: true });
  }

  /** The jobs from the ledger. One left running or queued by a process that is gone is uncertain: it may have run. */
  private read(): void {
    if (!fs.existsSync(this.file)) return;
    for (const row of fs.readFileSync(this.file, 'utf8').split('\n')) {
      if (!row.trim()) continue;
      let l: Record<string, any>;
      try { l = JSON.parse(row); } catch { continue; }
      if (l.kind === 'requested') this.jobs.set(l.operation_id, { operation_id: l.operation_id, op: l.op, inputs_hash: l.inputs_hash, inputs: l.inputs, reserve: l.reserve, state: 'queued', spent: null, uncertain: null, products: null, result: null, reason: null, cancel_requested: false });
      const j = this.jobs.get(l.operation_id);
      if (!j) continue;
      if (l.kind === 'started') j.state = 'running';
      if (l.kind === 'cancel_requested') j.cancel_requested = true;
      if (l.kind === 'finished') Object.assign(j, { state: l.state, spent: l.spent, uncertain: l.uncertain, products: l.products, result: l.result, reason: l.reason });
    }
    for (const j of this.jobs.values()) if (j.state === 'queued' || j.state === 'running') {
      j.state = 'uncertain';
      j.uncertain = j.reserve;
      j.reason = 'the ledger\'s process stopped while it ' + (j.cancel_requested ? 'was being cancelled' : 'ran') + '; it may have run';
      this.write({ kind: 'finished', operation_id: j.operation_id, state: 'uncertain', spent: null, uncertain: j.reserve, products: null, result: null, reason: j.reason });
    }
  }

  /** Per bag: its limit, what settled jobs spent, what running ones hold and what uncertain ones keep. */
  bags(): Record<string, { limit: number; spent: number; held: number; uncertain: number; free: number }> {
    const out: Record<string, { limit: number; spent: number; held: number; uncertain: number; free: number }> = {};
    for (const [b, limit] of Object.entries(this.limits)) {
      let spent = 0, held = 0, uncertain = 0;
      for (const j of this.jobs.values()) {
        if (j.state === 'queued' || j.state === 'running') held += j.reserve[b] ?? 0;
        else { spent += j.spent?.[b] ?? 0; uncertain += j.uncertain?.[b] ?? 0; }
      }
      out[b] = { limit, spent, held, uncertain, free: limit - spent - held - uncertain };
    }
    return out;
  }

  get(id: string): Job | null { const j = this.jobs.get(id); return j ? { ...j } : null; }
  list(): Job[] { return [...this.jobs.values()].map((j) => ({ ...j })); }

  /** Launches a job, or answers the one this id already is. `run` is the operation: it is told when to stop, and answers
      its products, its result and what it spent (null where it cannot say). */
  start(o: { operation_id: string; op: string; inputs: unknown; reserve: Bags; run: (signal: AbortSignal) => Promise<JobOutcome> }): { job: Job; done: Promise<Job>; again: boolean } {
    const inputs_hash = hashOf({ op: o.op, inputs: o.inputs });
    const known = this.jobs.get(o.operation_id);
    if (known) {
      if (known.inputs_hash !== inputs_hash) throw new JobRefused('operation_conflict', 'operation ' + o.operation_id + ' was asked with other inputs');
      const r = this.running.get(o.operation_id);
      return { job: { ...known }, done: r ? r.done : Promise.resolve({ ...known }), again: true };
    }
    for (const b of Object.keys(o.reserve)) if (!(b in this.limits)) throw new JobRefused('unknown_bag', 'no bag ' + b);
    const bags = this.bags();
    const short = Object.entries(o.reserve).filter(([b, n]) => n > bags[b].free);
    if (short.length) throw new JobRefused('budget', 'the bags cannot hold it: ' + short.map(([b, n]) => b + ' needs ' + n + ', ' + bags[b].free + ' free').join('; '));
    const job: Job = { operation_id: o.operation_id, op: o.op, inputs_hash, inputs: o.inputs, reserve: o.reserve, state: 'queued', spent: null, uncertain: null, products: null, result: null, reason: null, cancel_requested: false };
    this.jobs.set(job.operation_id, job);
    this.write({ kind: 'requested', operation_id: job.operation_id, op: job.op, inputs_hash, inputs: o.inputs, reserve: o.reserve });
    const abort = new AbortController();
    const done = (async (): Promise<Job> => {
      job.state = 'running';
      this.write({ kind: 'started', operation_id: job.operation_id });
      let out: JobOutcome;
      try { out = await o.run(abort.signal); } catch (e) { out = { spent: null, failed: String((e as Error)?.message ?? e) }; }
      const known = out.spent !== null;
      const spent: Bags = known ? out.spent! : {};
      job.state = abort.signal.aborted ? 'cancelled' : out.failed ? 'failed' : 'completed';
      job.spent = spent;
      job.uncertain = known ? null : job.reserve;
      job.products = out.products ?? null;
      job.result = out.result ?? null;
      job.reason = out.failed ?? (abort.signal.aborted ? 'cancelled' : null);
      this.write({ kind: 'finished', operation_id: job.operation_id, state: job.state, spent: job.spent, uncertain: job.uncertain, products: job.products, result: job.result, reason: job.reason });
      this.running.delete(job.operation_id);
      return { ...job };
    })();
    this.running.set(job.operation_id, { abort, done });
    return { job: { ...job }, done, again: false };
  }

  /** Asks a job to stop. It stays running, its reservation held, until its worker returns. */
  cancel(id: string): Job | null {
    const r = this.running.get(id), j = this.jobs.get(id);
    if (!j) return null;
    if (r && !j.cancel_requested) { j.cancel_requested = true; this.write({ kind: 'cancel_requested', operation_id: id }); r.abort.abort(); }
    return { ...j };
  }

  /** Every job still running asked to stop and waited for (the run that launched them closes). */
  async close(): Promise<Job[]> {
    const pending = [...this.running.keys()];
    for (const id of pending) this.cancel(id);
    return Promise.all(pending.map((id) => this.running.get(id)?.done ?? Promise.resolve(this.get(id)!)));
  }
}
