import test from 'node:test';
import assert from 'node:assert/strict';
import { LAW_TOOLS, lawExplorerPayload, lawExplorerSystem, ownLaw, parseLawTurn, type LawTool } from '../src/learn/law-explorer.ts';
import { ORBIT_PERCEPT_DOC } from '../src/worlds/orbit/sense.ts';

/* orbit@1, phase P3: what System 2 is told, and how its answers become laws and requests. */

/* Words that would tell it what kind of world this is, or what law to look for. */
const GIVEAWAYS = /\b(gravit\w*|newton\w*|mass(es)?|forces?|orbit\w*|planet\w*|stars?|suns?|attract\w*|pull\w*|physic\w*|energy|momentum|accelerat\w*|kepler\w*|inertia\w*|inverse|squared?)\b/i;

const draft = {
  observations: { dist: { definition: 'distance to the first body', source: '(p) => { const i = p.t.length - 1, a = p.series[p.symbols[0]], b = p.series[p.symbols[p.symbols.length - 1]]; return Math.hypot(a.x[i] - b.x[i], a.y[i] - b.y[i]); }', range: [0, 40] } },
  rules: { near: { type: 'noul', instructions: 'Is {{dist}} small?', criteria: { yes: 'small', no: 'large' } } },
  weights: { near: 2 },
  output: '(p, m) => { const i = p.t.length - 1, a = p.series[p.symbols[0]], b = p.series[p.symbols[p.symbols.length - 1]]; return [2 * b.x[i] - b.x[i - 1] + m.V * (a.x[i] - b.x[i]), 2 * b.y[i] - b.y[i - 1] + m.V * (a.y[i] - b.y[i])]; }'
};

test('the prompt names no science, no law and no quantity of the world; withheld instruments are not mentioned', () => {
  const full = lawExplorerSystem();
  assert.doesNotMatch(full, GIVEAWAYS, 'giveaway: ' + (full.match(GIVEAWAYS)?.[0] ?? ''));
  assert.doesNotMatch(ORBIT_PERCEPT_DOC, GIVEAWAYS);
  for (const t of LAW_TOOLS) assert.match(full, new RegExp('"' + t + '"'), t + ' is described');
  const none = lawExplorerSystem(new Set<LawTool>());
  for (const t of LAW_TOOLS) assert.doesNotMatch(none, new RegExp('\\{"' + t + '"'), t + ' withheld');
  assert.doesNotMatch(none, /INVESTIGATE before proposing/);
  assert.match(none, /"output"/, 'the task and the model remain');
  assert.doesNotMatch(full, /component|magnitude|log scale|\(p\) => \[x, y\]/i, 'no shape is imposed on the answer');
});

test('a proposal becomes a checked model: weights normalised, output kept, errors reported, beliefs kept', () => {
  const t = parseLawTurn(JSON.stringify({ rationale: 'r', ...draft, beliefs: [{ id: 'b1', stance: 'new', statement: 'closer means larger' }], lessons: ['l'] }), { world: 'orbit@1', round: 2 });
  assert.equal(t.kind, 'proposal');
  if (t.kind !== 'proposal' || !t.parse.ok) throw new Error('not parsed: ' + JSON.stringify(t));
  assert.deepEqual(t.parse.proposal.law.weights, { near: 1 });
  assert.equal(t.parse.proposal.law.output?.source, draft.output);
  assert.equal(t.parse.proposal.beliefs[0].id, 'b1');
  const bad = parseLawTurn(JSON.stringify({ ...draft, output: 3 }), { world: 'orbit@1' });
  assert.ok(bad.kind === 'proposal' && !bad.parse.ok && bad.parse.errors.some((e) => /"output" must be/.test(e)));
  const empty = parseLawTurn(JSON.stringify({ observations: {}, rules: {} }), { world: 'orbit@1' });
  assert.ok(empty.kind === 'proposal' && !empty.parse.ok && empty.parse.errors.some((e) => /needs rules or an output/.test(e)));
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
  assert.deepEqual(t.requests.map((r) => Object.keys(r)[0]), ['act', 'simulate', 'inspect', 'measure', 'table'], 'the earlier names are still accepted');
  assert.deepEqual((t.requests[0] as { act: unknown }).act, { x: 1, y: 2, vx: 0, vy: 0.5, m: 1 });
  assert.equal((t.requests[4] as { on: string }).on, 'checks');
  assert.equal((t.requests[1] as { rows: number }).rows, 40, 'at most 40 rows');
  assert.equal(t.warnings.length, 3);
  assert.equal(t.notes[0].do, 'write');
});

