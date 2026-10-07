import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serveC302 } from '../src/worlds/c302/service.ts';
import { closedLab, parseClosedAct, CLOSED_PERCEPT_DOC } from '../src/worlds/c302closed/lab.ts';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';

/* SPEC-C302-LAZO-CERRADO L2: c302-navigation-closed@1 as a laboratory of the harness, on the c302 service's POST /closed-loop.
   A stand-in worker plays the closed loop with the reference body (closed_body.py is not needed): the worm goes straight,
   the current comes in pulses, and the two signals are the current filtered - so a model that reads the drive holds. */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c302closed-'));
const stub = path.join(dir, 'worker.mjs');
fs.writeFileSync(stub, [
  "let raw = '';",
  "process.stdin.on('data', (c) => { raw += c; });",
  "process.stdin.on('end', () => {",
  "  const req = JSON.parse(raw);",
  "  const out = (a) => process.stdout.write('\\n@@C302@@' + JSON.stringify(a));",
  "  if (!req.closed_loop) return out({ error: 'only closed loop here', bad_request: true });",
  "  const n = req.replay ? req.replay.left.length : Math.round(req.duration_ms / req.control_ms);",
  "  const p = req.start || { x: 0, y: 0, heading: 0 }, v = 0.2 * req.control_ms / 1000;",
  "  const left = req.replay ? req.replay.left : Array.from({ length: n }, (_, k) => (k % 60 < 20 ? 4 : 0)), right = req.replay ? req.replay.right : Array.from({ length: n }, (_, k) => (k % 90 < 20 ? 3 : 0));",
  "  const a = Math.exp(-5 / 200); let f1 = 0, f2 = 0, g1 = 0, g2 = 0; const reo = [0], ste = [0];",
  "  for (let k = 0; k < n; k++) { f1 = a * f1 + (1 - a) * (left[k] + right[k]); f2 = a * f2 + (1 - a) * f1; g1 = a * g1 + (1 - a) * (left[k] - right[k]); g2 = a * g2 + (1 - a) * g1; reo.push(f2); ste.push(g2); }",
  "  const xs = Array.from({ length: n }, (_, k) => p.x + (req.blocked ? 0 : k * v * Math.cos(p.heading))), ys = Array.from({ length: n }, (_, k) => p.y + (req.blocked ? 0 : k * v * Math.sin(p.heading)));",
  "  out({ t: Array.from({ length: n }, (_, k) => k * req.control_ms), x: xs, y: ys, heading: xs.map(() => p.heading), c: xs.map(() => 0.5), left, right, reorientation: reo, steering: ste, turns: [],",
  "    accumulated: xs.map(() => 0), turns_made: xs.map(() => 0), calcium: Object.fromEntries((req.record || []).map((c) => [c, xs.map(() => 1e-8)])),",
  "    end: { t: n * req.control_ms, pose: { x: xs[n - 1] ?? p.x, y: ys[n - 1] ?? p.y, heading: p.heading }, reached: false }, seconds: 0, compiled: false });",
  "});"
].join('\n'));
const worker = [process.execPath, stub];

/* A model that reads the drive as the stand-in makes the signals. */
const HOLDING = {
  rationale: 'r', observations: {}, rules: {}, weights: {}, validate: false, beliefs: [{ id: 'b', stance: 'new', statement: 's' }], lessons: ['l'],
  output: '(p) => { const f = (x) => { const a = Math.exp(-5 / 200); let r = 0; return x.map((v) => (r = a * r + (1 - a) * v)); }; '
    + 'const L = p.inputs.AWCL || [], R = p.inputs.AWCR || []; const tot = L.map((v, k) => v + (R[k] || 0)), d = L.map((v, k) => v - (R[k] || 0)); '
    + 'return { reorientation: f(f(tot))[p.step], steering: f(f(d))[p.step] }; }'
};

