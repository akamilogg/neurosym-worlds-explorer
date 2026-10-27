import { hashString } from '../../core/hash.ts';
import { nextRandom, type Intent, type LivingAction, type LivingWorldAdapter, type Message, type Outcome, type PolicyActor } from '../../living/world.ts';

/* ============================================================================
 * plates@1: the REFERENCE LIVING WORLD (SPEC-ACONTECIMIENTOS-DEL-MUNDO §17.2). A plate of wells in rows A.. and columns
 * 1..; each well holds a nutrient (0-9) and a colony (0-9). Small, deterministic from its seed, its laws reached only
 * through what is perceived.
 *
 * Its laws (hidden; drawn from the seed):
 *   growth       a colony with nutrient grows by one every `grow_every` ticks (on the ticks that are multiples of it),
 *                eating one unit of nutrient; without nutrient it shrinks by one each tick
 *   seeding      an empty well with nutrient next to (row or column) a colony of at least `seed_at` starts a colony of 1
 *   contamination a contaminated well's colony falls by two each tick, never grows and is never seeded. It is NOT
 *                perceived: only its consequences are
 *   arrivals     in the shared world, now and then a well is contaminated (chance per tick); in a reserved realization
 *                none arrive (its regime), but a few wells start contaminated
 *   smudges      now and then a mark appears on a well or goes ('*'): perceived, and of no consequence at all
 *
 * Its actions: feed a well (nutrient up, at most 9), inoculate an empty well (a colony of 1), clean a well (two ticks; at
 * its end the well is no longer contaminated, and its colony is gone).
 * ========================================================================== */

export interface PlatesLaws {
  readonly grow_every: number;
  readonly seed_at: number;
  /** Chances per tick, per thousand. */
  readonly arrivals: number;
  readonly smudges: number;
}

export interface PlatesState {
  readonly tick: number;
  readonly rows: number;
  readonly cols: number;
  readonly colony: readonly number[];
  readonly nutrient: readonly number[];
  readonly contaminated: readonly boolean[];
  readonly marks: readonly boolean[];
  readonly laws: PlatesLaws;
  /** The stream of its chance (arrivals, smudges): a number, kept in its snapshot. */
  readonly rng: number;
  /** Cleanings in course. */
  readonly ops: readonly { readonly intent: string; readonly actor: string; readonly kind: 'clean'; readonly well: number; readonly completes_at: number }[];
}

/** What an actor perceives at a tick: the plate's colonies, nutrients and marks, a row per letter, rows joined by "/". */
export interface PlatesFrame {
  readonly tick: number;
  readonly colony: string;
  readonly nutrient: string;
  readonly marks: string;
}

export const PLATES_ACTIONS: readonly LivingAction[] = [
  { kind: 'feed', about: '{"feed": "<well>", "amount": <1..5>}: adds nutrient to a well (at most 9)', duration: 1 },
  { kind: 'inoculate', about: '{"inoculate": "<well>"}: starts a colony of 1 in an empty well', duration: 1 },
  { kind: 'clean', about: '{"clean": "<well>"}: cleans a well; takes 2 ticks, and its colony is gone when it is done', duration: 2 },
  /* A competitor's: given only to the members the manifest grants it. */
  { kind: 'drain', about: '{"drain": "<well>", "amount": <1..3>}: takes nutrient from a well', duration: 1, granted: true }
];

const ROWS = 'ABCDEFGH';
export const wellName = (s: { cols: number }, i: number): string => ROWS[Math.floor(i / s.cols)] + String(i % s.cols + 1);
export function wellIndex(s: { rows: number; cols: number }, name: unknown): number | null {
  const m = typeof name === 'string' ? /^([A-H])([1-9])$/.exec(name.trim().toUpperCase()) : null;
  if (!m) return null;
  const r = ROWS.indexOf(m[1]), c = Number(m[2]) - 1;
  return r < s.rows && c < s.cols ? r * s.cols + c : null;
}

