import fs from 'node:fs';
import { hashString, stableStringify } from '../core/hash.ts';

/* ============================================================================
 * A LIVING WORLD (SPEC-ACONTECIMIENTOS-DEL-MUNDO): a world that exists and goes on during the investigation, one state
 * per session that every actor shares, apart from the episodic contract (Lab.episode, Lab.act) and never made of episodes
 * started afresh.
 *
 *   the adapter      its state, laws, actions and what each actor may perceive of it (§3); the policies of the actors
 *                    that are not researchers (§4)
 *   the session      the coordinator: the clock, the windows, the batches sealed by the actors, their order and conflicts,
 *                    the members and their messages, the journal written ahead of every transition (§5, §8, §14). It
 *                    orders and delivers; it never interprets
 *   the journal      every window prepared and committed, every message published and received, under keys of their own:
 *                    a run resumed derives them again and finds them in the record it continues - never twice
 *
 * A window: the actors decide on the same revision of the state, each seals one batch (intents, a wait, or nothing), and
 * the world advances its interval with the batches applied in an order fixed by the seed - never by who answered first.
 * What an actor reads, measures or writes of its own while it decides never advances the world (§5.3).
 * ========================================================================== */

/** What an actor asks the world to do: a kind of the adapter's actions with its parameters (§3). */
export interface Intent {
  readonly id: string;
  readonly actor: string;
  readonly kind: string;
  readonly params: Readonly<Record<string, unknown>>;
}

/** What became of an intent when its window was applied. `completes_at`: the tick its effect is over (an action that lasts). */
export interface Outcome {
  readonly intent: string;
  readonly outcome: 'applied' | 'conflict' | 'rejected';
  readonly reason?: string;
  readonly completes_at?: number;
}

/** An action of the world, as the actors are told of it. */
export interface LivingAction {
  readonly kind: string;
  readonly about: string;
  /** Ticks it lasts: its effect is complete at the end of its last one. */
  readonly duration: number;
  /** Given only to the members the manifest grants it (e.g. a competitor's), never by default. */
  readonly granted?: boolean;
}

/** A message between members of a session (§8): its origin and identity assigned by the session, never by its fields. */
export interface Message {
  readonly id: string;
  readonly session: string;
  readonly from: string;
  readonly to: { readonly actor: string } | { readonly channel: 'global' };
  readonly kind: 'notice' | 'share';
  readonly body: Readonly<Record<string, unknown>>;
  /** The window it was published in: delivered once that window is committed, never in the middle of a decision. */
  readonly window: number;
  readonly seq: number;
}

/** An actor that is not a researcher (§4): a fixed policy, a reactive adversary, a population. It decides from its own
    projection and its own inbox only - never another's notebook, objective or score - and keeps a state of its own (JSON),
    kept in the session's record. */
export interface PolicyActor<F> {
  readonly kind: 'policy' | 'adversary' | 'population';
  initial(seed: number): unknown;
  decide(o: { readonly view: F; readonly inbox: readonly Message[]; readonly window: number; readonly state: unknown }):
    { readonly intents: readonly { readonly kind: string; readonly params: Readonly<Record<string, unknown>> }[]; readonly state: unknown;
      readonly messages?: readonly { readonly to: Message['to']; readonly body: Readonly<Record<string, unknown>> }[] };
}

export interface LivingWorldAdapter<St, F> {
  /** The adapter and its version (e.g. "plates@1"). */
  readonly id: string;
  readonly actions: readonly LivingAction[];
  /** What it guarantees: replayed from the same seed and intents it is the same world; a realization of its own is possible. */
  readonly guarantees: { readonly replay: 'deterministic'; readonly fork: boolean };
  /** The policies its non-researcher actors may follow, by name (§4). */
  readonly policies?: Readonly<Record<string, (params: Readonly<Record<string, unknown>>) => PolicyActor<F>>>;
  /** The initial state of a realization. */
  create(config: Readonly<Record<string, unknown>>, seed: number): St;
  /** Why an intent cannot be taken in this state (an action it does not have, a parameter out of range, a precondition), or
      null. Asked when it is sealed and again just before it is applied: a precondition broken meanwhile - by an intent
      applied before it in the same window - is a conflict, without its effects. */
  validateIntent(state: St, actor: string, intent: Intent): string | null;
  /** An intent applied at the start of its window, after those before it in the window's order: its effect at once, or the
      start of an action that lasts. Asked only after `validateIntent` held on the same state. Pure. */
  apply(state: St, intent: Intent): { readonly state: St; readonly outcome: Outcome };
  /** One tick of its laws and its chance. Pure: the same state is the same next state. `occurred`: what happened, for the
      restricted record only (never shown to an actor). */
  advance(state: St): { readonly state: St; readonly occurred: readonly Record<string, unknown>[] };
  /** What `principal` may perceive of the state now: a projection, never the state itself. A query: it changes nothing. */
  observe(state: St, principal: string): F;
  /** The tick of a state. */
  tickOf(state: St): number;
  /** The actions in course (begun, not yet complete), with their intents. */
  pending(state: St): readonly { readonly intent: string; readonly actor: string; readonly kind: string; readonly completes_at: number }[];
  /** The state as plain JSON, and back: everything, its chance included. */
  snapshot(state: St): unknown;
  restore(snapshot: unknown): St;
}

