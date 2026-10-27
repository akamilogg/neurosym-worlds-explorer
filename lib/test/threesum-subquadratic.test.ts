import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { judge, mulberry32, type ArtifactTask, type Paired, type RunOutcome } from '../src/artifacts/task.ts';
import { ArtifactWorld } from '../src/artifacts/world.ts';
import { processSandbox } from '../src/artifacts/sandbox.ts';
import { threesumInput, threesumSubquadraticTask, threesumTask } from '../src/artifacts/tasks/threesum.ts';

/* 3SUM below O(n^2): the verdict on how a version's time grows against a quadratic reference, not on its size - a faster
   constant or a fixed cost never passes for growth; the inputs of a wide range never have a triple by chance. */

const outcome = (ms: number): RunOutcome => ({ workload: 'w', exitCode: 0, timedOut: false, metrics: { wall_ms: ms }, output: 'no', stderr: '' });
const task = (): ArtifactTask => threesumSubquadraticTask();
/** Each size twice, and the floor: the reference quadratic with a fixed cost of 150 ms; the candidate as given, with a jitter. */
function pairsOf(candidate: (n: number) => number): Paired[] {
  const sizes = [3, 3, 2000, 2000, 4000, 4000, 8000, 8000];
  return sizes.map((n, i) => {
    const jitter = (k: number) => 1 + 0.02 * Math.sin(i * 7 + k * 3);
    return { workload: { family: 'ladder-none', id: 'w' + i, seed: i, params: { n } },
      reference: [0, 1, 2].map((k) => outcome((150 + 6e-5 * n * n) * jitter(k))), candidate: [0, 1, 2].map((k) => outcome(candidate(n) * jitter(k + 5))) };
  });
}

test('growth: a version holds only where its time over the quadratic reference\'s falls as n grows', () => {
  const sub = judge(task(), pairsOf((n) => 150 + 2e-3 * n ** 1.5));
  assert.equal(sub.holds, true, sub.why);
  assert.ok(sub.growth!.slope < -0.3, String(sub.growth!.slope));
  assert.deepEqual(sub.growth!.sizes, [2000, 4000, 8000]);
  /* Quadratic, three times faster, with a heavier start: a constant, never growth. */
  const faster = judge(task(), pairsOf((n) => 400 + 2e-5 * n * n));
  assert.equal(faster.holds, false, faster.why);
  assert.match(faster.why, /does not grow more slowly/);
  /* Without setting its fixed cost apart, that one would have looked like growth. */
  const naive = Math.log(((400 + 2e-5 * 8000 ** 2) / (150 + 6e-5 * 8000 ** 2)) / ((400 + 2e-5 * 2000 ** 2) / (150 + 6e-5 * 2000 ** 2))) / Math.log(4);
  assert.ok(naive < -0.05, 'the trap it avoids: ' + naive);
  /* The same as the reference: no growth either way. */
  assert.equal(judge(task(), pairsOf((n) => 150 + 6e-5 * n * n)).holds, false);
  assert.deepEqual(judge(task(), pairsOf((n) => 150 + 2e-3 * n ** 1.5)), sub, 'the same measures, the same verdict');
  /* One workload per size: the repetitions' variation is still in its interval - noise is never growth. */
  const one = pairsOf((n) => 150 + 6e-5 * n * n).filter((_, i) => i % 2 === 0);
  one.forEach((p, i) => { (p.candidate as RunOutcome[]).splice(0, 3, ...[0.8, 1, 1.25].map((k) => outcome((150 + 6e-5 * Number(p.workload.params.n) ** 2) * (i % 2 ? k : 1 / k)))); });
  const noisy = judge(task(), one);
  assert.equal(noisy.holds, false, noisy.why);
  assert.ok(noisy.growth!.interval[1] - noisy.growth!.interval[0] > 0.05, 'its interval is not a point: ' + noisy.growth!.interval);
  /* Work too faint to stand out from the fixed cost: not read, never a slope made of noise. */
  const faint = pairsOf((n) => 150).map((p) => ({ ...p, reference: p.reference.map((r) => outcome(150 + Number(p.workload.params.n) / 1000)) }));
  assert.match(judge(task(), faint).why, /does not stand out from its fixed cost/);
  /* Nothing at the floor: its growth cannot be read. */
  const noFloor = pairsOf((n) => 150 + 2e-3 * n ** 1.5).filter((p) => p.workload.params.n !== 3);
  assert.match(judge(task(), noFloor).why, /could not be read/);
});

test('the inputs: a wide range never has a triple by chance; planted ones always do; threesum@1 unchanged', () => {
  const has = (text: string) => {
    const a = text.split('\n')[1].split(' ').map(Number).sort((x, y) => x - y);
    for (let i = 0; i < a.length - 2; i++) { let lo = i + 1, hi = a.length - 1; while (lo < hi) { const t = a[i] + a[lo] + a[hi]; if (t === 0) return true; if (t < 0) lo++; else hi--; } }
    return false;
  };
  const t = threesumSubquadraticTask();
  const count = (id: string) => { const ws = t.families.find((f) => f.id === id)!.workloads(3, 2); return [ws.filter((w) => has(threesumInput(w))).length, ws.length]; };
  assert.deepEqual(count('ladder-none'), [0, 8]);
  assert.deepEqual(count('ladder-late'), [8, 8]);
  assert.equal(count('ladder')[0], 4, 'every other one');
  /* The draws of a range within 2^32 values are as they were: the workloads of threesum@1 are the same. */
  const old = threesumTask().families.find((f) => f.id === 'large')!.workloads(1, 1)[0];
  const rnd = mulberry32(old.seed);
  const first = Array.from({ length: 3 }, () => Math.floor(rnd() * (2 * 1e9 + 1)) - 1e9);
  assert.deepEqual(threesumInput(old).split('\n')[1].split(' ').slice(0, 3).map(Number), first);
  assert.ok(fs.readFileSync(path.join(t.base, 'main.py'), 'utf8').includes('lo, hi = i + 1, n - 1'), 'its base is the quadratic one');
});

