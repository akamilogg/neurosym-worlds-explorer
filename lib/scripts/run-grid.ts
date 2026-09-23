/* The unknown-world experiment: System 2 in a generated game it has never seen, perceiving only an ASCII picture.

     node --experimental-strip-types scripts/run-grid.ts --seed 16 [options]

   Endpoints and keys come from the environment (never from the command line, never written to the journal):
     JEV_URL (default https://api.typesafe.ai/v1/systemone), JEV_KEY
     LLM_URL (an OpenAI-compatible /chat/completions URL), LLM_KEY, LLM_MODEL
   Options:
     --seed N            the game (default 16: full board, forced win in 20, the flat control loses; see calibrate-grid.ts)
     --attempts N        proposal/trial rounds (default 8)
     --games N           trial games per attempt (default 4)
     --explore N         exploration games before the first proposal (default 4)
     --depth N           the learner's search depth (default 2)
     --levels a,b,c      the opponent's planner depths, the curriculum (default 2,4)
     --epsilon X         the opponent errs with this probability, seeded per game (default 0.15)
     --probe-positions N labelled positions a probe is measured on, at most (default 40)
     --no-ablation       skip the code-only ablation (same observations, no Judge; information only)
     --flat              CONTROL: a Judge that knows nothing (every answer neutral); the LLM is still consulted
     --out FILE          the journal (default runs/grid-s<seed>-<time>.json)

   The journal records the hidden spec for the operator; nothing of it is sent to System 2 or to Jev. */
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
import { EXPLORER_SYSTEM, explorerPayload, parseExplorerProposal, type ExplorerProposal } from '../src/learn/explorer.ts';
import { Notebook, type EpisodeRecord } from '../src/learn/notebook.ts';
import { codeOnlyFormula, codeOnlyJudge, fitCodeOnly } from '../src/learn/ablation.ts';
import { labelPositions, noisyOpponent, playEpisode } from '../src/learn/episodes.ts';
import { GRID_PERCEPT_DOC, asciiSense, bFallback, createGridWorld, generateSpec, mulberry32, readPicture,
  type GridMove, type GridState } from '../src/worlds/grid/index.ts';
import type { Formula, MeasureDecl } from '../src/core/types.ts';
import { ROOT } from '../test/support.ts';

/* --- Configuration ---------------------------------------------------------------- */

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
const flag = (name: string): boolean => argv.includes('--' + name);
const cfg = {
  seed: Number(arg('seed', '16')),
  attempts: Number(arg('attempts', '8')),
  games: Number(arg('games', '4')),
  explore: Number(arg('explore', '4')),
  depth: Number(arg('depth', '2')),
  levels: arg('levels', '2,4').split(',').map(Number),
  epsilon: Number(arg('epsilon', '0.15')),
  probePositions: Number(arg('probe-positions', '40')),
  flat: flag('flat'),
  ablation: !flag('no-ablation')
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
  : { url: env.JEV_URL || JEV_DEFAULT_URL, apiKey: env.JEV_KEY, model: env.JEV_MODEL, timeoutMs: 90000, retries: 2, concurrency: 8 });
const evaluator = new Evaluator<GridState>(observer, judge, { maximizer: 'A' });
const llm = openAiChatClient({ url: env.LLM_URL, apiKey: env.LLM_KEY, model: env.LLM_MODEL, jsonMode: true, temperature: 0.4, timeoutMs: 180000, retries: 1 });

let level = 0;
let planner = createPlanner(world, 'B', cfg.levels[level], { fallback: bFallback(spec) });
let truthMemo = new Map<string, { winner: string | null; plies: number; reason: string | null }>();

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

/* --- Playing ---------------------------------------------------------------------- */

const resultOf = (winner: string | null): EpisodeRecord['result'] => (winner === 'A' ? 'won' : winner === 'B' ? 'lost' : 'draw');
const pool: GridState[] = [];
const notebook = new Notebook();
/* Won positions the learner's own play rarely reaches: games where A picks at random AMONG the moves the truth says
   keep the win. They are measured by probes only - never shown to System 2 (that would be a demonstration). */
const bank: GridState[] = [];

