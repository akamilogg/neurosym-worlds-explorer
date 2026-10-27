import fs from 'node:fs';
import { hashString, stableStringify } from '../core/hash.ts';

/* ============================================================================
 * A LIVING WORLD (SPEC-ACONTECIMIENTOS-DEL-MUNDO): a world that exists and goes on during the investigation, one state
 * per session that every actor shares, apart from the episodic contract (Lab.episode, Lab.act) and never made of episodes
 * started afresh.
 *
 *   the adapter      its state, laws, actions and what each actor may perceive of it (§3)
 *   the session      the coordinator: the clock, the windows, the batches sealed by the actors, their order and conflicts,
 *                    the journal written ahead of every transition (§5, §14). It orders and delivers; it never interprets
 *   the journal      every window prepared and committed, every delivery, under keys of their own: a run resumed derives
 *                    them again and finds them in the record it continues - never a transition or a delivery twice
 *
 * A window: the actors decide on the same revision of the state, each seals one batch (intents, a wait, or nothing), and
 * the world advances its interval with the batches applied in an order fixed by the seed. What an actor reads, measures
 * or writes of its own while it decides never advances the world (§5.3).
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
}

export interface LivingWorldAdapter<St, F> {
  /** The adapter and its version (e.g. "plates@1"). */
  readonly id: string;
  readonly actions: readonly LivingAction[];
  /** What it guarantees: replayed from the same seed and intents it is the same world; a realization of its own is possible. */
  readonly guarantees: { readonly replay: 'deterministic'; readonly fork: boolean };
  /** The initial state of a realization. */
  create(config: Readonly<Record<string, unknown>>, seed: number): St;
  /** Why an intent cannot be taken in this state (an action it does not have, a parameter out of range, a precondition), or
      null. Asked when it is sealed and again when it is applied: a precondition broken meanwhile is a conflict. */
  validateIntent(state: St, actor: string, intent: Intent): string | null;
  /** One tick: the intents that start in it, in the order given; its laws and its chance. Pure: the same state and intents
      are the same next state. `occurred`: what happened, for the restricted record only (never shown to an actor). */
  advance(state: St, intents: readonly Intent[]): { readonly state: St; readonly outcomes: readonly Outcome[]; readonly occurred: readonly Record<string, unknown>[] };
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

/* --- The session: the coordinator (§2, §5) ------------------------------------------------------------------------------- */

export type SessionState = 'created' | 'running' | 'paused' | 'closing' | 'completed' | 'failed';
export type ActorState = 'ready' | 'thinking' | 'waiting' | 'exhausted' | 'stopped' | 'failed';

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

/** A window as it was applied: its interval and revisions, what became of each intent, and each actor's stretch. */
export interface WindowRecord<F> {
  readonly window: number;
  readonly from: number;
  readonly to: number;
  readonly revision: number;
  readonly outcomes: readonly Outcome[];
  readonly segments: ReadonlyMap<string, Segment<F>>;
}

interface ActorSlot {
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
}

export interface LivingSessionOptions<St, F> {
  readonly adapter: LivingWorldAdapter<St, F>;
  /** The session's id (e.g. "world:plates-s1"). */
  readonly id: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly seed: number;
  readonly actors: readonly string[];
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

/** The coordinator of a living world: one authoritative state, a clock, the windows, the actors' batches. */
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
  /** Counters for the run's record (§13). */
  readonly use = { windows: 0, ticks: 0, intents: 0, applied: 0, conflicts: 0, rejected: 0, calls: 0, empty_batches: 0 };

  constructor(o: LivingSessionOptions<St, F>) {
    this.adapter = o.adapter; this.id = o.id; this.clock = o.clock; this.limits = o.limits; this.journal = o.journal; this.seed = o.seed;
    if (!(o.clock.decision_interval >= 1) || !(o.clock.horizon >= 1)) throw new Error('a living world needs a decision interval and a horizon of at least one tick');
    if (!(o.limits.calls_per_window >= 1) || !(o.limits.intents_per_window >= 1)) throw new Error('a living world needs limits of at least one call and one intent per window');
    this.state = o.adapter.create(o.config, o.seed);
    for (const a of o.actors) this.actors.set(a, { state: 'ready', batch: null, watches: false, until: null, calls: 0, intents: 0 });
    this.journal.write({ key: 'manifest', session: o.id, adapter: o.adapter.id, seed: o.seed, config: o.config, clock: o.clock, limits: o.limits, actors: [...o.actors],
      actions: o.adapter.actions, guarantees: o.adapter.guarantees, state: stateHash(o.adapter, this.state) });
    this.status = 'running';
  }

  get tick(): number { return this.adapter.tickOf(this.state); }
  /** Whether the horizon is reached: nothing advances any more. */
  get ended(): boolean { return this.tick >= this.clock.horizon; }
  actorState(actor: string): ActorState { return this.slot(actor).state; }

