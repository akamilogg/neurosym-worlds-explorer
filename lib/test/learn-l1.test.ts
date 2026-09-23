import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFormula } from '../src/core/formula.ts';
import type { Formula } from '../src/core/types.ts';
import {
  changeKinds, describeChange, diffFormulas, hasEvaluableChange, narrowFormula, toFormulaDiff
} from '../src/learn/diff.ts';
import { judgeMeasured, prefilter } from '../src/learn/judges.ts';
import { validateEvidenceRef, type CitableEvidence } from '../src/learn/gates.ts';
import { loadHarness, mulberry32, readJson } from './support.ts';

/* L1 parity: the learner's algebra (diff, description, typed diff, narrow), the prefilter, the measured
   judge and the provenance gate reproduce the baseline harness on a large family of real mutations. */

const plain = (v: unknown): any => JSON.parse(JSON.stringify(v));

/** The harness rule set as a library Formula shell (observations kept in the harness format: the learner
    compares specs, it never executes them). */
function shellOf(rules: any): Formula {
  return makeFormula({
    world: 'foxhounds@1',
    observations: rules.observations || {},
    rules: rules.battery || {},
    weights: rules.weights || {},
    policy_weights: rules.policyWeights || {},
    confidence_floor: rules.confidenceFloor,
    meta: { version: rules.version, source: rules.source, rationale: rules.rationale, evidence: rules.evidence ?? null, warnings: rules.warnings || [] }
  });
}

function mutations(base: any, rnd: () => number): any[] {
  const clone = (): any => plain(base);
  const ids = Object.keys(base.battery);
  const obsIds = Object.keys(base.observations);
  const out: any[] = [];
  const pick = <T>(list: T[]): T => list[Math.floor(rnd() * list.length)];
  for (let i = 0; i < 40; i++) {
    const c = clone();
    c.version = base.version + 1 + Math.floor(rnd() * 3);
    c.rationale = 'mutation ' + i;
    const n = 1 + Math.floor(rnd() * 3);
    for (let k = 0; k < n; k++) {
      const what = Math.floor(rnd() * 11);
      const id = pick(ids);
      if (what === 0) { for (const w of Object.keys(c.weights)) c.weights[w] = Math.round(rnd() * 100) / 100; }
      else if (what === 1 && c.battery[id]) c.battery[id].instructions += ' Consider {{' + pick(obsIds) + '}} too.';
      else if (what === 2 && c.battery[id]) {
        if (Array.isArray(c.battery[id].criteria)) c.battery[id].criteria = c.battery[id].criteria.slice(0, -1);
        else c.battery[id].criteria.draw = 'rewritten ' + i;
      }
      else if (what === 3) c.battery['new_q_' + i] = { type: 'noul', used_as: 'value', instructions: 'Fresh {{' + pick(obsIds) + '}}', criteria: { yes: 'a', no: 'b' } };
      else if (what === 4 && ids.length > 1) delete c.battery[id];
      else if (what === 5) c.observations['obs_' + i] = { spec: { kind: 'op', op: 'mouse_mobility', args: {} }, range: [0, 4] };
      else if (what === 6) delete c.observations[pick(obsIds)];
      else if (what === 7) { const o = pick(obsIds); c.observations[o] = { ...c.observations[o], spec: { kind: 'op', op: 'mouse_routes', args: { cap: 1 + (i % 8) } } }; }
      else if (what === 8) c.confidenceFloor = Math.round((0.3 + rnd() * 0.6) * 100) / 100;
      else if (what === 9) c.policyWeights = { some_policy: rnd() };
      else if (what === 10 && c.battery[id] && c.battery[id].type === 'choice') c.battery[id].option = 'mouse_win';
    }
    out.push(c);
  }
  const proseOnly = clone(); proseOnly.rationale = 'only prose'; proseOnly.version = base.version + 1;
  if (proseOnly.observations[obsIds[0]]) proseOnly.observations[obsIds[0]].definition = 'reworded, same spec';
  out.push(proseOnly);
  return out;
}

const journal = readJson('runs/2026-09-21-run-journal.json');
function bases(h: any): any[] {
  return [
    h.normalizeRules(h.DEFAULT_RULES, { fallback: h.DEFAULT_RULES, source: 'bootstrap' }).rules,
    plain({ ...journal.accepted, confidenceFloor: journal.accepted.confidence_floor, policyWeights: journal.accepted.policy_weights })
  ];
}

test('the formula algebra reproduces the harness: diff, kinds, evaluable, description, typed diff', () => {
  const h = loadHarness().learner;
  const rnd = mulberry32(42);
  let compared = 0;
  for (const base of bases(h)) {
    for (const cand of mutations(base, rnd)) {
      const a = shellOf(base), b = shellOf(cand);
      assert.deepEqual(plain(diffFormulas(a, b)), plain(h.diffRuleSets(base, cand)));
      assert.deepEqual(changeKinds(diffFormulas(a, b)), Array.from(h.ruleChangeKinds(h.diffRuleSets(base, cand))));
      assert.equal(describeChange(a, b), h.describeRuleChange(base, cand));
      const mine = plain(toFormulaDiff(a, b));
      const theirs = plain(h.toRuleDiff(base, cand));
      assert.deepEqual(mine, theirs);
      compared++;
    }
  }
  assert.ok(compared >= 80);
  const prose = mutations(bases(h)[1], mulberry32(1)).pop();
  assert.equal(hasEvaluableChange(shellOf(bases(h)[1]), shellOf(prose)), false, 'prose and definitions are not learning');
});

