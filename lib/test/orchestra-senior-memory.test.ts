import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentFile, runAgentOperator, SENIOR_ROLE } from '../src/orchestra/agent-operator.ts';
import { UserParts, type ChatClient } from '../src/learn/system2.ts';

/* SPEC-ORQUESTADOR §3.3.1: the senior as a researcher with a memory of its own - one conversation for the whole run that
   only grows, its own notebook, its memory over it, consolidating itself, and its state carried into a run resumed. */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const check = (round: number) => ({ type: 'check', round, laboratories: [{ place: 'lab1', holds: false }] });
const until = async (ok: () => boolean, ms = 3000) => { const t = Date.now(); while (!ok() && Date.now() - t < ms) await sleep(10); };

/** A run's journal, still going (its status says so), with the events given. */
function journal(dir: string, name: string, events: Record<string, unknown>[]): string {
  const out = path.join(dir, name + '.json');
  fs.writeFileSync(out, JSON.stringify({ experiment: 'cells@1', researcher: 'assisted', events }));
  fs.writeFileSync(out.replace(/\.json$/, '.status.json'), JSON.stringify({ state: 'running', heartbeat: new Date().toISOString(), pid: process.pid }));
  return out;
}
const scripted = (answers: ((n: number) => Record<string, unknown>)) => {
  const calls: UserParts[] = [];
  const llm: ChatClient = { complete: async (r) => {
    calls.push(r.user as UserParts);
    return { content: JSON.stringify(answers(calls.length)), latencyMs: 0, raw: { usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 600 } } } };
  } };
  return { calls, llm };
};

test('its conversation lasts the run: a later decision repeats every earlier part and adds only what is new; it writes in its notebook and reads it back', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'senior-mem-'));
  const out = journal(dir, 'run', [check(1), check(2), check(3)]);
  const { calls, llm } = scripted((n) => n === 1 ? { investigate: [{ memory: 'list', of: 'checks' }], notes: [{ do: 'write', id: 'idea', text: 'the row repeats in every check' }],
    beliefs: [{ id: 'repeats', stance: 'new', statement: 'the row repeats', evidence: ['check:r3'] }] }
    : n === 2 ? { decision: 'wait', why: 'nothing yet' }
    : n === 3 ? { investigate: [{ memory: 'list', of: 'my_notes' }, { memory: 'open', items: ['my_belief:repeats', 'my_decision:1', 'check:r4'] }] }
    : { decision: 'wait', why: 'still nothing', beliefs: [{ id: 'repeats', stance: 'confirm', why: 'round 4 too', evidence: ['check:r4'] }] });
  const controller = new AbortController();
  const agent = runAgentOperator({ id: 'senior', role: 'senior', journal: out, llm, pollMs: 10, signal: controller.signal });
  await until(() => calls.length >= 2);
  await sleep(30);
  fs.writeFileSync(out, JSON.stringify({ experiment: 'cells@1', researcher: 'assisted', events: [check(1), check(2), check(3), check(4)] }));
  await until(() => calls.length >= 4);
  controller.abort();
  const { decisions } = await agent;
  assert.equal(decisions.length, 2);
  /* The second decision's question starts with everything the first one sent, as it was: its prefix is cached. */
  const first = calls[1].parts, later = calls[2].parts;
  assert.deepEqual(later.slice(0, first.length), first, 'nothing sent is rewritten');
  const added = later.slice(first.length) as Record<string, any>[];
  assert.ok(added[0].your_decision, 'what it decided stays in its conversation');
  assert.deepEqual(added[1].new_rounds.map((r: { round: number }) => r.round), [4], 'only the round completed since');
  assert.equal(added[2].call.n, 2);
  assert.ok((first[2] as Record<string, any>).you_wrote.notes, 'what it wrote is said back to it');
  /* It reads its own notebook and decisions next to the junior's record. */
  const read = (calls[3].parts.at(-1) as Record<string, any>).investigation_step.results;
  assert.deepEqual(read[0].index.map((i: { id: string }) => i.id), ['my_note:idea']);
  assert.deepEqual(read[1].items.map((i: { id: string }) => i.id), ['my_belief:repeats', 'my_decision:1', 'check:r4']);
  assert.equal(read[1].items[1].item.decision, 'wait');
  /* Its notebook is kept in its record, the junior never shown it. */
  const record = JSON.parse(fs.readFileSync(agentFile(out, 'senior'), 'utf8'));
  assert.equal(record.senior.notebook.notes[0].text, 'the row repeats in every check');
  assert.equal(record.senior.notebook.beliefs[0].status, 'confirmed');
  assert.equal(record.senior.since, 4);
  assert.deepEqual(decisions[1].wrote, { beliefs: [{ id: 'repeats', stance: 'confirm', why: 'round 4 too', evidence: ['check:r4'] }] });
  assert.match(SENIOR_ROLE, /YOUR NOTEBOOK is yours/);
});

