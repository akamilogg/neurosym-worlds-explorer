import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendReflection, beliefOf, classifyTrigger, reflectionWindow, reviseBelief, revisionsByState, selectCases,
  truthLabelCounts, witness, foldAtomStat, type Revision, type AtomStat
} from '../src/learn/evidence.ts';
import { foxhounds, SIDE_CATS } from '../src/worlds/foxhounds/world.ts';
import { loadHarness, mulberry32, sampleStates } from './support.ts';

/* L2 parity: what counts as evidence (revisions, the per-rule witness, the cases a reviewer asks for, the
   trigger of a consult, grouped reflections) is decided exactly as the baseline harness decided it. */

const plain = (v: unknown): any => JSON.parse(JSON.stringify(v));
const states = sampleStates(30, 5).filter((s) => !foxhounds.outcome(s).over);
const ATOMS = ['cats_win_forecast', 'mouse_containment', 'cat_formation'];

function randomJev(rnd: () => number) {
  const atoms = Object.fromEntries(ATOMS.map((id) => [id, Math.round(rnd() * 100) / 100]));
  return { winProbability: Math.round(rnd() * 1000) / 1000, confidence: rnd() < 0.2 ? null : Math.round(rnd() * 100) / 100,
    atoms, measured: { mouse_row: Math.floor(rnd() * 8) }, source: rnd() < 0.5 ? 'live' : 'cached-vector' };
}

test('revisions: first sighting, threshold, per-rule delta and the label against the truth match the harness', () => {
  const h = loadHarness().learner;
  const rnd = mulberry32(11);
  const revisions: Revision[] = [];
  let labelled = 0;
  for (const s of states.slice(0, 120)) {
    h.jevBeliefBaseline.clear();
    const verdict = rnd() < 0.5 ? { known: true, winner: rnd() < 0.5 ? 'cats' : 'mouse', plies: 3, reason: 'x' } : null;
    if (verdict) h.oracleCache.set(h.oracleCacheKey(s), verdict); else h.oracleCache.delete(h.oracleCacheKey(s));
    const j1 = randomJev(rnd), j2 = randomJev(rnd);
    assert.equal(h.recordRevision(s, j1, { revisions: [] }), null);
    const theirs = h.recordRevision(s, j2, { revisions: [] });
    const mine = reviseBelief(beliefOf(j1.winProbability, j1.confidence, j1.atoms, j1.measured, s.ply),
      beliefOf(j2.winProbability, j2.confidence, j2.atoms, j2.measured, s.ply),
      { stateKey: foxhounds.key(s), sideToMove: s.turn, source: j2.source, truth: verdict, maximizer: SIDE_CATS });
    assert.deepEqual(plain(mine), plain(theirs));
    if (mine) { revisions.push(mine); if (mine.oracle) labelled++; }
  }
  assert.ok(revisions.length > 50 && labelled > 10);
  h.setRevisions(plain(revisions));
  assert.deepEqual(plain(revisionsByState(revisions)), plain(h.viewRevisions()));
  assert.deepEqual(plain(truthLabelCounts(revisions)), plain(h.truthLabelCounts(revisions)));
  const stats: Record<string, AtomStat> = {};
  for (const r of revisions) foldAtomStat(stats, r);
  assert.deepEqual(plain(witness(stats)), plain(h.buildAtomWitness(revisions)));
});

test('path cases: the four measured selections match the harness, never twice and within the limit', () => {
  const h = loadHarness().learner;
  const rnd = mulberry32(23);
  const rules = h.normalizeRules(h.DEFAULT_RULES, { fallback: h.DEFAULT_RULES, source: 'bootstrap' }).rules;
  h.setMatch(states[0], rules);
  const rootMoves = foxhounds.actions(foxhounds.initial());
  const kinds = new Set<string>();
  for (let trial = 0; trial < 80; trial++) {
    const records = states.slice(trial % 20, trial % 20 + 12).map((s, i) => ({
      state_key: foxhounds.key(s) + '#' + i, ply: s.ply, side_to_move: s.turn,
      V: Math.round(rnd() * 1000) / 1000, confidence: rnd() < 0.15 ? null : Math.round(rnd() * 100) / 100,
      atoms: {}, measurements: {}, formula_hash: null, root_move: foxhounds.actionKey(rootMoves[i % 4]), leafState: s, path: []
    }));
    const limit = 1 + (trial % 6);
    const floor = 0.3 + (trial % 5) * 0.1;
    const best = trial % 5 === 0 ? null : rootMoves[trial % 4];
    h.config.pathCasesLimit = limit;
    const ctx = h.createSearchContext({ rules });
    ctx.leafRecords = records;
    ctx.confidenceFloor = floor;
    const theirs = h.selectPathCases(ctx, best ? { bestMove: best } : null)
      .map((c: any) => ({ kind: c.kind, key: c.state_key, why: c.why, gap: c.gap }));
    const mine = selectCases(records, { bestMoveKey: best ? foxhounds.actionKey(best) : null, limit, floor });
    assert.deepEqual(plain(mine.map((p) => ({ kind: p.kind, key: p.record.state_key, why: p.why, gap: p.extra?.gap }))), plain(theirs));
    assert.ok(mine.length <= limit && new Set(mine.map((p) => p.record.state_key)).size === mine.length);
    for (const p of mine) kinds.add(p.kind);
  }
  assert.equal(kinds.size, 4, [...kinds].join(','));
});

