import test from 'node:test';
import assert from 'node:assert/strict';
import { findingOf, findingText, findingView } from '../src/learn/finding.ts';

/* SPEC-OBJETIVO O10: the finding of a run, derived from its journal alone, the same for every world. */

const law = { observations: {}, rules: {}, weights: {}, output: '(p) => 1' };
const place = (id: string, holds: boolean, agreed: number) => ({ place: id, holds, agreed, points: 24, not_a_number: 0, trace: [{ point: id + '@0' }] });

/** A journal shaped like the lab runner's (messages@1): a failed validation, then an acceptance with one blind miss. */
const journal = {
  experiment: 'messages@1', started: '2026-09-27T16:29:33.965Z', commit: 'abc1234', config: { seed: 1 },
  objective: { answer: ['YOUR ANSWER: a number'], verdict: ['A VERDICT: ...'] },
  hidden_from_the_learner: { truth: [{ id: 'rule', statement: 'the truth' }], places: [{ id: 'lab1', role: 'laboratory' }] },
  events: [
    { type: 'proposal', round: 1, fingerprint: 'f1', law },
    { type: 'check', round: 1, attempt: 1, accepted: false, laboratories: [place('lab1', true, 24)],
      validation: { family: [place('place1', false, 17), place('place2', true, 24)], became_laboratories: ['place1'] } },
    { type: 'proposal', round: 2, fingerprint: 'f2', law },
    { type: 'check', round: 2, attempt: 2, accepted: true, laboratories: [place('lab1', true, 24), place('place1', true, 24)],
      validation: { family: [], blind_confirmation: { confirmed: true, sets: [{ ok: true, places: [place('blind1', true, 23)] }, { ok: true, places: [place('blind2', true, 24)] }] } } },
    { type: 'accepted', round: 2 },
    { type: 'reflection', round: 3, rationale: 'why', lessons: ['a lesson'], next_experiment: 'what is left open' },
    { type: 'operator_rule_recovery', score: 0.63, form: 'compact', grades: [{ id: 'rule', grade: 'partial' }], false_beliefs: [] },
    { type: 'end', stoppedBy: 'accepted', final: law,
      places: [{ id: 'lab1', role: 'laboratory', seen: true, pools: ['plain'] }],
      notebook: { beliefs: [
        { id: 'kept', statement: 'a claim', status: 'confirmed', since: 1, history: [{ round: 2, evidence: ['ep1@2'] }] },
        { id: 'gone', statement: 'dropped', status: 'dropped', history: [] }] },
      operator_summary: { accepted: { round: 2, attempt: 2 }, validations: [{ round: 1 }], trivial_checks: [], accepted_trivially: false,
        cost: { llm_calls: 11 }, cost_per_acceptance: { llm_calls: 8 }, judge: { rounds_ablated: 2 } } }
  ]
};

test('a finding says what was asked, what came of it, and with which model', () => {
  const f = findingOf(journal, { journal: 'messages-s1.json' });
  assert.equal(f.format, 'finding@1');
  assert.equal(f.researcher, 'unknown-world', 'a journal that names none is of the unknown-world researcher');
  assert.deepEqual(f.question, { world: 'messages@1', answer_form: ['YOUR ANSWER: a number'], verdict_form: ['A VERDICT: ...'] });
  assert.deepEqual(f.outcome, { status: 'accepted', round: 2, attempt: 2 });
  assert.deepEqual(f.model, { round: 2, fingerprint: 'f2', law });
  assert.deepEqual(f.reproduce, { experiment: 'messages@1', started: journal.started, config: { seed: 1 }, journal: 'messages-s1.json', commit: 'abc1234' });
});

test('claims are the beliefs held, with their latest evidence; dropped ones are not claims', () => {
  assert.deepEqual(findingOf(journal).claims, [{ id: 'kept', statement: 'a claim', status: 'confirmed', since: 1, evidence: ['ep1@2'] }]);
});

test('where it held at acceptance, without the case-by-case trace', () => {
  const a = findingOf(journal).tested.at_acceptance!;
  assert.equal(a.round, 2);
  assert.deepEqual(a.laboratories.map((p) => p.place), ['lab1', 'place1']);
  assert.deepEqual(a.blind.map((s) => [s.set, s.ok, s.places.map((p) => p.place)]), [[1, true, ['blind1']], [2, true, ['blind2']]]);
  assert.ok(!('trace' in a.laboratories[0]));
});

