/* ============================================================================
 * Validation harness for fox-hounds-harness.html
 * Usage: node fox-hounds-harness.selftest.js
 *
 * The deliverable is the single HTML file. This script proves it works:
 *   1. static gates: the file no longer contains any local evaluator, and the
 *      request/response shapes of the deleted (invented) contract are gone;
 *   2. a STUB of POST /v1/systemone that answers with the documented contract
 *      (choice / score / noul + usage). The stub lives ONLY here: the deliverable
 *      itself has no test double and no offline evaluator;
 *   3. behavioural gates: request shape, value provenance, two-level cache,
 *      search smoke test, and the "no Jev => no game" failure doctrine;
 *   4. the engine self-test embedded in the page, plus a DOM integration pass.
 * Exit code 0 = all green.
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const htmlPath = path.join(__dirname, 'fox-hounds-harness.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) {
  console.error('FAIL no inline <script> block found in ' + htmlPath);
  process.exit(2);
}
const source = scriptMatch[1];

/* --- 1. syntax + structural + purge gates --------------------------------- */
const gates = [];
const gate = function (name, pass, detail) {
  gates.push({ name: name, pass: !!pass, detail: detail === undefined ? '' : String(detail) });
};
try {
  new vm.Script(source, { filename: 'inline.js' });
  gate('the inline script parses cleanly', true);
} catch (error) {
  gate('the inline script parses cleanly', false, error.message);
  console.error('FAIL syntax gate: ' + error.message);
  process.exit(2);
}
gate('exactly one <style> block', (html.match(/<style>/g) || []).length === 1);
gate('exactly one inline <script> block', (html.match(/<script>/g) || []).length === 1);
gate('document closes with </html>', /<\/html>\s*$/.test(html.trim()));

/* The purge is scoped to the engine (everything before the self-test block): the page's
   own self-test legitimately names the removed symbols to assert they are gone. */
const engineSource = source.slice(0, source.indexOf('ENGINE SELF-TEST'));
const FORBIDDEN_CODE = [
  'localHeuristicValue', 'localJevDecision', 'computeFeatures', 'pathInterception',
  'ascentCorridor', 'BLOCKING_PROFILE', 'blendTowardProfile', 'nudgeRulesForEscalation',
  'directedRuleStep', 'applySaturationGuard', 'normalizeJevResponse',
  'resolveJevMode', 'jevRuntime', 'jevLocalFallbacks', 'jevBudgetSkips', 'jevStrictFailures',
  'ruleSchemaPromptText', 'RULE_WEIGHT_SCHEMA', 'defaultRuleWeights', 'HEURISTIC_GAIN',
  'FoxHounds.State', 'win_probability', 'perspective:', 'leafBudget', 'allowNetwork'
];
FORBIDDEN_CODE.forEach(function (needle) {
  gate('purged from the engine: "' + needle + '"', engineSource.indexOf(needle) < 0);
});
/* The documented contract must be present instead. */
gate('calls POST /v1/systemone', html.indexOf('api.typesafe.ai/v1/systemone') >= 0);
gate('sends the required `model` field', html.indexOf('model: config.jevModel') >= 0);
gate('sends a materialised `questions` map (the battery + the policy options)',
  html.indexOf('questions: wire.questions') >= 0 && html.indexOf('function materializeQuestions(battery, state, options)') >= 0);
gate('reads answers.<id> through the declared type, never a fixed id',
  html.indexOf('answer.type !== spec.type') >= 0 && html.indexOf("atomRole(spec) === 'policy'") >= 0 &&
  html.indexOf("spec.type === 'score'") >= 0);
gate('treats Noul as confidence-less', html.indexOf('Noul answers carry none') >= 0);
gate('keeps the neutral weight prior over the live value atoms', html.indexOf('round(1 / keys.length, 4)') >= 0);
/* Nothing else may value a position: no logistic heuristic, no local scoring term. */
gate('no local valuation term remains in the engine',
  engineSource.indexOf('Math.exp(') < 0 && engineSource.indexOf('localScore') < 0);
gate('the central experiment is explicit: System 2 formula -> position array -> Environment.Eval -> Jev rules -> weighted sum',
  source.indexOf('function boardPositionArray(state)') >= 0 &&
  source.indexOf('function createBoardEnvironment(state)') >= 0 &&
  source.indexOf('Eval: function (formula, options)') >= 0 &&
  source.indexOf("kind: 'weighted_jev_rules'") >= 0 &&
  source.indexOf('function compileMeasureExpression(expression)') >= 0 &&
  source.indexOf('value += weightOf(weights, key) * usable;') >= 0);

/* The CORS wall is documented in the page, and the loopback relay path exists. */
gate('the page explains the measured CORS rejection', html.indexOf('400 Disallowed CORS origin') >= 0);
gate('the page offers the loopback relay preset',
  html.indexOf('http://127.0.0.1:8787/api/jev') >= 0 && html.indexOf("id='btn-use-relay'") >= 0);
gate('network failures are never retried (no preflight retry storm)',
  source.indexOf("error.kind === 'network' ||") < 0);
gate('the relay ships next to the harness', fs.existsSync(path.join(__dirname, 'jev-relay.js')));
/* The default rubric must judge declared observations, while exact arithmetic and legality remain code. */
gate('the default rubric judges O(s), while code owns the declared measurements',
  html.indexOf('Judge whether the Cats force a trap from the DECLARED measurements only') >= 0 &&
  html.indexOf('Mouse mobility={{mouse_mobility}}') >= 0 &&
  html.indexOf('const DEFAULT_VALUE_ATOMS = [\'cats_win_forecast\', \'mouse_containment\']') >= 0 &&
  html.indexOf("cat_row_spread: {") >= 0 && html.indexOf("kind: 'expr'") >= 0 &&
  html.indexOf('used_as: \'value\',                    // composes V(s)') >= 0);
/* The System-2 prompt must describe the Jev schema (question types, criteria shapes, answer
   contract, number mapping, id rules) and must allow proposing a NEW question: without it the
   model can only reshuffle the same four numbers, which is what made every revision useless. */
gate('the System-2 prompt carries a Jev schema document',
  source.indexOf('function buildJevSchemaDoc()') >= 0 && source.indexOf('buildJevSchemaDoc()') >= 0 &&
  source.indexOf('content: opts.systemPrompt || buildLlmSystemPrompt()') >= 0);
gate('the schema document is generated from one question-type registry',
  source.indexOf('const QUESTION_TYPES = {') >= 0 && source.indexOf('spec.criteriaShape') >= 0 &&
  source.indexOf('renderRulesShape(null, true)') >= 0);
gate('the schema document names all three question types', source.indexOf('QUESTION OBJECTS') >= 0 &&
  source.indexOf('choice: {') >= 0 && source.indexOf('score: {') >= 0 && source.indexOf('noul: {') >= 0);
gate('the schema document states the answer contract and that Noul carries no confidence',
  source.indexOf('ANSWER CONTRACT') >= 0 && source.indexOf('NO confidence at all') >= 0 &&
  source.indexOf('carriesConfidence: false') >= 0);
gate('the schema document states how a Jev answer becomes one number',
  source.indexOf('HOW AN ANSWER BECOMES ONE NUMBER') >= 0 && source.indexOf('score / (levels - 1)') >= 0 &&
  source.indexOf('probabilities[<option>]') >= 0);
gate('the schema document names the id rules and what a battery must contain',
  source.indexOf('ID RULES') >= 0 && source.indexOf('answers.cat_line') >= 0 &&
  source.indexOf('LIMIT: a battery needs at least one VALUE question') >= 0);
gate('the schema document offers the policy role for guiding the next action',
  source.indexOf('ADDING A QUESTION') >= 0 && source.indexOf("'  ROLES: every question declares") >= 0 &&
  source.indexOf('"options_from": "legal_moves"') >= 0 && source.indexOf('LIMIT: a battery needs at least one VALUE question') >= 0);
gate('a question the gate refuses is counted and logged, not silent',
  source.indexOf('Telemetry.droppedQuestions += dropped.length') >= 0 &&
  source.indexOf('QUESTION DROPPED') >= 0);
gate('the mutation payload reports the derived atoms, the roles and the question cap',
  source.indexOf('battery_in_use: {') >= 0 && source.indexOf('value_atoms: valueAtoms(') >= 0 &&
  source.indexOf('question_role_policy') >= 0 && source.indexOf('const MAX_QUESTIONS = 6;') >= 0);
gate('there is no whitelist left: the battery decides the atoms',
  source.indexOf('const DEFAULT_VALUE_ATOMS =') >= 0 && source.indexOf('function valueAtoms(battery)') >= 0 &&
  source.indexOf('function policyAtoms(battery)') >= 0 && source.indexOf('is not one of the composed atoms') < 0);
gate('the policy depth control is the only policy knob, and it is advanced',
  html.indexOf("id='cfg-policy-depth'") >= 0 && html.indexOf("id='cfg-policy-width'") < 0 &&
  html.indexOf("id='btn-policy-ab'") < 0 && html.indexOf("id='btn-learn'") >= 0 &&
  html.indexOf("{ id: 'cfg-policy-depth', key: 'policyDepth', type: 'number' }") >= 0);
gate('the search uses every legal move: the prior only orders',
  source.indexOf('function policyPriorFor(state, rules, ctx)') >= 0 &&
  source.indexOf('const moves = orderMoves(state, legal, ctx, prior);') >= 0 &&
  source.indexOf('function narrowMoves') < 0 && source.indexOf('policyWidth') < 0);
gate('the policy merge is a DECLARED operation with one implementation, never a maximum',
  source.indexOf("const POLICY_AGGREGATES = ['single', 'weighted_mean'];") >= 0 &&
  source.indexOf('function policyAggregateMode(battery) {') >= 0 &&
  source.indexOf('function mergePolicyDistributions(entries, mode, policyWeights) {') >= 0 &&
  source.indexOf('function normalizePolicyWeights(raw, policyIds, fallbackWeights) {') >= 0 &&
  source.indexOf('function normaliseDistribution(distribution) {') >= 0 &&
  source.indexOf('policyWeights: policyWeightsResult.policyWeights,') >= 0 &&
  source.indexOf('policy_weights: source.policyWeights || {},') >= 0 &&
  source.indexOf('changes.policy_weights = true') >= 0 &&
  source.indexOf('kinds.push("policy_weights");') >= 0 &&
  source.indexOf('"subject", "aggregate"];') >= 0 &&
  source.indexOf('const merge = mergePolicyDistributions(entries, agg.mode, rules.policyWeights);') >= 0 &&
  /* The old merge took the HIGHEST probability per move, which is not a distribution at all. */
  source.indexOf('= Math.max(merged[moveKeyName]') < 0);
gate('the removed surface is gone from the page and the engine',
  html.indexOf("id='cfg-mouse-policy'") < 0 && html.indexOf("id='cfg-mouse-start'") < 0 &&
  html.indexOf("id='cfg-parallel'") < 0 && html.indexOf("id='cfg-max-mutations'") < 0 &&
  html.indexOf("id='cfg-rematch'") < 0 && html.indexOf("id='cfg-tune-perfect'") < 0 &&
  html.indexOf("id='cfg-freeze'") < 0 && html.indexOf("id='btn-start'") < 0 &&
  html.indexOf("id='btn-step'") < 0 && html.indexOf("id='btn-tune'") < 0 &&
  source.indexOf('chooseRandomMove(') < 0 && source.indexOf('config.mousePolicy') < 0 &&
  source.indexOf('escalateForMouse') < 0 && source.indexOf('config.maxRuleMutations') < 0 &&
  source.indexOf('autotunePerfect') < 0 && source.indexOf('rematchUntilCatsWin') < 0 &&
  source.indexOf('freezeRules') < 0 && source.indexOf('createRng(') < 0);
gate('the opponent is ONE declared model, documented inside the state it is judged in',
  source.indexOf("const OPPONENT_POLICY = 'greedy';") >= 0 &&
  source.indexOf('function opponentDescription()') >= 0 &&
  source.indexOf('opponent: opponentDescription(),') >= 0 &&
  source.indexOf('mouse_policy: opponentModelId(),') >= 0 &&
  source.indexOf('function opponentModelId()') >= 0);
gate('the Mouse is a CODE-ONLY planner: deterministic, budgeted, independent of the rule set under test',
  source.indexOf('function solveLookahead(position, depth, budget)') >= 0 &&
  source.indexOf('const mousePlanCache = new Map();') >= 0 &&
  source.indexOf('function planMouseMove(state, depth)') >= 0 &&
  source.indexOf('function predictedMouseMove(state)') >= 0 &&
  source.indexOf('const PLAN_NODE_BUDGET = ') >= 0 &&
  source.indexOf('const MOUSE_DEPTH_MAX_LIMIT = 12;') >= 0);
gate('the CURRICULUM escalates the Mouse while the Cats\' depth never moves',
  source.indexOf('function escalateMouseNow(score)') >= 0 &&
  source.indexOf('function resetMeasurementWorld()') >= 0 &&
  source.indexOf('if (escalateMouseNow(score)) continue;') >= 0 &&
  source.indexOf('if (escalateMouseNow(clean)) continue;') >= 0 &&
  source.indexOf('Curriculum ceiling') >= 0 &&
  source.indexOf('mouseDepth: clamp(Math.round(config.depth) || 1, 1, 6)') >= 0);
gate('an escalation is a NEW measurement world: no cache of the weaker Mouse survives it',
  source.indexOf("|o' + opponentModelId()") >= 0 &&
  source.indexOf('const key = oracleCacheKey(state);') >= 0 &&
  source.indexOf('jevBeliefBaseline.clear();') >= 0 &&
  source.indexOf('oracleCache.clear();') >= 0);
gate('the prompt is DE-ANCHORED and proposals must be born from the evidence they were shown',
  source.indexOf('renderRulesShape(null, true)') >= 0 &&
  source.indexOf('your_value_question_1') >= 0 &&
  source.indexOf('EVIDENCE FIRST') >= 0 &&
  source.indexOf('function validateEvidenceRef(proposal, opts)') >= 0 &&
  source.indexOf('UNSUPPORTED proposal') >= 0 &&
  source.indexOf('tried_rule_sets: summarizeTriedRuleSets(),') >= 0);
gate('System 2 formulates observations over real leaf arrays and CODE replays them before Jev judges',
  source.indexOf('Every possible move is learned through its LEAF BOARDS') >= 0 &&
  source.indexOf('FORMULATE; DO NOT CALCULATE') >= 0 &&
  source.indexOf('function replayFormulaOnEvidence(rules, cases)') >= 0 &&
  source.indexOf('function formulaEvidenceCases(options)') >= 0 &&
  source.indexOf('FORMULA REFUSED: System 2 declared O(s)') >= 0 &&
  source.indexOf('formula_observation_replay: opts.formulaReplay || null,') >= 0 &&
  source.indexOf('position_array: boardPositionArray(record.leafState)') >= 0 &&
  source.indexOf('outcome_label: "unresolved"') >= 0);
gate('the run journal exports what the log hides: history, judges, revisions and the curriculum',
  source.indexOf('function buildRunJournal()') >= 0 &&
  html.indexOf("id='btn-copy-journal'") >= 0 &&
  source.indexOf('accepted_provenance: match.acceptedAt || null,') >= 0 &&
  source.indexOf('revision_digest: buildRevisionDigest(),') >= 0 &&
  source.indexOf('value_vs_truth: { mae: Telemetry.valueTruthMae()') >= 0);
gate('V(s) is scored against the truth the game already paid for (MAE, zero new Jev calls)',
  source.indexOf('noteValueAgainstTruth: function (value, verdict)') >= 0 &&
  source.indexOf('valueTruthMae: function ()') >= 0 &&
  source.indexOf('Telemetry.noteValueAgainstTruth(search.result.value, verdict);') >= 0 &&
  source.indexOf('const key = oracleCacheKey(state);') >= 0);
gate('the only mid-game writer is the path consult, guarded by mode, budget, prefilter and JUDGES',
  source.indexOf('async function runCatsPly(controller, options) {') >= 0 &&
  source.indexOf('const correction = await maybeCourseCorrect(controller, search);') >= 0 &&
  source.indexOf('if (pathLearningMode() !== "live") { queuePathCases(cases); return null; }') >= 0 &&
  source.indexOf('const budget = clamp(Math.round(config.midgameCorrections), 0, 8);') >= 0 &&
  source.indexOf('let verdict = judgeRuleDiffMeasured(match.rules, mutation.rules, {') >= 0 &&
  source.indexOf('verdict = await judgeRuleDiffConsensus(match.rules, mutation.rules, {') >= 0 &&
  source.indexOf('const judged = verdict.decision === "narrow"') >= 0 &&
  source.indexOf('match.midgameChangesThisGame = spent + 1;') >= 0 &&
  source.indexOf('(opts.pathLearning === false || pathLearningMode() === "off" || match.play) && !recordingOnly') >= 0 &&
  source.indexOf('async function runLearning()') >= 0 &&
  source.indexOf('async function runAutotune()') < 0);
gate('a win obtained with a moving rule set is re-verified with the corrections held back',
  source.indexOf('async function verifyRulesCleanly(rules, trials)') >= 0 &&
  source.indexOf('config.pathLearning = "collect";') >= 0 &&
  source.indexOf('const clean = await verifyRulesCleanly(candidate, trialMatrix);') >= 0 &&
  source.indexOf('clean.cleanVerified = true;') >= 0 &&
  source.indexOf('CLEAN RE-VERIFICATION FAILED') >= 0 &&
  source.indexOf('match.measurementGame !== true') >= 0 &&
  source.indexOf('match.measurementGame = (config.pathLearning !== "live")') >= 0);
gate('learning is expressed only in the fields System 1 evaluates, and prose alone is not a change',
  source.indexOf('const EVALUATED_QUESTION_FIELDS = ["type", "used_as", "option", "options_from", "subject", "aggregate"];') >= 0 &&
  source.indexOf('function diffRuleSets(previous, candidate)') >= 0 &&
  source.indexOf('function hasEvaluableRuleChange(previous, candidate)') >= 0 &&
  source.indexOf('if (identical || !hasEvaluableRuleChange(previous, normalized.rules)) {') >= 0 &&
  source.indexOf('System 2 returned NO CHANGE') >= 0 &&
  source.indexOf('Nothing Jev evaluates changed') >= 0 &&
  source.indexOf('ruleChangeKinds(diffRuleSets(previous, candidate)).length > 0') >= 0);
gate('the path brief carries the BOARDS of the line, the Jev answers and the confidence',
  source.indexOf('function buildPathBrief(ply, rules, cases, trigger)') >= 0 &&
  source.indexOf('function pathBoards(entries, rules)') >= 0 &&
  source.indexOf('function recordLeafCase(ctx, state, jev, confidence, path)') >= 0 &&
  source.indexOf('line.concat([{ state: child, move: move }])') >= 0 &&
  source.indexOf('board_ascii: renderBoardAscii(record.leafState)') >= 0 &&
  source.indexOf('position_array: boardPositionArray(record.leafState)') >= 0 &&
  source.indexOf('what_to_change') >= 0 &&
  source.indexOf('recordLeafCase(ctx, state, jev, jev.confidence, path);') >= 0);
gate('the prompt states that learning lives in the evaluated fields and that no change is valid',
  source.indexOf('PATH EVIDENCE: when the payload carries path_brief') >= 0 &&
  source.indexOf('WHAT A RULE SET IS: your learning is expressed ONLY in executable formula fields') >= 0 &&
  source.indexOf('READ THE LINES, NOT THE SCORE') >= 0 &&
  source.indexOf('NO CHANGE IS VALID') >= 0);
gate('the search plays against the ACTUAL opponent, not against a phantom minimax',
  source.indexOf('function defaultOpponentModel()') >= 0 &&
  source.indexOf("if (match.play && match.play.humanSide === SIDE_MOUSE) return 'adversarial';") >= 0 &&
  source.indexOf("return mouseModelDepth() > 0 ? 'planner' : 'greedy';") >= 0 &&
  source.indexOf('opponentModel: opts.opponentModel || defaultOpponentModel(),') >= 0 &&
  source.indexOf('if (!maximizing && ctx.opponentModel !== \'adversarial\' && legal.length > 1) {') >= 0 &&
  source.indexOf('const predicted = predictedMouseMove(state);') >= 0 &&
  source.indexOf('if (predicted) legal = [predicted];') >= 0 &&
  source.indexOf('opponentModel: opts.opponentModel });') >= 0 &&
  source.indexOf("', opponent ' + ctx.opponentModel") >= 0);
gate('a diff is judged before it is applied, and the judge is not the proponent',
  source.indexOf("const JUDGE_MEASURED = 'measurement';") >= 0 &&
  source.indexOf("const JUDGE_CONSENSUS = 'consensus';") >= 0 &&
  source.indexOf('const CONSENSUS_VOTES = 3;') >= 0 &&
  source.indexOf('const CONSENSUS_QUORUM = 2;') >= 0 &&
  source.indexOf('const CONSENSUS_PER_GAME_CAP = 2;') >= 0 &&
  source.indexOf("const NARROWABLE_KINDS = ['weights', 'policy_weights', 'confidence_floor'];") >= 0 &&
  source.indexOf('function toRuleDiff(previous, candidate) {') >= 0 &&
  source.indexOf('function narrowRuleSet(previous, candidate, kinds) {') >= 0 &&
  source.indexOf('function buildJudgeSystemPrompt() {') >= 0 &&
  source.indexOf('systemPrompt: buildJudgeSystemPrompt()') >= 0 &&
  source.indexOf('let verdict = judgeRuleDiffMeasured(match.rules, mutation.rules, {') >= 0 &&
  source.indexOf('verdict = await judgeRuleDiffConsensus(match.rules, mutation.rules, {') >= 0 &&
  /* The judge payload carries the change and the evidence, never the author's rationale. */
  source.indexOf('proposed_change: {') >= 0 && source.indexOf('rationale: diff.rationale') < 0);
gate('every belief that MOVED is recorded, and only with the truth it could be labelled with',
  source.indexOf('const REVISION_MIN_DELTA = 0.05;') >= 0 &&
  source.indexOf('const jevBeliefBaseline = new Map();') >= 0 &&
  source.indexOf('function recordRevision(state, jev, ctx) {') >= 0 &&
  source.indexOf('recordRevision(state, jev, ctx);') >= 0 &&
  source.indexOf('function mergeRevisions(list) {') >= 0 &&
  source.indexOf('mergeRevisions(ctx.revisions);') >= 0 &&
  source.indexOf('function buildAtomWitness(revisions) {') >= 0 &&
  source.indexOf('revision_digest: buildRevisionDigest(),') >= 0 &&
  source.indexOf('if (!previous) return null;') >= 0);
gate('the oracle key is built in ONE place, and the revision journal reads it with the same key',
  source.indexOf('function oracleCacheKey(state) {') >= 0 &&
  source.indexOf("const cached = oracleCache.get(oracleCacheKey(state)) || null;") >= 0 &&
  source.indexOf('const key = oracleCacheKey(state);') >= 0 &&
  source.indexOf("oracleCache.get(key + '|p' + state.ply)") < 0,
  'a verdict is about a board AT a ply AGAINST a Mouse model; a reader that drops the model from the key reads verdicts about a different game');
gate('a narrow verdict cannot plant GHOST weights, and the version history only moves up',
  source.indexOf('const MOUSE_PLAN_CACHE_LIMIT = 40000;') >= 0 &&
  source.indexOf('cacheSet(mousePlanCache, key, move, MOUSE_PLAN_CACHE_LIMIT)') >= 0 &&
  source.indexOf('normalizeWeights(candidate.weights, previous.weights, valueAtoms(keptBattery), policyAtoms(keptBattery))') >= 0 &&
  source.indexOf('normalizePolicyWeights(candidate.policyWeights, policyAtoms(keptBattery), previous.policyWeights)') >= 0 &&
  source.indexOf('narrowed.version = highestKnownVersion(previous) + 1;') >= 0 &&
  source.indexOf("'RENAMING IS NOT EVOLUTION:") >= 0 &&
  source.indexOf('function highestKnownVersion(previous) {') >= 0 &&
  source.indexOf('const versionFloor = highestKnownVersion(previous);') >= 0);
