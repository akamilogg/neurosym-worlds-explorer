import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ResearchStore, write, read, hash } from '../src/console/store.ts';
import { Analysts } from '../src/console/analyst.ts';
import { Actions } from '../src/console/actions.ts';
import { RESEARCH_PAGE } from '../src/console/page.ts';
import { serveConsole } from '../src/runtime/console.ts';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'research-console-'));
function fixture(dir: string, name = 'a') {
  const file = path.join(dir, 'runs', name + '.json');
  const j = { experiment: 'cells@1', researcher: 'assisted', started: '2026-10-04T10:00:00.000Z', config: { llm_model: 'stub', attempts: 3 },
    hidden_from_the_learner: { truth: 'PRIVATE-TRUTH' },
    events: [
      { type: 'exploration_episode', episode: 'ep1', rows: ['PRIVATE-ROWS'], t: 0 },
      { type: 'investigation', round: 1, t: 1, requests: [{ view: 'ep1', from: 0, to: 2 }], results: [{ rows: ['visible'] }] },
      { type: 'proposal', round: 1, t: 2, rationale: 'early hypothesis', beliefs: [{ id: 'b', stance: 'new', statement: 'early', evidence: ['ep1@1'] }] },
      { type: 'operator_rule_recovery', round: 1, score: 1, truth: 'PRIVATE-GRADE', t: 3 },
      { type: 'reflection', round: 2, rationale: 'FUTURE-KNOWLEDGE', t: 4 }
    ] };
  write(file, j); write(file.replace('.json', '.status.json'), { state: 'running', heartbeat: new Date().toISOString(), round: 2 });
  return { file, j };
}
test('snapshots isolate views and historical search/detail/export; frozen evidence survives source mutation', () => {
  const dir = root(), { file, j } = fixture(dir), store = new ResearchStore(dir);
  const s = store.capture(['a'], 'researcher', { a: 3 });
  assert.equal(s.historical, true);
  assert.ok(!/PRIVATE|FUTURE/.test(JSON.stringify(s)));
  assert.equal(store.evidence(s, 'FUTURE').total, 0);
  assert.ok(!/PRIVATE|FUTURE/.test(store.export(s)));
  const before = JSON.stringify(s);
  j.events[1].results = [{ rows: ['changed after capture'] }]; write(file, j);
  assert.equal(JSON.stringify(store.snapshot(s.id)), before);
  assert.ok(store.capture(['a'], 'operator').events.some(e => e.type === 'operator_context'));
  assert.throws(() => store.capture(['../../outside'], 'operator'));
  assert.throws(() => store.snapshot('../../outside'));
  fs.writeFileSync(file, '{partial');
  assert.equal(store.catalogue()[0].stale, true);
  assert.throws(() => store.capture(['a'], 'operator'), /being written/);
});
test('event ids survive append, branches link to parents, message delivery has a real edge', () => {
  const dir = root(), { file, j } = fixture(dir), store = new ResearchStore(dir);
  const s = store.capture(['a'], 'operator');
  const more = { ...j, events: [...j.events, { type: 'operator_command', id: 'm1', accepted: true }, { type: 'operator_message', messages: [{ id: 'm1', text: 'test it' }] }] };
  write(file, more);
  const next = store.capture(['a'], 'operator');
  assert.equal(s.events[1].id, next.events[1].id);
  assert.equal(next.relations.filter(r => r.kind === 'delivered').length, 1);
  write(path.join(dir, 'runs', 'child.json'), { ...j, started: '2026-10-04T11:00:00.000Z', resumed: { from: 'a.json', from_started: j.started } });
  assert.equal(store.catalogue().find(e => e.id === 'child')?.parent, 'a');
});
test('durable message commands are idempotent, obey pure policy, and distinguish acceptance from delivery', () => {
  const dir = root(), { file, j } = fixture(dir), store = new ResearchStore(dir), analysts = new Analysts(store, {}), actions = new Actions(store, analysts, {});
  const rev = store.catalogue()[0].revision;
  const command = { key: 'same-order', kind: 'message', targets: ['a'], revisions: { a: rev }, text: 'look here' };
  const a = actions.send(command); actions.send(command);
  const inbox = file.replace('.json', '.inbox.jsonl');
  assert.equal(fs.readFileSync(inbox, 'utf8').trim().split('\n').length, 1);
  assert.equal(a.targets[0].state, 'pending');
  const order = JSON.parse(fs.readFileSync(inbox, 'utf8'));
  write(file, { ...j, events: [...j.events, { type: 'operator_command', id: order.id, accepted: true }] });
  assert.equal(actions.get(command.key).targets[0].state, 'accepted');
  write(file, { ...j, events: [...j.events, { type: 'operator_command', id: order.id }, { type: 'operator_message', messages: [order] }] });
  assert.equal(actions.get(command.key).targets[0].state, 'delivered');
  assert.throws(() => actions.send({ ...command, text: 'different' }), /different action/);
  write(file, { ...j, researcher: 'unknown-world' });
  const refused = actions.send({ ...command, key: 'pure-order', revisions: { a: store.catalogue()[0].revision } });
  assert.equal(refused.targets[0].state, 'refused');
  assert.equal(fs.readFileSync(inbox, 'utf8').trim().split('\n').length, 1);
  analysts.close();
});
test('analyst uses frozen evidence and a separate reservation; reports require opened references', async () => {
  const dir = root(); fixture(dir); const store = new ResearchStore(dir), s = store.capture(['a'], 'researcher', { a: 3 });
  const seen: any[] = [];
  const analysts = new Analysts(store, {}, () => ({ async complete(q) {
    const u = q.user as any; seen.push(u);
    return { latencyMs: 1, raw: { usage: { total_tokens: 100 } }, content: JSON.stringify(seen.length === 1 ? { open: [s.events[1].id] } : { report: {
      facts: [{ text: 'visible', refs: [s.events[1].id] }, { text: 'invented', refs: ['missing'] }], interpretations: [], unknowns: [] } }) };
  } }));
  analysts.setBudget(60000);
  const before = fs.readFileSync(path.join(dir, 'runs', 'a.json'), 'utf8');
  const a = analysts.start({ snapshot: s.id, task: 'inspect', budget: 40000 });
  assert.throws(() => analysts.start({ snapshot: s.id, task: 'another', budget: 40000 }), /Insufficient/);
  for (let i = 0; i < 100 && !['complete', 'error', 'budget', 'steps'].includes(analysts.get(a.id).state); i++) await new Promise(r => setTimeout(r, 10));
  const done = analysts.get(a.id);
  assert.equal(done.state, 'complete'); assert.equal(done.spent, 200);
  assert.equal(done.reports[0].report.facts.length, 1);
  assert.match(done.reports[0].report.unknowns[0], /referencia/);
  assert.ok(!/PRIVATE|FUTURE/.test(JSON.stringify(seen)));
  assert.equal(analysts.ledger().remaining, 59800);
  assert.equal(fs.readFileSync(path.join(dir, 'runs', 'a.json'), 'utf8'), before);
  analysts.close();
});
test('operator-profile analysis cannot send help even if its output is harmless', () => {
  const dir = root(); fixture(dir); const store = new ResearchStore(dir), s = store.capture(['a'], 'operator'), analysts = new Analysts(store, {});
  write(analysts.file('audit'), { format: 'analysis@1', id: 'audit', profile: 'operator', snapshot: s.id, reports: [{ report: { facts: [{ text: 'hello' }] } }] });
  const actions = new Actions(store, analysts);
  assert.throws(() => actions.send({ key: 'share-private', kind: 'message', targets: ['a'], text: 'hello', analysis: 'audit' }), /researcher-profile/);
  analysts.close();
});
test('research API protects mutations, freezes and exports snapshots, and serves parseable browser code', async () => {
  const dir = root(); fixture(dir); const c = await serveConsole({ root: dir, port: 0, env: {} });
  try {
    const base = c.url + '/api/research/';
    const session = await (await fetch(base + 'session')).json() as any;
    const denied = await fetch(base + 'budget', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"limit":100}' });
    assert.equal(denied.status, 403);
    const foreign = await fetch(base + 'budget', { method: 'POST', headers: { origin: 'https://elsewhere.test', 'x-console-token': session.token }, body: '{}' });
    assert.equal(foreign.status, 403);
    const r = await fetch(base + 'snapshots', { method: 'POST', headers: { 'x-console-token': session.token }, body: JSON.stringify({ entities: ['a'], profile: 'researcher', positions: { a: 3 } }) });
    assert.equal(r.status, 201); const s = await r.json() as any;
    const exported = await (await fetch(base + 'snapshots/' + s.id + '/export')).text(); assert.ok(!/PRIVATE|FUTURE/.test(exported));
    const html = await (await fetch(c.url + '/research')).text(); assert.equal(html, RESEARCH_PAGE);
    const js = html.split('<script>')[1].split('</script>')[0]; assert.doesNotThrow(() => new Function(js));
  } finally { await c.close(); }
});

