import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Observer } from '../core/observer.ts';
import { Evaluator } from '../core/evaluate.ts';
import { JevJudge, JEV_DEFAULT_URL } from '../core/jev.ts';
import { parseJsonLoose } from '../core/net.ts';
import { Predictor, type Law } from '../core/predict.ts';
import type { MeasureDecl } from '../core/types.ts';
import { nodeVmRunner } from './node-vm.ts';
import { openAiChatClient } from '../learn/system2.ts';
import { replayOnEvidence } from '../learn/gates.ts';
import { reflectionTask, system2Prompt, toolOf, type Tool } from '../learn/prompt.ts';
import { ownLaw, type LawRequest } from '../learn/law-explorer.ts';
import { LawSession, lawFingerprint } from '../learn/law-session.ts';
import { Protocol } from '../learn/protocol.ts';
import { GRADING_STRUCTURE, formOf, operatorSummary, tokensOf, type AblationRecord } from '../learn/operator.ts';
import type { Place } from '../learn/objective.ts';
import type { AnyLab, LabCase, LabOptions } from '../learn/lab.ts';
import { findingOf, findingText } from '../learn/finding.ts';
import { mulberry32 } from '../worlds/grid/gen.ts';

/* ============================================================================
 * The runner of a LABORATORY (SPEC-OBJETIVO O9): the same for every world that declares
 * itself as a `Lab` (learn/lab.ts). Node-side: files, a VM for the learner's code, the
 * network for the Judge and System 2.
 *
 * Endpoints and keys come from the environment (never from the command line, never
 * written to the journal): JEV_URL, JEV_KEY, JEV_MODEL; LLM_URL, LLM_KEY, LLM_MODEL.
 *
 * The protocol is the researcher's (learn/protocol.ts). The journal keeps the hidden truth
 * and the operator's measures; they never reach System 2 or the Judge.
 * ========================================================================== */

/** The common options, with their defaults (a laboratory may change a default: `Lab.defaults`). */
const COMMON: readonly { name: string; default: string; help: string }[] = [
  { name: 'seed', default: '1', help: 'the world' },
  { name: 'attempts', default: '8', help: 'proposal/check rounds' },
  { name: 'explore', default: '3', help: 'episodes the environment runs in the laboratory before the first proposal' },
  { name: 'steps', default: '3', help: 'investigation answers System 2 may give per round before proposing' },
  { name: 'check-episodes', default: '2', help: 'episodes per place in a check, a validation or a confirmation' },
  { name: 'every', default: '3', help: 'take every N-th step of an episode as a point of a check' },
  { name: 'family', default: '3', help: 'places of the family to validate on' },
  { name: 'validations', default: '3', help: 'how many times System 2 may validate' },
  { name: 'confirm-places', default: '2', help: 'places per blind confirmation set, two sets' },
  { name: 'tools', default: 'all', help: 'the instruments, a,b,... ("all" or "none")' },
  { name: 'out', default: '', help: 'the journal (default runs/<name>-<time>.json)' }
];
const FLAGS: readonly { name: string; help: string }[] = [
  { name: 'no-regression', help: 'do not answer each laboratory\'s previous check again with the new model' },
  { name: 'quick', help: 'stop the first time System 2 asks to validate, without validating' },
  { name: 'no-ablation', help: 'skip the operator\'s flat-judge arm (every rule answering 0.5)' },
  { name: 'no-grade', help: 'skip the operator-only grading of the recovered rule (one LLM call)' },
  { name: 'no-reflection', help: 'skip the final reflection round' },
  { name: 'flat', help: 'CONTROL: a Judge that knows nothing (every answer neutral); the LLM is still consulted' }
];

