import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LabError, runLaboratory } from '../src/runtime/lab-runner.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';
import type { FetchLike } from '../src/core/net.ts';

/* SPEC-OBJETIVO O13: a laboratory run as a library call - no environment, no console, no signals, no process.exit. The
   network is injected, so a whole run happens here, with System 2 answered by a stand-in. */

const draft = { observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]' };
/** System 2 stand-in: investigates in odd rounds, then proposes the same row again; reflects; grades. Stateless. */
const system2: FetchLike = async (_url, init) => {
  const b = JSON.parse(String(init.body));
  const sys = b.messages[0].content as string, user = b.messages[b.messages.length - 1].content as string;
  const content = sys.startsWith('You grade') ? { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' }
    : /"task"/.test(user) ? { rationale: 'r', beliefs: [{ id: 'b', stance: 'confirm', why: 'w' }], lessons: ['l'], next_experiment: 'n' }
    : !JSON.parse(user).investigation && JSON.parse(user).round % 2 === 1 ? { investigate: [{ view: 'ep1', from: 0, to: 3 }] }
    : { rationale: 'r', ...draft, validate: true, beliefs: [{ id: 'b', stance: 'new', statement: 's' }], lessons: ['l'] };
  const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
  return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
};

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lab-'));
const base = (dir: string, args: string[], more: Partial<Parameters<typeof runLaboratory>[1]> = {}) =>
  ({ args: [...args, '--out', path.join(dir, 'run.json')], root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch: system2, ...more });
const ARGS = ['--seed', '1', '--level', '1', '--attempts', '2', '--flat', '--no-grade'];

test('a run is a call: it returns why it stopped, its journal and its finding, and prints only where it is told', async () => {
  const dir = root();
  const lines: string[] = [];
  let told = '';
  const r = await runLaboratory(cellsLab, base(dir, ARGS, { print: (l) => lines.push(l), onJournal: (f) => { told = f; } }));
  assert.equal(r.journal, path.join(dir, 'run.json'));
  assert.equal(told, r.journal);
  assert.ok(['accepted', 'budget'].includes(r.stoppedBy));
  assert.equal(r.finding.format, 'finding@1');
  assert.equal(r.finding.question.world, 'cells@1');
  const journal = JSON.parse(fs.readFileSync(r.journal, 'utf8'));
  assert.equal(journal.events.at(-1).type, 'end');
  assert.equal(journal.config.llm_model, 'stand-in');
  assert.ok(fs.existsSync(r.findingFile));
  assert.ok(lines.some((l) => /done:/.test(l)));
  /* Two views: the operator's (with the hidden truth) and the researcher's (what another agent is given). */
  assert.equal(r.finding.view, 'operator');
  assert.equal(r.researcher.view, 'researcher');
  assert.ok(r.finding.operator?.truth);
  const given = fs.readFileSync(r.researcherFile, 'utf8');
  for (const t of r.finding.operator!.truth as { statement: string }[]) assert.ok(!given.includes(t.statement));
});

test('a configuration it cannot run is a LabError, not an exit', async () => {
  const dir = root();
  await assert.rejects(runLaboratory(cellsLab, base(dir, [...ARGS, '--tools', 'telescope'])), (e) => e instanceof LabError && /telescope/.test(e.message));
  await assert.rejects(runLaboratory(cellsLab, { ...base(dir, ARGS), llm: {} }), LabError);
  await assert.rejects(runLaboratory(cellsLab, base(dir, ['--seed', '1'])), /Judge is needed/);
  await assert.rejects(runLaboratory(cellsLab, base(dir, ['--resume', path.join(dir, 'nothing.json')])), /cannot read/);
});

test('an aborted signal stops the run before its next question to System 2', async () => {
  const dir = root();
  const controller = new AbortController();
  controller.abort();
  const r = await runLaboratory(cellsLab, base(dir, ARGS, { signal: controller.signal }));
  assert.equal(r.stoppedBy, 'cancelled');
  const journal = JSON.parse(fs.readFileSync(r.journal, 'utf8'));
  assert.ok(journal.events.some((e: { type: string }) => e.type === 'halted'));
});

test('a resumed run that diverges returns so, and the run it resumes is left as it was', async () => {
  const dir = root();
  const first = await runLaboratory(cellsLab, base(dir, ARGS));
  const before = fs.readFileSync(first.journal, 'utf8');
  /* The same journal, resumed with another experiment: what it asks is not what the first asked. */
  const other = path.join(dir, 'other.json');
  const j = JSON.parse(before);
  j.argv = [...j.argv, '--steps', '1'];
  fs.writeFileSync(other, JSON.stringify(j));
  fs.copyFileSync(first.journal.replace(/\.json$/, '.replay.jsonl'), other.replace(/\.json$/, '.replay.jsonl'));
  const r = await runLaboratory(cellsLab, { args: ['--resume', other, '--out', path.join(dir, 'resumed.json')], root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch: system2 });
  assert.equal(r.stoppedBy, 'diverged');
  assert.equal(fs.readFileSync(first.journal, 'utf8'), before);
  const events = JSON.parse(fs.readFileSync(r.journal, 'utf8')).events.map((e: { type: string }) => e.type);
  assert.deepEqual(events.slice(-2), ['diverged', 'end']);
});

test('a resumed run that does not diverge ends as the whole run did', async () => {
  const dir = root();
  const whole = await runLaboratory(cellsLab, base(dir, ARGS));
  const r = await runLaboratory(cellsLab, { args: ['--resume', whole.journal, '--out', path.join(dir, 'again.json')], root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' },
    fetch: async () => { throw new Error('the network is not asked: everything is replayed'); } });
  assert.equal(r.stoppedBy, whole.stoppedBy);
  const strip = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8')).events.filter((e: { type: string }) => e.type !== 'start' && e.type !== 'end').map(({ t: _t, ...e }: { t: number }) => e);
  assert.deepEqual(strip(r.journal), strip(whole.journal));
});

test('a laboratory without a truth runs, resumes and reports the same way: nothing but the grade depends on one', async () => {
  const dir = root();
  /* A world nobody wrote down: its truth, and so its grader, are not declared. */
  const { truth: _t, grading: _g, ...rest } = cellsLab;
  const unknown = rest as typeof cellsLab;
  const r = await runLaboratory(unknown, base(dir, ['--seed', '1', '--level', '1', '--attempts', '2', '--flat']));
  assert.ok(['accepted', 'budget'].includes(r.stoppedBy));
  const journal = JSON.parse(fs.readFileSync(r.journal, 'utf8'));
  assert.equal(journal.hidden_from_the_learner.truth, undefined);
  assert.ok(!journal.events.some((e: { type: string }) => /recovery/.test(e.type)), 'no grade without a truth');
  assert.equal(r.finding.operator?.truth, undefined);
  assert.equal(r.finding.operator?.rule_recovery, undefined);
  assert.ok(r.finding.model && r.finding.claims.length, 'the finding is complete without it');
  const again = await runLaboratory(unknown, { args: ['--resume', r.journal, '--out', path.join(dir, 'again.json')], root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' },
    fetch: async () => { throw new Error('everything is replayed'); } });
  assert.equal(again.stoppedBy, r.stoppedBy);
});
