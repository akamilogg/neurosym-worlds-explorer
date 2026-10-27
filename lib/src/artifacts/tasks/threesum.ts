import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mulberry32, type ArtifactTask, type Family, type Workload } from '../task.ts';

/* ============================================================================
 * The second artifact task: 3SUM - whether three of n integers, at three different positions, sum
 * to zero. The base is the simplest program: three nested loops, stopping at the first triple found,
 * cubic in n. How far below that it can go is the researcher's to find; nothing here says how.
 *
 * Decided, not found: out.txt is "yes" or "no", so a candidate is correct where it answers what the
 * reference answers on the same input (two programs may find different triples; they agree on
 * whether there is one). Some workloads have a triple planted, so that an answer fixed in advance
 * does not pass.
 *
 * The families pull apart: no triple at all (all the cubic work, everything to gain); a small range
 * of values (a triple almost at once, little to gain: not worse); a triple planted at the very end
 * (blind). The reference runs on every workload of a check, so n stays in the hundreds.
 * ========================================================================== */

const BASE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'examples', 'artifacts', 'threesum', 'base');

/** The workload's input: n integers in [-range, range]; with `planted`, three of them summing to zero - at random
    positions, or at the end (`planted: "end"`). */
export function threesumInput(w: Workload): string {
  const rnd = mulberry32(w.seed);
  const n = Math.max(3, Number(w.params.n)), range = Number(w.params.range);
  /* A range wider than the generator's 2^32 values draws twice (a finer fraction): never a lattice of values, where triples
     would come by chance. A narrower range draws as it always did (the same workloads for threesum@1). */
  const draw = range * 2 + 1 > 2 ** 32 ? () => rnd() + rnd() / 2 ** 32 : rnd;
  const numbers = Array.from({ length: n }, () => Math.floor(draw() * (2 * range + 1)) - range);
  const planted = w.params.planted;
  if (planted === 'random' || planted === 'end') {
    const at = planted === 'end' ? [n - 3, n - 2, n - 1] : (() => {
      const picks = new Set<number>();
      while (picks.size < 3) picks.add(Math.floor(rnd() * n));
      return [...picks];
    })();
    const a = Math.floor(rnd() * range) - Math.floor(range / 2), b = Math.floor(rnd() * range) - Math.floor(range / 2);
    numbers[at[0]] = a; numbers[at[1]] = b; numbers[at[2]] = -(a + b);
  }
  return n + '\n' + numbers.join(' ') + '\n';
}

/** A family whose workloads may differ in one parameter, workload by workload (`vary`). */
const family = (id: string, about: string, role: Family['role'], params: Workload['params'], requires: Family['requires'] = 'better',
  vary?: (i: number) => Partial<Workload['params']>): Family => ({
  id, about, role, requires,
  workloads: (seed, n) => Array.from({ length: n }, (_, i) => ({ family: id, id: id + '-' + seed + '-' + i, seed: seed * 7919 + i * 131 + id.length,
    params: { ...params, ...(vary ? vary(i) : {}) } as Workload['params'] }))
});

/** The task. `scale` shrinks every workload (the harness's own tests run it small). */
export function threesumTask(options: { scale?: number; python?: string } = {}): ArtifactTask {
  const s = options.scale ?? 1;
  const python = options.python ?? process.env.ARTIFACT_PYTHON ?? 'python';
  const n = (x: number) => Math.max(3, Math.round(x * s));
  return {
    id: 'threesum@1',
    about: 'decide whether three of n integers sum to zero: as fast as it can be, with the same answer',
    base: BASE,
    run: {
      command: () => [python, 'src/main.py'],
      inputs: (w) => ({ 'input.txt': threesumInput(w) }),
      outputs: ['out.txt'],
      environment: [[python, '--version']],
      timeoutMs: 120000
    },
    read: (files, measured) => ({ metrics: { wall_ms: measured.wallMs }, output: files['out.txt']?.trim() ?? null }),
    families: [
      family('mixed', 'a few hundred numbers in a wide range, a triple planted in every other workload', 'laboratory',
        { n: n(300), range: 1e9, planted: 'none' }, 'better', (i) => ({ planted: i % 2 === 1 ? 'random' : 'none' })),
      family('large', 'several hundred numbers in a wide range, no triple planted', 'family', { n: n(600), range: 1e9, planted: 'none' }),
      /* A small range: a triple almost at once, little to gain - a family to see that nothing breaks or slows. */
      family('dense', 'several hundred numbers in a small range', 'family', { n: n(600), range: 50, planted: 'none' }, 'not_worse'),
      family('late', 'several hundred numbers in a wide range, a triple planted at the very end', 'blind', { n: n(600), range: 1e9, planted: 'end' })
    ],
    oracle: (candidate, reference) => (candidate.output !== null && candidate.output === reference.output ? { ok: true }
      : { ok: false, why: candidate.output === null ? 'it left no out.txt' : 'its answer differs from the reference\'s' }),
    objective: { metric: 'wall_ms', direction: 'min', margin: 0.1, confidence: 0.9, repetitions: 3 }
  };
}

/* ============================================================================
 * 3SUM below O(n^2) (threesum-subquadratic@1): the same question, judged on how a version's time GROWS, not on its size.
 * The base - also the reference - is quadratic: sort, then for each number two pointers closing in. A version holds where
 * its time over the reference's falls as n grows (Objective.growth): a faster constant, a fixed cost, or a trick for a
 * bounded range of values never passes for it. The values span a wide range (+-1e12), so no table or transform over the
 * range fits; there is no triple in the family (all the work), half of the laboratory's have one, the blind ones have it
 * at the very end. Each place's workloads are a ladder of sizes, and the smallest (n = 3) measure each version's fixed
 * cost - starting, reading - set apart before the slope is taken.
 * ========================================================================== */

