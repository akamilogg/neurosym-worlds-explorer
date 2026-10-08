import { parseJsonLoose } from '../core/net.ts';
import { checkFormula, makeFormula, normalizeWeights, placeholdersOf } from '../core/formula.ts';
import type { Formula, MeasureDecl, QuestionType, Rule } from '../core/types.ts';
import { describeTest, type Probe, type ProbeResult } from './experiments.ts';
import { STANCES, type BeliefStance, type NoteOp, type Stance } from './notebook.ts';
import { INVESTIGATION_TOOLS as COMMON_INVESTIGATION, system2Prompt, type WorldInterface } from './prompt.ts';
import { objectiveLines } from './objective.ts';
import { unknownFields } from './lab.ts';
import { GRID_ANSWER, GRID_VERDICT } from '../worlds/grid/objective.ts';

/* ============================================================================
 * The explorer: System 2 in a world it has never seen.
 *
 * It is told NOTHING about the world: no rules, no names, no legal moves, no goal
 * beyond "your side won / lost". It learns ONLY from what it perceives, what its own
 * code measures, what its own search explored, and how its games ended. Nothing
 * that knows the world better than it does ever answers it.
 *
 *   investigate   it queries its own experience: views games, inspects what its
 *                 search did on one of its turns, measures code on positions
 *   note          it writes (and forgets) its own notes: the notebook is its own
 *   hypothesise   BELIEFS in words, with a stance on each one every round
 *   experiment    PROBES, tested against how its own games ended
 *   formulate     the formula: observations (code over the percept) + rules the Judge
 *                 answers over the picture AND those values + weights
 *   reflect       LESSONS and the NEXT EXPERIMENT, returned to it verbatim next round
 *
 * The prompt is the COMMON one (prompt.ts), the same in every world; this world adds
 * only its interface (GRID_INTERFACE) and `perceptDoc`, the shape of the object an
 * observation receives (which the sense defines, not the rules).
 * ========================================================================== */

/** The grid world's interface to the common prompt (learn/prompt.ts): what its model produces, and the parameters of its
    instruments. Interface words only (SPEC-MUNDO-FISICO I5). */
export const GRID_INTERFACE: WorldInterface = {
  tools: ['view', 'inspect', 'act', 'replay', 'measure', 'table'],
  features: ['check'],
  lines: [
    /* The objective's: the form of the answer and of a verdict (worlds/grid/objective.ts). */
    ...objectiveLines({ answer: GRID_ANSWER, verdictForm: GRID_VERDICT }),
    [COMMON_INVESTIGATION, 'Requests:'],
    [['view'], '  {"view": "<episode>", "from": <step>, "to": <step>}   the pictures of a stretch of one of your episodes (at most 30 per request)'],
    [['inspect'], '  {"inspect": "<episode>@<step>"}   on a step of yours: the point your search chose (named "<episode>@<step>/<k>", with its picture), the value your model gave it looking ahead and directly, what each rule answered and what each observation measured there, and the finished episodes your search ran into after it within its horizon, and how they ended'],
    [['act'], '  {"act": "<point>", "from": [row, col], "to": [row, col]}   on a point of an episode in one of your laboratories, where the next step is yours: ask the environment to take what is at (row, col) of the picture to (row, col). The environment answers whether it accepted it and, if so, the picture that results (named "act<n>", usable in later requests) and whether the episode ended there, and how. Acting changes nothing in any episode.'],
    [['replay'], '  {"replay": "<point>", "model": <round> | { "observations": ..., "rules": ..., "weights": ..., "output": ... }}   from any point of an episode in one of your laboratories ("<episode>@0" is its start, "act<n>" where an act left you), your steps chosen with the model of that round or a draft in the same shape as a proposal (without "model": your_model). You get a new episode (its name, how it ended, how many steps). At most `replays_left` this round.'],
    [['measure'], '  {"measure": {"source": "(p) => ...", "range": [min, max]}, "on": ["<episode>@<step>", "<episode>@<step>/<k>", ...]}'],
    [['table'], '  {"table": {"source": "(p) => ...", "range": [min, max]}, "on": "in_play" | "final"}   points of your episodes - still in play, or final - each with the score its episode ended with']
  ],
};

