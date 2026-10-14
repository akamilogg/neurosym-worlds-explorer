import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArtifactStore, type Patch } from './store.ts';
import type { Sandbox } from './sandbox.ts';
import { judge, type ArtifactTask, type Paired, type RunOutcome, type Verdict, type Workload } from './task.ts';

/* ============================================================================
 * The WORLD of an artifact task (SPEC-MUNDO-ARTEFACTOS §5-§8): its versions, the acts that change and
 * run them, and the verdict on a candidate.
 *
 *   change   a patch on a version: a new version (or why not)
 *   run      a version on workloads of a family: an EPISODE - per run, what was known before it
 *            (the workload's parameters, the version) and what came after (its metrics, and whether
 *            it was correct against the reference on the same workload)
 *   view     lines of a file of a version; diff, what differs between two
 *   check    the verdict (§8): the candidate and the reference interleaved, repetition by
 *            repetition, on fresh workloads of the places asked
 *
 * The reference is the base: what every candidate is compared with. Nothing here knows the task.
 * ========================================================================== */

export interface Execution { readonly workload: Workload; readonly repetition: number; readonly outcome: RunOutcome; readonly correct: boolean; readonly why?: string }

export interface Episode {
  readonly version: string;
  readonly family: string;
  readonly runs: readonly Execution[];
  /** Whether the sandbox isolated the runs (it says so for every episode). */
  readonly isolated: boolean;
  /** Where it was measured (§11, re-execution): a run measured elsewhere is compared knowing it. */
  readonly environment: Environment;
}

/** The machine and runtime a measure was taken on: what it is, and its fingerprint (a hash of it). */
export interface Environment {
  readonly fingerprint: string;
  readonly facts: Readonly<Record<string, string | number>>;
}

/** A computation whose result varies (measured runs), logged once and given again on a resume (`LabContext.recorded`). */
export type Recorder = <T>(route: string, body: unknown, compute: () => Promise<T>) => Promise<T>;
const direct: Recorder = (_route, _body, compute) => compute();

export class ArtifactWorld {
  readonly task: ArtifactTask;
  readonly store: ArtifactStore;
  private readonly sandbox: Sandbox;
  private environmentOnce: Promise<Environment> | null = null;

  constructor(task: ArtifactTask, sandbox: Sandbox, store?: ArtifactStore) {
    this.task = task;
    this.sandbox = sandbox;
    this.store = store ?? ArtifactStore.fromDirectory(task.base);
  }

  /** In a journal, the world is its task (its versions are in the acts that made them). */
  toJSON(): unknown { return { task: this.task.id, base: this.store.base }; }

