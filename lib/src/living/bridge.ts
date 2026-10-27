import { hashString, stableStringify } from '../core/hash.ts';
import { joinSegments, type LivingSession, type Message, type Outcome, type Receipt, type Segment } from './world.ts';

/* ============================================================================
 * THE BRIDGE between a living world and the assisted researcher's rounds (SPEC-ACONTECIMIENTOS-DEL-MUNDO §5.3, §8). The
 * researcher keeps its loop - investigation, proposal, checks, reflection - and its round counters; the session keeps the
 * world's clock and its members' messages. A window is not a round:
 *
 *   a query (view, table, measure, observe, its memory)   answered at once; advances nothing
 *   an act, a wait                                         taken into the step's batch; sealed when the step's requests are
 *                                                          all taken, applied once every member sealed (the barrier); what
 *                                                          came of it is that step's result, read with the next answer
 *   a request after an act in the same answer              not answered: its results did not exist yet
 *   an answer of queries only                              counted for the window: at its limit the batch is sealed empty
 *                                                          and it waits for the window, like the others
 *   a proposal, a round closed                             an empty batch: the window goes on
 *   a message, a share                                     published at once for the window in course; its recipients get it
 *                                                          once that window is committed, between their decisions
 *
 * Its batches carry the revision it decided on: one decided on a revision the world left without it (the window went on
 * when its time ran out) is late, refused, and it is told to look again.
 * ========================================================================== */

export interface BridgeHost<A> {
  readonly session: LivingSession<unknown, unknown>;
  /** The actor the researcher is in the session. */
  readonly actor: string;
  /** An act read as an intent, and as the interface writes it. */
  intent(act: A): { readonly kind: string; readonly params: Readonly<Record<string, unknown>> };
  asWritten(act: A): unknown;
  /** What the researcher is shown of a stretch it watched. */
  shown(segment: Segment<unknown>): Record<string, unknown>;
  /** Keeps a stretch as an episode of the researcher's, and answers its name: its own (`you`), the environment's, or one
      another member shared with it (`name` given, `by` its author). */
  store(segment: Segment<unknown>, round: number, by: string, answer?: (name: string) => Record<string, unknown>, name?: string): string;
  /** Material of its own it may share (§8): an episode of its own or one of the environment's, a document; or why not. */
  material(ref: { episode?: string; document?: string }): { readonly kind: 'episode'; readonly name: string; readonly segment: Segment<unknown> } | { readonly kind: 'document'; readonly id: string; readonly version: number; readonly text: string } | string;
  /** Whether a reference names material of its own (an episode, a point, a document): what a message may cite. */
  own(ref: string): boolean;
  /** Hands it messages between its decisions (its channel), and how many more wait. */
  deliver(messages: readonly Record<string, unknown>[], waiting: number): void;
  log(type: string, data?: Record<string, unknown>): void;
  say(text: string): void;
}

/** What an act or a wait is answered until its window is applied: replaced then, never shown as it is. */
interface Pending { readonly pending: true; readonly n: number }

/** The name, in a researcher's record, of an episode another member shared with it: its author and its own name, one
    name for each - never two authors under one ("Alice" and "alice", "a_b" and "a-b"). An author's id is written in the
    letters an episode's name allows, "-" escaping what they lack ("-c" a capital, "-u" an underscore, "-h" a hyphen), so it
    never holds "--": what follows the first "--" is the episode's own name. */
export const sharedName = (from: string, name: string): string => 'from-' + actorSlug(from) + '--' + name;

/** An actor's id in lowercase letters, digits and escapes only: one for each id, the same on a file system that does not
    tell capitals apart ("Alice" and "alice" are two names, never one file). */
export const actorSlug = (id: string): string =>
  [...id].map((c) => (/[a-z0-9]/.test(c) ? c : /[A-Z]/.test(c) ? '-c' + c.toLowerCase() : c === '_' ? '-u' : c === '-' ? '-h' : '-x' + c.charCodeAt(0).toString(36) + '-')).join('');

