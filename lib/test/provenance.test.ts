import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeExternalConfig, type WebTransport } from '../src/learn/assisted/external.ts';
import { EXTERNAL_PAGES_SECTION, EXTERNAL_SOURCES_SECTION, ORIGIN_LINE } from '../src/learn/assisted/external-sources.ts';
import { classify, hypothesesOf, originOf, provenanceCounts } from '../src/learn/assisted/provenance.ts';
import { runAgentOperator, SENIOR_EXTERNAL_SECTION, SENIOR_ORIGIN_LINE, SENIOR_PAGES_SECTION } from '../src/orchestra/agent-operator.ts';
import { parseLawTurn } from '../src/learn/law-explorer.ts';
import type { ChatClient } from '../src/learn/system2.ts';

/* SPEC-INVESTIGACION-EXTERNA §4.1.2: the provenance of each hypothesis - what its actor had read before it, derived from its
   record, set against where it says the idea comes from. The run of 3SUM with sources (14/11/2026) is the case: a senior
   read a page and, minutes later, proposed what the literature describes, citing nothing - and had nowhere to cite it. */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean, ms = 4000) => { const t = Date.now(); while (!ok() && Date.now() - t < ms) await sleep(10); };

test('an origin as written: "own", a list of references, or nothing', () => {
  assert.equal(originOf('own'), 'own');
  assert.deepEqual(originOf(['src:S1#L1-4', 'exp:exp1#artifact:x']), ['src:S1#L1-4', 'exp:exp1#artifact:x']);
  assert.deepEqual(originOf('src:S2'), ['src:S2']);
  assert.equal(originOf(undefined), null);
  assert.equal(originOf([3, '']), null);
});

test('the class of a hypothesis: declared, unacknowledged, own, declared_unread', () => {
  const ever = new Set(['senior.S1']);
  assert.equal(classify(['src:senior.S1#L4-9'], ['senior.S1'], ever), 'declared');
  assert.equal(classify(null, ['senior.S1'], ever), 'unacknowledged');
  assert.equal(classify('own', ['senior.S1'], ever), 'unacknowledged', 'reads before it and "own": a possible use not acknowledged');
  assert.equal(classify(null, [], ever), 'own');
  assert.equal(classify(['src:S9#L1-2'], [], ever), 'declared_unread');
  assert.equal(classify(['src:S1#L1-2'], [], ever), 'declared', 'an earlier reading of its own, cited by its short id');
});

test('the junior\'s record: each act that says why, each delegation and model closes a stretch, with what it read in it', () => {
  const ok = (snapshot: string) => ({ snapshot, url: 'https://en.wikipedia.org/wiki/3SUM' });
  const change = (why: string) => ({ act: { change: { from: 'v', files: {}, why, exploratory: true } } });
  const j = { events: [
    { type: 'investigation', round: 1, requests: [{ view: 'ep1' }, change('own idea')], results: [{}, { accepted: true }] },
    { type: 'investigation', round: 2, requests: [{ open: 'https://en.wikipedia.org/wiki/3SUM' }, { open: 'https://example.com/x' }], results: [ok('S1'), { state: 'not_allowed' }] },
    { type: 'investigation', round: 2, requests: [change('residues')], results: [{ accepted: true }] },
    { type: 'investigation', round: 3, requests: [{ find: 'modulus', in: 'S1' }, { ...change('from the page'), origin: ['src:S1#L40-60'] }], results: [{ lines: [] }, { accepted: true }] },
    { type: 'investigation', round: 4, requests: [{ ...change('a source never read'), origin: ['src:S7#L1-2'] }], results: [{ accepted: true }] },
    { type: 'proposal', round: 4, origin: 'own' },
    { type: 'operator_message', question: 5, messages: [{ id: 'o1', by: 'agent:senior', read_before: ['senior.S1'], provenance: 'unacknowledged', external_exposure: { direct: true, via: [] } }] },
    { type: 'investigation', round: 5, requests: [{ delegate: { question: 'q' } }], results: [{}] }
  ] };
  const hs = hypothesesOf(j);
  /* What it read stays within its reach: a later hypothesis has it before it too (`read_before`), apart from what it read in
     its own stretch (`fresh`). */
  assert.deepEqual(hs.map((h) => [h.kind, h.ref, h.class, h.read_before.join(','), h.fresh.join(',')]), [
    ['act', 'investigation:r1.1#2', 'own', '', ''],
    ['act', 'investigation:r2.2#1', 'unacknowledged', 'S1', 'S1'],
    ['act', 'investigation:r3.1#2', 'declared', 'S1', 'S1'],
    ['act', 'investigation:r4.1#1', 'declared_unread', 'S1', ''],
    ['model', 'model:r4', 'unacknowledged', 'S1', ''],
    ['message', 'message:o1', 'unacknowledged', 'senior.S1', ''],
    ['delegation', 'investigation:r5.1#1', 'unacknowledged', 'S1,message:o1', 'message:o1']
  ]);
  assert.deepEqual(provenanceCounts(hs), { declared: 1, unacknowledged: 4, own: 1, declared_unread: 1 });
  assert.deepEqual(hypothesesOf({ events: [{ type: 'investigation', round: 1, requests: [change('w')], results: [{}] }] }), [], 'nothing external ever within reach: nothing to say');
});

test('the junior writes "origin" beside an act, and it is kept as it wrote it', () => {
  const turn = parseLawTurn(JSON.stringify({ investigate: [{ act: { run: 1 }, origin: ['src:S1#L2-3'] }] }), { world: 'w', parseAct: (raw) => raw });
  assert.equal(turn.kind, 'investigate');
  assert.deepEqual((turn as { requests: { origin?: unknown }[] }).requests[0].origin, ['src:S1#L2-3']);
});