/** The instruments System 2 can be given. An experiment may withhold any of them (the baseline): the prompt then
    says nothing of what it lacks, and the host refuses any request for it. */
/* No `probes`: an AUC and a test of chance are an analysis made for it (SPEC-MUNDO-FISICO I2); `table` gives the rows. */
export const EXPLORER_TOOLS = ['view', 'inspect', 'act', 'measure', 'replay', 'table'] as const;
export type ExplorerTool = typeof EXPLORER_TOOLS[number];
type Tools = ReadonlySet<ExplorerTool>;
/** The requests of an investigation answer; without any of them there is no investigating at all. */
export const INVESTIGATION_TOOLS: readonly ExplorerTool[] = ['view', 'inspect', 'act', 'measure', 'replay', 'table'];
/** The code of a measure or a table request: its source, and its range when it answers a number (without one, the code
    composes a text - what the judge would read). Or why it cannot be read. */
export function codeRequest(raw: unknown, kind: string): { source: string; range: readonly [number, number] | null } | string {
  const m = (raw ?? {}) as Record<string, unknown>;
  const range = Array.isArray(m.range) && m.range.length === 2 && m.range.every((x) => typeof x === 'number') ? [m.range[0] as number, m.range[1] as number] as const : null;
  if (typeof m.source !== 'string' || (m.range !== undefined && m.range !== null && !range)) return kind + ' needs "source" (and a valid "range" for a number)';
  return { source: m.source, range };
}

/** Where a measure or a table request applies: "on" beside it, or inside it (both are read). */
export const onOf = (q: Record<string, unknown>, inner: unknown): unknown => q.on ?? ((inner ?? {}) as Record<string, unknown>).on;

/** The explorer's system prompt for the instruments it is given (all of them by default): the common prompt. */
export function explorerSystem(tools: Tools = new Set(EXPLORER_TOOLS)): string {
  return system2Prompt(GRID_INTERFACE, tools);
}

export const EXPLORER_SYSTEM = explorerSystem();

export interface ExplorerBrief {
  readonly round: number;
  /** The shape of what an observation receives (e.g. `{ cells: string[][], you: string, ... }`). */
  readonly perceptDoc: string;
  /** The notebook as the explorer reads it (Notebook.brief()). */
  readonly notebook?: Record<string, unknown> | null;
  /** Its latest model, and the round that wrote it. (No "best model", no surprises, no probe statistics: those would be
      an analysis made for it - SPEC-MUNDO-FISICO I2. They go to the journal only.) */
  readonly formula?: Formula | null;
  readonly formulaRound?: number | null;
  /** This round's requests and their results so far. */
  readonly investigation?: readonly unknown[];
  readonly stepsLeft?: number;
  /** Episodes it may still replay itself this round (the `replay` request). */
  readonly replaysLeft?: number;
  /** Answers of only memory requests it may still give this round (the assisted researcher with a selective memory). */
  readonly memoryAnswersLeft?: number;
  /** How many items of each kind its memory holds. After the round's investigation, not in the notebook: it changes with
      every step, and what changes goes last (a provider's cache reuses a prompt's unchanged beginning). */
  readonly memory?: Readonly<Record<string, number>>;
  /** Why the previous answer was refused. */
  readonly refused?: readonly string[];
  readonly directive?: string | null;
  /** What this consultation is for, when it is not a proposal (e.g. a reflection round). */
  readonly task?: string | null;
  /** The places it knows: its laboratories, and those where it was validated. */
  readonly places?: readonly unknown[];
  readonly validationsLeft?: number;
  /** The environment's verdicts on its latest model. */
  readonly lastCheck?: unknown;
}

/** Only what the explorer wrote travels back: its own code and words, never the host's internals. */
export function ownFormula(formula: Formula): Record<string, unknown> {
  const observations: Record<string, unknown> = {};
  for (const [id, d] of Object.entries(formula.observations)) {
    const spec = d.spec as { kind?: string; source?: string };
    if (spec.kind !== 'code') continue;
    observations[id] = { definition: d.definition ?? '', source: spec.source, range: d.range };
  }
  const rules: Record<string, unknown> = {};
  for (const [id, r] of Object.entries(formula.rules)) rules[id] = { type: r.type, instructions: r.instructions, criteria: r.criteria };
  return { observations, rules, weights: formula.weights, ...(formula.output ? { output: formula.output.source } : {}) };
}

