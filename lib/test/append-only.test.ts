import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';
import { runAgentOperator } from '../src/orchestra/agent-operator.ts';
import { UserParts, type ChatClient } from '../src/learn/system2.ts';
import type { FetchLike } from '../src/core/net.ts';
import { send } from '../src/runtime/control.ts';
import { cellsFocusLine } from '../src/worlds/cells/objective.ts';

/* The conversation with System 2 only ever grows (RoundConversation, lib/src/learn/system2.ts): what was sent once is
   never rewritten, so a provider's cache reuses it. The junior: its system prompt the same in every question of the run,
   and within a round each question the previous one with messages added at its end. The senior: its system prompt the
   same, and each question - across its calls, through the junior's rounds - the previous one with messages added.
   A consolidation (asked by the researcher, or forced when too long) is the one declared restart; these runs have none. */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Message = { role: string; content: string };

/** Whether `before` is `after`'s beginning, message by message; else the first message that differs. */
function prefixIssue(before: readonly unknown[], after: readonly unknown[]): string | null {
  if (after.length < before.length) return 'it has fewer messages (' + after.length + ' < ' + before.length + ')';
  for (let i = 0; i < before.length; i++) {
    const a = JSON.stringify(before[i]), b = JSON.stringify(after[i]);
    if (a !== b) return 'message ' + i + ' changed:\n  before ' + a.slice(0, 400) + '\n  after  ' + b.slice(0, 400);
  }
  return null;
}

test('the junior\'s conversation is never rewritten: one system prompt for the whole run, and within a round each question extends the previous one - with a senior writing to it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'append-only-'));
  const out = path.join(dir, 'run.json');
  const asked: Message[][] = [];
  /* The junior stands in: it looks twice every round, then proposes the same model; it never holds, so a senior is called. */
  const junior: FetchLike = async (_url, init) => {
    await sleep(30);
    const b = JSON.parse(String(init.body));
    const messages = b.messages as Message[];
    const sys = messages[0].content;
    const grading = sys.startsWith('You grade');
    if (!grading) asked.push(messages);
    const parts = messages.slice(1).map((m) => { try { return JSON.parse(m.content); } catch { return {}; } });
    const first = parts[0] ?? {};
    const looked = parts.filter((p) => p.investigation_step || p.investigation || p.results).length;
    const content = grading ? { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' }
      : 'task' in first ? { rationale: 'r', beliefs: [{ id: 'same', stance: 'keep', why: 'w' }], lessons: ['l'], next_experiment: 'n' }
      : looked < 2 ? { investigate: [{ view: 'ep1', from: 0, to: 2 }] }
      : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]', validate: false,
        beliefs: [{ id: 'same', stance: first.round === 1 ? 'new' : 'keep', statement: 'the row repeats', evidence: [] }], lessons: ['l'], next_experiment: 'n' };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
  const senior: ChatClient = { complete: async () => ({ content: JSON.stringify({ decision: 'message', text: 'Test whether the row depends on its neighbours.', evidence: ['check:r1'], why: 'stuck' }), latencyMs: 0, raw: null }) };
  const controller = new AbortController();
  const run = runLaboratory(cellsLab, { args: ['--seed', '1', '--level', '1', '--flat', '--tools', 'view', '--researcher', 'assisted', '--attempts', '5', '--steps', '3', '--agents', 'senior=message', '--out', out],
    root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch: junior });
  const agent = runAgentOperator({ id: 'senior', role: 'senior', patience: 1, journal: out, llm: senior, pollMs: 10, maxOrders: 2, signal: controller.signal });
  const r = await run;
  controller.abort();
  await agent;
  const events = JSON.parse(fs.readFileSync(r.journal, 'utf8')).events as Record<string, any>[];
  assert.ok(events.some((e) => e.type === 'operator_message'), 'a senior wrote to it');
  assert.ok(!events.some((e) => e.type === 'consolidated'), 'no consolidation here');
  assert.ok(asked.length >= 8, 'questions in several rounds: ' + asked.length);
  /* One system prompt, the same in every question of the run. */
  const systems = [...new Set(asked.map((m) => m[0].content))];
  assert.equal(systems.length, 1, 'its system prompt changed during the run:\n' + systems.map((s, i) => i + ': ...' + s.slice(-300)).join('\n'));
  /* Within a round (its first message, the round's context), each question extends the previous one. */
  let rounds = 0;
  for (let i = 1; i < asked.length; i++) {
    if (asked[i][1]?.content !== asked[i - 1][1]?.content) { rounds++; continue; }
    const issue = prefixIssue(asked[i - 1], asked[i]);
    assert.equal(issue, null, 'question ' + i + ' rewrote the conversation: ' + issue);
  }
  assert.ok(rounds >= 3, 'several rounds were compared: ' + rounds);
  /* What a directive is, told in its channel when the first came (the instructions, pinned by the harness: SPEC-CANAL-MENSAJES)
     - and again in every later round, after its first part. */
  const told = asked.findIndex((m) => m.some((x) => x.content.includes('"harness:instructions"') && x.content.includes('directive')));
  assert.ok(told > 0, "a directive's section came as a message");
  const later = asked.slice(told + 1).filter((m, i, all) => i === 0 || m[1]?.content !== all[i - 1][1]?.content);
  assert.ok(later.length > 0 && later.every((m) => m.slice(2).some((x) => x.content.includes('"harness:instructions"'))), 'and again in every later round');
});

