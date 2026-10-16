import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';
import { JEV_DEFAULT_URL } from '../src/core/jev.ts';
import { packRun, verifyPackage } from '../src/runtime/package.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';

/* An external review (16/10/2026): a run that did ask the Judge is rebuilt offline - the Judge's path is part of what makes
   a request that request, so the journal keeps it (never its host) and the reconstruction asks the same path. */

function jevAnswer(body: Record<string, any>): string {
  const answers = Object.fromEntries(Object.entries((body.questions ?? {}) as Record<string, any>).map(([id, rule]) => [id,
    rule.type === 'choice' ? { type: 'choice', probabilities: { [rule.option ?? 'yes']: 0.5 }, confidence: 0.5 } : rule.type === 'score' ? { type: 'score', score: 1, confidence: 0.5 } : { type: rule.type, noul: 0.5 }]));
  return JSON.stringify({ answers });
}

test('a run that asked the Judge, rebuilt offline at the Judge\'s own path', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'package-judge-'));
  let judged = 0;
  const answers: FetchLike = async (url, init) => {
    if (url.startsWith(JEV_DEFAULT_URL)) { judged++; const text = jevAnswer(JSON.parse(String(init.body))); return { ok: true, status: 200, text: async () => text, headers: { get: () => null } }; }
    const user = JSON.parse(userOf(JSON.parse(String(init.body))));
    const content = 'task' in user ? { rationale: 'r', beliefs: [], lessons: ['l'], next_experiment: 'n' }
      : { rationale: 'r', observations: { last: { definition: 'the last row', source: '(p) => p.rows[p.rows.length - 1]' } }, rules: { same: { type: 'noul', used_as: 'value', instructions: 'Row {{last}}: does it stay as it is?', criteria: { yes: '', no: '' } } }, weights: { same: 1 },
        output: '(p, m) => p.rows[p.rows.length - 1]', validate: false, lessons: ['l'], next_experiment: 'n', beliefs: [] };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
  const r = await runLaboratory(cellsLab, { args: ['--seed', '1', '--level', '1', '--researcher', 'assisted', '--attempts', '1', '--no-grade', '--no-reflection', '--no-ablation', '--out', path.join(dir, 'run.json')],
    root: dir, llm: { url: 'http://x.test/v1/chat/completions', model: 's' }, judge: { url: JEV_DEFAULT_URL, key: 'test-key' }, fetch: answers });
  assert.ok(judged > 0, 'the Judge was asked');
  assert.equal(JSON.parse(fs.readFileSync(r.journal, 'utf8')).config.jev_path, new URL(JEV_DEFAULT_URL).pathname);
  const v = await verifyPackage(packRun(r.journal).dir);
  assert.equal(v.reconstruction.holds, true, JSON.stringify(v.reconstruction));
  assert.equal(v.reconstruction.requests_refused, 0);
});
