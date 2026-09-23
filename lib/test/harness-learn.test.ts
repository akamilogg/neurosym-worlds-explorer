import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT, sampleStates } from './support.ts';
import { foxhounds } from '../src/worlds/foxhounds/world.ts';

/* Every learner adapter of the WORKING harness runs once (L1 algebra/judges/gates, L2 evidence): the parity
   against the baseline lives in learn-l1/learn-l2; this proves the delegation itself is wired - a missing
   variable or a wrong argument shows here in seconds, not after the 7-minute selftest. */

function loadWorkingHarness(fetchImpl?: (url: string, init: any) => Promise<any>): any {
  const html = fs.readFileSync(path.join(ROOT, 'fox-hounds-harness.html'), 'utf8');
  const source = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  const sandbox: Record<string, unknown> = { console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, setInterval, clearInterval,
    performance: { now: () => Date.now() }, AbortController, fetch: fetchImpl ?? (() => Promise.reject(new Error('offline'))) };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source + ';globalThis.__api = { normalizeRules, DEFAULT_RULES, diffRuleSets, ruleChangeKinds, hasEvaluableRuleChange, ' +
    'describeRuleChange, toRuleDiff, narrowRuleSet, judgeRuleDiffMeasured, prefilterCandidate, prefilterUsableCases, meanAbsEdge, ' +
    'validateEvidenceRef, replayFormulaOnEvidence, highestKnownVersion, recordRevision, viewRevisions, truthLabelCounts, buildAtomWitness, ' +
    'atomWitnessOverRun, buildRevisionDigest, selectPathCases, courseCorrectionTrigger, recordReflection, buildConsolidationBrief, ' +
    'createSearchContext, oracleCache, oracleCacheKey, Telemetry, match, config, createInitialState, judgeRuleDiffConsensus, requestMetaReasoning };', sandbox);
  return sandbox.__api;
}
const plain = (v: unknown): any => JSON.parse(JSON.stringify(v));

