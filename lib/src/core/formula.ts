import { clamp, hashString, round, stableStringify } from './hash.ts';
import { FORMULA_FORMAT, FORMULA_FORMAT_VERSION } from './types.ts';
import type { Formula, MeasureDecl, MeasureSpec, Rule } from './types.ts';

/* ============================================================================
 * The Formula artifact: formula = { O(s), r_i, w_i }.
 *   V(s) = SUM_i w_i * r_i(O(s))
 * Identity is semantic: `meta` (version, rationale, source) never changes a hash.
 * ========================================================================== */

export function valueRuleIds(formula: Pick<Formula, 'rules'>): string[] {
  return Object.keys(formula.rules || {}).filter((id) => formula.rules[id].used_as !== 'policy');
}

export function policyRuleIds(formula: Pick<Formula, 'rules'>): string[] {
  return Object.keys(formula.rules || {}).filter((id) => formula.rules[id].used_as === 'policy');
}

function observationProgram(observations: Formula['observations']): Record<string, { spec: MeasureSpec | null; range: readonly [number, number] | null }> {
  const program: Record<string, { spec: MeasureSpec | null; range: readonly [number, number] | null }> = {};
  for (const id of Object.keys(observations || {}).sort()) {
    const d = observations[id] || ({} as MeasureDecl);
    program[id] = { spec: d.spec ?? null, range: d.range ?? null };
  }
  return program;
}

/** Everything that changes V(s). */
export function formulaHash(formula: Formula): string {
  return hashString(stableStringify({
    format: formula.format, format_version: formula.format_version, world: formula.world,
    observations: observationProgram(formula.observations),
    rules: formula.rules, weights: formula.weights,
    policy_weights: formula.policy_weights ?? {}, confidence_floor: formula.confidence_floor ?? null,
    ...(formula.output ? { output: formula.output } : {})
  }));
}

/** Everything that changes what the Judge is ASKED (weights excluded: answers are reusable across them). */
export function judgmentHash(formula: Formula): string {
  return hashString(stableStringify({
    world: formula.world, observations: observationProgram(formula.observations), rules: formula.rules
  }));
}

/* --- Rules read measured facts ------------------------------------------- */

const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;

export function placeholdersOf(rule: Rule): string[] {
  const texts = [rule.instructions, ...(Array.isArray(rule.criteria) ? rule.criteria : Object.values(rule.criteria || {}))];
  const found = new Set<string>();
  for (const text of texts) {
    if (typeof text !== 'string') continue;
    for (const m of text.matchAll(PLACEHOLDER)) found.add(m[1]);
  }
  return [...found];
}

/** {{id}} becomes the measured number; an unknown placeholder stays visible (never silently deleted). */
export function substitute(text: string, values: Readonly<Record<string, number | string>>): string {
  if (typeof text !== 'string' || !text.includes('{{')) return text;
  return text.replace(PLACEHOLDER, (whole, id: string) => Object.prototype.hasOwnProperty.call(values, id) ? String(values[id]) : whole);
}

export function materializeRules(rules: Formula['rules'], values: Readonly<Record<string, number | string>>, ids?: readonly string[]): Record<string, Rule> {
  const out: Record<string, Rule> = {};
  for (const id of ids ?? Object.keys(rules || {})) {
    const r = rules[id];
    const criteria = Array.isArray(r.criteria)
      ? r.criteria.map((c) => substitute(c, values))
      : Object.fromEntries(Object.entries(r.criteria || {}).map(([k, c]) => [k, c == null ? c : substitute(c, values)]));
    out[id] = { ...r, instructions: substitute(r.instructions, values), criteria };
  }
  return out;
}

/* --- Composition (code owns it) ------------------------------------------ */

export interface Composition {
  readonly value: number;
  /** Rules without a usable answer: composed as a neutral 0.5 and COUNTED, never hidden. */
  readonly fallbacks: readonly string[];
}

