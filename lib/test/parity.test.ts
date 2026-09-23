import test from 'node:test';
import assert from 'node:assert/strict';
import { Observer } from '../src/core/observer.ts';
import { foxhounds, SIDE_CATS, SIDE_MOUSE } from '../src/worlds/foxhounds/world.ts';
import { FOXHOUNDS_OPS, foxhoundsDialect } from '../src/worlds/foxhounds/dialect.ts';
import { formulaFromHarness } from '../src/worlds/foxhounds/import-harness.ts';
import { loadHarness, readJson, sampleStates } from './support.ts';

/* P0 contract: the extraction changes NOTHING observable. The library's world and the foxhounds@1
   dialect must agree with fox-hounds-harness.html on every sampled reachable state. */

const states = sampleStates(240);

test('sample covers the game: openings, midgames and every kind of ending', () => {
  const reasons = new Set(states.map((s) => foxhounds.outcome(s).reason).filter(Boolean));
  assert.ok(states.length > 2000, 'states sampled: ' + states.length);
  assert.ok(reasons.has('mouse_trapped') && (reasons.has('mouse_bypassed_cats') || reasons.has('mouse_reached_row_0')), [...reasons].join(','));
});

test('world rules are identical to the harness (moves, transitions, outcome, key)', () => {
  const h = loadHarness();
  for (const s of states) {
    for (const side of [SIDE_CATS, SIDE_MOUSE]) {
      const mine = foxhounds.actions(s, side).map((m) => JSON.stringify(m));
      const theirs = Array.from(h.legalMovesForSide(s, side), (m) => JSON.stringify(m));
      assert.deepEqual(mine, theirs);
    }
    assert.deepEqual(foxhounds.outcome(s), { ...h.isTerminal(s) });
    assert.equal(foxhounds.key(s), h.stateKey(s));
    for (const m of foxhounds.actions(s)) assert.deepEqual(JSON.parse(JSON.stringify(foxhounds.step(s, m))), JSON.parse(JSON.stringify(h.applyMove(s, m))));
  }
});

test('foxhounds@1 ops = harness OBSERVATION_OPS on every state (all 12 ops)', () => {
  const h = loadHarness();
  assert.deepEqual(Object.keys(FOXHOUNDS_OPS).sort(), Object.keys(h.OBSERVATION_OPS).sort());
  const harnessDecls: Record<string, unknown> = {};
  const libDecls: Record<string, any> = {};
  for (const op of Object.keys(FOXHOUNDS_OPS)) {
    const args = op === 'mouse_routes' ? { cap: 8 } : {};
    harnessDecls[op] = { spec: { kind: 'op', op, args } };
    libDecls[op] = { spec: { kind: 'dsl', dialect: 'foxhounds@1', op, args } };
  }
  const observer = new Observer(foxhounds, { dialects: [foxhoundsDialect] });
  let compared = 0;
  for (const s of states) {
    if (foxhounds.outcome(s).reason === 'mouse_reached_row_0' || !s.cats.length) continue;
    const theirs = h.computeObservations(s, harnessDecls);
    const mine = observer.observe(s, libDecls);
    assert.deepEqual(mine.errors, []);
    assert.deepEqual(mine.values, { ...theirs.values });
    compared++;
  }
  assert.ok(compared > 2000);
});

test('the accepted formula of the 21/09 run imports and measures exactly as the harness measured it', () => {
  const h = loadHarness();
  const journal = readJson('runs/2026-09-21-run-journal.json');
  const formula = formulaFromHarness(journal);
  assert.equal(Object.keys(formula.observations).length, 10);
  assert.ok(Object.values(formula.observations).every((d) => d.spec.kind === 'dsl' && (d.spec as any).dialect === 'foxhounds@1'));
  const observer = new Observer(foxhounds, { dialects: [foxhoundsDialect] });
  for (const s of states.slice(0, 1500)) {
    const theirs = h.computeObservations(s, journal.accepted.observations);
    const mine = observer.observe(s, formula.observations);
    assert.deepEqual(mine.values, { ...theirs.values });
  }
});
