import test from 'node:test';
import assert from 'node:assert/strict';
import { Observer } from '../src/core/observer.ts';
import { JevJudge } from '../src/core/jev.ts';
import { makeFormula } from '../src/core/formula.ts';
import { createPlanner, solveAgainstModel } from '../src/core/truth.ts';
import { actionAccuracy, auc, classify, HypothesisRegistry, runProbes, winningMoves, type LabelledPosition } from '../src/learn/experiments.ts';
import { asciiSense, bFallback, createGridWorld, generateSpec, readPicture, type GridState } from '../src/worlds/grid/index.ts';
import { stubJev } from './stub-jev.ts';

const { spec } = generateSpec(4);
const world = createGridWorld(spec);
const sense = asciiSense(spec);
const observer = new Observer<GridState>(world, { kinds: ['sense', 'code'], senses: { ascii: (s) => sense.render(s) },
  perceive: (_s, p) => readPicture(Object.values(p)[0] ?? '') });
const base = makeFormula({ world: world.id, observations: { board: { spec: { kind: 'sense', sense: 'ascii' } } },
  rules: { r: { type: 'noul', used_as: 'value', instructions: 'Good?', criteria: { yes: 'y', no: 'n' } } }, weights: { r: 1 } });

/* Positions from a real game, labelled by construction (early = "win", late = "loss") to test the MECHANICS. */
function positions(): LabelledPosition<GridState>[] {
  const out: LabelledPosition<GridState>[] = [];
  let s = world.initial();
  for (let i = 0; i < 20 && !world.outcome(s).over; i++) {
    out.push({ state: s, label: 'win' });
    const moves = world.actions(s);
    s = moves.length ? world.step(s, moves[i % moves.length]) : world.pass!(s);
  }
  /* First half "won", second half "lost": whatever the game's length, both sides have samples. */
  return out.map((p, i) => ({ ...p, label: i < out.length / 2 ? 'win' : 'loss' }));
}

test('a hypothesis is classified by its AUC, against what chance gives with that many samples', () => {
  const hi = [0.9, 0.8, 0.85, 0.7, 0.95, 0.75, 0.8, 0.9], lo = [0.2, 0.3, 0.1, 0.4, 0.25, 0.15, 0.3, 0.2];
  assert.equal(auc(hi, lo), 1);
  assert.equal(classify(hi, lo).status, 'supported');
  assert.equal(classify(lo, hi).status, 'inverted');
  assert.equal(classify([0.5, 0.5, 0.5, 0.5, 0.5, 0.5], [0.52, 0.48, 0.5, 0.5, 0.51, 0.49]).status, 'unsupported');
  assert.equal(classify([0.9], [0.1, 0.2, 0.3]).status, 'inconclusive');
  /* A small but CONSISTENT difference is decisive (the old mean-difference threshold called it noise)... */
  const a = Array.from({ length: 20 }, (_, i) => 0.30 + i * 0.001), b = Array.from({ length: 20 }, (_, i) => 0.25 + i * 0.001);
  assert.equal(classify(a, b).status, 'supported');
  /* ...and the same AUC on two samples a side is not. */
  assert.equal(classify(a.slice(0, 2), b.slice(0, 2), { minSamples: 2 }).status, 'unsupported');
});

