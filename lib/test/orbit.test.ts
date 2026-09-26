import test from 'node:test';
import assert from 'node:assert/strict';
import { drawOrbit, fromPercept, generateOrbit, readTable, simulate, tableSense, toPercept, type OrbitSpec, type Vec2 } from '../src/worlds/orbit/index.ts';
import { accelSamples, fitNewton, noiseFloor, relError, sampleLaunches } from '../src/worlds/orbit/operator.ts';

/* orbit@1, phase P1: the world, its laws by level, the learner's frame, and the table it perceives. */

const close = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

test('a law is a function of (seed, level): the same draw twice, and each level is the kind of law it promises', () => {
  assert.deepEqual(drawOrbit(7, 3), drawOrbit(7, 3));
  assert.deepEqual(generateOrbit(7, 1).spec, generateOrbit(7, 1).spec);
  for (let seed = 1; seed <= 20; seed++) {
    const l1 = drawOrbit(seed, 1).law;
    assert.equal(l1.central.form, 'power');
    assert.ok(l1.central.p < 1.9 || l1.central.p > 2.1, 'never Newton: p = ' + l1.central.p);
    assert.equal(l1.velocity, null);
    const l2 = drawOrbit(seed, 2);
    assert.ok(l2.sources.length === 2 || l2.law.central.massExp !== 0, 'a hidden mass');
    assert.ok(drawOrbit(seed, 3).law.velocity, 'a term in the velocity');
    assert.notEqual(drawOrbit(seed, 4).law.central.form, 'power', 'a pull that is not a power');
  }
  assert.throws(() => drawOrbit(1, 5));
});

test('the integrator keeps the energy of a power law (U = -kM r^(1-p) / (p-1))', () => {
  const { spec } = generateOrbit(3, 1);
  const { k, p } = spec.law.central;
  const energy = (pos: Vec2, vel: Vec2) => (vel[0] ** 2 + vel[1] ** 2) / 2 - k * Math.pow(Math.hypot(pos[0], pos[1]), 1 - p) / (p - 1);
  const v = Math.sqrt(k * Math.pow(5, 1 - p));
  const tr = simulate(spec, 'e', { pos: [5, 0], vel: [0, v * 0.9], mass: 1 });
  assert.equal(tr.ended, 'steps');
  const e0 = energy(tr.states[0].pos, tr.states[0].vel);
  for (const s of tr.states) assert.ok(close(energy(s.pos, s.vel), e0, 1e-6), 'energy drift at t=' + s.t);
});

test('the learner\'s frame: positions and velocities go there and back, and a launch starts where it was asked', () => {
  const { spec } = generateOrbit(5, 1);
  const f = spec.frame;
  const p: Vec2 = [3.2, -1.7], v: Vec2 = [0.4, 0.9];
  const back = fromPercept.pos(f, toPercept.pos(f, p));
  const vback = fromPercept.vel(f, toPercept.vel(f, v));
  for (let i = 0; i < 2; i++) { assert.ok(close(back[i], p[i], 1e-9)); assert.ok(close(vback[i], v[i], 1e-9)); }
  const quiet: OrbitSpec = { ...spec, noise: 0 };
  const asked: Vec2 = toPercept.pos(f, [4, 1]);
  const tr = simulate(quiet, 'l1', { pos: fromPercept.pos(f, asked), vel: fromPercept.vel(f, [0, 0]), mass: 1 });
  const seen = readTable(tableSense(quiet).render(tr));
  const probe = seen.bodies[tableSense(quiet).probeGlyph];
  assert.ok(close(probe.x[0]!, asked[0], 1e-3) && close(probe.y[0]!, asked[1], 1e-3));
});

