import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { stableStringify } from '../core/hash.ts';
import { BlobStore, checkClosed, executionHash, normalizePackage, sha256, type BlobId, type JuniorPackage } from './package.ts';

/* ============================================================================
 * The junior's SESSIONS (SPEC-METAPOLITICA-APRENDIZAJE §5.1): one question, one published transition.
 *
 * A session holds a chain of memory states. Each question names its request (request_id), the hash of its content and
 * the state it expects to start from; the server runs it on a private copy and publishes, in one appended line of the
 * session's ledger, the receipt and the new state. A question asked again is answered by its receipt, without inference
 * nor writes. Another content under the same id, or a stale state, is refused; the session is never guessed from a prompt.
 *
 * The WORKER that runs the model keeps no state: every job carries the package and the memory to start from, and returns
 * the answer, its trace and the memory after. So restoring a session is the server's alone: its last published state.
 * A worker invalidated (cancelled, timed out, its server restarted) can never publish: the server publishes, and only
 * for the epoch it is waiting for.
 *
 * All the junior's inference goes through ONE queue (§11: the inference GPU); its waiting is recorded apart from its run.
 * ========================================================================== */

export interface MemoryState { readonly neural: BlobId | null; readonly twin: BlobId | null }
export const stateId = (s: MemoryState): string => sha256(stableStringify({ neural: s.neural, twin: s.twin }));

export type Terminal = 'answered' | 'limit_reached' | 'cancelled' | 'infra_failed';

export interface Limits { readonly max_tokens: number; readonly max_circuit_tokens: number; readonly timeout_ms: number }

export interface WorkerJob {
  readonly pkg: JuniorPackage;
  readonly execution: string;
  /** The blobs of the state to start from, with the store that holds them. */
  readonly state: MemoryState;
  readonly store: BlobStore;
  readonly content: unknown;
  readonly limits: Limits;
  readonly seed: number | null;
  readonly signal: AbortSignal;
}

export interface WorkerUsage { readonly prompt_tokens: number; readonly text_tokens: number; readonly circuit_tokens: number; readonly gpu_ms: number }

export interface WorkerResult {
  /** The execution hash the worker actually served. */
  readonly served: string;
  /** answered: a complete answer (valid or not as an act of the harness: that is measured elsewhere). limit_reached: a declared
      limit cut it; the prefix stays. infra_failed: the worker could not answer. */
  readonly terminal: 'answered' | 'limit_reached' | 'infra_failed';
  readonly text: string;
  /** What the replay of the circuit needs (the generated token ids, at least). */
  readonly trace: string;
  /** The memory operations read from the trace, in order. */
  readonly ops: readonly unknown[];
  /** The memory after a complete answer; null when there is none. */
  readonly after: { readonly neural: Uint8Array | null; readonly twin: Uint8Array | null } | null;
  readonly usage: WorkerUsage | null;
  readonly reason?: string;
}

export interface JuniorWorker {
  run(job: WorkerJob): Promise<WorkerResult>;
  /** What this worker cannot serve of a package, refused when a session opens; null if it can. */
  check?(pkg: JuniorPackage): string | null;
  /** Make sure a worker that may still be running can never answer again (kill its process). */
  invalidate?(): void;
  /** A memory read as files (§4: its readable content, derived from its snapshot): name to text. Through the reference twin,
      in the package's own terms - never a second reading of the store written here. */
  render?(job: { readonly pkg: JuniorPackage; readonly execution: string; readonly twin: Buffer | null; readonly store: BlobStore }): Promise<Record<string, string> | { readonly error: string }>;
}

export interface Receipt {
  readonly request_id: string;
  readonly content_hash: string;
  readonly content: BlobId;
  readonly state_before: string;
  readonly state_after: string;
  readonly after: MemoryState;
  readonly terminal: Terminal;
  readonly reason: string | null;
  readonly text: string;
  readonly trace: BlobId | null;
  readonly ops: readonly unknown[];
  /** Known consumption; null when it is not known (it stays reserved as uncertain, §5.1). */
  readonly usage: WorkerUsage | null;
  readonly uncertain: boolean;
  readonly limits: { readonly requested: Partial<Limits>; readonly effective: Limits };
  readonly seed: number | null;
  readonly served: string | null;
  readonly queue_ms: number;
  readonly run_ms: number;
}

