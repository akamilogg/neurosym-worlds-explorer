import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runBatch, spread, type BatchDefinition } from '../src/orchestra/batch.ts';
import { generateScene, type SceneSpec } from '../src/worlds/particles3d/scene.ts';
import { LabError } from '../src/runtime/lab-runner.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';


/* SPEC-ORQUESTADOR R2: a batch of runs, compared by condition from the researchers' findings; cut and resumed without
   running again what ended. The world is particles3d@1 with a stand-in for Blender whose dynamics is known. */

function fakeSimulate(body: { scene: { engine: { timestep: number }; fields: { type: string; location: number[]; strength: number }[]; particles: { location: number[]; velocity: number[]; mass: number }[] }; frames: number }) {
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
const NAIVE = '(p) => { const o = {}; const i = p.t.length - 1; for (const n of p.names) { const s = p.series[n]; if (s.x[i] !== null) o[n] = [2 * s.x[i] - s.x[i - 1], 2 * s.y[i] - s.y[i - 1], 2 * s.z[i] - s.z[i - 1]]; } return o; }';

/** System 2 standing in: with instruments it knows the law; without them (the other condition) it guesses. */
const world: FetchLike = async (url, init) => {
  if (url.includes('/simulate')) { const text = JSON.stringify(fakeSimulate(JSON.parse(String(init.body)))); return { ok: true, status: 200, text: async () => text, headers: { get: () => null } }; }
  const b = JSON.parse(String(init.body));
  const sys = b.messages[0].content as string, raw = userOf(b);
  const user = sys.startsWith('You grade') ? {} : JSON.parse(raw);
  const content = sys.startsWith('You grade') ? { grades: [{ id: 'field1', grade: 'exact' }], false_beliefs: [], form: 'compact', form_evidence: 'e' }
    : 'task' in user ? { rationale: 'r', beliefs: [{ id: 'b', stance: 'keep', why: 'w' }], lessons: ['l'], next_experiment: 'n' }
    : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: 'steps_left' in user ? knownLaw(generateScene(1, 1, 'A')) : NAIVE, validate: true,
      beliefs: [{ id: 'b', stance: user.round === 1 ? 'new' : 'keep', statement: 's', evidence: [] }], lessons: ['l'] };
  const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
  return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
};
const common = ['--level', '1', '--condition', 'A', '--attempts', '2', '--flat', '--no-reflection', '--service', 'http://fake.test'];
const DEF: BatchDefinition = { id: 'demo', concurrency: 1, runs: [
  { id: 'tools-1', lab: 'particles3d', condition: 'instruments', args: ['--seed', '1', ...common] },
  { id: 'tools-2', lab: 'particles3d', condition: 'instruments', args: ['--seed', '1', ...common] },
  { id: 'none-1', lab: 'particles3d', condition: 'no instruments', args: ['--seed', '1', ...common, '--tools', 'none'] },
  { id: 'none-2', lab: 'particles3d', condition: 'no instruments', args: ['--seed', '1', ...common, '--tools', 'none'] }
] };
const llm = { url: 'http://system2.test/chat', model: 'stand-in' };

test('a batch: its runs, a table by condition from the researchers\' findings, an audit apart', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-'));
  const report = await runBatch(DEF, { root, llm, fetch: world });
  assert.ok(report.ended);
  const byCondition = Object.fromEntries(report.table.map((c) => [c.condition, c]));
  assert.deepEqual([byCondition.instruments.accepted, byCondition.instruments.runs], [2, 2]);
  assert.deepEqual([byCondition['no instruments'].accepted, byCondition['no instruments'].runs], [0, 2]);
  assert.equal(byCondition.instruments.acceptance_round.median, 1);
  assert.ok(report.audit.find((a) => a.condition === 'instruments')!.rule_recovery.median === 1, 'the audit: the grading, apart');
  assert.ok(fs.existsSync(path.join(report.dir, 'batch.json')) && fs.readFileSync(path.join(report.dir, 'batch.txt'), 'utf8').includes('AUDIT'));
  assert.deepEqual(spread([1, 2, 3, 4, 100]), { median: 3, q1: 2, q3: 4 });
});

test('a batch cut and resumed: what ended is not run again, what was cut is resumed, and the table is the same', async () => {
  const straight = await runBatch(DEF, { root: fs.mkdtempSync(path.join(os.tmpdir(), 'batch-')), llm, fetch: world });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-'));
  const controller = new AbortController();
  /* Stopped as the second run starts. */
  const cut = await runBatch(DEF, { root, llm, fetch: world, signal: controller.signal, print: (l) => { if (/tools-2 \[instruments\] started/.test(l)) controller.abort(); } });
  assert.equal(cut.ended, undefined);
  assert.deepEqual(cut.runs.map((r) => r.status), ['accepted', 'cancelled', 'not run', 'not run']);
  let asked = 0;
  const counting: FetchLike = async (url, init) => { if (!url.includes('/simulate')) asked++; return world(url, init); };
  const resumed = await runBatch(DEF, { root, llm, fetch: counting });
  assert.ok(resumed.ended);
  assert.match(resumed.runs[1].journal!, /tools-2\.r1\.json$/, 'the cut run resumed as a run derived from it');
  assert.deepEqual(resumed.table, straight.table);
  assert.ok(asked < 12, 'the ended run was not run again');
  await assert.rejects(runBatch({ id: 'bad', runs: [{ id: 'x', lab: 'nowhere', condition: 'c' }] }, { root, llm }), (e) => e instanceof LabError && /no laboratory nowhere/.test(e.message));
});