export function explorerPayload(brief: ExplorerBrief): Record<string, unknown> {
  return {
    round: brief.round,
    percept: brief.perceptDoc,
    ...(brief.notebook ? { notebook: brief.notebook } : {}),
    ...(brief.formula ? { your_model: { ...(brief.formulaRound ? { from_round: brief.formulaRound } : {}), ...ownFormula(brief.formula) } } : {}),
    ...(brief.investigation && brief.investigation.length ? { investigation: brief.investigation } : {}),
    ...(brief.stepsLeft !== undefined ? { steps_left: brief.stepsLeft } : {}),
    ...(brief.replaysLeft !== undefined ? { replays_left: brief.replaysLeft } : {}),
    ...(brief.memoryAnswersLeft !== undefined ? { memory_answers_left: brief.memoryAnswersLeft } : {}),
    ...(brief.memory ? { memory: brief.memory } : {}),
    ...(brief.places && brief.places.length ? { places: brief.places } : {}),
    ...(brief.validationsLeft !== undefined ? { validations_left: brief.validationsLeft } : {}),
    ...(brief.lastCheck ? { last_check: brief.lastCheck } : {}),
    ...(brief.refused && brief.refused.length ? { your_previous_answer_was_refused: brief.refused } : {}),
    ...(brief.directive ? { operator_directive: brief.directive } : {}),
    ...(brief.task ? { task: brief.task } : {})
  };
}

/* --- Investigation requests ------------------------------------------------------------ */

export type ExplorerRequest =
  | { readonly view: string; readonly from: number; readonly to: number }
  | { readonly inspect: string }
  /** `place`: only the points of episodes in that place (a researcher with places to explore). */
  | { readonly table: { readonly source: string; readonly range: readonly [number, number] | null }; readonly on: 'in_play' | 'final'; readonly place?: string }
  | { readonly act: string; readonly from: readonly [number, number]; readonly to: readonly [number, number] }
  | { readonly measure: { readonly source: string; readonly range: readonly [number, number] | null }; readonly on: readonly string[] }
  /** `formula`: a round of its own, a draft it wrote (built and checked like a proposal's), or null for its best formula. */
  | { readonly replay: string; readonly formula: number | Formula | null }
  /** A request of an instrument the researcher brings (the assisted one's memory), as it was written. */
  | { readonly extra: Record<string, unknown> };

export type ExplorerTurn =
  | { kind: 'investigate'; requests: ExplorerRequest[]; notes: NoteOp[]; methods: NoteOp[]; warnings: string[] }
  | { kind: 'proposal'; parse: ExplorerParse; notes: NoteOp[]; methods: NoteOp[] }
  /** It consolidates its round's conversation (see RoundConversation): its summary, and the steps it keeps whole. */
  | { kind: 'consolidate'; summary: string; keep: number[]; notes: NoteOp[]; methods: NoteOp[] };

/** `archive`: the assisted researcher with a selective memory may archive a note (without it, only write and forget). */
export function parseNotes(raw: unknown, warnings: string[], archive = false): NoteOp[] {
  const out: NoteOp[] = [];
  (Array.isArray(raw) ? raw : []).forEach((n, i) => {
    const o = n && typeof n === 'object' ? n as Record<string, unknown> : null;
    /* Without "do", a note with an id and a text is a write: the intent is plain, and dropping it loses the record. */
    const act = o && o.do === undefined && typeof o.text === 'string' ? 'write' : o?.do;
    if (!o || (act !== 'write' && act !== 'forget' && !(archive && act === 'archive')) || typeof o.id !== 'string') { warnings.push('note #' + i + ' ignored: needs "id" (and "do": write | forget' + (archive ? ' | archive' : '') + ')'); return; }
    out.push({ do: act, id: o.id, ...(typeof o.text === 'string' ? { text: o.text } : {}),
      /* "points" in the prompt's words; "positions", the earlier name, is still accepted. */
      ...(Array.isArray(o.points ?? o.positions) ? { positions: ((o.points ?? o.positions) as unknown[]).map(String) } : {}) });
  });
  return out;
}

