import test from 'node:test';
import assert from 'node:assert/strict';
import { runAttempts, type AttemptScore, type LoopHooks } from '../src/learn/loop.ts';

/* L4: the boundary decisions of the attempt loop, scenario by scenario. The harness selftest exercises the same
   decisions end to end through runLearning (which now delegates here). */

type F = { v: number };
const won = (f: F, revised = 0): AttemptScore<F> => ({ formula: f, wins: 3, total: 3, perfect: true, games: [{ outcome: 'cats', plies: 20, midgameChanges: revised }, { outcome: 'cats', plies: 22 }, { outcome: 'cats', plies: 18 }] });
const lost = (f: F, wins: number): AttemptScore<F> => ({ formula: f, wins, total: 3, perfect: false, games: [{ outcome: 'mouse', plies: 9 }] });

function script(overrides: Partial<LoopHooks<F, string, string>>, scores: Array<(f: F) => AttemptScore<F>>) {
  const trace: string[] = [];
  let i = 0;
  const hooks: LoopHooks<F, string, string> = {
    budget: 6,
    isRunning: () => true,
    measure: async (f) => { trace.push('measure v' + f.v); return scores[Math.min(i++, scores.length - 1)](f); },
    verifyClean: async (f) => { trace.push('clean v' + f.v); return won(f); },
    lossEvidence: (s) => 'loss of v' + s.formula.v,
    nextHypothesis: async (from, _a, ev) => { trace.push('next from v' + from.v + ' (' + ev + ')'); return { v: from.v + 10 }; },
    ...overrides
  };
  return { hooks, trace };
}

test('a clean win is accepted at once', async () => {
  const { hooks, trace } = script({}, [(f) => won(f)]);
  const r = await runAttempts({ v: 1 }, hooks);
  assert.equal(r.stoppedBy, 'accepted');
  assert.equal(r.accepted!.formula.v, 1);
  assert.deepEqual(trace, ['measure v1']);
});

test('a win with mid-game revisions is a hypothesis: re-verified cleanly, accepted only if the frozen formula holds', async () => {
  const ok = script({}, [(f) => won(f, 2)]);
  const r1 = await runAttempts({ v: 1 }, ok.hooks);
  assert.equal(r1.stoppedBy, 'accepted');
  assert.equal(r1.accepted!.cleanVerified, true);
  assert.deepEqual(ok.trace, ['measure v1', 'clean v1']);

  const bad = script({ verifyClean: async (f) => lost(f, 1) }, [(f) => won(f, 1), (f) => won(f)]);
  const r2 = await runAttempts({ v: 1 }, bad.hooks);
  assert.deepEqual(bad.trace, ['measure v1', 'next from v1 (loss of v1)', 'measure v11']);
  assert.equal(r2.accepted!.formula.v, 11);
});

test('the curriculum raises the bar on clean wins; the last winner is the incumbent when nothing wins above it', async () => {
  let bar = 0;
  const { hooks, trace } = script({ budget: 5, escalate: () => (bar < 2 ? (bar++, true) : false) },
    [(f) => won(f), (f) => won(f), (f) => lost(f, 2), (f) => lost(f, 1), (f) => lost(f, 0)]);
  const r = await runAttempts({ v: 1 }, hooks);
  assert.equal(r.escalations, 2);
  assert.equal(r.stoppedBy, 'budget');
  assert.equal(r.accepted, null);
  assert.equal(r.incumbent!.formula.v, 1, 'the ceiling keeps the formula that won at the lower bar');
  assert.deepEqual(trace.slice(0, 3), ['measure v1', 'measure v1', 'measure v1']);
});

test('an operator directive overrides the boundary, including acceptance', async () => {
  let queued: string | null = 'advance in formation';
  const { hooks, trace } = script({
    takeDirective: () => { const d = queued; queued = null; return d; },
    directiveCandidate: async (f, _a, _s, d) => { trace.push('directive: ' + d); return { v: f.v + 100 }; }
  }, [(f) => won(f), (f) => won(f)]);
  const r = await runAttempts({ v: 1 }, hooks);
  assert.deepEqual(trace, ['measure v1', 'directive: advance in formation', 'measure v101']);
  assert.equal(r.accepted!.formula.v, 101);
});

test('a loss consolidates the doubts first, then asks for a hypothesis from the BEST score; no proposal stops the loop', async () => {
  let consolidated = false;
  const { hooks, trace } = script({
    consolidate: async (_a, s) => { if (consolidated) return null; consolidated = true; trace.push('consolidate v' + s.formula.v); return { v: 50 }; },
    nextHypothesis: async (from, _a, ev) => { trace.push('next from v' + from.v + ' (' + ev + ')'); return null; }
  }, [(f) => lost(f, 2), (f) => lost(f, 1)]);
  const r = await runAttempts({ v: 1 }, hooks);
  assert.deepEqual(trace, ['measure v1', 'consolidate v1', 'measure v50', 'next from v1 (loss of v50)']);
  assert.equal(r.stoppedBy, 'no_hypothesis');
  assert.equal(r.best!.formula.v, 1, 'best is the highest score, not the latest');
});

test('the loop stops when the host stops running or no game was played', async () => {
  const a = script({ isRunning: () => false }, [(f) => won(f)]);
  assert.equal((await runAttempts({ v: 1 }, a.hooks)).stoppedBy, 'not_running');
  const b = script({}, [(f) => ({ formula: f, wins: 0, total: 0, perfect: false, games: [] })]);
  assert.equal((await runAttempts({ v: 1 }, b.hooks)).stoppedBy, 'no_games');
});