export class LivingBridge<A> {
  private readonly h: BridgeHost<A>;
  /** The step's batch, as asked: acts, or a wait. */
  private asked: ({ act: A } | { wait: number; wake: string[] })[] = [];
  /** Its own reports of a signal so far (their keys). */
  private reports = 0;
  private readonly placeholders: Pending[] = [];
  /** The round's acts left, as the session counts them: each act taken, and a wait, spends one. */
  private budget: { acts: number } | null = null;
  /** The revision its decision in course rests on: the one the world had when it was asked (`decide`), the whole answer long. */
  private basis: number;
  /** The last window it logged. */
  private logged: number;

  constructor(host: BridgeHost<A>) { this.h = host; this.basis = host.session.revision; this.logged = host.session.window; }

  /** A decision is asked of it now: whatever it answers rests on the world's revision now - a query within its answer
      changes nothing of that (§5.1). */
  decide(): void { this.basis = this.h.session.revision; }

  /** Whether an act or a wait was taken in the step in course: a world query after it is not answered. */
  get sealing(): boolean { return this.asked.length > 0; }

  /** Requests a world query must not be after an act in the same answer: why. */
  static readonly AFTER_ACT = 'not answered: it comes after an act or a wait in the same answer, whose results do not exist yet - ask it in your next answer';

  /** The requests of its own a living world answers: the world now, a wait, the members and their messages. */
  static accepts(q: Record<string, unknown>): boolean { return ['observe', 'wait', 'send', 'share', 'read', 'members', 'watch', 'progress', 'perturb'].some((k) => k in q); }

  /** Its round, as its run reaches it (what an operator's "round" trigger reads). */
  round(n: number): void { this.h.session.round(this.h.actor, n); }

  /** A watcher of its own (§7): registered, a new version of it, or stopped; or the list of them. */
  watcher(q: Record<string, unknown>): Record<string, unknown> {
    const s = this.h.session, actor = this.h.actor;
    const w = q.watch;
    if (w === 'list' || w === true) return { watch: 'list', watchers: s.watching(actor) };
    if (w && typeof w === 'object' && typeof (w as Record<string, unknown>).stop === 'string') {
      const id = String((w as Record<string, unknown>).stop);
      return s.unwatch(actor, id) ? { watch: 'stopped', id } : { watch: 'refused', reason: 'no watcher "' + id + '" of yours measuring' };
    }
    const r = s.watch(actor, w as never);
    this.h.log('watcher', { ...(w && typeof w === 'object' ? { id: (w as Record<string, unknown>).id } : {}), ...('version' in r ? { version: r.version } : { refused: r.refused }) });
    return 'version' in r ? { watch: 'registered', id: (w as { id: string }).id, version: r.version, measures_from_tick: s.tick } : { watch: 'refused', reason: r.refused };
  }

  /** A sample of a signal it reports itself (§10): self-reported, and said so wherever it counts. */
  progress(q: Record<string, unknown>, round: number): Record<string, unknown> {
    const o = q.progress && typeof q.progress === 'object' ? q.progress as Record<string, unknown> : null;
    if (!o || typeof o.signal !== 'string' || !(typeof o.value === 'number' || o.value === null)) return { progress: q.progress, error: '{"progress": {"signal": "<yours>", "value": <number> | null}}' };
    const why = this.h.session.sample(o.signal, 'r' + round + '.' + (++this.reports), o.value as number | null, { actor: this.h.actor });
    return why ? { progress: 'refused', reason: why } : { progress: 'recorded', signal: o.signal };
  }

  /** A program it may ask for, asked (§10: a requested surprise): what it does in the world is the world's. */
  perturb(q: Record<string, unknown>): Record<string, unknown> {
    const why = typeof q.perturb === 'string' ? this.h.session.ask(this.h.actor, q.perturb) : 'name the program: {"perturb": "<program>"}';
    this.h.log('perturbation_asked', { program: q.perturb, ...(why ? { refused: why } : {}) });
    return why ? { perturb: 'refused', reason: why } : { perturb: 'asked', program: q.perturb };
  }

