import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectFiles, projectStatus, runProject, sendProject, compileCriterion, type ProjectOptions } from '../src/orchestra/project.ts';
import { generateScene, type SceneSpec } from '../src/worlds/particles3d/scene.ts';
import type { ChatClient } from '../src/learn/system2.ts';
import type { FetchLike } from '../src/core/net.ts';

/* SPEC-ORQUESTADOR R3, R3b, R4: the project planner - its loop to a computable criterion, the operator's approvals,
   stopping and resuming, and a branch out of a local minimum. World: particles3d@1 with a stand-in for Blender. */

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

/** System 2 standing in: with instruments it knows the law; without them it guesses; stuck unless an operator message
    reaches it (then it tries what the message held up). */
function world(llmCalls: { n: number } = { n: 0 }): FetchLike {
  return async (url, init) => {
    if (url.includes('/simulate')) { const text = JSON.stringify(fakeSimulate(JSON.parse(String(init.body)))); return { ok: true, status: 200, text: async () => text, headers: { get: () => null } }; }
    llmCalls.n++;
    const b = JSON.parse(String(init.body));
    const sys = b.messages[0].content as string, raw = b.messages[b.messages.length - 1].content as string;
    const user = sys.startsWith('You grade') ? {} : JSON.parse(raw);
    const law = user.operator_messages || 'steps_left' in user ? knownLaw(generateScene(1, 1, 'A')) : NAIVE;
    const content = sys.startsWith('You grade') ? { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' }
      : 'task' in user ? { rationale: 'r', beliefs: [{ id: 'b', stance: 'keep', why: 'w' }], lessons: ['l'], next_experiment: 'test whether the acceleration depends on where a column is' }
      : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: law, validate: true,
        beliefs: [{ id: 'b', stance: user.round === 1 ? 'new' : 'keep', statement: 's', evidence: [] }], lessons: ['l'], next_experiment: 'test whether the acceleration depends on where a column is' };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
}
const common = ['--level', '1', '--condition', 'A', '--attempts', '2', '--flat', '--no-reflection', '--service', 'http://fake.test'];

/** The planner standing in: iteration 1 without instruments, iteration 2 with them; a branch of a stuck run when there is one. */
function planner(seen: Record<string, any>[] = [], options: { branch?: boolean } = {}): ChatClient {
  return { complete: async (r) => {
    const u = r.user as { task: string; state: Record<string, any> };
    seen.push(u);
    const it = u.state.iteration;
    let content: Record<string, unknown>;
    if (u.task.startsWith('Propose the project')) content = { criterion: '(runs) => ({ met: runs.some((r) => r.accepted), why: "a run was accepted" })', why: 'w' };
    else if (u.task.startsWith('Plan')) {
      const stuck = (u.state.runs as Record<string, any>[]).find((x) => x.stuck?.branchable);
      content = options.branch && stuck
        ? { rationale: 'its researcher wrote an idea it never tested', hypotheses: [{ id: 'h2', statement: 'the untested idea helps', if_true: 'the branch is accepted', if_false: 'it is not' }],
          batch: { runs: [{ id: 'branch-1', lab: 'particles3d', condition: 'branch', fork: { of: stuck.id, attempts: 4, message: 'You wrote: "' + stuck.stuck.untested_ideas[0] + '". You have not tried it.' } }] }, budget_tokens: 2000 }
        : { rationale: 'r', hypotheses: [{ id: 'h' + it, statement: it === 1 ? 'without instruments it cannot' : 'with instruments it can', if_true: 'x', if_false: 'y' }],
          batch: { runs: [{ id: 'run-' + it, lab: 'particles3d', condition: it === 1 ? 'no instruments' : 'instruments', args: ['--seed', '1', ...common, ...(it === 1 ? ['--tools', 'none'] : [])] }], concurrency: 1 }, budget_tokens: 1000 };
    } else content = { verdicts: [{ hypothesis: 'h' + it, verdict: 'confirmed', runs: ['run-' + it], why: 'w' }],
      conclusions: [{ id: 'c1', statement: 'instruments decide it', status: it === 1 ? 'new' : 'confirmed', support: ['run-' + it], replicated: false, why: 'w' }], open_questions: ['replicate'] };
    return { content: JSON.stringify(content), latencyMs: 0, raw: { usage: { total_tokens: 10 } } };
  } };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const base = (root: string, extra: Partial<ProjectOptions> = {}): ProjectOptions => ({ root, id: 'p1', goal: { question: 'Can it learn particles3d level 1 A?' }, budget: { tokens: 20000 },
  planner: planner(), llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch: world(), pollMs: 20, ...extra });

/** Approves (or rejects) whatever the project waits for, as an operator at the console would. */
async function operator(root: string, id: string, decisions: ('approve' | string)[], done: Promise<unknown>): Promise<void> {
  let finished = false;
  void done.then(() => { finished = true; });
  for (const d of decisions) {
    while (!finished && projectStatus(root, id).status?.state !== 'waiting') await sleep(10);
    if (finished) return;
    const before = projectStatus(root, id).status?.waiting_for;
    sendProject(root, id, d === 'approve' ? { kind: 'approve', by: 'camilo' } : { kind: 'reject', note: d, by: 'camilo' });
    while (!finished && projectStatus(root, id).status?.waiting_for === before && projectStatus(root, id).status?.state === 'waiting') await sleep(10);
  }
}

test('consultive: the planner proposes the criterion and every plan; the operator approves or rejects with a note; the loop ends when the criterion is met', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-'));
  const seen: Record<string, any>[] = [];
  const done = runProject(base(root, { planner: planner(seen) }));
  await operator(root, 'p1', ['approve', 'approve', 'try it with instruments first', 'approve', 'approve'], done);
  const r = await done;
  assert.match(r.ended!.why, /criterion is met/);
  assert.deepEqual([r.criterion!.by, r.criterion!.approved], ['planner', true]);
  assert.deepEqual(r.iterations.map((i) => i.approval?.decision), ['approve', 'reject', 'approve']);
  assert.ok(seen.some((u) => u.state.operator_note === 'try it with instruments first'), 'the planner read the operator\'s note');
  assert.deepEqual(r.iterations.map((i) => i.criterion?.met ?? null), [false, null, true]);
  assert.equal(r.conclusions[0].status, 'confirmed');
  assert.equal(r.conclusions[0].replicated, false, 'one run each: not replicated');
  const report = fs.readFileSync(projectFiles(root, 'p1').report, 'utf8');
  assert.match(report, /rests on/);
  assert.ok(r.spent.planner > 0 && r.spent.runs > 0, 'the planner\'s own calls count in the budget');
  /* It saw the laboratories by name and options only (Q2). */
  const laboratories = JSON.stringify(seen[1].state.laboratories);
  assert.ok(laboratories.includes('particles3d') && !/Blender|force|field|velocity/i.test(laboratories));
});

test('threshold: a plan below it goes on its own; stopped and resumed, the project takes up its decisions and runs nothing again', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-'));
  const criterion = '(runs) => runs.filter((r) => r.accepted).length >= 1';
  /* Iteration 1 runs on its own (1000 ≤ 1500); stopped while iteration 2's plan... also runs on its own: stop it right after
     iteration 1 instead, from the operator's inbox. */
  const calls = { n: 0 };
  const first = runProject(base(root, { goal: { question: 'q', criterion }, autonomy: 'threshold', threshold: 1500, fetch: world(calls), budget: { tokens: 20000, iterations: 1 } }));
  const r1 = await first;
  assert.match(r1.ended!.why, /iterations of the budget/);
  assert.equal(r1.iterations[0].approval!.by, 'autonomy:threshold');
  const before = calls.n;
  const r2 = await runProject(base(root, { goal: { question: 'q', criterion }, autonomy: 'threshold', threshold: 1500, fetch: world(calls), budget: { tokens: 20000 } }));
  assert.match(r2.ended!.why, /criterion is met/);
  assert.equal(r2.iterations.length, 2);
  /* Iteration 1's run was not run again: only iteration 2's asked System 2. */
  assert.ok(calls.n - before <= 4, 'iteration 1 not run again');
  assert.throws(() => compileCriterion('not code ('), /does not compile/);
});

