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

test('an assisted run: a directive that came in this round leaves the proposal alone; in a later round, a proposal with it open is returned once; reported, it is taken', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'directive-'));
  const out = path.join(dir, 'run.json');
  send(out, { kind: 'message', text: 'Directive: test whether the row repeats.', by: 'agent:senior', directive: true });
  const asked: Record<string, any>[] = [];
  const r = await runLaboratory(cellsLab, { args: ['--seed', '1', '--level', '1', '--flat', '--researcher', 'assisted', '--attempts', '2', '--no-reflection', '--no-grade',
    '--agents', 'senior=message', '--out', out], root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch: junior(asked) });
  const events = JSON.parse(fs.readFileSync(r.journal, 'utf8')).events as Record<string, any>[];
  const delivered = events.find((e) => e.type === 'operator_message')!;
  assert.equal(delivered.messages[0].directive, true, 'delivered as a directive');
  const returned = events.find((e) => e.type === 'proposal_refused' && e.returned);
  assert.ok(returned, 'a proposal was returned');
  assert.equal(returned!.round, 2, 'not in the round the directive came in (it may have come with nothing left to carry it out), but in the next');
  assert.match(returned!.errors[0], /directives are still open/);
  assert.ok(events.some((e) => e.type === 'directive_report' && e.done === 'tested it'));
  assert.ok(events.some((e) => e.type === 'junior_report' && e.text === 'it did not hold'));
  assert.equal(events.filter((e) => e.type === 'proposal').length, 2, 'round 1 taken as it was; round 2 taken once reported');
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

/* SPEC-ORQUESTADOR §3.3.4: the junior does not start from a hypothesis of its own - after the first episodes the run waits for
   its senior's first hypothesis, which goes with the junior's first question as a directive. */
test('the opening: the run waits for its senior, whose first hypothesis goes with the junior\'s very first question', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opening-'));
  const out = path.join(dir, 'run.json');
  const asked: Record<string, any>[] = [];
  const seniorAsked: any[] = [];
  const llm: ChatClient = { complete: async (q) => { seniorAsked.push((q.user as { parts: unknown[] }).parts);
    return { content: JSON.stringify({ decision: 'message', text: 'Start from this: each cell copies its left neighbour. Test it on ep1.', why: 'w', evidence: ['episode:ep1'] }), latencyMs: 0, raw: null }; } };
  const controller = new AbortController();
  const agent = runAgentOperator({ id: 'senior', role: 'senior', journal: out, llm, pollMs: 20, maxOrders: 3, signal: controller.signal });
  const r = await runLaboratory(cellsLab, { args: ['--seed', '1', '--level', '1', '--attempts', '1', '--flat', '--no-grade', '--no-reflection', '--researcher', 'assisted',
    '--agents', 'senior=message', '--opening', 'senior', '--out', out], root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch: junior(asked) });
  controller.abort();
  await agent;
  const events = JSON.parse(fs.readFileSync(r.journal, 'utf8')).events as Record<string, any>[];
  const types = events.map((e) => e.type);
  assert.ok(types.indexOf('awaiting_opening') > types.lastIndexOf('exploration_episode'), 'after the first episodes');
  assert.ok(types.indexOf('opening_received') < types.indexOf('operator_message'));
  const first = asked[0].user;
  assert.equal(first.operator_messages.new[0].directive, true, 'its very first question carries it, as an order');
  assert.match(first.operator_messages.new[0].text, /copies its left neighbour/);
  assert.match(JSON.stringify(seniorAsked[0]), /"opening"/, 'the senior is told it opens');
  const record = JSON.parse(fs.readFileSync(agentFile(out, 'senior'), 'utf8'));
  assert.equal(record.decisions[0].opening, true);
});

test('the opening never comes: the run waits as long as it was told, then the junior starts on its own', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opening-'));
  const asked: Record<string, any>[] = [];
  const r = await runLaboratory(cellsLab, { args: ['--seed', '1', '--level', '1', '--attempts', '1', '--flat', '--no-grade', '--no-reflection', '--researcher', 'assisted',
    '--agents', 'senior=message', '--opening', 'senior', '--opening-minutes', '0.005', '--out', path.join(dir, 'run.json')], root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch: junior(asked) });
  const events = JSON.parse(fs.readFileSync(r.journal, 'utf8')).events as Record<string, any>[];
  assert.ok(events.some((e) => e.type === 'opening_missing'));
  assert.equal(asked[0].user.operator_messages, undefined);
});

test('the senior reads the junior\'s whole model and its methods in each round: its code, what it asks the Judge, its output', async () => {
  const { runDigest } = await import('../src/orchestra/view.ts');
  const { SENIOR_ROLE } = await import('../src/orchestra/agent-operator.ts');
  const law = { observations: { drive: { spec: { kind: 'code', lang: 'js', source: '(p) => p.inputs.AWCL[p.step]' } } },
    rules: { level: { type: 'score', instructions: 'Estimate the command from {{drive}}' } }, output: '(p, m) => ({ s1: m.rules.level })' };
  const d = runDigest({ experiment: 'x', events: [{ type: 'proposal', round: 1, rationale: 'r', law, fingerprint: 'f1' }, { type: 'methods', round: 1, methods: [{ do: 'write', id: 'pairs', text: 'compare matched pairs' }] }] });
  const r = d.latest_rounds[0];
  assert.equal(r.model.observations.drive, '(p) => p.inputs.AWCL[p.step]');
  assert.deepEqual(r.model.rules_for_the_judge.level, { type: 'score', asks: 'Estimate the command from {{drive}}' });
  assert.match(r.model.output, /m\.rules\.level/);
  assert.deepEqual(r.methods, [{ id: 'pairs', do: 'write', text: 'compare matched pairs' }]);
  assert.match(SENIOR_ROLE, /REVIEW ITS WORK FIRST/);
});

test('the senior is told the junior\'s own instruments: its sources (with their origins) and its selective memory', async () => {
  const { juniorInstruments } = await import('../src/orchestra/reader.ts');
  const { seniorSystem } = await import('../src/orchestra/agent-operator.ts');
  const s = juniorInstruments({ researcher: 'assisted', config: { sources_allow: 'D:/docs', memory: 'selective' }, events: [{ type: 'sources_allowed', origin: 'example.org' }] })!;
  assert.match(s, /SOURCES/);
  assert.match(s, /Its origins: D:\/docs, example\.org\./);
  assert.match(s, /MEMORY/);
  assert.equal(juniorInstruments({ researcher: 'unknown-world', config: { sources_allow: 'D:/docs' }, events: [] }), null);
  assert.match(seniorSystem(null, null, null, s), /THE JUNIOR'S OWN INSTRUMENTS/);
});

test('the senior\'s opening asks for the technical form of the model too: what code computes, whether and for what the Judge', async () => {
  const { SENIOR_ROLE } = await import('../src/orchestra/agent-operator.ts');
  assert.match(SENIOR_ROLE, /TECHNICAL FORM of its model/);
  assert.match(SENIOR_ROLE, /whether it uses the Judge's rules at all/);
});
