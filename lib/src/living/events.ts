import { hashString } from '../core/hash.ts';

/* ============================================================================
 * WHAT HAPPENS IN A LIVING WORLD THAT NOBODY IN IT ASKED FOR (SPEC-ACONTECIMIENTOS-DEL-MUNDO §6, §7, §10).
 *
 *   programs   the operator's: a trigger, a typed effect of the world, a schedule, an exposure. Their effects are the
 *              world's own (the adapter's), never a message disguised as one; their parameters drawn from a stream of
 *              each program's own, so its k-th firing is the same whenever it fires
 *   signals    what a stagnation is measured on: declared before the run - its producer, unit, direction, tolerance -
 *              never chosen by the researcher; a sample missing is no stagnation
 *   watchers   an actor's instruments that measure while it does not decide (§7): a versioned measure over what its owner
 *              may perceive, a condition, a cadence, limits. A reading says what was measured, never why
 *
 * Every trigger is evaluated when a window is committed, and what it fires is scheduled for a later tick: the past is
 * never rewritten, and nothing fires in the same instant as what fired it.
 * ========================================================================== */

/** A next draw of a stream kept as a number (mulberry32 by steps). */
function draw(state: number): [number, number] {
  const a = (state + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, a];
}

/** An effect of the world an operator's program may cause (§10): its own laws, typed. Its parameters given, or drawn from
    the program's stream; one whose precondition does not hold is refused, said so - never replaced by another. */
export interface EffectDecl<St> {
  readonly about: string;
  apply(state: St, params: Readonly<Record<string, unknown>>): { readonly state: St } | string;
  /** Parameters drawn: `next()` the program's own stream. */
  draw?(next: () => number): Record<string, unknown>;
}

export type Trigger =
  | { readonly kind: 'at'; readonly tick: number }
  | { readonly kind: 'every'; readonly ticks: number; readonly from?: number }
  | { readonly kind: 'round'; readonly actor: string; readonly round: number }
  | { readonly kind: 'interaction'; readonly actor: string; readonly action?: string }
  | { readonly kind: 'state'; readonly predicate: string }
  | { readonly kind: 'stagnation'; readonly signal: string; readonly window: number; readonly predicate: 'no_improvement' }
  | { readonly kind: 'request'; readonly actor: string }
  | { readonly kind: 'manual' };

export interface ProgramDecl {
  readonly id: string;
  readonly trigger: Trigger;
  readonly effect: { readonly type: string; readonly params?: Readonly<Record<string, unknown>> };
  readonly schedule: { readonly delay_ticks?: number; readonly cooldown_ticks?: number; readonly max_firings: number };
  readonly priority?: number;
  /** `sensors_only`: what it did is known only if an instrument measures its consequences; `announce_action`: the operator
      announces it too, as the operator's. */
  readonly exposure: 'sensors_only' | 'announce_action';
  readonly announcement?: string;
}

export interface SignalDecl {
  readonly id: string;
  /** Who produces its samples: the checks of a researcher's models (an operational indicator), a judge the operator
      configured (§10: its inputs, its rule, its answer and what it cost kept with each sample), or the researcher itself. */
  readonly producer: 'checks' | 'self_reported' | 'judge';
  /** A judge's: its question to the Judge, its ordered levels (the lowest first), and what it is given of each round. */
  readonly judge?: { readonly instructions: string; readonly criteria: readonly string[]; readonly inputs?: readonly ('check' | 'beliefs')[] };
  readonly actor: string;
  readonly unit: string;
  readonly direction: 'higher' | 'lower';
  readonly tolerance: number;
}

/** How a firing came about (§10.1, §15.1 K2): never mixed in a comparison. */
export type FiringMode = 'agenda' | 'reactive' | 'directed';
export type FiringLabel = 'operator_fixed' | 'self_reported' | 'requested_surprise' | 'directed';

export interface Firing {
  readonly id: string;
  readonly program: string;
  readonly version: number;
  readonly n: number;
  readonly at: number;
  readonly priority: number;
  readonly type: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly mode: FiringMode;
  readonly label: FiringLabel;
  readonly cause: Record<string, unknown>;
  readonly exposure: ProgramDecl['exposure'];
  readonly announcement?: string;
}

