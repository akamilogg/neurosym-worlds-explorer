import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { artifactsLab } from '../src/worlds/artifacts/lab.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';

/* SPEC-MUNDO-ARTEFACTOS §9 and plan step 4: each change says which beliefs it rests on; when one falls, the environment says
   which changes rested on it and whether they are still in the line of the latest version (a fact of the record; what to undo
   stays the researcher's); and the product is linked to the chain that made it - reasons, beliefs, tests of its own. */

const QUADRATIC = ['def main():', '    lines = open("input.txt", encoding="utf-8").read().split("\\n")', '    n = int(lines[0])', '    a = sorted(int(x) for x in lines[1].split()[:n])',
  '    answer = "no"', '    for i in range(n - 2):', '        lo, hi = i + 1, n - 1', '        while lo < hi:', '            s = a[i] + a[lo] + a[hi]', '            if s == 0:',
  '                answer = "yes"', '                break', '            if s < 0:', '                lo += 1', '            else:', '                hi -= 1', '        if answer == "yes":',
  '            break', '    open("out.txt", "w", encoding="utf-8").write(answer + "\\n")', 'main()', ''].join('\n');

test('because: a change says which beliefs it rests on; a fallen belief lists the changes that rested on it, and whether they are in the line of the latest version', async () => {
  const lab = artifactsLab;
  const spec = lab.generate(1, { artifact: 'threesum', scale: '0.1', acts: '3', tolerance: '0.25', workloads: '2' });
  assert.match(String(lab.act!.parse({ change: { from: spec.world.reference, files: { 'main.py': 'x' }, why: 'w', expect: 'e', because: 'b1' } })), /"because"/, 'ids, in a list');
  const a = lab.act!.parse({ change: { from: spec.world.reference, files: { 'main.py': QUADRATIC }, why: 'sorted pairs', expect: 'faster', because: ['sorting_helps'] } });
  const made = await lab.act!.start(spec, a as never, 'act1', {} as never) as { version: string };
  const b = lab.act!.parse({ change: { from: spec.world.reference, files: { 'NOTE.md': 'aside' }, why: 'a branch', exploratory: true, because: ['sorting_helps'] } });
  const aside = await lab.act!.start(spec, b as never, 'act2', {} as never) as { version: string };
  const c = lab.act!.parse({ change: { from: made.version, files: { 'NOTE.md': 'on top' }, why: 'a note', exploratory: true } });
  const top = await lab.act!.start(spec, c as never, 'act3', {} as never) as { version: string };
  const resting = lab.dependents!(spec, ['sorting_helps'])!;
  assert.equal(resting.latest_version, top.version);
  const byVersion = Object.fromEntries((resting.changes_resting_on_them as any[]).map((x) => [x.version, x.in_line_of_latest]));
  assert.deepEqual(byVersion, { [made.version]: true, [aside.version]: false }, 'in the line of the latest version, or not');
  assert.equal(lab.dependents!(spec, ['nothing_rests_on_this']), null);
  const line = lab.lineage!(spec, top.version);
  assert.deepEqual(line.map((t) => t.to), [made.version, top.version], 'from the base, change by change');
  assert.deepEqual((line[0].reason as any).because, ['sorting_helps']);
});

test('content is not provenance: base->A, base->B, B->A - A was last made from B, and the line of the latest is those changes', async () => {
  const lab = artifactsLab;
  const spec = lab.generate(1, { artifact: 'threesum', scale: '0.1', acts: '3', tolerance: '0.25', workloads: '2' });
  const make = async (change: Record<string, unknown>, id: string) => (await lab.act!.start(spec, lab.act!.parse({ change }) as never, id, {} as never) as { version: string }).version;
  const base = spec.world.reference;
  const a = await make({ from: base, files: { 'main.py': QUADRATIC }, why: 'straight to it', expect: 'faster', because: ['first_way'] }, 'act1');
  const b = await make({ from: base, files: { 'NOTE.md': 'a step' }, why: 'a step first', exploratory: true }, 'act2');
  const again = await make({ from: b, files: { 'main.py': QUADRATIC, 'NOTE.md': null }, why: 'then the change', expect: 'faster', because: ['second_way'] }, 'act3');
  assert.equal(again, a, 'the same content, the same version');
  const line = lab.lineage!(spec, a);
  assert.deepEqual(line.map((t) => [t.change, t.from, t.to]), [[2, base, b], [3, b, a]], 'the way it was last made, change by change');
  const resting = lab.dependents!(spec, ['first_way', 'second_way'])!;
  assert.deepEqual((resting.changes_resting_on_them as any[]).map((x) => [x.change, x.in_line_of_latest]), [[1, false], [3, true]],
    'the first way to A is not in the line of the latest: another change made it');
});

