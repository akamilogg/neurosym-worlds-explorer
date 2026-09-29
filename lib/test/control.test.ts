import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { LabError, chooseResearcher, parsePolicy, runLaboratory } from '../src/runtime/lab-runner.ts';
import { finding, listRuns, orderOutcome, runFiles, runStatus, send, startRun, stop } from '../src/runtime/control.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';
import { LABS } from '../src/worlds/labs.ts';
import { isGameLab } from '../src/learn/lab.ts';
import { system2Prompt } from '../src/learn/prompt.ts';
import { explorerSystem } from '../src/learn/explorer.ts';
import type { FetchLike } from '../src/core/net.ts';

/* SPEC-INVESTIGADOR-ASISTIDO A1: the unknown-world researcher frozen, the researcher and the operator's policy in the
   journal, a run as an object with a state and an inbox, and the control API over it. */

test('the unknown-world researcher is frozen: what System 2 is told in every world, byte for byte', () => {
  const h = (t: string) => createHash('sha256').update(t).digest('hex').slice(0, 16);
  /* The system prompt without and with the paired regression, and the percept, per world (the grid: its explorer's). */
  const FROZEN: Record<string, readonly string[]> = {
    cells: ['784da62b276314c5', 'd4e4158be39284b2', '050b7ce0a173f715'],
    messages: ['862ec75da0073ef9', '2db815f4e4ef01a1', 'e7b3118baeb95c62'],
    orbit: ['b9fcdc914383feac', '0a1d03f828800311', 'fa67491c1a09af17'],
    tank: ['39c541ec15e04674', '31707f80df38a21e', '8a934b83bc5bb3a5'],
    grid: ['23e7fb5bdaf9bc6e']
  };
  for (const [name, lab] of Object.entries(LABS)) {
    if (isGameLab(lab)) { assert.deepEqual([h(explorerSystem())], FROZEN[name], name); continue; }
    const all = new Set(lab.interface({}).tools);
    assert.deepEqual([h(system2Prompt(lab.interface({ regression: false }), all)), h(system2Prompt(lab.interface({ regression: true }), all)), h(lab.perceptDoc)], FROZEN[name], name);
  }
});

test('the operator\'s policy: allowed researchers, or one forced; a researcher it does not allow never starts', () => {
  assert.deepEqual(parsePolicy('force=assisted'), { force: 'assisted' });
  assert.deepEqual(parsePolicy('allow=unknown-world,assisted'), { allow: ['unknown-world', 'assisted'] });
  assert.throws(() => parsePolicy('force=oracle'), LabError);
  assert.equal(chooseResearcher('assisted', { force: 'unknown-world' }), 'unknown-world');
  assert.equal(chooseResearcher('unknown-world', null), 'unknown-world');
  assert.throws(() => chooseResearcher('unknown-world', { allow: ['assisted'] }), /does not allow/);
});

/* --- System 2 stand-in: investigates in odd rounds, then proposes the same row again; `delayMs` makes a run last. */
const draft = { observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]' };
const answer = (body: string): string => {
  const b = JSON.parse(body);
  const sys = b.messages[0].content as string, user = b.messages[b.messages.length - 1].content as string;
  const content = sys.startsWith('You grade') ? { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' }
    : /"task"/.test(user) ? { rationale: 'r', beliefs: [{ id: 'b', stance: 'confirm', why: 'w' }], lessons: ['l'], next_experiment: 'n' }
    : !JSON.parse(user).investigation && JSON.parse(user).round % 2 === 1 ? { investigate: [{ view: 'ep1', from: 0, to: 3 }] }
    : { rationale: 'r', ...draft, validate: false, beliefs: [{ id: 'b', stance: 'new', statement: 's' }], lessons: ['l'] };
  return JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
};
const system2 = (hook: () => void = () => {}): FetchLike => async (_url, init) => { hook(); const text = answer(String(init.body)); return { ok: true, status: 200, text: async () => text, headers: { get: () => null } }; };
const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'control-'));
const ARGS = ['--seed', '1', '--level', '1', '--attempts', '6', '--flat', '--no-grade', '--no-reflection'];
const options = (dir: string, fetch: FetchLike, more: object = {}) => ({ args: [...ARGS, '--out', path.join(dir, 'runs', 'run.json')], root: dir,
  llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch, ...more });

