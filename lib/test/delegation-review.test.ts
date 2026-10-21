import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';
import { Delegations } from '../src/learn/assisted/delegation.ts';
import { agentFile, runAgentOperator } from '../src/orchestra/agent-operator.ts';
import { emptySeniorState } from '../src/orchestra/senior.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';

/* An external review of the delegation (21/10/2026), reconciled: a stop between a request and its answer reconciled, never
   left blocking; one fund for the run, its junior and its senior; a launch that fails asynchronously is the branch's failure;
   the senior resumed keeps its branches, and a branch that ended calls it whatever the signs. */

const config = { fund: 100, tokens: 100, rounds: 1, maxRounds: 2 };
const base = (dir: string, extra: Partial<ConstructorParameters<typeof Delegations>[0]> = {}) => new Delegations({ config, journalFile: path.join(dir, 'run.json'), snapshot: () => ({ events: [] }),
  lab: cellsLab.id, worldArgs: [], launcher: () => {}, log: () => {}, history: [], unsupported: null, ...extra });
const requested = (dir: string) => ({ type: 'delegation_requested', id: 'delegation:r1.1', round: 1, question: 'q', journal: 'run.branches/delegation-r1.1.json', granted: { rounds: 1, tokens: 100 } });

test('a stop between a request and its answer: reconciled before anything else, never left blocking', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deleg-crash-'));
  const logged: any[] = [];
  /* Its record says it asked; nothing says it was answered, and the branch left no record: taken as never started. */
  const d = base(dir, { history: [requested(dir)], log: (type, data) => logged.push({ type, ...data }) });
  const a = await d.run({ delegate: { question: 'again' } }, 2);
  assert.equal(a.state, 'accepted', JSON.stringify(a));
  assert.ok(logged.some((e) => e.type === 'delegation_state' && e.id === 'delegation:r1.1' && e.state === 'failed' && e.reconciled), 'said so');

  /* The same, but its record exists: it started - running, so one at a time. */
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'deleg-crash2-'));
  fs.mkdirSync(path.join(dir2, 'run.branches'), { recursive: true });
  fs.writeFileSync(path.join(dir2, 'run.branches', 'delegation-r1.1.json'), JSON.stringify({ events: [] }));
  const e = base(dir2, { history: [requested(dir2)] });
  assert.match(String((await e.run({ delegate: { question: 'again' } }, 2)).error), /one branch at a time/);
});

test('one fund for the run: its junior and its senior reserve from the same ledger', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deleg-fund-'));
  const ledger = path.join(dir, 'run.delegation-fund.jsonl');
  const junior = base(dir, { ledger, requester: 'junior' });
  const senior = base(dir, { ledger, requester: 'agent:senior', journalFile: path.join(dir, 'run.agent-senior.json') });
  assert.equal((await junior.run({ delegate: { question: 'q' } }, 1)).state, 'accepted');
  const s = await senior.run({ delegate: { question: 'q' } }, 1);
  assert.match(String(s.error), /fund for branches is spent/, 'never twice the fund: ' + JSON.stringify(s));
  assert.equal(senior.fundLeft(), 0);
});

test('a launch that fails asynchronously is the branch\'s failure, its reservation released', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deleg-launch-'));
  const d = base(dir, { launcher: async () => { await new Promise((r) => setTimeout(r, 5)); throw new Error('no such process'); } });
  const a = await d.run({ delegate: { question: 'q' } }, 1);
  assert.equal(a.state, 'failed');
  assert.match(String(a.error), /could not be started/);
  assert.equal(d.fundLeft(), 100);
  assert.equal((await d.run({ delegate: { question: 'q2' } }, 1)).state, 'failed', 'not blocked: it may ask again');
});

