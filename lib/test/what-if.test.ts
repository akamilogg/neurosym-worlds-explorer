import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';
import { parseWhatIf, readAnswer, WhatIf } from '../src/learn/assisted/what-if.ts';
import { packRun, verifyPackage } from '../src/runtime/package.ts';
import { runFiles } from '../src/runtime/control.ts';
import { researcherEvents } from '../src/orchestra/view.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';

/* SPEC-Y-SI, PLAN-Y-SI Entrega 2: «what if…?» - a turn or a fork from an isolated call to System 2, with nothing but what the
   researcher gave it; a suggestion, never evidence; an investigation step and one of its calls; logged before and after;
   replayed offline; a tool of both hemispheres, the junior told what its senior asked. */

test('a request and an answer, as written', () => {
  assert.match(String(parseWhatIf({ what_if: { mode: 'spin', situation: 's' } })), /"turn" or "fork"/);
  assert.match(String(parseWhatIf({ what_if: { mode: 'turn' } })), /situation/);
  assert.deepEqual(parseWhatIf({ what_if: { mode: 'fork', situation: ' s ', refs: ['a', 'a', 'b'] } }), { mode: 'fork', situation: 's', refs: ['a', 'b'] });
  assert.deepEqual(readAnswer('turn', '{"idea": "What if it remembers?"}'), { idea: 'What if it remembers?' });
  assert.deepEqual(readAnswer('fork', '{"a": "x", "b": "y", "difference": "z"}'), { a: 'x', b: 'y', difference: 'z' });
  assert.deepEqual(readAnswer('fork', '{"no_direction": "nothing defensible"}'), { no_direction: 'nothing defensible' });
  assert.match(String(readAnswer('fork', '{"a": "x"}')), /"a", "b", "difference"/);
});

const MODEL = { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]', validate: false, lessons: ['l'], next_experiment: 'n', beliefs: [] };
const reply = (content: unknown) => { const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } }); return { ok: true, status: 200, text: async () => text, headers: { get: () => null } }; };
const PROPOSER = /^A researcher, investigating/;

/** A run of cells whose junior asks `asks` (one per investigation step of round 1), then proposes. */
function world(asks: Record<string, unknown>[], seen: { systems: string[]; users: any[]; proposer: any[] }, onFirst?: () => void): FetchLike {
  return async (_url, init) => {
    const b = JSON.parse(String(init.body));
    const system = b.messages[0].content as string;
    if (PROPOSER.test(system)) {
      seen.proposer.push({ system, user: JSON.parse(userOf(b)) });
      return reply(/FORK/.test(system) ? { a: 'its state is in the cells', b: 'its state is in the boundary', difference: 'cut the row at its edge' } : { idea: 'What if each cell remembers its previous value?' });
    }
    const user = JSON.parse(userOf(b));
    seen.systems.push(system); seen.users.push(user);
    if (seen.users.length === 1) onFirst?.();
    if ('task' in user) return reply({ rationale: 'r', beliefs: [], lessons: ['l'], next_experiment: 'n' });
    const done = (user.investigation ?? []).length;
    return reply(user.round === 1 && done < asks.length ? { investigate: [asks[done]], ...(done === 0 ? { notes: [{ do: 'write', id: 'hunch', text: 'the rule looks local' }] } : {}) } : MODEL);
  };
}
const args = (dir: string, extra: string[] = []) => ['--seed', '1', '--level', '1', '--researcher', 'assisted', '--attempts', '1', '--flat', '--no-grade', '--no-reflection', '--no-ablation', ...extra, '--out', path.join(dir, 'run.json')];
const llm = { url: 'http://x.test/v1/chat/completions', model: 's' };

