/* The unknown-world experiment: System 2 in a generated game it has never seen, perceiving only an ASCII picture.

     node --experimental-strip-types scripts/run-grid.ts --seed 22 [options]

   Endpoints and keys come from the environment (never from the command line, never written to the journal):
     JEV_URL (default https://api.typesafe.ai/v1/systemone), JEV_KEY
     LLM_URL (an OpenAI-compatible /chat/completions URL), LLM_KEY, LLM_MODEL
   Options:
     --seed N            the game (default 22: a heuristic that knows the rules wins it at depth 2, the flat control does not; see calibrate-grid.ts)
     --attempts N        proposal/trial rounds (default 8)
     --games N           trial games per attempt from the usual start (default 1: the learner's side is deterministic, so
                         more games from the same start are near-copies of one game, and would count it several times)
     --explore N         exploration games before the first proposal (default 4)
     --depth N           the learner's search depth (default 2)
     --levels a,b,c      the opponent's planner depths, the curriculum (default 2,4)
     --epsilon X         the opponent errs with this probability, seeded per game (default 0.15)
     --probe-positions N labelled positions a probe is measured on, at most (default 40)
     --steps N           investigation answers System 2 may give per round before proposing (default 3)
     --plays N           episodes System 2 may run itself per round with the "replay" request (default 4): its laboratory,
                         from any position of its games, with any of its formulas or a draft; never on the scoreboard
     --reveal-choices    inspect also shows every position the search considered (default: only the one it chose; the
                         learner finds out what else was possible by TRYING changes against the environment)
     --variants N        a laboratory's check: episodes from N starts never played, besides the usual one (default 7)
     --tools a,b,...     the instruments System 2 is given (default: all = view,inspect,act,measure,replay,table,probes - "try" and "play" are accepted too;
                         "none" = none of them). The BASELINE: without them the prompt says nothing of them and any
                         request for one is refused - to measure what the instruments add, the same seed, model and
                         budget with and without.
     --no-grade          skip the operator-only grading of recovered rules against the hidden ones (one LLM call)
     --no-reflection     skip the final reflection round (beliefs, notes and lessons after the last trial; no formula)
     --no-ablation       skip the code-only ablation (same observations, no Judge; information only)
     --flat              CONTROL: a Judge that knows nothing (every answer neutral); the LLM is still consulted
     --out FILE          the journal (default runs/grid-s<seed>-<time>.json)

   The protocol is a researcher's, as in orbit@1 (SPEC-MODELO-DEL-MUNDO §1.1, worlds/grid/family.ts):
     1. System 2 starts with ONE laboratory, the base board. Every round its model is CHECKED there: episodes from the
        usual start and from starts never played, and the episodes of its previous check there run again with the new
        model (same starts, same seeds for what it does not control - the paired regression). It holds in a place when
        every episode scored 1 and none run again scored less than before.
     2. When IT decides its model holds, it asks to validate ("validate": true). If it holds in all its laboratories, the
        model plays on boards of the family it has not seen (other sizes, pieces and starts, the same rules).
     3. A board where it does not hold becomes a laboratory: its episodes are the learner's, and it can act and replay there.
     4. When it holds on every board of the family, two sets of boards nobody has seen decide acceptance. Accepted against
        the last opponent level of --levels, the run ends; otherwise the opponent plans further ahead and the protocol goes on.
     --family N          boards of the family to validate on (default 4)
     --validations N     how many times System 2 may validate (default 3; asking before the model holds in its
                         laboratories is refused and costs nothing)
     --confirm-boards N  boards per blind confirmation set, two sets (default 3)
     --family-variants N episodes from new starts per board in a validation or a confirmation, besides the usual one (default 3)
     --quick             stop the first time System 2 asks to validate (it judges its model good), with no validation: to see
                         whether a change makes the exploration promising. Implies --no-ablation and --no-reflection.

   System 2 learns ONLY from what it perceives, what its code measures, what its own search explored and how its games
   ended. The journal also keeps OPERATOR-ONLY measurements (the hidden spec, the ceiling of a heuristic that knows the
   rules, the truth's view of each move, the code-only ablation): they are for us, and never reach System 2 or Jev.

   Every round has a TRIAL (the same measure for every formula, what the scoreboard shows) and, before it, System 2's own
   investigation, where it may play games itself. A line to explore when we move on to generalizing (option b, not
   built): no fixed trial per round - System 2 experiments freely with "play" and asks for the trial only when it
   presents a candidate formula, as a researcher would. */
import fs from 'node:fs';
import path from 'node:path';
import { Observer } from '../src/core/observer.ts';
import { Evaluator } from '../src/core/evaluate.ts';
import { OutputRunner, outputInputs } from '../src/core/output.ts';
import { JevJudge, JEV_DEFAULT_URL } from '../src/core/jev.ts';
import { searchBestMove, PLAY_PV_ALPHA_BETA } from '../src/core/search.ts';
import { createPlanner } from '../src/core/truth.ts';
import { nodeVmRunner } from '../src/runtime/node-vm.ts';
import { openAiChatClient } from '../src/learn/system2.ts';
import { replayOnEvidence } from '../src/learn/gates.ts';
import type { AttemptScore, TrialGame } from '../src/learn/loop.ts';
import { HypothesisRegistry, actionAccuracy, runProbes, winningMoves, type ActionSample, type LabelledPosition, type Probe } from '../src/learn/experiments.ts';
import { ceilingOf, tightness } from '../src/worlds/grid/informed.ts';
import { variantStarts } from '../src/worlds/grid/variants.ts';
import { reflectionTask, toolOf } from '../src/learn/prompt.ts';
import { EXPLORER_TOOLS, INVESTIGATION_TOOLS, explorerSystem, type ExplorerTool, explorerPayload, ownFormula, parseExplorerTurn, parseReflection, type ExplorerProposal, type ExplorerRequest } from '../src/learn/explorer.ts';
import { Notebook, type GameRecord } from '../src/learn/notebook.ts';
import { recordTurn, surprises, type TurnRecord } from '../src/learn/exploration.ts';
import { codeOnlyFormula, codeOnlyJudge, fitCodeOnly } from '../src/learn/ablation.ts';
import { noisyOpponent, playEpisode } from '../src/learn/episodes.ts';
import { parseJsonLoose, type ApiError } from '../src/core/net.ts';
import { describeGridTruth } from '../src/worlds/grid/describe.ts';
import { GRID_PERCEPT_DOC, asciiSense, bFallback, createGridWorld, generateSpec, mulberry32, readPicture,
  type GridMove, type GridSense, type GridSpec, type GridState } from '../src/worlds/grid/index.ts';
import { boardOf } from '../src/worlds/grid/family.ts';
import type { ObserverLike } from '../src/core/evaluate.ts';
import type { Planner } from '../src/core/truth.ts';
import type { Formula, MeasureDecl } from '../src/core/types.ts';
import { ROOT } from '../test/support.ts';

