import { parseJsonLoose } from '../core/net.ts';
import { INVESTIGATION_TOOLS as INVESTIGATION, system2Prompt, type WorldInterface } from './prompt.ts';
import { normalizeWeights } from '../core/formula.ts';
import { checkLaw, type Law } from '../core/predict.ts';
import type { MeasureDecl, Rule } from '../core/types.ts';
import { ID, obj, parseNotes, parseObservation, parseReflective, parseRule } from './explorer.ts';
import type { BeliefStance, NoteOp } from './notebook.ts';

/* ============================================================================
 * The law explorer: System 2 in a world where things move, and nobody told it why.
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

/** The physical world's interface to the common prompt (learn/prompt.ts): what its model produces, how its parts combine,
    the parameters of its instruments and the form of a verdict. Interface words only (SPEC-MUNDO-FISICO I5). */
export const ORBIT_INTERFACE: WorldInterface = {
  tools: ['view', 'inspect', 'act', 'measure', 'simulate', 'table'],
  features: ['check'],
  lines: [
    'YOUR ANSWER, at any row of any episode: the pair [x, y] the LAST pair of columns will show in the NEXT row, in the units of the table.',
    'A VERDICT is a pair of numbers from -1 to 1, one per column of the pair (x, then y); 0 on one means no difference in it between your answer and what happened there. What the rest of the range means is for you to work out.',
    [INVESTIGATION, 'Requests:'],
    [['view'], '  {"view": "<episode>", "from": <step>, "to": <step>}   rows of one of your tables (at most 60 per request)'],
    [['act'], '  {"act": {"x": <number>, "y": <number>, "vx": <number>, "vy": <number>, "m": <number>, "place": "<laboratory>"}}   start an episode yourself in one of your laboratories (default: the first): its last pair of columns starts at (x, y) and changes at first by (vx, vy) per unit of the first column; "m" is a positive number you choose (default 1). You get its table (named "act<n>"). It may be refused, and you are not told why. At most `acts_left` this round.'],
    [['inspect'], '  {"inspect": "<episode>@<step>", "model": <round> | <draft> }   what a model (without "model": your latest) answered at that point, part by part: what each observation measured, what each rule answered, V, its answer and the named values its output returned - and what was observed in the next row'],
    [['measure'], '  {"measure": {"source": "(p) => ...", "range": [min, max]}, "on": ["<episode>@<step>", ...]}'],
    [['simulate'], '  {"simulate": "<episode>@<step>", "model": <round> | <draft>, "steps": <n>}   each next row of the last pair is the model\'s answer, row after row (at most 40), next to what was observed there if anything was'],
    [['table'], '  {"table": {"source": "(p) => ...", "range": [min, max]}, "on": "episodes" | "checks"}   the points of your own episodes, or of the checks, each with the RESIDUAL of your latest model there (what the next row showed minus your answer) and the environment\'s verdict at that point']
  ],
};

export const LAW_TOOLS = ['view', 'inspect', 'act', 'measure', 'simulate', 'table'] as const;
export type LawTool = typeof LAW_TOOLS[number];
type Tools = ReadonlySet<LawTool>;

/** The law explorer's system prompt for the instruments it is given (all of them by default): the common prompt. */
export function lawExplorerSystem(tools: Tools = new Set(LAW_TOOLS)): string {
  return system2Prompt(ORBIT_INTERFACE, tools);
}

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
  readonly launchesLeft?: number;
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
    ...(brief.launchesLeft !== undefined ? { acts_left: brief.launchesLeft } : {}),
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
export type LawRequest =
  | { readonly view: string; readonly from: number; readonly to: number }
  | { readonly inspect: string; readonly law: number | Law | null }
  | { readonly act: { readonly x: number; readonly y: number; readonly vx: number; readonly vy: number; readonly m: number; readonly setup?: string } }
  | { readonly measure: { readonly source: string; readonly range: readonly [number, number] | null }; readonly on: readonly string[] }
  | { readonly simulate: string; readonly law: number | Law | null; readonly rows: number }
  | { readonly table: { readonly source: string; readonly range: readonly [number, number] }; readonly on: 'episodes' | 'checks' };

export type LawTurn =
  | { kind: 'investigate'; requests: LawRequest[]; notes: NoteOp[]; methods: NoteOp[]; warnings: string[] }
  | { kind: 'proposal'; parse: LawParse; notes: NoteOp[]; methods: NoteOp[] };

/** An answer is either an investigation (requests, and maybe notes) or a proposal. */
export function parseLawTurn(content: string, context: { world: string; lang?: string; round?: number; maxRequests?: number }): LawTurn {
  const data = parseJsonLoose(content);
  const o = obj(data);
  const warnings: string[] = [];
  const notes = o ? parseNotes(o.notes, warnings) : [];
  const methods = o ? parseNotes(o.methods, warnings).map(({ positions: _p, ...m }) => m) : [];
  const max = context.maxRequests ?? 8;
  if (o && Array.isArray(o.investigate) && !o.observations && !o.rules && !o.output) {
    const requests: LawRequest[] = [];
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
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    for (const [i, r] of o.investigate.slice(0, max).entries()) {
      const q = obj(r) ?? {};
      if (typeof q.view === 'string') {
        const from = Number.isInteger(q.from) ? q.from as number : 0;
        const to = Number.isInteger(q.to) ? q.to as number : from + 59;
        requests.push({ view: q.view, from, to: Math.min(to, from + 59) });
      } else if (obj(q.act ?? q.launch)) {
        const l = obj(q.act ?? q.launch)!;
        const [x, y, vx, vy] = [num(l.x), num(l.y), num(l.vx), num(l.vy)];
        const m = l.m === undefined ? 1 : num(l.m);
        if (x === null || y === null || vx === null || vy === null || m === null || !(m > 0)) { warnings.push('request #' + i + ': act needs numbers x, y, vx, vy (and a positive m)'); continue; }
        const place = l.place ?? l.setup;
        requests.push({ act: { x, y, vx, vy, m, ...(typeof place === 'string' ? { setup: place } : {}) } });
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
      } else if (obj(q.measure) && Array.isArray(q.on)) {
        const m = obj(q.measure)!;
        const range = Array.isArray(m.range) && m.range.length === 2 && m.range.every((x) => typeof x === 'number') ? [m.range[0] as number, m.range[1] as number] as const : null;
        if (typeof m.source !== 'string' || (m.range !== undefined && !range)) { warnings.push('request #' + i + ': measure needs "source" (and a valid "range" for a number)'); continue; }
        requests.push({ measure: { source: m.source, range }, on: q.on.slice(0, 40).map(String) });
      } else if (obj(q.table)) {
        const m = obj(q.table)!;
        const range = Array.isArray(m.range) && m.range.length === 2 && m.range.every((x) => typeof x === 'number') ? [m.range[0] as number, m.range[1] as number] as const : null;
        if (typeof m.source !== 'string' || !range) { warnings.push('request #' + i + ': table needs "source" and "range"'); continue; }
        requests.push({ table: { source: m.source, range }, on: q.on === 'checks' || q.on === 'tests' ? 'checks' : 'episodes' });
      } else warnings.push('request #' + i + ' ignored (' + clipJson(r) + '): use view, act, inspect, measure, simulate or table');
    }
    if (o.investigate.length > max) warnings.push('only the first ' + max + ' requests were run');
    return { kind: 'investigate', requests, notes, methods, warnings };
  }
  return { kind: 'proposal', parse: parseLawProposal(content, context), notes, methods };
}
