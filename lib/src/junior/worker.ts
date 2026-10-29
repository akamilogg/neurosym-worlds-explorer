import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { BlobStore, JuniorPackage } from './package.ts';
import type { JuniorWorker, WorkerJob, WorkerResult } from './sessions.ts';

/* ============================================================================
 * The worker as a process (SPEC-METAPOLITICA-APRENDIZAJE §5): junior_worker.py, long-lived, its model resident. The
 * package is materialized once per execution hash (its trees as folders, hard links where the disk allows), each job
 * written as one line, its answer read as one line. Invalidating it kills the process: a killed worker can never answer,
 * and the next job starts a new one.
 * ========================================================================== */

export const WORKER_PY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'junior_worker.py');
export const VERIFY_PY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'junior_verify.py');

export type Backend = 'fake' | 'qwenputer';

/** What a backend cannot serve, refused when a session opens - before any inference (§6.5: an option ignored or a backend
    incompatible is detected before the trial). */
export function unsupported(backend: Backend, pkg: JuniorPackage): string | null {
  if (backend !== 'qwenputer') return null;
  if (pkg.decoding.temperature !== 0) return 'the driver decodes greedily: temperature must be 0';
  if (pkg.decoding.forced_format !== null) return 'the driver has no forced format';
  if (pkg.adapter !== null) return 'adapters are served from MA5 on';
  return null;
}

function linkOrCopy(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try { fs.linkSync(from, to); } catch { fs.copyFileSync(from, to); }
}

/** A package's files where the worker can read them: trees as folders, single blobs by path. Kept per execution hash. */
export function materialize(pkg: JuniorPackage, execution: string, store: BlobStore, cache: string): { base: string; adapter: string | null; firmware: string } {
  const dir = path.join(cache, execution);
  const done = path.join(dir, '.complete');
  const tree = (id: string, where: string): string => {
    const target = path.join(dir, where);
    const t = store.tree(id);
    if (!t) throw new Error('blob ' + id + ' is not a tree');
    for (const [rel, blob] of Object.entries(t.files)) linkOrCopy(store.pathOf(blob), path.join(target, ...rel.split('/')));
    return target;
  };
  if (!fs.existsSync(done)) {
    fs.rmSync(dir, { recursive: true, force: true });
    tree(pkg.base, 'base');
    if (pkg.adapter) tree(pkg.adapter, 'adapter');
    linkOrCopy(store.pathOf(pkg.execution.firmware), path.join(dir, 'firmware.elf'));
    fs.writeFileSync(done, execution);
  }
  return { base: path.join(dir, 'base'), adapter: pkg.adapter ? path.join(dir, 'adapter') : null, firmware: path.join(dir, 'firmware.elf') };
}

export interface ProcessWorkerOptions {
  /** The interpreter and its arguments before the script, e.g. ['python'] or ['/opt/venv/bin/python', '-u']. */
  readonly python: readonly string[];
  readonly backend: Backend;
  /** Where packages are materialized and each job writes its memory after. */
  readonly work: string;
  readonly script?: string;
}

export class ProcessWorker implements JuniorWorker {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private readonly waiting = new Map<string, (r: WorkerResult & { id: string }) => void>();
  private next = 0;
  private readonly o: ProcessWorkerOptions;
  constructor(o: ProcessWorkerOptions) { this.o = o; }

  check(pkg: JuniorPackage): string | null { return unsupported(this.o.backend, pkg); }

  private start(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const child = spawn(this.o.python[0], [...this.o.python.slice(1), this.o.script ?? WORKER_PY], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      this.buffer += c;
      for (let i: number; (i = this.buffer.indexOf('\n')) >= 0;) {
        const line = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 1);
        if (!line.trim()) continue;
        try { const a = JSON.parse(line); this.waiting.get(a.id)?.(a); this.waiting.delete(a.id); } catch { /* not an answer */ }
      }
    });
    child.stderr.on('data', () => { /* the driver's prints; never an answer */ });
    const gone = (why: string): void => {
      if (this.child !== child) return;
      this.child = null;
      this.buffer = '';
      for (const [id, done] of this.waiting) done({ id, served: '', terminal: 'infra_failed', text: '', trace: '', ops: [], after: null, usage: null, reason: why });
      this.waiting.clear();
    };
    child.on('exit', (code) => gone('the worker exited (' + code + ')'));
    child.on('error', (e) => gone('the worker did not start: ' + e.message));
    this.child = child;
    return child;
  }

  invalidate(): void {
    const c = this.child;
    this.child = null;
    this.buffer = '';
    this.waiting.clear();
    c?.kill('SIGKILL');
  }

  /** The driver's resources measured for a package (§2, MA1): peak GPU memory per context length. */
  async probe(pkg: JuniorPackage, execution: string, store: BlobStore, lengths: readonly number[]): Promise<unknown> {
    const files = materialize(pkg, execution, store, path.join(this.o.work, 'packages'));
    const id = 'p' + (++this.next) + '-' + process.pid;
    const child = this.start();
    const a = await new Promise<Record<string, unknown>>((resolve) => {
      this.waiting.set(id, resolve as never);
      child.stdin.write(JSON.stringify({ id, op: 'probe', execution, backend: this.o.backend, files, circuit: pkg.execution.circuit, decoding: pkg.decoding,
        limits: { max_tokens: pkg.decoding.max_tokens, max_circuit_tokens: pkg.decoding.max_circuit_tokens }, lengths }) + '\n');
    });
    if (!a.probe) throw new Error('the probe failed: ' + String(a.reason ?? 'no answer'));
    return a.probe;
  }

  async run(job: WorkerJob): Promise<WorkerResult> {
    const files = materialize(job.pkg, job.execution, job.store, path.join(this.o.work, 'packages'));
    const id = 'j' + (++this.next) + '-' + process.pid;
    const out = path.join(this.o.work, 'jobs', id);
    fs.mkdirSync(out, { recursive: true });
    const child = this.start();
    const answer = await new Promise<WorkerResult & { id: string }>((resolve) => {
      this.waiting.set(id, resolve);
      child.stdin.write(JSON.stringify({
        id, execution: job.execution, backend: this.o.backend, files, circuit: job.pkg.execution.circuit, prompt: job.pkg.prompt, decoding: job.pkg.decoding,
        memory: { neural: job.state.neural ? job.store.pathOf(job.state.neural) : null, twin: job.state.twin ? job.store.pathOf(job.state.twin) : null },
        content: job.content, limits: job.limits, seed: job.seed, out
      }) + '\n');
    });
    try {
      const a = answer as unknown as { after: { neural: string | null; twin: string | null } | null };
      const after = a.after ? { neural: a.after.neural ? fs.readFileSync(a.after.neural) : null, twin: a.after.twin ? fs.readFileSync(a.after.twin) : null } : null;
      return { served: answer.served, terminal: answer.terminal, text: answer.text, trace: answer.trace, ops: answer.ops ?? [], after, usage: answer.usage ?? null, ...(answer.reason ? { reason: answer.reason } : {}) };
    } finally { fs.rmSync(out, { recursive: true, force: true }); }
  }
}
