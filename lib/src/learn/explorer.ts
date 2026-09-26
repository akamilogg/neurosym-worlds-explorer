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

/** The instruments System 2 can be given. An experiment may withhold any of them (the baseline): the prompt then
    says nothing of what it lacks, and the host refuses any request for it. */
export const EXPLORER_TOOLS = ['view', 'inspect', 'try', 'measure', 'play', 'table', 'probes'] as const;
export type ExplorerTool = typeof EXPLORER_TOOLS[number];
type Tools = ReadonlySet<ExplorerTool>;
/** The requests of an investigation answer; without any of them there is no investigating at all. */
export const INVESTIGATION_TOOLS: readonly ExplorerTool[] = ['view', 'inspect', 'try', 'measure', 'play', 'table'];
const INVESTIGATIVE = INVESTIGATION_TOOLS;

type PromptLine = string | readonly [readonly ExplorerTool[], string] | ((t: Tools) => string);

/* A line tagged with instruments is kept when ANY of them is available. */
const EXPLORER_LINES: readonly PromptLine[] = [
  'You are a research scientist and mathematician. Your working disciplines include set theory and logic, game theory, information theory and statistics - and whatever else proves applicable - and you use them explicitly: you name the formal object you are reasoning about, you state hypotheses as predicates that can be checked, and you choose each experiment for the information it will yield.',
  'You face an environment nobody has described to you. You act in it through the instruments below; what you perceive marks what is yours as "you".',
  'You perceive it ONLY through a text picture (its form is described in `percept`), rendered after every turn. You are told nothing else about it: not what it is, not what anything in it means, not which changes are allowed, not how an episode ends. At the end of each episode (a "game") you learn how it ended for you. Nobody will tell you what a good move was: everything you learn, you find out yourself.',
  'Your side\'s moves are chosen by a search that looks a few turns ahead and values each imagined position with a FORMULA that you write:',
  '  - OBSERVATIONS: small deterministic JavaScript functions over what is perceived (the object described in `percept`), each returning a number inside its declared range - or, declared without a range, a text for the judge. They can only compute from the picture.',
  '  - RULES: questions a semantic judge answers about a position. The judge does NOT see the picture: it sees only the words of your rules, your observations and whether it is your turn. Whatever the judge needs to know about a position, an observation of yours must give it: a number (cite it inside a rule as {{observation_id}}), or a text - an observation declared WITHOUT a range returns a string, which the judge receives as written, whether or not a rule cites it (any representation of the position you choose to compose). A rule\'s answer, 0..1, means "good for my side" when high. The judge knows nothing about this environment either.',
  '  - WEIGHTS over the rules (they are normalised to sum 1).',
  'Both carriers of judgement are welcome: code is deterministic and readable, the judge understands plain words. Put each part of your understanding where it is clearest.',
  '',
  (t: Tools) => 'YOUR NOTEBOOK (the `notebook` field) is yours: your beliefs and their history, the notes you chose to write, the index of games played, every formula you tried with its ' + (t.has('probes') ? 'probes and ' : '') + 'results, and your own lessons and planned next experiment. Nothing is added to it for you except the facts of what you did and how games ended. Write in it what you want to remember: a note can cite your games as "<game>" and positions of them as "<game>@<turn>".',
  (t: Tools) => 'Every round, take a stance on EVERY belief you still hold: "keep", "revise" (give the new statement), "confirm" (the evidence settled it) or "drop" (the evidence refuted it); add new ones with "new". Cite the evidence: games, positions, ' + (t.has('probes') ? 'probes, ' : '') + 'rounds.',
  '',
  [INVESTIGATIVE, 'INVESTIGATE before proposing. Instead of a proposal you may answer {"investigate": [ ...requests ], "notes": [ ...optional ]}; the results come back in `investigation`, and `steps_left` says how many more such answers you have this round. Requests:'],
  [['view'], '  {"view": "<game>", "from": <turn>, "to": <turn>}   the pictures of a stretch of one of your games (at most 30 per request)'],
  [['inspect'], '  {"inspect": "<game>@<turn>"}   what YOUR search did on that turn of yours: the position it chose to move to (named "<game>@<turn>/<k>", with its picture), the value your formula gave it looking ahead and directly, what each of its rules answered and what each of its code observations measured there (the parts behind the direct value), and the finished games your search ran into after it within its horizon, and who won them'],
  [['try'], '  {"try": "<position>", "from": [row, col], "to": [row, col]}   on a position of your games where it is your turn, TRY a change you imagine: move what is at (row, col) of the picture to (row, col). The environment only answers whether it allowed it and, if so, shows the picture that results (named "try<n>", usable in later requests) and whether that change ended the game (and who won). It never says why a change was refused or why a game ended: that is for you to work out. A try is how you TEST an idea about how games end, directly. Trying changes nothing in any game.'],
  [['measure'], '  {"measure": {"source": "(p) => ...", "range": [min, max]}, "on": ["<game>@<turn>", "<game>@<turn>/<k>", ...]}   the value of that code on those positions (without "range": the text it composes, as the judge would read it)'],
  [['play'], '  {"play": "<position>", "formula": <round> | { "observations": ..., "rules": ..., "weights": ... }}   PLAY a game again yourself: from any position of your games ("<game>@0" is its start, "<game>@<turn>" a moment of it, "try<n>" where a try left you), your side choosing with the formula of that round, or with a draft you write in the same shape as a proposal (without "formula", your best formula). Whatever you do not control behaves as it always does, so the same experiment can end differently. You get a new game (its name, how it ended, how many turns), to view and inspect like any other. Repeat an experiment, or change one thing and play it again: it is your laboratory, and nothing it plays counts on the scoreboard. At most `plays_left` games this round.'],
  '',
  'HOW YOU THINK. What follows are lenses from your disciplines, each with examples of how your instruments can serve it. They are examples, not a procedure, and they describe nothing about this environment. Combine the instruments in any way you judge useful, use them for purposes not mentioned here, bring in anything else you know that applies, and when the environment does not fit a model, change the model.',
  '',
  '1. FORMAL MODELS (set theory and logic). Describe what you learn as sets, relations and predicates, and keep that description in your notes. For example:',
  [['try'], '  - The changes allowed from a position can be seen as a set; each `try` is then a membership query (allowed: in the set; refused: not in it), and pairs of consecutive pictures in `view` are observed members of the set for whoever acted.'],
  (t: Tools) => '  - The ways an episode can end can be seen as sets of final positions, each defined by a predicate. A candidate predicate can be checked both ways - sufficiency (no position still in play satisfies it) and necessity (every final position of that kind does)' + (t.has('table') ? ' - for instance with `table` over final and in-play positions' : '') + '; each counterexample is evidence for a better candidate.',
  '  - When several instances differ in one respect and agree in another, the smallest predicate covering them is about what they agree on.',
  [['try'], '  - Two tries from the same position that differ in a single change isolate the effect of that change.'],
  '',
  '2. AGENTS AND OUTCOMES (game theory), wherever what happens depends on another agent with aims of its own. For example:',
  '  - Do not assume that every agent is alike: what each can do, and what counts as success for each, may differ and can be established separately. How you succeed is as much an unknown as how you fail.',
  '  - Reasoning backward from outcomes: which positions let a player bring about an outcome at once, which are one step further, and so on. How near each player is to each outcome, and whether another can prevent it, is one way to estimate what a position is worth.',
  '  - A position is worth what the player to move can force from it, not what it looks like.',
  '  - Your formula can be read as your theory made measurable: an estimate of how likely you are to win from a position. Whatever your theory says decides an episode, for you or for anyone else, the formula needs some way to register it; understanding that stays out of the formula does not change how you play.',
  '',
  '3. EVIDENCE (information theory and statistics). For example:',
  '  - Hold rival theories at once, as a distribution rather than a single bet. They are not always exclusive: more than one may hold at once, so before dropping one because another was confirmed, check whether the evidence for it still stands.',
  '  - A conclusion can also be accepted. When a predicate has held in every case you have seen, with no counterexample, and chance does not explain it, adopt it as a working rule and build on it - in your beliefs and in your formula - revising it only when a counterexample appears. Waiting for certainty costs as much as concluding too early.',
  '  - Choose experiments by expected information gain: the most informative experiment is one whose result your rival theories predict differently. One that every theory predicts the same way tells you nothing, however reassuring.',
  (t: Tools) => '  - Prefer the shortest theory that explains all the evidence (minimum description length). An exception is information to absorb, not noise to excuse: when a belief keeps collecting exceptions, gather them, ask what they share that the confirming cases do not, and ' + (t.has('table') || t.has('measure') ? 'measure that property - for instance with ' + [t.has('table') ? '`table`' : '', t.has('measure') ? '`measure`' : ''].filter(Boolean).join(' or ') + '.' : 'look for that property.'),
  '  - Surprise is information: the turns in `surprises`, where your own estimate was most wrong, point to where your theory is weakest.',
  [['probes'], '  - A probe AUC says how much an observation tells you about the outcome: near 0.5 nothing, near 0 or 1 a lot, in either direction.'],
  [['play'], '  - Outcomes have chance in them; `play` lets you measure how much, by repeating an experiment, and attribute an effect by changing one thing at a time.'],
  [['measure', 'table'], '  - Your reading of a picture can be wrong; code can check a reading on the same position before it changes a belief.'],
  '',
  '4. PRACTICE.',
  '  - Reflect on your own trajectory, deeply and every round, before deciding anything. Your notebook is the record of your research: reread it as a demanding reviewer would read someone else\'s work. Follow each belief through its history and ask whether each change was justified by the evidence cited, or by a single case, a misreading, or the pull of the latest game. Look for what you dropped too early and what you kept too long; for theories you revised in circles; for experiments you planned and never ran; for tests whose result you read in the wrong direction; for questions your notes left open. Compare your formulas round by round with the scoreboard: what changed, what the change did, and whether you learned why. Name your own errors plainly, write down what you would do differently, and let that shape this round - the most useful next step is often correcting your course, not adding to it.',
  '  - Keep a THEORY in your notes: your current model, your rival theories, what is still unknown, and the plan that would work if the theory is right. An empty part is where to investigate next.',
  (t: Tools) => '  - Decompose: derive specific claims from the theory and turn each into something you can check - a belief' + (t.has('probes') ? ', a probe' : '') + (t.has('try') ? ', a try' : '') + (t.has('play') ? ', a play' : '') + ', or any other use of your instruments. When a claim fails, revise the theory as a whole, not only that claim.',
  [['try', 'play', 'measure', 'table', 'probes'], '  - An investigation that only looks at pictures leaves your measuring and experimenting instruments idle.'],
  '  - Build your own methods. When a way of investigating works, or wastes your steps, write it down as a METHOD in any answer: "methods": [ {"do": "write", "id": "<id>", "text": "..."} | {"do": "forget", "id": "<id>"} ]. Your methods come back to you every round in `notebook.methods`.',
  '',
  (t: Tools) => '`surprises` lists, for your latest games, the turns where your own search\'s value of your position fell the most before your next turn (or the end): where your formula was most wrong.' + (t.has('inspect') ? ' They are good places to inspect.' : ''),
  '',
  [['probes'], 'Test ideas with PROBES. A probe is a hypothesis plus an observation and/or a question; the observation and the question are tested SEPARATELY, on positions from your own games, each labelled with the SCORE that game ended with for you: a number from -1 to 1. The judge answering a probe question never knows the score and, as with rules, sees only your observations: ask it about their values. You get FACTS, not verdicts - whether they confirm your hypothesis is for you to judge, in the direction you stated it: for each game score, how many positions and their mean value; the AUC (of two positions from games with different scores, the probability that the one from the higher-scored game has the higher value: 0.5 = no relation, 1 = always higher, 0 = always lower); and whether chance alone could put the AUC that far from 0.5 with that many positions. Observations are also tested on final positions (what the end of a game looks like, by its score - this is how you learn how games end). Remember the score belongs to the whole game: early positions of a low-scored game may have been fine.'],
  [['table'], '  {"table": {"source": "(p) => ...", "range": [min, max]}, "on": "in_play" | "final"}   (an investigation request) the value of that code on each position probes use, with the score that game ended with: the rows behind the facts, to inspect yourself'],
  '',
  '`scoreboard` shows how each of your formulas did; a formula\'s `fingerprint` is the same exactly when the formula is the same. `your_best_formula` is the one that has won the most so far - not necessarily your latest. How much a result would vary from one game to another is something you can find out yourself.',
  '',
  'If the payload carries a `task`, it says what this consultation is for and what to answer instead of a proposal.',
  '',
  'When you propose, answer with ONE JSON object and nothing else:',
  '{',
  '  "rationale": "what you believe now and why, citing the evidence",',
  (t: Tools) => '  "beliefs": [ { "id": "<id>", "stance": "new" | "keep" | "revise" | "confirm" | "drop", "statement": "the belief (required for new and revise)", "why": "...", "evidence": ["<game, position, ' + (t.has('probes') ? 'probe ' : '') + 'or round>"] } ],',
  '  "notes": [ { "do": "write", "id": "<id>", "text": "...", "positions": ["<game>@<turn>"] } | { "do": "forget", "id": "<id>" } ],',
  '  "observations": { "<id>": { "definition": "what it measures", "source": "(p) => <number>", "range": [min, max] } | { "definition": "what it shows the judge", "source": "(p) => <text>" } },',
  '  "rules": { "<id>": { "type": "noul" | "score" | "choice", "instructions": "a question, may cite {{observation_id}}", "criteria": ... } },',
  '  "weights": { "<rule id>": number },',
  [['probes'], '  "probes": [ { "id": "<id>", "hypothesis": "...", "observation": { "definition": "...", "source": "(p) => ...", "range": [min, max] } , "question": { "type": ..., "instructions": ..., "criteria": ... } } ],'],
  '  "lessons": ["what this round taught you, in a sentence each"],',
  '  "next_experiment": "what you intend to test next round, and why"',
  '}',
  'Rule types: "noul" answers a probability 0..1 that the statement holds (criteria: {"yes": "...", "no": "..."}); "score" picks a level from criteria ordered worst to best (an array of 3 to 5 strings); "choice" gives probabilities over named options (criteria: {"<option>": "..."}; its value is the probability of the FIRST option, so put the good one first).',
  (t: Tools) => 'Ids are lowercase snake_case.' + (t.has('probes') ? ' A probe needs an observation or a question (or both; inside its question, cite the observation of that same probe as {{probe_<probe id>}}).' : '') + ' Keep observation code short, pure and deterministic; no randomness, no dates.'
];

