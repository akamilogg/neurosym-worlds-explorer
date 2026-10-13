import test from 'node:test';
import assert from 'node:assert/strict';
import { closedLab, closedInterface, type ClosedEpisode, type ClosedResult } from '../src/worlds/c302closed/lab.ts';
import { C302_BODY, runEpisode, type Signals } from '../src/worlds/c302closed/body.ts';
import { toyCircuit } from '../src/worlds/c302closed/circuits.ts';
import type { ModelAnswer } from '../src/worlds/c302closed/navigation.ts';
import type { Objective, Place } from '../src/learn/objective.ts';
import { Protocol } from '../src/learn/protocol.ts';
import { researcherEvents, runDigest } from '../src/orchestra/view.ts';
import { journalReader } from '../src/learn/assisted/record.ts';
import { findingOf, findingView } from '../src/learn/finding.ts';

const spec = closedLab.generate(1, {});
type LabPlace = Place & { spec: typeof spec };
const place: LabPlace = { id: 'lab1', role: 'laboratory', seen: true, spec };
const e = runEpisode({ field: spec.field, body: C302_BODY, circuit: toyCircuit(), start: { x: 8, y: 1, heading: 2.5 }, durationMs: 6000, dtMs: 5 });
const episode: ClosedEpisode = {
  t: e.steps.map((s) => s.t), x: e.steps.map((s) => s.pose.x), y: e.steps.map((s) => s.pose.y), heading: e.steps.map((s) => s.pose.heading),
  c: e.steps.map((s) => s.c), left: e.steps.map((s) => s.left), right: e.steps.map((s) => s.right),
  reorientation: [0, ...e.steps.map((s) => s.signals.reorientation)], steering: [0, ...e.steps.map((s) => s.signals.steering)],
  turns: e.steps.flatMap((s, i) => s.turn === undefined ? [] : [[i, s.turn] as const]), accumulated: e.steps.map((s) => s.accumulated),
  turnsMade: e.steps.map((s) => s.turns), calcium: {}, end: e.end, field: spec.field, body: C302_BODY, start: e.steps[0].pose,
  identity: 'toy', names: { left: 'AWCL', right: 'AWCR', signals: ['reorientation', 'steering'] }
};
const oracle: ModelAnswer = async (p) => {
  assert.deepEqual(Object.keys(p).sort(), ['inputs', 'step', 't'], 'the transferable model sees no body or evaluation identity');
  const circuit = toyCircuit();
  let s: Signals = circuit.initial;
  for (let j = 1; j <= p.step; j++) s = circuit.step(p.inputs.AWCL[j], p.inputs.AWCR[j], 5);
  return s;
};
function setup(focus = 'both', data = episode) {
  const cases = closedLab.cases(spec, 'ep1', data, 100);
  const objective = closedLab.objective<ModelAnswer, LabPlace>({ casesIn: () => cases,
    answer: (m, p) => m(p as Parameters<ModelAnswer>[0]), compared: async () => null, focus: () => focus,
    episode: (id) => id === 'ep1' ? data : undefined, regression: true }, {}) as Objective<ModelAnswer, LabPlace, typeof cases, ClosedResult>;
  return { objective, cases };
}
const context = { round: 1, attempt: 1, purpose: 'check' as const };
const goodSignals: ClosedResult[] = [0, 1].map((n) => ({ facet: 'signals', place: 'lab1', point: 'ep1@' + n,
  signals: { place: 'lab1', point: 'ep1@' + n, verdict: [0, 0], came: { reorientation: n, steering: n }, answer: { reorientation: n, steering: n } } }));
const joint = (signals: boolean, navigation: boolean): ClosedResult[] => [{ facet: 'both', place: 'lab1', point: 'both', components: {
  signals: signals ? goodSignals : goodSignals.map((r) => ({ ...r, signals: { ...r.signals!, verdict: null } })),
  navigation: [{ facet: 'navigation', place: 'lab1', point: 'ep1', holds: navigation }]
} }];

test('one circuit model passes both evaluations on the same episode without any simulator calls', async () => {
  const { objective, cases } = setup();
  const results = (await objective.run(oracle, [{ place, cases }], context)).byPlace[0];
  assert.equal(objective.holds(results, { place }), true);
  assert.deepEqual(objective.view(results, place).evaluations, { signals: true, navigation: true });
  assert.ok(results[0].components!.signals.length > 1);
  assert.equal(results[0].components!.navigation!.length, 1);
  assert.match(JSON.stringify(closedInterface({ focus: 'both', regression: true })), /same version/);
});

