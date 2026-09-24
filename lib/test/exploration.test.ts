import test from 'node:test';
import assert from 'node:assert/strict';
import { Observer } from '../src/core/observer.ts';
import { Evaluator } from '../src/core/evaluate.ts';
import { makeFormula } from '../src/core/formula.ts';
import { recordTurn, surprises, type TurnRecord } from '../src/learn/exploration.ts';
import { asciiSense, createGridWorld, generateSpec, readPicture, type GridState } from '../src/worlds/grid/index.ts';
import type { Judge } from '../src/core/types.ts';

/* The learner's own exploration: what ITS search saw on one of its turns, and where its own values were most wrong.
   Nothing here comes from anything that knows the rules better than the learner's search. */

const { spec } = generateSpec(22);
const world = createGridWorld(spec);
const sense = asciiSense(spec);
const observer = new Observer<GridState>(world, { kinds: ['sense', 'code'], senses: { ascii: (s) => sense.render(s) },
  perceive: (_s, p) => readPicture(Object.values(p)[0] ?? '') });
/* A local judge that reads one measured fact: the move counter, scaled. */
const judge: Judge = { id: 'local', async judge(r) { return { v: { value: Math.min(1, (r.measurements.t ?? 0) / 20), confidence: null } }; } };
const formula = makeFormula({ world: world.id, observations: { picture: { spec: { kind: 'sense', sense: 'ascii' } },
  t: { spec: { kind: 'code', lang: 'js', source: '(p) => p.move' }, range: [0, 40] } },
  rules: { v: { type: 'noul', used_as: 'value', instructions: '{{t}}', criteria: { yes: '', no: '' } } }, weights: { v: 1 } });

test('a recorded turn holds every choice its search had, as its search valued them, and marks the one it took', async () => {
  const ev = new Evaluator<GridState>(observer, judge, { maximizer: 'A' });
  const s0 = world.initial();
  const moves = world.actions(s0);
  const t = await recordTurn(ev, world, s0, moves[1], { formula, depth: 2, maximizer: 'A', turn: 0 });
  assert.equal(t.choices.length, moves.length);
  assert.deepEqual(t.choices.map((c) => c.chosen), moves.map((_, i) => i === 1));
  for (const c of t.choices) {
    assert.equal(c.direct, 0.05, 'direct: the formula on the position itself (move 1 / 20)');
    assert.ok(Number.isFinite(c.lookahead));
    assert.ok(c.endingsWon >= 0 && c.endingsLost >= 0);
  }
  assert.equal(t.value, t.choices[1].lookahead);
});

test('surprises: where the search\'s own value fell most before the next turn or the end', () => {
  const turn = (n: number, value: number) => ({ turn: n, state: world.initial(), value, choices: [] }) as TurnRecord<GridState>;
  const s = surprises([turn(0, 0.6), turn(2, 0.7), turn(4, 0.3), turn(6, 0.4)], 0);
  assert.deepEqual(s.map((x) => [x.turn, x.next, x.drop]), [[2, 4, 0.4], [6, 'end', 0.4]]);
  assert.deepEqual(surprises([turn(0, 0.2)], 1), [], 'a rise is not a surprise');
});

test('generalization starts: never the usual one, each side in its own band, and still a fair (winnable) game', async () => {
  const { variantStarts } = await import('../src/worlds/grid/variants.ts');
  const { createPlanner, solveAgainstModel } = await import('../src/core/truth.ts');
  const { bFallback } = await import('../src/worlds/grid/index.ts');
  const starts = variantStarts(spec, { count: 4, level: 2, seed: 7 });
  assert.equal(starts.length, 4);
  const planner = createPlanner(world, 'B', 2, { fallback: bFallback(spec) });
  const keys = new Set(starts.map((s) => world.key(s)));
  assert.equal(keys.size, 4);
  assert.ok(!keys.has(world.key(world.initial())));
  for (const s of starts) {
    assert.ok(s.a.every((p) => p[1] <= 1) && s.b.every((p) => p[1] >= spec.height - 2));
    assert.equal(solveAgainstModel(world, s, 'A', (x) => planner.respond(x), { budget: 60000 }).winner, 'A');
  }
  assert.notDeepEqual(variantStarts(spec, { count: 4, level: 2, seed: 8 }).map((s) => world.key(s)), [...keys], 'a new attempt, new starts');
});
