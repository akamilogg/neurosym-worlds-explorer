import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';
import { describe, rate } from '../src/runtime/statistics.ts';
import { criteriaProblems, runResults } from '../src/orchestra/results.ts';
import { batchResults, batchText, type BatchReport } from '../src/orchestra/batch.ts';
import { labCli } from '../src/runtime/cli.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';

/* SPEC-CONTROL-ARNES K1 (§4.1, §4.2, §6.1, §6.2), SPEC-RIESGO-MODELOS M2: results apart (O1-O4), every part of the cost (an
   unknown one never zero), by group of comparable runs, each with its uncertainty - and no label of control. */

test('descriptive statistics: a bootstrap interval of the median, or "insufficient evidence" where it would feign certainty', () => {
  assert.deepEqual(describe([]), { n: 0, evidence: 'none' });
  assert.equal((describe([3, 5]) as any).evidence, 'insufficient evidence', 'fewer than 3');
  assert.deepEqual((describe([4, 4, 4, 4]) as any).values, [4, 4, 4, 4], 'all equal: the values, not an interval of width zero');
  const d = describe([1, 2, 3, 4, 100]) as any;
  assert.equal(d.median, 3);
  assert.ok(d.median_interval95[0] <= 3 && d.median_interval95[1] >= 3);
  assert.deepEqual(describe([1, 2, 3, 4, 100]), d, 'seeded: computed again, the same');
  assert.deepEqual(describe([null, undefined, 2, 2]), { n: 2, values: [2, 2], median: 2, evidence: 'insufficient evidence' }, 'unknown values left out');
  assert.equal(rate(1, 4).n, 4, 'a proportion says its denominator');
});

test('criteria of adequacy are declared well, or the batch does not start', () => {
  assert.deepEqual(criteriaProblems(undefined), []);
  assert.deepEqual(criteriaProblems({ anticipate: { require: ['model_accepted'] }, design: { require: ['model_accepted', { severe_tests_at_least: 1 }] } }), []);
  assert.equal(criteriaProblems({ x: { require: [] } }).length, 1);
  assert.match(criteriaProblems({ x: { require: ['correct'] } })[0], /not a condition/);
});

async function aRun(dir: string, name: string, model: string, seed: number): Promise<string> {
  const answers: FetchLike = async (_url, init) => {
    const user = JSON.parse(userOf(JSON.parse(String(init.body))));
    const content = 'task' in user ? { rationale: 'r', beliefs: [], lessons: ['l'], next_experiment: 'n' }
      : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]', validate: false, lessons: ['l'], next_experiment: 'n', beliefs: [] };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
  return (await runLaboratory(cellsLab, { args: ['--seed', String(seed), '--level', '1', '--researcher', 'assisted', '--attempts', '1', '--flat', '--no-grade', '--no-reflection', '--no-ablation', '--out', path.join(dir, name + '.json')],
    root: dir, llm: { url: 'http://system2.test/v1/chat/completions', model }, fetch: answers })).journal;
}

test('a batch\'s results: apart, by group of comparable runs, with their uncertainty, criteria and cost - the unknown said', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'results-'));
  const a1 = await aRun(root, 'a1', 'model-a', 1), a2 = await aRun(root, 'a2', 'model-a', 2), a3 = await aRun(root, 'a3', 'model-a', 3), b1 = await aRun(root, 'b1', 'model-b', 1);
  /* One run had a senior, whose provider reported its price. */
  fs.writeFileSync(a2.replace(/\.json$/, '.agent-senior.json'), JSON.stringify({ format: 'agent@1', agent: 'agent:senior', role: 'senior', llm_config: { model: 's' },
    decisions: [{ usage: { calls: 1, tokens_in: 1000, cached_in: 0, tokens_out: 200, cost: 0.01 } }] }));
  const criteria = { anticipate: { require: ['model_accepted'] }, mechanism: { require: ['model_accepted', { recovery_at_least: 0.5 }] } } as const;

  const one = runResults(a2, criteria as never);
  assert.equal(typeof one.o1_predictive_acceptance.model, 'boolean');
  assert.equal(one.o4_mechanistic_recovery, 'no truth to grade against, or not graded');
  assert.equal(one.cost.tokens.agents, 1200);
  assert.equal(one.cost.tokens.total_at_least, (one.cost.tokens.junior ?? 0) + 1200);
  assert.equal(one.cost.money.known, 0.01);
  assert.ok(one.cost.money.unknown.some((u) => /junior/.test(u)), 'the junior\'s price is unknown, never zero');

  const report = { format: 'batch@1', id: 'k1', dir: root, started: new Date(Date.now() - 60000).toISOString(), ended: new Date().toISOString(), table: [], audit: [],
    definition: { id: 'k1', runs: [], criteria }, runs: [['a', a1], ['a', a2], ['a', a3], ['b', b1]].map(([condition, journal], i) => ({ id: 'r' + i, condition, journal })) } as unknown as BatchReport;
  const r = batchResults(report);
  assert.equal(r.groups.length, 3, 'by condition and generator: the run with a senior is another configuration, never pooled');
  const a = r.groups.find((g) => g.group.condition === 'a' && g.runs === 2)!;
  assert.equal(a.runs, 2);
  assert.equal(a.o1_predictive_acceptance.model.n, 2);
  assert.equal((a.o4_mechanistic_recovery as any).evidence, 'none');
  const adequacy = a.o3_adequacy as Record<string, any>;
  assert.equal(adequacy.anticipate.evaluable, 2);
  assert.equal(adequacy.mechanism.evaluable + adequacy.mechanism.not_evaluable, 2, 'not evaluable never counted as failing: told apart, with the coverage');
  assert.ok('O1_model_accepted' in a.efficiency && 'anticipate' in a.efficiency, 'each criterion its own efficiency');
  assert.equal(a.cost.money_unknown_in, 2);
  assert.equal(r.groups.find((g) => g.runs === 1 && g.group.condition === 'a')!.cost.money_known_sum, 0.01);
  assert.ok(typeof r.times.duration_seconds === 'number' && 'accumulated_run_seconds' in r.times);
  assert.ok(!/in control|out of control/.test(JSON.stringify(r)), 'no label of control');
  assert.match(batchText({ ...report, results: r }), /RESULTS APART/);

  /* Computed again from the command line, over the batch's report as it is. */
  const file = path.join(root, 'batch.json');
  fs.writeFileSync(file, JSON.stringify(report));
  const said: string[] = [];
  assert.equal(await labCli(['batch', 'results', file], { root, out: (l) => said.push(l) }), 0);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).results.groups.length, 3);
  assert.ok(fs.existsSync(path.join(root, 'batch.txt')));
});
