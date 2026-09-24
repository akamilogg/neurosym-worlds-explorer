import { parseJsonLoose } from '../core/net.ts';
import { checkFormula, makeFormula, normalizeWeights, placeholdersOf } from '../core/formula.ts';
import type { Formula, MeasureDecl, QuestionType, Rule } from '../core/types.ts';
import { describeTest, type Probe, type ProbeResult } from './experiments.ts';
import { STANCES, type BeliefStance, type NoteOp, type Stance } from './notebook.ts';

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
 * The prompt is world-agnostic: the only world-specific text is `perceptDoc`, the
 * shape of the object an observation receives (which the sense defines, not the rules).
 * ========================================================================== */

export const EXPLORER_SYSTEM = [
  'You are a scientist facing an environment nobody has described to you.',
  'It is a turn-based two-player environment. You control one side, marked "you" in what you perceive; the other side is controlled by someone else.',
  'You perceive it ONLY through a text picture, rendered after every turn. You are told nothing else: not the rules, not what the symbols mean, not which changes are allowed, not how a game is won. At the end of each game you learn whether your side won or lost. Nobody will tell you what a good move was: everything you learn, you find out yourself.',
  'Your side\'s moves are chosen by a search that looks a few turns ahead and values each imagined position with a FORMULA that you write:',
  '  - OBSERVATIONS: small deterministic JavaScript functions over what is perceived (the object described in `percept`), each returning a number inside its declared range. They can only compute from the picture.',
  '  - RULES: questions a semantic judge answers about a position. The judge sees the picture AND the values of your observations (cite an observation inside a rule as {{observation_id}}). A rule\'s answer, 0..1, means "good for my side" when high. The judge knows nothing about this environment either.',
  '  - WEIGHTS over the rules (they are normalised to sum 1).',
  'Both carriers of judgement are welcome: code is deterministic and readable, the judge understands plain words. Put each part of your understanding where it is clearest.',
  '',
  'YOUR NOTEBOOK (the `notebook` field) is yours: your beliefs and their history, the notes you chose to write, the index of games played, every formula you tried with its probes and results, and your own lessons and planned next experiment. Nothing is added to it for you except the facts of what you did and how games ended. Write in it what you want to remember: a note can cite positions of your games as "<game>@<turn>".',
  'Every round, take a stance on EVERY belief you still hold: "keep", "revise" (give the new statement), "confirm" (the evidence settled it) or "drop" (the evidence refuted it); add new ones with "new". Cite the evidence: games, positions, probes, rounds.',
  '',
  'INVESTIGATE before proposing. Instead of a proposal you may answer {"investigate": [ ...requests ], "notes": [ ...optional ]}; the results come back in `investigation`, and `steps_left` says how many more such answers you have this round. Requests:',
  '  {"view": "<game>", "from": <turn>, "to": <turn>}   the pictures of a stretch of one of your games (at most 30 per request)',
  '  {"inspect": "<game>@<turn>"}   what YOUR search did on that turn of yours: the position it chose to move to (named "<game>@<turn>/<k>", with its picture), the value your formula gave it looking ahead and directly, and the finished games your search ran into after it within its horizon, and who won them',
  '  {"try": "<position>", "from": [row, col], "to": [row, col]}   on a position of your games where it is your turn, TRY a change you imagine: move what is at (row, col) of the picture to (row, col). The environment only answers whether it allowed it and, if so, shows the picture that results (named "try<n>", usable in later requests) and whether that change ended the game (and who won). It never says why a change was refused or why a game ended: that is for you to work out. A try is how you TEST an idea about how games end, directly. Trying changes nothing in any game.',
  '  {"measure": {"source": "(p) => ...", "range": [min, max]}, "on": ["<game>@<turn>", "<game>@<turn>/<k>", ...]}   the value of that code on those positions',
  '  {"play": "<position>", "formula": <round> | { "observations": ..., "rules": ..., "weights": ... }}   PLAY a game again yourself: from any position of your games ("<game>@0" is its start, "<game>@<turn>" a moment of it, "try<n>" where a try left you), your side choosing with the formula of that round, or with a draft you write in the same shape as a proposal (without "formula", your best formula). The other side plays as it always does, so the same experiment can end differently. You get a new game (its name, how it ended, how many turns), to view and inspect like any other. Repeat an experiment, or change one thing and play it again: it is your laboratory, and nothing it plays counts on the scoreboard. At most `plays_left` games this round.',
  '',
  'METHOD. How you investigate is yours to design, and it is part of what you learn. Some general strategies (none of them says anything about this environment):',
  '  - When a belief keeps collecting exceptions, stop patching it. Gather the exceptions and ask what they share that the confirming cases do not. Write code that measures that candidate property and run it with `table` or `measure` over the positions where it should matter, then read each value yourself.',
  '  - Your reading of a picture can be wrong. Before one reading changes a belief, check it with code on that same position.',
  '  - `try` tells you whether a change is allowed and whether it ends the game; `play` tells you how a whole game goes from a position. Repeat an experiment to see how much chance moves it; change one thing at a time to see what that one thing does.',
  '  - Prefer a test whose result could prove you wrong over one that can only agree with you.',
  '  - Every tool you have is for use: an investigation that only looks at pictures leaves your measuring and experimenting tools idle.',
  'Build your own strategies from these tools. When you find a way of investigating that works, or one that wasted your steps, write it down as a METHOD in any answer: "methods": [ {"do": "write", "id": "<id>", "text": "..."} | {"do": "forget", "id": "<id>"} ]. Your methods come back to you every round in `notebook.methods`.',
  '',
  '`surprises` lists, for your latest games, the turns where your own search\'s value of your position fell the most before your next turn (or the end): where your formula was most wrong. They are good places to inspect.',
  '',
  'Test ideas with PROBES. A probe is a hypothesis plus an observation and/or a question; the observation and the question are tested SEPARATELY, on positions from your own games labelled by how THAT game ended. The judge answering a probe question never knows how the game ended: ask it to describe the position. You get FACTS, not verdicts - whether they confirm your hypothesis is for you to judge, in the direction you stated it: the mean value on positions from games you won and from games you lost; the AUC (the probability that a position from a won game scores higher than one from a lost game: 0.5 = no relation, 1 = always higher in won games, 0 = always higher in lost games); how many positions; and whether chance alone could produce a difference that large with that many positions. Observations are also tested on final positions (what the end of a won or a lost game looks like - this is how you learn how games end). Remember the outcome belongs to the whole game: early positions of a lost game may have been fine.',
  '  {"table": {"source": "(p) => ...", "range": [min, max]}, "on": "in_play" | "final"}   (an investigation request) the value of that code on each position probes use, with how that game ended: the rows behind the facts, to inspect yourself',
  '',
  '`scoreboard` shows how each of your formulas did; a formula\'s `fingerprint` is the same exactly when the formula is the same. `your_best_formula` is the one that has won the most so far - not necessarily your latest. Games have chance in them (the other side is not always the same, and new starting positions differ): how much a result would vary is something you can find out yourself.',
  '',
  'If the payload carries a `task`, it says what this consultation is for and what to answer instead of a proposal.',
  '',
  'When you propose, answer with ONE JSON object and nothing else:',
  '{',
  '  "rationale": "what you believe now and why, citing the evidence",',
  '  "beliefs": [ { "id": "<id>", "stance": "new" | "keep" | "revise" | "confirm" | "drop", "statement": "the belief (required for new and revise)", "why": "...", "evidence": ["<game, position, probe or round>"] } ],',
  '  "notes": [ { "do": "write", "id": "<id>", "text": "...", "positions": ["<game>@<turn>"] } | { "do": "forget", "id": "<id>" } ],',
  '  "observations": { "<id>": { "definition": "what it measures", "source": "(p) => <number>", "range": [min, max] } },',
  '  "rules": { "<id>": { "type": "noul" | "score" | "choice", "instructions": "a question, may cite {{observation_id}}", "criteria": ... } },',
  '  "weights": { "<rule id>": number },',
  '  "probes": [ { "id": "<id>", "hypothesis": "...", "observation": { "definition": "...", "source": "(p) => ...", "range": [min, max] } , "question": { "type": ..., "instructions": ..., "criteria": ... } } ],',
  '  "lessons": ["what this round taught you, in a sentence each"],',
  '  "next_experiment": "what you intend to test next round, and why"',
  '}',
  'Rule types: "noul" answers a probability 0..1 that the statement holds (criteria: {"yes": "...", "no": "..."}); "score" picks a level from criteria ordered worst to best (an array of 3 to 5 strings); "choice" gives probabilities over named options (criteria: {"<option>": "..."}; its value is the probability of the FIRST option, so put the good one first).',
  'Ids are lowercase snake_case. A probe needs an observation or a question (or both; inside its question, cite the observation of that same probe as {{probe_<probe id>}}). Keep observation code short, pure and deterministic; no randomness, no dates.'
].join('\n');

