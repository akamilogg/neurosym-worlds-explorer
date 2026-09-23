import { clamp, cloneJson, round, stableStringify } from '../core/hash.ts';
import { policyRuleIds, valueRuleIds } from '../core/formula.ts';
import type { Formula, Rule } from '../core/types.ts';

/* ============================================================================
 * The algebra of learning: what changed between two formulas, and which of those
 * changes can be applied without playing a game.
 *
 * Learning is defined as a change in an EVALUABLE field - what is measured (the
 * observations' executable spec), what the Judge is asked (a rule's wording, rubric,
 * type, role), or how answers compose (weights, policy weights, confidence floor).
 * Prose (rationale, names, definitions) never counts: a reply that only rewrites
 * prose changed nothing the Judge can judge.
 *
 * The kind strings ("weights", "battery.instructions:<id>", "observations.added:<id>")
 * are the vocabulary the proposer, the judges and the journal already speak.
 * ========================================================================== */

/** Rule fields whose change is learning (besides instructions and criteria). */
export const EVALUATED_RULE_FIELDS = ['type', 'used_as', 'option', 'options_from', 'subject', 'aggregate'] as const;
/** The only fields a replay can MEASURE; everything else is judged by playing games. */
export const NARROWABLE_KINDS = ['weights', 'policy_weights', 'confidence_floor'] as const;

export type FormulaChanges = Record<string, string[] | true>;

const json = (v: unknown): string => JSON.stringify(v === undefined ? null : v);
const rulesOf = (f: Formula | null | undefined): Readonly<Record<string, Rule>> => (f && f.rules) || {};
const observationsOf = (f: Formula | null | undefined) => (f && f.observations && typeof f.observations === 'object' && !Array.isArray(f.observations)) ? f.observations : {};

export function versionOf(f: Formula | null | undefined): number | undefined {
  const v = f?.meta?.version;
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function diffFormulas(before: Formula, after: Formula): FormulaChanges {
  const rulesBefore = rulesOf(before);
  const rulesAfter = rulesOf(after);
  const changes: FormulaChanges = {};
  const push = (key: string, id: string): void => { ((changes[key] as string[]) || (changes[key] = [])).push(id); };
  for (const id of Object.keys(rulesAfter)) {
    const a = rulesBefore[id];
    const b = rulesAfter[id] || ({} as Rule);
    if (!a) { push('added', id); continue; }
    const moved: string[] = [];
    for (const field of EVALUATED_RULE_FIELDS) if (json(a[field]) !== json(b[field])) moved.push(field);
    if (String(a.instructions || '') !== String(b.instructions || '')) moved.push('instructions');
    if (JSON.stringify(a.criteria || {}) !== JSON.stringify(b.criteria || {})) moved.push('criteria');
    if (moved.length) changes[id] = moved;
  }
  for (const id of Object.keys(rulesBefore)) if (!rulesAfter[id]) push('removed', id);
  if (JSON.stringify(before.weights || {}) !== JSON.stringify(after.weights || {})) changes.weights = true;
  if (JSON.stringify(before.policy_weights || {}) !== JSON.stringify(after.policy_weights || {})) changes.policy_weights = true;
  if (before.confidence_floor !== after.confidence_floor) changes.confidence_floor = true;
  /* Observations: only the executable spec counts (names and definitions are documentation). */
  const obsBefore = observationsOf(before);
  const obsAfter = observationsOf(after);
  const specText = (decl: { spec?: unknown } | undefined): string => stableStringify({ spec: decl?.spec === undefined ? null : decl.spec });
  for (const id of Object.keys(obsAfter)) {
    if (!Object.prototype.hasOwnProperty.call(obsBefore, id)) push('obs_added', id);
    else if (specText(obsAfter[id]) !== specText(obsBefore[id])) push('obs_changed', id);
  }
  for (const id of Object.keys(obsBefore)) if (!Object.prototype.hasOwnProperty.call(obsAfter, id)) push('obs_removed', id);
  return changes;
}

export function changeKinds(changes: FormulaChanges): string[] {
  const kinds: string[] = [];
  for (const key of Object.keys(changes || {})) {
    const value = changes[key];
    if (key === 'added') kinds.push('battery.added:' + (value as string[]).join('|'));
    else if (key === 'removed') kinds.push('battery.removed:' + (value as string[]).join('|'));
    else if (key === 'weights' || key === 'policy_weights' || key === 'confidence_floor') kinds.push(key);
    else if (key === 'obs_added') kinds.push('observations.added:' + (value as string[]).join('|'));
    else if (key === 'obs_removed') kinds.push('observations.removed:' + (value as string[]).join('|'));
    else if (key === 'obs_changed') kinds.push('observations.changed:' + (value as string[]).join('|'));
    else kinds.push('battery.' + (value as string[]).join('+') + ':' + key);
  }
  return kinds;
}

export function hasEvaluableChange(before: Formula, after: Formula): boolean {
  return changeKinds(diffFormulas(before, after)).length > 0;
}

/* --- Human-readable delta ---------------------------------------------------- */

export function shortenText(value: unknown, max: number): string {
  const text = String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1) + '~' : text;
}

