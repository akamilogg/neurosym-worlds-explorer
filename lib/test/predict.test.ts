import test from 'node:test';
import assert from 'node:assert/strict';
import { Observer } from '../src/core/observer.ts';
import { Evaluator } from '../src/core/evaluate.ts';
import { checkLaw, magnitudeOf, Predictor, testPredictions, type Law } from '../src/core/predict.ts';
import { delegatedLaw, fitLawCodeOnly } from '../src/learn/law-ablation.ts';
import { generateOrbit } from '../src/worlds/orbit/index.ts';
import { orbitPointWorld, perceivePoint, predictionSamples, trialLaunches, type OrbitPoint } from '../src/worlds/orbit/predict.ts';
import type { Judge } from '../src/core/types.ts';

/* orbit@1, phase P2: a law predicts, the trial tests it, and the ablations say where the prediction lives. */

const { spec } = generateOrbit(3, 1);
const observer = new Observer<OrbitPoint>(orbitPointWorld(), { kinds: ['code'], perceive: (s) => perceivePoint(s) });
const samples = predictionSamples(spec, trialLaunches(spec, { sampling: 'grid', attempt: 1, inView: 6, beyond: 3 }));

/* A local judge that answers each rule with the measured value it names in its words ("{{mag}}" -> the value of mag). */
let calls = 0;
const echo: Judge = {
  id: 'echo',
  async judge(r) {
    calls++;
    return Object.fromEntries(Object.entries(r.questions).map(([id, q]) => [id, { value: Number(q.instructions), confidence: null }]));
  }
};

/* The operator's EXACT law, written as a learner would: code over the table, in the learner's frame. The departure from
   repeating the last step is a·Δt²; in the learner's frame that is s·k·dt²·(r'/s)^-p along the line to the source. */
const { k, p } = spec.law.central;
const K = spec.frame.scale * k * spec.dt * spec.dt;
const mags = samples.map((s) => Math.hypot(s.truth![0], s.truth![1]));
const [lo, hi] = [Math.min(...mags) / 2, Math.max(...mags) * 2];
const last = "const g = p.symbols, i = p.t.length - 1, s = p.bodies[g[0]], q = p.bodies[g[g.length - 1]];";
const exact: Law = {
  world: 'orbit@1',
  observations: {
    mag: { definition: 'the departure the law predicts, as a fraction of the log range', range: [0, 1], spec: { kind: 'code', lang: 'js',
      source: '(p) => { ' + last + ' const r = Math.hypot(q.x[i] - s.x[i], q.y[i] - s.y[i]) / ' + spec.frame.scale + '; const m = ' + K + ' * Math.pow(r, -' + p + ');'
        + ' return (Math.log(m) - Math.log(' + lo + ')) / (Math.log(' + hi + ') - Math.log(' + lo + ')); }' } }
  },
  rules: { pull: { type: 'noul', used_as: 'value', instructions: '{{mag}}', criteria: { yes: '', no: '' } } },
  components: {
    toward: { direction: { kind: 'code', lang: 'js', source: '(p) => { ' + last + ' return [s.x[i] - q.x[i], s.y[i] - q.y[i]]; }' }, weights: { pull: 1 }, range: [lo, hi], scale: 'log' }
  }
};

test('a magnitude lands in its range, linearly or on a log scale', () => {
  assert.equal(magnitudeOf(0.5, { range: [0, 10], scale: 'linear' }), 5);
  assert.ok(Math.abs(magnitudeOf(0.5, { range: [1, 100], scale: 'log' }) - 10) < 1e-9);
  assert.equal(magnitudeOf(2, { range: [1, 100], scale: 'log' }), 100, 'clamped');
});

test('a law is checked before it is used', () => {
  assert.deepEqual(checkLaw(exact).errors, []);
  const bad: Law = { ...exact, components: { a: { ...exact.components.toward, range: [0, 1], scale: 'log', weights: { nothing: 1 } } } };
  const errors = checkLaw(bad).errors.join(' | ');
  assert.match(errors, /log scale needs 0 < lo/);
  assert.match(errors, /weight "nothing" has no rule/);
});