interface Program {
  decl: ProgramDecl;
  version: number;
  active: boolean;
  firings: number;
  armed: boolean;
  last: number | null;
  rng: number;
  /** Added or changed during the run: what it fires is the operator's direction (§10.1). */
  directed: boolean;
}

const TRIGGERS = ['at', 'every', 'round', 'interaction', 'state', 'stagnation', 'request', 'manual'];

/** Why a program cannot be taken (its trigger, its effect, its limits), or null. */
export function programIssue(p: unknown, o: { effects: readonly string[]; signals: readonly string[]; actors: readonly string[]; predicates: boolean }): string | null {
  const d = p && typeof p === 'object' ? p as Record<string, any> : null;
  if (!d || typeof d.id !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(d.id)) return 'a program has an "id" in lowercase';
  const t = d.trigger, at = 'program "' + d.id + '": ';
  if (!t || !TRIGGERS.includes(t.kind)) return at + '"trigger.kind" is one of ' + TRIGGERS.join(', ');
  if (t.kind === 'at' && !(Number.isInteger(t.tick) && t.tick >= 0)) return at + 'an "at" trigger has a "tick"';
  if (t.kind === 'every' && !(Number.isInteger(t.ticks) && t.ticks >= 1)) return at + 'an "every" trigger has "ticks", at least 1';
  if (['round', 'interaction', 'request'].includes(t.kind) && !o.actors.includes(t.actor)) return at + 'its trigger names a member of the world ("actor"): ' + o.actors.join(', ');
  if (t.kind === 'round' && !(Number.isInteger(t.round) && t.round >= 1)) return at + 'a "round" trigger has a "round"';
  if (t.kind === 'state' && (typeof t.predicate !== 'string' || !o.predicates)) return at + 'a "state" trigger has a "predicate" (code over the state), and the session a sandbox to run it';
  if (t.kind === 'stagnation' && (!o.signals.includes(t.signal) || !(Number.isInteger(t.window) && t.window >= 1) || t.predicate !== 'no_improvement'))
    return at + 'a "stagnation" trigger names a declared signal (' + o.signals.join(', ') + '), a "window" of samples and "predicate": "no_improvement"';
  if (!d.effect || !o.effects.includes(d.effect.type)) return at + '"effect.type" is one of the world\'s: ' + o.effects.join(', ');
  if (d.effect.params !== undefined && (typeof d.effect.params !== 'object' || Array.isArray(d.effect.params))) return at + '"effect.params" is an object';
  const s = d.schedule;
  if (!s || !(Number.isInteger(s.max_firings) && s.max_firings >= 1)) return at + '"schedule.max_firings" is a whole number, at least 1: nothing fires without a limit';
  for (const k of ['delay_ticks', 'cooldown_ticks']) if (s[k] !== undefined && !(Number.isInteger(s[k]) && s[k] >= 0)) return at + '"schedule.' + k + '" is a whole number';
  if (d.exposure !== 'sensors_only' && d.exposure !== 'announce_action') return at + '"exposure" is "sensors_only" or "announce_action"';
  return null;
}

/** Why a signal cannot be taken, or null. */
export function signalIssue(s: unknown, actors: readonly string[]): string | null {
  const d = s && typeof s === 'object' ? s as Record<string, any> : null;
  if (!d || typeof d.id !== 'string' || !/^[a-z][a-z0-9_.-]*$/.test(d.id)) return 'a signal has an "id" in lowercase';
  const at = 'signal "' + d.id + '": ';
  if (d.producer !== 'checks' && d.producer !== 'self_reported' && d.producer !== 'judge') return at + '"producer" is "checks" (the checks of its models), "judge" (a judge configured) or "self_reported"';
  if (d.producer === 'judge' && (!d.judge || typeof d.judge.instructions !== 'string' || !d.judge.instructions.trim() || !Array.isArray(d.judge.criteria) || d.judge.criteria.length < 2
    || (d.judge.inputs !== undefined && (!Array.isArray(d.judge.inputs) || d.judge.inputs.some((x: unknown) => x !== 'check' && x !== 'beliefs')))))
    return at + 'a judge\'s signal has "judge": {"instructions", "criteria": [at least two levels, the lowest first], "inputs": ["check", "beliefs"]}';
  if (!actors.includes(d.actor)) return at + '"actor" is a member of the world: ' + actors.join(', ');
  if (typeof d.unit !== 'string' || (d.direction !== 'higher' && d.direction !== 'lower') || !(typeof d.tolerance === 'number' && d.tolerance >= 0))
    return at + 'it declares its "unit", its "direction" ("higher" or "lower" is better) and its "tolerance"';
  return null;
}

