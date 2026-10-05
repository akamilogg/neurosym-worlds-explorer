import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';
import { journalReader, stuckSignals } from '../src/orchestra/reader.ts';
import { runAgentOperator, SENIOR_HEAD, SENIOR_ROLE } from '../src/orchestra/agent-operator.ts';
import { juniorBrief, juniorPercept } from '../src/orchestra/reader.ts';
import { system2Prompt } from '../src/learn/prompt.ts';
import { explorerSystem } from '../src/learn/explorer.ts';
import { cellsInterface } from '../src/worlds/cells/interface.ts';
import type { ChatClient } from '../src/learn/system2.ts';
import type { FetchLike } from '../src/core/net.ts';
import { payloadOf, userOf } from './support.ts';


/* SPEC-ORQUESTADOR §3.3: the senior - it reads the junior's record (exactly what the junior saw) when the junior is stuck,
   and proposes a hypothesis its data suggest. */

/** A grid-like journal, by hand: what the junior did and was answered, and what it was never shown. */
const JOURNAL = {
  experiment: 'unknown-world@1', researcher: 'assisted',
  hidden_from_the_learner: { truth: 'SECRET the other wins at column 4' },
  events: [
    { type: 'exploration_game', game: 'g1', winner: 'B', reason: 'reach', plies: 8, frames: [] },
    { type: 'investigation', round: 1, requests: [{ act: 'g1@0', from: [0, 4], to: [0, 3] }], results: [{ act: 'g1@0', accepted: true }],
      notes: [{ do: 'write', id: 'acts', text: 'left was accepted at g1@0' }] },
    { type: 'proposal', round: 1, beliefs: [{ id: 'corner', stance: 'new', statement: 'losses end at the upper-right corner' }], rationale: 'r', lessons: ['l'], next_experiment: 'n',
      formula: { observations: { d: { definition: 'distance', spec: { kind: 'code', source: '(p) => 1' }, range: [0, 1] } }, rules: {}, weights: {}, output: { kind: 'code', source: '(p, m) => 0.5' } } },
    { type: 'check', round: 1, laboratories: [{ place: 'lab1', holds: false, wins: 3, total: 8, rerun: { went_up: 0, went_down: 1 }, action_accuracy: { rate: 0.5 } }],
      operator_analysis: { surprises: 'SECRET operator measure' } },
    { type: 'played_by_the_learner', round: 2, game: 'g9', from: 'g1@0', how: 'a draft model', result: 'won', turns: 12, reason: 'trap' },
    { type: 'operator_rule_recovery', truth: [{ statement: 'SECRET you win by trapping' }] }
  ]
};

test('the senior reads exactly what the junior saw: its answers and verdicts, never the hidden part, the operator\'s measures nor how an episode ended', async () => {
  const reader = journalReader(JOURNAL);
  const opened = await reader.run({ memory: 'open', items: ['investigation:r1.1', 'check:r1', 'model:r1', 'belief:corner', 'note:acts', 'episode:g1', 'episode:g9'] }) as { items: { id: string; item: any }[] };
  const by = Object.fromEntries(opened.items.map((i) => [i.id, i.item]));
  assert.deepEqual(by['investigation:r1.1'].results, [{ act: 'g1@0', accepted: true }], 'what an act answered');
  assert.deepEqual(by['check:r1'].laboratories, [{ place: 'lab1', holds: false, scored_1: 3, of: 8, rerun: { went_up: 0, went_down: 1 } }], 'the verdicts as given');
  assert.ok(by['model:r1'].model.observations.d.source, 'its model in its own words');
  assert.equal(by['belief:corner'].statement, 'losses end at the upper-right corner');
  assert.equal(by['note:acts'].text, 'left was accepted at g1@0');
  assert.deepEqual([by['episode:g1'].score, by['episode:g9'].score], [-1, 1]);
  const everything = JSON.stringify(await reader.run({ memory: 'find', words: 'secret' })) + JSON.stringify(opened);
  assert.doesNotMatch(everything, /SECRET|trap|reach|action_accuracy/, 'nothing it was not shown');
});

