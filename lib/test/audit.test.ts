import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { linksOf } from '../src/audit/links.ts';
import { linkTexts, roundTexts } from '../src/audit/judge.ts';
import { auditMethod } from '../src/audit/audit.ts';
import { labCli } from '../src/runtime/cli.ts';
import { findingOf, findingView } from '../src/learn/finding.ts';
import type { Judge, JudgeRequest } from '../src/core/types.ts';

/* SPEC-AUDITORIA-METODO: the method audit of a finished run - its links, what code observes of them (O1-O5), the Judge's
   closed answers (J1-J6) - beside the outcome, never combined with it, and never reaching a researcher. */

const frames = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => ({ step: from + i, picture: 'board ' + (from + i) }));

/** A finished run with the reference cases sown in (SPEC §7), and secrets only the operator holds. */
function journal() {
  return {
    experiment: 'unknown-world@1', researcher: 'assisted', config: { seed: 22, llm_model: 'model-x' },
    hidden_from_the_learner: { truth: [{ id: 'moves', statement: 'SECRET-TRUTH' }] },
    events: [
      { type: 'exploration_game', game: 'g1', winner: 'B', plies: 8 },
      { type: 'exploration_game', game: 'g2', winner: null, plies: 26 },
      { type: 'investigation', round: 1, requests: [{ view: 'g1', from: 0, to: 3 }], results: [{ view: 'g1', score: -1, steps: 8, frames: frames(0, 3) }] },
      /* Two acts from the same point (a comparison); the world refuses one of them. */
      { type: 'investigation', round: 1, requests: [{ act: 'g1@0', from: [0, 4], to: [1, 4] }, { act: 'g1@0', from: [0, 4], to: [2, 4] }],
        results: [{ act: 'g1@0', accepted: true, name: 'act1', picture: 'after', episode_ended: false }, { act: 'g1@0', accepted: false }] },
      /* A look nobody cites after. */
      { type: 'investigation', round: 1, requests: [{ view: 'g2', from: 0, to: 1 }], results: [{ view: 'g2', score: 0, steps: 26, frames: frames(0, 1) }] },
      { type: 'proposal', round: 1, rationale: 'In round 1 investigation step 2 the one-cell move was accepted and the two-cell move refused.',
        beliefs: [{ id: 'moves', stance: 'new', statement: 'pieces move one cell', why: 'the paired acts', evidence: ['g1@0', 'g1@3', 'g9@2', 'g2@5'] }] },
      { type: 'check', round: 1, laboratories: [{ place: 'lab1', holds: false, wins: 3, total: 8 }], operator_analysis: { surprises: 'SECRET-ANALYSIS' } },
      { type: 'operator_message', question: 5, messages: [{ id: 'm1', text: 'Hypothesis: the other piece can jump; replay from g1@0 to see.', by: 'agent:senior' }] },
      /* A replay set against the episode it starts from, and the same replay made twice (a replication). */
      { type: 'investigation', round: 2, requests: [{ replay: 'g1@0', formula: 1 }], results: [{ replay: 'g1@0', with: 'your model of round 1', episode: 'g3', score: 1, steps: 6 }] },
      { type: 'investigation', round: 2, requests: [{ replay: 'g2@4', formula: 1 }, { replay: 'g2@4', formula: 1 }],
        results: [{ replay: 'g2@4', episode: 'g4', score: 0, steps: 22 }, { replay: 'g2@4', episode: 'g5', score: 1, steps: 9 }] },
      { type: 'proposal', round: 2, rationale: 'The replays g3 and g4–g6 show the model can win from those starts; no jump was seen.',
        beliefs: [{ id: 'moves', stance: 'revise', statement: 'pieces move one cell, diagonally too', why: 'g3', evidence: ['g3@2'] }] },
      { type: 'check', round: 2, laboratories: [{ place: 'lab1', holds: true, wins: 8, total: 8 }], accepted: true },
      { type: 'operator_rule_recovery', score: 0.5, grades: [{ id: 'moves', grade: 'partial', evidence: 'SECRET-GRADE' }] },
      { type: 'end', stoppedBy: 'accepted' }
    ]
  };
}