test('the trigger of a consult: contradiction, coin-flip, no belief - in that order, as the harness decides', () => {
  const h = loadHarness().learner;
  const rnd = mulberry32(31);
  const rules = h.normalizeRules(h.DEFAULT_RULES, { fallback: h.DEFAULT_RULES, source: 'bootstrap' }).rules;
  h.setMatch(states[0], rules);
  const seen = new Set<string>();
  for (let i = 0; i < 300; i++) {
    const value = Math.round(rnd() * 100) / 100;
    const floor = 0.3 + Math.round(rnd() * 6) / 10;
    const oracle = rnd() < 0.4 ? { known: true, winner: rnd() < 0.5 ? 'cats' : 'mouse', plies: 4, reason: 'r' } : (rnd() < 0.2 ? { known: false } : null);
    const cases: any[] = [];
    if (rnd() < 0.6) cases.push({ kind: 'near_tie', gap: Math.round(rnd() * 20) / 100 });
    if (rnd() < 0.7) cases.push({ kind: 'decision_support', leaf: { value: Math.round(rnd() * 100) / 100, confidence: rnd() < 0.2 ? null : Math.round(rnd() * 100) / 100 } });
    const theirs = h.courseCorrectionTrigger({ result: { value }, ctx: { pathCases: cases, confidenceFloor: floor }, oracle });
    const described = oracle && oracle.known ? String(h.describeValueAgainstTruth(value, oracle)) : '';
    const tie = cases.find((c) => c.kind === 'near_tie');
    const commit = cases.find((c) => c.kind === 'decision_support');
    const mine = classifyTrigger({
      contradiction: described.indexOf('CONTRADICTION') === 0 ? described : null,
      nearTieGap: tie ? tie.gap : null,
      commit: commit ? { value: commit.leaf.value, confidence: commit.leaf.confidence } : null,
      floor
    });
    assert.deepEqual(mine ? { cls: mine.class, text: mine.text } : null, theirs ? { cls: theirs.class, text: theirs.text } : null);
    if (mine) seen.add(mine.class);
  }
  assert.equal(seen.size, 3);
});

test('reflections: consecutive doubts of one class and side are ONE doubt with a count, as in the harness', () => {
  const h = loadHarness().learner;
  const rnd = mulberry32(47);
  const rules = h.normalizeRules(h.DEFAULT_RULES, { fallback: h.DEFAULT_RULES, source: 'bootstrap' }).rules;
  h.setReflections([]);
  const mine: any[] = [];
  for (let i = 0; i < 80; i++) {
    const s = { ...states[i % states.length], turn: rnd() < 0.7 ? 'cats' : 'mouse', ply: i };
    h.setMatch(s, rules);
    const value = Math.round(rnd() * 100) / 100;
    const calibrated = rnd() < 0.2 ? null : Math.round(rnd() * 100) / 100;
    const cases = rnd() < 0.7 ? [{ kind: 'near_tie', gap: 0.01 }] : [{ kind: 'decision_support', leaf: { value: 0.2, confidence: 0.1 } }];
    const search = { result: { value, calibrated }, ctx: { pathCases: cases, confidenceFloor: 0.45 }, oracle: null };
    const theirs = h.recordReflection(search, []);
    if (!theirs) continue;
    appendReflection(mine, { class: theirs.class, side_to_move: s.turn, ply: s.ply,
      V: Number.isFinite(value) ? value : null, confidence: Number.isFinite(calibrated as number) ? calibrated : null,
      trigger_text: theirs.trigger_text, count: 1 } as any, 24);
  }
  const theirsList = plain(h.getReflections()).map((r: any) => ({ class: r.class, side: r.side_to_move, ply: r.ply, V: r.V, confidence: r.confidence, count: r.count }));
  const mineList = mine.map((r) => ({ class: r.class, side: r.side_to_move, ply: r.ply, V: r.V, confidence: r.confidence, count: r.count }));
  assert.deepEqual(mineList, theirsList);
  const w = reflectionWindow(mine, 6);
  assert.equal(w.kept.length, Math.min(6, mine.length));
  assert.equal(Object.values(w.byClass).reduce((a, b) => a + b, 0), mine.reduce((a, r) => a + (r.count || 1), 0));
});