/** The operator's programs and their signals, as the session runs them. */
export class Agenda<St> {
  private readonly programs = new Map<string, Program>();
  private readonly signals = new Map<string, { decl: SignalDecl; samples: { key: string; value: number | null }[] }>();
  /** Firings scheduled and not yet applied. */
  private queue: Firing[] = [];
  private seq = 0;
  readonly fired: Firing[] = [];
  readonly use = { agenda: 0, reactive: 0, directed: 0, rejected: 0, labels: {} as Record<string, number> };

  private readonly o: { seed: number; effects: Readonly<Record<string, EffectDecl<St>>>; predicate?: (source: string) => (input: unknown) => unknown };
  constructor(o: { seed: number; effects: Readonly<Record<string, EffectDecl<St>>>; predicate?: (source: string) => (input: unknown) => unknown }) { this.o = o; }

  /** The signals declared, those a member reports itself, and the programs a member may ask for. */
  signalIds(): string[] { return [...this.signals.keys()]; }
  selfReported(actor: string): string[] { return [...this.signals.values()].filter((s) => s.decl.producer === 'self_reported' && s.decl.actor === actor).map((s) => s.decl.id); }
  requestable(actor: string): string[] { return [...this.programs.values()].filter((p) => p.active && p.decl.trigger.kind === 'request' && p.decl.trigger.actor === actor).map((p) => p.decl.id); }

  /** A program taken: at the start (the manifest's), or during the run (the operator's direction, §10). */
  add(decl: ProgramDecl, directed: boolean): void {
    const was = this.programs.get(decl.id);
    this.programs.set(decl.id, { decl, version: (was?.version ?? 0) + 1, active: true, firings: was?.firings ?? 0, armed: true, last: was?.last ?? null,
      rng: was?.rng ?? (parseInt(hashString(this.o.seed + ':program:' + decl.id), 36) >>> 0), directed: directed || Boolean(was?.directed) });
  }
  disable(id: string): boolean { const p = this.programs.get(id); if (!p || !p.active) return false; p.active = false; return true; }
  has(id: string): boolean { return this.programs.has(id); }
  program(id: string): ProgramDecl | null { return this.programs.get(id)?.decl ?? null; }
  versions(): Record<string, { version: number; active: boolean; firings: number }> {
    return Object.fromEntries([...this.programs].map(([id, p]) => [id, { version: p.version, active: p.active, firings: p.firings }]));
  }

  signal(decl: SignalDecl): void { this.signals.set(decl.id, { decl, samples: [] }); }
  signalOf(id: string): SignalDecl | null { return this.signals.get(id)?.decl ?? null; }
  /** A sample of a signal under a key of its own (a round, a check): once each; null is a sample missing. */
  sample(id: string, key: string, value: number | null): boolean {
    const s = this.signals.get(id);
    if (!s || s.samples.some((x) => x.key === key)) return false;
    s.samples.push({ key, value: value !== null && Number.isFinite(value) ? value : null });
    return true;
  }

  /** The agenda's firings in the ticks from..to (its instants and its recurrences), scheduled exactly there. */
  schedule(from: number, to: number): void {
    for (const p of this.programs.values()) {
      if (!p.active) continue;
      const t = p.decl.trigger;
      const ticks = t.kind === 'at' ? [t.tick] : t.kind === 'every' ? Array.from({ length: to - from }, (_, k) => from + k).filter((x) => x >= (t.from ?? 0) && (x - (t.from ?? 0)) % t.ticks === 0) : [];
      /* Fixed before the run, the agenda; added during it, the operator's direction (§10.1). */
      for (const at of ticks) if (at >= from && at < to) this.fire(p, at, { trigger: t.kind, tick: at }, p.directed ? 'directed' : 'agenda', p.directed ? 'directed' : 'operator_fixed');
    }
  }

