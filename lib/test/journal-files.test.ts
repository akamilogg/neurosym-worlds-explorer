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

test('CC1 review: a refused rename never writes in place - the last whole journal stays, the pending one is kept, and a resumption recovers the newest complete state', async () => {
  const { writeAtomic, metaFileOf } = await import('../src/runtime/journal-files.ts');
  const dir = tmp();
  const file = path.join(dir, 'run.json');
  const head = { experiment: 'cells@1', argv: ['--seed', '1'], config: {} };
  writeAtomic(file, JSON.stringify({ ...head, events: [{ type: 'start' }] }));
  const refuse = () => { const e = new Error('busy') as NodeJS.ErrnoException; e.code = 'EPERM'; throw e; };
  writeAtomic(file, JSON.stringify({ ...head, events: [{ type: 'start' }, { type: 'check' }] }), { rename: refuse, wait: 0 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).events, [{ type: 'start' }], 'the journal as it was, whole');
  assert.equal(readJournalFile(file).events.length, 2, 'the newer one kept, pending, and recovered');
  /* A journal cut mid-write by an older writer: its header from the checkpoint of metadata, its events from the lines. */
  fs.writeFileSync(metaFileOf(file), JSON.stringify(head));
  fs.writeFileSync(eventsFileOf(file), JSON.stringify({ type: 'start' }) + '\n' + JSON.stringify({ type: 'check' }) + '\n');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.tmp'))) fs.rmSync(path.join(dir, f));
  fs.writeFileSync(file, '{"experiment": "cells@1", "ev');
  const j = readJournalFile(file);
  assert.deepEqual([j.experiment, j.events.length], ['cells@1', 2]);
});

test('CC1 review: an event appended after a cut line is kept; a line broken in the middle is told, never skipped', async () => {
  const { appendEvent } = await import('../src/runtime/journal-files.ts');
  const dir = tmp();
  const file = path.join(dir, 'run.json');
  fs.writeFileSync(eventsFileOf(file), JSON.stringify({ type: 'start' }) + '\n{"type": "che');
  appendEvent(file, { type: 'end' });
  assert.deepEqual(eventsOf(file), [{ type: 'start' }, { type: 'end' }]);
  fs.writeFileSync(eventsFileOf(file), JSON.stringify({ type: 'start' }) + '\n{"type": broken}\n' + JSON.stringify({ type: 'end' }) + '\n');
  assert.throws(() => eventsOf(file), /line 2/);
});

/* --- An external review of 0bec9b3 (13/11/2026) -------------------------------------------------------------------------- */

test('review 0bec9b3: a temporary another execution left under a name used again is never taken for the new run\'s state; one of the same execution that parts ways is told', async () => {
  const dir = tmp();
  const out = path.join(dir, 'run.json');
  const old = await runLaboratory(cellsLab, { args: args(out, 2), root: dir, llm: { url: 'http://x.test/c', model: 's' }, fetch: standIn, print: () => {} });
  const oldJournal = JSON.parse(fs.readFileSync(old.journal, 'utf8'));
  /* What an older process left pending: its journal, holding more events than the new run will. */
  fs.writeFileSync(out + '.999.tmp', JSON.stringify(oldJournal));
  const fresh = await runLaboratory(cellsLab, { args: args(out, 1), root: dir, llm: { url: 'http://x.test/c', model: 's' }, fetch: standIn, print: () => {} });
  const now = JSON.parse(fs.readFileSync(fresh.journal, 'utf8'));
  assert.ok(oldJournal.events.length > now.events.length && oldJournal.run_id !== now.run_id);
  const read = readJournalFile(out);
  assert.deepEqual([read.run_id, read.started, read.events.length], [now.run_id, now.started, now.events.length], 'the new run, never the old one');
  /* The new run's record of lines names its execution; the old one's lines would not be taken either. */
  const { eventRecordOf } = await import('../src/runtime/journal-files.ts');
  assert.equal(eventRecordOf(out)!.run, now.run_id);
  /* A pending state of the SAME execution whose events part ways from the journal's: told, not chosen by its length. */
  fs.rmSync(out + '.999.tmp');
  fs.writeFileSync(out + '.998.tmp', JSON.stringify({ ...now, events: [{ type: 'other' }, ...now.events] }));
  assert.throws(() => readJournalFile(out), /part ways/);
  /* And one of the same execution that continues it is the newest state. */
  fs.rmSync(out + '.998.tmp');
  fs.writeFileSync(out + '.997.tmp', JSON.stringify({ ...now, events: [...now.events, { type: 'later' }] }));
  assert.equal(readJournalFile(out).events.length, now.events.length + 1);
});