/** An answer is either an investigation (requests, and maybe notes) or a proposal. */
export function parseExplorerTurn(content: string, context: Parameters<typeof parseExplorerProposal>[1] & { maxRequests?: number;
  /** The researcher's own instruments (the assisted one's memory): a request they accept is passed on as written. */
  extraRequest?: (q: Record<string, unknown>) => boolean; archive?: boolean }): ExplorerTurn {
  const data = parseJsonLoose(content);
  const o = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : null;
  const warnings: string[] = [];
  const notes = o ? parseNotes(o.notes, warnings, context.archive === true) : [];
  const methods = o ? parseNotes(o.methods, warnings).map(({ positions: _p, ...m }) => m) : [];
  /* It consolidates its round's conversation: its own summary, and the steps it keeps whole. */
  if (o && obj(o.consolidate) && !Array.isArray(o.investigate) && !o.observations && !o.rules && !o.output) {
    const c = obj(o.consolidate)!;
    const summary = typeof c.summary === 'string' ? c.summary.trim() : '';
    if (summary) return { kind: 'consolidate', summary, keep: (Array.isArray(c.keep) ? c.keep : []).filter((k): k is number => Number.isInteger(k)), notes, methods };
    warnings.push('"consolidate" needs a "summary"');
  }
  /* A request of the researcher's own instrument written alone, outside "investigate" (a small model does): it is plainly
     a request, never a proposal, so it is run as one - and said so. Only where the researcher has such an instrument. */
  if (o && !Array.isArray(o.investigate) && !o.observations && !o.rules && !o.output && context.extraRequest?.(o)) {
    const { notes: _n, methods: _m, ...request } = o;
    return { kind: 'investigate', requests: [{ extra: request }], notes, methods,
      warnings: [...warnings, 'a request goes inside "investigate": [ ... ] - this one was run as if it were'] };
  }
  if (o && Array.isArray(o.investigate) && !o.observations && !o.rules) {
    const requests: ExplorerRequest[] = [];
    for (const [i, r] of o.investigate.slice(0, context.maxRequests ?? 8).entries()) {
      const q = r && typeof r === 'object' ? r as Record<string, unknown> : {};
      if (context.extraRequest?.(q)) {
        requests.push({ extra: q });
      } else if (typeof q.view === 'string') {
        const from = Number.isInteger(q.from) ? q.from as number : 0;
        const to = Number.isInteger(q.to) ? q.to as number : from + 29;
        requests.push({ view: q.view, from, to: Math.min(to, from + 29) });
      } else if (typeof (q.act ?? q.try) === 'string') {
        const cell = (v: unknown) => Array.isArray(v) && v.length === 2 && v.every((n) => Number.isInteger(n)) ? [v[0] as number, v[1] as number] as const : null;
        const from = cell(q.from), to = cell(q.to);
        if (!from || !to) { warnings.push('request #' + i + ': act needs "from" and "to" as [row, col]'); continue; }
        const unknown = unknownFields(q, [q.act !== undefined ? 'act' : 'try', 'from', 'to']);
        if (unknown) { warnings.push('request #' + i + ': ' + unknown); continue; }
        requests.push({ act: (q.act ?? q.try) as string, from, to });
      } else if (q.table && typeof q.table === 'object') {
        const code = codeRequest(q.table, 'table');
        if (typeof code === 'string') { warnings.push('request #' + i + ': ' + code); continue; }
        const where = q.place ?? (q.table as Record<string, unknown>).place;
        requests.push({ table: code, on: onOf(q, q.table) === 'final' ? 'final' : 'in_play', ...(typeof where === 'string' ? { place: where } : {}) });
      } else if (typeof (q.replay ?? q.play) === 'string') {
        const at = (q.replay ?? q.play) as string;
        const model = q.model !== undefined ? q.model : q.formula;
        if (model === undefined || model === null || model === 'best') requests.push({ replay: at, formula: null });
        else if (Number.isInteger(model)) requests.push({ replay: at, formula: model as number });
        else if (obj(model)) {
          const built = buildFormula(model as Record<string, unknown>, context);
          if (built.errors.length) { warnings.push('request #' + i + ': the draft model of replay was refused: ' + built.errors.slice(0, 4).join(' | ')); continue; }
          requests.push({ replay: at, formula: built.formula });
        } else { warnings.push('request #' + i + ': replay needs "model" as a round number or a draft { observations, rules, weights }'); continue; }
      } else if (typeof q.inspect === 'string') {
        requests.push({ inspect: q.inspect });
      } else if (q.measure && typeof q.measure === 'object' && Array.isArray(onOf(q, q.measure))) {
        const code = codeRequest(q.measure, 'measure');
        if (typeof code === 'string') { warnings.push('request #' + i + ': ' + code); continue; }
        requests.push({ measure: code, on: (onOf(q, q.measure) as unknown[]).slice(0, 40).map(String) });
      } else { const t = JSON.stringify(r) ?? String(r); warnings.push('request #' + i + ' ignored (' + (t.length > 200 ? t.slice(0, 199) + '…' : t) + '): use view, inspect, act, replay, measure or table'); }
    }
    if (o.investigate.length > (context.maxRequests ?? 8)) warnings.push('only the first ' + (context.maxRequests ?? 8) + ' requests were run');
    return { kind: 'investigate', requests, notes, methods, warnings };
  }
  return { kind: 'proposal', parse: parseExplorerProposal(content, context), notes, methods };
}

