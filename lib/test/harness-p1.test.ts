import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT, sampleStates } from './support.ts';
import { stubJev } from './stub-jev.ts';
import { foxhounds } from '../src/worlds/foxhounds/world.ts';

/* P1 in the WORKING harness: System 2 may declare measures as code (Eval mode), the observation mode decides
   which kinds it may declare, the code seed carries no catalogue op, the replay proves a code measure is a
   deterministic fact, and the telemetry reports a measure that has absorbed the judgment. */

function loadWorkingHarness(fetchImpl?: (url: string, init: any) => Promise<any>): any {
  const html = fs.readFileSync(path.join(ROOT, 'fox-hounds-harness.html'), 'utf8');
  const source = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  const sandbox: Record<string, unknown> = { console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, setInterval, clearInterval,
    performance: { now: () => Date.now() }, AbortController, fetch: fetchImpl ?? (() => Promise.reject(new Error('offline'))) };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source + ';globalThis.__api = { config, compileMeasure, normalizeRules, seedRules, DEFAULT_RULES, DEFAULT_CODE_RULES, ' +
    'buildLlmSystemPrompt, renderRulesShape, computeObservations, replayFormulaOnEvidence, evaluateWithJev, Telemetry, ' +
    'MEASURE_CODE_MAX_CHARS, ATOM_ACCURACY_MIN_SAMPLES, buildMetaContext, createInitialState };', sandbox);
  return sandbox.__api;
}
const plain = (v: unknown): any => JSON.parse(JSON.stringify(v));
const states = sampleStates(40, 17).filter((s) => !foxhounds.outcome(s).over);

const ROUTES_CODE = `function (ctx) {
  const size = ctx.view.scalars.board_size, cap = 8;
  const cats = ctx.view.entities.filter((e) => e.type === 'cat');
  const mouse = ctx.view.entities.find((e) => e.type === 'mouse');
  const occupied = (x, y) => ctx.view.entities.some((e) => e.x === x && e.y === y);
  const attacked = (x, y) => !occupied(x, y) && cats.some((c) => c.y === y - 1 && Math.abs(c.x - x) === 1);
  const memo = new Map();
  const count = (x, y) => {
    if (y === 0) return 1;
    const k = x + ',' + y;
    if (memo.has(k)) return memo.get(k);
    let total = 0;
    for (const dx of [-1, 1]) {
      const nx = x + dx, ny = y - 1;
      if (nx < 0 || nx >= size || (nx + ny) % 2 !== 1 || occupied(nx, ny) || attacked(nx, ny)) continue;
      total += count(nx, ny);
      if (total >= cap) { total = cap; break; }
    }
    memo.set(k, total);
    return total;
  };
  return Math.min(count(mouse.x, mouse.y), cap);
}`;

test('a code measure written from the rules computes exactly what the catalogue op computes', () => {
  const api = loadWorkingHarness();
  const decls = {
    routes_code: { spec: { kind: 'code', lang: 'js', range: [0, 8], source: ROUTES_CODE } },
    routes_op: { spec: { kind: 'op', op: 'mouse_routes', args: { cap: 8 } } }
  };
  for (const s of states) {
    const m = api.computeObservations(s, decls);
    assert.equal(m.errors.length, 0, JSON.stringify(plain(m.errors)));
    assert.equal(m.values.routes_code, m.values.routes_op);
  }
});

