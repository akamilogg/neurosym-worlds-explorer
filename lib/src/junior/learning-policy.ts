import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { stableStringify } from '../core/hash.ts';
import { checkPolicy, type PolicyConfig, type ResearchPolicy } from '../learn/assisted/research-policy.ts';
import { promote, measure, type CompetenceManifest, type Promotion } from './competence.ts';
import type { Evaluation } from './evaluate.ts';

/* ============================================================================
 * The procedure of learning, an artifact of its own (SPEC-METAPOLITICA-APRENDIZAJE §14.1, MA7): learning-policy@1, a
 * readable procedure that advises the strong researcher of the junior's world. It reuses M1 to decide and the channel of
 * advice to deliver: it never acts nor trains by itself.
 *
 *   policy               a research-policy@1: observations, rules, composition, initial state and templates
 *   procedures           id -> instructions (UTF-8 text, its full SHA-256 written with it)
 *   template_procedures  template -> the ordered ids of the procedures that go with its advice
 *   scope                the worlds, capabilities and instruments it needs
 *   provenance           parents, authorship (a recipe written by the teacher keeps that authorship), what motivated it
 *   evaluations          references to evaluations of it - never a self-evaluation as a verdict
 *
 * EXPANDED before M1 starts (expansion@1): each template is its text and its procedures, in the order declared, joined
 * by two newlines. No recursive inclusion, no file read while deciding, no recipe executed. A procedure's {{parameters}}
 * must be declared among its template's arguments; the result must pass research-policy@1's own check. A missing id, a
 * hash that does not match, an undeclared argument invalidate the package - a procedure is never dropped silently. The
 * trial's configuration fixes M1's context and limits and the largest advice: an expansion past it is refused, never cut.
 * Kept: the package as given, the policy expanded, the configuration in effect; its execution hash covers all of it.
 * ========================================================================== */

export const LEARNING_POLICY = 'learning-policy@1';
export const EXPANSION = 'expansion@1';

export interface LearningPolicy {
  readonly format: typeof LEARNING_POLICY;
  readonly id: string;
  readonly policy: ResearchPolicy;
  readonly procedures: Readonly<Record<string, { readonly text: string; readonly sha256: string }>>;
  readonly template_procedures: Readonly<Record<string, readonly string[]>>;
  readonly scope: { readonly worlds: readonly string[]; readonly capabilities?: readonly string[]; readonly instruments?: readonly string[] };
  readonly provenance?: Readonly<Record<string, unknown>>;
  readonly evaluations?: readonly unknown[];
}

export interface ExpansionConfig {
  readonly context?: PolicyConfig['context'];
  readonly limits?: PolicyConfig['limits'];
  /** The largest advice it may deliver, in characters: a template expanded past it is refused. */
  readonly max_advice_chars: number;
}

export interface Expanded {
  readonly format: 'learning-policy-expanded@1';
  readonly algorithm: typeof EXPANSION;
  /** The package as it was given (its hash), and itself. */
  readonly original: string;
  readonly package: LearningPolicy;
  /** What M1 runs: the research policy expanded, with the configuration in effect. */
  readonly config: PolicyConfig;
  readonly max_advice_chars: number;
  /** Everything that changes its behaviour: the policy expanded, the configuration, the scope, the algorithm. */
  readonly execution: string;
}

const sha = (v: string): string => createHash('sha256').update(v, 'utf8').digest('hex');
const params = (text: string): string[] => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);

