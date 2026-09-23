import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlanner, solveAgainstModel } from '../src/core/truth.ts';
import { foxhounds, SIDE_CATS, SIDE_MOUSE } from '../src/worlds/foxhounds/world.ts';
import { chooseGreedyMouseMove, createMouseModel, solveAgainstModel as foxOracle } from '../src/worlds/foxhounds/model.ts';
import { asciiSense, createGridWorld, generateSpec, movesFor } from '../src/worlds/grid/index.ts';
import { sampleStates } from './support.ts';

const plain = (v: unknown): any => JSON.parse(JSON.stringify(v));

test('the generic planner and oracle ARE the foxhounds ones when applied to that world', () => {
  const states = sampleStates(30, 13).filter((s) => !foxhounds.outcome(s).over);
  for (const depth of [1, 2, 3, 4]) {
    const generic = createPlanner(foxhounds, SIDE_MOUSE, depth, { fallback: (s) => chooseGreedyMouseMove(s) });
    const specific = createMouseModel(depth);
    for (const s of states.filter((x) => x.turn === SIDE_MOUSE).slice(0, 50)) {
      assert.deepEqual(plain(generic.respond(s)), plain(specific.respond(s)), 'depth ' + depth);
    }
  }
  const model = createMouseModel(2);
  const generic = createPlanner(foxhounds, SIDE_MOUSE, 2, { fallback: (s) => chooseGreedyMouseMove(s) });
  for (const s of states.filter((_, i) => i % 5 === 0).slice(0, 40)) {
    const a = solveAgainstModel(foxhounds, s, SIDE_CATS, (x) => generic.respond(x), { budget: 20000 });
    const b = foxOracle(s, model, { budget: 20000 });
    if (a.exhausted || b.exhausted) continue;
    assert.equal(a.winner, b.winner);
    /* Plies agree on every WON line; on a lost one the generic oracle reports the LONGEST defence while the
       foxhounds one kept the first child (its known limit, SPEC M-B-03b) - a deliberate improvement. */
    if (a.winner === SIDE_CATS) assert.equal(a.plies, b.plies);
    else assert.ok((a.plies ?? 0) >= (b.plies ?? 0));
  }
});

test('grid@1: every seed yields a playable, non-trivial game that A can force against the starting opponent', () => {
  const seen = new Set<string>();
  for (let seed = 1; seed <= 12; seed++) {
    const { spec, report } = generateSpec(seed);
    assert.deepEqual(plain(generateSpec(seed).spec), plain(spec), 'deterministic');
    assert.ok(report.randomAWinRate >= 0.1 && report.randomAWinRate <= 0.9);
    assert.ok((report.forcedWinPlies ?? 0) >= 8);
    const world = createGridWorld(spec);
    const s0 = world.initial();
    assert.ok(movesFor(spec, s0, 'A').length && movesFor(spec, s0, 'B').length);
    seen.add([spec.width, spec.height, spec.shape, spec.winA, spec.winB, spec.A.moves.length, spec.B.moves.length].join());
  }
  assert.ok(seen.size >= 8, 'the family is varied: ' + seen.size + ' distinct shapes of game over 12 seeds');
});

test('the ASCII sense shows the board and nothing else: no rules, no legal moves, no role names', () => {
  const { spec } = generateSpec(3);
  const sense = asciiSense(spec);
  const world = createGridWorld(spec);
  const s0 = world.initial();
  const picture = sense.render(s0);
  assert.equal(picture, sense.render(s0), 'deterministic');
  assert.notEqual(sense.glyphA, sense.glyphB);
  assert.ok(picture.includes('you: ' + sense.glyphA));
  assert.equal(picture.split('\n').length, (sense.orientation >= 4 ? spec.width : spec.height) + 2);
  for (const word of ['cat', 'mouse', 'goal', 'win', 'trap', 'reach', 'legal', 'A', 'B']) {
    assert.ok(!new RegExp('\\b' + word + '\\b', 'i').test(picture), 'the picture names "' + word + '"');
  }
  assert.ok(new RegExp('\\b' + 'you' + '\\b').test(picture), 'the word-boundary check itself works');
  const next = world.step(s0, world.actions(s0)[0]);
  assert.notEqual(sense.render(next), picture);
});

test('the picture is drawn in one of the 8 orientations, and the family uses several', () => {
  const orientations = new Set<number>();
  for (let seed = 1; seed <= 16; seed++) {
    const { spec } = generateSpec(seed);
    const sense = asciiSense(spec);
    orientations.add(sense.orientation);
    const s0 = createGridWorld(spec).initial();
    const glyphs = sense.render(s0).split(sense.glyphA).length - 1;
    assert.equal(glyphs - 2, spec.A.start.length, 'every piece is drawn once, whatever the orientation (plus "you:" and "to move:")');
  }
  assert.ok(orientations.size >= 4, [...orientations].join());
});
