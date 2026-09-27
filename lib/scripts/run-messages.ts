/* messages@1: a world whose percept is TEXT - the test of the Judge (H3). System 2 perceives short messages and the mark
   the environment gave each (0 or 1), and must write a model that answers the mark. The laboratory writes plainly; the
   places of the family use other wordings, so code written against the laboratory's words breaks there and a reader of
   meaning does not. The operator measures what the Judge's rules add (the flat-judge ablation).

     node --experimental-strip-types scripts/run-messages.ts --seed 1 [options]

   Endpoints and keys come from the environment (never from the command line, never written to the journal):
     JEV_URL (default https://api.typesafe.ai/v1/systemone), JEV_KEY
     LLM_URL (an OpenAI-compatible /chat/completions URL), LLM_KEY, LLM_MODEL
   Options:
     --seed N            the world (default 1)
     --attempts N        proposal/check rounds (default 8)
     --explore N         episodes the environment gives in the laboratory before the first proposal (default 3)
     --steps N           investigation answers System 2 may give per round before proposing (default 3)
     --check-episodes N  episodes per place in a check, a validation or a confirmation (default 2)
     --every N           take every N-th message of an episode as a point of a check (default 1: all)
     --tolerance N       misses allowed in a place for the model to hold there (default 1)
     --family N          places of the family to validate on (default 3)
     --validations N     how many times System 2 may validate (default 3)
     --confirm-places N  places per blind confirmation set, two sets (default 2)
     --no-regression     do not answer each laboratory's previous check again with the new model
     --tools a,b,...     the instruments (default all = view,inspect,measure,table; "none" = none)
     --quick             stop the first time System 2 asks to validate, without validating
     --no-ablation       skip the operator's flat-judge arm (every rule answering 0.5)
     --no-grade          skip the operator-only grading of the recovered rule (one LLM call)
     --no-reflection     skip the final reflection round
     --flat              CONTROL: a Judge that knows nothing (every answer neutral); the LLM is still consulted
     --out FILE          the journal (default runs/messages-s<seed>-<time>.json)

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
import { MESSAGES_PERCEPT_DOC, describeMessagesTruth, generateMessages, messagesPointWorld, perceiveMessage, placeOf, runEpisode, type MessagePoint, type MessagesSpec } from '../src/worlds/messages/world.ts';
import { messagesObjective, sideOf, type MessagesCase } from '../src/worlds/messages/objective.ts';
import { messagesInterface } from '../src/worlds/messages/interface.ts';
import type { MeasureDecl } from '../src/core/types.ts';
import { ROOT } from '../test/support.ts';

/* --- Configuration ---------------------------------------------------------------- */

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
const flag = (name: string): boolean => argv.includes('--' + name);
const ALL: readonly Tool[] = messagesInterface().tools;
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
  attempts: Number(arg('attempts', '8')),
  explore: Number(arg('explore', '3')),
  steps: Number(arg('steps', '3')),
  checkEpisodes: Math.max(1, Number(arg('check-episodes', '2'))),
  every: Math.max(1, Number(arg('every', '1'))),
  tolerance: Math.max(0, Number(arg('tolerance', '1'))),
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
const SYSTEM_PROMPT = system2Prompt(messagesInterface({ regression: cfg.regression }), tools);
const env = process.env;
if (!env.LLM_URL || !env.LLM_MODEL) { console.error('LLM_URL and LLM_MODEL are required (and LLM_KEY if the endpoint needs one).'); process.exit(2); }
if (!cfg.flat && !env.JEV_KEY) { console.error('JEV_KEY is required (or run the --flat control).'); process.exit(2); }

/* --- The world, as the operator knows it and as the learner perceives it ------------- */

const spec = generateMessages(cfg.seed);
interface MessagesPlace extends Place { readonly spec: MessagesSpec }
const places = new Map<string, MessagesPlace>();
places.set('lab1', { id: 'lab1', spec, role: 'laboratory', seen: true });
for (let k = 1; k <= cfg.family; k++) places.set('place' + k, { id: 'place' + k, spec: placeOf(spec, k), role: 'family', seen: false });

