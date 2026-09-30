import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { fromPercept, generateScene, placeScene, toPercept, velocityFromPercept, type SceneSpec } from '../src/worlds/particles3d/scene.ts';
import { observedNoiseVariance, perceiveEpisode, perceiveP3, pointAt } from '../src/worlds/particles3d/world.ts';
import { appendRow, p3Objective, readAnswer, type P3Case } from '../src/worlds/particles3d/objective.ts';
import { parseP3Act } from '../src/worlds/particles3d/interface.ts';
import { particles3dLab, priorWords } from '../src/worlds/particles3d/lab.ts';
import { findBlender, startBlenderService } from '../src/worlds/particles3d/blender.ts';
import { mulberry32 } from '../src/worlds/grid/gen.ts';
import type { FetchLike } from '../src/core/net.ts';

/* SPEC-MUNDO-3D: particles3d@1, a 3D world simulated by Blender. */

test('scenes: by level and condition, from the seed; the family keeps the laws and moves the sources', () => {
  assert.deepEqual(generateScene(4, 3, 'B'), generateScene(4, 3, 'B'));
  const kinds = (l: number, c: 'A' | 'B' | 'C') => generateScene(1, l, c).fields.map((f) => f.type);
  assert.deepEqual(kinds(1, 'A'), ['FORCE']);
  assert.deepEqual(kinds(1, 'C'), ['TEXTURE']);
  assert.ok(['DRAG', 'VORTEX', 'MAGNET'].includes(kinds(3, 'A')[1]));
  assert.deepEqual(kinds(6, 'B'), ['HARMONIC', 'TURBULENCE']);
  const a = generateScene(1, 1, 'A');
  assert.deepEqual([a.frame.rot, a.frame.scale, a.frame.tau, a.engine.integrator], [[1, 0, 0, 0, 1, 0, 0, 0, 1], 1, 0.04, 'MIDPOINT']);
  assert.equal(a.fields[0].falloff, undefined, 'condition A: Blender\'s field as it comes');
  const b = generateScene(1, 1, 'B');
  const r = b.frame.rot;
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(r[3 * i] ** 2 + r[3 * i + 1] ** 2 + r[3 * i + 2] ** 2 - 1) < 1e-9, 'a rotation');
  assert.ok(b.fields[0].falloff && b.fields[0].falloff.power % 1 !== 0);
  const p = placeScene(b, 2);
  assert.deepEqual([p.engine, p.frame.rot, p.frame.scale, p.fields.map((f) => ({ ...f, location: null }))], [b.engine, b.frame.rot, b.frame.scale, b.fields.map((f) => ({ ...f, location: null }))]);
  assert.notDeepEqual(p.fields[0].location, b.fields[0].location);
  const four = generateScene(2, 4, 'A');
  assert.notDeepEqual(placeScene(four, 1).bodies, four.bodies, 'level 4: hidden properties drawn anew in each place');
  assert.deepEqual(placeScene(generateScene(2, 2, 'A'), 1).bodies, generateScene(2, 2, 'A').bodies);
  assert.equal(new Set([...a.markers.map((m) => m.name), ...a.bodies.map((x) => x.name)]).size, a.markers.length + a.bodies.length, 'every column its own name');
});

test('the frame: Blender\'s coordinates and the learner\'s, both ways; a velocity in the table\'s units', () => {
  const s = generateScene(3, 2, 'B');
  const w = [0.3, -1.2, 2.5];
  const back = fromPercept(s.frame, toPercept(s.frame, w));
  back.forEach((v, i) => assert.ok(Math.abs(v - w[i]) < 1e-9));
  /* A velocity of the table moves a point by v·tau per row: in Blender, by v_w·timestep. */
  const vp = [1, 2, -0.5];
  const vw = velocityFromPercept(s.frame, s.engine, vp);
  const moved = toPercept(s.frame, w.map((x, i) => x + vw[i] * s.engine.timestep)).map((q, i) => q - toPercept(s.frame, w)[i]);
  moved.forEach((d, i) => assert.ok(Math.abs(d - vp[i] * s.frame.tau) < 1e-9));
});