  /** The triggers evaluated once a window is committed at `tick` (§10): what fires, scheduled for a later tick. */
  evaluate(c: { tick: number; state: unknown; rounds: ReadonlyMap<string, number>; applied: readonly { actor: string; kind: string }[] }): void {
    for (const p of this.programs.values()) {
      if (!p.active) continue;
      const t = p.decl.trigger;
      let cond: boolean | null;
      let label: FiringLabel = p.directed ? 'directed' : 'operator_fixed';
      if (t.kind === 'round') cond = (c.rounds.get(t.actor) ?? 0) >= t.round;
      else if (t.kind === 'interaction') cond = c.applied.some((a) => a.actor === t.actor && (!t.action || a.kind === t.action));
      else if (t.kind === 'state') {
        try { cond = Boolean(this.o.predicate!(t.predicate)(c.state)); } catch { cond = null; }
      } else if (t.kind === 'stagnation') {
        const s = this.signals.get(t.signal)!;
        cond = stagnant(s.decl, s.samples.map((x) => x.value), t.window);
        if (s.decl.producer === 'self_reported' && !p.directed) label = 'self_reported';
      } else continue;
      /* Not evaluable (a predicate that failed, too few samples): nothing fires, and nothing is rearmed. */
      if (cond === null) continue;
      if (!cond) { p.armed = true; continue; }
      if (!p.armed) continue;
      p.armed = false;
      this.fire(p, c.tick + (p.decl.schedule.delay_ticks ?? 0), { trigger: t.kind, at_tick: c.tick }, p.directed ? 'directed' : 'reactive', label);
    }
  }

  /** A firing asked for: by the operator by hand, or by the researcher a program of its own request names. */
  ask(id: string, tick: number, by: { operator: string } | { actor: string }): string | null {
    const p = this.programs.get(id);
    if (!p || !p.active) return 'no program "' + id + '" active';
    if ('actor' in by) {
      if (p.decl.trigger.kind !== 'request' || p.decl.trigger.actor !== by.actor) return 'program "' + id + '" is not one you may ask for';
      return this.fire(p, tick + (p.decl.schedule.delay_ticks ?? 0), { trigger: 'request', by: by.actor }, 'reactive', 'requested_surprise') ? null : 'program "' + id + '" may not fire now (its cooldown, or its limit of firings)';
    }
    return this.fire(p, tick + (p.decl.schedule.delay_ticks ?? 0), { trigger: 'manual', by: by.operator }, 'directed', 'directed') ? null : 'program "' + id + '" may not fire now (its cooldown, or its limit of firings)';
  }

  /** The firings due at a tick, in the order of their time, priority and id (§5.1). */
  due(tick: number): Firing[] {
    const now = this.queue.filter((f) => f.at === tick).sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : 1));
    this.queue = this.queue.filter((f) => f.at !== tick);
    return now;
  }

  /** Applies a firing to the state: its effect, or why its precondition did not hold. */
  apply(state: St, f: Firing): { state: St; refused?: string } {
    const e = this.o.effects[f.type];
    const r = e.apply(state, f.params);
    if (typeof r === 'string') { this.use.rejected++; return { state, refused: r }; }
    return { state: r.state };
  }

  pending(): readonly Firing[] { return this.queue; }
  /** Its state, for the session's snapshot. */
  snapshot(): unknown { return { programs: Object.fromEntries([...this.programs].map(([id, p]) => [id, { version: p.version, active: p.active, firings: p.firings, armed: p.armed, last: p.last, rng: p.rng }])), queue: this.queue }; }

  private fire(p: Program, at: number, cause: Record<string, unknown>, mode: FiringMode, label: FiringLabel): boolean {
    const s = p.decl.schedule;
    if (p.firings >= s.max_firings) return false;
    if (p.last !== null && s.cooldown_ticks !== undefined && at - p.last < s.cooldown_ticks) return false;
    /* Its parameters: as given, or drawn from its own stream - its k-th firing the same, whenever it fires. */
    const e = this.o.effects[p.decl.effect.type];
    let params: Record<string, unknown> = { ...(p.decl.effect.params ?? {}) };
    if (e.draw && !p.decl.effect.params) {
      const next = (): number => { const [x, n] = draw(p.rng); p.rng = n; return x; };
      params = e.draw(next);
    }
    p.firings++;
    p.last = at;
    const f: Firing = { id: 'f.' + p.decl.id + '.' + p.firings, program: p.decl.id, version: p.version, n: p.firings, at, priority: p.decl.priority ?? 0, type: p.decl.effect.type, params,
      mode, label, cause, exposure: p.decl.exposure, ...(p.decl.announcement ? { announcement: p.decl.announcement } : {}) };
    this.seq++;
    this.queue.push(f);
    this.fired.push(f);
    this.use[mode]++;
    this.use.labels[label] = (this.use.labels[label] ?? 0) + 1;
    return true;
  }
}