test('counterexamples are the failed validations; limitations name the misses the criterion tolerated', () => {
  const f = findingOf(journal);
  assert.deepEqual(f.counterexamples.map((c) => [c.round, c.where, c.place]), [[1, 'family', 'place1']]);
  assert.deepEqual(f.limitations.tolerated_misses, [{ place: 'blind1', missed: 1, points: 24 }]);
  assert.equal(f.limitations.learner?.next_experiment, 'what is left open');
});

test('the operator part keeps the grade, the Judge ablation and the truth, apart from the rest', () => {
  const f = findingOf(journal);
  assert.equal(f.operator!.rule_recovery?.score, 0.63);
  assert.deepEqual(f.operator!.truth, journal.hidden_from_the_learner.truth);
  assert.deepEqual(f.cost, { total: { llm_calls: 11 }, to_acceptance: { llm_calls: 8 } });
});

test('orbit: a final wrapped as { round, fingerprint, law } and a law recovery are read the same way', () => {
  const orbit = { experiment: 'orbit@1', events: [
    { type: 'operator_law_recovery', score: 0.75, form: 'mixed' },
    { type: 'end', stoppedBy: 'budget', final: { round: 5, fingerprint: 'o5', test: {}, law } }] };
  const f = findingOf(orbit);
  assert.deepEqual(f.model, { round: 5, fingerprint: 'o5', law });
  assert.equal(f.outcome.status, 'budget');
  assert.equal(f.operator!.rule_recovery?.score, 0.75);
  assert.equal(f.tested.at_acceptance, null);
});

test('an unfinished journal still has a finding, and its text says so', () => {
  const f = findingOf({ experiment: 'cells@1', events: [{ type: 'start' }] });
  assert.equal(f.outcome.status, 'unfinished');
  assert.equal(f.model, null);
  assert.match(findingText(f), /^cells@1: unfinished/);
  assert.match(findingText(findingOf(journal)), /tolerated: 1 of 24 missed in blind1/);
});

/* SPEC-OBJETIVO O14: the researcher's view - what another agent is given - keeps nothing only the operator knows. */

test('the researcher view drops the operator part, the hidden description of places and any fact measured with the truth', () => {
  const withSolver = JSON.parse(JSON.stringify(journal));
  /* A grid-like place: a solver's view of each move is measured with the hidden rules. */
  withSolver.events[3].laboratories[0] = { ...withSolver.events[3].laboratories[0], wins: 3, total: 3, critical: [8, 4], turns_still_winning: [4, 2], action_accuracy: { rate: 0.6 } };
  withSolver.events.at(-1).places = [{ id: 'lab1', role: 'laboratory', seen: true, sources: [{ pos: [3, 4] }], frame: { theta: 1 } }];
  const operator = findingOf(withSolver);
  const researcher = findingView(operator, 'researcher');
  assert.equal(operator.view, 'operator');
  assert.equal(researcher.view, 'researcher');
  assert.equal(researcher.operator, undefined);
  assert.deepEqual(researcher.tested.places, [{ id: 'lab1', role: 'laboratory', seen: true }]);
  assert.deepEqual(researcher.tested.at_acceptance!.laboratories[0], { place: 'lab1', holds: true, agreed: 24, points: 24, not_a_number: 0, wins: 3, total: 3 });
  assert.deepEqual(researcher.counterexamples[0].facts, { place: 'place1', holds: false, agreed: 17, points: 24, not_a_number: 0 });
  const text = JSON.stringify(researcher);
  for (const hidden of ['the truth', 'critical', 'turns_still_winning', 'action_accuracy', 'sources', 'theta', 'rule_recovery', 'grades', 'trace'])
    assert.ok(!text.includes(hidden), hidden + ' must not reach a researcher');
  /* What the result is, is all there. */
  assert.deepEqual(researcher.model, operator.model);
  assert.deepEqual(researcher.claims, operator.claims);
  assert.deepEqual(researcher.limitations, operator.limitations);
  assert.deepEqual(researcher.reproduce, operator.reproduce);
  assert.equal(findingView(operator, 'operator'), operator);
  assert.doesNotMatch(findingText(researcher), /operator:/);
});
