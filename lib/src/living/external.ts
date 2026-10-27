import { randomUUID } from 'node:crypto';
import type { WorldJournal } from './world.ts';

/* ============================================================================
 * A WORLD OUTSIDE THE HARNESS (SPEC-ACONTECIMIENTOS-DEL-MUNDO §5.2, §14): a service that is the authority of its own clock and
 * effects. The harness asks it, by operation ids, and reads what happened by a cursor over its sequence of events. What the
 * service does not guarantee is never promised:
 *
 *   idempotent    an operation sent again under its id is done once: a lost answer is asked again, safely
 *   lookup        an operation's state can be asked by its id: a lost answer is reconciled, never sent again
 *   neither       a lost answer leaves its effect UNCERTAIN: recorded so, never sent again
 *   retention     how many events it keeps: a cursor behind what it keeps is a GAP, recorded, and the record of the world is
 *                 then incomplete - its reproduction limited, said so
 *   pause         whether it can be paused: when it cannot, stopping the researcher does not stop the world - on returning,
 *                 what it kept is read and what it lost is named
 * ========================================================================== */

export interface ServiceGuarantees {
  readonly idempotent: boolean;
  readonly lookup: boolean;
  readonly pause: boolean;
  /** Events it keeps, the latest. */
  readonly retention: number;
}

/** How the harness reaches a service: a request answered, or a throw when the answer is lost (a timeout, a broken link). */
export interface ServiceTransport {
  request(route: string, body: Readonly<Record<string, unknown>>): Promise<{ readonly status: number; readonly body: Record<string, any> }>;
}

export interface ServiceEvent { readonly seq: number; readonly tick: number; readonly kind: string; readonly body: Readonly<Record<string, unknown>> }

/** A SIMULATED service (§17.2, test 14): its own clock, its own events, its guarantees as declared - and the faults a real
    one has: answers lost (after the operation was done), delays, events no longer kept, a pause it may not support. */
export class SimulatedService implements ServiceTransport {
  tick = 0;
  paused = false;
  private seq = 0;
  private readonly events: ServiceEvent[] = [];
  private readonly ops = new Map<string, Record<string, unknown>>();
  /** Operations done, each counted (a repeat that is not idempotent is done twice). */
  readonly done: string[] = [];
  readonly guarantees: ServiceGuarantees;
  private readonly lose: (route: string, n: number) => boolean;
  private readonly delayMs: number;
  private calls = 0;

  constructor(o: { guarantees: ServiceGuarantees; lose?: (route: string, n: number) => boolean; delayMs?: number }) {
    this.guarantees = o.guarantees; this.lose = o.lose ?? (() => false); this.delayMs = o.delayMs ?? 0;
  }

  /** Its clock goes on (by itself, unless paused): each tick an event of its own. */
  advance(ticks: number): void {
    for (let k = 0; k < ticks; k++) {
      if (this.paused) return;
      this.tick++;
      this.emit('tick', { tick: this.tick });
    }
  }

  async request(route: string, body: Readonly<Record<string, unknown>>): Promise<{ status: number; body: Record<string, any> }> {
    const n = ++this.calls;
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    let answer: { status: number; body: Record<string, any> };
    if (route === '/act') {
      const op = String(body.op);
      if (this.guarantees.idempotent && this.ops.has(op)) answer = { status: 200, body: { ...this.ops.get(op)!, repeated: true } };
      else {
        this.done.push(op);
        const e = this.emit('effect', { op, actor: body.actor, intents: body.intents });
        const result = { op, state: 'applied', seq: e.seq, tick: this.tick };
        if (this.guarantees.idempotent || this.guarantees.lookup) this.ops.set(op, result);
        answer = { status: 200, body: result };
      }
    } else if (route === '/op') answer = this.guarantees.lookup ? { status: 200, body: this.ops.get(String(body.op)) ?? { op: body.op, state: 'unknown' } } : { status: 501, body: { error: 'no lookup' } };
    else if (route === '/events') {
      const after = Number(body.after ?? 0);
      const kept = this.events.slice(-this.guarantees.retention);
      answer = { status: 200, body: { events: kept.filter((e) => e.seq > after), oldest: kept[0]?.seq ?? this.seq + 1, latest: this.seq, tick: this.tick } };
    } else if (route === '/pause' || route === '/resume') {
      if (!this.guarantees.pause) answer = { status: 501, body: { error: 'it cannot be paused' } };
      else { this.paused = route === '/pause'; answer = { status: 200, body: { paused: this.paused, tick: this.tick } }; }
    } else answer = { status: 404, body: { error: 'no route ' + route } };
    /* An answer lost after what was asked was done: the harness cannot tell it from one never done. */
    if (this.lose(route, n)) throw new Error('the answer was lost');
    return answer;
  }