test('both evaluations must pass now and on the previous check: neither can compensate for the other', () => {
  const { objective } = setup();
  for (const [signals, navigation] of [[true, false], [false, true], [false, false]]) {
    const failed = joint(signals, navigation);
    assert.equal(objective.holds(failed, { place }), false);
    const rerun = { before: joint(true, true), now: failed };
    assert.equal(objective.holds(joint(true, true), { place, rerun }), false);
    assert.deepEqual(objective.rerunView!(rerun, place), { your_model_holds_on_them: false, evaluations: { signals, navigation } });
  }
  assert.equal(objective.holds(joint(true, true), { place, rerun: { before: joint(false, false), now: joint(true, true) } }), true);
  assert.equal(objective.holds([], { place }), false);
  const nav = setup('navigation').objective;
  const good: ClosedResult[] = [{ facet: 'navigation', place: 'lab1', point: 'ep1', holds: true }];
  assert.equal(nav.holds(good, { place, rerun: { before: good, now: [{ ...good[0], holds: false }] } }), false);
});

test('own open-loop tests evaluate signals; formal checks always require navigation too', async () => {
  for (const change of [{ blocked: true }, { replayOf: 'ep0' }, { designed: [] }]) {
    const { objective, cases } = setup('both', { ...episode, ...change });
    const results = (await objective.run(oracle, [{ place, cases }], { ...context, purpose: 'test' })).byPlace[0];
    assert.equal(objective.holds(results, { place }), true);
    assert.deepEqual(objective.view(results, place).evaluations, { signals: true });
    assert.equal((objective.view(results, place).navigation as { applicable: boolean }).applicable, false);
  }
  const { objective, cases } = setup('both', { ...episode, blocked: true });
  const formal = (await objective.run(oracle, [{ place, cases }], context)).byPlace[0];
  assert.notEqual(formal[0].components!.navigation, null, 'an own-test exception cannot waive a formal evaluation');
});

test('family and blind acceptance use one version; a regression refuses validation without spending it', async () => {
  const base = setup().objective;
  const purposes: string[] = [];
  const objective: Objective<string, LabPlace, number, ClosedResult> = { ...base, casesIn: () => 1,
    async run(model, cases, c) {
      purposes.push(model + ':' + c.purpose);
      return { byPlace: cases.map(({ place }) => joint(!(model === 'family-fail' && c.purpose === 'validation' && place.id === 'family1'),
        !(model === 'regressed' && c.purpose === 'rerun') && !(model === 'blind-fail' && c.purpose === 'blind'))) };
    }
  };
  const places: LabPlace[] = [place, { ...place, id: 'family1', role: 'family', seen: false }, { ...place, id: 'family2', role: 'family', seen: false }];
  const protocol = new Protocol(objective, { places: () => places,
    blindPlaces: (set) => [{ ...place, id: 'blind' + set, role: 'confirmation', seen: false }], fingerprint: (m) => m, validations: 3, pairedRegression: true });
  await protocol.round('good', { round: 1, attempt: 1, validate: false });
  const failed = await protocol.round('regressed', { round: 2, attempt: 2, validate: true });
  assert.equal(failed.held, false);
  assert.equal(failed.validation, null);
  assert.equal(protocol.validationsLeft, 3);
  const family = await protocol.round('family-fail', { round: 3, attempt: 3, validate: true });
  assert.equal(family.accepted, false);
  assert.equal(family.validation!.blind, null);
  assert.equal((await protocol.round('blind-fail', { round: 4, attempt: 4, validate: true })).accepted, false);
  const accepted = await protocol.round('good', { round: 5, attempt: 5, validate: true });
  assert.equal(accepted.accepted, true);
  assert.ok(purposes.includes('good:validation') && purposes.includes('good:blind'));
  assert.ok(!purposes.some((p) => p.startsWith('regressed:validation')));
});

test('both verdicts survive senior memory and transferable findings without operator measures', async () => {
  const p = { place: 'lab1', holds: false, evaluations: { signals: true, navigation: false, private_score: 0.9 },
    signals: { r2: { reorientation: 0.9 } }, navigation: { horizons: [] },
    rerun: { your_model_holds_on_them: false, evaluations: { signals: false, navigation: true } } };
  const journal = { experiment: closedLab.id, config: { focus: 'both' }, events: [
    { type: 'proposal', round: 1, fingerprint: 'model-1', law: { observations: {}, rules: {}, weights: {}, output: '(p) => 0' } },
    { type: 'check', round: 1, attempt: 1, laboratories: [p], accepted: false },
    { type: 'check', round: 2, attempt: 2, laboratories: [{ ...p, holds: true, evaluations: { signals: true, navigation: true } }], accepted: true },
    { type: 'end', stoppedBy: 'accepted', operator_summary: { accepted: { round: 2, attempt: 2 } } }
  ] };
  const event = researcherEvents(journal).find((r) => r.type === 'check')!;
  assert.deepEqual(event.laboratories[0].evaluations, { signals: true, navigation: false });
  const text = JSON.stringify(await journalReader(journal).run({ memory: 'open', items: ['check:r1'] }));
  assert.match(text, /"signals":true,"navigation":false/);
  assert.match(text, /your_model_holds_on_them/);
  assert.doesNotMatch(text, /private_score|reorientation/);
  assert.match(JSON.stringify(runDigest(journal)), /evaluations/);
  const f = findingView(findingOf(journal), 'researcher');
  assert.deepEqual(f.tested.at_acceptance!.laboratories[0].evaluations, { signals: true, navigation: true });
});
