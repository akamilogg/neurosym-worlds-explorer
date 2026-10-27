import { joinSegments, type LivingSession, type Receipt, type Segment, type WindowRecord } from './world.ts';

/* ============================================================================
 * THE BRIDGE between a living world and the assisted researcher's rounds (SPEC-ACONTECIMIENTOS-DEL-MUNDO §5.3). The
 * researcher keeps its loop - investigation, proposal, checks, reflection - and its round counters; the session keeps the
 * world's clock. A window is not a round:
 *
 *   a query (view, table, measure, observe, its memory)   answered at once; advances nothing
 *   an act, a wait                                         taken into the step's batch; sealed when the step's requests are
 *                                                          all taken, applied after the window's barrier; what came of it is
 *                                                          that step's result, read with the next answer
 *   a request after an act in the same answer              not answered: its results did not exist yet
 *   an answer of queries only                              counted for the window: at its limit the batch is sealed empty
 *                                                          and the world goes on without it
 *   a proposal, a round closed                             an empty batch: the window goes on
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
  /** Keeps a stretch as an episode of the researcher's, and answers its name. */
  store(segment: Segment<unknown>, round: number, by: 'you' | 'the environment', answer?: (name: string) => Record<string, unknown>): string;
  log(type: string, data?: Record<string, unknown>): void;
  say(text: string): void;
}

/** What an act or a wait is answered until its window is applied: replaced then, never shown as it is. */
interface Pending { readonly pending: true; readonly n: number }

export class LivingBridge<A> {
  private readonly h: BridgeHost<A>;
  /** The step's batch, as asked: acts, or a wait. */
  private asked: ({ act: A } | { wait: number })[] = [];
  private readonly placeholders: Pending[] = [];
  /** The round's acts left, as the session counts them: each act taken, and a wait, spends one. */
  private budget: { acts: number } | null = null;

  constructor(host: BridgeHost<A>) { this.h = host; }

  /** Whether an act or a wait was taken in the step in course: a world query after it is not answered. */
  get sealing(): boolean { return this.asked.length > 0; }

  /** Requests a world query must not be after an act in the same answer: why. */
  static readonly AFTER_ACT = 'not answered: it comes after an act or a wait in the same answer, whose results do not exist yet - ask it in your next answer';

  /** The world as it is now, for the researcher (a query). */
  observe(): Record<string, unknown> {
    const o = this.h.session.observe(this.h.actor);
    return { observe: true, tick: o.tick, revision: o.revision, plate: o.view, ...(this.h.session.ended ? { the_world_has_ended: true } : {}) };
  }

  /** An act taken into the step's batch. */
  act(act: A, budget: { acts: number }): unknown {
    if (budget.acts - this.asked.length <= 0) return { act: this.h.asWritten(act), error: 'no acts left this round' };
    this.budget = budget;
    this.asked.push({ act });
    return this.placeholder();
  }

  /** A wait taken into the step's batch. */
  wait(ticks: unknown, budget: { acts: number }): unknown {
    if (budget.acts - this.asked.length <= 0) return { wait: ticks, error: 'no acts left this round' };
    this.budget = budget;
    this.asked.push({ wait: Number(ticks) });
    return this.placeholder();
  }

  /** The step's requests were all taken: its batch sealed and applied, each act's result in place of what it was answered;
      or, with queries only, the call counted - at its limit, the window goes on without it. */
  endStep(round: number, results: readonly unknown[]): unknown[] {
    const asked = this.asked;
    this.asked = [];
    const slots = new Map(this.placeholders.splice(0).map((p) => [p, p.n]));
    if (!asked.length) {
      if (this.h.session.call(this.h.actor)) this.applyEmpty(round, 'calls');
      return [...results];
    }
    const answers = this.apply(round, asked);
    return results.map((r) => (slots.has(r as Pending) ? answers[slots.get(r as Pending)!] : r));
  }

  /** The world going on before the researcher's first round (§5.1): a window it does not decide in, its stretch an episode of
      the environment's. Null when the world does not advance. */
  explore(): { name: string; segment: Segment<unknown> } | null {
    const s = this.h.session, actor = this.h.actor;
    if (!s.wait(actor, s.clock.decision_interval).accepted) return null;
    const parts: Segment<unknown>[] = [];
    do {
      const w = s.runWindow();
      if (!w) break;
      this.logWindow(0, w, 'exploration');
      const seg = w.segments.get(actor);
      if (seg) parts.push(seg);
    } while (s.actorState(actor) === 'waiting');
    if (!parts.length) return null;
    const segment = joinSegments(parts);
    const name = this.h.store(segment, 0, 'the environment');
    s.delivered(actor, 'w' + segment.window + '-' + segment.to, { episode: name, from: segment.from, to: segment.to, intents: [] });
    return { name, segment };
  }

  /** A round ended (a proposal, a closing, no proposal): an empty batch, and the window goes on. */
  endRound(round: number, how: string): void {
    this.applyEmpty(round, how);
  }

