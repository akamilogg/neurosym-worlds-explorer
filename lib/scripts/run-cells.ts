/* cells@1: a third environment, connected to the common prompt and protocol with only its world, senses, actions and
   objective (SPEC-OBJETIVO O5). System 2 perceives rows of symbols and must write a model that answers the next row.

     node --experimental-strip-types scripts/run-cells.ts --seed 1 --level 1 [options]

   Endpoints and keys come from the environment (never from the command line, never written to the journal):
     JEV_URL (default https://api.typesafe.ai/v1/systemone), JEV_KEY
     LLM_URL (an OpenAI-compatible /chat/completions URL), LLM_KEY, LLM_MODEL
   Options:
     --seed N            the world (default 1)
     --level N           1 the next symbol depends on a cell and its neighbours; 2 on a count within two cells (default 1)
     --attempts N        proposal/check rounds (default 8)
     --explore N         episodes the environment runs in the laboratory before the first proposal (default 3)
     --steps N           investigation answers System 2 may give per round before proposing (default 3)
     --acts N            episodes System 2 may start itself per round (default 4)
     --check-episodes N  episodes per place in a check, a validation or a confirmation (default 2)
     --every N           take every N-th step of an episode as a point of a check (default 3)
     --family N          places of the family to validate on (default 3)
     --validations N     how many times System 2 may validate (default 3)
     --confirm-places N  places per blind confirmation set, two sets (default 2)
     --no-regression     do not answer each laboratory's previous check again with the new model
     --tools a,b,...     the instruments (default all = view,inspect,act,measure,simulate,table; "none" = none)
     --quick             stop the first time System 2 asks to validate, without validating
     --no-ablation       skip the operator's flat-judge arm (every rule answering 0.5)
     --no-grade          skip the operator-only grading of the recovered rule (one LLM call)
     --no-reflection     skip the final reflection round
     --flat              CONTROL: a Judge that knows nothing (every answer neutral); the LLM is still consulted
     --out FILE          the journal (default runs/cells-s<seed>L<level>-<time>.json)

   The protocol is the researcher's (learn/protocol.ts), the same as in the other worlds. The journal keeps the hidden
   rule and the operator's measures; they never reach System 2 or the Judge. */
import fs from 'node:fs';
import path from 'node:path';
import { Observer } from '../src/core/observer.ts';
import { Evaluator } from '../src/core/evaluate.ts';
import { JevJudge, JEV_DEFAULT_URL } from '../src/core/jev.ts';
import { parseJsonLoose } from '../src/core/net.ts';
import { Predictor, type Law } from '../src/core/predict.ts';
import { nodeVmRunner } from '../src/runtime/node-vm.ts';
import { openAiChatClient } from '../src/learn/system2.ts';
import { replayOnEvidence } from '../src/learn/gates.ts';
import { reflectionTask, system2Prompt, toolOf, type Tool } from '../src/learn/prompt.ts';
import { ownLaw, type LawRequest } from '../src/learn/law-explorer.ts';
import { LawSession, lawFingerprint } from '../src/learn/law-session.ts';
import { Protocol } from '../src/learn/protocol.ts';
import { GRADING_STRUCTURE, formOf, operatorSummary, tokensOf, type AblationRecord } from '../src/learn/operator.ts';
import type { Place } from '../src/learn/objective.ts';
import { mulberry32 } from '../src/worlds/grid/gen.ts';
import { CELLS_PERCEPT_DOC, cellsPointWorld, describeCellsTruth, generateCells, perceiveCells, placeOf, readRow, runEpisode, type CellsPoint, type CellsSpec } from '../src/worlds/cells/world.ts';
import { cellsObjective, differences, type CellsCase } from '../src/worlds/cells/objective.ts';
import { cellsInterface } from '../src/worlds/cells/interface.ts';
import type { MeasureDecl } from '../src/core/types.ts';
import { ROOT } from '../test/support.ts';

