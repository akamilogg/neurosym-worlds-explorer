import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { runBatch, type BatchDefinition } from '../src/orchestra/batch.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';

/* c302closed-staged-n2-3 (13/10/2026): its phase A ended by its token budget with no reflection and no grading, so its finding
   had nothing of what it left open (SPEC-INVESTIGADOR-ASISTIDO §14.9); and its phase B looked for A under another batch's id
   (a path written by hand). */

function system2(asked: Record<string, any>[] = []): FetchLike {
  return async (_url, init) => {
    const b = JSON.parse(String(init.body));
    const sys = b.messages[0].content as string;
    const grading = sys.startsWith('You grade');
    const user = grading ? {} : JSON.parse(userOf(b));
    asked.push({ grading, ...user });
    const content = grading ? { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' }
      : 'task' in user ? { rationale: 'r', beliefs: [{ id: 'b', stance: 'keep', why: 'w' }], lessons: ['looked back'], next_experiment: 'n' }
      : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]', validate: false, beliefs: [{ id: 'b', stance: user.round === 1 ? 'new' : 'keep', statement: 's', evidence: [] }], lessons: ['l'] };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
}
const ARGS = ['--seed', '1', '--level', '1', '--flat', '--tools', 'none'];
const llm = { url: 'http://system2.test/chat', model: 'stand-in' };
const eventsOf = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8')).events as Record<string, any>[];

test('a token budget ends the investigation, not its account: the closing reflection and the grading still come, and a resume past that point does not diverge', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closing-'));
  const asked: Record<string, any>[] = [];
  const r = await runLaboratory(cellsLab, { args: [...ARGS, '--attempts', '6', '--max-tokens', '250', '--out', path.join(dir, 'cut.json')], root: dir, llm, fetch: system2(asked) });
  assert.equal(r.stoppedBy, 'token_budget', 'still said: a budget stopped it');
  const events = eventsOf(r.journal);
  assert.ok(events.some((e) => e.type === 'closing_after_budget'));
  assert.equal(events.filter((e) => e.type === 'reflection').length, 1, 'its closing reflection');
  assert.equal(events.filter((e) => e.type === 'operator_rule_recovery').length, 1, 'and its grading');
  const log = fs.readFileSync(r.journal.replace(/\.json$/, '.replay.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(log.filter((e) => e.closing).length >= 2, 'the closing\'s answers are marked in the log');
  /* Resumed with no budget: it goes on past where the budget stopped it, and the closing it never asks is no divergence. */
  const more = await runLaboratory(cellsLab, { args: ['--resume', r.journal, '--out', path.join(dir, 'more.json')], root: dir, llm, fetch: system2() });
  assert.notEqual(more.stoppedBy, 'diverged');
  assert.ok(eventsOf(more.journal).filter((e) => e.type === 'proposal').length > events.filter((e) => e.type === 'proposal').length, 'it went on');
});

test('a run of a batch names another of its runs as "@run:<id>": the journal it ended with; never one not ended, nor one the batch lacks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closing-batch-'));
  const def: BatchDefinition = { id: 'refs', concurrency: 1, runs: [
    { id: 'early', lab: 'cells', condition: 'too early', researcher: 'assisted', args: [...ARGS, '--attempts', '1', '--experience', '@run:a'] },
    { id: 'a', lab: 'cells', condition: 'A', args: [...ARGS, '--attempts', '1'] },
    { id: 'b', lab: 'cells', condition: 'B', researcher: 'assisted', args: [...ARGS, '--attempts', '1', '--experience', '@run:a', '--experience-mode', 'meta'] },
    { id: 'lost', lab: 'cells', condition: 'lost', args: [...ARGS, '--attempts', '1', '--experience', '@run:nobody'] }
  ] } as BatchDefinition;
  const report = await runBatch(def, { root: dir, llm, fetch: system2() });
  const row = (id: string) => report.runs.find((r: any) => r.id === id) as any;
  assert.match(String(row('early').error), /run "a" has no journal yet/);
  assert.match(String(row('lost').error), /this batch has no run "nobody"/);
  const b = JSON.parse(fs.readFileSync(row('b').journal, 'utf8'));
  assert.equal(path.resolve(b.config.experience), path.resolve(row('a').journal), 'B read the journal A ended with');
});