test('a local minimum: a stuck run is shown with its untested idea; the planner opens a branch that continues its history, handed to the assisted researcher; the original stays as it was', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-'));
  const seen: Record<string, any>[] = [];
  /* Iteration 1: a run without instruments gets stuck (never accepted, uses up its rounds). Iteration 2: a branch of it. */
  const r = await runProject(base(root, { goal: { question: 'q', criterion: '(runs) => runs.some((r) => r.accepted)' }, autonomy: 'autonomous', planner: planner(seen, { branch: true }) }));
  assert.match(r.ended!.why, /criterion is met/);
  const plan2 = seen.find((u) => u.task.startsWith('Plan') && u.state.iteration === 2)!;
  const stuck = plan2.state.runs[0];
  assert.equal(stuck.stuck.branchable, true);
  assert.match(stuck.stuck.untested_ideas.join(' '), /test whether the acceleration depends on where/);
  const batch = JSON.parse(fs.readFileSync(r.iterations[1].batch!, 'utf8'));
  const branch = JSON.parse(fs.readFileSync(batch.runs[0].journal, 'utf8'));
  assert.equal(branch.researcher, 'assisted');
  assert.equal(branch.assisted_after_attempts, 2);
  const delivered = branch.events.find((e: { type: string }) => e.type === 'operator_message');
  assert.equal(delivered.messages[0].by, 'agent:planner');
  assert.match(delivered.messages[0].text, /You wrote: "test whether/);
  assert.equal(batch.runs[0].status, 'accepted');
  /* The original run, untouched: still its own researcher's, still ended by its budget. */
  const original = JSON.parse(fs.readFileSync(JSON.parse(fs.readFileSync(r.iterations[0].batch!, 'utf8')).runs[0].journal, 'utf8'));
  assert.equal(original.researcher, 'unknown-world');
  assert.equal(original.events.at(-1).stoppedBy, 'budget');
});