/** The laws of a world, from its seed: the same for every realization of it (the shared one and the reserved). */
export function platesLaws(seed: number): PlatesLaws {
  let r = (seed * 2654435761) >>> 0;
  const draw = (): number => { const [x, n] = nextRandom(r); r = n; return x; };
  return { grow_every: 1 + Math.floor(draw() * 2), seed_at: 4 + Math.floor(draw() * 3), arrivals: 40, smudges: 60 };
}

/** A realization's initial plate: `layout` its own seed. `contaminated`: wells contaminated from the start (some of those
    with a colony); `arrivals`: whether contaminations arrive (the shared world) or not (a reserved realization). */
export function platesState(laws: PlatesLaws, layout: number, o: { rows?: number; cols?: number; contaminated?: number; arrivals?: boolean } = {}): PlatesState {
  const rows = o.rows ?? 4, cols = o.cols ?? 6, n = rows * cols;
  let r = (layout * 40503 + 17) >>> 0;
  const draw = (): number => { const [x, k] = nextRandom(r); r = k; return x; };
  const colony = Array.from({ length: n }, () => (draw() < 0.35 ? 1 + Math.floor(draw() * 6) : 0));
  const nutrient = Array.from({ length: n }, () => Math.floor(draw() * 10));
  const contaminated = Array.from({ length: n }, () => false);
  const living = colony.map((c, i) => (c > 0 ? i : -1)).filter((i) => i >= 0);
  for (let k = 0; k < Math.min(o.contaminated ?? 0, living.length); k++) {
    const pick = living.splice(Math.floor(draw() * living.length), 1)[0];
    contaminated[pick] = true;
  }
  const marks = Array.from({ length: n }, () => draw() < 0.1);
  return { tick: 0, rows, cols, colony, nutrient, contaminated, marks, laws: o.arrivals === false ? { ...laws, arrivals: 0 } : laws, rng: (layout * 7919 + 3) >>> 0, ops: [] };
}

const neighbours = (s: PlatesState, i: number): number[] => {
  const r = Math.floor(i / s.cols), c = i % s.cols;
  return [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]].filter(([a, b]) => a >= 0 && a < s.rows && b >= 0 && b < s.cols).map(([a, b]) => a * s.cols + b);
};

/** An intent applied at the start of its window (§3): its effect at once, or a cleaning begun. Pure. */
export function platesApply(s: PlatesState, i: Intent): { state: PlatesState; outcome: Outcome } {
  const w = wellIndex(s, i.params.well)!;
  const at = (k: number, v: number, xs: readonly number[]) => xs.map((x, j) => (j === k ? v : x));
  if (i.kind === 'feed') return { state: { ...s, nutrient: at(w, Math.min(9, s.nutrient[w] + Number(i.params.amount)), s.nutrient) }, outcome: { intent: i.id, outcome: 'applied', completes_at: s.tick + 1 } };
  if (i.kind === 'drain') return { state: { ...s, nutrient: at(w, Math.max(0, s.nutrient[w] - Number(i.params.amount ?? 2)), s.nutrient) }, outcome: { intent: i.id, outcome: 'applied', completes_at: s.tick + 1 } };
  if (i.kind === 'inoculate') return { state: { ...s, colony: at(w, Math.max(s.colony[w], 1), s.colony) }, outcome: { intent: i.id, outcome: 'applied', completes_at: s.tick + 1 } };
  if (i.kind === 'clean') return { state: { ...s, ops: [...s.ops, { intent: i.id, actor: i.actor, kind: 'clean', well: w, completes_at: s.tick + 2 }] }, outcome: { intent: i.id, outcome: 'applied', completes_at: s.tick + 2 } };
  return { state: s, outcome: { intent: i.id, outcome: 'rejected', reason: 'no such action' } };
}