test('the senior resumed keeps its branches; a branch that ended calls it whatever the signs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deleg-senior-resume-'));
  const llm = { url: 'http://x.test/v1/chat/completions', model: 's' };
  const MODEL = { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]', validate: false, lessons: ['l'], next_experiment: 'n', beliefs: [] };
  const junior: FetchLike = async (_url, init) => {
    await new Promise((r) => setTimeout(r, 60));
    const user = JSON.parse(userOf(JSON.parse(String(init.body))));
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify('task' in user ? { rationale: 'r', beliefs: [], lessons: ['l'], next_experiment: 'n' } : MODEL) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
  const common = ['--seed', '1', '--level', '1', '--flat', '--tools', 'none', '--researcher', 'assisted', '--agents', 'senior=message', '--delegation-fund', '1000'];
  const old = path.join(dir, 'old.json');
  await runLaboratory(cellsLab, { args: [...common, '--attempts', '1', '--out', old], root: dir, llm, fetch: junior });
  /* Its earlier record: a branch it opened, which has ended since, its result not given yet. */
  const branch = path.join(dir, 'old.agent-senior.branches', 'delegation-r1.1.json');
  fs.mkdirSync(path.dirname(branch), { recursive: true });
  fs.writeFileSync(branch, JSON.stringify({ events: [{ type: 'end', stoppedBy: 'budget', notebook: { beliefs: [{ id: 'edges', status: 'held', statement: 'the edges copy' }], notes: [] } }] }));
  fs.writeFileSync(agentFile(old, 'senior'), JSON.stringify({ format: 'agent@1', agent: 'agent:senior', role: 'senior', decisions: [], senior: emptySeniorState(),
    delegation_log: [{ type: 'delegation_requested', id: 'delegation:r1.1', round: 1, question: 'do the edges copy?', journal: 'old.agent-senior.branches/delegation-r1.1.json', granted: { rounds: 1, tokens: 100 } },
      { type: 'delegation_state', id: 'delegation:r1.1', state: 'running' }, { type: 'delegation_answered', round: 1, request: '{}', answer: { delegation: 'delegation:r1.1', state: 'accepted' } }] }));
  const out = path.join(dir, 'new.json');
  const calls: any[] = [];
  const senior = { complete: async (r: { user: unknown }) => { calls.push(JSON.parse(JSON.stringify(r.user))); return { content: JSON.stringify({ decision: 'wait', why: 'w' }), latencyMs: 0, raw: null }; } };
  const controller = new AbortController();
  const run = runLaboratory(cellsLab, { args: [...common, '--resume', old, '--attempts', '4', '--out', out], root: dir, llm, fetch: junior });
  /* No sign will call it (its patience is long): only its branch's result can. */
  const agent = runAgentOperator({ id: 'senior', role: 'senior', patience: 50, looking: 50, journal: out, llm: senior as never, pollMs: 15, maxOrders: 1, signal: controller.signal });
  await run; await new Promise((r) => setTimeout(r, 100)); controller.abort(); await agent;
  assert.ok(calls.some((c) => JSON.stringify(c).includes('branch_results') && JSON.stringify(c).includes('the edges copy')), 'called for its result: ' + calls.length + ' calls');
  const record = JSON.parse(fs.readFileSync(agentFile(out, 'senior'), 'utf8'));
  assert.ok((record.delegation_log as any[]).some((e) => e.type === 'delegation_requested' && e.id === 'delegation:r1.1'), 'its earlier branches kept');
  assert.ok((record.delegation_log as any[]).some((e) => e.type === 'branch_result_given' && e.id === 'delegation:r1.1'));
});

/* A second review (21/10/2026): bookings keyed by requester and branch; a ledger unreadable or missing is never a fresh
   fund; the ledger's name not part of the generator; a branch's execution judged by its heartbeat, not a file. */

const ended = (file: string, spent: number) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ events: [{ type: 'end', stoppedBy: 'budget', notebook: { beliefs: [], notes: [] } }] }));
  fs.writeFileSync(file.replace(/\.json$/, '.finding.json'), JSON.stringify({ cost: { total: { llm_tokens: spent } } }));
};