/** No improvement (§10): the last `window` samples, all valid, none better than the best before them by more than the
    tolerance. Too few valid samples, or a missing one in the window: not evaluable (null) - never stagnation. */
export function stagnant(s: SignalDecl, values: readonly (number | null)[], window: number): boolean | null {
  if (values.length < window + 1) return null;
  const last = values.slice(-window);
  if (last.some((v) => v === null)) return null;
  const before = values.slice(0, -window).filter((v): v is number => v !== null);
  if (!before.length) return null;
  const sign = s.direction === 'higher' ? 1 : -1;
  const best = Math.max(...before.map((v) => sign * v));
  return Math.max(...(last as number[]).map((v) => sign * v)) <= best + s.tolerance;
}

/* --- Watchers (§7) ---------------------------------------------------------------------------------------------------- */

export interface WatchDecl {
  readonly id: string;
  /** Code `(o) => number | null` over { frame, previous, tick }: what its owner perceives now and before. */
  readonly measure: string;
  readonly every: number;
  readonly when: { readonly above?: number; readonly below?: number; readonly changes_by?: number };
  readonly cooldown?: number;
  /** Ticks it watches for, from when it is registered. */
  readonly for: number;
  readonly notices: number;
}

interface Watch {
  readonly decl: WatchDecl;
  readonly version: number;
  readonly fn: (input: unknown) => unknown;
  readonly since: number;
  last: number | null;
  noticed: number;
  lastNotice: number | null;
  samples: number;
  failures: number;
  stopped: string | null;
  /** What its owner perceived at its own previous sample: each watcher its own, whatever others measure. */
  prev: unknown;
}

/** Why a watcher cannot be taken, or null. */
export function watchIssue(w: unknown): string | null {
  const d = w && typeof w === 'object' ? w as Record<string, any> : null;
  if (!d || typeof d.id !== 'string' || !/^[a-z][a-z0-9_]*$/.test(d.id)) return 'a watcher has an "id" in lowercase_snake_case';
  if (typeof d.measure !== 'string' || !d.measure.trim()) return 'a watcher has a "measure": code (o) => number, over { frame, previous, tick }';
  if (!(Number.isInteger(d.every) && d.every >= 1)) return 'a watcher measures "every" so many ticks (at least 1)';
  const w2 = d.when && typeof d.when === 'object' ? d.when : null;
  if (!w2 || !['above', 'below', 'changes_by'].some((k) => typeof w2[k] === 'number')) return 'a watcher says "when" it tells you: {"above": x} | {"below": x} | {"changes_by": x}';
  if (!(Number.isInteger(d.for) && d.for >= 1)) return 'a watcher watches "for" so many ticks';
  if (!(Number.isInteger(d.notices) && d.notices >= 1)) return 'a watcher tells you at most "notices" times';
  if (d.cooldown !== undefined && !(Number.isInteger(d.cooldown) && d.cooldown >= 0)) return '"cooldown" is a whole number of ticks';
  return null;
}

/** An actor's watchers, measured by the session tick by tick, whether their owner decides or not. */
export class Watchers {
  private readonly byActor = new Map<string, Map<string, Watch>>();
  readonly use = { samples: 0, notices: 0, failures: 0 };

