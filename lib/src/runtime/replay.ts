import fs from 'node:fs';
import { createHash } from 'node:crypto';
import type { FetchLike } from '../core/net.ts';

/* ============================================================================
 * A run that can be RESUMED (SPEC-OBJETIVO O11), by replay rather than by saving state.
 *
 * The environment is deterministic given its seed; what is not is what comes over the
 * network - System 2's answers and the Judge's. Each one is appended to a log the moment it
 * arrives (a checkpoint after every answer). Resuming runs the same run again with the same
 * arguments, serving the logged answers to the same requests: the protocol, the session and
 * the notebook come back exactly as they were, and the run goes on live from where it
 * stopped - a crash, a Ctrl+C or a budget.
 *
 * Provenance is kept: a resumed run never writes into the run it resumes. It reads that
 * run's log (`from`, left untouched) and writes a log of its own that holds every answer it
 * used, replayed or live, so it can be resumed in turn. A line cut by a hard stop in the log
 * it reads is dropped, and nothing is ever appended after it.
 *
 * A request the log does not answer while logged answers are still waiting is a DIVERGENCE:
 * the resumed run is no longer the run it resumes (the code or the configuration changed).
 * The network is not asked; `onDiverge` is told, and the request fails. Requests that run
 * together (the Judge's, several at once) may reach the log in another order than they did
 * the first time: a request without an answer first waits while the others are served, and
 * only a log that stops being consumed is a divergence.
 *
 * A REQUEST is known by what makes it that request: its channel, its method, its path and
 * parameters, and its body (the SHA-256 of them). A PUT is not the POST it follows, nor is
 * /second the answer of /first. Two things are left out: the host (a service may move to
 * another address between a stop and a resume and still be the same service), and the
 * parameters that carry credentials (key, token, signature...), which may rotate.
 *
 * A resumed run needs the log of the run it resumes: without it, every request would go to
 * the network again - costs and acts repeated - so a missing log is an error, never an
 * empty history.
 *
 * Only the answers are logged: never a request's headers or its URL (where the keys travel),
 * never a key.
 * ========================================================================== */

/** URL parameters that carry credentials: they are not part of what a request is. */
const CREDENTIAL = /^(api[-_]?key|key|token|access[-_]?token|auth|authorization|signature|sig|secret|password)$/i;

/** What makes a request that request, for the log: channel, method, path and parameters (without the host and without
    credentials), and body. */
