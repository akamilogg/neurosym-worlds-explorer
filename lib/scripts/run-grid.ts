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
     --plays N           games System 2 may play itself per round with the "play" request (default 4): its laboratory,
                         from any position of its games, with any of its formulas or a draft; never on the scoreboard
     --reveal-choices    inspect also shows every position the search considered (default: only the one it chose; the
                         learner finds out what else was possible by TRYING changes against the environment)
     --variants N        generalization: games from N starting positions never played, every trial (default 7; 0 = off).
                         Accepting a formula requires winning them too.
     --no-reflection     skip the final reflection round (beliefs, notes and lessons after the last trial; no formula)
     --no-ablation       skip the code-only ablation (same observations, no Judge; information only)
     --flat              CONTROL: a Judge that knows nothing (every answer neutral); the LLM is still consulted
     --out FILE          the journal (default runs/grid-s<seed>-<time>.json)

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
import { JevJudge, JEV_DEFAULT_URL } from '../src/core/jev.ts';
import { searchBestMove, PLAY_PV_ALPHA_BETA } from '../src/core/search.ts';
import { createPlanner } from '../src/core/truth.ts';
import { nodeVmRunner } from '../src/runtime/node-vm.ts';
import { openAiChatClient } from '../src/learn/system2.ts';
import { replayOnEvidence } from '../src/learn/gates.ts';
import { runAttempts, type AttemptScore, type TrialGame } from '../src/learn/loop.ts';
import { HypothesisRegistry, actionAccuracy, runProbes, winningMoves, type ActionSample, type LabelledPosition, type Probe } from '../src/learn/experiments.ts';
import { ceilingOf, tightness } from '../src/worlds/grid/informed.ts';
import { variantStarts } from '../src/worlds/grid/variants.ts';
import { EXPLORER_SYSTEM, explorerPayload, ownFormula, parseExplorerTurn, parseReflection, type ExplorerProposal, type ExplorerRequest } from '../src/learn/explorer.ts';
import { Notebook, type GameRecord } from '../src/learn/notebook.ts';
import { recordTurn, surprises, type TurnRecord } from '../src/learn/exploration.ts';
import { codeOnlyFormula, codeOnlyJudge, fitCodeOnly } from '../src/learn/ablation.ts';
import { noisyOpponent, playEpisode } from '../src/learn/episodes.ts';
import { GRID_PERCEPT_DOC, asciiSense, bFallback, createGridWorld, generateSpec, mulberry32, readPicture,
  type GridMove, type GridState } from '../src/worlds/grid/index.ts';
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
  steps: Number(arg('steps', '3')),
  plays: Number(arg('plays', '4')),
  revealChoices: flag('reveal-choices')
};
const env = process.env;
if (!env.LLM_URL || !env.LLM_MODEL) { console.error('LLM_URL and LLM_MODEL are required (and LLM_KEY if the endpoint needs one).'); process.exit(2); }
if (!cfg.flat && !env.JEV_KEY) { console.error('JEV_KEY is required (or run the --flat control).'); process.exit(2); }

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
const evaluator = new Evaluator<GridState>(observer, judge, { maximizer: 'A' });
const llm = openAiChatClient({ url: env.LLM_URL, apiKey: env.LLM_KEY, model: env.LLM_MODEL, jsonMode: true, temperature: 0.4, timeoutMs: 180000, retries: 1 });

let level = 0;
let planner = createPlanner(world, 'B', cfg.levels[level], { fallback: bFallback(spec) });
/* OPERATOR-CHOSEN starting positions never played before, new for every attempt (A can still force the win from each:
   the test must be fair); the learner only ever plays them. The formula and its ablation get the same ones. */
const variantCache = new Map<string, GridState[]>();
const variantsFor = (attempt: number): GridState[] => {
  const key = cfg.levels[level] + ':' + attempt;
  if (!variantCache.has(key)) variantCache.set(key, cfg.variants > 0 ? variantStarts(spec, { count: cfg.variants, level: cfg.levels[level], seed: cfg.seed * 1009 + attempt }) : []);
  return variantCache.get(key)!;
};

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
const valueOfResult = (r: GameRecord['result']): number => (r === 'won' ? 1 : r === 'lost' ? 0 : 0.5);