test('bookings keyed by requester and branch: two branches numbered alike are two bookings', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deleg-keys-'));
  const ledger = path.join(dir, 'run.delegation-fund.jsonl');
  const c = { fund: 100, tokens: 40, rounds: 1, maxRounds: 1 };
  const junior = base(dir, { config: c, ledger, requester: 'junior' });
  const senior = base(dir, { config: c, ledger, requester: 'agent:senior', journalFile: path.join(dir, 'run.agent-senior.json') });
  assert.equal((await junior.run({ delegate: { question: 'q' } }, 1)).delegation, 'delegation:r1.1');
  assert.equal((await senior.run({ delegate: { question: 'q' } }, 1)).delegation, 'delegation:r1.1', 'the same number, another requester');
  assert.equal(senior.fundLeft(), 20);
  ended(path.join(dir, 'run.branches', 'delegation-r1.1.json'), 10);
  assert.equal(junior.hasResults(), true);
  assert.equal(senior.fundLeft(), 50, '100 - 10 spent - 40 still reserved');
  ended(path.join(dir, 'run.agent-senior.branches', 'delegation-r1.1.json'), 5);
  senior.hasResults();
  assert.equal(junior.fundLeft(), 85, 'its settlement booked too');
});

test('a ledger broken, or missing where branches were booked, is no fund - never a fresh one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deleg-ledger-'));
  const ledger = path.join(dir, 'run.delegation-fund.jsonl');
  fs.writeFileSync(ledger, '{"requester":"junior","id":"delegation:r1.1","reserve":40}\n{"requester":"jun');
  const d = base(dir, { ledger });
  assert.equal(d.fundLeft(), 0);
  assert.match(String((await d.run({ delegate: { question: 'q' } }, 1)).error), /fund cannot be known: its ledger is broken at line 2/);
  fs.rmSync(ledger);
  const e = base(dir, { ledger, history: [requested(dir), { type: 'delegation_answered', round: 1, request: '{}', answer: {} }] });
  assert.match(String((await e.run({ delegate: { question: 'q' } }, 2)).error), /its ledger is missing/);
  const fresh = base(fs.mkdtempSync(path.join(os.tmpdir(), 'deleg-fresh-')), { ledger: path.join(dir, 'other.jsonl') });
  assert.equal(fresh.fundLeft(), 100, 'absent and nothing booked: a fresh fund');
});

test('the ledger\'s name is operational, not a condition: the same generator', async () => {
  const { generatorOf } = await import('../src/runtime/generators.ts');
  const journal = (ledger: string) => ({ experiment: cellsLab.id, researcher: 'assisted', config: { seed: 1, level: 1, llm_model: 'm', delegation: { fund: 10, tokens: 5, rounds: 1, max_rounds: 2, ledger } } });
  assert.equal(generatorOf(journal('a.jsonl'), os.tmpdir(), 'x').id, generatorOf(journal('b.jsonl'), os.tmpdir(), 'x').id);
});

test('a branch judged by its heartbeat: a record whose process died ends it; no record past the grace, never started', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deleg-live-'));
  const branch = path.join(dir, 'run.branches', 'delegation-r1.1.json');
  fs.mkdirSync(path.dirname(branch), { recursive: true });
  fs.writeFileSync(branch, JSON.stringify({ events: [{ type: 'start' }] }));
  fs.writeFileSync(branch.replace(/\.json$/, '.status.json'), JSON.stringify({ heartbeat: new Date(Date.now() - 120000).toISOString(), cost: { llm_tokens: 33 } }));
  const answered = { type: 'delegation_answered', round: 1, request: '{}', answer: {} };
  const dead = base(dir, { history: [requested(dir), { type: 'delegation_state', id: 'delegation:r1.1', state: 'running' }, answered] });
  assert.equal(dead.hasResults(), true, 'its process stopped without ending');
  const [r] = dead.results();
  assert.equal(r.result_state, 'failed');
  assert.equal(r.result_spent, 33, 'what its record says it spent');
  assert.match(r.text, /its process stopped without ending/);

  /* No record yet: starting within the grace (not freed), never started past it. */
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'deleg-live2-'));
  fs.mkdirSync(path.join(dir2, 'run.branches'), { recursive: true });
  fs.writeFileSync(path.join(dir2, 'run.branches', 'delegation-r1.1.cut.json'), '{}');
  let clock = Date.now();
  const starting = base(dir2, { history: [requested(dir2)], now: () => clock });
  assert.match(String((await starting.run({ delegate: { question: 'again' } }, 2)).error), /one branch at a time/, 'launched and not yet started: kept');
  clock += 61000;
  assert.equal(starting.hasResults(), true);
  assert.match(starting.results()[0].text, /never started/);
  assert.equal(starting.fundLeft(), 100);
});