/* --- Parsing: the explorer's text becomes a formula and probes, or a list of reasons ------ */

export interface ExplorerProposal {
  readonly formula: Formula;
  readonly probes: Probe[];
  readonly rationale: string;
  /** The stances on beliefs, as written (the notebook applies them). */
  readonly beliefs: BeliefStance[];
  readonly lessons: string[];
  readonly nextExperiment: string;
  readonly evidenceRef: unknown;
  /** It asks the environment to validate this model where it has not looked. */
  readonly validate: boolean;
  readonly warnings: string[];
}

export type ExplorerParse = { ok: true; proposal: ExplorerProposal } | { ok: false; errors: string[] };

export const ID = /^[a-z][a-z0-9_]{0,47}$/;
const TYPES: readonly QuestionType[] = ['noul', 'score', 'choice'];
export const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);

export function parseObservation(raw: unknown, where: string, lang: string, errors: string[]): MeasureDecl | null {
  const o = obj(raw);
  if (!o) { errors.push(where + ': an observation must be an object'); return null; }
  const source = typeof o.source === 'string' ? o.source.trim() : '';
  if (!source) { errors.push(where + ': "source" (a JavaScript function over the percept) is required'); return null; }
  /* No range: the code composes a text for the judge's context. A range that is there must be valid. */
  if (o.range === undefined || o.range === null) return { definition: typeof o.definition === 'string' ? o.definition : '', spec: { kind: 'code', lang, source } };
  const range = Array.isArray(o.range) && o.range.length === 2 && o.range.every((n) => typeof n === 'number' && Number.isFinite(n)) && (o.range[1] as number) > (o.range[0] as number)
    ? [o.range[0] as number, o.range[1] as number] as const : null;
  if (!range) { errors.push(where + ': "range" must be [min, max] with max > min (or absent, for a text)'); return null; }
  return { definition: typeof o.definition === 'string' ? o.definition : '', spec: { kind: 'code', lang, source }, range };
}

export function parseRule(raw: unknown, where: string, errors: string[]): Rule | null {
  const r = obj(raw);
  if (!r) { errors.push(where + ': a rule must be an object'); return null; }
  const type = r.type as QuestionType;
  if (!TYPES.includes(type)) { errors.push(where + ': "type" must be one of ' + TYPES.join(', ')); return null; }
  const instructions = typeof r.instructions === 'string' ? r.instructions.trim() : '';
  if (!instructions) { errors.push(where + ': "instructions" is required'); return null; }
  let criteria: Rule['criteria'];
  if (type === 'score') {
    if (!Array.isArray(r.criteria) || r.criteria.length < 2 || !r.criteria.every((c) => typeof c === 'string')) {
      errors.push(where + ': a score rule needs "criteria" as an array of at least 2 levels'); return null;
    }
    criteria = r.criteria as string[];
  } else {
    const c = obj(r.criteria);
    if (!c || Object.keys(c).length < (type === 'choice' ? 2 : 1)) { errors.push(where + ': a ' + type + ' rule needs "criteria" as an object'); return null; }
    criteria = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, typeof v === 'string' ? v : null]));
  }
  return { type, used_as: 'value', instructions, criteria };
}

