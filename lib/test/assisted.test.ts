import test from 'node:test';
import { INSTRUMENT_SECTION } from '../src/learn/instrument.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ASSISTED_SECTION, assistedSystem, deliveredMessages, operatorClient } from '../src/learn/assisted/session.ts';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { send } from '../src/runtime/control.ts';
import { findingView } from '../src/learn/finding.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';
import { cellsInterface } from '../src/worlds/cells/interface.ts';
import { system2Prompt } from '../src/learn/prompt.ts';
import type { ChatClient } from '../src/learn/system2.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';


/* SPEC-INVESTIGADOR-ASISTIDO A4: the assisted researcher - its own prompt, the operator's messages with its questions. */

test('its prompt is the common one and a section of its own; the unknown-world prompt is untouched', () => {
  const common = system2Prompt(cellsInterface(), new Set(cellsInterface().tools));
  assert.ok(assistedSystem(common).startsWith(common));
  assert.ok(assistedSystem(common).includes(ASSISTED_SECTION));
  assert.ok(assistedSystem(common).endsWith(INSTRUMENT_SECTION), 'and the instrument it may report (SPEC-CALIBRACION-INSTRUMENTOS §4)');
  assert.ok(!common.includes('THE OPERATOR'));
  assert.match(ASSISTED_SECTION, /not evidence/);
});

test('a question without a message is the unknown-world question itself; a message goes with the next one, then stays as earlier', async () => {
  const seen: unknown[] = [];
  const llm: ChatClient = { complete: async (r) => { seen.push(r.user); return { content: '{}', latencyMs: 0, raw: null }; } };
  const waiting: { id: string; text: string; at: string }[] = [];
  const logged: Record<string, unknown>[] = [];
  const client = operatorClient(llm, { take: () => waiting.splice(0) }, (type, data) => logged.push({ type, ...data }));
  const payload = { round: 1, x: 1 };
  await client.complete({ system: 'S', user: payload });
  assert.equal(seen[0], payload, 'the very same object: nothing added');
  waiting.push({ id: 'm1', text: 'look at step 0', at: 't' });
  await client.complete({ system: 'S', user: { round: 1 } });
  await client.complete({ system: 'S', user: { round: 2 } });
  assert.deepEqual((seen[1] as { operator_messages: unknown }).operator_messages, { new: [{ id: 'm1', text: 'look at step 0', at: 't' }], earlier: [] });
  assert.deepEqual((seen[2] as { operator_messages: unknown }).operator_messages, { new: [], earlier: [{ id: 'm1', text: 'look at step 0', at: 't' }] });
  assert.deepEqual(logged, [{ type: 'operator_message', question: 2, messages: [{ id: 'm1', text: 'look at step 0', at: 't' }] }]);
});

test('resuming, a message is delivered again at the question it went with, and nothing waiting is taken before', async () => {
  const seen: unknown[] = [];
  const llm: ChatClient = { complete: async (r) => { seen.push(r.user); return { content: '{}', latencyMs: 0, raw: null }; } };
  const scheduled = deliveredMessages({ events: [{ type: 'operator_message', question: 2, messages: [{ id: 'm1', text: 'again', at: 't' }] }] });
  const waiting = [{ id: 'm2', text: 'new', at: 't2' }];
  const client = operatorClient(llm, { take: () => waiting.splice(0), scheduled }, () => {});
  for (let q = 0; q < 3; q++) await client.complete({ system: 'S', user: { q } });
  assert.equal((seen[0] as { operator_messages?: unknown }).operator_messages, undefined, 'question 1: as the run it resumes');
  assert.equal((seen[1] as { operator_messages: { new: { id: string }[] } }).operator_messages.new[0].id, 'm1', 'question 2: what it delivered there');
  assert.equal((seen[2] as { operator_messages: { new: { id: string }[] } }).operator_messages.new[0].id, 'm2', 'then, live');
});

