import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { artifactsLab } from '../src/worlds/artifacts/lab.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';

/* SPEC-MUNDO-ARTEFACTOS, plan step 3: the world of artifacts as a laboratory - its versions and runs as episodes, its acts,
   its checks, and measured runs given again when a run is resumed. */

const FAST = 'import re\nTAG = re.compile(r"[a-z]+[0-9]+")\ndef main():\n    lines = open("input.csv", encoding="utf-8").read().split("\\n")\n    seen = set()\n    kept = []\n'
  + '    for line in lines[1:]:\n        if not line:\n            continue\n        key, value, tag = line.split(",")\n        if key in seen:\n            continue\n        seen.add(key)\n'
  + '        if TAG.fullmatch(tag) is None:\n            continue\n        kept.append((int(value), key, tag))\n    kept.sort(key=lambda r: (-r[0], r[1]))\n'
  + '    open("out.csv", "w", encoding="utf-8").write("key,value,tag\\n" + "".join(k + "," + str(v) + "," + t + "\\n" for v, k, t in kept))\nmain()\n';

/** System 2 standing in: it reads the base, makes the fast version and runs it, then proposes a model that predicts the base slower than any change. */
function system2(seen: Record<string, any>[]): FetchLike {
  let made: string | null = null;
  return async (_url, init) => {
    const b = JSON.parse(String(init.body));
    const sys = b.messages[0].content as string;
    const grading = sys.startsWith('You grade');
    const user = grading ? {} : JSON.parse(userOf(b));
    if (!grading) seen.push(user);
    for (const i of user.investigation ?? []) for (const x of i.results ?? []) if (x.accepted && typeof x.version === 'string' && !('runs' in x)) made = x.version;
    const done = (user.investigation ?? []).length;
    const base = (user.notebook?.episodes ?? []).find((e: any) => e.version)?.version;
    const content = grading ? { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' }
      : 'task' in user ? { rationale: 'r', beliefs: [{ id: 'b', stance: 'keep', why: 'w' }], lessons: ['l'], next_experiment: 'n' }
      : user.round === 1 && done === 0 ? { investigate: [{ view: 'ep1', from: 0, to: 40 }, { act: { change: { from: base, files: { 'main.py': FAST }, why: 'a set of seen keys and one sort', expect: 'faster where keys are many' } } }] }
      : user.round === 1 && done === 1 ? { investigate: [{ act: { run: { version: user.investigation[0].results[1].version ?? base, workloads: 2 } } }] }
      : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.changed.length ? 60 : 120', validate: false,
        ...(user.round === 1 ? { artifact: 'no-such-version' } : { artifact: made, validate_artifact: true }),
        beliefs: [{ id: 'b', stance: user.round === 1 ? 'new' : 'keep', statement: 'a change makes it faster', evidence: [] }], lessons: ['l'] };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
}

test('an assisted run on an artifact: versions to read, changes and runs as acts, checks of the reference and the latest version - and measured runs given again on a resume', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-lab-'));
  const seen: Record<string, any>[] = [];
  const args = ['--task', 'dedup', '--scale', '0.2', '--seed', '1', '--researcher', 'assisted', '--steps', '3', '--attempts', '2', '--flat', '--no-grade', '--no-reflection', '--no-ablation'];
  const r = await runLaboratory(artifactsLab, { args: [...args, '--out', path.join(dir, 'run.json')], root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch: system2(seen) });
  const journal = JSON.parse(fs.readFileSync(r.journal, 'utf8'));
  const inv = journal.events.filter((e: any) => e.type === 'investigation');
  const viewed = inv[0].results[0];
  assert.ok(viewed.rows.some((x: any) => x.file === 'main.py' && /seen = \[\]/.test(x.text)), 'the base is read as an episode of its lines');
  const made = inv[0].results[1];
  assert.equal(made.accepted, true, JSON.stringify(made));
  assert.match(String(made.version), /^[0-9a-f]{16}$/, 'the new version, by its content');
  const ran = inv[1].results[0];
  assert.equal(ran.accepted, true, JSON.stringify(ran));
  assert.equal(ran.correct, ran.runs, 'its runs are correct against the reference');
  const checks = journal.events.filter((e: any) => e.type === 'check');
  assert.ok(checks.length >= 1);
  assert.match(JSON.stringify(seen[seen.length - 1]), /your_answer/, 'the check tells what it answered and what was measured');
  /* The artifact's own verdict, apart from the model's: an unknown version refused, a known one judged - facts only. */
  const toldOf = (u: any) => u.last_check?.artifact;
  const told = seen.map(toldOf).filter(Boolean);
  assert.match(String(told[0]?.refused), /no version/, JSON.stringify(told[0]));
  const checked = journal.events.filter((e: any) => e.type === 'artifact_check');
  assert.ok(checked.length >= 1, 'a version put forward is judged');
  assert.doesNotMatch(JSON.stringify(checked[0].told), /ratio|interval/, 'System 2 is told the facts, never by how much');
  assert.match(String(checked[0].laboratories[0].environment?.fingerprint), /^[0-9a-f]{16}$/, 'where it was measured');
  const lab0 = checked[0].told.laboratories[0];
  assert.equal(typeof lab0.correct, 'boolean', JSON.stringify(checked[0].told));
  assert.equal(typeof lab0.your_artifact_holds_here, 'boolean', 'said of the artifact, not of a model');
  assert.ok(JSON.stringify(checked[0]).includes('ratio'), 'the operator keeps the measure');
  assert.equal(r.finding.artifact?.checks, checked.length, 'the finding has the artifact apart from the model');
  assert.equal(r.finding.artifact?.status, checked.some((c: any) => c.accepted) ? 'accepted' : 'not accepted');
  /* Resumed: every measured run comes from the log - none is run again, so nothing differs. */
  const again = await runLaboratory(artifactsLab, { args: ['--resume', r.journal, '--out', path.join(dir, 'again.json')], root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch: system2([]) });
  assert.notEqual(again.stoppedBy, 'diverged');
  const replayed = JSON.parse(fs.readFileSync(again.journal, 'utf8'));
  const measuredOf = (j: any) => j.events.filter((e: any) => e.type === 'check').map((e: any) => JSON.stringify(e.laboratories));
  assert.deepEqual(measuredOf(replayed), measuredOf(journal), 'the same measures, from the log');
  const artifactOf = (j: any) => j.events.filter((e: any) => e.type === 'artifact_check').map(({ t: _t, ...e }: any) => JSON.stringify(e));
  assert.deepEqual(artifactOf(replayed), artifactOf(journal), 'the same artifact verdicts, from the log');
});

