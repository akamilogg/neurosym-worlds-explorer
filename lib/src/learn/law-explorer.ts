import { parseJsonLoose } from '../core/net.ts';
import { normalizeWeights } from '../core/formula.ts';
import { checkLaw, type Law } from '../core/predict.ts';
import type { MeasureDecl, Rule } from '../core/types.ts';
import { ID, codeRequest, obj, onOf, parseNotes, parseObservation, parseReflective, parseRule } from './explorer.ts';
import type { BeliefStance, NoteOp } from './notebook.ts';

/* ============================================================================
 * The law explorer: System 2 in a world nobody told it about, whose answer is a model.
 *
 * The same stance as the game explorer (explorer.ts): it is told NOTHING about the
 * world - no law, no names, no units, no word that points to a known science - and it
 * learns ONLY from the tables it perceives, the bodies it launches itself, what its own
 * code measures and how its laws predicted. Its artifact is the same MODEL as in every
 * world (core/predict.ts, core/output.ts): observations in code, rules the judge answers
 * from them, weights over the rules (V) and optional output code - no imposed shape.
 *
 * ZERO HINTS: the prompt is a persona, a research method and a general account of the
 * instruments and the protocol. It says nothing about the nature of the world - not what
 * moves, not what varies between the places it is checked, not that there is noise or a
 * region it cannot see. The task (what to predict) and the tools' parameters are the
 * interface; the shape of the table it reads (`perceptDoc`) comes from the sense.
 * ========================================================================== */

/** What an ignored request looked like, so the learner and the journal can see what was asked. */
const clipJson = (v: unknown): string => { const t = JSON.stringify(v) ?? String(v); return t.length > 200 ? t.slice(0, 199) + '…' : t; };

export interface LawExplorerBrief {
  readonly round: number;
  readonly perceptDoc: string;
  readonly notebook?: Record<string, unknown> | null;
  readonly law?: Law | null;
  readonly lawRound?: number | null;
  /** The latest test: per launch, its error; the points it missed most. */
  readonly lastTest?: unknown;
  readonly investigation?: readonly unknown[];
  readonly stepsLeft?: number;
  /** Acts left this round, when the world offers `act`. */
  readonly actsLeft?: number;
  /** Answers of only memory requests it may still give this round (the assisted researcher with a selective memory). */
  readonly memoryAnswersLeft?: number;
  /** How many items of each kind its memory holds: after the investigation, since it changes with every step. */
  readonly memory?: Readonly<Record<string, number>>;
  /** The places it knows: its laboratories, and those where it was validated. */
  readonly setups?: readonly unknown[];
  readonly validationsLeft?: number;
  readonly refused?: readonly string[];
  readonly directive?: string | null;
  readonly task?: string | null;
}

/** Only what the explorer wrote travels back: its own code and words. */
export function ownLaw(law: Law): Record<string, unknown> {
  const observations: Record<string, unknown> = {};
  for (const [id, d] of Object.entries(law.observations)) {
    const spec = d.spec as { kind?: string; source?: string };
    if (spec.kind !== 'code') continue;
    observations[id] = { definition: d.definition ?? '', source: spec.source, ...(d.range ? { range: d.range } : {}) };
  }
  const rules: Record<string, unknown> = {};
  for (const [id, r] of Object.entries(law.rules)) rules[id] = { type: r.type, instructions: r.instructions, criteria: r.criteria };
  return { observations, rules, weights: law.weights, ...(law.output ? { output: law.output.source } : {}) };
}

export function lawExplorerPayload(brief: LawExplorerBrief): Record<string, unknown> {
  return {
    round: brief.round,
    percept: brief.perceptDoc,
    ...(brief.notebook ? { notebook: brief.notebook } : {}),
    ...(brief.law ? { your_model: { ...(brief.lawRound ? { from_round: brief.lawRound } : {}), ...ownLaw(brief.law) } } : {}),
    ...(brief.lastTest ? { last_check: brief.lastTest } : {}),
    ...(brief.investigation && brief.investigation.length ? { investigation: brief.investigation } : {}),
    ...(brief.stepsLeft !== undefined ? { steps_left: brief.stepsLeft } : {}),
    ...(brief.actsLeft !== undefined ? { acts_left: brief.actsLeft } : {}),
    ...(brief.memoryAnswersLeft !== undefined ? { memory_answers_left: brief.memoryAnswersLeft } : {}),
    ...(brief.memory ? { memory: brief.memory } : {}),
    ...(brief.setups && brief.setups.length ? { places: brief.setups } : {}),
    ...(brief.validationsLeft !== undefined ? { validations_left: brief.validationsLeft } : {}),
    ...(brief.refused && brief.refused.length ? { your_previous_answer_was_refused: brief.refused } : {}),
    ...(brief.directive ? { operator_directive: brief.directive } : {}),
    ...(brief.task ? { task: brief.task } : {})
  };
}

