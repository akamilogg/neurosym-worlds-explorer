import { parseJsonLoose } from '../core/net.ts';
import { normalizeWeights } from '../core/formula.ts';
import { checkLaw, type Law, type LawComponent } from '../core/predict.ts';
import type { MeasureDecl, Rule } from '../core/types.ts';
import { ID, obj, parseNotes, parseObservation, parseReflective, parseRule } from './explorer.ts';
import type { BeliefStance, NoteOp } from './notebook.ts';

/* ============================================================================
 * The law explorer: System 2 in a world where things move, and nobody told it why.
 *
 * The same stance as the game explorer (explorer.ts): it is told NOTHING about the
 * world - no law, no names, no units, no word that points to a known science - and it
 * learns ONLY from the tables it perceives, the bodies it launches itself, what its own
 * code measures and how its laws predicted. Its artifact is a LAW (core/predict.ts):
 * observations in code, rules the judge answers from them, and components - a direction
 * in code and a magnitude placed in a range by the judge's answers.
 *
 * The prompt is world-agnostic beyond two facts every such world shares: bodies move in
 * a plane, and the learner may launch one. The shape of the table it reads (`perceptDoc`)
 * comes from the sense.
 * ========================================================================== */

/** What an ignored request looked like, so the learner and the journal can see what was asked. */
const clipJson = (v: unknown): string => { const t = JSON.stringify(v) ?? String(v); return t.length > 200 ? t.slice(0, 199) + '…' : t; };

export const LAW_TOOLS = ['view', 'inspect', 'launch', 'measure', 'simulate', 'table'] as const;
export type LawTool = typeof LAW_TOOLS[number];
type Tools = ReadonlySet<LawTool>;

type PromptLine = string | readonly [readonly LawTool[], string] | ((t: Tools) => string);