  /** The world as it is now, for the researcher (a query). */
  observe(): Record<string, unknown> {
    const o = this.h.session.observe(this.h.actor);
    return { observe: true, tick: o.tick, revision: o.revision, plate: o.view, ...(this.h.session.ended ? { the_world_has_ended: true } : {}) };
  }

  /** The members of the session: who, of what kind, how they stand (§8: `channel.list`). */
  members(): Record<string, unknown> {
    return { members: this.h.session.members().filter((m) => m.id !== this.h.actor), you: this.h.actor };
  }

  /** A message to a member or to everyone (§8). Its references are of its own material, and never give access to it. */
  send(q: Record<string, unknown>): Record<string, unknown> {
    const o = q.send && typeof q.send === 'object' ? q.send as Record<string, unknown> : null;
    const to = o ? this.recipient(o.to) : null;
    if (!o || !to || typeof o.text !== 'string' || !o.text.trim()) return { send: q.send, error: 'a message is {"send": {"to": "<member>" | "global", "text": "...", "refs": [<your episodes or points>]}}' };
    const refs = Array.isArray(o.refs) ? o.refs.map(String) : [];
    const foreign = refs.filter((r) => !this.h.own(r));
    if (foreign.length) return { send: 'refused', reason: 'a message cites your own material only: ' + foreign.join(', ') + ' is not yours' };
    const r = this.h.session.send(this.h.actor, to, 'notice', { text: o.text, ...(refs.length ? { refs } : {}) });
    this.h.log('message_sent', { to, ...(r.accepted ? { id: r.id } : { refused: r.reason }), text: o.text, refs });
    return r.accepted ? { send: 'published', id: r.id, to: o.to, reaches_them: 'once the window in course is applied' } : { send: 'refused', reason: r.reason };
  }

  /** Shares material of its own (§8): an immutable copy, with its version and where it came from. */
  share(q: Record<string, unknown>): Record<string, unknown> {
    const o = q.share && typeof q.share === 'object' ? q.share as Record<string, unknown> : null;
    const to = o ? this.recipient(o.to) : null;
    if (!o || !to || (typeof o.episode !== 'string' && typeof o.document !== 'string'))
      return { share: q.share, error: 'a share is {"share": {"episode": "<yours>" | "document": "<yours>", "to": "<member>" | "global", "text": "..."}}' };
    const m = this.h.material({ ...(typeof o.episode === 'string' ? { episode: o.episode } : {}), ...(typeof o.document === 'string' ? { document: o.document } : {}) });
    if (typeof m === 'string') return { share: 'refused', reason: m };
    const content = m.kind === 'episode' ? { episode: m.name, segment: m.segment } : { document: m.id, version: m.version, text: m.text };
    const shared = { ...content, version_hash: hashString(stableStringify(content)) };
    const r = this.h.session.send(this.h.actor, to, 'share', { ...(typeof o.text === 'string' ? { text: o.text } : {}), shared });
    this.h.log('material_shared', { to, ...(r.accepted ? { id: r.id } : { refused: r.reason }), ...(m.kind === 'episode' ? { episode: m.name } : { document: m.id, version: m.version }), version_hash: shared.version_hash });
    return r.accepted ? { share: 'published', id: r.id, to: o.to, version_hash: shared.version_hash } : { share: 'refused', reason: r.reason };
  }

  /** Reads what waits in its inbox, or the global channel's history as far as it may (§8: `channel.read`). */
  read(q: Record<string, unknown>, round: number): Record<string, unknown> {
    const s = this.h.session, actor = this.h.actor;
    const what = q.read && typeof q.read === 'object' ? (q.read as Record<string, unknown>).channel : q.read;
    if (what === 'inbox') {
      const { messages, waiting } = s.inbox(actor);
      s.receive(actor, messages.map((m) => m.id), 'read');
      return { read: 'inbox', messages: messages.map((m) => this.received(m, round)), ...(waiting ? { still_waiting: waiting } : {}) };
    }
    if (what === 'global') {
      const after = q.read && typeof q.read === 'object' ? Number((q.read as Record<string, unknown>).after ?? 0) : 0;
      const h = s.history(actor, { after });
      return { read: 'global', messages: h.messages.map((m) => ({ id: m.id, seq: m.seq, from: m.from, window: m.window, ...(typeof m.body.text === 'string' ? { text: m.body.text } : {}), ...(m.kind === 'share' ? { shared: 'material (not given again: ask its author)' } : {}) })),
        ...(h.more ? { more: 'read again with "after": <the last seq>' } : {}) };
    }
    return { read: q.read, error: 'read "inbox" (what waits for you) or {"channel": "global", "after": <seq>} (its history)' };
  }