  /** Where its runs are measured: the machine, the sandbox and what the task's environment commands say. Taken once. */
  environment(): Promise<Environment> {
    this.environmentOnce ??= (async () => {
      const cpus = os.cpus();
      const facts: Record<string, string | number> = { platform: os.platform(), release: os.release(), arch: os.arch(), cpu: cpus[0]?.model?.trim() ?? '', cpus: cpus.length,
        memory_gb: Math.round(os.totalmem() / 2 ** 30), node: process.version, sandbox: this.sandbox.backend + (this.sandbox.isolated ? '' : ' (not isolated)') };
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-env-'));
      try {
        for (const command of this.task.run.environment ?? []) {
          const r = await this.sandbox.run(dir, { command, inputs: {}, outputs: [] }, { timeoutMs: 10000 });
          facts[command.join(' ')] = (r.stdout + r.stderr).trim().slice(0, 200) || 'exited with ' + r.exitCode;
        }
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
      return { fingerprint: createHash('sha256').update(JSON.stringify(facts)).digest('hex').slice(0, 16), facts };
    })();
    return this.environmentOnce;
  }

  /** The reference every candidate is compared with: the base. */
  get reference(): string { return this.store.base; }

  /** `change`: a new version from a patch on another. */
  change(from: string, patch: Patch): { version: string; parent: string } | { error: string } {
    const v = this.store.apply(from, patch);
    return typeof v === 'string' ? { error: v } : { version: v.hash, parent: v.parent ?? from };
  }

  /** One version, on workloads, `repetitions` times each: what each run produced. */
  async runVersion(version: string, workloads: readonly Workload[], repetitions = 1): Promise<RunOutcome[][]> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-version-'));
    try {
      this.store.materialize(version, dir);
      const out: RunOutcome[][] = workloads.map(() => []);
      for (let r = 0; r < repetitions; r++) for (const [i, w] of workloads.entries()) out[i].push(await this.once(dir, w, r));
      return out;
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  private async once(dir: string, w: Workload, repetition: number): Promise<RunOutcome> {
    const t = this.task;
    const r = await this.sandbox.run(dir, { command: t.run.command(w, repetition), inputs: t.run.inputs(w), outputs: t.run.outputs }, { timeoutMs: t.run.timeoutMs });
    const read = r.exitCode === 0 && !r.timedOut ? t.read(r.outputs, { wallMs: r.wallMs, stdout: r.stdout }) : { metrics: null, output: null };
    return { workload: w.id, exitCode: r.exitCode, timedOut: r.timedOut, metrics: read.metrics, output: read.output, stderr: r.stderr };
  }

  /** `run`: a version on n workloads of a family, each run judged correct or not against the reference's run there. An
      episode of the researcher's. Only the places it may act in: a blind family is never run for it. */
  async run(version: string, family: string, n: number, seed: number, repetitions = 1, record: Recorder = direct): Promise<Episode | { error: string }> {
    const f = this.task.families.find((x) => x.id === family);
    if (!f) return { error: 'no family "' + family + '" (' + this.task.families.filter((x) => x.role !== 'blind').map((x) => x.id).join(', ') + ')' };
    if (f.role === 'blind') return { error: 'family "' + family + '" is not yours to run' };
    if (!this.store.get(version)) return { error: 'no version "' + version + '"' };
    return record('/run', { task: this.task.id, version, family, n, seed, repetitions }, () => this.measureRun(version, f.workloads(seed, n), family, repetitions));
  }

  private async measureRun(version: string, workloads: readonly Workload[], family: string, repetitions: number): Promise<Episode> {
    const mine = await this.runVersion(version, workloads, repetitions);
    const refs = version === this.reference ? mine : await this.runVersion(this.reference, workloads, 1);
    const runs: Execution[] = [];
    workloads.forEach((w, i) => mine[i].forEach((o, rep) => {
      const ref = refs[i][0];
      const v = o.exitCode === 0 && !o.timedOut ? this.task.oracle(o, ref, w) : { ok: false, why: o.timedOut ? 'timed out' : 'exited with ' + o.exitCode };
      runs.push({ workload: w, repetition: rep, outcome: o, correct: v.ok, ...(v.ok ? {} : { why: v.why }) });
    }));
    return { version, family, runs, isolated: this.sandbox.isolated, environment: await this.environment() };
  }

  /** The verdict (§8) on a candidate in some families, on n fresh workloads each: reference and candidate interleaved,
      repetition by repetition, so a drift of the machine falls on both. */
  async check(candidate: string, families: readonly string[], n: number, seed: number, record: Recorder = direct): Promise<{ readonly family: string; readonly verdict: Verdict; readonly environment: Environment }[]> {
    return record('/check', { task: this.task.id, candidate, reference: this.reference, families, n, seed }, () => this.measureCheck(candidate, families, n, seed));
  }

  private async measureCheck(candidate: string, families: readonly string[], n: number, seed: number): Promise<{ readonly family: string; readonly verdict: Verdict; readonly environment: Environment }[]> {
    const reps = this.task.objective.repetitions;
    const environment = await this.environment();
    const out: { family: string; verdict: Verdict; environment: Environment }[] = [];
    const dirs = { ref: fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-ref-')), cand: fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-cand-')) };
    try {
      this.store.materialize(this.reference, dirs.ref);
      this.store.materialize(candidate, dirs.cand);
      for (const id of families) {
        const f = this.task.families.find((x) => x.id === id);
        if (!f) throw new Error('no family "' + id + '"');
        const workloads = f.workloads(seed, n);
        const pairs: { workload: Workload; reference: RunOutcome[]; candidate: RunOutcome[] }[] = workloads.map((w) => ({ workload: w, reference: [], candidate: [] }));
        for (let r = 0; r < reps; r++) {
          for (const p of pairs) {
            /* Interleaved, and alternating who goes first. */
            const first = r % 2 === 0 ? 'ref' : 'cand';
            for (const who of first === 'ref' ? ['ref', 'cand'] : ['cand', 'ref']) {
              const o = await this.once(who === 'ref' ? dirs.ref : dirs.cand, p.workload, r);
              (who === 'ref' ? p.reference : p.candidate).push(o);
            }
          }
        }
        out.push({ family: id, verdict: judge(this.task, pairs as Paired[], f.requires ?? 'better'), environment });
      }
      return out;
    } finally { for (const d of Object.values(dirs)) fs.rmSync(d, { recursive: true, force: true }); }
  }
}
