import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';
import { runAgentOperator, agentFile } from '../src/orchestra/agent-operator.ts';
import { stuckSignals } from '../src/orchestra/reader.ts';
import { runFiles } from '../src/runtime/control.ts';
import { packRun, verifyPackage } from '../src/runtime/package.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';

/* An external review of PLAN-Y-SI Entregas 1-2, and our own introspection, reconciled (19/10/2026): a closing is a round its
   senior counts; refs as announced without a selective memory; the senior's requests unique and kept in its record before
   and after the call; a closing answers to open directives; no call past a budget; the tool only where there are steps;
   a run with closings rebuilt offline. */

const MODEL = { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]', validate: false, lessons: ['l'], next_experiment: 'n', beliefs: [] };
const reply = (content: unknown, tokens = 100) => { const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: tokens } }); return { ok: true, status: 200, text: async () => text, headers: { get: () => null } }; };
const PROPOSER = /^A researcher, investigating/;
const llm = { url: 'http://x.test/v1/chat/completions', model: 's' };
const base = (dir: string, extra: string[]) => ['--seed', '1', '--level', '1', '--researcher', 'assisted', '--flat', '--no-grade', '--no-reflection', '--no-ablation', ...extra, '--out', path.join(dir, 'run.json')];
const eventsOf = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8')).events as Record<string, any>[];

test('a closing is a round: closings in a row a sign, and the senior called for them', async () => {
  const signals = stuckSignals({ events: [{ type: 'proposal', round: 1 }, { type: 'round_closed', round: 2 }, { type: 'round_closed', round: 3 }] });
  assert.equal(signals.rounds_closed_in_a_row, 2);
  assert.ok(signals.signs.some((s) => /closed its latest 2 rounds without a new model/.test(s)));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-closings-'));
  const out = path.join(dir, 'run.json');
  const closer: FetchLike = async (_url, init) => {
    await new Promise((r) => setTimeout(r, 40));
    const user = JSON.parse(userOf(JSON.parse(String(init.body))));
    return reply('task' in user ? { rationale: 'r', beliefs: [], lessons: ['l'], next_experiment: 'n' } : user.round === 1 ? MODEL : { close_round: { why: 'nothing new' } });
  };
  const calls: unknown[] = [];
  const senior = { complete: async (r: { user: unknown }) => { calls.push(r.user); return { content: JSON.stringify({ decision: 'wait', why: 'w' }), latencyMs: 0, raw: null }; } };
  const controller = new AbortController();
  const run = runLaboratory(cellsLab, { args: ['--seed', '1', '--level', '1', '--flat', '--tools', 'none', '--researcher', 'assisted', '--attempts', '6', '--agents', 'senior=message', '--out', out], root: dir, llm, fetch: closer });
  const agent = runAgentOperator({ id: 'senior', role: 'senior', patience: 3, journal: out, llm: senior as never, pollMs: 15, maxOrders: 1, signal: controller.signal });
  await run; controller.abort();
  const { decisions } = await agent;
  assert.ok(decisions.some((d) => (d.signals ?? []).some((s) => /closed its latest/.test(s))), 'called for its closings: ' + JSON.stringify(decisions.map((d) => d.signals)));
});

test('refs as announced without a selective memory: an investigation step of its own', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-refs-'));
  const proposer: any[] = [];
  const fetch: FetchLike = async (_url, init) => {
    const b = JSON.parse(String(init.body));
    if (PROPOSER.test(b.messages[0].content)) { proposer.push(JSON.parse(userOf(b))); return reply({ idea: 'What if?' }); }
    const user = JSON.parse(userOf(b));
    if ('task' in user) return reply({ rationale: 'r', beliefs: [], lessons: ['l'], next_experiment: 'n' });
    const done = (user.investigation ?? []).length;
    return reply(user.round === 1 && done === 0 ? { investigate: [{ view: 'ep1', from: 0, to: 3 }] }
      : user.round === 1 && done === 1 ? { investigate: [{ what_if: { mode: 'turn', situation: 's', refs: ['investigation:r1.1'] } }] } : MODEL);
  };
  const r = await runLaboratory(cellsLab, { args: base(dir, ['--attempts', '1']), root: dir, llm, fetch });
  assert.equal(proposer.length, 1, JSON.stringify(eventsOf(r.journal).filter((e) => e.type === 'investigation').map((e) => e.results)));
  assert.equal(proposer[0].items[0].id, 'investigation:r1.1');
});