  /** An act taken into the step's batch. */
  act(act: A, budget: { acts: number }): unknown {
    if (budget.acts - this.asked.length <= 0) return { act: this.h.asWritten(act), error: 'no acts left this round' };
    this.budget = budget;
    this.asked.push({ act });
    return this.placeholder();
  }

  /** A wait taken into the step's batch. */
  wait(ticks: unknown, budget: { acts: number }, wake: unknown = []): unknown {
    if (budget.acts - this.asked.length <= 0) return { wait: ticks, error: 'no acts left this round' };
    this.budget = budget;
    this.asked.push({ wait: Number(ticks), wake: Array.isArray(wake) ? wake.map(String) : typeof wake === 'string' ? [wake] : [] });
    return this.placeholder();
  }

  /** The step's requests were all taken: its batch sealed and applied, each act's result in place of what it was answered;
      or, with queries only, the call counted - at its limit, it waits for the window like everyone. Then what reached it. */
  async endStep(round: number, results: readonly unknown[]): Promise<unknown[]> {
    const asked = this.asked;
    this.asked = [];
    const slots = new Map(this.placeholders.splice(0).map((p) => [p, p.n]));
    let out: unknown[];
    if (!asked.length) {
      if (this.h.session.call(this.h.actor)) await this.cross(round, 'calls');
      out = [...results];
    } else {
      const answers = await this.apply(round, asked);
      out = results.map((r) => (slots.has(r as Pending) ? answers[slots.get(r as Pending)!] : r));
    }
    this.pull(round);
    return out;
  }

  /** A round ended (a proposal, a closing, no proposal): an empty batch, and the window goes on. */
  async endRound(round: number, how: string): Promise<void> {
    const s = this.h.session;
    if (s.status !== 'running' || s.ended) return;
    if (s.actorState(this.h.actor) === 'ready') s.seal(this.h.actor, []);
    await this.cross(round, how);
    this.pull(round);
  }

  /** The world going on before the researcher's first round (§5.1): a window it does not decide in, its stretch an episode of
      the environment's. Null when the world does not advance. */
  async explore(): Promise<{ name: string; segment: Segment<unknown> } | null> {
    const s = this.h.session, actor = this.h.actor;
    s.take(actor);
    if (!s.wait(actor, s.clock.decision_interval).accepted) return null;
    const segment = await this.watch(0, 'exploration');
    this.pull(0);
    if (!segment) return null;
    const name = this.h.store(segment, 0, 'the environment');
    s.delivered(actor, 'w' + segment.window + '-' + segment.to, { episode: name, from: segment.from, to: segment.to, intents: [] });
    return { name, segment };
  }

  /** The researcher's run ended: it leaves the session (a session of its own is closed by its run instead). */
  retire(reason: string): void { this.h.session.retire(this.h.actor, reason); }

  private recipient(to: unknown): Message['to'] | null {
    if (to === 'global') return { channel: 'global' };
    return typeof to === 'string' && to.trim() ? { actor: to.trim() } : null;
  }

  private placeholder(): Pending {
    const p: Pending = { pending: true, n: this.asked.length - 1 };
    this.placeholders.push(p);
    return p;
  }

  /** Waits for the window it sealed; logs every window since it last looked, and takes the revision it reached. */
  private async cross(round: number, by: string): Promise<void> {
    const before = this.h.session.window;
    await this.h.session.commit(this.h.actor);
    this.catchUp(round, by, before + 1);
  }

