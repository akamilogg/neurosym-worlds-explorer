import test from 'node:test';
import assert from 'node:assert/strict';
import { Observer } from '../src/core/observer.ts';
import { Evaluator } from '../src/core/evaluate.ts';
import { checkLaw, Predictor, testPredictions, type Law } from '../src/core/predict.ts';
import { delegatedLaw, fitLawCodeOnly } from '../src/learn/law-ablation.ts';
import { generateOrbit } from '../src/worlds/orbit/index.ts';
import { answerAsDeparture, orbitPointWorld, perceivePoint, predictionSamples, trialLaunches, type OrbitPoint } from '../src/worlds/orbit/predict.ts';
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
const last = "const g = p.symbols, i = p.t.length - 1, s = p.series[g[0]], q = p.series[g[g.length - 1]];";
/* The model answers the NEXT row of the last pair: repeating its last step, plus the departure the law gives, along the line
   to the source, of the size the Judge carries (V, the echo of `mag`) placed on a log scale - all written by the learner. */
const exact: Law = {
  world: 'orbit@1',
  observations: {
    mag: { definition: 'the departure the law predicts, as a fraction of the log range', range: [0, 1], spec: { kind: 'code', lang: 'js',
      source: '(p) => { ' + last + ' const r = Math.hypot(q.x[i] - s.x[i], q.y[i] - s.y[i]) / ' + spec.frame.scale + '; const m = ' + K + ' * Math.pow(r, -' + p + ');'
        + ' return (Math.log(m) - Math.log(' + lo + ')) / (Math.log(' + hi + ') - Math.log(' + lo + ')); }' } }
  },
  rules: { pull: { type: 'noul', used_as: 'value', instructions: '{{mag}}', criteria: { yes: '', no: '' } } },
  weights: { pull: 1 },
  output: { kind: 'code', lang: 'js', source: '(p, m) => { ' + last + ' const size = Math.exp(Math.log(' + lo + ') + m.V * (Math.log(' + hi + ') - Math.log(' + lo + ')));'
    + ' const dx = s.x[i] - q.x[i], dy = s.y[i] - q.y[i], n = Math.hypot(dx, dy);'
    + ' return { answer: [2 * q.x[i] - q.x[i - 1] + size * dx / n, 2 * q.y[i] - q.y[i - 1] + size * dy / n], size }; }' }
};
const predictorWith = (judge: Judge) => new Predictor(new Evaluator<OrbitPoint>(observer, judge, { maximizer: 'nature' }), perceivePoint, { answer: answerAsDeparture });

test('a model is checked before it is used: it needs rules or an output', () => {
  assert.deepEqual(checkLaw(exact).errors, []);
  assert.match(checkLaw({ world: 'orbit@1', observations: {}, rules: {}, weights: {} }).errors.join(' '), /needs rules or an output/);
  assert.match(checkLaw({ ...exact, weights: { nothing: 1 } }).errors.join(' '), /weight "nothing" has no value rule/);
});

test('a point holds only what is perceived; the target is read from the table, and the noise alone keeps even the truth off it', () => {
  for (const s of samples) assert.deepEqual(Object.keys(s.state).sort(), ['row', 'table']);
  const truthVsTarget = samples.reduce((n, s) => n + (s.truth![0] - s.target[0]) ** 2 + (s.truth![1] - s.target[1]) ** 2, 0);
  const size = samples.reduce((n, s) => n + s.target[0] ** 2 + s.target[1] ** 2, 0);
  assert.ok(Math.sqrt(truthVsTarget / size) < 0.2, 'the truth is close to what is observed');
  assert.ok(samples.some((s) => s.band === 'outer') && samples.some((s) => s.band === 'view'));
});

