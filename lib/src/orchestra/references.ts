import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LABS } from '../worlds/labs.ts';
import { worldOptionsIn } from './reader.ts';
import { generatorOf } from '../runtime/generators.ts';
import { pairedComparison, type PairedComparison } from '../runtime/statistics.ts';
import { runResults } from './results.ts';

/* ============================================================================
 * FROZEN REFERENCES (SPEC-CONTROL-ARNES K2, §6.1, §6.4): the distribution of a group of comparable runs at a version, frozen
 * with the hash of its runs - so that a change that worsens the process is never made normal in silence.
 *
 *   lab reference freeze <batch.json> --condition C --name N --by "<person>" [--generator G] [--supersedes OLD]
 *       runs/references/<N>.json, read only, never replaced. A new reference that supersedes another is frozen only once
 *       the batch it comes from has been compared with that one (its batch definition declared the comparison, §6.2.1),
 *       and a person decides it: the old one stays.
 *   lab reference show <N>      its group, its runs, and whether it holds (its own hash, its runs' journals)
 *
 * A batch compares itself with a reference when its definition declares it - before it runs, with its margin:
 *   "compare": [{ "reference": N, "condition": C, "metric": "o1"|"artifact"|"o4"|"severe"|"tokens"|"seconds", "margin": m,
 *                 "relative": true|false }]
 * paired by seed (and world), with the four conclusions of §6.2.1.
 * ========================================================================== */

type J = Record<string, any>;
const sha = (x: string | Buffer) => createHash('sha256').update(x).digest('hex');
const readJson = (file: string): J | null => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

/** The results a reference keeps of each run, and how each compares (§6.2.1). */
export const METRICS: Readonly<Record<string, { readonly binary?: boolean; readonly lower?: boolean; readonly what: string }>> = {
  o1: { binary: true, what: 'O1: its model accepted' },
  artifact: { binary: true, what: 'O1: its artifact accepted' },
  o4: { what: 'O4: mechanistic recovery' },
  severe: { what: 'O2: severe tests passed as preregistered' },
  tokens: { lower: true, what: 'tokens, at least' },
  seconds: { lower: true, what: 'seconds' }
};

export interface ReferenceRun { readonly key: string; readonly journal: string; readonly journal_sha256: string; readonly finding_sha256: string | null; readonly values: Readonly<Record<string, number | null>> }
export interface Reference {
  readonly format: 'reference@1';
  readonly name: string;
  readonly frozen: string;
  readonly by: string;
  readonly group: { readonly condition: string; readonly world: string; readonly code_version: string | null; readonly generator: string };
  readonly from_batch: string;
  readonly runs: readonly ReferenceRun[];
  /** The hash of its runs (what it is): computed again, it must be the same. */
  readonly runs_sha256: string;
  readonly supersedes?: string;
  readonly compared_with_superseded?: readonly unknown[];
}

export const referenceFile = (root: string, name: string) => path.join(root, 'runs', 'references', name + '.json');

/** A run's key to pair it with another: its world, its world's options and its seed. */
function pairKey(journal: J): string {
  const lab = Object.values(LABS).find((l) => l.id === journal.experiment);
  return String(journal.experiment) + '|' + JSON.stringify(lab ? worldOptionsIn(lab.options, journal.config ?? {}) : {}) + '|seed ' + String(journal.config?.seed ?? '');
}

/** What a run's results are, as numbers to compare. */
function valuesOf(journalFile: string): Record<string, number | null> {
  const r = runResults(journalFile);
  return { o1: r.o1_predictive_acceptance.model ? 1 : 0, artifact: r.o1_predictive_acceptance.artifact === undefined ? null : r.o1_predictive_acceptance.artifact ? 1 : 0,
    o4: typeof r.o4_mechanistic_recovery === 'object' ? r.o4_mechanistic_recovery.score : null, severe: r.o2_discriminating_evidence.severe_passed_as_preregistered,
    tokens: r.cost.tokens.total_at_least, seconds: r.cost.seconds };
}

/** The runs of a batch's condition, as one group of comparable runs (by its generating configuration and code version). */
function groupOf(report: J, condition: string, generator?: string): { key: Reference['group']; journals: string[] } {
  const rows = (report.runs ?? []).filter((r: J) => r.condition === condition && r.journal && fs.existsSync(r.journal));
  if (!rows.length) throw new Error('no run of condition ' + condition + ' in batch ' + report.id);
  const byGroup = new Map<string, { key: Reference['group']; journals: string[] }>();
  for (const r of rows) {
    const j = readJson(r.journal)!;
    const key = { condition, world: String(j.experiment), code_version: j.commit ?? null, generator: generatorOf(j, path.dirname(r.journal), path.basename(r.journal, '.json')).id };
    const id = JSON.stringify(key);
    byGroup.set(id, { key, journals: [...(byGroup.get(id)?.journals ?? []), r.journal] });
  }
  const groups = [...byGroup.values()].filter((g) => !generator || g.key.generator === generator);
  if (groups.length !== 1) throw new Error('condition ' + condition + ' of batch ' + report.id + ' holds ' + groups.length + ' groups of comparable runs (by world, code version and generator): '
    + groups.map((g) => g.key.generator + ' ' + g.key.world + ' ' + String(g.key.code_version).slice(0, 10)).join('; ') + ' - name one with --generator');
  return groups[0];
}