async function fillBank(): Promise<void> {
  for (let g = 0; g < 10; g++) {
    const rnd = mulberry32(cfg.seed * 4001 + g + level * 97);
    /* A noisier opponent than in the trials: the bank needs varied endings (a forced line tends to end in one place). */
    const opponent = noisyOpponent(world, (s) => planner.respond(s), Math.max(cfg.epsilon, 0.5), rnd);
    const ep = await playEpisode(world, (s, actor) => {
      if (actor === 'B') return opponent(s);
      const moves = winningMoves(world, s, 'A', (x) => planner.respond(x), 40000);
      const pickFrom = moves && moves.length ? moves : world.actions(s);
      return pickFrom[Math.floor(rnd() * pickFrom.length)];
    });
    bank.push(...ep.states);
  }
  log('probe_bank', { level: cfg.levels[level], positions: bank.length });
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
    pool.push(...ep.states);
    notebook.addEpisodes([{ id: 'explore-' + g, round: 0, how: 'exploration: your side moved at random', result: resultOf(ep.outcome.winner),
      frames: ep.states.map((s) => sense.render(s)), critical: null, heldWinTurns: null, ownPlay: false }]);
    log('exploration_game', { game: g, winner: ep.outcome.winner, reason: ep.outcome.reason, plies: ep.states.length - 1 });
  }
}

interface Measured extends AttemptScore<Formula> {
  readonly episodes: EpisodeRecord[];
  readonly samples: ActionSample[];
  readonly held: (number | null)[];
}

/** One trial: the formula plays `cfg.games` games. The truth watches every one of A's turns: was the position won,
    and did the chosen move keep it? The first move that threw a win away is the game's critical moment. */
async function trial(formula: Formula, attempt: number, using: Evaluator<GridState> = evaluator, tag = '', record = true): Promise<Measured> {
  const games: TrialGame[] = [];
  const episodes: EpisodeRecord[] = [];
  const samples: ActionSample[] = [];
  const held: (number | null)[] = [];
  const round = roundOf.get(formula) ?? currentRound;
  for (let g = 0; g < cfg.games; g++) {
    const rnd = mulberry32(cfg.seed * 7717 + attempt * 101 + g * 7 + level * 1_000_003);
    const opponent = noisyOpponent(world, (s) => planner.respond(s), cfg.epsilon, rnd);
    const t0 = Date.now();
    let stillWinning = 0;
    let critical: number | null = null;
    let knownThroughout = true;
    const ep = await playEpisode(world, async (s, actor) => {
      if (actor === 'B') return opponent(s);
      const r = await searchBestMove<GridState, GridMove>(using, s, { formula, depth: cfg.depth, profile: PLAY_PV_ALPHA_BETA });
      const chosen = r.best.bestMove ?? world.actions(s)[0];
      const winners = winningMoves(world, s, 'A', (x) => planner.respond(x), 40000);
      if (!winners) { if (critical === null) knownThroughout = false; return chosen; }
      const keeps = winners.some((m) => world.actionKey!(m) === world.actionKey!(chosen));
      samples.push({ winning: keeps, available: world.actions(s).length, keeping: winners.length });
      if (critical === null && winners.length) {
        if (keeps) stillWinning++;
        else critical = s.ply;
      }
      return chosen;
    });
    const outcome = ep.outcome.winner === 'A' ? 'win' : ep.outcome.winner === 'B' ? 'loss' : 'draw';
    games.push({ outcome, plies: ep.states.length - 1 });
    const heldTurns = knownThroughout || critical !== null ? stillWinning : null;
    held.push(heldTurns);
    if (record) {
      pool.push(...ep.states);
      episodes.push({ id: 'r' + round + 'a' + attempt + 'g' + g, round, how: 'trial: your formula chose your moves (round ' + round + ')',
        result: resultOf(ep.outcome.winner), frames: ep.states.map((s) => sense.render(s)), critical, heldWinTurns: heldTurns, ownPlay: true });
    }
    say(tag + 'attempt ' + attempt + ' game ' + g + ': ' + (ep.outcome.winner ?? 'none') + ' by ' + ep.outcome.reason + ' after ' + (ep.states.length - 1) +
      ' turns, still winning for ' + (heldTurns ?? '?') + ' of your turns' + (critical !== null ? ' (thrown at turn ' + critical + ')' : '') +
      ' (' + Math.round((Date.now() - t0) / 1000) + ' s' + (record ? ', Jev calls ' + judge.stats.calls : '') + ')');
  }
  const wins = games.filter((g) => g.outcome === 'win').length;
  return { formula, wins, total: games.length, perfect: wins === games.length, games, episodes, samples, held };
}