/** The hash of a state, from its snapshot. */
export const stateHash = <St>(adapter: LivingWorldAdapter<St, unknown>, state: St): string => hashString(stableStringify(adapter.snapshot(state)));

/* --- The journal of a session (§14) ------------------------------------------------------------------------------------- */

/** An entry of the session's journal, under a key of its own (`w3.prepare`, `w3.commit`, `d3.researcher`...). `at` is the
    wall time it was written at: not part of what it is. */
export interface WorldEntry { readonly key: string; readonly [k: string]: unknown }

const sameEntry = (a: Record<string, unknown>, b: Record<string, unknown>): boolean => {
  const { at: _a, ...x } = a, { at: _b, ...y } = b;
  return stableStringify(x) === stableStringify(y);
};

const readEntries = (file: string | null | undefined): Map<string, Record<string, unknown>> => {
  const out = new Map<string, Record<string, unknown>>();
  if (!file || !fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (typeof e?.key === 'string' && !out.has(e.key)) out.set(e.key, e); } catch { /* a line cut by a crash: not an entry */ }
  }
  return out;
};

/** The session's journal, written ahead (§14): an entry is written once, under its key. A run resumed derives its entries
    again: one already in the record it continues (`from`) is compared and carried as it was, never written twice; one that
    differs is a divergence, said so; one beyond that record is new. */
export class WorldJournal {
  readonly file: string | null;
  private readonly written: Map<string, Record<string, unknown>>;
  private readonly before: Map<string, Record<string, unknown>>;
  /** Keys derived again and found in the record continued, and those found different. */
  readonly carried: string[] = [];
  readonly diverged: { key: string; was: unknown; now: unknown }[] = [];
  private readonly onDiverge: (d: { key: string; was: unknown; now: unknown }) => void;

  constructor(file: string | null, o: { from?: string | null; onDiverge?: (d: { key: string; was: unknown; now: unknown }) => void } = {}) {
    this.file = file;
    this.written = readEntries(file);
    this.before = o.from && o.from !== file ? readEntries(o.from) : new Map();
    this.onDiverge = o.onDiverge ?? (() => {});
  }

  /** Whether the record continued holds an entry under this key (a transition it prepared, a delivery it made). */
  recorded(key: string): Record<string, unknown> | null { return this.written.get(key) ?? this.before.get(key) ?? null; }

  /** Writes an entry once. Answers whether it is new (false: it was in the record, carried or already written). */
  write(entry: WorldEntry): boolean {
    const now = { ...entry, at: new Date().toISOString() };
    const existing = this.written.get(entry.key) ?? this.before.get(entry.key);
    if (existing) {
      if (!sameEntry(existing, now)) {
        const d = { key: entry.key, was: existing, now };
        this.diverged.push(d);
        this.onDiverge(d);
      }
      if (!this.written.has(entry.key)) { this.append(existing); this.carried.push(entry.key); }
      return false;
    }
    this.append(now);
    return true;
  }

  /** Every entry written, in order. */
  entries(): Record<string, unknown>[] { return [...this.written.values()]; }

  private append(e: Record<string, unknown>): void {
    this.written.set(String(e.key), e);
    if (this.file) fs.appendFileSync(this.file, JSON.stringify(e) + '\n');
  }
}

/* --- The session: the coordinator (§2, §4, §5, §8) ---------------------------------------------------------------------- */

export type SessionState = 'created' | 'running' | 'paused' | 'closing' | 'completed' | 'failed';
export type ActorState = 'ready' | 'thinking' | 'waiting' | 'exhausted' | 'stopped' | 'failed';
export type ActorKind = 'researcher' | 'policy' | 'adversary' | 'population';

export interface SessionClock {
  /** Ticks per window: how often the actors decide. */
  readonly decision_interval: number;
  /** The tick the session ends at: no transition beyond it. */
  readonly horizon: number;
}

export interface SessionLimits {
  /** Decision calls an actor may make in one window before its batch is sealed empty for it (§5.3). */
  readonly calls_per_window: number;
  /** Intents in one batch. */
  readonly intents_per_window: number;
  /** Members at once (§4, §13): an actor that would join beyond it is refused. Default: those declared at the start. */
  readonly actors?: number;
  /** Messages a member may publish in one window (§8). Absent: nobody may publish - nothing is unlimited by default. */
  readonly messages_per_window?: number;
  /** The size of one message's body, in characters of its JSON. Required with `messages_per_window`. */
  readonly message_chars?: number;
  /** Messages delivered with one decision; the rest wait, said so, and are read by cursor. Default 8. */
  readonly delivery_per_decision?: number;
  /** Wall time a window waits for its researchers once one has sealed (ms): the missing ones are sealed empty (a no-op),
      recorded as timeouts. Absent: it waits for every one. */
  readonly window_ms?: number;
}

/** A member of the session, as the manifest declares it (§4, §16). */
export interface ActorDecl {
  readonly id: string;
  readonly kind: ActorKind;
  /** The actions it may take (its physical permissions). Default: the world's actions that are not granted explicitly only. */
  readonly actions?: readonly string[];
  /** A non-researcher's policy, by its name among the adapter's, and its parameters. */
  readonly policy?: string;
  readonly params?: Readonly<Record<string, unknown>>;
  /** Whether it may read the global channel's history from before it joined (§8). Default true. */
  readonly history?: boolean;
}