/* --- Configuration ---------------------------------------------------------------- */

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
const flag = (name: string): boolean => argv.includes('--' + name);
const cfg = {
  seed: Number(arg('seed', '22')),
  attempts: Number(arg('attempts', '8')),
  games: Number(arg('games', '1')),
  explore: Number(arg('explore', '4')),
  depth: Number(arg('depth', '2')),
  levels: arg('levels', '2,4').split(',').map(Number),
  epsilon: Number(arg('epsilon', '0.15')),
  probePositions: Number(arg('probe-positions', '40')),
  flat: flag('flat'),
  ablation: !flag('no-ablation'),
  variants: Number(arg('variants', '7')),
  reflection: !flag('no-reflection'),
  grade: !flag('no-grade'),
  steps: Number(arg('steps', '3')),
  plays: Number(arg('plays', '4')),
  revealChoices: flag('reveal-choices'),
  tools: parseTools(arg('tools', 'all')),
  family: Math.max(1, Number(arg('family', '4'))),
  validations: Math.max(1, Number(arg('validations', '3'))),
  confirmBoards: Math.max(1, Number(arg('confirm-boards', '3'))),
  familyVariants: Math.max(0, Number(arg('family-variants', '3'))),
  quick: flag('quick')
};
if (cfg.quick) { cfg.ablation = false; cfg.reflection = false; }
function parseTools(value: string): ExplorerTool[] {
  if (value === 'all') return [...EXPLORER_TOOLS];
  if (value === 'none') return [];
  const asked = value.split(',').map((t) => t.trim()).filter(Boolean).map((t) => toolOf(t) ?? t);
  const unknown = asked.filter((t) => !(EXPLORER_TOOLS as readonly string[]).includes(t));
  if (unknown.length) { console.error('--tools: unknown ' + unknown.join(', ') + ' (tools: ' + EXPLORER_TOOLS.join(', ') + ', or all / none)'); process.exit(2); }
  return EXPLORER_TOOLS.filter((t) => asked.includes(t));
}
const tools: ReadonlySet<ExplorerTool> = new Set(cfg.tools);
const investigative = INVESTIGATION_TOOLS.some((t) => tools.has(t));
const SYSTEM_PROMPT = explorerSystem(tools);
const env = process.env;
if (!env.LLM_URL || !env.LLM_MODEL) { console.error('LLM_URL and LLM_MODEL are required (and LLM_KEY if the endpoint needs one).'); process.exit(2); }
if (!cfg.flat && !env.JEV_KEY) { console.error('JEV_KEY is required (or run the --flat control).'); process.exit(2); }

/* --- Operator-only measures: logged for the operator, never shown to System 2 or the Judge ----------- */

/** How much the formula's observations compress the positions its games went through: distinct observation vectors
    (with the side to move - what the Judge's cache is keyed on) against distinct positions. Operator only. */
function abstractionOf(formula: Formula, stored: readonly { states: GridState[] }[]): Record<string, number> {
  const positions = new Set<string>();
  const observed = new Set<string>();
  let states = 0;
  for (const g of stored) {
    for (const st of g.states) {
      if (where(st).world.outcome(st).over) continue;
      states++;
      positions.add(where(st).id + world.key(st));
      observed.add(multiObserver.observe(st, formula.observations).vector + '|T' + st.turn);
    }
  }
  return { states, distinct_positions: positions.size, distinct_observations: observed.size,
    positions_per_observation: Math.round(positions.size / Math.max(1, observed.size) * 100) / 100 };
}

/** Operator only: an LLM grades System 2's final beliefs, notes and reflection against the hidden rules, stated in the
    coordinates of its picture. The result goes to the journal and nowhere else. */
async function gradeRecovery(): Promise<void> {
  const truth = describeGridTruth(spec, sense);
  const brief = notebook.brief();
  const learned = { beliefs: brief.beliefs_held, dropped: brief.beliefs_dropped, notes: brief.notes, reflections: notebook.reflections };
  const system = 'You grade how well a learner recovered the hidden rules of a game it could only watch as an ASCII picture. '
    + 'For each TRUE rule, decide from the learner\'s own words whether it stated that rule: "exact" (stated correctly and completely, in any wording or coordinates equivalent to the picture), '
    + '"partial" (the right idea but incomplete, too broad or too narrow), "wrong" (it states something that contradicts the rule), or "absent" (it says nothing about it). '
    + 'Judge what the learner holds, not what it dropped, unless it holds nothing on that rule. Quote the learner briefly as evidence. '
    + 'Answer JSON: {"grades": [{"id": ..., "grade": "exact"|"partial"|"wrong"|"absent", "evidence": ...}], "false_beliefs": [learner claims about the rules that no true rule supports]}';
  const user = JSON.stringify({ true_rules: truth, picture_glyphs: { learner: sense.glyphA, other: sense.glyphB }, learner: learned });
  try {
    const content = (await llm.complete({ system, user })).content;
    const parsed = parseJsonLoose(content) as { grades?: { id: string; grade: string; evidence?: string }[]; false_beliefs?: unknown[] } | null;
    const grades = (parsed?.grades ?? []).filter((g) => truth.some((t) => t.id === g.id));
    const points = grades.reduce((n, g) => n + (g.grade === 'exact' ? 1 : g.grade === 'partial' ? 0.5 : 0), 0);
    const score = Math.round(points / truth.length * 100) / 100;
    log('operator_rule_recovery', { truth, grades, false_beliefs: parsed?.false_beliefs ?? [], score, grader_model: env.LLM_MODEL });
    say('operator: rule recovery ' + score + ' (' + grades.map((g) => g.id + ':' + g.grade).join(' ') + ')');
  } catch (e) {
    log('operator_rule_recovery', { truth, error: String((e as Error).message ?? e) });
  }
}

/* --- The world, as the operator knows it and as the learner perceives it ------------- */

const { spec, report } = generateSpec(cfg.seed);
const world = createGridWorld(spec);
const sense = asciiSense(spec);
const observer = new Observer<GridState>(world, {
  kinds: ['sense', 'code'],
  runners: [nodeVmRunner({ timeoutMs: 2000 })],
  senses: { ascii: (s) => sense.render(s) },
  perceive: (_s, percepts) => readPicture(Object.values(percepts)[0])
});
const SENSES: Record<string, MeasureDecl> = { picture: { definition: 'what is perceived', spec: { kind: 'sense', sense: 'ascii' } } };

/* A Judge that knows nothing: the control a learned formula must beat. */
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
/* One cache of the Judge's answers for every board: it is keyed on what the observations measure, never on the board. */
const jevCache = new Map();
const evaluator = new Evaluator<GridState>(observer, judge, { maximizer: 'A', runners: [nodeVmRunner({ timeoutMs: 2000 })], cache: jevCache });
const outputs = new OutputRunner([nodeVmRunner({ timeoutMs: 2000 })]);
/** A model's output must answer a number on points of its own episodes before anything plays with it (every rule answering
    0.5: no Judge call). */
function outputFailures(formula: Formula, states: readonly GridState[]): string[] {
  if (!formula.output) return [];
  const neutral = Object.fromEntries(Object.keys(formula.rules).map((id) => [id, 0.5]));
  for (const state of states.filter((x) => !where(x).world.outcome(x).over).slice(-10)) {
    try {
      const o = multiObserver.observe(state, formula.observations);
      const out = outputs.run(formula.output, o.context ?? null, outputInputs(o.values, o.texts, neutral, Object.keys(neutral).length ? 0.5 : null));
      if (typeof out.answer !== 'number' || !Number.isFinite(out.answer)) return ['output must answer a number (it answered ' + JSON.stringify(out.answer) + ')'];
    } catch (e) { return ['output: ' + String((e as Error).message ?? e)]; }
  }
  return [];
}
const llm = openAiChatClient({ url: env.LLM_URL, apiKey: env.LLM_KEY, model: env.LLM_MODEL, jsonMode: true, temperature: 0.4, timeoutMs: 180000, retries: 1 });

let level = 0;

/* --- Places: the boards of the family (worlds/grid/family.ts, SPEC-MODELO-DEL-MUNDO §1.1) ------------------------
   The same rules on boards of other sizes, pieces and starts. System 2 begins with ONE laboratory (the base board); its
   model is checked there every round. When it asks to validate, the model plays on boards it has not seen; a board where
   it does not hold becomes a laboratory. When it holds on all of them, boards nobody has seen decide acceptance. */