export function requestIdentity(channel: string, url: string, init: { method?: string; body?: string }): string {
  let where = url;
  try {
    const u = new URL(url);
    const params = [...u.searchParams.entries()].filter(([k]) => !CREDENTIAL.test(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    where = u.pathname + (params.length ? '?' + new URLSearchParams(params).toString() : '');
  } catch { /* not an absolute URL: as it is */ }
  return createHash('sha256').update([channel, (init.method ?? 'POST').toUpperCase() + ' ' + where, init.body ?? ''].join('\n')).digest('base64url');
}

interface Entry { readonly channel: string; readonly key: string; readonly status: number; readonly text: string }

export interface ReplayStats {
  /** Answers served from the log it resumes, per channel. */
  readonly replayed: Record<string, number>;
  /** Answers that came live (and were logged), per channel. */
  readonly live: Record<string, number>;
  /** Logged answers never asked for again. */
  readonly unused: number;
  /** Set when a request found no answer while logged ones were waiting. */
  readonly diverged?: { readonly channel: string; readonly pending: number };
}

export class ReplayDivergence extends Error {
  readonly channel: string;
  readonly pending: number;
  constructor(channel: string, pending: number) {
    super('the resumed run asked something the run it resumes did not (' + channel + '; ' + pending + ' logged answers still waiting): it diverged');
    this.name = 'ReplayDivergence';
    this.channel = channel;
    this.pending = pending;
  }
}

/** The answers of a log, in order; a line that does not parse (cut by a hard stop) is dropped. A missing log is an error. */
export function readReplayLog(file: string): Entry[] {
  if (!fs.existsSync(file)) throw new Error('the log of the run it resumes is missing (' + file + '): without it every request would be made again');
  const out: Entry[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Entry;
      if (typeof e?.key === 'string' && typeof e.text === 'string') out.push(e);
    } catch { /* cut by a hard stop: that answer is asked again */ }
  }
  return out;
}

export class ReplayLog {
  private readonly file: string;
  private readonly queue = new Map<string, Entry[]>();
  private readonly replayed: Record<string, number> = {};
  private readonly live: Record<string, number> = {};
  private readonly onDiverge?: (d: { channel: string; pending: number }) => void;
  private readonly stallMs: number;
  private served = 0;
  private diverged: { channel: string; pending: number } | undefined;

  /** `file`: the log this run writes (started empty). `from`: the log of the run it resumes, read and never written. */
  constructor(file: string, options: { from?: string; onDiverge?: (d: { channel: string; pending: number }) => void; stallMs?: number } = {}) {
    this.file = file;
    this.onDiverge = options.onDiverge;
    this.stallMs = options.stallMs ?? 3000;
    if (options.from && fs.existsSync(options.from) && fs.realpathSync(options.from) === (fs.existsSync(file) ? fs.realpathSync(file) : '')) {
      throw new Error('a resumed run writes a log of its own: ' + file + ' is the log it resumes');
    }
    for (const e of options.from ? readReplayLog(options.from) : []) {
      const list = this.queue.get(e.key) ?? [];
      list.push(e);
      this.queue.set(e.key, list);
    }
    fs.writeFileSync(file, '');
  }

  /** The divergence, once found (a method: it may be found by another request while one waits). */
  divergence(): { channel: string; pending: number } | undefined { return this.diverged; }

  /** How many logged answers are still waiting to be served. */
  pending(): number {
    let n = 0;
    for (const list of this.queue.values()) n += list.length;
    return n;
  }

  stats(): ReplayStats {
    return { replayed: { ...this.replayed }, live: { ...this.live }, unused: this.pending(), ...(this.diverged ? { diverged: this.diverged } : {}) };
  }

  private record(entry: Entry): void {
    fs.appendFileSync(this.file, JSON.stringify(entry) + '\n');
  }

  /** Whether a request without a logged answer may go live: once nothing is waiting. While answers wait and are being
      served (requests that run together), it waits; if they stop being served, the run diverged. */
  private async mayGoLive(): Promise<boolean> {
    let seen = this.served, since = Date.now();
    while (this.pending() > 0) {
      await new Promise((r) => setTimeout(r, 5));
      if (this.served !== seen) { seen = this.served; since = Date.now(); } else if (Date.now() - since >= this.stallMs) return false;
    }
    return true;
  }

  /** `fetch` for one channel ("llm", "jev"): logged answers first, then the network, logging what it answers. */
  wrap(channel: string, fetch: FetchLike = globalThis.fetch as unknown as FetchLike): FetchLike {
    return async (url, init) => {
      /* After a divergence nothing is answered, logged or asked: the run has ended. */
      if (this.diverged) throw new ReplayDivergence(this.diverged.channel, this.diverged.pending);
      const key = requestIdentity(channel, url, init);
      const take = () => {
        const e = this.queue.get(key)?.shift();
        if (!e) return null;
        this.served++;
        this.replayed[channel] = (this.replayed[channel] ?? 0) + 1;
        this.record(e);
        return { ok: true, status: e.status, text: async () => e.text, headers: { get: () => null } };
      };
      const logged = take();
      if (logged) return logged;
      if (this.pending() > 0 && !(await this.mayGoLive())) {
        const later = take();
        if (later) return later;
        this.diverged = { channel, pending: this.pending() };
        this.onDiverge?.(this.diverged);
        throw new ReplayDivergence(channel, this.diverged.pending);
      }
      /* Another request may have found the divergence while this one waited: then this one is not asked either. */
      const stop = this.divergence();
      if (stop) throw new ReplayDivergence(stop.channel, stop.pending);
      const response = await fetch(url, init);
      if (!response.ok) return response;
      const text = await response.text();
      this.record({ channel, key, status: response.status, text });
      this.live[channel] = (this.live[channel] ?? 0) + 1;
      return { ok: true, status: response.status, statusText: response.statusText, text: async () => text,
        headers: { get: (name: string) => response.headers?.get(name) ?? null } };
    };
  }
}