function describeCriteriaDelta(before: unknown, after: unknown): string {
  const a = (before || {}) as Record<string, unknown>;
  const b = (after || {}) as Record<string, unknown>;
  if (Array.isArray(a) || Array.isArray(b)) return 'levels ' + (Array.isArray(a) ? a.length : 0) + ' -> ' + (Array.isArray(b) ? b.length : 0);
  const keys = Object.keys(b).filter((k) => String(a[k]) !== String(b[k]));
  return keys.length ? 'rewrote ' + keys.join('/') : 'shape only';
}

export function describeWeightsDelta(before: Readonly<Record<string, number>> | undefined, after: Readonly<Record<string, number>> | undefined): string {
  const a = before || {};
  const b = after || {};
  const ids = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  return ids.map((id) => id + ' ' + (Number.isFinite(a[id]) ? a[id] : 0) + '->' + (Number.isFinite(b[id]) ? b[id] : 0)).join(', ');
}

export function describeChange(before: Formula, after: Formula): string {
  const changes = diffFormulas(before, after);
  const kinds = changeKinds(changes);
  if (!kinds.length) return 'no evaluable change (prose/rationale only)';
  const rulesBefore = rulesOf(before);
  const rulesAfter = rulesOf(after);
  const obsBefore = observationsOf(before) as Record<string, { spec?: { op?: string }; range?: unknown }>;
  const obsAfter = observationsOf(after) as Record<string, { spec?: { op?: string }; range?: unknown }>;
  const details: string[] = [];
  const obsDelta = (id: string, kind: string): string => {
    const ao = obsBefore[id]?.spec?.op || '?';
    const bo = obsAfter[id]?.spec?.op || '?';
    if (kind === 'obs_added') return 'observation ' + id + ' declared (' + bo + ', range ' + JSON.stringify(obsAfter[id]?.range || null) + ')';
    if (kind === 'obs_removed') return 'observation ' + id + ' removed (was ' + ao + ')';
    return 'observation ' + id + ' re-specified (' + ao + ' -> ' + bo + ')';
  };
  for (const key of Object.keys(changes)) {
    if (key === 'obs_added' || key === 'obs_removed' || key === 'obs_changed') { for (const id of changes[key] as string[]) details.push(obsDelta(id, key)); continue; }
    if (key === 'weights' || key === 'policy_weights' || key === 'confidence_floor' || key === 'added' || key === 'removed') continue;
    const a = rulesBefore[key] || ({} as Rule);
    const b = rulesAfter[key] || ({} as Rule);
    for (const field of changes[key] as string[]) {
      if (field === 'instructions') details.push(key + '.instructions: "' + shortenText(a.instructions, 70) + '" -> "' + shortenText(b.instructions, 70) + '"');
      else if (field === 'criteria') details.push(key + '.criteria rewritten (' + describeCriteriaDelta(a.criteria, b.criteria) + ')');
      else details.push(key + '.' + field + ': ' + String(a[field]) + ' -> ' + String(b[field]));
    }
  }
  if (changes.added) details.push('new question(s): ' + (changes.added as string[]).join(', '));
  if (changes.removed) details.push('removed question(s): ' + (changes.removed as string[]).join(', '));
  if (changes.weights) details.push('weights: ' + describeWeightsDelta(before.weights, after.weights));
  if (changes.policy_weights) {
    details.push('policy_weights (the merge between policy questions): ' + describeWeightsDelta(before.policy_weights || {}, after.policy_weights || {}));
  }
  if (changes.confidence_floor) details.push('confidence_floor: ' + before.confidence_floor + ' -> ' + after.confidence_floor);
  return kinds.join(', ') + ' [' + details.join(' | ') + ']';
}