  private emit(kind: string, body: Record<string, unknown>): ServiceEvent {
    const e = { seq: ++this.seq, tick: this.tick, kind, body };
    this.events.push(e);
    return e;
  }
}

/** The harness's side of a world outside it: operations by their ids, a cursor over its events, every uncertainty and every
    gap recorded in the session's journal - never a guarantee the service does not declare. */
export class ExternalWorld {
  private cursor = 0;
  private opSeq = 0;
  private reads = 0;
  private pauses = 0;
  /** Its session with the service: an identity of its own, kept in its record - operation ids never repeat across sessions,
      and a session resumed goes on with its own. */
  readonly session: string;
  readonly uncertain: string[] = [];
  readonly gaps: { from: number; to: number }[] = [];
  readonly seen: ServiceEvent[] = [];
  private readonly o: { transport: ServiceTransport; guarantees: ServiceGuarantees; journal: WorldJournal; actor: string };

  constructor(o: { transport: ServiceTransport; guarantees: ServiceGuarantees; journal: WorldJournal; actor: string }) {
    this.o = o;
    /* Resumed from its record: its session, its counters, its cursor and what it observed, as recorded - never started afresh. */
    const before = o.journal.known('x.manifest')[0];
    this.session = typeof before?.session === 'string' ? before.session : randomUUID();
    o.journal.write({ key: 'x.manifest', session: this.session, actor: o.actor, guarantees: o.guarantees,
      promises: { exactly_once: o.guarantees.idempotent, reconciled: o.guarantees.idempotent || o.guarantees.lookup, pause: o.guarantees.pause } });
    this.opSeq = o.journal.known('x.op.').filter((e) => String(e.key).endsWith('.prepare')).length;
    for (const e of o.journal.known('x.op.')) if (!String(e.key).endsWith('.prepare') && e.state === 'uncertain') this.uncertain.push(String(e.op));
    const reads = o.journal.known('x.read.');
    this.reads = reads.length;
    this.cursor = Math.max(0, ...reads.map((e) => Number(e.cursor) || 0));
    for (const e of o.journal.known('x.events.').sort((a, b) => Number(a.from) - Number(b.from))) this.seen.push(...((e.events ?? []) as ServiceEvent[]));
    for (const e of o.journal.known('x.gap.')) this.gaps.push({ from: Number(e.from), to: Number(e.to) });
    this.pauses = o.journal.known('x.pause.').length;
  }

  /** An operation: done and answered, done for certain after a repeat (idempotent) or a lookup, or UNCERTAIN - recorded so,
      never sent again. */
  async act(intents: readonly Record<string, unknown>[]): Promise<{ op: string; state: 'applied' | 'uncertain' | 'refused'; result?: Record<string, unknown>; why?: string }> {
    const op = this.session + ':' + this.o.actor + ':op' + (++this.opSeq);
    this.o.journal.write({ key: 'x.op.' + op + '.prepare', op, intents });
    const done = (state: 'applied' | 'uncertain' | 'refused', extra: Record<string, unknown>) => {
      this.o.journal.write({ key: 'x.op.' + op, op, state, ...extra });
      if (state === 'uncertain') this.uncertain.push(op);
      return { op, state, ...extra };
    };
    try {
      const r = await this.o.transport.request('/act', { op, actor: this.o.actor, intents });
      return r.status === 200 ? done('applied', { result: r.body }) : done('refused', { why: String(r.body.error ?? r.status) });
    } catch (e) {
      const lost = String((e as Error).message ?? e);
      /* Sent again under its id: done once, by the service's own guarantee. */
      if (this.o.guarantees.idempotent) {
        try {
          const r = await this.o.transport.request('/act', { op, actor: this.o.actor, intents });
          /* Only an answer that says it was done says so: any other leaves it as uncertain as before. */
          if (r.status === 200 && r.body.state === 'applied') return done('applied', { result: r.body, after: 'its answer was lost (' + lost + '); asked again under its id' });
        } catch { /* lost again: as below */ }
      }
      /* Asked about by its id: what the service says it did. */
      if (this.o.guarantees.lookup) {
        try {
          const r = await this.o.transport.request('/op', { op });
          if (r.status !== 200) throw new Error('HTTP ' + r.status);
          if (r.body.state === 'applied') return done('applied', { result: r.body, after: 'its answer was lost; the service says it was done' });
          if (r.body.state === 'unknown') return done('refused', { why: 'its answer was lost; the service has no record of it: not done' });
        } catch { /* lost again: uncertain */ }
      }
      return done('uncertain', { why: 'its answer was lost (' + lost + ') and the service can neither repeat it safely nor say what it did: never sent again' });
    }
  }

