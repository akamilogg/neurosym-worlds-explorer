import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';
import { generateCells } from '../src/worlds/cells/world.ts';
import { findingText } from '../src/learn/finding.ts';
import { experimentStates, runDigest } from '../src/orchestra/view.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';

/* The review of c302closed-n2-4 (08/10/2026): the researcher's own documents, its task question by question, what it leaves
   open at the end (SPEC-INVESTIGADOR-ASISTIDO §14); a run that accepted continued into a new stage (§14.3); and what this
   code adds applying only from the rounds it reviews, so that a history made before is repeated as it was. */

const SEED = 2;
function evenLayer(): string {
  const spec = generateCells(SEED, 4);
  const [g0, g1] = spec.glyphs, rule = spec.layers![0];
  return '(p) => { const row = p.rows[p.rows.length - 1].split(""); const n = row.length, out = row.slice();'
    + ' for (let i = 0; i < n; i += 2) { const v = (j) => row[((j % n) + n) % n] === ' + JSON.stringify(g1) + ' ? 1 : 0;'
    + ' const k = v(i - 2) * 4 + v(i) * 2 + v(i + 2); out[i] = ((' + rule + ' >> k) & 1) ? ' + JSON.stringify(g1) + ' : ' + JSON.stringify(g0) + '; }'
    + ' return out.join(""); }';
}

/** System 2 standing in: proposes the even layer and asks to validate, writes a document of its own, and reflects with what
    it leaves open. */
function system2(seen: { system: string; user: any }[] = [], output = evenLayer(), validate = true): FetchLike {
  return async (_url, init) => {
    const b = JSON.parse(String(init.body));
    const sys = b.messages[0].content as string;
    const user = sys.startsWith('You grade') ? {} : JSON.parse(userOf(b));
    seen.push({ system: sys, user });
    const content = sys.startsWith('You grade') ? { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' }
      : 'task' in user ? { rationale: 'r', beliefs: [{ id: 'b', stance: 'confirm', why: 'w' }], lessons: ['l'], next_experiment: 'n',
        open_questions: [{ question: 'why only the even cells', state: 'investigable_here', plan: 'act on odd cells, 2 rounds' }, { question: 'what sets the rule', state: 'needs_instrument', report: 'an intervention on the rule' }] }
      : { rationale: 'r', observations: {}, rules: {}, weights: {}, output, validate, beliefs: [{ id: 'b', stance: user.round === 1 ? 'new' : 'keep', statement: 's', evidence: ['ep1@2'] }], lessons: ['l'],
        documents: [{ do: 'write', id: 'coverage', text: 'Q1 (which cells change): the even ones, round ' + user.round + '. Q2 (why): open.' }] };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
}
const ARGS = ['--seed', String(SEED), '--level', '4', '--focus', 'even', '--researcher', 'assisted', '--flat', '--no-grade', '--validations', '4'];
const llm = { url: 'http://system2.test/chat', model: 'stand-in' };
const journalOf = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8')) as Record<string, any>;
const strip = (es: Record<string, any>[]) => es.filter((e) => !['start', 'end'].includes(e.type)).map(({ t: _t, ...e }) => JSON.stringify(e));

test('its own documents, its task question by question, and what it leaves open: asked, kept, and in the finding', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-'));
  const seen: { system: string; user: any }[] = [];
  const r = await runLaboratory(cellsLab, { args: [...ARGS, '--attempts', '2', '--out', path.join(dir, 'run.json')], root: dir, llm, fetch: system2(seen) });
  assert.equal(r.stoppedBy, 'accepted');
  const asked = seen.filter((q) => !q.system.startsWith('You grade'));
  assert.ok(asked.every((q) => q.system.includes('YOUR OWN DOCUMENTS') && q.system.includes('YOUR TASK, QUESTION BY QUESTION')), 'the sections, from the start of a new run');
  const journal = journalOf(r.journal);
  assert.equal(journal.config.review_from, 0);
  assert.equal(journal.config.fingerprint, 2);
  const written = journal.events.filter((e: any) => e.type === 'document_written');
  assert.deepEqual(written.map((e: any) => [e.round, e.id, e.do]), [[1, 'coverage', 'write']]);
  const reflect = asked.find((q) => 'task' in q.user)!;
  assert.match(String(reflect.user.task), /open_questions/, 'the reflection asks what it leaves open');
  assert.match(JSON.stringify(reflect.user), /"your_documents"/, 'its documents reach it');
  assert.equal(r.finding.outcome.open, true, 'it says it could go on');
  assert.deepEqual(r.finding.limitations.learner!.open_questions!.map((q) => q.state), ['investigable_here', 'needs_instrument']);
  assert.deepEqual(r.finding.assistance!.documents, [{ id: 'coverage', versions: 1, rounds: [1], forgotten: false }]);
  assert.match(findingText(r.finding), /OPEN: it says it could go on/);
  /* The senior reads them in the round they were written. */
  assert.match(JSON.stringify(runDigest(journal).latest_rounds.find((x: any) => x.round === 1).documents), /coverage/);
});

test('a run that accepted, continued: its history as it was, then a new stage - checks afresh, validations given back - and the model it accepted kept', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-'));
  const first = await runLaboratory(cellsLab, { args: [...ARGS, '--attempts', '3', '--out', path.join(dir, 'first.json')], root: dir, llm, fetch: system2() });
  assert.equal(first.stoppedBy, 'accepted');
  const accepted = journalOf(first.journal).events.find((e: any) => e.type === 'check' && e.accepted);
  const more = await runLaboratory(cellsLab, { args: ['--resume', first.journal, '--attempts', String(accepted.attempt + 2), '--out', path.join(dir, 'more.json')], root: dir, llm, fetch: system2() });
  assert.notEqual(more.stoppedBy, 'diverged');
  const before = journalOf(first.journal).events, after = journalOf(more.journal).events;
  assert.deepEqual(strip(after).slice(0, strip(before).length), strip(before), 'its history, word for word');
  const stage = after.find((e: any) => e.type === 'stage_after_acceptance');
  assert.ok(stage, 'a new stage after the acceptance');
  assert.equal(stage.accepted_round, accepted.round);
  assert.ok(after.filter((e: any) => e.type === 'proposal').some((e: any) => e.round > stage.round), 'new rounds after it');
  assert.equal(journalOf(more.journal).config.continued_after_acceptance, accepted.attempt);
  assert.equal((more.finding.outcome.previously_accepted as { round: number }).round, accepted.round);
  /* A new stage: its validations given back, the same model is confirmed again on places nobody had seen. */
  assert.equal(more.stoppedBy, 'accepted');
  assert.equal(after.filter((e: any) => e.type === 'accepted').length, 2);
});

