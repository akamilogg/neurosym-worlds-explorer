import test from 'node:test';
import assert from 'node:assert/strict';
import { episodeOf, keyMoments, roundCited, synthesize } from '../src/view/synthesis.ts';

/* A run in miniature: the environment's episodes, an act that becomes evidence, a failing check, a revision that holds,
   a validation and the acceptance - the shape every journal has. */
const journal = {
  experiment: 'cells@1', started: '2026-09-27T14:23:06.122Z', config: { seed: 1, level: 2, llm_model: 'm' },
  hidden_from_the_learner: { spec: { id: 'cells@1:s1L2' }, truth: [{ id: 'rule', statement: 's' }] },
  events: [
    { t: 0, type: 'exploration_episode', episode: 'ep1' },
    { t: 0, type: 'exploration_episode', episode: 'ep2' },
    { t: 3, type: 'investigation', round: 1, requests: [{ view: 'ep1', from: 0, to: 5 }], results: [{}] },
    { t: 5, type: 'investigation', round: 1, requests: [{ act: { row: '..#' } }, { measure: { source: 'x' }, on: ['ep2@3'] }], results: [{ accepted: true, name: 'act3' }, {}],
      notes: [{ do: 'write', id: 'theory', text: 't' }] },
    { t: 9, type: 'proposal', round: 1, rationale: 'r1', beliefs: [{ id: 'wide', stance: 'new', statement: 'a wide window', evidence: ['act3@0'] }], law: { observations: {}, rules: {}, output: '(p)=>1' }, fingerprint: 'f1' },
    { t: 10, type: 'check', round: 1, attempt: 1, laboratories: [{ place: 'lab1', holds: false, exact: 3, points: 16 }], asked_to_validate: false, accepted: false },
    { t: 12, type: 'investigation', round: 2, requests: [{ view: 'ep2', from: 0, to: 3 }], results: [{}] },
    { t: 14, type: 'proposal', round: 2, rationale: 'r2', beliefs: [{ id: 'wide', stance: 'revise', statement: 'radius two', evidence: ['ep2@23', 'round 1'] }], law: { observations: {}, rules: { a: {} }, output: '(p)=>2' } },
    { t: 15, type: 'check', round: 2, attempt: 2, laboratories: [{ place: 'lab1', holds: true, exact: 16, points: 16 }], accepted: false },
    { t: 17, type: 'check', round: 3, attempt: 3, reused_check_of_round: 2, laboratories: [{ place: 'lab1', holds: true, exact: 16, points: 16 }], asked_to_validate: true,
      validation: { family: [{ place: 'place1', holds: true, exact: 16, points: 16 }], became_laboratories: [], blind_confirmation: { confirmed: true, sets: [{ ok: true }, { ok: true }] } }, accepted: true },
    { t: 20, type: 'reflection', round: 4, rationale: 'looking back', lessons: ['l1'] },
    { t: 21, type: 'operator_rule_recovery', truth: [{ id: 'rule' }], grades: [{ id: 'rule', grade: 'exact' }], score: 1, form: 'table' },
    { t: 22, type: 'end', stoppedBy: 'accepted', final: { observations: {}, rules: { a: {} }, output: '(p)=>2' }, operator_summary: { rounds: 3 },
      notebook: { beliefs: [{ id: 'wide', statement: 'radius two', status: 'confirmed', history: [
        { round: 1, stance: 'new', statement: 'a wide window', evidence: ['act3@0'] },
        { round: 2, stance: 'revise', statement: 'radius two', evidence: ['ep2@23', 'round 1'] }] }] } }
  ]
};

test('references: the episode a point names, and the round a belief cites', () => {
  assert.equal(episodeOf('g9@10'), 'g9');
  assert.equal(episodeOf('check1-lab1-2@23'), 'check1-lab1-2');
  assert.equal(episodeOf('act18'), 'act18');
  assert.equal(episodeOf('round 3'), null);
  assert.equal(roundCited('round 3'), 3);
});

