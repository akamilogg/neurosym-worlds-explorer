import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BODY, concentration, noseAt, reflect, runEpisode, sense, turnRate, type BodySpec, type Circuit, type FieldSpec, type Pose } from '../src/worlds/c302closed/body.ts';
import { constantCircuit, decoupledCircuit, splitCircuit, toyCircuit } from '../src/worlds/c302closed/circuits.ts';
import { mulberry32 } from '../src/worlds/grid/gen.ts';

/* SPEC-C302-LAZO-CERRADO L1 (§8): the body and the field, verified by themselves with synthetic circuits in place of c302 -
   before anything is attributed to the circuit. */

const FIELD: FieldSpec = { source: [0, 0], peak: 1, length: 5, shape: 'exp', arena: 15 };
const OPEN: FieldSpec = { ...FIELD, source: [500, 500], arena: 1e6 };
const run = (o: Partial<Parameters<typeof runEpisode>[0]> & { circuit: Circuit }) =>
  runEpisode({ field: OPEN, body: DEFAULT_BODY, start: { x: 0, y: 0, heading: 0 }, durationMs: 10000, dtMs: 5, ...o });
const near = (a: number, b: number, tol: number, what: string) => assert.ok(Math.abs(a - b) <= tol, what + ': ' + a + ' vs ' + b);

test('the declared functions: the field decays, the current saturates between 2.5 and 6 pA and is shared by the swing, the rate is never negative', () => {
  assert.equal(concentration(FIELD, [0, 0]), 1);
  assert.ok(concentration(FIELD, [5, 0]) < concentration(FIELD, [1, 0]));
  near(concentration({ ...FIELD, shape: 'gauss' }, [5, 0]), Math.exp(-0.5), 1e-12, 'gaussian at one length');
  const lo = sense(DEFAULT_BODY, 0, 0), hi = sense(DEFAULT_BODY, 1e9, 0);
  near(lo.left + lo.right, 2.5, 1e-9, 'no odor');
  near(hi.left + hi.right, 6, 1e-6, 'saturated');
  const swing = sense(DEFAULT_BODY, 1, 1000);
  assert.ok(swing.left > swing.right, 'half a swing in (it starts at the right), the head is on the left: the left takes more');
  assert.equal(turnRate(DEFAULT_BODY, -5), 0);
  assert.equal(turnRate(DEFAULT_BODY, 1e9), DEFAULT_BODY.rate.max);
});

test('the order of a step (§5): the current comes from the nose now; the signals read at the end of a step move the body over the next one', () => {
  const steer: Circuit = { initial: { reorientation: 0, steering: 0 }, step: () => ({ reorientation: 0, steering: 1 }) };
  const e = run({ circuit: steer, durationMs: 15 });
  assert.equal(e.steps[0].c, concentration(OPEN, noseAt(DEFAULT_BODY, { x: 0, y: 0, heading: 0 }, 0)));
  assert.equal(e.steps[1].pose.heading, 0, 'the first step moved by the initial signals (no steering)');
  near(e.steps[2].pose.heading, DEFAULT_BODY.steer.gain * 0.005, 1e-12, 'the second by the signals read at the end of the first');
});

test('constant signals: straight with none; a circle with a steady steering; turns at the rate given, to alternating sides', () => {
  const straight = run({ circuit: constantCircuit({ reorientation: 0, steering: 0 }) });
  near(straight.end.pose.x, DEFAULT_BODY.speed * 10, 1e-9, 'straight');
  near(straight.end.pose.y, 0, 1e-12, 'straight');
  const omega = 0.5;
  const circle = run({ circuit: constantCircuit({ reorientation: 0, steering: omega }), durationMs: Math.round(2 * Math.PI / omega * 1000 / 5) * 5 });
  near(Math.hypot(circle.end.pose.x, circle.end.pose.y), 0, 0.01, 'a whole circle comes back');
  const turning = run({ circuit: constantCircuit({ reorientation: 1, steering: 0 }) });
  const turns = turning.steps.filter((s) => s.turn !== undefined).map((s) => s.turn!);
  assert.ok(turns.length >= 9 && turns.length <= 10, 'a rate of 1 per s with a threshold of 1: about one turn a second (' + turns.length + ')');
  assert.ok(turns.every((t, i) => t === (i % 2 ? -1 : 1) * DEFAULT_BODY.turn.angle), 'by the fixed angle, alternating sides');
});