test('it consolidates its conversation itself; grown too long, it is asked to', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'senior-mem-'));
  const out = journal(dir, 'run', [check(1), check(2), check(3)]);
  const { calls, llm } = scripted((n) => n === 1 ? { investigate: [{ memory: 'list', of: 'checks' }] }
    : n === 2 ? { consolidate: { summary: 'three checks failed alike', keep: ['d1.1'] }, notes: [{ do: 'write', id: 'kept', text: 'what matters' }] }
    : { decision: 'wait', why: 'w' });
  const controller = new AbortController();
  const agent = runAgentOperator({ id: 'senior', role: 'senior', journal: out, llm, pollMs: 10, signal: controller.signal });
  await until(() => calls.length >= 3);
  controller.abort();
  await agent;
  const after = calls[2].parts as Record<string, any>[];
  assert.ok(after[0].your_notebook.notes.some((n: { id: string }) => n.id === 'kept'), 'it goes on from its notebook as it is');
  assert.equal(after[1].consolidated.summary, 'three checks failed alike');
  assert.equal(after[1].consolidated.kept_steps[0].step, 'd1.1', 'with the steps it kept');
  assert.ok(after[2].call, 'and why it was called');
  assert.equal(after.length, 3, 'the rest is gone from it');

  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'senior-mem-'));
  const out2 = journal(dir2, 'run', [check(1), check(2), check(3)]);
  const s = scripted(() => ({ decision: 'wait', why: 'w' }));
  const c2 = new AbortController();
  const agent2 = runAgentOperator({ id: 'senior', role: 'senior', journal: out2, llm: s.llm, pollMs: 10, signal: c2.signal, maxContextTokens: 100 });
  await until(() => s.calls.length >= 1);
  c2.abort();
  await agent2;
  assert.match(JSON.stringify(s.calls[0].parts.at(-1)), /consolidate it now/, 'asked to consolidate before anything else');
});

test('a run resumed: the senior goes on with the state of the run it derives from - its notebook, its conversation, its orders', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'senior-mem-'));
  const before = journal(dir, 'run', [{ type: 'start' }, check(1), check(2), check(3)]);
  const first = scripted((n) => n === 1 ? { decision: 'message', text: 'Hypothesis: the row repeats. Test it.', why: 'w', notes: [{ do: 'write', id: 'plan', text: 'follow the repeat' }] } : { decision: 'wait', why: 'w' });
  const c1 = new AbortController();
  const a1 = runAgentOperator({ id: 'senior', role: 'senior', journal: before, llm: first.llm, pollMs: 10, maxOrders: 3, signal: c1.signal });
  await until(() => first.calls.length >= 1);
  await sleep(40);
  c1.abort();
  await a1;
  const opening = first.calls[0].parts[0];

  /* The run resumed: a journal of its own whose start says what it resumes; the junior got the message and went on. */
  const after = journal(dir, 'run.resumed', [{ type: 'start', resumed_from: before }, check(1), check(2), check(3),
    { type: 'operator_command', by: 'agent:senior', kind: 'message', accepted: true }, { type: 'operator_message', question: 9, messages: [{ by: 'agent:senior', text: 'x' }] },
    check(4), check(5), check(6)]);
  const said: string[] = [];
  const second = scripted(() => ({ investigate: [{ memory: 'open', items: ['my_note:plan', 'my_decision:1'] }] }));
  const c2 = new AbortController();
  const a2 = runAgentOperator({ id: 'senior', role: 'senior', journal: after, llm: second.llm, pollMs: 10, maxOrders: 3, readSteps: 1, signal: c2.signal, say: (l) => said.push(l) });
  await until(() => second.calls.length >= 2);
  c2.abort();
  await a2;
  assert.match(said[0], /goes on from run\.agent-senior\.json \(1 decisions, 1 orders\)/);
  assert.deepEqual(second.calls[0].parts[0], opening, 'its conversation goes on where it was');
  assert.ok((second.calls[0].parts as Record<string, any>[]).some((p) => p.new_rounds?.some((r: { round: number }) => r.round === 6)), 'with the rounds since');
  const read = (second.calls[1].parts.at(-1) as Record<string, any>).investigation_step.results[0].items;
  assert.equal(read[0].item.text, 'follow the repeat', 'its notebook came with it');
  assert.equal(read[1].item.decision, 'message', 'and its earlier decisions');
  const record = JSON.parse(fs.readFileSync(agentFile(after, 'senior'), 'utf8'));
  assert.equal(record.continued_from, agentFile(before, 'senior'));
  assert.equal(record.earlier.decisions.length, 1);
});

