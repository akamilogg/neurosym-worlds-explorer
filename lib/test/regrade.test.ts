import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { regrade } from '../src/runtime/regrade.ts';
import { gridLab, GRID_GRADING_SYSTEM } from '../src/worlds/grid/lab.ts';
import type { ChatClient } from '../src/learn/system2.ts';
import type { FetchLike } from '../src/core/net.ts';

/* Grading a finished run again, with another model: the run's grader, the run's learner, the run's truth. */

const fetch: FetchLike = async (_url, init) => {
  const b = JSON.parse(String(init.body));
  const sys = b.messages[0].content as string;
  const user = sys.startsWith('You grade') ? {} : JSON.parse(b.messages[b.messages.length - 1].content as string);
  /* The run's own grader fails, as a small local model did (HTTP 400). */
  if (sys.startsWith('You grade')) return { ok: false, status: 400, text: async () => 'Bad Request', headers: { get: () => null } };
  const content = { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p, m) => 0.5', validate: false,
    beliefs: [{ id: 'edge', stance: user.round === 1 ? 'new' : 'keep', statement: 'the other wins when = reaches column 4' }], lessons: ['l'] };
  const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
  return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
};
const GRID = ['--seed', '22', '--attempts', '1', '--explore', '1', '--variants', '1', '--family', '1', '--family-variants', '1', '--confirm-places', '1', '--levels', '2', '--depth', '1',
  '--steps', '0', '--flat', '--no-reflection', '--no-ablation'];

test('a run whose grading failed is graded again by another model: appended, marked, and the findings report it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regrade-'));
  const r = await runLaboratory(gridLab, { args: [...GRID, '--out', path.join(dir, 'run.json')], root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch });
  assert.equal(r.finding.operator?.rule_recovery, undefined, 'its own grading failed');
  const asked: { system: string; user: any }[] = [];
  const grader: ChatClient = { complete: async (q) => {
    asked.push({ system: q.system, user: JSON.parse(String(q.user)) });
    return { content: JSON.stringify({ grades: [{ id: 'win_other', grade: 'exact', evidence: 'column 4' }, { id: 'draw', grade: 'absent' }], false_beliefs: [], form: 'compact', form_evidence: 'e' }), latencyMs: 0, raw: null };
  } };
  const out = await regrade(r.journal, grader, 'senior-model');
  assert.equal(asked[0].system, GRID_GRADING_SYSTEM, 'the run\'s own grader');
  assert.equal(asked[0].user.learner.beliefs[0].statement, 'the other wins when = reaches column 4', 'the learner as the run left it');
  assert.deepEqual(asked[0].user.picture_glyphs, { learner: '&', other: '=' });
  assert.equal(out.score, Math.round(1 / asked[0].user.true_rules.length * 100) / 100);
  const journal = JSON.parse(fs.readFileSync(r.journal, 'utf8'));
  const last = journal.events.at(-1);
  assert.equal(last.type, 'operator_rule_recovery');
  assert.equal(last.grader_model, 'senior-model');
  assert.ok(last.regraded);
  assert.equal(JSON.parse(fs.readFileSync(r.journal.replace(/\.json$/, '.finding.json'), 'utf8')).operator.rule_recovery.score, out.score, 'the findings report it');
  assert.equal(JSON.parse(fs.readFileSync(r.journal.replace(/\.json$/, '.finding.researcher.json'), 'utf8')).operator, undefined, 'never in the researcher\'s view');
});

test('a run that has not ended is not graded', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regrade-'));
  const file = path.join(dir, 'open.json');
  fs.writeFileSync(file, JSON.stringify({ experiment: 'unknown-world@1', events: [{ type: 'start' }] }));
  await assert.rejects(regrade(file, { complete: async () => ({ content: '{}', latencyMs: 0, raw: null }) }, 'm'), /has not ended/);
});