test('perception: columns in order of their names, markers that do not move, the noise estimated from them', () => {
  const s = generateScene(1, 2, 'A');
  const starts = s.bodies.map((b, i) => ({ name: b.name, location: [i, 0, 0] as [number, number, number], velocity: [0, 0, 0] as [number, number, number] }));
  const rows = Array.from({ length: 40 }, (_, f) => starts.map((st) => [st.location[0] + 0.01 * f, 0, 0]));
  const quiet = perceiveEpisode(s, starts, rows, 0, mulberry32(1), 'the environment');
  assert.deepEqual(quiet.names, [...quiet.names].sort());
  const m = quiet.names.indexOf(s.markers[0].name);
  assert.deepEqual(quiet.rows[0][m], quiet.rows[39][m]);
  assert.equal(observedNoiseVariance(quiet), 0);
  const noisy = perceiveEpisode(s, starts, rows, 0.001, mulberry32(2), 'the environment');
  const sd = 0.001 * s.region * s.frame.scale;
  assert.ok(Math.abs(Math.sqrt(observedNoiseVariance(noisy)) / sd - 1) < 0.3, 'the markers tell the noise');
  const p = perceiveP3(pointAt(noisy, 5));
  assert.equal(p.series[s.bodies[0].name].x.length, 6);
});

test('an act: launches by column name; parameters checked', () => {
  assert.deepEqual(parseP3Act({ launch: [{ name: 'B', x: 1, y: 2, z: 3, vx: 0.5 }] }), { launch: [{ name: 'B', x: 1, y: 2, z: 3, vx: 0.5, vy: 0, vz: 0 }] });
  assert.match(parseP3Act({ launch: [{ name: 'B', x: 1, y: 2, z: 3 }, { name: 'B', x: 0, y: 0, z: 0 }] }) as string, /at most once/);
  assert.match(parseP3Act({}) as string, /launch/);
  assert.deepEqual(priorWords('uses a Blender force field with RK4, like gravity and Coulomb'), { engine: ['blender', 'force field', 'rk4'], physics: ['gravity', 'coulomb'] });
});

/* --- A world with a known dynamics, for the plumbing: a stand-in for Blender that integrates FORCE fields (constant
   pull, divided by the mass) with semi-implicit Euler. The law that knows it holds; the laws that know nothing do not. */
function fakeSimulate(body: { scene: { engine: { timestep: number }; fields: { type: string; location: number[]; strength: number }[]; particles: { location: number[]; velocity: number[]; mass: number }[] }; frames: number }): { rows: number[][][] } {
  const dt = body.scene.engine.timestep;
  const ps = body.scene.particles.map((p) => ({ x: [...p.location], v: [...p.velocity], m: p.mass }));
  const rows = [ps.map((p) => [...p.x])];
  for (let f = 1; f < body.frames; f++) {
    for (const p of ps) {
      const a = [0, 0, 0];
      for (const fd of body.scene.fields.filter((x) => x.type === 'FORCE')) {
        const d = p.x.map((v, k) => v - fd.location[k]), r = Math.hypot(...d) || 1;
        d.forEach((v, k) => { a[k] += (fd.strength * v) / r / p.m; });
      }
      p.v = p.v.map((v, k) => v + a[k] * dt);
      p.x = p.x.map((v, k) => v + p.v[k] * dt);
    }
    rows.push(ps.map((p) => [...p.x]));
  }
  return { rows };
}