  /** What an actor perceives now, at the current revision (§5.3: a query, it advances nothing). */
  observe(actor: string): { readonly session: string; readonly tick: number; readonly revision: number; readonly view: F } {
    this.slot(actor);
    return { session: this.id, tick: this.tick, revision: this.revision, view: this.adapter.observe(this.state, actor) };
  }

  /** A decision call of an actor's (§5.3): counted for its window. True when it reached its limit: its batch is sealed empty
      for it, and the window may go on without it. */
  call(actor: string): boolean {
    const s = this.slot(actor);
    s.calls++; this.use.calls++;
    if (s.batch === null && s.calls >= this.limits.calls_per_window) { this.seal(actor, []); return true; }
    return false;
  }

  /** Seals an actor's batch for the window in course: each intent checked now and given its id, the refused left out.
      Its batch is one; a second one in the same window is refused whole. */
  seal(actor: string, asked: readonly { readonly kind: string; readonly params: Readonly<Record<string, unknown>> }[]): Receipt[] {
    const s = this.slot(actor);
    if (this.status !== 'running') return asked.map((a) => ({ intent: '', kind: a.kind, accepted: false, reason: 'the world is ' + this.status }));
    if (s.batch !== null) return asked.map((a) => ({ intent: '', kind: a.kind, accepted: false, reason: 'your batch for this window is already sealed' }));
    if (this.ended && asked.length) return asked.map((a) => ({ intent: '', kind: a.kind, accepted: false, reason: 'the world has reached its horizon (tick ' + this.clock.horizon + '): it does not advance any more' }));
    if (asked.length > this.limits.intents_per_window) return asked.map((a) => ({ intent: '', kind: a.kind, accepted: false, reason: 'at most ' + this.limits.intents_per_window + ' intents in one window' }));
    const batch: Intent[] = [];
    const receipts = asked.map((a) => {
      const intent: Intent = { id: actor + ':' + (s.intents + 1), actor, kind: a.kind, params: a.params };
      const why = this.adapter.validateIntent(this.state, actor, intent);
      if (why) return { intent: '', kind: a.kind, accepted: false, reason: why };
      s.intents++;
      batch.push(intent);
      return { intent: intent.id, kind: a.kind, accepted: true };
    });
    /* Nothing of it taken: nothing sealed (the actor may still act in this window). */
    if (asked.length && !batch.length) return receipts;
    s.batch = batch;
    s.watches = batch.length > 0;
    if (!batch.length) this.use.empty_batches++;
    this.use.intents += batch.length;
    return receipts;
  }

  /** `wait(ticks)` (§5.1): seals an empty batch and sleeps until then; it watches what happens meanwhile. One action when
      asked, never one per tick. */
  wait(actor: string, ticks: number): Receipt {
    const s = this.slot(actor);
    const n = Math.floor(ticks);
    if (!(n >= 1)) return { intent: '', kind: 'wait', accepted: false, reason: 'wait asks for a whole number of ticks, at least 1' };
    if (this.ended) return { intent: '', kind: 'wait', accepted: false, reason: 'the world has reached its horizon (tick ' + this.clock.horizon + '): it does not advance any more' };
    if (s.batch !== null) return { intent: '', kind: 'wait', accepted: false, reason: 'your batch for this window is already sealed' };
    s.batch = [];
    s.watches = true;
    s.until = Math.min(this.clock.horizon, this.tick + n);
    s.state = 'waiting';
    return { intent: actor + ':wait@' + this.tick, kind: 'wait', accepted: true };
  }

  /** Whether every actor that decides has sealed its batch (or sleeps): the window can be applied. */
  ready(): boolean {
    if (this.status !== 'running' || this.ended) return false;
    const deciding = [...this.actors.values()].filter((s) => s.state === 'ready' || s.state === 'thinking' || s.state === 'waiting');
    return deciding.length > 0 && deciding.every((s) => s.batch !== null || (s.until !== null && s.until > this.tick));
  }

