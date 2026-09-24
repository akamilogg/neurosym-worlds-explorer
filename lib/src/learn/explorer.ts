import { parseJsonLoose } from '../core/net.ts';
import { checkFormula, makeFormula, normalizeWeights } from '../core/formula.ts';
import type { Formula, MeasureDecl, QuestionType, Rule } from '../core/types.ts';
import type { Probe, ProbeResult } from './experiments.ts';
import { STANCES, type BeliefStance, type Stance } from './notebook.ts';

/* ============================================================================
 * The explorer: System 2 in a world it has never seen.
 *
 * It is told NOTHING about the world: no rules, no names, no legal moves, no goal
 * beyond "your side won / lost". It perceives what the senses render (e.g. an ASCII
 * picture), game after game, and must:
 *
 *   hypothesise   hold BELIEFS in words, and take a stance on each one every round
 *   experiment    PROBES: a hypothesis plus an observation (code over the percept) and/or
 *                 a question to the Judge, tested on positions whose outcome is known
 *   formulate     the formula: observations (code over the percept) + rules the Judge
 *                 answers over the picture AND those measured values + weights
 *   reflect       LESSONS and the NEXT EXPERIMENT, returned to it verbatim next round
 *
 * What it carries between rounds is the lab notebook (notebook.ts): its beliefs and
 * their history, the formula's lineage with every result, and curated experience.
 * The prompt is world-agnostic: the only world-specific text is `perceptDoc`, the
 * shape of the object an observation receives (which the sense defines, not the rules).
 * Every proposal crosses the same gates as any other: parse, structure, executability.
 * ========================================================================== */

/** A game as the explorer saw it (exploration or trial), before the notebook curates it. */
export interface Trajectory {
  readonly id: string;
  /** What the senses rendered, one frame per ply from the first position to the last. */
  readonly frames: readonly string[];
  /** From the learner's side: "won" | "lost" | "draw". */
  readonly result: string;
  /** How the frames were produced (e.g. "exploration: you moved at random", "trial: your formula played"). */
  readonly how: string;
}

export const EXPLORER_SYSTEM = [
  'You are a scientist facing an environment nobody has described to you.',
  'It is a turn-based two-player environment. You control one side, marked "you" in what you perceive; the other side is controlled by someone else.',
  'You perceive it ONLY through a text picture, rendered after every turn. You are told nothing else: not the rules, not what the symbols mean, not which changes are allowed, not how a game is won. You only learn, at the end of each game, whether your side won or lost.',
  'Your side\'s moves are chosen by a search that looks a few turns ahead and values each imagined position with a FORMULA that you write:',
  '  - OBSERVATIONS: small deterministic JavaScript functions over what is perceived (the object described in `percept`), each returning a number inside its declared range. They can only compute from the picture.',
  '  - RULES: questions a semantic judge answers about a position. The judge sees the picture AND the values of your observations (cite an observation inside a rule as {{observation_id}}). A rule\'s answer, 0..1, means "good for my side" when high.',
  '  - WEIGHTS over the rules (they are normalised to sum 1).',
  'Both carriers of judgement are welcome: code is deterministic and readable, the judge understands plain words. Put each part of your understanding where it is clearest; a rule in plain words is preferred when it explains a judgement better than a formula would.',
  '',
  'You work over many rounds and keep a LAB NOTEBOOK (the `notebook` field). It is your memory: your beliefs and their history, every formula you tried with what changed and how its games went, what the observations alone achieved, the probes and their results, and your own lessons and planned next experiment from the previous round. Read it first. Do not repeat what failed unless you say why it should now work; build on partial improvements.',
  'Every round, take a stance on EVERY belief you still hold: "keep", "revise" (give the new statement), "confirm" (the evidence settled it) or "drop" (the evidence refuted it); add new ones with "new". Cite the evidence: game cases, probe ids, rounds.',
  'Your EXPERIENCE (the `experience` field) is curated: every game you won, the critical moment of games you lost (the position before your move, when you could still win, and the position after it, when you no longer could; the move that would have kept the win is not shown), your best losses, and the latest games. "turns_still_winning" counts your turns played while your position could still be won: it grows when you improve, even before you win.',
  '',
  'Test ideas with PROBES before trusting them. A probe is a hypothesis plus an observation and/or a question. The observation and the question are tested SEPARATELY. The judge answering a probe question never knows how the game ended: ask it to describe the position (e.g. "is the other piece boxed in?"), and the outcome comparison is done for you.',
  'Each test reports an AUC: the probability that a position that was won scores higher than one that was lost (0.5 = no relation, 1 = always higher when won, 0 = always higher when lost). It is "supported" or "inverted" only when it is further from 0.5 than chance allows with that many samples. Tests run on three kinds of positions. "choices": from one position your side could still win, the positions your side could move to are compared - those that keep the win against those that throw it away; this is exactly what your formula must do for the search, so a probe that orders choices well is the one worth building on. "in play" (does it predict who will win? - careful: the won and lost positions come from different games, so a probe can separate them by resembling how good games look without helping to choose a move). "final" (only for observations: is it what the end of a won or lost game looks like? - this is how you can learn how games end).',
  '',
  'Answer with ONE JSON object and nothing else:',
  '{',
  '  "rationale": "what you believe now and why, citing the evidence",',
  '  "beliefs": [ { "id": "<id>", "stance": "new" | "keep" | "revise" | "confirm" | "drop", "statement": "the belief (required for new and revise)", "why": "...", "evidence": ["<case id, probe id or round>"] } ],',
  '  "observations": { "<id>": { "definition": "what it measures", "source": "(p) => <number>", "range": [min, max] } },',
  '  "rules": { "<id>": { "type": "noul" | "score" | "choice", "instructions": "a question, may cite {{observation_id}}", "criteria": ... } },',
  '  "weights": { "<rule id>": number },',
  '  "probes": [ { "id": "<id>", "hypothesis": "...", "observation": { "definition": "...", "source": "(p) => ...", "range": [min, max] } , "question": { "type": ..., "instructions": ..., "criteria": ... } } ],',
  '  "lessons": ["what this round taught you, in a sentence each"],',
  '  "next_experiment": "what you intend to test next round, and why",',
  '  "evidence_ref": { "case": "<a case id or probe id you rely on most>", "why": "..." }',
  '}',
  'Rule types: "noul" answers a probability 0..1 that the statement holds (criteria: {"yes": "...", "no": "..."}); "score" picks a level from criteria ordered worst to best (an array of 3 to 5 strings); "choice" gives probabilities over named options (criteria: {"<option>": "..."}; its value is the probability of the FIRST option, so put the good one first).',
  'Ids are lowercase snake_case. A probe needs an observation or a question (or both; inside its question, cite the observation of that same probe as {{probe_<probe id>}}). Keep observation code short, pure and deterministic; no randomness, no dates.'
].join('\n');