/** The command line's help for a laboratory. */
export function labUsage(lab: AnyLab, command: string): string {
  const pad = (s: string) => s.padEnd(22);
  const defaults = { ...Object.fromEntries(COMMON.map((o) => [o.name, o.default])), ...(lab.defaults ?? {}) };
  return [lab.id + ': ' + lab.about, '', '  ' + command + ' [options]', '', 'Options of this world:',
    ...lab.options.map((o) => '  ' + pad('--' + o.name + ' N') + o.help + ' (default ' + o.default + ')'),
    'Common options:',
    ...COMMON.map((o) => '  ' + pad('--' + o.name + ' ' + (o.name === 'tools' ? 'LIST' : o.name === 'out' ? 'FILE' : 'N')) + o.help + (defaults[o.name] ? ' (default ' + defaults[o.name] + ')' : '')),
    ...FLAGS.map((f) => '  ' + pad('--' + f.name) + f.help),
    '', 'Endpoints and keys come from the environment: LLM_URL, LLM_MODEL, LLM_KEY; JEV_URL, JEV_KEY (not needed with --flat).'].join('\n');
}

/** The commit the run is made from, marked when the working tree has changes (null outside a repository). */
function commitOf(root: string): string | null {
  try {
    const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim();
    return head + (dirty ? '+changes' : '');
  } catch { return null; }
}

