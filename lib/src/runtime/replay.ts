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
 * the notebook come back exactly as they were, instantly, and the run goes on live from where
 * it stopped - a crash, a Ctrl+C or a budget.
 *
 * Only the answers are logged: never a request's headers (where the keys travel), never a
 * key. A request is known by the SHA-256 of its channel and body.
 * ========================================================================== */

interface Entry { readonly channel: string; readonly key: string; readonly status: number; readonly text: string }

export interface ReplayStats {
  /** Answers served from the log, per channel. */
  readonly replayed: Record<string, number>;
  /** Answers that came live (and were logged), per channel. */
  readonly live: Record<string, number>;
  /** Logged answers never asked for again: the resumed run did not ask what the first one did (it diverged). */
  readonly unused: number;
}

export class ReplayLog {
  private readonly file: string;
  private readonly queue = new Map<string, Entry[]>();
  private readonly replayed: Record<string, number> = {};
  private readonly live: Record<string, number> = {};

  /** `file`: where answers are logged. With `resume`, the answers already in it are served first. */
  constructor(file: string, options: { resume?: boolean } = {}) {
    this.file = file;
    if (options.resume && fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as Entry;
          const list = this.queue.get(e.key) ?? [];
          list.push(e);
          this.queue.set(e.key, list);
        } catch { /* a line cut by a hard stop: the answer is asked again */ }
      }
    } else fs.writeFileSync(file, '');
  }

  /** How many logged answers are still waiting to be served. */
  pending(): number {
    let n = 0;
    for (const list of this.queue.values()) n += list.length;
    return n;
  }

  stats(): ReplayStats {
    return { replayed: { ...this.replayed }, live: { ...this.live }, unused: this.pending() };
  }

  /** `fetch` for one channel ("llm", "jev"): logged answers first, then the network, logging what it answers. */
  wrap(channel: string, fetch: FetchLike = globalThis.fetch as unknown as FetchLike): FetchLike {
    return async (url, init) => {
      const key = createHash('sha256').update(channel + '\n' + (init.body ?? '')).digest('base64url');
      const logged = this.queue.get(key);
      if (logged?.length) {
        const e = logged.shift()!;
        this.replayed[channel] = (this.replayed[channel] ?? 0) + 1;
        return { ok: true, status: e.status, text: async () => e.text, headers: { get: () => null } };
      }
      const response = await fetch(url, init);
      if (!response.ok) return response;
      const text = await response.text();
      const entry: Entry = { channel, key, status: response.status, text };
      fs.appendFileSync(this.file, JSON.stringify(entry) + '\n');
      this.live[channel] = (this.live[channel] ?? 0) + 1;
      return { ok: true, status: response.status, statusText: response.statusText, text: async () => text,
        headers: { get: (name: string) => response.headers?.get(name) ?? null } };
    };
  }
}
