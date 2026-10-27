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
 * A REFUSAL is an answer too, in a channel whose service is deterministic (`DETERMINISTIC`: the environment's): the same
 * request refused again is refused again, and the run depends on it (an act refused costs nothing and says so). It is
 * logged and served like any answer. A log written before it was (08/10/2026) lacks its refusals: a request of such a
 * channel that finds no answer while answers wait is asked of the service then - if it is refused, that is the refusal
 * the log never kept, and the run goes on; if it is answered, the run diverged. Never in another channel: an answer of
 * System 2 or of the Judge asked again is another answer.
 *
 * A CLOSING after a budget (the reflection a run is asked when its tokens or its time stopped the investigation) is
 * logged marked `closing`: a run resumed goes on past that point, so it never asks it again - those answers wait for
 * nobody and are no divergence. They are served if the same request comes (the same budget reached at the same place).
 *
 * A resumed run needs the log of the run it resumes: without it, every request would go to
 * the network again - costs and acts repeated - so a missing log is an error, never an
 * empty history.
 *
 * A FAILURE is part of the record too (27/10/2026: a run whose Judge failed in every call could not be resumed - its
 * failures were never logged, so the resumed run asked again and diverged): an answer that is an error of the service, a
 * key or a limit (an HTTP error that is not a refusal), and a request that never got an answer (the network), each logged
 * with what it was and served again as it was - the error, or the request failing - at the same place. A log written
 * before failures were kept lacks them: where the run it resumes recorded every call of a channel as failed (`failed`),
 * a request of that channel that finds no answer while answers wait is answered as failed - what its record says - and
 * the run goes on; any other is a divergence.
 *
 * Only the answers are logged: never a request's headers or its URL (where the keys travel),
 * never a key.
 * ========================================================================== */

/** URL parameters that carry credentials: they are not part of what a request is. */
const CREDENTIAL = /^(api[-_]?key|key|token|access[-_]?token|auth|authorization|signature|sig|secret|password)$/i;

/** What makes a request that request, for the log: channel, method, path and parameters (without the host and without
    credentials), and body. A source (channel "source") is a page anywhere: its host is part of what it is. */
export function requestIdentity(channel: string, url: string, init: { method?: string; body?: string }): string {
  let where = url;
  try {
    const u = new URL(url);
    const params = [...u.searchParams.entries()].filter(([k]) => !CREDENTIAL.test(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    where = (channel === 'source' ? u.host : '') + u.pathname + (params.length ? '?' + new URLSearchParams(params).toString() : '');
  } catch { /* not an absolute URL: as it is */ }
  return createHash('sha256').update([channel, (init.method ?? 'POST').toUpperCase() + ' ' + where, init.body ?? ''].join('\n')).digest('base64url');
}

interface Entry { readonly channel: string; readonly key: string; readonly status: number; readonly text: string; readonly closing?: boolean;
  /** A request that never got an answer (the network): what it failed with. */
  readonly failed?: string }

/** The answer a request gets where the run it resumes recorded every call of its channel as failed, and its log (written
    before failures were kept) holds no answer: failed, as its record says - an error that is not retried. */
const RECORDED_AS_FAILED = { status: 424, text: '{"error":"the run this one resumes recorded every call of this channel as failed; its log, written before failures were kept, does not hold this one"}' };

/** Channels whose refusals are answers (logged, replayed): the environment's service, deterministic. */
export const DETERMINISTIC: ReadonlySet<string> = new Set(['env']);
/** A refusal: the service understood the request and declined it (not a fault of the network, of a key or of a limit). */
const isRefusal = (status: number): boolean => status >= 400 && status < 500 && ![401, 402, 403, 407, 408, 429].includes(status);

export interface ReplayStats {
  /** Answers served from the log it resumes, per channel. */
  readonly replayed: Record<string, number>;
  /** Answers that came live (and were logged), per channel. */
  readonly live: Record<string, number>;
  /** Logged answers never asked for again. */
  readonly unused: number;
  /** Refusals a log written before they were kept lacked, asked again of their deterministic service. */
  readonly refusals_asked_again?: Record<string, number>;
  /** Requests of a channel its record says failed in every call, answered as failed (a log that never kept failures). */
  readonly failures_as_recorded?: Record<string, number>;
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
  /** Refusals a log written before they were logged lacked, asked again of their deterministic service. */
  private readonly refilled: Record<string, number> = {};
  private readonly onDiverge?: (d: { channel: string; pending: number }) => void;
  /** Channels the run it resumes recorded as failing in every call (a log written before failures were kept), and the
      error its record shows for them, when it shows one. */
  private readonly failedChannels: ReadonlyMap<string, { status?: number; statusText?: string }>;
  private readonly reproduced: Record<string, number> = {};
  private readonly stallMs: number;
  private served = 0;
  private diverged: { channel: string; pending: number } | undefined;
  /** Answers of a closing after a budget: served if asked, never waited for. */
  private readonly optional = new Map<string, Entry[]>();
  /** Set while the run asks its closing after a budget: what it is answered is logged so marked. */
  closing = false;

  /** `file`: the log this run writes (started empty). `from`: the log of the run it resumes, read and never written. */
  constructor(file: string, options: { from?: string; onDiverge?: (d: { channel: string; pending: number }) => void; stallMs?: number;
    failed?: readonly (string | { readonly channel: string; readonly status?: number; readonly statusText?: string })[] } = {}) {
    this.file = file;
    this.onDiverge = options.onDiverge;
    this.failedChannels = new Map((options.failed ?? []).map((f) => (typeof f === 'string' ? [f, {}] : [f.channel, { status: f.status, statusText: f.statusText }])));
    this.stallMs = options.stallMs ?? 3000;
    if (options.from && fs.existsSync(options.from) && fs.realpathSync(options.from) === (fs.existsSync(file) ? fs.realpathSync(file) : '')) {
      throw new Error('a resumed run writes a log of its own: ' + file + ' is the log it resumes');
    }
    for (const e of options.from ? readReplayLog(options.from) : []) {
      const pool = e.closing ? this.optional : this.queue;
      const list = pool.get(e.key) ?? [];
      list.push(e);
      pool.set(e.key, list);
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
    return { replayed: { ...this.replayed }, live: { ...this.live }, unused: this.pending(), ...(Object.keys(this.refilled).length ? { refusals_asked_again: { ...this.refilled } } : {}),
      ...(Object.keys(this.reproduced).length ? { failures_as_recorded: { ...this.reproduced } } : {}),
      ...(this.diverged ? { diverged: this.diverged } : {}) };
  }

  private record(entry: Entry): void {
    const { closing: _c, ...plain } = entry;
    fs.appendFileSync(this.file, JSON.stringify(this.closing ? { ...plain, closing: true } : plain) + '\n');
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
        const e = this.queue.get(key)?.shift() ?? this.optional.get(key)?.shift();
        if (!e) return null;
        this.served++;
        this.replayed[channel] = (this.replayed[channel] ?? 0) + 1;
        this.record(e);
        /* A request that failed then fails again, as it did. */
        if (e.failed !== undefined) throw new TypeError(e.failed);
        return { ok: e.status < 400, status: e.status, text: async () => e.text, headers: { get: () => null } };
      };
      const logged = take();
      if (logged) return logged;
      if (this.pending() > 0 && !(await this.mayGoLive())) {
        const later = take();
        if (later) return later;
        /* A refusal an older log never kept, asked again of its deterministic service. */
        if (DETERMINISTIC.has(channel) && !this.divergence()) {
          const again = await fetch(url, init);
          if (!again.ok && isRefusal(again.status)) {
            const text = await again.text();
            this.record({ channel, key, status: again.status, text });
            this.refilled[channel] = (this.refilled[channel] ?? 0) + 1;
            return { ok: false, status: again.status, statusText: again.statusText, text: async () => text, headers: { get: (name: string) => again.headers?.get(name) ?? null } };
          }
        }
        /* A channel its record says failed in every call, in a log that never kept failures: failed, as recorded. */
        const as = this.failedChannels.get(channel);
        if (as && !this.divergence()) {
          /* The error its record shows (what the researcher was told), else a failure that is not retried. */
          const status = as.status ?? RECORDED_AS_FAILED.status, statusText = as.status ? (as.statusText ?? '') : 'Failed Dependency';
          this.record({ channel, key, status, text: RECORDED_AS_FAILED.text });
          this.reproduced[channel] = (this.reproduced[channel] ?? 0) + 1;
          return { ok: false, status, statusText, text: async () => RECORDED_AS_FAILED.text, headers: { get: () => null } };
        }
        this.diverged = { channel, pending: this.pending() };
        this.onDiverge?.(this.diverged);
        throw new ReplayDivergence(channel, this.diverged.pending);
      }
      /* Another request may have found the divergence while this one waited: then this one is not asked either. */
      const stop = this.divergence();
      if (stop) throw new ReplayDivergence(stop.channel, stop.pending);
      let response: Awaited<ReturnType<FetchLike>>;
      try { response = await fetch(url, init); }
      catch (e) {
        /* No answer at all (the network): logged as failed, unless it was stopped (an abort is not the service's). */
        if (!init.signal?.aborted) this.record({ channel, key, status: 0, text: '', failed: String((e as Error)?.message ?? e).slice(0, 300) });
        throw e;
      }
      if (!response.ok) {
        /* An error of the service (or a refusal of the environment): an answer, logged, served again as it was. */
        const text = await response.text();
        this.record({ channel, key, status: response.status, text });
        this.live[channel] = (this.live[channel] ?? 0) + 1;
        return { ok: false, status: response.status, statusText: response.statusText, text: async () => text, headers: { get: (name: string) => response.headers?.get(name) ?? null } };
      }
      const text = await response.text();
      this.record({ channel, key, status: response.status, text });
      this.live[channel] = (this.live[channel] ?? 0) + 1;
      return { ok: true, status: response.status, statusText: response.statusText, text: async () => text,
        headers: { get: (name: string) => response.headers?.get(name) ?? null } };
    };
  }
}
