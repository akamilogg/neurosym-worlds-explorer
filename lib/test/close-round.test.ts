import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';
import { artifactsLab } from '../src/worlds/artifacts/lab.ts';
import { closeOf } from '../src/learn/law-session.ts';
import { researcherEvents } from '../src/orchestra/view.ts';
import { processTraces } from '../src/orchestra/traces.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';

/* PLAN-Y-SI, Entrega 1: the assisted researcher may close a round without a new model - told apart from "no proposal"; its
   latest model kept, not checked again; the tests it registered that round run once and come back with the next round;
   the round counts; nothing of any model's counterexamples closed. */

const MODEL = { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]', validate: false, lessons: ['l'], next_experiment: 'n', beliefs: [] };
const reply = (content: unknown) => { const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } }); return { ok: true, status: 200, text: async () => text, headers: { get: () => null } }; };

/** A run of cells whose researcher answers, round by round, as `plan` says ('close', 'model', or an object). */
async function cells(dir: string, plan: Record<number, unknown>, extra: string[] = []): Promise<{ journal: string; asked: Record<string, any>[]; systems: string[] }> {
  const asked: Record<string, any>[] = [], systems: string[] = [];
  const fetch: FetchLike = async (_url, init) => {
    const b = JSON.parse(String(init.body));
    systems.push(b.messages[0].content);
    const user = JSON.parse(userOf(b));
    asked.push(user);
    if ('task' in user) return reply({ rationale: 'r', beliefs: [], lessons: ['l'], next_experiment: 'n' });
    const p = plan[user.round] ?? 'model';
    return reply(p === 'close' ? { close_round: { why: 'round ' + user.round + ' showed me nothing new to model' } } : p === 'model' ? MODEL : p);
  };
  const r = await runLaboratory(cellsLab, { args: ['--seed', '1', '--level', '1', '--researcher', 'assisted', '--flat', '--no-grade', '--no-reflection', '--no-ablation', ...extra, '--out', path.join(dir, 'run.json')],
    root: dir, llm: { url: 'http://x.test/c', model: 's' }, fetch });
  return { journal: r.journal, asked, systems };
}
const eventsOf = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8')).events as Record<string, any>[];

test('a closing as written: alone, and saying why', () => {
  assert.equal(closeOf('{"rationale": "r"}'), null);
  assert.deepEqual(closeOf('{"close_round": {"why": "nothing new"}}'), { why: 'nothing new' });
  assert.match(String(closeOf('{"close_round": {}}')), /says why/);
  assert.match(String(closeOf('{"close_round": {"why": "x"}, "observations": {}, "output": "(p) => 1"}')), /alone/);
});

test('the first round closed without a model: told apart from no proposal, said at the next round, the round counted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'close-first-'));
  const { journal, asked, systems } = await cells(dir, { 1: 'close', 2: 'model' }, ['--attempts', '2']);
  const events = eventsOf(journal);
  assert.deepEqual(events.filter((e) => ['round_closed', 'proposal', 'no_proposal'].includes(e.type)).map((e) => [e.type, e.round]), [['round_closed', 1], ['proposal', 2]]);
  assert.ok(systems[0].includes('CLOSING A ROUND'), 'in its system from its first question');
  const second = asked.find((u) => u.round === 2)!;
  assert.deepEqual(second.you_closed_round, { round: 1, why: 'round 1 showed me nothing new to model' });
  assert.equal(events.find((e) => e.type === 'end')?.stoppedBy, 'budget', 'two rounds: the closed one counted');
  assert.ok(researcherEvents(JSON.parse(fs.readFileSync(journal, 'utf8'))).some((e) => e.type === 'round_closed'), 'the senior sees it');
  assert.equal(processTraces(journal).rounds_closed, 1);
});

test('closed after a proposal: its latest model kept, not checked again; every round closed, the run ends with its rounds', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'close-after-'));
  const { journal, asked } = await cells(dir, { 1: 'model', 2: 'close', 3: 'model' }, ['--attempts', '3']);
  const third = asked.find((u) => u.round === 3)!;
  assert.equal(third.your_model?.from_round, 1, 'the model of round 1 is still its latest');
  assert.equal(third.you_closed_round.round, 2);
  assert.deepEqual(eventsOf(journal).filter((e) => e.type === 'check').map((e) => e.round), [1, 3], 'no check for the closed round');

  const all = fs.mkdtempSync(path.join(os.tmpdir(), 'close-all-'));
  const closedAll = await cells(all, { 1: 'close', 2: 'close' }, ['--attempts', '2']);
  const end = eventsOf(closedAll.journal).find((e) => e.type === 'end')!;
  assert.equal(end.stoppedBy, 'budget');
  assert.equal(end.final, null);
});

