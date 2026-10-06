import { hashString } from '../../core/hash.ts';
import type { World } from '../../core/types.ts';
import { SAVE_EVERY_MS } from './stimuli.ts';
import { mulberry32 } from '../grid/gen.ts';

/* ============================================================================
 * c302-navigation@1 as the learner perceives it (SPEC-EUREKA-NAVEGACION §4.2): episodes of
 * 9 s of a simulated nervous system, sampled every 5 ms. At each step it perceives the current
 * injected so far into each stimulated cell, and two signals read from the calcium of the
 * cells (§10, our reading, documented as ours):
 *
 *   reorientation   mean of AVAL and AVAR minus mean of AVBL and AVBR
 *   steering        RIAL minus RIAR
 *
 * each passed twice through a causal one-pole filter of 200 ms, in units of 1e-8 mM. The
 * simulation is the c302 service's (worlds/c302), outside the harness; nothing here computes
 * the network.
 * ========================================================================== */

/** The panel of 28 cells the problem simulates: sensory, first layer, integrator, hub, command and head motor cells. */
export const PANEL = ['AWCL', 'AWCR', 'AIAL', 'AIAR', 'AIBL', 'AIBR', 'AIYL', 'AIYR', 'AIZL', 'AIZR', 'RIAL', 'RIAR',
  'RIML', 'RIMR', 'AVEL', 'AVER', 'RIBL', 'RIBR', 'AVAL', 'AVAR', 'AVBL', 'AVBR', 'SMDDL', 'SMDDR', 'SMDVL', 'SMDVR', 'RIVL', 'RIVR'] as const;
/** The cells the two signals are read from (always recorded). */
export const READOUT_CELLS = ['AVAL', 'AVAR', 'AVBL', 'AVBR', 'RIAL', 'RIAR'] as const;
export const SIGNALS = ['reorientation', 'steering'] as const;
export type Signal = typeof SIGNALS[number];
export const READOUT_TAU_MS = 200;
/** Calcium (mM) to the units the learner perceives. */
export const UNIT = 1e8;

/* ============================================================================
 * NAMES (SPEC-EUREKA-NAVEGACION N3). With real names the learner sees the cells, connections and
 * signals as c302 and the problem name them. With neutral names it never sees a real one: each
 * cell of the panel is "C01".."C28" by a permutation drawn from the run's seed, a connection is
 * named after its neutral cells, a transmitter is "T1".."Tn" (also drawn), and the two signals
 * are "s1" and "s2". The laboratory translates at its border: the service and the operator keep
 * the real names; the operator's glossary says which is which.
 * ========================================================================== */

export type NamesMode = 'real' | 'neutral';
export const NEUTRAL_CELLS: readonly string[] = PANEL.map((_, i) => 'C' + String(i + 1).padStart(2, '0'));
const TRANSMITTERS = ['Acetylcholine', 'GABA', 'Glutamate', 'Serotonin', 'Dopamine', 'Octopamine', 'Tyramine', 'FMRFamide'];

export interface Naming {
  readonly mode: NamesMode;
  /** The two signals as the learner names them (reorientation, then steering). */
  readonly signals: readonly [string, string];
  /** The cells as the learner names them, in the order it is told them. */
  readonly cells: readonly string[];
  cell(real: string): string;
  /** The real cell of a name the learner gave, or null when there is none in this run. */
  real(shown: string): string | null;
  connection(real: string): string;
  realConnection(shown: string): string | null;
  transmitter(real: string): string;
  /** OPERATOR ONLY: the learner's names and what they are. */
  glossary(): Record<string, string>;
}

const shuffled = <T>(xs: readonly T[], rnd: () => number): T[] => {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
};

