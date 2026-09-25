import test from 'node:test';
import assert from 'node:assert/strict';
import { Observer } from '../src/core/observer.ts';
import { Evaluator } from '../src/core/evaluate.ts';
import { JevJudge, parseJevAnswers } from '../src/core/jev.ts';
import { searchBestMove, PLAY_PV_ALPHA_BETA, LEARNING_FANOUT } from '../src/core/search.ts';
import { makeFormula } from '../src/core/formula.ts';
import { foxhounds, moveKey, SIDE_CATS, SIDE_MOUSE, type FoxMove, type FoxState } from '../src/worlds/foxhounds/world.ts';
import { foxhoundsDialect } from '../src/worlds/foxhounds/dialect.ts';
import { createMouseModel, createOracle, HUMAN_MOUSE, solveAgainstModel } from '../src/worlds/foxhounds/model.ts';
import { formulaFromHarness } from '../src/worlds/foxhounds/import-harness.ts';
import { harnessNet, loadHarness, readJson, sampleStates } from './support.ts';
import { stubJev } from './stub-jev.ts';

/* P0b contract: the library's Judge, search, Mouse model and oracle reproduce the harness. Both sides
   receive the same deterministic Jev stub; they must choose the same move with the same value, judge the
   same number of leaves, and send Jev byte-identical requests (except the formula-hash label, whose
   format is the library's own). */

const journal = readJson('runs/2026-09-21-run-journal.json');
const accepted = formulaFromHarness(journal);
const plain = (value: unknown): any => JSON.parse(JSON.stringify(value));
const sample = sampleStates(60, 99);
const catsToMove = sample.filter((s) => s.turn === SIDE_CATS && !foxhounds.outcome(s).over);
const mouseToMove = sample.filter((s) => s.turn === SIDE_MOUSE && !foxhounds.outcome(s).over);

test('the Mouse model plays exactly the harness planner (greedy and depths 1-4)', () => {
  const h = loadHarness();
  for (const depth of [0, 1, 2, 3, 4]) {
    const model = createMouseModel(depth);
    for (const s of mouseToMove.slice(0, 120)) {
      assert.deepEqual(plain(model.respond(s)), plain(h.planMouseMove(s, depth)), 'depth ' + depth + ' at ' + foxhounds.key(s));
    }
  }
});

test('the oracle reaches the harness verdicts (winner, plies, reason, exhaustion)', () => {
  const h = loadHarness();
  for (const depth of [0, 2]) {
    const model = createMouseModel(depth);
    for (const s of sample.filter((_, i) => i % 7 === 0).slice(0, 60)) {
      const mine = solveAgainstModel(s, model, { budget: 20000 });
      const theirs = h.solveAgainstModel(s, depth, { budget: 20000 });
      assert.deepEqual([mine.winner, mine.plies, mine.reason, mine.exhausted], [theirs.winner, theirs.plies, theirs.reason, theirs.exhausted]);
    }
  }
  const oracle = createOracle(createMouseModel(1));
  const s = sample[20];
  assert.equal(oracle.verdict(s), oracle.verdict(s), 'verdicts are cached per (state, ply, model)');
});

test('Jev answers are read as the harness reads them, and a type mismatch fails the call', () => {
  const rules = accepted.rules;
  const parsed = parseJevAnswers({ answers: {
    cats_win_forecast: { type: 'choice', probabilities: { cats_win: '0.7', mouse_win: 0.3 }, confidence: 0.61 },
    mouse_containment: { type: 'choice', probabilities: { mouse_win: 1 }, confidence: 0.4 },
    cat_formation: { type: 'score', score: 3, confidence: 0.9 },
    extra: { type: 'noul', noul: 0.1 }
  } }, rules);
  assert.equal(parsed.answers.cats_win_forecast.value, 0.7);
  assert.ok(Number.isNaN(parsed.answers.mouse_containment.value), 'a missing probability is reported, never invented');
  assert.equal(parsed.answers.cat_formation.value, 0.75);
  assert.deepEqual(parsed.unusedIds, ['extra']);
  assert.throws(() => parseJevAnswers({ answers: { cat_formation: { type: 'choice', probabilities: {} } } }, rules), /declared as a score/);
});

function libraryStack(depth: number, stub: ReturnType<typeof stubJev>, human = false) {
  const model = createMouseModel(depth);
  const judge = new JevJudge({ fetch: stub.fetch, model: 'jev-latest' });
  const ev = new Evaluator<FoxState>(new Observer(foxhounds, { dialects: [foxhoundsDialect] }), judge, {
    maximizer: SIDE_CATS,
    context: () => human ? { id: 'human-adversarial', facts: { opponent: HUMAN_MOUSE } } : { id: model.id, facts: { opponent: model.describe() } }
  });
  return { model, judge, ev };
}

/* The DISTINCT requests: the harness pays some twice (identical leaves launched together in the fan-out,
   before the first answer fills its cache); the library coalesces in-flight requests. */
function distinctBodies(bodies: any[]): string[] {
  return [...new Set(bodies.map((b) => {
    const copy = plain(b);
    delete copy.state.judgment_formula_hash;
    return JSON.stringify(copy);
  }))].sort();
}

export const duplicateCalls = { harness: 0, library: 0, distinct: 0 };