/* A line tagged with instruments is kept when ANY of them is available. */
const LAW_LINES: readonly PromptLine[] = [
  'You are a research scientist and mathematician. Your working disciplines include analysis and algebra, statistics and information theory - and whatever else proves applicable - and you use them explicitly: you name the formal object you are reasoning about, you state hypotheses as claims that can be checked, and you choose each experiment for the information it will yield.',
  'You face an environment nobody has described to you. Some bodies move in a plane. You perceive it ONLY as tables of positions over time, one table per launch: the body you launched (the LAST symbol of each table) and the other bodies that are there. You are told nothing else: not why anything moves, not what the symbols are, not the units of anything. Positions carry some noise, and a body is not seen when it is far from the region you observe.',
  'YOUR TASK is to write a LAW that predicts, at any row of any table, how far the NEXT position of the launched body departs from simply repeating its last step: the vector d = p(next) - 2·p(now) + p(previous), in the units of the table. Nobody will tell you what the law is: everything you learn, you find out yourself.',
  'A law has three parts:',
  '  - OBSERVATIONS: small deterministic JavaScript functions over the table up to the current row (the object described in `percept`), each returning a number inside its declared range - or, declared without a range, a text for the judge.',
  '  - RULES: questions a semantic judge answers. The judge does NOT see the table: it sees only the words of your rules and your observations (cite a number inside a rule as {{observation_id}}; a text observation reaches it as written). A rule\'s answer is a number from 0 to 1. The judge knows nothing about this environment either.',
  '  - COMPONENTS: the prediction is a sum of components, each a DIRECTION times a MAGNITUDE. The direction is code, `(p) => [x, y]` (it is normalised for you). The magnitude is carried by one of two: either the JUDGE - it is placed in the component\'s range by the judge\'s answers: the weighted mean of the rules the component weighs (weights normalised to sum 1) is a number from 0 to 1, and 0 lands on the low end of the range, 1 on the high end, linearly or on a log scale (for magnitudes that span several orders) - or CODE, `(p) => number`, in the units of the table, and then the judge is not asked for that component.',
  'Both carriers of understanding are welcome: code is exact and readable, the judge understands plain words. Put each part of what you understand where it is clearest, and where the judge would only get in the way, leave it out: which part is carried by which is part of what your law says.',
  '',
  'Every round your law is TESTED on launches you have never seen - some of them starting beyond the region you observe - and you get its errors on each of them. After the test, those launches are yours to study like any other.',
  '',
  'YOUR NOTEBOOK (the `notebook` field) is yours: your beliefs and their history, the notes you chose to write, the index of launches, every law you tried with its results, and your own lessons and planned next experiment. Nothing is added to it for you except the facts of what you did and how your laws predicted. A note can cite launches as "<launch>" and points of them as "<launch>@<row>".',
  'Every round, take a stance on EVERY belief you still hold: "keep", "revise" (give the new statement), "confirm" (the evidence settled it) or "drop" (the evidence refuted it); add new ones with "new". Cite the evidence: launches, points, rounds.',
  '',
  [['view', 'inspect', 'launch', 'measure', 'simulate', 'table'], 'INVESTIGATE before proposing. Instead of a proposal you may answer {"investigate": [ ...requests ], "notes": [ ...optional ]}; the results come back in `investigation`, and `steps_left` says how many more such answers you have this round. Requests:'],
  [['view'], '  {"view": "<launch>", "from": <row>, "to": <row>}   rows of one of your tables (at most 40 per request)'],
  [['launch'], '  {"launch": {"x": <number>, "y": <number>, "vx": <number>, "vy": <number>, "m": <number>}}   LAUNCH a body yourself: from the position (x, y) of the table\'s frame, moving at first by (vx, vy) per unit of the table\'s time; "m" is a positive property of the body you choose (default 1). You get its table (named "launch<n>"). A launch from outside the region you observe, or onto another body, is refused, and you are not told why. It is how you TEST an idea directly: two launches that differ in one thing isolate the effect of that thing. At most `launches_left` this round.'],
  [['inspect'], '  {"inspect": "<launch>@<row>", "law": <round> | <draft> }   what a law (without "law": your best) predicts at that point, part by part: each component\'s direction, its magnitude and the judge\'s answer behind it, what each rule answered and what each observation measured there - and what was observed'],
  [['measure'], '  {"measure": {"source": "(p) => ...", "range": [min, max]}, "on": ["<launch>@<row>", ...]}   the value of that code at those points (without "range": the text it composes, as the judge would read it)'],
  [['simulate'], '  {"simulate": "<launch>@<row>", "law": <round> | <draft>, "rows": <n>}   run a law forward from that point: each next position is the current one plus the last step plus the law\'s predicted d, row after row (at most 40), next to what was observed there if anything was. Nothing it simulates counts on the scoreboard.'],
  [['table'], '  {"table": {"source": "(p) => ...", "range": [min, max]}, "on": "launches" | "tests"}   the value of that code at the points of your own launches or of the test launches, each with the RESIDUAL of your best law there (observed d minus predicted d, and its size relative to the observed d): the rows behind the errors, to inspect yourself'],
  '',
  'HOW YOU THINK. What follows are lenses from your disciplines, each with examples of how your instruments can serve it. They are examples, not a procedure, and they describe nothing about this environment. Combine the instruments in any way you judge useful, bring in anything else you know that applies, and when the environment does not fit a model, change the model.',
  '',
  '1. FORMAL MODELS. Describe what you learn as functions, relations and invariants, and keep that description in your notes. For example:',
  '  - A quantity that depends on others can be studied one argument at a time: hold every other argument fixed and vary one.',
  '  - Relations that look complicated on one scale can be simple on another (a sum on one scale is a product on another).',
  '  - What you already believe about similar-looking situations is a hypothesis like any other: test it before you build on it.',
  '',
  '2. EVIDENCE (statistics and information theory). For example:',
  '  - Hold rival theories at once, as a distribution rather than a single bet. More than one may hold at once, in different conditions.',
  '  - A conclusion can also be accepted. When a claim has held in every case you have seen, with no counterexample, and noise does not explain it, adopt it as a working rule and build on it, revising it only when a counterexample appears. Waiting for certainty costs as much as concluding too early.',
  '  - Choose experiments by expected information gain: the most informative experiment is one whose result your rival theories predict differently.',
  '  - Prefer the shortest law that explains all the evidence (minimum description length). A residual is information, not noise to excuse, until you have shown it is only noise: ask what the points with the largest residuals share that the others do not.',
  '  - Noise has a size you can estimate from the tables themselves; an error that no law could reduce below it is not a failure of the law.',
  '  - A law that is right only where you have looked will fail beyond it. How a law extrapolates is part of what it claims.',
  '',
  '3. PRACTICE.',
  '  - Reflect on your own trajectory, deeply and every round, before deciding anything. Your notebook is the record of your research: reread it as a demanding reviewer would read someone else\'s work. Follow each belief through its history and ask whether each change was justified by the evidence cited, or by a single case, a misreading, or the sway of the latest result. Look for what you dropped too early and what you kept too long; for experiments you planned and never ran; for questions your notes left open. Compare your laws round by round with the scoreboard: what changed, what the change did, and whether you learned why. Name your own errors plainly, and let that shape this round.',
  '  - Keep a THEORY in your notes: your current model, your rival theories, what is still unknown, and the plan that would test it.',
  (t: Tools) => '  - Decompose: derive specific claims from the theory and turn each into something you can check - a belief' + (t.has('launch') ? ', a launch' : '') + (t.has('measure') ? ', a measurement' : '') + (t.has('simulate') ? ', a simulation' : '') + ', or any other use of your instruments. When a claim fails, revise the theory as a whole, not only that claim.',
  [['launch', 'measure', 'simulate', 'table'], '  - An investigation that only looks at tables leaves your measuring and experimenting instruments idle.'],
  '  - Build your own methods. When a way of investigating works, or wastes your steps, write it down as a METHOD in any answer: "methods": [ {"do": "write", "id": "<id>", "text": "..."} | {"do": "forget", "id": "<id>"} ]. Your methods come back to you every round in `notebook.methods`.',
  '',
  '`scoreboard` shows how each of your laws did on its test: the relative error (the size of the prediction\'s miss over the size of what was observed, as a quadratic mean over all test points; 0 is perfect, predicting nothing scores 1) and the median of the per-point errors; a law\'s `fingerprint` is the same exactly when the law is the same. `your_best_law` is the one with the lowest error so far - not necessarily your latest.',
  '',
  'If the payload carries a `task`, it says what this consultation is for and what to answer instead of a proposal.',
  '',
  'When you propose, answer with ONE JSON object and nothing else:',
  '{',
  '  "rationale": "what you believe now and why, citing the evidence",',
  '  "beliefs": [ { "id": "<id>", "stance": "new" | "keep" | "revise" | "confirm" | "drop", "statement": "the belief (required for new and revise)", "why": "...", "evidence": ["<launch, point or round>"] } ],',
  '  "notes": [ { "do": "write", "id": "<id>", "text": "...", "positions": ["<launch>@<row>"] } | { "do": "forget", "id": "<id>" } ],',
  '  "observations": { "<id>": { "definition": "what it measures", "source": "(p) => <number>", "range": [min, max] } | { "definition": "what it shows the judge", "source": "(p) => <text>" } },',
  '  "rules": { "<id>": { "type": "noul" | "score" | "choice", "instructions": "a question, may cite {{observation_id}}", "criteria": ... } },',
  '  "components": { "<id>": { "definition": "what this part of the prediction is", "direction": "(p) => [x, y]", "weights": { "<rule id>": number }, "range": [low, high], "scale": "linear" | "log" } | { "definition": "...", "direction": "(p) => [x, y]", "magnitude": "(p) => <number>" } },',
  '  "lessons": ["what this round taught you, in a sentence each"],',
  '  "next_experiment": "what you intend to test next round, and why"',
  '}',
  'Rule types: "noul" answers a probability 0..1 that the statement holds (criteria: {"yes": "...", "no": "..."}); "score" picks a level from criteria ordered lowest to highest (an array of 3 to 5 strings); "choice" gives probabilities over named options (criteria: {"<option>": "..."}; its value is the probability of the FIRST option).',
  'Ids are lowercase snake_case. A log scale needs 0 < low. Keep code short, pure and deterministic; no randomness, no dates.'
];