/* --- Configuration ---------------------------------------------------------------- */

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
const flag = (name: string): boolean => argv.includes('--' + name);
const ALL: readonly Tool[] = cellsInterface().tools;
function parseTools(value: string): Tool[] {
  if (value === 'all') return [...ALL];
  if (value === 'none') return [];
  const asked = value.split(',').map((t) => t.trim()).filter(Boolean).map((t) => toolOf(t) ?? t);
  const unknown = asked.filter((t) => !(ALL as readonly string[]).includes(t));
  if (unknown.length) { console.error('--tools: unknown ' + unknown.join(', ') + ' (tools: ' + ALL.join(', ') + ', or all / none)'); process.exit(2); }
  return ALL.filter((t) => asked.includes(t));
}
const cfg = {
  seed: Number(arg('seed', '1')),
  level: Number(arg('level', '1')),
  attempts: Number(arg('attempts', '8')),
  explore: Number(arg('explore', '3')),
  steps: Number(arg('steps', '3')),
  acts: Number(arg('acts', '4')),
  checkEpisodes: Math.max(1, Number(arg('check-episodes', '2'))),
  every: Math.max(1, Number(arg('every', '3'))),
  family: Math.max(1, Number(arg('family', '3'))),
  validations: Math.max(1, Number(arg('validations', '3'))),
  confirmPlaces: Math.max(1, Number(arg('confirm-places', '2'))),
  regression: !flag('no-regression'),
  tools: parseTools(arg('tools', 'all')),
  quick: flag('quick'),
  ablation: !flag('no-ablation') && !flag('quick'),
  grade: !flag('no-grade'),
  reflection: !flag('no-reflection') && !flag('quick'),
  flat: flag('flat')
};
const tools: ReadonlySet<Tool> = new Set(cfg.tools);
const investigative = cfg.tools.length > 0;
const SYSTEM_PROMPT = system2Prompt(cellsInterface({ regression: cfg.regression }), tools);
const env = process.env;
if (!env.LLM_URL || !env.LLM_MODEL) { console.error('LLM_URL and LLM_MODEL are required (and LLM_KEY if the endpoint needs one).'); process.exit(2); }
if (!cfg.flat && !env.JEV_KEY) { console.error('JEV_KEY is required (or run the --flat control).'); process.exit(2); }

/* --- The world, as the operator knows it and as the learner perceives it ------------- */

const spec = generateCells(cfg.seed, cfg.level);
interface CellsPlace extends Place { readonly spec: CellsSpec }
const places = new Map<string, CellsPlace>();
places.set('lab1', { id: 'lab1', spec, role: 'laboratory', seen: true });
for (let k = 1; k <= cfg.family; k++) places.set('place' + k, { id: 'place' + k, spec: placeOf(spec, k), role: 'family', seen: false });
const labs = () => [...places.values()].filter((p) => p.role === 'laboratory');

const world = cellsPointWorld();
const runner = nodeVmRunner({ timeoutMs: 2000 });
const observer = new Observer<CellsPoint>(world, { kinds: ['code'], runners: [runner], perceive: (s) => perceiveCells(s) });
const flatFetch = async (_u: string, init: { body?: string }) => {
  const body = JSON.parse(String(init.body));
  const answers: Record<string, unknown> = {};
  for (const [id, q] of Object.entries<any>(body.questions)) {
    answers[id] = q.type === 'choice' ? { type: 'choice', probabilities: Object.fromEntries(Object.keys(q.criteria).map((k, i) => [k, i === 0 ? 0.5 : 0.25])), confidence: 0.3 }
      : q.type === 'score' ? { type: 'score', score: Math.floor((q.criteria.length - 1) / 2), confidence: 0.3 } : { type: 'noul', noul: 0.5 };
  }
  const text = JSON.stringify({ answers });
  return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
};
const judge = new JevJudge(cfg.flat
  ? { url: JEV_DEFAULT_URL, apiKey: 'flat', fetch: flatFetch as never }
  : { url: env.JEV_URL || JEV_DEFAULT_URL, apiKey: env.JEV_KEY, model: env.JEV_MODEL, timeoutMs: 90000, retries: 4, retryNetwork: true, concurrency: 8 });
