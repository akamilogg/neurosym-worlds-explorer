import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { linksOf, shownBy, tableRows } from '../src/audit/links.ts';
import { checkFact, pointsOf, recordedPoints } from '../src/audit/facts.ts';
import { EXTRACT_SYSTEM, extractClaims, factMeasures } from '../src/audit/extract.ts';
import { auditMethod } from '../src/audit/audit.ts';
import type { ChatClient } from '../src/learn/system2.ts';
import type { Judge, JudgeRequest } from '../src/core/types.ts';

/* SPEC-AUDITORIA-METODO MA2: what each text claims, structured by an LLM, and the facts among them (O6) checked - the same
   for every world: code gathers what was shown at the points a fact cites, read by the answers' form, and the Judge says
   whether that supports it. The senior's "leap" of g76@6-7 was an ordinary step. */

const picture = (step: number, eq: string) => ['    0 1 2 3', ...[0, 1, 2, 3].map((r) => ' ' + r + '  ' + [0, 1, 2, 3].map((c) => (r + ',' + c === eq ? '=' : '.')).join(' ')), 'step ' + step].join('\n');

function journal() {
  return {
    experiment: 'unknown-world@1', researcher: 'assisted', config: { seed: 22, llm_model: 'researcher-model' },
    hidden_from_the_learner: { truth: [{ id: 'moves', statement: 'SECRET-TRUTH' }] },
    events: [
      { type: 'exploration_game', game: 'g1', winner: 'B', plies: 2, frames: [{ step: 0, picture: 'SECRET-UNSEEN-FRAME' }] },
      { type: 'investigation', round: 1, requests: [{ view: 'g1', from: 0, to: 1 }], results: [{ view: 'g1', frames: [{ step: 0, picture: picture(0, '2,1') }, { step: 1, picture: picture(1, '1,2') }] }] },
      { type: 'proposal', round: 1, rationale: 'In g1@0-1 the = moved from (2,1) to (1,2): a diagonal step.', beliefs: [{ id: 'diag', stance: 'new', statement: '= moves diagonally', evidence: ['g1@0', 'g1@1'] }] },
      { type: 'operator_message', question: 3, messages: [{ id: 'm1', by: 'agent:senior', text: 'Hypothesis: = can leap. In g1@0-1 it moves from (2,1) to (1,3).' }] },
      { type: 'proposal', round: 2, rationale: 'In g9@4 the = was at (0,0).', beliefs: [{ id: 'diag', stance: 'keep' }] },
      { type: 'end', stoppedBy: 'budget' }
    ]
  };
}

test('what an answer showed is read by its form, the same for every world', () => {
  /* frames, messages (items with a step), rows of a table answer (items with a point), a text table, an inspect. */
  assert.deepEqual(shownBy({ view: 'g1', from: 0 }, 'view', { frames: [{ step: 3, picture: 'P' }] }), [['g1@3', 'P']]);
  assert.deepEqual(shownBy({ view: 'ep2', from: 0 }, 'view', { messages: [{ step: 0, text: 'hello', mark: 1 }] }), [['ep2@0', 'hello']]);
  assert.deepEqual(shownBy({ table: '(p) => 1', on: 'final' }, 'table', { rows: [{ point: 'g2@26', value: 'V' }] }), [['g2@26', 'V']]);
  assert.deepEqual(shownBy({ view: 'ep1', from: 4 }, 'view', { table: '  t  x\n  4  1.0\n  5  2.0' }), [['ep1@4', '  4  1.0'], ['ep1@5', '  5  2.0']]);
  assert.deepEqual(shownBy({ view: 'ep3', from: 2 }, 'view', { rows: ['..#', '.##'] }), [['ep3@2', '..#'], ['ep3@3', '.##']]);
  assert.equal(shownBy({ inspect: 'g4@5' }, 'inspect', { chose: 'x', your_search_value: 0.4 })[0][0], 'g4@5');
  assert.deepEqual(pointsOf('g1@0-2'), ['g1@0', 'g1@1', 'g1@2']);
  /* A picture whose header is a ruler of numbers is not a table: its rows are not steps. */
  assert.deepEqual(tableRows(picture(0, '2,1')), []);
  const act = linksOf({ events: [{ type: 'investigation', round: 1, requests: [{ act: 'g1@0' }], results: [{ act: 'g1@0', accepted: true, name: 'act1', picture: picture(1, '1,2') }] }] }).links[0];
  assert.deepEqual(Object.keys(act.shown), ['act1'], 'the position an act made, whole');
});

