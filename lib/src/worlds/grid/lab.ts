/* ============================================================================
 * The grid (unknown-world@1) as a LABORATORY with a loop of its own (SPEC-OBJETIVO O9c):
 * System 2 in a generated game it has never seen, perceiving only an ASCII picture. Its
 * model is a formula a search plays with (not a law whose answers are compared with what
 * happened); its instruments (replay, inspect of its search, act as a try against the
 * environment, tables over its episodes), its check (episodes played from the usual start
 * and from starts never played) and its curriculum (the opponent plans further ahead once
 * a model is accepted) are its own. It runs with the services every laboratory shares
 * (learn/lab.ts `LabServices`): the command line, System 2 and the Judge with their answers
 * logged (--resume), the journal, the budgets, the finding. What System 2 sees is unchanged.
 *
 * The protocol is a researcher's, as in orbit@1 (SPEC-MODELO-DEL-MUNDO §1.1, family.ts):
 *   1. System 2 starts with ONE laboratory, the base board. Every round its model is CHECKED
 *      there: episodes from the usual start and from starts never played, and the episodes
 *      of its previous check run again with the new model (the paired regression). It holds
 *      in a place when every episode scored 1 and none run again scored less than before.
 *   2. When IT decides its model holds, it asks to validate. If it holds in all its
 *      laboratories, the model plays on boards of the family it has not seen.
 *   3. A board where it does not hold becomes a laboratory.
 *   4. When it holds on every board of the family, two sets of boards nobody has seen decide
 *      acceptance. Accepted against the last opponent level of --levels, the run ends;
 *      otherwise the opponent plans further ahead and the protocol goes on.
 *
 * System 2 learns ONLY from what it perceives, what its code measures, what its own search
 * explored and how its games ended. The journal also keeps OPERATOR-ONLY measurements (the
 * hidden spec, the ceiling of a heuristic that knows the rules, the truth's view of each
 * move, the code-only ablation): they are for us, and never reach System 2 or Jev.
 * ========================================================================== */
import { Observer } from '../../core/observer.ts';
import { Evaluator } from '../../core/evaluate.ts';
import { formulaHash } from '../../core/formula.ts';
import { OutputRunner, outputInputs } from '../../core/output.ts';
import { searchBestMove, PLAY_PV_ALPHA_BETA } from '../../core/search.ts';
import { createPlanner } from '../../core/truth.ts';
import { replayOnEvidence } from '../../learn/gates.ts';
import type { AttemptScore, TrialGame } from '../../learn/loop.ts';
import { HypothesisRegistry, actionAccuracy, runProbes, winningMoves, type ActionSample, type LabelledPosition, type Probe } from '../../learn/experiments.ts';
import { ceilingOf, tightness } from './informed.ts';
import { variantStarts } from './variants.ts';
import { reflectionTask, toolOf } from '../../learn/prompt.ts';
import { EXPLORER_TOOLS, INVESTIGATION_TOOLS, explorerSystem, type ExplorerTool, explorerPayload, ownFormula, parseExplorerTurn, parseReflection, type ExplorerProposal, type ExplorerRequest } from '../../learn/explorer.ts';
import { Notebook, type GameRecord } from '../../learn/notebook.ts';
import { OVERREACH, assistedSystem } from '../../learn/assisted/session.ts';
import { RoundConversation } from '../../learn/system2.ts';

/** How many times a round a researcher may consolidate its round's conversation. */
const MAX_CONSOLIDATIONS = 2;
import { FREE_MEMORY_ANSWERS, JournalMemory, MEMORY_SECTION } from '../../learn/assisted/memory.ts';
import { Experience, experienceSection } from '../../learn/assisted/experience.ts';
import { recordTurn, surprises, type TurnRecord } from '../../learn/exploration.ts';
import { codeOnlyFormula, codeOnlyJudge, fitCodeOnly } from '../../learn/ablation.ts';
import { noisyOpponent, playEpisode } from '../../learn/episodes.ts';
import { parseJsonLoose, type ApiError } from '../../core/net.ts';
import { describeGridTruth } from './describe.ts';
import { GRID_PERCEPT_DOC, asciiSense, bFallback, createGridWorld, generateSpec, mulberry32, readPicture,
  type GridMove, type GridSense, type GridSpec, type GridState } from './index.ts';
import { boardOf, examOverlap, explorationIndices, FAMILY_INDEX } from './family.ts';
import { PEERS_SECTION, PeerChannel, parsePublication, type BoardEntry } from '../../learn/assisted/board.ts';
import { hashString } from '../../core/hash.ts';
import { GRID_ANSWER, GRID_VERDICT, gridObjective } from './objective.ts';
import { Protocol } from '../../learn/protocol.ts';
import { GRADING_STRUCTURE, formOf, operatorSummary, type AblationRecord } from '../../learn/operator.ts';
import type { ObserverLike } from '../../core/evaluate.ts';
import type { Planner } from '../../core/truth.ts';
import type { Formula, MeasureDecl } from '../../core/types.ts';

import type { GameLab, LabRunEnd, LabServices } from '../../learn/lab.ts';

/** Lets the process breathe between steps of a long computation: a check on several places can run for many minutes, and
    without it nothing else runs meanwhile - the run's heartbeat, its inbox (a stop), what it prints, the network's idle
    connections. It changes nothing of what is computed. */
const yieldNow = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The operator's grader of the grid: how well the learner's own words state each hidden rule (also used to grade a
    finished journal again, runtime/regrade.ts). */
export const GRID_GRADING_SYSTEM = 'You grade how well a learner recovered the hidden rules of a game it could only watch as an ASCII picture. '
    + 'For each TRUE rule, decide from the learner\'s own words whether it stated that rule: "exact" (stated correctly and completely, in any wording or coordinates equivalent to the picture), '
    + '"partial" (the right idea but incomplete, too broad or too narrow), "wrong" (it states something that contradicts the rule), or "absent" (it says nothing about it). '
    + 'Judge what the learner holds, not what it dropped, unless it holds nothing on that rule. Quote the learner briefly as evidence. '
    + GRADING_STRUCTURE + ' '
    + 'Answer JSON: {"grades": [{"id": ..., "grade": "exact"|"partial"|"wrong"|"absent", "evidence": ...}], "false_beliefs": [learner claims about the rules that no true rule supports], "form": "compact"|"table"|"mixed", "form_evidence": ...}';

/** What the assisted researcher is told when it has exploration boards (SPEC-INVESTIGACION-PARALELA §4): interface words
    only, never how to use them. */
export const PLACES_SECTION = [
  'YOUR PLACES. Besides your laboratories, you have places to explore (`places`, role "a place to explore"): boards of the same family as your laboratory - the same kind of environment, with another size, other pieces or other starts. Your model is never checked there, and validating never uses them.',
  'Each point names its place (an episode is played in one place). act and replay work from points of episodes in your laboratories and in your places to explore; "<episode>@0" of an episode in a place starts there. A table may be narrowed to one place: {"table": {...}, "on": "in_play", "place": "<place>"}. The replays of one answer are played after its other requests, from what those left; their episodes are named in the order you asked, once all of them have ended.'
].join('\n');