const world = messagesPointWorld();
const runner = nodeVmRunner({ timeoutMs: 2000 });
const observer = new Observer<MessagePoint>(world, { kinds: ['code'], runners: [runner], perceive: (s) => perceiveMessage(s) });
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
const evaluator = new Evaluator<MessagePoint>(observer, judge, { maximizer: 'nature', runners: [runner] });
/* The answer is a number read on its side of 0.5: the Predictor's pair comparison is unused (the objective compares). */
const predictor = new Predictor<MessagePoint>(evaluator, perceiveMessage, { runners: [runner], answer: () => [0, 0] });
const llmUse = { calls: 0, tokens: 0 };
const llm = openAiChatClient({ url: env.LLM_URL, apiKey: env.LLM_KEY, model: env.LLM_MODEL, jsonMode: true, temperature: 0.4, timeoutMs: 180000, retries: 1,
  onRequest: () => { llmUse.calls++; }, onAnswer: (a) => { llmUse.tokens += tokensOf(a.raw); } });

/* --- The journal ------------------------------------------------------------------ */

const started = new Date();
const outFile = arg('out', path.join(ROOT, 'runs', 'messages-s' + cfg.seed + '-' + started.toISOString().replace(/[:.]/g, '-') + '.json'));
fs.mkdirSync(path.dirname(outFile), { recursive: true });
const truth = describeMessagesTruth(spec);
const journal: Record<string, any> = {
  experiment: 'messages@1', started: started.toISOString(), config: { ...cfg, llm_model: env.LLM_MODEL, jev_model: env.JEV_MODEL ?? null },
  hidden_from_the_learner: { spec, truth, places: [...places.values()].map((p) => ({ id: p.id, role: p.role, pools: p.spec.pools })) },
  events: [] as unknown[]
};
const log = (type: string, data: Record<string, unknown> = {}): void => {
  journal.events.push({ t: Math.round((Date.now() - started.getTime()) / 1000), type, ...data });
  fs.writeFileSync(outFile, JSON.stringify(journal, null, 2));
};
const say = (text: string): void => console.log('[' + Math.round((Date.now() - started.getTime()) / 1000) + 's] ' + text);

/* --- The learner's episodes ------------------------------------------------------------ */

interface StoredEpisode { readonly id: string; readonly place: string; readonly round: number; readonly by: string; readonly texts: string[]; readonly marks: (0 | 1)[] }
const episodes = new Map<string, StoredEpisode>();
let counter = 0;
const store = (id: string, place: MessagesPlace, round: number, by: string, e: { texts: string[]; marks: (0 | 1)[] }) => {
  const s: StoredEpisode = { id, place: place.id, round, by, ...e };
  episodes.set(id, s);
  return s;
};
const episodeIndex = () => [...episodes.values()].map((e) => ({ episode: e.id, place: e.place, round: e.round, by: e.by, steps: e.texts.length }));

/** "ep3@5": the message at step 5 of ep3, with its mark. */
function resolve(ref: string): { point: MessagePoint; mark: 0 | 1 } | null {
  const m = /^([a-z][a-z0-9-]*)@(\d+)$/.exec(ref.trim());
  const e = m ? episodes.get(m[1]) : undefined;
  if (!m || !e) return null;
  const step = Number(m[2]);
  return step >= 0 && step < e.texts.length ? { point: { text: e.texts[step] }, mark: e.marks[step] } : null;
}

const pointsOf = (e: { id: string; texts: string[]; marks: (0 | 1)[] }, every = cfg.every) =>
  e.texts.map((text, t): MessagesCase => ({ point: e.id + '@' + t, state: { text }, mark: e.marks[t] })).filter((_, t) => t % every === 0);
const ownPoints = () => [...episodes.values()].filter((e) => e.by === 'the environment').flatMap((e) => pointsOf(e, 1));
const checkPoints = new Map<number, MessagesCase[]>();

function explore(): void {
  const rnd = mulberry32(cfg.seed * 1013 + 7);
  const lab = places.get('lab1')!;
  for (let k = 0; k < cfg.explore; k++) {
    const e = store('ep' + (++counter), lab, 0, 'the environment', runEpisode(lab.spec, rnd));
    log('exploration_episode', { episode: e.id, messages: e.texts.map((text, step) => ({ step, text, mark: e.marks[step] })) });
  }
}

/* --- The objective and the protocol ------------------------------------------------------------ */