/** A stretch of the world as one actor perceived it (§5.3): the projection at every tick of the interval, its session,
    its revisions, and the intents of that actor's batch. Immutable; the laboratory exposes it as an episode. */
export interface Segment<F> {
  readonly session: string;
  readonly actor: string;
  readonly window: number;
  /** Ticks from..to: `frames[0]` is the projection at `from` (before the window), the last at `to`. */
  readonly from: number;
  readonly to: number;
  readonly revisions: readonly [number, number];
  readonly frames: readonly F[];
  readonly intents: readonly string[];
}

/** Consecutive stretches of one actor (a wait across several windows) as one: from the first's start to the last's end. */
export function joinSegments<F>(parts: readonly Segment<F>[]): Segment<F> {
  const [first] = parts, last = parts[parts.length - 1];
  return { session: first.session, actor: first.actor, window: first.window, from: first.from, to: last.to, revisions: [first.revisions[0], last.revisions[1]],
    frames: parts.flatMap((p, i) => (i === 0 ? p.frames : p.frames.slice(1))), intents: parts.flatMap((p) => p.intents) };
}

/** What an intent is answered when it is sealed: accepted for the window (not yet done), or refused, and why. */
export interface Receipt { readonly intent: string; readonly kind: string; readonly accepted: boolean; readonly reason?: string }

/** A window as it was applied: its interval and revisions, what became of each intent, each watcher's stretch, and the
    researchers that did not seal in time. */
export interface WindowRecord<F> {
  readonly window: number;
  readonly from: number;
  readonly to: number;
  readonly revision: number;
  readonly outcomes: readonly Outcome[];
  readonly segments: ReadonlyMap<string, Segment<F>>;
  readonly timeouts: readonly string[];
}

interface ActorSlot {
  readonly decl: ActorDecl;
  readonly actions: ReadonlySet<string>;
  readonly policy: PolicyActor<unknown> | null;
  policyState: unknown;
  state: ActorState;
  /** The batch sealed for the window in course; null: not sealed yet. */
  batch: Intent[] | null;
  /** Whether it watches the window it sealed (it acted or waits): it is given its stretch. */
  watches: boolean;
  /** Asleep until this tick (a `wait`). */
  until: number | null;
  calls: number;
  /** Its intents so far (their ids number them). */
  intents: number;
  /** Messages it published in the window in course. */
  sent: number;
  /** It did not seal in time: the window went on without it. */
  timedOut?: boolean;
  /** The window it joined after (0: from the start). */
  readonly joined: number;
  /** The stretches it watched, not yet taken. */
  watched: Segment<unknown>[];
  /** Ids of the messages it received. */
  readonly received: Set<string>;
  readonly use: { intents: number; applied: number; conflicts: number; calls: number; sent: number; received: number; timeouts: number };
}

export interface LivingSessionOptions<St, F> {
  readonly adapter: LivingWorldAdapter<St, F>;
  /** The session's id (e.g. "world:plates-s1"). */
  readonly id: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly seed: number;
  /** Its members: a name alone is a researcher with the world's default actions. */
  readonly actors: readonly (string | ActorDecl)[];
  readonly clock: SessionClock;
  readonly limits: SessionLimits;
  readonly journal: WorldJournal;
}

/** A small generator over a state of its own (mulberry32 by steps): its state is a number, kept in a snapshot. */
export function nextRandom(state: number): [number, number] {
  const a = (state + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, a];
}

const DECIDING: readonly ActorState[] = ['ready', 'thinking', 'waiting'];
const refuse = (asked: readonly { kind: string }[], reason: string): Receipt[] => asked.map((a) => ({ intent: '', kind: a.kind, accepted: false, reason }));

/** The coordinator of a living world: one authoritative state, a clock, the windows, the members and their messages. */
export class LivingSession<St, F> {
  readonly adapter: LivingWorldAdapter<St, F>;
  readonly id: string;
  readonly clock: SessionClock;
  readonly limits: SessionLimits;
  readonly journal: WorldJournal;
  status: SessionState = 'created';
  /** The current state's revision: one more per window committed. */
  revision = 0;
  /** Windows committed. */
  window = 0;
  private state: St;
  private readonly seed: number;
  private readonly actors = new Map<string, ActorSlot>();
  /* Messages: `seq` 0 until their window is committed, when the window's publications are numbered in an order of their
     own - by author, then each author's own order - never by who published first. */
  private readonly messages: (Omit<Message, 'seq'> & { seq: number; readonly recipients: readonly string[]; readonly k: number })[] = [];
  private seq = 0;
  /** Who waits for the next window to be applied. */
  private waiters: ((w: WindowRecord<F> | null) => void)[] = [];
  private readonly wakers = new Map<string, (() => void)[]>();
  private timer: { window: number; handle: ReturnType<typeof setTimeout> } | null = null;
  /** The latest windows applied, by number (a member that slept or decided through several reads them here). */
  private readonly records = new Map<number, WindowRecord<F>>();
  /** Counters for the run's record (§13): each consumption once - a global message once, its deliveries per receiver. */
  readonly use = { windows: 0, ticks: 0, intents: 0, applied: 0, conflicts: 0, rejected: 0, calls: 0, empty_batches: 0, messages: 0, deliveries: 0, history_reads: 0, timeouts: 0, late: 0 };

