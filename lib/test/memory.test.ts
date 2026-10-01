import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FREE_MEMORY_ANSWERS, JournalMemory, MEMORY_SECTION } from '../src/learn/assisted/memory.ts';
import { Notebook } from '../src/learn/notebook.ts';
import { explorerSystem, parseExplorerTurn } from '../src/learn/explorer.ts';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { gridLab } from '../src/worlds/grid/lab.ts';
import type { FetchLike } from '../src/core/net.ts';

/* SPEC-INVESTIGADOR-ASISTIDO §13: the assisted researcher's selective memory over its own record. */

function notebookOf(): Notebook {
  const nb = new Notebook();
  nb.applyStances(1, [{ id: 'b_end', stance: 'new', statement: 'it ends on row 0', evidence: ['g1@8'] }]);
  nb.applyStances(3, [{ id: 'b_end', stance: 'revise', statement: 'it ends when = reaches row 0', why: 'g8@23 scored 1', evidence: ['g8@23'] }]);
  nb.applyNotes(1, [{ do: 'write', id: 'theory', text: 'THEORY: the = walks at random; an old and long note about row 0' }], () => true);
  nb.applyNotes(3, [{ do: 'write', id: 'fresh', text: 'round 3: & adjacent to = scored 1' }, { do: 'write', id: 'scratch', text: 'to archive' }], () => true);
  nb.applyNotes(3, [{ do: 'archive', id: 'scratch' }], () => true);
  nb.addGames([{ id: 'g1', round: 0, how: 'at random', result: 'lost', turns: 8 }, { id: 'g8', round: 3, how: 'your model', result: 'won', turns: 23 }]);
  return nb;
}

test('the notebook travels abridged by its fixed rule; the rest is in memory, whole', () => {
  const memory = new JournalMemory(notebookOf());
  const brief = memory.brief(3) as Record<string, any>;
  assert.deepEqual(brief.beliefs_held[0].statement, 'it ends when = reaches row 0');
  assert.match(brief.beliefs_held[0].latest, /^round 3: revise/);
  assert.equal(brief.beliefs_held[0].earlier_stances, 1, 'earlier stances are recalled, not carried');
  assert.equal(brief.beliefs_held[0].history, undefined);
  const notes = Object.fromEntries(brief.notes.map((n: { id: string }) => [n.id, n]));
  assert.ok(notes.fresh.text, 'a note of the last two rounds travels whole');
  assert.ok(notes.theory.first_words && !notes.theory.text, 'an older one by its first words');
  assert.equal(notes.scratch, undefined, 'an archived note does not travel');
  assert.equal(brief.notes_archived, 1);
  assert.deepEqual(brief.episodes.map((e: { episode: string }) => e.episode), ['g8'], 'the episodes of the last two rounds');
  assert.equal(brief.memory.notes, 3);
});

test('list, open and find read its own record; select asks the Judge, and the journal is told what it kept', async () => {
  const selections: { items: readonly string[]; kept?: readonly string[] }[] = [];
  const memory = new JournalMemory(notebookOf(), { selector: async (_need, lines) => lines.map((l) => (/adjacent/.test(l) ? 1 : 0)), onSelect: (r) => selections.push(r) });
  memory.recordInvestigation(2, 1, { requests: [{ act: 'g2@4', from: [1, 4], to: [0, 4] }], results: [{ accepted: false }] });
  memory.recordCheck(2, { lab1: { wins: 2, of: 8 } });
  const list = await memory.run({ memory: 'list', of: 'notes' }) as Record<string, any>;
  assert.deepEqual(list.index.map((i: { id: string }) => i.id), ['note:theory', 'note:fresh', 'note:scratch']);
  assert.match(list.index[2].first_words, /^\[archived\]/);
  const opened = await memory.run({ memory: 'open', items: ['belief:b_end', 'investigation:r2.1', 'check:r2', 'note:nope'] }) as Record<string, any>;
  assert.equal(opened.items[0].item.history.length, 2, 'a belief whole, with its history');
  assert.deepEqual(opened.items[1].item.results, [{ accepted: false }], 'what an act answered, as it was answered');
  assert.deepEqual(opened.items[2].item, { lab1: { wins: 2, of: 8 } });
  assert.equal(opened.items[3].error, 'no such item');
  const found = await memory.run({ memory: 'find', words: 'ROW 0' }) as Record<string, any>;
  assert.deepEqual(found.items.map((i: { id: string }) => i.id), ['belief:b_end', 'note:theory'], 'every word, any case');
  const picked = await memory.run({ memory: 'find', words: 'scored', select: 'what made an episode score 1' }) as Record<string, any>;
  assert.deepEqual(picked.items.map((i: { id: string }) => i.id), ['note:fresh']);
  assert.deepEqual(selections[0].kept, ['note:fresh']);
  assert.ok(selections[0].items.includes('belief:b_end'), 'what it was shown, for the operator');
  assert.match((await memory.run({ memory: 'list', of: 'dreams' }) as { error: string }).error, /"of" is one of/);
  const noJudge = await new JournalMemory(notebookOf()).run({ memory: 'find', words: 'scored', select: 'x' }) as { note: string };
  assert.match(noJudge.note, /no Judge/);
});