export interface ExplorerBrief {
  readonly round: number;
  /** The shape of what an observation receives (e.g. `{ cells: string[][], you: string, ... }`). */
  readonly perceptDoc: string;
  /** The notebook as the explorer reads it (Notebook.brief()). */
  readonly notebook?: Record<string, unknown> | null;
  /** Where its own search was most wrong in its latest games (exploration.surprises). */
  readonly surprises?: unknown;
  /** The formula the next one should build on (the best so far), and the round that wrote it. */
  readonly formula?: Formula | null;
  readonly formulaRound?: number | null;
  /** How each of its formulas did, the best and the latest (facts of its own games). */
  readonly scoreboard?: unknown;
  readonly hypotheses?: readonly ProbeResult[];
  /** This round's requests and their results so far. */
  readonly investigation?: readonly unknown[];
  readonly stepsLeft?: number;
  /** Games it may still play itself this round (the `play` request). */
  readonly playsLeft?: number;
  /** Why the previous answer was refused. */
  readonly refused?: readonly string[];
  readonly directive?: string | null;
  /** What this consultation is for, when it is not a proposal (e.g. a reflection round). */
  readonly task?: string | null;
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
  return { observations, rules, weights: formula.weights };
}

export function explorerPayload(brief: ExplorerBrief): Record<string, unknown> {
  return {
    round: brief.round,
    percept: brief.perceptDoc,
    ...(brief.notebook ? { notebook: brief.notebook } : {}),
    ...(brief.surprises ? { surprises: brief.surprises } : {}),
    ...(brief.scoreboard ? { scoreboard: brief.scoreboard } : {}),
    ...(brief.formula ? { your_best_formula: { ...(brief.formulaRound ? { from_round: brief.formulaRound } : {}), ...ownFormula(brief.formula) } } : {}),
    /* Facts only - no verdict: which direction confirms a hypothesis is for the explorer to say. */
    ...(brief.hypotheses && brief.hypotheses.length ? { probes_reported: brief.hypotheses.map((h) => ({
      id: h.id, hypothesis: h.hypothesis, round: h.round, ...(h.code ? { code: h.code } : {}),
      tests: h.tests.map((t) => describeTest(t)),
      ...(h.errors.length ? { errors: h.errors } : {}) })) } : {}),
    ...(brief.investigation && brief.investigation.length ? { investigation: brief.investigation } : {}),
    ...(brief.stepsLeft !== undefined ? { steps_left: brief.stepsLeft } : {}),
    ...(brief.playsLeft !== undefined ? { plays_left: brief.playsLeft } : {}),
    ...(brief.refused && brief.refused.length ? { your_previous_answer_was_refused: brief.refused } : {}),
    ...(brief.directive ? { operator_directive: brief.directive } : {}),
    ...(brief.task ? { task: brief.task } : {})
  };
}