/** One tick of the plate: the cleanings that end, the chance of the tick, the laws. Pure. */
export function platesAdvance(s: PlatesState): { state: PlatesState; occurred: Record<string, unknown>[] } {
  const colony = [...s.colony], nutrient = [...s.nutrient], contaminated = [...s.contaminated], marks = [...s.marks];
  const occurred: Record<string, unknown>[] = [];
  /* Cleanings that end with this tick. */
  for (const op of s.ops.filter((o) => o.completes_at === s.tick + 1)) { contaminated[op.well] = false; colony[op.well] = 0; occurred.push({ kind: 'cleaned', well: wellName(s, op.well), intent: op.intent }); }
  const ops = s.ops.filter((o) => o.completes_at > s.tick + 1);
  /* The tick's chance: always four draws, whatever comes of them (the stream stays aligned). */
  let rng = s.rng;
  const draw = (): number => { const [x, n] = nextRandom(rng); rng = n; return x; };
  const [arrive, where, smudge, which] = [draw(), draw(), draw(), draw()];
  if (arrive < s.laws.arrivals / 1000) { const w = Math.floor(where * colony.length); contaminated[w] = true; occurred.push({ kind: 'contamination', well: wellName(s, w) }); }
  if (smudge < s.laws.smudges / 1000) { const w = Math.floor(which * colony.length); marks[w] = !marks[w]; occurred.push({ kind: 'smudge', well: wellName(s, w), mark: marks[w] }); }
  /* The laws, all at once from the plate as it stands now. */
  const before = { ...s, colony, nutrient, contaminated };
  const grows = (s.tick + 1) % s.laws.grow_every === 0;
  const nextColony = colony.map((c, i) => {
    if (contaminated[i]) return Math.max(0, c - 2);
    if (c > 0) return nutrient[i] > 0 ? (grows ? Math.min(9, c + 1) : c) : c - 1;
    return nutrient[i] > 0 && neighbours(before, i).some((j) => colony[j] >= s.laws.seed_at) ? 1 : 0;
  });
  const nextNutrient = nutrient.map((n, i) => (!contaminated[i] && colony[i] > 0 && n > 0 && grows && colony[i] < 9 ? n - 1 : n));
  return { state: { ...s, tick: s.tick + 1, colony: nextColony, nutrient: nextNutrient, contaminated, marks, rng, ops }, occurred };
}

/** The intents applied in order, then one tick (a test's and a reserved realization's shorthand). */
export function platesTick(s: PlatesState, intents: readonly Intent[]): { state: PlatesState; outcomes: Outcome[]; occurred: Record<string, unknown>[] } {
  const outcomes: Outcome[] = [];
  let state = s;
  for (const i of intents) { const r = platesApply(state, i); state = r.state; outcomes.push(r.outcome); }
  const next = platesAdvance(state);
  return { state: next.state, outcomes, occurred: next.occurred };
}

const layer = (s: PlatesState, cell: (i: number) => string): string =>
  Array.from({ length: s.rows }, (_, r) => Array.from({ length: s.cols }, (_, c) => cell(r * s.cols + c)).join('')).join('/');

export function platesFrame(s: PlatesState): PlatesFrame {
  return { tick: s.tick, colony: layer(s, (i) => String(s.colony[i])), nutrient: layer(s, (i) => String(s.nutrient[i])), marks: layer(s, (i) => (s.marks[i] ? '*' : '.')) };
}

/** The well an effect names: "well", or "at" (a fraction drawn) over the plate. */
const wellAt = (s: PlatesState, p: Readonly<Record<string, unknown>>): number | null =>
  p.well !== undefined ? wellIndex(s, p.well) : typeof p.at === 'number' && p.at >= 0 && p.at < 1 ? Math.floor(p.at * s.rows * s.cols) : null;