test('an observation probe costs nothing; a question probe asks the Judge and is cached per observed facts', async () => {
  const stub = stubJev();
  const ps = positions();
  const probes = [
    { id: 'clock', hypothesis: 'late positions are worse for me', observation: { spec: { kind: 'code' as const, lang: 'js', source: '(p) => p.move' }, range: [0, 12] as [number, number] } },
    { id: 'ask', hypothesis: 'the judge can tell', question: { type: 'noul' as const, instructions: 'Am I doing well?', criteria: { yes: 'y', no: 'n' } } }
  ];
  const results = await runProbes(probes, ps, { observer, judge: new JevJudge({ fetch: stub.fetch }), base, maximizer: 'A' }, { minSamples: 3, round: 1 });
  const clock = results.find((r) => r.id === 'clock')!;
  assert.equal(clock.tested_by, 'observation');
  assert.deepEqual(clock.tests.map((t) => t.by + ':' + t.positions), ['observation:in_play']);
  assert.equal(clock.status, 'inverted', 'the move counter is higher on the "lost" (late) positions');
  const ask = results.find((r) => r.id === 'ask')!;
  assert.equal(ask.tested_by, 'question');
  assert.ok(ask.samples_win + ask.samples_loss >= ps.length - 1);
  assert.ok(stub.bodies.length > 0 && stub.bodies.length <= ps.length);
  assert.ok(stub.bodies.every((b) => !b.state.perception && !b.state.rules_of_the_game), 'the Judge never perceives: it reads the observations');
  const registry = new HypothesisRegistry();
  registry.record(results);
  registry.record([{ ...clock, status: 'unsupported', round: 2 }]);
  assert.equal(registry.current().find((r) => r.id === 'clock')!.status, 'unsupported', 'the latest result per hypothesis');
  assert.equal(registry.all().length, 3);
  assert.equal(registry.summary().tested, 2);
});

test('the truth names the moves that keep a won position won, and action accuracy counts only real choices', () => {
  const planner = createPlanner(world, 'B', 2, { fallback: bFallback(spec) });
  const respond = (s: GridState) => planner.respond(s);
  const s0 = world.initial();
  assert.equal(solveAgainstModel(world, s0, 'A', respond).winner, 'A');
  const keep = winningMoves(world, s0, 'A', respond);
  assert.ok(keep && keep.length >= 1);
  for (const m of keep!) assert.equal(solveAgainstModel(world, world.step(s0, m), 'A', respond).winner, 'A');
  const acc = actionAccuracy([{ winning: true, available: 5, keeping: 2 }, { winning: false, available: 5, keeping: 1 }, { winning: true, available: 3, keeping: 3 }]);
  assert.deepEqual([acc.plies, acc.kept_the_win, acc.rate], [2, 1, 0.5]);
});

test('observation and question are reported separately, and finished positions test only the code', async () => {
  const stub = stubJev();
  const ps = positions();
  const finals = ps.slice(0, 6).map((p, i) => ({ ...p, final: true, label: (i < 3 ? 'win' : 'loss') as 'win' | 'loss' }));
  const probe = { id: 'both', hypothesis: 'late is bad',
    observation: { spec: { kind: 'code' as const, lang: 'js', source: '(p) => p.move' }, range: [0, 12] as [number, number] },
    question: { type: 'noul' as const, instructions: 'The clock reads {{probe_both}}. Early?', criteria: { yes: 'y', no: 'n' } } };
  const [r] = await runProbes([probe], [...ps, ...finals], { observer, judge: new JevJudge({ fetch: stub.fetch }), base, maximizer: 'A' }, { minSamples: 3 });
  assert.deepEqual(r.tests.map((t) => t.by + ':' + t.positions), ['observation:in_play', 'observation:final', 'question:in_play']);
  assert.equal(r.tests[0].status, 'inverted');
  assert.equal(r.tests[1].samples_win + r.tests[1].samples_loss, 6);
  assert.equal(r.tests[2].samples_win + r.tests[2].samples_loss, ps.length, 'the Judge is asked only about positions in play');
  assert.equal(r.status, 'inverted', 'the headline is the most decisive test');
  assert.ok(stub.bodies.every((b) => /The clock reads \d+/.test(b.questions.both.instructions)));
});

