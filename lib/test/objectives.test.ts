import test from 'node:test';
import assert from 'node:assert/strict';
import { gridObjective, GRID_ANSWER, GRID_VERDICT, type GridEpisode } from '../src/worlds/grid/objective.ts';
import { orbitObjective, orbitVerdict, ORBIT_ANSWER } from '../src/worlds/orbit/objective.ts';
import { GRID_INTERFACE } from '../src/learn/explorer.ts';
import { ORBIT_INTERFACE, lawExplorerSystem } from '../src/learn/law-explorer.ts';
import { generateOrbit } from '../src/worlds/orbit/index.ts';
import { predictionSamples, trialLaunches, type OrbitPoint } from '../src/worlds/orbit/predict.ts';
import type { Place } from '../src/learn/objective.ts';
import type { Vec2 } from '../src/core/predict.ts';

const lab: Place = { id: 'lab1', role: 'laboratory', seen: true };

test('the interfaces open with their objective\'s form of the answer and of a verdict', () => {
  assert.deepEqual(GRID_INTERFACE.lines.slice(0, 3), [...GRID_ANSWER.form, ...GRID_VERDICT]);
  assert.deepEqual(ORBIT_INTERFACE.lines.slice(0, 2), [...ORBIT_ANSWER.form, ...orbitVerdict()]);
  assert.doesNotMatch(lawExplorerSystem(), /answered again/);
  assert.match(lawExplorerSystem(undefined, { regression: true }), /answered again there by this model/);
});

test('grid: holds when every episode scored 1 and none run again scored less; the verdict is each episode\'s score', async () => {
  const o = gridObjective<string, Place, number[]>({
    casesIn: (_p, c) => [c.round, c.round + 1],
    play: async (model, place, cases, c) => ({ episodes: cases.map((k, i): GridEpisode => ({ place: place.id, ...(c.record ? { episode: 'g' + k } : {}), score: model === 'good' ? 1 : i ? -1 : 1 })) })
  });
  const out = await o.run('good', [{ place: lab, cases: o.casesIn(lab, { round: 1, attempt: 1, purpose: 'check', index: 0 }) }], { round: 1, attempt: 1, purpose: 'check' });
  const good = out.byPlace[0];
  assert.equal(o.holds(good, { place: lab }), true);
  assert.deepEqual(o.view(good, lab), { episodes: [{ episode: 'g1', score: 1 }, { episode: 'g2', score: 1 }] });
  const rerun = await o.run('bad', [{ place: lab, cases: [1, 2] }], { round: 2, attempt: 2, purpose: 'rerun' });
  assert.equal(rerun.byPlace[0][0].episode, undefined, 'a rerun is not the learner\'s');
  const r = { before: good, now: rerun.byPlace[0] };
  assert.deepEqual(o.rerunView!(r, lab), { went_up: 0, went_down: 1, changed: [{ episode: 'g2', before: 1, now: -1 }] });
  assert.equal(o.holds(good, { place: lab, rerun: r }), false);
});

test('orbit: the verdict per point, the criterion per band against the noise of what is observed, and the regression', async () => {
  const { spec } = generateOrbit(3, 1);
  const tr = trialLaunches(spec, { sampling: 'grid', attempt: 1, inView: 3, beyond: 1 });
  const samples = predictionSamples(spec, tr, { every: 8 }).map((s, i) => ({ ...s, ref: 'c' + (i % 4) + '@' + s.state.row }));
  const o = orbitObjective<'truth' | 'nothing', Place>({
    casesIn: () => ({ samples, noise: [{ variance: 1e-6, weight: 1 }] }),
    predict: async (m, state: OrbitPoint) => { const s = samples.find((x) => x.state === state)!; return (m === 'truth' ? s.reference! : [0, 0]) as Vec2; },
    launchOf: (e) => ({ launched: e }), accept: 2, precision: 0.01, regression: true
  });
  const run = async (m: 'truth' | 'nothing') => (await o.run(m, [{ place: lab, cases: o.casesIn(lab, { round: 1, attempt: 1, purpose: 'check', index: 0 }) }], { round: 1, attempt: 1, purpose: 'check' })).byPlace[0];
  const truth = await run('truth'), nothing = await run('nothing');
  assert.equal(o.holds(truth, { place: lab }), true, 'the hidden law holds');
  assert.equal(o.holds(nothing, { place: lab }), false, 'predicting nothing does not');
  const view = o.view(truth, lab) as { episodes: { episode: string; from: unknown; points: { verdict: number[] }[] }[] };
  assert.deepEqual(view.episodes.map((e) => e.episode).sort(), ['c0', 'c1', 'c2', 'c3']);
  assert.deepEqual(view.episodes[0].from, { launched: view.episodes[0].episode });
  assert.ok(view.episodes.every((e) => e.points.every((p) => p.verdict.length === 2 && p.verdict.every((v) => Math.abs(v) <= 1))));
  assert.equal(o.holds(truth, { place: lab, rerun: { before: truth, now: nothing } }), false, 'it must still hold on the previous check');
  assert.deepEqual(o.rerunView!({ before: nothing, now: truth }, lab), { points: truth.length, your_model_holds_on_them: true });
});
