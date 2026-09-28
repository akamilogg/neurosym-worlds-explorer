import test from 'node:test';
import assert from 'node:assert/strict';
import { LABS } from '../src/worlds/labs.ts';
import { labUsage } from '../src/runtime/lab-runner.ts';
import { mulberry32 } from '../src/worlds/grid/gen.ts';

/* SPEC-OBJETIVO O9: a world connects as one declaration. What every declaration must keep consistent. */

for (const [name, lab] of Object.entries(LABS)) {
  const options = Object.fromEntries(lab.options.map((o) => [o.name, o.default]));
  const spec = lab.generate(1, options);

  test(name + ': the interface offers act and simulate exactly when the laboratory declares them', () => {
    const tools = lab.interface({}).tools;
    assert.equal(tools.includes('act'), Boolean(lab.act));
    assert.equal(tools.includes('simulate'), Boolean(lab.simulate));
  });

  test(name + ': every case of an episode is a point the learner can name, with the same state', () => {
    const e = lab.episode(spec, mulberry32(7));
    const cases = lab.cases(spec, 'ep1', e, 1);
    assert.ok(cases.length > 0);
    for (const c of cases) {
      const at = lab.at(e, Number(c.point.split('@')[1]));
      assert.ok(at, c.point);
      assert.deepEqual(at.state, c.state);
    }
    assert.equal(lab.at(e, -1), null);
    assert.equal(lab.at(e, 10_000), null);
  });

  test(name + ': the family and the blind places are of the same world, and a place is described for the journal', () => {
    for (const index of [1, 2, 1001]) {
      const place = lab.placeOf(spec, index);
      assert.ok(lab.cases(place, 'x', lab.episode(place, mulberry32(index)), 1).length > 0);
      assert.equal(typeof lab.placeInfo(place), 'object');
    }
  });

  test(name + ': the operator has a truth, baselines, and an agreement that a known answer passes', () => {
    assert.ok(lab.truth(spec).length > 0);
    assert.ok(lab.baselines(spec).length > 0);
    const e = lab.episode(spec, mulberry32(3));
    const [c] = lab.cases(spec, 'ep1', e, 1);
    const right = 'next' in c ? c.next : c.mark;
    assert.equal(lab.answerIssue(right), null);
    assert.ok(lab.agrees(right, c));
    assert.ok(lab.answerIssue({ not: 'an answer' }) !== null);
  });

  test(name + ': --help lists the world options and the common ones', () => {
    const usage = labUsage(lab, 'run');
    for (const o of lab.options) assert.match(usage, new RegExp('--' + o.name));
    assert.match(usage, /--validations/);
  });
}

test('cells: an act the world cannot read is refused without saying why; one it can starts an episode', () => {
  const lab = LABS.cells;
  const spec = lab.generate(1, { level: '1', acts: '4' });
  assert.equal(typeof lab.act!.parse({}), 'string');
  const width = lab.at(lab.episode(spec, mulberry32(1)), 0)!.state.rows[0].length;
  const glyph = spec.glyphs[0];
  assert.equal(lab.act!.start(spec, { rows: ['?'.repeat(width)] }), null);
  const e = lab.act!.start(spec, lab.act!.parse({ row: glyph.repeat(width) }));
  assert.ok(e && lab.steps(e) > 0);
});