test('signs of being stuck are facts of the record', () => {
  const nowhere = (round: number) => ({ type: 'check', round, laboratories: [{ place: 'lab1', holds: false }] });
  const same = { view: 'g1', from: 0, to: 8 };
  const s = stuckSignals({ events: [nowhere(1), nowhere(2), nowhere(3),
    { type: 'investigation', round: 3, requests: [same, same, same] }, { type: 'investigation_refused', round: 3 }, { type: 'investigation_refused', round: 3 }] });
  assert.equal(s.holding_nowhere_in_a_row, 3);
  assert.equal(s.repeated_requests, 2);
  assert.equal(s.signs.length, 3);
  assert.deepEqual(stuckSignals({ events: [nowhere(1), { type: 'check', round: 2, laboratories: [{ place: 'lab1', holds: true }] }] }).signs, []);
});

/* --- A whole run: the junior (System 2 standing in) is stuck; the senior is called, reads its record, and writes once. */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stuck: FetchLike = async (_url, init) => {
  await sleep(40);
  const b = JSON.parse(String(init.body));
  const sys = b.messages[0].content as string, raw = userOf(b);
  const user = sys.startsWith('You grade') ? {} : JSON.parse(raw);
  const content = sys.startsWith('You grade') ? { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' }
    : 'task' in user ? { rationale: 'r', beliefs: [{ id: 'same', stance: 'keep', why: 'w' }], lessons: ['l'], next_experiment: 'n' }
    : { rationale: 'the row stays the same', observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]', validate: false,
      beliefs: [{ id: 'same', stance: user.round === 1 ? 'new' : 'keep', statement: 'the row repeats', evidence: [] }], lessons: ['l'], next_experiment: 'test whether the row depends on its neighbours' };
  const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
  return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
};

function senior(seen: { system: string; user: any }[]): ChatClient {
  return { complete: async (r) => {
    seen.push({ system: r.system, user: payloadOf(r.user) });
    const content = !payloadOf(r.user).investigation ? { investigate: [{ memory: 'find', words: 'repeats', of: 'beliefs' }, { memory: 'list', of: 'checks' }] }
      : { decision: 'message', text: 'Hypothesis: the row depends on its neighbours (belief:same never changed while no place held). Test it: measure each cell against its neighbours one step earlier.',
        evidence: ['belief:same', 'check:r1'], why: 'the same model every round, holding nowhere' };
    return { content: JSON.stringify(content), latencyMs: 0, raw: null };
  } };
}

test('a senior is called only when the junior is stuck, reads its record, proposes a hypothesis with its evidence; the junior gets it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'senior-'));
  const out = path.join(dir, 'run.json');
  const seen: { system: string; user: any }[] = [];
  const controller = new AbortController();
  const run = runLaboratory(cellsLab, { args: ['--seed', '1', '--level', '1', '--flat', '--tools', 'none', '--researcher', 'assisted', '--attempts', '6', '--agents', 'senior=message', '--out', out],
    root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch: stuck });
  const agent = runAgentOperator({ id: 'senior', role: 'senior', patience: 2, journal: out, llm: senior(seen), pollMs: 15, maxOrders: 1, signal: controller.signal });
  const r = await run;
  controller.abort();
  const { decisions, file } = await agent;
  assert.ok(seen.length >= 2);
  /* Its prompt: its role, then the junior's brief word for word (without the shape of a proposal), then its instructions. */
  const brief = juniorBrief(JSON.parse(fs.readFileSync(out, 'utf8')))!;
  for (const s of seen) {
    assert.ok(s.system.startsWith(SENIOR_HEAD) && s.system.endsWith(SENIOR_ROLE));
    assert.ok(s.system.includes(brief));
    assert.ok(s.system.includes(juniorPercept(JSON.parse(fs.readFileSync(out, 'utf8')))!), 'and what the code of the junior receives at a point');
  }
  assert.match(seen[0].user.signals.join(' '), /held in no place/, 'called for a sign of being stuck');
  assert.ok(seen[1].user.investigation[0].results[0].items.some((i: { id: string }) => i.id === 'belief:same'), 'it read the record');
  const message = decisions.find((d) => d.decision === 'message')!;
  assert.deepEqual(message.evidence, ['belief:same', 'check:r1']);
  assert.ok(message.read && message.read.length === 1);
  assert.match(message.outcome!, /accepted/);
  const events = JSON.parse(fs.readFileSync(r.journal, 'utf8')).events as Record<string, any>[];
  const delivered = events.filter((e) => e.type === 'operator_message').flatMap((e) => e.messages);
  assert.ok(delivered.some((m: { by: string; text: string }) => m.by === 'agent:senior' && /Hypothesis/.test(m.text)), 'the junior received it');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).role, 'senior');
  const journal = JSON.parse(fs.readFileSync(r.journal, 'utf8'));
  const inputs = JSON.stringify(seen.map((s) => s.user));
  for (const t of journal.hidden_from_the_learner.truth as { statement: string }[]) assert.ok(!inputs.includes(t.statement), 'never the truth');
});