/** Everything wrong with a package; empty: it may be expanded. */
export function learningPolicyProblems(raw: unknown): string[] {
  const p = raw as LearningPolicy;
  if (!p || p.format !== LEARNING_POLICY) return ['"format": "' + LEARNING_POLICY + '"'];
  const e: string[] = [];
  if (typeof p.id !== 'string' || !/^[\w.-]+$/.test(p.id)) e.push('"id": letters, digits, dots and dashes');
  e.push(...checkPolicy(p.policy).map((x) => 'policy: ' + x));
  if (!p.procedures || typeof p.procedures !== 'object') e.push('"procedures": {"<id>": {"text": "...", "sha256": "..."}}');
  for (const [id, pr] of Object.entries(p.procedures ?? {})) {
    if (typeof pr?.text !== 'string') { e.push('procedure ' + id + ': its "text"'); continue; }
    if (pr.sha256 !== sha(pr.text)) e.push('procedure ' + id + ': its text does not match its sha256');
  }
  const templates = (p.policy?.templates ?? {}) as ResearchPolicy['templates'];
  for (const [t, ids] of Object.entries(p.template_procedures ?? {})) {
    if (!templates[t]) { e.push('template_procedures: no template ' + t); continue; }
    if (!Array.isArray(ids)) { e.push('template_procedures.' + t + ': a list of procedure ids'); continue; }
    const declared = new Set(templates[t].arguments ?? []);
    for (const id of ids) {
      const pr = p.procedures?.[id];
      if (!pr) { e.push('template ' + t + ' names a procedure that is not there: ' + id); continue; }
      for (const k of params(pr.text)) if (!declared.has(k)) e.push('procedure ' + id + ' uses {{' + k + '}}, which template ' + t + ' does not declare');
    }
  }
  if (!p.scope || !Array.isArray(p.scope.worlds) || !p.scope.worlds.length) e.push('"scope": {"worlds": [...]} where it may be used');
  return e;
}

/** Whether a package may be used in a world with these capabilities and instruments: what its scope needs and lacks. */
export function scopeProblems(p: LearningPolicy, world: { id: string; capabilities?: readonly string[]; instruments?: readonly string[] }): string[] {
  const e: string[] = [];
  if (!p.scope.worlds.includes(world.id)) e.push('its scope is ' + p.scope.worlds.join(', ') + ', not ' + world.id);
  for (const c of p.scope.capabilities ?? []) if (!(world.capabilities ?? []).includes(c)) e.push('it needs the capability ' + c);
  for (const i of p.scope.instruments ?? []) if (!(world.instruments ?? []).includes(i)) e.push('it needs the instrument ' + i);
  return e;
}

/** The package expanded for M1 (expansion@1), or why not. */
export function expandLearningPolicy(raw: unknown, config: ExpansionConfig): Expanded | { errors: string[] } {
  const errors = learningPolicyProblems(raw);
  if (!(config.max_advice_chars > 0)) errors.push('the configuration fixes max_advice_chars');
  if (errors.length) return { errors };
  const p = raw as LearningPolicy;
  const templates: Record<string, ResearchPolicy['templates'][string]> = {};
  for (const [id, t] of Object.entries(p.policy.templates)) {
    const text = [t.text, ...(p.template_procedures[id] ?? []).map((pid) => p.procedures[pid].text)].join('\n\n');
    /* The static part of an advice: past the largest advice, refused - never cut. */
    const fixed = text.replace(/\{\{\w+\}\}/g, '');
    if (fixed.length > config.max_advice_chars) errors.push('template ' + id + ' expands to ' + fixed.length + ' characters, past the largest advice (' + config.max_advice_chars + ')');
    templates[id] = { ...t, text };
  }
  const policy: ResearchPolicy = { ...p.policy, templates };
  errors.push(...checkPolicy(policy).map((x) => 'expanded: ' + x));
  if (errors.length) return { errors };
  const cfg: PolicyConfig = { policy, ...(config.context ? { context: config.context } : {}), ...(config.limits ? { limits: config.limits } : {}) };
  const execution = sha(stableStringify({ policy, context: cfg.context ?? null, limits: cfg.limits ?? null, max_advice_chars: config.max_advice_chars, scope: p.scope, algorithm: EXPANSION }));
  return { format: 'learning-policy-expanded@1', algorithm: EXPANSION, original: sha(stableStringify(p)), package: p, config: cfg, max_advice_chars: config.max_advice_chars, execution };
}

/** An expansion written where a run reads it: the PolicyConfig M1 runs (`--research-policy`), and its record beside. */
export function writeExpansion(x: Expanded, dir: string): { policy: string; record: string } {
  fs.mkdirSync(dir, { recursive: true });
  const policy = path.join(dir, 'learning-policy.' + x.execution.slice(0, 16) + '.policy.json');
  const record = path.join(dir, 'learning-policy.' + x.execution.slice(0, 16) + '.expanded.json');
  fs.writeFileSync(policy, JSON.stringify(x.config, null, 2));
  fs.writeFileSync(record, JSON.stringify(x, null, 2));
  return { policy, record };
}