test('only what the explorer wrote travels back, and the payload carries the percept and the budget', () => {
  const t = parseLawTurn(JSON.stringify(draft), { world: 'orbit@1' });
  if (t.kind !== 'proposal' || !t.parse.ok) throw new Error('not parsed');
  const own = ownLaw(t.parse.proposal.law) as { output: string; weights: Record<string, number> };
  assert.equal(own.output, draft.output);
  assert.deepEqual(own.weights, { near: 1 });
  const payload = lawExplorerPayload({ round: 3, perceptDoc: ORBIT_PERCEPT_DOC, law: t.parse.proposal.law, lawRound: 2, stepsLeft: 2, launchesLeft: 5 });
  assert.equal(payload.acts_left, 5);
  assert.equal((payload.your_model as { from_round: number }).from_round, 2);
});

test('a model may be code only (no rules, an output); an ignored request is echoed back so it can be read', () => {
  const t = parseLawTurn(JSON.stringify({ observations: {}, rules: {}, output: draft.output.replaceAll('m.V', '0.5') }), { world: 'orbit@1' });
  if (t.kind !== 'proposal' || !t.parse.ok) throw new Error('not parsed: ' + JSON.stringify(t));
  assert.deepEqual(ownLaw(t.parse.proposal.law), { observations: {}, rules: {}, weights: {}, output: draft.output.replaceAll('m.V', '0.5') });
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

/* Zero hints (SPEC-MUNDO-FISICO I5): the prompt is a persona, a method and the instruments; nothing about the nature of the
   world - not what moves, not what varies between the places the law is checked, not a region it cannot see. */
const NATURE = /\b(famil(y|ies)|bodies|in a plane|region you observe|placed differently|same principle|axes are turned)\b/i;

test('zero hints: the prompt says nothing about what the world is or what varies in it', () => {
  const full = lawExplorerSystem();
  assert.doesNotMatch(full, NATURE, 'hint: ' + (full.match(NATURE)?.[0] ?? ''));
  assert.match(full, /places you have not seen/, 'the protocol is still explained');
});

import { commonPrompt, reflectionTask, TOOLS } from '../src/learn/prompt.ts';
import { EXPLORER_SYSTEM, GRID_INTERFACE } from '../src/learn/explorer.ts';
import { ORBIT_INTERFACE } from '../src/learn/law-explorer.ts';
import { GRID_PERCEPT_DOC } from '../src/worlds/grid/sense.ts';

/* ONE prompt for every world (learn/prompt.ts): each world's prompt is the common text for its instruments, then its
   interface. Nothing about a world is written outside its interface. */
test('one prompt: every world\'s prompt begins with the common text, word for word', () => {
  const grid = commonPrompt(new Set(GRID_INTERFACE.tools), new Set(GRID_INTERFACE.features));
  const orbit = commonPrompt(new Set(ORBIT_INTERFACE.tools), new Set(ORBIT_INTERFACE.features));
  assert.ok(EXPLORER_SYSTEM.startsWith(grid + '\n\nTHIS ENVIRONMENT\'S INTERFACE.'));
  assert.ok(lawExplorerSystem().startsWith(orbit + '\n\nTHIS ENVIRONMENT\'S INTERFACE.'));
  /* With the same instruments and features, the two worlds are told the same thing. */
  const same = new Set(TOOLS);
  assert.equal(commonPrompt(same, new Set(['check'])), commonPrompt(same, new Set(['check'])));
});

/* Zero hints in everything System 2 reads of a world: the prompt, the percept and the reflection task. "game theory" is a
   discipline of the persona, the same in every world. */
const WORLD_WORDS = /\b(games?|players?|turns?|wins?|won|lost|draws?|boards?|pieces?|moves?|bodies|body|launch\w*|positions?|orbit\w*|mass(es)?|forces?|famil(y|ies)|planes?|opponents?|sides?)\b/i;
test('zero hints: no world is named in its own words, in either world', () => {
  for (const [name, text] of [['grid prompt', EXPLORER_SYSTEM], ['orbit prompt', lawExplorerSystem()], ['grid percept', GRID_PERCEPT_DOC],
    ['orbit percept', ORBIT_PERCEPT_DOC], ['reflection', reflectionTask(true)]] as const) {
    const t = text.replaceAll('game theory', '');
    assert.doesNotMatch(t, WORLD_WORDS, name + ': ' + (t.match(WORLD_WORDS)?.[0] ?? ''));
  }
});
