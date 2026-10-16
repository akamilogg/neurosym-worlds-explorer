import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

/** A Judge that answers every question it is asked, of whatever kind. */
function jevAnswer(body: Record<string, any>): string {
  const answers = Object.fromEntries(Object.entries((body.questions ?? {}) as Record<string, any>).map(([id, rule]) => {
    const options = [...new Set([...(rule.option ? [rule.option] : []), ...(Array.isArray(rule.criteria) ? [] : Object.keys(rule.criteria ?? {}))])];
    return [id, rule.type === 'choice' ? { type: 'choice', probabilities: Object.fromEntries(options.map((o) => [o, 1 / Math.max(1, options.length)])), confidence: 0.5 }
      : rule.type === 'score' ? { type: 'score', score: 1, confidence: 0.5 } : { type: rule.type, noul: 0.5 }];
  }));
  return JSON.stringify({ answers });
}

async function aRun(dir: string, extra: { args?: string[]; judged?: boolean; attempts?: number } = {}): Promise<string> {
  let made = '';
  const answers: FetchLike = async (url, init) => {
    if (url.includes('jev.test')) { const text = jevAnswer(JSON.parse(String(init.body))); return { ok: true, status: 200, text: async () => text, headers: { get: () => null } }; }
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
  const r = await runLaboratory(artifactsLab, { args: ['--artifact', 'threesum', '--scale', '0.2', '--seed', '1', '--researcher', 'assisted', '--attempts', String(extra.attempts ?? 2),
    ...(extra.judged ? [] : ['--flat']), '--no-grade', '--no-reflection', '--no-ablation', ...(extra.args ?? []), '--out', path.join(dir, 'run.json')],
    root: dir, llm: { url: 'http://x.test/c', model: 's' }, fetch: answers, ...(extra.judged ? { judge: { url: 'http://jev.test/j', key: 'test-key' } } : {}) });
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

test('a package is never written where its run is, nor over a folder that is not a package', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'package-out-'));
  const journal = await aRun(dir);
  const before = fs.readdirSync(dir).sort();
  assert.throws(() => packRun(journal, dir), /never written where its run is/);
  assert.throws(() => packRun(journal, path.dirname(dir)), /never written where its run is/, 'nor a folder that holds it');
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-package-'));
  fs.writeFileSync(path.join(other, 'precious.txt'), 'x');
  assert.throws(() => packRun(journal, other), /not a package/);
  assert.ok(fs.existsSync(path.join(other, 'precious.txt')));
  assert.deepEqual(fs.readdirSync(dir).sort(), before, 'the run as it was');
  const { dir: pack } = packRun(journal);
  assert.doesNotThrow(() => packRun(journal, pack), 'a package is replaced by a package');
});

test('a blob is evidence only if its content is the one its name says: corrupt before packing, or forged in the package', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'package-blob-'));
  const journal = await aRun(dir);
  /* A text the journal kept whole by its content - and what is found under that name, altered. */
  const kept = 'the whole output of a run';
  const name = createHash('sha256').update(kept).digest('hex');
  const j = JSON.parse(fs.readFileSync(journal, 'utf8'));
  j.events.push({ t: 0, type: 'note', evidence: { sha256: name, kept: true } });
  fs.writeFileSync(journal, JSON.stringify(j));
  fs.mkdirSync(path.join(dir, 'blobs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'blobs', name), 'something else');
  const { dir: pack, manifest } = packRun(journal);
  assert.deepEqual(manifest.corrupt_blobs, [name], 'not packed as if it were the evidence');
  assert.equal((await verifyPackage(pack)).integrity.holds, false);
  /* Forged in the package with its manifest made to agree: the reference still names another content. */
  fs.writeFileSync(path.join(dir, 'blobs', name), kept);
  const again = packRun(journal);
  fs.writeFileSync(path.join(again.dir, 'blobs', name), 'forged');
  const m = JSON.parse(fs.readFileSync(path.join(again.dir, 'manifest.json'), 'utf8'));
  m.files = m.files.map((f: any) => (f.path === 'blobs/' + name ? { ...f, sha256: createHash('sha256').update('forged').digest('hex') } : f));
  fs.writeFileSync(path.join(again.dir, 'manifest.json'), JSON.stringify(m));
  const v = await verifyPackage(again.dir);
  assert.deepEqual(v.integrity.changed, []);
  assert.deepEqual(v.integrity.corrupt_blobs, [name]);
  assert.equal(v.integrity.holds, false);
});

test('reconstruction: a run with the Judge, offline and with no key; a run stopped by its budget, stopped there again; its end compared', async () => {
  const judged = fs.mkdtempSync(path.join(os.tmpdir(), 'package-judged-'));
  const v = await verifyPackage(packRun(await aRun(judged, { judged: true })).dir);
  assert.equal(v.reconstruction.holds, true, JSON.stringify(v.reconstruction));
  assert.equal(v.reconstruction.requests_refused, 0);

  const short = fs.mkdtempSync(path.join(os.tmpdir(), 'package-budget-'));
  const journal = await aRun(short, { attempts: 4, args: ['--max-tokens', '250'] });
  const end = JSON.parse(fs.readFileSync(journal, 'utf8')).events.find((e: any) => e.type === 'end');
  assert.equal(end.stoppedBy, 'token_budget');
  const w = await verifyPackage(packRun(journal).dir);
  assert.equal(w.reconstruction.holds, true, 'stopped where its record stopped, not gone on: ' + JSON.stringify(w.reconstruction));
  assert.equal(w.reconstruction.requests_refused, 0);

  /* Its end changed before packing - another final model: the reconstruction does not come out the same. */
  const changed = fs.mkdtempSync(path.join(os.tmpdir(), 'package-end-'));
  const run = await aRun(changed);
  const j = JSON.parse(fs.readFileSync(run, 'utf8'));
  const e = j.events.find((x: any) => x.type === 'end');
  e.final = { ...(e.final ?? {}), output: '(p) => 1' };
  fs.writeFileSync(run, JSON.stringify(j));
  const x = await verifyPackage(packRun(run).dir);
  assert.equal(x.reconstruction.holds, false);
  assert.deepEqual(x.reconstruction.end_differs, ['final']);
});