test('what code observes: comparisons, refusals and what cited them, citations to nothing or to what was never shown, orphans', () => {
  const r = linksOf(journal());
  assert.deepEqual(r.links.map((l) => [l.id, l.kind]), [['r1.s1', 'observation'], ['r1.s2', 'experiment'], ['r1.s3', 'observation'], ['r2.s1', 'experiment'], ['r2.s2', 'experiment']]);
  assert.deepEqual(r.refused.map((x) => [x.link, x.cited_after.length]), [['r1.s2', 1]], 'the refused act, cited by step in round 1');
  const status = Object.fromEntries(r.citations.map((c) => [c.ref, c.status]));
  assert.equal(status['g1@3'], 'seen');
  assert.equal(status['g9@2'], 'missing', 'an episode it never had');
  assert.equal(status['g2@5'], 'unseen', 'a point of an episode it had, never shown to it');
  assert.equal(status['round 1 investigation step 2'], 'seen');
  assert.deepEqual(r.orphans, ['r1.s3']);
  assert.deepEqual(r.controls.map((g) => [g.kind, g.point, g.used]).sort((x, y) => order(x) - order(y)), [['paired', 'g1@0', true], ['replicated', 'g2@4', true], ['against_recorded', 'g1@0', true]]);
  assert.equal(status['g3@2'], 'unseen', 'an episode its replay made, cited at a step it never looked at');
  assert.deepEqual(r.beliefs[0].stances, [{ round: 1, stance: 'new' }, { round: 2, stance: 'revise' }]);
  const replay = r.links.find((l) => l.id === 'r2.s1')!;
  assert.match(replay.before.operator_message ?? '', /can jump/, 'the operator\'s message it had not answered yet');
  assert.ok(replay.after?.cites_this.includes('g3'), 'a bare episode it made is a citation');
  assert.ok(r.links.find((l) => l.id === 'r2.s2')!.after?.cites_this.some((c) => /g4–g6/.test(c)), 'and so is a range');
});
const order = (g: (string | boolean)[]) => ['paired', 'replicated', 'against_recorded'].indexOf(String(g[0]));

/** A Judge stand-in: the first option of every question, most likely; what it was shown is kept. */
function standIn(shown: JudgeRequest[]): Judge {
  return { id: 'jev:stand-in', async judge(request) {
    shown.push(request);
    return Object.fromEntries(Object.entries(request.questions).map(([id, rule]) => {
      const options = Object.keys(rule.criteria as Record<string, string>);
      const probabilities = Object.fromEntries(options.map((o, i) => [o, i === 0 ? 0.7 : 0.3 / (options.length - 1)]));
      return [id, { value: 0.7, confidence: 0.8, raw: { type: 'choice', probabilities } }];
    }));
  } };
}

test('the audit: J1-J4 for each experiment, J5-J6 for each round; measures beside the outcome; nothing hidden reaches the Judge', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
  const file = path.join(dir, 'run.json');
  fs.writeFileSync(file, JSON.stringify(journal()));
  const shown: JudgeRequest[] = [];
  const a = await auditMethod(file, standIn(shown));
  assert.equal(a.format, 'method_audit@1');
  assert.equal(a.judged!.calls, 6, 'three experiment links, the observation cited after, and two stretches');
  assert.deepEqual(Object.keys(a.judged!.observations), ['r1.s1']);
  assert.deepEqual(Object.keys(a.judged!.rounds).sort(), ['r1', 'r2']);
  assert.deepEqual(Object.keys(a.judged!.links).sort(), ['r1.s2', 'r2.s1', 'r2.s2']);
  assert.equal(a.judged!.links['r1.s2'].reading!.answer, 'correct');
  assert.equal(a.judged!.links['r1.s2'].reading!.p, 0.7);
  assert.equal(a.measures.judged!.complete_chains, 1);
  assert.deepEqual(a.measures.citations, { total: 6, seen: 3, unseen: 2, missing: 1, accuracy: 0.5 });
  assert.deepEqual([a.measures.controls.paired, a.measures.controls.replicated, a.measures.controls.against_recorded], [1, 1, 1]);
  /* The outcome, beside it: as the run reported it, not combined into one mark. */
  assert.deepEqual(a.outcome.checks.map((c: any) => c.scored_1 + '/' + c.of), ['3/8', '8/8']);
  assert.equal(a.outcome.rule_recovery, 0.5);
  assert.ok(!('score' in a.measures), 'no combined mark');
  /* M2: the Judge reads what the researcher had, never the truth, the operator's measures or grades. */
  assert.ok(!/SECRET/.test(JSON.stringify(shown)));
  assert.ok(shown.every((r) => r.rulesOfTheWorld === ''), 'the neutral contract');
  assert.ok(shown.some((r) => /can jump/.test(r.texts?.operator_message ?? '')), 'the operator\'s message is part of what it held');
  /* M1: the operator's finding links it; the researcher's view never does. */
  const operator = JSON.parse(fs.readFileSync(path.join(dir, 'run.finding.json'), 'utf8'));
  assert.equal(operator.operator.method_audit.file, 'run.method.json');
  assert.ok(!('operator' in findingView(findingOf(journal(), { method: { file: 'x', judge: null, measures: {} } }), 'researcher')));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), journal(), 'the journal is left as it was');
});