test('a run made before this code, continued: its history repeated as it was asked, the additions only from its new rounds', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-'));
  /* A run of the unknown-world researcher, graded by nobody, that never accepts; then made as if before: no review_from. */
  const plain = ['--seed', '1', '--level', '1', '--flat', '--no-grade', '--tools', 'none'];
  const first = await runLaboratory(cellsLab, { args: [...plain, '--attempts', '2', '--out', path.join(dir, 'first.json')], root: dir, llm, fetch: system2([], '(p) => p.rows[p.rows.length - 1]', false) });
  const j = journalOf(first.journal);
  delete j.config.review_from;
  fs.writeFileSync(first.journal, JSON.stringify(j));
  const seen: { system: string; user: any }[] = [];
  const more = await runLaboratory(cellsLab, { args: ['--resume', first.journal, '--attempts', '4', '--researcher', 'assisted', '--out', path.join(dir, 'more.json')], root: dir, llm,
    fetch: system2(seen, '(p) => p.rows[p.rows.length - 1]', false) });
  assert.notEqual(more.stoppedBy, 'diverged');
  const journal = journalOf(more.journal);
  assert.equal(journal.config.review_from, 2, 'from its new rounds');
  const from = journal.events.find((e: any) => e.type === 'review_from');
  assert.equal(from.attempt, 3);
  const live = seen.filter((q) => !q.system.startsWith('You grade'));
  assert.ok(live.length > 0 && live.every((q) => q.system.includes('YOUR OWN DOCUMENTS')), 'live: the additions');
});

test('the state of its experiments: done, read, used - from its own record', () => {
  const journal = { events: [
    { type: 'investigation', round: 1, requests: [{ act: {} }, { act: {} }, { act: {} }], results: [{ accepted: true, name: 'act1' }, { accepted: true, name: 'act2' }, { accepted: true, name: 'act10' }] },
    { type: 'investigation', round: 1, requests: [{ view: 'act1', from: 0, to: 9 }, { view: 'act10', from: 0, to: 9 }], results: [{}, {}] },
    { type: 'proposal', round: 1, beliefs: [{ id: 'b', stance: 'new', statement: 's', evidence: ['act10@4'] }], notes: [] }
  ] };
  assert.deepEqual(experimentStates(journal).map((x) => x.episode + ':' + x.state), ['act1:read', 'act2:done', 'act10:used'], 'act1 is not act10');
  assert.deepEqual(runDigest(journal).its_experiments_not_yet_used, [{ episode: 'act1', round: 1, state: 'read, not cited as evidence' }, { episode: 'act2', round: 1, state: 'not read yet' }]);
});
