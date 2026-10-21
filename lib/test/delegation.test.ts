import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';
import { Delegations, type Launcher } from '../src/learn/assisted/delegation.ts';
import { runResults } from '../src/orchestra/results.ts';
import { processTraces } from '../src/orchestra/traces.ts';
import { packRun, verifyPackage } from '../src/runtime/package.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';

/* SPEC-DELEGACION-INVESTIGACIONES, first delivery: a researcher opens a branch - the general investigator, its task the
   question, the requester's record readable from a fixed cut, its own laboratory, a fund apart - goes on meanwhile, and gets
   its result as a message once: a contribution, not help; its cost delegated; one branch at a time; rebuilt offline with
   nothing launched again. */

const MODEL = { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]', validate: false, lessons: ['l'], next_experiment: 'n', beliefs: [] };
const reply = (content: unknown, tokens = 100) => { const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: tokens } }); return { ok: true, status: 200, text: async () => text, headers: { get: () => null } }; };
const llm = { url: 'http://x.test/v1/chat/completions', model: 's' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const eventsOf = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8')).events as Record<string, any>[];

interface Seen { parent: any[]; child: { system: string; user: any }[]; launched: number; childDone: Promise<unknown>[] }

/** A branch run here, as a process of its own would run it: its own journal, its own answers. */
function launcher(root: string, seen: Seen): Launcher {
  return (l) => {
    seen.launched++;
    const childFetch: FetchLike = async (_url, init) => {
      const b = JSON.parse(String(init.body));
      const user = JSON.parse(userOf(b));
      seen.child.push({ system: b.messages[0].content, user });
      return reply('task' in user ? { rationale: 'the edges hold the memory', beliefs: [], lessons: ['look at the edges'], next_experiment: 'n' }
        : { close_round: { why: 'I found that its edges behave apart; no model needed for that' }, notes: [{ do: 'write', id: 'edges', text: 'the edge cells copy their neighbour' }] }, 50);
    };
    seen.childDone.push(runLaboratory(cellsLab, { args: [...l.args, '--out', l.journal], root, llm, fetch: childFetch }));
  };
}

function parentFetch(seen: Seen, asks: Record<string, unknown>[]): FetchLike {
  return async (_url, init) => {
    await sleep(60);
    const user = JSON.parse(userOf(JSON.parse(String(init.body))));
    seen.parent.push(user);
    if ('task' in user) return reply({ rationale: 'r', beliefs: [], lessons: ['l'], next_experiment: 'n' });
    const done = (user.investigation ?? []).length;
    return reply(user.round === 1 && done < asks.length ? { investigate: [asks[done]] } : MODEL);
  };
}

const args = (dir: string, extra: string[]) => ['--seed', '1', '--level', '1', '--researcher', 'assisted', '--flat', '--no-grade', '--no-reflection', '--no-ablation', ...extra, '--out', path.join(dir, 'run.json')];
const DELEGATE = { delegate: { question: 'Is the persistent error at the edges of the row?', refs: ['model:r1'], expected: 'directions and what tells them apart', budget: { rounds: 1 } } };

test('a branch opened, the requester going on; its result delivered once, a contribution and not help; its cost delegated', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-'));
  const seen: Seen = { parent: [], child: [], launched: 0, childDone: [] };
  const r = await runLaboratory(cellsLab, { args: args(dir, ['--attempts', '4', '--delegation-fund', '1000', '--delegation-tokens', '500']), root: dir, llm,
    fetch: parentFetch(seen, [DELEGATE, { delegate: { question: 'a second one' } }, { delegation: { id: 'delegation:r1.1', status: true } }]), delegate: launcher(dir, seen) });
  await Promise.all(seen.childDone);
  const events = eventsOf(r.journal);
  const steps = events.filter((e) => e.type === 'investigation').map((e) => e.results[0]);
  assert.deepEqual([steps[0].delegation, steps[0].state, steps[0].granted], ['delegation:r1.1', 'accepted', { rounds: 1, tokens: 500 }]);
  assert.equal(steps[0].fund_left, 500, 'reserved');
  assert.match(steps[1].error, /one branch at a time/);
  assert.equal(seen.launched, 1);
  /* The branch: its task the question, the requester's record from its cut, its own journal. */
  const requested = events.find((e) => e.type === 'delegation_requested')!;
  assert.match(requested.cut.file, /run\.branches\/delegation-r1\.1\.cut\.json$/);
  assert.match(requested.laboratory, /instance of its own/);
  assert.ok(seen.child[0].system.includes('EXPERIENCE'), 'it reads the requester as experience');
  assert.ok(JSON.stringify(seen.child[0].user).includes('Is the persistent error at the edges of the row?'), 'its task is the question');
  assert.ok(fs.existsSync(path.join(dir, 'run.branches', 'delegation-r1.1.json')));
  assert.ok(!('hidden_from_the_learner' in JSON.parse(fs.readFileSync(path.join(dir, 'run.branches', 'delegation-r1.1.cut.json'), 'utf8'))), 'never the hidden part of its world');
  /* The result: once, as a message of its own. */
  const delivered = events.filter((e) => e.type === 'operator_message').flatMap((e) => e.messages).filter((m: any) => m.research_result);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].result_state, 'completed');
  assert.match(delivered[0].text, /RESEARCH RESULT of your branch delegation:r1\.1 \(a delegated contribution/);
  assert.match(delivered[0].text, /the edge cells copy their neighbour/);
  assert.ok(seen.parent.some((u) => JSON.stringify(u).includes('RESEARCH RESULT')), 'the requester got it');
  assert.equal(r.finding.assistance?.messages.length ?? 0, 0, 'never help');
  assert.equal(processTraces(r.journal).branches.results_delivered, 1);
  /* Its cost: apart, and in the total. */
  const end = events.find((e) => e.type === 'end')!;
  assert.equal(end.delegation.branches[0].state, 'completed');
  assert.ok(end.delegation.spent > 0);
  const cost = runResults(r.journal).cost.tokens;
  assert.equal(cost.delegated, end.delegation.spent);
  assert.equal(cost.total_at_least, (cost.junior ?? 0) + (cost.agents ?? 0) + end.delegation.spent);

  /* Rebuilt offline: answered from its record, nothing launched. */
  const v = await verifyPackage(packRun(r.journal).dir);
  assert.equal(v.reconstruction.holds, true, JSON.stringify(v.reconstruction));
  assert.equal(seen.launched, 1);
});