/** The packages of a folder that may be used in a world: valid, in scope, each by its id and file. The operator's choice
    among them is the operator's (or a meta-policy's), never this listing's. */
export function catalog(dir: string, world: Parameters<typeof scopeProblems>[1]): { id: string; file: string; usable: boolean; why: string[] }[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().flatMap((f) => {
    let p: LearningPolicy;
    try { p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return []; }
    if (p?.format !== LEARNING_POLICY) return [];
    const why = [...learningPolicyProblems(p), ...(learningPolicyProblems(p).length ? [] : scopeProblems(p, world))];
    return [{ id: p.id, file: path.join(dir, f), usable: !why.length, why }];
  });
}

/* --- Comparing improvement investigations (§14.2) ------------------------------------------------------------------ */

/** One improvement investigation under a condition: the junior it produced (its last promoted, or its start junior when
    none was) with that junior's evaluation, and what the whole investigation cost. */
export interface Improvement {
  readonly condition: string;
  readonly state: 'ended' | 'interrupted';
  readonly product: string;
  readonly evaluation: Evaluation;
  readonly cost: Readonly<Record<string, number>>;
}

/** The product of an investigation of the junior's world from its journal (§14.2): the last version its artifact
    protocol accepted (promoted by paired-cases@1 against the reference), or its start (the reference) when none was;
    whether it ended by its budget or was interrupted. Recorded at its close - never another descendant chosen afterwards. */
export function productOf(journalFile: string, reference: string): { product: string; state: 'ended' | 'interrupted' } {
  const j = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
  const events = (j.events ?? []) as Record<string, any>[];
  let product = reference;
  for (const e of events) if (e.type === 'artifact_accepted' && typeof e.version === 'string') product = e.version;
  const end = [...events].reverse().find((e) => e.type === 'end');
  const stopped = String(end?.stoppedBy ?? '');
  return { product, state: end && !['cancelled', 'llm_error', 'diverged'].includes(stopped) && !stopped.startsWith('error') ? 'ended' : 'interrupted' };
}

/** A procedure against its reference condition, investigation by investigation: each pair from the same start junior and
    bags, its products compared case by case (paired-cases@1, the candidate condition's against the reference's), the
    costs kept. An interrupted investigation, or a product measured incompletely, leaves its pair incomplete - the method
    is never credited with what it did not finish. Usefulness is never declared from this alone (§14.2). */
export function compareImprovements(m: CompetenceManifest, pairs: readonly { readonly reference: Improvement; readonly candidate: Improvement }[]): {
  readonly pairs: readonly { readonly verdict: Promotion['verdict'] | 'incomplete'; readonly why: string; readonly products: readonly [string, string]; readonly cost: readonly [Readonly<Record<string, number>>, Readonly<Record<string, number>>] }[];
  readonly improved: number; readonly worse: number; readonly inconclusive: number; readonly incomplete: number;
} {
  const out = pairs.map(({ reference: a, candidate: b }) => {
    const base = { products: [a.product, b.product] as const, cost: [a.cost, b.cost] as const };
    if (a.state !== 'ended' || b.state !== 'ended') return { ...base, verdict: 'incomplete' as const, why: 'an investigation was interrupted' };
    const ma = measure(m, a.evaluation.partition, a.evaluation.temperature, a.evaluation.observations);
    const mb = measure(m, b.evaluation.partition, b.evaluation.temperature, b.evaluation.observations);
    if (!ma.complete || !mb.complete) return { ...base, verdict: 'incomplete' as const, why: 'a product was measured incompletely' };
    if (a.product === b.product) return { ...base, verdict: 'inconclusive' as const, why: 'both produced the same junior' };
    const p = promote(m, ma, mb);
    return { ...base, verdict: p.verdict, why: p.why };
  });
  return { pairs: out, improved: out.filter((x) => x.verdict === 'promoted').length, worse: out.filter((x) => x.verdict === 'not_promoted').length,
    inconclusive: out.filter((x) => x.verdict === 'inconclusive').length, incomplete: out.filter((x) => x.verdict === 'incomplete').length };
}