test('only whoever has external sources is asked where its ideas come from, apart from its evidence', () => {
  for (const s of [EXTERNAL_SOURCES_SECTION, EXTERNAL_PAGES_SECTION]) assert.ok(s.endsWith(ORIGIN_LINE));
  for (const s of [SENIOR_EXTERNAL_SECTION, SENIOR_PAGES_SECTION]) {
    assert.ok(s.endsWith(SENIOR_ORIGIN_LINE));
    assert.doesNotMatch(s, /WHERE AN IDEA COMES FROM/, 'the senior is told its own line, never the junior\'s');
  }
  assert.match(SENIOR_ORIGIN_LINE, /"evidence" stays what in the junior's record supports it/);
});

const PAGE = '<html><body><p>Hash the values to a universe of size about n.</p><p>Pack them in words.</p></body></html>';
const web: WebTransport = async (url) => url === 'https://papers.example.org/3sum'
  ? { status: 200, headers: { 'content-type': 'text/html' }, bytes: new TextEncoder().encode(PAGE), truncated: false }
  : { status: 404, headers: {} as Record<string, string>, bytes: new Uint8Array(), truncated: false };
const config = normalizeExternalConfig({ format: 'external-research@1', web: { allow: ['papers.example.org'] }, budget: { search_calls: 0, fetch_calls: 4, download_bytes: 100000 } });
const check = (round: number) => ({ type: 'check', round, laboratories: [{ place: 'lab1', holds: false }] });

async function senior(decide: Record<string, unknown>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provenance-'));
  const out = path.join(dir, 'run.json');
  fs.writeFileSync(out, JSON.stringify({ experiment: 'cells@1', researcher: 'assisted', events: [check(1), check(2), check(3)] }));
  fs.writeFileSync(out.replace(/\.json$/, '.status.json'), JSON.stringify({ state: 'running', heartbeat: new Date().toISOString(), pid: process.pid }));
  let n = 0;
  const llm: ChatClient = { complete: async () => ({ content: JSON.stringify(++n === 1 ? { investigate: [{ open: 'https://papers.example.org/3sum', from: 1, to: 2 }] } : decide), latencyMs: 0, raw: null }) };
  const controller = new AbortController();
  const agent = runAgentOperator({ id: 'senior', role: 'senior', journal: out, llm, pollMs: 10, signal: controller.signal, external: { config, provider: null, transport: web } });
  await until(() => fs.existsSync(out.replace(/\.json$/, '.inbox.jsonl')));
  controller.abort();
  await agent;
  return JSON.parse(fs.readFileSync(out.replace(/\.json$/, '.inbox.jsonl'), 'utf8').trim().split('\n')[0]);
}

test('a senior that reads a page and then writes to the junior without citing it: its order carries what it read, unacknowledged', async () => {
  const order = await senior({ decision: 'message', text: 'Test a large modulus with packed residue bitsets.', evidence: ['check:r3'], why: 'w' });
  assert.deepEqual(order.read_before, ['senior.S1']);
  assert.equal(order.provenance, 'unacknowledged');
  assert.equal(order.origin, undefined);
});

test('what the senior read stays within its reach: its next message, with nothing read in between, still has it before it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provenance-'));
  const out = path.join(dir, 'run.json');
  const write = (events: unknown[]) => fs.writeFileSync(out, JSON.stringify({ experiment: 'cells@1', researcher: 'assisted', events }));
  write([check(1), check(2), check(3)]);
  fs.writeFileSync(out.replace(/\.json$/, '.status.json'), JSON.stringify({ state: 'running', heartbeat: new Date().toISOString(), pid: process.pid }));
  let n = 0;
  const llm: ChatClient = { complete: async () => ({ content: JSON.stringify(++n === 1 ? { investigate: [{ open: 'https://papers.example.org/3sum', from: 1, to: 2 }] }
    : { decision: 'message', text: 'hypothesis ' + n, evidence: ['check:r3'], why: 'w' }), latencyMs: 0, raw: null }) };
  const controller = new AbortController();
  const inbox = () => (fs.existsSync(out.replace(/\.json$/, '.inbox.jsonl')) ? fs.readFileSync(out.replace(/\.json$/, '.inbox.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const agent = runAgentOperator({ id: 'senior', role: 'senior', journal: out, llm, pollMs: 10, signal: controller.signal, maxOrders: 3, patience: 1, external: { config, provider: null, transport: web } });
  await until(() => inbox().length >= 1);
  /* The junior gets the message and goes on stuck: the senior is called again. */
  write([check(1), check(2), check(3), { type: 'operator_command', by: 'agent:senior', accepted: true }, { type: 'operator_message', question: 4, messages: [{ by: 'agent:senior', text: 'x' }] }, check(4), check(5), check(6), check(7)]);
  await until(() => inbox().length >= 2, 6000);
  controller.abort();
  await agent;
  const [first, second] = inbox();
  assert.deepEqual([first.read_before, first.fresh, first.provenance], [['senior.S1'], ['senior.S1'], 'unacknowledged']);
  assert.ok(second, 'a second message');
  assert.deepEqual([second.read_before, second.fresh, second.provenance], [['senior.S1'], [], 'unacknowledged']);
});

test('a senior that declares where its hypothesis comes from: declared', async () => {
  const order = await senior({ decision: 'message', text: 'Test a large modulus.', evidence: ['check:r3'], origin: ['src:senior.S1#L1-2'], why: 'w' });
  assert.deepEqual([order.read_before, order.provenance, order.origin], [['senior.S1'], 'declared', ['src:senior.S1#L1-2']]);
});
