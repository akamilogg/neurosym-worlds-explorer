import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { regrade } from '../src/runtime/regrade.ts';
import { gridLab, GRID_GRADING_SYSTEM } from '../src/worlds/grid/lab.ts';
import { FALSE_BELIEF_RULE } from '../src/learn/operator.ts';
import type { ChatClient } from '../src/learn/system2.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';


/* Grading a finished run again, with another model: the run's grader, the run's learner, the run's truth. */

const fetch: FetchLike = async (_url, init) => {
  const b = JSON.parse(String(init.body));
  const sys = b.messages[0].content as string;
  const user = sys.startsWith('You grade') ? {} : JSON.parse(userOf(b));
  /* The run's own grader fails, as a small local model did (HTTP 400). */
  if (sys.startsWith('You grade')) return { ok: false, status: 400, text: async () => 'Bad Request', headers: { get: () => null } };
  const content = { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p, m) => 0.5', validate: false,
    beliefs: [{ id: 'edge', stance: user.round === 1 ? 'new' : 'keep', statement: 'the other wins when = reaches column 4' }], lessons: ['l'] };
  const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
  return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
};
const GRID = ['--seed', '22', '--attempts', '1', '--explore', '1', '--variants', '1', '--family', '1', '--family-variants', '1', '--confirm-places', '1', '--levels', '2', '--depth', '1',
  '--steps', '0', '--flat', '--no-reflection', '--no-ablation'];

test('a run whose grading failed is graded again by another model: appended, marked, and the findings report it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regrade-'));
  const r = await runLaboratory(gridLab, { args: [...GRID, '--out', path.join(dir, 'run.json')], root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch });
  assert.equal(r.finding.operator?.rule_recovery, undefined, 'its own grading failed');
  const asked: { system: string; user: any }[] = [];
  const grader: ChatClient = { complete: async (q) => {
    asked.push({ system: q.system, user: JSON.parse(String(q.user)) });
    return { content: JSON.stringify({ grades: [{ id: 'win_other', grade: 'exact', evidence: 'column 4' }, { id: 'draw', grade: 'absent' }], false_beliefs: [], form: 'compact', form_evidence: 'e' }), latencyMs: 0, raw: null };
  } };
  const out = await regrade(r.journal, grader, 'senior-model');
  assert.equal(asked[0].system, GRID_GRADING_SYSTEM + ' ' + FALSE_BELIEF_RULE, 'the run\'s own grader, at version 2 (SPEC-CALIBRACION-INSTRUMENTOS §11.2)');
  assert.equal(asked[0].user.learner.beliefs[0].statement, 'the other wins when = reaches column 4', 'the learner as the run left it');
  assert.deepEqual(asked[0].user.picture_glyphs, { learner: '&', other: '=' });
  assert.equal(out.score, Math.round(1 / asked[0].user.true_rules.length * 100) / 100);
  const journal = JSON.parse(fs.readFileSync(r.journal, 'utf8'));
  const last = journal.events.at(-1);
  assert.equal(last.type, 'operator_rule_recovery');
  assert.equal(last.grader_model, 'senior-model');
  assert.ok(last.regraded);
  assert.equal(JSON.parse(fs.readFileSync(r.journal.replace(/\.json$/, '.finding.json'), 'utf8')).operator.rule_recovery.score, out.score, 'the findings report it');
  assert.equal(JSON.parse(fs.readFileSync(r.journal.replace(/\.json$/, '.finding.researcher.json'), 'utf8')).operator, undefined, 'never in the researcher\'s view');
});

test('a run that has not ended is not graded', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regrade-'));
  const file = path.join(dir, 'open.json');
  fs.writeFileSync(file, JSON.stringify({ experiment: 'unknown-world@1', events: [{ type: 'start' }] }));
  await assert.rejects(regrade(file, { complete: async () => ({ content: '{}', latencyMs: 0, raw: null }) }, 'm'), /has not ended/);
});

test('a world of laws whose run kept no truth is graded against the laboratory\'s own, from the run\'s spec and options', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regrade-'));
  const copy = path.join(dir, 'eureka'), rubric = path.join(copy, 'domains', 'neuroscience', 'navigation-goals', 'tests');
  fs.mkdirSync(rubric, { recursive: true });
  fs.writeFileSync(path.join(rubric, 'rubric.yaml'), 'insights:\r\n  criteria:\r\n  - id: I1\r\n    criterion: Does it explain A?\r\n    kind: finding\r\n');
  const file = path.join(dir, 'run.json');
  fs.writeFileSync(file, JSON.stringify({ experiment: 'c302-navigation@1', config: { eureka: copy, names: 'real' },
    hidden_from_the_learner: { spec: { seed: 1, place: 'steps', family: 'steps', names: 'real', namesSeed: 1 } },
    events: [{ t: 0, type: 'start' }, { t: 1, type: 'end', stoppedBy: 'budget', final: null, notebook: { beliefs: [], notes: [], reflections: [] } }] }));
  const asked: any[] = [];
  const out = await regrade(file, { complete: async (q) => { asked.push(JSON.parse(String(q.user)));
    return { content: JSON.stringify({ grades: [{ id: 'I1', grade: 'partial', evidence: 'e' }], false_beliefs: [], form: 'compact', form_evidence: 'e' }), latencyMs: 0, raw: null }; } }, 'm');
  assert.deepEqual(asked[0].true_statements, [{ id: 'I1', statement: '[finding] Does it explain A?' }]);
  assert.equal(out.score, 0.5);
  assert.deepEqual(out.event.truth, asked[0].true_statements, 'the truth it was graded against is kept with the grading');
});