const evaluator = new Evaluator<CellsPoint>(observer, judge, { maximizer: 'nature', runners: [runner] });
/* The answer is a row: nothing numeric is compared, so the Predictor's comparison is unused (the objective compares). */
const predictor = new Predictor<CellsPoint>(evaluator, perceiveCells, { runners: [runner] });
const llmUse = { calls: 0, tokens: 0 };
const llm = openAiChatClient({ url: env.LLM_URL, apiKey: env.LLM_KEY, model: env.LLM_MODEL, jsonMode: true, temperature: 0.4, timeoutMs: 180000, retries: 1,
  onRequest: () => { llmUse.calls++; }, onAnswer: (a) => { llmUse.tokens += tokensOf(a.raw); } });

/* --- The journal ------------------------------------------------------------------ */

const started = new Date();
const outFile = arg('out', path.join(ROOT, 'runs', 'cells-s' + cfg.seed + 'L' + cfg.level + '-' + started.toISOString().replace(/[:.]/g, '-') + '.json'));
fs.mkdirSync(path.dirname(outFile), { recursive: true });
const truth = describeCellsTruth(spec);
const journal: Record<string, any> = {
  experiment: 'cells@1', started: started.toISOString(), config: { ...cfg, llm_model: env.LLM_MODEL, jev_model: env.JEV_MODEL ?? null },
  hidden_from_the_learner: { spec, truth, places: [...places.values()].map((p) => ({ id: p.id, role: p.role, width: p.spec.width, density: p.spec.density })) },
  events: [] as unknown[]
};
const log = (type: string, data: Record<string, unknown> = {}): void => {
  journal.events.push({ t: Math.round((Date.now() - started.getTime()) / 1000), type, ...data });
  fs.writeFileSync(outFile, JSON.stringify(journal, null, 2));
};
const say = (text: string): void => console.log('[' + Math.round((Date.now() - started.getTime()) / 1000) + 's] ' + text);

/* --- The learner's episodes ------------------------------------------------------------ */

interface StoredEpisode { readonly id: string; readonly place: string; readonly round: number; readonly by: string; readonly rows: string[] }
const episodes = new Map<string, StoredEpisode>();
let counter = 0;
const store = (id: string, place: CellsPlace, round: number, by: string, rows: string[]) => { const e = { id, place: place.id, round, by, rows }; episodes.set(id, e); return e; };
const episodeIndex = () => [...episodes.values()].map((e) => ({ episode: e.id, place: e.place, round: e.round, by: e.by, steps: e.rows.length - 1 }));

/** "ep3@5": the rows of ep3 up to step 5, with the row that came next (if any). */
function resolve(ref: string): { point: CellsPoint; next: string | null } | null {
  const m = /^([a-z][a-z0-9-]*)@(\d+)$/.exec(ref.trim());
  const e = m ? episodes.get(m[1]) : undefined;
  if (!m || !e) return null;
  const step = Number(m[2]);
  if (step < 0 || step >= e.rows.length) return null;
  return { point: { rows: e.rows.slice(0, step + 1) }, next: e.rows[step + 1] ?? null };
}

/** Points of episodes: every `every`-th step from the start (the first steps carry the most), each with a next row. */
/* A point needs as many rows as the next one depends on (the operator's `order`; never told). */
const firstPoint = (spec.order ?? 1) - 1;
const pointsOf = (e: StoredEpisode, every = cfg.every) => Array.from({ length: e.rows.length - 1 }, (_, t) => t).filter((t) => t >= firstPoint && (t - firstPoint) % every === 0)
  .map((t): CellsCase => ({ point: e.id + '@' + t, state: { rows: e.rows.slice(0, t + 1) }, next: e.rows[t + 1] }));
const ownPoints = () => [...episodes.values()].filter((e) => e.by === 'you' || e.by === 'the environment').flatMap((e) => pointsOf(e, 2));
const checkPoints = new Map<number, CellsCase[]>();