const BASE_SUBQUADRATIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'examples', 'artifacts', 'threesum-subquadratic', 'base');

/** The sizes of a place's ladder (n), relative to the scale, and the floor's: what a fixed cost is measured at. */
export const SUBQUADRATIC_LADDER = [2000, 4000, 8000] as const;
const FLOOR = 3;

/** The floor of @2 (an external review, 27/10/2026: two evolved programs answered "yes" to 0 1 -2, and no workload of @1
    could tell - its values span 1e12, where a zero or a repeated value almost never comes): small inputs in a narrow range,
    zeros and repeated values among them, a triple planted in one of three. Still tiny, they measure each version's fixed
    cost as the floor of @1 did; and every place's check runs them, so a version wrong where it is small is wrong there. */
const EDGE_FLOOR = 5;
const edges = (count: number) => Math.max(16, 8 * count);
/* n from 3 to 5 in -3..3: where a zero, repeated values and both signs come often without a triple - the cases a wrong
   shortcut answers wrongly (with more or wider values a triple comes by chance, and hides it). */
const edgeParams = (i: number): Partial<Workload['params']> => ({ n: 3 + (i % 3), range: 3, planted: i % 4 === 3 ? 'random' : 'none' });

/** A family whose workloads climb a ladder of sizes: `count` at each size, and `count` at the floor - what varies, varying
    along the whole ladder (one workload per size still alternates). With `edge` (@2), its floor is the small inputs above. */
const ladder = (id: string, about: string, role: Family['role'], params: Workload['params'], sizes: readonly number[], vary?: (i: number) => Partial<Workload['params']>, edge = false): Family => ({
  id, about, role, requires: 'better',
  workloads: (seed, count) => (edge
    ? [...Array.from({ length: edges(count) }, (_, i) => ({ family: id, id: id + '-' + seed + '-edge-' + i, seed: seed * 7919 + i * 131 + 17 + id.length,
        params: { ...params, ...edgeParams(i) } as Workload['params'] })),
      ...sizes.flatMap((n, k) => Array.from({ length: count }, (_, i) => ({ family: id, id: id + '-' + seed + '-' + n + '-' + i,
        seed: seed * 7919 + (k + 1) * 1009 + i * 131 + id.length, params: { ...params, ...(vary ? vary(k * count + i) : {}), n } as Workload['params'] })))]
    : [FLOOR, ...sizes].flatMap((n, k) => Array.from({ length: count }, (_, i) => ({ family: id, id: id + '-' + seed + '-' + n + '-' + i,
      seed: seed * 7919 + k * 1009 + i * 131 + id.length, params: { ...params, ...(vary ? vary(k * count + i) : {}), n } as Workload['params'] }))))
});

export function threesumSubquadraticTask(options: { scale?: number; python?: string; version?: 1 | 2 } = {}): ArtifactTask {
  const s = options.scale ?? 1;
  const python = options.python ?? process.env.ARTIFACT_PYTHON ?? 'python';
  /* @2: its floor the small edge inputs, its ladder above them; @1 as it was, for the runs made with it. */
  const v2 = options.version === 2;
  const floor = v2 ? EDGE_FLOOR : FLOOR;
  const sizes = SUBQUADRATIC_LADDER.map((x) => Math.max(floor + 1, Math.round(x * s)));
  return {
    id: 'threesum-subquadratic@' + (v2 ? 2 : 1),
    about: 'decide whether three of n integers sum to zero, in time that grows more slowly than n^2 - the base, the reference, is quadratic',
    base: BASE_SUBQUADRATIC,
    run: {
      command: () => [python, 'src/main.py'],
      inputs: (w) => ({ 'input.txt': threesumInput(w) }),
      outputs: ['out.txt'],
      environment: [[python, '--version']],
      timeoutMs: 120000
    },
    read: (files, measured) => ({ metrics: { wall_ms: measured.wallMs }, output: files['out.txt']?.trim() ?? null }),
    families: [
      ladder('ladder', 'a ladder of sizes in a wide range of values, a triple planted in every other workload' + (v2 ? '; below it, small inputs in a narrow range' : ''), 'laboratory', { range: 1e12, planted: 'none' }, sizes,
        (i) => ({ planted: i % 2 === 1 ? 'random' : 'none' }), v2),
      ladder('ladder-none', 'a ladder of sizes in a wide range of values, no triple planted' + (v2 ? '; below it, small inputs in a narrow range' : ''), 'family', { range: 1e12, planted: 'none' }, sizes, undefined, v2),
      ladder('ladder-late', 'a ladder of sizes in a wide range of values, a triple planted at the very end' + (v2 ? '; below it, small inputs in a narrow range' : ''), 'blind', { range: 1e12, planted: 'end' }, sizes, undefined, v2)
    ],
    oracle: (candidate, reference) => (candidate.output !== null && candidate.output === reference.output ? { ok: true }
      : { ok: false, why: candidate.output === null ? 'it left no out.txt' : 'its answer differs from the reference\'s' }),
    objective: { metric: 'wall_ms', direction: 'min', margin: 0.05, confidence: 0.9, repetitions: 3, growth: { param: 'n', floor } }
  };
}