test('a resumed run accounts for inherited tokens separately from live purchases', async () => {
  const dir = root();
  const answer = { choices: [{ message: { content: JSON.stringify({ rationale: 'baseline', observations: {}, rules: {}, weights: {},
    output: '(p) => p.rows[p.rows.length-1]', validate: false, beliefs: [], lessons: [] }) } }], usage: { total_tokens: 50 } };
  const opts = { root: dir, llm: { url: 'http://stub.test', model: 'stub' }, fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(answer), headers: { get: () => null } }) };
  const first = await runLaboratory(cellsLab, { ...opts, args: ['--seed', '1', '--level', '1', '--attempts', '1', '--flat', '--no-grade', '--no-reflection', '--out', path.join(dir, 'runs', 'first.json')] });
  const again = await runLaboratory(cellsLab, { ...opts, args: ['--resume', first.journal, '--out', path.join(dir, 'runs', 'again.json')] });
  const original = read(first.journal)!.events.find((e: any) => e.type === 'end').console_usage;
  const replayed = read(again.journal)!.events.find((e: any) => e.type === 'end').console_usage;
  assert.ok(original.llm_tokens_live > 0);
  assert.equal(replayed.llm_tokens_live, 0);
  assert.equal(replayed.llm_tokens_replayed, original.llm_tokens_live);
});