test('a synthesis: moments, the progress of the checks, the beliefs, and what the operator kept apart', () => {
  const s = synthesize(journal);
  assert.equal(s.meta.outcome, 'accepted');
  assert.equal(s.meta.acceptedRound, 3);
  assert.equal(s.meta.world, 'cells@1:s1L2');
  assert.deepEqual(s.progress.map((p) => [p.round, Math.round(p.value * 100), p.held, p.accepted, p.reused]), [[1, 19, false, false, false], [2, 100, true, false, false], [3, 100, true, true, true]]);
  assert.deepEqual(s.moments.map((m) => m.kind), ['environment', 'environment', 'investigate', 'investigate', 'propose', 'check', 'investigate', 'propose', 'check', 'check', 'validate', 'reflect']);
  assert.equal(s.beliefs[0].steps.length, 2);
  assert.equal(s.operator.score, 1);
  assert.equal(s.operator.form, 'table');
  assert.deepEqual(s.finalModel, { observations: {}, rules: { a: {} }, output: '(p)=>2' });
});

test('relevance and the path: what the surviving belief cites is on the path; unused looks are not', () => {
  const s = synthesize(journal);
  const byTitle = (f: (m: (typeof s.moments)[number]) => boolean) => s.moments.find(f)!;
  const act = byTitle((m) => m.refs.includes('act3'));
  const firstView = byTitle((m) => m.kind === 'investigate' && m.refs.includes('ep1'));
  assert.ok(act.onPath && act.relevance > firstView.relevance, 'the act the belief cites outranks a look nobody cited');
  assert.equal(firstView.onPath, false);
  assert.ok(byTitle((m) => m.kind === 'environment' && m.refs[0] === 'ep2').onPath, 'the episode cited by the final belief');
  assert.ok(byTitle((m) => m.kind === 'check' && m.round === 1).onPath, 'the check the belief cites ("round 1")');
  assert.ok(s.moments.filter((m) => m.kind === 'propose').every((m) => m.onPath));
  const key = keyMoments(s, { threshold: 0.6 });
  assert.ok(key.some((m) => m.kind === 'validate'));
  assert.ok(key.every((m, i) => i === 0 || m.t >= key[i - 1].t), 'in the order they happened');
  assert.ok(keyMoments(s, { pathOnly: true, threshold: 0 }).every((m) => m.onPath));
  assert.equal(keyMoments(s, { threshold: 0, max: 3 }).length, 3);
});

test('older journals: laboratories as { held } (orbit) and no notebook (beliefs rebuilt from stances)', () => {
  const s = synthesize({ experiment: 'orbit@1', config: {}, events: [
    { t: 1, type: 'proposal', round: 1, beliefs: [{ id: 'b', stance: 'new', statement: 'x' }] },
    { t: 2, type: 'check', round: 1, laboratories: { held: { lab1: true, lab2: false } }, accepted: false },
    { t: 3, type: 'proposal', round: 2, beliefs: [{ id: 'b', stance: 'drop' }] }
  ] });
  assert.equal(s.progress[0].value, 0.5);
  assert.equal(s.beliefs[0].status, 'dropped');
  assert.equal(s.meta.outcome, 'unfinished');
});

test('a table of positions is read into bodies, for the animation', async () => {
  const { readPositions } = await import('../src/view/animate.ts');
  const table = '         t          + x          + y          ^ x          ^ y\n     0.000     7.5     2.2     1.0     1.0\n     0.518     7.5     2.2     1.1     1.07';
  const p = readPositions(table)!;
  assert.deepEqual(p.t, [0, 0.518]);
  assert.deepEqual(p.bodies.map((b) => b.glyph), ['+', '^']);
  assert.deepEqual(p.bodies[1].x, [1.0, 1.1]);
  assert.equal(readPositions('not a table'), null);
});
