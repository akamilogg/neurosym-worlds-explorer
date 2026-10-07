import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BODY, runEpisode, type FieldSpec, type Signals } from '../src/worlds/c302closed/body.ts';
import { toyCircuit } from '../src/worlds/c302closed/circuits.ts';
import { energyScore, navigationCheck, signalsAt, signalsPoint, type ModelAnswer, type RolloutContext } from '../src/worlds/c302closed/navigation.ts';

/* SPEC-C302-LAZO-CERRADO, the gate before L2: the three contracts - the order and the percept (§5), chance (§6), and the
   evaluation of the navigation (§7) - closed with their tests. */

const FIELD: FieldSpec = { source: [0, 0], peak: 1, length: 5, shape: 'exp', arena: 15 };
const NAMES = { left: 'AWCL', right: 'AWCR' };
const DT = 5;
const episode = runEpisode({ field: FIELD, body: DEFAULT_BODY, circuit: toyCircuit(), start: { x: 8, y: 1, heading: 2.5 }, durationMs: 20000, dtMs: DT });
const ctx: RolloutContext = { field: FIELD, body: DEFAULT_BODY, dtMs: DT, names: NAMES };

/** The circuit itself, as a model of it: replayed over the percept from the start (what a perfect learner would write). */
const oracle: ModelAnswer = async (p) => {
  const c = toyCircuit();
  let s: Signals = c.initial;
  for (let j = 1; j <= p.step; j++) s = c.step(p.inputs.AWCL[j], p.inputs.AWCR[j], DT);
  return s;
};

test('§5: the percept of the facet of signals holds nothing of the body and nothing after its step; indexed as c302nav\'s', async () => {
  const k = 700;
  const p = signalsPoint(episode, k, NAMES, DT);
  assert.deepEqual(Object.keys(p).sort(), ['inputs', 'step', 't']);
  assert.doesNotMatch(JSON.stringify(p), /pose|heading|"x"|"c"/);
  assert.equal(p.t.length, k + 1);
  assert.equal(p.inputs.AWCL.length, k + 1);
  assert.equal(p.inputs.AWCL[0], 0, 'nothing has acted at the start');
  assert.equal(p.inputs.AWCL[k], episode.steps[k - 1].left, 'the current shown at t_k acted over (t_{k−1}, t_k]');
  assert.deepEqual(await oracle(p), signalsAt(episode, k, toyCircuit().initial), 'the signals at t_k are what came of the currents shown');
  assert.deepEqual(signalsPoint(episode, k, NAMES, DT, { remove: ['A-B'] }).changes, { remove: ['A-B'] }, 'an act\'s changes are shown');
});

test('§7: the model in the loop - the circuit itself reproduces the worm\'s course at every horizon, turns included, and beats every baseline', async () => {
  const points = [400, 1600, 2600];
  const r = await navigationCheck(ctx, episode, toyCircuit().initial, points, oracle);
  assert.deepEqual(r.horizons.map((h) => h.horizon), [50, 500, 2000]);
  for (const h of r.horizons) {
    assert.ok(h.model !== null && h.model < 1e-9, 'exact in the deterministic body at ' + h.horizon + ' ms: ' + h.model);
    for (const [name, b] of Object.entries(h.baselines)) assert.ok(b >= 0, name);
    assert.equal(h.turns.rollout_too, h.turns.worm, 'it turns when the worm turns');
    if (h.turns.worm) assert.equal(h.turns.timing_ms, 0);
  }
  assert.ok(r.horizons[2].baselines.straight > 0.01, 'at 2 s, going straight is wrong by more than 10 µm: ' + r.horizons[2].baselines.straight);
  assert.equal(r.holds, true);
});

test('§7: a model that knows nothing is no better than the baselines - it does not hold; one that cannot answer neither', async () => {
  const still: ModelAnswer = async () => ({ reorientation: 0, steering: 0 });
  assert.equal((await navigationCheck(ctx, episode, toyCircuit().initial, [400, 1600], still)).holds, false);
  assert.equal((await navigationCheck(ctx, episode, toyCircuit().initial, [400], async () => null)).holds, false);
});

test('§6: the energy score is the distance with one sample, and rewards a spread that covers what came over a confident miss', () => {
  const y = { x: 0, y: 0, heading: 0 };
  assert.equal(energyScore([{ x: 3, y: 4, heading: 0 }], y), 5);
  const spread = [{ x: 1, y: 0, heading: 0 }, { x: -1, y: 0, heading: 0 }];
  const miss = [{ x: 1, y: 0, heading: 0 }, { x: 1, y: 0, heading: 0 }];
  assert.ok(energyScore(spread, y) < energyScore(miss, y));
});

test('§6: in the stochastic body the model and the baselines are rolled out in replicas, each with its own draws', async () => {
  const body = { ...DEFAULT_BODY, mode: 'stochastic' as const };
  const { mulberry32 } = await import('../src/worlds/grid/gen.ts');
  const e = runEpisode({ field: FIELD, body, circuit: toyCircuit(), start: { x: 8, y: 1, heading: 2.5 }, durationMs: 8000, dtMs: DT, rnd: mulberry32(3) });
  const r = await navigationCheck({ ...ctx, body }, e, toyCircuit().initial, [400], oracle, { horizons: [500], replicas: 4 });
  assert.equal(r.horizons.length, 1);
  assert.ok(r.horizons[0].model !== null && Number.isFinite(r.horizons[0].model));
});

test('§7 with the body for c302 (smelling in pulses): the circuit itself is still exact in the loop, rollouts started inside pulses too', async () => {
  const { C302_BODY } = await import('../src/worlds/c302closed/body.ts');
  const e = runEpisode({ field: FIELD, body: C302_BODY, circuit: toyCircuit(), start: { x: 8, y: 1, heading: 2.5 }, durationMs: 20000, dtMs: DT });
  const r = await navigationCheck({ ...ctx, body: C302_BODY }, e, toyCircuit().initial, [399, 1601, 2603], oracle);
  for (const h of r.horizons) assert.ok(h.model !== null && h.model < 1e-9, h.horizon + ' ms: ' + h.model);
});