function store(round: number, how: string, states: GridState[], winner: string | null, turns = new Map<number, TurnRecord<GridState>>()): StoredGame {
  const g: StoredGame = { id: 'g' + (++gameCounter), round, how, result: resultOf(winner), states, turns };
  games.set(g.id, g);
  notebook.addGames([{ id: g.id, round, how, result: g.result, turns: states.length - 1 }]);
  return g;
}

/* Positions the learner reached by TRYING a change against the environment (never part of a game). */
const tries: GridState[] = [];

/** "g3@4" is the position at turn 4 of game g3; "g3@4/2" a position its search considered on that turn (only the one
    it chose, unless --reveal-choices); "try5" the result of the learner's fifth accepted try. */
function resolve(ref: string): GridState | null {
  const t = /^try(\d+)$/.exec(ref.trim());
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
    const opponent = noisyOpponent(world, (s) => planner.respond(s), cfg.epsilon, rnd);
    const ep = await playEpisode(world, (s, actor) => {
      if (actor === 'B') return opponent(s);
      const moves = world.actions(s);
      return moves[Math.floor(rnd() * moves.length)];
    });
    const stored = store(0, 'exploration: your side moved at random', ep.states, ep.outcome.winner);
    log('exploration_game', { game: stored.id, winner: ep.outcome.winner, reason: ep.outcome.reason, plies: ep.states.length - 1 });
  }
}

interface Measured extends AttemptScore<Formula> {
  readonly stored: StoredGame[];
  /* Operator-only measurements (the truth watching): never shown to System 2. */
  readonly samples: ActionSample[];
  readonly held: (number | null)[];
  readonly critical: (number | null)[];
  /** Wins from the starting positions it had never played (the generalization test). */
  readonly variantWins: number;
}

/** One trial: the formula plays `cfg.games` games. Its search's view of each of its turns is recorded for the learner;
    the truth watches too, for the operator only. */
async function trial(formula: Formula, attempt: number, using: Evaluator<GridState> = evaluator, tag = '', record = true): Promise<Measured> {
  const results: TrialGame[] = [];
  const stored: StoredGame[] = [];
  const samples: ActionSample[] = [];
  const held: (number | null)[] = [];
  const criticals: (number | null)[] = [];
  const round = roundOf.get(formula) ?? currentRound;
  /* The usual start, then (generalization) starting positions the learner has never played. */
  const plans: { start?: GridState; label: string }[] = [
    ...Array.from({ length: cfg.games }, (_, g) => ({ label: 'game ' + g })),
    ...variantsFor(attempt).map((start, v) => ({ start, label: 'new start ' + v }))
  ];
  for (const [g, plan] of plans.entries()) {
    const rnd = mulberry32(cfg.seed * 7717 + attempt * 101 + g * 7 + level * 1_000_003);
    const opponent = noisyOpponent(world, (s) => planner.respond(s), cfg.epsilon, rnd);
    const t0 = Date.now();
    const turns = new Map<number, TurnRecord<GridState>>();
    let stillWinning = 0, critical: number | null = null, knownThroughout = true;
    const ep = await playEpisode(world, async (s, actor) => {
      if (actor === 'B') return opponent(s);
      const r = await searchBestMove<GridState, GridMove>(using, s, { formula, depth: cfg.depth, profile: PLAY_PV_ALPHA_BETA });
      const chosen = r.best.bestMove ?? world.actions(s)[0];
      if (record) turns.set(s.ply, await recordTurn(using, world, s, chosen, { formula, depth: cfg.depth, maximizer: 'A', turn: s.ply }));
      /* OPERATOR ONLY: the truth's view of the same turn. */
      const winners = winningMoves(world, s, 'A', (x) => planner.respond(x), 40000);
      if (!winners) { if (critical === null) knownThroughout = false; return chosen; }
      const keeps = winners.some((m) => world.actionKey!(m) === world.actionKey!(chosen));
      samples.push({ winning: keeps, available: world.actions(s).length, keeping: winners.length });
      if (critical === null && winners.length) { if (keeps) stillWinning++; else critical = s.ply; }
      return chosen;
    }, plan.start ? { start: plan.start } : {});
    results.push({ outcome: ep.outcome.winner === 'A' ? 'win' : ep.outcome.winner === 'B' ? 'loss' : 'draw', plies: ep.states.length - 1 });
    held.push(knownThroughout || critical !== null ? stillWinning : null);
    criticals.push(critical);
    if (record) stored.push(store(round, 'your formula of round ' + round + (plan.start ? ', from a starting position you had not played' : ''), ep.states, ep.outcome.winner, turns));
    say(tag + 'attempt ' + attempt + ' ' + plan.label + ': ' + (ep.outcome.winner ?? 'none') + ' by ' + ep.outcome.reason + ' after ' + (ep.states.length - 1) +
      ' turns [operator: still winning for ' + (held[held.length - 1] ?? '?') + ' turns' + (critical !== null ? ', thrown at ' + critical : '') + ']' +
      ' (' + Math.round((Date.now() - t0) / 1000) + ' s' + (record ? ', Jev calls ' + judge.stats.calls : '') + ')');
  }
  const wins = results.filter((g) => g.outcome === 'win').length;
  const variantWins = results.slice(cfg.games).filter((g) => g.outcome === 'win').length;
  return { formula, wins, total: results.length, perfect: wins === results.length, games: results, stored, samples, held, critical: criticals, variantWins };
}