gate('the operator can FORCE a System-2 consult mid-run, consumed at the attempt boundary',
  html.indexOf("id='cfg-operator-directive'") >= 0 &&
  html.indexOf("id='btn-directive'") >= 0 &&
  source.indexOf('function queueOperatorIntervention() {') >= 0 &&
  source.indexOf('function takeOperatorIntervention() {') >= 0 &&
  source.indexOf('async function directiveRules(candidate, attempt, score, directive) {') >= 0 &&
  source.indexOf('const directive = takeOperatorIntervention();') >= 0 &&
  source.indexOf("task: opts.operatorDirective ? 'operator_directive'") >= 0 &&
  source.indexOf('operator_directive: opts.operatorDirective') >= 0 &&
  source.indexOf('OPERATOR DIRECTIVE: when the payload carries') >= 0 &&
  source.indexOf('if (directive && ref.operator_directive === true) return true;') >= 0 &&
  source.indexOf('match.operatorIntervention = null;') >= 0);
gate('the post-game report carries the CATS OWN FORMATION, and strategy is a first-class hypothesis',
  source.indexOf('function catFormationFacts(trace) {') >= 0 &&
  source.indexOf('cat_formation: catFormationFacts(trace),') >= 0 &&
  source.indexOf('STRATEGIC HYPOTHESES: your batteries so far') >= 0 &&
  source.indexOf('left_behind: (front - rear) >= 2') >= 0);
gate('the confidence gate reflects the vendor actually installed, not a wish',
  source.indexOf('const CONFIDENCE_FLOOR_RANGE = { min: 0.3, max: 0.95 };') >= 0 &&
  source.indexOf('confidenceFloor: 0.45,') >= 0 &&
  html.indexOf("id='cfg-floor' min='0.3'") >= 0 &&
  /* ONE range, in one place: a hardcoded 0.5 clamp would silently raise the floor the prompt tells
     System 2 it can lower. */
  source.indexOf('confidenceFloor, 0.5, 0.95') < 0 &&
  source.indexOf('confidenceFloor: clamp(rules.confidenceFloor, CONFIDENCE_FLOOR_RANGE.min, CONFIDENCE_FLOOR_RANGE.max),') >= 0);
gate('learning is triggered by being WRONG (the oracle), not by being uncertain',
  source.indexOf('const oracleCache = new Map();') >= 0 &&
  source.indexOf('function oracleVerdict(state, options) {') >= 0 &&
  source.indexOf('function describeValueAgainstTruth(value, verdict) {') >= 0 &&
  source.indexOf('const contradiction = describeValueAgainstTruth(played.value, verdict);') >= 0 &&
  source.indexOf('if (contradiction.indexOf("CONTRADICTION") === 0) return triggerOf("contradiction", contradiction);') >= 0 &&
  source.indexOf("'the ply judgment cannot be trusted: confidence '") < 0 &&
  source.indexOf('const verdict = oracleVerdict(match.state);') >= 0);
gate('the trigger is TYPED and its mix is COUNTED, not only printed in prose',
  source.indexOf('function triggerOf(cls, text) {') >= 0 &&
  source.indexOf('function triggerText(trigger) {') >= 0 &&
  source.indexOf('function triggerClass(trigger) {') >= 0 &&
  source.indexOf('const TRIGGER_CLASSES = ["contradiction", "coin_flip", "no_belief"];') >= 0 &&
  source.indexOf('noteTrigger: function (cls) {') >= 0 &&
  source.indexOf("triggerMixLabel: function () {") >= 0 &&
  source.indexOf("{ key: 'triggermix', label: 'Trigger mix'") >= 0);
gate('consolidation learns at the BOUNDARY: the doubts are recorded, never applied ply by ply',
  html.indexOf("<option value='consolidate'>") >= 0 &&
  source.indexOf('const PATH_LEARNING_MODES = ["off", "collect", "consolidate", "live"];') >= 0 &&
  source.indexOf('const CONSOLIDATION_SCOPE = "attempt";') >= 0 &&
  source.indexOf('if (pathLearningMode() === "consolidate") recordReflection(search, cases);') >= 0 &&
  source.indexOf('const consolidated = await consolidateReflections(attempt, score);') >= 0 &&
  source.indexOf("(opts.consolidationBrief ? 'consolidate_reflections'") >= 0 &&
  source.indexOf('consolidation_brief: opts.consolidationBrief || null,') >= 0 &&
  source.indexOf('CONSOLIDATION: when the payload carries consolidation_brief') >= 0 &&
  source.indexOf('if (config.pathLearning !== "live") config.midgameCorrections = 0;') >= 0 &&
  source.indexOf('reflections: [],') >= 0);
gate('the System-2 contract never advertises a capability the engine does not have',
  html.indexOf('narrows') < 0 &&
  source.indexOf('Optional POLICY rules receive concrete legal transitions only to order search') >= 0 &&
  source.indexOf('the prior reorders, it never cuts') >= 0 &&
  source.indexOf('Halting the deep search') < 0 &&
  source.indexOf('so System 2 will be asked to revise the rule set') < 0 &&
  source.indexOf('below this the harness re-asks you') < 0 &&
  source.indexOf('needs at least one VALUE question') >= 0 &&
  source.indexOf('The battery declares no VALUE question') >= 0 &&
  /* A payload key nothing can ever fill is a lie of omission: the low-confidence report is gone. */
  source.indexOf('low_confidence_report') < 0 && source.indexOf('lowConfidenceReport') < 0 &&
  source.indexOf('function narrowMoves') < 0 && source.indexOf('policyWidth') < 0);
gate('every question gets an ACCURACY figure, not only a dispersion',
  source.indexOf('atomTruthWon: {},') >= 0 &&
  source.indexOf('noteAtomTruth: function (winner, atoms) {') >= 0 &&
  source.indexOf('atomAccuracy: function (options) {') >= 0 &&
  source.indexOf('atom_accuracy: Telemetry.atomAccuracy(),') >= 0 &&
  source.indexOf('uninformative_questions: Telemetry.atomAccuracy()') >= 0 &&
  source.indexOf('UNINFORMATIVE QUESTION(S) after attempt ') >= 0 &&
  source.indexOf('const ATOM_ACCURACY_MIN_SAMPLES = 20;') >= 0);
gate('a repeated note is counted, not printed (the log stays readable)',
  source.indexOf('function logNoteOnce(key, channel, level, message, payload) {') >= 0 &&
  source.indexOf("logNoteOnce('jev-answer-note:' + parsed.warnings.join('|')") >= 0 &&
  source.indexOf("logNoteOnce('policy-not-materialised:'") >= 0 &&
  source.indexOf('logState.suppressedNotes') >= 0 &&
  source.indexOf('warnedOnce: {}, suppressedNotes: 0') >= 0);
gate('the path-learning controls exist in the markup and are read from the form',
  html.indexOf("id='cfg-path-learning'") >= 0 && html.indexOf("id='cfg-midgame-corrections'") >= 0 &&
  html.indexOf("id='cfg-path-cases'") >= 0 &&
  source.indexOf("{ id: 'cfg-path-learning', key: 'pathLearning', type: 'string' }") >= 0 &&
  source.indexOf("{ id: 'cfg-midgame-corrections', key: 'midgameCorrections', type: 'number' }") >= 0 &&
  source.indexOf('pathLearning: "live",') >= 0 && source.indexOf('midgameCorrections: 3,') >= 0);
gate('the learning loop asks System 2 for its first candidate (no attempt measures the neutral prior)',
  source.indexOf('async function compileInitialRules(controller)') >= 0 &&
  source.indexOf('let candidate = match.bestRules;') >= 0 &&
  source.indexOf('Learning refused to start: System 2 produced no candidate') >= 0 &&
  source.indexOf('will not measure the neutral prior as if it were a hypothesis') >= 0 &&
  source.indexOf('async function bootstrapRules()') < 0 && source.indexOf('skipBootstrap') < 0);
gate('runHarness is a measurement primitive: the loaded rule set, one game, nothing else',
  source.indexOf('/* One game as a measurement: the rule set is already in match.rules (set by the caller), so this') >= 0 &&
  source.indexOf('never asks System 2 for anything. Every rule-set change belongs to runLearning. */') >= 0);
gate('every log channel the code writes is registered (an unregistered channel is invisible)',
  (function () {
    const used = {};
    const re = /log\('([A-Z]+)'/g;
    let m;
    while ((m = re.exec(source))) used[m[1]] = true;
    const declared = (source.match(/const LOG_CHANNELS = \[([^\]]+)\]/) || [])[1] || '';
    return Object.keys(used).every(function (c) { return declared.indexOf("'" + c + "'") >= 0; });
  })(), 'channels used: ' + (function () {
    const used = {}; const re = /log\('([A-Z]+)'/g; let m;
    while ((m = re.exec(source))) used[m[1]] = true;
    return Object.keys(used).join(',');
  })());
gate('each attempt reports its measured cost, and an inert confidence gate says why',
  source.indexOf("' cost: ' + cost.nodes + ' nodes, ' + cost.leaves") >= 0 &&
  source.indexOf('No confidence-gated pruning in this attempt') >= 0 &&
  source.indexOf('leaves_below_floor') >= 0 &&
  source.indexOf('jevPrunes') >= 0 && source.indexOf('certainPrunes') >= 0 &&
  source.indexOf('noteConfidence: function (value, floor)') >= 0 &&
  source.indexOf('confidenceSigma: function ()') >= 0 &&
  source.indexOf("{ key: 'jevconf', label: 'Jev confidence avg'") >= 0,
  'the number that explains a silent knob');
gate('the truth solver exists, is budgeted, and never reports exhaustion as a draw',
  source.indexOf('function solveAgainstModel(state, modelDepth, options)') >= 0 &&
  source.indexOf('const TRUTH_NODE_BUDGET = ') >= 0 &&
  source.indexOf('never reported as a draw') >= 0 &&
  source.indexOf('threefold repetition is NOT modelled') >= 0 &&
  source.indexOf('if (childResult === null) { exhausted = true; return null; }') >= 0 &&
  source.indexOf('winner: result ? result.winner : null,') >= 0 &&
  source.indexOf('function annotateTruth(trace, options)') >= 0 &&
  source.indexOf('function describeTruthGap(blunderRow, truth)') >= 0 &&
  source.indexOf('snapshot: { cats: preState.cats.map') >= 0);
gate('the evidence and the payload carry the truth, the cost and the per-atom dispersion',
  source.indexOf('loss_diagnosis: truthGap || diagnoseOutcome(') >= 0 &&
  source.indexOf('truth: truth,') >= 0 &&
  source.indexOf('attempt_cost: (match.tuning && match.tuning.lastCost)') >= 0 &&
  source.indexOf('atom_stats: Telemetry.atomStatistics(),') >= 0 &&
  source.indexOf('dead_atoms: Telemetry.atomStatistics().filter') >= 0 &&
  source.indexOf('noteAtoms: function (atoms)') >= 0 &&
  source.indexOf('DEAD QUESTION "') >= 0);
gate('play mode exists, uses the accepted rule set and never calls System 2',
  html.indexOf("id='btn-play'") >= 0 && html.indexOf("id='btn-undo'") >= 0 &&
  html.indexOf("id='cfg-human-side'") >= 0 && html.indexOf("id='play-hint'") >= 0 &&
  source.indexOf('function startPlayMode(humanSide)') >= 0 &&
  source.indexOf('function playHumanMove(fromX, fromY, toX, toY)') >= 0 &&
  source.indexOf('function handleBoardClick(x, y)') >= 0 &&
  source.indexOf('Human vs engine - you play the ') >= 0 &&
  source.indexOf("{ id: 'cfg-human-side', key: 'humanSide', type: 'string' }") >= 0 &&
  source.indexOf('play: null,') >= 0);
gate('the cache key separates policy from non-policy requests',
  source.indexOf("'|p' + (opts.includePolicy === true ? 1 : 0)") >= 0);
const idsInHtml = (html.match(/id='([a-zA-Z0-9_-]+)'/g) || []).map(function (s) { return s.slice(4, -1); });
const duplicateIds = idsInHtml.filter(function (id, index) { return idsInHtml.indexOf(id) !== index; });
gate('every markup id is unique (' + idsInHtml.length + ' ids, no duplicate silently shadowed by byId)',
  duplicateIds.length === 0, duplicateIds.join(', '));
const idsInJs = (source.match(/byId\('([a-zA-Z0-9_-]+)'\)/g) || []).map(function (s) { return s.slice(6, -2); });
const missingIds = idsInJs.filter(function (id) { return idsInHtml.indexOf(id) < 0; });
gate('every byId() lookup exists in the markup (' + idsInJs.length + ' lookups)', missingIds.length === 0, missingIds.join(', '));

gates.forEach(function (item) { console.log((item.pass ? 'OK   ' : 'FAIL ') + 'gate: ' + item.name + (item.detail ? ' [' + item.detail + ']' : '')); });
if (gates.some(function (item) { return !item.pass; })) {
  console.error('\nSTATIC GATES FAILED - fix the deliverable before behavioural tests.');
  process.exit(1);
}
/* --- 2. Stub of POST /v1/systemone (test double, lives only in this harness) --- */
const clamp01 = function (value) { return Math.min(1, Math.max(0, value)); };

function createJevStub(options) {
  const opts = options || {};
  const confidence = Number.isFinite(opts.confidence) ? opts.confidence : 0.88;
  const state = { mode: 'ok', calls: [] };
  const response = function (status, payload, retryAfter) {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status: status,
      statusText: status === 200 ? 'OK' : 'Error',
      headers: { get: function (name) { return (retryAfter !== undefined && name === 'retry-after') ? String(retryAfter) : null; } },
      text: function () { return Promise.resolve(text); }
    });
  };
  const fetchStub = function (url, init) {
    /* Models the real world: a relay DOES answer on 127.0.0.1:8787, while the page
       self-test's throwaway port 127.0.0.1:1 is refused. A browser reports that refusal as
       a bare TypeError, so the stub does too. */
    if (String(url).indexOf('127.0.0.1:1/') >= 0) return Promise.reject(new TypeError('Failed to fetch'));
    const call = { url: url, method: init.method, headers: init.headers, body: JSON.parse(init.body) };
    state.calls.push(call);
    if (state.mode === 'http-422') {
      return response(422, { detail: [{ loc: ['body', 'model'], msg: 'field required' }] });
    }
    if (state.mode === 'http-429-once' && state.calls.length === 1) return response(429, { detail: 'slow down' }, '0');
    if (state.mode === 'network') return Promise.reject(new Error('stub network failure'));
    /* What the browser reports when the preflight is refused: a bare TypeError. */
    if (state.mode === 'cors') return Promise.reject(new TypeError('Failed to fetch'));
    if (state.mode === 'garbage') return response(200, { model: 'jev-1.13.0', answers: { cats_win_forecast: { type: 'noul', noul: 0.5 } } });
    /* A deterministic stand-in judgment, built from the questions ACTUALLY DECLARED in the
       request - exactly as the documented contract works: the further the Mouse is from row 0,
       the better the Cats are doing. No question id is hardcoded here. */
    const wire = call.body.state || {};
    const mouseY = (wire.measurements && typeof wire.measurements.mouse_row === 'number')
      ? wire.measurements.mouse_row
      : ((wire.mouse && typeof wire.mouse[1] === 'number') ? wire.mouse[1] : 7);
    const advance = 1 - mouseY / 7;
    const pCats = clamp01(0.9 - 0.85 * advance);
    const questions = call.body.questions || {};
    const answers = {};
    Object.keys(questions).forEach(function (id) {
      const question = questions[id] || {};
      const criteria = (question.criteria && typeof question.criteria === 'object') ? question.criteria : null;
      if (question.type === 'choice') {
        const keys = criteria ? Object.keys(criteria) : [];
        if (!keys.length) { answers[id] = { type: 'choice', choice: null, probabilities: {}, confidence: confidence }; return; }
        const isPolicy = keys.every(function (key) { return criteria[key] === null; });
        const probabilities = {};
        if (isPolicy) {
          /* A policy answer: the first (materialised) move gets the mass, the rest share it. */
          keys.forEach(function (key, index) { probabilities[key] = index === 0 ? 0.6 : (0.4 / Math.max(1, keys.length - 1)); });
        } else {
          const rest = clamp01((1 - pCats) / Math.max(1, keys.length - 1));
          keys.forEach(function (key) { probabilities[key] = (key === 'cats_win') ? pCats : rest; });
        }
        answers[id] = {
          type: 'choice',
          choice: isPolicy ? keys[0] : (pCats >= 0.5 ? 'cats_win' : keys[0]),
          probabilities: probabilities,
          confidence: confidence
        };
        return;
      }
      if (question.type === 'score') {
        const levels = Array.isArray(criteria) ? criteria.length : 1;
        answers[id] = {
          type: 'score', score: opts.constantScore ? 0 : clamp01(1 - advance) * Math.max(1, levels - 1),
          legend: {}, probabilities: {}, confidence: 0.8
        };
        return;
      }
      answers[id] = { type: 'noul', noul: advance > 0.9 ? 0.9 : 0.05 };
    });
    return response(200, { model: 'jev-1.13.0', answers: answers, usage: { input_tokens: 420, output_tokens: 14 } });
  };
  return { fetch: fetchStub, state: state };
}

/* A stub that answers BOTH endpoints: /v1/systemone (Jev, System 1) and the chat-completions URL
   (System 2). It exists so the learning loop can be exercised end to end with no network: the
   loop's whole point is that System 2 supplies the candidates. */
function createDualStub(options) {
  const opts = options || {};
  const jev = createJevStub(opts.jev || {});
  const proposals = opts.proposals || [
    { version: 1, rationale: 'stub candidate', weights: { cats_win_forecast: 1 }, confidenceFloor: 0.7 }
  ];
  const llmCalls = [];
  const fetchStub = function (url, init) {
    if (String(url).indexOf('/v1/chat/completions') >= 0) {
      llmCalls.push(JSON.parse(init.body));
      const index = Math.min(llmCalls.length - 1, proposals.length - 1);
      const payload = proposals[index];
      /* The stub plays a System 2 that obeys the EVIDENCE FIRST contract: when the harness hands
         cases or labelled truths, its proposals cite one. A real model has to do the same, so a
         lawless stub author would be refused by the provenance gate for the wrong reason. */
      const answer = (payload && typeof payload === 'object' && !Array.isArray(payload) && !payload.evidence_ref)
        ? Object.assign({}, payload, { evidence_ref: { case: 0, why: 'stub: answering the first case shown' } })
        : payload;
      const content = typeof answer === 'string' ? answer : JSON.stringify(answer);
      /* The OpenAI chat-completions envelope, exactly as System 2 reads it. */
      const text = JSON.stringify({ model: 'stub-llm', choices: [{ message: { content: content } }] });
      return Promise.resolve({
        ok: true, status: 200, statusText: 'OK',
        headers: { get: function () { return null; } },
        text: function () { return Promise.resolve(text); }
      });
    }
    return jev.fetch(url, init);
  };
  return { fetch: fetchStub, state: jev.state, llmCalls: llmCalls };
}

/* A fake document, built from the ids actually present in the markup, so the real UI
   code runs its render path headless. */
function createFakeDom() {
  const elements = new Map();
  const make = function (tag) {
    const el = {
      tagName: tag, id: '', innerHTML: '', value: '', checked: false, disabled: false,
      type: 'text', title: '', style: {}, dataset: {}, className: '', children: [], parentNode: null,
      scrollTop: 0, scrollHeight: 0
    };
    Object.defineProperty(el, 'textContent', {
      get: function () { return el.__text || ''; },
      set: function (value) { el.__text = String(value); el.children = []; }
    });
    Object.defineProperty(el, 'childNodes', { get: function () { return el.children; } });
    Object.defineProperty(el, 'firstChild', { get: function () { return el.children[0] || null; } });
    el.classList = { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } };
    el.appendChild = function (child) { child.parentNode = el; el.children.push(child); return child; };
    el.removeChild = function (child) { el.children = el.children.filter(function (c) { return c !== child; }); return child; };
    el.insertBefore = function (child) { return el.appendChild(child); };
    el.addEventListener = function () {};
    el.removeEventListener = function () {};
    el.setAttribute = function (name, value) { el[name] = value; };
    el.getAttribute = function (name) { return el[name] === undefined ? null : el[name]; };
    el.querySelector = function () { return null; };
    el.querySelectorAll = function () { return []; };
    el.closest = function () { return null; };
    el.click = function () {};
    el.focus = function () {};
    el.blur = function () {};
    el.remove = function () {};
    return el;
  };
  const ids = (html.match(/id='([a-zA-Z0-9_-]+)'/g) || []).map(function (s) { return s.slice(4, -1); });
  ids.forEach(function (id) { const el = make('div'); el.id = id; elements.set(id, el); });
  return {
    elements: elements,
    document: {
      getElementById: function (id) { return elements.get(id) || null; },
      createElement: make,
      addEventListener: function () {},
      body: make('body'),
      readyState: 'complete'
    }
  };
}

