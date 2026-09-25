import test from 'node:test';
import assert from 'node:assert/strict';
import { asciiSense, createGridWorld, generateSpec, movesFor, readPicture, stepGrid } from '../src/worlds/grid/index.ts';
import { describeGridTruth, pictureDelta } from '../src/worlds/grid/describe.ts';

/* Operator only: the hidden rules stated in the picture's coordinates, to grade what System 2 recovered. */

test('a move stated in picture directions is the move the picture shows', () => {
  for (const seed of [4, 22, 26]) {
    const { spec } = generateSpec(seed);
    const world = createGridWorld(spec);
    const sense = asciiSense(spec);
    const s0 = world.initial();
    const m = movesFor(spec, s0, 'A')[0];
    const cellsOf = (pic: string): string[] => readPicture(pic).cells.flatMap((row, r) => row.flatMap((c, col) => c === sense.glyphA ? [col + ',' + r] : []));
    const before = cellsOf(sense.render(s0)), after = cellsOf(sense.render(stepGrid(s0, m)));
    const to = after.find((k) => !before.includes(k))!.split(',').map(Number);
    const from = before.find((k) => !after.includes(k))!.split(',').map(Number);
    assert.deepEqual(pictureDelta(spec, sense, [m.to[0] - m.from[0], m.to[1] - m.from[1]]), [to[0] - from[0], to[1] - from[1]], 'seed ' + seed);
    const truth = describeGridTruth(spec, sense);
    assert.ok(truth.some((t) => t.id === 'moves_you') && truth.some((t) => t.id === 'win_you') && truth.some((t) => t.id === 'win_other'));
  }
});