test('a focus sent during the run rewrites no earlier message: the new instructions come as a message, the system prompt stays', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'append-only-focus-'));
  const asked: Message[][] = [];
  let journal = '', n = 0;
  const junior: FetchLike = async (_url, init) => {
    const b = JSON.parse(String(init.body));
    const messages = b.messages as Message[];
    const sys = messages[0].content;
    const grading = sys.startsWith('You grade');
    if (!grading) { asked.push(messages); if (++n === 2) send(journal, { kind: 'focus', facet: 'even', by: 'operator' }); }
    const first = (() => { try { return JSON.parse(messages[1].content); } catch { return {}; } })();
    const looked = messages.slice(2).length;
    const content = grading ? { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' }
      : 'task' in first ? { rationale: 'r', beliefs: [{ id: 'same', stance: 'keep', why: 'w' }], lessons: ['l'], next_experiment: 'n' }
      : looked < 1 ? { investigate: [{ view: 'ep1', from: 0, to: 2 }] }
      : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]', validate: false,
        beliefs: [{ id: 'same', stance: first.round === 1 ? 'new' : 'keep', statement: 'the row repeats', evidence: [] }], lessons: ['l'], next_experiment: 'n' };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
  await runLaboratory(cellsLab, { args: ['--seed', '1', '--level', '4', '--flat', '--no-grade', '--tools', 'view', '--researcher', 'assisted', '--attempts', '3', '--out', path.join(dir, 'run.json')],
    root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' }, onJournal: (f) => { journal = f; }, fetch: junior });
  assert.equal(new Set(asked.map((m) => m[0].content)).size, 1, 'its system prompt never changed');
  assert.ok(!asked[0][0].content.includes(cellsFocusLine('even')!));
  const at = asked.findIndex((m) => m.some((x) => x.content.includes('"harness:instructions"') && x.content.includes('"now"')));
  assert.ok(at > 0 && JSON.stringify(asked[at]).includes(JSON.stringify(cellsFocusLine('even')!).slice(1, -1)), 'the focused instructions came as a message');
  for (let i = 1; i < asked.length; i++) if (asked[i][1]?.content === asked[i - 1][1]?.content) assert.equal(prefixIssue(asked[i - 1], asked[i]), null, 'question ' + i);
});

test('the senior\'s conversation is never rewritten: one system prompt, and every question - across its calls and the junior\'s rounds - extends the previous one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'append-only-senior-'));
  const out = path.join(dir, 'run.json');
  const stuck: FetchLike = async (_url, init) => {
    await sleep(30);
    const b = JSON.parse(String(init.body));
    const sys = b.messages[0].content as string;
    const user = sys.startsWith('You grade') ? {} : JSON.parse(b.messages[1].content);
    const content = sys.startsWith('You grade') ? { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' }
      : 'task' in user ? { rationale: 'r', beliefs: [{ id: 'same', stance: 'keep', why: 'w' }], lessons: ['l'], next_experiment: 'n' }
      : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]', validate: false,
        beliefs: [{ id: 'same', stance: user.round === 1 ? 'new' : 'keep', statement: 'the row repeats', evidence: [] }], lessons: ['l'], next_experiment: 'n' };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
  const calls: { system: string; parts: readonly unknown[] }[] = [];
  const senior: ChatClient = { complete: async (r) => {
    assert.ok(r.user instanceof UserParts, 'the senior is asked in messages');
    calls.push({ system: r.system, parts: [...(r.user as UserParts).parts] });
    const read = calls.length % 2 === 1;
    const content = read ? { investigate: [{ memory: 'list', of: 'checks' }] }
      : { decision: 'message', text: 'Test whether the row depends on its neighbours (call ' + calls.length + ').', evidence: ['check:r1'], why: 'stuck' };
    return { content: JSON.stringify(content), latencyMs: 0, raw: null };
  } };
  const controller = new AbortController();
  const run = runLaboratory(cellsLab, { args: ['--seed', '1', '--level', '1', '--flat', '--tools', 'none', '--researcher', 'assisted', '--attempts', '8', '--agents', 'senior=message', '--out', out],
    root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch: stuck });
  const agent = runAgentOperator({ id: 'senior', role: 'senior', patience: 1, journal: out, llm: senior, pollMs: 10, maxOrders: 3, signal: controller.signal });
  await run;
  controller.abort();
  const { decisions } = await agent;
  assert.ok(decisions.filter((d) => d.decision === 'message').length >= 2, 'it was called more than once: ' + decisions.length);
  assert.ok(calls.length >= 4);
  assert.equal(new Set(calls.map((c) => c.system)).size, 1, 'its system prompt changed between calls');
  for (let i = 1; i < calls.length; i++) {
    const issue = prefixIssue(calls[i - 1].parts, calls[i].parts);
    assert.equal(issue, null, 'question ' + i + ' rewrote the conversation: ' + issue);
  }
});
