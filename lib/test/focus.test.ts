import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LabError, runLaboratory } from '../src/runtime/lab-runner.ts';
import { send } from '../src/runtime/control.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';
import { cellsInterface } from '../src/worlds/cells/interface.ts';
import { cellsFocusLine, differences } from '../src/worlds/cells/objective.ts';
import { generateCells, stepCells } from '../src/worlds/cells/world.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';


/* SPEC-INVESTIGADOR-ASISTIDO A5: a FACET of the task - what of the answer counts - at the start (either researcher) and,
   for the assisted researcher, changed by the operator during the run. Cells level 4: two layers in one row. */

test('level 4: two different elementary rules on the even and the odd cells of an even ring, each layer blind to the other', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const spec = generateCells(seed, 4);
    assert.ok(spec.layers && spec.layers[0] !== spec.layers[1], 'seed ' + seed);
    assert.equal(spec.width % 2, 0);
  }
  const spec = generateCells(1, 4);
  const row = Array.from({ length: spec.width }, (_, i) => (i * 7) % 3 === 0 ? 1 : 0);
  const other = row.map((v, i) => (i % 2 ? 1 - v : v));
  const a = stepCells(spec, row), b = stepCells(spec, other);
  assert.deepEqual(a.filter((_, i) => i % 2 === 0), b.filter((_, i) => i % 2 === 0), 'changing the odd cells does not touch the even ones');
});

test('a facet: only its positions are compared, and the interface says so; without one, nothing of the prompt changes', () => {
  assert.deepEqual(differences('ab.c', 'xbyc'), [0, 2]);
  assert.deepEqual(differences('ab.c', 'xbyc', 'odd'), []);
  assert.deepEqual(differences('ab.c', 'xbyc', 'even'), [0, 2]);
  assert.equal(cellsFocusLine('all'), null);
  assert.deepEqual(cellsInterface({ focus: 'all' }), cellsInterface());
  assert.ok(cellsInterface({ focus: 'even' }).lines.includes(cellsFocusLine('even')!));
});

/* --- A model right on one layer only: the even ring stepped under its rule, the odd cells left as they were. */
function oneLayer(spec: ReturnType<typeof generateCells>, parity: 0 | 1): string {
  const [g0, g1] = spec.glyphs, rule = spec.layers![parity];
  return '(p) => { const row = p.rows[p.rows.length - 1].split(""); const n = row.length, out = row.slice();'
    + ' for (let i = ' + parity + '; i < n; i += 2) { const v = (j) => row[((j % n) + n) % n] === ' + JSON.stringify(g1) + ' ? 1 : 0;'
    + ' const k = v(i - 2) * 4 + v(i) * 2 + v(i + 2); out[i] = ((' + rule + ' >> k) & 1) ? ' + JSON.stringify(g1) + ' : ' + JSON.stringify(g0) + '; }'
    + ' return out.join(""); }';
}

const SEED = 2;
const EVEN = oneLayer(generateCells(SEED, 4), 0);
/** System 2 stand-in: investigates in odd rounds, then proposes the even-layer model (from round `from`; the same row
    before); reflects; grades. */
function system2(asked: { system: string; user: Record<string, any> }[] = [], hook: (n: number) => void = () => {}, from = 0): FetchLike {
  return async (_url, init) => {
    const b = JSON.parse(String(init.body));
    const sys = b.messages[0].content as string, raw = userOf(b);
    const user = sys.startsWith('You grade') ? {} : JSON.parse(raw);
    if (!sys.startsWith('You grade')) { asked.push({ system: sys, user }); hook(asked.length); }
    const content = sys.startsWith('You grade') ? { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' }
      : 'task' in user ? { rationale: 'r', beliefs: [{ id: 'b', stance: 'confirm', why: 'w' }], lessons: ['l'], next_experiment: 'n' }
      : !user.investigation && user.round % 2 === 1 ? { investigate: [{ view: 'ep1', from: 0, to: 3 }] }
      : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: user.round >= from ? EVEN : '(p) => p.rows[p.rows.length - 1]', validate: true, beliefs: [{ id: 'b', stance: 'revise', statement: 's', evidence: ['ep1@2'] }], lessons: ['l'] };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
}
const ARGS = ['--seed', String(SEED), '--level', '4', '--attempts', '4', '--flat', '--no-grade'];
const llm = { url: 'http://system2.test/chat', model: 'stand-in' };
const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'focus-'));
const eventsOf = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8')).events as Record<string, any>[];

test('--focus even: a model right on the even layer only is accepted; without the focus, the same model is not', async () => {
  const dir = root();
  const asked: { system: string; user: Record<string, any> }[] = [];
  const focused = await runLaboratory(cellsLab, { args: [...ARGS, '--focus', 'even', '--out', path.join(dir, 'even.json')], root: dir, llm, fetch: system2(asked) });
  assert.equal(focused.stoppedBy, 'accepted');
  assert.ok(asked.every((q) => q.system.includes(cellsFocusLine('even')!)), 'the prompt says what counts');
  assert.equal(focused.researcherUsed, 'unknown-world', 'a focus at the start defines the task: the pure researcher takes it');
  assert.equal(JSON.parse(fs.readFileSync(focused.journal, 'utf8')).config.focus, 'even');
  assert.equal(focused.finding.question.focus, 'even');
  const whole = await runLaboratory(cellsLab, { args: [...ARGS, '--out', path.join(dir, 'all.json')], root: dir, llm, fetch: system2() });
  assert.notEqual(whole.stoppedBy, 'accepted');
  assert.equal(whole.finding.question.focus, undefined);
});