/* OPERATOR ONLY: the same observations read linearly, no Judge, the same games. Never shown to System 2. */
async function ablate(formula: Formula, attempt: number, score: Measured): Promise<void> {
  const fit = fitCodeOnly(observer, formula, (await probeSet()).filter((p) => !p.final));
  const plain = new Evaluator<GridState>(observer, codeOnlyJudge(fit), { maximizer: 'A' });
  const ablated = await trial(codeOnlyFormula(formula), attempt, plain, '  [code-only] ', false);
  const carrier = ablated.wins > score.wins ? 'the observations alone won MORE than the formula (' + ablated.wins + ' vs ' + score.wins + ')'
    : ablated.wins === score.wins ? (score.wins ? 'the observations carry it' : 'neither wins')
    : 'the rules of the Judge add ' + (score.wins - ablated.wins) + ' win(s)';
  log('operator_ablation_code_only', { attempt, level: cfg.levels[level], fit, formula_wins: score.wins, code_only_wins: ablated.wins, total: score.total,
    formula_held: score.held, code_only_held: ablated.held, code_only_action_accuracy: actionAccuracy(ablated.samples), reading: carrier });
  say('  [operator] ablation: formula ' + score.wins + '/' + score.total + ', observations alone ' + ablated.wins + '/' + ablated.total + ' -> ' + carrier);
}

/* --- Probes: labelled by how the learner's OWN games ended -------------------------------- */

const registry = new HypothesisRegistry();
let currentRound = 0;
const roundOf = new WeakMap<Formula, number>();
const formulaOfRound = new Map<number, Formula>();
let lastScore: Measured | null = null;
let unaddressed: string[] = [];

type Labelled = LabelledPosition<GridState> & { readonly ref: string };

async function probeSet(): Promise<Labelled[]> {
  const inPlay: Labelled[] = [], finals: Labelled[] = [];
  const seen = new Set<string>();
  for (const g of games.values()) {
    const label = g.result === 'won' ? 'win' : 'loss';
    for (const [turn, s] of g.states.entries()) {
      const over = world.outcome(s).over;
      if (!over && s.turn !== 'A') continue;
      const key = (over ? 'F' : 'P') + world.key(s) + label;
      if (seen.has(key)) continue;
      seen.add(key);
      (over ? finals : inPlay).push({ state: s, label, ref: g.id + '@' + turn, ...(over ? { final: true } : {}) });
    }
  }
  /* Balanced and bounded: as many positions from won as from lost games when it can be. */
  const take = <T>(xs: T[], n: number) => { const step = Math.max(1, xs.length / n); return Array.from({ length: Math.min(n, xs.length) }, (_, i) => xs[Math.floor(i * step)]); };
  const half = Math.floor(cfg.probePositions / 2);
  const pick = (xs: Labelled[], n: number) => [...take(xs.filter((p) => p.label === 'win'), n), ...take(xs.filter((p) => p.label === 'loss'), n)];
  return [...pick(inPlay, half), ...pick(finals, Math.max(6, Math.floor(half / 2)))];
}

