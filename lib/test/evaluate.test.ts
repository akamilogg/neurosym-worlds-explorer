import test from 'node:test';
import assert from 'node:assert/strict';
import { Observer } from '../src/core/observer.ts';
import { Evaluator, MeasurementError } from '../src/core/evaluate.ts';
import { checkFormula, formulaHash, judgmentHash, makeFormula } from '../src/core/formula.ts';
import { foxhounds } from '../src/worlds/foxhounds/world.ts';
import { foxhoundsDialect } from '../src/worlds/foxhounds/dialect.ts';
import { formulaFromHarness } from '../src/worlds/foxhounds/import-harness.ts';
import type { Judge, JudgeRequest } from '../src/core/types.ts';
import { readJson, sampleStates } from './support.ts';

/* A deterministic stand-in for Jev: it only records what it was asked. The library never ships one. */
function recordingJudge(): Judge & { requests: JudgeRequest[] } {
  const requests: JudgeRequest[] = [];
  return {
    id: 'recording-stub',
    requests,
    async judge(req) {
      requests.push(req);
      const out: Record<string, { value: number; confidence: number }> = {};
      for (const id of Object.keys(req.questions)) out[id] = { value: (Object.values(req.measurements).reduce((a, b) => a + b, 0) % 10) / 10, confidence: 0.5 };
      return out;
    }
  };
}

const journal = readJson('runs/2026-09-21-run-journal.json');
const accepted = formulaFromHarness(journal);

test('the accepted 21/09 formula passes the structural gate', () => {
  const check = checkFormula(accepted);
  assert.deepEqual(check.errors, []);
  assert.deepEqual(check.warnings, []);
});

test('Eval: O(s) -> Judge -> SUM w*r, with the judge reading measured FACTS (no placeholder survives)', async () => {
  const judge = recordingJudge();
  const ev = new Evaluator(new Observer(foxhounds, { dialects: [foxhoundsDialect] }), judge);
  const s = sampleStates(1)[6];
  const result = await ev.eval(accepted, s);
  assert.equal(result.provenance, 'live');
  const req = judge.requests[0];
  assert.deepEqual(Object.keys(req.questions).sort(), ['cat_formation', 'cats_win_forecast', 'mouse_containment']);
  for (const q of Object.values(req.questions)) {
    assert.doesNotMatch(q.instructions, /\{\{/);
    for (const c of Object.values(q.criteria)) if (typeof c === 'string') assert.doesNotMatch(c, /\{\{/);
  }
  assert.match(req.questions.mouse_containment.instructions, new RegExp('given ' + result.observation.values.mouse_mobility + ', '));
  const expected = Object.entries(accepted.weights).reduce((sum, [id, w]) => sum + w * result.answers[id].value, 0);
  assert.equal(result.value, Math.min(1, Math.max(0, expected)));
  assert.deepEqual(result.fallbacks, []);
});

test('states that measure the same are ONE question to the judge (vector cache)', async () => {
  const judge = recordingJudge();
  const ev = new Evaluator(new Observer(foxhounds, { dialects: [foxhoundsDialect] }), judge);
  const states = sampleStates(40, 11).filter((s) => !foxhounds.outcome(s).over);
  const vectors = new Set<string>();
  for (const s of states) vectors.add((await ev.eval(accepted, s)).observation.vector + '|' + s.turn);
  assert.equal(judge.requests.length, vectors.size);
  assert.equal(ev.stats.vectorHits, states.length - vectors.size);
  assert.ok(vectors.size < states.length, 'the observation vector compresses the state space');
});

test('identity is semantic: meta never changes a hash; weights change the formula but not the judgment', () => {
  const renamed = { ...accepted, meta: { rationale: 'other prose', version: 99 } };
  assert.equal(formulaHash(renamed), formulaHash(accepted));
  const reweighted = { ...accepted, weights: { cats_win_forecast: 0.5, mouse_containment: 0.5, cat_formation: 0 } };
  assert.notEqual(formulaHash(reweighted), formulaHash(accepted));
  assert.equal(judgmentHash(reweighted), judgmentHash(accepted));
  const remeasured = { ...accepted, observations: { ...accepted.observations, mouse_routes: { ...accepted.observations.mouse_routes, spec: { kind: 'dsl', dialect: 'foxhounds@1', op: 'mouse_routes', args: { cap: 3 } } } } } as typeof accepted;
  assert.notEqual(judgmentHash(remeasured), judgmentHash(accepted));
});

test('the gate refuses formulas that could not mean anything', () => {
  const noValue = makeFormula({ world: 'foxhounds@1', observations: accepted.observations, rules: {}, weights: {} });
  assert.match(checkFormula(noValue).errors.join(' '), /at least one VALUE rule/);
  const dangling = makeFormula({ world: 'foxhounds@1', observations: {}, rules: accepted.rules, weights: accepted.weights });
  assert.match(checkFormula(dangling).errors.join(' '), /observe at least one fact/);
  assert.match(checkFormula(dangling).errors.join(' '), /undeclared observation\(s\): cat_front_row/);
});

test('a formula whose measures this host cannot run is refused before the judge is paid', async () => {
  const judge = recordingJudge();
  const ev = new Evaluator(new Observer(foxhounds, { kinds: ['code'], dialects: [foxhoundsDialect] }), judge);
  await assert.rejects(() => ev.eval(accepted, foxhounds.initial()), MeasurementError);
  assert.equal(judge.requests.length, 0);
});