function explore(): void {
  const rnd = mulberry32(cfg.seed * 1013 + cfg.level);
  const lab = places.get('lab1')!;
  for (let k = 0; k < cfg.explore; k++) {
    const e = store('ep' + (++counter), lab, 0, 'the environment', runEpisode(lab.spec, rnd));
    log('exploration_episode', { episode: e.id, rows: e.rows });
  }
}

/* --- The objective and the protocol ------------------------------------------------------------ */

const answerOf = async (law: Law, state: CellsPoint) => (await predictor.predict(law, state)).answer;
const objective = cellsObjective<Law, CellsPlace>({
  casesIn(place, c) {
    /* Fresh episodes in the place; a check's and a validation's become the learner's, a blind confirmation's never. */
    const rnd = mulberry32(cfg.seed * 7717 + c.round * 101 + c.index * 7 + (c.purpose === 'validation' ? 5000 : c.purpose === 'blind' ? 100000 * (1 + (c.set ?? 0)) : 0));
    const cases: CellsCase[] = [];
    for (let k = 0; k < cfg.checkEpisodes; k++) {
      const rows = runEpisode(place.spec, rnd);
      const id = c.purpose === 'blind' ? place.id + '-' + k : (c.purpose === 'check' ? 'check' : 'valid') + c.round + '-' + place.id + '-' + (k + 1);
      const e = c.purpose === 'blind' ? { id, rows } : store(id, place, c.round, 'the ' + c.purpose + ' of round ' + c.round, rows);
      cases.push(...pointsOf(e as StoredEpisode));
    }
    if (c.purpose !== 'blind') checkPoints.set(c.round, [...(checkPoints.get(c.round) ?? []), ...cases]);
    return cases;
  },
  answer: answerOf,
  regression: cfg.regression
});
let blindCounter = 0;
const protocol = new Protocol(objective, {
  places: () => [...places.values()],
  blindPlaces: () => Array.from({ length: cfg.confirmPlaces }, () => { const k = ++blindCounter; return { id: 'blind' + k, spec: placeOf(spec, 1000 + k), role: 'confirmation' as const, seen: false }; }),
  fingerprint: (law) => lawFingerprint(law),
  validations: cfg.validations, pairedRegression: cfg.regression, quick: cfg.quick,
  cost: () => ({ jev_calls: judge.stats.calls, jev_not_asked: evaluator.stats.judgeUnread, llm_calls: llmUse.calls, llm_tokens: llmUse.tokens }),
  /* OPERATOR ONLY: models that know nothing. If one holds too, the check could not tell a model from knowing nothing. */
  baselines: ([['the same row again', '(p) => p.rows[p.rows.length - 1]'],
    ['the row before it', '(p) => p.rows[Math.max(0, p.rows.length - 2)]'],
    ...spec.glyphs.map((g) => ['a row of "' + g + '" only', '(p) => ' + JSON.stringify(g) + '.repeat(p.rows[p.rows.length - 1].length)'])] as const)
    .map(([name, source]) => ({ name, model: { world: world.id, observations: {}, rules: {}, weights: {}, output: { kind: 'code' as const, lang: 'js', source } } })),
  say
});

/* --- Instruments ------------------------------------------------------------------------ */

/** An act: the row to start from - or several, oldest first, the last being the present. */
interface CellsAct { readonly rows: readonly string[]; readonly place?: string }
const parseAct = (raw: Record<string, unknown>): CellsAct | string => {
  const rows = typeof raw.row === 'string' ? [raw.row] : Array.isArray(raw.rows) && raw.rows.length && raw.rows.length <= 4 && raw.rows.every((r) => typeof r === 'string') ? raw.rows as string[] : null;
  return rows ? { rows, ...(typeof raw.place === 'string' ? { place: raw.place } : {}) } : 'act needs "row" (a string) or "rows" (a list of strings)';
};