test('the junior\'s brief is its prompt word for word, its world\'s interface included, without the shape of a proposal', () => {
  const grid = juniorBrief({ experiment: 'unknown-world@1', config: { tools: ['view', 'act', 'table'] } })!;
  const full = explorerSystem(new Set(['view', 'act', 'table']) as never);
  assert.ok(full.startsWith(grid), 'the same text');
  assert.match(grid, /THIS ENVIRONMENT'S INTERFACE/);
  assert.match(grid, /"act": "<point>"/, 'what an act is');
  assert.doesNotMatch(grid, /When you propose, answer with ONE JSON object/);
  const cells = juniorBrief({ experiment: 'cells@1', config: { tools: ['view'], regression: true } });
  if (cells) assert.ok(system2Prompt(cellsInterface({ regression: true }), new Set(['view'])).startsWith(cells));
  assert.equal(juniorBrief({ experiment: 'nowhere@1' }), null);
  /* What the junior's code receives at a point reaches it with every round, not in its brief: the senior is given it apart. */
  assert.match(juniorPercept({ experiment: 'c302-navigation@1' })!, /p = \{ step, t, inputs \}/);
  assert.match(juniorPercept({ experiment: 'unknown-world@1' })!, /./);
  assert.equal(juniorPercept({ experiment: 'nowhere@1' }), null);
});

test('an agent that cannot reach its model says so on its console, with the signs it was called for', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'senior-'));
  const out = path.join(dir, 'run.json');
  const lines: string[] = [];
  const controller = new AbortController();
  const refused: ChatClient = { complete: async () => { throw new Error('HTTP 401 Unauthorized'); } };
  const run = runLaboratory(cellsLab, { args: ['--seed', '1', '--level', '1', '--flat', '--tools', 'none', '--researcher', 'assisted', '--attempts', '4', '--agents', 'senior=message', '--out', out],
    root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch: stuck });
  const agent = runAgentOperator({ id: 'senior', role: 'senior', patience: 2, journal: out, llm: refused, pollMs: 15, signal: controller.signal, say: (l) => lines.push(l) });
  await run;
  controller.abort();
  await agent;
  assert.ok(lines.some((l) => /error - HTTP 401 Unauthorized \[signals: .*held in no place/.test(l)), lines.join('\n'));
});

test('a round of only looking is a sign (from the second round on); a round with an experiment is not', () => {
  const look = (round: number) => ({ type: 'investigation', round, requests: [{ view: 'g1' }, { inspect: 'g1@2' }] });
  const s = stuckSignals({ events: [{ type: 'check', round: 1, laboratories: [{ place: 'lab1', holds: false }] }, look(2), look(2), look(2)] });
  assert.equal(s.only_looking, 3);
  assert.equal(s.current_round, 2);
  assert.ok(s.in_round && s.signs.some((x) => /only looking/.test(x)));
  assert.equal(stuckSignals({ events: [look(1), look(1), look(1)] }).only_looking, 0, 'round 1 is for looking');
  assert.equal(stuckSignals({ events: [look(2), look(2), { type: 'investigation', round: 2, requests: [{ table: { source: 's' }, on: 'episodes' }] }] }).only_looking, 0);
});

