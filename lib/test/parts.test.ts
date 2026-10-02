import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { gridLab } from '../src/worlds/grid/lab.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';

/* A provider's cache reuses whole earlier messages, never the common beginning of one that grew. So a round's question
   grows by messages: within a round, each request repeats the earlier ones exactly and only its last one changes. */

function recorder(bodies: { messages: { role: string; content: string }[] }[], answer: (user: any) => unknown): FetchLike {
  return async (_url, init) => {
    const b = JSON.parse(String(init.body));
    bodies.push(b);
    const sys = b.messages[0].content as string;
    const content = sys.startsWith('You grade') ? { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' } : answer(JSON.parse(userOf(b)));
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 10 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
}

function checkGrowth(bodies: { messages: { role: string; content: string }[] }[]): number {
  let sameRound = 0;
  for (let i = 1; i < bodies.length; i++) {
    const a = bodies[i - 1].messages, b = bodies[i].messages;
    if (a[0].content !== b[0].content || !a[1] || !b[1] || JSON.parse(a[1].content).round !== JSON.parse(b[1].content).round) continue;
    sameRound++;
    /* The earlier request, whole, is the beginning of this one: nothing rewritten, something added at the end. */
    assert.ok(b.length > a.length, 'request ' + (i + 1) + ' adds to the earlier one');
    for (let k = 0; k < a.length; k++) assert.equal(b[k].content, a[k].content, 'message ' + k + ' of request ' + (i + 1) + ' is the earlier one\'s');
  }
  return sameRound;
}

const GRID = ['--seed', '22', '--attempts', '2', '--explore', '2', '--variants', '1', '--family', '1', '--family-variants', '1', '--confirm-places', '1', '--levels', '2', '--depth', '1',
  '--flat', '--no-grade', '--no-reflection', '--no-ablation'];

test('the grid: within a round, each request repeats the earlier messages and adds the new step before a new last one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parts-'));
  const bodies: any[] = [];
  await runLaboratory(gridLab, { args: [...GRID, '--out', path.join(dir, 'run.json')], root: dir, llm: { url: 'http://x.test/chat', model: 'm' },
    fetch: recorder(bodies, (u) => ((u.investigation ?? []).length < 3 && u.round <= 2 ? { investigate: [{ view: 'g1', from: 0, to: 2 }] }
      : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p, m) => 0.5', validate: false, beliefs: [{ id: 'b', stance: u.round === 1 ? 'new' : 'keep', statement: 's' }], lessons: ['l'] })) });
  assert.ok(checkGrowth(bodies) >= 4);
  const second = bodies[1].messages;
  assert.ok(JSON.parse(second[1].content).notebook && JSON.parse(second.at(-1).content).investigation_step, 'the context first, each step added after it');
  assert.equal(JSON.parse(second.at(-1).content).steps_left, 2, 'the newest part says what is left');
});

test('a world of laws: the same', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parts-'));
  const bodies: any[] = [];
  await runLaboratory(cellsLab, { args: ['--seed', '1', '--level', '1', '--attempts', '2', '--flat', '--no-grade', '--no-reflection', '--out', path.join(dir, 'run.json')], root: dir,
    llm: { url: 'http://x.test/chat', model: 'm' },
    fetch: recorder(bodies, (u) => ((u.investigation ?? []).length < 2 ? { investigate: [{ view: 'ep1', from: 0, to: 3 }] }
      : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]', validate: false, beliefs: [{ id: 'b', stance: u.round === 1 ? 'new' : 'keep', statement: 's' }], lessons: ['l'] })) });
  assert.ok(checkGrowth(bodies) >= 2);
});

test('a round that ends without a proposal: the assisted researcher keeps its model and the run goes on; the unknown-world one stops', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parts-'));
  /* It proposes in round 1, then in round 2 only ever asks to investigate (no steps left); from round 3 it proposes again. */
  const answer = (u: any) => (u.round === 2 ? { investigate: [{ view: 'g1', from: 0, to: 2 }] }
    : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p, m) => 0.5', validate: false, beliefs: [{ id: 'b', stance: u.round === 1 ? 'new' : 'keep', statement: 's' }], lessons: ['l'] });
  const args = ['--seed', '22', '--attempts', '3', '--explore', '1', '--variants', '1', '--family', '1', '--family-variants', '1', '--confirm-places', '1', '--levels', '2', '--depth', '1',
    '--steps', '1', '--flat', '--no-grade', '--no-reflection', '--no-ablation'];
  const helped = await runLaboratory(gridLab, { args: [...args, '--researcher', 'assisted', '--out', path.join(dir, 'a.json')], root: dir, llm: { url: 'http://x.test/chat', model: 'm' }, fetch: recorder([], answer) });
  const events = JSON.parse(fs.readFileSync(helped.journal, 'utf8')).events as { type: string; round?: number }[];
  assert.ok(events.some((e) => e.type === 'kept_model'), 'kept its model');
  assert.ok(events.filter((e) => e.type === 'check').length >= 3, 'and the run went on');
  assert.notEqual(helped.stoppedBy, 'no_hypothesis');
  const pure = await runLaboratory(gridLab, { args: [...args, '--out', path.join(dir, 'p.json')], root: dir, llm: { url: 'http://x.test/chat', model: 'm' }, fetch: recorder([], answer) });
  assert.equal(pure.stoppedBy, 'no_hypothesis', 'the unknown-world researcher as it always was');
});