/** A law must compute on points of the learner's own episodes and answer a string there (no Judge call). */
function failures(law: Law): string[] {
  const points = ownPoints().slice(-8);
  const errors = replayOnEvidence(observer, law.observations, points.map((p) => ({ state: p.state }))).errors.slice(0, 4).map((e) => (e.observation ?? '') + ': ' + e.error);
  if (errors.length) return errors;
  const neutral = Object.fromEntries(Object.keys(law.rules).map((id) => [id, 0.5]));
  for (const p of points.slice(0, 4)) {
    try {
      const a = predictor.rawAnswerWith(law, predictor.measured(law, p.state), neutral);
      if (typeof a !== 'string') return ['output: the answer must be a string (it was ' + JSON.stringify(a)?.slice(0, 60) + ')'];
    } catch (e) { return ['output: ' + String((e as Error).message ?? e)]; }
  }
  return [];
}

async function runRequest(req: LawRequest<CellsAct>, budget: { acts: number }): Promise<unknown> {
  const kind = (['view', 'inspect', 'act', 'measure', 'simulate', 'table'] as const).find((k) => k in req)!;
  if (!tools.has(kind)) return { [kind]: (req as Record<string, unknown>)[kind], error: '"' + kind + '" is not available in this experiment' };
  if ('view' in req) {
    const e = episodes.get(req.view);
    if (!e) return { view: req.view, error: 'no such episode' };
    return { view: e.id, steps: e.rows.length - 1, rows: e.rows.slice(Math.max(0, req.from), Math.max(0, req.to) + 1).map((row, i) => ({ step: Math.max(0, req.from) + i, row })) };
  }
  if ('act' in req) {
    if (budget.acts <= 0) return { act: req.act, error: 'no acts left this round' };
    const place = places.get(req.act.place ?? 'lab1');
    if (!place || place.role !== 'laboratory') return { act: req.act, error: 'you can act only in your laboratories: ' + labs().map((l) => l.id).join(', ') };
    const rows = req.act.rows.map((r) => readRow(place.spec, r));
    /* The environment answers only whether it accepted: never why not. */
    if (rows.some((r) => !r)) return { act: req.act, accepted: false };
    budget.acts--;
    const e = store('act' + (++counter), place, session.currentRound, 'you', runEpisode(place.spec, rows as number[][]));
    return { act: req.act, accepted: true, name: e.id, rows: e.rows };
  }
  if ('measure' in req) {
    const decl: MeasureDecl = { spec: { kind: 'code', lang: 'js', source: req.measure.source }, ...(req.measure.range ? { range: req.measure.range } : {}) };
    return { measure: req.measure.source, values: req.on.map((ref) => {
      const r = resolve(ref);
      if (!r) return { point: ref, error: 'no such point' };
      const o = observer.observe(r.point, { m: decl });
      const err = o.errors.find((e) => e.id === 'm');
      return err ? { point: ref, error: err.error } : { point: ref, value: o.values.m ?? o.texts.m };
    }) };
  }
  if ('inspect' in req) {
    const law = session.lawOf(req.law);
    const r = resolve(req.inspect);
    if (!law) return { inspect: req.inspect, error: 'there is no model yet: name a draft' };
    if (!r) return { inspect: req.inspect, error: 'no such point' };
    const f = typeof req.law === 'object' && req.law ? failures(law) : [];
    if (f.length) return { inspect: req.inspect, error: 'your draft failed on points of your episodes: ' + f.join(' | ') };
    try {
      /* A model taken apart: its rules are answered even when its output does not read them. */
      const pr = await predictor.predict(law, r.point, { askRules: true });
      return { inspect: req.inspect, your_observations_measured: pr.observations,
        ...(pr.evaluation ? { each_rule_answered: pr.rules, V: pr.V } : { the_judge_was_not_asked: true }),
        your_answer: pr.answer, ...(Object.keys(pr.parts).length ? { your_output_also_returned: pr.parts } : {}), the_next_row_was: r.next };
    } catch (e) { return { inspect: req.inspect, error: String((e as Error).message ?? e) }; }
  }
  if ('simulate' in req) {
    const law = session.lawOf(req.law);
    const r = resolve(req.simulate);
    if (!law) return { simulate: req.simulate, error: 'there is no model yet: name a draft' };
    if (!r) return { simulate: req.simulate, error: 'no such point' };
    const [id, at] = req.simulate.split('@');
    const seen = episodes.get(id)!.rows;
    const rows = [...r.point.rows];
    const steps: unknown[] = [];
    try {
      for (let k = 0; k < req.rows; k++) {
        const a = await answerOf(law, { rows });
        if (typeof a !== 'string') return { simulate: req.simulate, error: 'the answer was not a string', steps };
        rows.push(a);
        steps.push({ step: Number(at) + k + 1, simulated: a, seen: seen[Number(at) + k + 1] ?? null });
      }
    } catch (e) { return { simulate: req.simulate, error: String((e as Error).message ?? e), steps }; }
    return { simulate: req.simulate, steps };
  }
  /* table: code on every point of its episodes or of the checks, with the row that came next there. */
  const decl: MeasureDecl = { spec: { kind: 'code', lang: 'js', source: req.table.source }, ...(req.table.range ? { range: req.table.range } : {}) };
  const points = req.on === 'checks' ? [...checkPoints.values()].flat().slice(-60) : ownPoints().slice(-60);
  return { table: req.table.source, on: req.on, rows: points.map((p) => {
    const o = observer.observe(p.state, { m: decl });
    const err = o.errors.find((e) => e.id === 'm');
    return { point: p.point, ...(err ? { error: err.error } : { value: o.values.m ?? o.texts.m }), the_next_row_was: p.next };
  }) };
}