export const gridLab: GameLab = {
  kind: 'game',
  id: 'unknown-world@1',
  about: 'System 2 plays a generated game it has never seen, perceiving only an ASCII picture; its model is a formula that answers how good a point is for it, and a search plays with it.',
  options: [
    { name: 'games', default: '1', help: 'episodes from the usual start per check (the learner\'s side is deterministic: more are near-copies)' },
    { name: 'depth', default: '2', help: 'the learner\'s search depth' },
    { name: 'levels', default: '2,4', help: 'the opponent\'s planner depths, the curriculum' },
    { name: 'epsilon', default: '0.15', help: 'the opponent errs with this probability, seeded per game' },
    { name: 'probe-positions', default: '40', help: 'labelled positions a table and the ablation read, at most' },
    { name: 'plays', default: '4', help: 'episodes System 2 may run itself per round with "replay"' },
    { name: 'variants', default: '7', help: 'a laboratory\'s check: episodes from N starts never played, besides the usual one' },
    { name: 'family-variants', default: '3', help: 'episodes from new starts per board in a validation or a confirmation, besides the usual one' },
    { name: 'explore-places', default: '0', help: 'boards of the family to explore besides the laboratory, never checked there (SPEC-INVESTIGACION-PARALELA §4; the assisted researcher)' },
    { name: 'explore-offset', default: '0', help: 'where its exploration boards start in their stretch of the family (a team gives each member its own)' },
    { name: 'place-concurrency', default: 'concurrent', help: 'with exploration boards, the replays of one step: "concurrent" (at once) or "serial" (one after another); the same episodes either way' }
  ],
  flags: [{ name: 'reveal-choices', help: 'inspect also shows every position the search considered (default: only the one it chose)' }],
  defaults: { seed: '22', explore: '4', family: '4', 'confirm-places': '3' },
  aliases: { 'confirm-boards': 'confirm-places' },
  assistedOptions: ['explore-places'],
  teams: true,
  tools: EXPLORER_TOOLS,
  runName: (seed) => 'grid-s' + seed,
  run: (s) => runGrid(s)
};