/* Its contract (the generic one runs every laboratory at its default scale: test/labs.test.ts), here at a small scale. */
test('artifacts: its contract - acts echoed and refused as the others, a change the same version twice, cases and points the same, places described', async () => {
  const options = { task: 'dedup', scale: '0.1', acts: '3', tolerance: '0.25', workloads: '2' };
  const lab = artifactsLab;
  const spec = lab.generate(1, options);
  assert.equal(lab.interface({ world: options }).tools.includes('act'), true);
  for (const x of lab.act!.examples(spec)) {
    const act = lab.act!.parse(x);
    assert.notEqual(typeof act, 'string', JSON.stringify(x));
    assert.deepEqual(lab.act!.parse(JSON.parse(JSON.stringify(lab.act!.asWritten!(act as never)))), act, 'I1: what is echoed can be written again');
    assert.match(String(lab.act!.parse({ ...x, not_a_field: 1 })), /not_a_field/, 'I2');
  }
  assert.match(String(lab.act!.parse({ change: { from: spec.world.reference, files: { 'NOTE.md': 'x' } } })), /says why/, 'a change says why');
  assert.match(String(lab.act!.parse({ change: { from: spec.world.reference, files: { 'NOTE.md': 'x' }, why: 'w' } })), /exploratory/, 'and what it expects, or that it is exploratory');
  const change = lab.act!.parse({ change: { from: spec.world.reference, files: { 'NOTE.md': 'x' }, why: 'w', exploratory: true } });
  assert.deepEqual((change as any).change.exploratory, true);
  const once = await lab.act!.start(spec, change as never, 'act1', {} as never);
  const twice = await lab.act!.start(spec, change as never, 'act1', {} as never);
  assert.deepEqual(twice, once, 'I4: a change is the same version twice');
  assert.equal(lab.act!.varies!(lab.act!.parse({ run: { version: spec.world.reference } }) as never) !== null, true, 'a run says it varies');
  const e = await lab.episode(spec, () => 0.5);
  const cases = lab.cases(spec, 'ep1', e, 1);
  assert.ok(cases.length > 0);
  for (const c of cases) assert.deepEqual(lab.at(e, Number(c.point.split('@')[1]))!.state, c.state);
  assert.equal(lab.at(e, -1), null);
  assert.equal(typeof lab.placeInfo(spec), 'object');
  assert.deepEqual(lab.places!(spec, {} as never).laboratories.map((p) => p.id), ['mixed']);
  assert.deepEqual(lab.blindPlaces!(spec, 0, 1, {} as never).map((p) => p.id), ['wide-0']);
  assert.equal(lab.answerIssue(120), null);
  assert.notEqual(lab.answerIssue({ not: 'a number' }), null);
});