const session = new LawSession<CellsAct>({
  llm, system: SYSTEM_PROMPT, world: world.id, perceptDoc: CELLS_PERCEPT_DOC, steps: cfg.steps, investigative,
  ...(tools.has('act') ? { acts: cfg.acts } : {}), parseAct,
  runRequest: (r, budget) => runRequest(r, budget),
  known: (ref) => episodes.has(ref.trim()) || resolve(ref) !== null,
  failures,
  episodes: episodeIndex,
  places: () => protocol.placesView(), validationsLeft: () => protocol.validationsLeft, lastCheck: () => protocol.lastView,
  log, say
});

/* --- Operator only ------------------------------------------------------------------------- */

/** The same model with every rule answering 0.5 (a Judge that knows nothing), on the same points: what the rules add. */
const ablations: AblationRecord[] = [];
async function ablate(law: Law, round: number): Promise<void> {
  if (!Object.keys(law.rules).length) return;
  const points = checkPoints.get(round) ?? [];
  const neutral = Object.fromEntries(Object.keys(law.rules).map((id) => [id, 0.5]));
  let model = 0, flat = 0;
  for (const p of points) {
    try { if (differences(await answerOf(law, p.state), p.next)?.length === 0) model++; } catch { /* a miss */ }
    try { if (differences(predictor.rawAnswerWith(law, predictor.measured(law, p.state), neutral), p.next)?.length === 0) flat++; } catch { /* a miss */ }
  }
  ablations.push({ round, model, withoutJudge: flat, better: 'higher' });
  log('operator_ablation_flat_judge', { round, points: points.length, model_exact: model, flat_judge_exact: flat });
  say('  [operator] ablation: model ' + model + '/' + points.length + ' exact, every rule at 0.5: ' + flat + '/' + points.length);
}