test('the round\'s investigation: the last two answers whole, earlier ones by name', () => {
  const steps = [1, 2, 3].map((step) => ({ step, requests: [{ view: 'g1' }], results: [{ pictures: 'x'.repeat(50) }] }));
  const view = JournalMemory.investigationView(4, steps) as Record<string, unknown>[];
  assert.deepEqual(view[0], { step: 1, requests: [{ view: 'g1' }], results_in_memory: 'investigation:r4.1' });
  assert.deepEqual(view.slice(1), steps.slice(1));
});

test('a memory request and an archive are understood only where the researcher has a memory', () => {
  const ctx = { world: 'w', senses: {}, round: 1 };
  const answer = JSON.stringify({ investigate: [{ memory: 'list', of: 'notes' }], notes: [{ do: 'archive', id: 'n1' }] });
  const pure = parseExplorerTurn(answer, ctx);
  assert.equal(pure.kind, 'investigate');
  assert.equal((pure as { requests: unknown[] }).requests.length, 0);
  assert.equal(pure.notes.length, 0, 'the unknown-world researcher: no archive');
  const withMemory = parseExplorerTurn(answer, { ...ctx, extraRequest: JournalMemory.accepts, archive: true });
  assert.deepEqual((withMemory as { requests: unknown[] }).requests, [{ extra: { memory: 'list', of: 'notes' } }]);
  assert.deepEqual(withMemory.notes, [{ do: 'archive', id: 'n1' }]);
  assert.ok(!explorerSystem().includes('YOUR MEMORY'));
});

/* --- A whole assisted grid run with a selective memory, System 2 standing in: in its first round it recalls from memory
   (free), then investigates the world, then proposes. */
function system2(asked: Record<string, any>[]): FetchLike {
  return async (_url, init) => {
    const b = JSON.parse(String(init.body));
    const sys = b.messages[0].content as string;
    const user = JSON.parse(b.messages[b.messages.length - 1].content as string);
    asked.push({ system: sys, user });
    const done = (user.investigation ?? []).length;
    const content = user.round === 1 && done === 0 ? { investigate: [{ memory: 'list', of: 'episodes' }, { memory: 'find', words: 'score' }] }
      : user.round === 1 && done === 1 ? { investigate: [{ view: 'g1', from: 0, to: 2 }], notes: [{ do: 'write', id: 'n1', text: 'a note' }] }
      : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p, m) => 0.5', validate: false, beliefs: [{ id: 'b', stance: user.round === 1 ? 'new' : 'keep', statement: 's' }], lessons: ['l'],
        ...(user.round === 2 ? { notes: [{ do: 'archive', id: 'n1' }] } : {}) };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
}
const GRID = ['--seed', '22', '--attempts', '2', '--explore', '2', '--variants', '1', '--family', '1', '--family-variants', '1', '--confirm-places', '1', '--levels', '2', '--depth', '1',
  '--flat', '--no-grade', '--no-reflection', '--no-ablation'];
const llm = { url: 'http://system2.test/chat', model: 'stand-in' };

test('an assisted grid run with a selective memory: its prompt, the abridged notebook, free recalls, and the finding', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-'));
  const asked: Record<string, any>[] = [];
  const r = await runLaboratory(gridLab, { args: [...GRID, '--researcher', 'assisted', '--memory', 'selective', '--out', path.join(dir, 'run.json')], root: dir, llm, fetch: system2(asked) });
  assert.equal(r.researcherUsed, 'assisted');
  assert.ok(asked[0].system.endsWith(MEMORY_SECTION), 'its prompt says what its memory is');
  assert.match(asked[0].system, /THE OPERATOR/);
  assert.ok(asked[0].user.notebook.memory, 'the notebook says what its memory holds');
  assert.equal(asked[1].user.steps_left, asked[0].user.steps_left, 'an answer of only memory requests is free');
  assert.equal(asked[2].user.steps_left, asked[0].user.steps_left - 1, 'one that asks the world is not');
  assert.equal(asked[1].user.investigation[0].results[0].of, 'episodes');
  const j = JSON.parse(fs.readFileSync(r.journal, 'utf8'));
  assert.equal(j.config.memory, 'selective');
  const inv = j.events.filter((e: { type: string }) => e.type === 'investigation');
  assert.equal(inv[0].free, true);
  assert.deepEqual(inv[0].requests[0], { memory: 'list', of: 'episodes' });
  const end = j.events.find((e: { type: string }) => e.type === 'end');
  assert.equal(end.notebook.notes.find((n: { id: string }) => n.id === 'n1').archived, true, 'archived in round 2, kept');
  assert.deepEqual(r.finding.assistance?.memory?.listed, ['episodes']);
  assert.deepEqual(r.finding.assistance?.memory?.found, ['score']);
  assert.ok(FREE_MEMORY_ANSWERS >= 1);
});

test('a selective memory is the assisted researcher\'s, and the grid\'s only for now', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-'));
  await assert.rejects(runLaboratory(gridLab, { args: [...GRID, '--memory', 'selective', '--out', path.join(dir, 'a.json')], root: dir, llm, fetch: system2([]) }), /only the assisted researcher/);
  await assert.rejects(runLaboratory(gridLab, { args: [...GRID, '--researcher', 'assisted', '--memory', 'total', '--out', path.join(dir, 'b.json')], root: dir, llm, fetch: system2([]) }), /only memory is "selective"/);
  const { cellsLab } = await import('../src/worlds/cells/lab.ts');
  await assert.rejects(runLaboratory(cellsLab, { args: ['--seed', '1', '--flat', '--researcher', 'assisted', '--memory', 'selective', '--out', path.join(dir, 'c.json')], root: dir, llm, fetch: system2([]) }), /grid only/);
});