test('the unknown-world researcher is left as it was: no closing in its prompt, a closing of it refused as a proposal', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'close-pure-'));
  const asked: string[] = [];
  const fetch: FetchLike = async (_url, init) => { const b = JSON.parse(String(init.body)); asked.push(b.messages[0].content); return reply({ close_round: { why: 'x' } }); };
  const r = await runLaboratory(cellsLab, { args: ['--seed', '1', '--level', '1', '--attempts', '1', '--flat', '--no-grade', '--no-reflection', '--no-ablation', '--out', path.join(dir, 'run.json')],
    root: dir, llm: { url: 'http://x.test/c', model: 's' }, fetch });
  assert.ok(!asked.some((s) => s.includes('CLOSING A ROUND')));
  const events = eventsOf(r.journal);
  assert.ok(!events.some((e) => e.type === 'round_closed'));
  assert.ok(events.some((e) => e.type === 'no_proposal'));
});

const QUADRATIC = ['def main():', '    lines = open("input.txt", encoding="utf-8").read().split("\\n")', '    n = int(lines[0])', '    a = sorted(int(x) for x in lines[1].split()[:n])',
  '    answer = "no"', '    for i in range(n - 2):', '        lo, hi = i + 1, n - 1', '        while lo < hi:', '            s = a[i] + a[lo] + a[hi]', '            if s == 0:',
  '                answer = "yes"', '                break', '            if s < 0:', '                lo += 1', '            else:', '                hi -= 1', '        if answer == "yes":',
  '            break', '    open("out.txt", "w", encoding="utf-8").write(answer + "\\n")', 'main()', ''].join('\n');

test('a test of its own registered in a closed round runs once, its result with the next round', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'close-tests-'));
  let made = '';
  const asked: Record<string, any>[] = [];
  const fetch: FetchLike = async (_url, init) => {
    const user = JSON.parse(userOf(JSON.parse(String(init.body))));
    asked.push(user);
    for (const i of user.investigation ?? []) for (const x of i.results ?? []) if (x.accepted && typeof x.version === 'string' && !('runs' in x)) made = x.version;
    const done = (user.investigation ?? []).length;
    const base = (user.notebook?.episodes ?? []).find((e: any) => e.version)?.version;
    if ('task' in user) return reply({ rationale: 'r', beliefs: [], lessons: ['l'], next_experiment: 'n' });
    if (user.round === 1 && done === 0) return reply({ investigate: [{ act: { change: { from: base, files: { 'main.py': QUADRATIC }, why: 'w', expect: 'e' } } }] });
    if (user.round === 1) return reply({ ...MODEL, output: '(p) => 100' });
    if (user.round === 2 && done === 0) return reply({ investigate: [{ register_test: { protocol: { run: { version: made, workloads: 1 } }, model: 1, rival: { observations: {}, rules: {}, weights: {}, output: '(p) => 101' }, claim: 'about 100 ms', kind: 'replicate' } }] });
    if (user.round === 2) return reply({ close_round: { why: 'I registered a test; its result decides my next model' } });
    return reply({ ...MODEL, output: '(p) => 100' });
  };
  const r = await runLaboratory(artifactsLab, { args: ['--artifact', 'threesum', '--scale', '0.2', '--seed', '1', '--researcher', 'assisted', '--attempts', '3', '--flat', '--no-grade', '--no-reflection', '--no-ablation', '--out', path.join(dir, 'run.json')],
    root: dir, llm: { url: 'http://x.test/c', model: 's' }, fetch });
  const events = eventsOf(r.journal);
  assert.ok(events.some((e) => e.type === 'round_closed' && e.round === 2));
  assert.equal(events.filter((e) => e.type === 'test_result').length, 1, 'run once');
  const third = asked.find((u) => u.round === 3)!;
  assert.equal(third.last_check?.your_tests?.[0]?.claim, 'about 100 ms', 'its result with the next round: ' + JSON.stringify(third.last_check));
});