test('narrow reproduces the harness: weights re-settled over the conserved rules, version above the ledger', () => {
  const h = loadHarness().learner;
  const rnd = mulberry32(7);
  for (const base of bases(h)) {
    const ledger = [{ version: base.version }, { version: base.version + 5 }];
    h.setLedger(ledger);
    for (const cand of mutations(base, rnd)) {
      const kinds = Array.from(h.toRuleDiff(base, cand).narrowable) as string[];
      const theirs = h.narrowRuleSet(base, cand, kinds);
      const mine = narrowFormula(shellOf(base), shellOf(cand), kinds, ledger.map((l) => l.version));
      if (!theirs) { assert.equal(mine, null); continue; }
      assert.ok(mine);
      assert.deepEqual(plain(mine!.weights), plain(theirs.weights));
      assert.deepEqual(plain(mine!.policy_weights), plain(theirs.policyWeights || {}));
      assert.equal(mine!.confidence_floor, theirs.confidenceFloor);
      assert.equal(mine!.meta!.version, theirs.version);
      assert.equal(mine!.meta!.source, theirs.source);
      assert.deepEqual(plain(mine!.meta!.narrowed_from), plain(theirs.narrowed_from));
      assert.deepEqual(plain(mine!.meta!.warnings), plain(theirs.warnings));
      assert.deepEqual(plain(mine!.rules), plain(theirs.battery), 'the conserved battery is the previous one');
    }
  }
});

test('the prefilter and the measured judge (J1/J2/narrow/silence) reproduce the harness', () => {
  const h = loadHarness().learner;
  const rnd = mulberry32(99);
  let decisions = new Map<string, number>();
  for (const base of bases(h)) {
    const ids = Object.keys(base.battery);
    h.setLedger([{ version: base.version }]);
    for (const cand of mutations(base, rnd)) {
      const n = Math.floor(rnd() * 5);
      const cases = Array.from({ length: n }, () => ({ leaf: { atoms: Object.fromEntries(ids.map((id) => [id, Math.round(rnd() * 100) / 100])) } }));
      const contradicted = rnd() < 0.3;
      const pfMine = prefilter(shellOf(base), shellOf(cand), cases.map((c) => c.leaf));
      assert.deepEqual(plain(pfMine), plain(h.prefilterCandidate(base, cand, cases)));
      const theirs = h.judgeRuleDiffMeasured(base, cand, { cases, contradicted, oracle: { known: true } });
      const mine = judgeMeasured(shellOf(base), shellOf(cand), { cases: cases.map((c) => c.leaf), contradicted, ledgerVersions: [base.version] });
      if (theirs === null) { assert.equal(mine, null); decisions.set('silent', (decisions.get('silent') || 0) + 1); continue; }
      assert.ok(mine);
      assert.equal(mine!.decision, theirs.decision);
      assert.equal(mine!.reason, theirs.reason);
      assert.deepEqual(plain(mine!.applied_fields), plain(theirs.applied_fields));
      assert.deepEqual(plain(mine!.diff), plain(theirs.diff));
      decisions.set(mine!.decision, (decisions.get(mine!.decision) || 0) + 1);
    }
  }
  assert.ok(decisions.size >= 3, 'the family exercises several verdicts: ' + JSON.stringify([...decisions]));
});

test('J0: a proposal made with evidence in hand must cite it, exactly as the harness requires', () => {
  const h = loadHarness().learner;
  const briefs: Array<{ opts: any; evidence: CitableEvidence | null }> = [
    { opts: {}, evidence: null },
    { opts: { pathBrief: { cases: [{}, {}, {}] } }, evidence: { cases: 3 } },
    { opts: { consolidationBrief: { reflections: [{}] } }, evidence: { cases: 1 } },
    { opts: { pathBrief: { cases: [] } }, evidence: { cases: 0 } },
    { opts: { lossReport: { truth: [{ state_key: 'A' }, { state_key: 'B' }], blunder_state_key: 'Z' } }, evidence: { truthKeys: ['A', 'B'], anchorKey: 'Z' } },
    { opts: { lossReport: { truth: [] } }, evidence: { truthKeys: [] } },
    { opts: { operatorDirective: 'advance in formation' }, evidence: { directive: true } },
    { opts: { operatorDirective: 'x', pathBrief: { cases: [{}] } }, evidence: { directive: true, cases: 1 } }
  ];
  const refs: any[] = [undefined, null, {}, { case: 0 }, { case: 2 }, { case: 5 }, { case: -1 }, { case: 1.5 },
    { state_key: 'A' }, { state_key: 'Z' }, { state_key: 'nope' }, { operator_directive: true }, { operator_directive: true, case: 9 }];
  for (const b of briefs) {
    for (const ref of refs) {
      const proposal = ref === undefined ? { version: 1 } : { version: 1, evidence_ref: ref };
      assert.equal(validateEvidenceRef(ref, b.evidence), h.validateEvidenceRef(proposal, b.opts), JSON.stringify({ b: b.opts, ref }));
    }
  }
});
