import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runBatch, type BatchDefinition } from '../src/orchestra/batch.ts';
import type { FetchLike } from '../src/core/net.ts';
import { heardOf, userOf } from './support.ts';

/* A message of the operator scheduled in advance: held until its round begins, then delivered with its first question - a
   nudge at a round chosen beforehand, declared in a batch. Help like any other message. */

test('a batch schedules a message for a round: it waits in the run\'s inbox and reaches the researcher with the first question of that round, not before', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-'));
  const asked: Record<string, any>[] = [];
  const system2: FetchLike = async (_url, init) => {
    const b = JSON.parse(String(init.body));
    const sys = b.messages[0].content as string;
    const user = sys.startsWith('You grade') ? {} : JSON.parse(userOf(b));
    if (!sys.startsWith('You grade')) asked.push(user);
    const content = sys.startsWith('You grade') ? { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' }
      : 'task' in user ? { rationale: 'r', beliefs: [{ id: 'same', stance: 'keep', why: 'w' }], lessons: ['l'], next_experiment: 'n' }
      : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]', validate: false,
        beliefs: [{ id: 'same', stance: user.round === 1 ? 'new' : 'keep', statement: 'the row repeats', evidence: [] }], lessons: ['l'], next_experiment: 'n' };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
  const def: BatchDefinition = { id: 'nudge', concurrency: 1, runs: [{ id: 'cells', lab: 'cells', condition: 'nudged at round 3', researcher: 'assisted',
    args: ['--seed', '1', '--level', '1', '--attempts', '4', '--flat', '--no-grade', '--no-reflection', '--tools', 'none'],
    messages: [{ round: 3, text: 'There is a verified model simpler than yours: look for it.' }] }] };
  const report = await runBatch(def, { root, llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch: system2 });
  const heardAt = asked.map((u) => [u.round, heardOf(u).some((m) => /verified model/.test(m.text))]);
  assert.deepEqual(heardAt.filter(([, h]) => h).map(([r]) => r)[0], 3, 'first heard in round 3: ' + JSON.stringify(heardAt));
  assert.ok(heardAt.filter(([r]) => (r as number) < 3).every(([, h]) => !h), 'not before');
  const journal = JSON.parse(fs.readFileSync(report.runs[0].journal!, 'utf8'));
  const delivered = journal.events.filter((e: any) => e.type === 'operator_message');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].messages[0].round, 3);
  assert.equal(report.runs[0].help, 1, 'help, like any other message');
});