  private placeholder(): Pending {
    const p: Pending = { pending: true, n: this.asked.length - 1 };
    this.placeholders.push(p);
    return p;
  }

  private applyEmpty(round: number, by: string): void {
    const s = this.h.session;
    if (s.status !== 'running' || s.ended) return;
    if (s.actorState(this.h.actor) === 'ready') s.seal(this.h.actor, []);
    const w = s.runWindow();
    if (w) this.logWindow(round, w, by);
  }

  /** The batch: its acts sealed together (a wait alone), the window applied - as many as a wait lasts - and each answered. */
  private apply(round: number, asked: ({ act: A } | { wait: number })[]): unknown[] {
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
    let receipts: Receipt[] = [];
    if (wait !== null) {
      const ticks = (asked[wait] as { wait: number }).wait;
      const r = s.wait(actor, ticks);
      if (!r.accepted) { answers[wait] = { wait: ticks, accepted: false, reason: r.reason }; return this.finishEmpty(round, answers); }
    } else receipts = s.seal(actor, acts.map((i) => this.h.intent((asked[i] as { act: A }).act)));
    acts.forEach((i, k) => { if (!receipts[k]?.accepted) answers[i] = { act: this.h.asWritten((asked[i] as { act: A }).act), accepted: false, reason: receipts[k]?.reason ?? 'not sealed' }; });
    const taken = acts.filter((_, k) => receipts[k]?.accepted);
    if (wait === null && !taken.length) return this.finishEmpty(round, answers);
    if (this.budget) this.budget.acts -= taken.length + (wait !== null ? 1 : 0);
    /* Applied: one window for acts; for a wait, every window until it wakes. */
    const windows: WindowRecord<unknown>[] = [];
    do {
      const w = s.runWindow();
      if (!w) break;
      windows.push(w);
      this.logWindow(round, w, wait !== null ? 'wait' : 'acts');
    } while (wait !== null && s.actorState(actor) === 'waiting');
    const parts = windows.map((w) => w.segments.get(actor)).filter((x): x is Segment<unknown> => x !== undefined);
    if (!parts.length) {
      /* Nothing applied (paused, ended meanwhile): said so, never an invented episode. */
      for (const i of [...taken, ...(wait !== null ? [wait] : [])]) answers[i] = { ...('act' in asked[i] ? { act: this.h.asWritten((asked[i] as { act: A }).act) } : { wait: (asked[i] as { wait: number }).wait }),
        accepted: true, applied: false, reason: 'the world did not advance: it is ' + s.status + (s.ended ? ', at its horizon' : '') };
      return answers;
    }
    const segment = joinSegments(parts);
    const outcomes = new Map(windows.flatMap((w) => w.outcomes).map((o) => [o.intent, o]));
    const ids = new Map(taken.map((i) => [i, receipts[acts.indexOf(i)]?.intent ?? '']));
    const describe = (name: string): Record<string, unknown> => ({ name, ticks: [segment.from, segment.to], revisions: segment.revisions, ...this.h.shown(segment) });
    let name = '';
    const first = wait !== null ? wait : taken[0];
    name = this.h.store(segment, round, 'you', (n) => {
      const a = asked[first];
      return 'act' in a ? { act: this.h.asWritten(a.act), accepted: true, ...this.outcomeOf(outcomes.get(ids.get(first)!)), ...describe(n) } : { wait: a.wait, accepted: true, ...describe(n) };
    });
    if (wait !== null) answers[wait] = { wait: (asked[wait] as { wait: number }).wait, accepted: true, ...describe(name) };
    taken.forEach((i, k) => {
      const o = outcomes.get(ids.get(i)!);
      const act = this.h.asWritten((asked[i] as { act: A }).act);
      answers[i] = k === 0 ? { act, accepted: true, ...this.outcomeOf(o), ...describe(name) } : { act, accepted: true, ...this.outcomeOf(o), name, with: 'the same batch as the first act: its stretch is ' + name };
    });
    s.delivered(actor, 'w' + segment.window + '-' + segment.to, { episode: name, from: segment.from, to: segment.to, intents: segment.intents });
    return answers;
  }

  private outcomeOf(o: { outcome: string; reason?: string; completes_at?: number } | undefined): Record<string, unknown> {
    return o ? { outcome: o.outcome, ...(o.reason ? { reason: o.reason } : {}), ...(o.completes_at !== undefined ? { done_at_tick: o.completes_at } : {}) } : { outcome: 'pending' };
  }

  /** Nothing of the batch was taken: nothing sealed - the answer counts as one of queries. */
  private finishEmpty(round: number, answers: unknown[]): unknown[] {
    if (this.h.session.call(this.h.actor)) this.applyEmpty(round, 'calls');
    return answers;
  }

  private logWindow(round: number, w: WindowRecord<unknown>, by: string): void {
    this.h.log('world_window', { round, window: w.window, from: w.from, to: w.to, revision: w.revision, by,
      /* The researcher's own intents only: what else happened stays in the world's restricted record. */
      outcomes: w.outcomes.filter((o) => o.intent.startsWith(this.h.actor + ':')) });
  }
}
