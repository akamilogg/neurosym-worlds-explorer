import path from 'node:path';
import type { Verdict } from '../../artifacts/task.ts';
import type { ArtifactWorld } from '../../artifacts/world.ts';
import type { Evaluator } from './engine.ts';
import type { Evaluation } from './policy.ts';

/* ============================================================================
 * The evaluator of an evolutionary search in a world of artifacts (SPEC-DELEGACION-EVOLUTIVA §5): ArtifactWorld runs
 * and checks each candidate - the harness's own task, never a reimplementation - on a FIXED manifest of exploration
 * workloads (families, count, seed) granted to the branch. Its quality is the task's objective, through `judge`: the
 * upper end of each family's interval (of the slope, where the task judges growth), lower better - a selection
 * heuristic, never a proof between candidates. Correctness is a gate: every run of every family correct.
 * ========================================================================== */

export interface ArtifactExploration {
  /** The families granted to the branch for selection: its laboratories, never a blind family or a check's. */
  readonly families: readonly string[];
  readonly workloads: number;
  readonly seed: number;
  /** At most this many files in a patch. */
  readonly maxFiles?: number;
  /** A behaviour's cell, when the branch declares descriptors (optional). */
  readonly descriptor?: (checks: readonly { family: string; verdict: Verdict }[]) => string | null;
  /** Where the search starts, by its content (a program of the requester's): the base when absent. */
  readonly start?: { readonly hash: string; readonly files: Readonly<Record<string, string>> };
}

type Checks = readonly { readonly family: string; readonly verdict: Verdict }[];

/** Each family's component: the upper end of its slope's interval where growth is judged, else of its ratio's; null where
    it could not be read (the growth too faint, nothing measured). */
export function qualityOf(checks: Checks): (number | null)[] {
  return checks.map(({ verdict: v }) => (v.growth ? v.growth.interval[1] : v.interval ? v.interval[1] : null));
}

/** What the mutator may be told of an evaluation: per family, whether every run was correct and why not, and the
    exploration measure (the slope or the ratio, with its interval) - the numbers of these workloads, nothing reserved. */
function feedbackOf(checks: Checks): unknown {
  return checks.map(({ family, verdict: v }) => ({ family, correct: v.correct, why: v.why,
    ...(v.growth ? { growth: { slope: v.growth.slope, interval: v.growth.interval, sizes: v.growth.sizes } } : v.ratio !== null ? { ratio: v.ratio, interval: v.interval } : {}),
    ...(v.incorrect.length ? { incorrect: v.incorrect.slice(0, 3) } : {}) }));
}

/** Why a patch is refused: too many files, or a path that is not a plain relative one of the artifact (null: none). */
export function validatePatch(files: Readonly<Record<string, string | null>>, maxFiles = 8): string | null {
  const paths = Object.keys(files);
  if (paths.length > maxFiles) return 'at most ' + maxFiles + ' files in a change';
  for (const p of paths) {
    const n = path.posix.normalize(p.replace(/\\/g, '/'));
    if (!p || path.isAbsolute(p) || n.startsWith('..') || n !== p.replace(/\\/g, '/') || p.includes('\0')) return 'the path "' + p + '" is not a plain relative path of the artifact';
  }
  return null;
}

export function artifactEvaluator(world: ArtifactWorld, x: ArtifactExploration): Evaluator {
  const blind = x.families.filter((f) => world.task.families.find((g) => g.id === f)?.role !== 'laboratory');
  if (blind.length || !x.families.length) throw new Error('an evolutionary branch selects on its laboratories only: ' + (blind.join(', ') || 'none given'));
  let identity: string | null = null;
  const ev: Evaluator = {
    async identity() {
      identity ??= 'artifacts:' + world.task.id + ':' + world.reference + ':' + x.families.join(',') + ':' + x.workloads + ':' + x.seed + ':' + (await world.environment()).fingerprint;
      return identity;
    },
    contract: () => ({ about: world.task.about, metric: world.task.objective.metric, direction: world.task.objective.direction,
      ...(world.task.objective.growth ? { judged_on: 'how ' + world.task.objective.metric + ' grows with ' + world.task.objective.growth.param + ' against the reference: the slope, lower is better' } : {}),
      files: [...world.store.get(world.reference)!.files.keys()], keep: 'what it answers: every answer must be the reference\'s on the same input' }),
    start: () => (x.start ? { hash: x.start.hash, files: x.start.files } : { hash: world.reference, files: Object.fromEntries(world.store.get(world.reference)!.files) }),
    validate: (files) => validatePatch(files, x.maxFiles ?? 8),
    materialize(from, files) {
      const made = world.change(from, { files });
      if ('error' in made) return made;
      return { hash: made.version, files: Object.fromEntries(world.store.get(made.version)!.files) };
    },
    adopt(hash, files) {
      if (world.store.get(hash)) return null;
      /* From the base: every file it holds, and the base's it does not, removed. */
      const base = world.store.get(world.reference)!;
      const patch: Record<string, string | null> = { ...files };
      for (const p of base.files.keys()) if (!(p in files)) patch[p] = null;
      const made = world.change(world.reference, { files: patch });
      if ('error' in made) return made.error;
      return made.version === hash ? null : 'its content hashes to ' + made.version;
    },
    async evaluate(hash): Promise<Evaluation> {
      const checks = await world.check(hash, x.families, x.workloads, x.seed);
      const incorrect = checks.flatMap((c) => c.verdict.incorrect);
      const runs = checks.reduce((a, c) => a + c.evidence.reduce((b, e) => b + e.candidate.length, 0), 0);
      /* It ran if any run ended normally: every one exited badly or timed out, it did not. */
      const crashed = incorrect.filter((i) => /^(exited with|timed out)/.test(i.why)).length;
      return { executable: crashed < runs, correct: checks.every((c) => c.verdict.correct) ? 'yes' : 'no', quality: qualityOf(checks),
        descriptor: x.descriptor ? x.descriptor(checks) : null, feedback: feedbackOf(checks),
        diagnostics: [...new Set(incorrect.map((i) => i.workload + ': ' + i.why))].slice(0, 3), evaluator: await ev.identity() };
    }
  };
  /* A start of the requester's, made known by its content - refused if it does not hash to what it says. */
  if (x.start) { const why = ev.adopt(x.start.hash, x.start.files); if (why) throw new Error('the start ' + x.start.hash + ' cannot be taken: ' + why); }
  return ev;
}
