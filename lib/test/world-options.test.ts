import test from 'node:test';
import assert from 'node:assert/strict';
import { juniorBrief, worldOptionsIn } from '../src/orchestra/reader.ts';

/* A journal keeps its world options camel-cased, a number-like one as a number - and an option left at its empty default ('')
   as 0. Reading them back, that 0 is the empty default, never the value '0'. */

test('worldOptionsIn: an empty default kept as 0 reads back as the empty default; other values as they were', () => {
  const options = [{ name: 'program-profiles', default: '' }, { name: 'teacher-url', default: '' }, { name: 'searches', default: '1' }, { name: 'edits', default: '0' }, { name: 'lab-python', default: 'python3' }];
  assert.deepEqual(worldOptionsIn(options, { programProfiles: 0, teacherUrl: 'http://t', searches: 0, edits: 3 }),
    { 'program-profiles': '', 'teacher-url': 'http://t', searches: '0', edits: '3', 'lab-python': 'python3' });
});

test('juniorBrief: a junior journal with no program profiles (kept as programProfiles: 0) gives its brief, not a missing file', () => {
  const brief = juniorBrief({ experiment: 'junior-competence@1', researcher: 'assisted', config: { seed: 1, programProfiles: 0, teacherUrl: 0, teacherModel: 0, tools: ['view'], regression: true } });
  assert.equal(typeof brief, 'string');
  assert.ok(brief!.length > 0);
});
