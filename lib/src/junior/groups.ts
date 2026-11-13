import fs from 'node:fs';
import path from 'node:path';
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
  return REALIZATION + ':' + sha([REALIZATION, id, seed, identity]);
}

/* A realization names the identity it was made under (`realization@2:<sha256>`): a hash says nothing of the rule that made
   it, and two rules give the same world different hashes. One made under another identity - or written before identities
   were named, a bare hash (realization@1 or @2, which cannot be told) - is never compared with the current ones: it is
   made again from what it was made of where that is recorded, and otherwise its origin is unknown. */
export const REALIZATION = 'realization@2';

/** Whether a declared realization is of the current identity. */
export const isCurrentRealization = (r: unknown): r is string => typeof r === 'string' && new RegExp('^' + REALIZATION + ':[0-9a-f]{64}$').test(r);

/** What a run's realization is made of, captured from its record when the run is read - its experiment, its arguments and
    the execution it was - so its realization can be made again under any identity WITHOUT reading the path again: a
    path names a file, and a file may be another run by then (an external review of 0bec9b3: a candidate learned from seed
    9, its file reused by a run of seed 3, rebuilt as learned from 3 and admitted on 9). */
export interface RunCapture { readonly experiment: string; readonly argv: readonly string[]; readonly run_id: string | null }

export const isCapture = (c: unknown): c is RunCapture => !!c && typeof c === 'object' && typeof (c as RunCapture).experiment === 'string'
  && Array.isArray((c as RunCapture).argv) && (c as RunCapture).argv.every((x) => typeof x === 'string');

/** A journal's capture, null when it is not a run's record. */
export function captureOfJournal(j: unknown): RunCapture | null {
  const r = j as { experiment?: unknown; argv?: unknown; run_id?: unknown } | null;
  if (!r || typeof r.experiment !== 'string' || !Array.isArray(r.argv)) return null;
  return { experiment: r.experiment, argv: r.argv.map(String), run_id: typeof r.run_id === 'string' ? r.run_id : null };
}

/** A run's capture, read from its record now; null when it cannot be read. */
export function captureOfRun(journalFile: string): RunCapture | null {
  try { return captureOfJournal(JSON.parse(fs.readFileSync(journalFile, 'utf8'))); } catch { return null; }
}

export const realizationOfCapture = (c: RunCapture): string => realizationOf(c.experiment, c.argv);

/** Realizations as recorded, of the current identity: as they are when every one is; else made again from the captures
    recorded with them (never from a path read again); undefined - an unknown origin - where none were recorded. */
export function currentRealizations(recorded: readonly unknown[] | undefined, captures?: readonly unknown[]): string[] | undefined {
  if (recorded && recorded.every(isCurrentRealization)) return [...recorded].sort();
  if (!Array.isArray(captures) || !captures.every(isCapture)) return undefined;
  return [...new Set(captures.map(realizationOfCapture))].sort();
}

/** The realization of a run, from its record: its experiment and the arguments it was given (argv). Null when the record
    cannot be read: an unknown origin is never taken for a clean one by whoever reads it. */
export function realizationOfRun(journalFile: string): string | null {
  const c = captureOfRun(journalFile);
  return c ? realizationOfCapture(c) : null;
}

/** The captures of the runs a dataset's examples were cut from, as each example recorded when it was cut; null when one
    did not record it (an example of before captures were kept) or cannot be found: its origin is unknown. */
export function datasetCaptures(examplesDir: string, dataset: { readonly examples: readonly string[] }): RunCapture[] | null {
  const files = fs.existsSync(examplesDir) ? fs.readdirSync(examplesDir).map((n) => path.join(examplesDir, n)) : [];
  const out: RunCapture[] = [];
  for (const id of dataset.examples) {
    let ex: { id?: unknown; cut?: { capture?: unknown } } | null = null;
    for (const f of files) { try { const e = JSON.parse(fs.readFileSync(f, 'utf8')); if (e.id === id) { ex = e; break; } } catch { /* not an example */ } }
    if (!ex || !isCapture(ex.cut?.capture)) return null;
    out.push(ex.cut.capture);
  }
  return out;
}

/** The realizations of the runs a dataset's examples were cut from, from their captures; null where one is unknown. */
export function datasetRealizations(examplesDir: string, dataset: { readonly examples: readonly string[] }): string[] | null {
  const c = datasetCaptures(examplesDir, dataset);
  return c ? [...new Set(c.map(realizationOfCapture))].sort() : null;
}
