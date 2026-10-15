import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { send } from '../src/runtime/control.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';
import { gridLab } from '../src/worlds/grid/lab.ts';
import { BUDGET_SECTION } from '../src/learn/assisted/session.ts';
import type { FetchLike } from '../src/core/net.ts';

/* SPEC-INVESTIGADOR-ASISTIDO §15: the assisted researcher knows the rounds it has left and, with a help budget, the help it
   may still be given - two counters with its others, in the messages its conversation adds; never how to spend them. */

type Message = { role: string; content: string };
const llm = { url: 'http://system2.test/chat', model: 'stand-in' };
const parts = (m: Message[]): Record<string, any>[] => m.slice(1).map((x) => { try { return JSON.parse(x.content); } catch { return {}; } });
/** The budget as it stands at a question: pinned in its channel (SPEC-CANAL-MENSAJES), the latest value - or, where there
    is no channel (the grid, until it has one), the latest part whose counters carry it. */
const latest = (m: Message[]): Record<string, any> => {
  const pinned = parts(m).flatMap((p) => p.channel?.pinned ?? []).filter((x: any) => x.key === 'harness:budget');
  return pinned.length ? pinned[pinned.length - 1].value : [...parts(m)].reverse().find((p) => 'rounds_left' in p) ?? {};
};

/** The junior standing in: it looks once a round, then proposes the same model. */
function junior(asked: Message[][], hook: (n: number) => void = () => {}): FetchLike {
  return async (_url, init) => {
    const b = JSON.parse(String(init.body));
    const messages = b.messages as Message[];
    const grading = messages[0].content.startsWith('You grade');
    if (!grading) { asked.push(messages); hook(asked.length); }
    const ps = parts(messages);
    const first = ps[0] ?? {};
    const content = grading ? { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' }
      : 'task' in first ? { rationale: 'r', beliefs: [{ id: 'same', stance: 'keep', why: 'w' }], lessons: ['l'], next_experiment: 'n' }
      : !ps.some((p) => p.investigation_step) ? { investigate: [{ view: 'ep1', from: 0, to: 2 }] }
      : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]', validate: false,
        beliefs: [{ id: 'same', stance: first.round === 1 ? 'new' : 'keep', statement: 'the row repeats', evidence: [] }], lessons: ['l'], next_experiment: 'n' };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
}
const ARGS = ['--seed', '1', '--level', '1', '--flat', '--no-grade', '--tools', 'view', '--researcher', 'assisted'];

test('the assisted researcher knows its rounds left and the help it may still be given, with its other counters', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-'));
  const asked: Message[][] = [];
  let journal = '';
  const r = await runLaboratory(cellsLab, { args: [...ARGS, '--attempts', '3', '--help-budget', '2', '--out', path.join(dir, 'run.json')], root: dir, llm,
    onJournal: (f) => { journal = f; }, fetch: junior(asked, (n) => { if (n === 2) send(journal, { kind: 'message', text: 'look at the neighbours', by: 'operator' }); }) });
  const rounds = asked.filter((m) => !('task' in (parts(m)[0] ?? {})));
  assert.ok(rounds.length >= 6);
  assert.ok(asked.every((m) => m[0].content.includes(BUDGET_SECTION(true))), 'its system prompt says what they are, once');
  for (const m of rounds) assert.equal(latest(m).rounds_left, 3 - parts(m)[0].round + 1, 'this round included');
  const help = rounds.map((m) => latest(m).help_left);
  assert.equal(help[0], 2);
  assert.equal(help.at(-1), 1, 'one message of help was given');
  const journalOf = JSON.parse(fs.readFileSync(r.journal, 'utf8'));
  assert.equal(journalOf.config.budget_visible, true);
  assert.equal(journalOf.config.capabilities_from.budget, 0);
  /* Resumed from its log: told what it was told, so nothing diverges. */
  const resumed = await runLaboratory(cellsLab, { args: ['--resume', r.journal, '--attempts', '4', '--out', path.join(dir, 'more.json')], root: dir, llm, fetch: junior([]) });
  assert.notEqual(resumed.stoppedBy, 'diverged');
});

test('without a help budget only the rounds; --budget-hidden and the unknown-world researcher: neither, and no section', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-hidden-'));
  const asked: Message[][] = [];
  await runLaboratory(cellsLab, { args: [...ARGS, '--attempts', '2', '--out', path.join(dir, 'plain.json')], root: dir, llm, fetch: junior(asked) });
  assert.ok(asked.every((m) => m[0].content.includes(BUDGET_SECTION(false))));
  assert.ok(asked.every((m) => !JSON.stringify(parts(m)).includes('help_left')));
  const pure = ARGS.filter((a) => a !== '--researcher' && a !== 'assisted');
  for (const [name, args] of [['hidden', [...ARGS, '--budget-hidden']], ['pure', pure]] as const) {
    const seen: Message[][] = [];
    await runLaboratory(cellsLab, { args: [...args, '--attempts', '2', '--out', path.join(dir, name + '.json')], root: dir, llm, fetch: junior(seen) });
    assert.ok(seen.length > 0);
    assert.ok(seen.every((m) => !m[0].content.includes('YOUR BUDGET') && !JSON.stringify(parts(m)).includes('rounds_left')), name);
  }
});

test('the grid, likewise: its rounds left with its counters, its section once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-grid-'));
  const asked: Message[][] = [];
  const grid: FetchLike = async (_url, init) => {
    const b = JSON.parse(String(init.body));
    const messages = b.messages as Message[];
    const grading = messages[0].content.startsWith('You grade');
    if (!grading) asked.push(messages);
    const first = parts(messages)[0] ?? {};
    const content = grading ? { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' }
      : 'task' in first ? { rationale: 'r', beliefs: [{ id: 'b', stance: 'keep', why: 'w' }], lessons: ['l'], next_experiment: 'n' }
      : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p, m) => 0.5', validate: false, beliefs: [{ id: 'b', stance: first.round === 1 ? 'new' : 'keep', statement: 's' }], lessons: ['l'] };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
  await runLaboratory(gridLab, { args: ['--seed', '22', '--explore', '1', '--variants', '1', '--family', '1', '--family-variants', '1', '--confirm-places', '1', '--levels', '2', '--depth', '1',
    '--steps', '0', '--flat', '--no-ablation', '--no-grade', '--attempts', '2', '--researcher', 'assisted', '--out', path.join(dir, 'grid.json')], root: dir, llm, fetch: grid });
  const rounds = asked.filter((m) => !('task' in (parts(m)[0] ?? {})));
  assert.ok(rounds.length >= 2);
  assert.ok(asked.every((m) => m[0].content.includes(BUDGET_SECTION(false))));
  assert.deepEqual([...new Set(rounds.map((m) => latest(m).rounds_left))], [2, 1]);
});