/** The adapter (§3): its actions, its laws by tick, and every actor perceiving the same projection (the plate as seen). */
export const platesAdapter: LivingWorldAdapter<PlatesState, PlatesFrame> = {
  id: 'plates@1',
  actions: PLATES_ACTIONS,
  guarantees: { replay: 'deterministic', fork: true },
  create: (config, seed) => platesState(platesLaws(seed), Number(config.layout ?? seed), {
    ...(config.rows !== undefined ? { rows: Number(config.rows) } : {}), ...(config.cols !== undefined ? { cols: Number(config.cols) } : {}),
    contaminated: Number(config.contaminated ?? 0), arrivals: config.arrivals !== false }),
  /* The operator's effects (SPEC-ACONTECIMIENTOS-DEL-MUNDO §10): its own laws - a contamination, a pulse of nutrient, a
     mark - never a message. A well named, or drawn from the program's own stream. */
  effects: {
    contaminate: { about: 'a well is contaminated (named, or drawn)',
      apply: (s, p) => { const w = wellAt(s, p); if (w === null) return 'no such well'; if (s.contaminated[w]) return wellName(s, w) + ' is contaminated already';
        return { state: { ...s, contaminated: s.contaminated.map((c, i) => c || i === w) } }; },
      draw: (next) => ({ at: next() }) },
    nutrient_pulse: { about: 'every well gains nutrient (up to 9)',
      apply: (s, p) => { const k = Number(p.amount ?? 2); if (!Number.isInteger(k) || k < 1 || k > 5) return 'a pulse is 1 to 5'; return { state: { ...s, nutrient: s.nutrient.map((n) => Math.min(9, n + k)) } }; } },
    smudge: { about: 'a mark appears on a well, or goes (of no consequence)',
      apply: (s, p) => { const w = wellAt(s, p); if (w === null) return 'no such well'; return { state: { ...s, marks: s.marks.map((m, i) => (i === w ? !m : m)) } }; },
      draw: (next) => ({ at: next() }) }
  },
  policies: {
    consumer: (p) => consumerPolicy(p),
    adversary: (p) => adversaryPolicy(p),
    population: (p) => populationPolicy(p)
  },
  validateIntent: (s, _actor, i) => {
    if (!PLATES_ACTIONS.some((a) => a.kind === i.kind)) return 'no action "' + i.kind + '": the actions are ' + PLATES_ACTIONS.map((a) => a.kind).join(', ');
    const w = wellIndex(s, i.params.well);
    if (w === null) return 'no well ' + JSON.stringify(i.params.well) + ': the wells are A1..' + wellName(s, s.rows * s.cols - 1);
    if (i.kind === 'feed') { const a = Number(i.params.amount); if (!Number.isInteger(a) || a < 1 || a > 5) return 'feed asks for an amount from 1 to 5'; }
    if (i.kind === 'drain') { const a = Number(i.params.amount ?? 2); if (!Number.isInteger(a) || a < 1 || a > 3) return 'drain asks for an amount from 1 to 3'; }
    if (i.kind === 'inoculate' && s.colony[w] > 0) return 'inoculate asks for an empty well (' + wellName(s, w) + ' holds a colony)';
    if (i.kind === 'clean' && s.ops.some((o) => o.well === w)) return wellName(s, w) + ' is being cleaned already';
    return null;
  },
  apply: (s, i) => platesApply(s, i),
  advance: (s) => platesAdvance(s),
  observe: (s) => platesFrame(s),
  tickOf: (s) => s.tick,
  pending: (s) => s.ops.map((o) => ({ intent: o.intent, actor: o.actor, kind: o.kind, completes_at: o.completes_at })),
  snapshot: (s) => JSON.parse(JSON.stringify(s)),
  restore: (snap) => JSON.parse(JSON.stringify(snap)) as PlatesState,
  /* The same plate; its chance the same, or a stream of its own. */
  fork: (snap, p) => {
    const s = JSON.parse(JSON.stringify(snap)) as PlatesState;
    return p.randomness === 'same' ? s : { ...s, rng: (s.rng ^ parseInt(hashString(p.salt), 36)) >>> 0 };
  }
};

/** A reserved realization (§5.4, §15): a plate of its own from `layout`, the same laws, its regime - no arrivals, two wells
    contaminated from the start - ticked `ticks` times with no actor in it. Never the shared state. */
export function reservedRun(laws: PlatesLaws, layout: number, ticks: number): PlatesFrame[] {
  let s = platesState(laws, layout, { contaminated: 2, arrivals: false });
  const frames = [platesFrame(s)];
  for (let t = 0; t < ticks; t++) { s = platesTick(s, []).state; frames.push(platesFrame(s)); }
  return frames;
}

/* --- The actors that are not researchers (SPEC-ACONTECIMIENTOS-DEL-MUNDO §4): each decides from the plate as it perceives it
   and its own inbox, never from another's record. They take nutrient (drain), a competitor's action. ------------------- */