type Role = 'laboratory' | 'family' | 'confirmation';
interface Place {
  readonly id: string;
  readonly index: number;
  readonly spec: GridSpec;
  readonly world: typeof world;
  readonly sense: GridSense;
  readonly observer: Observer<GridState>;
  readonly evaluator: Evaluator<GridState>;
  role: Role;
  /** Its episodes are the learner's (a laboratory, or a board where it validated). */
  seen: boolean;
  planner: Planner<GridState, GridMove>;
}
const plannerFor = (w: typeof world, board: GridSpec) => createPlanner(w, 'B', cfg.levels[level], { fallback: bFallback(board) });
const base: Place = { id: 'lab1', index: 0, spec, world, sense, observer, evaluator, role: 'laboratory', seen: true, planner: plannerFor(world, spec) };
function makePlace(id: string, index: number, role: Role): Place {
  /* One world id for the whole family: a model is usable on every board. */
  const board: GridSpec = { ...boardOf(spec, index).spec, id: spec.id };
  const w = createGridWorld(board);
  const se = asciiSense(board);
  const ob = new Observer<GridState>(w, { kinds: ['sense', 'code'], runners: [nodeVmRunner({ timeoutMs: 2000 })], senses: { ascii: (x) => se.render(x) },
    perceive: (_s, percepts) => readPicture(Object.values(percepts)[0]) });
  const ev = new Evaluator<GridState>(ob, judge, { maximizer: 'A', runners: [nodeVmRunner({ timeoutMs: 2000 })], cache: jevCache });
  return { id, index, spec: board, world: w, sense: se, observer: ob, evaluator: ev, role, seen: role === 'laboratory', planner: plannerFor(w, board) };
}
const places = new Map<string, Place>([[base.id, base]]);
for (let k = 1; k <= cfg.family; k++) places.set('place' + k, makePlace('place' + k, k, 'family'));
const labs = (): Place[] => [...places.values()].filter((p) => p.role === 'laboratory');

/* Every state the learner can name belongs to a board: what is perceived and how an episode ends depend on it. */
const placeOf = new WeakMap<GridState, Place>();
const where = (s: GridState): Place => placeOf.get(s) ?? base;
/** Measures a state on its own board (probes, tables, measures and the ablation read states of any board). */
const multiObserver: ObserverLike<GridState> = { world, observe: (s, obs) => where(s).observer.observe(s, obs) };

/* OPERATOR-CHOSEN starting positions never played before, new for every attempt (A can still force the win from each:
   the test must be fair); the learner only ever plays them. The formula and its ablation get the same ones. */
const variantCache = new Map<string, GridState[]>();
const variantsFor = (place: Place, attempt: number, count = cfg.variants): GridState[] => {
  const key = place.id + ':' + cfg.levels[level] + ':' + attempt + ':' + count;
  if (!variantCache.has(key)) {
    let starts: GridState[] = [];
    try { starts = count > 0 ? variantStarts(place.spec, { count, level: cfg.levels[level], seed: cfg.seed * 1009 + attempt + place.index * 7919 }) : []; } catch { starts = []; }
    variantCache.set(key, starts);
  }
  return variantCache.get(key)!;
};

/** The episodes of a check: the board's usual start, then starts never played; each with its own seed for everything
    the learner does not control, kept so the same episode can be run again with another model. */
interface Plan { readonly start?: GridState; readonly seed: number; readonly label: string }
function plansFor(place: Place, attempt: number, count: number): Plan[] {
  const seedOf = (g: number) => cfg.seed * 7717 + attempt * 101 + g * 7 + level * 1_000_003 + place.index * 104729;
  return [...Array.from({ length: cfg.games }, (_, g) => ({ seed: seedOf(g), label: 'usual start ' + g })),
    ...variantsFor(place, attempt, count).map((start, v) => ({ start, seed: seedOf(cfg.games + v), label: 'new start ' + v }))];
}

/* --- The journal ------------------------------------------------------------------ */

const started = new Date();
const outFile = arg('out', path.join(ROOT, 'runs', 'grid-s' + cfg.seed + '-' + started.toISOString().replace(/[:.]/g, '-') + '.json'));
fs.mkdirSync(path.dirname(outFile), { recursive: true });
const journal: Record<string, any> = {
  experiment: 'unknown-world@1', started: started.toISOString(), config: { ...cfg, llm_model: env.LLM_MODEL, jev_model: env.JEV_MODEL ?? null },
  hidden_from_the_learner: { spec, generator: report, glyphs: { you: sense.glyphA, other: sense.glyphB }, orientation: sense.orientation },
  events: [] as unknown[]
};
const log = (type: string, data: Record<string, unknown> = {}): void => {
  journal.events.push({ t: Math.round((Date.now() - started.getTime()) / 1000), type, ...data });
  fs.writeFileSync(outFile, JSON.stringify(journal, null, 2));
};
const say = (text: string): void => console.log('[' + Math.round((Date.now() - started.getTime()) / 1000) + 's] ' + text);

/* --- The learner's own experience ---------------------------------------------------
   Games are kept whole (states) with what the learner's search did on each of its turns. System 2 reaches them only
   through its requests; the truth never labels anything it sees. */

interface StoredGame {
  readonly id: string;
  readonly place: string;
  readonly round: number;
  readonly how: string;
  readonly result: GameRecord['result'];
  readonly states: GridState[];
  readonly turns: Map<number, TurnRecord<GridState>>;
}
const games = new Map<string, StoredGame>();
const notebook = new Notebook();
let gameCounter = 0;
const resultOf = (winner: string | null): GameRecord['result'] => (winner === 'A' ? 'won' : winner === 'B' ? 'lost' : 'draw');
/** What System 2 is told of how an episode ended: the score of the interface, never a word of a game. */
const scoreOfResult = (r: string): number => (r === 'won' ? 1 : r === 'lost' ? -1 : 0);
const valueOfResult = (r: GameRecord['result']): number => (r === 'won' ? 1 : r === 'lost' ? 0 : 0.5);

function store(round: number, how: string, states: GridState[], winner: string | null, turns = new Map<number, TurnRecord<GridState>>(), place: Place = base): StoredGame {
  const g: StoredGame = { id: 'g' + (++gameCounter), place: place.id, round, how, result: resultOf(winner), states, turns };
  for (const st of states) placeOf.set(st, place);
  for (const t of turns.values()) { placeOf.set(t.state, place); for (const c of t.choices) placeOf.set(c.state, place); }
  games.set(g.id, g);
  notebook.addGames([{ id: g.id, round, how: how + ' (in ' + place.id + ')', result: g.result, turns: states.length - 1 }]);
  return g;
}

/* Positions the learner reached by TRYING a change against the environment (never part of a game). */
const tries: GridState[] = [];

/** "g3@4" is the position at turn 4 of game g3; "g3@4/2" a position its search considered on that turn (only the one
    it chose, unless --reveal-choices); "try5" the result of the learner's fifth accepted try. */
function resolve(ref: string): GridState | null {
  const t = /^(?:act|try)(\d+)$/.exec(ref.trim());
  if (t) return tries[Number(t[1]) - 1] ?? null;
  const m = /^(g\d+)@(\d+)(?:\/(\d+))?$/.exec(ref.trim());
  const g = m ? games.get(m[1]) : undefined;
  if (!m || !g) return null;
  const turn = Number(m[2]);
  if (m[3] === undefined) return g.states[turn] ?? null;
  const choice = g.turns.get(turn)?.choices[Number(m[3])];
  return choice && (cfg.revealChoices || choice.chosen) ? choice.state : null;
}

async function explore(): Promise<void> {
  for (let g = 0; g < cfg.explore; g++) {
    const rnd = mulberry32(cfg.seed * 1009 + g);
    const opponent = noisyOpponent(world, (s) => base.planner.respond(s), cfg.epsilon, rnd);
    const ep = await playEpisode(world, (s, actor) => {
      if (actor === 'B') return opponent(s);
      const moves = world.actions(s);
      return moves[Math.floor(rnd() * moves.length)];
    });
    const stored = store(0, 'the environment: your steps chosen at random', ep.states, ep.outcome.winner);
    log('exploration_game', { game: stored.id, winner: ep.outcome.winner, reason: ep.outcome.reason, plies: ep.states.length - 1 });
  }
}