/** The reflective part of any answer: stances on beliefs, lessons, the next experiment. */
export function parseReflective(data: Record<string, unknown>, round: number, warnings: string[]): { beliefs: BeliefStance[]; lessons: string[]; nextExperiment: string } {
  const beliefs: BeliefStance[] = [];
  const rawBeliefs = Array.isArray(data.beliefs) ? data.beliefs : [];
  rawBeliefs.forEach((raw, i) => {
    const b = obj(raw);
    const id = b && typeof b.id === 'string' ? b.id : '';
    if (!b || !ID.test(id)) { warnings.push('belief #' + i + ' ignored: "id" must be lowercase snake_case'); return; }
    const stance = b.stance as Stance;
    if (!STANCES.includes(stance)) { warnings.push('belief "' + id + '" ignored: stance must be one of ' + STANCES.join(', ')); return; }
    beliefs.push({ id, stance, ...(typeof b.statement === 'string' && b.statement.trim() ? { statement: b.statement.trim() } : {}),
      ...(typeof b.why === 'string' ? { why: b.why } : {}),
      evidence: Array.isArray(b.evidence) ? b.evidence.map(String) : (b.evidence !== undefined && b.evidence !== null ? [String(b.evidence)] : []) });
  });
  /* An answer in the older shape (plain hypotheses) still counts: each becomes a new belief. */
  if (!rawBeliefs.length && Array.isArray(data.hypotheses)) {
    data.hypotheses.filter((h): h is string => typeof h === 'string').forEach((statement, i) =>
      beliefs.push({ id: 'r' + round + '_h' + (i + 1), stance: 'new', statement }));
  }
  const lessons = Array.isArray(data.lessons) ? data.lessons.filter((l): l is string => typeof l === 'string') : [];
  const nextExperiment = typeof data.next_experiment === 'string' ? data.next_experiment : '';
  return { beliefs, lessons, nextExperiment };
}

export interface ExplorerReflection {
  readonly rationale: string;
  readonly beliefs: BeliefStance[];
  readonly lessons: string[];
  readonly nextExperiment: string;
  readonly warnings: string[];
}

/** A reflection round's answer: what it now believes, with no formula. */
export function parseReflection(content: string, round: number): { ok: true; reflection: ExplorerReflection } | { ok: false; errors: string[] } {
  const data = obj(parseJsonLoose(content));
  if (!data) return { ok: false, errors: ['the answer was not a JSON object'] };
  const warnings: string[] = [];
  const { beliefs, lessons, nextExperiment } = parseReflective(data, round, warnings);
  if (!beliefs.length && !lessons.length) return { ok: false, errors: ['a reflection needs stances on your beliefs and/or lessons'] };
  return { ok: true, reflection: { rationale: typeof data.rationale === 'string' ? data.rationale : '', beliefs, lessons, nextExperiment, warnings } };
}