/* --- The typed diff a judge reads --------------------------------------------- */

export interface DiffField {
  readonly kind: string;
  readonly id: string | null;
  readonly from: unknown;
  readonly to: unknown;
}

export interface FormulaDiff {
  readonly from_version: number | undefined;
  readonly to_version: number | undefined;
  readonly kinds: string[];
  readonly fields: DiffField[];
  readonly narrowable: string[];
  readonly summary: string;
}

export function toFormulaDiff(before: Formula, after: Formula): FormulaDiff {
  const changes = diffFormulas(before, after);
  const kinds = changeKinds(changes);
  const rulesBefore = rulesOf(before);
  const rulesAfter = rulesOf(after);
  const fields: DiffField[] = [];
  for (const key of Object.keys(changes)) {
    if (key === 'weights' || key === 'policy_weights' || key === 'confidence_floor') { fields.push({ kind: key, id: null, from: null, to: null }); continue; }
    if (key === 'added' || key === 'removed') {
      for (const id of changes[key] as string[]) {
        fields.push({ kind: key, id, from: key === 'added' ? null : (rulesBefore[id] || null), to: key === 'removed' ? null : (rulesAfter[id] || null) });
      }
      continue;
    }
    if (key === 'obs_added' || key === 'obs_removed' || key === 'obs_changed') {
      for (const id of changes[key] as string[]) {
        fields.push({ kind: key, id, from: key === 'obs_added' ? null : (observationsOf(before)[id] || null),
          to: key === 'obs_removed' ? null : (observationsOf(after)[id] || null) });
      }
      continue;
    }
    for (const field of changes[key] as string[]) {
      const a = (rulesBefore[key] || {}) as Record<string, unknown>;
      const b = (rulesAfter[key] || {}) as Record<string, unknown>;
      fields.push({ kind: field, id: key, from: a[field] === undefined ? null : a[field], to: b[field] === undefined ? null : b[field] });
    }
  }
  return {
    from_version: versionOf(before),
    to_version: versionOf(after),
    kinds,
    fields,
    narrowable: kinds.filter((k) => (NARROWABLE_KINDS as readonly string[]).includes(k)),
    summary: describeChange(before, after)
  };
}

/* --- Weights, settled over a declared set of rules ------------------------------ */

const equalShares = (ids: readonly string[]): Record<string, number> =>
  Object.fromEntries(ids.map((id) => [id, round(1 / ids.length, 4)]));

/** Value weights over `ids`: clipped to [0,1]; a missing weight KEEPS the fallback's; renormalised to sum 1.
    A weight naming a policy rule or an undeclared rule is reported and dropped (it would compose as a ghost). */
export function settleWeights(raw: unknown, fallbackWeights: Readonly<Record<string, number>> | null, ids: readonly string[], policyIds: readonly string[] = []):
  { weights: Record<string, number>; warnings: string[] } {
  const keys = ids.length ? ids.slice() : Object.keys(fallbackWeights || {});
  const fallback = fallbackWeights || equalShares(keys);
  const warnings: string[] = [];
  const candidate = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  if (!candidate) {
    warnings.push('Weights were not a JSON object; kept the previous vector.');
    return { weights: { ...fallback }, warnings };
  }
  const weights: Record<string, number> = {};
  let sum = 0;
  for (const key of keys) {
    const value = candidate[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      const clipped = clamp(value, 0, 1);
      if (clipped !== value) warnings.push('Weight "' + key + '" clipped to ' + clipped + '.');
      weights[key] = clipped;
    } else {
      const f = fallback[key];
      weights[key] = typeof f === 'number' && Number.isFinite(f) ? f : 0;
      if (value !== undefined) warnings.push('Weight "' + key + '" was not numeric; kept ' + weights[key] + '.');
    }
    sum += weights[key];
  }
  for (const key of Object.keys(candidate)) {
    if (keys.includes(key)) continue;
    if (policyIds.includes(key)) warnings.push('Weight "' + key + '" ignored: a policy question never enters V(s); its merge weight belongs in "policyWeights".');
    else warnings.push('Weight "' + key + '" ignored: the battery declares no such question.');
  }
  if (sum <= 0) {
    warnings.push('All weights were zero; reverted to the neutral vector.');
    return { weights: { ...fallback }, warnings };
  }
  for (const key of keys) weights[key] = round(weights[key] / sum, 4);
  return { weights, warnings };
}

