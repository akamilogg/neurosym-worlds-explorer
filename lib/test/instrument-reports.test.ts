import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { INSTRUMENT_SECTION, instrumentReports } from '../src/learn/instrument.ts';
import { assistedSystem, operatorClient } from '../src/learn/assisted/session.ts';
import { SENIOR_ROLE, agentFile, runAgentOperator } from '../src/orchestra/agent-operator.ts';
import type { ChatClient } from '../src/learn/system2.ts';

/* SPEC-CALIBRACION-INSTRUMENTOS §4 (A3): the assisted researcher and its senior may say the instrument failed - a suspicion
   logged for the operator, never a belief and never evidence, and it costs no step. */

test('a report is read from any answer: one or a list; its kind is one of the known, else "other"; one with no "what" is none', () => {
  assert.deepEqual(instrumentReports({ instrument_report: { what: ' the cut was not applied ', evidence: ['act3', 4], kind: 'accepted_but_not_applied' } }),
    [{ what: 'the cut was not applied', evidence: ['act3', '4'], kind: 'accepted_but_not_applied' }]);
  assert.deepEqual(instrumentReports({ instrument_report: [{ what: 'a', kind: 'weird' }, { evidence: ['x'] }] }), [{ what: 'a', evidence: [], kind: 'other' }]);
  assert.deepEqual(instrumentReports({ investigate: [] }), []);
  assert.deepEqual(instrumentReports(null), []);
});

test('the junior: its prompt says the instrument may fail and how to report it; each report is logged, numbered, as the junior\'s', async () => {
  assert.ok(assistedSystem('COMMON').endsWith(INSTRUMENT_SECTION));
  const logged: { type: string; data?: Record<string, unknown> }[] = [];
  const answers = [{ investigate: [{ view: 'ep1' }], instrument_report: { what: 'the same act answered twice differently', evidence: ['act1', 'act2'], kind: 'inconsistent_answer' } },
    { investigate: [], instrument_report: [{ what: 'a NaN in the table', evidence: ['act3@4'], kind: 'impossible_value' }] }];
  let n = 0;
  const inner: ChatClient = { complete: async () => ({ content: JSON.stringify(answers[n++]), latencyMs: 0, raw: null }) };
  const client = operatorClient(inner, { take: () => [], round: () => 3 }, (type, data) => logged.push({ type, data }));
  await client.complete({ system: 'S', user: { round: 3 } });
  await client.complete({ system: 'S', user: { round: 3 } });
  assert.deepEqual(logged.filter((l) => l.type === 'instrument_report').map((l) => l.data), [
    { question: 1, round: 3, id: 'ir1', by: 'junior', what: 'the same act answered twice differently', evidence: ['act1', 'act2'], kind: 'inconsistent_answer' },
    { question: 2, round: 3, id: 'ir2', by: 'junior', what: 'a NaN in the table', evidence: ['act3@4'], kind: 'impossible_value' }
  ]);
});

test('the senior: told it may report the instrument; what it reports goes with its decision', async () => {
  assert.match(SENIOR_ROLE, /"instrument_report"/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instrument-'));
  const out = path.join(dir, 'run.json');
  const check = (round: number) => ({ type: 'check', round, laboratories: [{ place: 'lab1', holds: false }] });
  fs.writeFileSync(out, JSON.stringify({ experiment: 'cells@1', researcher: 'assisted', events: [check(1), check(2), check(3)] }));
  fs.writeFileSync(out.replace(/\.json$/, '.status.json'), JSON.stringify({ state: 'running', heartbeat: new Date().toISOString(), pid: process.pid }));
  let calls = 0;
  const llm: ChatClient = { complete: async () => { calls++; return { content: JSON.stringify({ decision: 'wait', why: 'w',
    instrument_report: { what: 'its act asked for "remove" and the episode is the one without it', evidence: ['investigation:r2.1'], kind: 'accepted_but_not_applied' } }), latencyMs: 0, raw: null }; } };
  const controller = new AbortController();
  const agent = runAgentOperator({ id: 'senior', role: 'senior', journal: out, llm, pollMs: 10, maxOrders: 1, signal: controller.signal });
  const t = Date.now();
  while (!calls && Date.now() - t < 3000) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 50));
  controller.abort();
  await agent;
  const record = JSON.parse(fs.readFileSync(agentFile(out, 'senior'), 'utf8'));
  assert.deepEqual(record.decisions[0].instrument_reports, [{ what: 'its act asked for "remove" and the episode is the one without it', evidence: ['investigation:r2.1'], kind: 'accepted_but_not_applied' }]);
});