/** The formula part of an answer (observations, rules, weights), built and checked: a proposal's, or a draft to play. */
export function buildFormula(data: Record<string, unknown>, context: { world: string; senses: Readonly<Record<string, MeasureDecl>>; lang?: string; round?: number }):
  { formula: Formula; observations: Record<string, MeasureDecl>; errors: string[]; warnings: string[] } {
  const lang = context.lang ?? 'js';
  const errors: string[] = [];
  const warnings: string[] = [];
  const observations: Record<string, MeasureDecl> = { ...context.senses };
  for (const [id, raw] of Object.entries(obj(data.observations) ?? {})) {
    if (!ID.test(id)) { errors.push('observation id "' + id + '" must be lowercase snake_case'); continue; }
    if (id in context.senses) { errors.push('observation id "' + id + '" is taken by a sense'); continue; }
    const decl = parseObservation(raw, 'observation "' + id + '"', lang, errors);
    if (decl) observations[id] = decl;
  }
  const rules: Record<string, Rule> = {};
  for (const [id, raw] of Object.entries(obj(data.rules) ?? {})) {
    if (!ID.test(id)) { errors.push('rule id "' + id + '" must be lowercase snake_case'); continue; }
    const rule = parseRule(raw, 'rule "' + id + '"', errors);
    if (rule) rules[id] = rule;
  }
  const { weights, warnings: weightWarnings } = normalizeWeights(obj(data.weights) ?? {}, Object.keys(rules));
  if (Object.keys(rules).length) warnings.push(...weightWarnings);
  let output: Formula['output'];
  if (data.output !== undefined && data.output !== null) {
    const source = typeof data.output === 'string' ? data.output.trim() : typeof obj(data.output)?.source === 'string' ? String(obj(data.output)!.source).trim() : '';
    if (!source) errors.push('"output" must be a JavaScript function (p, m) => answer');
    else output = { kind: 'code', lang, source };
  }

  const formula = makeFormula({
    world: context.world, observations, rules, weights, ...(output ? { output } : {}),
    meta: { source: 'explorer', round: context.round ?? 0, rationale: typeof data.rationale === 'string' ? data.rationale : '' }
  });
  const check = checkFormula(formula);
  errors.push(...check.errors);
  warnings.push(...check.warnings);
  return { formula, observations, errors, warnings };
}

/** `senses`: the observations every formula carries (what is perceived); the explorer never writes them. */
export function parseExplorerProposal(content: string, context: {
  world: string; senses: Readonly<Record<string, MeasureDecl>>; lang?: string; round?: number;
}): ExplorerParse {
  const data = obj(parseJsonLoose(content));
  if (!data) return { ok: false, errors: ['the answer was not a JSON object'] };
  const errors: string[] = [];
  const warnings: string[] = [];
  const { formula, observations, errors: formulaErrors, warnings: formulaWarnings } = buildFormula(data, context);
  errors.push(...formulaErrors);
  warnings.push(...formulaWarnings);
  const lang = context.lang ?? 'js';

  const probes: Probe[] = [];
  const rawProbes = Array.isArray(data.probes) ? data.probes : [];
  rawProbes.forEach((raw, i) => {
    const p = obj(raw);
    const id = p && typeof p.id === 'string' ? p.id : '';
    const where = 'probe ' + (id || '#' + i);
    if (!p || !ID.test(id)) { errors.push(where + ': "id" must be lowercase snake_case'); return; }
    if (probes.some((q) => q.id === id)) { errors.push(where + ': duplicate id'); return; }
    const hypothesis = typeof p.hypothesis === 'string' ? p.hypothesis.trim() : '';
    if (!hypothesis) { errors.push(where + ': "hypothesis" is required'); return; }
    const observation = p.observation ? parseObservation(p.observation, where + ' observation', lang, errors) : undefined;
    if (observation && !observation.range) { errors.push(where + ' observation: a probe measures a number - declare its "range"'); return; }
    const question = p.question ? parseRule(p.question, where + ' question', errors) : undefined;
    if (!observation && !question) { errors.push(where + ': needs an observation or a question'); return; }
    /* A question may cite the formula's observations and, when the probe has one, its own (probe_<id>): anything else
       would only fail later, silently, when the probe is measured. */
    if (question) {
      const citable = [...Object.keys(observations), ...(observation ? ['probe_' + id] : [])];
      const unknown = placeholdersOf(question).filter((ph) => !citable.includes(ph));
      if (unknown.length) {
        errors.push(where + ' question cites ' + unknown.map((u) => '{{' + u + '}}').join(', ') + ', which is not measured' +
          (unknown.includes('probe_' + id) ? ' (a probe can cite {{probe_' + id + '}} only when it declares its own observation)' : ''));
        return;
      }
    }
    probes.push({ id, hypothesis, ...(observation ? { observation } : {}), ...(question ? { question } : {}) });
  });

  const { beliefs, lessons, nextExperiment } = parseReflective(data, context.round ?? 0, warnings);
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    proposal: {
      formula, probes, warnings,
      rationale: typeof data.rationale === 'string' ? data.rationale : '',
      beliefs, lessons, nextExperiment,
      evidenceRef: data.evidence_ref ?? null,
      validate: data.validate === true
    }
  };
}