/** Opens a reference: it, and whether it holds - its own hash, and its runs' journals where they still are. */
export function openReference(root: string, name: string): { reference: Reference; holds: boolean; problems: string[] } {
  const reference = readJson(referenceFile(root, name)) as Reference | null;
  if (!reference || reference.format !== 'reference@1') throw new Error('no reference ' + name + ' (runs/references/' + name + '.json)');
  const problems: string[] = [];
  if (sha(JSON.stringify(reference.runs)) !== reference.runs_sha256) problems.push('its runs are not the ones it was frozen with (its hash)');
  for (const r of reference.runs) {
    const at = path.resolve(root, r.journal);
    if (fs.existsSync(at) && sha(fs.readFileSync(at)) !== r.journal_sha256) problems.push(r.journal + ' changed since it was frozen');
  }
  return { reference, holds: !problems.length, problems };
}

/** Freezes the group of a batch's condition as a reference. */
export function freezeReference(root: string, batchFile: string, o: { condition: string; name: string; by: string; generator?: string; supersedes?: string }): Reference {
  if (!o.by?.trim() || /^agent:/i.test(o.by)) throw new Error('a reference is set by a person: --by "<who>" (never an agent)');
  if (!/^[a-z0-9][a-z0-9_.-]*$/i.test(o.name)) throw new Error('a reference\'s name: letters, digits, ., - and _');
  const file = referenceFile(root, o.name);
  if (fs.existsSync(file)) throw new Error('reference ' + o.name + ' exists: a reference is never replaced - freeze a new one, superseding it');
  const report = readJson(batchFile);
  if (!report || report.format !== 'batch@1') throw new Error(batchFile + ' is not a batch report');
  const group = groupOf(report, o.condition, o.generator);
  /* A new reference only after the comparison with the one it supersedes (§6.4): declared by its batch, and in its results. */
  let compared: unknown[] | undefined;
  if (o.supersedes) {
    openReference(root, o.supersedes);
    const found = (report.results?.comparisons ?? []).filter((c: J) => c.reference === o.supersedes && c.condition === o.condition);
    compared = found;
    if (!found.length) throw new Error('batch ' + report.id + ' was not compared with ' + o.supersedes + ' for ' + o.condition + ': declare the comparison in its definition ("compare") and compute its results first');
  }
  const runs: ReferenceRun[] = group.journals.map((j) => {
    const finding = j.replace(/\.json$/, '.finding.json');
    return { key: pairKey(readJson(j)!), journal: path.relative(root, j).split(path.sep).join('/'), journal_sha256: sha(fs.readFileSync(j)),
      finding_sha256: fs.existsSync(finding) ? sha(fs.readFileSync(finding)) : null, values: valuesOf(j) };
  });
  const reference: Reference = { format: 'reference@1', name: o.name, frozen: new Date().toISOString(), by: o.by.trim(), group: group.key,
    from_batch: path.relative(root, batchFile).split(path.sep).join('/'), runs, runs_sha256: sha(JSON.stringify(runs)),
    ...(o.supersedes ? { supersedes: o.supersedes, compared_with_superseded: compared } : {}) };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(reference, null, 2));
  try { fs.chmodSync(file, 0o444); } catch { /* the hash still tells a change */ }
  return reference;
}

export interface ComparisonDeclared { readonly reference: string; readonly condition: string; readonly metric: string; readonly margin: number; readonly relative?: boolean }

/** Whether the comparisons a batch declares can be made (checked before it runs). */
export function comparisonProblems(root: string, compare: unknown): string[] {
  if (compare === undefined) return [];
  if (!Array.isArray(compare)) return ['"compare": a list of { reference, condition, metric, margin }'];
  return compare.flatMap((c: J, i) => {
    const out: string[] = [];
    if (!c || typeof c.reference !== 'string' || typeof c.condition !== 'string') return ['compare ' + i + ': its reference and its condition'];
    if (!METRICS[c.metric]) out.push('compare ' + i + ': metric ' + JSON.stringify(c.metric) + ' (one of ' + Object.keys(METRICS).join(', ') + ')');
    if (typeof c.margin !== 'number' || !(c.margin > 0)) out.push('compare ' + i + ': a margin above zero, declared before - the least improvement that would matter');
    try { const r = openReference(root, c.reference); if (!r.holds) out.push('reference ' + c.reference + ' does not hold: ' + r.problems.join('; ')); }
    catch (e) { out.push(String((e as Error).message)); }
    return out;
  });
}

/* --- Two conditions of one batch, compared (K3, §4.3, §6.2.1): the effect of a senior, of an opening - only so ---------- */

export interface ConditionsDeclared { readonly a: string; readonly b: string; readonly metric: string; readonly margin: number; readonly relative?: boolean }