test('the exact law, written in the learner\'s frame as the next row, predicts to the noise; the Judge is asked once per point', async () => {
  calls = 0;
  const predictor = predictorWith(echo);
  const r = await testPredictions(samples, async (s) => (await predictor.predict(exact, s)).compared);
  assert.deepEqual(r.failed, []);
  /* The law at an instant scores what the hidden law itself scores; the rest of its miss is not noise (the noise floor is
     small) but the second difference over two rows, which departs from the law where the pull changes within a row. */
  assert.ok(Math.abs(r.error - r.reference!) < 0.02 * r.reference! + 1e-3, 'the exact law scores the reference: ' + r.error + ' vs ' + r.reference);
  assert.ok(r.floor! < 0.03 && r.floor! < r.reference!, 'noise floor ' + r.floor + ' below the hidden law\'s own miss ' + r.reference);
  assert.ok(r.error < 0.2, 'against what was observed: ' + r.error);
  /* One question per distinct observation: points that measure the same share the answer. */
  const distinct = new Set(samples.map((x) => observer.observe(x.state, exact.observations).vector)).size;
  assert.equal(calls, distinct, 'one question per distinct observation');
  await testPredictions(samples, async (s) => (await predictor.predict(exact, s)).compared);
  assert.equal(calls, distinct, 'the same points again: every answer from the cache');
  /* A different output asks the Judge nothing new: the cache is keyed on the observations and the rules only. */
  const halved: Law = { ...exact, output: { ...exact.output!, source: exact.output!.source.replace('size * dx / n', '0.5 * size * dx / n') } };
  await testPredictions(samples, async (s) => (await predictor.predict(halved, s)).compared);
  assert.equal(calls, distinct, 'a new output, no new question');
  /* What the output chose to show comes back with the answer. */
  const pr = await predictor.predict(exact, samples[3].state);
  assert.ok(typeof pr.parts.size === 'number' && Array.isArray(pr.answer) && pr.V !== null && pr.rules.pull === pr.V);
});

test('ablations: code alone carries a law written in code; a constant per rule is the floor', async () => {
  const predictor = predictorWith(echo);
  const codeOnly = fitLawCodeOnly(predictor, exact, samples);
  const flat = fitLawCodeOnly(predictor, exact, samples, { flat: true });
  const c = await testPredictions(samples, codeOnly.predict);
  const f = await testPredictions(samples, flat.predict);
  assert.ok(c.error < f.error, 'code ' + c.error + ' vs flat ' + f.error);
  assert.ok(c.error < 0.5, 'a logistic reading of mag stands in for the echo: ' + c.error);
  assert.deepEqual(Object.keys(codeOnly.coefficients.pull), ['constant', 'mag']);
  assert.ok(codeOnly.coefficients.pull.mag > 0, 'the reading grows with mag: ' + JSON.stringify(codeOnly.coefficients));
});

