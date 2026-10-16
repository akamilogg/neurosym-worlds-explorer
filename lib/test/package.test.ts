import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { artifactsLab } from '../src/worlds/artifacts/lab.ts';
import { packRun, verifyPackage } from '../src/runtime/package.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';

/* SPEC-RIESGO-MODELOS M1 (R6, R7) and an external audit (16/10/2026): a run packed whole - its record, its blobs, a manifest of
   hashes, its results each by its name - and verified apart: its integrity, its history rebuilt offline from its record, and
   what was not done (re-execution, reproduction) said, never taken for the first. */

const QUADRATIC = ['def main():', '    lines = open("input.txt", encoding="utf-8").read().split("\\n")', '    n = int(lines[0])', '    a = sorted(int(x) for x in lines[1].split()[:n])',
  '    answer = "no"', '    for i in range(n - 2):', '        lo, hi = i + 1, n - 1', '        while lo < hi:', '            s = a[i] + a[lo] + a[hi]', '            if s == 0:',
  '                answer = "yes"', '                break', '            if s < 0:', '                lo += 1', '            else:', '                hi -= 1', '        if answer == "yes":',
  '            break', '    open("out.txt", "w", encoding="utf-8").write(answer + "\\n")', 'main()', ''].join('\n');

async function aRun(dir: string): Promise<string> {
  let made = '';
  const answers: FetchLike = async (_url, init) => {
    const b = JSON.parse(String(init.body));
    const sys = b.messages[0].content as string;
    const user = sys.startsWith('You grade') ? {} : JSON.parse(userOf(b));
    for (const i of user.investigation ?? []) for (const x of i.results ?? []) if (x.accepted && typeof x.version === 'string' && !('runs' in x)) made = x.version;
    const done = (user.investigation ?? []).length;
    const base = (user.notebook?.episodes ?? []).find((e: any) => e.version)?.version;
    const content = 'task' in user ? { rationale: 'r', beliefs: [], lessons: ['l'], next_experiment: 'n' }
      : user.round === 1 && done === 0 ? { investigate: [{ act: { change: { from: base, files: { 'main.py': QUADRATIC }, why: 'two pointers on the sorted list', expect: 'faster' } } }] }
      : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => 100', validate: false, lessons: ['l'], next_experiment: 'n', beliefs: [], ...(made ? { artifact: made, validate_artifact: true } : {}) };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
  const r = await runLaboratory(artifactsLab, { args: ['--artifact', 'threesum', '--scale', '0.2', '--seed', '1', '--researcher', 'assisted', '--attempts', '2', '--flat', '--no-grade', '--no-reflection', '--no-ablation', '--out', path.join(dir, 'run.json')],
    root: dir, llm: { url: 'http://x.test/c', model: 's' }, fetch: answers });
  return r.journal;
}

test('a run packed whole and verified: integrity by its hashes, its history rebuilt offline; a file changed, told by its name', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'package-'));
  const journal = await aRun(dir);
  const { dir: pack, manifest } = packRun(journal);
  assert.equal(manifest.format, 'research_package@1');
  const paths = manifest.files.map((f) => f.path);
  for (const p of ['run.json', 'run.replay.jsonl', 'run.finding.json', 'report.json']) assert.ok(paths.includes(p), p + ' in ' + paths.join(', '));
  assert.deepEqual(manifest.missing_blobs, []);
  const report = JSON.parse(fs.readFileSync(path.join(pack, 'report.json'), 'utf8'));
  assert.deepEqual(Object.keys(report.results), ['predictive_acceptance_of_the_model', 'predictive_acceptance_of_the_artifact', 'discriminating_evidence', 'adequacy_to_a_use', 'mechanistic_recovery'], 'each result by its name (R6)');
  assert.ok(!JSON.stringify(report).includes('"correct"'));

  /* Carried elsewhere, the run's folder gone: the package is all there is. */
  const moved = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'carried-')), 'pkg');
  fs.cpSync(pack, moved, { recursive: true });
  fs.rmSync(dir, { recursive: true, force: true });
  const v = await verifyPackage(moved);
  assert.equal(v.integrity.holds, true, JSON.stringify(v.integrity));
  assert.equal(v.reconstruction.holds, true, JSON.stringify(v.reconstruction));
  assert.ok(v.reconstruction.events_compared > 3);
  assert.equal(v.reconstruction.requests_refused, 0, 'every answer from its record');
  assert.equal(v.re_execution.done, false);
  assert.equal(v.reproduction.done, false);

  /* A file changed after packing: integrity names it, and the reconstruction of a changed record is not trusted silently. */
  const log = path.join(moved, 'run.replay.jsonl');
  const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
  fs.writeFileSync(log, lines.slice(0, Math.max(1, lines.length - 2)).join('\n') + '\n');
  fs.writeFileSync(path.join(moved, 'stray.txt'), 'x');
  const w = await verifyPackage(moved);
  assert.equal(w.integrity.holds, false);
  assert.deepEqual(w.integrity.changed, ['run.replay.jsonl']);
  assert.deepEqual(w.integrity.unlisted, ['stray.txt']);
  assert.equal(w.reconstruction.holds, false, 'its record cut: what it needs is not there, and is not asked again: ' + JSON.stringify(w.reconstruction));
});