test('the senior is called during a round in which the junior only looks, and its message reaches it in that same round', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'senior-'));
  const out = path.join(dir, 'run.json');
  /* The junior: proposes in round 1; in round 2 only looks, then insists with no steps left - until a message comes. */
  const looking: FetchLike = async (_url, init) => {
    await sleep(40);
    const b = JSON.parse(String(init.body));
    const sys = b.messages[0].content as string, raw = userOf(b);
    const user = sys.startsWith('You grade') ? {} : JSON.parse(raw);
    const told = Boolean(user.operator_messages?.new?.length || user.operator_messages?.earlier?.length);
    const content = sys.startsWith('You grade') ? { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' }
      : 'task' in user ? { rationale: 'r', beliefs: [{ id: 'same', stance: 'keep', why: 'w' }], lessons: ['l'], next_experiment: 'n' }
      : user.round >= 2 && !told ? { investigate: [{ view: 'ep1', from: 0, to: 3 }] }
      : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]', validate: false,
        beliefs: [{ id: 'same', stance: user.round === 1 ? 'new' : 'keep', statement: 'the row repeats', evidence: [] }], lessons: ['l'], next_experiment: 'n' };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
  const seen: any[] = [];
  const advisor: ChatClient = { complete: async (r) => {
    seen.push(payloadOf(r.user));
    return { content: JSON.stringify({ decision: 'message', text: 'You have looked enough: propose the model your notes support and test it.', evidence: ['investigation:r2.1'], why: 'only looking' }), latencyMs: 0, raw: null };
  } };
  const controller = new AbortController();
  const run = runLaboratory(cellsLab, { args: ['--seed', '1', '--level', '1', '--flat', '--tools', 'view', '--researcher', 'assisted', '--attempts', '3', '--agents', 'senior=message', '--out', out],
    root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch: looking });
  const agent = runAgentOperator({ id: 'senior', role: 'senior', journal: out, llm: advisor, pollMs: 10, maxOrders: 1, signal: controller.signal });
  const r = await run;
  controller.abort();
  const { decisions } = await agent;
  const message = decisions.find((d) => d.decision === 'message')!;
  assert.equal(message.during_round, 2, 'called during round 2');
  assert.equal(seen[0].during_round, 2);
  assert.match(seen[0].signals.join(' '), /only looking/);
  const events = JSON.parse(fs.readFileSync(r.journal, 'utf8')).events as Record<string, any>[];
  const delivered = events.findIndex((e) => e.type === 'operator_message');
  const proposed2 = events.findIndex((e) => e.type === 'proposal' && e.round === 2);
  assert.ok(delivered >= 0 && proposed2 > delivered, 'received within round 2, and then it proposed');
});

test('regressions and no progress since its best check are signs', async () => {
  const check = (round: number, wins: number, down = 0) => ({ type: 'check', round, laboratories: [{ place: 'lab1', holds: false, wins, total: 8, ...(round > 1 ? { rerun: { went_up: 0, went_down: down } } : {}) }] });
  const s = stuckSignals({ events: [check(1, 4), check(2, 5, 1), check(3, 3, 0), check(4, 4, 2)] });
  assert.equal(s.regressions, 2);
  assert.equal(s.checks_since_best, 2);
  assert.ok(s.signs.some((x) => /scored lower when run again/.test(x)));
  assert.ok(s.signs.some((x) => /best check \(5 of 8 scored 1, round 2\) has not been matched in the 2 checks since/.test(x)));
  assert.deepEqual(stuckSignals({ events: [check(1, 4), check(2, 5, 0), check(3, 6, 0)] }, 5).signs, [], 'improving: no sign');
  assert.equal(stuckSignals({ events: [check(1, 5), check(2, 3, 0), check(3, 5, 0)] }).checks_since_best, 0, 'matching its best counts');
});

