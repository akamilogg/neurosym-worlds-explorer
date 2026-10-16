import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';
import { characterize, rate } from '../src/runtime/generators.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';

/* SPEC-RIESGO-MODELOS §8.2 (M5): a generating configuration characterized over the runs of batches - per configuration and
   population, its rates with their 95% intervals, its cost and failure modes; the world it ran on is its population, never
   part of the configuration; measured again, added. */

test('a proportion with its 95% interval (Wilson): sound with none and with all', () => {
  assert.deepEqual(rate(0, 0), { k: 0, n: 0, rate: null, interval95: null });
  assert.deepEqual(rate(0, 3).interval95, [0, 0.562]);
  assert.deepEqual(rate(3, 3).interval95, [0.438, 1]);
  const half = rate(5, 10);
  assert.ok(half.interval95![0] < 0.5 && half.interval95![1] > 0.5);
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

test('characterized per configuration and population; its world never part of it; measured again, added', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'generators-'));
  const runs = [await aRun(root, 'a1', 'model-a', 1), await aRun(root, 'a2', 'model-a', 2), await aRun(root, 'b1', 'model-b', 1)];
  const batch = path.join(root, 'batch.json');
  fs.writeFileSync(batch, JSON.stringify({ format: 'batch@1', id: 'b1', runs: runs.map((journal, i) => ({ id: 'r' + i, condition: 'c', journal })) }));
  const made = characterize(root, [batch]);
  assert.deepEqual(made.map((g) => g.runs).sort(), [1, 2], 'two seeds of one configuration are one generator');
  const a = JSON.parse(fs.readFileSync(made.find((g) => g.runs === 2)!.file, 'utf8'));
  assert.equal(a.configuration.llm_model, 'model-a');
  assert.ok(!('seed' in a.configuration.harness) && !('level' in a.configuration.harness), 'its world is its population');
  const p = a.characterizations[0].populations[0];
  assert.equal(p.world, cellsLab.id);
  assert.equal(p.runs, 2);
  assert.equal(p.predictive_acceptance_of_the_model.n, 2);
  assert.ok(Array.isArray(p.predictive_acceptance_of_the_model.interval95));
  assert.equal(p.failure_modes.llm_error.k, 0);
  assert.match(a.reading, /never evidence about any one/);
  characterize(root, [batch]);
  assert.equal(JSON.parse(fs.readFileSync(made.find((g) => g.runs === 2)!.file, 'utf8')).characterizations.length, 2);
  assert.throws(() => characterize(root, [runs[0]]), /not a batch report/);
});
