import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OwnTests, type OwnTestsHost } from '../src/learn/assisted/own-tests.ts';
import { DIRECTIVES_SECTION } from '../src/learn/assisted/session.ts';
import { ownTestsOf, findingOf, findingText } from '../src/learn/finding.ts';
import { judgeMethod, TEST_QUESTIONS } from '../src/audit/judge.ts';
import { measuresOf } from '../src/audit/audit.ts';
import { linksOf } from '../src/audit/links.ts';
import { batchTable, rowOf } from '../src/orchestra/batch.ts';
import { agentFile, runAgentOperator } from '../src/orchestra/agent-operator.ts';
import type { ChatClient } from '../src/learn/system2.ts';
import type { Judge } from '../src/core/types.ts';

/* SPEC-PRUEBAS-PROPIAS T4: the senior orders a test; the audit asks of each test whether its rival was genuine and its claim
   what its protocol tells apart; the finding and the batch report count them. */

/** A world of numbers: a model is a number, it holds where it is at least the episode's; the rival "0" holds nowhere new. */
function host(logged: Record<string, any>[]): OwnTestsHost<number, { x: number }, number> {
  return {
    parseAct: (raw) => (typeof raw.x === 'number' ? { x: raw.x } : 'x'), asWritten: (a) => a, placeOf: () => 'lab1', laboratories: () => ['lab1'],
    identity: (_p, a) => 'x=' + a.x, identities: true, seen: () => ({ identities: new Map(), acts: new Map() }),
    model: (ref) => (typeof ref === 'number' ? ref : 'a number'), rival: (n) => (n === 'zero' ? 0 : null), rivalNames: () => ['zero'],
    fingerprint: (l) => 'm' + l, describe: (l) => ({ output: String(l) }), sharedHolds: async () => 1,
    start: async (_p, a) => a.x, cases: () => [1], evaluate: async (law, _p, _c) => ({ holds: law >= 5, view: {} }), answers: async () => true,
    log: (type, data) => logged.push({ type, ...data })
  };
}

test('a test the senior ordered is registered as the junior\'s, attributed to its senior; the finding and the batch count it', async () => {
  assert.match(DIRECTIVES_SECTION, /"directive": "<the message id>"/);
  const logged: Record<string, any>[] = [];
  const tests = new OwnTests(host(logged));
  const budget = { acts: 3 };
  await tests.register({ register_test: { protocol: { x: 7 }, model: 9, rival: 'rival:zero', claim: 'it holds at 7', kind: 'new', directive: 'order-1' } }, 2, budget);
  await tests.register({ register_test: { protocol: { x: 8 }, model: 3, rival: 'rival:zero', claim: 'c', kind: 'new' } }, 2, budget);
  await tests.runPending(2);
  await tests.closeBy(9, 3);
  const registered = logged.filter((e) => e.type === 'test_registered');
  assert.deepEqual(registered.map((e) => [e.test, e.by, e.directive ?? null]), [['t1', 'senior', 'order-1'], ['t2', 'you', null]]);
  assert.deepEqual(registered[0].rival_law, { output: '0' }, 'the audit reads what the rival is');
  const events = logged.map((e, i) => ({ ...e, round: e.round ?? 3, t: i }));
  const m = ownTestsOf(events, { own_tests: { required: 1, final_model: { passed_preregistered: ['t1'], passed_regression: ['t2'], failing: [] } } })!;
  assert.deepEqual([m.registered, m.valid, m.severe, m.by, m.kinds, m.counterexamples], [2, 2, 1, { junior: 1, senior: 1 }, { new: 2, replicate: 0 },
    { found: 1, closed: 1, rounds_open: [1] }]);
  const journal = { experiment: 'cells@1', researcher: 'assisted', events: [...events, { type: 'end', stoppedBy: 'accepted', own_tests: { required: 1, final_model: { passed_preregistered: ['t1'], passed_regression: ['t2'], failing: [] } } }] };
  const f = findingOf(journal, { journal: 'run.json' });
  assert.equal(f.own_tests!.by.senior, 1);
  assert.match(findingText(f), /tests of its own: 2 registered \(1 by the junior, 1 ordered by its senior; 2 new, 0 replications\), 2 valid, 1 severe; 1 counterexample\(s\), 1 closed; the final model: 1 passed as registered with it, 1 on regression \(1 required\)/);
  const row = rowOf({ id: 'r1', lab: 'cells', condition: 'own-tests' }, null, f);
  assert.deepEqual(row.own_tests, { registered: 2, severe: 1, by_senior: 1, counterexamples: 1, closed: 1, preregistered_final: 1 });
  assert.equal(batchTable([row])[0].severe_tests.median, 1);
});

