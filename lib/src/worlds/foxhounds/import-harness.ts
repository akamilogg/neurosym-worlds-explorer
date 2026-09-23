import { makeFormula } from '../../core/formula.ts';
import type { Formula, MeasureDecl, MeasureSpec, Rule } from '../../core/types.ts';
import { FOXHOUNDS_DIALECT_ID } from './dialect.ts';
import { FOXHOUNDS_ID } from './world.ts';

/* Converts a rule set exported by fox-hounds-harness.html ("Copy Run Journal JSON" -> accepted, or a
   "weighted_jev_rules" formula) into a library Formula. Measures keep their meaning exactly:
     {kind:"op", op, args}      -> {kind:"dsl", dialect:"foxhounds@1", op, args}
     {kind:"expr", expr, range} -> {kind:"dsl", dialect:"core@1", expr'}  (groups cats->cat,
                                   primitive->call foxhounds@1) */

const GROUPS: Record<string, string> = { cats: 'cat', mouse: 'mouse', all: 'all' };

function convertExpr(node: unknown): unknown {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
  const n = node as Record<string, unknown>;
  if (n.op === 'aggregate') return { ...n, group: GROUPS[String(n.group ?? 'all')] ?? n.group };
  if (n.op === 'primitive') return { op: 'call', dialect: FOXHOUNDS_DIALECT_ID, name: n.name, args: n.args ?? {} };
  const out: Record<string, unknown> = { ...n };
  if (n.arg !== undefined) out.arg = convertExpr(n.arg);
  if (n.value !== undefined && n.op === 'clamp') out.value = convertExpr(n.value);
  if (Array.isArray(n.args)) out.args = n.args.map(convertExpr);
  return out;
}

export function convertHarnessSpec(spec: Record<string, unknown>): MeasureSpec {
  const kind = spec.kind ?? 'op';
  if (kind === 'expr') return { kind: 'dsl', dialect: 'core@1', expr: convertExpr(spec.expr) };
  if (kind === 'op') return { kind: 'dsl', dialect: FOXHOUNDS_DIALECT_ID, op: spec.op, args: spec.args ?? {} };
  throw new Error('harness measure kind "' + String(kind) + '" has no library equivalent');
}

interface HarnessRules {
  version?: number;
  rationale?: string;
  source?: string;
  confidence_floor?: number;
  confidenceFloor?: number;
  weights?: Record<string, number>;
  policy_weights?: Record<string, number>;
  policyWeights?: Record<string, number>;
  battery?: Record<string, Rule>;
  rules?: Record<string, Rule>;
  observations?: Record<string, { name?: string; definition?: string; spec: Record<string, unknown>; range?: [number, number] }>;
}

export function formulaFromHarness(exported: HarnessRules | { accepted: HarnessRules }): Formula {
  const rules: HarnessRules = 'accepted' in exported && exported.accepted ? exported.accepted : exported as HarnessRules;
  const observations: Record<string, MeasureDecl> = {};
  for (const [id, decl] of Object.entries(rules.observations ?? {})) {
    const spec = decl.spec;
    const range = decl.range ?? (spec.range as [number, number] | undefined);
    observations[id] = { name: decl.name, definition: decl.definition, spec: convertHarnessSpec(spec), ...(range ? { range } : {}) };
  }
  return makeFormula({
    world: FOXHOUNDS_ID,
    observations,
    rules: rules.battery ?? rules.rules ?? {},
    weights: rules.weights ?? {},
    policy_weights: rules.policy_weights ?? rules.policyWeights ?? {},
    confidence_floor: rules.confidence_floor ?? rules.confidenceFloor,
    meta: { version: rules.version, rationale: rules.rationale, source: rules.source, imported_from: 'fox-hounds-harness' }
  });
}