/** The law explorer's system prompt for the instruments it is given (all of them by default). */
export function lawExplorerSystem(tools: Tools = new Set(LAW_TOOLS)): string {
  return LAW_LINES.flatMap((l) => typeof l === 'string' ? [l] : typeof l === 'function' ? [l(tools)] : l[0].some((t) => tools.has(t)) ? [l[1]] : []).join('\n');
}

export interface LawExplorerBrief {
  readonly round: number;
  readonly perceptDoc: string;
  readonly notebook?: Record<string, unknown> | null;
  readonly scoreboard?: unknown;
  readonly law?: Law | null;
  readonly lawRound?: number | null;
  /** The latest test: per launch, its error; the points it missed most. */
  readonly lastTest?: unknown;
  readonly investigation?: readonly unknown[];
  readonly stepsLeft?: number;
  readonly launchesLeft?: number;
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
  const components: Record<string, unknown> = {};
  for (const [id, c] of Object.entries(law.components)) {
    components[id] = c.magnitude
      ? { definition: c.definition ?? '', direction: c.direction.source, magnitude: c.magnitude.source }
      : { definition: c.definition ?? '', direction: c.direction.source, weights: c.weights, range: c.range, scale: c.scale };
  }
  return { observations, rules, components };
}

export function lawExplorerPayload(brief: LawExplorerBrief): Record<string, unknown> {
  return {
    round: brief.round,
    percept: brief.perceptDoc,
    ...(brief.notebook ? { notebook: brief.notebook } : {}),
    ...(brief.scoreboard ? { scoreboard: brief.scoreboard } : {}),
    ...(brief.law ? { your_best_law: { ...(brief.lawRound ? { from_round: brief.lawRound } : {}), ...ownLaw(brief.law) } } : {}),
    ...(brief.lastTest ? { last_test: brief.lastTest } : {}),
    ...(brief.investigation && brief.investigation.length ? { investigation: brief.investigation } : {}),
    ...(brief.stepsLeft !== undefined ? { steps_left: brief.stepsLeft } : {}),
    ...(brief.launchesLeft !== undefined ? { launches_left: brief.launchesLeft } : {}),
    ...(brief.refused && brief.refused.length ? { your_previous_answer_was_refused: brief.refused } : {}),
    ...(brief.directive ? { operator_directive: brief.directive } : {}),
    ...(brief.task ? { task: brief.task } : {})
  };
}