interface Measured extends AttemptScore<Formula> {
  readonly stored: StoredGame[];
  /** The episodes' plans and scores, in order (to run them again with another model). */
  readonly plans: Plan[];
  readonly scores: number[];
  /* Operator-only measurements (the truth watching): never shown to System 2. */
  readonly samples: ActionSample[];
  readonly held: (number | null)[];
  readonly critical: (number | null)[];
  /** Wins from the starting positions it had never played (the generalization test). */
  readonly variantWins: number;
}

/** Episodes of a model on one board, from the given plans. Its search's view of each of its steps is recorded for the
    learner when `record`; the truth watches too, for the operator only. */
async function trial(formula: Formula, attempt: number, place: Place, plans: readonly Plan[], options: { using?: Evaluator<GridState>; tag?: string; record?: boolean; how?: string } = {}): Promise<Measured> {
  const using = options.using ?? place.evaluator;
  const record = options.record ?? true;
  const tag = options.tag ?? '';
  const pw = place.world;
  const results: TrialGame[] = [];
  const stored: StoredGame[] = [];
  const samples: ActionSample[] = [];
  const held: (number | null)[] = [];
  const criticals: (number | null)[] = [];
  const scores: number[] = [];
  const round = roundOf.get(formula) ?? currentRound;
  for (const plan of plans) {
    const rnd = mulberry32(plan.seed);
    const opponent = noisyOpponent(pw, (s) => place.planner.respond(s), cfg.epsilon, rnd);
    const t0 = Date.now();
    const turns = new Map<number, TurnRecord<GridState>>();
    let stillWinning = 0, critical: number | null = null, knownThroughout = true;
    const ep = await playEpisode(pw, async (s, actor) => {
      if (actor === 'B') return opponent(s);
      const r = await searchBestMove<GridState, GridMove>(using, s, { formula, depth: cfg.depth, profile: PLAY_PV_ALPHA_BETA });
      const chosen = r.best.bestMove ?? pw.actions(s)[0];
      if (record) turns.set(s.ply, await recordTurn(using, pw, s, chosen, { formula, depth: cfg.depth, maximizer: 'A', turn: s.ply }));
      /* OPERATOR ONLY: the truth's view of the same step. */
      const winners = winningMoves(pw, s, 'A', (x) => place.planner.respond(x), 40000);
      if (!winners) { if (critical === null) knownThroughout = false; return chosen; }
      const keeps = winners.some((m) => pw.actionKey!(m) === pw.actionKey!(chosen));
      samples.push({ winning: keeps, available: pw.actions(s).length, keeping: winners.length });
      if (critical === null && winners.length) { if (keeps) stillWinning++; else critical = s.ply; }
      return chosen;
    }, plan.start ? { start: plan.start } : {});
    results.push({ outcome: ep.outcome.winner === 'A' ? 'win' : ep.outcome.winner === 'B' ? 'loss' : 'draw', plies: ep.states.length - 1 });
    scores.push(ep.outcome.winner === 'A' ? 1 : ep.outcome.winner === 'B' ? -1 : 0);
    held.push(knownThroughout || critical !== null ? stillWinning : null);
    criticals.push(critical);
    if (record) stored.push(store(round, (options.how ?? 'your model of round ' + round) + (plan.start ? ', from a start you had not seen' : ''), ep.states, ep.outcome.winner, turns, place));
    say(tag + place.id + ' attempt ' + attempt + ' ' + plan.label + ': ' + (ep.outcome.winner ?? 'none') + ' by ' + ep.outcome.reason + ' after ' + (ep.states.length - 1) +
      ' turns [operator: still winning for ' + (held[held.length - 1] ?? '?') + ' turns' + (critical !== null ? ', thrown at ' + critical : '') + ']' +
      ' (' + Math.round((Date.now() - t0) / 1000) + ' s' + (record ? ', Jev calls ' + judge.stats.calls : '') + ')');
  }
  const wins = results.filter((g) => g.outcome === 'win').length;
  const variantWins = results.slice(cfg.games).filter((g) => g.outcome === 'win').length;
  return { formula, wins, total: results.length, perfect: wins === results.length, games: results, stored, plans: [...plans], scores, samples, held, critical: criticals, variantWins };
}

/* OPERATOR ONLY: the same observations read linearly, no Judge, the same episodes. Never shown to System 2. */
async function ablate(formula: Formula, attempt: number, score: Measured, place: Place): Promise<void> {
  const fit = fitCodeOnly(multiObserver, formula, (await probeSet()).filter((p) => !p.final));
  const plain = new Evaluator<GridState>(place.observer, codeOnlyJudge(fit), { maximizer: 'A', runners: [nodeVmRunner({ timeoutMs: 2000 })] });
  const ablated = await trial(codeOnlyFormula(formula), attempt, place, score.plans, { using: plain, tag: '  [code-only] ', record: false });
  const carrier = ablated.wins > score.wins ? 'the observations alone won MORE than the formula (' + ablated.wins + ' vs ' + score.wins + ')'
    : ablated.wins === score.wins ? (score.wins ? 'the observations carry it' : 'neither wins')
    : 'the rules of the Judge add ' + (score.wins - ablated.wins) + ' win(s)';
  log('operator_ablation_code_only', { attempt, place: place.id, level: cfg.levels[level], fit, formula_wins: score.wins, code_only_wins: ablated.wins, total: score.total,
    formula_held: score.held, code_only_held: ablated.held, code_only_action_accuracy: actionAccuracy(ablated.samples), reading: carrier });
  say('  [operator] ablation: formula ' + score.wins + '/' + score.total + ', observations alone ' + ablated.wins + '/' + ablated.total + ' -> ' + carrier);
}

/* --- Probes: labelled by how the learner's OWN games ended -------------------------------- */

const registry = new HypothesisRegistry();
let currentRound = 0;
const roundOf = new WeakMap<Formula, number>();
const formulaOfRound = new Map<number, Formula>();
let lastScore: Measured | null = null;
/* The protocol's state: what System 2 asked of each model, the validations left, the latest verdicts, and each laboratory's
   previous check (to run it again with the next model). */
const asksToValidate = new WeakSet<Formula>();
let validationsLeft = cfg.validations;
let lastCheck: unknown = null;
const previousCheck = new Map<string, { plans: Plan[]; scores: number[]; ids: string[] }>();
const placesView = () => [...places.values()].filter((p) => p.role !== 'confirmation' && p.seen)
  .map((p) => ({ place: p.id, role: p.role === 'laboratory' ? 'your laboratory: you can act and replay here' : 'a place where your model was validated' }));
let unaddressed: string[] = [];

type Labelled = LabelledPosition<GridState> & { readonly ref: string };

async function probeSet(): Promise<Labelled[]> {
  const inPlay: Labelled[] = [], finals: Labelled[] = [];
  const seen = new Set<string>();
  for (const g of games.values()) {
    /* The score the game ended with for the learner; the operator's code-only fit still reads won / not won. */
    const score = g.result === 'won' ? 1 : g.result === 'lost' ? -1 : 0;
    const label = score > 0 ? 'win' : 'loss';
    for (const [turn, s] of g.states.entries()) {
      const over = where(s).world.outcome(s).over;
      if (!over && s.turn !== 'A') continue;
      const key = (over ? 'F' : 'P') + g.place + world.key(s) + score;
      if (seen.has(key)) continue;
      seen.add(key);
      (over ? finals : inPlay).push({ state: s, label, score, ref: g.id + '@' + turn, ...(over ? { final: true } : {}) });
    }
  }
  /* Balanced and bounded: as many positions from each game score as there can be. */
  const take = <T>(xs: T[], n: number) => { const step = Math.max(1, xs.length / n); return Array.from({ length: Math.min(n, xs.length) }, (_, i) => xs[Math.floor(i * step)]); };
  const third = Math.floor(cfg.probePositions / 3);
  const pick = (xs: Labelled[], n: number) => [1, 0, -1].flatMap((score) => take(xs.filter((p) => p.score === score), n));
  return [...pick(inPlay, third), ...pick(finals, Math.max(5, Math.floor(third / 2)))];
}


