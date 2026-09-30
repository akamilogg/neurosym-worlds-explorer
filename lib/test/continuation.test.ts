import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LabError, runLaboratory } from '../src/runtime/lab-runner.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';
import type { FetchLike } from '../src/core/net.ts';

/* A CONTINUATION: a run that used up its rounds is given more (--resume <journal> --attempts N). Its history is replayed as
   it was - its ending too: the reflection and the grading it ended with - and then it goes on, live. */

/** System 2 standing in: never asks to validate (so a run ends by using up its rounds); reflects; grades. */
function system2(asked: Record<string, any>[] = []): FetchLike {
  return async (_url, init) => {
    const b = JSON.parse(String(init.body));
    const sys = b.messages[0].content as string, raw = b.messages[b.messages.length - 1].content as string;
    const user = sys.startsWith('You grade') ? {} : JSON.parse(raw);
    asked.push({ grade: sys.startsWith('You grade'), ...user });
    const content = sys.startsWith('You grade') ? { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' }
      : 'task' in user ? { rationale: 'r', beliefs: [{ id: 'b', stance: 'keep', why: 'w' }], lessons: ['looked back at round ' + user.round], next_experiment: 'n' }
      : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]', validate: false, beliefs: [{ id: 'b', stance: user.round === 1 ? 'new' : 'keep', statement: 's', evidence: [] }], lessons: ['l'] };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
}
const ARGS = ['--seed', '1', '--level', '1', '--flat', '--tools', 'none'];
const llm = { url: 'http://system2.test/chat', model: 'stand-in' };
const eventsOf = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8')).events as Record<string, any>[];
const strip = (es: Record<string, any>[]) => es.filter((e) => !['start', 'end'].includes(e.type)).map(({ t: _t, ...e }) => JSON.stringify(e));

test('a run that used up its rounds, given more: its history as it was (ending included), then new rounds; and again', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cont-'));
  const first = await runLaboratory(cellsLab, { args: [...ARGS, '--attempts', '2', '--out', path.join(dir, 'first.json')], root: dir, llm, fetch: system2() });
  assert.equal(first.stoppedBy, 'budget');
  const asked: Record<string, any>[] = [];
  const more = await runLaboratory(cellsLab, { args: ['--resume', first.journal, '--attempts', '4', '--out', path.join(dir, 'more.json')], root: dir, llm, fetch: system2(asked) });
  assert.equal(more.stoppedBy, 'budget');
  const before = eventsOf(first.journal), after = eventsOf(more.journal);
  /* The first run's history, word for word, is the start of the continued one: its rounds, its reflection, its grading. */
  assert.deepEqual(strip(after).slice(0, strip(before).length), strip(before));
  const extended = after.find((e) => e.type === 'budget_extended')!;
  assert.deepEqual([extended.after_attempts, extended.to_attempts], [2, 4]);
  assert.deepEqual(after.filter((e) => e.type === 'proposal').map((e) => e.round), [1, 2, 4, 5], 'two rounds more, after the reflection of round 3');
  assert.deepEqual(after.filter((e) => e.type === 'reflection').map((e) => e.round), [3, 6]);
  assert.equal(after.filter((e) => e.type === 'operator_rule_recovery').length, 2, 'graded where the first run ended, and at the new end');
  /* Only the new rounds were asked: everything before came from the log. */
  assert.ok(asked.every((q) => q.grade || q.round >= 4), 'nothing of the first run asked again');
  const journal = JSON.parse(fs.readFileSync(more.journal, 'utf8'));
  assert.deepEqual([journal.continuations, journal.config.attempts], [[2], 4]);
  /* A continuation can be continued: each ending is replayed where it was. */
  const again = await runLaboratory(cellsLab, { args: ['--resume', more.journal, '--attempts', '5', '--out', path.join(dir, 'again.json')], root: dir, llm, fetch: system2() });
  assert.equal(again.stoppedBy, 'budget');
  assert.deepEqual(strip(eventsOf(again.journal)).slice(0, strip(after).length), strip(after));
  assert.deepEqual(JSON.parse(fs.readFileSync(again.journal, 'utf8')).continuations, [2, 4]);
});

test('only a run that used up its rounds is given more, and more than it had', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cont-'));
  const first = await runLaboratory(cellsLab, { args: [...ARGS, '--attempts', '2', '--out', path.join(dir, 'first.json')], root: dir, llm, fetch: system2() });
  await assert.rejects(runLaboratory(cellsLab, { args: ['--resume', first.journal, '--attempts', '2'], root: dir, llm, fetch: system2() }), (e) => e instanceof LabError && /more than the 2 rounds/.test(e.message));
  const cut = await runLaboratory(cellsLab, { args: [...ARGS, '--attempts', '2', '--max-tokens', '150', '--out', path.join(dir, 'cut.json')], root: dir, llm, fetch: system2() });
  assert.equal(cut.stoppedBy, 'token_budget');
  await assert.rejects(runLaboratory(cellsLab, { args: ['--resume', cut.journal, '--attempts', '4'], root: dir, llm, fetch: system2() }), (e) => e instanceof LabError && /token_budget/.test(e.message));
});