/* --- Investigation requests ------------------------------------------------------------ */

export type ExplorerRequest =
  | { readonly view: string; readonly from: number; readonly to: number }
  | { readonly inspect: string }
  | { readonly table: { readonly source: string; readonly range: readonly [number, number] }; readonly on: 'in_play' | 'final' }
  | { readonly try: string; readonly from: readonly [number, number]; readonly to: readonly [number, number] }
  | { readonly measure: { readonly source: string; readonly range: readonly [number, number] }; readonly on: readonly string[] }
  /** `formula`: a round of its own, a draft it wrote (built and checked like a proposal's), or null for its best formula. */
  | { readonly play: string; readonly formula: number | Formula | null };

export type ExplorerTurn =
  | { kind: 'investigate'; requests: ExplorerRequest[]; notes: NoteOp[]; methods: NoteOp[]; warnings: string[] }
  | { kind: 'proposal'; parse: ExplorerParse; notes: NoteOp[]; methods: NoteOp[] };

function parseNotes(raw: unknown, warnings: string[]): NoteOp[] {
  const out: NoteOp[] = [];
  (Array.isArray(raw) ? raw : []).forEach((n, i) => {
    const o = n && typeof n === 'object' ? n as Record<string, unknown> : null;
    if (!o || (o.do !== 'write' && o.do !== 'forget') || typeof o.id !== 'string') { warnings.push('note #' + i + ' ignored: needs "do" (write | forget) and "id"'); return; }
    out.push({ do: o.do, id: o.id, ...(typeof o.text === 'string' ? { text: o.text } : {}),
      ...(Array.isArray(o.positions) ? { positions: o.positions.map(String) } : {}) });
  });
  return out;
}

