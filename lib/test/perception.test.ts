import test from 'node:test';
import assert from 'node:assert/strict';
import { Observer } from '../src/core/observer.ts';
import { Evaluator } from '../src/core/evaluate.ts';
import { JevJudge } from '../src/core/jev.ts';
import { checkFormula, makeFormula } from '../src/core/formula.ts';
import { asciiSense, createGridWorld, generateSpec, readPicture, type GridState } from '../src/worlds/grid/index.ts';
import { stubJev } from './stub-jev.ts';

/* G2: a world perceived only through a predefined sense. System 2's observations are code over WHAT IS
   PERCEIVED (never the hidden state or the rules); Jev receives the picture AND the measured values. */

const { spec } = generateSpec(4);
const world = createGridWorld(spec);
const sense = asciiSense(spec);
const observer = new Observer<GridState>(world, {
  kinds: ['sense', 'code'],
  senses: { ascii: (s) => sense.render(s) },
  perceive: (_s, percepts) => readPicture(Object.values(percepts)[0])
});
const countMine = { spec: { kind: 'code', lang: 'js', source: '(p) => p.cells.flat().filter((c) => c === p.you).length' }, range: [0, 64] } as const;
const formula = makeFormula({
  world: world.id,
  observations: { board: { spec: { kind: 'sense', sense: 'ascii' } }, my_pieces: countMine },
  rules: { good: { type: 'noul', used_as: 'value', instructions: 'Is this good for me? I have {{my_pieces}} pieces.', criteria: { yes: 'good', no: 'bad' } } },
  weights: { good: 1 }
});

test('the sense is perceived as text, and a code observation is computed FROM the percept', () => {
  assert.deepEqual([...checkFormula(formula).warnings], [], 'a sense needs no rule citing it');
  const o = observer.observe(world.initial(), formula.observations);
  assert.deepEqual(o.errors, []);
  assert.equal(o.percepts.board, sense.render(world.initial()));
  assert.equal(o.values.my_pieces, spec.A.start.length);
});

test('a perception-only measure cannot reach the hidden state, the rules or the legal moves', () => {
  const peek = { spec: { kind: 'code', lang: 'js', source: '(p) => p.state.a.length + p.world.actions(p.state).length' }, range: [0, 99] } as const;
  const o = observer.observe(world.initial(), { board: { spec: { kind: 'sense', sense: 'ascii' } }, peek });
  assert.equal(o.values.peek, undefined);
  assert.equal(o.errors[0].id, 'peek');
  const ghost = observer.observe(world.initial(), { eyes: { spec: { kind: 'sense', sense: 'sonar' } } });
  assert.match(ghost.errors[0].error, /sense "sonar" does not exist/);
});

test('Jev receives the picture AND the measured values, under a contract that names nothing about the world', async () => {
  const stub = stubJev();
  const ev = new Evaluator<GridState>(observer, new JevJudge({ fetch: stub.fetch }), { maximizer: 'A' });
  const r = await ev.eval(formula, world.initial());
  assert.equal(r.provenance, 'live');
  const body = stub.bodies[0];
  assert.equal(body.state.perception.board, sense.render(world.initial()));
  assert.equal(body.state.measurements.my_pieces, spec.A.start.length);
  assert.match(body.state.evaluation_contract, /Nothing else about this world is known/);
  assert.equal(body.state.rules_of_the_game, undefined);
  assert.match(body.questions.good.instructions, new RegExp('I have ' + spec.A.start.length + ' pieces'));
  await ev.eval(formula, world.initial());
  assert.equal(stub.bodies.length, 1, 'the same picture with the same facts is one question');
});