test('the stochastic body: turns come with probability 1 − exp(−rate·Δ) per step, by angles in their range', () => {
  const body: BodySpec = { ...DEFAULT_BODY, mode: 'stochastic' };
  const e = run({ body, circuit: constantCircuit({ reorientation: 1, steering: 0 }), durationMs: 600000, rnd: mulberry32(7) });
  const turns = e.steps.filter((s) => s.turn !== undefined).map((s) => s.turn!);
  assert.ok(Math.abs(turns.length - 600) < 3 * Math.sqrt(600), 'about 600 in 600 s (' + turns.length + ')');
  assert.ok(turns.every((t) => Math.abs(t) >= body.turn.min && Math.abs(t) <= body.turn.max));
  const left = turns.filter((t) => t > 0).length;
  assert.ok(Math.abs(left - turns.length / 2) < 3 * Math.sqrt(turns.length / 4), 'both sides alike');
});

test('a uniform field: the swing alone gives no drift and no bias of the course (measured, §8.2)', () => {
  for (const gain of [0.5, 1, 2]) {
    const e = run({ field: { ...OPEN, uniform: true }, circuit: splitCircuit(gain), durationMs: 600000 });
    const period = 400, mean = (a: number, b: number) => e.steps.slice(a, b).reduce((s, x) => s + x.pose.heading, 0) / (b - a);
    const first = mean(0, period), last = mean(e.steps.length - period, e.steps.length);
    near(last, first, 1e-4 * gain, 'no drift over 10 minutes (gain ' + gain + ')');
    assert.ok(Math.abs(first) < 0.002 * gain, 'what remains of a bias is the delay of one step: ' + first + ' rad (gain ' + gain + ')');
  }
});

test('symmetry: the scene rotated gives the path rotated; mirrored, with the body\'s mirror image, the path mirrored', () => {
  const start: Pose = { x: 6, y: 2, heading: 2.2 };
  const base = run({ field: { ...OPEN, source: [1, -1] }, circuit: toyCircuit(), start, durationMs: 60000 });
  const a = 0.9, rot = (x: number, y: number): [number, number] => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
  const [sx, sy] = rot(start.x, start.y), [fx, fy] = rot(1, -1);
  const rotated = run({ field: { ...OPEN, source: [fx, fy] }, circuit: toyCircuit(), start: { x: sx, y: sy, heading: start.heading + a }, durationMs: 60000 });
  assert.equal(rotated.steps.length, base.steps.length);
  for (const k of [100, 3000, base.steps.length - 1]) {
    const [x, y] = rot(base.steps[k].pose.x, base.steps[k].pose.y);
    near(rotated.steps[k].pose.x, x, 1e-6, 'rotated x at ' + k);
    near(rotated.steps[k].pose.y, y, 1e-6, 'rotated y at ' + k);
  }
  const mirrored = run({ field: { ...OPEN, source: [1, 1] }, body: { ...DEFAULT_BODY, chirality: -1 }, circuit: toyCircuit(), start: { x: 6, y: -2, heading: -2.2 }, durationMs: 60000 });
  for (const k of [100, 3000, base.steps.length - 1]) {
    near(mirrored.steps[k].pose.x, base.steps[k].pose.x, 1e-6, 'mirrored x at ' + k);
    near(mirrored.steps[k].pose.y, -base.steps[k].pose.y, 1e-6, 'mirrored y at ' + k);
  }
});

/* Starts around the source, 9 mm away, each heading past it. */
const STARTS: Pose[] = Array.from({ length: 12 }, (_, i) => { const a = i * Math.PI / 6; return { x: 9 * Math.cos(a), y: 9 * Math.sin(a), heading: a + Math.PI / 2 }; });

test('actions unrelated to the odor: the path does not depend on where the source is, and reaches it no more than by chance', () => {
  const here = run({ field: FIELD, circuit: decoupledCircuit(3), start: STARTS[0], durationMs: 120000 });
  const there = run({ field: { ...FIELD, source: [-12, 7] }, circuit: decoupledCircuit(3), start: STARTS[0], durationMs: 120000 });
  for (const k of [10, 5000, 20000]) assert.deepEqual(there.steps[k].pose, here.steps[k].pose, 'the same path at ' + k);
  const reached = STARTS.filter((start, i) => run({ field: FIELD, circuit: decoupledCircuit(i + 1), start, durationMs: 600000 }).end.reached).length;
  assert.ok(reached <= 2, 'decoupled, ' + reached + ' of 12 reached the source');
});

