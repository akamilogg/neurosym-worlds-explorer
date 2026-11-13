import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeExternalConfig, type WebTransport } from '../src/learn/assisted/external.ts';
import { fakeProvider } from '../src/learn/assisted/source-search.ts';
import { researchSpecProblems, runResearchOperator, type OperatorResearchSpec } from '../src/orchestra/research-operator.ts';
import type { ChatClient } from '../src/learn/system2.ts';

/* SPEC-INVESTIGACION-EXTERNA §6.3, §7, IE4: an operator woken by what it declared - a clock included, which says nothing is
   wrong - investigates with its own sources and decides: wait, or a contribution delivered once to each recipient. */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean, ms = 5000) => { const t = Date.now(); while (!ok() && Date.now() - t < ms) await sleep(10); };
const PAGE = '<html><body><p>Sparse adaptation changes few rows.</p></body></html>';
const web: WebTransport = async (url) => url === 'https://papers.example.org/sparse'
  ? { status: 200, headers: { 'content-type': 'text/html' } as Record<string, string>, bytes: new TextEncoder().encode(PAGE), truncated: false }
  : { status: 404, headers: {} as Record<string, string>, bytes: new Uint8Array(), truncated: false };
const config = normalizeExternalConfig({ format: 'external-research@1', search: { provider: 'fake', max_results: 5 }, web: { allow: ['papers.example.org'] },
  budget: { search_calls: 2, fetch_calls: 4, download_bytes: 100000 } });
const provider = fakeProvider({ 'few changed rows': [{ title: 'Sparse adaptation', url: 'https://papers.example.org/sparse', snippet: 'few rows' }] });
function target(dir: string, name: string, state = 'running', experiment = 'cells@1'): string {
  const out = path.join(dir, name + '.json');
  fs.writeFileSync(out, JSON.stringify({ experiment, researcher: 'assisted', events: [{ type: 'start' }, { type: 'check', round: 1, laboratories: [{ place: 'lab1', holds: false }] }] }));
  fs.writeFileSync(out.replace(/\.json$/, '.status.json'), JSON.stringify({ state, heartbeat: new Date().toISOString(), pid: process.pid }));
  return out;
}
const spec = (targets: string[], over: Partial<OperatorResearchSpec> = {}): OperatorResearchSpec => ({ format: 'operator-research@1', id: 'scout', task: 'look for methods other problems use when a model changes too much',
  targets, wake: { interval_ms: 1000 }, budget: { tokens: 100000, calls: 20, minutes: 5, activations: 1 }, max_messages: 2, ...over });