/* --- Investigation: System 2 queries its own experience ------------------------------ */

const picture = (s: GridState): string => where(s).sense.render(s);

/* Its own games, played on request: from a position of its games, with a formula it names or drafts. The opponent is
   the usual one, with a fresh seed each time, so a repeated experiment can end differently - as the real one would. */
let playCounter = 0;
async function play(from: string, formula: Formula, how: string): Promise<unknown> {
  const start = resolve(from);
  if (!start) return { replay: from, error: 'no such point' };
  const place = where(start);
  if (place.role !== 'laboratory') return { replay: from, error: 'you can replay only in your laboratories: ' + labs().map((l) => l.id).join(', ') };
  const pw = place.world;
  if (pw.outcome(start).over) return { replay: from, error: 'that episode has already ended there' };
  const rnd = mulberry32(cfg.seed * 3571 + (++playCounter) * 131 + level * 1_000_003);
  const opponent = noisyOpponent(pw, (s) => place.planner.respond(s), cfg.epsilon, rnd);
  const turns = new Map<number, TurnRecord<GridState>>();
  const ep = await playEpisode(pw, async (s, actor) => {
    if (actor === 'B') return opponent(s);
    const r = await searchBestMove<GridState, GridMove>(place.evaluator, s, { formula, depth: cfg.depth, profile: PLAY_PV_ALPHA_BETA });
    const chosen = r.best.bestMove ?? pw.actions(s)[0];
    const turn = s.ply - start.ply;
    turns.set(turn, await recordTurn(place.evaluator, pw, s, chosen, { formula, depth: cfg.depth, maximizer: 'A', turn }));
    return chosen;
  }, { start });
  const g = store(currentRound, 'your replay: ' + how + ', from ' + from, ep.states, ep.outcome.winner, turns, place);
  log('played_by_the_learner', { round: currentRound, game: g.id, from, how, result: g.result, turns: ep.states.length - 1, reason: ep.outcome.reason,
    ...(roundOf.has(formula) ? {} : { draft: formula }) });
  return { replay: from, with: how, episode: g.id, score: scoreOfResult(g.result), steps: ep.states.length - 1 };
}

async function runRequest(req: ExplorerRequest, current: Formula | null, plays: { left: number }): Promise<unknown> {
  /* An instrument withheld by the experiment is refused, never run. */
  const kind = (['view', 'inspect', 'act', 'measure', 'replay', 'table'] as const).find((k) => k in req)!;
  if (!tools.has(kind)) return { [kind]: (req as Record<string, unknown>)[kind], error: '"' + kind + '" is not available in this experiment' };
  if ('replay' in req) {
    if (plays.left <= 0) return { replay: req.replay, error: 'no replays left this round' };
    const formula = req.formula === null ? current : typeof req.formula === 'number' ? formulaOfRound.get(req.formula) ?? null : req.formula;
    if (!formula) return { replay: req.replay, error: req.formula === null ? 'you have no model yet: write a draft' : 'no model of round ' + req.formula };
    if (typeof req.formula === 'object' && req.formula !== null) {
      const recent = [...games.values()].flatMap((g) => g.states).slice(-60);
      const observed = replayOnEvidence(multiObserver, formula.observations, recent.map((state) => ({ state }))).errors.slice(0, 4).map((e) => (e.observation ?? '') + ': ' + e.error);
      const failures = observed.length ? observed : outputFailures(formula, recent);
      if (failures.length) return { replay: req.replay, error: 'your draft failed on points of your episodes: ' + failures.join(' | ') };
    }
    plays.left--;
    const how = req.formula === null ? 'your_model' + (current && roundOf.has(current) ? ' (round ' + roundOf.get(current) + ')' : '')
      : typeof req.formula === 'number' ? 'your model of round ' + req.formula : 'a draft model';
    return play(req.replay, formula, how);
  }
  if ('view' in req) {
    const g = games.get(req.view);
    if (!g) return { view: req.view, error: 'no such episode' };
    const frames = g.states.map((s, step) => ({ step, picture: picture(s) })).slice(Math.max(0, req.from), Math.max(0, req.to) + 1);
    return { view: g.id, score: scoreOfResult(g.result), steps: g.states.length - 1, frames };
  }
  if ('inspect' in req) {
    const m = /^(g\d+)@(\d+)$/.exec(req.inspect.trim());
    const g = m ? games.get(m[1]) : undefined;
    if (!m || !g) return { inspect: req.inspect, error: 'use "<episode>@<step>" with an episode from your notebook' };
    const t = g.turns.get(Number(m[2]));
    if (!t) return { inspect: req.inspect, error: g.turns.size ? 'your search did not choose at that step (it is not one of yours); yours here: ' + [...g.turns.keys()].join(', ') : 'in this episode your steps were chosen at random: nothing was searched' };
    const describe = (c: TurnRecord<GridState>['choices'][number], k: number) => ({ name: req.inspect + '/' + k, picture: picture(c.state),
      value_looking_ahead: c.lookahead, value_directly: c.direct,
      /* Its own formula taken apart: the answer of each rule and the value of each observation behind value_directly. */
      ...(Object.keys(c.rules).length ? { each_rule_answered: c.rules } : {}),
      ...(Object.keys(c.measures).length ? { your_observations_measured: c.measures } : {}),
      finished_episodes_your_search_ran_into: { scored_1: c.endingsWon, scored_minus_1: c.endingsLost } });
    const k = t.choices.findIndex((c) => c.chosen);
    return {
      inspect: req.inspect, point: picture(t.state), your_search_value: t.value,
      chose: k >= 0 ? describe(t.choices[k], k) : null,
      /* Only with --reveal-choices: otherwise the learner finds out what was possible by trying. */
      ...(cfg.revealChoices ? { also_considered: t.choices.map((c, j) => ({ c, j })).filter(({ c }) => !c.chosen).map(({ c, j }) => describe(c, j)) } : {})
    };
  }
  if ('table' in req) {
    /* The rows behind the probe facts: each position probes use, the code's value, and the score that game ended with. */
    const decl: MeasureDecl = { spec: { kind: 'code', lang: 'js', source: req.table.source }, range: req.table.range };
    const rows = (await probeSet()).filter((p) => !!p.final === (req.on === 'final')).map((p) => {
      const o = multiObserver.observe(p.state, { ...SENSES, m: decl });
      const err = o.errors.find((e) => e.id === 'm');
      return { point: p.ref, episode_score: p.score, ...(err ? { error: err.error } : { value: o.values.m }) };
    });
    return { table: req.table.source, on: req.on, rows };
  }
  if ('act' in req) {
    const s = resolve(req.act);
    if (!s) return { act: req.act, error: 'no such point' };
    const place = where(s);
    if (place.role !== 'laboratory') return { act: req.act, error: 'you can act only in your laboratories: ' + labs().map((l) => l.id).join(', ') };
    if (place.world.outcome(s).over || s.turn !== 'A') return { act: req.act, error: 'the next step there is not yours' };
    const from = place.sense.locate(req.from[0], req.from[1]), to = place.sense.locate(req.to[0], req.to[1]);
    /* The environment answers only allowed or not: never why. */
    const move = from && to ? place.world.actions(s).find((m) => m.from[0] === from[0] && m.from[1] === from[1] && m.to[0] === to[0] && m.to[1] === to[1]) : undefined;
    if (!move) return { act: req.act, from: req.from, to: req.to, accepted: false };
    const after = place.world.step(s, move);
    placeOf.set(after, place);
    tries.push(after);
    /* What anyone who makes the move sees: whether the game ended there, and who won. Never why. */
    const outcome = place.world.outcome(after);
    return { act: req.act, from: req.from, to: req.to, accepted: true, name: 'act' + tries.length, picture: picture(after),
      episode_ended: outcome.over ? { score: outcome.winner === 'A' ? 1 : outcome.winner === 'B' ? -1 : 0 } : false };
  }
  const decl: MeasureDecl = { spec: { kind: 'code', lang: 'js', source: req.measure.source }, ...(req.measure.range ? { range: req.measure.range } : {}) };
  return {
    measure: req.measure.source, values: req.on.map((ref) => {
      const s = resolve(ref);
      if (!s) return { point: ref, error: 'no such point' };
      const o = multiObserver.observe(s, { ...SENSES, m: decl });
      const err = o.errors.find((e) => e.id === 'm');
      return err ? { point: ref, error: err.error } : { point: ref, value: o.values.m ?? o.texts.m };
    })
  };
}