test('the senior waits for the junior to get its message, and counts the pause from then', async () => {
  const { waitingOnMessage } = await import('../src/orchestra/agent-operator.ts');
  const sent = { type: 'operator_command', kind: 'message', by: 'agent:senior', accepted: true };
  const got = { type: 'operator_message', question: 9, messages: [{ id: 'o1', text: 't', by: 'agent:senior' }] };
  const check = { type: 'check', round: 1, laboratories: [] };
  assert.equal(waitingOnMessage({ events: [] }, 'senior', 2), false, 'nothing sent');
  assert.equal(waitingOnMessage({ events: [sent, check, check, check] }, 'senior', 2), true, 'sent, not yet delivered: still waiting');
  assert.equal(waitingOnMessage({ events: [sent, check, got, check] }, 'senior', 2), true, 'one check since the junior got it');
  assert.equal(waitingOnMessage({ events: [sent, got, check, check] }, 'senior', 2), false, 'two checks since: it may be called again');
});

test('after the final reflection the senior does not write: the message would never reach the junior', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'senior-'));
  const out = path.join(dir, 'run.json');
  const check = (round: number) => ({ type: 'check', round, laboratories: [{ place: 'lab1', holds: false }] });
  fs.writeFileSync(out, JSON.stringify({ experiment: 'cells@1', researcher: 'assisted', events: [check(1), check(2), check(3), { type: 'reflection', round: 4, beliefs: [] }] }));
  fs.writeFileSync(out.replace(/\.json$/, '.status.json'), JSON.stringify({ state: 'running', heartbeat: new Date().toISOString(), pid: process.pid }));
  let asked = 0;
  const llm: ChatClient = { complete: async () => { asked++; return { content: JSON.stringify({ decision: 'message', text: 'x' }), latencyMs: 0, raw: null }; } };
  const controller = new AbortController();
  const agent = runAgentOperator({ id: 'senior', role: 'senior', journal: out, llm, pollMs: 10, signal: controller.signal });
  await sleep(120);
  controller.abort();
  const { decisions } = await agent;
  assert.equal(asked, 0);
  assert.deepEqual(decisions, []);
  /* The control: the same run before its reflection - the senior is called. */
  fs.writeFileSync(out, JSON.stringify({ experiment: 'cells@1', researcher: 'assisted', events: [check(1), check(2), check(3)] }));
  fs.writeFileSync(out.replace(/\.json$/, '.status.json'), JSON.stringify({ state: 'running', heartbeat: new Date().toISOString(), pid: process.pid }));
  const again = new AbortController();
  const control = runAgentOperator({ id: 'control', role: 'senior', journal: out, llm, pollMs: 10, signal: again.signal });
  await sleep(120);
  again.abort();
  assert.ok((await control).decisions.length > 0 && asked > 0, 'without the reflection, it decides');
});

test('a follow-up is due when the junior, having got the senior\'s message, runs an experiment - once per message', async () => {
  const { followUpDue } = await import('../src/orchestra/reader.ts');
  const got = { type: 'operator_message', question: 5, messages: [{ id: 'o1', text: 'test the column', by: 'agent:senior' }] };
  const look = { type: 'investigation', round: 3, requests: [{ view: 'g1' }] };
  const table = { type: 'investigation', round: 3, requests: [{ table: { source: 's' }, on: 'final' }] };
  assert.equal(followUpDue({ events: [table] }, 'senior'), null, 'no message: nothing to follow up');
  assert.equal(followUpDue({ events: [got, look] }, 'senior'), null, 'it only looked since');
  assert.deepEqual(followUpDue({ events: [look, got, look, table] }, 'senior'), { message: 0, text: 'test the column', experiment: 'investigation:r3.3', round: 3, requests: table.requests });
  assert.equal(followUpDue({ events: [table, got] }, 'senior'), null, 'an experiment before the message does not count');
});