/* --- Building a law from the explorer's text ------------------------------------------ */

/** The model part of an answer (observations, rules, weights, output), built and checked: a proposal's, or a draft. */
export function buildLaw(data: Record<string, unknown>, context: { world: string; lang?: string }): { law: Law; errors: string[]; warnings: string[] } {
  const lang = context.lang ?? 'js';
  const errors: string[] = [];
  const warnings: string[] = [];
  const observations: Record<string, MeasureDecl> = {};
  for (const [id, raw] of Object.entries(obj(data.observations) ?? {})) {
    if (!ID.test(id)) { errors.push('observation id "' + id + '" must be lowercase snake_case'); continue; }
    const decl = parseObservation(raw, 'observation "' + id + '"', lang, errors);
    if (decl) observations[id] = decl;
  }
  const rules: Record<string, Rule> = {};
  for (const [id, raw] of Object.entries(obj(data.rules) ?? {})) {
    if (!ID.test(id)) { errors.push('rule id "' + id + '" must be lowercase snake_case'); continue; }
    const rule = parseRule(raw, 'rule "' + id + '"', errors);
    if (rule) rules[id] = rule;
  }
  const { weights, warnings: w } = normalizeWeights(obj(data.weights) ?? {}, Object.keys(rules));
  if (Object.keys(rules).length) warnings.push(...w);
  let output: Law['output'];
  if (data.output !== undefined && data.output !== null) {
    const source = typeof data.output === 'string' ? data.output.trim() : typeof obj(data.output)?.source === 'string' ? String(obj(data.output)!.source).trim() : '';
    if (!source) errors.push('"output" must be a JavaScript function (p, m) => answer');
    else output = { kind: 'code', lang, source };
  }
  const law: Law = { world: context.world, observations, rules, weights, ...(output ? { output } : {}) };
  if (!errors.length) {
    const check = checkLaw(law);
    errors.push(...check.errors);
    warnings.push(...check.warnings);
  }
  return { law, errors, warnings };
}

export interface LawProposal {
  readonly law: Law;
  /** It asks the environment to validate this law where it has not looked. */
  readonly validate: boolean;
  readonly rationale: string;
  readonly beliefs: BeliefStance[];
  readonly lessons: string[];
  readonly nextExperiment: string;
  readonly warnings: string[];
}

export type LawParse = { ok: true; proposal: LawProposal } | { ok: false; errors: string[] };

export function parseLawProposal(content: string, context: { world: string; lang?: string; round?: number }): LawParse {
  const data = obj(parseJsonLoose(content));
  if (!data) return { ok: false, errors: ['the answer was not a JSON object'] };
  const { law, errors, warnings } = buildLaw(data, context);
  const { beliefs, lessons, nextExperiment } = parseReflective(data, context.round ?? 0, warnings);
  if (errors.length) return { ok: false, errors };
  return { ok: true, proposal: { law, validate: data.validate === true, rationale: typeof data.rationale === 'string' ? data.rationale : '', beliefs, lessons, nextExperiment, warnings } };
}

/* --- Investigation requests ------------------------------------------------------------ */

/** `law`: a round of its own, a draft it wrote (built and checked like a proposal's), or null for its latest law. */
/** What `act` carries is the world's: each world parses its own parameters (`parseAct`). */
export type LawRequest<A> =
  | { readonly view: string; readonly from: number; readonly to: number }
  | { readonly inspect: string; readonly law: number | Law | null }
  | { readonly act: A }
  | { readonly measure: { readonly source: string; readonly range: readonly [number, number] | null }; readonly on: readonly string[] }
  | { readonly simulate: string; readonly law: number | Law | null; readonly rows: number }
  | { readonly table: { readonly source: string; readonly range: readonly [number, number] | null }; readonly on: 'episodes' | 'checks' }
  /** A request of an instrument the researcher brings (the assisted one's sources), as it was written. */
  | { readonly extra: Record<string, unknown> };

export type LawTurn<A> =
  | { kind: 'investigate'; requests: LawRequest<A>[]; notes: NoteOp[]; methods: NoteOp[]; warnings: string[] }
  | { kind: 'proposal'; parse: LawParse; notes: NoteOp[]; methods: NoteOp[] };

