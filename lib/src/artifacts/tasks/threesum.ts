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
  const numbers = Array.from({ length: n }, () => Math.floor(rnd() * (2 * range + 1)) - range);
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