test('a point holds only what is perceived; the target is read from the table, and the noise alone keeps even the truth off it', () => {
  for (const s of samples) assert.deepEqual(Object.keys(s.state).sort(), ['row', 'table']);
  const truthVsTarget = samples.reduce((n, s) => n + (s.truth![0] - s.target[0]) ** 2 + (s.truth![1] - s.target[1]) ** 2, 0);
  const size = samples.reduce((n, s) => n + s.target[0] ** 2 + s.target[1] ** 2, 0);
  assert.ok(Math.sqrt(truthVsTarget / size) < 0.2, 'the truth is close to what is observed');
  assert.ok(samples.some((s) => s.band === 'outer') && samples.some((s) => s.band === 'view'));
});

test('the exact law, written in the learner\'s frame, predicts to the noise; the Judge is asked once per point', async () => {
  calls = 0;
  const predictor = new Predictor(new Evaluator<OrbitPoint>(observer, echo, { maximizer: 'nature' }), perceivePoint);
  const twoParts: Law = { ...exact, components: { toward: exact.components.toward, again: { ...exact.components.toward, range: [lo * 1e-6, lo * 1e-5] } } };
  const r = await testPredictions(samples, async (s) => (await predictor.predict(twoParts, s)).vector);
  assert.deepEqual(r.failed, []);
  assert.ok(r.truthError! < 0.02, 'against the truth: ' + r.truthError);
  assert.ok(r.error < 0.2, 'against what was observed: ' + r.error);
  assert.ok(Math.abs(r.error - r.floor!) < 0.02 * r.floor! + 1e-3, 'a perfect law scores the floor: ' + r.error + ' vs ' + r.floor);
  assert.equal(calls, samples.length, 'two components, one question per point');
  await testPredictions(samples, async (s) => (await predictor.predict(twoParts, s)).vector);
  assert.equal(calls, samples.length, 'the same points again: every answer from the cache');
});

test('ablations: code alone carries a law written in code; a constant per component is the floor', async () => {
  const codeOnly = fitLawCodeOnly(observer, perceivePoint, exact, samples);
  const flat = fitLawCodeOnly(observer, perceivePoint, exact, samples, { flat: true });
  const c = await testPredictions(samples, codeOnly.predict);
  const f = await testPredictions(samples, flat.predict);
  assert.ok(c.error < f.error, 'code ' + c.error + ' vs flat ' + f.error);
  const fit = codeOnly.coefficients.toward;
  /* With the component's own scale, code alone finds the law written in code (0 and 1 are exact; fitted on the samples it
     is scored on, it also fits their noise - the runner fits it on other points). */
  assert.ok(Math.abs(fit.constant) < 0.05 && Math.abs(fit.mag - 1) < 0.05, JSON.stringify(fit));
  assert.deepEqual(Object.keys(codeOnly.coefficients.toward), ['constant', 'mag']);
});

test('the delegated mode: the Judge reads the latest rows of the table as text, in the harness\'s words', async () => {
  const d = delegatedLaw(exact);
  assert.deepEqual(checkLaw(d).errors, []);
  const seen: string[] = [];
  const spy: Judge = { id: 'spy', async judge(r) { seen.push(r.texts?.observed_table ?? ''); return { delegated_toward: { value: 0.5, confidence: null } }; } };
  const predictor = new Predictor(new Evaluator<OrbitPoint>(observer, spy, { maximizer: 'nature' }), perceivePoint);
  await predictor.predict(d, samples[samples.length - 1].state);
  const rows = seen[0].split('\n');
  assert.equal(rows[0], samples[samples.length - 1].state.table.split('\n')[0], 'the header');
  assert.equal(rows[rows.length - 1], samples[samples.length - 1].state.table.split('\n').pop(), 'down to the present row');
  assert.ok(seen[0].length < 4000);
});

test('--sampling: the grid repeats its launches every attempt; free draws new ones', () => {
  const ids = (sampling: 'grid' | 'free', attempt: number) => trialLaunches(spec, { sampling, attempt, inView: 3, beyond: 1 }).map((t) => t.launch.pos.join(','));
  assert.deepEqual(ids('grid', 1), ids('grid', 2));
  assert.notDeepEqual(ids('free', 1), ids('free', 2));
});
