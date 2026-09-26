import test from 'node:test';
import assert from 'node:assert/strict';
import { asciiSense, createGridWorld, generateSpec, movesFor, outcomeOf } from '../src/worlds/grid/index.ts';
import { boardOf } from '../src/worlds/grid/family.ts';

/* G1: a family of boards under one set of rules (SPEC-MODELO-DEL-MUNDO §3). */

for (const seed of [22, 26]) {
  test('seed ' + seed + ': the same rules on boards of other sizes, pieces and starts; the picture keeps its orientation and symbols', () => {
    const { spec: base } = generateSpec(seed);
    const baseSense = asciiSense(base);
    assert.equal(boardOf(base, 0).spec, base);
    assert.deepEqual(boardOf(base, 4), boardOf(base, 4), 'deterministic');
    const shapes = new Set<string>();
    for (let i = 1; i <= 20; i++) {
      const { spec: b } = boardOf(base, i);
      shapes.add(b.width + 'x' + b.height + ':' + b.A.count + '/' + b.B.count);
      /* The rules stay. */
      assert.deepEqual([b.A.moves, b.B.moves, b.winA, b.winB, b.shape, b.goalRow, b.maxPlies], [base.A.moves, base.B.moves, base.winA, base.winB, base.shape, base.goalRow, base.maxPlies]);
      /* The picture: the same orientation and symbols ("forward" is a direction of the world). */
      const sense = asciiSense(b);
      assert.deepEqual([sense.orientation, sense.glyphA, sense.glyphB], [baseSense.orientation, baseSense.glyphA, baseSense.glyphB]);
      /* Playable: both sides can move, and the start is not already over. */
      const s0 = createGridWorld(b).initial();
      assert.ok(!outcomeOf(b, s0).over && movesFor(b, s0, 'A').length > 0 && movesFor(b, s0, 'B').length > 0);
      assert.ok(b.A.start.every(([, y]) => y === 0) && b.B.start.every(([, y]) => y === b.height - 1), 'each side in its own band');
    }
    assert.ok(shapes.size >= 8, 'the boards differ: ' + [...shapes].join(' '));
  });
}

import { jsFunctionRunner } from '../src/core/code-runner.ts';
import { checkRulesAt, trueRulesSource } from '../src/worlds/grid/rules-check.ts';
import { mulberry32, stepGrid, type GridSpec, type GridState } from '../src/worlds/grid/index.ts';

/* Calibration (SPEC-MODELO-DEL-MUNDO §7): positions from random games on 60 boards of each family. */
function positions(spec: GridSpec, seed: number, games = 3): GridState[] {
  const rnd = mulberry32(seed), out: GridState[] = [];
  for (let g = 0; g < games; g++) {
    let s = createGridWorld(spec).initial();
    for (let i = 0; i < spec.maxPlies + 2; i++) {
      out.push(s);
      if (outcomeOf(spec, s).over) break;
      const moves = movesFor(spec, s, s.turn);
      s = moves.length ? stepGrid(s, moves[Math.floor(rnd() * moves.length)]) : { ...s, turn: s.turn === 'A' ? 'B' : 'A', ply: s.ply + 1 };
    }
  }
  return out;
}
const compile = (src: { moves: string; ending: string }) => {
  const runner = jsFunctionRunner();
  return { moves: runner.compile(src.moves) as unknown as (p: unknown) => unknown, ending: runner.compile(src.ending) as unknown as (p: unknown) => unknown };
};
const failures = (base: GridSpec, rules: { moves: string; ending: string }) => {
  const compiled = compile(rules);
  let wrong = 0, checked = 0, boards = 0;
  for (let i = 1; i <= 60; i++) {
    const { spec } = boardOf(base, i);
    const sense = asciiSense(spec);
    let bad = false;
    for (const s of positions(spec, i)) { checked++; if (!checkRulesAt(spec, sense, s, compiled).correct) { wrong++; bad = true; } }
    if (bad) boards++;
  }
  return { wrong, checked, boards };
};

for (const seed of [22, 26, 4]) {
  test('calibration, seed ' + seed + ': the true rules written over the picture hold on 60 boards; one-board rules and a missing move do not', () => {
    const { spec: base } = generateSpec(seed);
    const sense = asciiSense(base);
    const truth = trueRulesSource(base, sense);
    const ok = failures(base, truth);
    assert.equal(ok.wrong, 0, 'the true rules fail at ' + ok.wrong + ' of ' + ok.checked + ' positions');
    assert.ok(ok.checked > 1000);
    /* Rules fitted to one board: the picture's size of the base game written in as constants. */
    const shown = asciiSense(base).render(createGridWorld(base).initial()).split('\n');
    const H = shown.length - 2, W = shown[1].slice(4).length / 2 + 0.5 | 0;
    const oneBoard = { moves: truth.moves.replaceAll('p.height', String(H)).replaceAll('p.width', String(W)), ending: truth.ending.replaceAll('p.height', String(H)).replaceAll('p.width', String(W)) };
    assert.ok(failures(base, oneBoard).boards > 10, 'rules fitted to one board fail on others');
    /* A move of the other side forgotten (as run 7 did). */
    /* Only a move the world ever allows can be missed: seed 26's other side has a move that would always take it off the
       board, and rules without it predict exactly what the true ones do. Rules are validated as far as the world shows. */
    const perMove = base.B.moves.map((_, i) => {
      const fewer = trueRulesSource({ ...base, B: { ...base.B, moves: base.B.moves.filter((__, j) => j !== i) } }, sense);
      return failures(base, { moves: fewer.moves, ending: truth.ending }).boards;
    });
    assert.ok(Math.max(...perMove) > 10, 'forgetting a move that occurs fails: ' + perMove.join(', '));
  });
}
