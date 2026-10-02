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
    /* Everything but the last message of the earlier request is repeated, word for word; then come new steps and a new last. */
    for (let k = 0; k < a.length - 1; k++) assert.equal(b[k].content, a[k].content, 'message ' + k + ' of request ' + (i + 1) + ' is the earlier one\'s');
    assert.ok(b.length > a.length, 'the round grows by messages');
    assert.ok(JSON.parse(b[b.length - 2].content).investigation_step, 'the new step is a message of its own');
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
  const last = JSON.parse(bodies[1].messages.at(-1).content);
  assert.ok('steps_left' in last && !('notebook' in last), 'what changes goes last; the context goes first');
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