export interface SessionInfo {
  readonly session_id: string;
  readonly run_id: string;
  readonly execution: string;
  readonly opened_with: MemoryState;
  readonly origin: unknown;
  readonly head: MemoryState;
  readonly head_id: string;
  readonly receipts: number;
  readonly pending: string | null;
  readonly closed: boolean;
}

export class SessionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

type Line = Record<string, unknown> & { kind: string; prev: string | null; hash: string };

interface Session {
  info: { session_id: string; run_id: string; execution: string; pkg: JuniorPackage; opened_with: MemoryState; origin: unknown };
  head: MemoryState;
  receipts: Map<string, Receipt>;
  order: string[];
  pending: { request_id: string; content_hash: string; epoch: number; abort: AbortController; done: Promise<Receipt> } | null;
  closed: boolean;
  last: string | null;
  file: string;
}

export interface SessionServerOptions {
  readonly root: string;
  readonly store: BlobStore;
  readonly worker: JuniorWorker;
  /** Grace past a job's own time limit before the server kills it as a failure of the infrastructure. */
  readonly graceMs?: number;
  /** How long a job may wait in the queue before it is given up (infra, never a failure of the junior). */
  readonly queueTimeoutMs?: number;
  readonly now?: () => number;
}

const hashLine = (l: Omit<Line, 'hash'>): string => sha256(stableStringify(l));

/** Lines of a session's ledger, their chain checked: each names the hash of the one before, and its own. */
export function readLedger(file: string): Line[] {
  if (!fs.existsSync(file)) return [];
  const out: Line[] = [];
  let prev: string | null = null;
  const text = fs.readFileSync(file, 'utf8');
  const rows = text.split('\n');
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row.trim()) continue;
    let l: Line;
    try { l = JSON.parse(row); } catch {
      // A last line cut by a crash was never published; any other is an altered ledger.
      if (i === rows.length - 1 || rows.slice(i + 1).every((r) => !r.trim())) break;
      throw new SessionError('ledger_corrupt', file + ': line ' + (i + 1) + ' is not JSON');
    }
    const { hash, ...rest } = l;
    if (rest.prev !== prev || hashLine(rest as Omit<Line, 'hash'>) !== hash) throw new SessionError('ledger_corrupt', file + ': line ' + (i + 1) + ' breaks the chain');
    out.push(l);
    prev = hash;
  }
  return out;
}

export class SessionServer {
  readonly root: string;
  readonly store: BlobStore;
  private readonly worker: JuniorWorker;
  private readonly sessions = new Map<string, Session>();
  private readonly graceMs: number;
  private readonly queueTimeoutMs: number;
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();
  private epoch = 0;
  /** The epoch the queue is serving; a result of any other is never published. */
  private serving = -1;
  /** Packages by execution hash, for sessions reloaded from their ledger. */
  private readonly packages = new Map<string, JuniorPackage>();
  /** Stopped: it publishes nothing more, whatever its worker answers late. */
  private stopped = false;
  private readonly lock: string;

  constructor(o: SessionServerOptions) {
    this.root = o.root;
    this.store = o.store;
    this.worker = o.worker;
    this.graceMs = o.graceMs ?? 30_000;
    this.queueTimeoutMs = o.queueTimeoutMs ?? Infinity;
    this.now = o.now ?? Date.now;
    fs.mkdirSync(path.join(this.root, 'sessions'), { recursive: true });
    this.lock = path.join(this.root, 'server.lock');
    this.takeLock();
    this.reload();
  }