test('the senior follows up its message within the round: the junior ran the experiment, and is told what its data show', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'senior-'));
  const out = path.join(dir, 'run.json');
  /* The junior: round 1 proposes; round 2 only looks until it gets a message, then runs a table, then proposes once it has
     heard back. */
  const junior: FetchLike = async (_url, init) => {
    await sleep(40);
    const b = JSON.parse(String(init.body));
    const sys = b.messages[0].content as string, raw = userOf(b);
    const user = sys.startsWith('You grade') ? {} : JSON.parse(raw);
    const heard = [...(user.operator_messages?.earlier ?? []), ...(user.operator_messages?.new ?? [])].length;
    const tabled = (user.investigation ?? []).some((s: { requests: Record<string, unknown>[] }) => s.requests.some((q) => 'table' in q));
    const content = sys.startsWith('You grade') ? { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' }
      : 'task' in user ? { rationale: 'r', beliefs: [{ id: 'same', stance: 'keep', why: 'w' }], lessons: ['l'], next_experiment: 'n' }
      : user.round === 2 && heard === 0 ? { investigate: [{ view: 'ep1', from: 0, to: 3 }] }
      : user.round === 2 && !tabled ? { investigate: [{ table: { source: '(p) => p.rows.length', range: [0, 100] }, on: 'episodes' }] }
      : user.round === 2 && heard < 2 ? { investigate: [{ view: 'ep1', from: 0, to: 3 }] }
      : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]', validate: false,
        beliefs: [{ id: 'same', stance: user.round === 1 ? 'new' : 'keep', statement: 'the row repeats', evidence: [] }], lessons: ['l'], next_experiment: 'n' };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
  const seen: any[] = [];
  const advisor: ChatClient = { complete: async (r) => {
    const user = payloadOf(r.user);
    seen.push(user);
    const content = user.follow_up
      ? { decision: 'message', text: 'Your table confirms it: adopt it as a working rule and propose now a model built on it.', evidence: [user.follow_up.experiment], why: 'confirmed' }
      : { decision: 'message', text: 'Hypothesis: the length matters. Test it with a table over your episodes.', evidence: ['investigation:r2.1'], why: 'only looking' };
    return { content: JSON.stringify(content), latencyMs: 0, raw: null };
  } };
  const controller = new AbortController();
  const run = runLaboratory(cellsLab, { args: ['--seed', '1', '--level', '1', '--flat', '--tools', 'view,table', '--steps', '9', '--researcher', 'assisted', '--attempts', '3',
    '--agents', 'senior=message', '--out', out], root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch: junior });
  const agent = runAgentOperator({ id: 'senior', role: 'senior', journal: out, llm: advisor, pollMs: 10, maxOrders: 3, signal: controller.signal });
  const r = await run;
  controller.abort();
  const { decisions } = await agent;
  const follow = decisions.find((d) => d.follow_up);
  assert.ok(follow, 'a follow-up');
  assert.match(follow!.follow_up!, /^investigation:r2\.\d+$/);
  assert.equal(follow!.decision, 'message');
  const call = seen.find((u) => u.follow_up)!;
  assert.match(call.follow_up.your_message, /Test it with a table/);
  assert.ok(call.follow_up.its_record.requests.some((q: Record<string, unknown>) => 'table' in q), 'the experiment comes with the follow-up: no reading needed');
  assert.ok(call.follow_up.its_record.results, 'and what it was answered');
  assert.ok(call.run.latest_rounds.length <= 3, 'the run in its latest rounds only');
  assert.equal(follow!.usage!.calls, 1, 'decided in one call');
  const events = JSON.parse(fs.readFileSync(r.journal, 'utf8')).events as Record<string, any>[];
  const confirmed = events.findIndex((e) => e.type === 'operator_message' && e.messages.some((m: { text: string }) => /confirms it/.test(m.text)));
  const proposed2 = events.findIndex((e) => e.type === 'proposal' && e.round === 2);
  assert.ok(confirmed >= 0 && proposed2 > confirmed, 'it heard back within round 2, then proposed');
});

