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
  /* Written alone, outside "investigate" (as Qwen did): run as a request, and said so; for the pure researcher, a proposal. */
  const bare = JSON.stringify({ memory: 'open', items: ['note:n1'] });
  const ran = parseExplorerTurn(bare, { ...ctx, extraRequest: JournalMemory.accepts, archive: true }) as { kind: string; requests: unknown[]; warnings: string[] };
  assert.deepEqual([ran.kind, ran.requests], ['investigate', [{ extra: { memory: 'open', items: ['note:n1'] } }]]);
  assert.match(ran.warnings[0], /inside "investigate"/);
  assert.equal(parseExplorerTurn(bare, ctx).kind, 'proposal');
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

test("a selective memory is the assisted researcher's", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-'));
  await assert.rejects(runLaboratory(gridLab, { args: [...GRID, '--memory', 'selective', '--out', path.join(dir, 'a.json')], root: dir, llm, fetch: system2([]) }), /only the assisted researcher/);
  await assert.rejects(runLaboratory(gridLab, { args: [...GRID, '--researcher', 'assisted', '--memory', 'total', '--out', path.join(dir, 'b.json')], root: dir, llm, fetch: system2([]) }), /only memory is "selective"/);
});

/* --- The same memory in a world whose model is a law (cells): its episodes and models come from the run, not the notebook. */
test("in a world of laws: the abridged notebook with the run's episodes and models, free recalls, a bare request, the finding", async () => {
  const { cellsLab } = await import('../src/worlds/cells/lab.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-'));
  const asked: Record<string, any>[] = [];
  const fetch: FetchLike = async (_url, init) => {
    const b = JSON.parse(String(init.body));
    const sys = b.messages[0].content as string, raw = b.messages[b.messages.length - 1].content as string;
    const user = JSON.parse(raw);
    asked.push({ system: sys, user });
    const done = (user.investigation ?? []).length;
    const content = /"task"/.test(raw) ? { rationale: 'r', beliefs: [{ id: 'b', stance: 'confirm', why: 'w' }], lessons: ['l'], next_experiment: 'n' }
      : user.round === 2 && done === 0 ? { investigate: [{ memory: 'list', of: 'models' }] }
      : user.round === 2 && done === 1 ? { memory: 'open', items: ['model:r1', 'episode:ep1'] }
      : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]', validate: false,
        beliefs: [{ id: 'b', stance: user.round === 1 ? 'new' : 'keep', statement: 's', evidence: ['ep1@2'] }], lessons: ['l'] };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
  const r = await runLaboratory(cellsLab, { args: ['--seed', '1', '--level', '1', '--attempts', '2', '--flat', '--no-grade', '--researcher', 'assisted', '--memory', 'selective',
    '--out', path.join(dir, 'run.json')], root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch });
  assert.ok(asked[0].system.endsWith(MEMORY_SECTION));
  const second = asked.filter((a) => a.user.round === 2);
  assert.equal(second[0].user.notebook.models.length, 1);
  assert.ok(second[0].user.notebook.models[0].model, 'the latest model whole');
  assert.ok(second[0].user.notebook.memory.episodes > 0, "the run's episodes are in its memory");
  assert.equal(second[1].user.steps_left, second[0].user.steps_left, 'a memory answer is free');
  assert.equal(second[1].user.memory_answers_left, FREE_MEMORY_ANSWERS - 1);
  const opened = second[2].user.investigation[1];
  assert.match(opened.warnings.join(' '), /inside "investigate"/);
  assert.ok(opened.results[0].items[0].item.model, 'model:r1 opened whole');
  assert.equal(opened.results[0].items[1].id, 'episode:ep1');
  assert.deepEqual(r.finding.assistance?.memory?.listed, ['models']);
  assert.deepEqual(r.finding.assistance?.memory?.opened, ['model:r1', 'episode:ep1']);
});

test('with no steps left, the memory requests of an answer are still answered (the rest not, and said so), and it then proposes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-'));
  const asked: Record<string, any>[] = [];
  const fetch: FetchLike = async (_url, init) => {
    const b = JSON.parse(String(init.body));
    const user = JSON.parse(b.messages[b.messages.length - 1].content as string);
    asked.push(user);
    const done = (user.investigation ?? []).length;
    const content = user.round === 1 && done === 0 ? { investigate: [{ view: 'g1', from: 0, to: 2 }] }
      : user.round === 1 && done === 1 ? { investigate: [{ memory: 'list', of: 'episodes' }, { view: 'g2', from: 0, to: 2 }] }
      : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p, m) => 0.5', validate: false, beliefs: [{ id: 'b', stance: user.round === 1 ? 'new' : 'keep', statement: 's' }], lessons: ['l'] };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
  const r = await runLaboratory(gridLab, { args: [...GRID, '--steps', '1', '--attempts', '1', '--researcher', 'assisted', '--memory', 'selective', '--out', path.join(dir, 'run.json')], root: dir, llm, fetch });
  assert.notEqual(r.stoppedBy, 'no_first_proposal');
  assert.deepEqual([asked[1].steps_left, asked[1].memory_answers_left], [0, FREE_MEMORY_ANSWERS]);
  const step2 = asked[2].investigation[1];
  assert.deepEqual(step2.requests, [{ memory: 'list', of: 'episodes' }], 'only the memory request was run');
  assert.match(step2.warnings.join(' '), /only your memory requests were answered/);
  assert.equal(asked[2].memory_answers_left, FREE_MEMORY_ANSWERS - 1);
  assert.equal(asked[2].investigation[0].results.length, 1, 'this round\'s investigation travels whole');
});

test('the assisted researcher may insist on investigating with no steps left a few times (logged) before it is a refusal', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-'));
  /* It investigates once (its only step), insists 4 more times, then proposes. */
  const stubborn = (): FetchLike => {
    let round1 = 0;
    return async (_url, init) => {
      const b = JSON.parse(String(init.body));
      const user = JSON.parse(b.messages[b.messages.length - 1].content as string);
      const content = user.round === 1 && ++round1 <= 5 ? { investigate: [{ view: 'g1', from: 0, to: 2 }] }
        : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p, m) => 0.5', validate: false, beliefs: [{ id: 'b', stance: user.round === 1 ? 'new' : 'keep', statement: 's' }], lessons: ['l'] };
      const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
      return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
    };
  };
  const args = [...GRID, '--steps', '1', '--attempts', '1'];
  const helped = await runLaboratory(gridLab, { args: [...args, '--researcher', 'assisted', '--out', path.join(dir, 'a.json')], root: dir, llm, fetch: stubborn() });
  assert.notEqual(helped.stoppedBy, 'no_first_proposal');
  const events = JSON.parse(fs.readFileSync(helped.journal, 'utf8')).events.filter((e: { type: string }) => e.type === 'investigation_refused');
  assert.deepEqual(events.map((e: { reminders_left: number }) => e.reminders_left), [2, 1, 0]);
  const pure = await runLaboratory(gridLab, { args: [...args, '--out', path.join(dir, 'p.json')], root: dir, llm, fetch: stubborn() });
  assert.equal(pure.stoppedBy, 'no_first_proposal', 'the unknown-world researcher as it was');
});