/** How each of its formulas did (facts of its own games), with the best and the latest named. */
function scoreboard(): unknown {
  const rows = notebook.rounds.filter((r) => r.games.length).map((r) => ({ round: r.round, fingerprint: r.fingerprint,
    scored_1: r.games.reduce((a, g) => a + g.wins, 0), episodes: r.games.reduce((a, g) => a + g.of, 0) }));
  if (!rows.length) return null;
  const best = rows.reduce((a, b) => (b.scored_1 / b.episodes > a.scored_1 / a.episodes ? b : a));
  return { by_round: rows, best: best, latest: rows[rows.length - 1] };
}

function latestSurprises(): unknown {
  const latest = lastScore?.stored ?? [];
  return latest.map((g) => ({ episode: g.id, score: scoreOfResult(g.result), where_your_search_was_most_wrong: surprises([...g.turns.values()], valueOfResult(g.result))
    .map(({ turn, next, ...rest }) => ({ step: turn, next, ...rest })) }));
}

const REFLECTION_TASK = reflectionTask(investigative);

/* Set when the LLM service refuses the account itself (no credit, bad key): nothing further can be asked of System 2. */
let llmFatal: string | null = null;

async function propose(from: Formula | null, directive: string | null = null, mode: 'propose' | 'reflect' = 'propose'): Promise<Formula | null> {
  if (llmFatal) return null;
  currentRound++;
  const round = currentRound;
  let refused: string[] = [];
  const investigation: unknown[] = [];
  let steps = 0, refusals = 0;
  const plays = { left: cfg.plays };
  while (refusals < 3 && steps <= cfg.steps + 3) {
    const stepsLeft = investigative ? Math.max(0, cfg.steps - steps) : 0;
    const payload = explorerPayload({
      round, perceptDoc: GRID_PERCEPT_DOC, notebook: notebook.brief(unaddressed),
      formula: from, formulaRound: from ? roundOf.get(from) ?? null : null,
      ...(investigative ? { investigation, stepsLeft } : {}), ...(tools.has('replay') ? { replaysLeft: plays.left } : {}),
      refused, directive, task: mode === 'reflect' ? REFLECTION_TASK : null,
      places: placesView(), validationsLeft, lastCheck
    });
    say('round ' + round + (steps ? ' step ' + steps : '') + ': consulting System 2 (' + Math.round(JSON.stringify(payload).length / 1024) + ' KB)');
    steps++;
    let content = '';
    try {
      content = (await llm.complete({ system: SYSTEM_PROMPT, user: payload })).content;
    } catch (error) {
      const status = (error as ApiError)?.details?.status;
      if (status === 401 || status === 402 || status === 403) {
        llmFatal = String((error as Error)?.message || error);
        log('llm_fatal', { round, status, error: llmFatal });
        say('the LLM service refused the account (HTTP ' + status + '): stopping');
        return null;
      }
      refusals++;
      log('proposal_failed', { round, error: String((error as Error)?.message || error) });
      continue;
    }
    const turn = parseExplorerTurn(content, { world: world.id, senses: SENSES, round });
    const noteWarnings = [...notebook.applyNotes(round, turn.notes, (ref) => games.has(ref.trim()) || resolve(ref) !== null), ...notebook.applyMethods(round, turn.methods)];
    if (turn.notes.length) say('  notes: ' + turn.notes.map((n) => n.do + ' ' + n.id).join(', '));
    if (turn.methods.length) {
      say('  methods: ' + turn.methods.map((m) => m.do + ' ' + m.id).join(', '));
      log('methods', { round, methods: turn.methods });
    }
    if (turn.kind === 'investigate') {
      if (stepsLeft <= 0) { refused = [investigative ? 'no investigation steps left this round: answer with your proposal now' : 'there is no investigating in this experiment: answer with your proposal']; refusals++; continue; }
      const results: unknown[] = [];
      for (const r of turn.requests) results.push(await runRequest(r, from, plays));
      /* A draft travels back as it wrote it, never as the host's formula object. */
      const asWritten = turn.requests.map((r) => 'replay' in r && r.formula !== null && typeof r.formula === 'object' ? { replay: r.replay, model: ownFormula(r.formula) } : r);
      investigation.push({ step: investigation.length + 1, requests: asWritten, results, ...(turn.warnings.length || noteWarnings.length ? { warnings: [...turn.warnings, ...noteWarnings] } : {}) });
      log('investigation', { round, requests: turn.requests, warnings: [...turn.warnings, ...noteWarnings], notes: turn.notes });
      say('  investigates: ' + turn.requests.map((r, i) => 'view' in r ? 'view ' + r.view : 'inspect' in r ? 'inspect ' + r.inspect
        : 'act' in r ? 'act ' + r.act + ' ' + JSON.stringify(r.from) + '>' + JSON.stringify(r.to) + ((results[i] as { accepted?: boolean }).accepted ? ' accepted' : ' refused')
        : 'replay' in r ? 'replay from ' + r.replay + ' -> ' + ((results[i] as { score?: number; error?: string }).score ?? (results[i] as { error?: string }).error)
        : 'table' in r ? 'table on ' + r.on : 'measure on ' + r.on.length).join('; '));
      refused = [];
      continue;
    }
    if (mode === 'reflect') {
      const r = parseReflection(content, round);
      if (!r.ok) { refused = r.errors; refusals++; log('reflection_refused', { round, errors: r.errors, content }); continue; }
      const stances = notebook.applyStances(round, r.reflection.beliefs);
      unaddressed = stances.unaddressed;
      notebook.recordReflection(round, r.reflection.rationale, r.reflection.lessons, r.reflection.nextExperiment);
      log('reflection', { round, investigation_steps: investigation.length, rationale: r.reflection.rationale, beliefs: r.reflection.beliefs, notes: turn.notes,
        lessons: r.reflection.lessons, next_experiment: r.reflection.nextExperiment, stance_warnings: stances.warnings, note_warnings: noteWarnings, no_stance_on: stances.unaddressed });
      say('  reflection: beliefs ' + r.reflection.beliefs.map((b) => b.id + ':' + b.stance).join(' ') + (stances.unaddressed.length ? '; NO STANCE on ' + stances.unaddressed.join(', ') : ''));
      for (const l of r.reflection.lessons) say('  lesson: ' + l);
      return from;
    }
    const parsed = turn.parse;
    if (!parsed.ok) {
      refused = parsed.errors; refusals++;
      log('proposal_refused', { round, errors: parsed.errors, content });
      say('  refused: ' + parsed.errors.slice(0, 3).join(' | '));
      continue;
    }
    /* Executability over the positions of its own games: every observation computes, and repeats itself. */
    const recent = [...games.values()].flatMap((g) => g.states).slice(-60);
    const replay = replayOnEvidence(multiObserver, parsed.proposal.formula.observations, recent.map((state) => ({ state })));
    const probeObs = Object.fromEntries(parsed.proposal.probes.filter((p) => p.observation).map((p) => ['probe_' + p.id, p.observation!]));
    const probeReplay = replayOnEvidence(multiObserver, { ...SENSES, ...probeObs }, recent.slice(-20).map((state) => ({ state })));
    const failures = [...[...replay.errors, ...probeReplay.errors].slice(0, 8).map((e) => (e.observation ?? '') + ': ' + e.error),
      ...(replay.errors.length ? [] : outputFailures(parsed.proposal.formula, recent))];
    if (failures.length) {
      refused = ['your model failed on points of your episodes: ' + failures.join(' | ')]; refusals++;
      log('proposal_refused', { round, errors: refused, content });
      say('  refused: ' + refused[0].slice(0, 200));
      continue;
    }
    const proposal: ExplorerProposal = parsed.proposal;
    const stances = notebook.applyStances(round, proposal.beliefs);
    unaddressed = stances.unaddressed;
    notebook.recordRound(round, proposal.formula, proposal.lessons, proposal.nextExperiment);
    roundOf.set(proposal.formula, round);
    formulaOfRound.set(round, proposal.formula);
    if (proposal.validate) asksToValidate.add(proposal.formula);
    log('proposal', { round, investigation_steps: investigation.length, rationale: proposal.rationale, beliefs: proposal.beliefs, notes: turn.notes,
      lessons: proposal.lessons, next_experiment: proposal.nextExperiment, stance_warnings: stances.warnings, note_warnings: noteWarnings,
      no_stance_on: stances.unaddressed, formula: proposal.formula, probes: proposal.probes, warnings: proposal.warnings, variation: replay.variation });
    say('  proposal: ' + Object.keys(proposal.formula.observations).length + ' observations, ' + Object.keys(proposal.formula.rules).length +
      ' rules, ' + proposal.probes.length + ' probes; beliefs ' + proposal.beliefs.map((b) => b.id + ':' + b.stance).join(' ') +
      (stances.unaddressed.length ? '; NO STANCE on ' + stances.unaddressed.join(', ') : ''));
    for (const l of proposal.lessons) say('  lesson: ' + l);
    /* Probes are not an instrument: their statistics would be an analysis made for System 2 (SPEC-MUNDO-FISICO I2). */
    if (proposal.probes.length) log('probes_ignored', { round, reason: 'probes are not an instrument (an analysis made for it)', count: proposal.probes.length });
    return proposal.formula;
  }
  return null;
}

