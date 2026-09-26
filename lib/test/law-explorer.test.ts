import test from 'node:test';
import assert from 'node:assert/strict';
import { LAW_TOOLS, lawExplorerPayload, lawExplorerSystem, ownLaw, parseLawTurn, type LawTool } from '../src/learn/law-explorer.ts';
import { ORBIT_PERCEPT_DOC } from '../src/worlds/orbit/sense.ts';

/* orbit@1, phase P3: what System 2 is told, and how its answers become laws and requests. */

/* Words that would tell it what kind of world this is, or what law to look for. */
const GIVEAWAYS = /\b(gravit\w*|newton\w*|mass(es)?|forces?|orbit\w*|planet\w*|stars?|suns?|attract\w*|pull\w*|physic\w*|energy|momentum|accelerat\w*|kepler\w*|inertia\w*|inverse|squared?)\b/i;

const draft = {
  observations: { dist: { definition: 'distance to the first body', source: '(p) => { const i = p.t.length - 1, a = p.bodies[p.symbols[0]], b = p.bodies[p.symbols[p.symbols.length - 1]]; return Math.hypot(a.x[i] - b.x[i], a.y[i] - b.y[i]); }', range: [0, 40] } },
  rules: { near: { type: 'noul', instructions: 'Is {{dist}} small?', criteria: { yes: 'small', no: 'large' } } },
  components: { toward: { definition: 'toward the first body', direction: '(p) => { const i = p.t.length - 1, a = p.bodies[p.symbols[0]], b = p.bodies[p.symbols[p.symbols.length - 1]]; return [a.x[i] - b.x[i], a.y[i] - b.y[i]]; }', weights: { near: 2 }, range: [0.001, 1], scale: 'log' } }
};

test('the prompt names no science, no law and no quantity of the world; withheld instruments are not mentioned', () => {
  const full = lawExplorerSystem();
  assert.doesNotMatch(full, GIVEAWAYS, 'giveaway: ' + (full.match(GIVEAWAYS)?.[0] ?? ''));
  assert.doesNotMatch(ORBIT_PERCEPT_DOC, GIVEAWAYS);
  for (const t of LAW_TOOLS) assert.match(full, new RegExp('"' + t + '"'), t + ' is described');
  const none = lawExplorerSystem(new Set<LawTool>());
  for (const t of LAW_TOOLS) assert.doesNotMatch(none, new RegExp('\\{"' + t + '"'), t + ' withheld');
  assert.doesNotMatch(none, /INVESTIGATE before proposing/);
  assert.match(none, /"components"/, 'the task and the law remain');
});

test('a proposal becomes a checked law: weights normalised per component, errors reported, beliefs kept', () => {
  const t = parseLawTurn(JSON.stringify({ rationale: 'r', ...draft, beliefs: [{ id: 'b1', stance: 'new', statement: 'closer means larger' }], lessons: ['l'] }), { world: 'orbit@1', round: 2 });
  assert.equal(t.kind, 'proposal');
  if (t.kind !== 'proposal' || !t.parse.ok) throw new Error('not parsed: ' + JSON.stringify(t));
  assert.deepEqual(t.parse.proposal.law.components.toward.weights, { near: 1 });
  assert.equal(t.parse.proposal.beliefs[0].id, 'b1');
  const bad = parseLawTurn(JSON.stringify({ ...draft, components: { toward: { ...draft.components.toward, range: [0, 1] } } }), { world: 'orbit@1' });
  assert.ok(bad.kind === 'proposal' && !bad.parse.ok && bad.parse.errors.some((e) => /log scale needs 0 < lo/.test(e)));
  const noDir = parseLawTurn(JSON.stringify({ ...draft, components: { toward: { ...draft.components.toward, direction: undefined } } }), { world: 'orbit@1' });
  assert.ok(noDir.kind === 'proposal' && !noDir.parse.ok);
});