test('a closing with an open directive of its senior is returned once; no call past a budget; the tool only with steps', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-vet-'));
  const journal = path.join(dir, 'run.json');
  let answers = 0;
  const fetch: FetchLike = async (_url, init) => {
    const user = JSON.parse(userOf(JSON.parse(String(init.body))));
    answers++;
    if (answers === 1) fs.appendFileSync(runFiles(journal).inbox, JSON.stringify({ id: 'd1', kind: 'message', text: 'measure the edges first', directive: true, by: 'agent:senior' }) + '\n');
    if ('task' in user) return reply({ rationale: 'r', beliefs: [], lessons: ['l'], next_experiment: 'n' });
    return reply(user.round <= 2 ? MODEL : { close_round: { why: 'nothing new' } });
  };
  const r = await runLaboratory(cellsLab, { args: base(dir, ['--attempts', '4', '--agents', 'senior=message']), root: dir, llm, fetch });
  const events = eventsOf(r.journal);
  /* The directive reached it in round 2; it closes round 3 without having answered for it. */
  const round3 = events.filter((e) => e.round === 3 && (e.type === 'proposal_refused' || e.type === 'round_closed')).map((e) => e.type + (e.returned ? ' returned' : ''));
  assert.deepEqual(round3, ['proposal_refused returned', 'round_closed'], 'returned once, then closed');

  const spent = fs.mkdtempSync(path.join(os.tmpdir(), 'review-halt-'));
  let proposerCalls = 0;
  const greedy: FetchLike = async (_url, init) => {
    const b = JSON.parse(String(init.body));
    if (PROPOSER.test(b.messages[0].content)) { proposerCalls++; return reply({ idea: 'x' }); }
    const user = JSON.parse(userOf(b));
    return reply(user.round === 1 && !(user.investigation ?? []).length ? { investigate: [{ what_if: { mode: 'turn', situation: 's' } }] } : MODEL, 1000);
  };
  const h = await runLaboratory(cellsLab, { args: base(spent, ['--attempts', '2', '--max-tokens', '500']), root: spent, llm, fetch: greedy });
  assert.equal(proposerCalls, 0, 'not asked past its budget');
  assert.match(eventsOf(h.journal).find((e) => e.type === 'investigation')!.results[0].error, /not asked: token_budget/);

  const none = fs.mkdtempSync(path.join(os.tmpdir(), 'review-nosteps-'));
  const systems: string[] = [];
  const plain: FetchLike = async (_url, init) => { const b = JSON.parse(String(init.body)); systems.push(b.messages[0].content); return reply(MODEL); };
  await runLaboratory(cellsLab, { args: base(none, ['--attempts', '1', '--tools', 'none']), root: none, llm, fetch: plain });
  assert.ok(!systems.some((s) => s.includes('WHAT IF...?')), 'no investigation steps: not offered');
});

test('the senior\'s requests: unique ids, kept in its record before and after the call', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-senior-'));
  const out = path.join(dir, 'run.json');
  const stuck: FetchLike = async (_url, init) => {
    await new Promise((r) => setTimeout(r, 40));
    const user = JSON.parse(userOf(JSON.parse(String(init.body))));
    return reply('task' in user ? { rationale: 'r', beliefs: [], lessons: ['l'], next_experiment: 'n' } : { ...MODEL, beliefs: [{ id: 'same', stance: user.round === 1 ? 'new' : 'keep', statement: 's', evidence: [] }] });
  };
  let asked = 0;
  const senior = { complete: async (r: { system: string; user: unknown }) => {
    if (PROPOSER.test(r.system)) return { content: JSON.stringify({ idea: 'What if it is copied?' }), latencyMs: 0, raw: null };
    asked++;
    const content = asked <= 2 ? { investigate: [{ what_if: { mode: 'turn', situation: 'call ' + asked, refs: ['belief:same'] } }] } : { decision: 'wait', why: 'w' };
    return { content: JSON.stringify(content), latencyMs: 0, raw: null };
  } };
  const controller = new AbortController();
  const run = runLaboratory(cellsLab, { args: ['--seed', '1', '--level', '1', '--flat', '--tools', 'none', '--researcher', 'assisted', '--attempts', '5', '--agents', 'senior=message', '--out', out], root: dir, llm, fetch: stuck });
  const agent = runAgentOperator({ id: 'senior', role: 'senior', patience: 2, journal: out, llm: senior as never, pollMs: 15, maxOrders: 1, signal: controller.signal });
  await run; controller.abort(); await agent;
  const record = JSON.parse(fs.readFileSync(agentFile(out, 'senior'), 'utf8'));
  const log = (record.what_if ?? []) as Record<string, any>[];
  assert.deepEqual(log.map((e) => e.type), ['what_if_requested', 'what_if', 'what_if_requested', 'what_if'], 'its request before, its answer after');
  assert.equal(log[0].situation, 'call 1');
  assert.deepEqual(log[0].refs, ['belief:same']);
  const ids = log.filter((e) => e.type === 'what_if_requested').map((e) => e.id);
  assert.equal(new Set(ids).size, 2, 'unique: ' + ids.join(', '));
  assert.equal(record.senior.what_if_used, 2);
});

test('a run with closings is rebuilt offline', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-verify-'));
  const fetch: FetchLike = async (_url, init) => {
    const user = JSON.parse(userOf(JSON.parse(String(init.body))));
    return reply('task' in user ? { rationale: 'r', beliefs: [], lessons: ['l'], next_experiment: 'n' } : user.round === 2 ? { close_round: { why: 'nothing new' } } : MODEL);
  };
  const r = await runLaboratory(cellsLab, { args: base(dir, ['--attempts', '3']), root: dir, llm, fetch });
  assert.ok(eventsOf(r.journal).some((e) => e.type === 'round_closed'));
  const v = await verifyPackage(packRun(r.journal).dir);
  assert.equal(v.reconstruction.holds, true, JSON.stringify(v.reconstruction));
});
