import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { normalizeExternalConfig, type WebTransport } from '../src/learn/assisted/external.ts';
import { ExternalSources, EXTERNAL_SOURCES_SECTION } from '../src/learn/assisted/external-sources.ts';
import { fakeProvider } from '../src/learn/assisted/source-search.ts';
import { exposureOf } from '../src/learn/assisted/exposure.ts';
import { agentFile, runAgentOperator, SENIOR_EXTERNAL_SECTION } from '../src/orchestra/agent-operator.ts';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { gridLab } from '../src/worlds/grid/lab.ts';
import type { ChatClient } from '../src/learn/system2.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';

/* SPEC-INVESTIGACION-EXTERNA, IE2: the same instruments for the junior without a senior, for the senior and in the grid's
   loop - each with its own bags; the pure researcher and runs without the capability unchanged. */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean, ms = 4000) => { const t = Date.now(); while (!ok() && Date.now() - t < ms) await sleep(10); };
const PAGE = '<html><body><p>Sparse adaptation changes few rows.</p><p>Freeze the rest.</p></body></html>';
const web = (seen: string[] = []): WebTransport => async (url) => {
  seen.push(url);
  return url === 'https://papers.example.org/sparse' ? { status: 200, headers: { 'content-type': 'text/html' }, bytes: new TextEncoder().encode(PAGE), truncated: false }
    : { status: 404, headers: {} as Record<string, string>, bytes: new Uint8Array(), truncated: false };
};
const provider = fakeProvider({ 'sparse adaptation': [{ title: 'Sparse adaptation', url: 'https://papers.example.org/sparse', snippet: 'few rows' }] });
const config = normalizeExternalConfig({ format: 'external-research@1', search: { provider: 'fake', max_results: 5 }, web: { allow: ['papers.example.org'] },
  budget: { search_calls: 2, fetch_calls: 4, download_bytes: 100000 } });
const check = (round: number) => ({ type: 'check', round, laboratories: [{ place: 'lab1', holds: false }] });
function journal(dir: string, name: string, experiment: string, events: Record<string, unknown>[]): string {
  const out = path.join(dir, name + '.json');
  fs.writeFileSync(out, JSON.stringify({ experiment, researcher: 'assisted', events }));
  fs.writeFileSync(out.replace(/\.json$/, '.status.json'), JSON.stringify({ state: 'running', heartbeat: new Date().toISOString(), pid: process.pid }));
  return out;
}
const scripted = (answers: (n: number, user: Record<string, any>) => Record<string, unknown>) => {
  const systems: string[] = [];
  const steps: Record<string, any>[] = [];
  const llm: ChatClient = { complete: async (r) => {
    systems.push(r.system);
    const parts = (r.user as { parts: Record<string, any>[] }).parts;
    const last = parts.at(-1)!;
    if (last.investigation_step) steps.push(last.investigation_step);
    return { content: JSON.stringify(answers(systems.length, last)), latencyMs: 0, raw: null };
  } };
  return { systems, steps, llm };
};

test('IE2: the senior searches and reads by itself - its own bags, its ids apart from the junior\'s, its record keeps what it read; its message carries its exposure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'senior-ext-'));
  const out = journal(dir, 'run', 'cells@1', [check(1), check(2), check(3)]);
  const seen: string[] = [];
  const s = scripted((n) => n === 1 ? { investigate: [{ search: { query: 'sparse adaptation', limit: 2 } }] }
    : n === 2 ? { investigate: [{ open: 'senior.Q1.1', from: 1, to: 2 }] }
    : { decision: 'message', text: 'Test whether changing only a few rows is enough (src:senior.S1#L1-1).', evidence: ['check:r3'], why: 'a lead from a source' });
  const controller = new AbortController();
  const agent = runAgentOperator({ id: 'senior', role: 'senior', journal: out, llm: s.llm, pollMs: 10, signal: controller.signal, external: { config, provider, transport: web(seen) } });
  await until(() => fs.existsSync(out.replace(/\.json$/, '.inbox.jsonl')));
  controller.abort();
  await agent;
  assert.ok(s.systems[0].includes(SENIOR_EXTERNAL_SECTION.split('\n')[0]), 'told its instruments');
  assert.deepEqual(s.steps[0].results[0].results.map((r: { id: string }) => r.id), ['senior.Q1.1'], 'its ids apart from the junior\'s');
  assert.equal(s.steps[1].results[0].snapshot, 'senior.S1');
  const record = JSON.parse(fs.readFileSync(agentFile(out, 'senior'), 'utf8'));
  assert.deepEqual(record.sources_log.map((e: { type: string }) => e.type), ['external_research_inventory', 'source_search', 'source_acquired']);
  assert.deepEqual(record.sources_log[2].left, { search_calls: 1, fetch_calls: 3, download_bytes: 100000 - new TextEncoder().encode(PAGE).length }, 'its own bags');
  const order = JSON.parse(fs.readFileSync(out.replace(/\.json$/, '.inbox.jsonl'), 'utf8').trim().split('\n')[0]);
  assert.equal(order.external_exposure.direct, true, 'what it sends carries its exposure');
  assert.deepEqual(seen, ['https://papers.example.org/sparse']);
});