/* --- The run ---------------------------------------------------------------------- */

say('seed ' + cfg.seed + ': ' + spec.width + 'x' + spec.height + ' ' + spec.shape + ', A ' + spec.A.count + ' vs B ' + spec.B.count +
  ', A wins by ' + spec.winA + ', B by ' + spec.winB + (cfg.flat ? '  [CONTROL: flat Judge]' : ''));
log('start', { picture: sense.render(world.initial()) });
/* OPERATOR ONLY: can a heuristic that KNOWS the rules win this game at this depth? Never shown to System 2. */
{
  const ceiling = await ceilingOf(spec, { depth: cfg.depth, level: cfg.levels[0], epsilon: cfg.epsilon });
  journal.hidden_from_the_learner.ceiling = { informed_heuristic: ceiling, tightness: tightness(spec, cfg.levels[0]) };
  say('[operator] ceiling: a heuristic that knows the rules wins ' + ceiling.wins + '/' + ceiling.total + ' at depth ' + cfg.depth);
  if (ceiling.wins === 0) say('[operator] WARNING: not even an informed heuristic wins this game at this depth - pick a seed from calibrate-grid.ts');
}
await explore();
const first = await propose(null);
if (!first) { log('end', { stoppedBy: llmFatal ? 'llm_error' : 'no_first_proposal', ...(llmFatal ? { llm_error: llmFatal } : {}), notebook }); say('no usable first proposal'); process.exit(1); }

/* --- The researcher's protocol (SPEC-MODELO-DEL-MUNDO §1.1): check in the laboratories every round; validate on boards not
   seen when System 2 asks; a board where the model does not hold becomes a laboratory; boards nobody has seen decide. */

type CheckOfPlace = { place: Place; score: Measured; holds: boolean; rerun: { went_up: number; went_down: number; changed: { episode: string; before: number; now: number }[] } | null };
/** Facts only: per place, whether the model holds, each episode's score, and how its previous check's episodes fared again. */
const describeChecks = (checks: readonly CheckOfPlace[]) => checks.map((c) => ({ place: c.place.id, your_model_holds_here: c.holds,
  episodes: c.score.stored.length ? c.score.stored.map((g, i) => ({ episode: g.id, score: c.score.scores[i] })) : c.score.scores.map((score) => ({ score })),
  ...(c.rerun ? { your_previous_check_run_again: c.rerun } : {}) }));

/** A place's check: episodes from its usual start and starts never played, and - in a laboratory - the episodes of its
    previous check run again with this model (same starts, same seeds). */
async function checkIn(place: Place, formula: Formula, attempt: number, count: number, record: boolean, how: string): Promise<CheckOfPlace> {
  const score = await trial(formula, attempt, place, plansFor(place, attempt, count), { record, how });
  let rerun: CheckOfPlace['rerun'] = null;
  const prev = previousCheck.get(place.id);
  if (prev && place.role === 'laboratory') {
    const again = await trial(formula, attempt, place, prev.plans, { record: false, tag: '  [run again] ' });
    const changed = again.scores.map((now, i) => ({ episode: prev.ids[i], before: prev.scores[i], now })).filter((x) => x.now !== x.before);
    rerun = { went_up: changed.filter((x) => x.now > x.before).length, went_down: changed.filter((x) => x.now < x.before).length, changed };
  }
  if (place.role === 'laboratory') previousCheck.set(place.id, { plans: score.plans, scores: score.scores, ids: score.stored.map((g) => g.id) });
  return { place, score, holds: score.perfect && (rerun?.went_down ?? 0) === 0, rerun };
}

const allHold = (checks: readonly CheckOfPlace[]) => checks.every((c) => c.holds);
let confirmCounter = 0;