/** The names of a run: the real ones, or neutral ones drawn from its seed. */
export function namingOf(mode: NamesMode, seed: number): Naming {
  if (mode === 'real') {
    const known = new Set<string>(PANEL);
    return { mode, signals: ['reorientation', 'steering'], cells: PANEL,
      cell: (c) => c, real: (c) => (known.has(c) ? c : null), connection: (c) => c,
      realConnection: (c) => { const m = /^([A-Z0-9]+)-([A-Z0-9]+)(_GJ)?$/.exec(c); return m && known.has(m[1]) && known.has(m[2]) ? c : null; },
      transmitter: (t) => t, glossary: () => ({}) };
  }
  const rnd = mulberry32(seed * 2654435 + 302);
  const order = shuffled(PANEL, rnd);
  const toShown = new Map(order.map((c, i) => [c as string, NEUTRAL_CELLS[i]]));
  const toReal = new Map(order.map((c, i) => [NEUTRAL_CELLS[i], c as string]));
  const tOrder = shuffled(TRANSMITTERS, rnd);
  const tShown = new Map(tOrder.map((t, i) => [t, 'T' + (i + 1)]));
  const conn = (c: string, map: Map<string, string>): string | null => {
    const m = /^([A-Z0-9]+)-([A-Z0-9]+)(_GJ)?$/.exec(c);
    return m && map.has(m[1]) && map.has(m[2]) ? map.get(m[1]) + '-' + map.get(m[2]) + (m[3] ?? '') : null;
  };
  return { mode, signals: ['s1', 's2'], cells: NEUTRAL_CELLS,
    cell: (c) => toShown.get(c) ?? c, real: (c) => toReal.get(c) ?? null,
    connection: (c) => conn(c, toShown) ?? c, realConnection: (c) => conn(c, toReal),
    transmitter: (t) => tShown.get(t) ?? 'T?',
    glossary: () => ({ s1: 'the reorientation signal (AVA - AVB)', s2: 'the steering signal (RIAL - RIAR)',
      ...Object.fromEntries(NEUTRAL_CELLS.map((n) => [n, toReal.get(n)!])), ...Object.fromEntries([...tShown].map(([t, n]) => [n, t])) }) };
}

/** A stimulus as the service takes it: a square pulse, or a sine while it lasts. */
export interface Stimulus {
  readonly cell: string;
  readonly kind?: 'pulse' | 'sine';
  readonly delay_ms: number;
  readonly duration_ms: number;
  readonly amplitude_pa: number;
  readonly period_ms?: number;
  readonly phase_rad?: number;
}

/** Changes to the network an act may ask for (the service's words). */
export interface NetworkChanges {
  readonly remove_connections?: readonly string[];
  readonly connection_number_scaling?: Readonly<Record<string, number>>;
  readonly connection_polarity_override?: Readonly<Record<string, string>>;
  readonly param_overrides?: Readonly<Record<string, string>>;
}

/** The laboratory's spec: which family of drive a place draws its episodes from. */
export interface C302NavSpec {
  readonly seed: number;
  readonly place: string;
  /** The family its episodes draw their drive from: "steps" (irregular trains) or "rotating" (periodic trains turning
      smoothly). */
  readonly family: 'steps' | 'rotating';
  /** How the learner is told the cells and signals, and the seed its neutral names are drawn from (the run's). */
  readonly names: NamesMode;
  readonly namesSeed: number;
}

/** An episode as it was perceived, in the learner's names: the times, the current into each stimulated cell, the two
    signals, and the calcium of the cells recorded (units of 1e-8 mM). An act that asked for the wiring has no steps and
    says it. */
export interface C302NavEpisode {
  readonly t: readonly number[];
  readonly inputs: Readonly<Record<string, readonly number[]>>;
  readonly signals: Readonly<Record<string, readonly number[]>>;
  readonly calcium: Readonly<Record<string, readonly number[]>>;
  /** What was asked of the network besides the stimuli (an act's). */
  readonly changes?: NetworkChanges;
  /** Operator only: the protocol drawn (family and seed), for an episode of the environment. */
  readonly protocol?: { readonly family: string; readonly seed: number };
  /** The physical experiment it was, canonical (SPEC-PRUEBAS-PROPIAS §4.2). */
  readonly identity?: string;
  readonly wiring?: unknown;
}