test('the table says nothing but symbols, t, x, y and numbers; it is the same every time it is read', () => {
  for (const level of [1, 2, 3, 4]) {
    const { spec } = generateOrbit(11, level);
    const sense = tableSense(spec);
    const tr = sampleLaunches(spec, 1, 99, 'view')[0];
    const table = sense.render(tr);
    assert.equal(table, sense.render(tr), 'the noise is seeded: one trajectory, one reading');
    let rest = table;
    for (const g of [...sense.sourceGlyphs, sense.probeGlyph]) rest = rest.split(g).join('');
    assert.match(rest, /^[\d.\-\stxy·]+$/, 'no word, no parameter name, no unit');
    const read = readTable(table);
    assert.deepEqual(read.symbols, [...sense.sourceGlyphs, sense.probeGlyph]);
    assert.equal(read.t.length, tr.states.length);
  }
});

test('--resolution rounds what is perceived; outside the observable region the probe is not seen', () => {
  const { spec } = generateOrbit(2, 1);
  const tr = sampleLaunches(spec, 1, 5, 'view')[0];
  const coarse = readTable(tableSense(spec, { resolution: 0.5 }).render(tr));
  for (const g of coarse.symbols) for (const v of [...coarse.bodies[g].x, ...coarse.bodies[g].y]) if (v !== null) assert.ok(close(v / 0.5, Math.round(v / 0.5), 1e-9));
  const far = simulate(spec, 'far', { pos: [14, 0], vel: [0, 0.3], mass: 1 });
  const glyph = tableSense(spec).probeGlyph;
  assert.equal(readTable(tableSense(spec).render(far)).bodies[glyph].x[0], null);
  assert.notEqual(readTable(tableSense(spec, { window: false }).render(far)).bodies[glyph].x[0], null);
});

test('operator: Newton fits a Newtonian law exactly and misses a generated one; rounding raises the noise floor', () => {
  const { spec } = generateOrbit(4, 1);
  const newtonian: OrbitSpec = { ...spec, law: { ...spec.law, central: { ...spec.law.central, p: 2, k: 5 } } };
  const samples = accelSamples(newtonian, sampleLaunches(newtonian, 10, 1, 'view'), 0, newtonian.window);
  assert.ok(relError(samples, fitNewton(newtonian, samples)) < 1e-9);
  const own = accelSamples(spec, sampleLaunches(spec, 10, 1, 'view'), 0, spec.window);
  assert.ok(relError(own, fitNewton(spec, own)) > 0.03, 'p = ' + spec.law.central.p.toFixed(2) + ' is not Newton');
  assert.ok(noiseFloor(spec, own, 0.5) > noiseFloor(spec, own, 0));
});

test('operator: the law stated in the learner\'s terms is the law the tables show (d = C · r^-p in table units)', async () => {
  const { describeOrbitTruth } = await import('../src/worlds/orbit/describe.ts');
  const { predictionSamples, trialLaunches } = await import('../src/worlds/orbit/predict.ts');
  const { spec } = generateOrbit(3, 1);
  const sense = tableSense(spec);
  const truth = describeOrbitTruth(spec, sense);
  const stated = truth.find((t) => t.id.startsWith('central_'))!.statement;
  const [, C, p] = /size ([\d.e+-]+) · r\^-([\d.]+)/.exec(stated)!.map(Number) as number[];
  const trajectories = trialLaunches(spec, { sampling: 'grid', attempt: 1, inView: 3, beyond: 1 });
  for (const s of predictionSamples(spec, trajectories)) {
    const row = s.state.row;
    const seen = readTable(s.state.table);
    const src = toPercept.pos(spec.frame, spec.sources[0].pos);
    const probe: Vec2 = [seen.bodies[sense.probeGlyph].x[row]!, seen.bodies[sense.probeGlyph].y[row]!];
    const r = Math.hypot(probe[0] - src[0], probe[1] - src[1]);
    const size = Math.hypot(s.reference![0], s.reference![1]);
    assert.ok(close(size, C * Math.pow(r, -p), 0.02 + 5 * spec.noise * spec.frame.scale / r), 'at r = ' + r.toFixed(2) + ': ' + size + ' vs ' + C * Math.pow(r, -p));
  }
  assert.ok(truth.some((t) => t.id === 'launch_property' && /does not matter/.test(t.statement)));
  assert.ok(truth.some((t) => t.id === 'velocity_term' && /does not depend on how fast/.test(t.statement)));
});
