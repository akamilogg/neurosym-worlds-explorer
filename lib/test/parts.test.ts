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

test('it consolidates its round: the context afresh, its own summary with the steps it keeps; then the conversation grows again', async () => {
  for (const world of ['grid', 'cells'] as const) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parts-'));
    const bodies: any[] = [];
    const view = world === 'grid' ? { view: 'g1', from: 0, to: 2 } : { view: 'ep1', from: 0, to: 3 };
    const propose = world === 'grid' ? { observations: {}, rules: {}, weights: {}, output: '(p, m) => 0.5' } : { observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]' };
    let consolidated = false;
    const answer = (u: any) => {
      if (u.round !== 1) return { rationale: 'r', ...propose, validate: false, beliefs: [{ id: 'b', stance: 'keep', statement: 's' }], lessons: ['l'] };
      if (!consolidated && (u.investigation ?? []).length < 2) return { investigate: [view], notes: (u.investigation ?? []).length === 1 ? [{ do: 'write', id: 'seen', text: 'two views seen' }] : [] };
      if (!consolidated) { consolidated = true; return { consolidate: { summary: 'the second view is what matters', keep: [2, 9] } }; }
      return { rationale: 'r', ...propose, validate: false, beliefs: [{ id: 'b', stance: 'new', statement: 's' }], lessons: ['l'] };
    };
    const args = world === 'grid' ? [...GRID.filter((x, i, a) => !(x === '2' && a[i - 1] === '--attempts')), '--attempts', '1', '--out', path.join(dir, 'run.json')]
      : ['--seed', '1', '--level', '1', '--attempts', '1', '--flat', '--no-grade', '--no-reflection', '--out', path.join(dir, 'run.json')];
    const r = await runLaboratory(world === 'grid' ? gridLab : cellsLab, { args, root: dir, llm: { url: 'http://x.test/chat', model: 'm' }, fetch: recorder(bodies, answer) });
    const at = bodies.findIndex((b) => b.messages.some((m: { content: string }) => m.content.includes('"consolidated"')));
    assert.ok(at > 0, world + ': consolidated');
    const after = bodies[at].messages;
    assert.equal(after.length, 3, world + ': system, the context afresh, the summary');
    assert.match(after[1].content, /two views seen/, world + ': the notebook as it is now, its note in it');
    const part = JSON.parse(after[2].content).consolidated;
    assert.equal(part.summary, 'the second view is what matters');
    assert.deepEqual(part.kept_steps.map((s: { step: number }) => s.step), [2], world + ': the steps it kept (a step it never had is not)');
    const events = JSON.parse(fs.readFileSync(r.journal, 'utf8')).events as Record<string, any>[];
    const e = events.find((x) => x.type === 'consolidated')!;
    assert.deepEqual([e.kept, e.dropped], [[2], 1], world + ': logged');
  }
});

test('a grid run that used up its rounds is continued: its history replayed with its ending, then the rounds it is given', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parts-'));
  const answer = (u: any) => ('task' in u ? { rationale: 'r', beliefs: [{ id: 'b', stance: 'keep', why: 'w' }], lessons: ['l'], next_experiment: 'n' }
    : (u.investigation ?? []).length < 1 ? { investigate: [{ view: 'g1', from: 0, to: 2 }] }
    : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p, m) => 0.5', validate: false, beliefs: [{ id: 'b', stance: u.round === 1 ? 'new' : 'keep', statement: 's' }], lessons: ['l'] });
  const args = ['--seed', '22', '--attempts', '2', '--explore', '1', '--variants', '1', '--family', '1', '--family-variants', '1', '--confirm-places', '1', '--levels', '2', '--depth', '1',
    '--steps', '1', '--flat', '--no-grade', '--no-ablation', '--researcher', 'assisted', '--out', path.join(dir, 'run.json')];
  const llm = { url: 'http://x.test/chat', model: 'm' };
  const first = await runLaboratory(gridLab, { args, root: dir, llm, fetch: recorder([], answer) });
  assert.equal(first.stoppedBy, 'budget');
  const asked: any[] = [];
  const more = await runLaboratory(gridLab, { args: ['--resume', first.journal, '--attempts', '3', '--out', path.join(dir, 'more.json')], root: dir, llm, fetch: recorder(asked, answer) });
  assert.equal(more.stoppedBy, 'budget', 'it did not diverge');
  const j = JSON.parse(fs.readFileSync(more.journal, 'utf8'));
  const types = j.events.map((e: { type: string }) => e.type);
  assert.deepEqual(j.continuations, [2]);
  assert.ok(types.indexOf('budget_extended') > types.indexOf('reflection'), 'its ending, as it was, then more rounds');
  assert.equal(j.events.filter((e: { type: string }) => e.type === 'check').length, 3, 'a third check');
  assert.equal(j.events.filter((e: { type: string }) => e.type === 'reflection').length, 2, 'the old ending and the new one');
  const end = j.events.find((e: { type: string }) => e.type === 'end');
  assert.equal(end.replay.unused, 0, 'every logged answer was asked for again');
  assert.ok(asked.length > 0, 'and then it asked live');
});
