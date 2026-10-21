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
  const junior = base(dir, { ledger, requester: 'junior', opens: true });
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
  const junior = base(dir, { config: c, ledger, requester: 'junior', opens: true });
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
  const fresh = base(fs.mkdtempSync(path.join(os.tmpdir(), 'deleg-fresh-')), { ledger: path.join(dir, 'other.jsonl'), opens: true });
  assert.equal(fresh.fundLeft(), 100, 'opened by the run that begins it: a fresh fund');
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
  assert.equal(r.result_spent, 33, 'what was observed, at least');
  assert.deepEqual(r.result_spent_uncertain, { at_least: 33, held: 100 }, 'not known: its grant held in the fund, apart');
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

/* A third review (21/10/2026): the fund opened once for the lineage, so its loss is a loss for every requester; a package
   follows the branches its records name; a heartbeat late is no death, and a death's spending is kept uncertain. */

test('a ledger lost is lost for every requester: a senior with no branches of its own is refused too', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deleg-lost-'));
  const ledger = path.join(dir, 'run.delegation-fund.jsonl');
  const junior = base(dir, { ledger, requester: 'junior', opens: true });
  assert.equal((await junior.run({ delegate: { question: 'q' } }, 1)).state, 'accepted');
  fs.rmSync(ledger);
  const senior = base(dir, { ledger, requester: 'agent:senior', journalFile: path.join(dir, 'run.agent-senior.json') });
  assert.equal(senior.fundLeft(), 0);
  assert.match(String((await senior.run({ delegate: { question: 'q' } }, 1)).error), /its ledger is missing/);
  /* Nor does one that would open it, once its run has asked: a resumed run never opens it again. */
  const again = base(dir, { ledger, requester: 'junior', opens: true, history: [requested(dir)] });
  assert.match(String((await again.run({ delegate: { question: 'q' } }, 2)).error), /fund cannot be known/);
  assert.ok(!fs.existsSync(ledger));
  /* A ledger that exists but was never opened by its run is no fund either. */
  fs.writeFileSync(ledger, '');
  assert.match(String((await senior.run({ delegate: { question: 'q' } }, 1)).error), /not opened by its run/);
});

test('a package follows the branches its records name: a run resumed keeps the branches of the run it resumed', async () => {
  const { packRun } = await import('../src/runtime/package.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deleg-pack-'));
  const write = (rel: string, v: unknown) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), JSON.stringify(v)); };
  write('old.branches/delegation-r1.1.json', { events: [] });
  write('old.branches/delegation-r1.1.cut.json', { events: [] });
  write('old.agent-senior.branches/delegation-r2.1.json', { events: [] });
  write('stray.branches/x.json', {});
  write('new.json', { experiment: 'x', events: [{ type: 'delegation_requested', id: 'delegation:r1.1', journal: 'old.branches/delegation-r1.1.json' }] });
  write('new.agent-senior.json', { delegation_log: [{ type: 'delegation_requested', id: 'delegation:r2.1', journal: 'old.agent-senior.branches/delegation-r2.1.json' }] });
  const files = packRun(path.join(dir, 'new.json'), path.join(os.tmpdir(), 'deleg-pack-out-' + path.basename(dir))).manifest.files.map((f) => f.path);
  for (const f of ['old.branches/delegation-r1.1.json', 'old.branches/delegation-r1.1.cut.json', 'old.agent-senior.branches/delegation-r2.1.json'])
    assert.ok(files.includes(f), f + ' packed: ' + files.join(', '));
  assert.ok(!files.some((f) => f.startsWith('stray.')), 'only what its records name');
});

test('a heartbeat late is no death while its process lives; a death keeps its spending uncertain, its grant booked', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deleg-pid-'));
  const ledger = path.join(dir, 'run.delegation-fund.jsonl');
  fs.writeFileSync(ledger, JSON.stringify({ opened: 100, by: 'junior' }) + '\n' + JSON.stringify({ requester: 'junior', id: 'delegation:r1.1', reserve: 100 }) + '\n');
  const branch = path.join(dir, 'run.branches', 'delegation-r1.1.json');
  fs.mkdirSync(path.dirname(branch), { recursive: true });
  fs.writeFileSync(branch, JSON.stringify({ events: [{ type: 'start' }] }));
  const status = (pid: number) => fs.writeFileSync(branch.replace(/\.json$/, '.status.json'), JSON.stringify({ pid, heartbeat: new Date(Date.now() - 120000).toISOString(), cost: { llm_tokens: 33 } }));
  const history = [requested(dir), { type: 'delegation_state', id: 'delegation:r1.1', state: 'running' }, { type: 'delegation_answered', round: 1, request: '{}', answer: {} }];
  status(process.pid);
  const alive = base(dir, { history, ledger, requester: 'junior' });
  assert.equal(alive.hasResults(), false, 'its process alive: still running, its reservation kept');
  assert.equal(alive.fundLeft(), 0);
  status(2 ** 22 + 12345);
  const dead = base(dir, { history, ledger, requester: 'junior' });
  assert.equal(dead.hasResults(), true);
  const [r] = dead.results();
  assert.equal(r.result_state, 'failed');
  assert.match(r.text, /is gone/);
  assert.deepEqual(r.result_spent_uncertain, { at_least: 33, held: 100 });
  assert.equal(dead.fundLeft(), 0, 'its grant kept booked: never freed on a guess');
  const settled = fs.readFileSync(ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.settle !== undefined);
  assert.equal(settled.settle, 100);
  assert.equal(settled.uncertain, true);
  assert.equal(settled.at_least, 33);
  assert.ok((dead.close() as any).branches[0].spent_uncertain, 'said in its summary');
});

