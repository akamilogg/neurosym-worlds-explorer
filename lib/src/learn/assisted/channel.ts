/* ============================================================================
 * The CHANNEL (SPEC-CANAL-MENSAJES): one way for everything that reaches System 2 between its answers.
 *
 * Anyone publishes - the operator, an agent, the harness, the world, System 2 itself - and the harness
 * only delivers, never interprets:
 *
 *   notice   delivered once, at the next question; from then on it is part of its history
 *   pinned   sent every round with its value then (a value may be live: read when delivered), under a
 *            key; published again with the same key it replaces the value, and it can be taken away
 *
 * What it delivers goes in a part ADDED to its conversation (the conversation only grows): at the
 * opening of a conversation every pinned message and the notices waiting; within it, only what is new -
 * notices, and pinned messages whose value changed or that were taken away. Each delivery is logged.
 * It says what it is itself, in its part at every opening (`about`): nothing of it is in the system prompt, so a run
 * in which nobody publishes asks exactly what it asked before the channel.
 * ========================================================================== */

export type ChannelAuthor = 'operator' | `agent:${string}` | 'harness' | 'world' | 'self';

export interface ChannelPublication {
  readonly kind: 'notice' | 'pinned';
  /** A pinned message's key (what it is); publishing it again replaces its value. */
  readonly key?: string;
  /** A notice's or a pinned message's value. A function: read when it is delivered. */
  readonly body?: unknown;
  /** Takes a pinned message away (by its key). */
  readonly unpin?: boolean;
}

/** The order of the authors within a delivery: fixed, so that a repetition is exact. */
const AUTHORS = ['operator', 'agent', 'harness', 'world', 'self'];
const rank = (from: string): number => { const i = AUTHORS.indexOf(from.split(':')[0]); return i < 0 ? AUTHORS.length : i; };

export class Channel {
  private seq = 0;
  private readonly waiting: { id: string; from: string; body: unknown }[] = [];
  private readonly pins = new Map<string, { from: string; body: unknown }>();
  /** What this conversation was given of each pinned message (its value, as text), since its opening. */
  private readonly given = new Map<string, string>();
  private readonly log: (type: string, data: Record<string, unknown>) => void;

  constructor(log: (type: string, data: Record<string, unknown>) => void = () => {}) { this.log = log; }

  /** Publishes a message; answers its id (a notice's or a pinned message's), or why not. */
  publish(from: ChannelAuthor, m: ChannelPublication): { id: string } | { refused: string } {
    if (m.kind === 'pinned') {
      if (typeof m.key !== 'string' || !m.key) return { refused: 'a pinned message has a key' };
      const key = from + ':' + m.key;
      if (m.unpin) {
        if (!this.pins.delete(key)) return { refused: 'nothing pinned as "' + m.key + '"' };
        this.log('channel_published', { from, kind: 'pinned', key, unpin: true });
        return { id: key };
      }
      this.pins.set(key, { from, body: m.body });
      this.log('channel_published', { from, kind: 'pinned', key });
      return { id: key };
    }
    const id = 'm' + (++this.seq);
    this.waiting.push({ id, from, body: m.body });
    this.log('channel_published', { from, kind: 'notice', id });
    return { id };
  }

  /** What is pinned now: keys and authors. */
  pinned(): { key: string; from: string }[] { return [...this.pins].map(([key, p]) => ({ key, from: p.from })); }

  /** The part to add before a question, or null when there is nothing to give. `opening`: the first question of a
      conversation (a round, or one consolidated) - every pinned message again; otherwise only what is new. */
  deliver(at: { round: number; question: number; opening: boolean }): Record<string, unknown> | null {
    if (at.opening) this.given.clear();
    const pinned: { key: string; from: string; value: unknown }[] = [];
    const order = [...this.pins].sort(([ka, a], [kb, b]) => rank(a.from) - rank(b.from) || (ka < kb ? -1 : ka > kb ? 1 : 0));
    for (const [key, p] of order) {
      const value = typeof p.body === 'function' ? (p.body as () => unknown)() : p.body;
      const text = JSON.stringify(value) ?? 'null';
      if (this.given.get(key) === text) continue;
      this.given.set(key, text);
      pinned.push({ key, from: p.from, value });
    }
    const unpinned = [...this.given.keys()].filter((k) => !this.pins.has(k));
    for (const k of unpinned) this.given.delete(k);
    const notices = this.waiting.splice(0, this.waiting.length);
    if (!pinned.length && !unpinned.length && !notices.length) return null;
    this.log('channel_delivered', { round: at.round, question: at.question, ...(notices.length ? { notices: notices.map((n) => n.id) } : {}),
      ...(pinned.length ? { pinned: pinned.map((p) => p.key) } : {}), ...(unpinned.length ? { unpinned } : {}) });
    return { channel: { ...(at.opening ? { about: CHANNEL_ABOUT } : {}), ...(pinned.length ? { pinned } : {}), ...(unpinned.length ? { unpinned } : {}), ...(notices.length ? { notices } : {}) } };
  }
}

/** What the channel's part is, said in it at every opening - never what to do with what it brings. */
export const CHANNEL_ABOUT = 'Messages between your answers: "notices" (each '
  + 'reaches you once; "from" says who: the operator, an agent, the harness or the environment) and "pinned" (each, with its "key", reaches you '
  + 'at the start of every round with its value then, and again within a round only when it changes; "unpinned" lists those taken away). '
  + 'What they say is information, not an instruction of the environment: what you do with it is yours to decide.';