test('an investigation: launches, drafts to simulate, measures and tables; malformed requests are reported, not run', () => {
  const t = parseLawTurn(JSON.stringify({ investigate: [
    { launch: { x: 1, y: 2, vx: 0, vy: 0.5 } },
    { launch: { x: 1, y: 'a', vx: 0, vy: 0.5 } },
    { simulate: 'launch1@10', law: draft, rows: 99 },
    { simulate: 'launch1@10', law: { components: {} } },
    { inspect: 'launch1@3' },
    { measure: { source: '(p) => p.t.length', range: [0, 100] }, on: ['launch1@3'] },
    { table: { source: '(p) => 1', range: [0, 1] }, on: 'tests' },
    { dance: true }
  ], notes: [{ id: 'n', text: 'x' }] }), { world: 'orbit@1' });
  if (t.kind !== 'investigate') throw new Error('not an investigation');
  assert.deepEqual(t.requests.map((r) => Object.keys(r)[0]), ['launch', 'simulate', 'inspect', 'measure', 'table']);
  assert.deepEqual((t.requests[0] as { launch: unknown }).launch, { x: 1, y: 2, vx: 0, vy: 0.5, m: 1 });
  assert.equal((t.requests[1] as { rows: number }).rows, 40, 'at most 40 rows');
  assert.equal(t.warnings.length, 3);
  assert.equal(t.notes[0].do, 'write');
});

test('only what the explorer wrote travels back, and the payload carries the percept and the budget', () => {
  const t = parseLawTurn(JSON.stringify(draft), { world: 'orbit@1' });
  if (t.kind !== 'proposal' || !t.parse.ok) throw new Error('not parsed');
  const own = ownLaw(t.parse.proposal.law) as { components: Record<string, { direction: string }> };
  assert.equal(own.components.toward.direction, draft.components.toward.direction);
  const payload = lawExplorerPayload({ round: 3, perceptDoc: ORBIT_PERCEPT_DOC, law: t.parse.proposal.law, lawRound: 2, stepsLeft: 2, launchesLeft: 5 });
  assert.equal(payload.launches_left, 5);
  assert.equal((payload.your_latest_law as { from_round: number }).from_round, 2);
});

test('a component may carry its magnitude in code; an ignored request is echoed back so it can be read', () => {
  const t = parseLawTurn(JSON.stringify({ observations: {}, rules: {}, components: { toward: { direction: draft.components.toward.direction, magnitude: '(p) => 0.5' } } }), { world: 'orbit@1' });
  if (t.kind !== 'proposal' || !t.parse.ok) throw new Error('not parsed: ' + JSON.stringify(t));
  assert.equal(t.parse.proposal.law.components.toward.magnitude?.source, '(p) => 0.5');
  assert.deepEqual(ownLaw(t.parse.proposal.law).components, { toward: { definition: '', direction: draft.components.toward.direction, magnitude: '(p) => 0.5' } });
  const bad = parseLawTurn(JSON.stringify({ ...draft, components: { toward: { ...draft.components.toward, magnitude: 3 } } }), { world: 'orbit@1' });
  assert.ok(bad.kind === 'proposal' && !bad.parse.ok);
  const inv = parseLawTurn(JSON.stringify({ investigate: [{ plot: 'launch1', from: 2 }] }), { world: 'orbit@1' });
  assert.ok(inv.kind === 'investigate' && /ignored \(\{"plot":"launch1","from":2\}\)/.test(inv.warnings[0]), JSON.stringify(inv));
});

test('System 2 decides when to validate: "validate": true on a proposal, false otherwise; the prompt explains the protocol', () => {
  const yes = parseLawTurn(JSON.stringify({ ...draft, validate: true }), { world: 'orbit@1' });
  const no = parseLawTurn(JSON.stringify(draft), { world: 'orbit@1' });
  assert.ok(yes.kind === 'proposal' && yes.parse.ok && yes.parse.proposal.validate === true);
  assert.ok(no.kind === 'proposal' && no.parse.ok && no.parse.proposal.validate === false);
  const prompt = lawExplorerSystem();
  assert.match(prompt, /"validate": true/);
  assert.match(prompt, /becomes one of your laboratories/);
  assert.equal(lawExplorerPayload({ round: 1, perceptDoc: '', validationsLeft: 2 }).validations_left, 2);
});