test('siblings: choices from one won position are ordered by the probe, pairs compared only within a position', async () => {
  const { siblingSets, siblingTest } = await import('../src/learn/experiments.ts');
  /* Pairs never cross positions: a set whose values are all higher does not help another set. */
  const t = siblingTest(Array.from({ length: 8 }, (_, i) => ({ keep: [i + 0.6], lose: [i + 0.4, i + 0.1] })));
  assert.deepEqual([t.auc, t.status, t.sets], [1, 'supported', 8]);
  assert.equal(siblingTest([{ keep: [0.9], lose: [0.1] }]).status, 'inconclusive', 'one position is not evidence');
  /* Seed 16: a tight game (in seed 4 no choice ever throws the win away, so it has no sibling sets). */
  const tight = generateSpec(16).spec;
  const world16 = createGridWorld(tight);
  const sense16 = asciiSense(tight);
  const observer16 = new Observer<GridState>(world16, { kinds: ['sense', 'code'], senses: { ascii: (x) => sense16.render(x) }, perceive: (_s, p) => readPicture(Object.values(p)[0] ?? '') });
  const planner = createPlanner(world16, 'B', 2, { fallback: bFallback(tight) });
  const respond = (s: GridState) => planner.respond(s);
  /* Positions from a few games where A moves at random: somewhere a choice keeps the win and another throws it. */
  const line: GridState[] = [];
  for (let g = 0; g < 6; g++) {
    let s = world16.initial();
    for (let i = 0; i < 12 && !world16.outcome(s).over; i++) {
      line.push(s);
      const moves = world16.actions(s);
      s = s.turn === 'A' ? world16.step(s, moves[(i * 7 + g * 3) % moves.length]) : world16.step(s, respond(s)!);
    }
  }
  const sets = siblingSets(world16, line, 'A', respond, { max: 4 });
  assert.ok(sets.length >= 1);
  for (const set of sets) {
    assert.ok(set.keep.length && set.lose.length);
    for (const k of set.keep) assert.equal(solveAgainstModel(world16, k, 'A', respond).winner, 'A');
    for (const l of set.lose) assert.notEqual(solveAgainstModel(world16, l, 'A', respond).winner, 'A');
  }
  const stub = stubJev();
  const [r] = await runProbes([{ id: 'clock', hypothesis: 'h', observation: { spec: { kind: 'code', lang: 'js', source: '(p) => p.move' }, range: [0, 40] } }],
    positions(), { observer: observer16, judge: new JevJudge({ fetch: stub.fetch }), base: { ...base, world: world16.id }, maximizer: 'A', siblings: sets }, { minSamples: 1 });
  const choice = r.tests.find((x) => x.positions === 'siblings')!;
  assert.equal(choice.sets, sets.length);
  assert.equal(choice.auc, 0.5, 'every choice from one position has the same move counter: it orders nothing');
});

test('positions are compared by the score their game ended with: a draw is neither a win nor a loss', async () => {
  const { classifyScored, concordance, describeTest } = await import('../src/learn/experiments.ts');
  /* The value is 1 exactly in lost games: with draws lumped as losses it would look like a weak signal. */
  const samples = [
    ...Array.from({ length: 8 }, () => ({ value: 0, score: 1 })),
    ...Array.from({ length: 8 }, () => ({ value: 0, score: 0 })),
    ...Array.from({ length: 8 }, () => ({ value: 1, score: -1 }))];
  assert.equal(concordance(samples), 1 / 6, 'lost vs the rest: always higher (0); won vs draw: ties (half) - 32 of 192 pairs');
  assert.equal(classifyScored(samples).status, 'inverted');
  assert.equal(classifyScored(samples, { minSamples: 9 }).status, 'inconclusive');
  const stub = stubJev();
  const ps = positions().slice(0, 12).map((p, i) => ({ ...p, final: true, score: [1, 0, -1][i % 3] }));
  const probe = { id: 'x', hypothesis: 'h', observation: { spec: { kind: 'code' as const, lang: 'js', source: '(p) => p.move' }, range: [0, 12] as [number, number] } };
  const [r] = await runProbes([probe], ps, { observer, judge: new JevJudge({ fetch: stub.fetch }), base, maximizer: 'A' }, { minSamples: 3 });
  const final = r.tests.find((t) => t.positions === 'final')!;
  assert.deepEqual(final.by_score!.map((g) => [g.score, g.positions]), [[1, 4], [0, 4], [-1, 4]]);
  const seen = describeTest(final) as any;
  assert.deepEqual(seen.by_game_score.map((g: any) => g.game_score), [1, 0, -1]);
  assert.ok(!('mean_in_won_games' in seen) && !/won|lost|draw/.test(JSON.stringify(seen)), 'only the score: its meaning is for the learner');
});