/** An answer is either an investigation (requests, and maybe notes) or a proposal. */
export function parseLawTurn<A>(content: string, context: { world: string; lang?: string; round?: number; maxRequests?: number;
  /** The world's act parameters, or why they cannot be read. */
  parseAct: (raw: Record<string, unknown>) => A | string;
  /** Requests of instruments the researcher brings: taken as they are written (none by default). */
  extraRequest?: (q: Record<string, unknown>) => boolean;
  /** `archive` among the note operations (the assisted researcher with a selective memory). */
  archive?: boolean }): LawTurn<A> {
  const parseAct = context.parseAct;
  const data = parseJsonLoose(content);
  const o = obj(data);
  const warnings: string[] = [];
  const notes = o ? parseNotes(o.notes, warnings, context.archive === true) : [];
  const methods = o ? parseNotes(o.methods, warnings).map(({ positions: _p, ...m }) => m) : [];
  const max = context.maxRequests ?? 8;
  /* A request of the researcher's own instrument written alone, outside "investigate": plainly a request, run as one. */
  if (o && !Array.isArray(o.investigate) && !o.observations && !o.rules && !o.output && context.extraRequest?.(o)) {
    const { notes: _n, methods: _m, ...request } = o;
    return { kind: 'investigate', requests: [{ extra: request }], notes, methods,
      warnings: [...warnings, 'a request goes inside "investigate": [ ... ] - this one was run as if it were'] };
  }
  if (o && Array.isArray(o.investigate) && !o.observations && !o.rules && !o.output) {
    const requests: LawRequest<A>[] = [];
    const lawOf = (raw: unknown, i: number, kind: string): number | Law | null | undefined => {
      if (raw === undefined || raw === null || raw === 'best') return null;
      if (Number.isInteger(raw)) return raw as number;
      if (obj(raw)) {
        const built = buildLaw(raw as Record<string, unknown>, context);
        if (built.errors.length) { warnings.push('request #' + i + ': the draft model of ' + kind + ' was refused: ' + built.errors.slice(0, 4).join(' | ')); return undefined; }
        return built.law;
      }
      warnings.push('request #' + i + ': "model" must be a round number or a draft { observations, rules, weights, output }');
      return undefined;
    };
    for (const [i, r] of o.investigate.slice(0, max).entries()) {
      const q = obj(r) ?? {};
      if (typeof q.view === 'string') {
        const from = Number.isInteger(q.from) ? q.from as number : 0;
        const to = Number.isInteger(q.to) ? q.to as number : from + 59;
        requests.push({ view: q.view, from, to: Math.min(to, from + 59) });
      } else if (obj(q.act ?? q.launch)) {
        const act = parseAct(obj(q.act ?? q.launch)!);
        if (typeof act === 'string') { warnings.push('request #' + i + ': ' + act); continue; }
        requests.push({ act });
      } else if (typeof q.inspect === 'string') {
        const law = lawOf(q.model !== undefined ? q.model : q.law, i, 'inspect');
        if (law === undefined) continue;
        requests.push({ inspect: q.inspect, law });
      } else if (typeof q.simulate === 'string') {
        const law = lawOf(q.model !== undefined ? q.model : q.law, i, 'simulate');
        if (law === undefined) continue;
        const n = q.steps ?? q.rows;
        const rows = Number.isInteger(n) ? Math.max(1, Math.min(40, n as number)) : 20;
        requests.push({ simulate: q.simulate, law, rows });
      } else if (obj(q.measure) && Array.isArray(onOf(q, q.measure))) {
        const code = codeRequest(q.measure, 'measure');
        if (typeof code === 'string') { warnings.push('request #' + i + ': ' + code); continue; }
        requests.push({ measure: code, on: (onOf(q, q.measure) as unknown[]).slice(0, 40).map(String) });
      } else if (obj(q.table)) {
        const code = codeRequest(q.table, 'table');
        if (typeof code === 'string') { warnings.push('request #' + i + ': ' + code); continue; }
        const on = onOf(q, q.table);
        requests.push({ table: code, on: on === 'checks' || on === 'tests' ? 'checks' : 'episodes' });
      } else if (context.extraRequest?.(q)) requests.push({ extra: q });
      else warnings.push('request #' + i + ' ignored (' + clipJson(r) + '): use view, act, inspect, measure, simulate or table');
    }
    if (o.investigate.length > max) warnings.push('only the first ' + max + ' requests were run');
    return { kind: 'investigate', requests, notes, methods, warnings };
  }
  return { kind: 'proposal', parse: parseLawProposal(content, context), notes, methods };
}