test('the senior is told how the junior tests its model, and may order a test with its message', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'senior-test-'));
  const out = path.join(dir, 'run.json');
  const check = (round: number) => ({ type: 'check', round, laboratories: [{ place: 'lab1', holds: false }] });
  fs.writeFileSync(out, JSON.stringify({ experiment: 'cells@1', researcher: 'assisted', config: { seed: 1, ownTests: 2 }, events: [check(1), check(2), check(3)] }));
  fs.writeFileSync(out.replace(/\.json$/, '.status.json'), JSON.stringify({ state: 'running', heartbeat: new Date().toISOString(), pid: process.pid }));
  const systems: string[] = [];
  const order = { protocol: { row: '..##..' }, rival: 3, claim: 'its model and round 3 part on a lone block', kind: 'new' };
  const llm: ChatClient = { complete: async (q) => { systems.push(q.system); return { content: JSON.stringify({ decision: 'message', text: 'Register this test.', why: 'w', test: order }), latencyMs: 0, raw: null }; } };
  const controller = new AbortController();
  const agent = runAgentOperator({ id: 'senior', role: 'senior', journal: out, llm, pollMs: 10, maxOrders: 1, signal: controller.signal });
  const t = Date.now();
  while (!systems.length && Date.now() - t < 3000) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 50));
  controller.abort();
  await agent;
  assert.match(systems[0], /HOW THE JUNIOR MAY TEST ITS MODEL/);
  assert.match(systems[0], /IN THIS RUN THEY COUNT: a model of yours is confirmed in the places nobody has seen only once it has passed 2 severe tests/);
  assert.match(systems[0], /YOU MAY ORDER A TEST/);
  const inbox = fs.readFileSync(out.replace(/\.json$/, '.inbox.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual([inbox[0].directive, inbox[0].test], [true, order]);
  assert.deepEqual(JSON.parse(fs.readFileSync(agentFile(out, 'senior'), 'utf8')).decisions[0].test, order);
});

test('the audit asks of each registered test whether its rival was genuine and its claim what its protocol tells apart', async () => {
  const asked: Record<string, string>[] = [];
  const judge: Judge = { judge: async (req: { texts: Record<string, string>; questions: Record<string, unknown> }) => {
    if ('rival' in req.questions) asked.push(req.texts);
    return Object.fromEntries(Object.keys(req.questions).map((id) => [id, { value: 1, confidence: 0.8,
      raw: { probabilities: id === 'rival' ? { straw_man: 0.7, genuine: 0.3 } : id === 'claim' ? { matches: 0.9, overstates: 0.1 } : {} } }]));
  } } as never;
  const tests = [{ type: 'test_registered', test: 't1', protocol: { x: 7 }, claim: 'it holds at 7', model_law: { output: '9' }, rival_law: { output: '0' }, shared: { model_holds_in: 1, rival_holds_in: 1 } }];
  const record = linksOf({ events: [] });
  const judged = await judgeMethod(record, judge, tests);
  assert.deepEqual(Object.keys(TEST_QUESTIONS), ['rival', 'claim']);
  assert.equal(judged.tests!.t1.rival!.answer, 'straw_man');
  assert.match(asked[0].rival, /"output":"0"/);
  assert.ok(!('result' in asked[0]), 'never how the test came out');
  const m = measuresOf(record, judged);
  assert.deepEqual([m.judged!.test_rival, m.judged!.test_claim], [{ straw_man: 1 }, { matches: 1 }]);
});