test('the junior asks a turn and a fork: isolated calls, its named items only, logged before and after, its budget told', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'what-if-'));
  const seen = { systems: [] as string[], users: [] as any[], proposer: [] as any[] };
  const asks = [
    { what_if: { mode: 'turn', situation: 'I keep adjusting which cells change, and the same error comes back after each row.', refs: ['note:hunch'] } },
    { what_if: { mode: 'fork', situation: 'Two readings remain.', question: 'Where is its memory?' } },
    { what_if: { mode: 'turn', situation: 's', refs: ['nothing:here'] } }
  ];
  const r = await runLaboratory(cellsLab, { args: args(dir), root: dir, llm, fetch: world(asks, seen) });
  assert.ok(seen.systems[0].includes('WHAT IF...?'), 'in its system from its first question');
  assert.equal(seen.proposer.length, 2, 'the missing ref is refused before any call');
  assert.deepEqual(Object.keys(seen.proposer[0].user).sort(), ['items', 'mode', 'situation'], 'only what it gave');
  assert.equal(seen.proposer[0].user.items[0].id, 'note:hunch');
  assert.ok(!JSON.stringify(seen.proposer).includes('percept'), 'never its conversation or its world');
  const events = JSON.parse(fs.readFileSync(r.journal, 'utf8')).events as Record<string, any>[];
  const kinds = events.filter((e) => /^what_if/.test(e.type)).map((e) => e.type + ' ' + e.id);
  assert.deepEqual(kinds, ['what_if_requested what_if:junior:r1.1', 'what_if what_if:junior:r1.1', 'what_if_requested what_if:junior:r1.2', 'what_if what_if:junior:r1.2']);
  const steps = events.filter((e) => e.type === 'investigation').map((e) => e.results[0]);
  assert.equal(steps[0].idea, 'What if each cell remembers its previous value?');
  assert.match(steps[0].generated, /never evidence/);
  assert.equal(steps[1].difference, 'cut the row at its edge');
  assert.match(steps[2].error, /not in your memory: nothing:here/);
  assert.equal(steps[1].what_if_left, 4);
  assert.ok(JSON.stringify(seen.users[1]).includes('"what_if_left":5'), 'its budget tells what is left');
  assert.ok(researcherEvents(JSON.parse(fs.readFileSync(r.journal, 'utf8'))).some((e) => e.type === 'what_if' && e.answer?.idea), 'its senior sees its requests and answers');
  /* Its tokens are the run's: the proposer's calls counted with the junior's. */
  assert.equal(r.finding.cost.total?.llm_calls, seen.users.length + seen.proposer.length);
  /* Replayed offline: its record whole, no call made again. */
  const v = await verifyPackage(packRun(r.journal).dir);
  assert.equal(v.reconstruction.holds, true, JSON.stringify(v.reconstruction));
});

test('its limit; and --no-what-if takes it from both hemispheres', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'what-if-limit-'));
  const seen = { systems: [] as string[], users: [] as any[], proposer: [] as any[] };
  const ask = { what_if: { mode: 'turn', situation: 's' } };
  const r = await runLaboratory(cellsLab, { args: args(dir, ['--what-if-max', '1']), root: dir, llm, fetch: world([ask, ask], seen) });
  const steps = (JSON.parse(fs.readFileSync(r.journal, 'utf8')).events as Record<string, any>[]).filter((e) => e.type === 'investigation').map((e) => e.results[0]);
  assert.equal(seen.proposer.length, 1);
  assert.match(steps[1].error, /no calls of what_if left in this run \(1\)/);

  const off = fs.mkdtempSync(path.join(os.tmpdir(), 'what-if-off-'));
  const none = { systems: [] as string[], users: [] as any[], proposer: [] as any[] };
  const o = await runLaboratory(cellsLab, { args: args(off, ['--no-what-if']), root: off, llm, fetch: world([ask], none) });
  assert.ok(!none.systems.some((s) => s.includes('WHAT IF...?')));
  assert.equal(none.proposer.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(o.journal, 'utf8')).config.what_if, false, 'the condition in its configuration');
});