test('the journal says which researcher ran, which was asked, and under which policy; assisted is not built yet', async () => {
  const dir = root();
  const r = await runLaboratory(cellsLab, options(dir, system2(), { policy: { allow: ['unknown-world'] } }));
  const j = JSON.parse(fs.readFileSync(r.journal, 'utf8'));
  assert.deepEqual([j.researcher, j.researcher_requested, j.researcher_policy], ['unknown-world', 'unknown-world', { allow: ['unknown-world'] }]);
  assert.equal(r.researcherUsed, 'unknown-world');
  await assert.rejects(runLaboratory(cellsLab, options(dir, system2(), { researcher: 'assisted' })), /not built yet/);
  await assert.rejects(runLaboratory(cellsLab, options(dir, system2(), { policy: { force: 'assisted' } })), /not built yet/);
  await assert.rejects(runLaboratory(cellsLab, { ...options(dir, system2()), args: [...ARGS, '--policy', 'allow=assisted'] }), /does not allow/);
});

test('an order in the inbox: stop is obeyed before the next question; help is refused by the unknown-world researcher, and said so', async () => {
  const dir = root();
  let journal = '', asked = 0;
  /* The operator writes while the run is going: after System 2's first answer, a message and a stop. */
  const hook = () => { if (++asked === 2) { send(journal, { kind: 'message', text: 'look at step 0', by: 'operator' }); stop(journal, 'operator'); } };
  const r = await runLaboratory(cellsLab, options(dir, system2(hook), { onJournal: (f: string) => { journal = f; } }));
  assert.equal(r.stoppedBy, 'cancelled');
  const events = JSON.parse(fs.readFileSync(r.journal, 'utf8')).events;
  const refused = events.find((e: { type: string }) => e.type === 'operator_command_refused');
  assert.equal(refused.kind, 'message');
  assert.match(refused.reason, /learns only from what the world answers/);
  assert.equal(events.find((e: { type: string }) => e.type === 'operator_command').kind, 'stop');
  assert.ok(!JSON.stringify(events).includes('look at step 0'), 'the refused help reaches nothing: not even the journal');
  assert.equal(asked, 2, 'no question after the stop');
  const status = JSON.parse(fs.readFileSync(runFiles(r.journal).status, 'utf8'));
  assert.deepEqual([status.state, status.stoppedBy, status.researcher], ['ended', 'cancelled', 'unknown-world']);
});

test('the control API lists runs with their state, reports orders, and gives the finding in either view', async () => {
  const dir = root();
  const r = await runLaboratory(cellsLab, options(dir, system2()));
  const runs = listRuns(path.join(dir, 'runs'));
  assert.equal(runs.length, 1);
  assert.deepEqual([runs[0].lab, runs[0].researcher, runs[0].state, runs[0].stoppedBy], ['cells@1', 'unknown-world', 'ended', r.stoppedBy]);
  const { id } = send(r.journal, { kind: 'stop' });
  assert.deepEqual(orderOutcome(r.journal, id), { state: 'pending' }, 'an ended run reads no more orders');
  assert.equal(finding(r.journal).view, 'operator');
  assert.equal(finding(r.journal, 'researcher').view, 'researcher');
  /* A run whose heartbeat stopped without an end was interrupted. */
  const cut = path.join(dir, 'runs', 'cut.json');
  const j = JSON.parse(fs.readFileSync(r.journal, 'utf8'));
  fs.writeFileSync(cut, JSON.stringify({ ...j, events: j.events.filter((e: { type: string }) => e.type !== 'end') }));
  fs.writeFileSync(runFiles(cut).status, JSON.stringify({ state: 'running', heartbeat: new Date(Date.now() - 60000).toISOString(), lab: 'cells@1' }));
  assert.equal(runStatus(cut).state, 'interrupted');
});

test('a run started in a process of its own is followed and stopped through its inbox', { timeout: 120000 }, async () => {
  const dir = root();
  /* System 2 over HTTP, slow enough that the run is still going when it is stopped. */
  const server = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => setTimeout(() => res.end(answer(b)), 400)); });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1/chat/completions';
  try {
    const { journal, pid } = startRun('cells', { root: dir, args: ARGS, env: { ...process.env, LLM_URL: url, LLM_MODEL: 'stand-in', LLM_KEY: '', JEV_KEY: '' } });
    assert.ok(pid > 0);
    const until = async (ok: () => boolean, ms = 60000) => { const t = Date.now(); while (!ok()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 200)); } };
    await until(() => fs.existsSync(runFiles(journal).status) && runStatus(journal).state === 'running');
    const { id } = stop(journal, 'test');
    await until(() => runStatus(journal).state === 'ended');
    assert.equal(runStatus(journal).stoppedBy, 'cancelled');
    assert.equal(orderOutcome(journal, id).state, 'accepted');
    assert.equal(listRuns(path.join(dir, 'runs'))[0].researcher, 'unknown-world');
  } finally { server.close(); }
});