test('the senior\'s reading grows by messages (its context unchanged within a decision), and large items come clipped unless asked whole', async () => {
  const { UserParts } = await import('../src/learn/system2.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'senior-'));
  const out = path.join(dir, 'run.json');
  const check = (round: number) => ({ type: 'check', round, laboratories: [{ place: 'lab1', holds: false }] });
  const big = 'x'.repeat(9000);
  fs.writeFileSync(out, JSON.stringify({ experiment: 'cells@1', researcher: 'assisted', events: [check(1), check(2),
    { type: 'investigation', round: 3, requests: [{ view: 'ep1' }], results: [{ pictures: big }] }, check(3)] }));
  fs.writeFileSync(out.replace(/\.json$/, '.status.json'), JSON.stringify({ state: 'running', heartbeat: new Date().toISOString(), pid: process.pid }));
  const calls: InstanceType<typeof UserParts>[] = [];
  const llm: ChatClient = { complete: async (r) => {
    calls.push(r.user as InstanceType<typeof UserParts>);
    const content = calls.length === 1 ? { investigate: [{ memory: 'open', items: ['investigation:r3.1'] }] }
      : calls.length === 2 ? { investigate: [{ memory: 'open', items: ['investigation:r3.1'], whole: true }] }
      : { decision: 'wait', why: 'read' };
    return { content: JSON.stringify(content), latencyMs: 0, raw: null };
  } };
  const controller = new AbortController();
  const agent = runAgentOperator({ id: 'senior', role: 'senior', journal: out, llm, pollMs: 10, signal: controller.signal });
  await sleep(150);
  controller.abort();
  await agent;
  assert.equal(calls.length, 3);
  assert.ok(calls.every((u) => u instanceof UserParts));
  assert.deepEqual(calls[1].parts[0], calls[0].parts[0], 'its context, unchanged');
  assert.deepEqual(calls[2].parts.slice(0, 2), calls[1].parts.slice(0, 2), 'the earlier messages repeated');
  const clipped = (calls[1].parts[1] as any).investigation_step.results[0].items[0];
  assert.ok(clipped.clipped && clipped.clipped.size > 9000 && clipped.clipped.beginning.length === 4000);
  const whole = (calls[2].parts[2] as any).investigation_step.results[0].items[0];
  assert.equal(whole.item.results[0].pictures, big, 'asked whole: entire');
});

test('a follow-up allows one reading; asked to read again, the senior is reminded to hand the junior the next step, and decides', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'senior-'));
  const out = path.join(dir, 'run.json');
  /* The junior got the senior's message and then ran an experiment: a follow-up is due. */
  fs.writeFileSync(out, JSON.stringify({ experiment: 'cells@1', researcher: 'assisted', events: [
    { type: 'check', round: 1, laboratories: [{ place: 'lab1', holds: false }] },
    { type: 'operator_command', kind: 'message', by: 'agent:senior', accepted: true },
    { type: 'operator_message', question: 3, messages: [{ id: 'o1', text: 'test the edge with a table', by: 'agent:senior' }] },
    { type: 'investigation', round: 2, requests: [{ table: { source: 's' }, on: 'episodes' }], results: [{ rows: [] }] }] }));
  fs.writeFileSync(out.replace(/\.json$/, '.status.json'), JSON.stringify({ state: 'running', heartbeat: new Date().toISOString(), pid: process.pid }));
  const calls: unknown[] = [];
  const llm: ChatClient = { complete: async (r) => {
    calls.push(r.user);
    const reminded = JSON.stringify((r.user as { parts: unknown[] }).parts).includes('"reminder"');
    const content = reminded ? { decision: 'message', text: 'Your table confirms it: adopt the edge rule and propose a model built on it.', evidence: ['investigation:r2.1'], why: 'confirmed' }
      : { investigate: [{ memory: 'list', of: 'notes' }] };
    return { content: JSON.stringify(content), latencyMs: 0, raw: null };
  } };
  const controller = new AbortController();
  const agent = runAgentOperator({ id: 'senior', role: 'senior', journal: out, llm, pollMs: 10, maxOrders: 1, signal: controller.signal });
  await sleep(150);
  controller.abort();
  const { decisions } = await agent;
  const d = decisions.find((x) => x.follow_up)!;
  assert.equal(d.decision, 'message', 'it decided, no error');
  assert.equal(d.read!.length, 1, 'one reading');
  assert.equal(d.reminded, 1, 'reminded once');
  assert.equal(calls.length, 3, 'read, reminded, decided');
  const reminder = (calls[2] as { parts: Record<string, unknown>[] }).parts.at(-1)!;
  assert.match(String(reminder.reminder), /not to do the junior's work/);
});