/** A point: the step, and the times and the current into each stimulated cell up to it (included). */
export interface C302NavPoint {
  readonly step: number;
  readonly t: readonly number[];
  readonly inputs: Readonly<Record<string, readonly number[]>>;
  /** What an act of the learner changed in the network, in the interface's words (SPEC-PRUEBAS-PROPIAS §4.4). */
  readonly changes?: Readonly<Record<string, unknown>>;
}

export const C302NAV_PERCEPT_DOC = 'At a point of an episode your code receives p = { step, t, inputs }: `p.t` is the time of each step from the start '
  + 'up to this one (ms, every ' + SAVE_EVERY_MS + ' ms; `p.t[p.step]` is now), and `p.inputs` the current injected into each stimulated cell at each '
  + 'of those steps (pA), by the name of the cell: `p.inputs[<cell>][p.step]` is the current into it now. Nothing after this step. '
  + 'In an episode of yours that changed the network, `p.changes` says what it changed as you wrote it (remove, scale, polarity, parameters); otherwise there is no `p.changes`.';

export const perceiveC302Nav = (point: C302NavPoint): C302NavPoint => point;

/** The causal one-pole filter the signals are read with (from 0). */
export function onepole(x: readonly number[], tauMs: number, dtMs: number): number[] {
  const a = Math.exp(-dtMs / Math.max(tauMs, dtMs));
  let run = 0;
  return x.map((v) => (run = a * run + (1 - a) * v));
}

const mean = (xs: readonly (readonly number[])[]): number[] => xs[0].map((_, k) => xs.reduce((s, x) => s + x[k], 0) / xs.length);
const round = (x: number): number => Number(x.toPrecision(6));

/** The two signals, from the calcium (mM) of the readout cells sampled every `dtMs`. */
export function signalsOf(calcium: Readonly<Record<string, readonly number[]>>, dtMs = SAVE_EVERY_MS): Record<Signal, number[]> {
  const read = (x: number[]) => onepole(onepole(x, READOUT_TAU_MS, dtMs), READOUT_TAU_MS, dtMs).map((v) => round(v * UNIT));
  const ava = mean([calcium.AVAL, calcium.AVAR]), avb = mean([calcium.AVBL, calcium.AVBR]);
  return {
    reorientation: read(ava.map((v, k) => v - avb[k])),
    steering: read(calcium.RIAL.map((v, k) => v - calcium.RIAR[k]))
  };
}

/** The current into each stimulated cell at the sample times (a pulse shows at the samples with start < t <= its end). */
export function inputTraces(stimuli: readonly Stimulus[], t: readonly number[]): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const s of stimuli) {
    const x = out[s.cell] ?? (out[s.cell] = t.map(() => 0));
    t.forEach((tk, k) => {
      if (tk <= s.delay_ms || tk > s.delay_ms + s.duration_ms) return;
      x[k] = round(x[k] + (s.kind === 'sine' ? s.amplitude_pa * Math.sin((s.phase_rad ?? 0) + 2 * Math.PI * (tk - s.delay_ms) / s.period_ms!) : s.amplitude_pa));
    });
  }
  return out;
}

export function c302NavPointWorld(): World<C302NavPoint, never> {
  return {
    id: 'c302-navigation@1',
    actors: ['nature'],
    initial: () => { throw new Error('c302-navigation@1 has no initial state: points come from episodes'); },
    toMove: () => 'nature',
    actions: () => [],
    step: (s) => s,
    outcome: () => ({ over: false, winner: null, reason: null }),
    key: (s) => hashString(JSON.stringify(s)),
    view: () => ({ entities: [], scalars: {} }),
    describeRules: () => '',
    actionKey: () => ''
  };
}