const scripted = (answers: (n: number) => Record<string, unknown>) => {
  let n = 0;
  const seen: Record<string, any>[][] = [];
  const llm: ChatClient = { complete: async (r) => { seen.push((r.user as { parts: Record<string, any>[] }).parts.slice()); n++; return { content: JSON.stringify(answers(n)), latencyMs: 0, raw: { usage: { total_tokens: 50 } } }; } };
  return { llm, seen };
};
const inbox = (t: string): Record<string, any>[] => (fs.existsSync(t.replace(/\.json$/, '.inbox.jsonl')) ? fs.readFileSync(t.replace(/\.json$/, '.inbox.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

test('IE4: an operator-research@1 file - targets, a wake, a finite budget; no session is endless', () => {
  assert.deepEqual(researchSpecProblems(spec(['a.json'])), []);
  assert.match(researchSpecProblems({ ...spec(['a.json']), wake: {} }).join(), /at least one condition/);
  assert.match(researchSpecProblems({ ...spec(['a.json']), budget: { tokens: 1, calls: 1, minutes: 0, activations: 1 } }).join(), /minutes/);
  assert.match(researchSpecProblems({ ...spec(['a.json']), wake: { interval_ms: 10 } }).join(), /at least 1000/);
  assert.match(researchSpecProblems({ ...spec(['a.json']), concurrency: 2 as 1 }).join(), /concurrency/);
});

test('IE4: woken by its clock with nothing stuck, it searches, reads, and delivers a contribution - kept by its content, never a directive, with its exposure; resumed, never delivered twice', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-op-'));
  const t = target(dir, 'run');
  const s = scripted((n) => n === 1 ? { investigate: [{ search: { query: 'few changed rows' } }, { read: 'run' }] }
    : n === 2 ? { investigate: [{ open: 'op-scout.Q1.1' }] }
    : { decision: 'contribute', to: 'all', summary: 'Methods that freeze most weights may fit your problem.', report: 'I read src:op-scout.S1#L1-1. I infer it may apply; I tested nothing.', refs: ['op-scout.S1'], state: 'partial', why: 'a lead' });
  const controller = new AbortController();
  const done = runResearchOperator({ spec: spec([t]), llm: s.llm, pollMs: 10, signal: controller.signal, external: { config, provider, transport: web } });
  await until(() => inbox(t).length > 0);
  controller.abort();
  const record = await done;
  assert.deepEqual(record.activations[0].woken_by.map((w: { fact: string }) => w.fact), ['interval_ms']);
  assert.match(record.activations[0].woken_by[0].note, /nothing is said to be wrong/);
  assert.equal(s.seen[1].at(-1)!.investigation_step.results[1].digest !== undefined, true, 'it read the target as its researcher lived it');
  const c = record.contributions[0];
  assert.deepEqual([c.format, c.state, c.to, c.external_exposure.direct], ['research-contribution@1', 'partial', ['run.json'], true]);
  assert.ok(fs.existsSync(path.join(dir, 'blobs', c.report.sha256)), 'its report kept by its content');
  const orders = inbox(t);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].directive, undefined, 'never a directive');
  assert.deepEqual([orders[0].contribution.id, orders[0].external_exposure.direct], [c.id, true]);
  assert.match(orders[0].text, /adopt, question or ignore/);
  /* Resumed on its record: the same contribution is never delivered again. */
  const again = runResearchOperator({ spec: spec([t], { budget: { tokens: 100000, calls: 20, minutes: 5, activations: 1 } }), llm: scripted(() => ({ decision: 'wait' })).llm, pollMs: 10,
    external: { config, provider, transport: web } });
  await again;
  assert.equal(inbox(t).length, 1, 'keyed by (contribution, recipient)');
});

test('IE4: another activation waits; facts that come together wake one activation; a recipient that ended is never reopened - the late result kept in the record', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-op-'));
  const live = target(dir, 'live'), gone = target(dir, 'gone', 'ended');
  const waits = scripted(() => ({ decision: 'wait', why: 'nothing worth saying' }));
  const w = await runResearchOperator({ spec: spec([live], { wake: { opening: true, interval_ms: 1000 } }), llm: waits.llm, pollMs: 10 });
  assert.equal(w.activations.length, 1);
  assert.deepEqual(w.activations[0].woken_by.map((x: { fact: string }) => x.fact).sort(), ['interval_ms', 'opening'], 'one activation for both');
  assert.equal(w.activations[0].decision.decision, 'wait');
  assert.equal(w.ended_by, 'budget:activations');
  const late = scripted(() => ({ decision: 'contribute', to: ['live', 'gone'], summary: 's', report: 'r', state: 'no_result' }));
  const r = await runResearchOperator({ spec: { ...spec([live, gone], { id: 'late' }) }, llm: late.llm, pollMs: 10 });
  assert.deepEqual(r.deliveries.map((d: { to: string; state?: string }) => [d.to, d.state ?? 'sent']).sort(), [['gone.json', 'kept_recipient_ended'], ['live.json', 'sent']]);
  assert.equal(inbox(gone).length, 0);
});

test('IE4: its lifetime "targets" ends when every target ended; its budget of calls stops an activation where it is', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-op-'));
  const t = target(dir, 'run', 'ended');
  const r = await runResearchOperator({ spec: spec([t]), llm: scripted(() => ({ decision: 'wait' })).llm, pollMs: 10 });
  assert.deepEqual([r.ended_by, r.activations.length], ['targets_ended', 0]);
  const u = target(dir, 'other');
  const reads = scripted(() => ({ investigate: [{ read: 'other' }] }));
  const s = await runResearchOperator({ spec: spec([u], { id: 'thrifty', budget: { tokens: 100000, calls: 2, minutes: 5, activations: 3 } }), llm: reads.llm, pollMs: 10 });
  assert.equal(s.spent.calls, 2);
  assert.match(s.activations[0].decision.why, /calls/);
});