function system2(law: string, asked: Record<string, any>[] = [], first?: string): FetchLike {
  return async (url, init) => {
    if (url.includes('/simulate')) {
      const text = JSON.stringify(fakeSimulate(JSON.parse(String(init.body))));
      return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
    }
    const b = JSON.parse(String(init.body));
    const sys = b.messages[0].content as string, raw = b.messages[b.messages.length - 1].content as string;
    const user = sys.startsWith('You grade') ? {} : JSON.parse(raw);
    if (!sys.startsWith('You grade')) asked.push(user);
    const content = sys.startsWith('You grade') ? { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' }
      : 'task' in user ? { rationale: 'r', beliefs: [{ id: 'b', stance: 'confirm', why: 'w' }], lessons: ['l'], next_experiment: 'n' }
      : !user.investigation?.length && user.round === 1 ? { investigate: [{ view: 'ep1', from: 0, to: 5 }, { act: { launch: [{ name: user.notebook?.episodes?.[0]?.columns?.find((c: string) => c !== 'X') ?? 'A', x: 1, y: 1, z: 1, vx: 0.2 }] } }] }
      : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: first && user.round === 1 ? first : law, validate: true, beliefs: [{ id: 'b', stance: user.round === 1 ? 'new' : 'revise', statement: 's', evidence: ['ep1@4'] }], lessons: ['l'] };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
}

/** The law of the stand-in world, as a learner would write it: the markers are the columns that do not move. */
function knownLaw(spec: SceneSpec): string {
  const s = spec.fields[0].strength, dt = spec.frame.tau;
  return '(p) => { const i = p.t.length - 1, o = {}; const still = p.names.filter((n) => { const s = p.series[n]; return s.x[0] !== null && Math.abs(s.x[i] - s.x[0]) + Math.abs(s.y[i] - s.y[0]) + Math.abs(s.z[i] - s.z[0]) < 0.02; });'
    + ' const mean = (a) => { const v = a.filter((x) => x !== null); return v.reduce((s, x) => s + x, 0) / v.length; };'
    + ' const M = still.map((n) => [mean(p.series[n].x), mean(p.series[n].y), mean(p.series[n].z)]);'
    + ' for (const n of p.names) { const s = p.series[n]; if (s.x[i] === null) continue; if (still.includes(n) || i < 1) { o[n] = [s.x[i], s.y[i], s.z[i]]; continue; }'
    + ' const x = [s.x[i], s.y[i], s.z[i]], prev = [s.x[i - 1], s.y[i - 1], s.z[i - 1]], a = [0, 0, 0];'
    + ' for (const m of M) { const d = x.map((v, k) => v - m[k]), r = Math.hypot(...d) || 1; d.forEach((v, k) => { a[k] += ' + s + ' * v / r; }); }'
    + ' o[n] = x.map((v, k) => 2 * v - prev[k] + a[k] * ' + dt * dt + '); } return o; }';
}

const ARGS = ['--seed', '1', '--level', '1', '--condition', 'A', '--attempts', '2', '--flat', '--no-grade', '--no-reflection', '--service', 'http://fake.test'];
const llm = { url: 'http://system2.test/chat', model: 'stand-in' };
const eventsOf = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8')).events as Record<string, any>[];

test('the criterion by horizons, in a world whose dynamics is known: the law that knows it is accepted; the last step repeated is not', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3d-'));
  const spec = generateScene(1, 1, 'A');
  const asked: Record<string, any>[] = [];
  const good = await runLaboratory(particles3dLab, { args: [...ARGS, '--out', path.join(dir, 'good.json')], root: dir, llm, fetch: system2(knownLaw(spec), asked) });
  assert.equal(good.stoppedBy, 'accepted');
  const events = eventsOf(good.journal);
  const check = events.find((e) => e.type === 'check')!;
  assert.deepEqual(check.horizons_asked, [1, 4, 12, 30], 'no chaos here: every horizon is asked');
  assert.ok(events.some((e) => e.type === 'investigation' && e.results.some((r: Record<string, unknown>) => typeof r.table === 'string' && /A\.x|B\.x|C\.x|D\.x/.test(r.table as string))));
  assert.ok(!JSON.stringify(asked).toLowerCase().includes('blender'), 'System 2 is never told the world is Blender');
  const bad = await runLaboratory(particles3dLab, { args: [...ARGS, '--out', path.join(dir, 'bad.json')], root: dir, llm,
    fetch: system2('(p) => { const o = {}; const i = p.t.length - 1; for (const n of p.names) { const s = p.series[n]; o[n] = [2 * s.x[i] - s.x[i - 1], 2 * s.y[i] - s.y[i - 1], 2 * s.z[i] - s.z[i - 1]]; } return o; }') });
  assert.notEqual(bad.stoppedBy, 'accepted');
});

