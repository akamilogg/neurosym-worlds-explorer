import test from 'node:test';
import assert from 'node:assert/strict';
import { judge, type ArtifactTask, type Paired, type RunOutcome } from '../src/artifacts/task.ts';
import { ArtifactWorld } from '../src/artifacts/world.ts';
import { processSandbox } from '../src/artifacts/sandbox.ts';
import { dedupTask } from '../src/artifacts/tasks/dedup.ts';

/* SPEC-MUNDO-ARTEFACTOS §4-§8: the task, the acts, the verdict - and the first case (§14). */

const outcome = (ms: number, output = 'same', exitCode: number | null = 0): RunOutcome => ({ workload: 'w', exitCode, timedOut: false, metrics: { wall_ms: ms, peak_kb: 1000 }, output, stderr: '' });
const pairsOf = (ref: number[][], cand: number[][], output = 'same'): Paired[] => ref.map((r, i) => ({ workload: { family: 'f', id: 'w' + i, seed: i, params: {} },
  reference: r.map((ms) => outcome(ms)), candidate: cand[i].map((ms) => outcome(ms, output)) }));
const task = (extra: Partial<ArtifactTask['objective']> = {}): ArtifactTask => ({ ...dedupTask(), oracle: (c, r) => ({ ok: c.output === r.output, why: 'differs' }),
  objective: { metric: 'wall_ms', direction: 'min', margin: 0.1, confidence: 0.9, repetitions: 3, ...extra } });

test('the verdict: correct everywhere, better by the margin with its confidence, no constraint broken - deterministic', () => {
  const ref = [[100, 104, 98], [200, 210, 190], [150, 149, 152], [120, 118, 125]];
  const fast = judge(task(), pairsOf(ref, ref.map((r) => r.map((x) => x * 0.5))));
  assert.equal(fast.holds, true, fast.why);
  assert.ok(Math.abs(fast.ratio! - 0.5) < 0.02);
  assert.deepEqual(judge(task(), pairsOf(ref, ref.map((r) => r.map((x) => x * 0.5)))), fast, 'the same measures, the same verdict');
  const same = judge(task(), pairsOf(ref, ref.map((r) => r.map((x) => x * 0.97))));
  assert.equal(same.holds, false);
  assert.match(same.why, /not better by 10%/);
  assert.equal(judge(task(), pairsOf(ref, ref.map((r) => r.map((x) => x * 0.97))), 'not_worse').holds, true, 'where only not being worse is asked');
  assert.equal(judge(task(), pairsOf(ref, ref.map((r) => r.map((x) => x * 1.5))), 'not_worse').holds, false);
  const wrong = judge(task(), pairsOf(ref, ref.map((r) => r.map((x) => x * 0.5)), 'other'));
  assert.deepEqual([wrong.holds, wrong.correct, wrong.incorrect.length], [false, false, 12]);
  /* Better on most workloads but much worse on one: the interval does not clear the margin. */
  const mixed = judge(task(), pairsOf(ref, [[50, 52, 49], [100, 105, 95], [600, 610, 590], [60, 59, 62]]));
  assert.equal(mixed.holds, false, mixed.why);
  /* A constraint: memory may not grow more than 10 %. */
  const heavy = pairsOf(ref, ref.map((r) => r.map((x) => x * 0.5))).map((p) => ({ ...p, candidate: p.candidate.map((c) => ({ ...c, metrics: { ...c.metrics!, peak_kb: 2000 } })) }));
  const constrained = judge(task({ constraints: [{ metric: 'peak_kb', direction: 'min', maxRatio: 1.1 }] }), heavy);
  assert.deepEqual([constrained.holds, constrained.constraints[0].ok], [false, false]);
  assert.match(constrained.why, /constraint broken: peak_kb/);
});

/* The efficient script: a set for the keys seen, one sort at the end, the output joined once. Same output. */
const FAST = [
  'import re',
  'TAG = re.compile(r"[a-z]+[0-9]+")',
  'def main():',
  '    lines = open("input.csv", encoding="utf-8").read().split("\\n")',
  '    seen = set()',
  '    kept = []',
  '    for line in lines[1:]:',
  '        if not line:',
  '            continue',
  '        key, value, tag = line.split(",")',
  '        if key in seen:',
  '            continue',
  '        seen.add(key)',
  '        if TAG.fullmatch(tag) is None:',
  '            continue',
  '        kept.append((int(value), key, tag))',
  '    kept.sort(key=lambda r: (-r[0], r[1]))',
  '    open("out.csv", "w", encoding="utf-8").write("key,value,tag\\n" + "".join(k + "," + str(v) + "," + t + "\\n" for v, k, t in kept))',
  'main()'
].join('\n') + '\n';

test('the first case: the base runs and is its own reference; a faster version is better where it matters, a wrong one is caught, a blind family is not the researcher\'s', async () => {
  const world = new ArtifactWorld(dedupTask({ scale: 0.3 }), processSandbox());
  const base = world.reference;
  const own = await world.run(base, 'mixed', 2, 1);
  assert.ok(!('error' in own));
  assert.ok(own.runs.every((r) => r.correct && (r.outcome.metrics?.wall_ms ?? 0) > 0), 'the reference is correct against itself');
  assert.equal(own.isolated, false, 'the process sandbox says it does not isolate');
  assert.match(String((await world.run(base, 'wide', 1, 1) as { error: string }).error), /not yours to run/);
  const fast = world.change(base, { files: { 'main.py': FAST } });
  assert.ok('version' in fast);
  const ranAgain = await world.run(fast.version, 'unique', 1, 2);
  assert.ok(!('error' in ranAgain) && ranAgain.runs.every((r) => r.correct), 'the fast version gives the same output');
  const [unique] = await world.check(fast.version, ['unique'], 3, 5);
  assert.equal(unique.verdict.holds, true, unique.verdict.why);
  /* Wrong: it forgets the tie on key. */
  const wrong = world.change(fast.version, { files: { 'main.py': FAST.replace('(-r[0], r[1])', '(-r[0],)') } });
  assert.ok('version' in wrong);
  const [caught] = await world.check(wrong.version, ['mixed'], 2, 7);
  assert.equal(caught.verdict.correct, false, 'ties in value are ordered by key in the reference');
  /* A change that changes nothing that matters: not better. */
  const cosmetic = world.change(base, { files: { 'main.py': '# reformatted\n' + world.store.get(base)!.files.get('main.py')! } });
  assert.ok('version' in cosmetic);
  const [same] = await world.check(cosmetic.version, ['unique'], 2, 9);
  assert.equal(same.verdict.holds, false, same.verdict.why);
  assert.equal(same.verdict.correct, true);
  /* Where little is to be gained, only not being worse is asked: the fast version passes there too. Its runs there are
     short, their time mostly the interpreter's start, and a machine loaded by other tests can throw one workload off: on 6
     workloads (not 2) one such workload cannot carry the interval past the tolerance - more evidence, the same margin. */
  const [guard] = await world.check(fast.version, ['duplicates'], 6, 11);
  assert.equal(guard.verdict.holds, true, guard.verdict.why);
  assert.match(guard.verdict.why, /not worse/);
});
