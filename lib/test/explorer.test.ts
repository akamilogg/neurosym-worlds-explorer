import test from 'node:test';
import assert from 'node:assert/strict';
import { Observer } from '../src/core/observer.ts';
import { createPlanner } from '../src/core/truth.ts';
import { replayOnEvidence } from '../src/learn/gates.ts';
import { EXPLORER_SYSTEM, explorerPayload, parseExplorerProposal, parseExplorerTurn } from '../src/learn/explorer.ts';
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

test('the explorer is told nothing about the world: the payload is its notebook, its own words and what it asked for', async () => {
  const parsed = parseExplorerProposal(JSON.stringify(answer), { world: world.id, senses: SENSES });
  assert.ok(parsed.ok);
  const { Notebook } = await import('../src/learn/notebook.ts');
  const nb = new Notebook();
  nb.addGames([{ id: 'g1', round: 0, how: 'exploration: your side moved at random', result: 'lost', turns: 12 }]);
  const payload = explorerPayload({
    round: 2, perceptDoc: GRID_PERCEPT_DOC, formula: parsed.ok ? parsed.proposal.formula : null, notebook: nb.brief(),
    investigation: [{ step: 1, results: [{ view: 'g1', frames: [{ turn: 0, picture: sense.render(world.initial()) }] }] }], stepsLeft: 2
  });
  const text = (JSON.stringify(payload) + EXPLORER_SYSTEM).toLowerCase();
  for (const word of [spec.winA, spec.winB, 'grid@1', world.id.toLowerCase(), 'legal', 'fox', 'hound', 'cat', 'mouse']) {
    assert.ok(!text.includes(word), 'the payload must not say "' + word + '"');
  }
  const own = (payload as any).your_best_formula;
  assert.deepEqual(Object.keys(own.observations), ['mine'], 'the sense is the host\'s, not echoed as the explorer\'s code');
  assert.equal((payload as any).investigation[0].results[0].frames[0].picture, sense.render(world.initial()));
  assert.equal((payload as any).steps_left, 2);
  assert.ok(!('experience' in payload), 'nothing is curated for it: it asks');
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

test('ablation: the same observations read linearly, no Judge - the sign is fitted on labelled positions', async () => {
  const { fitCodeOnly, codeOnlyFormula, codeOnlyJudge, CODE_ONLY_RULE } = await import('../src/learn/ablation.ts');
  const { Evaluator } = await import('../src/core/evaluate.ts');
  const clock = { spec: { kind: 'code', lang: 'js', source: '(p) => p.move' }, range: [0, 40] } as const;
  const f = parseExplorerProposal(JSON.stringify({ ...answer, observations: { ...answer.observations, clock: { source: clock.spec.source, range: [0, 40] } },
    rules: { r: { type: 'noul', instructions: '{{mine}} {{clock}}', criteria: { yes: 'y', no: 'n' } } }, weights: { r: 1 }, probes: [] }),
  { world: world.id, senses: SENSES });
  assert.ok(f.ok);
  if (!f.ok) return;
  const ep = await playEpisode(world, (s) => world.actions(s)[0]);
  /* Early positions labelled won, late ones lost: "later is worse" must come out as a negative clock weight. */
  const states = ep.states.filter((s) => world.toMove(s) === 'A' && !world.outcome(s).over);
  const labelled = states.map((state, i) => ({ state, label: (i < states.length / 2 ? 'win' : 'loss') as 'win' | 'loss' }));
  const fit = fitCodeOnly(observer, f.proposal.formula, labelled);
  assert.ok(fit.weights.clock < 0, JSON.stringify(fit));
  assert.equal(fit.weights.mine, 0, 'a constant observation separates nothing');
  const ev = new Evaluator<GridState>(observer, codeOnlyJudge(fit), { maximizer: 'A' });
  const early = await ev.eval(codeOnlyFormula(f.proposal.formula), labelled[0].state);
  const late = await ev.eval(codeOnlyFormula(f.proposal.formula), labelled[labelled.length - 1].state);
  assert.ok(early.value > late.value);
  assert.ok(early.answers[CODE_ONLY_RULE]);
});

test('what System 2 reads never carries the operator measurements, nor counts choices', () => {
  const probe = { id: 'p', hypothesis: 'h', round: 1, status: 'supported' as const, errors: [], tested_by: 'observation' as const, positions: 'siblings' as const,
    samples_win: 23, samples_loss: 51, mean_when_win: 0.6, mean_when_loss: 0.4, separation: 0.2, auc: 0.8,
    tests: [{ by: 'observation' as const, positions: 'siblings' as const, sets: 12, samples_win: 23, samples_loss: 51, mean_when_win: 0.6, mean_when_loss: 0.4, auc: 0.8, margin: 0.2, status: 'supported' as const }] };
  const payload = explorerPayload({ round: 2, perceptDoc: GRID_PERCEPT_DOC, hypotheses: [probe] }) as any;
  const text = JSON.stringify(payload);
  assert.deepEqual(payload.probes_reported[0].tests[0].samples, { positions_compared: 12 });
  assert.ok(!text.includes('23') && !text.includes('51'), 'the number of choices is never shown');
  assert.ok(!/informed|ceiling|tightness|operator|still winning|critical|kept the win/i.test(text + EXPLORER_SYSTEM));
});

test('an answer is either an investigation or a proposal; notes ride on both', () => {
  const inv = parseExplorerTurn(JSON.stringify({
    investigate: [{ view: 'g1', from: 2, to: 90 }, { inspect: 'g2@4' }, { measure: { source: '(p) => 1', range: [0, 1] }, on: ['g1@0'] }, { guess: 'x' }],
    notes: [{ do: 'write', id: 'n1', text: 't', positions: ['g1@0'] }, { do: 'shout', id: 'n2' }]
  }), { world: world.id, senses: SENSES });
  assert.equal(inv.kind, 'investigate');
  if (inv.kind !== 'investigate') return;
  assert.deepEqual(inv.requests[0], { view: 'g1', from: 2, to: 31 }, 'at most 30 frames per request');
  assert.equal(inv.requests.length, 3);
  assert.equal(inv.notes.length, 1);
  assert.equal(inv.warnings.length, 2);
  const prop = parseExplorerTurn(JSON.stringify({ ...answer, notes: [{ do: 'forget', id: 'n1' }] }), { world: world.id, senses: SENSES });
  assert.ok(prop.kind === 'proposal' && prop.parse.ok && prop.notes[0].do === 'forget');
});