  /** Waits for the window it sealed and, asleep, for every one until it wakes: the stretch it watched, one. */
  private async watch(round: number, by: string): Promise<Segment<unknown> | null> {
    const s = this.h.session, actor = this.h.actor;
    await this.cross(round, by);
    if (s.actorState(actor) === 'waiting') {
      await s.awake(actor);
      this.catchUp(round, by, 0);
    }
    const parts = s.take(actor);
    return parts.length ? joinSegments(parts) : null;
  }

  /** The windows applied since it last logged: `by` for the one it sealed (and those it slept through), the others as
      windows that went on while it decided. Its own intents' outcomes only. */
  private catchUp(round: number, by: string, sealed: number): void {
    const s = this.h.session;
    for (let n = this.logged + 1; n <= s.window; n++) {
      const w = s.windowRecord(n);
      const mine = (w?.outcomes ?? []).filter((o) => o.intent.startsWith(this.h.actor + ':'));
      this.h.log('world_window', { round, window: n, ...(w ? { from: w.from, to: w.to, revision: w.revision } : {}),
        by: n === sealed || by === 'wait' || by === 'exploration' ? by : 'went_on', outcomes: mine, ...(w?.timeouts.length ? { timeouts: w.timeouts } : {}) });
    }
    this.logged = s.window;
  }

  /** What reached it since it last looked: delivered between its decisions, each received once. */
  private pull(round: number): void {
    const s = this.h.session, actor = this.h.actor;
    const { messages, waiting } = s.inbox(actor);
    if (!messages.length) return;
    s.receive(actor, messages.map((m) => m.id), 'delivered');
    this.h.deliver(messages.map((m) => this.received(m, round)), waiting);
  }

  /** A message as its recipient is given it: its references in its author's names (they give no access), what was shared
      kept as an episode of the recipient's own, with its version and its author. */
  private received(m: Message, round: number): Record<string, unknown> {
    /* An instrument's reading, the operator's announcement: each with its own provenance, never another member's word. */
    if (m.kind === 'reading') return { message: m.id, from: m.from, window: m.window, reading: m.body };
    if (m.kind === 'announcement') return { message: m.id, from: 'operator', window: m.window, ...m.body };
    /* The operator's word: help, counted where it is received; its pin, kept before it under its key. */
    if (m.from === 'operator' && m.kind === 'pin') return { message: m.id, from: 'operator', pin: m.body.key, text: m.body.text };
    if (m.from === 'operator') return { message: m.id, from: 'operator', window: m.window, text: m.body.text, help: true };
    const body = m.body as { text?: string; refs?: string[]; shared?: Record<string, unknown> };
    const shared = body.shared;
    let kept: Record<string, unknown> | null = null;
    if (shared && typeof shared.episode === 'string') {
      const name = this.h.store(shared.segment as Segment<unknown>, round, 'actor:' + m.from, undefined, sharedName(m.from, shared.episode));
      kept = { episode: name, as_its_author_named_it: shared.episode, version_hash: shared.version_hash };
    } else if (shared) kept = { document: shared.document, version: shared.version, text: shared.text, version_hash: shared.version_hash };
    return { message: m.id, from: m.from, to: 'channel' in m.to ? 'global' : 'you', window: m.window, ...(body.text ? { text: body.text } : {}),
      ...(body.refs?.length ? { refs: body.refs.map((r) => m.from + ':' + r) } : {}), ...(kept ? { shared: kept } : {}) };
  }

