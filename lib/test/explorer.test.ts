import test from 'node:test';
import assert from 'node:assert/strict';
import { Observer } from '../src/core/observer.ts';
import { createPlanner } from '../src/core/truth.ts';
import { replayOnEvidence } from '../src/learn/gates.ts';
import { EXPLORER_SYSTEM, explorerPayload, parseExplorerProposal } from '../src/learn/explorer.ts';
import { labelPositions, noisyOpponent, playEpisode } from '../src/learn/episodes.ts';
import { GRID_PERCEPT_DOC, asciiSense, bFallback, createGridWorld, generateSpec, mulberry32, readPicture, type GridState } from '../src/worlds/grid/index.ts';

/* G4: System 2 as an explorer of a world nobody described. Its answer is text: it becomes a formula and
   probes only through the gates, and nothing about the world travels to it but what the senses render. */

const { spec } = generateSpec(4);
const world = createGridWorld(spec);
const sense = asciiSense(spec);
const SENSES = { picture: { spec: { kind: 'sense', sense: 'ascii' } } } as const;
const observer = new Observer<GridState>(world, { kinds: ['sense', 'code'], senses: { ascii: (s) => sense.render(s) },
  perceive: (_s, p) => readPicture(Object.values(p)[0]) });

const answer = {
  rationale: 'r', hypotheses: ['h'],
  observations: { mine: { definition: 'my pieces', source: '(p) => p.cells.flat().filter((c) => c === p.you).length', range: [0, 20] } },
  rules: { many: { type: 'score', instructions: 'I have {{mine}} pieces. How good?', criteria: ['bad', 'even', 'good'] } },
  weights: { many: 3 },
  probes: [{ id: 'late', hypothesis: 'late is bad', observation: { source: '(p) => p.move', range: [0, 40] } }],
  evidence_ref: { case: 0 }
};

test('a well-formed answer becomes a formula that carries the senses, and probes', () => {
  const parsed = parseExplorerProposal(JSON.stringify(answer), { world: world.id, senses: SENSES, round: 1 });
  assert.ok(parsed.ok, JSON.stringify(parsed));
  if (!parsed.ok) return;
  const f = parsed.proposal.formula;
  assert.deepEqual(Object.keys(f.observations).sort(), ['mine', 'picture']);
  assert.equal(f.weights.many, 1);
  assert.equal(f.rules.many.used_as, 'value');
  assert.equal(parsed.proposal.probes[0].id, 'late');
  const replay = replayOnEvidence(observer, f.observations, [{ state: world.initial() }]);
  assert.deepEqual(replay.errors, [], 'a perception measure replays WITH its senses');
  assert.equal(replay.rows[0].measurements.mine, spec.A.start.length);
});

test('a malformed answer is refused with every reason, never repaired', () => {
  const bad = {
    observations: { Mine: { source: '(p) => 1', range: [0, 1] }, picture: { source: '(p) => 1', range: [0, 1] }, norange: { source: '(p) => 1' } },
    rules: { r: { type: 'vibes', instructions: 'x', criteria: {} }, q: { type: 'noul', instructions: 'reads {{ghost}}', criteria: { yes: 'y', no: 'n' } } },
    probes: [{ id: 'p', hypothesis: 'nothing to test it with' }]
  };
  const parsed = parseExplorerProposal(JSON.stringify(bad), { world: world.id, senses: SENSES });
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  const all = parsed.errors.join('\n');
  for (const reason of [/"Mine" must be lowercase/, /"picture" is taken by a sense/, /norange.*range/, /rule "r".*type/, /undeclared observation\(s\): ghost/, /probe p: needs an observation or a question/]) {
    assert.match(all, reason);
  }
  assert.deepEqual(parseExplorerProposal('not json', { world: world.id, senses: SENSES }), { ok: false, errors: ['the answer was not a JSON object'] });
});

test('the explorer is told nothing about the world: the payload is pictures, results and its own words', async () => {
  const planner = createPlanner(world, 'B', 2, { fallback: bFallback(spec) });
  const rnd = mulberry32(1);
  const ep = await playEpisode(world, (s, actor) => actor === 'B' ? planner.respond(s) : world.actions(s)[Math.floor(rnd() * world.actions(s).length)]);
  const parsed = parseExplorerProposal(JSON.stringify(answer), { world: world.id, senses: SENSES });
  assert.ok(parsed.ok);
  const payload = explorerPayload({
    round: 2, perceptDoc: GRID_PERCEPT_DOC, formula: parsed.ok ? parsed.proposal.formula : null,
    experience: [{ id: 'e0', how: 'exploration', result: 'lost', frames: ep.states.map((s) => sense.render(s)) }]
  });
  const text = (JSON.stringify(payload) + EXPLORER_SYSTEM).toLowerCase();
  for (const word of [spec.winA, spec.winB, 'grid@1', world.id.toLowerCase(), 'legal', 'fox', 'hound', 'cat', 'mouse']) {
    assert.ok(!text.includes(word), 'the payload must not say "' + word + '"');
  }
  const own = (payload as any).your_current_formula;
  assert.deepEqual(Object.keys(own.observations), ['mine'], 'the sense is the host\'s, not echoed as the explorer\'s code');
  assert.equal((payload as any).experience[0].frames[0], sense.render(world.initial()));
});

test('episodes: a noisy opponent replays exactly per seed, and positions are labelled by the truth', async () => {
  const planner = createPlanner(world, 'B', 2, { fallback: bFallback(spec) });
  const play = async (seed: number) => {
    const rnd = mulberry32(seed);
    const opponent = noisyOpponent(world, (s) => planner.respond(s), 0.5, rnd);
    return playEpisode(world, (s, actor) => actor === 'B' ? opponent(s) : world.actions(s)[0]);
  };
  const [a, b] = [await play(3), await play(3)];
  assert.deepEqual(a.states.map(world.key), b.states.map(world.key));
  const labelled = labelPositions(world, a.states, 'A', (s) => planner.respond(s), { budget: 60000 });
  assert.ok(labelled.length > 0);
  assert.ok(labelled.every((p) => world.toMove(p.state) === 'A' && (p.label === 'win' || p.label === 'loss')));
  assert.equal(labelled[0].label, 'win', 'the start is a forced win for A (the generator guarantees it)');
});
