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
 * Only the answers are logged: never a request's headers (where the keys travel), never a
 * key. A request is known by the SHA-256 of its channel and body.
 * ========================================================================== */

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

/** The answers of a log, in order; a line that does not parse (cut by a hard stop) is dropped. */
export function readReplayLog(file: string): Entry[] {
  if (!fs.existsSync(file)) return [];
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
      const key = createHash('sha256').update(channel + '\n' + (init.body ?? '')).digest('base64url');
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
      if (this.diverged) throw new ReplayDivergence(this.diverged.channel, this.diverged.pending);
      if (this.pending() > 0 && !(await this.mayGoLive())) {
        const later = take();
        if (later) return later;
        this.diverged = { channel, pending: this.pending() };
        this.onDiverge?.(this.diverged);
        throw new ReplayDivergence(channel, this.diverged.pending);
      }
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