/* --- A whole assisted run, with System 2 standing in: it cites the operator's message when it has one. */
const draft = { observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]' };
function system2(asked: Record<string, any>[], hook: (n: number) => void = () => {}): FetchLike {
  return async (_url, init) => {
    const b = JSON.parse(String(init.body));
    const sys = b.messages[0].content as string, raw = userOf(b);
    const user = sys.startsWith('You grade') ? {} : JSON.parse(raw);
    if (!sys.startsWith('You grade')) { asked.push({ system: sys, user }); hook(asked.length); }
    const cited = user.operator_messages ? [...user.operator_messages.earlier, ...user.operator_messages.new].map((m: { id: string }) => 'operator:' + m.id) : [];
    const content = sys.startsWith('You grade') ? { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' }
      : /"task"/.test(raw) ? { rationale: 'r', beliefs: [{ id: 'b', stance: 'confirm', why: 'w' }], lessons: ['l'], next_experiment: 'n' }
      : !user.investigation && user.round % 2 === 1 ? { investigate: [{ view: 'ep1', from: 0, to: 3 }] }
      : { rationale: 'r', ...draft, validate: false, beliefs: [{ id: 'b', stance: cited.length ? 'revise' : 'new', statement: 's', evidence: ['ep1@2', ...cited] }], lessons: ['l'] };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
}
const ARGS = ['--seed', '1', '--level', '1', '--attempts', '4', '--flat', '--no-grade'];
const llm = { url: 'http://system2.test/chat', model: 'stand-in' };

test('an assisted run: a message sent while it goes reaches the next question, and the journal and the finding say so', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assisted-'));
  const asked: Record<string, any>[] = [];
  let journal = '';
  const r = await runLaboratory(cellsLab, { args: [...ARGS, '--researcher', 'assisted', '--out', path.join(dir, 'run.json')], root: dir, llm, onJournal: (f) => { journal = f; },
    fetch: system2(asked, (n) => { if (n === 2) send(journal, { kind: 'message', text: 'look at step 0', by: 'operator' }); }) });
  assert.equal(r.researcherUsed, 'assisted');
  assert.ok(asked.every((q) => q.system.includes(ASSISTED_SECTION) && q.system.endsWith(INSTRUMENT_SECTION)), 'its own prompt');
  assert.equal(asked[0].user.operator_messages, undefined);
  const first = asked.findIndex((q) => q.user.operator_messages);
  assert.equal(first, 2, 'read before the third question, delivered with it');
  assert.equal(asked[first].user.operator_messages.new[0].text, 'look at step 0');
  const events = JSON.parse(fs.readFileSync(r.journal, 'utf8')).events;
  assert.equal(events.find((e: { type: string }) => e.type === 'operator_command').accepted, true);
  assert.equal(events.find((e: { type: string }) => e.type === 'operator_message').question, 3);
  assert.equal(r.finding.researcher, 'assisted');
  assert.deepEqual(r.finding.assistance!.messages.map((m) => [m.question, m.text]), [[3, 'look at step 0']]);
  assert.deepEqual(r.finding.claims[0].grounded, ['world', 'operator']);
  assert.deepEqual(findingView(r.finding, 'researcher').assistance, r.finding.assistance, 'provenance: the researcher view keeps it');
});

test('an assisted run cut and resumed receives each message at the same question: the replay recognises every request', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assisted-'));
  let journal = '';
  const hook = (n: number) => { if (n === 2) send(journal, { kind: 'message', text: 'look at step 0', by: 'operator' }); };
  const whole = await runLaboratory(cellsLab, { args: [...ARGS, '--researcher', 'assisted', '--out', path.join(dir, 'whole.json')], root: dir, llm, onJournal: (f) => { journal = f; }, fetch: system2([], hook) });
  const cut = await runLaboratory(cellsLab, { args: [...ARGS, '--researcher', 'assisted', '--max-tokens', '450', '--out', path.join(dir, 'cut.json')], root: dir, llm, onJournal: (f) => { journal = f; }, fetch: system2([], hook) });
  assert.equal(cut.stoppedBy, 'token_budget');
  const asked: Record<string, any>[] = [];
  const resumed = await runLaboratory(cellsLab, { args: ['--resume', cut.journal, '--out', path.join(dir, 'resumed.json')], root: dir, llm, fetch: system2(asked) });
  assert.equal(resumed.stoppedBy, whole.stoppedBy, 'it did not diverge');
  assert.equal(resumed.researcherUsed, 'assisted', 'the researcher of the run it resumes');
  /* The same events, but for when the message was written (the whole run and the cut one are two runs, written at two times). */
  const strip = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8')).events.filter((e: { type: string }) => !['start', 'end', 'operator_command'].includes(e.type))
    .map(({ t: _t, ...e }: Record<string, any>) => (e.type === 'operator_message' ? { ...e, messages: e.messages.map(({ at: _a, ...m }: Record<string, unknown>) => m) } : e));
  /* ...and for the order's id: each of the two runs was sent a message of its own (same text, same question). */
  const same = (f: string) => JSON.stringify(strip(f)).replace(/order-[a-z0-9]+-\d+-\d+/g, 'order');
  assert.equal(same(resumed.journal), same(whole.journal));
  assert.deepEqual(resumed.finding.assistance!.messages.map((m) => m.question), [3]);
});

test('a message sent while a resumed run still replays its history waits, and goes with its first question asked live', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assisted-'));
  const cut = await runLaboratory(cellsLab, { args: [...ARGS, '--researcher', 'assisted', '--max-tokens', '450', '--out', path.join(dir, 'cut.json')], root: dir, llm, fetch: system2([]) });
  assert.equal(cut.stoppedBy, 'token_budget');
  const logged = fs.readFileSync(cut.journal.replace(/\.json$/, '.replay.jsonl'), 'utf8').split('\n').filter((l) => l.includes('"llm"')).length;
  /* An agent or a person writes to the resumed run before it has replayed anything (as an agent following "last" did). */
  const out = path.join(dir, 'resumed.json');
  send(out, { kind: 'message', text: 'while it replays', by: 'operator' });
  const resumed = await runLaboratory(cellsLab, { args: ['--resume', cut.journal, '--out', out], root: dir, llm, fetch: system2([]) });
  const events = JSON.parse(fs.readFileSync(resumed.journal, 'utf8')).events as Record<string, any>[];
  assert.ok(!events.some((e) => e.type === 'diverged'), 'it did not diverge');
  const delivered = events.find((e) => e.type === 'operator_message' && e.messages.some((m: { text: string }) => m.text === 'while it replays'));
  assert.ok(delivered && delivered.question > logged, 'delivered live, after the history: question ' + delivered?.question + ' > ' + logged);
});