test('the observation mode governs what System 2 may DECLARE, and says why it refuses', () => {
  const api = loadWorkingHarness();
  const seed = api.normalizeRules(api.DEFAULT_RULES, { fallback: api.DEFAULT_RULES, source: 'bootstrap' }).rules;
  const proposal = (obs: Record<string, unknown>) => ({ version: 2, weights: seed.weights, battery: seed.battery, observations: { ...plain(seed.observations), ...obs } });
  const codeRoutes = { routes_code: { name: 'routes', definition: 'safe monotone paths', spec: { kind: 'code', lang: 'js', range: [0, 8], source: ROUTES_CODE } } };

  api.config.observationMode = 'dsl';
  const inDsl = api.normalizeRules(proposal(codeRoutes), { fallback: seed, source: 'llm-mutation' });
  assert.ok(!inDsl.rules.observations.routes_code);
  assert.ok(inDsl.warnings.some((w: string) => /kind "code" is not admitted by the observation mode "dsl"/.test(w)));

  api.config.observationMode = 'both';
  const inBoth = api.normalizeRules(proposal(codeRoutes), { fallback: seed, source: 'llm-mutation' });
  assert.ok(inBoth.rules.observations.routes_code && inBoth.rules.observations.mouse_routes);

  api.config.observationMode = 'code';
  /* The proposal judges the code seed's facts; its battery cites no catalogue measure. */
  const inCode = api.normalizeRules({ version: 2, weights: plain(api.DEFAULT_CODE_RULES.weights), battery: plain(api.DEFAULT_CODE_RULES.battery),
    observations: { ...plain(api.DEFAULT_CODE_RULES.observations), ...codeRoutes,
    op_leak: { spec: { kind: 'op', op: 'mouse_routes', args: {} } } } }, { fallback: api.seedRules(), source: 'llm-mutation' });
  assert.ok(inCode.warnings.some((w: string) => /"op_leak" was dropped: kind "op" is not admitted by the observation mode "code"/.test(w)));
  assert.ok(inCode.rules.observations.routes_code && !inCode.rules.observations.op_leak);
  assert.ok(Object.values(inCode.rules.observations).every((d: any) => d.spec.kind === 'code'));

  /* A rule set the harness imports or restores is not a proposal: it keeps running whatever the mode. */
  api.config.observationMode = 'dsl';
  const imported = api.normalizeRules(proposal(codeRoutes), { fallback: seed, source: 'imported' });
  assert.ok(imported.rules.observations.routes_code);
});

test('the code seed carries no catalogue op, and Jev judges it from measured facts only', async () => {
  const stub = stubJev();
  const api = loadWorkingHarness(stub.fetch);
  api.config.observationMode = 'code';
  Object.assign(api.config, { typesafeUrl: 'https://api.typesafe.ai/v1/systemone', typesafeKey: 'k' });
  const seed = api.normalizeRules(api.seedRules(), { fallback: api.seedRules(), source: 'bootstrap' });
  assert.equal(seed.warnings.length, 0, JSON.stringify(plain(seed.warnings)));
  assert.ok(Object.values(seed.rules.observations).every((d: any) => d.spec.kind === 'code'));
  const leaf = await api.evaluateWithJev(api.createInitialState(0), seed.rules, {});
  assert.equal(leaf.source, 'live');
  const body = stub.bodies[0];
  assert.deepEqual(Object.keys(body.state.measurements).sort(), Object.keys(seed.rules.observations).sort());
  assert.equal(body.state.measurements.mouse_row, 7);
  assert.equal(body.state.cats, undefined, 'no raw coordinates for value rules');
  assert.ok(!JSON.stringify(body.questions).includes('{{'), 'every placeholder is a measured number');
});

test('the gate refuses a code measure it cannot trust as a fact, WITH A REASON', () => {
  const api = loadWorkingHarness();
  assert.match(api.compileMeasure({ kind: 'code', lang: 'js', source: '() => 1' }).error, /finite range/);
  assert.match(api.compileMeasure({ kind: 'code', lang: 'py', range: [0, 1], source: 'lambda c: 1' }).error, /no runner for language "py"/);
  assert.match(api.compileMeasure({ kind: 'code', lang: 'js', range: [0, 1], source: '(ctx) => {' }).error, /does not compile/);
  const long = '(ctx) => 0' + ' '.repeat(api.MEASURE_CODE_MAX_CHARS);
  assert.match(api.compileMeasure({ kind: 'code', lang: 'js', range: [0, 1], source: long }).error, /not interpretable; split it/);
  const noisy = api.computeObservations(states[0], {
    rnd: { spec: { kind: 'code', lang: 'js', range: [0, 1], source: '() => Math.random()' } },
    clock: { spec: { kind: 'code', lang: 'js', range: [0, 1e13], source: '() => Date.now()' } }
  });
  assert.deepEqual(Object.keys(noisy.values), [], 'randomness and the clock are not in scope');
});

