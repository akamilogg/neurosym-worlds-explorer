import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { processTraces } from '../src/orchestra/traces.ts';
import { groupResults } from '../src/orchestra/results.ts';

/* SPEC-CONTROL-ARNES K4 (§4.3): traces of the process, described - rounds to the first model that holds, steps by type,
   proposals returned, the senior's directives and what the junior said of each - never as a performance. */

const journal = {
  experiment: 'cells@1', researcher: 'assisted', config: { seed: 1, level: 1, llm_model: 'm' }, started: new Date().toISOString(),
  events: [
    { t: 1, type: 'investigation', round: 1, requests: [{ view: {} }, { act: {} }, { memory: 'list' }, { something_new: {} }, { table: {} }] },
    { t: 2, type: 'proposal_refused', round: 1 },
    { t: 3, type: 'proposal', round: 1 },
    { t: 4, type: 'check', round: 1, laboratories: [{ place: 'lab1', holds: false }] },
    { t: 5, type: 'operator_message', question: 3, messages: [{ id: 'd1', directive: true, by: 'agent:senior', text: 'run it' }, { id: 'd2', directive: true, by: 'agent:senior', text: 'drop that' }, { id: 'm1', by: 'operator', text: 'hi' }] },
    { t: 6, type: 'directive_report', question: 4, id: 'd1', done: 'ran it in lab1' },
    { t: 6, type: 'junior_report', question: 4, text: 'I disagree on the second: my episodes 3 and 4 say otherwise' },
    { t: 7, type: 'proposal', round: 2 },
    { t: 8, type: 'check', round: 2, laboratories: [{ place: 'lab1', holds: true }, { place: 'lab2', holds: true }] },
    { t: 9, type: 'end', stoppedBy: 'budget' }
  ]
};

test('the traces of a run, as they happened: no valuation in them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traces-'));
  const file = path.join(dir, 'run.json');
  fs.writeFileSync(file, JSON.stringify(journal));
  const t = processTraces(file);
  assert.equal(t.rounds, 2);
  assert.equal(t.first_round_holding_in_its_laboratories, 2);
  assert.deepEqual({ ...t.steps, by_request: undefined }, { looking: 2, experimenting: 1, recalling: 1, other: 1, by_request: undefined });
  assert.equal(t.steps.by_request.something_new, 1, 'a kind of request it does not know is counted by its name, as other');
  assert.equal(t.proposals_returned, 1);
  assert.deepEqual(t.directives, { given: 2, reported_carried_out: 1, reported_not_carried_out: 0, not_reported: 1 });
  assert.equal(t.told_its_senior, 1);
  assert.equal(t.other_help, 1);
  assert.ok(!/loss|perform(ed|s) (well|badly)|waste/i.test(JSON.stringify(t)), 'described, not valued');

  /* In a group's results: described across its runs. */
  const second = path.join(dir, 'run2.json');
  fs.writeFileSync(second, JSON.stringify({ ...journal, config: { ...journal.config, seed: 2 }, events: journal.events.filter((e) => e.type !== 'check' || e.round === 1) }));
  const [g] = groupResults([{ condition: 'c', journal: file }, { condition: 'c', journal: second }]);
  assert.equal(g.runs, 2);
  assert.equal(g.process.runs_never_holding, 1);
  assert.deepEqual(g.process.directives, { given: 4, reported_carried_out: 2, reported_not_carried_out: 0, not_reported: 2 });
  assert.match(g.process.reading, /never their performance/);
});
