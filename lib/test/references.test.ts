import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';
import { pairedComparison } from '../src/runtime/statistics.ts';
import { comparisonProblems, freezeReference, openReference, referenceFile } from '../src/orchestra/references.ts';
import { batchResults, batchText, type BatchReport } from '../src/orchestra/batch.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';

/* SPEC-CONTROL-ARNES K2 (§6.1, §6.4) and the paired comparison of §6.2.1: a group's distribution frozen with its runs' hash;
   a new version compared with it seed by seed, with a margin declared before, before a person sets a new one - and the old
   one never deleted. */

const m = (pairs: [string, number][]) => new Map(pairs);

test('a paired comparison: four conclusions by its rule, the effect oriented so that better is positive', () => {
  const before = m([['s1', 10], ['s2', 12], ['s3', 11], ['s4', 13]]);
  assert.equal(pairedComparison(before, m([['s1', 12], ['s2', 14.5], ['s3', 13], ['s4', 15.5]]), { margin: 1 }).conclusion, 'improves');
  assert.equal(pairedComparison(before, m([['s1', 8], ['s2', 9.5], ['s3', 9], ['s4', 10.5]]), { margin: 1 }).conclusion, 'worsens');
  assert.equal(pairedComparison(before, m([['s1', 10.1], ['s2', 11.9], ['s3', 11.05], ['s4', 12.95]]), { margin: 1 }).conclusion, 'indistinguishable');
  assert.equal(pairedComparison(before, m([['s1', 12], ['s2', 14]]), { margin: 1 }).conclusion, 'insufficient evidence', 'fewer than 3 paired seeds');
  assert.equal(pairedComparison(before, m([['s1', 11], ['s2', 13], ['s3', 12]]), { margin: 0.5 }).conclusion, 'insufficient evidence', 'all differences alike: no interval feigning certainty');
  /* A cost: lower is better - it falls, and that is an improvement. */
  const cost = pairedComparison(m([['a', 100], ['b', 200], ['c', 150], ['d', 120]]), m([['a', 40], ['b', 90], ['c', 75], ['d', 66]]), { margin: 0.2, lower: true, relative: true });
  assert.ok((cost.effect ?? 0) > 0.4);
  assert.equal(cost.conclusion, 'improves');
  /* Binary: the discordant pairs, each way. */
  const b = pairedComparison(m([['a', 0], ['b', 1], ['c', 0], ['d', 1]]), m([['a', 1], ['b', 1], ['c', 1], ['d', 0]]), { margin: 0.25, binary: true });
  assert.deepEqual(b.discordant, { better_now: 2, worse_now: 1 });
});

async function aRun(dir: string, name: string, model: string, seed: number, tokens: number): Promise<string> {
  const answers: FetchLike = async (_url, init) => {
    const user = JSON.parse(userOf(JSON.parse(String(init.body))));
    const content = 'task' in user ? { rationale: 'r', beliefs: [], lessons: ['l'], next_experiment: 'n' }
      : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]', validate: false, lessons: ['l'], next_experiment: 'n', beliefs: [] };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: tokens } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
  return (await runLaboratory(cellsLab, { args: ['--seed', String(seed), '--level', '1', '--researcher', 'assisted', '--attempts', '1', '--flat', '--no-grade', '--no-reflection', '--no-ablation', '--out', path.join(dir, name + '.json')],
    root: dir, llm: { url: 'http://system2.test/v1/chat/completions', model }, fetch: answers })).journal;
}

const batch = (root: string, id: string, journals: string[], extra: Record<string, unknown> = {}) => {
  const report = { format: 'batch@1', id, dir: root, started: new Date().toISOString(), table: [], audit: [], definition: { id, runs: [], ...extra },
    runs: journals.map((journal, i) => ({ id: 'r' + i, condition: 'c', journal })) } as unknown as BatchReport;
  const file = path.join(root, id + '.json');
  fs.writeFileSync(file, JSON.stringify(report));
  return { report, file };
};

test('a reference frozen, a new version compared with it as declared, and a new reference only after - the old one stays', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'references-'));
  const old = [await aRun(root, 'o1', 'model-a', 1, 100), await aRun(root, 'o2', 'model-a', 2, 120), await aRun(root, 'o3', 'model-a', 3, 110)];
  const first = batch(root, 'old', old);
  assert.throws(() => freezeReference(root, first.file, { condition: 'c', name: 'base', by: 'agent:senior' }), /a person/);
  const base = freezeReference(root, first.file, { condition: 'c', name: 'base', by: 'Ana' });
  assert.equal(base.runs.length, 3);
  assert.ok(base.runs.every((r) => /\|seed \d$/.test(r.key)));
  assert.throws(() => freezeReference(root, first.file, { condition: 'c', name: 'base', by: 'Ana' }), /never replaced/);
  assert.equal(openReference(root, 'base').holds, true);

  /* The new version (here: another model), the same seeds, the comparison declared before it runs. */
  const compare = [{ reference: 'base', condition: 'c', metric: 'tokens', margin: 0.2, relative: true }];
  assert.deepEqual(comparisonProblems(root, compare), []);
  assert.match(comparisonProblems(root, [{ reference: 'base', condition: 'c', metric: 'correctness', margin: 0 }]).join(' '), /metric.*margin above zero/);
  const fresh = [await aRun(root, 'n1', 'model-b', 1, 40), await aRun(root, 'n2', 'model-b', 2, 60), await aRun(root, 'n3', 'model-b', 3, 66)];
  const second = batch(root, 'new', fresh, { compare });
  const results = batchResults(second.report, root);
  const c = results.comparisons![0] as Record<string, any>;
  assert.equal(c.comparison.pairs, 3, 'paired by seed and world');
  assert.equal(c.comparison.conclusion, 'improves', JSON.stringify(c.comparison));
  assert.deepEqual(c.groups.differ_in, ['generator'], 'what else differs between the groups is said');
  assert.match(batchText({ ...second.report, results }), /compared with reference base \[c, tokens\]: improves/);

  /* A new reference: only once compared with the one it supersedes; the old one stays. */
  assert.throws(() => freezeReference(root, second.file, { condition: 'c', name: 'next', by: 'Ana', supersedes: 'base' }), /was not compared with base/);
  fs.writeFileSync(second.file, JSON.stringify({ ...second.report, results }));
  const next = freezeReference(root, second.file, { condition: 'c', name: 'next', by: 'Ana', supersedes: 'base' });
  assert.equal(next.supersedes, 'base');
  assert.ok(fs.existsSync(referenceFile(root, 'base')));

  /* A run of the reference changed after it was frozen: it no longer holds, and no comparison is made with it. */
  fs.writeFileSync(old[0], fs.readFileSync(old[0], 'utf8').replace('"seed"', '"seed" '));
  const opened = openReference(root, 'base');
  assert.equal(opened.holds, false);
  assert.match(comparisonProblems(root, compare).join(' '), /does not hold/);
});