test('review 0bec9b3: a package is one snapshot read as a resumption reads it - the events the record of lines recovered, and the blobs they cite', async () => {
  const { createHash } = await import('node:crypto');
  const { packRun } = await import('../src/runtime/package.ts');
  const dir = tmp();
  const r = await runLaboratory(cellsLab, { args: args(path.join(dir, 'run.json'), 1), root: dir, llm: { url: 'http://x.test/c', model: 's' }, fetch: standIn, print: () => {} });
  const whole = JSON.parse(fs.readFileSync(r.journal, 'utf8'));
  /* An event only the record of lines holds, citing a blob kept beside the run; the journal two events short. */
  const text = 'a text kept whole';
  const sha = createHash('sha256').update(text).digest('hex');
  fs.mkdirSync(path.join(dir, 'blobs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'blobs', sha), text);
  const extra = { t: 0, type: 'note', text: { sha256: sha, kept: true } };
  fs.appendFileSync(eventsFileOf(r.journal), JSON.stringify(extra) + '\n');
  fs.writeFileSync(r.journal, JSON.stringify({ ...whole, events: whole.events.slice(0, -2) }));
  const recovered = readJournalFile(r.journal).events;
  assert.equal(recovered.length, whole.events.length + 1);
  const pack = packRun(r.journal, path.join(tmp(), 'pkg'));
  const packed = JSON.parse(fs.readFileSync(path.join(pack.dir, 'run.json'), 'utf8'));
  assert.deepEqual(packed.events, recovered, 'every event the reader recovers is exported');
  assert.ok(fs.existsSync(path.join(pack.dir, 'blobs', sha)), 'with the blob a recovered event cites');
  assert.deepEqual(pack.manifest.missing_blobs, []);
});

test('review 2 of 0bec9b3: the execution is the one last started (its start marker), never the journal an earlier one left; where it left no state, a conflict is told', async () => {
  const { writeAtomic, metaFileOf, startEvents, appendEvent } = await import('../src/runtime/journal-files.ts');
  const dir = tmp();
  const file = path.join(dir, 'run.json');
  const head = (id: string) => ({ experiment: 'cells@1', argv: ['--seed', '1'], run_id: id, started: id });
  writeAtomic(file, JSON.stringify({ ...head('old'), events: [{ type: 'start' }, { type: 'a' }, { type: 'b' }] }));
  /* A new run under the same name whose renames are all refused: its marker, its lines, its checkpoint and its temporary
     are new; the journal is still the old one. */
  startEvents(file, 'new');
  const refuse = () => { const e = new Error('busy') as NodeJS.ErrnoException; e.code = 'EPERM'; throw e; };
  fs.writeFileSync(metaFileOf(file), JSON.stringify(head('new')));
  appendEvent(file, { type: 'start' });
  writeAtomic(file, JSON.stringify({ ...head('new'), events: [{ type: 'start' }] }), { rename: refuse, wait: 0 });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).run_id, 'old', 'the journal still the earlier run');
  const read = readJournalFile(file);
  assert.deepEqual([read.run_id, read.events.length], ['new', 1], 'the run last started, never the old one');
  /* Without its temporary, its checkpoint and its lines. */
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.tmp'))) fs.rmSync(path.join(dir, f));
  assert.deepEqual([readJournalFile(file).run_id, readJournalFile(file).events.length], ['new', 1]);
  /* A new run that left nothing of its own but its marker: a conflict, told. */
  fs.rmSync(metaFileOf(file));
  startEvents(file, 'newer');
  assert.throws(() => readJournalFile(file), /last started under this name is newer/);
});
