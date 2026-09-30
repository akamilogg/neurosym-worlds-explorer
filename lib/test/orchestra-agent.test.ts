import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LabError, runLaboratory } from '../src/runtime/lab-runner.ts';
import { send } from '../src/runtime/control.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';
import { researcherEvents, runDigest } from '../src/orchestra/view.ts';
import { runAgentOperator } from '../src/orchestra/agent-operator.ts';
import type { ChatClient } from '../src/learn/system2.ts';
import type { FetchLike } from '../src/core/net.ts';

/* SPEC-ORQUESTADOR R1: the agent operator - what it sees (Q2), its policy, its help budget, its record. */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** System 2 standing in, stuck: the same model every round, never validating; a little slow, as a real one is. */
function stuck(asked: Record<string, any>[] = []): FetchLike {
  return async (_url, init) => {
    await sleep(40);
    const b = JSON.parse(String(init.body));
    const sys = b.messages[0].content as string, raw = b.messages[b.messages.length - 1].content as string;
    const user = sys.startsWith('You grade') ? {} : JSON.parse(raw);
    asked.push(user);
    const content = sys.startsWith('You grade') ? { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' }
      : 'task' in user ? { rationale: 'r', beliefs: [{ id: 'same', stance: 'keep', why: 'w' }], lessons: ['l'], next_experiment: 'test whether the row depends on its neighbours' }
      : { rationale: 'the row stays the same', observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]', validate: false,
        beliefs: [{ id: 'same', stance: user.round === 1 ? 'new' : 'keep', statement: 'the row repeats', evidence: [] }], lessons: ['l'], next_experiment: 'test whether the row depends on its neighbours' };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
}
const ARGS = ['--seed', '1', '--level', '1', '--flat', '--tools', 'none', '--researcher', 'assisted', '--attempts', '6'];
const llm = { url: 'http://system2.test/chat', model: 'stand-in' };
const eventsOf = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8')).events as Record<string, any>[];

/** An agent standing in: waits for two rounds, then holds up the researcher's own untested plan, once. */
function coach(seen: unknown[]): ChatClient {
  let wrote = false;
  return { complete: async (r) => {
    seen.push(r.user);
    const run = (r.user as { run: { rounds_so_far: number; latest_rounds: { next_experiment?: string }[] } }).run;
    const plan = run.latest_rounds.at(-1)?.next_experiment;
    const content = run.rounds_so_far >= 2 && !wrote
      ? { decision: 'message', text: 'You planned to "' + plan + '" and have not run it.', why: 'the same model every round' } : { decision: 'wait', why: 'too early, or already pushed' };
    if (content.decision === 'message') wrote = true;
    return { content: JSON.stringify(content), latencyMs: 0, raw: null };
  } };
}

test('what an agent sees is what the researcher lived: no hidden part, no operator measure, no truth', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-'));
  const r = await runLaboratory(cellsLab, { args: [...ARGS, '--attempts', '2', '--out', path.join(dir, 'run.json')], root: dir, llm, fetch: stuck() });
  const journal = JSON.parse(fs.readFileSync(r.journal, 'utf8'));
  const visible = JSON.stringify([researcherEvents(journal), runDigest(journal)]);
  for (const t of journal.hidden_from_the_learner.truth as { statement: string }[]) assert.ok(!visible.includes(t.statement), 'the truth never');
  assert.doesNotMatch(visible, /hidden_from_the_learner|operator_(rule|law)_recovery|operator_ablation|"trace"|"came"/);
  assert.ok(researcherEvents(journal).some((e) => e.type === 'check' && e.laboratories[0].holds === false), 'whether its model held: yes');
});

test('an agent follows a stuck assisted run and writes to it; the run takes it only within its policy, and the finding says an agent wrote it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-'));
  const out = path.join(dir, 'run.json');
  const seen: unknown[] = [];
  const controller = new AbortController();
  /* An agent the policy does not name, and a stop the coach may not send. */
  send(out, { kind: 'message', text: 'from a stranger', by: 'agent:stranger' });
  send(out, { kind: 'stop', by: 'agent:coach' });
  const run = runLaboratory(cellsLab, { args: [...ARGS, '--agents', 'coach=message', '--out', out], root: dir, llm, fetch: stuck() });
  const agent = runAgentOperator({ id: 'coach', journal: out, llm: coach(seen), pollMs: 15, signal: controller.signal });
  const r = await run;
  controller.abort();
  const { decisions, file } = await agent;
  const events = eventsOf(r.journal);
  const refused = events.filter((e) => e.type === 'operator_command_refused').map((e) => e.reason);
  assert.ok(refused.some((x) => /agent stranger may not send message/.test(x)));
  assert.ok(refused.some((x) => /agent coach may not send stop/.test(x)));
  const message = decisions.find((d) => d.decision === 'message')!;
  assert.match(message.text!, /have not run it/);
  assert.match(message.outcome!, /accepted/);
  assert.deepEqual(r.finding.assistance!.messages.map((m) => [m.by, m.author]), [['agent:coach', 'agent']]);
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(record.format, 'agent@1');
  assert.ok(record.decisions.length >= 2 && record.decisions.every((d: { why?: string }) => typeof d.why === 'string'), 'every decision with its reason');
  /* It read the run as the researcher lived it. */
  assert.doesNotMatch(JSON.stringify(seen), /hidden_from_the_learner|operator_rule_recovery|wraps around/);
});

test('without --agents no agent may order a run; a person may; the help budget counts everyone\'s help', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-'));
  const out = path.join(dir, 'run.json');
  send(out, { kind: 'message', text: 'from an agent', by: 'agent:coach' });
  send(out, { kind: 'message', text: 'first', by: 'operator' });
  send(out, { kind: 'message', text: 'second', by: 'operator' });
  const r = await runLaboratory(cellsLab, { args: [...ARGS, '--attempts', '2', '--help-budget', '1', '--out', out], root: dir, llm, fetch: stuck() });
  const refused = eventsOf(r.journal).filter((e) => e.type === 'operator_command_refused').map((e) => e.reason);
  assert.ok(refused.some((x) => /no agent may: --agents/.test(x)));
  assert.ok(refused.some((x) => /help budget of this run is spent \(1\)/.test(x)));
  assert.deepEqual(r.finding.assistance!.messages.map((m) => [m.text, m.author]), [['first', 'person']]);
  assert.equal(r.finding.assistance!.help_budget, 1);
  await assert.rejects(runLaboratory(cellsLab, { args: [...ARGS, '--agents', 'coach=shout', '--out', path.join(dir, 'x.json')], root: dir, llm, fetch: stuck() }), (e) => e instanceof LabError && /unknown order shout/.test(e.message));
});