  private readonly compile: (source: string) => (input: unknown) => unknown;
  private readonly limit: number;
  constructor(compile: (source: string) => (input: unknown) => unknown, limit: number) { this.compile = compile; this.limit = limit; }

  /** Registers (or updates: a new version) a watcher of an actor's. Answers its version, or why not. */
  register(actor: string, d: WatchDecl, tick: number): { version: number } | { refused: string } {
    const issue = watchIssue(d);
    if (issue) return { refused: issue };
    const mine = this.byActor.get(actor) ?? new Map<string, Watch>();
    /* The others measuring now: a new one, or one stopped and registered again, takes a place of its own. */
    if ([...mine.values()].filter((w) => !w.stopped && w.decl.id !== d.id).length >= this.limit) return { refused: 'at most ' + this.limit + ' watchers of yours at once' };
    let fn: (input: unknown) => unknown;
    try { fn = this.compile(d.measure); } catch (e) { return { refused: 'its measure does not compile: ' + String((e as Error).message ?? e) }; }
    const version = (mine.get(d.id)?.version ?? 0) + 1;
    mine.set(d.id, { decl: d, version, fn, since: tick, last: null, noticed: 0, lastNotice: null, samples: 0, failures: 0, stopped: null, prev: null });
    this.byActor.set(actor, mine);
    return { version };
  }

  stop(actor: string, id: string): boolean {
    const w = this.byActor.get(actor)?.get(id);
    if (!w || w.stopped) return false;
    w.stopped = 'stopped by its owner';
    return true;
  }

  list(actor: string): Record<string, unknown>[] {
    return [...(this.byActor.get(actor)?.values() ?? [])].map((w) => ({ id: w.decl.id, version: w.version, samples: w.samples, notices: w.noticed, ...(w.stopped ? { stopped: w.stopped } : {}) }));
  }

  /** The measures due at a tick, on what each owner perceives: the readings that meet their condition (notices), and the
      failures - never a normal reading in place of a failure. */
  measure(tick: number, frameOf: (actor: string) => unknown | null): { actor: string; body: Record<string, unknown> }[] {
    const out: { actor: string; body: Record<string, unknown> }[] = [];
    /* One capture of what each owner perceives at this tick, the same for all its watchers. */
    const now = new Map<string, unknown>();
    for (const [actor, mine] of this.byActor) {
      for (const w of mine.values()) {
        if (w.stopped) continue;
        if (tick > w.since + w.decl.for) { w.stopped = 'its time ended'; continue; }
        if ((tick - w.since) % w.decl.every !== 0) continue;
        if (!now.has(actor)) now.set(actor, frameOf(actor));
        const frame = now.get(actor);
        if (frame === null || frame === undefined) continue;
        const previous = w.prev;
        w.prev = frame;
        let v: unknown;
        try { v = w.fn({ frame, previous, tick }); } catch (e) {
          w.failures++; this.use.failures++;
          out.push({ actor, body: { watch: w.decl.id, version: w.version, tick, failed: String((e as Error).message ?? e).slice(0, 200) } });
          if (w.failures >= 3) w.stopped = 'it failed three times';
          continue;
        }
        w.samples++; this.use.samples++;
        if (typeof v !== 'number' || !Number.isFinite(v)) { w.last = null; continue; }
        const c = w.decl.when;
        const met = (c.above !== undefined && v > c.above) || (c.below !== undefined && v < c.below) || (c.changes_by !== undefined && w.last !== null && Math.abs(v - w.last) >= c.changes_by);
        const before = w.last;
        w.last = v;
        if (!met || w.noticed >= w.decl.notices || (w.lastNotice !== null && tick - w.lastNotice < (w.decl.cooldown ?? w.decl.every))) continue;
        w.noticed++; w.lastNotice = tick; this.use.notices++;
        out.push({ actor, body: { watch: w.decl.id, version: w.version, tick, measured: v, ...(before !== null ? { before } : {}), condition: c,
          ...(w.noticed >= w.decl.notices ? { its_last_notice: true } : {}) } });
      }
    }
    return out;
  }
}
