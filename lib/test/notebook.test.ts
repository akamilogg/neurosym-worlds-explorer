import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFormula } from '../src/core/formula.ts';
import { Notebook } from '../src/learn/notebook.ts';
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

test('rounds: the lineage says what changed and how its games went, and the lessons travel back verbatim', () => {
  const nb = new Notebook();
  nb.recordRound(1, formula({ a: 'A?' }), ['edges matter'], 'test the edge');
  nb.recordGames(1, ['lost', 'won', 'lost', 'draw']);
  nb.recordRound(2, formula({ a: 'A?', b: 'B?' }), ['blocking helps'], 'test blocking');
  const brief = nb.brief() as any;
  assert.equal(brief.rounds.length, 2);
  assert.deepEqual(brief.rounds[0].games, [{ results: ['lost', 'won', 'lost', 'draw'], wins: 1, of: 4 }]);
  assert.deepEqual(brief.rounds[1].changes, { added: ['rule b'], removed: [], reweighted: ['a'] });
  assert.deepEqual(brief.your_last_lessons, ['blocking helps']);
  assert.equal(brief.your_planned_next_experiment, 'test blocking');
  assert.ok(!('picture' in brief.rounds[0].formula.observations), 'the sense is the host own, not part of the explorer lineage');
});

test('notes belong to the explorer: it writes, rewrites and forgets them; positions must exist in its own games', () => {
  const nb = new Notebook();
  nb.addGames([{ id: 'g1', round: 0, how: 'exploration: at random', result: 'lost', turns: 9 }]);
  const exists = (ref: string) => /^g1@[0-9]$/.test(ref);
  assert.deepEqual(nb.applyNotes(1, [{ do: 'write', id: 'edge', text: 'it ran to the edge', positions: ['g1@8', 'g7@1'] }], exists), ['note "edge": no position "g7@1"']);
  nb.applyNotes(2, [{ do: 'write', id: 'edge', text: 'it ran to the right edge', positions: ['g1@9'] }, { do: 'write', id: 'Bad', text: 'x' }], exists);
  let brief = nb.brief() as any;
  assert.deepEqual(brief.notes, [{ id: 'edge', text: 'it ran to the right edge', positions: ['g1@9'], written_round: 1, updated_round: 2 }]);
  assert.deepEqual(brief.games, [{ game: 'g1', round: 0, moves_chosen_by: 'exploration: at random', result: 'lost', turns: 9 }]);
  assert.deepEqual(nb.applyNotes(3, [{ do: 'forget', id: 'edge' }, { do: 'forget', id: 'ghost' }], exists), ['note "ghost" does not exist']);
  brief = nb.brief() as any;
  assert.deepEqual(brief.notes, []);
  assert.ok(!('experience' in brief), 'nothing is curated for the explorer');
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
  const payload = explorerPayload({ round: 3, perceptDoc: 'doc', notebook: nb.brief(['edge']), formula: parsed.proposal.formula, formulaRound: 2 }) as any;
  assert.deepEqual(payload.notebook.you_took_no_stance_on, ['edge']);
  assert.equal(payload.your_best_formula.from_round, 2);
});