export async function runLab(lab: AnyLab, argv: readonly string[], context: { root: string; command: string }): Promise<void> {
  /* --- Configuration ---------------------------------------------------------------- */
  if (argv.includes('--help') || argv.includes('-h')) { console.log(labUsage(lab, context.command)); return; }
  const defaults: Record<string, string> = { ...Object.fromEntries(COMMON.map((o) => [o.name, o.default])), ...(lab.defaults ?? {}) };
  const arg = (name: string, fallback = defaults[name] ?? ''): string => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
  const flag = (name: string): boolean => argv.includes('--' + name);
  const worldOptions: LabOptions = Object.fromEntries(lab.options.map((o) => [o.name, arg(o.name, o.default)]));
  const ALL: readonly Tool[] = lab.interface({}).tools;
  const parseTools = (value: string): Tool[] => {
    if (value === 'all') return [...ALL];
    if (value === 'none') return [];
    const asked = value.split(',').map((t) => t.trim()).filter(Boolean).map((t) => toolOf(t) ?? t);
    const unknown = asked.filter((t) => !(ALL as readonly string[]).includes(t));
    if (unknown.length) { console.error('--tools: unknown ' + unknown.join(', ') + ' (tools: ' + ALL.join(', ') + ', or all / none)'); process.exit(2); }
    return ALL.filter((t) => asked.includes(t));
  };
  const cfg = {
    seed: Number(arg('seed')),
    ...Object.fromEntries(Object.entries(worldOptions).map(([k, v]) => [k, Number.isFinite(Number(v)) ? Number(v) : v])),
    attempts: Number(arg('attempts')),
    explore: Number(arg('explore')),
    steps: Number(arg('steps')),
    checkEpisodes: Math.max(1, Number(arg('check-episodes'))),
    every: Math.max(1, Number(arg('every'))),
    family: Math.max(1, Number(arg('family'))),
    validations: Math.max(1, Number(arg('validations'))),
    confirmPlaces: Math.max(1, Number(arg('confirm-places'))),
    regression: !flag('no-regression'),
    tools: parseTools(arg('tools')),
    quick: flag('quick'),
    ablation: !flag('no-ablation') && !flag('quick'),
    grade: !flag('no-grade'),
    reflection: !flag('no-reflection') && !flag('quick'),
    flat: flag('flat')
  };
  const acts = lab.act && worldOptions.acts !== undefined ? Number(worldOptions.acts) : undefined;
  const tools: ReadonlySet<Tool> = new Set(cfg.tools);
  const investigative = cfg.tools.length > 0;
  const SYSTEM_PROMPT = system2Prompt(lab.interface({ regression: cfg.regression }), tools);
  const env = process.env;
  if (!env.LLM_URL || !env.LLM_MODEL) { console.error('LLM_URL and LLM_MODEL are required (and LLM_KEY if the endpoint needs one).'); process.exit(2); }
  if (!cfg.flat && !env.JEV_KEY) { console.error('JEV_KEY is required (or run the --flat control).'); process.exit(2); }

  /* --- The world, as the operator knows it and as the learner perceives it ------------- */
  type Spec = unknown;
  type Point = unknown;
  type Case = LabCase<Point> & Record<string, unknown>;
  interface LabPlace extends Place { readonly spec: Spec }
  const spec: Spec = lab.generate(cfg.seed, worldOptions);
  const places = new Map<string, LabPlace>();
  places.set('lab1', { id: 'lab1', spec, role: 'laboratory', seen: true });
  for (let k = 1; k <= cfg.family; k++) places.set('place' + k, { id: 'place' + k, spec: lab.placeOf(spec, k), role: 'family', seen: false });
  const labs = () => [...places.values()].filter((p) => p.role === 'laboratory');

  const world = lab.world();
  const runner = nodeVmRunner({ timeoutMs: 2000 });
  const observer = new Observer<Point>(world, { kinds: ['code'], runners: [runner], perceive: (s) => lab.perceive(s) });
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
  const evaluator = new Evaluator<Point>(observer, judge, { maximizer: 'nature', runners: [runner] });
  /* The objective compares answers (Lab.objective): the Predictor hands them as given. */
  const predictor = new Predictor<Point>(evaluator, (s) => lab.perceive(s), { runners: [runner] });
  const llmUse = { calls: 0, tokens: 0 };
  const llm = openAiChatClient({ url: env.LLM_URL, apiKey: env.LLM_KEY, model: env.LLM_MODEL, jsonMode: true, temperature: 0.4, timeoutMs: 180000, retries: 1,
    onRequest: () => { llmUse.calls++; }, onAnswer: (a) => { llmUse.tokens += tokensOf(a.raw); } });

  /* --- The journal ------------------------------------------------------------------ */
  const started = new Date();
  const outFile = arg('out') || path.join(context.root, 'runs', lab.runName(cfg.seed, worldOptions) + '-' + started.toISOString().replace(/[:.]/g, '-') + '.json');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const truth = lab.truth(spec);
  const commit = commitOf(context.root);
  const journal: Record<string, any> = {
    experiment: lab.id, started: started.toISOString(), ...(commit ? { commit } : {}), config: { ...cfg, ...(acts !== undefined ? { acts } : {}), llm_model: env.LLM_MODEL, jev_model: env.JEV_MODEL ?? null },
    hidden_from_the_learner: { spec, truth, places: [...places.values()].map((p) => ({ id: p.id, role: p.role, ...lab.placeInfo(p.spec) })) },
    events: [] as unknown[]
  };
  const log = (type: string, data: Record<string, unknown> = {}): void => {
    journal.events.push({ t: Math.round((Date.now() - started.getTime()) / 1000), type, ...data });
    fs.writeFileSync(outFile, JSON.stringify(journal, null, 2));
  };
  const say = (text: string): void => console.log('[' + Math.round((Date.now() - started.getTime()) / 1000) + 's] ' + text);

  /* --- The learner's episodes ------------------------------------------------------------ */
  interface StoredEpisode { readonly id: string; readonly place: string; readonly round: number; readonly by: string; readonly data: unknown }
  const episodes = new Map<string, StoredEpisode>();
  let counter = 0;
  const store = (id: string, place: LabPlace, round: number, by: string, data: unknown) => { const e = { id, place: place.id, round, by, data }; episodes.set(id, e); return e; };
  const episodeIndex = () => [...episodes.values()].map((e) => ({ episode: e.id, place: e.place, round: e.round, by: e.by, steps: lab.steps(e.data) }));

  /** "ep3@5": the point at step 5 of ep3, with what is shown there. */
  const resolve = (ref: string): { state: Point; shown: Record<string, unknown> } | null => {
    const m = /^([a-z][a-z0-9-]*)@(\d+)$/.exec(ref.trim());
    const e = m ? episodes.get(m[1]) : undefined;
    return m && e ? lab.at(e.data, Number(m[2])) : null;
  };
  const casesOf = (id: string, data: unknown, every = cfg.every): Case[] => lab.cases(spec, id, data, every);
  const ownPoints = () => [...episodes.values()].filter((e) => e.by === 'you' || e.by === 'the environment').flatMap((e) => casesOf(e.id, e.data, lab.ownEvery));
  const checkPoints = new Map<number, Case[]>();

  const explore = (): void => {
    const rnd = mulberry32(lab.explorationSeed(cfg.seed, worldOptions));
    const first = places.get('lab1')!;
    for (let k = 0; k < cfg.explore; k++) {
      const e = store('ep' + (++counter), first, 0, 'the environment', lab.episode(first.spec, rnd));
      log('exploration_episode', { episode: e.id, ...lab.explored(e.data) });
    }
  };

  /* --- The objective and the protocol ------------------------------------------------------------ */
  const answerOf = async (law: Law, state: Point) => (await predictor.predict(law, state)).answer;
  const objective = lab.objective<Law, LabPlace>({
    casesIn(place, c) {
      /* Fresh episodes in the place; a check's and a validation's become the learner's, a blind confirmation's never. */
      const rnd = mulberry32(cfg.seed * 7717 + c.round * 101 + c.index * 7 + (c.purpose === 'validation' ? 5000 : c.purpose === 'blind' ? 100000 * (1 + (c.set ?? 0)) : 0));
      const cases: Case[] = [];
      for (let k = 0; k < cfg.checkEpisodes; k++) {
        const data = lab.episode(place.spec, rnd);
        const id = c.purpose === 'blind' ? place.id + '-' + k : (c.purpose === 'check' ? 'check' : 'valid') + c.round + '-' + place.id + '-' + (k + 1);
        if (c.purpose !== 'blind') store(id, place, c.round, 'the ' + c.purpose + ' of round ' + c.round, data);
        cases.push(...casesOf(id, data));
      }
      if (c.purpose !== 'blind') checkPoints.set(c.round, [...(checkPoints.get(c.round) ?? []), ...cases]);
      return cases;
    },
    answer: (law, state) => answerOf(law, state),
    regression: cfg.regression
  }, worldOptions);
  /* What was asked, in the interface's words (the finding's question). */
  journal.objective = { answer: objective.answer.form, verdict: objective.verdictForm };
  let blindCounter = 0;
  const protocol = new Protocol(objective, {
    places: () => [...places.values()],
    blindPlaces: () => Array.from({ length: cfg.confirmPlaces }, () => { const k = ++blindCounter; return { id: 'blind' + k, spec: lab.placeOf(spec, 1000 + k), role: 'confirmation' as const, seen: false }; }),
    fingerprint: (law) => lawFingerprint(law),
    validations: cfg.validations, pairedRegression: cfg.regression, quick: cfg.quick,
    cost: () => ({ jev_calls: judge.stats.calls, jev_not_asked: evaluator.stats.judgeUnread, llm_calls: llmUse.calls, llm_tokens: llmUse.tokens }),
    /* OPERATOR ONLY: models that know nothing. If one holds too, the check could not tell a model from knowing nothing. */
    baselines: lab.baselines(spec).map(({ name, source }) => ({ name, model: { world: world.id, observations: {}, rules: {}, weights: {}, output: { kind: 'code' as const, lang: 'js', source } } })),
    say
  });

  /* --- Instruments ------------------------------------------------------------------------ */

  /** A law must compute on points of the learner's own episodes and answer in the form asked (no Judge call). */
  const failures = (law: Law): string[] => {
    const points = ownPoints().slice(-8);
    const errors = replayOnEvidence(observer, law.observations, points.map((p) => ({ state: p.state }))).errors.slice(0, 4).map((e) => (e.observation ?? '') + ': ' + e.error);
    if (errors.length) return errors;
    const neutral = Object.fromEntries(Object.keys(law.rules).map((id) => [id, 0.5]));
    for (const p of points.slice(0, 4)) {
      try {
        const issue = lab.answerIssue(predictor.rawAnswerWith(law, predictor.measured(law, p.state), neutral));
        if (issue) return ['output: ' + issue];
      } catch (e) { return ['output: ' + String((e as Error).message ?? e)]; }
    }
    return [];
  };

  const runRequest = async (req: LawRequest<unknown>, budget: { acts: number }): Promise<unknown> => {
    const kind = (['view', 'inspect', 'act', 'measure', 'simulate', 'table'] as const).find((k) => k in req)!;
    if (!tools.has(kind)) return { [kind]: (req as Record<string, unknown>)[kind], error: '"' + kind + '" is not available in this experiment' };
    if ('view' in req) {
      const e = episodes.get(req.view);
      if (!e) return { view: req.view, error: 'no such episode' };
      return { view: e.id, ...lab.view(e.data, Math.max(0, req.from), Math.max(0, req.to)) };
    }
    if ('act' in req) {
      if (!lab.act) return { act: req.act, error: '"act" is not available in this experiment' };
      if (budget.acts <= 0) return { act: req.act, error: 'no acts left this round' };
      const place = places.get(lab.act.place(req.act) ?? 'lab1');
      if (!place || place.role !== 'laboratory') return { act: req.act, error: 'you can act only in your laboratories: ' + labs().map((l) => l.id).join(', ') };
      const data = lab.act.start(place.spec, req.act);
      /* The environment answers only whether it accepted: never why not. */
      if (data === null) return { act: req.act, accepted: false };
      budget.acts--;
      const e = store('act' + (++counter), place, session.currentRound, 'you', data);
      return { act: req.act, accepted: true, name: e.id, ...lab.act.shown(e.data) };
    }
    if ('measure' in req) {
      const decl: MeasureDecl = { spec: { kind: 'code', lang: 'js', source: req.measure.source }, ...(req.measure.range ? { range: req.measure.range } : {}) };
      return { measure: req.measure.source, values: req.on.map((ref) => {
        const r = resolve(ref);
        if (!r) return { point: ref, error: 'no such point' };
        const o = observer.observe(r.state, { m: decl });
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
        const pr = await predictor.predict(law, r.state, { askRules: true });
        return { inspect: req.inspect, your_observations_measured: pr.observations,
          ...(pr.evaluation ? { each_rule_answered: pr.rules, V: pr.V } : { the_judge_was_not_asked: true }),
          your_answer: pr.answer, ...(Object.keys(pr.parts).length ? { your_output_also_returned: pr.parts } : {}), ...r.shown };
      } catch (e) { return { inspect: req.inspect, error: String((e as Error).message ?? e) }; }
    }
    if ('simulate' in req) {
      if (!lab.simulate) return { simulate: req.simulate, error: '"simulate" is not available in this experiment' };
      const law = session.lawOf(req.law);
      const r = resolve(req.simulate);
      if (!law) return { simulate: req.simulate, error: 'there is no model yet: name a draft' };
      if (!r) return { simulate: req.simulate, error: 'no such point' };
      const [id, at] = req.simulate.split('@');
      const seen = episodes.get(id)!.data;
      let state = r.state;
      const steps: unknown[] = [];
      try {
        for (let k = 0; k < req.rows; k++) {
          const a = await answerOf(law, state);
          const next = lab.simulate.advance(state, a);
          if (typeof next === 'string') return { simulate: req.simulate, error: next, steps };
          state = next;
          steps.push({ step: Number(at) + k + 1, simulated: a, seen: lab.simulate.seen(seen, Number(at) + k + 1) ?? null });
        }
      } catch (e) { return { simulate: req.simulate, error: String((e as Error).message ?? e), steps }; }
      return { simulate: req.simulate, steps };
    }
    /* table: code on every point of its episodes or of the checks, with what is shown there. */
    const decl: MeasureDecl = { spec: { kind: 'code', lang: 'js', source: req.table.source }, ...(req.table.range ? { range: req.table.range } : {}) };
    const points = req.on === 'checks' ? [...checkPoints.values()].flat().slice(-60) : ownPoints().slice(-60);
    return { table: req.table.source, on: req.on, rows: points.map((p) => {
      const o = observer.observe(p.state, { m: decl });
      const err = o.errors.find((e) => e.id === 'm');
      return { point: p.point, ...(err ? { error: err.error } : { value: o.values.m ?? o.texts.m }), ...lab.shown(p) };
    }) };
  };

  const session: LawSession<unknown> = new LawSession<unknown>({
    llm, system: SYSTEM_PROMPT, world: world.id, perceptDoc: lab.perceptDoc, steps: cfg.steps, investigative,
    ...(lab.act && tools.has('act') && acts !== undefined ? { acts } : {}),
    parseAct: lab.act ? (raw) => lab.act!.parse(raw) : () => 'act is not available in this experiment',
    runRequest: (r, budget) => runRequest(r, budget),
    known: (ref) => episodes.has(ref.trim()) || resolve(ref) !== null,
    failures,
    episodes: episodeIndex,
    places: () => protocol.placesView(), validationsLeft: () => protocol.validationsLeft, lastCheck: () => protocol.lastView,
    log, say
  });

  /* --- Operator only ------------------------------------------------------------------------- */

  /** The same model with every rule answering 0.5 (a Judge that knows nothing), on the same points: what the rules add,
      per place (the family's places are where a reader of meaning should matter). */
  const ablations: AblationRecord[] = [];
  const ablate = async (law: Law, round: number): Promise<void> => {
    if (!Object.keys(law.rules).length) { log('operator_ablation_flat_judge', { round, note: 'the model has no rules: nothing is asked of the Judge' }); return; }
    const points = checkPoints.get(round) ?? [];
    const neutral = Object.fromEntries(Object.keys(law.rules).map((id) => [id, 0.5]));
    let model = 0, flat = 0;
    const byPlace: Record<string, { model: number; flat: number; points: number }> = {};
    for (const p of points) {
      const place = episodes.get(p.point.split('@')[0])?.place ?? 'lab1';
      const w = (byPlace[place] ??= { model: 0, flat: 0, points: 0 });
      w.points++;
      try { if (lab.agrees(await answerOf(law, p.state), p)) { model++; w.model++; } } catch { /* a miss */ }
      try { if (lab.agrees(predictor.rawAnswerWith(law, predictor.measured(law, p.state), neutral), p)) { flat++; w.flat++; } } catch { /* a miss */ }
    }
    ablations.push({ round, model, withoutJudge: flat, better: 'higher' });
    log('operator_ablation_flat_judge', { round, points: points.length, ['model_' + lab.agreement]: model, ['flat_judge_' + lab.agreement]: flat, by_place: byPlace });
    say('  [operator] ablation: model ' + model + '/' + points.length + ' ' + lab.agreement + ', every rule at 0.5: ' + flat + '/' + points.length);
  };

  const gradeRecovery = async (final: Law | null): Promise<void> => {
    const brief = session.notebook.brief();
    const learned = { final_model: final ? ownLaw(final) : null, beliefs: brief.beliefs_held, dropped: brief.beliefs_dropped, notes: brief.notes, reflections: session.notebook.reflections };
    const system = 'You grade how well a learner recovered the hidden rule ' + lab.grading.subject + '. '
      + 'For each TRUE statement, decide from the learner\'s own model and words whether it stated it: "exact", "partial" (the right idea but incomplete), "wrong" (it contradicts it) or "absent". '
      + lab.grading.reading + ' Judge what it holds, not what it dropped. Quote the learner briefly as evidence. '
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
  };

  /* --- The run ------------------------------------------------------------------------------- */
  say(lab.id + ' seed ' + cfg.seed + ' ' + lab.headline(spec) + '; journal ' + outFile);
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
    places: [...places.values()].map((p) => ({ id: p.id, role: p.role, seen: p.seen, ...lab.placeInfo(p.spec) })),
    notebook: session.notebook, episodes: episodeIndex(),
    jev: { calls: judge.stats.calls, errors: judge.stats.errors },
    /* OPERATOR ONLY (SPEC-OBJETIVO O4): milestones and cost of the run. */
    operator_summary: operatorSummary(protocol.summary(), ablations)
  });
  /* OPERATOR ONLY (SPEC-OBJETIVO O10): the finding, next to the journal. */
  /* Read as it was written: the notebook and the rest as JSON. */
  const finding = findingOf(JSON.parse(JSON.stringify(journal)), { journal: path.basename(outFile) });
  const findingFile = outFile.replace(/\.json$/, '') + '.finding.json';
  fs.writeFileSync(findingFile, JSON.stringify(finding, null, 2));
  console.log(findingText(finding));
  say('finding ' + findingFile);
  say('done: ' + (accepted ? 'accepted in round ' + accepted.round : satisfied ? 'stopped by --quick in round ' + satisfied.round : 'not accepted') + '; journal ' + outFile);
}