test('the delegated learner runs end to end inside the working harness', () => {
  const api = loadWorkingHarness();
  const base = api.normalizeRules(api.DEFAULT_RULES, { fallback: api.DEFAULT_RULES, source: 'bootstrap' }).rules;
  api.match.rules = base;
  api.match.rulesHistory = [base];
  const cand = plain(base);
  cand.version = 4;
  cand.weights = { cats_win_forecast: 0.8, mouse_containment: 0.2 };
  cand.battery.cats_win_forecast.instructions += ' Also weigh {{mouse_routes}}.';

  /* L1 */
  assert.ok(api.hasEvaluableRuleChange(base, cand));
  assert.deepEqual(plain(api.ruleChangeKinds(api.diffRuleSets(base, cand))).sort(), ['battery.instructions:cats_win_forecast', 'weights']);
  assert.match(api.describeRuleChange(base, cand), /cats_win_forecast\.instructions/);
  assert.equal(api.toRuleDiff(base, cand).narrowable.join(), 'weights');
  const narrowed = api.narrowRuleSet(base, cand, ['weights']);
  assert.equal(narrowed.weights.cats_win_forecast, 0.8);
  assert.equal(narrowed.battery.cats_win_forecast.instructions, base.battery.cats_win_forecast.instructions);
  assert.equal(narrowed.version, api.highestKnownVersion(base) + 1);
  const cases = [0.9, 0.2, 0.7].map((v) => ({ leaf: { atoms: { cats_win_forecast: v, mouse_containment: 1 - v } } }));
  assert.equal(api.prefilterUsableCases(cases, base.weights, cand.weights).length, 3);
  assert.ok(api.meanAbsEdge(cases, cand.weights) > 0);
  assert.equal(typeof api.prefilterCandidate(base, cand, cases).ok, 'boolean');
  const verdict = api.judgeRuleDiffMeasured(base, cand, { cases, contradicted: false, oracle: null });
  assert.ok(verdict && ['apply', 'narrow', 'reject'].includes(verdict.decision) && !('narrowed' in verdict));
  assert.equal(api.validateEvidenceRef({ evidence_ref: { case: 0 } }, { pathBrief: { cases: [{}] } }), true);
  assert.equal(api.validateEvidenceRef({}, { pathBrief: { cases: [{}] } }), false);
  const s = sampleStates(3, 9).find((x) => !foxhounds.outcome(x).over)!;
  const replay = api.replayFormulaOnEvidence(base, [{ case_id: 'c0', leaf_state: s }]);
  assert.equal(replay.valid, true, JSON.stringify(plain(replay.errors)));
  assert.equal(replay.rows[0].state_key, foxhounds.key(s));

  /* L2 */
  api.oracleCache.set(api.oracleCacheKey(s), { known: true, winner: 'mouse', plies: 3, reason: 'x' });
  const ctx = api.createSearchContext({ rules: base });
  const jev = (v: number) => ({ winProbability: v, confidence: 0.4, atoms: { cats_win_forecast: v, mouse_containment: v }, measured: { mouse_row: 3 }, source: 'live' });
  assert.equal(api.recordRevision(s, jev(0.2), ctx), null);
  const before = api.Telemetry.revisionsAgainstTruth;
  const rev = api.recordRevision(s, jev(0.6), ctx);
  assert.equal(rev.against_truth, true, 'the value rose where the rules say the Mouse wins');
  assert.equal(api.Telemetry.revisionsAgainstTruth, before + 1);
  api.match.revisions = [rev];
  assert.equal(api.viewRevisions().length, 1);
  assert.equal(api.truthLabelCounts([rev]).against_truth, 1);
  assert.equal(api.buildAtomWitness([rev]).length, 2);
  assert.ok(Array.isArray(api.atomWitnessOverRun()));
  assert.ok(api.buildRevisionDigest());
  ctx.leafRecords = [0.8, 0.78, 0.2].map((v, i) => ({ state_key: 'k' + i, ply: 1, side_to_move: 'mouse', V: v, confidence: 0.2, atoms: {},
    measurements: {}, formula_hash: null, root_move: 'r' + i, leafState: s, path: [] }));
  ctx.confidenceFloor = 0.45;
  const picked = api.selectPathCases(ctx, null);
  assert.ok(picked.length >= 1 && picked[0].leaf.board_ascii && picked[0].leaf_state);
  const trig = api.courseCorrectionTrigger({ result: { value: 0.3 }, ctx: { pathCases: [{ kind: 'near_tie', gap: 0.01 }], confidenceFloor: 0.45 }, oracle: null });
  assert.equal(trig.class, 'coin_flip');
  api.match.state = s;
  api.match.reflections = [];
  const search = { result: { value: 0.3, calibrated: 0.2 }, ctx: { pathCases: [{ kind: 'near_tie', gap: 0.01 }], confidenceFloor: 0.45 }, oracle: null };
  api.recordReflection(search, []);
  api.recordReflection(search, []);
  assert.equal(api.match.reflections.length, 1);
  assert.equal(api.match.reflections[0].count, 2);
  const brief = api.buildConsolidationBrief(1, base, api.match.reflections, { games: [] });
  assert.equal(brief.by_class.coin_flip, 2);
});

test('System 2 and the consensus judge run through the library inside the working harness', async () => {
  const bodies: any[] = [];
  const votes = ['{"decision":"apply","kinds":["weights"],"reason":"a"}', '{"decision":"apply","kinds":[],"reason":"b"}', 'garbage'];
  const api = loadWorkingHarness(async (_u: string, init: any) => {
    bodies.push(JSON.parse(String(init.body)));
    const text = JSON.stringify({ choices: [{ message: { content: votes[(bodies.length - 1) % votes.length] } }] });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  });
  Object.assign(api.config, { llmUrl: 'https://llm.example/v1/chat/completions', llmKey: 'k', llmModel: 'm', llmRetries: 0 });
  const base = api.normalizeRules(api.DEFAULT_RULES, { fallback: api.DEFAULT_RULES, source: 'bootstrap' }).rules;
  const cand = plain(base);
  cand.version = 2;
  cand.weights = { cats_win_forecast: 0.9, mouse_containment: 0.1 };
  const calls = api.Telemetry.llmCalls;
  const verdict = await api.judgeRuleDiffConsensus(base, cand, { cases: [], oracle: null });
  assert.equal(verdict.decision, 'apply');
  assert.deepEqual(plain(verdict.votes), { apply: 2, reject: 0, narrow: 0 });
  assert.equal(api.Telemetry.llmCalls, calls + 3, 'every request is counted');
  assert.equal(api.Telemetry.judgeCalls, 2, 'usable votes only');
  assert.equal(bodies[0].model, 'm');
  assert.ok(!JSON.stringify(bodies[0]).includes(cand.rationale || '@@none@@'), 'the rationale never travels');
  const answer = await api.requestMetaReasoning({ task: 'x' }, {});
  assert.equal(typeof answer.content, 'string');
});
