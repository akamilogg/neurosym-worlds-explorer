import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { artifactsLab } from '../src/worlds/artifacts/lab.ts';
import { reviseRun } from '../src/runtime/validation.ts';
import { inventoryFile, readInventory, reevaluateModel, registerModel } from '../src/runtime/inventory.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';

/* SPEC-RIESGO-MODELOS M5, §9: a synthetic re-evaluation - the model a run ended with, frozen, with its dependencies as
   inventoried, checked by its world's protocol on new places of its family (and its artifact's version, made again from the
   record); no System 2. Below its criteria, the model is to validate again; each re-evaluation takes places of its own; it
   goes into the validation report as robustness. */

const QUADRATIC = ['def main():', '    lines = open("input.txt", encoding="utf-8").read().split("\\n")', '    n = int(lines[0])', '    a = sorted(int(x) for x in lines[1].split()[:n])',
  '    answer = "no"', '    for i in range(n - 2):', '        lo, hi = i + 1, n - 1', '        while lo < hi:', '            s = a[i] + a[lo] + a[hi]', '            if s == 0:',
  '                answer = "yes"', '                break', '            if s < 0:', '                lo += 1', '            else:', '                hi -= 1', '        if answer == "yes":',
  '            break', '    open("out.txt", "w", encoding="utf-8").write(answer + "\\n")', 'main()', ''].join('\n');

async function aRun(dir: string): Promise<string> {
  let made = '';
  const answers: FetchLike = async (_url, init) => {
    const user = JSON.parse(userOf(JSON.parse(String(init.body))));
    for (const i of user.investigation ?? []) for (const x of i.results ?? []) if (x.accepted && typeof x.version === 'string' && !('runs' in x)) made = x.version;
    const base = (user.notebook?.episodes ?? []).find((e: any) => e.version)?.version;
    const content = 'task' in user ? { rationale: 'r', beliefs: [], lessons: ['l'], next_experiment: 'n' }
      : user.round === 1 && !(user.investigation ?? []).length ? { investigate: [{ act: { change: { from: base, files: { 'main.py': QUADRATIC }, why: 'two pointers', expect: 'faster' } } }] }
      : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => 100', validate: false, lessons: ['l'], next_experiment: 'n', beliefs: [], ...(made ? { artifact: made, validate_artifact: true } : {}) };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
  return (await runLaboratory(artifactsLab, { args: ['--artifact', 'threesum', '--scale', '0.2', '--seed', '1', '--researcher', 'assisted', '--attempts', '2', '--flat', '--no-grade', '--no-reflection', '--no-ablation', '--out', path.join(dir, 'run.json')],
    root: dir, llm: { url: 'http://x.test/c', model: 's' }, fetch: answers })).journal;
}

test('a synthetic re-evaluation: the frozen model and its artifact on new places, no System 2; below its criteria, validate again', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reevaluation-'));
  const evidenceDir = path.join(root, 'runs', 'models', 'evidence');
  const journal = await aRun(root);
  const m = await registerModel(root, journal, { owner: 'Ana', use: 'anticipate the time of a run', evidenceDir });
  assert.match(String(m.layers.artifact.version), /^[0-9a-f]{16}$/, 'an artifact version to re-evaluate');

  const asked: string[] = [];
  const noSystem2: FetchLike = async (url) => { asked.push(url); throw new Error('no request goes out in a re-evaluation of a law without rules'); };
  const first = await reevaluateModel(root, m.id, { evidenceDir, fetch: noSystem2 });
  assert.deepEqual(asked, [], 'System 2 is never asked');
  assert.ok(first.reevaluation.model.places > 0);
  assert.equal(first.reevaluation.artifact.version, m.layers.artifact.version, 'its version, made again from the record');
  assert.ok(first.reevaluation.artifact.places > 0);
  assert.ok(first.reevaluation.places.every((p: any) => p.id.startsWith('reevaluation9000-')));
  /* '(p) => 100' cannot hold everywhere: below its criteria. */
  assert.ok(first.reevaluation.model.holds_in < first.reevaluation.model.places);
  assert.equal(first.entry.status, 'revalidate');
  assert.match(first.entry.history.at(-1)!.cause, /^reevaluation: its model holds in \d+ of \d+ new places.*below its criteria/);

  /* Another re-evaluation: places of its own. */
  const second = await reevaluateModel(root, m.id, { evidenceDir, fetch: noSystem2 });
  assert.equal(second.reevaluation.set, 9001);
  assert.equal(readInventory(root).models[0].reevaluations!.length, 2);

  /* Into the validation report: robustness, from its re-evaluations, as evidence. */
  const rev = await reviseRun(journal, { evidenceDir });
  assert.equal(rev.report.robustness.synthetic_reevaluations.length, 2);
  assert.match(rev.report.robustness.within, /not the real system/);
  const roles = JSON.parse(fs.readFileSync(path.join(evidenceDir, rev.revision), 'utf8')).evidence.map((e: any) => e.role);
  assert.equal(roles.filter((r: string) => r === 'reevaluation').length, 2);

  /* A dependency not as inventoried: refused - it would evaluate something else. */
  const inv = readInventory(root);
  (inv.models[0].layers.execution_dependencies as any).runtime = { node: 'v0.0.0' };
  fs.writeFileSync(inventoryFile(root), JSON.stringify(inv));
  await assert.rejects(reevaluateModel(root, m.id, { evidenceDir, fetch: noSystem2 }), /not as inventoried \(runtime\)/);
});