  /** The batch: its acts sealed together (a wait alone), the window applied - as many as a wait lasts - and each answered. */
  private async apply(round: number, asked: ({ act: A } | { wait: number; wake: string[] })[]): Promise<unknown[]> {
    const s = this.h.session, actor = this.h.actor;
    const waits = asked.map((a, i) => ('wait' in a ? i : -1)).filter((i) => i >= 0);
    const acts = asked.map((a, i) => ('act' in a ? i : -1)).filter((i) => i >= 0);
    const answers: unknown[] = new Array(asked.length);
    /* A wait goes alone: with acts, or a second one, it is refused and the rest goes on. */
    let wait: number | null = null;
    for (const i of waits) {
      const ticks = (asked[i] as { wait: number }).wait;
      if (acts.length || wait !== null) answers[i] = { wait: ticks, accepted: false, reason: 'a wait goes alone in an answer: with no act and no other wait' };
      else wait = i;
    }
    s.take(actor);
    let receipts: Receipt[] = [];
    if (wait !== null) {
      const ticks = (asked[wait] as { wait: number }).wait;
      const r = s.wait(actor, ticks, this.basis, (asked[wait] as { wake: string[] }).wake);
      if (!r.accepted) { answers[wait] = { wait: ticks, accepted: false, reason: r.reason }; return this.finishEmpty(round, answers); }
    } else receipts = s.seal(actor, acts.map((i) => this.h.intent((asked[i] as { act: A }).act)), this.basis);
    acts.forEach((i, k) => { if (!receipts[k]?.accepted) answers[i] = { act: this.h.asWritten((asked[i] as { act: A }).act), accepted: false, reason: receipts[k]?.reason ?? 'not sealed' }; });
    const taken = acts.filter((_, k) => receipts[k]?.accepted);
    if (wait === null && !taken.length) return this.finishEmpty(round, answers);
    if (this.budget) this.budget.acts -= taken.length + (wait !== null ? 1 : 0);
    const segment = await this.watch(round, wait !== null ? 'wait' : 'acts');
    if (!segment) {
      /* Nothing applied (closed, ended meanwhile): said so, never an invented episode. */
      for (const i of [...taken, ...(wait !== null ? [wait] : [])]) answers[i] = { ...('act' in asked[i] ? { act: this.h.asWritten((asked[i] as { act: A }).act) } : { wait: (asked[i] as { wait: number }).wait }),
        accepted: true, applied: false, reason: 'the world did not advance: it is ' + s.status + (s.ended ? ', at its horizon' : '') };
      return answers;
    }
    const outcomes = new Map(s.windowRecord(segment.window)?.outcomes.map((o) => [o.intent, o]) ?? []);
    const ids = new Map(taken.map((i) => [i, receipts[acts.indexOf(i)]?.intent ?? '']));
    const describe = (name: string): Record<string, unknown> => ({ name, ticks: [segment.from, segment.to], revisions: segment.revisions, ...this.h.shown(segment) });
    const first = wait !== null ? wait : taken[0];
    const name = this.h.store(segment, round, 'you', (n) => {
      const a = asked[first];
      return 'act' in a ? { act: this.h.asWritten(a.act), accepted: true, ...this.outcomeOf(outcomes.get(ids.get(first)!)), ...describe(n) } : { wait: a.wait, accepted: true, ...describe(n) };
    });
    /* Woken before its time: said so, with what woke it (it reaches it in its channel). */
    if (wait !== null) answers[wait] = { wait: (asked[wait] as { wait: number }).wait, accepted: true, ...describe(name),
      ...(segment.to < segment.from + (asked[wait] as { wait: number }).wait && !s.ended ? { woken_at_tick: segment.to } : {}) };
    taken.forEach((i, k) => {
      const o = outcomes.get(ids.get(i)!);
      const act = this.h.asWritten((asked[i] as { act: A }).act);
      answers[i] = k === 0 ? { act, accepted: true, ...this.outcomeOf(o), ...describe(name) } : { act, accepted: true, ...this.outcomeOf(o), name, with: 'the same batch as the first act: its stretch is ' + name };
    });
    s.delivered(actor, 'w' + segment.window + '-' + segment.to, { episode: name, from: segment.from, to: segment.to, intents: segment.intents });
    return answers;
  }

  private outcomeOf(o: Outcome | undefined): Record<string, unknown> {
    return o ? { outcome: o.outcome, ...(o.reason ? { reason: o.reason } : {}), ...(o.completes_at !== undefined ? { done_at_tick: o.completes_at } : {}) } : { outcome: 'pending' };
  }

  /** Nothing of the batch was taken: nothing sealed - the answer counts as one of queries. */
  private async finishEmpty(round: number, answers: unknown[]): Promise<unknown[]> {
    if (this.h.session.call(this.h.actor)) await this.cross(round, 'calls');
    return answers;
  }
}