/* A fourth review (21/10/2026): a spending not known stays so through a resumption - its events, its delivery, its rebuilding;
   and what the fund holds for it is apart from what was observed spent, never counted as spent nor called a bound. */

const deadBranch = (dir: string) => {
  const branch = path.join(dir, 'run.branches', 'delegation-r1.1.json');
  fs.mkdirSync(path.dirname(branch), { recursive: true });
  fs.writeFileSync(branch, JSON.stringify({ events: [{ type: 'start' }] }));
  fs.writeFileSync(branch.replace(/\.json$/, '.status.json'), JSON.stringify({ heartbeat: new Date(Date.now() - 120000).toISOString(), cost: { llm_tokens: 33 } }));
  return [requested(dir), { type: 'delegation_state', id: 'delegation:r1.1', state: 'running' }, { type: 'delegation_answered', round: 1, request: '{}', answer: {} }];
};

test('a spending not known stays so on a resumption: delivered to the junior, given to the senior, reconciled', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deleg-unc-'));
  const history: any[] = deadBranch(dir);
  const first = base(dir, { history });
  const [m] = first.results();
  /* The junior's: delivered as a message of its run, read again on resuming. */
  const junior = base(dir, { history: [...history, { type: 'operator_message', messages: [m] }] });
  const s = junior.close() as any;
  assert.deepEqual(s.branches[0].spent_uncertain, { at_least: 33, held: 100 }, 'still not known after resuming');
  assert.equal(s.spent, 33);
  assert.equal(s.held_uncertain, 100);
  assert.equal(junior.fundLeft(), 0, 'its grant still held');
  /* Its status says the same as its result and its summary: nothing given as spent, what was observed and what is held apart. */
  const status: any = await junior.run({ delegation: { id: 'delegation:r1.1', status: true } }, 2);
  assert.equal(status.spent_tokens, null, JSON.stringify(status));
  assert.deepEqual(status.spent_not_known, { observed_at_least: 33, held_in_the_fund: 100 });
  /* The senior's: given at one of its calls, its record says so. */
  const logged: any[] = [];
  const senior = base(dir, { history, log: (type, data) => logged.push({ type, ...data }) });
  for (const r of senior.results()) senior.given(r);
  const given = logged.find((e) => e.type === 'branch_result_given');
  assert.deepEqual(given.uncertain, { at_least: 33, held: 100 });
  const resumed = base(dir, { history: [...history, given] });
  assert.deepEqual((resumed.close() as any).branches[0].spent_uncertain, { at_least: 33, held: 100 });
  /* Reconciled before its answer: its state event carries it. */
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'deleg-unc2-'));
  const h2 = deadBranch(dir2).slice(0, 2);
  const rec: any[] = [];
  await base(dir2, { history: h2, log: (type, data) => rec.push({ type, ...data }) }).run({ delegation: { id: 'delegation:r1.1', status: true } }, 2);
  const state = rec.find((e) => e.type === 'delegation_state' && e.reconciled);
  assert.equal(state.spent, 33);
  assert.deepEqual(state.uncertain, { at_least: 33, held: 100 });
  assert.deepEqual((base(dir2, { history: [...h2, state] }).close() as any).branches[0].spent_uncertain, { at_least: 33, held: 100 });
  /* A record of the earlier version (its grant as its spending, the least observed): read as held. */
  const old = base(dir2, { history: [...h2, { type: 'delegation_state', id: 'delegation:r1.1', state: 'failed', reconciled: true, spent: 100, uncertain: { at_least: 33 } }] });
  assert.deepEqual((old.close() as any).branches[0].spent_uncertain, { at_least: 33, held: 100 });
});

test('K1: what the fund holds for a spending not known is apart from what was observed spent', async () => {
  const { runResults } = await import('../src/orchestra/results.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deleg-k1-'));
  const d = base(dir, { history: deadBranch(dir) });
  d.results();
  const journal = path.join(dir, 'run.json');
  fs.writeFileSync(journal, JSON.stringify({ events: [{ type: 'end', t: 1, delegation: d.close() }] }));
  fs.writeFileSync(path.join(dir, 'run.finding.json'), JSON.stringify({ cost: { total: { llm_tokens: 0 } } }));
  const cost = runResults(journal).cost;
  assert.equal(cost.tokens.delegated, 33, 'observed');
  assert.equal(cost.tokens.total_at_least, 33, 'never the amount held');
  assert.equal(cost.tokens.delegated_held_uncertain, 100);
  const note = (cost as any).unknown.find((u: string) => /not known/.test(u));
  assert.ok(note && !/upper bound/.test(note) && /not a bound/.test(note), String(note));
});