/** An answer is either an investigation (requests, and maybe notes) or a proposal. */
export function parseExplorerTurn(content: string, context: Parameters<typeof parseExplorerProposal>[1] & { maxRequests?: number }): ExplorerTurn {
  const data = parseJsonLoose(content);
  const o = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : null;
  const warnings: string[] = [];
  const notes = o ? parseNotes(o.notes, warnings) : [];
  const methods = o ? parseNotes(o.methods, warnings).map(({ positions: _p, ...m }) => m) : [];
  if (o && Array.isArray(o.investigate) && !o.observations && !o.rules) {
    const requests: ExplorerRequest[] = [];
    for (const [i, r] of o.investigate.slice(0, context.maxRequests ?? 8).entries()) {
      const q = r && typeof r === 'object' ? r as Record<string, unknown> : {};
      if (typeof q.view === 'string') {
        const from = Number.isInteger(q.from) ? q.from as number : 0;
        const to = Number.isInteger(q.to) ? q.to as number : from + 29;
        requests.push({ view: q.view, from, to: Math.min(to, from + 29) });
      } else if (typeof q.try === 'string') {
        const cell = (v: unknown) => Array.isArray(v) && v.length === 2 && v.every((n) => Number.isInteger(n)) ? [v[0] as number, v[1] as number] as const : null;
        const from = cell(q.from), to = cell(q.to);
        if (!from || !to) { warnings.push('request #' + i + ': try needs "from" and "to" as [row, col]'); continue; }
        requests.push({ try: q.try, from, to });
      } else if (q.table && typeof q.table === 'object') {
        const m = q.table as Record<string, unknown>;
        const range = Array.isArray(m.range) && m.range.length === 2 && m.range.every((x) => typeof x === 'number') ? [m.range[0] as number, m.range[1] as number] as const : null;
        if (typeof m.source !== 'string' || !range) { warnings.push('request #' + i + ': table needs "source" and "range"'); continue; }
        requests.push({ table: { source: m.source, range }, on: q.on === 'final' ? 'final' : 'in_play' });
      } else if (typeof q.play === 'string') {
        if (q.formula === undefined || q.formula === null || q.formula === 'best') requests.push({ play: q.play, formula: null });
        else if (Number.isInteger(q.formula)) requests.push({ play: q.play, formula: q.formula as number });
        else if (obj(q.formula)) {
          const built = buildFormula(q.formula as Record<string, unknown>, context);
          if (built.errors.length) { warnings.push('request #' + i + ': the draft formula of play was refused: ' + built.errors.slice(0, 4).join(' | ')); continue; }
          requests.push({ play: q.play, formula: built.formula });
        } else { warnings.push('request #' + i + ': play needs "formula" as a round number or a draft { observations, rules, weights }'); continue; }
      } else if (typeof q.inspect === 'string') {
        requests.push({ inspect: q.inspect });
      } else if (q.measure && typeof q.measure === 'object' && Array.isArray(q.on)) {
        const m = q.measure as Record<string, unknown>;
        const range = Array.isArray(m.range) && m.range.length === 2 && m.range.every((x) => typeof x === 'number') ? [m.range[0] as number, m.range[1] as number] as const : null;
        if (typeof m.source !== 'string' || !range) { warnings.push('request #' + i + ': measure needs "source" and "range"'); continue; }
        requests.push({ measure: { source: m.source, range }, on: q.on.slice(0, 40).map(String) });
      } else warnings.push('request #' + i + ' ignored: use view, inspect, try, play, measure or table');
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
  readonly warnings: string[];
}

export type ExplorerParse = { ok: true; proposal: ExplorerProposal } | { ok: false; errors: string[] };

const ID = /^[a-z][a-z0-9_]{0,47}$/;
const TYPES: readonly QuestionType[] = ['noul', 'score', 'choice'];
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);

function parseObservation(raw: unknown, where: string, lang: string, errors: string[]): MeasureDecl | null {
  const o = obj(raw);
  if (!o) { errors.push(where + ': an observation must be an object'); return null; }
  const source = typeof o.source === 'string' ? o.source.trim() : '';
  if (!source) { errors.push(where + ': "source" (a JavaScript function over the percept) is required'); return null; }
  const range = Array.isArray(o.range) && o.range.length === 2 && o.range.every((n) => typeof n === 'number' && Number.isFinite(n)) && (o.range[1] as number) > (o.range[0] as number)
    ? [o.range[0] as number, o.range[1] as number] as const : null;
  if (!range) { errors.push(where + ': "range" must be [min, max] with max > min'); return null; }
  return { definition: typeof o.definition === 'string' ? o.definition : '', spec: { kind: 'code', lang, source }, range };
}

function parseRule(raw: unknown, where: string, errors: string[]): Rule | null {
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
function parseReflective(data: Record<string, unknown>, round: number, warnings: string[]): { beliefs: BeliefStance[]; lessons: string[]; nextExperiment: string } {
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
function buildFormula(data: Record<string, unknown>, context: { world: string; senses: Readonly<Record<string, MeasureDecl>>; lang?: string; round?: number }):
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
  warnings.push(...weightWarnings);

  const formula = makeFormula({
    world: context.world, observations, rules, weights,
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
      evidenceRef: data.evidence_ref ?? null
    }
  };
}