/** Policy-merge weights over `policyIds`: missing ids keep the fallback's (or an equal share); zeros revert to equal. */
export function settlePolicyWeights(raw: unknown, policyIds: readonly string[], fallbackWeights?: Readonly<Record<string, number>>):
  { policyWeights: Record<string, number>; warnings: string[] } {
  const ids = policyIds || [];
  const fallback = fallbackWeights || {};
  const warnings: string[] = [];
  if (!ids.length) return { policyWeights: {}, warnings };
  const candidate = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  if (!candidate) {
    const kept = Object.keys(fallback).length ? { ...fallback } : equalShares(ids);
    if (raw !== undefined) warnings.push('policyWeights was not a JSON object; kept ' + (Object.keys(fallback).length ? 'the previous vector.' : 'an equal share.'));
    return { policyWeights: kept, warnings };
  }
  const weights: Record<string, number> = {};
  let sum = 0;
  for (const id of ids) {
    const value = candidate[id];
    if (typeof value === 'number' && Number.isFinite(value)) {
      const clipped = clamp(value, 0, 1);
      if (clipped !== value) warnings.push('policyWeights "' + id + '" clipped to ' + clipped + '.');
      weights[id] = clipped;
    } else weights[id] = typeof fallback[id] === 'number' ? fallback[id] : round(1 / ids.length, 4);
    sum += weights[id];
  }
  for (const key of Object.keys(candidate)) if (!ids.includes(key)) warnings.push('policyWeights "' + key + '" ignored: it is not a declared policy question.');
  if (sum <= 0) {
    warnings.push('Every policy weight was zero; reverted to an equal share.');
    return { policyWeights: equalShares(ids), warnings };
  }
  for (const id of ids) weights[id] = round(weights[id] / sum, 4);
  return { policyWeights: weights, warnings };
}

/* --- The narrow verdict --------------------------------------------------------- */

/** The next version, floored at everything the run's ledger has carried: versions are the learner's
    bookkeeping, never the proposer's claim, and a history that goes backwards is unreadable. */
export function nextVersion(previousVersion: number | undefined, ledgerVersions: readonly (number | undefined)[] = []): number {
  let max = typeof previousVersion === 'number' && Number.isFinite(previousVersion) ? previousVersion : 0;
  for (const v of ledgerVersions) if (typeof v === 'number' && Number.isFinite(v) && v > max) max = v;
  return max + 1;
}

/** Keep the previous formula and move ONLY the fields a replay can measure (weights, policy weights, floor),
    re-settled over the CONSERVED rules so a weight naming a rule that no longer exists is dropped, never kept
    as a ghost. Returns null when none of `kinds` is narrowable. */
export function narrowFormula(previous: Formula, candidate: Formula, kinds: readonly string[], ledgerVersions: readonly (number | undefined)[] = []):
  Formula | null {
  const usable = (kinds || []).filter((k) => (NARROWABLE_KINDS as readonly string[]).includes(k));
  if (!usable.length) return null;
  const narrowed = cloneJson(previous) as { -readonly [K in keyof Formula]: Formula[K] };
  const settledWarnings: string[] = [];
  if (usable.includes('weights')) {
    const settled = settleWeights(candidate.weights, previous.weights, valueRuleIds(previous), policyRuleIds(previous));
    narrowed.weights = settled.weights;
    settledWarnings.push(...settled.warnings);
  }
  if (usable.includes('policy_weights')) {
    const settled = settlePolicyWeights(candidate.policy_weights, policyRuleIds(previous), previous.policy_weights);
    narrowed.policy_weights = settled.policyWeights;
    settledWarnings.push(...settled.warnings);
  }
  if (usable.includes('confidence_floor')) narrowed.confidence_floor = candidate.confidence_floor;
  const candidateWarnings = Array.isArray(candidate.meta?.warnings) ? candidate.meta!.warnings as string[] : [];
  narrowed.meta = {
    ...(previous.meta || {}),
    version: nextVersion(versionOf(previous), ledgerVersions),
    source: 'llm-narrowed',
    rationale: candidate.meta?.rationale,
    evidence: candidate.meta?.evidence ?? null,
    warnings: candidateWarnings.concat(settledWarnings),
    narrowed_from: usable.slice()
  };
  return narrowed;
}