export interface ExplorerBrief {
  readonly round: number;
  /** The shape of what an observation receives (e.g. `{ cells: string[][], you: string, ... }`). */
  readonly perceptDoc: string;
  /** Curated experience (Notebook.memory()), or plain trajectories. */
  readonly experience: Record<string, unknown> | readonly Trajectory[];
  /** The notebook as the explorer reads it (Notebook.brief()). */
  readonly notebook?: Record<string, unknown> | null;
  /** The formula the next one should build on (the best so far), and the round that wrote it. */
  readonly formula?: Formula | null;
  readonly formulaRound?: number | null;
  readonly lastScore?: Record<string, unknown> | null;
  readonly hypotheses?: readonly ProbeResult[];
  readonly actionAccuracy?: unknown;
  /** Why the previous proposal was refused before it could be tested. */
  readonly refused?: readonly string[];
  readonly directive?: string | null;
}

/** Only what the explorer wrote travels back: its own code and words, never the host's internals. */
function ownFormula(formula: Formula): Record<string, unknown> {
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

const POSITION_LABEL = { siblings: 'choices from one position', in_play: 'positions in play', final: 'final positions' } as const;

export function explorerPayload(brief: ExplorerBrief): Record<string, unknown> {
  const experience = Array.isArray(brief.experience)
    ? (brief.experience as readonly Trajectory[]).map((t) => ({ case: t.id, how: t.how, result: t.result, turns: t.frames.length - 1, frames: t.frames }))
    : brief.experience;
  return {
    round: brief.round,
    percept: brief.perceptDoc,
    ...(brief.notebook ? { notebook: brief.notebook } : {}),
    experience,
    ...(brief.formula ? { your_best_formula: { ...(brief.formulaRound ? { from_round: brief.formulaRound } : {}), ...ownFormula(brief.formula) } } : {}),
    ...(brief.lastScore ? { last_trial: brief.lastScore } : {}),
    ...(brief.hypotheses && brief.hypotheses.length ? { probes_reported: brief.hypotheses.map((h) => ({
      id: h.id, hypothesis: h.hypothesis, status: h.status, round: h.round,
      tests: h.tests.map((t) => ({ tested: t.by, on: POSITION_LABEL[t.positions], status: t.status,
        /* Choices: only how many positions were compared - counting the choices would tell how many moves exist. */
        auc: t.auc, samples: t.positions === 'siblings' ? { positions_compared: t.sets ?? 0 } : { won: t.samples_win, lost: t.samples_loss } })),
      ...(h.errors.length ? { errors: h.errors } : {}) })) } : {}),
    ...(brief.actionAccuracy ? { move_quality: brief.actionAccuracy } : {}),
    ...(brief.refused && brief.refused.length ? { your_previous_answer_was_refused: brief.refused } : {}),
    ...(brief.directive ? { operator_directive: brief.directive } : {})
  };
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

/** `senses`: the observations every formula carries (what is perceived); the explorer never writes them. */
export function parseExplorerProposal(content: string, context: {
  world: string; senses: Readonly<Record<string, MeasureDecl>>; lang?: string; round?: number;
}): ExplorerParse {
  const data = obj(parseJsonLoose(content));
  if (!data) return { ok: false, errors: ['the answer was not a JSON object'] };
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
    probes.push({ id, hypothesis, ...(observation ? { observation } : {}), ...(question ? { question } : {}) });
  });

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
      beliefs.push({ id: 'r' + (context.round ?? 0) + '_h' + (i + 1), stance: 'new', statement }));
  }
  const lessons = Array.isArray(data.lessons) ? data.lessons.filter((l): l is string => typeof l === 'string') : [];
  const nextExperiment = typeof data.next_experiment === 'string' ? data.next_experiment : '';

  const formula = makeFormula({
    world: context.world, observations, rules, weights,
    meta: { source: 'explorer', round: context.round ?? 0, rationale: typeof data.rationale === 'string' ? data.rationale : '' }
  });
  const check = checkFormula(formula);
  errors.push(...check.errors);
  warnings.push(...check.warnings);
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
