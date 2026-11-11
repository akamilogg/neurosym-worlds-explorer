import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';
import { eventsFileOf, eventsOf, readJournalFile } from '../src/runtime/journal-files.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';

/* SPEC-CONSOLIDACION §3.2 (CC1, its writing): each event a line of <run>.events.jsonl; <run>.json written whole or not at all;
   resuming, the record of lines rules. */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'journal-files-'));
const LOOK = { investigate: [{ view: 'ep1', from: 0, to: 2 }] };
const PROPOSE = { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]', validate: false, lessons: ['l'], next_experiment: 'n', beliefs: [] };
const standIn: FetchLike = async (_url, init) => {
  const user = JSON.parse(userOf(JSON.parse(String(init.body))));
  const content = 'task' in user ? { rationale: 'r', beliefs: [], lessons: ['l'], next_experiment: 'n' } : (user.investigation ?? []).length ? PROPOSE : LOOK;
  const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
  return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
};
const args = (out: string, attempts = 2) => ['--seed', '1', '--level', '1', '--flat', '--no-grade', '--tools', 'view', '--attempts', String(attempts), '--out', out];

test('CC1: every event a line of the record; the journal written whole, no temporary left; the same events in both', async () => {
  const dir = tmp();
  const r = await runLaboratory(cellsLab, { args: args(path.join(dir, 'run.json')), root: dir, llm: { url: 'http://x.test/c', model: 's' }, fetch: standIn, print: () => {} });
  const j = JSON.parse(fs.readFileSync(r.journal, 'utf8'));
  const lines = eventsOf(r.journal)!;
  assert.ok(lines.length > 3);
  assert.deepEqual(lines, j.events, 'the record of lines and the journal hold the same events');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'no temporary left');
});

test('CC1: resuming, the record of lines rules where the journal holds fewer events', async () => {
  const dir = tmp();
  const r = await runLaboratory(cellsLab, { args: args(path.join(dir, 'run.json'), 1), root: dir, llm: { url: 'http://x.test/c', model: 's' }, fetch: standIn, print: () => {} });
  const whole = JSON.parse(fs.readFileSync(r.journal, 'utf8'));
  /* The journal as a stop between a line and its rewrite would have left it: two events short. */
  fs.writeFileSync(r.journal, JSON.stringify({ ...whole, events: whole.events.slice(0, -2) }));
  assert.deepEqual(readJournalFile(r.journal).events, whole.events);
  /* A last line cut by a stop is no event. */
  fs.appendFileSync(eventsFileOf(r.journal), '{"type": "en');
  assert.equal(eventsOf(r.journal)!.length, whole.events.length);
  const again = await runLaboratory(cellsLab, { args: ['--resume', r.journal, '--attempts', '2', '--out', path.join(dir, 'more.json')], root: dir, llm: { url: 'http://x.test/c', model: 's' }, fetch: standIn, print: () => {} });
  assert.notEqual(again.stoppedBy, 'diverged');
});
