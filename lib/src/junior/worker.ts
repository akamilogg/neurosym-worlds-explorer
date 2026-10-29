import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { BlobStore, JuniorPackage } from './package.ts';
import { stableStringify } from '../core/hash.ts';
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
const NL = String.fromCharCode(10);

/** What a backend cannot serve, refused when a session opens - before any inference (§6.5: an option ignored or a backend
    incompatible is detected before the trial). */
export function unsupported(backend: Backend, pkg: JuniorPackage): string | null {
  if (backend !== 'qwenputer') return null;
  if (pkg.decoding.temperature !== 0) return 'the driver decodes greedily: temperature must be 0';
  if (pkg.decoding.forced_format !== null) return 'the driver has no forced format';
  return null;
}

function linkOrCopy(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try { fs.linkSync(from, to); } catch { fs.copyFileSync(from, to); }
}

export interface Materialized {
  readonly base: string;
  readonly adapter: string | null;
  readonly firmware: string;
  /** The package's tokenizer, put in place of the checkpoint's own: what the driver reads is the package's. */
  readonly tokenizer: string;
  readonly chat_template: string;
  /** The package's driver: a folder to import from (a tree), or its one file. */
  readonly driver: string;
}

/** A package's files where the worker can read them: trees as folders, single blobs by path, every part the package fixes
    - base, adapter, firmware, tokenizer, chat template and driver. Kept per execution hash. */
export function materialize(pkg: JuniorPackage, execution: string, store: BlobStore, cache: string): Materialized {
  const dir = path.join(cache, execution);
  const done = path.join(dir, '.complete');
  const tree = (id: string, where: string): string => {
    const target = path.join(dir, where);
    const t = store.tree(id);
    if (!t) throw new Error('blob ' + id + ' is not a tree');
    for (const [rel, blob] of Object.entries(t.files)) linkOrCopy(store.pathOf(blob), path.join(target, ...rel.split('/')));
    return target;
  };
  const driverIsTree = store.tree(pkg.execution.driver) !== null;
  /* The driver lives where its own hash says, shared by every package that has it: a process that imported it from there
     serves any of them; another driver is another folder (and another process). */
  const driverDir = path.join(path.dirname(cache), 'drivers', pkg.execution.driver);
  if (driverIsTree && !fs.existsSync(path.join(driverDir, '.complete'))) {
    fs.rmSync(driverDir, { recursive: true, force: true });
    const t = store.tree(pkg.execution.driver)!;
    for (const [rel, blob] of Object.entries(t.files)) linkOrCopy(store.pathOf(blob), path.join(driverDir, ...rel.split('/')));
    fs.writeFileSync(path.join(driverDir, '.complete'), pkg.execution.driver);
  }
  if (!fs.existsSync(done)) {
    fs.rmSync(dir, { recursive: true, force: true });
    tree(pkg.base, 'base');
    if (pkg.adapter) tree(pkg.adapter, 'adapter');
    linkOrCopy(store.pathOf(pkg.execution.firmware), path.join(dir, 'firmware.elf'));
    /* The checkpoint's tokenizer is replaced by the package's - unlinked first: its file may be a link to a blob. */
    fs.rmSync(path.join(dir, 'base', 'tokenizer.json'), { force: true });
    fs.copyFileSync(store.pathOf(pkg.execution.tokenizer), path.join(dir, 'base', 'tokenizer.json'));
    fs.copyFileSync(store.pathOf(pkg.execution.chat_template), path.join(dir, 'chat_template.jinja'));
    if (!driverIsTree) linkOrCopy(store.pathOf(pkg.execution.driver), path.join(dir, 'driver.bin'));
    fs.writeFileSync(done, execution);
  }
  return { base: path.join(dir, 'base'), adapter: pkg.adapter ? path.join(dir, 'adapter') : null, firmware: path.join(dir, 'firmware.elf'),
    tokenizer: path.join(dir, 'base', 'tokenizer.json'), chat_template: path.join(dir, 'chat_template.jinja'), driver: driverIsTree ? driverDir : path.join(dir, 'driver.bin') };
}

/** What a worker says it loaded: the digests of the files it read and the configuration it runs with. */
export interface Loaded {
  readonly tokenizer: string;
  readonly chat_template: string;
  readonly firmware: string;
  /** A driver folder: each file's digest by its path; a driver file: its digest. */
  readonly driver: Readonly<Record<string, string>> | string;
  /** The circuit's configuration as the driver read it (chipformer.json), or null where there is none. */
  readonly circuit: Readonly<Record<string, unknown>> | null;
  /** The precision its weights were loaded in, or null where the backend has none. */
  readonly precision: string | null;
}