/** A Judge stand-in: a claim that names a cell no picture it is shown has '=' at is contradicted; it keeps what it was shown. */
function judge(shown: JudgeRequest[]): Judge {
  return { id: 'jev:stand-in', async judge(request) {
    shown.push(request);
    const claim = String(request.texts?.claim ?? ''), seen = String(request.texts?.shown ?? '');
    const contradicted = /\(1,3\)/.test(claim) && !/ 1 {2}\. \. \. =/.test(seen);
    const probabilities = contradicted ? { supported: 0.1, contradicted: 0.85, cannot_tell: 0.05 } : { supported: 0.8, contradicted: 0.1, cannot_tell: 0.1 };
    return { fact: { value: probabilities.supported, confidence: 0.8, raw: { type: 'choice', probabilities } } };
  } };
}

test('a fact is checked against what was shown at its points: by the Judge; unverifiable when nothing was shown or no Judge', async () => {
  const recorded = recordedPoints(linksOf(journal()));
  assert.ok(!recorded.get('g1@0')!.includes('SECRET'), 'what the researcher was shown, not the operator\'s record');
  const asked: JudgeRequest[] = [];
  const leap = await checkFact('in g1@0-1 = moves from (2,1) to (1,3)', ['g1@0-1'], recorded, judge(asked));
  assert.deepEqual([leap.status, leap.points], ['false', ['g1@0', 'g1@1']]);
  assert.match(String(asked[0].texts?.shown), /g1@1:\n {4}0 1 2 3/, 'the Judge reads the pictures themselves');
  assert.equal(asked[0].rulesOfTheWorld, '', 'the neutral contract');
  assert.equal((await checkFact('= moved from (2,1) to (1,2)', ['g1@0-1'], recorded, judge([]))).status, 'true');
  assert.match((await checkFact('= was at (0,0)', ['g9@4'], recorded, judge([]))).detail, /nothing was recorded as shown at g9@4/);
  assert.match((await checkFact('= moved', ['g1@0'], recorded, null)).detail, /not judged/);
});

/** An extractor stand-in: it writes down what each text claims. */
function extractor(shown: unknown[]): ChatClient {
  return { async complete({ system, user }) {
    assert.equal(system, EXTRACT_SYSTEM);
    shown.push(user);
    const text = String((user as { text: string }).text);
    const claims = /leap/.test(text) ? [{ text: '= can leap', kind: 'hypothesis', cites: [] }, { text: 'in g1@0-1 = moves from (2,1) to (1,3)', kind: 'fact', cites: ['g1@0-1'] }]
      : /g9@4/.test(text) ? [{ text: 'the = was at (0,0) in g9@4', kind: 'fact', cites: ['g9@4'] }]
      : [{ text: '= moved from (2,1) to (1,2)', kind: 'fact', cites: ['g1@0-1'] }, { text: '= moves diagonally', kind: 'hypothesis', cites: ['g1@0', 'g1@1'] }];
    return { content: JSON.stringify({ claims }), raw: {} } as never;
  } };
}

test('the extractor structures each text, the researcher\'s and the operator\'s; the facts are checked; the audit keeps them', async () => {
  const j = journal();
  const shown: unknown[] = [];
  const sources = await extractClaims(j, linksOf(j), extractor(shown), judge([]));
  assert.deepEqual(sources.map((s) => [s.id, s.author]), [['r1', 'researcher'], ['message:3', 'operator'], ['r2', 'researcher']]);
  assert.deepEqual(sources.flatMap((s) => s.claims.map((c) => c.check?.status ?? c.kind)), ['true', 'hypothesis', 'hypothesis', 'false', 'unverifiable']);
  assert.ok((shown[0] as { shown: Record<string, string> }).shown['g1@1'].includes('='), 'the extractor is shown what was shown at the points cited');
  assert.ok(!/SECRET/.test(JSON.stringify(shown)));
  const m = factMeasures(sources);
  assert.deepEqual(m.by_kind, { fact: 3, hypothesis: 2, sample_pattern: 0 });
  assert.deepEqual([m.facts.checked, m.facts.true, m.facts.false, m.facts.unverifiable, m.facts.accuracy], [3, 1, 1, 1, 0.5]);
  assert.deepEqual([m.facts_of_the_operator.false, m.facts_of_the_researcher.false], [1, 0]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-claims-'));
  const file = path.join(dir, 'run.json');
  fs.writeFileSync(file, JSON.stringify(j));
  const a = await auditMethod(file, judge([]) as Judge & { id: string }, { llm: extractor([]), model: 'researcher-model' });
  assert.equal(a.extracted!.same_model_as_researcher, true, 'it says when the extractor is the researcher\'s own model');
  assert.equal(a.measures.claims!.facts.false, 1);
  assert.equal((await auditMethod(file, null)).extracted, null);
});
