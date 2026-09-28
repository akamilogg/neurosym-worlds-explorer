import test from 'node:test';
import assert from 'node:assert/strict';
import { LABS } from '../src/worlds/labs.ts';
import { isGameLab, type LawLab } from '../src/learn/lab.ts';
import { labUsage } from '../src/runtime/lab-runner.ts';
import { mulberry32 } from '../src/worlds/grid/gen.ts';
import { departureAsNext } from '../src/worlds/orbit/predict.ts';
import { toPercept } from '../src/worlds/orbit/world.ts';

/* SPEC-OBJETIVO O9: a world connects as one declaration. What every declaration must keep consistent. */

/* The laboratories whose world runs here (tank@1's runs in a service of its own: test/tank.test.ts). */
const LAW_LABS = Object.entries(LABS).filter(([, l]) => !isGameLab(l) && !(l as LawLab).external) as [string, LawLab][];

for (const [name, lab] of LAW_LABS) {
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
      const place = lab.placeOf(spec, index, options);
      assert.ok(lab.cases(place, 'x', lab.episode(place, mulberry32(index)), 1).length > 0);
      assert.equal(typeof lab.placeInfo(place), 'object');
    }
  });

  test(name + ': the operator has baselines and an agreement that a known answer passes (and, a world written here, its truth)', () => {
    if (lab.truth) assert.ok(lab.truth(spec, options).length > 0);
    assert.equal(Boolean(lab.truth), Boolean(lab.grading), 'a grader only where there is a truth to grade against');
    assert.ok(lab.baselines(spec).length > 0);
    const e = lab.episode(spec, mulberry32(3));
    const [c] = lab.cases(spec, 'ep1', e, 1);
    /* What happened, as an answer: the next row, the mark, or (orbit) the pair the next row showed. */
    const right = 'next' in c ? c.next : 'mark' in c ? c.mark : departureAsNext(c.target, c.state);
    assert.equal(lab.answerIssue(right), null);
    if (lab.compare) assert.deepEqual((lab.compare(right, c.state) as number[]).map((v) => Math.round(v * 1e9)), c.target.map((v: number) => Math.round(v * 1e9)));
    if (!lab.operator?.ablate) assert.ok(lab.agrees(right, c));
    assert.ok(lab.answerIssue({ not: 'an answer' }) !== null);
  });

  test(name + ': --help lists the world options and the common ones', () => {
    const usage = labUsage(lab, 'run');
    for (const o of lab.options) assert.match(usage, new RegExp('--' + o.name));
    assert.match(usage, /--validations/);
  });
}

test('cells: an act the world cannot read is refused without saying why; one it can starts an episode', () => {
  const lab = LABS.cells as LawLab;
  const spec = lab.generate(1, { level: '1', acts: '4' });
  assert.equal(typeof lab.act!.parse({}), 'string');
  const width = lab.at(lab.episode(spec, mulberry32(1)), 0)!.state.rows[0].length;
  const glyph = spec.glyphs[0];
  assert.equal(lab.act!.start(spec, { rows: ['?'.repeat(width)] }, 'act1', undefined as never), null);
  const e = lab.act!.start(spec, lab.act!.parse({ row: glyph.repeat(width) }), 'act1', undefined as never);
  assert.ok(e && lab.steps(e) > 0);
});

test('orbit: its laboratories and family are named as before, and an act is refused where no body can start', () => {
  const lab = LABS.orbit as LawLab;
  const options = Object.fromEntries([...lab.options.map((o) => [o.name, o.default]), ...(lab.flags ?? []).map((f) => [f.name, 'false'])]);
  const spec = lab.generate(3, options);
  const ctx = { seed: 3, options: { ...options, labs: '2' }, family: 4, every: 8, checkEpisodes: 2, confirmPlaces: 3, explore: 4 };
  const places = lab.places!(spec, ctx);
  assert.deepEqual(places.laboratories.map((p) => p.id), ['lab1', 'lab2']);
  assert.equal(places.laboratories[0].spec, spec, 'the first laboratory is the base world');
  assert.deepEqual(places.family.map((p) => p.id), ['setup1', 'setup2', 'setup3', 'setup4']);
  assert.deepEqual(lab.blindPlaces!(spec, 1, 2, ctx).map((p) => p.id), ['blind200020', 'blind200021', 'blind200022']);
  const [x, y] = toPercept.pos(spec.frame, spec.sources[0].pos);
  assert.equal(lab.act!.start(spec, { x, y, vx: 0, vy: 0, m: 1 }, 'act1', ctx), null, 'on top of a body');
  assert.equal(labUsage(lab, 'run').includes('--vary-strength'), true);
});

test('grid: a laboratory with a loop of its own - its options, its tools and its help, with the common ones it uses', () => {
  const lab = LABS.grid;
  assert.ok(isGameLab(lab));
  assert.deepEqual([...lab.tools], ['view', 'inspect', 'act', 'measure', 'replay', 'table']);
  assert.equal(lab.runName(22, {}), 'grid-s22');
  const usage = labUsage(lab, 'run');
  for (const name of ['levels', 'depth', 'variants', 'family-variants', 'reveal-choices', 'resume', 'max-tokens', 'no-regression']) assert.match(usage, new RegExp('--' + name));
  assert.doesNotMatch(usage, /--every|--check-episodes/, 'the points of an episode are not its');
  assert.equal(lab.aliases?.['confirm-boards'], 'confirm-places', 'the earlier runner\'s name still works');
});