/* Information, not a verdict: the same observations read linearly, no Judge, the same games. Never shown to System 2. */
async function ablate(formula: Formula, attempt: number, score: Measured): Promise<void> {
  const fit = fitCodeOnly(observer, formula, (await probeSet()).filter((p) => !p.final));
  const plain = new Evaluator<GridState>(observer, codeOnlyJudge(fit), { maximizer: 'A' });
  const ablated = await trial(codeOnlyFormula(formula), attempt, plain, '  [code-only] ', false);
  const carrier = ablated.wins > score.wins ? 'the observations alone won MORE than the formula (' + ablated.wins + ' vs ' + score.wins + ')'
    : ablated.wins === score.wins ? (score.wins ? 'the observations carry it' : 'neither wins')
    : 'the rules of the Judge add ' + (score.wins - ablated.wins) + ' win(s)';
  notebook.recordCodeOnly(roundOf.get(formula) ?? currentRound, ablated.wins, ablated.total);
  log('ablation_code_only', { attempt, level: cfg.levels[level], fit, formula_wins: score.wins, code_only_wins: ablated.wins, total: score.total,
    formula_held: score.held, code_only_held: ablated.held, code_only_action_accuracy: actionAccuracy(ablated.samples), reading: carrier });
  say('  ablation: formula ' + score.wins + '/' + score.total + ', observations alone ' + ablated.wins + '/' + ablated.total + ' -> ' + carrier);
}

/* --- Proposing and experimenting ---------------------------------------------------- */

const registry = new HypothesisRegistry();
let currentRound = 0;
const roundOf = new WeakMap<Formula, number>();
let lastScore: Measured | null = null;
let unaddressed: string[] = [];

