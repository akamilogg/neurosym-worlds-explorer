import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLaboratory, LabError } from '../src/runtime/lab-runner.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';
import { DOCUMENTARY_SECTION, type Launcher } from '../src/learn/assisted/delegation.ts';
import { fakeProvider } from '../src/learn/assisted/source-search.ts';
import type { WebTransport } from '../src/learn/assisted/external.ts';
import { runResults } from '../src/orchestra/results.ts';
import { classOf } from '../src/learn/requests.ts';
import { finishOf } from '../src/learn/law-session.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';

/* SPEC-INVESTIGACION-EXTERNA §6.2, IE3: a documentary branch - no world of its own, no simulator, no baseline, no
   evaluation; records, sources and notes; it ends with its report ({"finish": ...}), never an acceptance - and its result
   goes back as a contribution kept by its content, with its exposure. Its bags of sources are granted from its requester's. */

const MODEL = { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]', validate: false, lessons: ['l'], next_experiment: 'n', beliefs: [] };
const reply = (content: unknown) => { const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 50 } }); return { ok: true, status: 200, text: async () => text, headers: { get: () => null } }; };
const llm = { url: 'http://x.test/v1/chat/completions', model: 's' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const eventsOf = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8')).events as Record<string, any>[];
const PAGE = '<html><body><p>Edge cells copy their neighbour in many automata.</p></body></html>';
const web: WebTransport = async (url) => url === 'https://papers.example.org/edges'
  ? { status: 200, headers: { 'content-type': 'text/html' } as Record<string, string>, bytes: new TextEncoder().encode(PAGE), truncated: false }
  : { status: 404, headers: {} as Record<string, string>, bytes: new Uint8Array(), truncated: false };
const provider = fakeProvider({ 'edge cells automata': [{ title: 'Edges', url: 'https://papers.example.org/edges', snippet: 's' }] });

interface Seen { child: { system: string; user: any }[]; childDone: Promise<{ journal: string; stoppedBy: string }>[]; args: string[][] }
function launcher(root: string, seen: Seen): Launcher {
  return (l) => {
    seen.args.push([...l.args]);
    let step = 0;
    const childFetch: FetchLike = async (_url, init) => {
      const b = JSON.parse(String(init.body));
      const user = JSON.parse(userOf(b));
      seen.child.push({ system: b.messages[0].content, user });
      step++;
      return reply(step === 1 ? { investigate: [{ search: { query: 'edge cells automata' } }] }
        : step === 2 ? MODEL
        : { finish: { report: 'I read src:S1#L1-1: edge cells copy their neighbour in many automata. I infer it may hold here; I tested nothing.', state: 'partial', refs: ['src:S1#L1-1'] },
          notes: [{ do: 'write', id: 'edges', text: 'a lead from a source' }] });
    };
    seen.childDone.push(runLaboratory(cellsLab, { args: [...l.args, '--out', l.journal], root, llm, fetch: childFetch, external: { provider, transport: web } }));
  };
}
const parentFetch = (asks: Record<string, unknown>[]): FetchLike => async (_url, init) => {
  await sleep(40);
  const user = JSON.parse(userOf(JSON.parse(String(init.body))));
  if ('task' in user) return reply({ rationale: 'r', beliefs: [], lessons: ['l'], next_experiment: 'n' });
  const done = (user.investigation ?? []).length;
  return reply(user.round === 1 && done < asks.length ? { investigate: [asks[done]] } : MODEL);
};
const args = (dir: string, extra: string[]) => ['--seed', '1', '--level', '1', '--researcher', 'assisted', '--flat', '--no-grade', '--no-reflection', '--no-ablation',
  '--delegation-fund', '1000', '--delegation-tokens', '500', ...extra, '--out', path.join(dir, 'run.json')];
const external = (dir: string) => fs.writeFileSync(path.join(dir, 'external.json'), JSON.stringify({ format: 'external-research@1', search: { provider: 'fake', max_results: 5 },
  web: { allow: ['papers.example.org'] }, budget: { search_calls: 5, fetch_calls: 10, download_bytes: 100000 }, branches: { inherit_sources: true, budget: { search_calls: 2, fetch_calls: 3, download_bytes: 50000 } } }));
const DOC = { delegate: { question: 'What do other automata do at their edges?', access: { world: 'none', sources: true }, budget: { rounds: 3, search_calls: 1 } } };

test('IE3: a documentary branch starts no simulator, reads with the bags granted from its requester\'s, refuses a model, ends with its report - never an acceptance - and its result is a contribution with its exposure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'documentary-'));
  external(dir);
  const seen: Seen = { child: [], childDone: [], args: [] };
  const r = await runLaboratory(cellsLab, { args: args(dir, ['--attempts', '5', '--external-research', 'external.json']), root: dir, llm, fetch: parentFetch([DOC]), delegate: launcher(dir, seen),
    external: { provider, transport: web } });
  const child = await seen.childDone[0];
  assert.ok(seen.args[0].includes('--documentary'));
  const requested = eventsOf(r.journal).find((e) => e.type === 'delegation_requested')!;
  assert.deepEqual(requested.access, { world: 'none', sources: true });
  assert.deepEqual(requested.sources.granted, { search_calls: 1, fetch_calls: 3, download_bytes: 50000 }, 'what it asked, within the branch bag and its requester\'s');
  /* The branch: no episode, no world, its prompt says so; its model refused; its end, a report. */
  const cev = eventsOf(child.journal);
  assert.equal(child.stoppedBy, 'task_completed');
  assert.ok(!cev.some((e) => e.type === 'exploration_episode' || e.type === 'check' || e.type === 'accepted'), 'no simulator, no check, no acceptance');
  assert.ok(seen.child[0].system.includes(DOCUMENTARY_SECTION));
  assert.match(cev.find((e) => e.type === 'proposal_refused')!.errors[0], /proposes no model/);
  const fin = cev.find((e) => e.type === 'task_finished')!;
  assert.equal(fin.state, 'partial');
  assert.ok(fs.existsSync(path.join(path.dirname(child.journal), 'blobs', fin.report.sha256)), 'its report kept by its content');
  assert.equal(JSON.parse(fs.readFileSync(child.journal, 'utf8')).config.external_research.config.budget.search_calls, 1, 'its own bags, the grant');
  assert.deepEqual(runResults(child.journal).o1_predictive_acceptance, { model: null, documentary: { ended: 'task_completed', report: 'partial' } }, 'a session with no model to propose, not a run without data');
  /* Its result reached the requester: the report itself, a contribution, and its exposure. */
  const delivered = eventsOf(r.journal).filter((e) => e.type === 'operator_message').flatMap((e) => e.messages).find((m: any) => m.research_result);
  assert.ok(delivered, 'delivered');
  assert.match(delivered.text, /edge cells copy their neighbour/);
  assert.equal(delivered.contribution.state, 'partial');
  assert.equal(delivered.external_exposure.direct, true);
  assert.ok((r.finding as any).external_exposure.via.includes('agent:delegation:r1.1'), 'the requester exposed through its branch');
});

test('IE3: without its requester\'s sources a documentary branch gets none; finish is an exchange, alone, and checked', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'documentary-'));
  const seen: Seen = { child: [], childDone: [], args: [] };
  await runLaboratory(cellsLab, { args: args(dir, ['--attempts', '3']), root: dir, llm, fetch: parentFetch([DOC]), delegate: launcher(dir, seen) });
  await seen.childDone[0];
  assert.ok(seen.args[0].includes('--documentary') && !seen.args[0].includes('--external-research'), 'nothing to inherit');
  assert.equal(classOf({ finish: {} }), 'exchange');
  assert.match(String(finishOf(JSON.stringify({ finish: { report: 'r' }, investigate: [{ view: 'ep1' }] }))), /alone/);
  assert.match(String(finishOf(JSON.stringify({ finish: { report: 'r', state: 'done' } }))), /complete, partial or no_result/);
  assert.equal(finishOf(JSON.stringify({ rationale: 'r' })), null);
  await assert.rejects(runLaboratory(cellsLab, { args: ['--seed', '1', '--documentary', '--out', path.join(dir, 'x.json')], root: dir, llm, fetch: parentFetch([]) }),
    (e) => e instanceof LabError && /documentary/.test(e.message));
});