test('the senior asks too: the junior is told that it asked and what, a fact of the record - never help', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'what-if-senior-'));
  const seen = { systems: [] as string[], users: [] as any[], proposer: [] as any[] };
  const journal = path.join(dir, 'run.json');
  /* As a senior's operator does: a request of its own, sent to the run's inbox. */
  const tell = () => fs.appendFileSync(runFiles(journal).inbox, JSON.stringify({ id: 'o1', kind: 'what_if_requested', mode: 'fork', situation: 'its checks stall at the edges', by: 'agent:senior' }) + '\n');
  const ask = { what_if: { mode: 'turn', situation: 's' } };
  const r = await runLaboratory(cellsLab, { args: args(dir, ['--agents', 'senior=message']), root: dir, llm, fetch: world([ask], seen, tell) });
  const told = seen.users.find((u) => JSON.stringify(u).includes('what_if_requested'));
  assert.ok(told, 'in its channel');
  assert.match(JSON.stringify(told), /its checks stall at the edges/);
  const events = JSON.parse(fs.readFileSync(r.journal, 'utf8')).events as Record<string, any>[];
  assert.ok(events.some((e) => e.type === 'what_if_requested' && e.by === 'agent:senior'));
  assert.ok(!events.some((e) => e.type === 'operator_command'), 'never help');

  /* The senior's own tool: the same primitive, its ids its own, the other told. */
  const told2: unknown[] = [];
  const w = new WhatIf({ llm: { complete: async () => ({ content: '{"idea": "What if?"}' }) } as never, who: 'senior', max: 2, log: () => {}, onRequested: (e) => told2.push(e),
    resolve: async () => ({ items: [] }) });
  const a = await w.run({ what_if: { mode: 'turn', situation: 's' } }, 3);
  assert.equal(a.id, 'what_if:senior:r3.1');
  assert.equal(told2.length, 1);
});

test('the senior asks from its own loop: a fork on the junior record, one of its readings; the junior is told', async () => {
  const { runAgentOperator } = await import('../src/orchestra/agent-operator.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'what-if-senior-loop-'));
  const out = path.join(dir, 'run.json');
  const junior: { users: any[] } = { users: [] };
  const stuck: FetchLike = async (_url, init) => {
    await new Promise((r) => setTimeout(r, 40));
    const b = JSON.parse(String(init.body));
    const user = JSON.parse(userOf(b));
    junior.users.push(user);
    return reply('task' in user ? { rationale: 'r', beliefs: [{ id: 'same', stance: 'keep', why: 'w' }], lessons: ['l'], next_experiment: 'n' }
      : { ...MODEL, beliefs: [{ id: 'same', stance: user.round === 1 ? 'new' : 'keep', statement: 'the row repeats', evidence: [] }] });
  };
  const seniorSystems: string[] = [];
  const proposer: any[] = [];
  const seniorLlm = { complete: async (r: { system: string; user: unknown }) => {
    if (PROPOSER.test(r.system)) { proposer.push(r.user); return { content: JSON.stringify({ a: 'the row is copied', b: 'the row is computed from its neighbours', difference: 'change one cell and see if its neighbours follow' }), latencyMs: 0, raw: null }; }
    seniorSystems.push(r.system);
    const asked = JSON.stringify(r.user).includes('what_if:senior');
    const content = !asked ? { investigate: [{ what_if: { mode: 'fork', situation: 'the junior keeps the same model and it holds nowhere', refs: ['belief:same'] } }] }
      : { decision: 'message', text: 'Test whether the row is computed from its neighbours: change one cell.', evidence: ['belief:same'], why: 'a fork I asked for' };
    return { content: JSON.stringify(content), latencyMs: 0, raw: null };
  } };
  const controller = new AbortController();
  const run = runLaboratory(cellsLab, { args: ['--seed', '1', '--level', '1', '--flat', '--tools', 'none', '--researcher', 'assisted', '--attempts', '6', '--agents', 'senior=message', '--out', out],
    root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch: stuck });
  const agent = runAgentOperator({ id: 'senior', role: 'senior', patience: 2, journal: out, llm: seniorLlm as never, pollMs: 15, maxOrders: 1, signal: controller.signal });
  const r = await run;
  controller.abort();
  const { decisions } = await agent;
  assert.ok(seniorSystems[0].includes('WHAT IF...? You may ask'), 'in its system');
  assert.equal(proposer.length, 1);
  assert.equal(JSON.parse(JSON.stringify(proposer[0])).items[0].id, 'belief:same', 'the junior record it named');
  const read = JSON.stringify(decisions.find((d) => d.decision === 'message')?.what_if ?? []);
  assert.match(read, /what_if:senior:r\d+\.1/);
  assert.match(read, /change one cell and see if its neighbours follow/);
  const events = JSON.parse(fs.readFileSync(r.journal, 'utf8')).events as Record<string, any>[];
  assert.ok(events.some((e) => e.type === 'what_if_requested' && e.by === 'agent:senior'), 'its request a fact of the junior record');
  assert.ok(junior.users.some((u) => JSON.stringify(u).includes('the junior keeps the same model and it holds nowhere')), 'the junior told what its senior asked');
});