const answerOf = async (law: Law, state: MessagePoint) => (await predictor.predict(law, state)).answer;
const objective = messagesObjective<Law, MessagesPlace>({
  casesIn(place, c) {
    /* Fresh episodes in the place; a check's and a validation's become the learner's, a blind confirmation's never. */
    const rnd = mulberry32(cfg.seed * 7717 + c.round * 101 + c.index * 7 + (c.purpose === 'validation' ? 5000 : c.purpose === 'blind' ? 100000 * (1 + (c.set ?? 0)) : 0));
    const cases: MessagesCase[] = [];
    for (let k = 0; k < cfg.checkEpisodes; k++) {
      const e = runEpisode(place.spec, rnd);
      const id = c.purpose === 'blind' ? place.id + '-' + k : (c.purpose === 'check' ? 'check' : 'valid') + c.round + '-' + place.id + '-' + (k + 1);
      if (c.purpose !== 'blind') store(id, place, c.round, 'the ' + c.purpose + ' of round ' + c.round, e);
      cases.push(...pointsOf({ id, ...e }));
    }
    if (c.purpose !== 'blind') checkPoints.set(c.round, [...(checkPoints.get(c.round) ?? []), ...cases]);
    return cases;
  },
  answer: answerOf,
  regression: cfg.regression,
  tolerance: cfg.tolerance
});
let blindCounter = 0;
const constant = (v: number): Law => ({ world: world.id, observations: {}, rules: {}, weights: {}, output: { kind: 'code', lang: 'js', source: '(p) => ' + v } });
const protocol = new Protocol(objective, {
  places: () => [...places.values()],
  blindPlaces: () => Array.from({ length: cfg.confirmPlaces }, () => { const k = ++blindCounter; return { id: 'blind' + k, spec: placeOf(spec, 1000 + k), role: 'confirmation' as const, seen: false }; }),
  fingerprint: (law) => lawFingerprint(law),
  validations: cfg.validations, pairedRegression: cfg.regression, quick: cfg.quick,
  cost: () => ({ jev_calls: judge.stats.calls, jev_not_asked: evaluator.stats.judgeUnread, llm_calls: llmUse.calls, llm_tokens: llmUse.tokens }),
  /* OPERATOR ONLY: models that know nothing. If one holds too, the check could not tell a model from knowing nothing. */
  baselines: [{ name: 'always 0', model: constant(0) }, { name: 'always 1', model: constant(1) }],
  say
});

/* --- Instruments ------------------------------------------------------------------------ */

/** A law must compute on points of the learner's own episodes and answer a number there (no Judge call). */
function failures(law: Law): string[] {
  const points = ownPoints().slice(-8);
  const errors = replayOnEvidence(observer, law.observations, points.map((p) => ({ state: p.state }))).errors.slice(0, 4).map((e) => (e.observation ?? '') + ': ' + e.error);
  if (errors.length) return errors;
  const neutral = Object.fromEntries(Object.keys(law.rules).map((id) => [id, 0.5]));
  for (const p of points.slice(0, 4)) {
    try {
      const a = predictor.rawAnswerWith(law, predictor.measured(law, p.state), neutral);
      if (sideOf(a) === null) return ['output: the answer must be a number (it was ' + JSON.stringify(a)?.slice(0, 60) + ')'];
    } catch (e) { return ['output: ' + String((e as Error).message ?? e)]; }
  }
  return [];
}

async function runRequest(req: LawRequest<never>): Promise<unknown> {
  const kind = (['view', 'inspect', 'act', 'measure', 'simulate', 'table'] as const).find((k) => k in req)!;
  if (!tools.has(kind)) return { [kind]: (req as Record<string, unknown>)[kind], error: '"' + kind + '" is not available in this experiment' };
  if ('view' in req) {
    const e = episodes.get(req.view);
    if (!e) return { view: req.view, error: 'no such episode' };
    const from = Math.max(0, req.from), to = Math.min(Math.max(0, req.to), from + 29);
    return { view: e.id, steps: e.texts.length, messages: e.texts.slice(from, to + 1).map((text, i) => ({ step: from + i, text, mark: e.marks[from + i] })) };
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
        your_answer: pr.answer, ...(Object.keys(pr.parts).length ? { your_output_also_returned: pr.parts } : {}), the_mark_was: r.mark };
    } catch (e) { return { inspect: req.inspect, error: String((e as Error).message ?? e) }; }
  }
  if ('table' in req) {
    /* Code on every point of its episodes or of the checks, with the mark given there. */
    const decl: MeasureDecl = { spec: { kind: 'code', lang: 'js', source: req.table.source }, ...(req.table.range ? { range: req.table.range } : {}) };
    const points = req.on === 'checks' ? [...checkPoints.values()].flat().slice(-60) : ownPoints().slice(-60);
    return { table: req.table.source, on: req.on, rows: points.map((p) => {
      const o = observer.observe(p.state, { m: decl });
      const err = o.errors.find((e) => e.id === 'm');
      return { point: p.point, ...(err ? { error: err.error } : { value: o.values.m ?? o.texts.m }), mark: p.mark };
    }) };
  }
  return { error: 'not available in this experiment' };
}

