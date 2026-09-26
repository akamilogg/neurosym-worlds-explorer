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
  /* The law at an instant scores what the hidden law itself scores; the rest of its miss is not noise (the noise floor is
     small) but the second difference over two rows, which departs from the law where the pull changes within a row. */
  assert.ok(Math.abs(r.error - r.reference!) < 0.02 * r.reference! + 1e-3, 'the exact law scores the reference: ' + r.error + ' vs ' + r.reference);
  assert.ok(r.floor! < 0.03 && r.floor! < r.reference!, 'noise floor ' + r.floor + ' below the hidden law\'s own miss ' + r.reference);
  assert.ok(r.error < 0.2, 'against what was observed: ' + r.error);
  /* One question per distinct observation: two components share it, and points that measure the same share the answer. */
  const distinct = new Set(samples.map((x) => observer.observe(x.state, exact.observations).vector)).size;
  assert.equal(calls, distinct, 'two components, one question per distinct observation');
  await testPredictions(samples, async (s) => (await predictor.predict(twoParts, s)).vector);
  assert.equal(calls, distinct, 'the same points again: every answer from the cache');
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

test('a magnitude in code: the Judge is never asked for it, the ablation keeps it, and the delegated mode leaves it alone', async () => {
  const codeOnlyLaw: Law = {
    world: 'orbit@1', observations: {}, rules: {},
    components: { toward: { direction: exact.components.toward.direction, magnitude: { kind: 'code', lang: 'js',
      source: '(p) => { ' + last + ' const r = Math.hypot(q.x[i] - s.x[i], q.y[i] - s.y[i]) / ' + spec.frame.scale + '; return ' + K + ' * Math.pow(r, -' + p + '); }' } } }
  };
  assert.deepEqual(checkLaw(codeOnlyLaw).errors, []);
  calls = 0;
  const predictor = new Predictor(new Evaluator<OrbitPoint>(observer, echo, { maximizer: 'nature' }), perceivePoint);
  const r = await testPredictions(samples, async (s) => (await predictor.predict(codeOnlyLaw, s)).vector);
  assert.equal(calls, 0, 'no rule, no question');
  assert.ok(Math.abs(r.error - r.reference!) < 0.02 * r.reference! + 1e-3, 'the law in code scores the hidden law: ' + r.error);
  const pr = await predictor.predict(codeOnlyLaw, samples[0].state);
  assert.equal(pr.evaluation, null);
  assert.equal(pr.components.toward.value, null);
  /* Mixed: a code component and a Judge component; code-only keeps the first and fits the second. */
  const mixed: Law = { ...exact, components: { toward: codeOnlyLaw.components.toward, extra: { ...exact.components.toward, range: [lo * 1e-6, lo * 1e-5] } } };
  assert.deepEqual(checkLaw(mixed).errors, []);
  const fit = fitLawCodeOnly(observer, perceivePoint, mixed, samples);
  assert.deepEqual(Object.keys(fit.coefficients), ['extra']);
  assert.ok((await testPredictions(samples, fit.predict)).error < 0.2);
  assert.deepEqual(delegatedLaw(mixed).components.toward, mixed.components.toward);
  const both = { ...codeOnlyLaw.components.toward, weights: { pull: 1 } };
  assert.match(checkLaw({ ...exact, components: { both } }).errors.join(' '), /weighs no rule/);
});

test('the environment\'s verdict: per axis, in [-1, 1], 0 where the prediction agrees, relative to what happened there', async () => {
  const { scoreOf, scoreRms } = await import('../src/core/predict.ts');
  assert.deepEqual(scoreOf([1, 2], [1, 2]), [0, 0]);
  const far = scoreOf([0.009, 0], [0.01, 0]), near = scoreOf([9, 0], [10, 0]);
  assert.ok(Math.abs(far[0] - near[0]) < 1e-12, 'a 10% miss weighs the same far away and close in');
  assert.ok(far[0] > 0 && scoreOf([0.011, 0], [0.01, 0])[0] < 0, 'the sign says which way it missed');
  assert.ok(scoreOf([100, 0], [1, 0])[0] >= -1 && scoreOf([0, 0], [0, 0]).every((v) => v === 0));
  assert.equal(scoreRms([[0.3, 0.4]]), 0.5);
});