async function runGrid(s: LabServices): Promise<LabRunEnd> {
  const o = s.options;
  const cfg = {
    seed: s.cfg.seed, attempts: s.cfg.attempts, games: Number(o.games), explore: s.cfg.explore, depth: Number(o.depth),
    levels: o.levels.split(',').map(Number), epsilon: Number(o.epsilon), probePositions: Number(o['probe-positions']),
    flat: s.cfg.flat, ablation: s.cfg.ablation, variants: Number(o.variants), reflection: s.cfg.reflection, grade: s.cfg.grade,
    steps: s.cfg.steps, plays: Number(o.plays), revealChoices: o['reveal-choices'] === 'true', tools: s.cfg.tools as ExplorerTool[],
    family: s.cfg.family, validations: s.cfg.validations, confirmBoards: s.cfg.confirmPlaces, familyVariants: Math.max(0, Number(o['family-variants'])),
    quick: s.cfg.quick, regression: s.cfg.regression,
    explorePlaces: Math.max(0, Math.floor(Number(o['explore-places']) || 0)), exploreOffset: Math.max(0, Math.floor(Number(o['explore-offset']) || 0)),
    concurrent: o['place-concurrency'] !== 'serial'
  };
  if (!['serial', 'concurrent'].includes(o['place-concurrency'])) throw new Error('--place-concurrency: "serial" or "concurrent"');
  s.journal.config = { ...s.journal.config, levels: cfg.levels };
  const tools: ReadonlySet<ExplorerTool> = new Set(cfg.tools);
  const investigative = INVESTIGATION_TOOLS.some((t) => tools.has(t));
  /* The assisted researcher (SPEC-INVESTIGADOR-ASISTIDO): its own section of the prompt (the operator may write to it), and
     its selective memory when the run gives it one (§13). Without it, the unknown-world researcher's prompt, as it is. */
  const assisted = s.assisted ?? null;
  /* A member of a team (SPEC-INVESTIGACION-PARALELA §5): its board, read and written only if the team exchanges. */
  const team = s.team ?? null;
  const exchange = team !== null && team.board.spec.exchange && assisted !== null;
  const SYSTEM_PROMPT = assisted ? assistedSystem(explorerSystem(tools)) + (assisted.memory ? '\n\n' + MEMORY_SECTION : '')
    + (assisted.experience ? '\n\n' + experienceSection(assisted.experience.mode, assisted.experience.scope) : '')
    + (cfg.explorePlaces ? '\n\n' + PLACES_SECTION : '') + (exchange ? '\n\n' + PEERS_SECTION(team!.board.spec.window) : '') : explorerSystem(tools);

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
    const system = GRID_GRADING_SYSTEM;
    const user = JSON.stringify({ true_rules: truth, picture_glyphs: { learner: sense.glyphA, other: sense.glyphB }, learner: learned });
    try {
      const content = (await llm.complete({ system, user })).content;
      const parsed = parseJsonLoose(content) as { grades?: { id: string; grade: string; evidence?: string }[]; false_beliefs?: unknown[] } | null;
      const grades = (parsed?.grades ?? []).filter((g) => truth.some((t) => t.id === g.id));
      const points = grades.reduce((n, g) => n + (g.grade === 'exact' ? 1 : g.grade === 'partial' ? 0.5 : 0), 0);
      const score = Math.round(points / truth.length * 100) / 100;
      log('operator_rule_recovery', { truth, grades, false_beliefs: parsed?.false_beliefs ?? [], score, ...formOf(parsed as Record<string, unknown> | null), grader_model: s.journal.config.llm_model });
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
    runners: [s.codeRunner()],
    senses: { ascii: (s) => sense.render(s) },
    perceive: (_s, percepts) => readPicture(Object.values(percepts)[0])
  });
  const SENSES: Record<string, MeasureDecl> = { picture: { definition: 'what is perceived', spec: { kind: 'sense', sense: 'ascii' } } };

  const judge = s.judge;
  /* One cache of the Judge's answers for every board: it is keyed on what the observations measure, never on the board. */
  const jevCache = new Map();
  /* And its requests in flight: two searches on two boards at once ask the same judgment once. */
  const jevInflight = new Map();
  const evaluator = new Evaluator<GridState>(observer, judge, { maximizer: 'A', runners: [s.codeRunner()], cache: jevCache, inflight: jevInflight });
  const outputs = new OutputRunner([s.codeRunner()]);
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
  const llm = s.llm;
  const llmUse = s.llmUse;

  let level = 0;

  /* --- Places: the boards of the family (worlds/grid/family.ts, SPEC-MODELO-DEL-MUNDO §1.1) ------------------------
     The same rules on boards of other sizes, pieces and starts. System 2 begins with ONE laboratory (the base board); its
     model is checked there every round. When it asks to validate, the model plays on boards it has not seen; a board where
     it does not hold becomes a laboratory. When it holds on all of them, boards nobody has seen decide acceptance. */

  type Role = 'laboratory' | 'family' | 'confirmation' | 'exploration';
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
    const ob = new Observer<GridState>(w, { kinds: ['sense', 'code'], runners: [s.codeRunner()], senses: { ascii: (x) => se.render(x) },
      perceive: (_s, percepts) => readPicture(Object.values(percepts)[0]) });
    const ev = new Evaluator<GridState>(ob, judge, { maximizer: 'A', runners: [s.codeRunner()], cache: jevCache, inflight: jevInflight });
    return { id, index, spec: board, world: w, sense: se, observer: ob, evaluator: ev, role, seen: role === 'laboratory' || role === 'exploration', planner: plannerFor(w, board) };
  }
  const places = new Map<string, Place>([[base.id, base]]);
  for (let k = 1; k <= cfg.family; k++) places.set('place' + k, makePlace('place' + k, k, 'family'));
  /* Boards to explore (SPEC-INVESTIGACION-PARALELA §4, E1): from their own stretch of the family, never a board of validation
     or a blind one; the learner acts there and its model is never checked there. */
  const exploring = explorationIndices(cfg.explorePlaces, cfg.exploreOffset);
  const overlap = examOverlap(cfg.family, exploring);
  if (overlap) throw new Error('exploration boards: ' + overlap);
  for (const [k, index] of exploring.entries()) places.set('explore' + (k + 1), makePlace('explore' + (k + 1), index, 'exploration'));
  /** Evaluations, on every board, where a model's output read none of its rules (so the Judge was not asked). */
  const judgeUnread = (): number => [...places.values()].reduce((n, p) => n + p.evaluator.stats.judgeUnread, 0);
  const labs = (): Place[] => [...places.values()].filter((p) => p.role === 'laboratory');
  /** Where the learner may act and replay: its laboratories and its boards to explore. */
  const actable = (p: Place): boolean => p.role === 'laboratory' || p.role === 'exploration';
  const actableIds = (): string => [...places.values()].filter(actable).map((p) => p.id).join(', ');
  const whereToAct = (): string => (cfg.explorePlaces ? 'your laboratories and your places to explore: ' : 'your laboratories: ') + actableIds();

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

  /* --- The journal (the runner's): what the learner is never told, and what it is asked -------------------------- */

  Object.assign(s.journal.hidden_from_the_learner, { spec, generator: report, glyphs: { you: sense.glyphA, other: sense.glyphB }, orientation: sense.orientation,
    /* The hidden rules, where every laboratory keeps them (the operator's finding reads them). */
    truth: describeGridTruth(spec, sense),
    /* Its boards to explore: which of the family, and what they are (SPEC-INVESTIGACION-PARALELA E1). */
    ...(exploring.length ? { exploration: [...places.values()].filter((p) => p.role === 'exploration').map((p) => ({ id: p.id, index: p.index, spec: p.spec })) } : {}) });
  s.journal.objective = { answer: GRID_ANSWER.form, verdict: GRID_VERDICT };
  const log = s.log;
  const say = s.say;

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
  /* Its selective memory: the notebook abridged by a fixed rule, and the rest to ask for. What the Judge picked for it is the
     operator's (memory_select). */
  const memory = assisted?.memory ? new JournalMemory(notebook, { ...(assisted.selector ? { selector: assisted.selector } : {}),
    onSelect: (record) => log('memory_select', { round: currentRound, ...record }) }) : null;
  /* The records of earlier runs it may read (§12): answered by their reader, never by the world; each read counts as a step. */
  const experience = assisted?.experience?.reader ?? null;
  const recalls = (q: Record<string, unknown>): boolean => memory !== null && JournalMemory.accepts(q);
  /* Its team's board (§5.2): what it publishes and reads there is answered by the board, never by the world. */
  const peers = exchange ? team!.channel : null;
  const ownRequest = (q: Record<string, unknown>): boolean => recalls(q) || (experience !== null && Experience.accepts(q))
    || (peers !== null && (PeerChannel.acceptsRead(q) || PeerChannel.acceptsPublish(q)));
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
      log('exploration_game', { game: stored.id, winner: ep.outcome.winner, reason: ep.outcome.reason, plies: ep.states.length - 1,
        frames: ep.states.map((s, step) => ({ step, picture: sense.render(s) })) });
    }
    /* The same on each board to explore, each with its own seed. */
    for (const place of [...places.values()].filter((p) => p.role === 'exploration')) {
      for (let g = 0; g < cfg.explore; g++) {
        const rnd = mulberry32(cfg.seed * 1009 + place.index * 7919 + g);
        const pw = place.world;
        const opponent = noisyOpponent(pw, (s) => place.planner.respond(s), cfg.epsilon, rnd);
        const ep = await playEpisode(pw, (s, actor) => {
          if (actor === 'B') return opponent(s);
          const moves = pw.actions(s);
          return moves[Math.floor(rnd() * moves.length)];
        });
        const stored = store(0, 'the environment: your steps chosen at random', ep.states, ep.outcome.winner, undefined, place);
        log('exploration_game', { game: stored.id, place: place.id, winner: ep.outcome.winner, reason: ep.outcome.reason, plies: ep.states.length - 1,
          frames: ep.states.map((s, step) => ({ step, picture: place.sense.render(s) })) });
      }
    }
  }

  interface Measured extends AttemptScore<Formula> {
    readonly stored: StoredGame[];
    /** The episodes' plans and scores, in order (to run them again with another model). */
    readonly plans: Plan[];
    readonly scores: number[];
    /* Operator-only measurements (the truth watching): never shown to System 2. */
    readonly samples: ActionSample[];
    /** The same, per episode. */
    readonly samplesByEpisode: ActionSample[][];
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
    const samplesByEpisode: ActionSample[][] = [];
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
      const mine: ActionSample[] = [];
      samplesByEpisode.push(mine);
      const ep = await playEpisode(pw, async (s, actor) => {
        if (actor === 'B') return opponent(s);
        await yieldNow();
        const r = await searchBestMove<GridState, GridMove>(using, s, { formula, depth: cfg.depth, profile: PLAY_PV_ALPHA_BETA });
        const chosen = r.best.bestMove ?? pw.actions(s)[0];
        if (record) turns.set(s.ply, await recordTurn(using, pw, s, chosen, { formula, depth: cfg.depth, maximizer: 'A', turn: s.ply }));
        /* OPERATOR ONLY: the truth's view of the same step. */
        const winners = winningMoves(pw, s, 'A', (x) => place.planner.respond(x), 40000);
        if (!winners) { if (critical === null) knownThroughout = false; return chosen; }
        const keeps = winners.some((m) => pw.actionKey!(m) === pw.actionKey!(chosen));
        const sample = { winning: keeps, available: pw.actions(s).length, keeping: winners.length };
        samples.push(sample);
        mine.push(sample);
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
    return { formula, wins, total: results.length, perfect: wins === results.length, games: results, stored, plans: [...plans], scores, samples, samplesByEpisode, held, critical: criticals, variantWins };
  }

  /* OPERATOR ONLY: the same observations read linearly, no Judge, the same episodes. Never shown to System 2. */
  const ablations: AblationRecord[] = [];
  async function ablate(formula: Formula, attempt: number, score: Measured, place: Place): Promise<void> {
    const fit = fitCodeOnly(multiObserver, formula, (await probeSet()).filter((p) => !p.final));
    const plain = new Evaluator<GridState>(place.observer, codeOnlyJudge(fit), { maximizer: 'A', runners: [s.codeRunner()] });
    const ablated = await trial(codeOnlyFormula(formula), attempt, place, score.plans, { using: plain, tag: '  [code-only] ', record: false });
    const carrier = ablated.wins > score.wins ? 'the observations alone won MORE than the formula (' + ablated.wins + ' vs ' + score.wins + ')'
      : ablated.wins === score.wins ? (score.wins ? 'the observations carry it' : 'neither wins')
      : 'the rules of the Judge add ' + (score.wins - ablated.wins) + ' win(s)';
    ablations.push({ round: roundOf.get(formula) ?? currentRound, model: score.wins, withoutJudge: ablated.wins, better: 'higher' });
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
  /* The researcher's protocol (learn/protocol.ts) on the grid's objective (worlds/grid/objective.ts): what System 2 asked
     of each model, and the protocol that checks, validates and confirms it. */
  const asksToValidate = new WeakSet<Formula>();
  let confirmCounter = 0;
  const objective = gridObjective<Formula, Place, Plan[]>({
    /* A check draws --variants new starts besides the usual one; a validation or a confirmation --family-variants. */
    casesIn: (place, c) => plansFor(place, c.attempt, c.purpose === 'check' ? cfg.variants : cfg.familyVariants),
    async play(formula, place, plans, c) {
      const how = c.purpose === 'check' ? 'the check of round ' + c.round : c.purpose === 'validation' ? 'the validation of round ' + c.round : 'blind';
      const score = await trial(formula, c.attempt, place, plans, { record: c.record, how, ...(c.purpose === 'rerun' ? { tag: '  [run again] ' } : {}) });
      return { episodes: score.scores.map((sc, i) => ({ place: place.id, ...(score.stored[i] ? { episode: score.stored[i].id } : {}), score: sc,
        held: score.held[i], critical: score.critical[i], samples: score.samplesByEpisode[i] })), detail: score };
    }
  });
  /* A member of a team takes its blind boards from the team's ledger - none consulted twice in the team - and spends one of
     the team's blind confirmations each time its model holds on every board of the family (§5.4). Each under a key of its
     own history, so a resumed run is given what it was given. */
  let confirmations = 0;
  const protocol = new Protocol(objective, {
    places: () => [...places.values()],
    blindPlaces: (set) => team
      ? team.board.blindBoards(team.member, 'c' + confirmations + '.s' + set, cfg.confirmBoards).map((index) => makePlace('blind' + (++confirmCounter), index, 'confirmation'))
      : Array.from({ length: cfg.confirmBoards }, () => { const k = ++confirmCounter; return makePlace('blind' + k, FAMILY_INDEX.blind + k, 'confirmation'); }),
    ...(team ? { confirm: (c: { round: number }) => team.board.confirm(team.member, 'c' + (++confirmations), c.round) } : {}),
    fingerprint: (f) => formulaHash(f),
    validations: cfg.validations, pairedRegression: cfg.regression, quick: cfg.quick,
    cost: () => ({ jev_calls: judge.stats.calls, jev_not_asked: judgeUnread(), llm_calls: llmUse.calls, llm_tokens: llmUse.tokens }),
    say: (line) => say(line),
    roleWords: { laboratory: 'your laboratory: you can act and replay here', validated: 'a place where your model was validated',
      exploration: 'a place to explore: you can act and replay here; your model is never checked here' }
  });
  let unaddressed: string[] = [];

  type Labelled = LabelledPosition<GridState> & { readonly ref: string };

  async function probeSet(only?: string): Promise<Labelled[]> {
    const inPlay: Labelled[] = [], finals: Labelled[] = [];
    const seen = new Set<string>();
    for (const g of games.values()) {
      if (only !== undefined && g.place !== only) continue;
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
  /** A replay admitted: where it starts, with what, and the seed of everything the learner does not control. */
  interface ReplayJob { readonly from: string; readonly how: string; readonly formula: Formula; readonly start: GridState; readonly place: Place; readonly seed: number }
  interface Played { readonly states: GridState[]; readonly winner: string | null; readonly reason: string | null; readonly turns: Map<number, TurnRecord<GridState>>; readonly ms: number }

  /** A replay request checked and given its seed - in the order asked - or what it is answered when it is not played. */
  function admitReplay(req: Extract<ExplorerRequest, { replay: string }>, current: Formula | null, plays: { left: number }): ReplayJob | { result: unknown } {
    if (plays.left <= 0) return { result: { replay: req.replay, error: 'no replays left this round' } };
    const formula = req.formula === null ? current : typeof req.formula === 'number' ? formulaOfRound.get(req.formula) ?? null : req.formula;
    if (!formula) return { result: { replay: req.replay, error: req.formula === null ? 'you have no model yet: write a draft' : 'no model of round ' + req.formula } };
    if (typeof req.formula === 'object' && req.formula !== null) {
      const recent = [...games.values()].flatMap((g) => g.states).slice(-60);
      const observed = replayOnEvidence(multiObserver, formula.observations, recent.map((state) => ({ state }))).errors.slice(0, 4).map((e) => (e.observation ?? '') + ': ' + e.error);
      const failures = observed.length ? observed : outputFailures(formula, recent);
      if (failures.length) return { result: { replay: req.replay, error: 'your draft failed on points of your episodes: ' + failures.join(' | ') } };
    }
    plays.left--;
    const how = req.formula === null ? 'your_model' + (current && roundOf.has(current) ? ' (round ' + roundOf.get(current) + ')' : '')
      : typeof req.formula === 'number' ? 'your model of round ' + req.formula : 'a draft model';
    const from = req.replay;
    const start = resolve(from);
    if (!start) return { result: { replay: from, error: 'no such point' } };
    const place = where(start);
    if (!actable(place)) return { result: { replay: from, error: 'you can replay only in ' + whereToAct() } };
    if (place.world.outcome(start).over) return { result: { replay: from, error: 'that episode has already ended there' } };
    return { from, how, formula, start, place, seed: cfg.seed * 3571 + (++playCounter) * 131 + level * 1_000_003 };
  }

  /** The episode of a replay admitted (nothing is stored yet). */
  async function playJob(j: ReplayJob): Promise<Played> {
    const t0 = Date.now();
    const { place, start, formula } = j;
    const pw = place.world;
    const rnd = mulberry32(j.seed);
    const opponent = noisyOpponent(pw, (s) => place.planner.respond(s), cfg.epsilon, rnd);
    const turns = new Map<number, TurnRecord<GridState>>();
    const ep = await playEpisode(pw, async (s, actor) => {
      if (actor === 'B') return opponent(s);
      await yieldNow();
      const r = await searchBestMove<GridState, GridMove>(place.evaluator, s, { formula, depth: cfg.depth, profile: PLAY_PV_ALPHA_BETA });
      const chosen = r.best.bestMove ?? pw.actions(s)[0];
      const turn = s.ply - start.ply;
      turns.set(turn, await recordTurn(place.evaluator, pw, s, chosen, { formula, depth: cfg.depth, maximizer: 'A', turn }));
      return chosen;
    }, { start });
    return { states: ep.states, winner: ep.outcome.winner, reason: ep.outcome.reason, turns, ms: Date.now() - t0 };
  }

  /** A replay's episode stored (named now), logged, and answered. */
  function commitReplay(j: ReplayJob, p: Played): unknown {
    const g = store(currentRound, 'your replay: ' + j.how + ', from ' + j.from, p.states, p.winner, p.turns, j.place);
    log('played_by_the_learner', { round: currentRound, game: g.id, from: j.from, how: j.how, result: g.result, turns: p.states.length - 1, reason: p.reason,
      ...(roundOf.has(j.formula) ? {} : { draft: j.formula }) });
    intervened('replay', j.place, gameKey(g.id, hashString(j.place.index + '|' + world.key(j.start) + '|' + formulaHash(j.formula))));
    return { replay: j.from, with: j.how, episode: g.id, score: scoreOfResult(g.result), steps: p.states.length - 1 };
  }

  /* --- What the operator keeps of each intervention, to measure a team (SPEC-INVESTIGACION-PARALELA §6): the same experiment
     on the same board - an act from the same position, a replay from the same position with the same model - has the same
     key, whoever made it. Logged only in a team; never shown. */
  let stepInterventions: { kind: string; place: string; index: number; key: string }[] = [];
  const keyOfGame = new Map<string, string>();
  const keyOfAct = new Map<string, string>();
  const gameKey = (id: string, key: string): string => { keyOfGame.set(id, key); return key; };
  function intervened(kind: string, place: Place, key: string): void { if (team) stepInterventions.push({ kind, place: place.id, index: place.index, key }); }
  /* What the environment answered to each act and each investigation step, as it answered it: the records a publication carries. */
  const actAnswers = new Map<string, Record<string, unknown>>();
  const stepAnswers = new Map<string, { requests: unknown; results: unknown }>();
  const stepKeys = new Map<string, string[]>();

  async function runRequest(req: ExplorerRequest, current: Formula | null, plays: { left: number }): Promise<unknown> {
    /* Its own memory is answered by it, never by the world; its team's board by the board. */
    if ('extra' in req) return recalls(req.extra) ? memory!.run(req.extra) : experience && Experience.accepts(req.extra) ? experience.run(req.extra)
      : peers && PeerChannel.acceptsRead(req.extra) ? readPeers(req.extra) : peers && PeerChannel.acceptsPublish(req.extra) ? publish(req.extra.publish) : { error: 'no such instrument' };
    /* An instrument withheld by the experiment is refused, never run. */
    const kind = (['view', 'inspect', 'act', 'measure', 'replay', 'table'] as const).find((k) => k in req)!;
    if (!tools.has(kind)) return { [kind]: (req as Record<string, unknown>)[kind], error: '"' + kind + '" is not available in this experiment' };
    if ('replay' in req) {
      const j = admitReplay(req, current, plays);
      return 'result' in j ? j.result : commitReplay(j, await playJob(j));
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
      const decl: MeasureDecl = { spec: { kind: 'code', lang: 'js', source: req.table.source }, ...(req.table.range ? { range: req.table.range } : {}) };
      /* Narrowed to one place when it asks (SPEC-INVESTIGACION-PARALELA §4). */
      const only = cfg.explorePlaces ? req.place : undefined;
      if (only !== undefined && !places.get(only)?.seen) return { table: req.table.source, on: req.on, place: only, error: 'no such place of yours: ' + actableIds() };
      const rows = (await probeSet(only)).filter((p) => !!p.final === (req.on === 'final')).map((p) => {
        const o = multiObserver.observe(p.state, { ...SENSES, m: decl });
        const err = o.errors.find((e) => e.id === 'm');
        return { point: p.ref, episode_score: p.score, ...(err ? { error: err.error } : { value: o.values.m ?? o.texts.m }) };
      });
      return { table: req.table.source, on: req.on, ...(only !== undefined ? { place: only } : {}), rows };
    }
    if ('act' in req) {
      const s = resolve(req.act);
      if (!s) return { act: req.act, error: 'no such point' };
      const place = where(s);
      if (!actable(place)) return { act: req.act, error: 'you can act only in ' + whereToAct() };
      if (place.world.outcome(s).over || s.turn !== 'A') return { act: req.act, error: 'the next step there is not yours' };
      const from = place.sense.locate(req.from[0], req.from[1]), to = place.sense.locate(req.to[0], req.to[1]);
      const key = hashString(place.index + '|' + world.key(s) + '|' + JSON.stringify([req.from, req.to]));
      intervened('act', place, key);
      /* The environment answers only allowed or not: never why. */
      const move = from && to ? place.world.actions(s).find((m) => m.from[0] === from[0] && m.from[1] === from[1] && m.to[0] === to[0] && m.to[1] === to[1]) : undefined;
      if (!move) return { act: req.act, from: req.from, to: req.to, accepted: false };
      const after = place.world.step(s, move);
      placeOf.set(after, place);
      tries.push(after);
      /* What anyone who makes the move sees: whether the game ended there, and who won. Never why. */
      const outcome = place.world.outcome(after);
      const answer = { act: req.act, from: req.from, to: req.to, accepted: true, name: 'act' + tries.length, picture: picture(after),
        episode_ended: outcome.over ? { score: outcome.winner === 'A' ? 1 : outcome.winner === 'B' ? -1 : 0 } : false };
      actAnswers.set(answer.name, answer);
      keyOfAct.set(answer.name, key);
      return answer;
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

  /* --- One step of an investigation with places to explore (SPEC-INVESTIGACION-PARALELA §4) -----------------------------
     The step's requests are answered in the order asked, except its replays: each is admitted in its turn (checked, given
     its seed), then all are played - at once, or one after another with --place-concurrency serial - and their episodes are
     named in the order asked once every one has ended. Serial or concurrent, the episodes are the same; only the clock
     differs (step_clock, operator only). */
  async function runStep(requests: readonly ExplorerRequest[], current: Formula | null, plays: { left: number }): Promise<unknown[]> {
    const results: unknown[] = new Array(requests.length);
    const jobs: { at: number; job: ReplayJob }[] = [];
    const t0 = Date.now();
    for (const [at, r] of requests.entries()) {
      if ('replay' in r && tools.has('replay')) {
        const j = admitReplay(r, current, plays);
        if ('result' in j) results[at] = j.result; else jobs.push({ at, job: j });
      } else results[at] = await runRequest(r, current, plays);
    }
    const t1 = Date.now();
    const played: Played[] = [];
    if (cfg.concurrent) played.push(...await Promise.all(jobs.map(({ job }) => playJob(job))));
    else for (const { job } of jobs) played.push(await playJob(job));
    for (const [k, { at, job }] of jobs.entries()) results[at] = commitReplay(job, played[k]);
    if (jobs.length) log('step_clock', { round: currentRound, mode: cfg.concurrent ? 'concurrent' : 'serial', replays: jobs.map(({ job }, k) => ({ place: job.place.id, ms: played[k].ms })),
      replays_ms: Date.now() - t1, step_ms: Date.now() - t0 });
    return results;
  }

  /* --- Its team's board (SPEC-INVESTIGACION-PARALELA §5.2) ------------------------------------------------------------ */

  async function readPeers(q: Record<string, unknown>): Promise<unknown> {
    const answer = await peers!.run(q, currentRound) as Record<string, unknown>;
    log('peer_read', { round: currentRound, peers: q.peers, ...(answer.version !== undefined ? { version: answer.version } : {}),
      ...(q.items !== undefined || q.item !== undefined ? { items: Array.isArray(q.items) ? q.items.map(String) : [String(q.item)] } : {}),
      ...(typeof q.evidence === 'string' ? { evidence: q.evidence } : {}), ...(typeof q.words === 'string' ? { words: q.words } : {}),
      ...(Array.isArray(answer.entries) ? { shown: (answer.entries as { id: string }[]).map((e) => e.id) } : {}),
      ...(answer.error ? { error: answer.error } : {}) });
    return answer;
  }

  /** What a place is, as anyone who sees its pictures can tell: its size and its pieces, and whether every member of the
      team has this same board (the laboratory and the boards of validation) or it is this member's own. */
  const placeInfo = (p: Place): Record<string, unknown> => ({ place: p.id, board: p.spec.width + 'x' + p.spec.height, pieces: { yours: p.spec.A.count, other: p.spec.B.count },
    same_board_for_the_whole_team: p.index < FAMILY_INDEX.exploration });

  /** The record of the environment behind one of its references, as it answered it (and, for the operator, the keys of the
      interventions behind it); null when there is none. */
  function evidenceOf(ref: string): { record: Record<string, unknown>; place: Place | null; keys: string[] } | null {
    const r = ref.trim();
    const step = /^(?:investigation:)?r(\d+)\.(\d+)$/.exec(r);
    if (step) {
      const id = 'r' + step[1] + '.' + step[2];
      const s = stepAnswers.get(id);
      return s ? { record: { step: id, ...s }, place: null, keys: stepKeys.get(id) ?? [] } : null;
    }
    const act = /^(?:act|try)(\d+)$/.exec(r);
    if (act) {
      const name = 'act' + act[1];
      const a = actAnswers.get(name);
      const place = a ? where(tries[Number(act[1]) - 1]) : null;
      return a && place ? { record: { ...a, place: place.id }, place, keys: keyOfAct.has(name) ? [keyOfAct.get(name)!] : [] } : null;
    }
    const point = /^(g\d+)@(\d+)$/.exec(r);
    if (point) {
      const g = games.get(point[1]);
      const st = g?.states[Number(point[2])];
      return g && st ? { record: { point: r, place: g.place, episode: g.id, step: Number(point[2]), picture: picture(st) }, place: places.get(g.place) ?? null, keys: [] } : null;
    }
    const g = games.get(r);
    return g ? { record: { episode: g.id, place: g.place, chosen_by: g.how, score: scoreOfResult(g.result), steps: g.states.length - 1,
      frames: g.states.map((s, k) => ({ step: k, picture: picture(s) })) }, place: places.get(g.place) ?? null, keys: keyOfGame.has(g.id) ? [keyOfGame.get(g.id)!] : [] } : null;
  }

  /** A publication: checked, its evidence's records attached, put on the board under its number (the same number when a
      resumed run publishes it again: nothing is added). What it is answered is the same live or resumed. */
  function publish(raw: unknown): unknown {
    const p = parsePublication(raw);
    if (typeof p === 'string') return { publish: 'refused', error: p };
    const found = p.evidence.map((ref) => ({ ref, at: evidenceOf(ref) }));
    const missing = found.filter((x) => !x.at).map((x) => x.ref);
    if (missing.length) return { publish: 'refused', error: 'no record of yours behind ' + missing.join(', ') + ' (an episode "g<n>", a point "g<n>@<step>", an act "act<n>", an investigation step "r<round>.<step>")' };
    const board = peers!.board;
    const n = peers!.published + 1;
    const seenIn = [...new Map(found.flatMap((x) => (x.at!.place ? [[x.at!.place.id, x.at!.place] as const] : []))).values()];
    const { evidence: _refs, ...said } = p;
    const entry: BoardEntry = { id: team!.member + '#' + n, member: team!.member, n, round: currentRound, window: board.windowOf(currentRound), ...said,
      world: seenIn.map(placeInfo), evidence: found.map((x) => ({ ref: x.ref, record: x.at!.record })) };
    const put = board.publish(entry, { places: seenIn.map((pl) => ({ id: pl.id, index: pl.index })), keys: found.flatMap((x) => x.at!.keys) });
    peers!.published = n;
    log('peer_publish', { round: currentRound, id: entry.id, kind: entry.kind, claim: entry.claim, evidence: p.evidence, window: entry.window,
      ...(put.replayed ? { replayed: true } : {}), ...(put.conflict ? { conflict: put.conflict } : {}) });
    say('  publishes ' + entry.id + ' (' + entry.kind + ')' + (put.replayed ? ' [already on the board]' : '') + (put.conflict ? ' [CONFLICT: ' + put.conflict + ']' : ''));
    return { publish: 'published', id: entry.id, window: entry.window, readable_in_round: entry.window * board.spec.window + 1 };
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
  /* Set when the runner stops the run (cancelled, a budget spent): nothing further is asked. */
  let halted: string | null = null;

  async function propose(from: Formula | null, directive: string | null = null, mode: 'propose' | 'reflect' = 'propose'): Promise<Formula | null> {
    if (llmFatal || halted) return null;
    currentRound++;
    const round = currentRound;
    /* A member of a team tells the board where it is: the versions every member has passed are sealed. */
    team?.board.reach(team.member, round);
    let refused: string[] = [];
    const investigation: unknown[] = [];
    let steps = 0, refusals = 0, free = 0, overreach = 0, consolidated = 0;
    /* The round's conversation only grows (see RoundConversation): what changes from one answer to the next goes in the
       part added for that answer. */
    let talk = new RoundConversation();
    const counters = (): Record<string, unknown> => ({ ...(investigative ? { steps_left: Math.max(0, cfg.steps - (steps - free)) } : {}),
      ...(tools.has('replay') ? { replays_left: plays.left } : {}), ...(memory ? { memory_answers_left: FREE_MEMORY_ANSWERS - free, memory: memory.counts() } : {}) });
    let told: string[] = refused;
    let written: Record<string, unknown> = {};
    const plays = { left: cfg.plays };
    /* The round's context: the notebook as it is when the round begins (or when the researcher consolidates). */
    const context = (): Record<string, unknown> => ({ ...explorerPayload({ round, perceptDoc: GRID_PERCEPT_DOC, notebook: memory ? memory.brief(round, unaddressed) : notebook.brief(unaddressed),
      formula: from, formulaRound: from ? roundOf.get(from) ?? null : null, directive, task: mode === 'reflect' ? REFLECTION_TASK : null,
      places: protocol.placesView(), validationsLeft: protocol.validationsLeft, lastCheck: protocol.lastView }), ...counters() });
    while (refusals < 3 && steps - free - overreach - consolidated <= cfg.steps + 3) {
      const stop = s.halt();
      if (stop) {
        halted = stop;
        log('halted', { round, step: steps, reason: stop });
        say('stopping before asking System 2 again: ' + stop);
        return null;
      }
      const stepsLeft = investigative ? Math.max(0, cfg.steps - (steps - free)) : 0;
      /* A refusal of its previous answer is a part of its own (with any notes that answer wrote). */
      if (refused !== told && refused.length) { talk.add({ your_previous_answer_was_refused: refused, ...written, ...counters() }); written = {}; }
      told = refused;
      talk.open(context);
      const payload = talk.question();
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
      const turn = parseExplorerTurn(content, { world: world.id, senses: SENSES, round, ...(memory || experience || peers ? { extraRequest: ownRequest } : {}), ...(memory ? { archive: true } : {}) });
      const noteWarnings = [...notebook.applyNotes(round, turn.notes, (ref) => games.has(ref.trim()) || resolve(ref) !== null), ...notebook.applyMethods(round, turn.methods)];
      /* What it wrote in its notebook comes back in the next part of the conversation (the notebook shown is the round's). */
      written = { ...(turn.notes.length ? { your_notes: turn.notes } : {}), ...(turn.methods.length ? { your_methods: turn.methods } : {}) };
      if (turn.notes.length) say('  notes: ' + turn.notes.map((n) => n.do + ' ' + n.id).join(', '));
      if (turn.methods.length) {
        say('  methods: ' + turn.methods.map((m) => m.do + ' ' + m.id).join(', '));
        log('methods', { round, methods: turn.methods });
      }
      if (turn.kind === 'consolidate') {
        /* It consolidates its round's conversation: the context afresh (its notebook as it is now), then its own summary with
           the steps it keeps whole. Nothing is summarised for it; the steps it drops stay in the journal. */
        if (consolidated >= MAX_CONSOLIDATIONS) { refused = ['you may consolidate at most ' + MAX_CONSOLIDATIONS + ' times a round']; refusals++; continue; }
        consolidated++;
        const keep = [...new Set(turn.keep)].filter((k) => k >= 1 && k <= investigation.length).sort((x, y) => x - y);
        talk = new RoundConversation();
        talk.open(context);
        talk.add({ consolidated: { summary: turn.summary, kept_steps: keep.map((k) => investigation[k - 1]) }, ...written, ...counters() });
        written = {};
        told = refused = [];
        log('consolidated', { round, summary: turn.summary, kept: keep, dropped: investigation.length - keep.length, notes: turn.notes });
        say('  consolidates its round: keeps ' + keep.length + ' of ' + investigation.length + ' steps');
        continue;
      }
      if (turn.kind === 'investigate') {
        /* An answer of only memory requests asks nothing of the world: it is free, a few times a round. With no steps left,
           the memory requests of an answer are still answered (and the others not, said so) rather than all refused. */
        let requests = turn.requests;
        const warnings = [...turn.warnings];
        const recalled = requests.filter((r) => 'extra' in r && recalls(r.extra));
        let onlyMemory = memory !== null && requests.length > 0 && recalled.length === requests.length && free < FREE_MEMORY_ANSWERS;
        if (!onlyMemory && memory !== null && stepsLeft <= 0 && recalled.length && free < FREE_MEMORY_ANSWERS) {
          requests = recalled; onlyMemory = true;
          warnings.push('no investigation steps left this round: only your memory requests were answered');
        }
        if (onlyMemory) free++;
        else if (stepsLeft <= 0) {
          refused = [investigative ? 'no investigation steps left this round: answer with your proposal now' : 'there is no investigating in this experiment: answer with your proposal'];
          /* The assisted researcher may insist on investigating with no steps left a few times (a small model does) before
             it counts as a refusal - a round that ends without a proposal ends the run. Logged, so the journal says so. */
          if (assisted && investigative && overreach < OVERREACH) {
            overreach++;
            log('investigation_refused', { round, reason: 'no investigation steps left', reminders_left: OVERREACH - overreach, requests: requests.map((r) => ('extra' in r ? r.extra : r)) });
            say('  refused: no investigation steps left (reminder ' + overreach + ' of ' + OVERREACH + ')');
          } else {
            refusals++;
            say('  refused: ' + refused[0] + ' (refusal ' + refusals + ' of 3)');
          }
          continue;
        }
        stepInterventions = [];
        const results: unknown[] = [];
        if (cfg.explorePlaces) results.push(...await runStep(requests, from, plays));
        else for (const r of requests) results.push(await runRequest(r, from, plays));
        /* A draft travels back as it wrote it, never as the host's formula object. */
        const asWritten = requests.map((r) => 'replay' in r && r.formula !== null && typeof r.formula === 'object' ? { replay: r.replay, model: ownFormula(r.formula) } : 'extra' in r ? r.extra : r);
        const entry = { step: investigation.length + 1, requests: asWritten, results, ...(warnings.length || noteWarnings.length ? { warnings: [...warnings, ...noteWarnings] } : {}) };
        investigation.push(entry);
        /* What the environment answered at this step, as it answered it: a publication may cite it ("r<round>.<step>"). */
        stepAnswers.set('r' + round + '.' + entry.step, { requests: asWritten, results });
        if (team && stepInterventions.length) {
          stepKeys.set('r' + round + '.' + entry.step, stepInterventions.map((i) => i.key));
          log('operator_interventions', { round, step: entry.step, interventions: stepInterventions });
        }
        talk.add({ investigation_step: entry, ...written, ...counters() });
        written = {};
        memory?.recordInvestigation(round, entry.step, entry);
        /* What it was answered too, as in a world of laws: what an agent reviewing its work reads (SPEC-ORQUESTADOR §3.3). */
        log('investigation', { round, requests: requests.map((r) => ('extra' in r ? r.extra : r)), results, warnings: [...warnings, ...noteWarnings], notes: turn.notes, ...(onlyMemory ? { free: true } : {}) });
        say('  investigates: ' + requests.map((r, i) => 'extra' in r && PeerChannel.acceptsPublish(r.extra) ? 'publish ' + String((results[i] as { id?: string; error?: string }).id ?? (results[i] as { error?: string }).error)
          : 'extra' in r && PeerChannel.acceptsRead(r.extra) ? 'peers ' + String(r.extra.peers)
          : 'extra' in r ? (Experience.accepts(r.extra) ? 'experience ' + String(r.extra.experience) + (r.extra.run ? ' of ' + String(r.extra.run) : '') : 'memory ' + String(r.extra.memory)) + (r.extra.of ? ' of ' + String(r.extra.of) : '') + (r.extra.words ? ' "' + String(r.extra.words) + '"' : '') + (r.extra.select ? ' (select)' : '')
          : 'view' in r ? 'view ' + r.view : 'inspect' in r ? 'inspect ' + r.inspect
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
    s.journal.hidden_from_the_learner.ceiling = { informed_heuristic: ceiling, tightness: tightness(spec, cfg.levels[0]) };
    say('[operator] ceiling: a heuristic that knows the rules wins ' + ceiling.wins + '/' + ceiling.total + ' at depth ' + cfg.depth);
    if (ceiling.wins === 0) say('[operator] WARNING: not even an informed heuristic wins this game at this depth - pick a seed from calibrate-grid.ts');
  }
  await explore();
  const first = await propose(null);
  if (!first) {
    say('no usable first proposal');
    return { stoppedBy: llmFatal ? 'llm_error' : halted ?? 'no_first_proposal', halted, end: { ...(llmFatal ? { llm_error: llmFatal } : {}), notebook } };
  }

  /* --- The researcher's protocol (SPEC-MODELO-DEL-MUNDO §1.1, learn/protocol.ts): check in the laboratories every round;
     validate on boards not seen when System 2 asks; a board where the model does not hold becomes a laboratory; boards
     nobody has seen decide. */

  let candidate: Formula = first;
  let accepted: { formula: Formula; round: number | null } | null = null;
  let satisfied: Formula | null = null;
  let best: { formula: Formula; wins: number; total: number } | null = null;
  let stoppedBy = 'budget';
  let escalations = 0;
  const endings = s.endings ?? [];
  if (endings.length) s.journal.continuations = [...endings];
  for (let attempt = 1; attempt <= cfg.attempts && !llmFatal && !halted; attempt++) {
    /* Where the run's history had an ending (it used up its rounds and was given more): that ending, as it was - its
       reflection and its grading - then the rounds it was given since. */
    if (endings.includes(attempt - 1)) {
      if (cfg.reflection) { say('the ending of the run it continues (attempt ' + (attempt - 1) + '): its reflection'); await propose(best?.formula ?? null, null, 'reflect'); }
      if (llmFatal || halted) break;
      if (cfg.grade) await gradeRecovery();
      const to = endings.find((e) => e > attempt - 1) ?? cfg.attempts;
      log('budget_extended', { after_attempts: attempt - 1, to_attempts: to, round: currentRound });
      say('more rounds: ' + (attempt - 1) + ' → ' + to);
    }
    const round = roundOf.get(candidate) ?? currentRound;
    say('attempt ' + attempt + ' (round ' + round + ') against opponent level ' + cfg.levels[level] + (cfg.epsilon ? ' (errs ' + cfg.epsilon + ')' : '') + '; laboratories: ' + labs().map((l) => l.id).join(', '));
    const outcome = await protocol.round(candidate, { round, attempt, validate: asksToValidate.has(candidate) });
    const measured = outcome.laboratories.map((o) => o.detail as Measured);
    const reused = outcome.reused !== null;
    const stored = reused ? [] : measured.flatMap((m) => m.stored);
    const wins = measured.reduce((n, m) => n + m.wins, 0), total = measured.reduce((n, m) => n + m.total, 0);
    if (!reused) {
      lastScore = { ...measured[0], stored };
      notebook.recordGames(round, stored.map((g) => g.result));
      if (!best || wins / Math.max(1, total) > best.wins / Math.max(1, best.total)) best = { formula: candidate, wins, total };
    }
    log('check', { ...outcome.journal, level: cfg.levels[level],
      jev: { calls: judge.stats.calls, errors: judge.stats.errors, calls_per_game: Math.round((outcome.cost.jev_calls ?? 0) / Math.max(1, reused ? 1 : total) * 10) / 10,
        /* Evaluations where the model's output read none of its rules: the Judge was not asked (its rules are decorative). */
        ...(Object.keys(candidate.rules).length && candidate.output ? { not_asked_output_ignores_rules: outcome.cost.jev_not_asked ?? 0 } : {}) },
      abstraction: abstractionOf(candidate, stored),
      /* OPERATOR ONLY: analyses of the learner's data it is never handed (SPEC-MUNDO-FISICO I2). */
      operator_analysis: { surprises: latestSurprises(), record: scoreboard() } });
    /* The verdicts as it is given them, kept in its memory by the round of the model checked. */
    memory?.recordCheck(round, protocol.lastView);
    if (outcome.accepted) say('  ACCEPTED');
    if (cfg.ablation && !reused) await ablate(candidate, attempt, measured[0], outcome.laboratories[0].place);
    if (outcome.quickStop) {
      satisfied = candidate; stoppedBy = 'quick_stop';
      log('quick_stop', { round, held_in_laboratories: Object.fromEntries(outcome.laboratories.map((o) => [o.place.id, o.holds])), model: ownFormula(candidate) });
      say('  --quick: System 2 judges its model good in round ' + round + ' (in its laboratories: ' + (outcome.held ? 'holds' : 'does NOT hold') + '); stopping without validation');
      break;
    }
    if (outcome.accepted) {
      /* Accepted against this opponent: the next one plans further ahead, if the curriculum has one. */
      if (level < cfg.levels.length - 1) {
        level++;
        escalations++;
        for (const p of places.values()) p.planner = plannerFor(p.world, p.spec);
        evaluator.reset();
        protocol.restart();
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
    if (!next) {
      if (llmFatal || halted) break;
      /* The assisted researcher keeps its latest model when a round ends without a proposal (it did not change it): the next
         round checks it again. The unknown-world researcher's run ends there, as it always has. */
      if (assisted) { log('kept_model', { round: currentRound, attempt }); say('attempt ' + attempt + ': no usable proposal; the assisted researcher keeps its model'); continue; }
      say('attempt ' + attempt + ': System 2 gave no usable proposal'); stoppedBy = 'no_hypothesis'; break;
    }
    candidate = next;
  }
  const result = { accepted: accepted ? { formula: accepted.formula } : null, best, stoppedBy };

  if (cfg.reflection && !llmFatal && !halted) {
    say('reflection round: the formula is final; System 2 looks back');
    await propose(result.accepted?.formula ?? result.best?.formula ?? null, null, 'reflect');
  }
  if (cfg.grade && !llmFatal && !halted) await gradeRecovery();

  if (satisfied) say('the model System 2 judged good (round ' + (roundOf.get(satisfied) ?? '?') + '):\n' + JSON.stringify(ownFormula(satisfied), null, 2));
  say('best ' + (result.best ? result.best.wins + '/' + result.best.total : '-') + ', hypotheses ' + JSON.stringify(registry.summary()));
  const finalModel = accepted?.formula ?? satisfied ?? result.best?.formula ?? null;
  return {
    stoppedBy: llmFatal ? 'llm_error' : halted && !accepted ? halted : result.stoppedBy, halted,
    end: {
      ...(llmFatal ? { llm_error: llmFatal } : {}),
      escalations,
      /* The model the finding reports, in the learner's own words. */
      final: finalModel ? ownFormula(finalModel) : null,
      accepted: accepted ? { formula: accepted.formula, round: accepted.round } : null,
      ...(satisfied ? { quick_stop: { model: ownFormula(satisfied), round: roundOf.get(satisfied) ?? null } } : {}),
      places: [...places.values()].map((p) => ({ id: p.id, index: p.index, role: p.role, seen: p.seen, size: p.spec.width + 'x' + p.spec.height, pieces: p.spec.A.count + '/' + p.spec.B.count })),
      best: result.best ? { formula: result.best.formula, round: roundOf.get(result.best.formula) ?? null, wins: result.best.wins, total: result.best.total } : null,
      hypotheses: registry.all(), summary: registry.summary(), notebook,
      /* OPERATOR ONLY (SPEC-OBJETIVO O4): milestones and cost of the run. */
      operator_summary: operatorSummary(protocol.summary(), ablations),
      jev: { calls: judge.stats.calls, errors: judge.stats.errors }
    }
  };
}
