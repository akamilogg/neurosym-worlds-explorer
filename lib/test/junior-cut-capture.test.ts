import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';
import { captureCut } from '../src/junior/probes.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';

/* An external review of 0bec9b3 (13/11/2026): a cut's content, hash and capture come from the one copy it is rebuilt from. */

const LOOK = { investigate: [{ view: 'ep1', from: 0, to: 2 }] };
const PROPOSE = { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]', validate: false, lessons: ['l'], next_experiment: 'n', beliefs: [] };
const standIn: FetchLike = async (_url, init) => {
  const user = JSON.parse(userOf(JSON.parse(String(init.body))));
  const content = 'task' in user ? { rationale: 'r', beliefs: [], lessons: ['l'], next_experiment: 'n' } : (user.investigation ?? []).length ? PROPOSE : LOOK;
  const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
  return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
};
const run = (dir: string, seed: string) => runLaboratory(cellsLab, { args: ['--seed', seed, '--level', '1', '--flat', '--no-grade', '--tools', 'view', '--attempts', '1', '--out', path.join(dir, 'run.json')],
  root: dir, llm: { url: 'http://x.test/c', model: 's' }, fetch: standIn, print: () => {} });

test('review 3 of 0bec9b3: a run replaced while its cut is rebuilt - the cut keeps the content, hash and capture of the run it was rebuilt from', async () => {
  const one = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-capture-'));
  const nine = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-capture-'));
  const r1 = await run(one, '1');
  await run(nine, '9');
  const reference = await captureCut(r1.journal, 0);
  assert.equal(reference.capture?.argv[reference.capture.argv.indexOf('--seed') + 1], '1');
  /* The cut begun (its copy staged at once), then the original replaced by the run of seed 9 before it ends. */
  const pending = captureCut(r1.journal, 0);
  fs.copyFileSync(path.join(nine, 'run.json'), r1.journal);
  const cut = await pending;
  assert.deepEqual(cut.content, reference.content);
  assert.equal(cut.hash, reference.hash);
  assert.deepEqual(cut.capture, reference.capture, 'the identity of the run it was rebuilt from, never the file as it is now');
});