async function gradeRecovery(final: Law | null): Promise<void> {
  const brief = session.notebook.brief();
  const learned = { final_model: final ? ownLaw(final) : null, beliefs: brief.beliefs_held, dropped: brief.beliefs_dropped, notes: brief.notes, reflections: session.notebook.reflections };
  const system = 'You grade how well a learner recovered the hidden rule of an environment it could only perceive as rows of symbols. '
    + 'For each TRUE statement, decide from the learner\'s own model and words whether it stated it: "exact", "partial" (the right idea but incomplete), "wrong" (it contradicts it) or "absent". '
    + 'Read its model as code: what its observations, rules and output compute is what it claims. Judge what it holds, not what it dropped. Quote the learner briefly as evidence. '
    + GRADING_STRUCTURE + ' '
    + 'Answer JSON: {"grades": [{"id": ..., "grade": "exact"|"partial"|"wrong"|"absent", "evidence": ...}], "false_beliefs": [claims no true statement supports], "form": "compact"|"table"|"mixed", "form_evidence": ...}';
  try {
    const content = (await llm.complete({ system, user: JSON.stringify({ true_statements: truth, learner: learned }) })).content;
    const parsed = parseJsonLoose(content) as { grades?: { id: string; grade: string }[]; false_beliefs?: unknown[] } | null;
    const grades = (parsed?.grades ?? []).filter((g) => truth.some((t) => t.id === g.id));
    const score = Math.round(grades.reduce((n, g) => n + (g.grade === 'exact' ? 1 : g.grade === 'partial' ? 0.5 : 0), 0) / truth.length * 100) / 100;
    log('operator_rule_recovery', { truth, grades, false_beliefs: parsed?.false_beliefs ?? [], score, ...formOf(parsed as Record<string, unknown> | null), grader_model: env.LLM_MODEL });
    say('operator: rule recovery ' + score);
  } catch (e) { log('operator_rule_recovery', { truth, error: String((e as Error).message ?? e) }); }
}

/* --- The run ------------------------------------------------------------------------------- */

say('cells@1 seed ' + cfg.seed + ' level ' + cfg.level + ' (width ' + spec.width + ', rule ' + spec.rule + ', radius ' + spec.radius + '); journal ' + outFile);
log('start', {});
explore();
let accepted: { law: Law; round: number } | null = null;
let satisfied: { law: Law; round: number } | null = null;
for (let attempt = 1; attempt <= cfg.attempts && !session.fatal; attempt++) {
  const record = await session.consult('propose');
  if (!record) { if (session.fatal) break; continue; }
  const outcome = await protocol.round(record.law, { round: record.round, attempt, validate: record.validate });
  record.accepted = outcome.accepted;
  log('check', { ...outcome.journal, jev: { calls: judge.stats.calls, errors: judge.stats.errors } });
  if (outcome.accepted) say('  ACCEPTED');
  if (outcome.quickStop) {
    satisfied = { law: record.law, round: record.round };
    log('quick_stop', { round: record.round, held_in_laboratories: Object.fromEntries(outcome.laboratories.map((o) => [o.place.id, o.holds])), law: ownLaw(record.law) });
    say('  --quick: System 2 judges its model good in round ' + record.round + ' (in its laboratories: ' + (outcome.held ? 'holds' : 'does NOT hold') + ')');
    break;
  }
  if (cfg.ablation && outcome.reused === null) await ablate(record.law, record.round);
  if (outcome.accepted) { accepted = { law: record.law, round: record.round }; log('accepted', { round: record.round }); break; }
}
if (cfg.reflection && !session.fatal) {
  say('reflection round: the model is final; System 2 looks back');
  await session.consult('reflect', reflectionTask(investigative));
}
const final = accepted?.law ?? session.latest()?.law ?? null;
if (cfg.grade && !session.fatal) await gradeRecovery(final);
log('end', {
  stoppedBy: session.fatal ? 'llm_error' : accepted ? 'accepted' : satisfied ? 'quick_stop' : 'budget', ...(session.fatal ? { llm_error: session.fatal } : {}),
  final: final ? ownLaw(final) : null,
  places: [...places.values()].map((p) => ({ id: p.id, role: p.role, seen: p.seen, width: p.spec.width })),
  notebook: session.notebook, episodes: episodeIndex(),
  jev: { calls: judge.stats.calls, errors: judge.stats.errors },
  /* OPERATOR ONLY (SPEC-OBJETIVO O4): milestones and cost of the run. */
  operator_summary: operatorSummary(protocol.summary(), ablations)
});
say('done: ' + (accepted ? 'accepted in round ' + accepted.round : satisfied ? 'stopped by --quick in round ' + satisfied.round : 'not accepted') + '; journal ' + outFile);
