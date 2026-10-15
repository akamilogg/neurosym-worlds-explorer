import test from 'node:test';
import assert from 'node:assert/strict';
import { ArtifactWorld } from '../src/artifacts/world.ts';
import { processSandbox } from '../src/artifacts/sandbox.ts';
import { threesumInput, threesumTask } from '../src/artifacts/tasks/threesum.ts';

/* The second artifact task, 3SUM: decided, not found - correct where it answers what the reference answers. Correctness
   only here (times vary with the machine; test/artifact-world.test.ts measures them on the first case). */

const QUADRATIC = [
  'def main():',
  '    lines = open("input.txt", encoding="utf-8").read().split("\\n")',
  '    n = int(lines[0])',
  '    a = sorted(int(x) for x in lines[1].split()[:n])',
  '    answer = "no"',
  '    for i in range(n - 2):',
  '        lo, hi = i + 1, n - 1',
  '        while lo < hi:',
  '            s = a[i] + a[lo] + a[hi]',
  '            if s == 0:',
  '                answer = "yes"',
  '                break',
  '            if s < 0:',
  '                lo += 1',
  '            else:',
  '                hi -= 1',
  '        if answer == "yes":',
  '            break',
  '    open("out.txt", "w", encoding="utf-8").write(answer + "\\n")',
  'main()', ''].join('\n');
const ALWAYS_NO = 'open("out.txt", "w", encoding="utf-8").write("no\\n")\n';

test('3SUM: a triple planted where asked, at random or at the end; none fixed in advance', () => {
  const at = (planted: string) => threesumInput({ family: 'x', id: 'x', seed: 7, params: { n: 50, range: 1e9, planted } });
  const nums = (text: string) => text.split('\n')[1].split(' ').map(Number);
  const end = nums(at('end'));
  assert.equal(end[47] + end[48] + end[49], 0, 'at the end');
  const random = nums(at('random'));
  let found = false;
  for (let i = 0; i < 50 && !found; i++) for (let j = i + 1; j < 50 && !found; j++) for (let k = j + 1; k < 50; k++) if (random[i] + random[j] + random[k] === 0) { found = true; break; }
  assert.ok(found, 'at random positions');
  assert.equal(threesumInput({ family: 'x', id: 'x', seed: 7, params: { n: 50, range: 1e9, planted: 'none' } }), threesumInput({ family: 'x', id: 'x', seed: 7, params: { n: 50, range: 1e9, planted: 'none' } }), 'a seed, the same input');
});

test('3SUM: the base is its own reference; a quadratic version answers the same everywhere; a fixed "no" is caught where a triple was planted', async () => {
  const world = new ArtifactWorld(threesumTask({ scale: 0.3 }), processSandbox());
  const base = await world.run(world.reference, 'mixed', 2, 1);
  assert.ok(!('error' in base) && base.runs.every((r) => r.correct), 'the base, against itself');
  const fast = world.change(world.reference, { files: { 'main.py': QUADRATIC } });
  assert.ok(!('error' in fast));
  for (const f of ['mixed', 'large', 'dense']) {
    const e = await world.run((fast as { version: string }).version, f, 2, 3);
    assert.ok(!('error' in e) && e.runs.every((r) => r.correct), 'correct in ' + f);
  }
  const wrong = world.change(world.reference, { files: { 'main.py': ALWAYS_NO } });
  const caught = await world.run((wrong as { version: string }).version, 'mixed', 2, 1);
  assert.ok(!('error' in caught) && caught.runs.some((r) => !r.correct), 'an answer fixed in advance does not pass');
  assert.match(String((await world.run(world.reference, 'late', 1, 1) as { error?: string }).error), /not yours/, 'the blind family is not the researcher\'s to run');
});
