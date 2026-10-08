import test from 'node:test';
import assert from 'node:assert/strict';
import { Protocol } from '../src/learn/protocol.ts';
import { objectiveLines, type Objective, type Place } from '../src/learn/objective.ts';

/* A toy objective: a model is a number; a case is a hurdle of some height; the model clears it when it is at least as
   high. Each place has hurdles up to its own height; the check draws them fresh by round. Nothing of any world. */

interface ToyPlace extends Place { readonly height: number }
interface Hurdle { readonly id: string; readonly h: number }
interface Cleared { readonly place: string; readonly id: string; readonly cleared: boolean }

let runs = 0;
const toy: Objective<number, ToyPlace, Hurdle[], Cleared> = {
  answer: { form: ['YOUR ANSWER: a number.'], use: 'predict' },
  verdictForm: ['A VERDICT is whether the hurdle was cleared.'],
  casesIn: (place, c) => [0, 1, 2].map((k) => ({ id: place.id + '-' + c.purpose + c.round + '-' + k, h: place.height * (k + 1) / 3 })),
  async run(model, cases) {
    runs++;
    return { byPlace: cases.map(({ place, cases: hs }) => hs.map((h) => ({ place: place.id, id: h.id, cleared: model >= h.h }))), operator: { runs } };
  },
  holds: (rs, { rerun }) => rs.every((r) => r.cleared) && (!rerun || rerun.now.every((r, i) => r.cleared || !rerun.before[i].cleared)),
  view: (rs) => ({ cases: rs.map((r) => ({ case: r.id, cleared: r.cleared })) }),
  rerunView: (r) => ({ worse: r.now.filter((x, i) => !x.cleared && r.before[i].cleared).length }),
  operatorView: (rs) => ({ cleared: rs.filter((r) => r.cleared).length, of: rs.length }),
  trace: (rs) => rs.map((r) => ({ case: r.id, cleared: r.cleared }))
};

function setup(options: { pairedRegression?: boolean; quick?: boolean; replications?: boolean } = {}) {
  const places: ToyPlace[] = [
    { id: 'lab1', role: 'laboratory', seen: true, height: 1 },
    { id: 'place1', role: 'family', seen: false, height: 1 },
    { id: 'place2', role: 'family', seen: false, height: 5 }
  ];
  let spent = 0;
  const protocol = new Protocol(toy, {
    places: () => places, blindPlaces: (set, round) => [{ id: 'blind' + set + '-' + round, role: 'confirmation', seen: false, height: 1 }],
    fingerprint: (m) => String(m), validations: 2, pairedRegression: options.pairedRegression ?? true, quick: options.quick, replications: options.replications,
    cost: () => ({ calls: spent++ })
  });
  return { protocol, places };
}

test('the objective contributes the form of the answer and of a verdict to the interface, in that order', () => {
  assert.deepEqual(objectiveLines(toy), ['YOUR ANSWER: a number.', 'A VERDICT is whether the hurdle was cleared.']);
});