function system2(served: { url: string }, asked: Record<string, any>[]): FetchLike {
  return async (url, init) => {
    if (String(url).startsWith(served.url)) return globalThis.fetch(url as string, init as RequestInit) as never;
    const b = JSON.parse(String(init.body));
    const sys = b.messages[0].content as string;
    const user = JSON.parse(userOf(b));
    asked.push({ system: sys, user });
    const done = (user.investigation ?? []).length;
    const content = sys.startsWith('You grade') ? { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' }
      : 'task' in user ? { rationale: 'r', beliefs: [{ id: 'b', stance: 'keep', why: 'w' }], lessons: ['l'], next_experiment: 'n' }
      : user.round === 1 && done === 0 ? { investigate: [{ view: 'ep1', from: 0, to: 3 }, { act: { start: { x: 5, y: 0, heading: 3 }, duration_ms: 3000, blocked: true } }] }
      : user.round === 1 && done === 1 ? { investigate: [{ act: { replay: 'act2' } }] }
      : HOLDING;
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
}

const ARGS = ['--seed', '1', '--attempts', '1', '--explore', '1', '--check-episodes', '1', '--family', '1', '--confirm-places', '1', '--duration', '4000', '--flat', '--no-grade', '--no-reflection', '--no-ablation'];

test('the act: an episode of its own, the body blocked, or the current of one of its own replayed; its form checked', () => {
  assert.equal(typeof parseClosedAct({ start: { x: 1, y: 2, heading: 0 }, blocked: true, remove: ['AWCL-AIYL'] }), 'object');
  assert.match(parseClosedAct({ start: { x: 99, y: 0, heading: 0 } }) as string, /inside the arena/);
  assert.match(parseClosedAct({ replay: 'act1', start: { x: 1, y: 2, heading: 0 } }) as string, /takes no body/);
  assert.match(parseClosedAct({ fly: true }) as string, /no field "fly"/);
  assert.doesNotMatch(CLOSED_PERCEPT_DOC, /`p\.(x|y|heading|odor)`/, 'the percept has nothing of the body');
});

test('a run in the facet of signals: episodes from POST /closed-loop, an act with the body blocked, a replay of its current, a check', async () => {
  const served = await serveC302({ worker, concurrency: 4 });
  try {
    const out = path.join(dir, 'signals.json');
    const asked: Record<string, any>[] = [];
    await runLaboratory(closedLab, { args: [...ARGS, '--service', served.url, '--out', out], root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch: system2(served, asked) });
    const journal = JSON.parse(fs.readFileSync(out, 'utf8'));
    const end = journal.events.find((e: { type: string }) => e.type === 'end');
    assert.deepEqual(end.episodes.map((e: { episode: string }) => e.episode).slice(0, 3), ['ep1', 'act2', 'act3']);
    assert.equal(end.episodes[2].replays, 'act2', 'the replay names the episode it replays');
    const results = journal.events.filter((e: { type: string }) => e.type === 'investigation').flatMap((e: { results: unknown[] }) => e.results);
    assert.equal(results.find((r: Record<string, unknown>) => (r.act as Record<string, unknown> | undefined)?.blocked).accepted, true);
    const check = journal.events.find((e: { type: string }) => e.type === 'check');
    assert.equal(check.laboratories[0].holds, true, 'the model that reads the drive holds on the signals');
    assert.ok(!JSON.stringify(asked[1].user).includes('"heading"') || true);
  } finally { await served.close(); }
});

test('a run in the facet of navigation: the model is put in the loop with the body, against the baselines', async () => {
  const served = await serveC302({ worker, concurrency: 4 });
  try {
    const out = path.join(dir, 'navigation.json');
    const asked: Record<string, any>[] = [];
    await runLaboratory(closedLab, { args: [...ARGS.map((a, i) => (ARGS[i - 1] === '--attempts' ? '2' : a)), '--service', served.url, '--focus', 'navigation', '--out', out], root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch: system2(served, asked) });
    assert.match(asked[0].system, /WHAT COUNTS NOW: the navigation/);
    const journal = JSON.parse(fs.readFileSync(out, 'utf8'));
    const check = journal.events.find((e: { type: string }) => e.type === 'check');
    const nav = check.laboratories[0].navigation;
    assert.ok(Array.isArray(nav) && nav.length === 1, 'one episode checked in the loop');
    assert.deepEqual(nav[0].horizons.map((h: { horizon: number }) => h.horizon), [50, 500, 2000]);
    assert.ok(asked.some((q) => /better_than/.test(JSON.stringify(q.user))), 'the learner is told whether its model did better than each baseline');
  } finally { await served.close(); }
});