test('the objective asks along the horizons from the model\'s own answers', async () => {
  /* A table moving at constant speed: the last step repeated is exact at every horizon. */
  const names = ['A', 'B'];
  const rows = Array.from({ length: 30 }, (_, i) => [[i * 0.1, 0, 0], [5, 5, 5]]);
  const state = { t: rows.slice(0, 11).map((_, i) => i), names, rows: rows.slice(0, 11) };
  const c: P3Case = { point: 'e@10', episode: 'e', row: 10, state, horizons: [1, 4, 12], targets: { 1: rows[11], 4: rows[14], 12: rows[22] }, bodies: ['A'], noise: 1e-8 };
  let calls = 0;
  const obj = p3Objective({ casesIn: () => [c], answer: async (_m, s) => { calls++; const i = s.rows.length - 1; return { A: s.rows[i][0]!.map((v, k) => 2 * v - s.rows[i - 1][0]![k]), B: s.rows[i][1] }; }, accept: 2, precision: 0.01 });
  const out = await obj.run(null as never, [{ place: { id: 'lab1', role: 'laboratory', seen: true }, cases: [c] }], { round: 1, attempt: 1, purpose: 'check' });
  assert.equal(calls, 12, 'row after row up to the furthest horizon');
  assert.deepEqual(out.byPlace[0].map((r) => r.point), ['e@10+1', 'e@10+4', 'e@10+12']);
  assert.ok(obj.holds(out.byPlace[0], { place: { id: 'lab1', role: 'laboratory', seen: true } }));
  assert.deepEqual(readAnswer({ A: [1, 2] }, names), 'column A must be [x, y, z] (numbers)');
  assert.deepEqual(appendRow(state, { A: [9, 9, 9] }).rows.at(-1), [[9, 9, 9], [5, 5, 5]]);
});

test('cut and resumed, a run is answered what Blender answered before: the same journal', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3d-'));
  /* The right law comes in round 2: the cut falls after round 1. */
  const law = knownLaw(generateScene(1, 1, 'A')), first = '(p) => { const o = {}; const i = p.t.length - 1; for (const n of p.names) { const s = p.series[n]; o[n] = [s.x[i], s.y[i], s.z[i]]; } return o; }';
  const whole = await runLaboratory(particles3dLab, { args: [...ARGS, '--out', path.join(dir, 'whole.json')], root: dir, llm, fetch: system2(law, [], first) });
  assert.equal(whole.stoppedBy, 'accepted');
  const cut = await runLaboratory(particles3dLab, { args: [...ARGS, '--max-tokens', '150', '--out', path.join(dir, 'cut.json')], root: dir, llm, fetch: system2(law, [], first) });
  assert.equal(cut.stoppedBy, 'token_budget');
  /* The service is gone now: only the log can answer what the first run asked. */
  let asked = 0;
  const gone: FetchLike = async (url, init) => { if (url.includes('/simulate')) asked++; return system2(law, [], first)(url, init); };
  const resumed = await runLaboratory(particles3dLab, { args: ['--resume', cut.journal, '--out', path.join(dir, 'resumed.json')], root: dir, llm, fetch: gone });
  assert.equal(resumed.stoppedBy, whole.stoppedBy);
  const strip = (f: string) => JSON.stringify(eventsOf(f).filter((e) => !['start', 'end'].includes(e.type)).map(({ t: _t, ...e }) => e));
  assert.equal(strip(resumed.journal), strip(whole.journal));
  assert.ok(asked > 0, 'after the cut it asks the service again');
});

/* --- With Blender itself (skipped where it is not installed). */
const blender = findBlender();
test('with Blender: its answers are the world; a run goes from exploration to checks along horizons', { skip: !blender && 'Blender is not installed' }, async () => {
  const service = await startBlenderService({ port: 18590 + Math.floor(Math.random() * 9), quiet: true });
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3d-'));
    const real: FetchLike = async (url, init) => (url.includes('/simulate') ? fetch(url, init as never) as never : system2('(p) => { const o = {}; const i = p.t.length - 1; for (const n of p.names) { const s = p.series[n]; if (s.x[i] !== null) o[n] = [2 * s.x[i] - s.x[i - 1], 2 * s.y[i] - s.y[i - 1], 2 * s.z[i] - s.z[i - 1]]; } return o; }')(url, init));
    const r = await runLaboratory(particles3dLab, { args: [...ARGS.slice(0, -1), service.url, '--level', '3', '--condition', 'B', '--out', path.join(dir, 'run.json')], root: dir, llm, fetch: real });
    const events = eventsOf(r.journal);
    const explored = events.filter((e) => e.type === 'exploration_episode');
    assert.equal(explored.length, 3);
    assert.ok(/\d/.test(explored[0].table) && explored[0].table.split('\n').length === 91, 'a table of 90 rows from Blender');
    assert.ok(events.find((e) => e.type === 'check')!.horizons_asked.includes(1));
    assert.notEqual(r.stoppedBy, 'accepted', 'the last step repeated does not explain Blender\'s fields');
  } finally { service.stop(); }
});
