import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { batchResults, runBatch, type BatchReport } from '../src/orchestra/batch.ts';
import { compareConditions, freezeReference, referenceFile } from '../src/orchestra/references.ts';
import { LabError } from '../src/runtime/lab-runner.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';

/* An external review of K2-K4 (19/10/2026), reconciled: pairing that tells apart what a design varies (the order of the runs
   never decides a conclusion); a batch resumed keeps its runs, and what is declared after it began is said so; a budget
   known from the limits recorded, never assumed equal; a reference superseded only by a comparison made. */

const answers: FetchLike = async (_url, init) => {
  const body = String(init.body);
  const user = JSON.parse(userOf(JSON.parse(body)));
  const content = 'task' in user ? { rationale: 'r', beliefs: [], lessons: ['l'], next_experiment: 'n' }
    : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]', validate: false, lessons: ['l'], next_experiment: 'n', beliefs: [] };
  const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: Math.round(body.length / 50) } });
  return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
};
const llm = { url: 'http://system2.test/v1/chat/completions', model: 's' };
const template = (level = '1') => ({ lab: 'cells', researcher: 'assisted' as const, args: ['--level', level, '--flat', '--no-grade', '--no-reflection', '--no-ablation'] });
const nudge = { messages: [{ round: 1, text: 'Look closely at how each cell depends on its neighbours in the row before.' }] };

test('pairing tells apart what a design varies, and the order of the runs never decides the conclusion', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pairing-'));
  const report = await runBatch({ id: 'p', template: template(), vary: { seeds: [1, 2, 3], conditions: { plain: {}, nudged: nudge }, args: { '--attempts': ['1', '2'] } },
    compare_conditions: [{ a: 'plain', b: 'nudged', metric: 'tokens', margin: 0.05, relative: true }], runs: undefined as never }, { root, llm, fetch: answers });
  assert.equal(report.runs.length, 12);
  const c = report.results!.condition_comparisons![0] as Record<string, any>;
  assert.equal(c.comparison.pairs, 6, 'each seed at each number of attempts its own pair');
  const reversed = { ...report, runs: [...report.runs].reverse() } as BatchReport;
  assert.deepEqual((batchResults(reversed, root).condition_comparisons![0] as any).comparison, c.comparison, 'the same, whatever the order');
  /* The same runs, without the design that tells them apart: refused, not paired one over another. */
  const flat = { ...report, definition: { ...report.definition, vary: undefined } } as unknown as Record<string, any>;
  assert.match(String(compareConditions(flat, { a: 'plain', b: 'nudged', metric: 'tokens', margin: 0.05 }).refused), /not told apart/);
});

test('a batch resumed keeps its runs; what is declared after it began is said not preregistered', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-design-'));
  const def = { id: 'r', template: template('1'), vary: { seeds: [1, 2, 3], conditions: { plain: {} } }, runs: undefined as never };
  await runBatch(def, { root, llm, fetch: answers });
  await assert.rejects(runBatch({ ...def, template: template('2') }, { root, llm, fetch: answers }), (e) => e instanceof LabError && /began with other runs/.test(e.message));
  const later = await runBatch({ ...def, criteria: { anticipate: { require: ['model_accepted'] } } }, { root, llm, fetch: answers });
  assert.deepEqual(later.preregistered!.criteria, {}, 'what it began with');
  assert.equal(later.definition_history!.length, 2);
  assert.match(String((later.results!.groups[0].o3_adequacy as Record<string, any>).anticipate.declared), /after it began: not preregistered/);
});

test('a budget known from the limits each run recorded; one not recorded is never taken as the same', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'limits-'));
  const report = await runBatch({ id: 'l', template: template(), vary: { seeds: [1, 2, 3], conditions: { small: { args: ['--max-tokens', '10000'] }, large: { args: ['--max-tokens', '20000'] } } },
    compare_conditions: [{ a: 'small', b: 'large', metric: 'o1', margin: 0.3 }], runs: undefined as never }, { root, llm, fetch: answers });
  const journal = JSON.parse(fs.readFileSync(report.runs[0].journal!, 'utf8'));
  assert.deepEqual(journal.limits, { max_tokens: 10000, max_minutes: null });
  assert.deepEqual((report.results!.condition_comparisons![0] as any).not_controlled, ['the budget']);
  /* A journal from before the limits were recorded: not known to be the same. */
  const old = report.runs.find((r) => r.condition === 'large')!.journal!;
  const j = JSON.parse(fs.readFileSync(old, 'utf8'));
  delete j.limits;
  fs.writeFileSync(old, JSON.stringify(j));
  const same = { ...report, definition: { ...report.definition, runs: report.definition.runs.map((r) => ({ ...r, args: (r.args ?? []).filter((a, i, all) => a !== '--max-tokens' && all[i - 1] !== '--max-tokens') })) } } as BatchReport;
  assert.deepEqual((batchResults(same, root).condition_comparisons![0] as any).not_controlled, ['the budget (not recorded for some runs)']);
});

test('a reference is superseded only by a comparison made, with a reference that holds', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supersede-'));
  const first = await runBatch({ id: 'old', template: template(), vary: { seeds: [1, 2, 3], conditions: { c: {} } }, runs: undefined as never }, { root, llm, fetch: answers });
  freezeReference(root, path.join(first.dir, 'batch.json'), { condition: 'c', name: 'base', by: 'Ana' });
  /* Compared against a condition it does not have: the comparison is refused - and cannot supersede. */
  const second = await runBatch({ id: 'new', template: template(), vary: { seeds: [1, 2, 3], conditions: { c: nudge } },
    compare: [{ reference: 'base', condition: 'c', metric: 'tokens', margin: 0.05, relative: true }], runs: undefined as never }, { root, llm, fetch: answers });
  const file = path.join(second.dir, 'batch.json');
  const refused = { ...second, results: { ...second.results!, comparisons: [{ reference: 'base', condition: 'c', metric: 'tokens', refused: 'the reference does not hold' }] } };
  fs.writeFileSync(file, JSON.stringify(refused));
  assert.throws(() => freezeReference(root, file, { condition: 'c', name: 'next', by: 'Ana', supersedes: 'base' }), /a comparison declared, made, and with paired runs/);
  fs.writeFileSync(file, JSON.stringify(second));
  /* The old reference no longer holds: nothing compared with it stands. */
  const run = JSON.parse(fs.readFileSync(referenceFile(root, 'base'), 'utf8')).runs[0].journal;
  fs.appendFileSync(path.resolve(root, run), ' ');
  assert.throws(() => freezeReference(root, file, { condition: 'c', name: 'next', by: 'Ana', supersedes: 'base' }), /does not hold/);
});