test('a check, a refused validation, and a model that held validated on that check without checking again', async () => {
  const { protocol, places } = setup();
  const r1 = await protocol.round(0.1, { round: 1, attempt: 1, validate: true });
  assert.equal(r1.held, false);
  assert.match(r1.refused!, /does not yet hold/);
  assert.equal(protocol.validationsLeft, 2, 'a refusal costs nothing');
  assert.deepEqual((r1.view.validation as { refused: string }).refused, r1.refused);

  const r2 = await protocol.round(2, { round: 2, attempt: 2, validate: false });
  assert.equal(r2.held, true);
  assert.equal(r2.validation, null);
  const lab = (r2.view.laboratories as Record<string, unknown>[])[0];
  assert.equal(lab.your_model_holds_here, true);
  assert.equal(lab.trace, undefined, 'the trace is the operator\'s');
  assert.deepEqual((r2.journal.laboratories as { trace?: unknown[] }[])[0].trace![0], { case: 'lab1-check2-0', cleared: true }, 'the journal keeps the trace');
  assert.deepEqual(lab.your_previous_check_run_again, { worse: 0 }, 'the paired regression, as the objective words it');

  const before = runs;
  const r3 = await protocol.round(2, { round: 3, attempt: 3, validate: true });
  assert.equal(r3.reused, 2);
  assert.match(String(r3.view.not_checked_again), /round 2/);
  assert.equal(runs - before, 1, 'only the validation ran: the laboratories were not checked again');
  assert.deepEqual(r3.validation!.becameLaboratories, ['place2']);
  assert.equal(places[2].role, 'laboratory');
  assert.ok(places.every((p) => p.seen));
  assert.equal(r3.accepted, false);
  assert.deepEqual(protocol.placesView().map((p) => p.place), ['lab1', 'place1', 'place2']);
  assert.equal(protocol.validationsLeft, 1);
  assert.equal((r3.journal.validation as { family: { place: string; cleared: number }[] }).family[1].cleared, 1, 'the operator\'s view in the journal');

  /* The same model again: the laboratories changed, so it is checked again - and fails in the new one. */
  const r4 = await protocol.round(2, { round: 4, attempt: 4, validate: true });
  assert.equal(r4.reused, null);
  assert.equal(r4.held, false);

  const r5 = await protocol.round(5, { round: 5, attempt: 5, validate: true });
  assert.equal(r5.held, true);
  assert.equal(r5.validation!.blind!.length, 2);
  assert.equal(r5.accepted, true);
  assert.deepEqual(r5.view.validation, { validated_in: [{ place: 'place1', your_model_holds_here: true, cases: (r5.view.validation as any).validated_in[0].cases }] });

  const s = protocol.summary();
  assert.deepEqual(s.firstHeld, { round: 2, attempt: 2 });
  assert.deepEqual(s.accepted, { round: 5, attempt: 5 });
  assert.equal(s.validations.length, 2);
  assert.equal(s.rounds, 5);
  assert.equal(s.checks, 4, 'the reused round checked nothing');
  assert.ok(s.costPerAcceptance && s.costPerAcceptance.calls > 0);
});

test('the paired regression: a model that loses a case it cleared before does not hold', async () => {
  const { protocol } = setup();
  await protocol.round(1, { round: 1, attempt: 1, validate: false });
  const worse = await protocol.round(0.5, { round: 2, attempt: 2, validate: false });
  assert.equal(worse.laboratories[0].rerun!.before.length, 3);
  assert.equal(worse.held, false);
  const without = setup({ pairedRegression: false });
  await without.protocol.round(1, { round: 1, attempt: 1, validate: false });
  assert.equal((await without.protocol.round(1, { round: 2, attempt: 2, validate: false })).laboratories[0].rerun, null);
});

test('--quick stops where System 2 asks to validate, without validating; restart gives the validations back', async () => {
  const { protocol } = setup({ quick: true });
  const r = await protocol.round(2, { round: 1, attempt: 1, validate: true });
  assert.equal(r.quickStop, true);
  assert.equal(r.validation, null);
  assert.equal(protocol.validationsLeft, 2);
  protocol.validationsLeft = 0;
  protocol.restart();
  assert.equal(protocol.validationsLeft, 2);
});

test('operator measures: what the Judge added over the ablated rounds, and the tokens an answer reports', async () => {
  const { judgeContribution, tokensOf, operatorSummary } = await import('../src/learn/operator.ts');
  const j = judgeContribution([{ round: 1, model: 4, withoutJudge: 4, better: 'higher' }, { round: 2, model: 6, withoutJudge: 5, better: 'higher' },
    { round: 3, model: 0.2, withoutJudge: 0.1, better: 'lower' }]);
  assert.deepEqual([j.rounds_ablated, j.judge_changed_nothing, j.judge_helped, j.judge_hurt], [3, 1, 1, 1]);
  assert.equal(tokensOf({ usage: { prompt_tokens: 3, completion_tokens: 4 } }), 7);
  assert.equal(tokensOf(null), 0);
  const { protocol } = setup();
  await protocol.round(2, { round: 1, attempt: 1, validate: false });
  const s = operatorSummary(protocol.summary());
  assert.deepEqual(s.first_held, { round: 1, attempt: 1 });
  assert.equal(s.accepted, null);
});