function createSandbox(stub, quiet, withDom) {
  const sandbox = {
    console: quiet || { log: function () {}, warn: function () {}, error: function () {} },
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval,
    performance: { now: function () { return Date.now(); } },
    AbortController: AbortController,
    fetch: stub.fetch
  };
  if (withDom) {
    const dom = createFakeDom();
    sandbox.__dom = dom;
    sandbox.document = dom.document;
    sandbox.documentElement = dom.document.body;
    sandbox.window = sandbox;
    sandbox.alert = function () {};
    sandbox.navigator = { clipboard: { writeText: function () { return Promise.resolve(); } } };
    sandbox.localStorage = { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} };
    sandbox.sessionStorage = { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} };
    sandbox.requestAnimationFrame = function (cb) { return setTimeout(function () { cb(Date.now()); }, 0); };
    sandbox.cancelAnimationFrame = function (id) { clearTimeout(id); };
    sandbox.URL = { createObjectURL: function () { return 'blob:fake'; }, revokeObjectURL: function () {} };
    sandbox.Blob = function () {};
  }
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const bridge = ';globalThis.__api = { runEngineSelfTest, runAsyncSelfTest, runHarness, resetHarness, match, Telemetry, config, ' +
    'createInitialState, isTerminal, stateKey, DEFAULT_RULES, DEFAULT_BATTERY, ATOM_KEYS, searchBestMove, describeMove, ' +
    'normalizeRules, normalizeWeights, normalizeBattery, composeLeafValue, parseJevAnswers, parseJSONLoose, evaluateWithJev, ' +
    'legalMovesForSide, applyMove, passTurn, checkThreefold, isDarkSquare, threatenedSquares, toWireState, ' +
    'batteryHash, weightsHash, rulesHash, ruleFormulaOf, toWireRules, formulaHash, judgmentFormulaHash, compileRuleFormula, createBoardEnvironment, ' +
    'boardPositionArray, stateFromPositionArray, buildTrialMatrix, diagnoseOutcome, SIDE_CATS, SIDE_MOUSE, MAX_PLIES, moveKey, ' +
    'CAT_HOME_ROW, MOUSE_HOME_ROW, jevAnswerCache, jevValueCache, jevVectorCache, buildLossEvidence, boot, startLearningWithHealthGate, ' +
    'runLearning, opponentDescription, OPPONENT_POLICY, ' +
    'STAT_TILE_DEFS, jevHealth, probeJevConnection, applyLocalRelayPreset, jevModeLabel, ' +
    'isRelayEndpoint, networkFailureKind, networkFailureHint, networkFailureLabel, RELAY_DEFAULT_URL, RELAY_HINT, ' +
    'logState, parseNumericInput, readConfigFromForm, reportLearningStatus, ' +
    'buildLlmSystemPrompt, buildJevSchemaDoc, renderRulesShape, collectDroppedQuestions, ' +
    'noteDroppedQuestions, QUESTION_TYPES, MAX_QUESTIONS, buildMetaContext, RULES_JSON_SHAPE, ' +
    'DEFAULT_VALUE_ATOMS, valueAtoms, policyAtoms, atomRole, materializeQuestions, ' +
    'QUESTION_ID_PATTERN, QUESTION_ROLES, POLICY_SUBJECTS, batteryOf, normalizeQuestion, ' +
    'policyPriorFor, orderMoves, createSearchContext, playAvailable, playRules, startPlayMode, ' +
    'playHumanMove, handleBoardClick, undoPlayPly, stopPlayMode, maybeEnginePlies, playHintText, cellCoordinatesFrom, onBoardClickEvent, ' +
    'scheduleEnginePlies, solveAgainstModel, solveLookahead, planMouseMove, predictedMouseMove, mouseModelDepth, ' +
    'opponentModelId, mousePlanCache, PLAN_NODE_BUDGET, MOUSE_DEPTH_MAX_LIMIT, MOUSE_PLAN_CACHE_LIMIT, cacheSet, escalateMouseNow, resetMeasurementWorld, ' +
    'summarizeTriedRuleSets, validateEvidenceRef, validateBoardReading, readingSeparatesCases, buildRunJournal, describeTruthGap, annotateTruth, TRUTH_NODE_BUDGET, ' +
        'ATOM_DEAD_MIN_SAMPLES, ATOM_DEAD_SIGMA, ' +
        'RULE_FORMULA_VERSION, MEASURE_SPEC_VERSION, MEASURE_KINDS, MEASURE_EXPR_MAX_NODES, MEASURE_EXPR_MAX_DEPTH, ' +
        'OBSERVATION_OPS, compileMeasure, compileMeasureExpression, normalizeObservations, computeObservations, replayFormulaOnEvidence, formulaEvidenceCases, ' +
    'substituteQuestionObservations, enforceObservationPlaceholders, questionsFingerprint, ' +
    'pathLearningMode, recordLeafCase, pathBoards, selectPathCases, buildPathBrief, prefilterCandidate, ' +
    'prefilterUsableCases, meanAbsEdge, courseCorrectionTrigger, queuePathCases, summarizePathCases, ' +
    'maybeCourseCorrect, verifyRulesCleanly, diffRuleSets, ruleChangeKinds, hasEvaluableRuleChange, ' +
    'describeRuleChange, describeWeightsDelta, shortenText, PATH_LEARNING_MODES, PATH_TIE_MARGIN, ' +
    'PATH_COINFLIP_MARGIN, PATH_PREFILTER_TOLERANCE, ' +
    'defaultOpponentModel, oracleVerdict, describeValueAgainstTruth, oracleCache, logNoteOnce, ' +
    'ATOM_ACCURACY_MIN_SAMPLES, ATOM_ACCURACY_MIN_SEPARATION, CONFIDENCE_FLOOR_RANGE, ' +
    'POLICY_AGGREGATES, normalizePolicyWeights, mergePolicyDistributions, normaliseDistribution, policyAggregateMode, ' +
    'recordRevision, mergeRevisions, viewRevisions, truthLabelCounts, buildAtomWitness, buildRevisionDigest, ' +
    'REVISION_MIN_DELTA, REVISION_CAP, REVISION_JOURNAL_CAP, jevBeliefBaseline, ' +
    'JUDGE_MEASURED, JUDGE_CONSENSUS, CONSENSUS_VOTES, CONSENSUS_QUORUM, CONSENSUS_PER_GAME_CAP, NARROWABLE_KINDS, ' +
    'toRuleDiff, narrowRuleSet, judgeRuleDiffMeasured, judgeRuleDiffConsensus, judgeDiffWithLLM, buildJudgeSystemPrompt, ' +
    'recordReflection, consolidateReflections, buildConsolidationBrief, triggerOf, triggerText, triggerClass, ' +
    'REFLECTION_CAP, CONSOLIDATION_SCOPE, CONSOLIDATION_MAX_REFLECTIONS, CONSOLIDATION_CASES_PER_REFLECTION, TRIGGER_CLASSES, ' +
    'directiveRules, catFormationFacts, queueOperatorIntervention, takeOperatorIntervention, highestKnownVersion };';
  vm.runInContext(source + bridge, sandbox, { filename: 'inline.js' });
  const api = sandbox.__api;
  if (withDom) api.__dom = sandbox.__dom;
  return api;
}
/* --- 3. Behavioural gates -------------------------------------------------- */
(async function main() {
  const results = [];
  const push = function (name, pass, detail) {
    results.push({ name: name, pass: !!pass, detail: detail === undefined ? '' : String(detail) });
  };
  const stub = createJevStub();
  const api = createSandbox(stub);
  Object.assign(api.config, {
    typesafeUrl: 'https://api.typesafe.ai/v1/systemone', typesafeKey: 'test-key', jevModel: 'jev-latest',
    llmUrl: '', depth: 2, parallelBranch: 3, seed: 11, mouseStartCol: 0,
    stepDelayMs: 0, autotuneHypotheses: 1, autotuneTrials: 1, confidenceFloor: 0.7
  });

  /* 3a. One leaf: the request must match the documented contract exactly. */
  const opening = api.createInitialState(0);
  const leaf = await api.evaluateWithJev(opening, api.DEFAULT_RULES, {});
  const firstCall = stub.state.calls[0];
  const body = firstCall ? firstCall.body : {};
  push('The request carries model, state and questions',
    body.model === 'jev-latest' && !!body.state && !!body.questions, Object.keys(body).join(','));
  push('No invented top-level field is sent (schema/rules/perspective are gone)',
    body.schema === undefined && body.rules === undefined && body.perspective === undefined);
  push('Environment.Eval sends declared measurements to Jev and withholds raw coordinates for value rules',
    typeof body.state.rules_of_the_game === 'string' && !!body.state.measurements &&
    body.state.measurements.mouse_row === 7 && body.state.board_ascii === undefined && body.state.cats === undefined,
    JSON.stringify(body.state));
  push('The battery is materialised from the declaration: one choice + one score',
    Object.keys(body.questions).join(',') === api.DEFAULT_VALUE_ATOMS.join(',') &&
    body.questions.cats_win_forecast.type === 'choice' && body.questions.mouse_containment.type === 'score',
    Object.keys(body.questions).join(','));
  push('Every question is about the complete state, and none about an engine fact',
    body.state.opponent && body.state.opponent.policy === api.opponentDescription().policy &&
    body.questions.trap === undefined && body.questions.blocked === undefined &&
    body.questions.cat_advantage === undefined);
  push('The option the value question composes is the one it declares',
    Object.keys(body.questions.cats_win_forecast.criteria).join(',') === 'cats_win,mouse_win,draw' &&
    api.DEFAULT_RULES.battery.cats_win_forecast.option === 'cats_win');
  push('Auth uses the documented Bearer header',
    !!firstCall && String(firstCall.headers.Authorization) === 'Bearer test-key', firstCall && firstCall.headers.Authorization);
  push('V(s) is composed from the answers and marked live',
    leaf.source === 'live' && leaf.winProbability >= 0.5 && leaf.winProbability <= 1, leaf.winProbability);
  push('The composed value is exactly the weighted answers, no local term',
    Math.abs(leaf.winProbability - (0.5 * (leaf.atoms.cats_win_forecast + leaf.atoms.mouse_containment))) < 0.0002,
    leaf.winProbability);
  push('The confidence is the one Jev reported', leaf.confidence === 0.88, leaf.confidence);
  push('The raw atoms are kept for the telemetry log',
    !!leaf.atoms && Number.isFinite(leaf.atoms.mouse_containment) && Object.keys(leaf.atoms).join(',') === api.DEFAULT_VALUE_ATOMS.join(','));

  /* 3b. Search: every leaf value must come from the endpoint. */
  const callsBefore = stub.state.calls.length;
  const search = await api.searchBestMove(opening, api.DEFAULT_RULES, { depth: 2, parallelBatch: 3 });
  const legal = api.legalMovesForSide(opening, api.SIDE_CATS);
  const chosen = search.result.bestMove;
  push('The search returns a legal Cat move',
    !!chosen && legal.some(function (move) {
      return move.piece === chosen.piece && move.catIndex === chosen.catIndex &&
        move.to[0] === chosen.to[0] && move.to[1] === chosen.to[1];
    }), api.describeMove(chosen));
  push('The search value is a probability', search.result.value >= 0 && search.result.value <= 1, search.result.value);
  push('The search hit the endpoint and never errored',
    stub.state.calls.length - callsBefore > 0 && api.Telemetry.jevErrors === 0,
    (stub.state.calls.length - callsBefore) + ' calls');
  push('Ordering used only Jev values (PV + value hints, no heuristic)',
    search.ctx.valueHints.size > 0, search.ctx.valueHints.size + ' hints');

  /* 3c. Two-level cache: new weights must not re-hit the endpoint. */
  const callsBeforeWeights = stub.state.calls.length;
  const requilt = api.normalizeRules({
    version: 5, weights: { cats_win_forecast: 1, mouse_containment: 0 }
  }, { fallback: api.DEFAULT_RULES }).rules;
  const reSearch = await api.searchBestMove(opening, requilt, { depth: 2, parallelBatch: 3 });
  push('Changing only the weights needs zero new endpoint calls',
    stub.state.calls.length === callsBeforeWeights, stub.state.calls.length - callsBeforeWeights);
  const reLeaf = await api.evaluateWithJev(opening, requilt, {});
  push('Values were recomposed from the cached answers',
    api.Telemetry.jevRecompositions > 0 && Math.abs(reLeaf.winProbability - reLeaf.atoms.cats_win_forecast) < 0.0002,
    api.Telemetry.jevRecompositions + ' recomposed, V ' + reLeaf.winProbability + ' = forecast ' + reLeaf.atoms.cats_win_forecast);
  push('The battery is what invalidates the inference cache',
    api.batteryHash(requilt.battery) === api.batteryHash(api.DEFAULT_RULES.battery) &&
    api.weightsHash(requilt.weights) !== api.weightsHash(api.DEFAULT_RULES.weights));
/* 3d. Failure doctrine: no Jev, no game. The caches are emptied first, so the failure
     cannot be masked by answers fetched in the earlier steps. */
  api.resetHarness(false);
  api.jevAnswerCache.clear();
  api.jevValueCache.clear();
  api.jevVectorCache && api.jevVectorCache.clear();
  const callsBeforeFailure = stub.state.calls.length;
  api.config.parallelBranch = 1;      // one leaf at a time, so the count isolates the retry policy
  stub.state.mode = 'http-422';
  await api.runHarness({});
  push('A rejected request stops the harness (422 is not retried)', api.match.status === 'error', api.match.status);
  push('A 422 costs exactly one call', stub.state.calls.length - callsBeforeFailure === 1,
    stub.state.calls.length - callsBeforeFailure + ' calls');
  push('No move is played without System 1', api.match.moveLog.length === 0, api.match.moveLog.length);
  stub.state.mode = 'ok';

  /* 3d-bis. Retry policy: a throttled call is retried, honouring retry-after. */
  const retryStub = createJevStub();
  retryStub.state.mode = 'http-429-once';
  const retryApi = createSandbox(retryStub);
  Object.assign(retryApi.config, {
    typesafeUrl: 'https://api.typesafe.ai/v1/systemone', typesafeKey: 'k', jevModel: 'jev-latest',
    typesafeRetries: 2, typesafeTimeoutMs: 5000
  });
  const retried = await retryApi.evaluateWithJev(retryApi.createInitialState(0), retryApi.DEFAULT_RULES, {});
  push('A 429 is retried and then answered', retryStub.state.calls.length === 2 && retried.source === 'live',
    retryStub.state.calls.length + ' calls');

  /* 3d-ter. The wall the user hit: a refused preflight must be reported, not retried. */
  const corsStub = createJevStub();
  corsStub.state.mode = 'cors';
  const corsApi = createSandbox(corsStub);
  Object.assign(corsApi.config, {
    typesafeUrl: 'https://api.typesafe.ai/v1/systemone', typesafeKey: 'k', jevModel: 'jev-latest',
    typesafeRetries: 3, typesafeTimeoutMs: 3000
  });
  let corsError = null;
  try {
    await corsApi.evaluateWithJev(corsApi.createInitialState(0), corsApi.DEFAULT_RULES, {});
  } catch (error) {
    corsError = error;
  }
  push('A refused CORS preflight is detected',
    !!corsError && corsError.networkDiagnosis === 'cors',
    corsError ? (corsError.kind + '/' + corsError.networkDiagnosis) : 'no error');
  push('A refused preflight costs exactly one attempt', corsStub.state.calls.length === 1, corsStub.state.calls.length + ' attempts');
  push('The failure names CORS and points at the relay',
    !!corsError && /Disallowed CORS origin/.test(corsError.message) && /jev-relay\.js/.test(corsError.message),
    corsError ? String(corsError.message).slice(0, 70) : 'none');
  push('The health state records the rejection', corsApi.jevHealth.lastError === 'CORS/preflight rejected',
    corsApi.jevHealth.lastError);
  push('The relay preset is recognised as loopback transport',
    corsApi.isRelayEndpoint('http://127.0.0.1:8787/api/jev') === true &&
    corsApi.isRelayEndpoint('https://api.typesafe.ai/v1/systemone') === false);
  corsApi.config.typesafeUrl = 'https://api.typesafe.ai/v1/systemone';
  corsApi.jevHealth.lastError = null;
  push('The vendor endpoint is labelled direct', corsApi.jevModeLabel() === 'direct (live)', corsApi.jevModeLabel());
  corsApi.config.typesafeUrl = corsApi.RELAY_DEFAULT_URL;
  push('The relay endpoint is labelled as such', corsApi.jevModeLabel() === 'relay 127.0.0.1:8787', corsApi.jevModeLabel());
  push('Any failure still blocks the start gate', (function () {
    corsApi.jevHealth.lastError = 'x';
    return corsApi.jevModeLabel() === 'error';
  })());
  corsApi.jevHealth.lastError = null;

  /* 3d-quater. The panel must tell "Jev is unsure" apart from "Jev failed". */
  const unsureStub = createJevStub({ confidence: 0.44 });
  const unsureApi = createSandbox(unsureStub);
  Object.assign(unsureApi.config, {
    typesafeUrl: 'https://api.typesafe.ai/v1/systemone', typesafeKey: 'k', jevModel: 'jev-latest', typesafeRetries: 0
  });
  await unsureApi.evaluateWithJev(unsureApi.createInitialState(0), unsureApi.DEFAULT_RULES, {});
  const jevRows = unsureApi.logState.entries.filter(function (e) { return e.channel === 'JEV'; });
  push('A low-confidence answer is logged as a warning, never as an error',
    jevRows.length === 1 && jevRows[0].level === 'warn' && /LOW CONFIDENCE/.test(jevRows[0].message),
    jevRows.length ? (jevRows[0].level + ': ' + jevRows[0].message.slice(0, 40)) : 'no JEV row');
  push('That answer still counts as a live call, not an error',
    unsureApi.Telemetry.jevCalls === 1 && unsureApi.Telemetry.jevErrors === 0,
    unsureApi.Telemetry.jevCalls + '/' + unsureApi.Telemetry.jevErrors);
  unsureApi.jevHealth.lastError = 'stale outage';
  const openingMoves = unsureApi.legalMovesForSide(unsureApi.createInitialState(0), unsureApi.SIDE_CATS);
  await unsureApi.evaluateWithJev(unsureApi.applyMove(unsureApi.createInitialState(0), openingMoves[0]), unsureApi.DEFAULT_RULES, {});
  push('A successful answer clears an earlier outage flag', unsureApi.jevHealth.lastError === null, unsureApi.jevHealth.lastError);

  /* 3d-quinquies. Running the page self-test must NOT look like a System-1 outage. */
  const hygieneStub = createJevStub();
  const hygieneApi = createSandbox(hygieneStub);
  Object.assign(hygieneApi.config, {
    typesafeUrl: 'http://127.0.0.1:8787/api/jev', typesafeKey: '', jevModel: 'jev-latest', typesafeRetries: 0
  });
  await hygieneApi.probeJevConnection({});
  const callsAfterProbe = hygieneStub.state.calls.length;
  const hygieneChecks = hygieneApi.runEngineSelfTest();
  await hygieneApi.runAsyncSelfTest(hygieneChecks);
  push('The self-test leaves the health chip alone',
    hygieneApi.jevModeLabel() === 'relay 127.0.0.1:8787' && hygieneApi.jevHealth.lastError === null,
    hygieneApi.jevModeLabel() + ' / ' + hygieneApi.jevHealth.lastError);
  push('The self-test leaves the telemetry alone',
    hygieneApi.Telemetry.jevErrors === 0 && hygieneApi.Telemetry.jevCalls === 1 &&
    hygieneStub.state.calls.length === callsAfterProbe,
    'err=' + hygieneApi.Telemetry.jevErrors + ' calls=' + hygieneApi.Telemetry.jevCalls);
  const probeRows = hygieneApi.logState.entries.filter(function (e) { return /\[self-test\]/.test(e.message); });
  push('Its deliberate failure is logged as an informational probe',
    probeRows.length === 1 && probeRows[0].level === 'info', probeRows.length ? probeRows[0].level : 'no row');

  /* 3d-sexies. The advice must fit the endpoint: loopback cannot be CORS. */
  const loopStub = createJevStub();
  loopStub.state.mode = 'cors';
  const loopApi = createSandbox(loopStub);
  Object.assign(loopApi.config, {
    typesafeUrl: 'http://127.0.0.1:8787/api/jev', typesafeKey: '', jevModel: 'jev-latest', typesafeRetries: 0
  });
  let loopError = null;
  try {
    await loopApi.evaluateWithJev(loopApi.createInitialState(0), loopApi.DEFAULT_RULES, {});
  } catch (error) {
    loopError = error;
  }
  push('A dead relay is diagnosed as "not running", not as CORS',
    !!loopError && /not running|connection refused/.test(loopError.message) &&
    !/Disallowed CORS origin/.test(loopError.message),
    loopError ? String(loopError.message).slice(0, 70) : 'none');
  push('The health label names the dead relay',
    loopApi.jevHealth.lastError === '127.0.0.1:8787 not answering', loopApi.jevHealth.lastError);

  /* 3e. A full match on stub answers. runHarness is a measurement primitive: it plays the rule set
     that is already loaded, and never asks System 2 for a new one. */
  api.resetHarness(false);
  await api.runHarness({});
  const outcome = api.match.terminal ? api.match.terminal.winner + ':' + api.match.terminal.reason : 'none';
  push('A full match reaches a terminal position on Jev values only',
    api.match.status === 'finished' && outcome !== 'none', outcome + ' @ply ' + api.match.state.ply);
  push('Inference calls never exceed the endpoint hits',
    api.Telemetry.jevCalls > 0 && api.Telemetry.jevCalls <= stub.state.calls.length,
    api.Telemetry.jevCalls + ' / ' + stub.state.calls.length);
  push('A match played without System 2 is labelled as bootstrap play',
    api.logState.entries.some(function (e) { return /Bootstrap play/.test(e.message); }),
    api.logState.entries.filter(function (e) { return /Bootstrap play/.test(e.message); }).length + ' row(s)');
  const seriesRows = api.logState.entries.filter(function (e) { return /Cat value series V\(s\) by ply/.test(e.message); });
  push('The finished match ends with a readable value-series autopsy',
    seriesRows.length === 1 && /lowest at ply/.test(seriesRows[0].message), seriesRows.length ? seriesRows[0].message.slice(0, 60) : 'no row');

  /* 3e-bis. A dead System 2 must be shouted about, not glossed over. */
  const learnApi = createSandbox(createJevStub());
  learnApi.Telemetry.llmCalls = 2;
  learnApi.Telemetry.llmErrors = 2;
  learnApi.reportLearningStatus();
  const blockedRows = learnApi.logState.entries.filter(function (e) { return /LEARNING BLOCKED/.test(e.message); });
  push('A match whose System 2 never answered reports LEARNING BLOCKED',
    blockedRows.length === 1 && blockedRows[0].level === 'error',
    blockedRows.length ? blockedRows[0].level : 'no row');
  push('That report names the rule set it actually played and the URL pitfall',
    blockedRows.length === 1 && /rule set v/.test(blockedRows[0].message) &&
    /chat\/completions/.test(blockedRows[0].message));

  /* 3e-ter. Locale-friendly numbers: "0,9" must not silently become the default. */
  const numApi = createSandbox(createJevStub(), null, true);
  push('A comma decimal is read as the operator meant',
    numApi.parseNumericInput('0,9') === 0.9 && numApi.parseNumericInput(' 0.9 ') === 0.9, numApi.parseNumericInput('0,9'));
  push('Junk in a numeric field is rejected', Number.isNaN(numApi.parseNumericInput('abc')));
  numApi.__dom.elements.get('cfg-llm-temp').value = '0,9';
  numApi.__dom.elements.get('cfg-llm-url').value = 'https://vllm.example/v1/chat/completions';
  numApi.readConfigFromForm();
  push('The temperature keeps 0.9 instead of falling back to the default',
    numApi.config.llmTemperature === 0.9, numApi.config.llmTemperature);
  push('The LLM URL survives the form round trip',
    numApi.config.llmUrl === 'https://vllm.example/v1/chat/completions', numApi.config.llmUrl);
  numApi.__dom.elements.get('cfg-llm-temp').value = 'nonsense';
  const numericProblems = numApi.readConfigFromForm();
  push('Junk in a number field is reported instead of hidden',
    numApi.config.llmTemperature === 0.3 &&
    numericProblems.some(function (problem) { return /is not a number/.test(problem); }),
    numericProblems.join(' | ') || 'no problems reported');

  /* 3e-ter. The Jev schema document System 2 now reads, and the fate of a question this build
     cannot compose yet. */
  const schemaDoc = api.buildJevSchemaDoc();
  push('the schema document names every question type with its criteria shape',
    Object.keys(api.QUESTION_TYPES).every(function (type) {
      return schemaDoc.indexOf(type + ': { "type": "' + type + '"') >= 0 &&
        schemaDoc.indexOf(api.QUESTION_TYPES[type].criteriaShape) >= 0;
    }), schemaDoc.length + ' chars');
  push('the schema document carries the answer contract and the number mapping',
    schemaDoc.indexOf('ANSWER CONTRACT') >= 0 && schemaDoc.indexOf('NO confidence at all') >= 0 &&
    schemaDoc.indexOf('HOW AN ANSWER BECOMES ONE NUMBER') >= 0 &&
    schemaDoc.indexOf('score / (levels - 1)') >= 0 && schemaDoc.indexOf('Levels: 3..9') >= 0);
  push('the schema document names the id rules and what a battery must contain',
    schemaDoc.indexOf('ID RULES') >= 0 && schemaDoc.indexOf('answers.cat_line') >= 0 &&
    schemaDoc.indexOf('needs at least one VALUE question') >= 0);
  push('the prompt says V(s) is composed from the battery the AUTHOR declares (de-anchored)',
    api.buildLlmSystemPrompt().indexOf('The VALUE-question ids and the measures are yours to define') >= 0 &&
    api.RULES_JSON_SHAPE.indexOf('your_value_question_1') >= 0 &&
    api.RULES_JSON_SHAPE.indexOf('cats_win_forecast') < 0);
  push('the schema document invites a NEW question and a policy role',
    schemaDoc.indexOf('ADDING A QUESTION') >= 0 && schemaDoc.indexOf('ROLES: every question declares') >= 0 &&
    schemaDoc.indexOf('options_from') >= 0 && schemaDoc.indexOf('at least one VALUE question') >= 0);
  push('the system prompt embeds the schema document, built per request',
    api.buildLlmSystemPrompt().indexOf(schemaDoc) >= 0 &&
    api.buildLlmSystemPrompt().indexOf('Required JSON shape:') >= 0);
  push('the required JSON shape is rendered from the live battery, not hand-copied',
    api.renderRulesShape(api.DEFAULT_BATTERY).indexOf('"cats_win_forecast": <0..1>') >= 0 &&
    api.renderRulesShape({ cats_win_forecast: { type: 'choice' } }).indexOf('"cats_win_forecast": { "type": "choice"') >= 0);

  const proposedRules = {
    version: 99, rationale: 'test whether an unbroken Cat line explains the loss',
    weights: { cats_win_forecast: 0.4, cat_line: 0.4, badId: 0.2, move_choice: 0.2 },
    battery: {
      cats_win_forecast: api.DEFAULT_BATTERY.cats_win_forecast,
      cat_line: { type: 'noul', instructions: 'Is the Cat line unbroken?', criteria: { true: 'the line is whole', false: 'a Cat is stranded' } },
      move_choice: { type: 'choice', used_as: 'policy', options_from: 'legal_moves', subject: 'cats', instructions: 'Which Cat move holds the line?' },
      badId: { type: 'noul', instructions: 'invalid id, uppercase letters', criteria: { true: 'y', false: 'n' } },
      shaped: { type: 'score', instructions: 'too few levels', criteria: ['only one'] }
    }
  };
  const gated = api.normalizeRules(proposedRules, { fallback: api.DEFAULT_RULES, source: 'llm' });
  push('an invented value question survives the gate with its wording',
    !!gated.rules.battery.cat_line && gated.rules.battery.cat_line.instructions === 'Is the Cat line unbroken?');
  push('a policy question survives the gate and is never weighted',
    !!gated.rules.battery.move_choice && api.policyAtoms(gated.rules.battery).join(',') === 'move_choice' &&
    Object.keys(gated.rules.weights).sort().join(',') === 'cat_line,cats_win_forecast',
    JSON.stringify(gated.rules.weights));
  push('the weights are renormalised over the battery\'s value atoms',
    api.valueAtoms(gated.rules.battery).join(',') === 'cats_win_forecast,cat_line' &&
    Math.abs(gated.rules.weights.cats_win_forecast + gated.rules.weights.cat_line - 1) < 0.01);
  push('a weight for a policy question is reported as ignored',
    gated.warnings.some(function (w) { return w.indexOf('move_choice') >= 0 && w.indexOf('never enters V(s)') >= 0; }),
    gated.warnings.join(' | '));
  const dropped = api.collectDroppedQuestions(proposedRules, gated.rules.battery);
  push('the questions the gate refused are identified', dropped.sort().join(',') === 'badId,shaped', dropped.join(','));
  const droppedBefore = api.Telemetry.droppedQuestions;
  const logBefore = api.logState.entries.length;
  api.noteDroppedQuestions(proposedRules, gated.rules.battery, 'selftest');
  const newEntries = api.logState.entries.slice(logBefore);
  push('a refused question is counted and logged as never reaching Jev',
    api.Telemetry.droppedQuestions === droppedBefore + 2 &&
    newEntries.some(function (entry) {
      return entry.channel === 'LLM' && entry.level === 'warn' &&
        entry.message.indexOf('QUESTION DROPPED') >= 0 && entry.message.indexOf('never sent to Jev') >= 0;
    }), api.Telemetry.droppedQuestions + ' counted');
  push('a valid battery reports no refused question',
    api.collectDroppedQuestions({ battery: { cats_win_forecast: {}, cat_line: {} } }, { cats_win_forecast: {}, cat_line: {} }).length === 0);
  const metaContext = api.buildMetaContext(api.createInitialState(0), {});
  push('the mutation payload tells the model the derived atoms, the roles and the cap',
    !!metaContext.battery_in_use && metaContext.battery_in_use.value_atoms.join(',') === api.DEFAULT_VALUE_ATOMS.join(',') &&
    metaContext.battery_in_use.policy_atoms.length === 0 &&
    metaContext.battery_in_use.max_questions === api.MAX_QUESTIONS && !!metaContext.question_role_policy);

  /* 3e-quater. The POLICY role end to end: Jev's own move distribution orders the search, never
     values it, and the width cut is an approximation with guards. */
  const policyRules = {
    version: 7, rationale: 'policy prior', confidenceFloor: 0.7,
    weights: { cats_win_forecast: 1 },
    battery: {
      cats_win_forecast: api.DEFAULT_BATTERY.cats_win_forecast,
      move_choice: { type: 'choice', used_as: 'policy', options_from: 'legal_moves', subject: 'side_to_move', instructions: 'Which move is best?', criteria: {} }
    }
  };
  const policyStub = createJevStub();
  const policyApi = createSandbox(policyStub);
  Object.assign(policyApi.config, {
    typesafeUrl: 'https://api.typesafe.ai/v1/systemone', typesafeKey: 'test-key', jevModel: 'jev-latest',
    depth: 2, parallelBranch: 2, seed: 7, mouseStartCol: 0, stepDelayMs: 0,
    policyDepth: 1, confidenceFloor: 0.7
  });
  const pState = policyApi.createInitialState(0);
  const pCtx = policyApi.createSearchContext({ rules: policyRules, depth: 2, rootDepth: 2 });
  const callsBeforePolicy = policyStub.state.calls.length;
  const prior = await policyApi.policyPriorFor(pState, policyRules, pCtx);
  const legalKeys = policyApi.legalMovesForSide(pState, policyApi.SIDE_CATS).map(function (m) { return policyApi.moveKey(m); });
  push('the policy prior is built from the legal moves of the state',
    !!prior && Object.keys(prior).join('|') === legalKeys.join('|'), prior ? Object.keys(prior).length + ' moves' : 'none');
  push('the policy request is materialised with null rubrics and no harness fields',
    (function () {
      const body = policyStub.state.calls[policyStub.state.calls.length - 1].body;
      const question = body.questions.move_choice;
      return Object.keys(question).sort().join(',') === 'criteria,instructions,type' &&
        Array.isArray(body.state.cats) && Array.isArray(body.state.mouse) &&
        Object.keys(question.criteria).length === legalKeys.length &&
        legalKeys.every(function (k) { return question.criteria[k] === null; });
    })());
  const callsAfterFirst = policyStub.state.calls.length;
  await policyApi.policyPriorFor(pState, policyRules, pCtx);
  push('a second look at the same state costs no second call',
    policyStub.state.calls.length === callsAfterFirst && callsAfterFirst === callsBeforePolicy + 1,
    policyStub.state.calls.length - callsBeforePolicy);
  push('the prior orders the frontier first and never enters V(s)',
    (function () {
      const legal = policyApi.legalMovesForSide(pState, policyApi.SIDE_CATS);
      const ordered = policyApi.orderMoves(pState, legal, pCtx, prior);
      const argmax = Object.keys(prior).reduce(function (best, k) { return (best === null || prior[k] > prior[best]) ? k : best; }, null);
      const parsed = policyApi.parseJevAnswers({ answers: {
        cats_win_forecast: { type: 'choice', probabilities: { cats_win: 0.9 }, confidence: 0.9 },
        move_choice: { type: 'choice', probabilities: { x: 1 }, confidence: 0.9 }
      } }, policyRules.battery);
      return policyApi.moveKey(ordered[0]) === argmax &&
        policyApi.composeLeafValue(parsed.atoms, policyRules.weights) === 0.9 &&
        !('move_choice' in parsed.atoms);
    })());
  const plainStubCalls = policyStub.state.calls.length;
  await policyApi.evaluateWithJev(pState, policyRules, {});
  push('a leaf call after a policy call is a separate cache entry, not a reuse',
    policyApi.jevAnswerCache.size > 1 && policyStub.state.calls.length === plainStubCalls + 1,
    policyStub.state.calls.length - plainStubCalls);
  const offCalls = policyStub.state.calls.length;
  push('policyDepth 0 asks for nothing at all',
    (await policyApi.policyPriorFor(pState, policyRules, policyApi.createSearchContext({ rules: policyRules, depth: 2, policyDepth: 0 }))) === null &&
    policyStub.state.calls.length === offCalls);
  push('a default battery (no policy question) never pays for a prior',
    (await policyApi.policyPriorFor(pState, api.DEFAULT_RULES, policyApi.createSearchContext({ rules: api.DEFAULT_RULES, depth: 2 }))) === null);

  /* The prior ORDERS the search and never narrows it: every legal move is searched, whatever the
     prior says. (The width cut was removed: a value that only orders costs nothing, a cut trades
     correctness for speed.) */
  const allMoves = policyApi.legalMovesForSide(pState, policyApi.SIDE_CATS);
  const allOrdered = policyApi.orderMoves(pState, allMoves, policyApi.createSearchContext({ rules: policyRules, depth: 2 }), prior);
  push('the prior never drops a move: the search keeps the full legal width',
    allOrdered.length === allMoves.length &&
    allMoves.every(function (move) { return allOrdered.indexOf(move) >= 0; }),
    allOrdered.length + '/' + allMoves.length);
  /* A position where one Cat move traps the Mouse: it must be searched whatever the prior says. */
  const trapReady = { cats: [[1, 0], [2, 1], [5, 0], [7, 0]], mouse: [0, 1], turn: api.SIDE_CATS, ply: 2 };
  const trapMoves = policyApi.legalMovesForSide(trapReady, api.SIDE_CATS);
  const winningMove = trapMoves.filter(function (move) { return policyApi.isTerminal(policyApi.applyMove(trapReady, move)).winner === api.SIDE_CATS; })[0];
  push('the test position really contains a rule-win', !!winningMove, winningMove ? policyApi.describeMove(winningMove) : 'none');
  const trapPrior = {};
  trapMoves.forEach(function (move) { trapPrior[policyApi.moveKey(move)] = 0.9; });
  if (winningMove) trapPrior[policyApi.moveKey(winningMove)] = 0.001;
  const trapOrdered = policyApi.orderMoves(trapReady, trapMoves, policyApi.createSearchContext({ rules: policyRules, depth: 2 }), trapPrior);
  push('a low-ranked move that wins by the rules is still searched',
    !!winningMove && trapOrdered.indexOf(winningMove) >= 0 && trapOrdered.length === trapMoves.length,
    trapOrdered.length + ' kept');

  const searchStub = createJevStub();
  const searchApi = createSandbox(searchStub);
  Object.assign(searchApi.config, {
    typesafeUrl: 'https://api.typesafe.ai/v1/systemone', typesafeKey: 'test-key', jevModel: 'jev-latest',
    depth: 2, parallelBranch: 2, seed: 7, mouseStartCol: 0, stepDelayMs: 0,
    policyDepth: 1, confidenceFloor: 0.7
  });
  const policySearch = await searchApi.searchBestMove(searchApi.createInitialState(0), policyRules, { depth: 2, parallelBatch: 2 });
  push('a search with a policy battery makes policy calls and scores its argmax',
    searchApi.Telemetry.policyCalls > 0 && searchApi.Telemetry.policyArgmaxChecks > 0 &&
    searchApi.Telemetry.policyArgmaxHits <= searchApi.Telemetry.policyArgmaxChecks && !!policySearch.result.bestMove,
    searchApi.Telemetry.policyCalls + ' policy calls, hit ' + searchApi.Telemetry.policyArgmaxHits + '/' + searchApi.Telemetry.policyArgmaxChecks);
  push('the policy search still returns a legal Cat move',
    !!policySearch.result.bestMove && searchApi.legalMovesForSide(searchApi.createInitialState(0), searchApi.SIDE_CATS).some(function (move) {
      return searchApi.moveKey(move) === searchApi.moveKey(policySearch.result.bestMove);
    }));
  push('the removed width cut is not reachable from the engine API',
    policyApi.narrowMoves === undefined && policyApi.runPolicyComparison === undefined &&
    policyApi.config.policyWidth === undefined);

  /* 3e-sexies. M-B-02: the merge between policy questions is DECLARED, and it is an average. */
  {
    const mergeApi = createSandbox(createJevStub({}));
    const twoQuestions = [
      { id: 'closing_line', distribution: { m1: 0.9, m2: 0.1 } },
      { id: 'escape_denial', distribution: { m1: 0.1, m2: 0.9 } }
    ];
    const weighted = mergeApi.mergePolicyDistributions(twoQuestions, 'weighted_mean', { closing_line: 0.75, escape_denial: 0.25 });
    push('weighted_mean averages the declared distributions with the policy weights (never a maximum)',
      Math.abs(weighted.prior.m1 - 0.7) < 0.001 && Math.abs(weighted.prior.m2 - 0.3) < 0.001 &&
      weighted.prior.m1 !== 0.9 && weighted.mode === 'weighted_mean' && weighted.used.length === 2 &&
      weighted.ignored.length === 0,
      'm1 ' + weighted.prior.m1 + ' (max would be 0.9), m2 ' + weighted.prior.m2);
    const single = mergeApi.mergePolicyDistributions(twoQuestions, 'single', {});
    push('single lets the first declared policy question decide and REPORTS the ones it ignored',
      Math.abs(single.prior.m1 - 0.9) < 0.001 && single.used.join(',') === 'closing_line' &&
      single.ignored.join(',') === 'escape_denial' && single.mode === 'single',
      'used ' + single.used.join(',') + ', ignored ' + single.ignored.join(','));
    const policyWeightGate = mergeApi.normalizePolicyWeights({ closing_line: 0.75, escape_denial: 0.25 }, ['closing_line', 'escape_denial'], {});
    const clippedPolicyWeights = mergeApi.normalizePolicyWeights({ closing_line: 3, escape_denial: 1 }, ['closing_line', 'escape_denial'], {});
    const declaredBattery = {
      cats_win_forecast: { type: 'choice', used_as: 'value', instructions: 'x', criteria: { cats_win: 'a', mouse_win: 'b' } },
      move_choice: { type: 'choice', used_as: 'policy', options_from: 'legal_moves', subject: 'side_to_move', instructions: 'y', criteria: {}, aggregate: 'weighted_mean' }
    };
    push('policy weights are clipped like the value weights, renormalised, and the aggregate is read from the battery',
      Math.abs(policyWeightGate.policyWeights.closing_line - 0.75) < 0.001 &&
      Math.abs(policyWeightGate.policyWeights.escape_denial - 0.25) < 0.001 &&
      Math.abs(clippedPolicyWeights.policyWeights.closing_line - 0.5) < 0.001 &&
      clippedPolicyWeights.warnings.some(function (w) { return w.indexOf('clipped') >= 0; }) &&
      mergeApi.policyAggregateMode(declaredBattery).mode === 'weighted_mean' &&
      mergeApi.policyAggregateMode(declaredBattery).ids.join(',') === 'move_choice',
      'weights ' + JSON.stringify(policyWeightGate.policyWeights) + ', clipped 3:1 -> ' +
      JSON.stringify(clippedPolicyWeights.policyWeights) + ', mode ' + mergeApi.policyAggregateMode(declaredBattery).mode);
  }

  /* 3e-quinquies. One game per call, and the rule set is frozen inside it. Low confidence is
     recorded for the learner instead of mutating the hypothesis under test. */
  const frozenStub = createJevStub({ confidence: 0.2 });
  const frozenApi = createSandbox(frozenStub);
  Object.assign(frozenApi.config, {
    typesafeUrl: 'https://api.typesafe.ai/v1/systemone', typesafeKey: 'test-key', jevModel: 'jev-latest',
    llmUrl: '', depth: 1, parallelBranch: 2, seed: 3, mouseStartCol: 0, stepDelayMs: 0, confidenceFloor: 0.7
  });
  frozenApi.resetHarness(false);
  const versionBeforeGame = frozenApi.match.rules.version;
  await frozenApi.runHarness({});
  push('a game measures the rule set it started with (no mid-game mutation)',
    frozenApi.match.rules.version === versionBeforeGame && frozenApi.Telemetry.restarts === 0,
    'v' + frozenApi.match.rules.version + ', restarts ' + frozenApi.Telemetry.restarts);
  push('low confidence is recorded as evidence and queues the path cases without a single call',
    frozenApi.logState.entries.some(function (e) { return e.channel === 'LLM' && e.level === 'warn' && e.message.indexOf('wants a System-2 consult') >= 0; }) &&
    (frozenApi.match.pathCases || []).length > 0 && frozenApi.Telemetry.courseCorrectionCalls === 0 &&
    frozenApi.match.rules.version === versionBeforeGame,
    frozenApi.match.pathCases.length + ' case(s) queued, ' + frozenApi.Telemetry.courseCorrectionCalls + ' consult(s)');
  push('one runHarness call plays exactly one game and never replays a loss',
    frozenApi.logState.entries.filter(function (e) { return e.message.indexOf('Losing-game feedback') >= 0; }).length === 0);
  /* The single entry point: it needs System 1, and it stops when System 2 cannot hypothesise. */
  const gateStub = createJevStub();
  gateStub.state.mode = 'cors';
  const gateApi = createSandbox(gateStub);
  Object.assign(gateApi.config, {
    typesafeUrl: 'https://api.typesafe.ai/v1/systemone', typesafeKey: 'k', jevModel: 'jev-latest',
    llmUrl: '', depth: 1, parallelBranch: 1, autotuneHypotheses: 1, autotuneTrials: 1
  });
  await gateApi.startLearningWithHealthGate();
  push('the single entry point refuses to learn without a working System 1',
    gateApi.match.status !== 'tuning' && gateApi.match.tuning === null &&
    gateApi.logState.entries.some(function (e) { return e.channel === 'ERROR' && e.message.indexOf('Search blocked') >= 0; }));
  const honestStub = createJevStub();
  const honestApi = createSandbox(honestStub);
  Object.assign(honestApi.config, {
    typesafeUrl: 'https://api.typesafe.ai/v1/systemone', typesafeKey: 'k', jevModel: 'jev-latest',
    llmUrl: '', depth: 1, parallelBranch: 2, autotuneHypotheses: 1, autotuneTrials: 1, stepDelayMs: 0
  });
  /* The page's button calls the gate without awaiting it (the UI must return immediately), so the
     loop itself is what this test drives. */
  await honestApi.runLearning();
  push('with no System 2 the loop refuses to start and plays no game at all',
    honestApi.match.tuning === null && honestApi.match.status === 'idle' &&
    honestApi.match.moveLog.length === 0 && honestApi.Telemetry.trialGames === 0 &&
    honestApi.logState.entries.some(function (e) {
      return e.channel === 'HALT' && e.level === 'error' &&
        e.message.indexOf('Learning refused to start') >= 0 && e.message.indexOf('No game was played') >= 0;
    }),
    honestApi.match.moveLog.length + ' moves, ' + honestApi.Telemetry.trialGames + ' games');
  /* F1: with a working System 2 the FIRST attempt plays a rule set System 2 proposed, not the
     shipped neutral prior. The dual stub answers both endpoints. */
  const dual = createDualStub({
    proposals: [
      { version: 1, rationale: 'first candidate', weights: { cats_win_forecast: 1 }, confidenceFloor: 0.7 },
      { version: 2, rationale: 'second candidate', weights: { cats_win_forecast: 0.8, mouse_containment: 0.2 }, confidenceFloor: 0.7 }
    ]
  });
  const candidateApi = createSandbox(dual);
  Object.assign(candidateApi.config, {
    typesafeUrl: 'https://api.typesafe.ai/v1/systemone', typesafeKey: 'k', jevModel: 'jev-latest',
    llmUrl: 'https://stub.local/v1/chat/completions', llmModel: 'stub-llm', llmKey: 'k',
    depth: 1, parallelBranch: 2, autotuneHypotheses: 1, autotuneTrials: 1, stepDelayMs: 0
  });
  candidateApi.resetHarness(false);
  const startSource = candidateApi.match.rules.source;
  await candidateApi.runLearning();
  const logMessages = candidateApi.logState.entries.map(function (e) { return e.channel + ':' + e.message; });
  const compileAt = logMessages.findIndex(function (m) { return m.indexOf('System 2 compiled rules v1') >= 0; });
  const attemptAt = logMessages.findIndex(function (m) { return /Attempt 1 rules v1 -> \d+\/1 cat wins/.test(m); });
  const probeGames = candidateApi.Telemetry.trialGames - 1;   // the extra game is the depth probe, if any
  push('the loop asks System 2 for a candidate BEFORE the first attempt',
    compileAt >= 0 && attemptAt >= 0 && compileAt < attemptAt &&
    candidateApi.Telemetry.trialGames >= 1 && probeGames <= 1,
    'compile@' + compileAt + ' attempt@' + attemptAt + ', ' + candidateApi.Telemetry.trialGames + ' game(s) (' + probeGames + ' depth probe)');
  push('that candidate is a System-2 proposal, never the shipped prior',
    logMessages.some(function (m) { return m.indexOf('starting from v1 [llm-compile]') >= 0; }) &&
    startSource === 'default',
    'compile-at-' + compileAt + ' < attempt-at-' + attemptAt + ' is what makes the first attempt a hypothesis');
  const consults = candidateApi.Telemetry.courseCorrectionCalls;
  const proposals = candidateApi.Telemetry.trialWins >= 1 ? 0 : 1;
  push('the attempt is scored, the next candidate waits for a loss, and every other call is a budgeted path consult',
    dual.llmCalls.length === 1 + proposals + consults &&
    consults <= candidateApi.config.midgameCorrections * candidateApi.Telemetry.trialGames,
    dual.llmCalls.length + ' llm call(s) = 1 compile + ' + proposals + ' proposal + ' + consults +
    ' mid-game consult(s) over ' + candidateApi.Telemetry.trialGames + ' game(s)');
  /* F2: the cost of each attempt is measured and reported, and an inert alpha-beta cut explains
     itself with the numbers that caused it. Low-confidence stub so the cut really stays inert. */
  push('the attempt reports its measured cost (nodes, leaves, live calls, time)',
    logMessages.some(function (m) { return /Attempt 1 cost: \d+ nodes, \d+ leaf evals, \d+ live Jev calls in \d/.test(m); }),
    logMessages.filter(function (m) { return m.indexOf('cost:') >= 0; }).slice(-1)[0]);
  const lowDual = createDualStub({ jev: { confidence: 0.3 } });
  const inertApi = createSandbox(lowDual);
  Object.assign(inertApi.config, {
    typesafeUrl: 'https://api.typesafe.ai/v1/systemone', typesafeKey: 'k', jevModel: 'jev-latest',
    llmUrl: 'https://stub.local/v1/chat/completions', llmModel: 'stub-llm', llmKey: 'k',
    depth: 1, parallelBranch: 2, autotuneHypotheses: 1, autotuneTrials: 1, stepDelayMs: 0
  });
  inertApi.resetHarness(false);
  await inertApi.runLearning();
  const inertMessages = inertApi.logState.entries.map(function (e) { return e.message; });
  push('an inert confidence gate is explained with the confidence that caused it',
    inertApi.Telemetry.confidenceMean !== null && Math.abs(inertApi.Telemetry.confidenceMean - 0.3) < 0.001 &&
    inertApi.Telemetry.confidenceBelowFloor > 0 && inertApi.Telemetry.jevPrunes === 0 &&
    inertMessages.some(function (m) {
      return m.indexOf('No confidence-gated pruning in this attempt') >= 0 &&
        m.indexOf('were below 0.7') >= 0 && m.indexOf('DEPTH is the lever') >= 0;
    }),
    'mean ' + inertApi.Telemetry.confidenceMean + ', ' + inertApi.Telemetry.confidenceBelowFloor + ' below floor, ' +
    inertApi.Telemetry.jevPrunes + ' gated cuts, ' + inertApi.Telemetry.certainPrunes + ' rules-certain cuts');
  push('the confidence measurement is a real Welford aggregate, not a last-value echo',
    inertApi.Telemetry.confidenceSamples > 1 && inertApi.Telemetry.confidenceMin === 0.3 &&
    inertApi.Telemetry.confidenceMax === 0.3 && inertApi.Telemetry.confidenceSigma() === 0);
  const snapshot = inertApi.Telemetry.snapshot();
  push('the telemetry snapshot carries the confidence aggregate',
    snapshot.jev_confidence_mean === 0.3 && snapshot.jev_confidence_sigma === 0 &&
    snapshot.leaves_below_floor > 0 && snapshot.leaves_below_floor <= snapshot.leaf_evals);

  /* 3i. PLAY MODE: a human against the accepted rule set. It must use the same rule set, never
     call System 2, never change the rule set, and refuse an illegal move on rules-engine grounds. */
  const playStub = createJevStub();
  const playApi = createSandbox(playStub);
  Object.assign(playApi.config, {
    typesafeUrl: 'https://api.typesafe.ai/v1/systemone', typesafeKey: 'test-key', jevModel: 'jev-latest',
    llmUrl: '', depth: 1, parallelBranch: 2, seed: 5, mouseStartCol: 0, stepDelayMs: 0, humanSide: 'mouse'
  });
  playApi.resetHarness(false);
  push('play mode refuses to start without an accepted rule set',
    playApi.playAvailable() === false &&
    playApi.startPlayMode(playApi.SIDE_MOUSE) === false &&
    playApi.logState.entries.some(function (e) { return e.channel === 'PLAY' && e.level === 'error'; }));
  playApi.match.bestRules = playApi.normalizeRules({ version: 9, rationale: 'play', weights: { cats_win_forecast: 1 } },
    { fallback: playApi.DEFAULT_RULES }).rules;
  push('an accepted rule set makes the game available and the hint says so',
    playApi.playAvailable() === true && playApi.playHintText().indexOf('press "New game"') >= 0);
  const llmBeforePlay = playApi.Telemetry.llmCalls;
  const playVersion = playApi.match.bestRules.version;
  push('the human game starts and the engine answers the opening move',
    playApi.startPlayMode(playApi.SIDE_MOUSE) === true &&
    playApi.match.play.humanSide === playApi.SIDE_MOUSE);
  await playApi.match.play.pending;
  push('the engine moved (the Cats opened) and it is now the human turn',
    playApi.match.state.ply === 1 && playApi.match.state.turn === playApi.SIDE_MOUSE,
    playApi.match.state.ply + ' plies, ' + playApi.match.state.turn + ' to move');
  push('the value on screen came from Jev and the rule set is the accepted one',
    playApi.match.rules.version === playVersion && Number.isFinite(playApi.match.winProbability) &&
    playApi.match.jevSource.indexOf('live Jev composite V(s)') >= 0);
  const humanMove = playApi.legalMovesForSide(playApi.match.state, playApi.SIDE_MOUSE)[0];
  const plyBefore = playApi.match.state.ply;
  push('a legal human move is applied (clicking source then destination)',
    playApi.handleBoardClick(humanMove.from[0], humanMove.from[1]) === false &&
    playApi.match.play.selected.join(',') === humanMove.from.join(',') &&
    playApi.playHumanMove(humanMove.from[0], humanMove.from[1], humanMove.to[0], humanMove.to[1]) === true &&
    playApi.match.moveLog.length > 0);
  await playApi.match.play.pending;
  push('the engine answers again, so the human gets the turn back',
    playApi.match.state.ply > plyBefore + 1 && playApi.match.state.turn === playApi.SIDE_MOUSE,
    playApi.match.state.ply + ' plies');
  push('System 2 was never called during the human game',
    playApi.Telemetry.llmCalls === llmBeforePlay, playApi.Telemetry.llmCalls + ' llm calls');
  push('the rule set never changed during the human game',
    playApi.match.rules.version === playVersion && playApi.Telemetry.restarts === 0);
  const illegal = playApi.playHumanMove(7, 0, 6, 0);
  push('an illegal human move is refused by the rules engine, not guessed',
    illegal === false && playApi.logState.entries.some(function (e) {
      return e.channel === 'PLAY' && e.message.indexOf('Illegal move') >= 0 && e.message.indexOf('rules engine decides legality') >= 0;
    }));
  const plyBeforeUndo = playApi.match.state.ply;
  push('undo returns the game to the human\'s previous decision point',
    playApi.undoPlayPly() === true && playApi.match.state.ply < plyBeforeUndo &&
    playApi.match.state.turn === playApi.SIDE_MOUSE,
    plyBeforeUndo + ' -> ' + playApi.match.state.ply);
  push('leaving play mode clears the game and keeps the accepted rule set',
    playApi.stopPlayMode() === true && playApi.match.play === null && playApi.playRules().version === playVersion);
  /* The other branch: with the human on the Cats, the engine plays the fixed Mouse opponent. */
  push('a new human game with the Cats is accepted', playApi.startPlayMode(playApi.SIDE_CATS) === true &&
    playApi.match.play.humanSide === playApi.SIDE_CATS);
  const catMove = playApi.legalMovesForSide(playApi.match.state, playApi.SIDE_CATS)[0];
  playApi.playHumanMove(catMove.from[0], catMove.from[1], catMove.to[0], catMove.to[1]);
  await playApi.match.play.pending;
  push('with the human on the Cats, the engine replies as the fixed Mouse opponent',
    playApi.match.state.turn === playApi.SIDE_CATS &&
    playApi.match.trace.some(function (row) { return row.source === 'mouse-' + playApi.opponentModelId(); }) &&
    playApi.match.trace.some(function (row) { return row.source === 'human'; }),
    playApi.match.trace.map(function (row) { return row.source; }).join(','));

  /* 3j. TRUTH: the position is solvable against the fixed deterministic Mouse, and the harness now
     computes it instead of asking anyone's opinion. */
  const trapBoard = { cats: [[1, 0], [2, 1], [5, 0], [7, 0]], mouse: [0, 1], turn: api.SIDE_CATS, ply: 2 };
  const trapMove = api.legalMovesForSide(trapBoard, api.SIDE_CATS).filter(function (move) {
    return api.isTerminal(api.applyMove(trapBoard, move)).winner === api.SIDE_CATS;
  })[0];
  const trapTruth = api.solveAgainstModel(trapBoard, api.mouseModelDepth());
  push('the solver finds a forced trap in one Cat move',
    !!trapMove && trapTruth.winner === api.SIDE_CATS && trapTruth.plies === 1 &&
    trapTruth.reason === 'mouse_trapped' && trapTruth.exhausted === false,
    trapTruth.winner + ' in ' + trapTruth.plies + ' ply (' + trapTruth.reason + '), ' + trapTruth.nodes + ' nodes');
  const escapeReady = { cats: [[1, 0], [3, 0], [7, 0], [5, 2]], mouse: [4, 1], turn: api.SIDE_MOUSE, ply: 4 };
  const escapeTruth = api.solveAgainstModel(escapeReady, api.mouseModelDepth());
  push('the solver sees the Mouse escape when the route to row 0 is open',
    escapeTruth.winner === api.SIDE_MOUSE && escapeTruth.plies === 1 && escapeTruth.exhausted === false,
    escapeTruth.winner + ' in ' + escapeTruth.plies + ' ply');
  const again = api.solveAgainstModel(escapeReady, api.mouseModelDepth());
  push('the solver is deterministic (the opponent is, so the verdict is)',
    again.winner === escapeTruth.winner && again.plies === escapeTruth.plies);
  const starved = api.solveAgainstModel(api.createInitialState(0), api.mouseModelDepth(), { budget: 5 });
  push('an exhausted budget says unknown, never a draw',
    starved.exhausted === true && starved.winner === null && starved.plies === null &&
    Math.abs(starved.nodes - 6) <= 1,
    'winner ' + starved.winner + ', exhausted ' + starved.exhausted + ', ' + starved.nodes + '/' + starved.budget + ' nodes');
  push('the verdict declares what it does NOT cover',
    api.solveAgainstModel(escapeReady, api.mouseModelDepth()).covers.indexOf('threefold repetition is NOT modelled') >= 0);

  /* 3j-bis. THE CURRICULUM: the Mouse model is code-only, monotone in its depth, and a clean
     win raises the bar instead of ending the run - the acceptance criterion never changes. */
  push('the Mouse model is at least as deep as the Cats (the handicap is an invariant)',
    api.mouseModelDepth() >= api.config.depth && api.mouseModelDepth() <= api.MOUSE_DEPTH_MAX_LIMIT,
    'cats ' + api.config.depth + ' vs mouse ' + api.mouseModelDepth());
  const planStart = api.createInitialState(0);
  const hitsBefore = api.Telemetry.mousePlanCacheHits;
  const planA = api.planMouseMove(planStart, api.mouseModelDepth());
  const planB = api.planMouseMove(planStart, api.mouseModelDepth());
  push('the planner is deterministic and memoised (the same position, the same move, one search)',
    !!planA && api.moveKey(planA) === api.moveKey(planB) && api.Telemetry.mousePlanCacheHits > hitsBefore,
    api.Telemetry.mousePlanCalls + ' call(s), ' + api.Telemetry.mousePlanCacheHits + ' memo hit(s)');

  /* F3: the planner memo is the most consulted store in the system, so it has its own cap.
     cacheSet must (a) respect a custom limit, (b) fall back to the shared default when no
     limit is given, and (c) evict FIFO so the map never grows past its cap. */
  {
    const probe = new Map();
    api.cacheSet(probe, 'a', 1, 3); api.cacheSet(probe, 'b', 2, 3); api.cacheSet(probe, 'c', 3, 3);
    api.cacheSet(probe, 'd', 4, 3);   // this insert must evict 'a', the oldest
    push('the planner cache respects its declared limit and evicts the oldest entry first',
      probe.size === 3 && !probe.has('a') && probe.has('b') && probe.has('c') && probe.has('d'),
      'size ' + probe.size + ', keys ' + JSON.stringify(Array.from(probe.keys())));
    const noCap = new Map();
    for (let i = 0; i < 4; i++) api.cacheSet(noCap, 'k' + i, i);   // no limit -> falls back, never throws
    push('cacheSet without a limit falls back to the shared default instead of growing without bound',
      noCap.size <= api.MOUSE_PLAN_CACHE_LIMIT && noCap.has('k3'), 'size ' + noCap.size);
  }

  push('the provenance gate refuses a proposal that cites no evidence it was given',
    api.validateEvidenceRef({}, { pathBrief: { cases: [{}] } }) === false &&
    api.validateEvidenceRef({ evidence_ref: { case: 0 } }, { pathBrief: { cases: [{}] } }) === true &&
    api.validateEvidenceRef({ rules: { evidence_ref: { case: 0 } } }, { pathBrief: { cases: [{}] } }) === true &&
    api.validateEvidenceRef({}, {}) === true);

  /* M-B-05: the board reading is authorship evidence with its own gate. Structure (traceable
     positions, a definition, finite numbers) is enforced; arithmetic correctness is not - the
     reading answers "did the author show its work", never "what is the value". */
  {
    const readingOpts = { pathBrief: { cases: [{}, {}] } };
    const goodReading = {
      evidence_ref: { case: 0, why: 'the winning line keeps the spread' },
      board_reading: {
        positions: [0, 1],
        measures: [{
          name: 'horizontal_spread',
          definition: 'max(cat row) minus min(cat row) over the four Cats',
          values: { 0: 1, 1: 3 }
        }],
        distinction: 'the winning line keeps spread 1, the losing line opens to 3'
      }
    };
    push('a proposal that changes the rule set WITH a well-formed board reading passes the reading gate',
      api.validateBoardReading(goodReading, readingOpts) === true &&
      api.readingSeparatesCases(goodReading.board_reading) === true,
      'positions [0,1], spread 1 vs 3');
    push('a proposal with NO board reading fails the reading gate (a rewrite with no shown work is not a hypothesis)',
      api.validateBoardReading({ evidence_ref: { case: 0 } }, readingOpts) === false,
      'no board_reading field at all');
    push('a reading over a SINGLE board does NOT separate (the judge needs two values to compare)',
      api.validateBoardReading({
        board_reading: {
          positions: [0],
          measures: [{ name: 'horizontal_spread', definition: 'max row minus min row', values: { 0: 2 } }]
        }
      }, readingOpts) === true && api.readingSeparatesCases({
        positions: [0],
        measures: [{ name: 'horizontal_spread', definition: 'max row minus min row', values: { 0: 2 } }]
      }) === null,
      'gate passes the shape; separation is null (one value, nothing to compare)');
    push('a reading that names positions NOBODY showed fails the gate (a calculation nobody can trace is not a measurement)',
      api.validateBoardReading({
        board_reading: {
          positions: [7, 9],
          measures: [{ name: 'horizontal_spread', definition: 'max row minus min row', values: { 7: 1, 9: 3 } }]
        }
      }, readingOpts) === false,
      'positions [7,9] against 2 cases');
    push('a reading whose measures answer the SAME either way does NOT separate (evidence against the change)',
      api.readingSeparatesCases({
        positions: [0, 1],
        measures: [{ name: 'horizontal_spread', definition: 'max row minus min row', values: { 0: 2, 1: 2 } }],
        distinction: 'no separation at all'
      }) === false,
      'values 2 vs 2');
  }
  const tuningBefore = api.match.tuning;
  api.config.escalateMouse = true; api.config.escalateAfter = 1; api.config.maxEscalations = 3; api.config.mouseDepthMax = 8;
  api.match.tuning = { mouseDepth: api.config.depth, escalations: 0, consecutiveWins: 0, incumbent: null };
  const escalated = api.escalateMouseNow({ rules: { version: 1 }, wins: 3, total: 3 });
  push('a clean win escalates the Mouse, not the run: the bar rises and the loop continues',
    escalated === true && api.match.tuning.mouseDepth === api.config.depth + 1 &&
    api.match.tuning.escalations === 1 && api.match.tuning.incumbent.depth === api.config.depth &&
    api.Telemetry.escalations >= 1,
    'mouse depth ' + api.match.tuning.mouseDepth + ' after ' + api.Telemetry.escalations + ' escalation(s)');
  api.config.maxEscalations = 0;
  push('with the rung budget spent the win stands and the run stops',
    api.escalateMouseNow({ rules: { version: 1 }, wins: 3, total: 3 }) === false);
  api.config.maxEscalations = 3;
  api.match.tuning = tuningBefore;

  /* 3k. Atom dispersion: a question whose judgment never moves is dead weight, and the harness has
     to say so in those terms (changing its weight cannot fix it). */
  const statsBefore = api.Telemetry.atomStatistics().length;
  for (let i = 0; i < 60; i++) api.Telemetry.noteAtoms({ frozen_question: 0.05, lively_question: i / 60 });
  const stats = api.Telemetry.atomStatistics();
  const frozen = stats.filter(function (s) { return s.id === 'frozen_question'; })[0];
  const lively = stats.filter(function (s) { return s.id === 'lively_question'; })[0];
  push('a question that never moved is flagged as dead, with its dispersion',
    stats.length === statsBefore + 2 && frozen.dead === true && frozen.n === 60 &&
    frozen.sigma === 0 && frozen.min === 0.05 && frozen.max === 0.05,
    JSON.stringify(frozen));
  push('a question that did move is not flagged',
    lively.dead === false && lively.sigma > 0.25 && lively.min === 0 && lively.max > 0.9,
    'sigma ' + lively.sigma + ' over ' + lively.n + ' leaves');
  push('the dead flag needs enough samples before it accuses a question',
    api.Telemetry.atomStatistics({ minSamples: 500 }).every(function (s) { return s.dead === false; }));

  /* 3l. The loss report carries computed truth, and the payload hands it to System 2 together with
     the cost and the dispersion. This is the evidence the learner never had. */
  api.resetHarness(false);
  await api.runHarness({});
  const evidence = api.buildLossEvidence(api.match.terminal, null);
  push('the loss report carries computed truth for the audited positions',
    Array.isArray(evidence.truth) && evidence.truth.length > 0 && evidence.truth.length <= 3 &&
    evidence.truth.every(function (t) {
      return (t.winner === api.SIDE_CATS || t.winner === api.SIDE_MOUSE || t.winner === null) &&
        typeof t.exhausted === 'boolean' && Number.isFinite(t.nodes) && Number.isFinite(t.ply);
    }) &&
    evidence.truth_covers.indexOf('Mouse model the game actually plays') >= 0,
    evidence.truth.map(function (t) { return 'p' + t.ply + ':' + t.winner + '/' + t.plies_to_end + (t.exhausted ? '(x ' + t.nodes + ' nodes/' + t.ms + ' ms)' : '(' + t.nodes + 'n/' + t.ms + 'ms)'); }).join(' '));
  push('the diagnosis is computed in code from the truth, in one sentence',
    typeof evidence.loss_diagnosis === 'string' &&
    /THE VALUE WAS (ALREADY WRONG|RIGHT)|Truth unavailable|Truth at ply/.test(evidence.loss_diagnosis),
    evidence.loss_diagnosis.slice(0, 130));
  push('the diagnosis says the fault is earlier when the value was already wrong',
    api.describeTruthGap({ ply: 6, V: 0.54, confidence: 0.3 },
      { winner: api.SIDE_MOUSE, plies: 4, reason: 'mouse_reached_row_0', exhausted: false })
      .indexOf('THE VALUE WAS ALREADY WRONG at ply 6') >= 0 &&
    api.describeTruthGap({ ply: 6, V: 0.54, confidence: 0.3 },
      { winner: api.SIDE_CATS, plies: 4, reason: 'mouse_trapped', exhausted: false })
      .indexOf('THE VALUE WAS RIGHT at ply 6') >= 0 &&
    api.describeTruthGap({ ply: 6, V: 0.54, confidence: 0.3 },
      { winner: null, plies: null, reason: null, exhausted: true, budget: 60000 })
      .indexOf('Truth unavailable at ply 6') >= 0);
  /* The telemetry reset clears the aggregates, so the dead atom is injected after it - and the
     atoms of the real game are still there, measured, not synthesised. */
  for (let i = 0; i < 60; i++) api.Telemetry.noteAtoms({ frozen_after_reset: 0.5 });
  const metaWithTruth = api.buildMetaContext(api.createInitialState(0), { task: 'compile_rules', lossReport: evidence });
  push('the System-2 payload carries the truth, the cost and the atom dispersion',
    !!metaWithTruth.loss_report && Array.isArray(metaWithTruth.loss_report.truth) &&
    !!metaWithTruth.loss_report.loss_diagnosis &&
    Array.isArray(metaWithTruth.atom_stats) && Array.isArray(metaWithTruth.dead_atoms) &&
    metaWithTruth.atom_stats.some(function (s) { return s.id === 'frozen_after_reset' && s.dead === true; }) &&
    metaWithTruth.dead_atoms.indexOf('frozen_after_reset') >= 0 &&
    metaWithTruth.atom_stats.some(function (s) { return s.id === 'cats_win_forecast' && s.n > 0 && s.sigma > 0; }),
    metaWithTruth.atom_stats.length + ' atoms, dead: ' + metaWithTruth.dead_atoms.join(',') +
    ', measured: ' + metaWithTruth.atom_stats.map(function (s) { return s.id + '(n' + s.n + ',s' + s.sigma + ')'; }).join(' '));
  push('the attempt cost travels with the payload when an attempt has run',
    !!metaWithTruth.attempt_cost === false ||
    (metaWithTruth.attempt_cost && Number.isFinite(metaWithTruth.attempt_cost.nodes) &&
      Number.isFinite(metaWithTruth.attempt_cost.jev_calls) && Number.isFinite(metaWithTruth.attempt_cost.ms)));
  /* End to end: a question whose answers never move is reported as dead, in the terms the learner
     needs (the weight is not the problem), during a real attempt. */
  const flatDual = createDualStub({ jev: { constantScore: true } });
  const flatApi = createSandbox(flatDual);
  Object.assign(flatApi.config, {
    typesafeUrl: 'https://api.typesafe.ai/v1/systemone', typesafeKey: 'k', jevModel: 'jev-latest',
    llmUrl: 'https://stub.local/v1/chat/completions', llmModel: 'stub-llm', llmKey: 'k',
    depth: 1, parallelBranch: 2, autotuneHypotheses: 1, autotuneTrials: 1, stepDelayMs: 0
  });
  flatApi.resetHarness(false);
  await flatApi.runLearning();
  const flatMessages = flatApi.logState.entries.map(function (e) { return e.message; });
  const flatStat = flatApi.Telemetry.atomStatistics().filter(function (s) { return s.id === 'mouse_containment'; })[0];
  push('a question that never varied during a real attempt is reported as dead weight',
    !!flatStat && flatStat.dead === true && flatStat.n >= flatApi.ATOM_DEAD_MIN_SAMPLES &&
    flatMessages.some(function (m) {
      return m.indexOf('DEAD QUESTION "mouse_containment"') >= 0 &&
        m.indexOf('Changing its weight is not a fix') >= 0;
    }),
    flatStat ? ('n ' + flatStat.n + ', sigma ' + flatStat.sigma + ', dead ' + flatStat.dead) : 'no stat');
  const promptText = api.buildLlmSystemPrompt();
  push('the prompt tells System 2 what it will receive and how to use it',
    promptText.indexOf('WHAT YOU RECEIVE BACK') >= 0 &&
    promptText.indexOf('loss_report.truth') >= 0 &&
    promptText.indexOf('ALREADY lost there') >= 0 &&
    promptText.indexOf('atom_stats') >= 0 && promptText.indexOf('dead_atoms') >= 0 &&
    promptText.indexOf('changing its WEIGHT does nothing at all') >= 0 &&
    promptText.indexOf('attempt_cost') >= 0 && promptText.indexOf('jev_prunes') >= 0,
    'prompt ' + promptText.length + ' chars');
  push('the prompt carries no template leak (no "undefined" reaches the model)',
    promptText.indexOf('undefined') < 0 && promptText.indexOf('NaN') < 0 &&
    api.buildJevSchemaDoc().indexOf('undefined') < 0 &&
    JSON.stringify(metaWithTruth).indexOf('undefined') < 0,
    promptText.slice(promptText.indexOf('undefined') - 40, promptText.indexOf('undefined') + 40));
  push('the prompt states the policy contract and the floor range exactly as the engine implements them',
    promptText.indexOf('narrows') < 0 &&
    promptText.indexOf('only an OPTIONAL move-ordering prior') >= 0 &&
    promptText.indexOf('never replaces leaf evaluation') >= 0 &&
    promptText.indexOf('explores EVERY legal move') >= 0 &&
    promptText.indexOf('[' + api.CONFIDENCE_FLOOR_RANGE.min + ',' + api.CONFIDENCE_FLOOR_RANGE.max + ']') >= 0 &&
    promptText.indexOf('re-asks you') < 0 &&
    promptText.indexOf('a battery needs at least one VALUE question') >= 0,
    (promptText.indexOf('narrows') < 0 ? 'honest' : 'still advertises the removed width cut') +
    ', floor range ' + api.CONFIDENCE_FLOOR_RANGE.min + '-' + api.CONFIDENCE_FLOOR_RANGE.max + ' printed');

  /* 3f. The engine self-test embedded in the page. */
  const checks = api.runEngineSelfTest();
  await api.runAsyncSelfTest(checks);
  const failedChecks = checks.filter(function (c) { return !c.pass; });
  push('The embedded engine self-test passes (' + (checks.length - failedChecks.length) + '/' + checks.length + ')',
    failedChecks.length === 0, failedChecks.map(function (c) { return c.name + (c.detail ? '=' + c.detail : ''); }).join(' | '));

  /* 3g. DOM integration: boot the real UI against a fake document built from the markup. */
  const domStub = createJevStub();
  let domApi = null;
  let domError = null;
  try {
    domApi = createSandbox(domStub, null, true);
  } catch (error) {
    domError = error;
  }
  push('loading the page with a document present does not throw', !domError,
    domError ? String(domError.stack).split('\n').slice(0, 3).join(' ~ ') : 'ok');
  if (domApi) {
    Object.assign(domApi.config, {
      typesafeUrl: 'https://api.typesafe.ai/v1/systemone', typesafeKey: 'test-key', jevModel: 'jev-latest', llmUrl: '', stepDelayMs: 0
    });
    let bootError = null;
    try { domApi.boot(); } catch (error) { bootError = error; }
    push('booting the UI renders without throwing', !bootError, bootError ? bootError.message : 'ok');
    const grid = domApi.__dom.elements.get('stats-grid');
    push('every stat tile renders with its class',
      !!grid && grid.children.length === domApi.STAT_TILE_DEFS.length &&
      grid.children.every(function (tile) { return String(tile.className).indexOf('stat-tile') === 0; }),
      (grid ? grid.children.length : -1) + ' tiles / ' + domApi.STAT_TILE_DEFS.length + ' defs');
    push('the board grid is built', domApi.__dom.elements.get('board').children.length > 0,
      domApi.__dom.elements.get('board').children.length + ' nodes');
    push('the log stream received the boot entries', domApi.__dom.elements.get('log-stream').children.length > 1,
      domApi.__dom.elements.get('log-stream').children.length + ' entries');
    domStub.state.mode = 'http-422';
    domApi.jevAnswerCache.clear();
    domApi.jevValueCache.clear();
    domApi.jevHealth.lastSuccessAt = null;
    domApi.jevHealth.lastError = null;
    await domApi.startLearningWithHealthGate();
    push('the single entry point is refused while System 1 is unreachable',
      domApi.match.status !== 'tuning' && domApi.match.tuning === null && !!domApi.jevHealth.lastError,
      domApi.match.status + ' / ' + domApi.jevHealth.lastError);
    domStub.state.mode = 'ok';
    await domApi.probeJevConnection({});
    push('A successful probe clears the health gate',
      domApi.jevHealth.lastError === null && !!domApi.jevHealth.lastSuccessAt);
    domApi.applyLocalRelayPreset();
    push('The relay preset fills the endpoint and leaves no key in the page',
      domApi.config.typesafeUrl === 'http://127.0.0.1:8787/api/jev' && domApi.config.typesafeKey === '',
      domApi.config.typesafeUrl + ' / key "' + domApi.config.typesafeKey + '"');
    push('The transport chip reports the relay after the preset',
      domApi.jevModeLabel() === 'relay 127.0.0.1:8787', domApi.jevModeLabel());
  }

  /* ---- 3i. PATH LEARNING: the line the search walked, and the contract that keeps learning inside
     the fields System 1 evaluates. ---- */
  {
    const casesApi = createSandbox(createJevStub({}));
    const rootState = casesApi.createInitialState(0);
    const catMoves = casesApi.legalMovesForSide(rootState, casesApi.SIDE_CATS);
    const ctxA = casesApi.createSearchContext({ rules: casesApi.DEFAULT_RULES });
    const firstChild = casesApi.applyMove(rootState, catMoves[0]);
    const jevAnswer = { winProbability: 0.9, confidence: 0.35, atoms: { cats_win_forecast: 0.5, mouse_containment: 0.95 } };
    casesApi.recordLeafCase(ctxA, firstChild, jevAnswer, 0.35, [{ state: firstChild, move: catMoves[0] }]);
    push('the path of a leaf is recorded with its boards and its Jev answers, at no call cost',
      ctxA.leafRecords.length === 1 && ctxA.leafRecords[0].path.length === 1 &&
      ctxA.leafRecords[0].V === 0.9 && ctxA.leafRecords[0].confidence === 0.35 &&
      ctxA.leafRecords[0].atoms.mouse_containment === 0.95 && casesApi.Telemetry.pathLeafCases === 1,
      ctxA.leafRecords.length + ' record(s), counter ' + casesApi.Telemetry.pathLeafCases);
    casesApi.recordLeafCase(ctxA, firstChild, jevAnswer, 0.35, [{ state: firstChild, move: catMoves[0] }]);
    push('the same position reached down two lines is ONE case, not two', ctxA.leafRecords.length === 1);
    const boardsA = casesApi.pathBoards(ctxA.leafRecords[0].path);
    push('the boards of the line are real positions and the move that produced each one is named',
      boardsA.length === 1 && boardsA[0].board_ascii.indexOf('C') > 0 &&
      boardsA[0].board_ascii.indexOf('y=0') === 0 && Array.isArray(boardsA[0].position_array) &&
      boardsA[0].position_array.length === 5 && String(boardsA[0].move).length > 4,
      String(boardsA[0].move));

    /* cats_win_forecast is constant here on purpose: mouse_containment is then the only informative
       atom, which is what makes the prefilter assertions below meaningful. */
    const ctxB = casesApi.createSearchContext({ rules: casesApi.DEFAULT_RULES });
    const leafValues = [0.9, 0.86, 0.3, 0.1];
    const leafConfidences = [0.35, 0.6, 0.25, 0.5];
    const leafContainment = [0.95, 0.9, 0.2, 0.05];
    catMoves.slice(0, 4).forEach(function (mv, index) {
      const st = casesApi.applyMove(rootState, mv);
      casesApi.recordLeafCase(ctxB, st, {
        winProbability: leafValues[index], confidence: leafConfidences[index],
        atoms: { cats_win_forecast: 0.5, mouse_containment: leafContainment[index] }
      }, leafConfidences[index], [{ state: st, move: mv }]);
    });
    const pathCases = casesApi.selectPathCases(ctxB, { bestMove: catMoves[0] });
    const kinds = pathCases.map(function (c) { return c.kind; });
    push('the case list leads with the line behind the chosen move and carries the near-tie alternative',
      kinds[0] === 'decision_support' && kinds.indexOf('near_tie') >= 0 &&
      pathCases.filter(function (c) { return c.kind === 'near_tie'; })[0].gap === 0.04,
      kinds.join(','));
    push('every case is bounded, deduplicated and carries a code-generated reason',
      pathCases.length <= casesApi.config.pathCasesLimit &&
      pathCases.every(function (c) { return String(c.why).length > 20 && c.path.length >= 1; }) &&
      pathCases.filter(function (c) { return c.kind === 'lowest_confidence'; }).length === 1,
      pathCases.length + ' cases of ' + casesApi.config.pathCasesLimit);

    const brief = casesApi.buildPathBrief(7, casesApi.DEFAULT_RULES, pathCases,
      'the ply judgment cannot be trusted: confidence 0.3 < floor 0.7');
    push('the brief hands System 2 the BOARDS, the trigger, and the rule that learning must be evaluable',
      brief.cases.length === pathCases.length && brief.trigger.indexOf('confidence') > 0 &&
      brief.cases[0].leaf.board_ascii.indexOf('C') > 0 && brief.how_to_read.indexOf('path') > 0 &&
      brief.what_to_change.indexOf('EVALUATES') > 0 && brief.ask.indexOf('WITHOUT weights and battery') > 0,
      brief.cases.length + ' case(s), ' + brief.how_to_read.length + ' chars of reading contract');

    const sameVerdict = casesApi.prefilterCandidate(casesApi.DEFAULT_RULES, casesApi.DEFAULT_RULES, pathCases);
    push('the prefilter recomposes over the answers the ply already paid for, and accepts an identical set',
      sameVerdict.ok === true && sameVerdict.before === sameVerdict.after && sameVerdict.cases === pathCases.length,
      'decisiveness ' + sameVerdict.before + ' over ' + sameVerdict.cases + ' case(s)');
    const flatRules = casesApi.normalizeRules({ weights: { cats_win_forecast: 1, mouse_containment: 0 } },
      { fallback: casesApi.DEFAULT_RULES }).rules;
    const flatVerdict = casesApi.prefilterCandidate(casesApi.DEFAULT_RULES, flatRules, pathCases);
    push('the prefilter REFUSES a candidate that makes the composition less decisive, and reports the numbers',
      flatVerdict.ok === false && flatVerdict.after < flatVerdict.before && flatVerdict.reason.indexOf('LESS decisive') > 0,
      flatVerdict.reason);

    const baseRules = casesApi.normalizeRules({ weights: { cats_win_forecast: 0.5, mouse_containment: 0.5 } },
      { fallback: casesApi.DEFAULT_RULES }).rules;
    const proseRules = casesApi.normalizeRules({
      rationale: 'a completely different story about the position, with no field Jev reads',
      weights: { cats_win_forecast: 0.5, mouse_containment: 0.5 }
    }, { fallback: baseRules }).rules;
    push('a prose-only reply is NOT learning: nothing Jev evaluates moved',
      casesApi.hasEvaluableRuleChange(baseRules, proseRules) === false &&
      casesApi.describeRuleChange(baseRules, proseRules).indexOf('no evaluable change') === 0,
      casesApi.describeRuleChange(baseRules, proseRules));
    const rewrittenRules = casesApi.normalizeRules({
      weights: { cats_win_forecast: 0.5, mouse_containment: 0.5 },
      battery: {
        cats_win_forecast: {
          type: 'choice',
          instructions: 'REWRITTEN: can the Cats force the trap within three plies against the described Mouse?',
          criteria: { cats_win: 'yes', mouse_win: 'no', draw: 'unclear' }
        },
        mouse_containment: {
          type: 'score', instructions: 'How many independent Mouse escape routes remain?',
          criteria: ['three or more', 'two', 'one and unsettled', 'one and fragile', 'none']
        }
      }
    }, { fallback: baseRules }).rules;
    push('a rewritten instruction IS learning, and the delta names the field that moved',
      casesApi.hasEvaluableRuleChange(baseRules, rewrittenRules) === true &&
      casesApi.describeRuleChange(baseRules, rewrittenRules).indexOf('instructions') > 0,
      casesApi.describeRuleChange(baseRules, rewrittenRules));
    const newQuestionRules = casesApi.normalizeRules({
      weights: { cats_win_forecast: 0.4, mouse_containment: 0.4, cat_line: 0.2 },
      battery: {
        cats_win_forecast: {
          type: 'choice', instructions: 'Can the Cats force the trap from here?',
          criteria: { cats_win: 'yes', mouse_win: 'no', draw: 'unclear' }
        },
        mouse_containment: {
          type: 'score', instructions: 'How many independent Mouse escape routes remain?',
          criteria: ['three or more', 'two', 'one and unsettled', 'one and fragile', 'none']
        },
        cat_line: {
          type: 'score', instructions: 'Is the Cat line unbroken, with no Cat left behind?',
          criteria: ['broken', 'one Cat behind', 'nearly level', 'intact', 'closed and level']
        }
      }
    }, { fallback: baseRules }).rules;
    push('a new question is reported as a new atom, weighted over the enlarged value set',
      casesApi.describeRuleChange(baseRules, newQuestionRules).indexOf('new question(s): cat_line') > 0 &&
      newQuestionRules.weights.cat_line === 0.2,
      casesApi.describeRuleChange(baseRules, newQuestionRules));
    const observationRules = casesApi.normalizeRules({
      observations: Object.assign({}, baseRules.observations, {
        front_gap_signal: { spec: { kind: 'op', op: 'front_row_gap', args: {} } }
      })
    }, { fallback: baseRules }).rules;
    const observationDiff = casesApi.toRuleDiff(baseRules, observationRules);
    push('an observation declaration is an evaluable formula diff and is serialised without crashing',
      casesApi.describeRuleChange(baseRules, observationRules).indexOf('observation front_gap_signal declared') >= 0 &&
      observationDiff.kinds.indexOf('observations.added:front_gap_signal') >= 0 &&
      observationDiff.fields.some(function (field) { return field.kind === 'obs_added' && field.id === 'front_gap_signal' && field.to; }),
      JSON.stringify(observationDiff));
  }
  /* ---- 3j. The consult itself: cost guards, the prefilter gate, and NO CHANGE as a first-class answer. ---- */
  {
    /* Local fixture builder: cats_win_forecast constant, mouse_containment informative, four lines
       with different values and confidences. */
    const makeCases = function (api) {
      const state = api.createInitialState(0);
      const moves = api.legalMovesForSide(state, api.SIDE_CATS);
      const context = api.createSearchContext({ rules: api.DEFAULT_RULES });
      const values = [0.9, 0.86, 0.3, 0.1];
      const containment = [0.95, 0.9, 0.2, 0.05];
      moves.slice(0, 4).forEach(function (mv, index) {
        const st = api.applyMove(state, mv);
        api.recordLeafCase(context, st, {
          winProbability: values[index], confidence: 0.3,
          atoms: { cats_win_forecast: 0.5, mouse_containment: containment[index] }
        }, 0.3, [{ state: st, move: mv }]);
      });
      return api.selectPathCases(context, { bestMove: moves[0] });
    };
    const buildSearch = function (api, cases) {
      const context = api.createSearchContext({ rules: api.match.rules });
      context.pathCases = cases;
      return { result: { calibrated: 0.3, value: 0.4, bestMove: null, line: [] }, ctx: context };
    };
    const goodReading = function () {
      return {
        evidence_ref: { case: 0, why: 'the winning line keeps the spread while the losing line opens it' },
        board_reading: {
          positions: [0, 1],
          measures: [{
            name: 'horizontal_spread',
            definition: 'max(cat row) minus min(cat row) over the four Cats',
            values: { 0: 1, 1: 3 }
          }],
          distinction: 'the winning line keeps spread 1, the losing line opens to 3'
        }
      };
    };
    const goodProposal = Object.assign({ version: 9, rationale: 'stub candidate that trusts the informative question', weights: { cats_win_forecast: 0.25, mouse_containment: 0.75 }, confidenceFloor: 0.7 }, goodReading());
    const stubA = createDualStub({ proposals: [goodProposal] });
    const apiA = createSandbox(stubA);
    Object.assign(apiA.config, {
      llmUrl: 'https://stub.invalid/v1/chat/completions', llmKey: 'stub-key',
      pathLearning: 'collect', midgameCorrections: 3
    });
    apiA.match.state = apiA.createInitialState(0);
    const sharedCases = makeCases(apiA);
    const noneInCollect = await apiA.maybeCourseCorrect(null, buildSearch(apiA, sharedCases));
    push('collect mode makes NO call even when the trigger fires: the cases wait for the next proposal',
      sharedCases.length >= 2 && noneInCollect === null && stubA.llmCalls.length === 0 &&
      apiA.Telemetry.courseCorrectionCalls === 0 && apiA.match.pathCases.length === sharedCases.length,
      sharedCases.length + ' case(s), ' + stubA.llmCalls.length + ' LLM call(s), ' +
      apiA.match.pathCases.length + ' queued');
    apiA.config.pathLearning = 'live';
    apiA.config.midgameCorrections = 0;
    const blockedByBudget = await apiA.maybeCourseCorrect(null, buildSearch(apiA, sharedCases));
    push('live mode with the budget spent makes no call either, and queues the cases instead of dropping them',
      blockedByBudget === null && stubA.llmCalls.length === 0 && apiA.match.pathCases.length === sharedCases.length * 2,
      stubA.llmCalls.length + ' LLM call(s), ' + apiA.match.pathCases.length + ' case(s) queued');
    apiA.config.midgameCorrections = 2;
    const appliedRules = await apiA.maybeCourseCorrect(null, buildSearch(apiA, sharedCases));
    push('live mode with budget CONSULTS System 2 and applies a revision that passes the prefilter',
      appliedRules !== null && appliedRules.version === 9 && stubA.llmCalls.length === 1 &&
      apiA.match.midgameChangesThisGame === 1 && apiA.Telemetry.courseCorrectionsApplied === 1,
      'v' + (appliedRules ? appliedRules.version : 'none') + ', ' + stubA.llmCalls.length + ' call(s)');
    push('the applied revision moved FIELDS System 1 evaluates (visible in the returned rule set)',
      appliedRules.weights.mouse_containment === 0.75 && appliedRules.weights.cats_win_forecast === 0.25,
      'weights ' + JSON.stringify(appliedRules.weights));

    const stubB = createDualStub({ proposals: [Object.assign({ version: 9, rationale: 'stub candidate that silences the informative question', weights: { cats_win_forecast: 1, mouse_containment: 0 }, confidenceFloor: 0.7 }, goodReading())] });
    const apiB = createSandbox(stubB);
    Object.assign(apiB.config, {
      llmUrl: 'https://stub.invalid/v1/chat/completions', llmKey: 'stub-key',
      pathLearning: 'live', midgameCorrections: 2
    });
    apiB.match.state = apiB.createInitialState(0);
    const refused = await apiB.maybeCourseCorrect(null, buildSearch(apiB, makeCases(apiB)));
    push('a revision that fails the free prefilter is REJECTED and the rule set is left untouched',
      refused === null && apiB.match.rules.version === 0 && stubB.llmCalls.length === 1 &&
      apiB.Telemetry.courseCorrectionsRejected === 1 && apiB.Telemetry.courseCorrectionsApplied === 0,
      'rejected ' + apiB.Telemetry.courseCorrectionsRejected + ', version ' + apiB.match.rules.version);
    const consultsAfterRefusal = apiB.match.midgameConsultsThisGame;
    apiB.config.midgameCorrections = 1;
    const secondConsult = await apiB.maybeCourseCorrect(null, buildSearch(apiB, makeCases(apiB)));
    push('a REFUSED candidate still spends the budget: System 2 cannot be consulted on every ply',
      consultsAfterRefusal === 1 && secondConsult === null && stubB.llmCalls.length === 1 &&
      apiB.Telemetry.courseCorrectionCalls === 1,
      'consults ' + consultsAfterRefusal + ' with budget 1, ' + stubB.llmCalls.length + ' LLM call(s)');

    const stubC = createDualStub({ proposals: [{ version: 9, rationale: 'the current questions already separate these lines, so no field Jev evaluates needs to change' }] });
    const apiC = createSandbox(stubC);
    Object.assign(apiC.config, {
      llmUrl: 'https://stub.invalid/v1/chat/completions', llmKey: 'stub-key',
      pathLearning: 'live', midgameCorrections: 2
    });
    apiC.match.state = apiC.createInitialState(0);
    const idleAnswer = await apiC.maybeCourseCorrect(null, buildSearch(apiC, makeCases(apiC)));
    push('a NO CHANGE answer is accepted as an answer: no version bump, no revision, cases queued',
      idleAnswer === null && apiC.match.rules.version === 0 && apiC.Telemetry.courseCorrectionsIdle === 1 &&
      apiC.Telemetry.courseCorrectionsApplied === 0 && apiC.match.pathCases.length >= 2,
      'idle ' + apiC.Telemetry.courseCorrectionsIdle + ', version ' + apiC.match.rules.version);

    const partialBattery = apiA.normalizeRules({
      weights: { cat_line: 1 },
      battery: { cat_line: { type: 'score', instructions: 'Is the Cat line unbroken?', criteria: ['a', 'b', 'c'] } }
    }, { fallback: apiA.DEFAULT_RULES }).rules;
    push('a PARTIAL battery replaces the whole set, and the delta says the removals out loud',
      apiA.describeRuleChange(apiA.DEFAULT_RULES, partialBattery).indexOf('removed question(s):') > 0,
      apiA.describeRuleChange(apiA.DEFAULT_RULES, partialBattery));

    /* The promise the prompt makes ("a battery needs at least one VALUE question") has to be ENFORCED,
       or a set of policy questions only would leave V(s) constant at 0.5 with no error anywhere. */
    const policyOnly = apiA.normalizeRules({
      weights: { move_choice: 1 },
      battery: {
        move_choice: {
          type: 'choice', used_as: 'policy', options_from: 'legal_moves', subject: 'side_to_move',
          instructions: 'Which move?', criteria: {}
        }
      }
    }, { fallback: apiA.DEFAULT_RULES });
    push('a battery with no VALUE question is REFUSED, so V(s) can never be composed out of nothing',
      policyOnly.rules.battery.move_choice === undefined &&
      apiA.valueAtoms(policyOnly.rules.battery).length >= 1 &&
      policyOnly.warnings.some(function (w) { return w.indexOf('declares no VALUE question') >= 0; }),
      policyOnly.warnings.filter(function (w) { return w.indexOf('VALUE question') >= 0; })[0] || 'no warning');

    const domStubLive = createJevStub({});
    const domApiLive = createSandbox(domStubLive, null, true);
    domApiLive.config.llmUrl = '';
    domApiLive.boot();
    domApiLive.readConfigFromForm();
    push('the UI reads path learning back in a valid mode, and the default is live',
      domApiLive.PATH_LEARNING_MODES.indexOf(String(domApiLive.config.pathLearning)) >= 0 &&
      domApiLive.config.pathLearning === 'live',
      String(domApiLive.config.pathLearning));

    /* ---- 3j-quater. CONSOLIDATION: learning at the boundary, not inside the action. ---- */
    {
      /* The doubt is the same in every case: the rules engine already decided the position and V(s)
         disagrees, which is the strongest trigger there is (see courseCorrectionTrigger). */
      const doubtingSearch = function (api) {
        const leafState = api.createInitialState(0);
        const leaf = {
          board_ascii: 'y=7  M', side_to_move: api.SIDE_MOUSE,
          position_array: api.boardPositionArray(leafState), state: api.toWireState(leafState),
          value: 0.95, confidence: 0.2, atoms: { cats_win_forecast: 0.9 },
          measurements: api.computeObservations(leafState, api.DEFAULT_RULES.observations).values,
          outcome_label: 'bad_for_cats'
        };
        const oneCase = {
          case_id: 'decision_support#0', kind: 'decision_support', why: 'the line behind the chosen move',
          state_key: 'k0', leaf_state: leafState, leaf: leaf, path: []
        };
        return {
          result: { value: 0.95, calibrated: 0.2, bestMove: null, line: [] },
          ctx: { confidenceFloor: 0.45, pathCases: [oneCase] },
          oracle: { known: true, winner: api.SIDE_MOUSE, plies: 4, reason: 'mouse_reached_row_0' }
        };
      };

      const boundaryStub = createDualStub({});
      const boundaryApi = createSandbox(boundaryStub);
      Object.assign(boundaryApi.config, {
        llmUrl: 'https://stub.invalid/v1/chat/completions', llmKey: 'stub-key',
        pathLearning: 'consolidate', midgameCorrections: 3, pathCasesLimit: 4
      });
      boundaryApi.match.state = boundaryApi.createInitialState(0);
      const noChangeInGame = await boundaryApi.maybeCourseCorrect(null, doubtingSearch(boundaryApi));
      push('consolidate mode records the doubt and changes NOTHING inside the game (zero calls)',
        noChangeInGame === null && boundaryStub.llmCalls.length === 0 &&
        boundaryApi.Telemetry.reflectionsRecorded === 1 && boundaryApi.Telemetry.courseCorrectionCalls === 0 &&
        boundaryApi.match.midgameChangesThisGame === 0 && boundaryApi.match.rules.version === 0 &&
        boundaryApi.match.reflections.length === 1 &&
        boundaryApi.match.reflections[0].class === 'contradiction' &&
        boundaryApi.Telemetry.triggerMixLabel() === '1/0/0',
        'reflections ' + boundaryApi.Telemetry.reflectionsRecorded + ', mix ' + boundaryApi.Telemetry.triggerMixLabel());

      const collectStub = createDualStub({});
      const collectApi = createSandbox(collectStub);
      Object.assign(collectApi.config, {
        llmUrl: 'https://stub.invalid/v1/chat/completions', llmKey: 'stub-key',
        pathLearning: 'collect', midgameCorrections: 3
      });
      collectApi.match.state = collectApi.createInitialState(0);
      await collectApi.maybeCourseCorrect(null, doubtingSearch(collectApi));
      push('collect stays a PURE measurement: nothing recorded, nothing called, cases queued',
        collectApi.match.reflections.length === 0 && collectApi.Telemetry.reflectionsRecorded === 0 &&
        collectStub.llmCalls.length === 0 && collectApi.match.pathCases.length === 1,
        collectApi.match.reflections.length + ' reflection(s), ' + collectApi.match.pathCases.length + ' case(s) queued');

      const quietStub = createDualStub({});
      const quietApi = createSandbox(quietStub);
      Object.assign(quietApi.config, {
        llmUrl: 'https://stub.invalid/v1/chat/completions', llmKey: 'stub-key', pathLearning: 'consolidate'
      });
      quietApi.match.state = quietApi.createInitialState(0);
      const nothingToConsolidate = await quietApi.consolidateReflections(1, { games: [], wins: 0, total: 0 });
      push('no doubt recorded means no consult: the boundary does not ask System 2 "just in case"',
        nothingToConsolidate === null && quietApi.Telemetry.consolidations === 0 && quietStub.llmCalls.length === 0,
        'consolidations ' + quietApi.Telemetry.consolidations + ', ' + quietStub.llmCalls.length + ' call(s)');

      const journalApi = createSandbox(createDualStub({}));
      Object.assign(journalApi.config, { pathLearning: 'consolidate' });
      journalApi.match.state = journalApi.createInitialState(0);
      journalApi.recordReflection(doubtingSearch(journalApi));
      journalApi.recordReflection(doubtingSearch(journalApi));
      journalApi.recordReflection(doubtingSearch(journalApi));
      push('consecutive doubts of the same class are ONE doubt with a count, not three findings',
        journalApi.match.reflections.length === 1 && journalApi.match.reflections[0].count === 3 &&
        journalApi.Telemetry.reflectionsRecorded === 1 &&
        journalApi.Telemetry.triggerMixLabel() === '3/0/0',
        journalApi.match.reflections.length + ' reflection(s), count ' +
        (journalApi.match.reflections[0] ? journalApi.match.reflections[0].count : '-') +
        ', mix ' + journalApi.Telemetry.triggerMixLabel());

      const leafLine = {
        kind: 'near_tie', why: 'y',
        leaf: { board_ascii: 'b', side_to_move: 'cats', value: 0.5, confidence: 0.2, atoms: {} }, path: []
      };
      const manyReflections = [];
      for (let i = 0; i < 8; i++) {
        manyReflections.push({
          ply: i, side_to_move: journalApi.SIDE_CATS, class: 'coin_flip', trigger_text: 'coin-flip',
          rules_version: 0, V: 0.5, confidence: 0.2, oracle: null, count: 1,
          cases: [leafLine, leafLine, leafLine]
        });
      }
      const boundaryBrief = journalApi.buildConsolidationBrief(2, journalApi.DEFAULT_RULES, manyReflections, { games: [] });
      push('the boundary brief is BOUNDED (6 doubts, 2 lines each) and does not duplicate the measured tables',
        boundaryBrief.reflections.length === journalApi.CONSOLIDATION_MAX_REFLECTIONS &&
        boundaryBrief.omitted_reflections === 2 &&
        boundaryBrief.reflections.every(function (r) {
          return r.cases.length === journalApi.CONSOLIDATION_CASES_PER_REFLECTION;
        }) &&
        boundaryBrief.scope === journalApi.CONSOLIDATION_SCOPE &&
        boundaryBrief.atom_accuracy === undefined && boundaryBrief.attempt_cost === undefined,
        boundaryBrief.reflections.length + ' of 8 kept, omitted ' + boundaryBrief.omitted_reflections);

      const applyStub = createDualStub({
        proposals: [Object.assign({ version: 9, rationale: 'boundary candidate', weights: { cats_win_forecast: 0.25, mouse_containment: 0.75 }, confidenceFloor: 0.7 },
          { evidence_ref: { case: 0, why: 'the recorded doubt shows the spread opening' },
            board_reading: { positions: [0], measures: [{ name: 'horizontal_spread', definition: 'max row minus min row', values: { a: 1, b: 3 } }], distinction: 'the recorded reflection opens the spread' } })]
      });
      const applyApi = createSandbox(applyStub);
      Object.assign(applyApi.config, {
        llmUrl: 'https://stub.invalid/v1/chat/completions', llmKey: 'stub-key', pathLearning: 'consolidate'
      });
      applyApi.match.state = applyApi.createInitialState(0);
      applyApi.recordReflection(doubtingSearch(applyApi));
      const applied = await applyApi.consolidateReflections(3,
        { games: [{ outcome: 'mouse:mouse_reached_row_0', plies: 12, midgameChanges: 0 }], wins: 0, total: 1 });
      push('the boundary hands System 2 the recorded doubts as task=consolidate_reflections and applies a judged change',
        applied !== null && applied.version > 0 && applyApi.Telemetry.consolidationsApplied === 1 &&
        applyApi.Telemetry.consolidations === 1 && applyApi.match.reflections.length === 0 &&
        JSON.stringify(applyStub.llmCalls[0]).indexOf('consolidate_reflections') >= 0 &&
        JSON.stringify(applyStub.llmCalls[0]).indexOf('reflections_recorded') >= 0 &&
        'v' + applied.version + ' [' + (applied.source || '?') + '] weights ' +
        JSON.stringify(applied.weights) + ', ' + applyStub.llmCalls.length + ' call(s)');

      const idleStub = createDualStub({
        proposals: [{ version: 1, rationale: 'prose only: nothing Jev evaluates moves', evidence_ref: { case: 0, why: 'no distinction worth asking for' } }]
      });
      const idleApi = createSandbox(idleStub);
      Object.assign(idleApi.config, {
        llmUrl: 'https://stub.invalid/v1/chat/completions', llmKey: 'stub-key', pathLearning: 'consolidate'
      });
      idleApi.match.state = idleApi.createInitialState(0);
      idleApi.recordReflection(doubtingSearch(idleApi));
      const idleAnswer = await idleApi.consolidateReflections(4, { games: [] });
      push('an honest NO CHANGE at the boundary keeps the rule set and is counted as idle, not as a revision',
        idleAnswer === null && idleApi.match.rules.version === 0 &&
        idleApi.Telemetry.consolidationsIdle === 1 && idleApi.Telemetry.consolidationsApplied === 0,
        'idle ' + idleApi.Telemetry.consolidationsIdle + ', version ' + idleApi.match.rules.version);

      /* The END-TO-END regression: one whole attempt in consolidate mode. In this mode the games are
         MEASUREMENT games (the mid-game writer is held back), so the recording has to survive that
         flag - which is exactly the trap this test locks: without it, a consolidate run records
         nothing at all and the boundary never has evidence to consolidate. */
      const loopStub = createDualStub({
        proposals: [
          Object.assign({ version: 1, rationale: 'loop candidate', weights: { cats_win_forecast: 1 }, confidenceFloor: 0.7 }, { evidence_ref: { case: 0, why: 'first candidate' }, board_reading: { positions: [0, 1], measures: [{ name: 'horizontal_spread', definition: 'max row minus min row', values: { a: 1, b: 2 } }], distinction: 'trace' } }),
          Object.assign({ version: 2, rationale: 'consolidated candidate', weights: { cats_win_forecast: 0.3, mouse_containment: 0.7 }, confidenceFloor: 0.7 }, { evidence_ref: { case: 0, why: 'the recorded doubt' }, board_reading: { positions: [0, 1], measures: [{ name: 'horizontal_spread', definition: 'max row minus min row', values: { a: 1, b: 3 } }], distinction: 'trace' } })
        ]
      });
      const loopApi = createSandbox(loopStub);
      Object.assign(loopApi.config, {
        typesafeUrl: 'https://api.typesafe.ai/v1/systemone', typesafeKey: 'k', jevModel: 'jev-latest',
        llmUrl: 'https://stub.local/v1/chat/completions', llmModel: 'stub-llm', llmKey: 'k',
        depth: 1, parallelBranch: 2, autotuneHypotheses: 1, autotuneTrials: 1, stepDelayMs: 0,
        pathLearning: 'consolidate', midgameCorrections: 3
      });
      loopApi.resetHarness(false);
      await loopApi.runLearning();
      const loopMessages = loopApi.logState.entries.map(function (e) { return e.message; });
      const midGameApplied = loopMessages.some(function (m) { return m.indexOf('COURSE CORRECTION APPLIED') >= 0; });
      const attemptAccepted = loopMessages.some(function (m) {
        return m.indexOf('Winning rule set ready') >= 0 || m.indexOf('ACCEPTED rule set') >= 0;
      });
      const boundaryAnswered = loopApi.Telemetry.consolidations + loopApi.Telemetry.consolidationsIdle;
      push('a consolidate attempt keeps its games clean AND still runs the oracle that feeds the journal',
        loopApi.Telemetry.trialGames >= 1 &&
        loopMessages.some(function (m) { return m.indexOf('Oracle at ply ') >= 0; }) &&
        !midGameApplied && loopApi.match.midgameChangesThisGame === 0 &&
        (loopApi.Telemetry.reflectionsRecorded === 0 || boundaryAnswered >= 1 || attemptAccepted),
        loopApi.Telemetry.trialGames + ' game(s), ' + loopApi.Telemetry.reflectionsRecorded +
        ' reflection(s), ' + boundaryAnswered + ' boundary consult(s), mid-game changes ' +
        loopApi.match.midgameChangesThisGame);
    }
  }
  /* ---- 3j-quinquies. SPEC-01: the revision journal, the judges and the narrow verdict. ---- */
  {
    const journalApi = createSandbox(createDualStub({}));
    journalApi.match.state = journalApi.createInitialState(0);
    const journalCtx = journalApi.createSearchContext({ rules: journalApi.DEFAULT_RULES });
    const belief = function (value, atoms) {
      return { winProbability: value, confidence: 0.5, atoms: atoms, source: 'live' };
    };
    const firstSighting = journalApi.recordRevision(journalApi.match.state,
      belief(0.8, { cats_win_forecast: 0.8 }), journalCtx);
    const moved = journalApi.recordRevision(journalApi.match.state,
      belief(0.4, { cats_win_forecast: 0.4 }), journalCtx);
    const wobble = journalApi.recordRevision(journalApi.match.state,
      belief(0.42, { cats_win_forecast: 0.42 }), journalCtx);
    push('a belief that MOVED is a revision; a first sighting and a rounding wobble are not',
      firstSighting === null && moved !== null && wobble === null && journalCtx.revisions.length === 1 &&
      Math.abs(moved.delta_V + 0.4) < 0.0001 && journalApi.Telemetry.revisionsRecorded === 1,
      'delta ' + (moved ? moved.delta_V : 'none') + ', journal ' + journalCtx.revisions.length + ' row(s)');
    const mergedRows = journalApi.mergeRevisions(journalCtx.revisions);
    const digest = journalApi.buildRevisionDigest();
    push('the digest names the state, the per-question delta, and the truth labels it could NOT take',
      mergedRows === 1 && journalCtx.revisions.length === 0 && journalApi.match.revisions.length === 1 &&
      digest.revisions === 1 && digest.states === 1 && digest.labels.known === 0 && digest.labels.unknown === 1 &&
      digest.atom_witness[0].id === 'cats_win_forecast' &&
      Math.abs(digest.atom_witness[0].mean_delta + 0.4) < 0.0001,
      'labels ' + JSON.stringify(digest.labels) + ', witness ' + digest.atom_witness[0].id + ' ' +
      digest.atom_witness[0].mean_delta);

    const judgeApi = createSandbox(createDualStub({}));
    judgeApi.match.state = judgeApi.createInitialState(0);
    const oneLine = [{
      case_id: 'decision_support#0', kind: 'decision_support', why: 'the line behind the chosen move',
      state_key: 'k0', path: [],
      leaf: { board_ascii: 'y=7  M', side_to_move: judgeApi.SIDE_CATS, value: 0.6, confidence: 0.5, atoms: { cats_win_forecast: 0.6, mouse_containment: 0.5 } }
    }, {
      case_id: 'near_tie#1', kind: 'near_tie', why: 'the alternative line was within 0.01 of the chosen one',
      state_key: 'k1', path: [],
      leaf: { board_ascii: 'y=6  M', side_to_move: judgeApi.SIDE_CATS, value: 0.7, confidence: 0.4, atoms: { cats_win_forecast: 0.9, mouse_containment: 0.5 } }
    }];
    const judgeBase = judgeApi.normalizeRules({ weights: { cats_win_forecast: 0.5, mouse_containment: 0.5 } },
      { fallback: judgeApi.DEFAULT_RULES }).rules;
    const sharper = judgeApi.normalizeRules({ weights: { cats_win_forecast: 1, mouse_containment: 0 } },
      { fallback: judgeBase }).rules;
    const flatter = judgeApi.normalizeRules({ weights: { cats_win_forecast: 0, mouse_containment: 1 } },
      { fallback: judgeBase }).rules;
    const rewritten = Object.assign({}, judgeBase, {
      version: judgeBase.version + 1,
      rationale: 'SECRET-AUTHOR-STORY-42',
      battery: Object.assign({}, judgeBase.battery, {
        cats_win_forecast: Object.assign({}, judgeBase.battery.cats_win_forecast,
          { instructions: 'REWRITTEN: can the Cats force the trap?' })
      })
    });
    const flatterVerdict = judgeApi.judgeRuleDiffMeasured(judgeBase, flatter, { cases: oneLine });
    const sharperVerdict = judgeApi.judgeRuleDiffMeasured(judgeBase, sharper, { cases: oneLine });
    const contradictionVerdict = judgeApi.judgeRuleDiffMeasured(judgeBase, sharper, {
      cases: oneLine, contradicted: true,
      oracle: { known: true, winner: judgeApi.SIDE_MOUSE, plies: 4 }
    });
    push('the measured judge REJECTS a less decisive diff, APPLIES a more decisive one, and needs no consensus',
      flatterVerdict.decision === 'reject' && flatterVerdict.judge === 'measurement' &&
      sharperVerdict.decision === 'apply' && sharperVerdict.applied_fields.indexOf('weights') >= 0 &&
      contradictionVerdict.decision === 'apply' &&
      contradictionVerdict.reason.indexOf('CONTRADICTION') > 0,
      'flatter ' + flatterVerdict.decision + ', sharper ' + sharperVerdict.decision +
      ', contradiction ' + contradictionVerdict.decision);
    const proseOnly = judgeApi.judgeRuleDiffMeasured(judgeBase, rewritten, { cases: oneLine });
    push('a diff the replay cannot measure is NOT approved by the measured judge (it is silent instead)',
      proseOnly === null && judgeApi.toRuleDiff(judgeBase, rewritten).narrowable.length === 0 &&
      judgeApi.toRuleDiff(judgeBase, rewritten).fields.some(function (f) {
        return f.kind === 'instructions' && f.id === 'cats_win_forecast';
      }),
      'fields ' + judgeApi.toRuleDiff(judgeBase, rewritten).kinds.join(','));
    const narrowed = judgeApi.narrowRuleSet(judgeBase, Object.assign({}, rewritten, { weights: sharper.weights }), ['weights', 'instructions']);
    push('a narrow verdict moves ONLY the measurable fields and keeps the rest of the rule set',
      narrowed !== null && narrowed.source === 'llm-narrowed' &&
      narrowed.narrowed_from.join(',') === 'weights' &&
      narrowed.weights.cats_win_forecast === sharper.weights.cats_win_forecast &&
      narrowed.battery.cats_win_forecast.instructions === judgeBase.battery.cats_win_forecast.instructions &&
      judgeApi.narrowRuleSet(judgeBase, rewritten, ['instructions']) === null,
      'narrowed ' + (narrowed ? narrowed.narrowed_from.join(',') : 'none') + ', version v' + (narrowed ? narrowed.version : '-'));

    /* The ghost-atom guard: a candidate weight naming a question the CONSERVED battery does not
       declare must never survive a narrow verdict (it would compose as the neutral 0.5 in every
       leaf), and the version must move strictly up even when the model repeats a lower number. */
    const ghostCandidate = Object.assign({}, rewritten, {
      version: judgeBase.version,                       // the model repeating a LOWER version number
      weights: { cats_win_forecast: 1, mouse_containment: 0, ghost_question: 0.5 }
    });
    const ghost = judgeApi.narrowRuleSet(judgeBase, ghostCandidate, ['weights']);
    push('a narrow verdict drops GHOST weights the conserved battery does not declare, renormalises, and reports them',
      ghost !== null && ghost.weights.cats_win_forecast === 1 && ghost.weights.mouse_containment === 0 &&
      ghost.weights.ghost_question === undefined &&
      ghost.warnings.some(function (w) { return w.indexOf('ghost_question') >= 0; }) &&
      Math.abs(ghost.weights.cats_win_forecast + ghost.weights.mouse_containment - 1) < 0.0001,
      'weights ' + JSON.stringify(ghost ? ghost.weights : null) + ', warnings ' +
      JSON.stringify(ghost ? ghost.warnings.filter(function (w) { return w.indexOf('ghost_question') >= 0; }) : []));
    push('the narrow version is STRICTLY increasing even when the model repeats a lower one',
      ghost !== null && ghost.version > Math.max(judgeBase.version || 0, ghostCandidate.version || 0),
      'v' + (ghost ? ghost.version : '-') + ' after base v' + judgeBase.version + ' and a candidate claiming v' + ghostCandidate.version);

    /* The operator intervention: a forced consult whose proposal must ACKNOWLEDGE the directive,
       with the version floored at the RUN LEDGER (not at the older best.rules). */
    const directiveStub = createDualStub({
      proposals: [Object.assign({
        version: 3, rationale: 'directive: value the formation and the horizontal line',
        weights: { cats_win_forecast: 0.2, mouse_containment: 0.8 }, confidenceFloor: 0.45,
        evidence_ref: { operator_directive: true, why: 'the operator asked for formation play' }
      }, {
        board_reading: {
          positions: [0, 1],
          measures: [{ name: 'horizontal_spread', definition: 'max row minus min row over the four Cats', values: { 0: 0, 1: 2 } }],
          distinction: 'the directive line keeps the spread while the measured line opens it'
        }
      })]
    });
    const directiveApi = createSandbox(directiveStub);
    Object.assign(directiveApi.config, { llmUrl: 'https://stub.local/v1/chat/completions', llmModel: 'stub-llm', llmKey: 'k' });
    directiveApi.match.status = 'tuning';
    directiveApi.match.rulesHistory.push({
      version: 8, source: 'llm-mutation', rationale: 'an older, higher version from this run',
      weights: { cats_win_forecast: 1 }, battery: directiveApi.DEFAULT_BATTERY, confidenceFloor: 0.45
    });
    const forced = await directiveApi.directiveRules(directiveApi.match.rules, 1,
      { perfect: true, wins: 3, total: 3 },
      { text: 'Cats advance in formation, keeping one horizontal line while far from the Mouse', queuedAt: '2026-09-19T00:00:00.000Z', ply: 4 });
    const directivePayload = directiveStub.llmCalls.length
      ? String(directiveStub.llmCalls[directiveStub.llmCalls.length - 1].messages[1].content) : '';
    push('a queued operator directive forces a System-2 consult, cites the directive, and the version follows the RUN LEDGER',
      forced !== null && forced.version === 9 &&
      directiveApi.Telemetry.operatorInterventions === 1 &&
      directiveApi.match.rulesHistory.some(function (r) { return r.version === 9; }) &&
      directivePayload.indexOf('operator_directive') > 0 &&
      directivePayload.indexOf('horizontal line') > 0,
      'v' + (forced ? forced.version : '-') + ', interventions ' + directiveApi.Telemetry.operatorInterventions +
        ', directive in payload: ' + (directivePayload.indexOf('operator_directive') > 0));

    const muteDirectiveStub = createDualStub({
      proposals: [{ version: 5, rationale: 'ignores what the operator asked for',
        weights: { cats_win_forecast: 0.9, mouse_containment: 0.1 }, confidenceFloor: 0.45 }]
    });
    const directiveMuteApi = createSandbox(muteDirectiveStub);
    Object.assign(directiveMuteApi.config, { llmUrl: 'https://stub.local/v1/chat/completions', llmModel: 'stub-llm', llmKey: 'k' });
    directiveMuteApi.match.status = 'tuning';
    const refusedDirective = await directiveMuteApi.directiveRules(directiveMuteApi.match.rules, 1,
      { perfect: true, wins: 3, total: 3 }, { text: 'make the Cats keep one line', queuedAt: 'x', ply: 2 });
    push('a directive proposal that does not ACKNOWLEDGE the directive is UNSUPPORTED and changes nothing',
      refusedDirective === null && directiveMuteApi.Telemetry.operatorInterventions === 1 &&
      directiveMuteApi.Telemetry.unsupportedProposals === 1 && directiveMuteApi.match.rules.version === 0,
      'refused ' + (refusedDirective === null) + ', unsupported ' + directiveMuteApi.Telemetry.unsupportedProposals);

    const formation = judgeApi.catFormationFacts([
      { side: judgeApi.SIDE_CATS, move: 'cat#1 (3,0)->(2,1)',
        snapshot: { cats: [[1, 0], [3, 0], [5, 0], [7, 0]], mouse: [0, 7], turn: judgeApi.SIDE_CATS, ply: 1 } },
      { side: judgeApi.SIDE_CATS, move: 'cat#1 (2,1)->(1,2)',
        snapshot: { cats: [[1, 2], [3, 0], [5, 1], [7, 1]], mouse: [0, 7], turn: judgeApi.SIDE_CATS, ply: 3 } }
    ]);
    push('the post-game report carries CAT FORMATION facts: spread and the stranded Cat are measured, not judged',
      formation !== null && formation.per_ply.length === 2 &&
      formation.per_ply[0].spread === 6 && formation.per_ply[0].left_behind === false &&
      formation.per_ply[1].spread === 6 && formation.per_ply[1].left_behind === true &&
      formation.per_ply[1].front_row === 2 && formation.per_ply[1].rear_row === 0,
      'per_ply ' + JSON.stringify(formation ? formation.per_ply : null));

    /* The consensus judge: independent votes, its OWN prompt, and the author's story withheld. */
    const voteStub = createDualStub({
      proposals: [{ decision: 'narrow', kinds: ['weights'], reason: 'only the weights are supported by the evidence' }]
    });
    const voteApi = createSandbox(voteStub);
    Object.assign(voteApi.config, { llmUrl: 'https://stub.local/v1/chat/completions', llmModel: 'stub-llm', llmKey: 'k' });
    const consensus = await voteApi.judgeRuleDiffConsensus(judgeBase,
      Object.assign({}, rewritten, { weights: sharper.weights }), { cases: oneLine });
    const judgeBodies = JSON.stringify(voteStub.llmCalls);
    push('the consensus judge votes on a BLINDED payload with its own prompt, and a quorum decides',
      consensus !== null && consensus.decision === 'narrow' && consensus.judge === 'consensus' &&
      consensus.votes.narrow === voteApi.CONSENSUS_VOTES &&
      consensus.applied_fields.join(',') === 'weights' &&
      judgeBodies.indexOf('SECRET-AUTHOR-STORY-42') < 0 &&
      judgeBodies.indexOf('"rationale"') < 0 &&
      voteStub.llmCalls[0].messages[0].content.indexOf('INDEPENDENT JUDGE') >= 0 &&
      voteStub.llmCalls[0].messages[0].content.indexOf('YOUR ONLY OUTPUT') < 0,
      'votes ' + JSON.stringify(consensus ? consensus.votes : null) + ', ' + voteStub.llmCalls.length + ' call(s)');
    const muteStub = createDualStub({ proposals: ['not a json answer at all'] });
    const muteApi = createSandbox(muteStub);
    Object.assign(muteApi.config, { llmUrl: 'https://stub.local/v1/chat/completions', llmModel: 'stub-llm', llmKey: 'k' });
    const noVotes = await muteApi.judgeRuleDiffConsensus(judgeBase, sharper, { cases: oneLine });
    push('votes that cannot be read are NOT an approval: no usable vote means null, never apply',
      noVotes === null && muteApi.Telemetry.judgeCalls === 0,
      muteStub.llmCalls.length + ' call(s), usable votes ' + muteApi.Telemetry.judgeCalls);
  }
  /* ---- 3k. The opponent model, the oracle and the accuracy of each question. ---- */
  {
    /* A LOW-confidence stub on purpose: with a high confidence the alpha-beta window closes and both
       models get cut short, which would hide the effect of the opponent model behind the pruning. */
    const searchStub = createJevStub({ confidence: 0.2 });
    const searchApi = createSandbox(searchStub);
    Object.assign(searchApi.config, {
      typesafeUrl: 'https://api.typesafe.ai/v1/systemone', typesafeKey: 'test-key', jevModel: 'jev-latest',
      depth: 3, parallelBranch: 1, stepDelayMs: 0
    });
    /* Column 2, not 0: a Mouse on the corner square has exactly ONE legal move, so the two
       opponent models would explore the same tree and the measurement would prove nothing. */
    const start = searchApi.createInitialState(2);
    push('the opponent model is the CODE-ONLY planner unless a human plays the Mouse',
      searchApi.defaultOpponentModel() === 'planner' &&
      (function () {
        searchApi.match.play = { humanSide: searchApi.SIDE_MOUSE };
        const human = searchApi.defaultOpponentModel() === 'adversarial';
        searchApi.match.play = null;
        return human;
      })());
    const adversarial = await searchApi.searchBestMove(start, searchApi.DEFAULT_RULES, { depth: 3, opponentModel: 'adversarial' });
    const vsGreedy = await searchApi.searchBestMove(start, searchApi.DEFAULT_RULES, { depth: 3, opponentModel: 'greedy' });
    push('modelling the real Mouse searches a SMALLER tree and still returns a legal move',
      vsGreedy.ctx.nodes < adversarial.ctx.nodes && !!vsGreedy.result.bestMove &&
      searchApi.legalMovesForSide(start, searchApi.SIDE_CATS).some(function (move) {
        return searchApi.moveKey(move) === searchApi.moveKey(vsGreedy.result.bestMove);
      }),
      vsGreedy.ctx.nodes + ' nodes vs ' + adversarial.ctx.nodes + ' against a phantom Mouse');
    push('the pass log says which opponent the search is facing',
      searchApi.logState.entries.some(function (e) { return e.channel === 'SEARCH' && e.message.indexOf('opponent greedy') >= 0; }) &&
      searchApi.logState.entries.some(function (e) { return e.channel === 'SEARCH' && e.message.indexOf('opponent adversarial') >= 0; }));

    const oracleApi = createSandbox(createJevStub({}));
    const oracleState = oracleApi.createInitialState(0);
    const first = oracleApi.oracleVerdict(oracleState);
    const before = oracleApi.Telemetry.oracleCalls;
    const second = oracleApi.oracleVerdict(oracleState);
    push('the oracle is cached per position: the same board is not solved twice',
      first === second && oracleApi.Telemetry.oracleCalls === before && oracleApi.Telemetry.oracleReuses > 0,
      oracleApi.Telemetry.oracleCalls + ' solve(s), ' + oracleApi.Telemetry.oracleReuses + ' reuse(s)');
    const starved = oracleApi.oracleVerdict(oracleApi.createInitialState(2), { budget: 5 });
    push('a starved oracle claims NOTHING: known is false and the value is neither confirmed nor contradicted',
      starved.known === false && starved.exhausted === true &&
      oracleApi.describeValueAgainstTruth(0.9, starved).indexOf('CONTRADICTION') < 0 &&
      oracleApi.describeValueAgainstTruth(0.9, starved).indexOf('no verdict') > 0,
      'known ' + starved.known + ', exhausted ' + starved.exhausted + ', ' + starved.nodes + ' nodes');
    const catVerdict = { winner: oracleApi.SIDE_CATS, plies: 2, known: true };
    const mouseVerdict = { winner: oracleApi.SIDE_MOUSE, plies: 3, known: true };
    push('a value that disagrees with the rules is reported as a CONTRADICTION in both directions',
      oracleApi.describeValueAgainstTruth(0.1, catVerdict).indexOf('CONTRADICTION: the rules already WIN') === 0 &&
      oracleApi.describeValueAgainstTruth(0.95, mouseVerdict).indexOf('CONTRADICTION: the rules already LOSE') === 0 &&
      oracleApi.describeValueAgainstTruth(0.9, catVerdict).indexOf('CONTRADICTION') < 0,
      oracleApi.describeValueAgainstTruth(0.95, mouseVerdict));

    const triggerApi = createSandbox(createJevStub({}));
    triggerApi.match.state = triggerApi.createInitialState(0);
    triggerApi.match.rules = triggerApi.DEFAULT_RULES;
    const loudSearch = {
      result: { value: 0.95, calibrated: 0.9, bestMove: null, line: [] },
      ctx: { confidenceFloor: 0.45, pathCases: [] },
      oracle: { winner: triggerApi.SIDE_MOUSE, plies: 4, known: true, reason: 'mouse_reached_row_0' }
    };
    const loud = triggerApi.courseCorrectionTrigger(loudSearch);
    push('the trigger fires on a rules contradiction even when the confidence is HIGH',
      String(loud).indexOf('CONTRADICTION') === 0 && String(loud).indexOf('mouse_reached_row_0') > 0, loud);
    const quiet = triggerApi.courseCorrectionTrigger({
      result: { value: 0.55, calibrated: 0.1, bestMove: null, line: [] },
      ctx: { confidenceFloor: 0.45, pathCases: [] },
      oracle: { known: false, exhausted: true }
    });
    push('uncertainty alone is NOT a trigger any more (that is what made every ply consult)',
      quiet === null, String(quiet));
    const tieSearch = {
      result: { value: 0.5, calibrated: 0.9, bestMove: null, line: [] },
      ctx: { confidenceFloor: 0.45, pathCases: [{ kind: 'near_tie', gap: 0.01, leaf: { value: 0.5, confidence: 0.4, atoms: {} } }] },
      oracle: { known: false }
    };
    push('a coin-flip decision still triggers a consult',
      String(triggerApi.courseCorrectionTrigger(tieSearch)).indexOf('coin-flip') > 0);

    const accuracyApi = createSandbox(createJevStub({}));
    accuracyApi.Telemetry.noteAtomTruth(accuracyApi.SIDE_CATS, { separating: 0.9, flat: 0.5 });
    accuracyApi.Telemetry.noteAtomTruth(accuracyApi.SIDE_CATS, { separating: 0.8, flat: 0.5 });
    accuracyApi.Telemetry.noteAtomTruth(accuracyApi.SIDE_MOUSE, { separating: 0.1, flat: 0.5 });
    accuracyApi.Telemetry.noteAtomTruth(accuracyApi.SIDE_MOUSE, { separating: 0.2, flat: 0.5 });
    const measured = accuracyApi.Telemetry.atomAccuracy({ minSamples: 2 });
    const separating = measured.filter(function (a) { return a.id === 'separating'; })[0];
    const flat = measured.filter(function (a) { return a.id === 'flat'; })[0];
    push('a question that separates winning from losing positions is measured as informative',
      separating.separation > 0.5 && separating.informative === true && separating.samples_cat_wins === 2 &&
      separating.mean_when_cats_win > separating.mean_when_mouse_wins,
      'separation ' + separating.separation + ' (' + separating.mean_when_cats_win + ' vs ' + separating.mean_when_mouse_wins + ')');
    push('a question that answers the same either way is measured as UNINFORMATIVE',
      flat.separation === 0 && flat.informative === false,
      'separation ' + flat.separation + ' over ' + (flat.samples_cat_wins + flat.samples_mouse_wins) + ' labelled position(s)');
    push('with too few labelled positions no verdict is given on a question (null, not a guess)',
      accuracyApi.Telemetry.atomAccuracy().filter(function (a) { return a.id === 'flat'; })[0].informative === null);

    const noteApi = createSandbox(createJevStub({}));
    noteApi.logNoteOnce('key', 'JEV', 'warn', 'the same note on every leaf');
    noteApi.logNoteOnce('key', 'JEV', 'warn', 'the same note on every leaf');
    noteApi.logNoteOnce('key', 'JEV', 'warn', 'the same note on every leaf');
    const printed = noteApi.logState.entries.filter(function (e) {
      return e.message.indexOf('the same note on every leaf') >= 0;
    }).length;
    push('a repeated note is printed once and folded after that (the log stays readable)',
      printed === 1 && noteApi.logState.suppressedNotes === 2 && noteApi.logState.warnedOnce.key === 3,
      printed + ' printed, ' + noteApi.logState.suppressedNotes + ' folded');
  }
  /* 3h. Opt-in end-to-end proof against a RUNNING relay (real key, real Jev answers).
     Enable with JEV_RELAY_URL, e.g. $env:JEV_RELAY_URL='http://127.0.0.1:8787/api/jev' */
  const relayUrl = process.env.JEV_RELAY_URL;
  if (relayUrl) {
    const liveApi = createSandbox({ fetch: function (url, init) { return fetch(url, init); } });
    Object.assign(liveApi.config, {
      typesafeUrl: relayUrl, typesafeKey: '', jevModel: process.env.JEV_MODEL || 'jev-latest',
      typesafeRetries: 0, typesafeTimeoutMs: 30000
    });
    const probe = await liveApi.probeJevConnection({});
    push('end-to-end through the live relay: one real Jev leaf answered',
      probe.ok === true && probe.probe.source === 'live',
      probe.ok ? ('V=' + probe.probe.winProbability + ' confidence=' + probe.probe.confidence)
        : String(liveApi.jevHealth.lastError));
    } else {
    console.log('SKIP behaviour: end-to-end relay check (start the relay and set JEV_RELAY_URL to enable it)');
  }

  /* 3s. The observation vocabulary is a closed, pure op registry with a version. */
    push('the default rule set declares observations (System 2 drives the facts, not the harness)',
    !!api.DEFAULT_RULES.observations && Object.keys(api.DEFAULT_RULES.observations).length > 0,
    JSON.stringify(api.DEFAULT_RULES.observations));
  push('the measurement spec is gated by a version constant',
    typeof api.MEASURE_SPEC_VERSION === 'number' && api.MEASURE_SPEC_VERSION === 2, api.MEASURE_SPEC_VERSION);
  push('the measurement vocabulary executes registered ops and bounded declarative expressions',
    JSON.stringify(api.MEASURE_KINDS) === JSON.stringify(['op', 'expr']), JSON.stringify(api.MEASURE_KINDS));
  const weightOnlyFormula = api.normalizeRules({ weights: { cats_win_forecast: 1, mouse_containment: 0 } },
    { fallback: api.DEFAULT_RULES }).rules;
  push('omitting observations preserves the current O(s) instead of silently erasing the formula',
    Object.keys(weightOnlyFormula.observations).join(',') === Object.keys(api.DEFAULT_RULES.observations).join(',') &&
    Object.keys(api.DEFAULT_RULES.observations).every(function (id) {
      return JSON.stringify(weightOnlyFormula.observations[id].spec) === JSON.stringify(api.DEFAULT_RULES.observations[id].spec);
    }),
    JSON.stringify(Object.keys(weightOnlyFormula.observations || {})));
  push('reweighting changes the full formula but preserves the reusable Jev judgment program',
    api.formulaHash(weightOnlyFormula) !== api.formulaHash(api.DEFAULT_RULES) &&
    api.judgmentFormulaHash(weightOnlyFormula) === api.judgmentFormulaHash(api.DEFAULT_RULES));
  const noObservationResult = api.normalizeRules({
    observations: {}, weights: { simple_value: 1 },
    battery: { simple_value: { type: 'noul', instructions: 'Is this abstract state favourable?', criteria: { true: 'yes', false: 'no' } } }
  }, { fallback: api.DEFAULT_RULES });
  push('an empty observations object is refused: every executable formula observes at least one fact',
    Object.keys(noObservationResult.rules.observations || {}).length === Object.keys(api.DEFAULT_RULES.observations).length &&
    noObservationResult.warnings.some(function (warning) { return warning.indexOf('at least one executable observation') >= 0; }),
    JSON.stringify(noObservationResult.warnings));
  push('the semantic rule hash includes observations, not only battery and weights',
    api.rulesHash(Object.assign({}, api.DEFAULT_RULES, { observations: {} })) !== api.rulesHash(api.DEFAULT_RULES));

  /* 3t. A measure is a pure fact of the state, computed with zero network. */
  const obsState = api.createInitialState(0);        // Cats on row 7, Mouse on row 0
  const preCalls = stub.state.calls.length;
  const measured = api.computeObservations(obsState, api.DEFAULT_RULES.observations);
  const postCalls = stub.state.calls.length;
    push('computeObservations makes no endpoint call and returns a fixed-shape bag',
    postCalls === preCalls && !!measured && typeof measured.count === 'number' && measured.count > 0 &&
    typeof measured.values === 'object' && !Array.isArray(measured.values) && Array.isArray(measured.errors) &&
    Object.keys(measured.values).every(function (k) { return typeof measured.values[k] === 'number'; }),
    postCalls === preCalls ? ('count=' + measured.count + ' no calls') : ('LEAKED ' + (postCalls - preCalls) + ' calls'));

    /* 3u. Known op values on the opening state: Cats all on row 7, Mouse all the way down on row 0. */
  const byId = measured.values;
  push('the declared measures compute their known opening values',
    byId.mouse_row === 7 && byId.cat_front_row === 0, JSON.stringify(byId));
  push('every measured value is inside the op-declared range',
    Object.keys(byId).every(function (k) { var op = api.OBSERVATION_OPS[k]; return op && byId[k] >= op.range[0] && byId[k] <= op.range[1]; }),
    JSON.stringify(Object.keys(byId).map(function(k){return k+':'+byId[k];})));
  const flatPositions = api.boardPositionArray(obsState);
  push('the environment exposes the canonical flat board-position array',
    flatPositions.length === 5 && flatPositions.filter(function (p) { return p.piece === 'cat'; }).length === 4 &&
    flatPositions.filter(function (p) { return p.piece === 'mouse'; })[0].y === 7 && Object.isFrozen(flatPositions),
    JSON.stringify(flatPositions));
  const replayState = api.applyMove(obsState, api.legalMovesForSide(obsState, api.SIDE_CATS)[0]);
  const replayCallsBefore = stub.state.calls.length;
  const formulaReplay = api.replayFormulaOnEvidence(api.DEFAULT_RULES, [
    { case_id: 'good#0', leaf_state: obsState, leaf: { outcome_label: 'good_for_cats' } },
    { case_id: 'bad#1', leaf_state: replayState, leaf: { outcome_label: 'bad_for_cats' } }
  ]);
  push('candidate O(s) is executed by code over the exact good/bad leaf boards before Jev',
    formulaReplay.valid === true && formulaReplay.evaluated_leaf_boards === 2 &&
    formulaReplay.rows[0].outcome_label === 'good_for_cats' &&
    formulaReplay.rows[1].outcome_label === 'bad_for_cats' &&
    formulaReplay.rows.every(function (row) { return row.positions.length === 5 && Object.keys(row.measurements).length > 0; }) &&
    stub.state.calls.length === replayCallsBefore,
    JSON.stringify({ valid: formulaReplay.valid, rows: formulaReplay.rows.length, errors: formulaReplay.errors }));
  const spreadExpr = api.compileMeasure({
    kind: 'expr', range: [0, 7],
    expr: { op: 'sub', args: [
      { op: 'aggregate', group: 'cats', field: 'y', reduce: 'max' },
      { op: 'aggregate', group: 'cats', field: 'y', reduce: 'min' }
    ] }
  });
  push('System 2 can formulate a derived measure and code executes it over the position array',
    spreadExpr.ok === true && spreadExpr.fn(flatPositions, { turn: obsState.turn, ply: obsState.ply }) === 0,
    JSON.stringify({ ok: spreadExpr.ok, error: spreadExpr.error, nodes: spreadExpr.nodes }));
  const badExpr = api.compileMeasure({ kind: 'expr', range: [0, 7], expr: { op: 'javascript', source: 'return 1' } });
  push('arbitrary code is not a measurement language',
    badExpr.ok === false && badExpr.error.indexOf('unknown expression op') >= 0, badExpr.error);
  push('the measured vector travelled to Jev as a fact in the request, not as a value',
    (function () {
      const b = firstCall && firstCall.body;
      return !!b && !!b.state.measurements && typeof b.state.measurements === 'object' &&
        b.state.measurements.mouse_row === 7 && b.state.measurements.cat_front_row === 0;
    })(), JSON.stringify(firstCall && firstCall.body && firstCall.body.state && firstCall.body.state.measurements));

  const explicitEnvironment = api.createBoardEnvironment(obsState);
  const explicitFormula = api.ruleFormulaOf(api.DEFAULT_RULES);
  const explicitEval = await explicitEnvironment.Eval(explicitFormula, {});
  push('the environment owns Eval(formula), and the result identifies the formula it ran',
    typeof explicitEnvironment.Eval === 'function' && explicitEval.formulaHash === api.formulaHash(explicitFormula) &&
    explicitEval.winProbability >= 0 && explicitEval.winProbability <= 1,
    'formula=' + explicitEval.formulaHash + ' source=' + explicitEval.source);
  const exportedFormulaEval = await explicitEnvironment.Eval(api.toWireRules(api.DEFAULT_RULES), {});
  push('the copied wire rule set is itself an Eval-compatible cached formula',
    exportedFormulaEval.formulaHash === explicitEval.formulaHash && exportedFormulaEval.source.indexOf('cached') === 0,
    'formula=' + exportedFormulaEval.formulaHash + ' source=' + exportedFormulaEval.source);

        /* 3v. Unknown / malformed ops are rejected WITH A REASON, never silently neutral. */
    const badWarnings = [];
    const badRaw = {
      not_an_op: { spec: { op: 'no_such_op', args: {} } },            // unknown op
      mouse_row_ok: { spec: { op: 'mouse_row', args: {} } }           // valid
    };
    const normObs = api.normalizeObservations(badRaw, badWarnings);
  push('an unknown op is dropped with a reason, the valid op is kept',
      normObs.dropped.indexOf('not_an_op') >= 0 && normObs.dropped.indexOf('mouse_row_ok') < 0 &&
      Object.prototype.hasOwnProperty.call(normObs.observations, 'mouse_row_ok') &&
      badWarnings.some(function (w) { return w.indexOf('not_an_op') >= 0; }),
      JSON.stringify(normObs) + ' | warnings=' + JSON.stringify(badWarnings));
  const placeholderRules = api.normalizeRules({
    observations: { mouse_routes: { spec: { kind: 'op', op: 'mouse_routes', args: { cap: 3 } } } },
    battery: {
      route_judgment: {
        type: 'score', instructions: 'Judge containment from measured routes {{ mouse_routes }}.',
        criteria: ['{{mouse_routes}} leaves many routes', 'some routes', 'few routes']
      }
    },
    weights: { route_judgment: 1 }
  }, { fallback: api.DEFAULT_RULES }).rules;
  push('observation placeholders, including whitespace and ids containing s, survive the gate and are substituted',
    !!placeholderRules.battery.route_judgment &&
    api.substituteQuestionObservations(api.materializeQuestions(placeholderRules.battery, obsState, {}).questions,
      api.computeObservations(obsState, placeholderRules.observations).values).route_judgment.instructions.indexOf('{{') < 0,
    JSON.stringify(placeholderRules.battery));

    /* 3w. compileMeasure refuses an unregistered op and names it in the error. */
    const compiledBad = api.compileMeasure({ op: 'phantom_op', args: {} });
    push('compileMeasure rejects an op not in the vocabulary and reports the name',
      compiledBad.ok === false && compiledBad.error.indexOf('phantom_op') >= 0, String(compiledBad.error));

    /* 3x. Two distinct declared ids both survive; a bad op is dropped before it can corrupt the vector. */
    const dupRaw = {
      mouse_row: { spec: { op: 'mouse_row', args: {} } },
      cat_front_row_ok: { spec: { op: 'cat_front_row', args: {} } }
    };
    const dupObs = api.normalizeObservations(dupRaw, []);
    push('two distinct ids both survive (keyed by id, each is a separate measure)',
      Object.keys(dupObs.observations).length === 2, JSON.stringify(Object.keys(dupObs.observations)));

      /* 3y. The vector cache key changes with the measured vector: same vector reuses, a different vector does not. */
  const vStateA = api.createInitialState(0);              // mouse_row 7, cat_front_row 0
  /* state B: same measured vector (mouse_row=7, cat_front_row=0) but a DIFFERENT
     stateKey (Mouse on another dark square of row 7; column 2 instead of 0). */
  const vStateB = Object.assign({}, vStateA, { mouse: [2, 7] });
  const vectorBattery = {
    measured_forecast: {
      type: 'choice', used_as: 'value', option: 'cats_win',
      instructions: 'Judge the declared measurements only.',
      criteria: { cats_win: 'measurements favour the Cats', mouse_win: 'measurements favour the Mouse' }
    }
  };
  const rulesVec = api.normalizeRules({
    version: 2, weights: { measured_forecast: 1 }, battery: vectorBattery,
    observations: { mouse_row: { spec: { op: 'mouse_row', args: {} } }, cat_front_row: { spec: { op: 'cat_front_row', args: {} } } }
  }, { fallback: api.DEFAULT_RULES }).rules;
  /* sanity: both states measure the same vector */
  const vecA = api.computeObservations(vStateA, rulesVec.observations).vector;
  const vecB = api.computeObservations(vStateB, rulesVec.observations).vector;
  const sameVector = vecA === vecB && vecA.length > 0;
  const differentStateKey = api.stateKey(vStateA) !== api.stateKey(vStateB);
  api.resetHarness(false);
  api.jevAnswerCache.clear();
  api.jevVectorCache.clear();
  api.jevValueCache.clear();
  const baselineHits = api.Telemetry.jevVectorCacheHits;
  const baselineCalls = stub.state.calls.length;
  await api.evaluateWithJev(vStateA, rulesVec, {});                        // A: miss -> inference + vector cache filled
  const firstHits = api.Telemetry.jevVectorCacheHits;
  const callsAfterA = stub.state.calls.length;
  const reused = await api.evaluateWithJev(vStateB, rulesVec, {});          // B: inference miss (diff stateKey), vector HIT
  const secondHits = api.Telemetry.jevVectorCacheHits;
  const callsAfterB = stub.state.calls.length;
  push('two positions sharing the same measure-vector reuse the cached judgement (vector cache hit, no new call)',
    sameVector && differentStateKey && secondHits === firstHits + 1 && callsAfterB === callsAfterA,
    'vecEq=' + sameVector + ' keyDiff=' + differentStateKey + ' hits ' + firstHits + '->' + secondHits + ' calls ' + callsAfterA + '->' + callsAfterB);
  push('the reused judgement is tagged as coming from the vector cache, not a fresh live call',
    reused.source === 'cached-vector' && callsAfterB === callsAfterA, 'source=' + reused.source + ' calls=' + (callsAfterB - baselineCalls));
  const sameStatePrimitive = api.normalizeRules({
    version: 5, weights: { measured_forecast: 1 }, battery: vectorBattery,
    observations: { signal: { spec: { kind: 'op', op: 'mouse_row', args: {} } } }
  }, { fallback: api.DEFAULT_RULES }).rules;
  const sameStateExpr = api.normalizeRules({
    version: 6, weights: { measured_forecast: 1 }, battery: vectorBattery,
    observations: { signal: { spec: { kind: 'expr', range: [0, 7], expr: { op: 'aggregate', group: 'mouse', field: 'y', reduce: 'max' } } } }
  }, { fallback: api.DEFAULT_RULES }).rules;
  api.jevAnswerCache.clear(); api.jevVectorCache.clear(); api.jevValueCache.clear();
  const callsBeforeSpecChange = stub.state.calls.length;
  await api.evaluateWithJev(vStateA, sameStatePrimitive, {});
  await api.evaluateWithJev(vStateA, sameStateExpr, {});
  push('re-specifying a measure invalidates exact and vector caches even when the resulting number is equal',
    stub.state.calls.length === callsBeforeSpecChange + 2 &&
    api.judgmentFormulaHash(sameStatePrimitive) !== api.judgmentFormulaHash(sameStateExpr),
    'calls=' + (stub.state.calls.length - callsBeforeSpecChange));
    push('a DIFFERENT vector must NOT reuse: only cat_front_row is shared, mouse_row differs -> distinct vectorKey',
    (function () {
      const rulesSingleA = api.normalizeRules({
        version: 3, weights: { measured_forecast: 1 }, battery: vectorBattery,
        observations: { mouse_row: { spec: { op: 'mouse_row', args: {} } } }
      }, { fallback: api.DEFAULT_RULES }).rules;
      const va = api.computeObservations(vStateA, rulesSingleA.observations).vector;
      const rulesSingleB = api.normalizeRules({
        version: 4, weights: { measured_forecast: 1 }, battery: vectorBattery,
        observations: { cat_front_row: { spec: { op: 'cat_front_row', args: {} } } }
      }, { fallback: api.DEFAULT_RULES }).rules;
      const vb = api.computeObservations(vStateB, rulesSingleB.observations).vector;
      /* mouse_row=0 vs cat_front_row=7 -> different vector strings (different op + different id) */
      return va !== vb;
    })(), 'mouse_row vector vs cat_front_row vector differ');

    /* 3z. The measured facts travel with the result as evidence a later formula can cite. */
  const measuredLeaf = await api.evaluateWithJev(api.createInitialState(0), api.DEFAULT_RULES, {});
  push('the result carries the measured vector as reusable evidence',
    !!measuredLeaf.measured && typeof measuredLeaf.measured === 'object' &&
    Object.prototype.hasOwnProperty.call(measuredLeaf.measured, 'mouse_row') &&
    typeof measuredLeaf.measured.mouse_row === 'number',
    JSON.stringify(measuredLeaf.measured));
  push('measuredDeclared matches the number of declared observations',
    measuredLeaf.measuredDeclared === Object.keys(api.DEFAULT_RULES.observations).length,
    'declared=' + Object.keys(api.DEFAULT_RULES.observations).length + ' declared=' + measuredLeaf.measuredDeclared);

  results.forEach(function (item) {
    console.log((item.pass ? 'OK   ' : 'FAIL ') + 'behaviour: ' + item.name + (item.detail ? ' [' + item.detail + ']' : ''));
  });
  const ok = results.every(function (item) { return item.pass; });
  console.log('');
  console.log(ok ? 'ALL VALIDATION PASSED' : 'VALIDATION FAILED');
  process.exit(ok ? 0 : 1);
})();