let candidate: Formula = first;
let accepted: { formula: Formula; round: number | null } | null = null;
let satisfied: Formula | null = null;
let best: { formula: Formula; wins: number; total: number } | null = null;
let stoppedBy = 'budget';
let escalations = 0;
for (let attempt = 1; attempt <= cfg.attempts && !llmFatal; attempt++) {
  const round = roundOf.get(candidate) ?? currentRound;
  say('attempt ' + attempt + ' (round ' + round + ') against opponent level ' + cfg.levels[level] + (cfg.epsilon ? ' (errs ' + cfg.epsilon + ')' : '') + '; laboratories: ' + labs().map((l) => l.id).join(', '));
  /* 1. The check in the laboratories. */
  const callsBefore = judge.stats.calls;
  const labChecks: CheckOfPlace[] = [];
  for (const lab of labs()) labChecks.push(await checkIn(lab, candidate, attempt, cfg.variants, true, 'the check of round ' + round));
  const trialCalls = judge.stats.calls - callsBefore;
  const stored = labChecks.flatMap((c) => c.score.stored);
  const wins = labChecks.reduce((n, c) => n + c.score.wins, 0), total = labChecks.reduce((n, c) => n + c.score.total, 0);
  lastScore = { ...labChecks[0].score, stored };
  notebook.recordGames(round, stored.map((g) => g.result));
  if (!best || wins / Math.max(1, total) > best.wins / Math.max(1, best.total)) best = { formula: candidate, wins, total };
  const operator = labChecks.map((c) => ({ place: c.place.id, action_accuracy: actionAccuracy(c.score.samples), turns_still_winning: c.score.held, critical: c.score.critical }));
  say('  check in the laboratories: ' + labChecks.map((c) => c.place.id + ' ' + c.score.wins + '/' + c.score.total + (c.rerun ? ' (run again: +' + c.rerun.went_up + ' -' + c.rerun.went_down + ')' : '') + (c.holds ? ' holds' : '')).join(', '));
  /* 2. The validation, when System 2 asks for it and its model holds in its laboratories. */
  let validation: Record<string, unknown> | null = null;
  let validationView: Record<string, unknown> | null = null;
  let ok = false;
  const quickStop = cfg.quick && asksToValidate.has(candidate);
  if (asksToValidate.has(candidate) && !quickStop) {
    if (!allHold(labChecks)) validationView = { refused: 'your model does not yet hold in every one of your laboratories: nothing was spent' };
    else if (validationsLeft <= 0) validationView = { refused: 'you have no validations left' };
    else {
      validationsLeft--;
      /* Every board of the family that is not a laboratory: the ones seen before are checked again (a regression). */
      const family = [...places.values()].filter((p) => p.role === 'family');
      const famChecks: CheckOfPlace[] = [];
      for (const f of family) { f.seen = true; famChecks.push(await checkIn(f, candidate, attempt, cfg.familyVariants, true, 'the validation of round ' + round)); }
      const becameLabs = famChecks.filter((c) => !c.holds).map((c) => { c.place.role = 'laboratory'; return c.place.id; });
      validationView = { validated_in: describeChecks(famChecks), ...(becameLabs.length ? { now_your_laboratories: becameLabs } : {}) };
      validation = { family: famChecks.map((c) => ({ place: c.place.id, holds: c.holds, wins: c.score.wins, total: c.score.total })), became_laboratories: becameLabs };
      say('  validation (' + (cfg.validations - validationsLeft) + '/' + cfg.validations + '): ' + famChecks.map((c) => c.place.id + ' ' + c.score.wins + '/' + c.score.total).join(', ') + (becameLabs.length ? '; now laboratories: ' + becameLabs.join(', ') : ''));
      /* 3. It holds everywhere: boards nobody has seen decide. */
      if (!becameLabs.length) {
        const sets: { ok: boolean; places: { place: string; wins: number; total: number }[] }[] = [];
        for (let k = 0; k < 2; k++) {
          const checks: CheckOfPlace[] = [];
          for (let j = 0; j < cfg.confirmBoards; j++) {
            const blind = makePlace('blind' + (++confirmCounter), 1000 + confirmCounter, 'confirmation');
            checks.push(await checkIn(blind, candidate, attempt, cfg.familyVariants, false, 'blind'));
          }
          sets.push({ ok: allHold(checks), places: checks.map((c) => ({ place: c.place.id, wins: c.score.wins, total: c.score.total })) });
        }
        ok = sets.every((x) => x.ok);
        validation.blind_confirmation = { confirmed: ok, sets };
        say('  holds on every board of the family; blind confirmation: ' + sets.map((x) => '[' + x.places.map((p) => p.wins + '/' + p.total).join(' ') + ']').join(' ') + (ok ? ' CONFIRMED' : ' NOT confirmed'));
      }
    }
  }
  lastCheck = { round, laboratories: describeChecks(labChecks), ...(validationView ? { validation: validationView } : {}), accepted: ok, validations_left: validationsLeft };
  log('check', { attempt, round, level: cfg.levels[level], laboratories: labChecks.map((c) => ({ place: c.place.id, holds: c.holds, wins: c.score.wins, total: c.score.total, rerun: c.rerun })),
    asked_to_validate: asksToValidate.has(candidate), ...(validation ? { validation } : validationView ? { validation: validationView } : {}), accepted: ok, operator,
    jev: { calls: judge.stats.calls, errors: judge.stats.errors, trial_calls: trialCalls, calls_per_game: Math.round(trialCalls / Math.max(1, total) * 10) / 10 },
    abstraction: abstractionOf(candidate, stored),
    /* OPERATOR ONLY: analyses of the learner's data it is never handed (SPEC-MUNDO-FISICO I2). */
    operator_analysis: { surprises: latestSurprises(), record: scoreboard() } });
  if (asksToValidate.has(candidate) && !validation && !quickStop) say('  validation refused: ' + String(validationView?.refused ?? ''));
  if (ok) say('  ACCEPTED');
  if (cfg.ablation) await ablate(candidate, attempt, labChecks[0].score, labChecks[0].place);
  if (quickStop) {
    satisfied = candidate; stoppedBy = 'quick_stop';
    log('quick_stop', { round, held_in_laboratories: Object.fromEntries(labChecks.map((c) => [c.place.id, c.holds])), model: ownFormula(candidate) });
    say('  --quick: System 2 judges its model good in round ' + round + ' (in its laboratories: ' + (allHold(labChecks) ? 'holds' : 'does NOT hold') + '); stopping without validation');
    break;
  }
  if (ok) {
    /* Accepted against this opponent: the next one plans further ahead, if the curriculum has one. */
    if (level < cfg.levels.length - 1) {
      level++;
      escalations++;
      for (const p of places.values()) p.planner = plannerFor(p.world, p.spec);
      evaluator.reset();
      previousCheck.clear();
      validationsLeft = cfg.validations;
      log('escalate', { level: cfg.levels[level] });
      say('accepted: the opponent now plans ' + cfg.levels[level] + ' turns ahead');
      continue;
    }
    accepted = { formula: candidate, round };
    stoppedBy = 'accepted';
    break;
  }
  /* It builds on its latest model; which of its models to build on is its own decision (no "best model" handed to it). */
  const next = await propose(candidate);
  if (!next) { if (!llmFatal) { say('attempt ' + attempt + ': System 2 gave no usable proposal'); stoppedBy = 'no_hypothesis'; } break; }
  candidate = next;
}
const result = { accepted: accepted ? { formula: accepted.formula } : null, best, stoppedBy };

if (cfg.reflection && !llmFatal) {
  say('reflection round: the formula is final; System 2 looks back');
  await propose(result.accepted?.formula ?? result.best?.formula ?? null, null, 'reflect');
}
if (cfg.grade && !llmFatal) await gradeRecovery();

log('end', {
  stoppedBy: llmFatal ? 'llm_error' : result.stoppedBy, ...(llmFatal ? { llm_error: llmFatal } : {}),
  escalations,
  accepted: accepted ? { formula: accepted.formula, round: accepted.round } : null,
  ...(satisfied ? { quick_stop: { model: ownFormula(satisfied), round: roundOf.get(satisfied) ?? null } } : {}),
  places: [...places.values()].map((p) => ({ id: p.id, index: p.index, role: p.role, seen: p.seen, size: p.spec.width + 'x' + p.spec.height, pieces: p.spec.A.count + '/' + p.spec.B.count })),
  best: result.best ? { formula: result.best.formula, round: roundOf.get(result.best.formula) ?? null, wins: result.best.wins, total: result.best.total } : null,
  hypotheses: registry.all(), summary: registry.summary(), notebook,
  jev: { calls: judge.stats.calls, errors: judge.stats.errors }
});
if (satisfied) say('the model System 2 judged good (round ' + (roundOf.get(satisfied) ?? '?') + '):\n' + JSON.stringify(ownFormula(satisfied), null, 2));
say('done: ' + result.stoppedBy + ', best ' + (result.best ? result.best.wins + '/' + result.best.total : '-') + ', hypotheses ' + JSON.stringify(registry.summary()));
say('journal: ' + outFile);