  /** One server writes a root at a time: two would interleave one ledger. A lock left by a process that is gone is taken. */
  private takeLock(): void {
    const mine = JSON.stringify({ pid: process.pid, token: randomUUID() });
    for (let attempt = 0; attempt < 2; attempt++) {
      try { fs.writeFileSync(this.lock, mine, { flag: 'wx' }); return; } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        let pid = 0;
        try { pid = Number(JSON.parse(fs.readFileSync(this.lock, 'utf8')).pid); } catch { /* unreadable: treated as gone */ }
        let alive = false;
        if (pid > 0) { try { process.kill(pid, 0); alive = true; } catch (k) { alive = (k as NodeJS.ErrnoException).code === 'EPERM'; } }
        if (alive) throw new SessionError('root_busy', 'another server (pid ' + pid + ') holds ' + this.root);
        fs.rmSync(this.lock, { force: true });
      }
    }
    throw new SessionError('root_busy', 'could not take ' + this.lock);
  }

  /** Stops this server: its worker invalidated, nothing published after, its lock released. A question it was answering
      stays an intention; the next server on this root publishes its failure. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.worker.invalidate?.();
    fs.rmSync(this.lock, { force: true });
  }

  private fileOf(id: string): string { return path.join(this.root, 'sessions', id + '.jsonl'); }

  private append(s: Session, line: Record<string, unknown> & { kind: string }): void {
    const body = { ...line, prev: s.last } as Omit<Line, 'hash'>;
    const full = { ...body, hash: hashLine(body) };
    const fd = fs.openSync(s.file, 'a');
    try { fs.writeSync(fd, JSON.stringify(full) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    s.last = full.hash;
  }

  /** Sessions from their ledgers. An intention with no receipt was cut by a stop of this server: its worker died with it and
      can never publish, so the server attests it and publishes its failure, the memory unchanged, its consumption uncertain. */
  private reload(): void {
    const dir = path.join(this.root, 'sessions');
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort()) {
      const lines = readLedger(path.join(dir, f));
      const open = lines.find((l) => l.kind === 'open');
      if (!open) continue;
      const pkg = normalizePackage(open.package);
      const s: Session = {
        info: { session_id: String(open.session_id), run_id: String(open.run_id), execution: String(open.execution), pkg, opened_with: open.state as MemoryState, origin: open.origin ?? null },
        head: open.state as MemoryState, receipts: new Map(), order: [], pending: null, closed: false, last: lines.length ? lines[lines.length - 1].hash : null, file: path.join(dir, f)
      };
      this.packages.set(s.info.execution, pkg);
      let intent: Line | null = null;
      for (const l of lines) {
        if (l.kind === 'intent') intent = l;
        if (l.kind === 'receipt') { const r = l.receipt as Receipt; s.receipts.set(r.request_id, r); s.order.push(r.request_id); s.head = r.after; intent = null; }
        if (l.kind === 'close') s.closed = true;
      }
      this.sessions.set(s.info.session_id, s);
      if (intent) this.publish(s, this.failure(s, intent, 'infra_failed', 'the server stopped while it ran; its worker can no longer publish', null, 0, 0));
    }
  }

  private failure(s: Session, intent: Line, terminal: 'cancelled' | 'infra_failed', reason: string, served: string | null, queue_ms: number, run_ms: number): Receipt {
    return {
      request_id: String(intent.request_id), content_hash: String(intent.content_hash), content: String(intent.content), state_before: stateId(s.head),
      state_after: stateId(s.head), after: s.head, terminal, reason, text: '', trace: null, ops: [], usage: null, uncertain: true,
      limits: intent.limits as Receipt['limits'], seed: (intent.seed ?? null) as number | null, served, queue_ms, run_ms
    };
  }

  private publish(s: Session, r: Receipt): Receipt {
    if (this.stopped) throw new SessionError('stopped', 'this server is stopped: it publishes nothing');
    this.append(s, { kind: 'receipt', receipt: r });
    s.receipts.set(r.request_id, r);
    s.order.push(r.request_id);
    s.head = r.after;
    return r;
  }

  private get(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new SessionError('no_session', 'no session ' + id);
    return s;
  }

  info(id: string): SessionInfo {
    const s = this.get(id);
    return { session_id: s.info.session_id, run_id: s.info.run_id, execution: s.info.execution, opened_with: s.info.opened_with, origin: s.info.origin,
      head: s.head, head_id: stateId(s.head), receipts: s.order.length, pending: s.pending?.request_id ?? null, closed: s.closed };
  }

  /** Opens a session: its run, its package (checked closed in the store), the state it starts from. Without a state it starts
      from the package's initial memory; a probe `cut` or a distillation passes the cut's snapshot, and its origin is recorded.
      `continues` links a new session to the last receipt of another, whose state it starts from. */
  open(o: { run_id: string; pkg: unknown; session_id?: string; state?: MemoryState; origin?: unknown; continues?: { session_id: string } }): SessionInfo {
    const pkg = normalizePackage(o.pkg);
    const closed = checkClosed(pkg, this.store);
    if (!closed.closed) throw new SessionError('package_open', 'the package is not closed in the store: ' + [...closed.missing.map((m) => 'missing ' + m), ...closed.corrupt.map((c) => 'corrupt ' + c)].join(', '));
    const refused = this.worker.check?.(pkg) ?? null;
    if (refused) throw new SessionError('unsupported', 'the worker cannot serve this package: ' + refused);
    const execution = executionHash(pkg);
    let state: MemoryState = o.state ?? pkg.memory;
    let origin: unknown = o.origin ?? (o.state ? null : { from: 'package' });
    if (o.state && o.origin === undefined) throw new SessionError('origin_missing', 'a session opened from an explicit snapshot declares where it comes from');
    if (o.continues) {
      if (o.state) throw new SessionError('bad_open', 'a continuation starts from the last receipt of its session, not from a state given');
      const prev = this.get(o.continues.session_id);
      if (prev.pending) throw new SessionError('pending', 'the session continued still has a question pending: resolve it first');
      if (prev.info.execution !== execution) throw new SessionError('bad_open', 'a continuation serves the same junior as its session');
      state = prev.head;
      origin = { continues: prev.info.session_id, receipt: prev.order[prev.order.length - 1] ?? null, state: stateId(prev.head) };
    }
    if ((state.neural === null) !== (state.twin === null)) throw new SessionError('bad_state', 'a memory state has both its neural snapshot and its twin, or neither');
    for (const b of [state.neural, state.twin]) if (b !== null && !this.store.intact(b)) throw new SessionError('bad_state', 'the state blob ' + b + ' is missing or corrupt');
    const id = o.session_id ?? randomUUID();
    if (this.sessions.has(id) || fs.existsSync(this.fileOf(id))) throw new SessionError('exists', 'session ' + id + ' exists');
    const s: Session = { info: { session_id: id, run_id: o.run_id, execution, pkg, opened_with: state, origin }, head: state, receipts: new Map(), order: [], pending: null, closed: false, last: null, file: this.fileOf(id) };
    this.append(s, { kind: 'open', session_id: id, run_id: o.run_id, execution, package: pkg, state, origin, at: this.now() });
    this.sessions.set(id, s);
    this.packages.set(execution, pkg);
    return this.info(id);
  }

  /** A receipt, or where its request stands: published, pending (running or queued), or unknown to this session. */
  receipt(id: string, request_id: string): { state: 'published'; receipt: Receipt } | { state: 'pending' } | { state: 'unknown' } {
    const s = this.get(id);
    const r = s.receipts.get(request_id);
    if (r) return { state: 'published', receipt: r };
    if (s.pending?.request_id === request_id) return { state: 'pending' };
    return { state: 'unknown' };
  }

  /** A memory state read as files, by the worker that serves its package (§4). */
  async render(o: { pkg: unknown; twin: BlobId | null }): Promise<Record<string, string>> {
    const pkg = normalizePackage(o.pkg);
    if (!this.worker.render) throw new SessionError('unsupported', 'this worker cannot read a memory as files');
    if (o.twin !== null && !this.store.intact(o.twin)) throw new SessionError('bad_state', 'the twin ' + o.twin + ' is missing or corrupt');
    const r = await this.worker.render({ pkg, execution: executionHash(pkg), twin: o.twin === null ? null : this.store.get(o.twin), store: this.store });
    if ('error' in r && typeof r.error === 'string' && Object.keys(r).length === 1) throw new SessionError('render_failed', r.error);
    return r as Record<string, string>;
  }

  /** The state a new question starts from: the last one published, its blobs checked (§5.2: never the initial one). */
  restore(id: string): { head: MemoryState; head_id: string; last_receipt: string | null } {
    const s = this.get(id);
    for (const b of [s.head.neural, s.head.twin]) if (b !== null && !this.store.intact(b)) throw new SessionError('bad_state', 'the published state blob ' + b + ' is missing or corrupt');
    return { head: s.head, head_id: stateId(s.head), last_receipt: s.order[s.order.length - 1] ?? null };
  }

  close(id: string): SessionInfo {
    const s = this.get(id);
    if (s.pending) throw new SessionError('pending', 'a question is pending: cancel or wait for it first');
    if (!s.closed) { this.append(s, { kind: 'close', at: this.now() }); s.closed = true; }
    return this.info(id);
  }

  /** Stops a question: its worker invalidated, its failure published with the memory unchanged and what it spent uncertain. */
  async cancel(id: string, request_id: string): Promise<Receipt | null> {
    const s = this.get(id);
    if (!s.pending || s.pending.request_id !== request_id) return s.receipts.get(request_id) ?? null;
    s.pending.abort.abort();
    return s.pending.done;
  }

  /** A question as an OpenAI chat completion, for a laboratory that talks to the junior as to any System 2: its system
      message and its user parts are the content; its max_tokens a limit requested. The same content asked again (a retry
      of the harness) is its receipt; after a failure of the infrastructure it is asked anew, as another request. It always
      starts from the state the session is at. */
  async chat(id: string, body: { messages?: { role: string; content: unknown }[]; max_tokens?: number; max_completion_tokens?: number }): Promise<Receipt> {
    const s = this.get(id);
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    const text = (c: unknown): string => (typeof c === 'string' ? c : JSON.stringify(c));
    const content = { system: msgs.filter((m) => m.role === 'system').map((m) => text(m.content)).join('\n\n'), user: { parts: msgs.filter((m) => m.role !== 'system').map((m) => text(m.content)) } };
    const most = Number(body.max_completion_tokens ?? body.max_tokens);
    const limits: Partial<Limits> = most > 0 ? { max_tokens: most } : {};
    const content_hash = sha256(stableStringify({ content, limits, seed: null }));
    if (s.pending?.content_hash === content_hash) return s.pending.done;
    const last = [...s.order].reverse().map((r) => s.receipts.get(r)!).find((r) => r.content_hash === content_hash);
    if (last && (last.terminal === 'answered' || last.terminal === 'limit_reached') && last.state_after === stateId(s.head)) return last;
    return this.ask(id, { request_id: 'chat:' + s.order.length, content, expected: stateId(s.head), limits });
  }

  /** Asks one question. `expected` is the id of the state it must start from (stateId). */
  ask(id: string, q: { request_id: string; content: unknown; expected: string; limits?: Partial<Limits>; seed?: number | null }): Promise<Receipt> {
    if (this.stopped) return Promise.reject(new SessionError('stopped', 'this server is stopped'));
    const s = this.get(id);
    const content_hash = sha256(stableStringify({ content: q.content, limits: q.limits ?? {}, seed: q.seed ?? null }));
    const done = s.receipts.get(q.request_id);
    if (done) {
      if (done.content_hash !== content_hash) return Promise.reject(new SessionError('request_conflict', 'request ' + q.request_id + ' was asked with another content'));
      return Promise.resolve(done);
    }
    if (s.pending) {
      if (s.pending.request_id !== q.request_id) return Promise.reject(new SessionError('busy', 'the session is answering ' + s.pending.request_id + '; its questions are served one at a time'));
      if (s.pending.content_hash !== content_hash) return Promise.reject(new SessionError('request_conflict', 'request ' + q.request_id + ' was asked with another content'));
      return s.pending.done;
    }
    if (s.closed) return Promise.reject(new SessionError('closed', 'session ' + id + ' is closed'));
    if (q.expected !== stateId(s.head)) return Promise.reject(new SessionError('stale_state', 'the session is at ' + stateId(s.head) + ', not ' + q.expected));

    const d = s.info.pkg.decoding;
    const req = q.limits ?? {};
    const effective: Limits = {
      max_tokens: Math.min(d.max_tokens, req.max_tokens ?? Infinity),
      max_circuit_tokens: Math.min(d.max_circuit_tokens, req.max_circuit_tokens ?? Infinity),
      timeout_ms: req.timeout_ms ?? 600_000
    };
    const limits = { requested: req, effective };
    const contentBlob = this.store.put(stableStringify(q.content));
    const epoch = ++this.epoch;
    const intent = { kind: 'intent', request_id: q.request_id, content_hash, content: contentBlob, state_before: stateId(s.head), epoch, limits, seed: q.seed ?? null, at: this.now() };
    this.append(s, intent);
    const abort = new AbortController();
    const queued = this.now();
    const run = async (): Promise<Receipt> => {
      const queue_ms = this.now() - queued;
      const intentLine = { ...intent, prev: null, hash: '' } as Line;
      if (abort.signal.aborted) return this.publish(s, this.failure(s, intentLine, 'cancelled', 'cancelled before it ran', null, queue_ms, 0));
      if (queue_ms > this.queueTimeoutMs) return this.publish(s, this.failure(s, intentLine, 'infra_failed', 'the queue timed out before it ran', null, queue_ms, 0));
      this.serving = epoch;
      const started = this.now();
      const job = new AbortController();
      const onAbort = (): void => job.abort();
      abort.signal.addEventListener('abort', onAbort);
      let killed: 'cancelled' | 'timeout' | null = null;
      const hard = setTimeout(() => { killed = 'timeout'; job.abort(); }, effective.timeout_ms + this.graceMs);
      abort.signal.addEventListener('abort', () => { killed ??= 'cancelled'; });
      let result: WorkerResult | null = null, error: unknown = null;
      try {
        result = await Promise.race([
          this.worker.run({ pkg: s.info.pkg, execution: s.info.execution, state: s.head, store: this.store, content: q.content, limits: effective, seed: q.seed ?? null, signal: job.signal }),
          new Promise<null>((resolve) => job.signal.addEventListener('abort', () => resolve(null)))
        ]);
      } catch (e) { error = e; } finally { clearTimeout(hard); abort.signal.removeEventListener('abort', onAbort); }
      const run_ms = this.now() - started;
      if (killed || result === null || this.serving !== epoch) {
        this.worker.invalidate?.();
        this.serving = -1;
        return this.publish(s, this.failure(s, intentLine, killed === 'cancelled' ? 'cancelled' : 'infra_failed',
          killed === 'cancelled' ? 'cancelled while it ran' : killed === 'timeout' ? 'the worker passed its time limit and was stopped' : 'the worker failed: ' + String((error as Error)?.message ?? error), null, queue_ms, run_ms));
      }
      this.serving = -1;
      if (result.served !== s.info.execution)
        return this.publish(s, this.failure(s, intentLine, 'infra_failed', 'the worker served ' + result.served + ', not ' + s.info.execution, result.served, queue_ms, run_ms));
      // A complete answer carries its memory after; anything else keeps the memory it started from (§5.1).
      let after: MemoryState = s.head;
      if (result.terminal === 'answered') {
        if (!result.after) return this.publish(s, this.failure(s, intentLine, 'infra_failed', 'the worker answered without the memory after', result.served, queue_ms, run_ms));
        after = { neural: result.after.neural ? this.store.put(result.after.neural) : null, twin: result.after.twin ? this.store.put(result.after.twin) : null };
        if ((after.neural === null) !== (after.twin === null)) return this.publish(s, this.failure(s, intentLine, 'infra_failed', 'the worker returned half a memory state', result.served, queue_ms, run_ms));
      }
      const trace = this.store.put(result.trace);
      return this.publish(s, {
        request_id: q.request_id, content_hash, content: contentBlob, state_before: stateId(s.head), state_after: stateId(after), after,
        terminal: result.terminal, reason: result.reason ?? null, text: result.text, trace, ops: result.ops, usage: result.usage,
        uncertain: result.usage === null, limits, seed: q.seed ?? null, served: result.served, queue_ms, run_ms
      });
    };
    const p = this.queue.then(run, run).finally(() => { if (s.pending?.epoch === epoch) s.pending = null; });
    this.queue = p.catch(() => undefined);
    s.pending = { request_id: q.request_id, content_hash, epoch, abort, done: p };
    return p;
  }
}