const session = new LawSession<never>({
  llm, system: SYSTEM_PROMPT, world: world.id, perceptDoc: MESSAGES_PERCEPT_DOC, steps: cfg.steps, investigative,
  parseAct: () => 'act is not available in this experiment',
  runRequest: (r) => runRequest(r),
  known: (ref) => episodes.has(ref.trim()) || resolve(ref) !== null,
  failures,
  episodes: episodeIndex,
  places: () => protocol.placesView(), validationsLeft: () => protocol.validationsLeft, lastCheck: () => protocol.lastView,
  log, say
});

/* --- Operator only ------------------------------------------------------------------------- */

/** The same model with every rule answering 0.5 (a Judge that knows nothing), on the same points: what the rules add. On
    the check's points and, when there was one, the validation's (the held-out wordings, where the Judge should matter). */
const ablations: AblationRecord[] = [];
async function ablate(law: Law, round: number): Promise<void> {
  if (!Object.keys(law.rules).length) { log('operator_ablation_flat_judge', { round, note: 'the model has no rules: nothing is asked of the Judge' }); return; }
  const points = checkPoints.get(round) ?? [];
  const neutral = Object.fromEntries(Object.keys(law.rules).map((id) => [id, 0.5]));
  let model = 0, flat = 0;
  const byWording: Record<string, { model: number; flat: number; points: number }> = {};
  for (const p of points) {
    const place = episodes.get(p.point.split('@')[0])?.place ?? 'lab1';
    const w = (byWording[place] ??= { model: 0, flat: 0, points: 0 });
    w.points++;
    try { if (sideOf(await answerOf(law, p.state)) === p.mark) { model++; w.model++; } } catch { /* a miss */ }
    try { if (sideOf(predictor.rawAnswerWith(law, predictor.measured(law, p.state), neutral)) === p.mark) { flat++; w.flat++; } } catch { /* a miss */ }
  }
  ablations.push({ round, model, withoutJudge: flat, better: 'higher' });
  log('operator_ablation_flat_judge', { round, points: points.length, model_agreed: model, flat_judge_agreed: flat, by_place: byWording });
  say('  [operator] ablation: model ' + model + '/' + points.length + ' on the mark\'s side, every rule at 0.5: ' + flat + '/' + points.length);
}

async function gradeRecovery(final: Law | null): Promise<void> {
  const brief = session.notebook.brief();
  const learned = { final_model: final ? ownLaw(final) : null, beliefs: brief.beliefs_held, dropped: brief.beliefs_dropped, notes: brief.notes, reflections: session.notebook.reflections };
  const system = 'You grade how well a learner recovered the hidden rule by which an environment marks short texts 0 or 1; the learner saw only the texts and their marks. '
    + 'For each TRUE statement, decide from the learner\'s own model and words whether it stated it: "exact", "partial" (the right idea but incomplete), "wrong" (it contradicts it) or "absent". '
    + 'Read its model as code and as the questions its rules ask a judge: what its observations, rules and output compute is what it claims. Judge what it holds, not what it dropped. Quote the learner briefly as evidence. '
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

say('messages@1 seed ' + cfg.seed + ' (rule ' + spec.rule + ', k ' + spec.k + '); journal ' + outFile);
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
  places: [...places.values()].map((p) => ({ id: p.id, role: p.role, seen: p.seen, pools: p.spec.pools })),
  notebook: session.notebook, episodes: episodeIndex(),
  jev: { calls: judge.stats.calls, errors: judge.stats.errors },
  /* OPERATOR ONLY (SPEC-OBJETIVO O4): milestones and cost of the run. */
  operator_summary: operatorSummary(protocol.summary(), ablations)
});
say('done: ' + (accepted ? 'accepted in round ' + accepted.round : satisfied ? 'stopped by --quick in round ' + satisfied.round : 'not accepted') + '; journal ' + outFile);