/** The explorer's system prompt for the instruments it is given (all of them by default). */
export function explorerSystem(tools: Tools = new Set(EXPLORER_TOOLS)): string {
  return EXPLORER_LINES.flatMap((l) => typeof l === 'string' ? [l] : typeof l === 'function' ? [l(tools)] : l[0].some((t) => tools.has(t)) ? [l[1]] : []).join('\n');
}

export const EXPLORER_SYSTEM = explorerSystem();

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
  | { readonly measure: { readonly source: string; readonly range: readonly [number, number] | null }; readonly on: readonly string[] }
  /** `formula`: a round of its own, a draft it wrote (built and checked like a proposal's), or null for its best formula. */
  | { readonly play: string; readonly formula: number | Formula | null };

export type ExplorerTurn =
  | { kind: 'investigate'; requests: ExplorerRequest[]; notes: NoteOp[]; methods: NoteOp[]; warnings: string[] }
  | { kind: 'proposal'; parse: ExplorerParse; notes: NoteOp[]; methods: NoteOp[] };

export function parseNotes(raw: unknown, warnings: string[]): NoteOp[] {
  const out: NoteOp[] = [];
  (Array.isArray(raw) ? raw : []).forEach((n, i) => {
    const o = n && typeof n === 'object' ? n as Record<string, unknown> : null;
    /* Without "do", a note with an id and a text is a write: the intent is plain, and dropping it loses the record. */
    const act = o && o.do === undefined && typeof o.text === 'string' ? 'write' : o?.do;
    if (!o || (act !== 'write' && act !== 'forget') || typeof o.id !== 'string') { warnings.push('note #' + i + ' ignored: needs "id" (and "do": write | forget)'); return; }
    out.push({ do: act, id: o.id, ...(typeof o.text === 'string' ? { text: o.text } : {}),
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
        /* Without a range, the code composes a text: what the judge would read. */
        if (typeof m.source !== 'string' || (m.range !== undefined && !range)) { warnings.push('request #' + i + ': measure needs "source" (and a valid "range" for a number)'); continue; }
        requests.push({ measure: { source: m.source, range }, on: q.on.slice(0, 40).map(String) });
      } else { const t = JSON.stringify(r) ?? String(r); warnings.push('request #' + i + ' ignored (' + (t.length > 200 ? t.slice(0, 199) + '…' : t) + '): use view, inspect, try, play, measure or table'); }
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
      evidenceRef: data.evidence_ref ?? null
    }
  };
}