for (const [label, human] of [['learning fan-out vs the planner', false], ['play PV alpha-beta vs a human (adversarial)', true]] as const) {
  test('search parity, ' + label + ': same move, value, line, leaves and Jev requests', async (t) => {
    const h = loadHarness();
    const depth = 3;
    h.config.depth = depth;
    const harnessRules = h.normalizeRules(h.rulesFromFormula(journal.accepted), {}).rules;
    const positions: FoxState[] = [foxhounds.initial({ mouseStartCol: 4 }), ...catsToMove.filter((_, i) => i % 9 === 3).slice(0, 4)];
    for (const s of positions) {
      h.resetCaches();
      h.setHumanMouse(human);
      const theirsStub = stubJev();
      harnessNet.fetch = theirsStub.fetch as any;
      const theirs = await h.searchBestMove(s, harnessRules, { depth, ...(human ? { opponentModel: 'adversarial' } : {}) });
      h.setHumanMouse(false);

      const mineStub = stubJev();
      const { model, ev } = libraryStack(depth, mineStub, human);
      const mine = await searchBestMove<FoxState, FoxMove>(ev, s, {
        formula: accepted, depth, ...(human ? {} : { respond: (st) => model.respond(st) })
      });
      const last = mine.passes[mine.passes.length - 1];
      assert.equal(mine.passes.length, depth);
      assert.equal(mine.best.value, theirs.result.value, 'V(s) at ' + foxhounds.key(s));
      assert.equal(moveKey(mine.best.bestMove!), h.moveKey(theirs.result.bestMove));
      assert.deepEqual(mine.best.line.map(moveKey), Array.from(theirs.result.line as FoxMove[], (m) => h.moveKey(m)));
      assert.equal(last.stats.leaves, theirs.ctx.leafEvals, 'leaves judged in the deepest pass');
      assert.equal(last.stats.nodes, theirs.ctx.nodes);
      assert.equal(last.stats.prunes, theirs.ctx.prunes);
      assert.deepEqual(distinctBodies(mineStub.bodies), distinctBodies(theirsStub.bodies), 'the same Jev questions, byte for byte');
      assert.equal(mineStub.bodies.length, distinctBodies(mineStub.bodies).length, 'the library never pays the same question twice');
      duplicateCalls.harness += theirsStub.bodies.length;
      duplicateCalls.library += mineStub.bodies.length;
      duplicateCalls.distinct += distinctBodies(theirsStub.bodies).length;
      assert.equal(mine.best.calibrated, theirs.result.calibrated);
    }
    t.diagnostic('Jev calls for the same searches: harness ' + duplicateCalls.harness + ', library ' + duplicateCalls.library +
      ' (distinct questions ' + duplicateCalls.distinct + ')');
    duplicateCalls.harness = duplicateCalls.library = duplicateCalls.distinct = 0;
  });
}

test('profiles: learning never prunes and fans the whole root out; play prunes against an adversary', async () => {
  const stub = stubJev();
  const { model, ev } = libraryStack(2, stub);
  const s = foxhounds.initial();
  const learning = await searchBestMove<FoxState, FoxMove>(ev, s, { formula: accepted, depth: 3, respond: (st) => model.respond(st) });
  const lastL = learning.passes[2].stats;
  assert.equal(lastL.prunes, 0);
  assert.equal(lastL.rootFanout, foxhounds.actions(s).length);
  const play = await searchBestMove<FoxState, FoxMove>(ev, s, { formula: accepted, depth: 3, profile: PLAY_PV_ALPHA_BETA });
  const exhaustive = await searchBestMove<FoxState, FoxMove>(ev, s, { formula: accepted, depth: 3, profile: LEARNING_FANOUT });
  assert.equal(play.best.value, exhaustive.best.value, 'alpha-beta is exact w.r.t. the frozen scalar');
  assert.ok(play.passes[2].stats.leaves < exhaustive.passes[2].stats.leaves, 'and cheaper');
});

test('a policy rule orders the search through the Judge and never removes a legal move', async () => {
  const stub = stubJev();
  const formula = makeFormula({
    ...accepted,
    rules: { ...accepted.rules, cat_plan: { type: 'choice', used_as: 'policy', subject: 'cats', instructions: 'Which Cat move keeps the line? {{cat_row_spread}}', criteria: {} } }
  });
  const { model, ev } = libraryStack(1, stub);
  const s = foxhounds.initial();
  const prior = await ev.prior(formula, s);
  assert.ok(prior && Object.keys(prior.prior).length === foxhounds.actions(s).length);
  const policyRequest = stub.bodies.find((b) => b.questions.cat_plan);
  assert.deepEqual(Object.keys(policyRequest.questions.cat_plan.criteria).sort(), foxhounds.actions(s).map(moveKey).sort());
  assert.equal(policyRequest.state.board_ascii, undefined, 'the Judge sees no position that no observation shows it');
  /* If the author wants the Judge to see the board, its own code composes it: a measure without a range is a text. */
  const drawn = makeFormula({ ...formula, observations: { ...formula.observations,
    board: { definition: 'the board as I draw it', spec: { kind: 'code', lang: 'js', source: '(ctx) => JSON.stringify(ctx.state.cats) + " " + JSON.stringify(ctx.state.mouse)' } } } });
  const before = stub.bodies.length;
  await ev.prior(drawn, s);
  const drawnRequest = stub.bodies.slice(before).find((b) => b.questions.cat_plan);
  assert.match(drawnRequest.state.observed_texts.board, /\[/, 'the text reaches the Judge as written');
  const result = await searchBestMove<FoxState, FoxMove>(ev, s, { formula, depth: 2, respond: (st) => model.respond(st) });
  assert.equal(result.passes[1].stats.rootFanout, foxhounds.actions(s).length);
  assert.ok(result.passes[0].stats.priorCalls >= 1);
  const mouseState = foxhounds.step(s, foxhounds.actions(s)[0]);
  assert.equal(await ev.prior(formula, mouseState), null, 'a Cats policy is not asked while the Mouse is to move');
});