test('a workspace has a single console writer and releases its lease on close', async () => {
  const dir = root(); const c = await serveConsole({ root: dir, port: 0, env: {} });
  try { assert.throws(() => serveConsole({ root: dir, port: 0, env: {} }), /Another console/); }
  finally { await c.close(); }
  const again = await serveConsole({ root: dir, port: 0, env: {} }); await again.close();
});
test('a report of the instrument is shown on its run with its state, and the console writes the operator\'s verdict next to it', () => {
  const dir = root(), { file, j } = fixture(dir), store = new ResearchStore(dir), analysts = new Analysts(store, {}), actions = new Actions(store, analysts, {});
  write(file, { ...j, events: [...j.events, { type: 'instrument_report', round: 2, id: 'ir1', by: 'junior', what: 'the cut was not applied', evidence: ['act1'], kind: 'accepted_but_not_applied' }] });
  assert.deepEqual(store.catalogue()[0].anomalies, [{ id: 'ir1', by: 'junior', state: 'pending', kind: 'accepted_but_not_applied', what: 'the cut was not applied' }]);
  assert.match(RESEARCH_PAGE, /kind:'verdict'/);
  assert.throws(() => actions.send({ key: 'v0', kind: 'verdict', entity: 'a', report: 'ir9', verdict: 'bug' }), /No report/);
  assert.throws(() => actions.send({ key: 'v1', kind: 'verdict', entity: 'a', report: 'ir1', verdict: 'maybe' }), /A verdict is/);
  assert.equal(actions.send({ key: 'v2', kind: 'verdict', entity: 'a', report: 'ir1', verdict: 'bug' }).targets[0].state, 'written');
  assert.equal(store.catalogue()[0].anomalies![0].state, 'bug');
  const researcherView = store.capture(['a'], 'researcher');
  assert.ok(researcherView.events.some((e) => e.type === 'instrument_report'), 'its own report is the researcher\'s to read');
  analysts.close();
});
