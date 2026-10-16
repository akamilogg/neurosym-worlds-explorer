import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { coverage, designProblems, expandDesign, mergeArgs } from '../src/orchestra/design.ts';
import { conditionComparisonProblems } from '../src/orchestra/references.ts';
import { batchText, runBatch } from '../src/orchestra/batch.ts';
import { LabError } from '../src/runtime/lab-runner.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';

/* SPEC-CONTROL-ARNES K3 (§4.3, §7): a batch designed from a template - the same seeds under every condition - that says what
   of §7 it leaves uncovered, and compares its conditions seed by seed as declared before it runs; what was not held the same
   between them, said. */

const senior = { id: 'senior', role: 'senior' as const };

test('a design: its runs, the same seeds in every condition, crossed with what is varied; refused if ill declared', () => {
  const runs = expandDesign({ lab: 'cells', args: ['--level', '1'], agent: senior },
    { seeds: [1, 2, 3], conditions: { with_senior: {}, alone: { agent: null } }, args: { '--family': ['2', '4'] } });
  assert.equal(runs.length, 12);
  assert.deepEqual(runs.filter((r) => r.condition === 'alone').map((r) => r.args!.slice(-4).join(' ')).sort(),
    ['--family 2 --seed 1', '--family 2 --seed 2', '--family 2 --seed 3', '--family 4 --seed 1', '--family 4 --seed 2', '--family 4 --seed 3']);
  assert.ok(runs.filter((r) => r.condition === 'alone').every((r) => !r.agent), 'null: no agent in that condition');
  assert.ok(runs.filter((r) => r.condition === 'with_senior').every((r) => r.agent?.role === 'senior'));
  assert.equal(new Set(runs.map((r) => r.id)).size, 12, 'each run its own id');
  assert.deepEqual(mergeArgs(['--attempts', '1', '--flat'], ['--attempts', '2']), ['--flat', '--attempts', '2'], 'the args of a condition replace those of the template');

  assert.match(designProblems({ runs: [{}], template: { lab: 'cells' }, vary: { seeds: [1], conditions: { a: {} } } }).join(), /either by its runs or by a template/);
  assert.match(designProblems({ template: { lab: 'cells', args: ['--seed', '1'] }, vary: { seeds: [1], conditions: { a: {} } } }).join(), /seeds are the variation's/);
  assert.match(designProblems({ template: { lab: 'nowhere' }, vary: { seeds: [], conditions: {} } }).join(), /lab.*seeds.*conditions/);
  assert.deepEqual(conditionComparisonProblems(['a', 'b'], [{ a: 'a', b: 'b', metric: 'o1', margin: 0.2 }]), []);
  assert.match(conditionComparisonProblems(['a', 'b'], [{ a: 'a', b: 'c', metric: 'o1', margin: 0.2 }]).join(), /two conditions of this batch/);
});

test('what a design covers of §7, and what it leaves uncovered - said', () => {
  const thin = coverage({ lab: 'cells' }, { seeds: [1], conditions: { a: {} } });
  assert.deepEqual(thin.covered, []);
  assert.ok(thin.uncovered.includes('seeds: at least 3 per group') && thin.uncovered.includes('with a senior and without') && thin.uncovered.includes('budgets'));
  assert.ok(!thin.uncovered.some((u) => /names/.test(u)), 'names only where the world has them');
  const wide = coverage({ lab: 'c302nav', agent: senior }, { seeds: [1, 2, 3],
    conditions: { opening: {}, no_opening: { agent: { ...senior, opening: false } }, alone: { agent: null } }, args: { '--names': ['real', 'neutral'], '--attempts': ['6', '12'], '--acts': ['2', '4'] } });
  assert.deepEqual(wide.uncovered, []);
});

test('a designed batch run: its conditions compared seed by seed as declared; one not held the same is said', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-'));
  /* Tokens that vary with what is asked: a message makes a question longer. */
  const answers: FetchLike = async (_url, init) => {
    const body = String(init.body);
    const user = JSON.parse(userOf(JSON.parse(body)));
    const content = 'task' in user ? { rationale: 'r', beliefs: [], lessons: ['l'], next_experiment: 'n' }
      : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]', validate: false, lessons: ['l'], next_experiment: 'n', beliefs: [] };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: Math.round(body.length / 50) } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
  const llm = { url: 'http://system2.test/v1/chat/completions', model: 's' };
  const template = { lab: 'cells', researcher: 'assisted' as const, args: ['--level', '1', '--attempts', '1', '--flat', '--no-grade', '--no-reflection', '--no-ablation'] };
  const report = await runBatch({ id: 'k3', template, vary: { seeds: [1, 2, 3], conditions: { plain: {}, nudged: { messages: [{ round: 1, text: 'Look closely at how each cell depends on its neighbours in the row before.' }] } } },
    compare_conditions: [{ a: 'plain', b: 'nudged', metric: 'tokens', margin: 0.05, relative: true }], runs: undefined as never }, { root, llm, fetch: answers });
  assert.equal(report.design?.runs, 6);
  assert.ok(report.design!.uncovered.includes('with a senior and without'));
  const c = report.results!.condition_comparisons![0] as Record<string, any>;
  assert.equal(c.comparison.pairs, 3, 'paired by seed');
  assert.ok(c.comparison.differences.every((d: any) => d.difference < 0), 'a longer question costs more: worse on tokens, seed by seed');
  assert.equal(c.not_controlled, undefined, 'the same version and budget');
  assert.match(batchText(report), /nudged against plain \[tokens\]/);
  assert.match(batchText(report), /leaves UNCOVERED/);

  /* Another budget in one condition: compared all the same, and said not controlled. */
  const other = await runBatch({ id: 'k3b', template, vary: { seeds: [1, 2, 3], conditions: { short: {}, long: { args: ['--attempts', '2'] } } },
    compare_conditions: [{ a: 'short', b: 'long', metric: 'o1', margin: 0.3 }], runs: undefined as never }, { root, llm, fetch: answers });
  assert.deepEqual((other.results!.condition_comparisons![0] as any).not_controlled, ['the budget']);

  await assert.rejects(runBatch({ id: 'k3c', template, vary: { seeds: [1], conditions: { a: {} } }, compare_conditions: [{ a: 'a', b: 'z', metric: 'o1', margin: 0.2 }], runs: undefined as never },
    { root, llm, fetch: answers }), (e) => e instanceof LabError && /two conditions of this batch/.test(e.message));
});
