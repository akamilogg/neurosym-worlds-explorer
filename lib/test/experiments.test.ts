import test from 'node:test';
import assert from 'node:assert/strict';
import { Observer } from '../src/core/observer.ts';
import { JevJudge } from '../src/core/jev.ts';
import { makeFormula } from '../src/core/formula.ts';
import { createPlanner, solveAgainstModel } from '../src/core/truth.ts';
import { actionAccuracy, classify, HypothesisRegistry, runProbes, winningMoves, type LabelledPosition } from '../src/learn/experiments.ts';
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

test('a hypothesis is classified by how it separates won from lost positions', () => {
  assert.equal(classify([0.9, 0.8, 0.85], [0.2, 0.3, 0.1], 0.15, 3).status, 'supported');
  assert.equal(classify([0.1, 0.2, 0.1], [0.8, 0.9, 0.7], 0.15, 3).status, 'inverted');
  assert.equal(classify([0.5, 0.5, 0.5], [0.52, 0.48, 0.5], 0.15, 3).status, 'unsupported');
  assert.equal(classify([0.9], [0.1, 0.2, 0.3], 0.15, 3).status, 'inconclusive');
});

test('an observation probe costs nothing; a question probe asks the Judge and is cached per picture', async () => {
  const stub = stubJev();
  const ps = positions();
  const probes = [
    { id: 'clock', hypothesis: 'late positions are worse for me', observation: { spec: { kind: 'code' as const, lang: 'js', source: '(p) => p.move' }, range: [0, 12] as [number, number] } },
    { id: 'ask', hypothesis: 'the judge can tell', question: { type: 'noul' as const, instructions: 'Am I doing well?', criteria: { yes: 'y', no: 'n' } } }
  ];
  const results = await runProbes(probes, ps, { observer, judge: new JevJudge({ fetch: stub.fetch }), base, maximizer: 'A' }, { minSamples: 3, round: 1 });
  const clock = results.find((r) => r.id === 'clock')!;
  assert.equal(clock.tested_by, 'observation');
  assert.equal(clock.status, 'inverted', 'the move counter is higher on the "lost" (late) positions');
  const ask = results.find((r) => r.id === 'ask')!;
  assert.equal(ask.tested_by, 'question');
  assert.ok(ask.samples_win + ask.samples_loss >= ps.length - 1);
  assert.ok(stub.bodies.length > 0 && stub.bodies.length <= ps.length);
  assert.ok(stub.bodies.every((b) => b.state.perception && !b.state.rules_of_the_game));
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