test('what the configuration cannot take is a LabError: a facet the laboratory lacks, a task for the pure researcher', async () => {
  const dir = root();
  const base = (args: string[]) => ({ args: [...ARGS, ...args, '--out', path.join(dir, 'x.json')], root: dir, llm, fetch: system2() });
  await assert.rejects(runLaboratory(cellsLab, base(['--focus', 'middle'])), (e) => e instanceof LabError && /facets: all, even, odd/.test(e.message));
  await assert.rejects(runLaboratory(cellsLab, base(['--task', 'the even cells'])), (e) => e instanceof LabError && /assisted/.test(e.message));
});

test('assisted: a task goes with every question; a focus sent during the run is applied with the next question', async () => {
  const dir = root();
  const asked: { system: string; user: Record<string, any> }[] = [];
  let journal = '';
  const r = await runLaboratory(cellsLab, { args: [...ARGS, '--researcher', 'assisted', '--task', 'how the even cells change', '--out', path.join(dir, 'run.json')], root: dir, llm,
    onJournal: (f) => { journal = f; },
    fetch: system2(asked, (n) => { if (n === 2) { send(journal, { kind: 'focus', facet: 'middle', by: 'operator' }); send(journal, { kind: 'focus', facet: 'even', task: 'the even layer', by: 'operator' }); } }) });
  assert.equal(r.stoppedBy, 'accepted');
  assert.ok(asked.every((q) => q.user.operator_task), 'the task, with every question');
  assert.equal(asked[0].user.operator_task, 'how the even cells change');
  assert.ok(!asked[1].system.includes('WHAT COUNTS') && asked[2].system.includes(cellsFocusLine('even')!), 'the prompt says what counts from the question it went with');
  assert.equal(asked[2].user.operator_task, 'the even layer');
  assert.match(asked[2].user.operator_messages.new[0].text, /facet "even"/);
  const events = eventsOf(r.journal);
  assert.match(events.find((e) => e.type === 'operator_command_refused')!.reason, /no facet "middle"/);
  assert.deepEqual(events.filter((e) => e.type === 'focus_changed').map(({ t: _t, ...e }) => e), [{ type: 'focus_changed', question: 3, facet: 'even', task: 'the even layer' }]);
  assert.equal(r.finding.assistance!.focus_changes.length, 1);
});

test('assisted, cut and resumed: the focus is applied again at the same question, and the replay recognises every request', async () => {
  const dir = root();
  let journal = '';
  const hook = (n: number) => { if (n === 2) send(journal, { kind: 'focus', facet: 'even', by: 'operator' }); };
  /* The right model comes late (round 4), so that the cut falls after the focus and before the acceptance. */
  const run = (name: string, more: string[]) => runLaboratory(cellsLab, { args: [...ARGS, '--researcher', 'assisted', ...more, '--out', path.join(dir, name)], root: dir, llm, onJournal: (f) => { journal = f; }, fetch: system2([], hook, 4) });
  const whole = await run('whole.json', []);
  const cut = await run('cut.json', ['--max-tokens', '350']);
  assert.equal(cut.stoppedBy, 'token_budget');
  const resumed = await runLaboratory(cellsLab, { args: ['--resume', cut.journal, '--out', path.join(dir, 'resumed.json')], root: dir, llm, fetch: system2([], () => {}, 4) });
  assert.ok(eventsOf(cut.journal).some((e) => e.type === 'focus_changed'), 'the cut came after the focus');
  assert.equal(resumed.stoppedBy, 'accepted', 'it did not diverge, and the focus holds after the resume');
  const strip = (f: string) => JSON.stringify(eventsOf(f).filter((e) => !['start', 'end', 'operator_command'].includes(e.type))
    .map(({ t: _t, ...e }) => (e.type === 'operator_message' ? { ...e, messages: e.messages.map(({ at: _a, ...m }: Record<string, unknown>) => m) } : e)))
    .replace(/order-[a-z0-9]+-\d+-\d+/g, 'order');
  assert.equal(strip(resumed.journal), strip(whole.journal));
});

test('the pure researcher refuses a focus order during the run, and never logs what it said', async () => {
  const dir = root();
  let journal = '';
  const r = await runLaboratory(cellsLab, { args: [...ARGS, '--out', path.join(dir, 'pure.json')], root: dir, llm, onJournal: (f) => { journal = f; },
    fetch: system2([], (n) => { if (n === 2) send(journal, { kind: 'focus', facet: 'even', task: 'secret words', by: 'operator' }); }) });
  const events = eventsOf(r.journal);
  assert.ok(events.some((e) => e.type === 'operator_command_refused' && e.kind === 'focus'));
  assert.ok(!events.some((e) => e.type === 'focus_changed'));
  assert.ok(!fs.readFileSync(r.journal, 'utf8').includes('secret words'));
});