test('the console and the command line show a project and carry the operator\'s decisions to it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-'));
  const { serveConsole } = await import('../src/runtime/console.ts');
  const { labCli } = await import('../src/runtime/cli.ts');
  const done = runProject(base(root, { goal: { question: 'q', criterion: '(runs) => runs.some((r) => r.accepted)' } }));
  while (projectStatus(root, 'p1').status?.state !== 'waiting') await sleep(10);
  const c = await serveConsole({ root, port: 0 });
  /* The console shares this process with the project's runs here (not so in use): a request may wait out a busy loop. */
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    for (let k = 0; ; k++) { try { return await globalThis.fetch(url, init); } catch (e) { if (k >= 5) throw e; await sleep(300); } }
  };
  try {
    const list = await (await fetch(c.url + '/api/projects')).json() as { id: string; state: string }[];
    assert.deepEqual(list.map((p) => [p.id, p.state]), [['p1', 'waiting']]);
    const view = await (await fetch(c.url + '/api/projects/p1')).json() as { record: { iterations: unknown[] }; status: { waiting_for: string }; report: string };
    assert.match(view.status.waiting_for, /plan of iteration 1/);
    const bad = await fetch(c.url + '/api/projects/p1/orders', { method: 'POST', body: JSON.stringify({ kind: 'reject' }) });
    assert.equal(bad.status, 400, 'a rejection says what to change');
    await fetch(c.url + '/api/projects/p1/orders', { method: 'POST', body: JSON.stringify({ kind: 'reject', note: 'with instruments' }) });
    while (!(projectStatus(root, 'p1').status?.waiting_for as string ?? '').includes('iteration 2')) await sleep(10);
    const lines: string[] = [];
    assert.equal(await labCli(['project', 'status', 'p1'], { root, out: (l) => lines.push(l) }), 0);
    assert.match(lines.join('\n'), /WAITING for you to approve the plan of iteration 2/);
    for (let k = 0; k < 2; k++) {
      await labCli(['project', 'approve', 'p1'], { root, out: () => {} });
      while (projectStatus(root, 'p1').status?.state === 'waiting' && !projectStatus(root, 'p1').record?.ended) await sleep(10);
      while (projectStatus(root, 'p1').status?.state !== 'waiting' && !projectStatus(root, 'p1').record?.ended) await sleep(10);
    }
    const r = await done;
    assert.match(r.ended!.why, /criterion is met/);
    const detail = await (await fetch(c.url + '/api/projects/p1')).json() as { batches: { runs: { run: string }[] }[] };
    /* Iteration 1 was rejected (no batch); iteration 2 ran and met the criterion. */
    const run = detail.batches.filter((b) => b.runs.length).at(-1)!.runs[0].run;
    assert.match(run, /^projects\/p1\/batches\/i2\//);
    const rv = await fetch(c.url + '/api/runs/' + encodeURIComponent(run));
    assert.equal(rv.status, 200, 'a batch\'s run opens in its run view');
  } finally { await c.close(); }
});