test('its record read from the requester; no fund, no tool; a world outside the harness refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-read-'));
  const seen: Seen = { parent: [], child: [], launched: 0, childDone: [] };
  let readAnswer: any = null;
  const fetch: FetchLike = async (_url, init) => {
    await sleep(60);
    const user = JSON.parse(userOf(JSON.parse(String(init.body))));
    seen.parent.push(user);
    if ('task' in user) return reply({ rationale: 'r', beliefs: [], lessons: ['l'], next_experiment: 'n' });
    const done = (user.investigation ?? []).length;
    if (user.round === 1 && done === 0) return reply({ investigate: [DELEGATE] });
    if (user.round === 3 && done === 0) return reply({ investigate: [{ delegation: { id: 'delegation:r1.1', read: { experience: 'open', items: ['note:edges'] } } }] });
    if (user.round === 3 && done === 1) readAnswer = user.investigation[0].results[0];
    return reply(MODEL);
  };
  await runLaboratory(cellsLab, { args: args(dir, ['--attempts', '4', '--delegation-fund', '1000']), root: dir, llm, fetch, delegate: launcher(dir, seen) });
  await Promise.all(seen.childDone);
  assert.match(JSON.stringify(readAnswer), /the edge cells copy their neighbour/, 'its record, read as experience: ' + JSON.stringify(readAnswer));

  const none = fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-none-'));
  const systems: string[] = [];
  const plain: FetchLike = async (_url, init) => { systems.push(JSON.parse(String(init.body)).messages[0].content); return reply(MODEL); };
  await runLaboratory(cellsLab, { args: args(none, ['--attempts', '1']), root: none, llm, fetch: plain });
  assert.ok(!systems.some((s) => s.includes('DELEGATING AN INVESTIGATION')));

  const outside = new Delegations({ config: { fund: 10, tokens: 10, rounds: 1, maxRounds: 1 }, journalFile: path.join(none, 'x.json'), snapshot: () => ({ events: [] }), lab: 'c302', worldArgs: [],
    launcher: () => { throw new Error('never'); }, log: () => {}, history: [], unsupported: 'its environment is outside the harness' });
  assert.match(String((await outside.run({ delegate: { question: 'q' } }, 1)).error), /not here: its environment is outside the harness/);
});

