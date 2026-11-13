import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { stableStringify } from '../core/hash.ts';
import { LABS } from '../worlds/labs.ts';
import type { CompetenceManifest } from './competence.ts';

/* ============================================================================
 * THE USES OF DATA, kept apart by one rule (SPEC-VALIDEZ-MEDIDA §5): every group (a lineage of runs) has the uses a
 * manifest gives it - diagnosis (the weight laboratory's), training (cases run only to be distilled at), selection by
 * probe, selection by investigation, confirmation - and what one use touches never feeds another. Before it, the weight
 * laboratory refused a diagnosis group shared with any case while the distillation compared its datasets with the probes
 * only: a dataset could share a group with a case of investigation, or of confirmation, and be trained on.
 *
 * A REALIZATION is a world and the arguments that make it (its laboratory, its seed, its options), by hash: what a case is,
 * and what a run that fed a junior was. A package carries the realizations of what it learned from, and the confirmation
 * compares them with its reserved cases'.
 * ========================================================================== */

export type GroupUse = 'diagnosis' | 'training' | 'selection_probe' | 'selection_investigation' | 'confirmation';

/** Each group of a manifest with its uses. */
export function usesOf(m: Pick<CompetenceManifest, 'cases'> & { readonly weight_lab?: { readonly diagnosis?: Readonly<Record<string, unknown>> } }): Map<string, Set<GroupUse>> {
  const out = new Map<string, Set<GroupUse>>();
  const add = (g: unknown, u: GroupUse) => { if (typeof g !== 'string' || !g) return; const s = out.get(g) ?? new Set<GroupUse>(); s.add(u); out.set(g, s); };
  for (const c of m.cases ?? []) {
    if (c.kind === 'probe') add(c.group, 'selection_probe');
    else if (c.kind === 'investigation') add(c.group, c.partition === 'confirmation' ? 'confirmation' : c.partition === 'training' ? 'training' : 'selection_investigation');
  }
  for (const g of Object.keys(m.weight_lab?.diagnosis ?? {})) add(g, 'diagnosis');
  return out;
}

/** The groups that select or confirm juniors: nothing a junior learns from may share one. */
export function measuringGroups(m: Parameters<typeof usesOf>[0]): Set<string> {
  return new Set([...usesOf(m)].filter(([, u]) => [...u].some((x) => x !== 'diagnosis' && x !== 'training')).map(([g]) => g));
}

const sha = (v: unknown): string => createHash('sha256').update(stableStringify(v)).digest('hex');

/** The value an argument list gives an option, as the runner reads it: its first one; undefined when none. */
function valueOf(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : undefined;
}

/** A realization by hash: the laboratory (by its registry name or its experiment id) and the world its arguments make - its
    seed and the laboratory's own options, their defaults written out (the corpus's notion of a realization), whatever
    else the arguments say of the researcher left aside. */
export function realizationOf(lab: string, args: readonly string[]): string {
  const l = LABS[lab] ?? Object.values(LABS).find((x) => x.id === lab);
  const id = l?.id ?? lab;
  const options = ((l as { options?: readonly { name: string; default: string }[] } | undefined)?.options ?? []);
  /* A laboratory may change a default (Lab.defaults): the world its arguments make with it. */
  const defaults = ((l as { defaults?: Readonly<Record<string, string>> } | undefined)?.defaults ?? {});
  const given: Record<string, string> = {};
  for (const o of options) given[o.name] = valueOf(args, o.name) ?? defaults[o.name] ?? o.default;
  /* What its generator reads, normalized as it reads it (Lab.realization); never a budget of the researcher. */
  const identity = (l as { realization?: (o: Readonly<Record<string, string>>) => unknown } | undefined)?.realization?.(given) ?? null;
  const rawSeed = valueOf(args, 'seed') ?? defaults.seed ?? '1';
  const seed = Number.isFinite(Number(rawSeed)) ? Number(rawSeed) : rawSeed;
  return sha(['realization@2', id, seed, identity]);
}

/** The realization of a run, from its record: its experiment and the arguments it was given (argv). Null when the record
    cannot be read: an unknown origin is never taken for a clean one by whoever reads it. */
export function realizationOfRun(journalFile: string): string | null {
  try {
    const j = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
    if (typeof j.experiment !== 'string' || !Array.isArray(j.argv)) return null;
    return realizationOf(j.experiment, j.argv.map(String));
  } catch { return null; }
}