/** Whether the comparisons of conditions a batch declares can be made (checked before it runs). */
export function conditionComparisonProblems(conditions: readonly string[], compare: unknown): string[] {
  if (compare === undefined) return [];
  if (!Array.isArray(compare)) return ['"compare_conditions": a list of { a, b, metric, margin }'];
  return compare.flatMap((c: J, i) => [
    ...(!c || !conditions.includes(c.a) || !conditions.includes(c.b) || c.a === c.b ? ['compare_conditions ' + i + ': two conditions of this batch (' + conditions.join(', ') + ')'] : []),
    ...(!METRICS[c?.metric] ? ['compare_conditions ' + i + ': metric ' + JSON.stringify(c?.metric) + ' (one of ' + Object.keys(METRICS).join(', ') + ')'] : []),
    ...(typeof c?.margin !== 'number' || !(c.margin > 0) ? ['compare_conditions ' + i + ': a margin above zero, declared before'] : [])]);
}

/** What a run's budget was: its rounds and its limits (a comparison is controlled only with the same). */
const budgetOf = (journal: J): string => {
  const argv = (journal.argv ?? []) as string[];
  const at = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  return JSON.stringify({ attempts: journal.config?.attempts ?? null, max_tokens: at('--max-tokens'), max_minutes: at('--max-minutes') });
};

/** Condition b against condition a, paired by seed and world, as declared - and what was not held the same, said. */
export function compareConditions(report: J, c: ConditionsDeclared): Record<string, unknown> & { readonly comparison?: PairedComparison } {
  const m = METRICS[c.metric];
  const side = (condition: string) => {
    const journals = (report.runs ?? []).filter((r: J) => r.condition === condition && r.journal && fs.existsSync(r.journal)).map((r: J) => r.journal as string);
    const values = new Map<string, number>(), versions = new Set<string>(), budgets = new Set<string>();
    for (const j of journals) {
      const journal = readJson(j)!;
      versions.add(String(journal.commit ?? 'unknown'));
      budgets.add(budgetOf(journal));
      const v = valuesOf(j)[c.metric];
      if (typeof v === 'number') values.set(pairKey(journal), v);
    }
    return { values, versions, budgets };
  };
  const a = side(c.a), b = side(c.b);
  const same = (x: Set<string>, y: Set<string>) => x.size === 1 && y.size === 1 && [...x][0] === [...y][0];
  const notControlled = [...(same(a.versions, b.versions) ? [] : ['the code version']), ...(same(a.budgets, b.budgets) ? [] : ['the budget'])];
  return { a: c.a, b: c.b, metric: c.metric, what: m.what + ', ' + c.b + ' against ' + c.a,
    ...(notControlled.length ? { not_controlled: notControlled, reading: 'the conditions differ in more than what they stand for: the effect is not theirs alone' } : {}),
    unpaired: { in_a: [...a.values.keys()].filter((k) => !b.values.has(k)).length, in_b: [...b.values.keys()].filter((k) => !a.values.has(k)).length },
    comparison: pairedComparison(a.values, b.values, { margin: c.margin, ...(m.binary ? { binary: true } : {}), ...(m.lower ? { lower: true } : {}), ...(c.relative ? { relative: true } : {}) }) };
}

/** A batch's condition compared with a reference, paired by seed, as declared (§6.2.1, §6.4). */
export function compareWithReference(root: string, report: J, c: ComparisonDeclared): Record<string, unknown> & { readonly comparison?: PairedComparison } {
  const opened = openReference(root, c.reference);
  if (!opened.holds) return { reference: c.reference, condition: c.condition, metric: c.metric, refused: 'the reference does not hold: ' + opened.problems.join('; ') };
  const m = METRICS[c.metric];
  let group: ReturnType<typeof groupOf>;
  try { group = groupOf(report, c.condition); } catch (e) { return { reference: c.reference, condition: c.condition, metric: c.metric, refused: String((e as Error).message) }; }
  const before = new Map<string, number>(), now = new Map<string, number>();
  for (const r of opened.reference.runs) if (typeof r.values[c.metric] === 'number') before.set(r.key, r.values[c.metric] as number);
  for (const j of group.journals) { const v = valuesOf(j)[c.metric]; if (typeof v === 'number') now.set(pairKey(readJson(j)!), v); }
  const ref = opened.reference.group;
  return { reference: c.reference, condition: c.condition, metric: c.metric, what: m.what,
    /* What differs between the two groups besides what is compared: the version is the point; anything else is said. */
    groups: { reference: ref, now: group.key, differ_in: (['world', 'code_version', 'generator'] as const).filter((k) => ref[k] !== group.key[k]) },
    unpaired: { in_reference: [...before.keys()].filter((k) => !now.has(k)).length, now: [...now.keys()].filter((k) => !before.has(k)).length },
    comparison: pairedComparison(before, now, { margin: c.margin, ...(m.binary ? { binary: true } : {}), ...(m.lower ? { lower: true } : {}), ...(c.relative ? { relative: true } : {}) }) };
}