test('in a run: a dropped belief is told with the changes that rested on it; the product\'s chain in the finding - reasons, beliefs as they stand, its tests', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-because-'));
  let made = '';
  const told: Record<string, any>[] = [];
  const answers: FetchLike = async (_url, init) => {
    const b = JSON.parse(String(init.body));
    const sys = b.messages[0].content as string;
    const user = sys.startsWith('You grade') ? {} : JSON.parse(userOf(b));
    if (!sys.startsWith('You grade')) told.push(user);
    for (const i of user.investigation ?? []) for (const x of i.results ?? []) if (x.accepted && typeof x.version === 'string' && !('runs' in x)) made = x.version;
    const done = (user.investigation ?? []).length;
    const base = (user.notebook?.episodes ?? []).find((e: any) => e.version)?.version;
    const proposal = (extra: Record<string, unknown>) => ({ rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => 100', validate: false, lessons: ['l'], next_experiment: 'n', ...extra });
    const content = sys.startsWith('You grade') ? { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' }
      : 'task' in user ? { rationale: 'r', beliefs: [], lessons: ['l'], next_experiment: 'n' }
      : user.round === 1 && done === 0 ? { investigate: [{ act: { change: { from: base, files: { 'main.py': QUADRATIC }, why: 'sorting lets two pointers find a pair in linear time', expect: 'faster where no triple exists', because: ['sorting_helps'] } } }] }
      : user.round === 1 ? proposal({ beliefs: [{ id: 'sorting_helps', stance: 'new', statement: 'sorting makes the pair search linear', evidence: [] }], artifact: made, validate_artifact: true })
      : user.round === 2 && done === 0 ? { investigate: [{ register_test: { protocol: { run: { version: made, workloads: 1 } }, model: 1, rival: { observations: {}, rules: {}, weights: {}, output: '(p) => 5000' }, claim: 'it runs in about 100 ms', kind: 'replicate' } }] }
      : user.round === 2 ? proposal({ beliefs: [{ id: 'sorting_helps', stance: 'drop', why: 'a test of mine says otherwise' }] })
      : proposal({ beliefs: [] });
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
  const r = await runLaboratory(artifactsLab, { args: ['--artifact', 'threesum', '--scale', '0.5', '--seed', '1', '--researcher', 'assisted', '--attempts', '3', '--flat', '--no-grade', '--no-reflection', '--no-ablation', '--out', path.join(dir, 'run.json')],
    root: dir, llm: { url: 'http://x.test/c', model: 's' }, fetch: answers });
  const events = JSON.parse(fs.readFileSync(r.journal, 'utf8')).events as Record<string, any>[];
  const fell = events.find((e) => e.type === 'beliefs_fell');
  assert.ok(fell, 'the drop is told');
  assert.deepEqual(fell.beliefs_fell, ['sorting_helps']);
  assert.equal(fell.changes_resting_on_them[0].version, made);
  assert.equal(fell.changes_resting_on_them[0].in_line_of_latest, true);
  const noticed = told.find((u) => (u.channel?.notices ?? []).some((n: any) => n.from === 'world' && n.body.beliefs_fell));
  assert.equal(noticed?.round, 3, 'as a notice of the world, at the next round');
  /* The version the run ends with - accepted or not, as a measurement may decide - and the chain that made it. */
  assert.equal(r.finding.artifact?.version, made, 'the product: ' + JSON.stringify(r.finding.artifact));
  const lineage = r.finding.artifact!.lineage as any[];
  assert.equal(lineage.length, 1);
  assert.equal(lineage[0].to, made);
  assert.equal(lineage[0].reason.expect, 'faster where no triple exists');
  assert.deepEqual(lineage[0].beliefs, [{ id: 'sorting_helps', status: 'dropped' }], 'the belief it rested on, as it stands at the end');
  assert.equal(lineage[0].tests?.[0]?.claim, 'it runs in about 100 ms', 'the test of its own registered on that version: ' + JSON.stringify(events.filter((e) => e.type === 'investigation' && e.round === 2).map((e) => e.results)));
  assert.notEqual(lineage[0].tests[0].result, 'not run', 'with what came of it');
});
