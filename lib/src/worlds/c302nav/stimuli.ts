import { mulberry32 } from '../grid/gen.ts';

/* ============================================================================
 * The two families of odor drive of c302-navigation@1 (SPEC-EUREKA-NAVEGACION §2, N1): square
 * pulses of current into the two odor-sensing cells, AWCL and AWCR, over 9 s. Each pulse has a
 * total current and a split between the two sides; the left cell takes total x split, the right
 * one the rest. Written from what the problem describes and from the statistics of its
 * protocols (measured 05/10/2026, §10), never from its code:
 *
 *   steps     (the family the researcher sees): irregular trains - every width, gap, total and
 *             split drawn on its own from a few values; the first pulse at 200, 350 or 500 ms.
 *   rotating  (the family of validation): periodic trains - one width and one period for the
 *             whole run - with the total and the split turning smoothly through it, each on a
 *             cycle of its own; the first pulse at 200 ms.
 * ========================================================================== */

export const STIM_CELLS = ['AWCL', 'AWCR'] as const;
export const DURATION_MS = 9000;
export const SAVE_EVERY_MS = 5;

export type Family = 'steps' | 'rotating';
export interface Pulse { readonly start_ms: number; readonly width_ms: number; readonly total_pa: number; readonly split: number }
export interface Protocol { readonly family: Family; readonly seed: number; readonly pulses: readonly Pulse[] }

const STEPS = {
  first: [200, 350, 500],
  width: [60, 120, 200, 320, 400],
  gap: [100, 200, 400, 700, 900],
  total: [2.5, 3.5, 4.5, 5.5, 6.0],
  split: [0, 0.25, 0.5, 0.75, 1]
};
const ROTATING = {
  first: 200,
  margin: 100,
  period: [500, 700, 900, 1200],
  width: [150, 250, 350],
  totalCycle: [2000, 3000, 4500],
  /* The split turns on a cycle about 1.43 times the total's (2000 -> 2850, 3000 -> 4300, 4500 -> 6430 in its protocols). */
  splitCycleRatio: 1.43,
  total: { center: 3.25, amplitude: 2.75 },
  split: { center: 0.5, amplitude: 0.45 }
};

const pick = <T>(rnd: () => number, xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
const round = (x: number, n = 4): number => Math.round(x * 10 ** n) / 10 ** n;

/** A protocol of a family, from a seed: the same seed, the same protocol. */
export function protocolOf(family: Family, seed: number): Protocol {
  const rnd = mulberry32(seed * 7919 + (family === 'steps' ? 11 : 23));
  const pulses: Pulse[] = [];
  if (family === 'steps') {
    let t = pick(rnd, STEPS.first);
    for (;;) {
      const width = pick(rnd, STEPS.width);
      if (t + width > DURATION_MS) break;
      pulses.push({ start_ms: t, width_ms: width, total_pa: pick(rnd, STEPS.total), split: pick(rnd, STEPS.split) });
      t += width + pick(rnd, STEPS.gap);
    }
  } else {
    const period = pick(rnd, ROTATING.period), width = pick(rnd, ROTATING.width);
    const cycle = pick(rnd, ROTATING.totalCycle), splitCycle = cycle * ROTATING.splitCycleRatio;
    const phaseT = rnd() * 2 * Math.PI, phaseS = rnd() * 2 * Math.PI;
    /* The last pulse ends 100 ms before the run does (it holds for all 33 of its protocols). */
    for (let t = ROTATING.first; t + width <= DURATION_MS - ROTATING.margin; t += period) {
      pulses.push({ start_ms: t, width_ms: width,
        total_pa: round(ROTATING.total.center + ROTATING.total.amplitude * Math.cos(2 * Math.PI * t / cycle + phaseT)),
        split: round(ROTATING.split.center + ROTATING.split.amplitude * Math.cos(2 * Math.PI * t / splitCycle + phaseS)) });
    }
  }
  return { family, seed, pulses };
}

/** The protocol as the c302 service takes it: a square pulse into each side that receives current. */
export function stimuliOf(p: Protocol): { cell: string; delay_ms: number; duration_ms: number; amplitude_pa: number }[] {
  return p.pulses.flatMap((x) => [
    { cell: 'AWCL', amp: x.total_pa * x.split },
    { cell: 'AWCR', amp: x.total_pa * (1 - x.split) }
  ].filter((s) => s.amp > 0).map((s) => ({ cell: s.cell, delay_ms: x.start_ms, duration_ms: x.width_ms, amplitude_pa: round(s.amp) })));
}

/** The current into each side on the 5 ms grid (what the researcher perceives of the drive). */
export function tracesOf(p: Protocol, everyMs = SAVE_EVERY_MS, durationMs = DURATION_MS): { t: number[]; AWCL: number[]; AWCR: number[] } {
  const n = Math.floor(durationMs / everyMs) + 1;
  const t = Array.from({ length: n }, (_, k) => k * everyMs);
  const L = new Array<number>(n).fill(0), R = new Array<number>(n).fill(0);
  for (const x of p.pulses) {
    for (let k = 0; k < n; k++) if (t[k] > x.start_ms && t[k] <= x.start_ms + x.width_ms) { L[k] = round(x.total_pa * x.split); R[k] = round(x.total_pa * (1 - x.split)); }
  }
  return { t, AWCL: L, AWCR: R };
}