test('the senior delegates from its own loop: the result comes to it, never to the junior; its record keeps it all', async () => {
  const { runAgentOperator, agentFile } = await import('../src/orchestra/agent-operator.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-senior-'));
  const out = path.join(dir, 'run.json');
  const seen: Seen = { parent: [], child: [], launched: 0, childDone: [] };
  const junior: FetchLike = async (_url, init) => {
    await sleep(60);
    const user = JSON.parse(userOf(JSON.parse(String(init.body))));
    seen.parent.push(user);
    return reply('task' in user ? { rationale: 'r', beliefs: [], lessons: ['l'], next_experiment: 'n' } : { ...MODEL, beliefs: [{ id: 'same', stance: user.round === 1 ? 'new' : 'keep', statement: 's', evidence: [] }] });
  };
  const calls: any[] = [];
  const senior = { complete: async (r: { system: string; user: unknown }) => {
    calls.push({ system: r.system, user: JSON.parse(JSON.stringify(r.user)) });
    const content = calls.length === 1 ? { investigate: [{ delegate: { question: 'Does the row depend on its edges?', budget: { rounds: 1 } } }] } : { decision: 'wait', why: 'w' };
    return { content: JSON.stringify(content), latencyMs: 0, raw: null };
  } };
  const controller = new AbortController();
  const run = runLaboratory(cellsLab, { args: ['--seed', '1', '--level', '1', '--flat', '--tools', 'none', '--researcher', 'assisted', '--attempts', '8', '--agents', 'senior=message',
    '--delegation-fund', '1000', '--out', out], root: dir, llm, fetch: junior });
  const agent = runAgentOperator({ id: 'senior', role: 'senior', patience: 1, cooldown: 0, journal: out, llm: senior as never, pollMs: 15, maxOrders: 1, signal: controller.signal, delegate: launcher(dir, seen) });
  await run; await Promise.all(seen.childDone); await sleep(100); controller.abort(); await agent;
  assert.ok(calls[0].system.includes('DELEGATING AN INVESTIGATION. Among your readings'), 'in its system');
  assert.equal(seen.launched, 1);
  const record = JSON.parse(fs.readFileSync(agentFile(out, 'senior'), 'utf8'));
  const kinds = new Set((record.delegation_log as any[]).map((e) => e.type));
  for (const k of ['delegation_requested', 'delegation_state', 'delegation_answered', 'branch_result_given']) assert.ok(kinds.has(k), k + ' in its record');
  assert.ok(calls.some((c) => JSON.stringify(c.user).includes('branch_results')), 'it gets the result: ' + calls.length + ' calls');
  assert.ok(!seen.parent.some((u) => JSON.stringify(u).includes('RESEARCH RESULT')), 'never the junior');
  assert.ok(fs.existsSync(path.join(dir, 'run.agent-senior.branches', 'delegation-r' + (record.delegation_log as any[]).find((e) => e.type === 'delegation_requested').round + '.1.json')));
});

test('the requester ends with its branch running: the branch asked to stop, its partial record kept', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-end-'));
  let child: Promise<unknown> | null = null;
  const slow: Launcher = (l) => {
    const fetch: FetchLike = async (_url, init) => { await sleep(150); const user = JSON.parse(userOf(JSON.parse(String(init.body)))); return reply('task' in user ? { rationale: 'r', beliefs: [], lessons: ['l'], next_experiment: 'n' } : MODEL); };
    child = runLaboratory(cellsLab, { args: [...l.args, '--out', l.journal], root: dir, llm, fetch });
  };
  const parent: FetchLike = async (_url, init) => {
    const user = JSON.parse(userOf(JSON.parse(String(init.body))));
    return reply(user.round === 1 && !(user.investigation ?? []).length ? { investigate: [{ delegate: { question: 'q', budget: { rounds: 6 } } }] } : MODEL);
  };
  const r = await runLaboratory(cellsLab, { args: args(dir, ['--attempts', '1', '--delegation-fund', '1000']), root: dir, llm, fetch: parent, delegate: slow });
  const end = eventsOf(r.journal).find((e) => e.type === 'end')!;
  assert.equal(end.delegation.branches[0].state, 'running');
  assert.ok(eventsOf(r.journal).some((e) => e.type === 'delegation_cancel_asked' && /its requester ended/.test(e.why)));
  const c = await child! as { stoppedBy: string };
  assert.equal(c.stoppedBy, 'cancelled', 'it stopped as asked');
  assert.ok(runResults(r.journal).cost.unknown.some((u) => /still running/.test(u)), 'its cost not known, and said so');
});