  constructor(o: LivingSessionOptions<St, F>) {
    this.adapter = o.adapter; this.id = o.id; this.clock = o.clock; this.limits = o.limits; this.journal = o.journal; this.seed = o.seed;
    if (!(o.clock.decision_interval >= 1) || !(o.clock.horizon >= 1)) throw new Error('a living world needs a decision interval and a horizon of at least one tick');
    if (!(o.limits.calls_per_window >= 1) || !(o.limits.intents_per_window >= 1)) throw new Error('a living world needs limits of at least one call and one intent per window');
    if (o.limits.messages_per_window !== undefined && !(o.limits.message_chars! >= 1)) throw new Error('messages need a limit of their size (message_chars)');
    const decls = o.actors.map((a): ActorDecl => (typeof a === 'string' ? { id: a, kind: 'researcher' } : a));
    if (new Set(decls.map((d) => d.id)).size !== decls.length) throw new Error('two members of the session with the same id');
    if (o.limits.actors !== undefined && decls.length > o.limits.actors) throw new Error('more members (' + decls.length + ') than the session allows (' + o.limits.actors + ')');
    this.state = o.adapter.create(o.config, o.seed);
    for (const d of decls) this.actors.set(d.id, this.slotOf(d, 0));
    this.journal.write({ key: 'manifest', session: o.id, adapter: o.adapter.id, seed: o.seed, config: o.config, clock: o.clock, limits: o.limits,
      actors: decls.map((d) => ({ ...d, actions: [...this.actors.get(d.id)!.actions] })), actions: o.adapter.actions, guarantees: o.adapter.guarantees, state: stateHash(o.adapter, this.state) });
    this.status = 'running';
    this.sealPolicies();
  }

  get tick(): number { return this.adapter.tickOf(this.state); }
  /** Whether the horizon is reached: nothing advances any more. */
  get ended(): boolean { return this.tick >= this.clock.horizon; }
  actorState(actor: string): ActorState { return this.slot(actor).state; }
  /** The members: who they are, of what kind, how they stand (public within the session). */
  members(): { id: string; kind: ActorKind; state: ActorState }[] { return [...this.actors.values()].map((s) => ({ id: s.decl.id, kind: s.decl.kind, state: s.state })); }

  /** What an actor perceives now, at the current revision (§5.3: a query, it advances nothing). */
  observe(actor: string): { readonly session: string; readonly tick: number; readonly revision: number; readonly view: F } {
    this.slot(actor);
    return { session: this.id, tick: this.tick, revision: this.revision, view: this.adapter.observe(this.state, actor) };
  }

  /** A decision call of an actor's (§5.3): counted for its window. True when it reached its limit: its batch is sealed empty
      for it, and the window may go on without it. */
  call(actor: string): boolean {
    const s = this.slot(actor);
    s.calls++; s.use.calls++; this.use.calls++;
    if (s.batch === null && s.calls >= this.limits.calls_per_window) { this.seal(actor, []); return true; }
    return false;
  }

  /** Seals an actor's batch for the window in course: each intent checked now and given its id, the refused left out.
      `basis`: the revision it decided on - a batch decided on a revision already passed is late, refused whole (§5.1). Its
      batch is one; a second one in the same window is refused whole. Nothing of it taken: nothing sealed. */
  seal(actor: string, asked: readonly { readonly kind: string; readonly params: Readonly<Record<string, unknown>> }[], basis?: number): Receipt[] {
    const s = this.slot(actor);
    if (this.status !== 'running') return refuse(asked, 'the world is ' + this.status);
    if (!DECIDING.includes(s.state)) return refuse(asked, 'you are ' + s.state + ' in this world');
    if (s.batch !== null) return refuse(asked, 'your batch for this window is already sealed');
    if (this.ended && asked.length) return refuse(asked, 'the world has reached its horizon (tick ' + this.clock.horizon + '): it does not advance any more');
    if (basis !== undefined && basis < this.revision && asked.length) {
      this.use.late++;
      return refuse(asked, 'late: you decided on revision ' + basis + ' and the world went on to revision ' + this.revision + ' without you - look at it again');
    }
    if (asked.length > this.limits.intents_per_window) return refuse(asked, 'at most ' + this.limits.intents_per_window + ' intents in one window');
    const batch: Intent[] = [];
    const receipts = asked.map((a) => {
      if (!s.actions.has(a.kind)) return { intent: '', kind: a.kind, accepted: false, reason: 'you may not "' + a.kind + '" in this world (yours: ' + [...s.actions].join(', ') + ')' };
      const intent: Intent = { id: actor + ':' + (s.intents + 1), actor, kind: a.kind, params: a.params };
      const why = this.adapter.validateIntent(this.state, actor, intent);
      if (why) return { intent: '', kind: a.kind, accepted: false, reason: why };
      s.intents++;
      batch.push(intent);
      return { intent: intent.id, kind: a.kind, accepted: true };
    });
    if (asked.length && !batch.length) return receipts;
    s.batch = batch;
    s.watches = batch.length > 0;
    if (!batch.length) this.use.empty_batches++;
    this.use.intents += batch.length; s.use.intents += batch.length;
    this.arm();
    return receipts;
  }