test('what the senior understood is graded from its own notebook, into its record; the batch says what it cost and how much was cached', async () => {
  const { gradeSenior } = await import('../src/runtime/regrade.ts');
  const { rowOf, batchText } = await import('../src/orchestra/batch.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'senior-mem-'));
  const out = path.join(dir, 'run.json');
  fs.writeFileSync(out, JSON.stringify({ experiment: 'cells@1', researcher: 'assisted', hidden_from_the_learner: { truth: [{ id: 'r1', statement: 'the row repeats' }, { id: 'r2', statement: 'edges wrap' }] },
    events: [{ type: 'start' }, { type: 'end', stoppedBy: 'budget' }] }));
  fs.writeFileSync(agentFile(out, 'senior'), JSON.stringify({ format: 'agent@1', role: 'senior', decisions: [{ decision: 'message', text: 'Hypothesis: it repeats', rounds: 2, at: 'x', usage: { calls: 3, tokens_in: 30000, cached_in: 24000, tokens_out: 300, cost: 0.05 } }],
    earlier: { decisions: [{ decision: 'wait', rounds: 1, at: 'x', usage: { calls: 1, tokens_in: 10000, cached_in: 0, tokens_out: 100, cost: 0.02 } }] },
    senior: { notebook: { beliefs: [{ id: 'repeats', statement: 'the row repeats', status: 'confirmed', since: 1, history: [] }], notes: [{ id: 'n', text: 'edges unclear' }], methods: [] } } }));
  let asked: any = null;
  const g = await gradeSenior(out, agentFile(out, 'senior'), { complete: async (q) => { asked = JSON.parse(String(q.user));
    return { content: JSON.stringify({ grades: [{ id: 'r1', grade: 'exact' }, { id: 'r2', grade: 'absent' }], false_beliefs: [], form: 'compact', form_evidence: 'e' }), latencyMs: 0, raw: null }; } }, 'grader');
  assert.equal(g.score, 0.5);
  assert.deepEqual(asked.learner.beliefs, [{ id: 'repeats', statement: 'the row repeats', status: 'confirmed' }], 'its notebook is what is graded');
  assert.deepEqual(asked.learner.messages_to_the_junior, ['Hypothesis: it repeats']);
  const record = JSON.parse(fs.readFileSync(agentFile(out, 'senior'), 'utf8'));
  assert.equal(record.gradings[0].subject, 'senior');
  assert.ok(!JSON.parse(fs.readFileSync(out, 'utf8')).events.some((e: { type: string }) => e.type === 'operator_rule_recovery'), 'never into the run\'s journal');
  const row = rowOf({ id: 'a', lab: 'cells', condition: 'c', agent: { id: 'senior', role: 'senior' } }, out, null);
  assert.deepEqual(row.agent, { id: 'senior', decisions: 2, calls: 4, tokens_in: 40000, cached_share: 0.6, cost: 0.07 });
  assert.match(batchText({ format: 'batch@1', id: 'b', definition: { id: 'b', runs: [] }, dir, started: 'x', runs: [row], table: [], audit: [] } as never), /agent:senior 2 decisions, 4 calls, 40k tokens in \(60% cached\), \$0\.07/);
});