test('a toy circuit that navigates reaches the source: the loop works end to end; the walls keep the body in the arena', () => {
  const reached = STARTS.filter((start) => run({ field: FIELD, circuit: toyCircuit(), start, durationMs: 600000 }).end.reached).length;
  assert.ok(reached >= 10, 'the toy circuit, ' + reached + ' of 12');
  const e = run({ field: FIELD, circuit: decoupledCircuit(5), start: { x: 14, y: 0, heading: 0 }, durationMs: 300000 });
  assert.ok(e.steps.every((s) => Math.abs(s.pose.x) <= FIELD.arena && Math.abs(s.pose.y) <= FIELD.arena));
  near(reflect(10, { x: 10.5, y: 0, heading: 0 }).x, 9.5, 1e-12, 'a wall sends it back');
  near(reflect(10, { x: 10.5, y: 0, heading: 0 }).heading, Math.PI, 1e-12, 'its heading mirrored');
});

test('the body blocked: it does not move, and the circuit still smells as the head swings', () => {
  const e = run({ field: FIELD, circuit: toyCircuit(), start: { x: 5, y: 0, heading: 1 }, blocked: true, durationMs: 4000 });
  assert.ok(e.steps.every((s) => s.pose.x === 5 && s.pose.y === 0 && s.pose.heading === 1));
  assert.ok(new Set(e.steps.map((s) => s.left.toFixed(6))).size > 10, 'the current into the sides still changes with the swing');
});

test('the incremental readout: step by step, keeping its filters\' state, exactly c302nav\'s readout over the whole trace', async () => {
  const { Readout } = await import('../src/worlds/c302closed/readout.ts');
  const { signalsOf } = await import('../src/worlds/c302nav/world.ts');
  const rnd = mulberry32(11);
  const n = 600, cells = ['AVAL', 'AVAR', 'AVBL', 'AVBR', 'RIAL', 'RIAR'] as const;
  const calcium = Object.fromEntries(cells.map((c) => [c, Array.from({ length: n }, (_, k) => 1e-8 * (Math.sin(k / 37 + c.length) + rnd()))])) as Record<(typeof cells)[number], number[]>;
  const whole = signalsOf(calcium, 5);
  const r = new Readout(5);
  for (let k = 0; k < n; k++) {
    const s = r.step(Object.fromEntries(cells.map((c) => [c, calcium[c][k]])) as never);
    assert.equal(s.reorientation, whole.reorientation[k], 'reorientation at ' + k);
    assert.equal(s.steering, whole.steering[k], 'steering at ' + k);
  }
});

test('smelling in pulses: none between pulses; a pulse carries what was smelled at its start, held; the windows come from the seed', async () => {
  const { C302_BODY, pulseWindows, Sensor } = await import('../src/worlds/c302closed/body.ts');
  const { STEPS } = await import('../src/worlds/c302nav/stimuli.ts');
  const windows = pulseWindows(C302_BODY.sensing!, 20000);
  assert.ok(STEPS.first.includes(windows[0][0]));
  assert.ok(windows.every(([a, b]) => STEPS.width.includes(b - a)));
  assert.ok(windows.slice(1).every(([a], i) => STEPS.gap.includes(a - windows[i][1])));
  assert.deepEqual(pulseWindows(C302_BODY.sensing!, 20000), windows, 'the same seed, the same windows');
  const e = runEpisode({ field: FIELD, body: C302_BODY, circuit: toyCircuit(), start: { x: 8, y: 1, heading: 2.5 }, durationMs: 20000, dtMs: 5 });
  for (const s of e.steps) {
    const w = windows.find(([a, b]) => a <= s.t && s.t < b);
    if (!w) { assert.deepEqual([s.left, s.right], [0, 0], 'nothing between pulses at ' + s.t); continue; }
    const first = e.steps.find((x) => x.t === w[0])!;
    assert.deepEqual([s.left, s.right], [first.left, first.right], 'held through the pulse at ' + s.t);
  }
  const inside = windows[2];
  const fresh = new Sensor(C302_BODY, 20000, { left: 1, right: 2 }, inside[0] + 10);
  assert.deepEqual(fresh.current(FIELD, { x: 0, y: 0, heading: 0 }, inside[0] + 10), { left: 1, right: 2 }, 'a rollout started inside a pulse goes on with what it carries');
});