  /** `wait(ticks)` (§5.1): seals an empty batch and sleeps until then; it watches what happens meanwhile. One action when
      asked, never one per tick. */
  wait(actor: string, ticks: number, basis?: number): Receipt {
    const s = this.slot(actor);
    const n = Math.floor(ticks);
    if (!(n >= 1)) return { intent: '', kind: 'wait', accepted: false, reason: 'wait asks for a whole number of ticks, at least 1' };
    if (this.status !== 'running') return { intent: '', kind: 'wait', accepted: false, reason: 'the world is ' + this.status };
    if (this.ended) return { intent: '', kind: 'wait', accepted: false, reason: 'the world has reached its horizon (tick ' + this.clock.horizon + '): it does not advance any more' };
    if (s.batch !== null) return { intent: '', kind: 'wait', accepted: false, reason: 'your batch for this window is already sealed' };
    if (basis !== undefined && basis < this.revision) { this.use.late++; return { intent: '', kind: 'wait', accepted: false, reason: 'late: you decided on revision ' + basis + ' and the world went on to revision ' + this.revision + ' without you - look at it again' }; }
    s.batch = [];
    s.watches = true;
    s.until = Math.min(this.clock.horizon, this.tick + n);
    s.state = 'waiting';
    this.arm();
    return { intent: actor + ':wait@' + this.tick, kind: 'wait', accepted: true };
  }

  /** Whether the window can be applied: a researcher still decides, and every member that decides sealed its batch or sleeps. */
  ready(): boolean {
    if (this.status !== 'running' || this.ended) return false;
    const deciding = [...this.actors.values()].filter((s) => DECIDING.includes(s.state));
    return deciding.some((s) => s.decl.kind === 'researcher') && deciding.every((s) => s.batch !== null || (s.until !== null && s.until > this.tick));
  }

  /** Waits for the next window to be applied, after the batches sealed so far; its record, or null when the world cannot go
      on (it ended, it was closed). Applying it never depends on who asked first. */
  commit(_actor: string): Promise<WindowRecord<F> | null> {
    if (this.status === 'completed' || this.status === 'closing' || this.ended) return Promise.resolve(null);
    const p = new Promise<WindowRecord<F> | null>((resolve) => this.waiters.push(resolve));
    this.settle();
    return p;
  }

  /** Waits until a sleeping actor wakes (at once when it does not sleep), or the world can go on no more. */
  awake(actor: string): Promise<void> {
    const s = this.slot(actor);
    if (s.state !== 'waiting' || this.status === 'completed' || this.ended) return Promise.resolve();
    const p = new Promise<void>((resolve) => this.wakers.set(actor, [...(this.wakers.get(actor) ?? []), resolve]));
    this.settle();
    return p;
  }

  /** A window applied lately, by its number (the latest 256). */
  windowRecord(n: number): WindowRecord<F> | null { return this.records.get(n) ?? null; }

  /** The stretches an actor watched since it last took them. */
  take(actor: string): Segment<F>[] { const s = this.slot(actor); const out = s.watched as Segment<F>[]; s.watched = []; return out; }

  /** Applies every window that can be applied now, one after the other; arms the wait for those that did not seal. */
  settle(): void {
    while (this.ready()) this.runWindow();
    this.arm();
  }