test('the delegated mode: the Judge reads the latest rows of the table as text; the output still reads the learner\'s observations', async () => {
  const d = delegatedLaw(exact);
  assert.deepEqual(checkLaw(d).errors, []);
  assert.doesNotMatch(d.rules.pull.instructions, /\{\{/, 'no citation of an observation the Judge does not get');
  const seen: string[] = [];
  const spy: Judge = { id: 'spy', async judge(r) { seen.push(r.texts?.observed_table ?? ''); return { pull: { value: 0.5, confidence: null } }; } };
  const predictor = predictorWith(spy);
  const pr = await predictor.predict(d, samples[samples.length - 1].state, { measure: exact.observations });
  const rows = seen[0].split('\n');
  assert.equal(rows[0], samples[samples.length - 1].state.table.split('\n')[0], 'the header');
  assert.equal(rows[rows.length - 1], samples[samples.length - 1].state.table.split('\n').pop(), 'down to the present row');
  assert.ok(seen[0].length < 4000);
  assert.ok(typeof pr.observations.mag === 'number', 'the output reads what the learner measured');
});

test('--sampling: the grid repeats its launches every attempt; free draws new ones', () => {
  const ids = (sampling: 'grid' | 'free', attempt: number) => trialLaunches(spec, { sampling, attempt, inView: 3, beyond: 1 }).map((t) => t.launch.pos.join(','));
  assert.deepEqual(ids('grid', 1), ids('grid', 2));
  assert.notDeepEqual(ids('free', 1), ids('free', 2));
});

test('a law in code only: the Judge is never asked, and there is nothing to ablate', async () => {
  const codeOnlyLaw: Law = {
    world: 'orbit@1', observations: {}, rules: {}, weights: {},
    output: { kind: 'code', lang: 'js', source: '(p) => { ' + last + ' const r = Math.hypot(q.x[i] - s.x[i], q.y[i] - s.y[i]) / ' + spec.frame.scale
      + '; const size = ' + K + ' * Math.pow(r, -' + p + '), dx = s.x[i] - q.x[i], dy = s.y[i] - q.y[i], n = Math.hypot(dx, dy);'
      + ' return [2 * q.x[i] - q.x[i - 1] + size * dx / n, 2 * q.y[i] - q.y[i - 1] + size * dy / n]; }' }
  };
  assert.deepEqual(checkLaw(codeOnlyLaw).errors, []);
  calls = 0;
  const predictor = predictorWith(echo);
  const r = await testPredictions(samples, async (s) => (await predictor.predict(codeOnlyLaw, s)).compared);
  assert.equal(calls, 0, 'no rule, no question');
  assert.ok(Math.abs(r.error - r.reference!) < 0.02 * r.reference! + 1e-3, 'the law in code scores the hidden law: ' + r.error);
  const pr = await predictor.predict(codeOnlyLaw, samples[0].state);
  assert.equal(pr.evaluation, null);
  assert.equal(pr.V, null);
  assert.deepEqual(fitLawCodeOnly(predictor, codeOnlyLaw, samples).coefficients, {});
  /* An answer that is not a pair is refused with the reason. */
  const wrong: Law = { ...codeOnlyLaw, output: { kind: 'code', lang: 'js', source: '(p) => 3' } };
  await assert.rejects(predictor.predict(wrong, samples[0].state), /must be a pair/);
});

test('a formula\'s output is the value in the Evaluator (kept to [0, 1]); the judgment hash, and so the cache, ignore it', async () => {
  const { formulaHash, judgmentHash, makeFormula } = await import('../src/core/formula.ts');
  const base = makeFormula({ world: 'orbit@1', observations: exact.observations, rules: exact.rules, weights: { pull: 1 } });
  const flipped = makeFormula({ ...base, output: { kind: 'code', lang: 'js', source: '(p, m) => 1 - m.V' } });
  const over = makeFormula({ ...base, output: { kind: 'code', lang: 'js', source: '(p, m) => 2 + m.rules.pull' } });
  assert.equal(judgmentHash(base), judgmentHash(flipped));
  assert.notEqual(formulaHash(base), formulaHash(flipped));
  calls = 0;
  const evaluator = new Evaluator<OrbitPoint>(observer, echo, { maximizer: 'nature' });
  const a = await evaluator.eval(base, samples[5].state);
  const b = await evaluator.eval(flipped, samples[5].state);
  assert.equal(calls, 1, 'one question for both');
  assert.ok(Math.abs(b.value - (1 - a.value)) < 1e-4 && b.composed === a.value);
  assert.equal((await evaluator.eval(over, samples[5].state)).value, 1, 'kept to [0, 1]');
});

test('an output that reads none of the rules answers alone: the Judge is not asked questions nobody reads', async () => {
  const { makeFormula } = await import('../src/core/formula.ts');
  const { OutputRunner } = await import('../src/core/output.ts');
  const runner = new OutputRunner();
  const code = (source: string) => ({ kind: 'code' as const, lang: 'js', source });
  assert.equal(runner.runIfJudgeUnread(code('(p, m) => m.observations.a + 1'), null, { a: 1 })?.answer, 2);
  for (const reads of ['(p, m) => m.rules.x', '(p, m) => m.V', '(p, m) => { try { return m.rules.x; } catch (e) { return 0; } }', '(p, m) => ({ ...m }).observations.a'])
    assert.equal(runner.runIfJudgeUnread(code(reads), null, { a: 1 }), null, reads);
  assert.throws(() => runner.runIfJudgeUnread(code('(p, m) => m.observations.a.b.c'), null, { a: 1 }), 'an error of its own is its own');

  const base = makeFormula({ world: 'orbit@1', observations: exact.observations, rules: exact.rules, weights: { pull: 1 } });
  const ignores = makeFormula({ ...base, output: code('(p, m) => m.observations.mag') });
  const reads = makeFormula({ ...base, output: code('(p, m) => m.rules.pull') });
  calls = 0;
  const evaluator = new Evaluator<OrbitPoint>(observer, echo, { maximizer: 'nature' });
  const alone = await evaluator.eval(ignores, samples[5].state);
  assert.equal(calls, 0, 'not asked');
  assert.equal(alone.provenance, 'code');
  assert.deepEqual(alone.answers, {});
  assert.equal(evaluator.stats.judgeUnread, 1);
  const asked = await evaluator.eval(ignores, samples[5].state, undefined, { askRules: true });
  assert.equal(calls, 1, 'asked when the rules are to be shown');
  assert.equal(asked.value, alone.value, 'the same answer either way');
  assert.ok('pull' in asked.answers);
  await evaluator.eval(reads, samples[6].state);
  assert.equal(calls, 2, 'asked when the output reads them');

  /* The same in the Predictor. */
  calls = 0;
  const predictor = predictorWith(echo);
  const law: Law = { ...exact, output: code('(p, m) => [m.observations.mag, 0]') };
  const pr = await predictor.predict(law, samples[3].state);
  assert.equal(calls, 0);
  assert.equal(pr.evaluation, null);
  assert.deepEqual(pr.rules, {});
  assert.ok(typeof pr.observations.mag === 'number');
  const shown = await predictor.predict(law, samples[3].state, { askRules: true });
  assert.equal(calls, 1);
  assert.deepEqual(shown.compared, pr.compared);
  assert.ok('pull' in shown.rules);
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

test('acceptance by the noise of what is observed: estimated from the motionless sources, a perfect predictor gives about 1, a law 5% off lies far above', async () => {
  const { observedNoiseVariance } = await import('../src/worlds/orbit/predict.ts');
  const trajectories = trialLaunches(spec, { sampling: 'free', attempt: 11, inView: 6, beyond: 3 });
  const variance = observedNoiseVariance(spec, trajectories);
  const expected = 6 * (spec.noise * spec.frame.scale) ** 2;
  assert.ok(Math.abs(variance / expected - 1) < 0.15, 'the sources give the noise of d: ' + variance + ' vs ' + expected);
  const pts = predictionSamples(spec, trajectories);
  const perfect = await testPredictions(pts, (s) => pts.find((x) => x.state === s)!.truth!, { noiseVariance: variance });
  for (const m of Object.values(perfect.chi2!.byBand)) assert.ok(m > 0.3 && m < 1.5, 'noise alone: ' + m);
  const weak = await testPredictions(pts, (s) => { const t = pts.find((x) => x.state === s)!.reference!; return [0.95 * t[0], 0.95 * t[1]]; }, { noiseVariance: variance });
  assert.ok(weak.chi2!.byBand.view > 2, 'a law 5% too weak: ' + weak.chi2!.byBand.view);
  /* With a declared precision of 1%, the hidden law passes with room to spare, a law 1% off passes, one 5% off does not. */
  const opts = { noiseVariance: variance, relativePrecision: 0.01 };
  const hidden = await testPredictions(pts, (s) => pts.find((x) => x.state === s)!.reference!, opts);
  const off1 = await testPredictions(pts, (s) => { const t = pts.find((x) => x.state === s)!.reference!; return [1.01 * t[0], 1.01 * t[1]]; }, opts);
  const off5 = await testPredictions(pts, (s) => { const t = pts.find((x) => x.state === s)!.reference!; return [0.95 * t[0], 0.95 * t[1]]; }, opts);
  for (const b of ['view', 'outer']) assert.ok(hidden.chi2!.byBand[b] < 1.2 && off1.chi2!.byBand[b] < 2, b + ': ' + hidden.chi2!.byBand[b] + ', ' + off1.chi2!.byBand[b]);
  assert.ok(off5.chi2!.byBand.view > 2, '5% off: ' + off5.chi2!.byBand.view);
  assert.equal((await testPredictions(pts, () => [0, 0])).chi2, null, 'no noise estimate, no chi2');
});