/** Where what a worker loaded is not what the package fixes, or null: the identity served is checked, never echoed. */
export function identityMismatch(pkg: JuniorPackage, store: BlobStore, loaded: Loaded | undefined): string | null {
  if (!loaded) return 'the worker did not say what it loaded';
  const e = pkg.execution;
  const wrong: string[] = [];
  if (loaded.tokenizer !== e.tokenizer) wrong.push('tokenizer');
  if (loaded.chat_template !== e.chat_template) wrong.push('chat template');
  if (loaded.firmware !== e.firmware) wrong.push('firmware');
  const t = store.tree(e.driver);
  if (t ? stableStringify(loaded.driver) !== stableStringify(t.files) : loaded.driver !== e.driver) wrong.push('driver');
  const declared = e.circuit as Record<string, unknown>;
  if (Object.keys(declared).length && (loaded.circuit === null || Object.entries(declared).some(([k, v]) => stableStringify(loaded.circuit![k]) !== stableStringify(v)))) wrong.push('circuit configuration');
  if (loaded.precision !== null && loaded.precision !== e.precision) wrong.push('precision (' + loaded.precision + ')');
  return wrong.length ? 'it loaded another ' + wrong.join(', ') + ' than the package fixes' : null;
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

  /** The driver its process imported: a package with another one needs a fresh process (a module is imported once). */
  private driver: string | null = null;
  private use(pkg: JuniorPackage): void {
    if (this.driver !== null && this.driver !== pkg.execution.driver) this.invalidate();
    this.driver = pkg.execution.driver;
  }

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

  /** The circuit's validity suite (§10.1), served on the inference GPU with the package's adapter applied. */
  async validity(job: { readonly pkg: JuniorPackage; readonly execution: string; readonly store: BlobStore }): Promise<import('./sessions.ts').Validity | { readonly error: string }> {
    const files = materialize(job.pkg, job.execution, job.store, path.join(this.o.work, 'packages'));
    this.use(job.pkg);
    const id = 'v' + (++this.next) + '-' + process.pid;
    const child = this.start();
    const a = await new Promise<Record<string, unknown>>((resolve) => {
      this.waiting.set(id, resolve as never);
      child.stdin.write(JSON.stringify({ id, op: 'validity', execution: job.execution, backend: this.o.backend, files, circuit: job.pkg.execution.circuit, decoding: job.pkg.decoding }) + NL);
    });
    return a.validity && typeof a.validity === 'object' ? a.validity as import('./sessions.ts').Validity : { error: String(a.reason ?? 'no answer') };
  }

  /** One memory operation on a copy of a twin, by the package's reference store (§8). */
  async memoryCall(job: { readonly pkg: JuniorPackage; readonly execution: string; readonly twin: Buffer | null; readonly store: BlobStore; readonly call: { op: string; name?: string; text?: string } }): Promise<{ readonly result: string; readonly twin: Buffer } | { readonly error: string }> {
    const files = this.o.backend === 'fake' ? null : materialize(job.pkg, job.execution, job.store, path.join(this.o.work, 'packages'));
    const id = 'c' + (++this.next) + '-' + process.pid;
    const child = this.start();
    const a = await new Promise<Record<string, unknown>>((resolve) => {
      this.waiting.set(id, resolve as never);
      child.stdin.write(JSON.stringify({ id, op: 'memory_call', execution: job.execution, backend: this.o.backend, files, circuit: job.pkg.execution.circuit,
        twin: job.twin === null ? null : job.twin.toString('base64'), call: job.call }) + NL);
    });
    return typeof a.result === 'string' && typeof a.twin === 'string' ? { result: a.result, twin: Buffer.from(a.twin, 'base64') } : { error: String(a.reason ?? 'no answer') };
  }

  /** A memory read as files by the package's own driver (§4). */
  async render(job: { readonly pkg: JuniorPackage; readonly execution: string; readonly twin: Buffer | null; readonly store: BlobStore }): Promise<Record<string, string> | { readonly error: string }> {
    const files = this.o.backend === 'fake' ? null : materialize(job.pkg, job.execution, job.store, path.join(this.o.work, 'packages'));
    const id = 'r' + (++this.next) + '-' + process.pid;
    const child = this.start();
    const a = await new Promise<Record<string, unknown>>((resolve) => {
      this.waiting.set(id, resolve as never);
      child.stdin.write(JSON.stringify({ id, op: 'render', execution: job.execution, backend: this.o.backend, files, circuit: job.pkg.execution.circuit, twin: job.twin === null ? null : job.twin.toString('base64') }) + '\n');
    });
    return a.files && typeof a.files === 'object' ? a.files as Record<string, string> : { error: String(a.reason ?? 'no answer') };
  }

  async run(job: WorkerJob): Promise<WorkerResult> {
    const files = materialize(job.pkg, job.execution, job.store, path.join(this.o.work, 'packages'));
    this.use(job.pkg);
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
      /* What it served is what it loaded, checked against the package - never the hash it was asked for, said back. */
      const wrong = answer.terminal === 'infra_failed' ? null : identityMismatch(job.pkg, job.store, (answer as unknown as { loaded?: Loaded }).loaded);
      const served = answer.terminal === 'infra_failed' ? answer.served : wrong ? 'unverified' : job.execution;
      return { served, terminal: answer.terminal, text: answer.text, trace: answer.trace, ops: answer.ops ?? [], after, usage: answer.usage ?? null,
        ...(wrong ? { reason: wrong } : answer.reason ? { reason: answer.reason } : {}) };
    } finally { fs.rmSync(out, { recursive: true, force: true }); }
  }
}