  /** Applies the window in course (§5.1): written ahead, the batches in the order of the window - each intent checked again
      on the state the ones before it left -, the interval ticked, its stretch given to each actor that watches it,
      committed. Null when it cannot be applied now (not ready, paused, ended). */
  runWindow(): WindowRecord<F> | null {
    if (!this.ready()) return null;
    const window = this.window + 1;
    const from = this.tick;
    /* The interval: one decision interval, cut short where a sleeper wakes and at the horizon. */
    const wakes = [...this.actors.values()].filter((s) => s.until !== null && s.until > from).map((s) => s.until!);
    const to = Math.min(this.clock.horizon, from + this.clock.decision_interval, ...wakes);
    const timeouts = [...this.actors.values()].filter((s) => s.timedOut).map((s) => s.decl.id);
    /* Rotating priority over an order fixed by the seed (§5.1): the first to apply changes with the window. */
    const order = this.order(window);
    const batches = order.map((a) => ({ actor: a, intents: this.actors.get(a)!.batch ?? [] }));
    const policies = Object.fromEntries([...this.actors.values()].filter((s) => s.policy).map((s) => [s.decl.id, hashString(stableStringify(s.policyState))]));
    this.journal.write({ key: 'w' + window + '.prepare', window, from, to, revision: this.revision, state: stateHash(this.adapter, this.state),
      order, batches: batches.map((b) => ({ actor: b.actor, intents: b.intents.map((i) => ({ id: i.id, kind: i.kind, params: i.params })) })),
      ...(Object.keys(policies).length ? { policies } : {}), ...(timeouts.length ? { timeouts } : {}) });
    const watching = [...this.actors.entries()].filter(([, s]) => s.watches).map(([a]) => a);
    const frames = new Map<string, F[]>(watching.map((a) => [a, [this.adapter.observe(this.state, a)]]));
    const outcomes: Outcome[] = [];
    for (const b of batches) for (const i of b.intents) {
      const why = this.adapter.validateIntent(this.state, i.actor, i);
      if (why) { outcomes.push({ intent: i.id, outcome: 'conflict', reason: why }); continue; }
      const r = this.adapter.apply(this.state, i);
      this.state = r.state;
      outcomes.push(r.outcome);
    }
    const occurred: Record<string, unknown>[] = [];
    for (let t = from; t < to; t++) {
      const next = this.adapter.advance(this.state);
      this.state = next.state;
      occurred.push(...next.occurred.map((o) => ({ tick: t, ...o })));
      for (const [a, f] of frames) f.push(this.adapter.observe(this.state, a));
    }
    this.revision++;
    this.window = window;
    this.use.windows++; this.use.ticks += to - from;
    /* The window's publications, numbered now: by author, then each author's own order. */
    const published = this.messages.filter((m) => m.window === window).sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.k - b.k));
    for (const m of published) m.seq = ++this.seq;
    for (const o of outcomes) {
      this.use[o.outcome === 'applied' ? 'applied' : o.outcome === 'conflict' ? 'conflicts' : 'rejected']++;
      const s = this.actors.get(o.intent.split(':')[0]);
      if (s && o.outcome === 'applied') s.use.applied++; else if (s && o.outcome === 'conflict') s.use.conflicts++;
    }
    this.journal.write({ key: 'w' + window + '.commit', window, from, to, revision: this.revision, state: stateHash(this.adapter, this.state), outcomes, occurred,
      pending: this.adapter.pending(this.state), ...(published.length ? { messages: published.map((m) => m.id) } : {}) });
    const segments = new Map<string, Segment<F>>();
    for (const [a, f] of frames) {
      const mine = batches.find((b) => b.actor === a)?.intents.map((i) => i.id) ?? [];
      const seg: Segment<F> = { session: this.id, actor: a, window, from, to, revisions: [this.revision - 1, this.revision], frames: f, intents: mine };
      segments.set(a, seg);
      this.actors.get(a)!.watched.push(seg as Segment<unknown>);
    }
    /* A new window: every batch open again; a sleeper whose time came wakes. */
    const woke: string[] = [];
    for (const s of this.actors.values()) {
      s.batch = null; s.calls = 0; s.sent = 0;
      delete s.timedOut;
      if (s.until !== null && s.until <= this.tick) { s.until = null; if (s.state === 'waiting') { s.state = 'ready'; woke.push(s.decl.id); } }
      s.watches = s.until !== null;
      if (s.until !== null || !DECIDING.includes(s.state)) s.batch = [];
    }
    if (this.timer) { clearTimeout(this.timer.handle); this.timer = null; }
    const record: WindowRecord<F> = { window, from, to, revision: this.revision, outcomes, segments, timeouts };
    this.records.set(window, record);
    this.records.delete(window - 256);
    this.sealPolicies();
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w(record);
    for (const a of woke) { for (const r of this.wakers.get(a) ?? []) r(); this.wakers.delete(a); }
    if (this.ended) this.release();
    return record;
  }

  /* --- Members (§4, §13) ------------------------------------------------------------------------------------------------ */

  /** A member joins after the window in course, within the limit of members. It is given nothing of the global channel's
      history: what it may read of it, it reads (§8). */
  join(decl: ActorDecl): { accepted: true } | { accepted: false; reason: string } {
    if (this.actors.has(decl.id)) return { accepted: false, reason: 'a member "' + decl.id + '" is in the session already' };
    if (this.status !== 'running') return { accepted: false, reason: 'the world is ' + this.status };
    const active = [...this.actors.values()].filter((s) => s.state !== 'stopped').length;
    const limit = this.limits.actors ?? this.actors.size;
    if (active + 1 > limit) return { accepted: false, reason: 'the session holds at most ' + limit + ' members at once' };
    let slot: ActorSlot;
    try { slot = this.slotOf(decl, this.window); } catch (e) { return { accepted: false, reason: String((e as Error).message ?? e) }; }
    this.actors.set(decl.id, slot);
    this.journal.write({ key: 'join.' + decl.id, ...decl, actions: [...slot.actions], window: this.window, tick: this.tick });
    this.sealPolicies();
    this.settle();
    return { accepted: true };
  }

  /** A member leaves (§4): it decides no more; what it began goes on as the world's laws say - a batch it already sealed is
      applied with its window: it was decided -, and nothing of its history or of what it published is taken away. */
  retire(actor: string, reason: string): void {
    const s = this.slot(actor);
    if (s.state === 'stopped') return;
    s.state = 'stopped'; s.batch = s.batch ?? []; s.until = null;
    this.journal.write({ key: 'retire.' + actor, reason, window: this.window, tick: this.tick, pending: this.adapter.pending(this.state).filter((p) => p.actor === actor) });
    for (const r of this.wakers.get(actor) ?? []) r();
    this.wakers.delete(actor);
    this.settle();
  }

  /** An actor that can decide no more (its budget spent): it stops deciding; what it began goes on as the world's laws say. */
  exhaust(actor: string): void { const s = this.slot(actor); s.state = 'exhausted'; s.batch = s.batch ?? []; s.until = null; this.settle(); }

  /* --- Messages (§8) ------------------------------------------------------------------------------------------------------ */

  /** Publishes a message from a member: to one member, or to the global channel. Its origin, id, window and order are the
      session's. Accepted means published - never read, never agreed. */
  send(from: string, to: Message['to'], kind: Message['kind'], body: Readonly<Record<string, unknown>>): { accepted: true; id: string } | { accepted: false; reason: string } {
    const s = this.slot(from);
    const no = (reason: string) => ({ accepted: false as const, reason });
    if (this.limits.messages_per_window === undefined) return no('nobody may publish in this session');
    if (this.status !== 'running') return no('the world is ' + this.status);
    if (s.state === 'stopped') return no('you left the session');
    if (s.sent >= this.limits.messages_per_window) return no('at most ' + this.limits.messages_per_window + ' messages of yours in one window');
    /* Its words count, not the material it shares (a copy of its own, kept whole). */
    const size = JSON.stringify({ ...body, shared: undefined }).length;
    if (size > this.limits.message_chars!) return no('a message is at most ' + this.limits.message_chars + ' characters (this one: ' + size + '): nothing of it was cut, nothing was sent');
    let recipients: string[];
    if ('actor' in to) {
      const t = this.actors.get(to.actor);
      if (!t || to.actor === from) return no('no member "' + to.actor + '" to write to (members: ' + [...this.actors.keys()].filter((k) => k !== from).join(', ') + ')');
      if (t.state === 'stopped') return no(to.actor + ' left the session');
      recipients = [to.actor];
    } else if (to.channel === 'global') recipients = [...this.actors.values()].filter((x) => x.decl.id !== from && x.state !== 'stopped').map((x) => x.decl.id);
    else return no('a message goes to {"actor": "<id>"} or {"channel": "global"}');
    s.sent++; s.use.sent++; this.use.messages++;
    const window = this.window + 1;
    const m = { id: 'message:w' + window + '.' + from + '.' + s.sent, session: this.id, from, to, kind, body, window, seq: 0, recipients, k: s.sent };
    this.messages.push(m);
    const { seq: _q, k: _k, ...published } = m;
    this.journal.write({ key: 'm.' + m.id, ...published });
    return { accepted: true, id: m.id };
  }

  /** What an actor's inbox holds for it now: the messages to it published in a window already committed, not received yet,
      in their order - at most `delivery_per_decision`, and how many more wait. */
  inbox(actor: string): { messages: Message[]; waiting: number } {
    const s = this.slot(actor);
    const due = this.messages.filter((m) => m.recipients.includes(actor) && m.window <= this.window && !s.received.has(m.id)).sort((a, b) => a.seq - b.seq);
    const n = this.limits.delivery_per_decision ?? 8;
    return { messages: due.slice(0, n).map(({ recipients: _r, k: _k, ...m }) => m), waiting: Math.max(0, due.length - n) };
  }

  /** Messages received by an actor (delivered with a decision, or read by it): its own receipt, once each. */
  receive(actor: string, ids: readonly string[], how: 'delivered' | 'read'): void {
    const s = this.slot(actor);
    for (const id of ids) {
      if (s.received.has(id)) continue;
      s.received.add(id); s.use.received++; this.use.deliveries++;
      this.journal.write({ key: 'r.' + actor + '.' + id, actor, message: id, how, window: this.window });
    }
  }

  /** The global channel's history, as far as an actor may read it: from its joining on, or all of it with the permission. */
  history(actor: string, o: { after?: number; limit?: number } = {}): { messages: Message[]; more: boolean } {
    const s = this.slot(actor);
    const since = s.decl.history === false ? s.joined : 0;
    const all = this.messages.filter((m) => 'channel' in m.to && m.window <= this.window && m.window > since && m.seq > (o.after ?? 0)).sort((a, b) => a.seq - b.seq);
    const n = Math.min(20, Math.max(1, o.limit ?? 20));
    this.use.history_reads++;
    return { messages: all.slice(0, n).map(({ recipients: _r, k: _k, ...m }) => m), more: all.length > n };
  }

  /** Records a delivery of a stretch to an actor (its own receipt), once under its key. Answers whether it is new. */
  delivered(actor: string, key: string, what: Record<string, unknown>): boolean {
    return this.journal.write({ key: 'd.' + actor + '.' + key, actor, window: this.window, revision: this.revision, ...what });
  }

  /* --- The session's course (§13) ---------------------------------------------------------------------------------------- */

  /** Pauses the clock (§13): no window is applied until it is resumed. */
  pause(): void { if (this.status === 'running') { this.status = 'paused'; this.journal.write({ key: 'pause@w' + this.window + '.' + (++this.pauses), window: this.window, tick: this.tick }); } }
  resume(): void { if (this.status === 'paused') { this.status = 'running'; this.journal.write({ key: 'resume@w' + this.window + '.' + this.pauses, window: this.window, tick: this.tick }); this.settle(); } }
  private pauses = 0;

  /** Closes the session (§13): no more windows; what was in course is kept, as pending, with the final state; whoever waited
      is told the world goes on no more. */
  close(reason: string): Record<string, unknown> {
    if (this.status === 'completed') return this.summary();
    this.status = 'closing';
    const pending = this.adapter.pending(this.state);
    /* Under where it closed: a continuation that goes further closes elsewhere, never as the run it continues closed. */
    this.journal.write({ key: 'close@w' + this.window + '.t' + this.tick, reason, window: this.window, tick: this.tick, revision: this.revision, state: stateHash(this.adapter, this.state), pending,
      snapshot: this.adapter.snapshot(this.state), policies: Object.fromEntries([...this.actors.values()].filter((s) => s.policy).map((s) => [s.decl.id, s.policyState])), use: this.use });
    this.status = 'completed';
    this.release();
    return { ...this.summary(), closed: reason, pending };
  }

  /** What the run's record keeps of the session (§13): its counters, each member's, and where it is. */
  summary(): Record<string, unknown> {
    return { session: this.id, adapter: this.adapter.id, status: this.status, tick: this.tick, horizon: this.clock.horizon, window: this.window, revision: this.revision,
      state: stateHash(this.adapter, this.state), ...this.use, members: Object.fromEntries([...this.actors.values()].map((s) => [s.decl.id, { kind: s.decl.kind, state: s.state, ...s.use }])),
      ...(this.journal.diverged.length ? { diverged: this.journal.diverged.map((d) => d.key) } : {}) };
  }

  /** The state, for the operator (the restricted record): never an actor's. */
  auditState(): St { return this.state; }

  private release(): void {
    if (this.timer) { clearTimeout(this.timer.handle); this.timer = null; }
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w(null);
    for (const rs of this.wakers.values()) for (const r of rs) r();
    this.wakers.clear();
  }

  /** The window waits for its researchers only so long (`window_ms`) once one of them sealed: then the missing ones are
      sealed empty, a no-op recorded as their timeout, and the window is applied without them (§5.1). */
  private arm(): void {
    const ms = this.limits.window_ms;
    if (!ms || this.status !== 'running' || this.ended || this.timer?.window === this.window) return;
    const researchers = [...this.actors.values()].filter((s) => s.decl.kind === 'researcher' && DECIDING.includes(s.state));
    /* One sealed - acting, yielding or asleep: the others have so long. */
    const sealed = researchers.some((s) => s.batch !== null);
    const missing = researchers.filter((s) => s.batch === null);
    if (!sealed || !missing.length) return;
    const window = this.window;
    const handle = setTimeout(() => {
      this.timer = null;
      if (this.window !== window || this.status !== 'running') return;
      const late = [...this.actors.values()].filter((s) => s.decl.kind === 'researcher' && DECIDING.includes(s.state) && s.batch === null);
      for (const s of late) { s.batch = []; s.timedOut = true; s.use.timeouts++; this.use.timeouts++; }
      this.journal.write({ key: 'w' + (window + 1) + '.timeout', window: window + 1, after_ms: ms, actors: late.map((s) => s.decl.id) });
      this.settle();
    }, ms);
    this.timer = { window, handle };
  }

  /** The non-researchers decide at the opening of each window, on the same revision as everyone, from their own view and
      inbox; their batch sealed at once (empty when nothing of it holds). */
  private sealPolicies(): void {
    if (this.status !== 'running' || this.ended) return;
    for (const s of this.actors.values()) {
      if (!s.policy || s.batch !== null || !DECIDING.includes(s.state)) continue;
      const { messages } = this.inbox(s.decl.id);
      this.receive(s.decl.id, messages.map((m) => m.id), 'read');
      const d = s.policy.decide({ view: this.adapter.observe(this.state, s.decl.id) as never, inbox: messages, window: this.window + 1, state: s.policyState });
      s.policyState = d.state;
      for (const m of d.messages ?? []) this.send(s.decl.id, m.to, 'notice', m.body);
      this.seal(s.decl.id, d.intents.slice(0, this.limits.intents_per_window));
      if (s.batch === null) s.batch = [];
    }
  }

  private slotOf(d: ActorDecl, joined: number): ActorSlot {
    const kinds = this.adapter.actions.map((a) => a.kind);
    const unknown = (d.actions ?? []).filter((k) => !kinds.includes(k));
    if (unknown.length) throw new Error('"' + d.id + '" is given actions the world does not have: ' + unknown.join(', '));
    const actions = new Set(d.actions ?? this.adapter.actions.filter((a) => !a.granted).map((a) => a.kind));
    let policy: PolicyActor<unknown> | null = null;
    if (d.kind !== 'researcher') {
      const make = d.policy ? this.adapter.policies?.[d.policy] : undefined;
      if (!make) throw new Error('"' + d.id + '": no policy ' + JSON.stringify(d.policy) + ' in ' + this.adapter.id + ' (its policies: ' + Object.keys(this.adapter.policies ?? {}).join(', ') + ')');
      policy = make(d.params ?? {}) as PolicyActor<unknown>;
      if (policy.kind !== d.kind) throw new Error('"' + d.id + '": the policy ' + d.policy + ' is a ' + policy.kind + ', not a ' + d.kind);
    }
    return { decl: d, actions, policy, policyState: policy ? policy.initial(hashString(this.seed + ':' + d.id).split('').reduce((n, c) => (n * 36 + parseInt(c, 36)) >>> 0, 0)) : null,
      state: 'ready', batch: null, watches: false, until: null, calls: 0, intents: 0, sent: 0, joined, watched: [], received: new Set(),
      use: { intents: 0, applied: 0, conflicts: 0, calls: 0, sent: 0, received: 0, timeouts: 0 } };
  }

  private order(window: number): string[] {
    /* An order fixed by the seed, rotated by one each window. */
    const keyed = [...this.actors.keys()].map((id) => ({ id, x: hashString(this.seed + ':' + id) })).sort((a, b) => (a.x < b.x ? -1 : a.x > b.x ? 1 : a.id < b.id ? -1 : 1)).map((k) => k.id);
    const k = (window - 1) % keyed.length;
    return [...keyed.slice(k), ...keyed.slice(0, k)];
  }

  private slot(actor: string): ActorSlot {
    const s = this.actors.get(actor);
    if (!s) throw new Error('no actor "' + actor + '" in the session ' + this.id);
    return s;
  }
}
