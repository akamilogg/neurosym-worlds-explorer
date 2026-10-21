import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';
import { runAgentOperator } from '../src/orchestra/agent-operator.ts';
import { stuckSignals } from '../src/orchestra/reader.ts';
import { runFiles } from '../src/runtime/control.ts';
import { packRun, verifyPackage } from '../src/runtime/package.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';

/* PLAN-Y-SI Entrega 1, as reviewed (19/10/2026): a closing is a round its senior counts, closings in a row a sign; a closing
   answers to its senior's open directives as a proposal does; a run with closings is rebuilt offline. */

const MODEL = { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]', validate: false, lessons: ['l'], next_experiment: 'n', beliefs: [] };
const reply = (content: unknown) => { const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } }); return { ok: true, status: 200, text: async () => text, headers: { get: () => null } }; };
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
  const senior = { complete: async () => ({ content: JSON.stringify({ decision: 'wait', why: 'w' }), latencyMs: 0, raw: null }) };
  const controller = new AbortController();
  const run = runLaboratory(cellsLab, { args: ['--seed', '1', '--level', '1', '--flat', '--tools', 'none', '--researcher', 'assisted', '--attempts', '6', '--agents', 'senior=message', '--out', out], root: dir, llm, fetch: closer });
  const agent = runAgentOperator({ id: 'senior', role: 'senior', patience: 3, journal: out, llm: senior as never, pollMs: 15, maxOrders: 1, signal: controller.signal });
  await run; controller.abort();
  const { decisions } = await agent;
  assert.ok(decisions.some((d) => (d.signals ?? []).some((s) => /closed its latest/.test(s))), 'called for its closings: ' + JSON.stringify(decisions.map((d) => d.signals)));
});

test('a closing with an open directive of its senior is returned once', async () => {
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
  /* The directive reached it in round 2; it closes round 3 without having answered for it. */
  const round3 = eventsOf(r.journal).filter((e) => e.round === 3 && (e.type === 'proposal_refused' || e.type === 'round_closed')).map((e) => e.type + (e.returned ? ' returned' : ''));
  assert.deepEqual(round3, ['proposal_refused returned', 'round_closed'], 'returned once, then closed');
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