test('a world of it, small: the base never holds against itself; the cubic is correct but does not hold; a fixed answer is caught', async () => {
  /* Large enough that the work stands out from starting Python. */
  const big = new ArtifactWorld(threesumSubquadraticTask({ scale: 0.3 }), processSandbox());
  const [self] = await big.check(big.reference, ['ladder-none'], 1, 3);
  assert.equal(self.verdict.holds, false, self.verdict.why);
  assert.ok(self.verdict.correct && self.verdict.growth, self.verdict.why);
  /* Small, for the cubic to end in time. */
  const world = new ArtifactWorld(threesumSubquadraticTask({ scale: 0.05 }), processSandbox());
  const cubic = world.change(world.reference, { files: { 'main.py': fs.readFileSync(path.join(threesumTask().base, 'main.py'), 'utf8') } }, { why: 'w', exploratory: true });
  assert.ok('version' in cubic);
  const [c] = await world.check(cubic.version, ['ladder-none'], 1, 5);
  assert.equal(c.verdict.holds, false);
  assert.ok(c.verdict.correct, c.verdict.why);
  const fixed = world.change(world.reference, { files: { 'main.py': 'open("out.txt", "w").write("no\\n")\n' } }, { why: 'w', exploratory: true });
  assert.ok('version' in fixed);
  const [f] = await world.check(fixed.version, ['ladder'], 1, 7);
  assert.equal(f.verdict.correct, false, 'a triple is planted in every other workload');
});

test('@2: a version wrong where it is small - zero with both signs taken for a triple - is caught at the floor; @1 as it was', async () => {
  /* The shortcut two evolved programs took (27/10/2026): a zero and both signs present, taken for a triple. */
  const WRONG = 'def main():\n    lines = open("input.txt", encoding="utf-8").read().split("\\n")\n    n = int(lines[0])\n    a = sorted(int(x) for x in lines[1].split()[:n])\n'
    + '    answer = "no"\n    if 0 in a and a[0] < 0 < a[-1]:\n        answer = "yes"\n    else:\n        for i in range(n - 2):\n            lo, hi = i + 1, n - 1\n'
    + '            while lo < hi:\n                t = a[i] + a[lo] + a[hi]\n                if t == 0:\n                    answer = "yes"\n                    break\n                if t < 0:\n                    lo += 1\n                else:\n                    hi -= 1\n            if answer == "yes":\n                break\n'
    + '    open("out.txt", "w", encoding="utf-8").write(answer + "\\n")\n\n\nmain()\n';
  const v2 = new ArtifactWorld(threesumSubquadraticTask({ scale: 0.02, version: 2 }), processSandbox());
  assert.equal(v2.task.id, 'threesum-subquadratic@2');
  const wrong2 = v2.change(v2.reference, { files: { 'main.py': WRONG } }) as { version: string };
  const [c2] = await v2.check(wrong2.version, ['ladder-none'], 1, 3);
  assert.equal(c2.verdict.correct, false, 'caught at the floor of @2');
  const [ok2] = await v2.check(v2.reference, ['ladder-none'], 1, 3);
  assert.equal(ok2.verdict.correct, true, 'the reference is right there');
  /* @1, as it was: the same workloads (its floor n = 3 in the wide range), and the wrong version not caught. */
  const v1 = threesumSubquadraticTask({ scale: 0.02 });
  assert.equal(v1.id, 'threesum-subquadratic@1');
  const ws = v1.families.find((f) => f.id === 'ladder-none')!.workloads(3, 1);
  assert.deepEqual(ws.map((w) => [w.id, w.params.n, w.params.range]), [['ladder-none-3-3-0', 3, 1e12], ['ladder-none-3-40-0', 40, 1e12], ['ladder-none-3-80-0', 80, 1e12], ['ladder-none-3-160-0', 160, 1e12]]);
  assert.equal(v1.objective.growth!.floor, 3);
  const w1 = new ArtifactWorld(v1, processSandbox());
  const wrong1 = w1.change(w1.reference, { files: { 'main.py': WRONG } }) as { version: string };
  const [c1] = await w1.check(wrong1.version, ['ladder-none'], 1, 3);
  assert.equal(c1.verdict.correct, true, 'the hole @2 closes');
  /* @2's floor: small, narrow, with zeros and planted triples among them. */
  const e = threesumSubquadraticTask({ version: 2 }).families[0].workloads(1, 1).filter((w) => Number(w.params.n) <= 5);
  assert.ok(e.length >= 16 && e.every((w) => w.params.range === 3 && Number(w.params.n) <= 5) && e.some((w) => w.params.planted === 'random'));
});