test('IE2: in a world that admits no external sources the senior is refused them too, and its messages are not pushed there exposed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'senior-ext-'));
  const out = journal(dir, 'run', 'c302-navigation@1', [check(1), check(2), check(3)]);
  const s = scripted((n) => n === 1 ? { investigate: [{ search: { query: 'connectome' } }] } : { decision: 'wait', why: 'nothing' });
  const controller = new AbortController();
  const agent = runAgentOperator({ id: 'senior', role: 'senior', journal: out, llm: s.llm, pollMs: 10, signal: controller.signal, external: { config, provider, transport: web() } });
  await until(() => s.systems.length >= 2);
  controller.abort();
  await agent;
  assert.ok(!s.systems[0].includes(SENIOR_EXTERNAL_SECTION.split('\n')[0]), 'nothing announced');
  assert.equal(s.steps[0].results[0].state, 'not_allowed');
  assert.match(s.steps[0].results[0].why, /connectome/);
  const record = JSON.parse(fs.readFileSync(agentFile(out, 'senior'), 'utf8'));
  assert.equal(record.sources_log[0].type, 'external_research_refused');
});

test('IE2: an actor without a replay log made again in a new process reads its snapshots offline from its record and the texts kept, and keeps its bags', async () => {
  const blobs = new Map<string, string>();
  const keep = (t: string) => { const sha = createHash('sha256').update(t).digest('hex'); blobs.set(sha, t); return sha; };
  const events: Record<string, any>[] = [];
  const a = new ExternalSources({ config, actor: 'senior', provider, transport: web(), keep, log: (type, d) => events.push({ type, ...d }) });
  await a.search({ query: 'sparse adaptation' });
  await a.open('senior.Q1.1');
  const b = new ExternalSources({ config, actor: 'senior', provider, transport: async () => { throw new Error('never the network'); } });
  b.restore(events, (sha) => blobs.get(sha) ?? null);
  assert.match((await b.open('senior.S1', 1, 1) as any).text, /Sparse adaptation changes few rows/);
  assert.deepEqual(b.spending(), a.spending());
  assert.equal(b.allSnapshots().length, 1);
  assert.ok(b.accepts({ open: 'senior.Q1.1' }), 'its search results known again');
});

test('IE2: a message from an exposed actor exposes the run that receives it (via), as its record shows', () => {
  const x = exposureOf({ events: [{ type: 'operator_message', question: 3, messages: [{ id: 'm1', by: 'agent:senior', text: 't', external_exposure: { direct: true, via: [], since: null } }] }] });
  assert.deepEqual([x.direct, x.via], [false, ['agent:senior']]);
  assert.equal(exposureOf({ events: [{ type: 'investigation', requests: [{ open: 'x' }], results: [{ text: 't' }] }] }).direct, false, 'another world\'s requests named alike, without sources, are no reading of one');
});

/* --- The grid's loop --------------------------------------------------------------------------------------------- */

const GRID = ['--seed', '22', '--attempts', '2', '--explore', '2', '--variants', '1', '--family', '1', '--family-variants', '1', '--confirm-places', '1', '--levels', '2', '--depth', '1',
  '--flat', '--no-grade', '--no-reflection', '--no-ablation'];
const system2 = (asked: Record<string, any>[]): FetchLike => async (_url, init) => {
  const b = JSON.parse(String(init.body));
  const user = JSON.parse(userOf(b));
  asked.push({ system: b.messages[0].content as string, user });
  const done = (user.investigation ?? []).length;
  const content = user.round === 1 && done === 0 ? { investigate: [{ search: { query: 'sparse adaptation' } }] }
    : user.round === 1 && done === 1 ? { investigate: [{ open: 'Q1.1' }] }
    : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p, m) => 0.5', validate: false, beliefs: [{ id: 'b', stance: user.round === 1 ? 'new' : 'keep', statement: 's' }], lessons: ['l'] };
  const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
  return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
};

test('IE2: the grid\'s loop - the same instruments, announced in its prompt and answered by the sources, never by the world', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grid-ext-'));
  fs.writeFileSync(path.join(dir, 'external.json'), JSON.stringify({ format: 'external-research@1', search: { provider: 'fake', max_results: 5 }, web: { allow: ['papers.example.org'] },
    budget: { search_calls: 2, fetch_calls: 4, download_bytes: 100000 } }));
  const asked: Record<string, any>[] = [];
  const r = await runLaboratory(gridLab, { args: [...GRID, '--researcher', 'assisted', '--external-research', 'external.json', '--out', path.join(dir, 'run.json')], root: dir,
    llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch: system2(asked), external: { provider, transport: web() } });
  assert.ok(asked[0].system.includes(EXTERNAL_SOURCES_SECTION));
  assert.equal(asked[1].user.investigation[0].results[0].results[0].id, 'Q1.1');
  assert.equal(asked[2].user.investigation[1].results[0].snapshot, 'S1');
  const events = JSON.parse(fs.readFileSync(r.journal, 'utf8')).events as Record<string, any>[];
  assert.ok(events.some((e) => e.type === 'source_acquired' && e.snapshot === 'S1'));
  assert.equal((r.finding as any).external_exposure.direct, true);
});

test('IE2: without the capability, nothing changes - the pure grid researcher is not told of external sources', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grid-ext-'));
  const asked: Record<string, any>[] = [];
  const plain: FetchLike = async (_url, init) => {
    const b = JSON.parse(String(init.body));
    asked.push({ system: b.messages[0].content as string });
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify({ rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p, m) => 0.5', validate: false, lessons: ['l'] }) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
  const r = await runLaboratory(gridLab, { args: [...GRID, '--out', path.join(dir, 'run.json')], root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch: plain });
  assert.ok(asked.every((q) => !q.system.includes('EXTERNAL SOURCES')));
  assert.equal((r.finding as any).external_research, undefined);
  assert.equal((r.finding as any).external_exposure.direct, false);
});
