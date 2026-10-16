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

/* --- A paired comparison (SPEC-CONTROL-ARNES §6.2.1): two conditions run with the same seeds, the effect seed by seed --------- */

export interface PairedComparison {
  readonly pairs: number;
  /** Per paired seed: the difference, oriented so that positive is better (a cost that falls is an improvement). */
  readonly differences: readonly { readonly key: string; readonly difference: number }[];
  /** Binary results: the discordant pairs, each way. */
  readonly discordant?: { readonly better_now: number; readonly worse_now: number };
  readonly effect: number | null;
  readonly effect_is: string;
  readonly interval95: [number, number] | null;
  readonly margin: number;
  readonly conclusion: 'improves' | 'worsens' | 'indistinguishable' | 'insufficient evidence';
  readonly rule: string;
}

/** Compares `now` with `before`, paired by key (a seed and its world). `binary`: values 1 or 0 (the effect is the mean of the
    differences); otherwise continuous (their median). `lower`: lower is better. `relative`: each difference as a share of the
    value before. The margin - the least improvement that would matter - is declared before; four conclusions, by its rule. */
export function pairedComparison(before: ReadonlyMap<string, number>, now: ReadonlyMap<string, number>,
  o: { readonly margin: number; readonly binary?: boolean; readonly lower?: boolean; readonly relative?: boolean; readonly resamples?: number; readonly seed?: number }): PairedComparison {
  const sign = o.lower ? -1 : 1;
  const differences = [...now.keys()].filter((k) => before.has(k)).sort().flatMap((key) => {
    const b = before.get(key)!, n = now.get(key)!;
    if (o.relative && !b) return [];
    return [{ key, difference: r3(sign * (o.relative ? (n - b) / Math.abs(b) : n - b)) }];
  });
  const rule = 'improves if its interval is wholly above the margin; worsens if wholly below zero; indistinguishable if it crosses zero and is narrower than the margin; otherwise, or with fewer than 3 paired seeds or all differences alike, insufficient evidence';
  const discordant = o.binary ? { better_now: differences.filter((d) => d.difference > 0).length, worse_now: differences.filter((d) => d.difference < 0).length } : undefined;
  const xs = differences.map((d) => d.difference);
  const stat = (v: readonly number[]) => (o.binary ? v.reduce((a, b) => a + b, 0) / v.length : quantile([...v].sort((a, b) => a - b), 0.5));
  const base = { pairs: xs.length, differences, ...(discordant ? { discordant } : {}), margin: o.margin, rule, effect_is: (o.binary ? 'the mean' : 'the median') + ' of the paired differences' + (o.relative ? ', each relative to the value before' : '') + (o.lower ? ', lower being better' : '') };
  if (xs.length < 3 || xs.every((x) => x === xs[0])) return { ...base, effect: xs.length ? r3(stat(xs)) : null, interval95: null, conclusion: 'insufficient evidence' };
  const B = o.resamples ?? 2000, rnd = mulberry32(o.seed ?? 20261016);
  const stats: number[] = [];
  for (let b = 0; b < B; b++) stats.push(stat(Array.from({ length: xs.length }, () => xs[Math.floor(rnd() * xs.length)])));
  stats.sort((a, b) => a - b);
  const ci: [number, number] = [r3(quantile(stats, 0.025)), r3(quantile(stats, 0.975))];
  const conclusion = ci[0] > o.margin ? 'improves' : ci[1] < 0 ? 'worsens' : ci[0] <= 0 && ci[1] >= 0 && ci[1] - ci[0] < o.margin ? 'indistinguishable' : 'insufficient evidence';
  return { ...base, effect: r3(stat(xs)), interval95: ci, conclusion };
}