test('the replay on the evidence proves a code measure is deterministic before any Jev call', () => {
  const api = loadWorkingHarness();
  const seed = api.normalizeRules(api.DEFAULT_RULES, { fallback: api.DEFAULT_RULES, source: 'bootstrap' }).rules;
  const withCounter = { ...plain(seed), observations: { ...plain(seed.observations),
    drifting: { name: 'drift', definition: 'a counter hidden in a closure', spec: { kind: 'code', lang: 'js', range: [0, 1e6],
      source: '(function () { let n = 0; return (ctx) => ++n; })()' } } } };
  const cases = states.slice(0, 3).map((s, i) => ({ case_id: 'c' + i, leaf_state: s }));
  const bad = api.replayFormulaOnEvidence(withCounter, cases);
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.some((e: any) => e.observation === 'drifting' && /non-deterministic/.test(e.error)));
  const good = api.replayFormulaOnEvidence({ ...plain(seed), observations: { ...plain(seed.observations),
    routes_code: { spec: { kind: 'code', lang: 'js', range: [0, 8], source: ROUTES_CODE } } } }, cases);
  assert.equal(good.valid, true, JSON.stringify(plain(good.errors)));
});

test('a measure that separates the truth on its own is reported as having absorbed the judgment', () => {
  const api = loadWorkingHarness();
  const obs = {
    verdict_like: { range: [0, 1], spec: { kind: 'code' } },
    plain_fact: { range: [0, 7], spec: { kind: 'op' } }
  };
  const n = api.ATOM_ACCURACY_MIN_SAMPLES;
  for (let i = 0; i < n; i++) {
    api.Telemetry.noteMeasureTruth('cats', { verdict_like: 1, plain_fact: i % 8 }, obs);
    api.Telemetry.noteMeasureTruth('mouse', { verdict_like: 0, plain_fact: (i + 3) % 8 }, obs);
  }
  const rows = Object.fromEntries(api.Telemetry.measureAccuracy().map((r: any) => [r.id, r]));
  assert.equal(rows.verdict_like.absorbs_judgment, true);
  assert.equal(rows.verdict_like.kind, 'code');
  assert.equal(rows.plain_fact.absorbs_judgment, false);
  const payload = api.buildMetaContext(api.createInitialState(0), { task: 'compile_rules', lowConfidenceScore: null });
  const meta = JSON.parse(JSON.stringify(payload));
  const text = JSON.stringify(meta);
  assert.ok(text.includes('verdict_like_measures') && text.includes('absorbs_judgment'), 'System 2 is told');
});

test('the prompt teaches exactly the vocabulary of the mode (no capability it would refuse)', () => {
  const api = loadWorkingHarness();
  api.config.observationMode = 'code';
  const codePrompt = api.buildLlmSystemPrompt();
  assert.ok(codePrompt.includes('EVAL form (kind "code")') && codePrompt.includes('OBSERVE FACTS, LET JEV JUDGE'));
  assert.ok(!codePrompt.includes('- mouse_routes:') && !codePrompt.includes('EXPR AST'));
  assert.ok(codePrompt.includes('"kind": "code"') && !codePrompt.includes('"kind": "op"'));
  api.config.observationMode = 'dsl';
  const dslPrompt = api.buildLlmSystemPrompt();
  assert.ok(!dslPrompt.includes('EVAL form') && dslPrompt.includes('- mouse_routes:') && !dslPrompt.includes('"kind": "code"'));
});

test('in code mode no catalogue op reaches System 2: not as vocabulary, not as a seed, not as a "tried" set', () => {
  const api = loadWorkingHarness();
  api.config.observationMode = 'code';
  const payload = plain(api.buildMetaContext(api.createInitialState(0), { task: 'compile_rules', lowConfidenceScore: null }));
  assert.deepEqual(payload.observations_in_use.vocabulary, []);
  assert.equal(payload.observations_in_use.observation_mode, 'code');
  assert.ok(!payload.observations_in_use.declared_ids.includes('mouse_routes'));
  assert.ok(payload.tried_rule_sets.every((t: any) => t.source !== 'default'));
  const text = JSON.stringify(payload);
  for (const op of ['mouse_routes', 'covered_mouse_moves', 'front_row_gap', 'cat_adjacent_pairs']) assert.ok(!text.includes(op), op + ' leaked');
  api.config.observationMode = 'dsl';
  const dsl = plain(api.buildMetaContext(api.createInitialState(0), { task: 'compile_rules', lowConfidenceScore: null }));
  assert.ok(dsl.observations_in_use.vocabulary.some((v: any) => v.id === 'mouse_routes'));
});
