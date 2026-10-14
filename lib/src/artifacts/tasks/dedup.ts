import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mulberry32, type ArtifactTask, type Family, type Workload } from '../task.ts';

/* ============================================================================
 * The first artifact task (SPEC-MUNDO-ARTEFACTOS §14): a data script with real inefficiencies of
 * different kinds - a list for the keys seen (quadratic in the unique keys), a sort after every
 * record kept (quadratic in the kept ones), output built by concatenation. Which one dominates
 * depends on the workload: many unique keys, many duplicates, long records. A model of its
 * behaviour should find which, and a change that wins only on one family should not pass the
 * others.
 *
 * Correct: the same out.csv as the reference's on the same input. Metric: wall time, lower is
 * better, by 10 % with 90 % confidence, three runs each, interleaved - except where little is to
 * be gained (many duplicates): there, not worse by more than 10 %.
 * ========================================================================== */

const BASE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'examples', 'artifacts', 'dedup', 'base');

/** The workload's input: rows of key,value,tag - `unique` of them distinct keys, some tags malformed, tags `width` long. */
export function dedupInput(w: Workload): string {
  const rnd = mulberry32(w.seed);
  const rows = Number(w.params.rows), unique = Math.max(1, Math.round(rows * Number(w.params.unique))), width = Number(w.params.width);
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const lines = ['key,value,tag'];
  for (let i = 0; i < rows; i++) {
    const key = 'k' + Math.floor(rnd() * unique);
    const value = Math.floor(rnd() * 1000);
    let tag = '';
    for (let j = 0; j < width - 2; j++) tag += letters[Math.floor(rnd() * 26)];
    tag += rnd() < 0.15 ? 'X!' : String(Math.floor(rnd() * 90) + 10);
    lines.push(key + ',' + value + ',' + tag);
  }
  return lines.join('\n') + '\n';
}

const family = (id: string, about: string, role: Family['role'], params: Workload['params'], requires: Family['requires'] = 'better'): Family => ({
  id, about, role, requires,
  workloads: (seed, n) => Array.from({ length: n }, (_, i) => ({ family: id, id: id + '-' + seed + '-' + i, seed: seed * 7919 + i * 131 + id.length, params }))
});

/** The task. `scale` shrinks every workload (the harness's own tests run it small). */
export function dedupTask(options: { scale?: number; python?: string } = {}): ArtifactTask {
  const s = options.scale ?? 1;
  const python = options.python ?? process.env.ARTIFACT_PYTHON ?? 'python';
  return {
    id: 'dedup@1',
    about: 'deduplicate records by key, keep the well-formed ones, rank them by value: as fast as it can be, with the same output',
    base: BASE,
    run: {
      command: () => [python, 'src/main.py'],
      inputs: (w) => ({ 'input.csv': dedupInput(w) }),
      outputs: ['out.csv'],
      environment: [[python, '--version']],
      timeoutMs: 60000
    },
    read: (files, measured) => ({ metrics: { wall_ms: measured.wallMs }, output: files['out.csv'] ?? null }),
    families: [
      family('mixed', 'a few hundred rows, half of the keys distinct', 'laboratory', { rows: Math.round(1200 * s), unique: 0.5, width: 8 }),
      family('unique', 'thousands of rows, nearly every key distinct', 'family', { rows: Math.round(12000 * s), unique: 0.95, width: 8 }),
      /* Few distinct keys: little to gain, a family to see that nothing breaks or slows. */
      family('duplicates', 'thousands of rows, few distinct keys', 'family', { rows: Math.round(12000 * s), unique: 0.05, width: 8 }, 'not_worse'),
      family('wide', 'long tags, a third of the keys distinct', 'blind', { rows: Math.round(5000 * s), unique: 0.35, width: 120 })
    ],
    oracle: (candidate, reference) => (candidate.output !== null && candidate.output === reference.output ? { ok: true }
      : { ok: false, why: candidate.output === null ? 'it left no out.csv' : 'its out.csv differs from the reference\'s' }),
    objective: { metric: 'wall_ms', direction: 'min', margin: 0.1, confidence: 0.9, repetitions: 3 }
  };
}