const wellsOf = (f: PlatesFrame): number[] => f.nutrient.replace(/\//g, '').split('').map(Number);
const colsOf = (f: PlatesFrame): number => f.nutrient.split('/')[0].length;
const nameAt = (f: PlatesFrame, i: number): string => wellName({ cols: colsOf(f) }, i);
const drain = (f: PlatesFrame, i: number, amount: number) => ({ kind: 'drain', params: { well: nameAt(f, i), amount } });

/** A fixed policy: every window it drains the well with the most nutrient (the first of them). */
export function consumerPolicy(p: Readonly<Record<string, unknown>>): PolicyActor<PlatesFrame> {
  const amount = Number(p.amount ?? 2);
  return {
    kind: 'policy',
    initial: () => null,
    decide: ({ view }) => {
      const n = wellsOf(view);
      const best = n.reduce((b, x, i) => (x > n[b] ? i : b), 0);
      return { intents: n[best] > 0 ? [drain(view, best, amount)] : [], state: null };
    }
  };
}

/** A reactive adversary: it drains the wells it saw fed since it last looked - and, first, a well it was told of in a message
    (what it is told voluntarily, it reads; nothing else of anyone). */
export function adversaryPolicy(p: Readonly<Record<string, unknown>>): PolicyActor<PlatesFrame> {
  const amount = Number(p.amount ?? 3);
  return {
    kind: 'adversary',
    initial: () => ({ last: null }),
    decide: ({ view, inbox, state }) => {
      const before = (state as { last: string | null }).last;
      const now = wellsOf(view);
      const fed = before ? wellsOf({ ...view, nutrient: before }).map((x, i) => (now[i] > x ? i : -1)).filter((i) => i >= 0) : [];
      const told = inbox.flatMap((m: Message) => String(m.body.text ?? '').toUpperCase().match(/\b[A-H][1-9]\b/g) ?? [])
        .map((w) => wellIndex({ rows: view.nutrient.split('/').length, cols: colsOf(view) }, w)).filter((i): i is number => i !== null);
      const targets = [...new Set([...told, ...fed])].filter((i) => now[i] > 0).slice(0, 2);
      return { intents: targets.map((i) => drain(view, i, amount)), state: { last: view.nutrient } };
    }
  };
}

/** An adaptive population: members each draining the first well with at least its threshold of nutrient; every `every`
    windows the member that took least is replaced by a copy of the one that took most, its threshold moved by one at random.
    Its variation, selection and seed are its own; every decision is in its state. */
export function populationPolicy(p: Readonly<Record<string, unknown>>): PolicyActor<PlatesFrame> {
  const size = Math.max(1, Math.min(4, Number(p.size ?? 3))), every = Math.max(1, Number(p.every ?? 4));
  type S = { members: { theta: number; took: number }[]; rng: number; generation: number };
  return {
    kind: 'population',
    initial: (seed) => ({ members: Array.from({ length: size }, (_, k) => ({ theta: 3 + 2 * k, took: 0 })), rng: seed >>> 0, generation: 0 }),
    decide: ({ view, window, state }) => {
      const st = JSON.parse(JSON.stringify(state)) as S;
      const n = wellsOf(view);
      const used = new Set<number>();
      const intents = [];
      for (const m of st.members) {
        const i = n.findIndex((x, j) => x >= m.theta && !used.has(j));
        if (i < 0) continue;
        used.add(i);
        m.took += Math.min(2, n[i]);
        intents.push(drain(view, i, 2));
      }
      if (window % every === 0) {
        const order = [...st.members.keys()].sort((a, b) => st.members[a].took - st.members[b].took || a - b);
        const [x, r] = nextRandom(st.rng);
        st.rng = r;
        st.members[order[0]] = { theta: Math.max(1, Math.min(9, st.members[order[order.length - 1]].theta + (x < 0.5 ? -1 : 1))), took: 0 };
        for (const m of st.members) m.took = 0;
        st.generation++;
      }
      return { intents, state: st };
    }
  };
}
