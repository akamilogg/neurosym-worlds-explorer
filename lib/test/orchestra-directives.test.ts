import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DIRECTIVES_SECTION, operatorClient, type OperatorMessage } from '../src/learn/assisted/session.ts';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { send } from '../src/runtime/control.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';
import { agentFile, runAgentOperator } from '../src/orchestra/agent-operator.ts';
import type { ChatClient } from '../src/learn/system2.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';

/* SPEC-ORQUESTADOR §3.3.3: the senior's messages are DIRECTIVES - orders the junior carries out and reports, saying where it
   disagrees; a proposal made while one is open is returned to it once; the senior reads what it reported. */

test('a directive: once one has reached it, its prompt says what one is; what it reports is logged, and a directive reported is closed', async () => {
  const logged: { type: string; data?: Record<string, unknown> }[] = [];
  const systems: string[] = [];
  let inbox: OperatorMessage[] = [{ id: 'm1', text: 'Build a decaying state into your model.', by: 'agent:senior', at: 'x', directive: true }];
  const answers = [{ investigate: [], to_senior: 'I doubt the decay is shared.' }, { directives: [{ id: 'm1', done: 'my model of round 2 carries it' }] }];
  const inner: ChatClient = { complete: async (q) => { systems.push(q.system); return { content: JSON.stringify(answers[systems.length - 1]), latencyMs: 0, raw: null }; } };
  const client = operatorClient(inner, { take: () => { const t = inbox; inbox = []; return t; } }, (type, data) => logged.push({ type, data }));
  await client.complete({ system: 'S', user: { round: 1 } });
  assert.ok(systems[0].endsWith(DIRECTIVES_SECTION), 'the prompt says what a directive is');
  assert.deepEqual(client.openDirectives().map((m) => m.id), ['m1']);
  assert.deepEqual(logged.find((l) => l.type === 'junior_report')!.data, { question: 1, text: 'I doubt the decay is shared.' });
  await client.complete({ system: 'S', user: { round: 1 } });
  assert.deepEqual(client.openDirectives(), [], 'reported: closed');
  assert.deepEqual(logged.find((l) => l.type === 'directive_report')!.data, { question: 2, id: 'm1', done: 'my model of round 2 carries it' });
  /* Without a directive, nothing of it: the question and the prompt are as before. */
  const plain = operatorClient(inner, { take: () => [{ id: 'p', text: 'a suggestion', at: 'x' }] }, () => {});
  systems.length = 0;
  await plain.complete({ system: 'S', user: { round: 1 } });
  assert.equal(systems[0], 'S');
});

/* The junior, standing in: it proposes; asked again (its proposal returned), it reports the directive and proposes. */
const PROPOSAL = (extra: Record<string, unknown> = {}) => ({ rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]', validate: false,
  beliefs: [{ id: 'same', stance: 'new', statement: 'the row repeats' }], lessons: ['l'], ...extra });
function junior(asked: Record<string, any>[]): FetchLike {
  return async (_url, init) => {
    const b = JSON.parse(String(init.body));
    const sys = b.messages[0].content as string;
    const user = JSON.parse(userOf(b));
    asked.push({ system: sys, user });
    const returned = JSON.stringify(user).includes('directives are still open');
    const content = sys.startsWith('You grade') ? { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' }
      : 'task' in user ? { rationale: 'r', beliefs: [{ id: 'same', stance: 'keep', why: 'w' }], lessons: ['l'], next_experiment: 'n' }
      : returned ? PROPOSAL({ beliefs: [{ id: 'same', stance: 'new', statement: 'the row repeats' }], directives: [{ id: user.operator_messages?.new?.[0]?.id ?? user.operator_messages?.earlier?.[0]?.id, done: 'tested it' }], to_senior: 'it did not hold' })
      : PROPOSAL();
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
}

test('an assisted run: a proposal made while a directive is open is returned once; reported, it is taken', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'directive-'));
  const out = path.join(dir, 'run.json');
  send(out, { kind: 'message', text: 'Directive: test whether the row repeats.', by: 'agent:senior', directive: true });
  const asked: Record<string, any>[] = [];
  const r = await runLaboratory(cellsLab, { args: ['--seed', '1', '--level', '1', '--flat', '--researcher', 'assisted', '--attempts', '1', '--no-reflection', '--no-grade',
    '--agents', 'senior=message', '--out', out], root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch: junior(asked) });
  const events = JSON.parse(fs.readFileSync(r.journal, 'utf8')).events as Record<string, any>[];
  const delivered = events.find((e) => e.type === 'operator_message')!;
  assert.equal(delivered.messages[0].directive, true, 'delivered as a directive');
  const returned = events.find((e) => e.type === 'proposal_refused' && e.returned);
  assert.ok(returned, 'its first proposal was returned');
  assert.match(returned!.errors[0], /directives are still open/);
  assert.ok(events.some((e) => e.type === 'directive_report' && e.done === 'tested it'));
  assert.ok(events.some((e) => e.type === 'junior_report' && e.text === 'it did not hold'));
  assert.equal(events.filter((e) => e.type === 'proposal').length, 1, 'then its proposal was taken');
  assert.ok(asked.some((q) => q.system.includes('YOUR SENIOR.')), 'its prompt says what a directive is');
});

test('the senior writes directives, and reads what the junior reported since its latest call', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'directive-'));
  const out = path.join(dir, 'run.json');
  const check = (round: number) => ({ type: 'check', round, laboratories: [{ place: 'lab1', holds: false }] });
  fs.writeFileSync(out, JSON.stringify({ experiment: 'cells@1', researcher: 'assisted', events: [check(1), check(2), check(3),
    { type: 'directive_report', question: 4, id: 'order-1', done: 'ran it' }, { type: 'junior_report', question: 4, text: 'I disagree: the edges matter' }] }));
  fs.writeFileSync(out.replace(/\.json$/, '.status.json'), JSON.stringify({ state: 'running', heartbeat: new Date().toISOString(), pid: process.pid }));
  const seen: any[] = [];
  const llm: ChatClient = { complete: async (q) => { seen.push((q.user as { parts: unknown[] }).parts); return { content: JSON.stringify({ decision: 'message', text: 'Build the edges into your model.', why: 'w' }), latencyMs: 0, raw: null }; } };
  const controller = new AbortController();
  const agent = runAgentOperator({ id: 'senior', role: 'senior', journal: out, llm, pollMs: 10, maxOrders: 1, signal: controller.signal });
  const t = Date.now();
  while (!seen.length && Date.now() - t < 3000) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 50));
  controller.abort();
  await agent;
  const call = (seen[0] as Record<string, any>[]).find((p) => p.call)!.call;
  assert.deepEqual(call.junior_reports, [{ directive: 'order-1', done: 'ran it' }, { the_junior_says: 'I disagree: the edges matter' }]);
  const inbox = fs.readFileSync(out.replace(/\.json$/, '.inbox.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(inbox[0].directive, true, 'its message is a directive');
  assert.equal(JSON.parse(fs.readFileSync(agentFile(out, 'senior'), 'utf8')).senior.reports_seen, 2);
});