test('review 2 of 0bec9b3: a run whose record of lines holds events its journal lacks is regraded as a resumption reads it - the journal and the record never part ways, and it can still be packed', async () => {
  const { readJournalFile, eventRecordOf } = await import('../src/runtime/journal-files.ts');
  const { packRun } = await import('../src/runtime/package.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regrade-'));
  const r = await runLaboratory(gridLab, { args: [...GRID, '--out', path.join(dir, 'run.json')], root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch });
  const whole = JSON.parse(fs.readFileSync(r.journal, 'utf8'));
  /* The journal as a stop between a line and its rewrite left it: its last two events only in the record of lines. */
  fs.writeFileSync(r.journal, JSON.stringify({ ...whole, events: whole.events.slice(0, -2) }));
  assert.equal(readJournalFile(r.journal).events.length, whole.events.length);
  const grader: ChatClient = { complete: async () => ({ content: JSON.stringify({ grades: [{ id: 'win_other', grade: 'exact', evidence: 'e' }], false_beliefs: [] }), latencyMs: 0, raw: null }) };
  const out = await regrade(r.journal, grader, 'senior-model');
  const read = readJournalFile(r.journal);
  assert.equal(read.events.length, whole.events.length + 1, 'the recovered events and the regrading, read without a conflict');
  assert.deepEqual(eventRecordOf(r.journal)!.events, read.events, 'the record of lines holds the same sequence');
  assert.deepEqual(JSON.parse(fs.readFileSync(r.journal, 'utf8')).events, read.events, 'and so does the journal');
  assert.equal(out.finding.operator?.rule_recovery?.score, out.score, 'its findings from that sequence');
  const pack = packRun(r.journal, path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'regrade-pkg-')), 'p'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(pack.dir, 'run.json'), 'utf8')).events.length, read.events.length);
});

test('review 3 of 0bec9b3: a slow regrading never erases one that finished while it waited - each published on the state in force, one after the other', async () => {
  const { readJournalFile, eventRecordOf } = await import('../src/runtime/journal-files.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regrade-'));
  const r = await runLaboratory(gridLab, { args: [...GRID, '--out', path.join(dir, 'run.json')], root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch });
  const before = readJournalFile(r.journal).events.length;
  /* The journal two events short, as a stop left it: the record of lines differs from what the slow one read. */
  const whole = JSON.parse(fs.readFileSync(r.journal, 'utf8'));
  fs.writeFileSync(r.journal, JSON.stringify({ ...whole, events: whole.events.slice(0, -2) }));
  let release!: () => void;
  const held = new Promise<void>((ok) => { release = ok; });
  const answer = { content: JSON.stringify({ grades: [{ id: 'win_other', grade: 'exact', evidence: 'e' }], false_beliefs: [] }), latencyMs: 0, raw: null };
  const slow: ChatClient = { complete: async () => { await held; return answer; } };
  const quick: ChatClient = { complete: async () => answer };
  const pending = regrade(r.journal, slow, 'slow');
  await new Promise((ok) => setTimeout(ok, 50));
  await regrade(r.journal, quick, 'fast');
  release();
  await pending;
  const read = readJournalFile(r.journal);
  assert.deepEqual(read.events.slice(before).map((e: Record<string, unknown>) => e.grader_model), ['fast', 'slow'], 'both kept, in the order they were published');
  assert.equal(read.events.length, before + 2);
  assert.deepEqual(eventRecordOf(r.journal)!.events, read.events);
  assert.deepEqual(JSON.parse(fs.readFileSync(r.journal, 'utf8')).events, read.events);
  assert.ok(!fs.existsSync(r.journal.replace(/\.json$/, '.lock')), 'the lock let go');
  /* Another execution under the name by the time it publishes: a conflict, nothing published. */
  let release2!: () => void;
  const held2 = new Promise<void>((ok) => { release2 = ok; });
  const pending2 = regrade(r.journal, { complete: async () => { await held2; return answer; } }, 'late');
  await new Promise((ok) => setTimeout(ok, 50));
  const { startEvents } = await import('../src/runtime/journal-files.ts');
  const other = { ...read, run_id: 'another', events: read.events };
  fs.writeFileSync(r.journal, JSON.stringify(other));
  startEvents(r.journal, 'another');
  release2();
  await assert.rejects(pending2, /another execution now/);
});