async function probeSet(): Promise<LabelledPosition<GridState>[]> {
  if (!bank.length) await fillBank();
  const labelled = labelPositions(world, [...bank, ...pool], 'A', (s) => planner.respond(s), { budget: 40000, memo: truthMemo, includeFinal: true });
  /* Balanced and bounded: as many won as lost positions when it can be; finished positions are a separate, smaller set. */
  const take = <T>(xs: T[], n: number) => { const step = Math.max(1, xs.length / n); return Array.from({ length: Math.min(n, xs.length) }, (_, i) => xs[Math.floor(i * step)]); };
  const half = Math.floor(cfg.probePositions / 2);
  const pick = (final: boolean, n: number) => [
    ...take(labelled.filter((p) => !!p.final === final && p.label === 'win'), n),
    ...take(labelled.filter((p) => !!p.final === final && p.label === 'loss'), n)
  ];
  return [...pick(false, half), ...pick(true, Math.max(6, Math.floor(half / 2)))];
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

async function propose(from: Formula | null, directive: string | null = null): Promise<Formula | null> {
  currentRound++;
  const round = currentRound;
  let refused: string[] = [];
  for (let tryNo = 0; tryNo < 3; tryNo++) {
    const payload = explorerPayload({
      round, perceptDoc: GRID_PERCEPT_DOC, notebook: notebook.brief(unaddressed), experience: notebook.memory(),
      formula: from, formulaRound: from ? roundOf.get(from) ?? null : null,
      lastScore: lastScore ? { opponent_level: cfg.levels[level], wins: lastScore.wins, of: lastScore.total, results: lastScore.games.map((g) => g.outcome),
        turns_still_winning: lastScore.held } : null,
      hypotheses: registry.current(), actionAccuracy: lastScore ? actionAccuracy(lastScore.samples) : null, refused, directive
    });
    say('round ' + round + ': consulting System 2 (' + Math.round(JSON.stringify(payload).length / 1024) + ' KB)');
    let content = '';
    try {
      content = (await llm.complete({ system: EXPLORER_SYSTEM, user: payload })).content;
    } catch (error) {
      log('proposal_failed', { round, try: tryNo, error: String((error as Error)?.message || error) });
      continue;
    }
    const parsed = parseExplorerProposal(content, { world: world.id, senses: SENSES, round });
    if (!parsed.ok) {
      refused = parsed.errors;
      log('proposal_refused', { round, try: tryNo, errors: parsed.errors, content });
      say('  refused: ' + parsed.errors.slice(0, 3).join(' | '));
      continue;
    }
    /* Executability over the positions seen so far: every observation computes, and repeats itself. */
    const replay = replayOnEvidence(observer, parsed.proposal.formula.observations, pool.slice(-60).map((state) => ({ state })));
    const probeObs = Object.fromEntries(parsed.proposal.probes.filter((p) => p.observation).map((p) => ['probe_' + p.id, p.observation!]));
    const probeReplay = replayOnEvidence(observer, { ...SENSES, ...probeObs }, pool.slice(-20).map((state) => ({ state })));
    const failures = [...replay.errors, ...probeReplay.errors].slice(0, 8).map((e) => (e.observation ?? '') + ': ' + e.error);
    if (failures.length) {
      refused = ['an observation failed on positions you have seen: ' + failures.join(' | ')];
      log('proposal_refused', { round, try: tryNo, errors: refused, content });
      say('  refused: ' + refused[0].slice(0, 200));
      continue;
    }
    const proposal: ExplorerProposal = parsed.proposal;
    const stances = notebook.applyStances(round, proposal.beliefs);
    unaddressed = stances.unaddressed;
    notebook.recordRound(round, proposal.formula, proposal.lessons, proposal.nextExperiment);
    roundOf.set(proposal.formula, round);
    log('proposal', { round, try: tryNo, rationale: proposal.rationale, beliefs: proposal.beliefs, lessons: proposal.lessons,
      next_experiment: proposal.nextExperiment, evidence_ref: proposal.evidenceRef, stance_warnings: stances.warnings, no_stance_on: stances.unaddressed,
      formula: proposal.formula, probes: proposal.probes, warnings: proposal.warnings, variation: replay.variation });
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
    notebook.addEpisodes(score.episodes);
    const accuracy = actionAccuracy(score.samples);
    notebook.recordTrial(roundOf.get(candidate) ?? currentRound, { level: cfg.levels[level], wins: score.wins, total: score.total,
      results: score.games.map((g) => g.outcome), held_win_turns: score.held, action_accuracy: accuracy.rate });
    log('trial', { attempt, round: roundOf.get(candidate) ?? currentRound, level: cfg.levels[level], wins: score.wins, total: score.total, games: score.games,
      turns_still_winning: score.held, critical: score.episodes.map((e) => e.critical), action_accuracy: accuracy,
      jev: { calls: judge.stats.calls, errors: judge.stats.errors } });
    if (cfg.ablation) await ablate(candidate, attempt, score);
    return score;
  },
  verifyClean: async () => lastScore!,
  escalate: () => {
    if (level >= cfg.levels.length - 1) return false;
    level++;
    planner = createPlanner(world, 'B', cfg.levels[level], { fallback: bFallback(spec) });
    truthMemo = new Map();
    bank.length = 0;
    evaluator.reset();
    log('escalate', { level: cfg.levels[level] });
    say('won every game: the opponent now plans ' + cfg.levels[level] + ' turns ahead');
    return true;
  },
  lossEvidence: (score) => score as Measured,
  nextHypothesis: (from) => propose(from),
  onNoHypothesis: (attempt) => say('attempt ' + attempt + ': System 2 gave no usable proposal')
});

log('end', {
  stoppedBy: result.stoppedBy, attempts: result.attempts, escalations: result.escalations,
  accepted: result.accepted ? { formula: result.accepted.formula, wins: result.accepted.wins, total: result.accepted.total } : null,
  best: result.best ? { formula: result.best.formula, round: roundOf.get(result.best.formula) ?? null, wins: result.best.wins, total: result.best.total } : null,
  hypotheses: registry.all(), summary: registry.summary(), notebook,
  jev: { calls: judge.stats.calls, errors: judge.stats.errors }
});
say('done: ' + result.stoppedBy + ', best ' + (result.best ? result.best.wins + '/' + result.best.total : '-') + ', hypotheses ' + JSON.stringify(registry.summary()));
say('journal: ' + outFile);