async function experiment(probes: Probe[], base: Formula): Promise<void> {
  if (!probes.length) return;
  const positions = await probeSet();
  const results = await runProbes(probes, positions, { observer, judge, base, maximizer: 'A' }, { round: currentRound });
  registry.record(results);
  notebook.recordProbes(currentRound, results);
  const count = (final: boolean, label: string) => positions.filter((p) => !!p.final === final && p.label === label).length;
  log('probes', { round: currentRound, positions: { in_play: { win: count(false, 'win'), loss: count(false, 'loss') }, final: { win: count(true, 'win'), loss: count(true, 'loss') } }, results });
  for (const r of results) {
    say('  probe ' + r.id + ': ' + r.status + ' - ' + r.hypothesis);
    for (const t of r.tests) say('      ' + t.by + ' on ' + t.positions + ': ' + t.status + ' (auc ' + t.auc + ', ' + t.samples_win + '/' + t.samples_loss + ')');
  }
}

/* --- Investigation: System 2 queries its own experience ------------------------------ */

const picture = (s: GridState): string => sense.render(s);

/* Its own games, played on request: from a position of its games, with a formula it names or drafts. The opponent is
   the usual one, with a fresh seed each time, so a repeated experiment can end differently - as the real one would. */
let playCounter = 0;
async function play(from: string, formula: Formula, how: string): Promise<unknown> {
  const start = resolve(from);
  if (!start) return { play: from, error: 'no such position' };
  if (world.outcome(start).over) return { play: from, error: 'that game is already over there' };
  const rnd = mulberry32(cfg.seed * 3571 + (++playCounter) * 131 + level * 1_000_003);
  const opponent = noisyOpponent(world, (s) => planner.respond(s), cfg.epsilon, rnd);
  const turns = new Map<number, TurnRecord<GridState>>();
  const ep = await playEpisode(world, async (s, actor) => {
    if (actor === 'B') return opponent(s);
    const r = await searchBestMove<GridState, GridMove>(evaluator, s, { formula, depth: cfg.depth, profile: PLAY_PV_ALPHA_BETA });
    const chosen = r.best.bestMove ?? world.actions(s)[0];
    const turn = s.ply - start.ply;
    turns.set(turn, await recordTurn(evaluator, world, s, chosen, { formula, depth: cfg.depth, maximizer: 'A', turn }));
    return chosen;
  }, { start });
  const g = store(currentRound, 'you played it: ' + how + ', from ' + from, ep.states, ep.outcome.winner, turns);
  log('played_by_the_learner', { round: currentRound, game: g.id, from, how, result: g.result, turns: ep.states.length - 1, reason: ep.outcome.reason,
    ...(roundOf.has(formula) ? {} : { draft: formula }) });
  return { play: from, with: how, game: g.id, result: g.result, turns: ep.states.length - 1 };
}

