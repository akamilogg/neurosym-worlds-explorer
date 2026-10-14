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
  readonly id: string;
  readonly version: string;
  readonly family: string;
  readonly runs: readonly Execution[];
  /** Whether the sandbox isolated the runs (it says so for every episode). */
  readonly isolated: boolean;
}

export class ArtifactWorld {
  readonly task: ArtifactTask;
  readonly store: ArtifactStore;
  private readonly sandbox: Sandbox;
  private episodes = 0;

  constructor(task: ArtifactTask, sandbox: Sandbox, store?: ArtifactStore) {
    this.task = task;
    this.sandbox = sandbox;
    this.store = store ?? ArtifactStore.fromDirectory(task.base);
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
  async run(version: string, family: string, n: number, seed: number, repetitions = 1): Promise<Episode | { error: string }> {
    const f = this.task.families.find((x) => x.id === family);
    if (!f) return { error: 'no family "' + family + '" (' + this.task.families.filter((x) => x.role !== 'blind').map((x) => x.id).join(', ') + ')' };
    if (f.role === 'blind') return { error: 'family "' + family + '" is not yours to run' };
    if (!this.store.get(version)) return { error: 'no version "' + version + '"' };
    const workloads = f.workloads(seed, n);
    const mine = await this.runVersion(version, workloads, repetitions);
    const refs = version === this.reference ? mine : await this.runVersion(this.reference, workloads, 1);
    const runs: Execution[] = [];
    workloads.forEach((w, i) => mine[i].forEach((o, rep) => {
      const ref = refs[i][0];
      const v = o.exitCode === 0 && !o.timedOut ? this.task.oracle(o, ref, w) : { ok: false, why: o.timedOut ? 'timed out' : 'exited with ' + o.exitCode };
      runs.push({ workload: w, repetition: rep, outcome: o, correct: v.ok, ...(v.ok ? {} : { why: v.why }) });
    }));
    return { id: 'run' + (++this.episodes), version, family, runs, isolated: this.sandbox.isolated };
  }

  /** The verdict (§8) on a candidate in some families, on n fresh workloads each: reference and candidate interleaved,
      repetition by repetition, so a drift of the machine falls on both. */
  async check(candidate: string, families: readonly string[], n: number, seed: number): Promise<{ readonly family: string; readonly verdict: Verdict }[]> {
    const reps = this.task.objective.repetitions;
    const out: { family: string; verdict: Verdict }[] = [];
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
        out.push({ family: id, verdict: judge(this.task, pairs as Paired[], f.requires ?? 'better') });
      }
      return out;
    } finally { for (const d of Object.values(dirs)) fs.rmSync(d, { recursive: true, force: true }); }
  }
}
