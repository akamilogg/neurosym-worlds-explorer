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

/** `actor:<id>`: another member of a living world's session (SPEC-ACONTECIMIENTOS-DEL-MUNDO §8). */
export type ChannelAuthor = 'operator' | `agent:${string}` | `actor:${string}` | 'harness' | 'world' | 'self';

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
const AUTHORS = ['operator', 'agent', 'actor', 'harness', 'world', 'self'];
const rank = (from: string): number => { const i = AUTHORS.indexOf(from.split(':')[0]); return i < 0 ? AUTHORS.length : i; };

export class Channel {
  private seq = 0;
  private readonly waiting: { id: string; from: string; body: unknown }[] = [];
  /** Every notice published, by id (one can be pinned afterwards). */
  private readonly notices = new Map<string, { from: string; body: unknown }>();
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
    this.notices.set(id, { from, body: m.body });
    /* The body of the environment's and the harness's notices goes to the journal (for the operator and for a senior); an
       operator's or an agent's message is there already, as it was delivered (operator_message). */
    this.log('channel_published', { from, kind: 'notice', id, ...(from === 'world' || from === 'harness' ? { body: m.body } : {}) });
    return { id };
  }

  /** A notice by its id, once delivered (what is still waiting has not reached anyone). */
  notice(id: string): { from: string; body: unknown } | null {
    return this.waiting.some((w) => w.id === id) ? null : this.notices.get(id) ?? null;
  }

  /** Takes in, as they were, the deliveries of another researcher's channel (its journal's `channel_delivered`): its pinned
      messages under their keys, its notices, what it took away. A senior's channel mirrors its junior's this way: everything
      the junior is told between its answers reaches the senior too, with nothing chosen on the way. */
  mirror(delivered: { readonly pinned?: readonly { key: string; from: string; value: unknown }[]; readonly unpinned?: readonly string[];
    readonly notices?: readonly { id?: string; from: string; body: unknown }[] }, options: { readonly notices?: boolean } = {}): void {
    for (const p of delivered.pinned ?? []) this.pins.set(p.key, { from: p.from, body: p.value });
    for (const k of delivered.unpinned ?? []) this.pins.delete(k);
    /* Rebuilding what is pinned (a channel made again, in a run resumed) gives no notice twice. */
    if (options.notices === false) return;
    for (const n of delivered.notices ?? []) {
      const id = 'm' + (++this.seq);
      this.waiting.push({ id, from: n.from, body: n.body });
      this.notices.set(id, { from: n.from, body: n.body });
    }
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
    const part = { ...(pinned.length ? { pinned } : {}), ...(unpinned.length ? { unpinned } : {}), ...(notices.length ? { notices } : {}) };
    /* What was delivered, whole: the record of what its researcher was told between its answers - what a senior, the
       other half of the same researcher, is given as it was (SPEC-CANAL-MENSAJES §9). */
    this.log('channel_delivered', { round: at.round, question: at.question, opening: at.opening, delivered: part });
    return { channel: { ...(at.opening ? { about: CHANNEL_ABOUT } : {}), ...part } };
  }
}

/** What the channel's part is, said in it at every opening - never what to do with what it brings. */
export const CHANNEL_ABOUT = 'Messages between your answers: "notices" (each '
  + 'reaches you once; "from" says who: the operator, an agent, the harness or the environment) and "pinned" (each, with its "key", reaches you '
  + 'at the start of every round with its value then, and again within a round only when it changes; "unpinned" lists those taken away). '
  + 'What they say is information, not an instruction of the environment: what you do with it is yours to decide.';

/* --- What System 2 pins itself (SPEC-CANAL-MENSAJES §6) ------------------------------------------------------------- */

/** One of its pins: a document of its own (delivered in its latest version), a notice it received, or a text - or one
    taken away. */
export type PinOp =
  | { readonly do: 'pin'; readonly id: string; readonly document?: string; readonly message?: string; readonly text?: string }
  | { readonly do: 'unpin'; readonly id: string };

const PIN_ID = /^[a-z][a-z0-9_]*$/;

/** Its "pins", as written in an answer; what cannot be read is a warning, never a guess. */
export function parsePins(raw: unknown, warnings: string[]): PinOp[] {
  const out: PinOp[] = [];
  (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).forEach((d, i) => {
    const o = d && typeof d === 'object' ? d as Record<string, unknown> : null;
    if (!o || (o.do !== 'pin' && o.do !== 'unpin') || typeof o.id !== 'string' || !PIN_ID.test(o.id)) { warnings.push('pin #' + i + ' ignored: needs "do": pin | unpin and an "id" in lowercase_snake_case'); return; }
    if (o.do === 'unpin') { out.push({ do: 'unpin', id: o.id }); return; }
    const sources = (['document', 'message', 'text'] as const).filter((k) => typeof o[k] === 'string' && (o[k] as string).trim());
    if (sources.length !== 1) { warnings.push('pin "' + o.id + '" ignored: it pins one "document", "message" or "text"'); return; }
    out.push({ do: 'pin', id: o.id, [sources[0]]: o[sources[0]] as string });
  });
  return out;
}

/** The interface line for its pins (in the system prompt, fixed from the start): what it can pin - never what to. */
export const PINS_SECTION = 'PINNED. To keep something before you, in any answer: "pins": [{"do": "pin", "id": "<lowercase_snake_case>", '
  + '"document": "<a document of yours>" | "message": "<the id of a notice you received>" | "text": "..."}, {"do": "unpin", "id": "..."}]. '
  + 'What you pin reaches you in the channel at the start of every round (a document in its latest version) and within a round when it changes; '
  + 'pinning the same id again replaces it. You cannot unpin what others pinned.';

/** Applies its pins to its channel, as `self` (SPEC-CANAL-MENSAJES §6): a document is a live value - its latest version when
    delivered, or that it is gone -, a notice only one that reached it, a text as it is. Answers the refusals, with why. */
export function applyPins(channel: Channel, ops: readonly PinOp[], documentOf: (id: string) => { readonly text: string; readonly versions: number } | undefined): string[] {
  const warnings: string[] = [];
  for (const op of ops) {
    let r: { id: string } | { refused: string };
    if (op.do === 'unpin') r = channel.publish('self', { kind: 'pinned', key: op.id, unpin: true });
    else if (op.document !== undefined) {
      const doc = op.document;
      r = channel.publish('self', { kind: 'pinned', key: op.id, body: () => {
        const d = documentOf(doc);
        return d ? { document: doc, version: d.versions, text: d.text } : { document: doc, absent: 'no document "' + doc + '" now' };
      } });
    } else if (op.message !== undefined) {
      const n = channel.notice(op.message);
      r = n ? channel.publish('self', { kind: 'pinned', key: op.id, body: { message: op.message, from: n.from, body: n.body } }) : { refused: 'no notice "' + op.message + '" reached you' };
    } else r = channel.publish('self', { kind: 'pinned', key: op.id, body: op.text });
    if ('refused' in r) warnings.push('pin "' + op.id + '": ' + r.refused);
  }
  return warnings;
}