async function runRequest(req: ExplorerRequest, base: Formula | null, plays: { left: number }): Promise<unknown> {
  if ('play' in req) {
    if (plays.left <= 0) return { play: req.play, error: 'no games left to play this round' };
    const formula = req.formula === null ? base : typeof req.formula === 'number' ? formulaOfRound.get(req.formula) ?? null : req.formula;
    if (!formula) return { play: req.play, error: req.formula === null ? 'you have no formula yet: write a draft' : 'no formula of round ' + req.formula };
    if (typeof req.formula === 'object' && req.formula !== null) {
      const recent = [...games.values()].flatMap((g) => g.states).slice(-60);
      const failures = replayOnEvidence(observer, formula.observations, recent.map((state) => ({ state }))).errors.slice(0, 4).map((e) => (e.observation ?? '') + ': ' + e.error);
      if (failures.length) return { play: req.play, error: 'an observation of your draft failed on positions of your games: ' + failures.join(' | ') };
    }
    plays.left--;
    const how = req.formula === null ? 'your best formula' + (base && roundOf.has(base) ? ' (round ' + roundOf.get(base) + ')' : '')
      : typeof req.formula === 'number' ? 'your formula of round ' + req.formula : 'a draft formula';
    return play(req.play, formula, how);
  }
  if ('view' in req) {
    const g = games.get(req.view);
    if (!g) return { view: req.view, error: 'no such game' };
    const frames = g.states.map((s, turn) => ({ turn, picture: picture(s) })).slice(Math.max(0, req.from), Math.max(0, req.to) + 1);
    return { view: g.id, result: g.result, turns: g.states.length - 1, frames };
  }
  if ('inspect' in req) {
    const m = /^(g\d+)@(\d+)$/.exec(req.inspect.trim());
    const g = m ? games.get(m[1]) : undefined;
    if (!m || !g) return { inspect: req.inspect, error: 'use "<game>@<turn>" with a game from your notebook' };
    const t = g.turns.get(Number(m[2]));
    if (!t) return { inspect: req.inspect, error: g.turns.size ? 'your search did not choose on that turn (it is not one of your turns); your turns here: ' + [...g.turns.keys()].join(', ') : 'in this game your side moved at random: nothing was searched' };
    const describe = (c: TurnRecord<GridState>['choices'][number], k: number) => ({ name: req.inspect + '/' + k, picture: picture(c.state),
      value_looking_ahead: c.lookahead, value_directly: c.direct,
      finished_games_your_search_ran_into: { you_won: c.endingsWon, the_other_side_won: c.endingsLost } });
    const k = t.choices.findIndex((c) => c.chosen);
    return {
      inspect: req.inspect, position: picture(t.state), your_search_value: t.value,
      chose: k >= 0 ? describe(t.choices[k], k) : null,
      /* Only with --reveal-choices: otherwise the learner finds out what was possible by trying. */
      ...(cfg.revealChoices ? { also_considered: t.choices.map((c, j) => ({ c, j })).filter(({ c }) => !c.chosen).map(({ c, j }) => describe(c, j)) } : {})
    };
  }
  if ('table' in req) {
    /* The rows behind the probe facts: each position probes use, the code's value, and how that game ended. */
    const decl: MeasureDecl = { spec: { kind: 'code', lang: 'js', source: req.table.source }, range: req.table.range };
    const rows = (await probeSet()).filter((p) => !!p.final === (req.on === 'final')).map((p) => {
      const o = observer.observe(p.state, { ...SENSES, m: decl });
      const err = o.errors.find((e) => e.id === 'm');
      return { position: p.ref, game_result: p.label === 'win' ? 'won' : 'not won', ...(err ? { error: err.error } : { value: o.values.m }) };
    });
    return { table: req.table.source, on: req.on, rows };
  }
  if ('try' in req) {
    const s = resolve(req.try);
    if (!s) return { try: req.try, error: 'no such position' };
    if (world.outcome(s).over || s.turn !== 'A') return { try: req.try, error: 'it is not your turn in that position' };
    const from = sense.locate(req.from[0], req.from[1]), to = sense.locate(req.to[0], req.to[1]);
    /* The environment answers only allowed or not: never why. */
    const move = from && to ? world.actions(s).find((m) => m.from[0] === from[0] && m.from[1] === from[1] && m.to[0] === to[0] && m.to[1] === to[1]) : undefined;
    if (!move) return { try: req.try, from: req.from, to: req.to, allowed: false };
    const after = world.step(s, move);
    tries.push(after);
    /* What anyone who makes the move sees: whether the game ended there, and who won. Never why. */
    const outcome = world.outcome(after);
    return { try: req.try, from: req.from, to: req.to, allowed: true, name: 'try' + tries.length, picture: picture(after),
      game_ended: outcome.over ? (outcome.winner === 'A' ? 'you won' : outcome.winner === 'B' ? 'you lost' : 'draw') : false };
  }
  const decl: MeasureDecl = { spec: { kind: 'code', lang: 'js', source: req.measure.source }, range: req.measure.range };
  return {
    measure: req.measure.source, values: req.on.map((ref) => {
      const s = resolve(ref);
      if (!s) return { position: ref, error: 'no such position' };
      const o = observer.observe(s, { ...SENSES, m: decl });
      const err = o.errors.find((e) => e.id === 'm');
      return err ? { position: ref, error: err.error } : { position: ref, value: o.values.m };
    })
  };
}

/** How each of its formulas did (facts of its own games), with the best and the latest named. */
function scoreboard(): unknown {
  const rows = notebook.rounds.filter((r) => r.games.length).map((r) => ({ round: r.round, fingerprint: r.fingerprint,
    wins: r.games.reduce((a, g) => a + g.wins, 0), of: r.games.reduce((a, g) => a + g.of, 0) }));
  if (!rows.length) return null;
  const best = rows.reduce((a, b) => (b.wins / b.of > a.wins / a.of ? b : a));
  return { by_round: rows, best: best, latest: rows[rows.length - 1] };
}