test('operator baselines: a model that knows nothing run on the same cases; a check it passes too is trivial', async () => {
  const places: ToyPlace[] = [{ id: 'lab1', role: 'laboratory', seen: true, height: 1 }, { id: 'place1', role: 'family', seen: false, height: 1 }];
  const protocol = new Protocol(toy, {
    places: () => places, blindPlaces: (set, round) => [{ id: 'blind' + set + '-' + round, role: 'confirmation', seen: false, height: 1 }],
    fingerprint: (m) => String(m), validations: 1, pairedRegression: false,
    baselines: [{ name: 'tall enough anyway', model: 1 }, { name: 'nothing', model: 0 }]
  });
  const r = await protocol.round(3, { round: 1, attempt: 1, validate: true });
  assert.equal(r.accepted, true);
  assert.equal(r.journal.check_is_trivial, true, 'a baseline cleared every hurdle too');
  assert.deepEqual((r.journal.laboratories as { baselines_that_hold_too?: string[] }[])[0].baselines_that_hold_too, ['tall enough anyway']);
  assert.equal(JSON.stringify(r.view).includes('tall enough'), false, 'never shown to System 2');
  const s = protocol.summary();
  assert.deepEqual(s.trivialChecks, [1]);
  assert.equal(s.acceptedTrivially, true);
  places[0] = { ...places[0], height: 5 } as ToyPlace;
  protocol.restart();
  const hard = await protocol.round(6, { round: 2, attempt: 2, validate: false });
  assert.equal(hard.journal.check_is_trivial, false);
});

test('the grader separates predicting from understanding: a table that agrees is partial; the form is read back', async () => {
  const { GRADING_STRUCTURE, formOf } = await import('../src/learn/operator.ts');
  assert.match(GRADING_STRUCTURE, /lookup table/);
  /* A disclaimer is not knowing; false is only what a true statement contradicts (every grader shares it). */
  assert.match(GRADING_STRUCTURE, /A statement of NOT KNOWING is not knowing/);
  assert.match(GRADING_STRUCTURE, /never false merely because no true statement mentions it/);
  const { ruleGradingSystem } = await import('../src/learn/lab.ts');
  assert.match(ruleGradingSystem('x', 'y'), /"false_beliefs": \[claims of the learner that a true statement contradicts\]/);
  const { GRID_GRADING_SYSTEM } = await import('../src/worlds/grid/lab.ts');
  assert.match(GRID_GRADING_SYSTEM, /NOT KNOWING/);
  assert.match(GRADING_STRUCTURE, /"partial"/);
  assert.deepEqual(formOf({ form: 'table', form_evidence: 'a 32-entry lookup' }), { form: 'table', form_evidence: 'a 32-entry lookup' });
  assert.deepEqual(formOf({ form: 'nonsense' }), { form: null, form_evidence: null });
  assert.deepEqual(formOf(null), { form: null, form_evidence: null });
});

test('a model proposed again is recognized, and its checks add up as replications (SPEC-CALIBRACION-INSTRUMENTOS §11.1)', async () => {
  const { protocol } = setup({ replications: true });
  const r1 = await protocol.round(2, { round: 1, attempt: 1, validate: false });
  assert.equal(r1.view.same_model_as_round, undefined, 'the first time, nothing to recognize');
  await protocol.round(3, { round: 2, attempt: 2, validate: false });
  const r3 = await protocol.round(2, { round: 3, attempt: 3, validate: false });
  assert.equal(r3.view.same_model_as_round, 1);
  assert.deepEqual(r3.view.this_model_so_far, { lab1: { held: 2, did_not_hold: 0 } });
  assert.equal(r3.journal.same_model_as_round, 1, 'the journal says so too');
  /* Validated on the check it held in: the reused check is not counted twice; the family places are. */
  const r4 = await protocol.round(2, { round: 4, attempt: 4, validate: true });
  assert.equal(r4.reused, 3);
  assert.deepEqual(r4.view.this_model_so_far, { lab1: { held: 2, did_not_hold: 0 }, place1: { held: 1, did_not_hold: 0 }, place2: { held: 0, did_not_hold: 1 } });
  const off = setup();
  await off.protocol.round(2, { round: 1, attempt: 1, validate: false });
  assert.equal((await off.protocol.round(2, { round: 2, attempt: 2, validate: false })).view.same_model_as_round, undefined, 'off by default: a journal of version 1');
});