  /** Applies the window in course (§5.1): written ahead, the batches in the order of the window, the interval ticked, its
      stretch given to each actor that watches it, committed. Null when it cannot be applied now (not ready, paused, ended). */
  runWindow(): WindowRecord<F> | null {
    if (!this.ready()) return null;
    const window = this.window + 1;
    const from = this.tick;
    /* The interval: one decision interval, cut short where a sleeper wakes and at the horizon. */
    const wakes = [...this.actors.values()].filter((s) => s.until !== null && s.until > from).map((s) => s.until!);
    const to = Math.min(this.clock.horizon, from + this.clock.decision_interval, ...wakes);
    /* Rotating priority over an order fixed by the seed (§5.1): the first to apply changes with the window. */
    const order = this.order(window);
    const batches = order.map((a) => ({ actor: a, intents: this.actors.get(a)!.batch ?? [] }));
    this.journal.write({ key: 'w' + window + '.prepare', window, from, to, revision: this.revision, state: stateHash(this.adapter, this.state),
      order, batches: batches.map((b) => ({ actor: b.actor, intents: b.intents.map((i) => ({ id: i.id, kind: i.kind, params: i.params })) })) });
    const watching = [...this.actors.entries()].filter(([, s]) => s.watches).map(([a]) => a);
    const frames = new Map<string, F[]>(watching.map((a) => [a, [this.adapter.observe(this.state, a)]]));
    const outcomes: Outcome[] = [];
    const occurred: Record<string, unknown>[] = [];
    for (let t = from; t < to; t++) {
      /* The intents start at the window's first tick; one whose precondition another broke is a conflict, without its effects. */
      const starting: Intent[] = [];
      if (t === from) for (const b of batches) for (const i of b.intents) {
        const why = this.adapter.validateIntent(this.state, i.actor, i);
        if (why) outcomes.push({ intent: i.id, outcome: 'conflict', reason: why }); else starting.push(i);
      }
      const next = this.adapter.advance(this.state, starting);
      this.state = next.state;
      outcomes.push(...next.outcomes);
      occurred.push(...next.occurred.map((o) => ({ tick: t, ...o })));
      for (const [a, f] of frames) f.push(this.adapter.observe(this.state, a));
    }
    this.revision++;
    this.window = window;
    this.use.windows++; this.use.ticks += to - from;
    for (const o of outcomes) this.use[o.outcome === 'applied' ? 'applied' : o.outcome === 'conflict' ? 'conflicts' : 'rejected']++;
    this.journal.write({ key: 'w' + window + '.commit', window, from, to, revision: this.revision, state: stateHash(this.adapter, this.state), outcomes, occurred,
      pending: this.adapter.pending(this.state) });
    const segments = new Map<string, Segment<F>>();
    for (const [a, f] of frames) {
      const mine = batches.find((b) => b.actor === a)?.intents.map((i) => i.id) ?? [];
      segments.set(a, { session: this.id, actor: a, window, from, to, revisions: [this.revision - 1, this.revision], frames: f, intents: mine });
    }
    /* A new window: every batch open again; a sleeper whose time came wakes. */
    for (const s of this.actors.values()) {
      s.batch = null; s.calls = 0;
      if (s.until !== null && s.until <= this.tick) { s.until = null; if (s.state === 'waiting') s.state = 'ready'; }
      s.watches = s.until !== null;
      if (s.until !== null) s.batch = [];
    }
    return { window, from, to, revision: this.revision, outcomes, segments };
  }

  /** Records a delivery to an actor (§8: its own receipt), once under its key. Answers whether it is new. */
  delivered(actor: string, key: string, what: Record<string, unknown>): boolean {
    return this.journal.write({ key: 'd.' + actor + '.' + key, actor, window: this.window, revision: this.revision, ...what });
  }

  /** Pauses the clock (§13): no window is applied until it is resumed. */
  pause(): void { if (this.status === 'running') { this.status = 'paused'; this.journal.write({ key: 'pause@w' + this.window, window: this.window, tick: this.tick }); } }
  resume(): void { if (this.status === 'paused') { this.status = 'running'; this.journal.write({ key: 'resume@w' + this.window, window: this.window, tick: this.tick }); } }

  /** An actor that can decide no more (its budget spent): it stops deciding; what it began goes on as the world's laws say. */
  exhaust(actor: string): void { const s = this.slot(actor); s.state = 'exhausted'; s.batch = s.batch ?? []; s.until = null; }

  /** Closes the session (§13): no more windows; what was in course is kept, as pending, with the final state. */
  close(reason: string): Record<string, unknown> {
    if (this.status === 'completed') return this.summary();
    this.status = 'closing';
    const pending = this.adapter.pending(this.state);
    this.journal.write({ key: 'close', reason, window: this.window, tick: this.tick, revision: this.revision, state: stateHash(this.adapter, this.state), pending,
      snapshot: this.adapter.snapshot(this.state), use: this.use });
    this.status = 'completed';
    return { ...this.summary(), closed: reason, pending };
  }

  /** What the run's record keeps of the session (§13): its counters and where it is. */
  summary(): Record<string, unknown> {
    return { session: this.id, adapter: this.adapter.id, status: this.status, tick: this.tick, horizon: this.clock.horizon, window: this.window, revision: this.revision,
      state: stateHash(this.adapter, this.state), ...this.use, ...(this.journal.diverged.length ? { diverged: this.journal.diverged.map((d) => d.key) } : {}) };
  }

  /** The state, for the operator (the restricted record): never an actor's. */
  auditState(): St { return this.state; }

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