function latestSurprises(): unknown {
  const latest = lastScore?.stored ?? [];
  return latest.map((g) => ({ game: g.id, result: g.result, where_your_search_was_most_wrong: surprises([...g.turns.values()], valueOfResult(g.result)) }));
}

const REFLECTION_TASK = 'REFLECTION ROUND. Your formula is final: do not propose one. Look back at your games (you may investigate first) and '
  + 'answer with {"rationale": ..., "beliefs": [stances on every belief you hold, and any new ones], "notes": [...], "lessons": [...], "next_experiment": ...}: '
  + 'what you now believe about this environment - how it works, how each side wins, and why your formula won or lost - citing your evidence.';

async function propose(from: Formula | null, directive: string | null = null, mode: 'propose' | 'reflect' = 'propose'): Promise<Formula | null> {
  currentRound++;
  const round = currentRound;
  let refused: string[] = [];
  const investigation: unknown[] = [];
  let steps = 0, refusals = 0;
  const plays = { left: cfg.plays };
  while (refusals < 3 && steps <= cfg.steps + 3) {
    const stepsLeft = Math.max(0, cfg.steps - steps);
    const payload = explorerPayload({
      round, perceptDoc: GRID_PERCEPT_DOC, notebook: notebook.brief(unaddressed), surprises: latestSurprises(), scoreboard: scoreboard(),
      formula: from, formulaRound: from ? roundOf.get(from) ?? null : null,
      hypotheses: registry.current(), investigation, stepsLeft, playsLeft: plays.left, refused, directive, task: mode === 'reflect' ? REFLECTION_TASK : null
    });
    say('round ' + round + (steps ? ' step ' + steps : '') + ': consulting System 2 (' + Math.round(JSON.stringify(payload).length / 1024) + ' KB)');
    steps++;
    let content = '';
    try {
      content = (await llm.complete({ system: EXPLORER_SYSTEM, user: payload })).content;
    } catch (error) {
      refusals++;
      log('proposal_failed', { round, error: String((error as Error)?.message || error) });
      continue;
    }
    const turn = parseExplorerTurn(content, { world: world.id, senses: SENSES, round });
    const noteWarnings = notebook.applyNotes(round, turn.notes, (ref) => resolve(ref) !== null);
    if (turn.notes.length) say('  notes: ' + turn.notes.map((n) => n.do + ' ' + n.id).join(', '));
    if (turn.kind === 'investigate') {
      if (stepsLeft <= 0) { refused = ['no investigation steps left this round: answer with your proposal now']; refusals++; continue; }
      const results: unknown[] = [];
      for (const r of turn.requests) results.push(await runRequest(r, from, plays));
      /* A draft travels back as it wrote it, never as the host's formula object. */
      const asWritten = turn.requests.map((r) => 'play' in r && r.formula !== null && typeof r.formula === 'object' ? { play: r.play, formula: ownFormula(r.formula) } : r);
      investigation.push({ step: investigation.length + 1, requests: asWritten, results, ...(turn.warnings.length || noteWarnings.length ? { warnings: [...turn.warnings, ...noteWarnings] } : {}) });
      log('investigation', { round, requests: turn.requests, warnings: [...turn.warnings, ...noteWarnings], notes: turn.notes });
      say('  investigates: ' + turn.requests.map((r, i) => 'view' in r ? 'view ' + r.view : 'inspect' in r ? 'inspect ' + r.inspect
        : 'try' in r ? 'try ' + r.try + ' ' + JSON.stringify(r.from) + '>' + JSON.stringify(r.to) + ((results[i] as { allowed?: boolean }).allowed ? ' allowed' : ' refused')
        : 'play' in r ? 'play from ' + r.play + ' -> ' + ((results[i] as { result?: string; error?: string }).result ?? (results[i] as { error?: string }).error)
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
    const replay = replayOnEvidence(observer, parsed.proposal.formula.observations, recent.map((state) => ({ state })));
    const probeObs = Object.fromEntries(parsed.proposal.probes.filter((p) => p.observation).map((p) => ['probe_' + p.id, p.observation!]));
    const probeReplay = replayOnEvidence(observer, { ...SENSES, ...probeObs }, recent.slice(-20).map((state) => ({ state })));
    const failures = [...replay.errors, ...probeReplay.errors].slice(0, 8).map((e) => (e.observation ?? '') + ': ' + e.error);
    if (failures.length) {
      refused = ['an observation failed on positions of your games: ' + failures.join(' | ')]; refusals++;
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
    log('proposal', { round, investigation_steps: investigation.length, rationale: proposal.rationale, beliefs: proposal.beliefs, notes: turn.notes,
      lessons: proposal.lessons, next_experiment: proposal.nextExperiment, stance_warnings: stances.warnings, note_warnings: noteWarnings,
      no_stance_on: stances.unaddressed, formula: proposal.formula, probes: proposal.probes, warnings: proposal.warnings, variation: replay.variation });
    say('  proposal: ' + Object.keys(proposal.formula.observations).length + ' observations, ' + Object.keys(proposal.formula.rules).length +
      ' rules, ' + proposal.probes.length + ' probes; beliefs ' + proposal.beliefs.map((b) => b.id + ':' + b.stance).join(' ') +
      (stances.unaddressed.length ? '; NO STANCE on ' + stances.unaddressed.join(', ') : ''));
    for (const l of proposal.lessons) say('  lesson: ' + l);
    await experiment(proposal.probes, proposal.formula);
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
if (!first) { log('end', { stoppedBy: 'no_first_proposal', notebook }); say('no usable first proposal'); process.exit(1); }

const result = await runAttempts<Formula, Measured, never>(first, {
  budget: cfg.attempts,
  isRunning: () => true,
  onAttemptStart: (attempt) => say('attempt ' + attempt + ' against opponent level ' + cfg.levels[level] + (cfg.epsilon ? ' (errs ' + cfg.epsilon + ')' : '')),
  measure: async (candidate, attempt) => {
    const score = await trial(candidate, attempt);
    lastScore = score;
    const round = roundOf.get(candidate) ?? currentRound;
    notebook.recordGames(round, score.stored.map((g) => g.result));
    log('trial', { attempt, round, level: cfg.levels[level], wins: score.wins, total: score.total, usual_start_wins: score.wins - score.variantWins, new_start_wins: score.variantWins, new_starts: variantsFor(attempt).length, games: score.stored.map((g) => ({ id: g.id, result: g.result, turns: g.states.length - 1 })),
      operator: { turns_still_winning: score.held, critical: score.critical, action_accuracy: actionAccuracy(score.samples) },
      jev: { calls: judge.stats.calls, errors: judge.stats.errors } });
    if (cfg.ablation) await ablate(candidate, attempt, score);
    return score;
  },
  verifyClean: async () => lastScore!,
  escalate: () => {
    if (level >= cfg.levels.length - 1) return false;
    level++;
    planner = createPlanner(world, 'B', cfg.levels[level], { fallback: bFallback(spec) });
    evaluator.reset();
    log('escalate', { level: cfg.levels[level] });
    say('won every game: the opponent now plans ' + cfg.levels[level] + ' turns ahead');
    return true;
  },
  lossEvidence: (score) => score as Measured,
  nextHypothesis: (from) => propose(from),
  onNoHypothesis: (attempt) => say('attempt ' + attempt + ': System 2 gave no usable proposal')
});

if (cfg.reflection) {
  say('reflection round: the formula is final; System 2 looks back');
  await propose(result.accepted?.formula ?? result.best?.formula ?? null, null, 'reflect');
}

log('end', {
  stoppedBy: result.stoppedBy, attempts: result.attempts, escalations: result.escalations,
  accepted: result.accepted ? { formula: result.accepted.formula, wins: result.accepted.wins, total: result.accepted.total } : null,
  best: result.best ? { formula: result.best.formula, round: roundOf.get(result.best.formula) ?? null, wins: result.best.wins, total: result.best.total } : null,
  hypotheses: registry.all(), summary: registry.summary(), notebook,
  jev: { calls: judge.stats.calls, errors: judge.stats.errors }
});
say('done: ' + result.stoppedBy + ', best ' + (result.best ? result.best.wins + '/' + result.best.total : '-') + ', hypotheses ' + JSON.stringify(registry.summary()));
say('journal: ' + outFile);