test('a run not ended is not audited; lab audit --flat audits with code only', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
  const open = journal();
  open.events = open.events.filter((e) => e.type !== 'end');
  fs.writeFileSync(path.join(dir, 'open.json'), JSON.stringify(open));
  await assert.rejects(auditMethod(path.join(dir, 'open.json'), null), /has not ended/);
  fs.mkdirSync(path.join(dir, 'runs'));
  const file = path.join(dir, 'runs', 'run.json');
  fs.writeFileSync(file, JSON.stringify(journal()));
  const lines: string[] = [];
  assert.equal(await labCli(['audit', file, '--flat'], { root: dir, out: (l) => lines.push(l), env: {} }), 0);
  assert.match(lines.join('\n'), /3 experiments, 2 observations/);
  assert.match(lines.join('\n'), /outcome, beside it: \["3\/8","8\/8"\], rule recovery 0.5/);
  const a = JSON.parse(fs.readFileSync(path.join(dir, 'runs', 'run.method.json'), 'utf8'));
  assert.equal(a.judge, null);
  assert.equal(a.judged, null);
  assert.equal(await labCli(['audit', file], { root: dir, out: (l) => lines.push(l), env: {} }), 1, 'without --flat, the Judge is needed');
});

test('only what was shown is seen: a part of a table is that part; the Judge is shown the frames and rows themselves', () => {
  const table = (from: number, to: number) => '   t      A.x\n' + Array.from({ length: to - from + 1 }, (_, i) => '   ' + (from + i) + '   ' + (1.5 * (from + i)).toFixed(2)).join('\n');
  const j = {
    experiment: 'particles3d@1', researcher: 'assisted', config: { seed: 1, level: 1 },
    events: [
      { type: 'exploration_episode', episode: 'ep1', place: 'lab1', table: 'SECRET-ROWS' },
      { type: 'investigation', round: 1, requests: [{ view: 'ep1', from: 0, to: 2 }], results: [{ view: 'ep1', rows_in_table: 90, table: table(0, 2) }] },
      /* An act whose table shows only its first rows ("view it for the rest"). */
      { type: 'investigation', round: 1, requests: [{ act: { launch: [{ name: 'A' }], place: 'lab1' } }], results: [{ accepted: true, name: 'act1', rows_in_table: 90, more: 'view it for the rest', table: table(0, 3) }] },
      { type: 'proposal', round: 1, rationale: 'x', beliefs: [{ id: 'b', stance: 'new', statement: 'A drifts', evidence: ['ep1@1', 'ep1@999', 'act1@3', 'act1@50'] }] },
      { type: 'end', stoppedBy: 'budget' }
    ]
  };
  const r = linksOf(j);
  const status = Object.fromEntries(r.citations.map((c) => [c.ref, c.status]));
  assert.deepEqual([status['ep1@1'], status['ep1@999'], status['act1@3'], status['act1@50']], ['seen', 'unseen', 'seen', 'unseen']);
  assert.match(linkTexts(r.links[0]).shown, /ep1@1 \(cited after\):\n\s+1\s+1\.50/, 'the row itself, marked as cited');
  assert.match(linkTexts(linksOf(journal()).links[0]).shown, /g1@3 \(cited after\):\nboard 3/, 'the frame itself');
  assert.ok(!/SECRET/.test(JSON.stringify(r.links.map(linkTexts))));
});

test('a stretch is judged in the order it was lived: the verdict of the check it was given comes before what closed it', () => {
  const j = {
    experiment: 'cells@1', researcher: 'assisted', config: { seed: 1, level: 1 },
    events: [
      { type: 'investigation', round: 1, requests: [{ view: 'ep1', from: 0, to: 1 }], results: [{ view: 'ep1', frames: frames(0, 1) }] },
      { type: 'proposal', round: 1, rationale: 'r', beliefs: [{ id: 'grow', stance: 'new', statement: 'the edge grows' }] },
      { type: 'check', round: 1, laboratories: [{ place: 'lab1', holds: false, points: 9, operator_only: 'SECRET-MEASURE' }], operator_analysis: 'SECRET' },
      { type: 'reflection', round: 2, rationale: 'the check failed: the edge does not grow', beliefs: [{ id: 'grow', stance: 'drop', why: 'the check of round 1' }] },
      { type: 'end', stoppedBy: 'budget' }
    ]
  };
  const r = linksOf(j);
  assert.deepEqual(r.rounds.map((s) => [s.id, s.checks_before.length]), [['r1', 0], ['r2.reflection', 1]], 'a reflection with no step is a stretch too');
  const t = roundTexts(r.rounds[1], r).timeline;
  assert.ok(t.indexOf('held_at_start') < t.indexOf('verdict_of_a_check_it_was_given') && t.indexOf('verdict_of_a_check_it_was_given') < t.indexOf('closed_by'), 'in order');
  assert.match(t, /"holds":false/);
  assert.match(t, /"stance":"drop"/);
  assert.ok(!/SECRET/.test(t), 'the verdict as it was given, never the measures of the operator');
});

