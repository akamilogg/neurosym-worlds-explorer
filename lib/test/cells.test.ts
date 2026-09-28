import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCells, lively, placeOf, readRow, renderRow, runEpisode, stepCells, describeCellsTruth, type CellsSpec } from '../src/worlds/cells/world.ts';
import { cellsObjective, differences, CELLS_ANSWER, cellsVerdict } from '../src/worlds/cells/objective.ts';
import { cellsInterface } from '../src/worlds/cells/interface.ts';
import { LawSession, lawFingerprint } from '../src/learn/law-session.ts';
import { system2Prompt } from '../src/learn/prompt.ts';
import type { Place } from '../src/learn/objective.ts';

/* cells@1: the third world (SPEC-OBJETIVO O5), connected with only its world, senses, actions and objective. */

const rule110: CellsSpec = { id: 't', seed: 0, level: 1, width: 8, radius: 1, rule: 110, glyphs: ['.', '#'], density: 0.5, steps: 3 };

test('the ring steps by its local rule, wrapping around; the family keeps the rule and changes the length', () => {
  /* Rule 110 from a single second symbol: 111->0, 110->1, 101->1, 100->0, 011->1, 010->1, 001->1, 000->0. */
  assert.equal(renderRow(rule110, stepCells(rule110, readRow(rule110, '.......#')!)), '......##');
  assert.equal(renderRow(rule110, stepCells(rule110, readRow(rule110, '#.......')!)), '#......#', 'the first cell has the last as a neighbour');
  assert.equal(readRow(rule110, '..'), null);
  assert.equal(readRow(rule110, '.......x'), null);
  assert.equal(runEpisode(rule110, readRow(rule110, '.......#')!).length, 4);
  const spec = generateCells(1, 1);
  const other = placeOf(spec, 2);
  assert.equal(other.rule, spec.rule);
  assert.deepEqual(other.glyphs, spec.glyphs);
  assert.equal(placeOf(spec, 0), spec);
  assert.equal(generateCells(1, 2).radius, 2);
  assert.match(describeCellsTruth(rule110)[2].statement, /\.\.# -> #/);
});

test('the generator draws only lively rules: none that empties or freezes the rows', () => {
  assert.equal(lively({ radius: 2, rule: 32 }), false, 'only five of five: every row empties at once');
  assert.equal(lively({ radius: 1, rule: 204 }), false, 'the identity freezes');
  assert.equal(lively({ radius: 1, rule: 110 }), true);
  for (const level of [1, 2]) for (let seed = 1; seed <= 6; seed++) assert.ok(lively(generateCells(seed, level)), 'seed ' + seed + ' level ' + level);
});

test('the verdict is where the answer differs; the model holds when every point is exact, also on the previous check', async () => {
  assert.deepEqual(differences('ab.c', 'abxc'), [2]);
  assert.equal(differences(3, 'abc'), null);
  assert.equal(differences('ab', 'abc'), null);
  const lab: Place = { id: 'lab1', role: 'laboratory', seen: true };
  const o = cellsObjective<string, Place>({
    casesIn: () => [{ point: 'e@0', state: { rows: ['..#'] }, next: '.##' }, { point: 'e@1', state: { rows: ['..#', '.##'] }, next: '###' }],
    answer: async (m, s) => (m === 'good' ? { '..#': '.##', '.##': '###' }[s.rows[s.rows.length - 1]] : m === 'throws' ? (() => { throw new Error('boom'); })() : 'no'),
    regression: true
  });
  const run = async (m: string) => (await o.run(m, [{ place: lab, cases: await o.casesIn(lab, { round: 1, attempt: 1, purpose: 'check', index: 0 }) }], { round: 1, attempt: 1, purpose: 'check' })).byPlace[0];
  const good = await run('good'), bad = await run('bad'), thrown = await run('throws');
  assert.equal(o.holds(good, { place: lab }), true);
  assert.equal(o.holds(bad, { place: lab }), false);
  assert.deepEqual(o.view(bad, lab), { points: [{ point: 'e@0', not_a_row_of_that_length: true }, { point: 'e@1', not_a_row_of_that_length: true }] });
  assert.equal((o.view(thrown, lab).points as { error?: string }[])[0].error, 'boom');
  assert.equal(o.holds(good, { place: lab, rerun: { before: good, now: bad } }), false);
  assert.deepEqual(o.operatorView!(good, lab), { exact: 2, points: 2, cells_wrong: 0, not_a_row: 0 });
  /* The journal's trace (operator only): what the model answered against what came; System 2's view has none of it. */
  assert.deepEqual(o.trace!(good, lab), [{ point: 'e@0', before: '..#', answer: '.##', came: '.##' }, { point: 'e@1', before: '.##', answer: '###', came: '###' }]);
  assert.equal(o.trace!(thrown, lab)[0] && (o.trace!(thrown, lab)[0] as { error?: string }).error, 'boom');
  assert.ok(!JSON.stringify(o.view(good, lab)).includes('###'), 'the view shows no answer and no row that came');
});

test('its interface is the common prompt\'s: the objective\'s lines first, and no word about what the world is', () => {
  const i = cellsInterface();
  assert.deepEqual(i.lines.slice(0, 3), [...CELLS_ANSWER.form, ...cellsVerdict()]);
  const text = system2Prompt(cellsInterface({ regression: true }));
  for (const w of ['cell', 'ring', 'automat', 'neighbo', 'wrap']) assert.doesNotMatch(text, new RegExp('\\b' + w, 'i'), w);
  assert.match(text, /answered again there by this model/);
});

test('a session: an investigation step, then a proposal; a draft travels back as written, and a model has a fingerprint', async () => {
  const draft = { observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]' };
  const answers = [{ investigate: [{ act: { row: '..#' } }, { inspect: 'e@0', model: draft }] }, { rationale: 'r', beliefs: [{ id: 'b', stance: 'new', statement: 's' }], ...draft, validate: true, lessons: ['l'] }];
  const seen: Record<string, unknown>[] = [];
  const events: string[] = [];
  const session = new LawSession<{ row: string }>({
    llm: { complete: async (r) => { seen.push(r.user as Record<string, unknown>); return { content: JSON.stringify(answers.shift()), latencyMs: 0, raw: null }; } },
    system: 'S', world: 'cells@1', perceptDoc: 'P', steps: 2, investigative: true, acts: 1,
    parseAct: (raw) => (typeof raw.row === 'string' ? { row: raw.row } : 'act needs "row"'),
    runRequest: async (r, budget) => ('act' in r ? { accepted: true, left: --budget.acts } : { inspected: true }),
    known: () => true, failures: () => [], episodes: () => [{ episode: 'e' }],
    places: () => [{ place: 'lab1' }], validationsLeft: () => 3, lastCheck: () => null,
    log: (type) => { events.push(type); }, say: () => {}
  });
  const record = await session.consult('propose');
  assert.ok(record && record.validate && record.round === 1);
  assert.equal(record!.fingerprint, lawFingerprint(record!.law));
  assert.equal(seen[0].acts_left, 1);
  const inv = (seen[1].investigation as { requests: { inspect?: string; model?: { output?: string } }[]; results: unknown[] }[])[0];
  assert.equal(inv.requests[1].model!.output, draft.output, 'the draft as it wrote it');
  assert.deepEqual(inv.results[0], { accepted: true, left: 0 });
  assert.deepEqual(events, ['investigation', 'proposal']);
  assert.deepEqual((session.notebookBrief().models as unknown[]).length, 1);
});

test('level 3 is of second order: the same present row after different rows before leads to different next rows', () => {
  const spec = generateCells(1, 3);
  assert.equal(spec.order, 2);
  assert.ok(lively(spec));
  /* From the same present row, two different rows before it. */
  const now = readRow(spec, spec.glyphs[1].repeat(spec.width))!;
  const a = runEpisode(spec, [readRow(spec, spec.glyphs[0].repeat(spec.width))!, now]);
  const b = runEpisode(spec, [now, now]);
  assert.equal(a[1], b[1], 'the same present row');
  assert.notEqual(a[2], b[2], 'the row before it decides the next');
  assert.equal(runEpisode(spec, now).length, spec.steps + 1, 'a single row: the row before it is taken to be the same');
  assert.equal(runEpisode(spec, () => 0.3).length, spec.steps + 2, 'drawn at random: two rows to start from');
  assert.match(describeCellsTruth(spec).map((t) => t.id).join(','), /history/);
});