export function compose(answers: Readonly<Record<string, number | undefined>>, weights: Readonly<Record<string, number>>): Composition {
  let value = 0;
  const fallbacks: string[] = [];
  for (const id of Object.keys(weights || {})) {
    const w = weights[id];
    const weight = typeof w === 'number' && Number.isFinite(w) ? w : 0;
    const a = answers[id];
    const answered = typeof a === 'number' && Number.isFinite(a);
    if (!answered) fallbacks.push(id);
    value += weight * (answered ? clamp(a, 0, 1) : 0.5);
  }
  return { value: clamp(value, 0, 1), fallbacks };
}

/** Non-negative weights over the value rules, normalised to sum 1 (4 decimals, as the harness). */
export function normalizeWeights(raw: Readonly<Record<string, unknown>>, ruleIds: readonly string[]): { weights: Record<string, number>; warnings: string[] } {
  const warnings: string[] = [];
  const weights: Record<string, number> = {};
  let sum = 0;
  for (const id of ruleIds) {
    const v = raw ? raw[id] : undefined;
    const w = typeof v === 'number' && Number.isFinite(v) ? clamp(v, 0, 1) : 0;
    if (v !== undefined && w !== v) warnings.push('weight "' + id + '" set to ' + w);
    weights[id] = w;
    sum += w;
  }
  for (const id of Object.keys(raw || {})) if (!ruleIds.includes(id)) warnings.push('weight "' + id + '" ignored: no such value rule');
  if (sum <= 0) {
    warnings.push('all weights were zero: equal shares');
    for (const id of ruleIds) weights[id] = round(1 / ruleIds.length, 4);
    return { weights, warnings };
  }
  for (const id of ruleIds) weights[id] = round(weights[id] / sum, 4);
  return { weights, warnings };
}

/* --- Validation ----------------------------------------------------------- */

export interface FormulaCheck {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

/** Structural gate: a formula must observe at least one fact and judge through at least one value rule,
    and every placeholder must name a declared observation. (Executability is the Observer's job.) */
export function checkFormula(formula: Formula): FormulaCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (formula.format !== FORMULA_FORMAT) errors.push('format must be "' + FORMULA_FORMAT + '"');
  if (!formula.world) errors.push('world is required');
  const obsIds = Object.keys(formula.observations || {});
  if (!obsIds.length) errors.push('a formula must observe at least one fact');
  const values = valueRuleIds(formula);
  if (!values.length && !formula.output) errors.push('a formula needs at least one VALUE rule, or an output (otherwise its answer is constant)');
  if (formula.output && (formula.output.kind !== 'code' || !String(formula.output.source ?? '').trim())) errors.push('output needs code: (p, m) => answer');
  for (const id of Object.keys(formula.rules || {})) {
    const missing = placeholdersOf(formula.rules[id]).filter((p) => !obsIds.includes(p));
    if (missing.length) errors.push('rule "' + id + '" references undeclared observation(s): ' + missing.join(', '));
  }
  /* A sense feeds the code, never the Judge; a text (a code measure without a range) reaches the Judge's context
     whether a rule cites it or not; a number needs a rule that reads it. */
  const unread = obsIds.filter((o) => {
    const decl = formula.observations[o];
    const kind = (decl?.spec as { kind?: string } | undefined)?.kind;
    return kind !== 'sense' && !(kind === 'code' && !decl?.range) && !Object.values(formula.rules || {}).some((r) => placeholdersOf(r).includes(o));
  });
  if (unread.length) warnings.push('observation(s) no rule reads: ' + unread.join(', '));
  for (const id of Object.keys(formula.weights || {})) if (!values.includes(id)) errors.push('weight "' + id + '" has no value rule');
  return { ok: errors.length === 0, errors, warnings };
}

export function makeFormula(parts: Omit<Formula, 'format' | 'format_version'>): Formula {
  return { format: FORMULA_FORMAT, format_version: FORMULA_FORMAT_VERSION, ...parts };
}
