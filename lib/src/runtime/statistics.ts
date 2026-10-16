/* ============================================================================
 * DESCRIPTIVE STATISTICS WITH THEIR UNCERTAINTY (SPEC-CONTROL-ARNES §6.2; SPEC-RIESGO-MODELOS M2): what is said of a group of
 * few runs - never a label of "in control" or "out of control".
 *
 *   rate(k, n)        a proportion with its declared denominator and its 95% interval (Wilson: sound with few runs, and
 *                     with none or all of them)
 *   describe(values)  counts and continuous values: median, quartiles, and a 95% interval of the median by bootstrap - or,
 *                     with fewer than 3 observations or all of them equal, the values observed and "insufficient
 *                     evidence" (resamples all alike would give an interval of width zero: a certainty nobody has)
 * ========================================================================== */

const r3 = (x: number) => Math.round(x * 1000) / 1000;

export interface Rate { readonly k: number; readonly n: number; readonly rate: number | null; readonly interval95: [number, number] | null }

/** A proportion with its 95% interval (Wilson's score interval). */
export function rate(k: number, n: number): Rate {
  if (!n) return { k, n, rate: null, interval95: null };
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const centre = (p + z * z / (2 * n)) / d, half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return { k, n, rate: r3(p), interval95: [r3(Math.max(0, centre - half)), r3(Math.min(1, centre + half))] };
}

export type Described =
  | { readonly n: 0; readonly evidence: 'none' }
  | { readonly n: number; readonly values: readonly number[]; readonly median: number; readonly evidence: 'insufficient evidence' }
  | { readonly n: number; readonly median: number; readonly q1: number; readonly q3: number; readonly median_interval95: [number, number]; readonly method: string };

const quantile = (sorted: readonly number[], q: number): number => {
  const at = (sorted.length - 1) * q, lo = Math.floor(at), hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
};

/** A generator of the same numbers for the same seed: a report computed again says the same. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Counts and continuous values (unknown ones left out, and counted apart by the caller). */
export function describe(values: readonly (number | null | undefined)[], options: { resamples?: number; seed?: number } = {}): Described {
  const xs = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return { n: 0, evidence: 'none' };
  const median = r3(quantile(xs, 0.5));
  if (xs.length < 3 || xs[0] === xs[xs.length - 1]) return { n: xs.length, values: xs, median, evidence: 'insufficient evidence' };
  const B = options.resamples ?? 2000, rnd = mulberry32(options.seed ?? 20261016);
  const medians: number[] = [];
  for (let b = 0; b < B; b++) {
    const sample = Array.from({ length: xs.length }, () => xs[Math.floor(rnd() * xs.length)]).sort((a, c) => a - c);
    medians.push(quantile(sample, 0.5));
  }
  medians.sort((a, c) => a - c);
  return { n: xs.length, median, q1: r3(quantile(xs, 0.25)), q3: r3(quantile(xs, 0.75)),
    median_interval95: [r3(quantile(medians, 0.025)), r3(quantile(medians, 0.975))], method: 'percentile bootstrap of the median, ' + B + ' resamples, seeded' };
}