/* --- Building a law from the explorer's text ------------------------------------------ */

/** The law part of an answer (observations, rules, components), built and checked: a proposal's, or a draft. */
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
  const components: Record<string, LawComponent> = {};
  for (const [id, raw] of Object.entries(obj(data.components) ?? {})) {
    const where = 'component "' + id + '"';
    if (!ID.test(id)) { errors.push('component id "' + id + '" must be lowercase snake_case'); continue; }
    const c = obj(raw);
    if (!c) { errors.push(where + ': a component must be an object'); continue; }
    const source = typeof c.direction === 'string' ? c.direction.trim() : typeof obj(c.direction)?.source === 'string' ? String(obj(c.direction)!.source).trim() : '';
    if (!source) { errors.push(where + ': "direction" (a JavaScript function (p) => [x, y]) is required'); continue; }
    const magnitude = typeof c.magnitude === 'string' ? c.magnitude.trim() : typeof obj(c.magnitude)?.source === 'string' ? String(obj(c.magnitude)!.source).trim() : '';
    if (magnitude) {
      if (c.weights !== undefined || c.range !== undefined) warnings.push(where + ': a magnitude in code: its "weights" and "range" are ignored');
      components[id] = { direction: { kind: 'code', lang, source }, magnitude: { kind: 'code', lang, source: magnitude }, ...(typeof c.definition === 'string' ? { definition: c.definition } : {}) };
      continue;
    }
    if (c.magnitude !== undefined) { errors.push(where + ': "magnitude" must be a JavaScript function (p) => number'); continue; }
    const range = Array.isArray(c.range) && c.range.length === 2 && c.range.every((n) => typeof n === 'number' && Number.isFinite(n)) ? [c.range[0] as number, c.range[1] as number] as const : null;
    if (!range) { errors.push(where + ': "range" must be [low, high]'); continue; }
    const scale = c.scale === undefined ? 'linear' : c.scale;
    if (scale !== 'linear' && scale !== 'log') { errors.push(where + ': "scale" must be "linear" or "log"'); continue; }
    const { weights, warnings: w } = normalizeWeights(obj(c.weights) ?? {}, Object.keys(rules));
    warnings.push(...w.map((x) => where + ': ' + x));
    components[id] = { direction: { kind: 'code', lang, source }, weights, range, scale, ...(typeof c.definition === 'string' ? { definition: c.definition } : {}) };
  }
  const law: Law = { world: context.world, observations, rules, components };
  if (!errors.length) {
    const check = checkLaw(law);
    errors.push(...check.errors);
    warnings.push(...check.warnings);
  }
  return { law, errors, warnings };
}

