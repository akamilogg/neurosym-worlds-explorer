import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFormula } from '../src/core/formula.ts';
import { Notebook, type EpisodeRecord } from '../src/learn/notebook.ts';
import { explorerPayload, parseExplorerProposal } from '../src/learn/explorer.ts';

/* The lab notebook: what the explorer carries from one hypothesis to the next. Its beliefs with their history,
   the lineage of formulas with every result, its own lessons verbatim, and curated experience. */

const SENSES = { picture: { spec: { kind: 'sense', sense: 'ascii' } } } as const;
const formula = (rules: Record<string, string>) => makeFormula({
  world: 'w', observations: { ...SENSES, x: { definition: 'a fact', spec: { kind: 'code', lang: 'js', source: '(p) => 1' }, range: [0, 1] } },
  rules: Object.fromEntries(Object.entries(rules).map(([id, text]) => [id, { type: 'noul' as const, used_as: 'value' as const, instructions: text + ' {{x}}', criteria: { yes: 'y', no: 'n' } }])),
  weights: Object.fromEntries(Object.keys(rules).map((id) => [id, 1 / Object.keys(rules).length]))
});

test('beliefs: every one held needs a stance each round; the history keeps why it changed', () => {
  const nb = new Notebook();
  assert.deepEqual(nb.applyStances(1, [
    { id: 'edge', stance: 'new', statement: 'the other side wins at the right edge' },
    { id: 'near', stance: 'new', statement: 'staying close helps' }
  ]), { warnings: [], unaddressed: [] });
  const r2 = nb.applyStances(2, [
    { id: 'edge', stance: 'confirm', why: 'final positions', evidence: ['probe edge_final'] },
    { id: 'ghost', stance: 'keep' },
    { id: 'edge2', stance: 'new' }
  ]);
  assert.deepEqual(r2.unaddressed, ['near'], 'a belief held and not addressed is reported back');
  assert.equal(r2.warnings.length, 2);
  nb.applyStances(3, [{ id: 'near', stance: 'drop', why: 'probe inverted' }, { id: 'edge', stance: 'revise', statement: 'it wins on reaching the right column' }]);
  const brief = nb.brief() as any;
  assert.deepEqual(brief.beliefs_held.map((b: any) => [b.id, b.status]), [['edge', 'held']]);
  assert.match(brief.beliefs_held[0].statement, /right column/);
  assert.deepEqual(brief.beliefs_dropped, [{ id: 'near', statement: 'staying close helps', why: 'probe inverted' }]);
  assert.equal(brief.beliefs_held[0].history.length, 3);
  assert.match(brief.beliefs_held[0].history[1], /round 2: confirm - final positions \[probe edge_final\]/);
});

test('rounds: the lineage says what changed and how it went, and the lessons travel back verbatim', () => {
  const nb = new Notebook();
  nb.recordRound(1, formula({ a: 'A?' }), ['edges matter'], 'test the edge');
  nb.recordTrial(1, { level: 2, wins: 0, total: 4, results: ['loss', 'loss', 'loss', 'loss'], held_win_turns: [1, 2, 0, 1], action_accuracy: 0.2 });
  nb.recordCodeOnly(1, 3, 4);
  nb.recordRound(2, formula({ a: 'A?', b: 'B?' }), ['blocking helps'], 'test blocking');
  const brief = nb.brief() as any;
  assert.equal(brief.rounds.length, 2);
  assert.equal(brief.rounds[0].observations_alone_won, '3 of 4');
  assert.deepEqual(brief.rounds[0].games[0].turns_still_winning, [1, 2, 0, 1]);
  assert.deepEqual(brief.rounds[1].changes, { added: ['rule b'], removed: [], reweighted: ['a'] });
  assert.deepEqual(brief.your_last_lessons, ['blocking helps']);
  assert.equal(brief.your_planned_next_experiment, 'test blocking');
  assert.ok(!('picture' in brief.rounds[0].formula.observations), 'the sense is the host\'s, not part of the explorer\'s lineage');
});