  /** What happened since the cursor: the events it still keeps, and a gap where it kept no more. */
  async read(): Promise<{ events: ServiceEvent[]; gap?: { from: number; to: number } }> {
    const r = await this.o.transport.request('/events', { after: this.cursor });
    if (r.status !== 200) throw new Error('the service did not answer what happened: HTTP ' + r.status);
    const events = (r.body.events ?? []) as ServiceEvent[];
    let gap: { from: number; to: number } | undefined;
    if (Number(r.body.oldest) > this.cursor + 1 && Number(r.body.latest) > this.cursor) {
      gap = { from: this.cursor + 1, to: Number(r.body.oldest) - 1 };
      this.gaps.push(gap);
      this.o.journal.write({ key: 'x.gap.' + gap.from + '-' + gap.to, ...gap, why: 'the service keeps its latest ' + this.o.guarantees.retention + ' events only: these are lost to the record' });
    }
    /* What was observed, whole, in the record before the cursor moves past it: the service need not keep it. */
    if (events.length) this.o.journal.write({ key: 'x.events.' + events[0].seq + '-' + events[events.length - 1].seq, from: events[0].seq, to: events[events.length - 1].seq, events });
    for (const e of events) this.seen.push(e);
    if (events.length) this.cursor = events[events.length - 1].seq;
    this.o.journal.write({ key: 'x.read.' + (++this.reads), cursor: this.cursor, events: events.length, ...(gap ? { gap } : {}) });
    return { events, ...(gap ? { gap } : {}) };
  }

  /** The researcher stops: the world is paused if the service can be; otherwise it goes on, said so. */
  async pause(): Promise<{ paused: boolean; why?: string }> {
    const r = await this.o.transport.request('/pause', {});
    const key = 'x.pause.' + (++this.pauses);
    if (r.status === 200) { this.o.journal.write({ key, cursor: this.cursor, paused: true }); return { paused: true }; }
    this.o.journal.write({ key, cursor: this.cursor, paused: false, why: 'the service cannot be paused: the world goes on without the researcher' });
    return { paused: false, why: 'the service cannot be paused: the world goes on without the researcher' };
  }

  /** The researcher returns: what the service kept since is read, and what it lost is named. */
  async resume(): Promise<{ events: ServiceEvent[]; lost?: { from: number; to: number } }> {
    if (this.o.guarantees.pause) await this.o.transport.request('/resume', {});
    const r = await this.read();
    return { events: r.events, ...(r.gap ? { lost: r.gap } : {}) };
  }

  /** How complete the record is (§14): every operation certain and no event lost, or limited - and why. */
  summary(): Record<string, unknown> {
    const limited = this.uncertain.length > 0 || this.gaps.length > 0;
    return { guarantees: this.o.guarantees, cursor: this.cursor, operations: this.opSeq, uncertain: this.uncertain, gaps: this.gaps,
      reproduction: limited ? 'limited' : 'complete', ...(limited ? { because: [...(this.uncertain.length ? ['operations of uncertain effect'] : []), ...(this.gaps.length ? ['events the service no longer kept'] : [])] } : {}) };
  }
}