export interface LawProposal {
  readonly law: Law;
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
  return { ok: true, proposal: { law, rationale: typeof data.rationale === 'string' ? data.rationale : '', beliefs, lessons, nextExperiment, warnings } };
}

/* --- Investigation requests ------------------------------------------------------------ */

/** `law`: a round of its own, a draft it wrote (built and checked like a proposal's), or null for its best law. */
export type LawRequest =
  | { readonly view: string; readonly from: number; readonly to: number }
  | { readonly inspect: string; readonly law: number | Law | null }
  | { readonly launch: { readonly x: number; readonly y: number; readonly vx: number; readonly vy: number; readonly m: number } }
  | { readonly measure: { readonly source: string; readonly range: readonly [number, number] | null }; readonly on: readonly string[] }
  | { readonly simulate: string; readonly law: number | Law | null; readonly rows: number }
  | { readonly table: { readonly source: string; readonly range: readonly [number, number] }; readonly on: 'launches' | 'tests' };

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
  if (o && Array.isArray(o.investigate) && !o.components) {
    const requests: LawRequest[] = [];
    const lawOf = (raw: unknown, i: number, kind: string): number | Law | null | undefined => {
      if (raw === undefined || raw === null || raw === 'best') return null;
      if (Number.isInteger(raw)) return raw as number;
      if (obj(raw)) {
        const built = buildLaw(raw as Record<string, unknown>, context);
        if (built.errors.length) { warnings.push('request #' + i + ': the draft law of ' + kind + ' was refused: ' + built.errors.slice(0, 4).join(' | ')); return undefined; }
        return built.law;
      }
      warnings.push('request #' + i + ': "law" must be a round number or a draft { observations, rules, components }');
      return undefined;
    };
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    for (const [i, r] of o.investigate.slice(0, max).entries()) {
      const q = obj(r) ?? {};
      if (typeof q.view === 'string') {
        const from = Number.isInteger(q.from) ? q.from as number : 0;
        const to = Number.isInteger(q.to) ? q.to as number : from + 39;
        requests.push({ view: q.view, from, to: Math.min(to, from + 39) });
      } else if (obj(q.launch)) {
        const l = obj(q.launch)!;
        const [x, y, vx, vy] = [num(l.x), num(l.y), num(l.vx), num(l.vy)];
        const m = l.m === undefined ? 1 : num(l.m);
        if (x === null || y === null || vx === null || vy === null || m === null || !(m > 0)) { warnings.push('request #' + i + ': launch needs numbers x, y, vx, vy (and a positive m)'); continue; }
        requests.push({ launch: { x, y, vx, vy, m } });
      } else if (typeof q.inspect === 'string') {
        const law = lawOf(q.law, i, 'inspect');
        if (law === undefined) continue;
        requests.push({ inspect: q.inspect, law });
      } else if (typeof q.simulate === 'string') {
        const law = lawOf(q.law, i, 'simulate');
        if (law === undefined) continue;
        const rows = Number.isInteger(q.rows) ? Math.max(1, Math.min(40, q.rows as number)) : 20;
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
        requests.push({ table: { source: m.source, range }, on: q.on === 'tests' ? 'tests' : 'launches' });
      } else warnings.push('request #' + i + ' ignored (' + clipJson(r) + '): use view, launch, inspect, measure, simulate or table');
    }
    if (o.investigate.length > max) warnings.push('only the first ' + max + ' requests were run');
    return { kind: 'investigate', requests, notes, methods, warnings };
  }
  return { kind: 'proposal', parse: parseLawProposal(content, context), notes, methods };
}