test('memory is curated: every win, the critical moments, the best loss - not a sliding window', () => {
  const nb = new Notebook();
  const game = (id: string, round: number, result: EpisodeRecord['result'], critical: number | null, held: number | null, ownPlay = true): EpisodeRecord =>
    ({ id, round, how: 'h', result, frames: ['f0', 'f1', 'f2', 'f3', 'f4'], critical, heldWinTurns: held, ownPlay });
  nb.addEpisodes([game('e0', 0, 'lost', null, null, false), game('e1', 0, 'lost', null, null, false)]);
  const first = nb.memory() as any;
  assert.equal(first.latest_games.length, 2);
  assert.ok(first.latest_games[0].frames, 'before any trial the exploration games are shown whole');
  nb.addEpisodes([game('r1g0', 1, 'won', null, 2), game('r1g1', 1, 'lost', 2, 1), game('r1g2', 1, 'lost', 1, 0)]);
  for (let r = 2; r <= 9; r++) nb.addEpisodes([game('r' + r + 'g0', r, 'lost', 3, 1)]);
  nb.addEpisodes([game('r10g0', 10, 'lost', 3, 2), game('r10g1', 10, 'lost', null, 0)]);
  const m = nb.memory() as any;
  assert.deepEqual(m.wins.map((w: any) => w.case), ['r1g0'], 'the win from round 1 is still there at round 10');
  assert.equal(m.critical_moments.length, 6);
  assert.deepEqual(m.critical_moments[0], { case: 'r5g0', turn: 3, before_your_move: 'f3', after_your_move: 'f4',
    note: 'before this move your position could still be won; after it, it could not' });
  assert.deepEqual(m.best_losses.map((b: any) => b.case), ['r10g0']);
  assert.deepEqual(m.latest_games.map((g: any) => g.case), ['r10g1']);
  assert.deepEqual(m.latest_games[0].key_frames.map((k: any) => k.turn), [0, 4], 'the latest games travel as key frames');
});

test('the explorer answers with stances, lessons and a next experiment; the payload carries the notebook', () => {
  const answer = {
    rationale: 'r',
    beliefs: [{ id: 'edge', stance: 'new', statement: 's', evidence: 'case r1g0' }, { id: 'Bad', stance: 'new' }, { id: 'x', stance: 'maybe' }],
    observations: { x: { source: '(p) => 1', range: [0, 1] } },
    rules: { a: { type: 'noul', instructions: 'A {{x}}?', criteria: { yes: 'y', no: 'n' } } },
    weights: { a: 1 }, lessons: ['l1', 7], next_experiment: 'n'
  };
  const parsed = parseExplorerProposal(JSON.stringify(answer), { world: 'w', senses: SENSES, round: 2 });
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.proposal.beliefs, [{ id: 'edge', stance: 'new', statement: 's', evidence: ['case r1g0'] }]);
  assert.equal(parsed.proposal.warnings.filter((w) => /belief/.test(w)).length, 2, 'malformed stances are reported, not fatal');
  assert.deepEqual(parsed.proposal.lessons, ['l1']);
  assert.equal(parsed.proposal.nextExperiment, 'n');
  const legacy = parseExplorerProposal(JSON.stringify({ ...answer, beliefs: undefined, hypotheses: ['old style'] }), { world: 'w', senses: SENSES, round: 3 });
  assert.ok(legacy.ok && legacy.proposal.beliefs[0].id === 'r3_h1' && legacy.proposal.beliefs[0].stance === 'new');
  const nb = new Notebook();
  nb.applyStances(2, parsed.proposal.beliefs);
  nb.recordRound(2, parsed.proposal.formula, parsed.proposal.lessons, parsed.proposal.nextExperiment);
  const payload = explorerPayload({ round: 3, perceptDoc: 'doc', notebook: nb.brief(['edge']), experience: nb.memory(), formula: parsed.proposal.formula, formulaRound: 2 }) as any;
  assert.deepEqual(payload.notebook.you_took_no_stance_on, ['edge']);
  assert.equal(payload.your_best_formula.from_round, 2);
  assert.deepEqual(Object.keys(payload.experience), ['wins', 'critical_moments', 'best_losses', 'latest_games', 'total_games_played']);
});
