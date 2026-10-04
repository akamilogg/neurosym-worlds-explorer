import test from 'node:test';
import assert from 'node:assert/strict';
import { RESEARCH_PAGE } from '../src/console/page.ts';

/* The trajectory by rounds of the research console: what each round shows is read from the events as the snapshot gives
   them - the check (scored 1 of how many, or held), episodes that did worse again, the model (and a return to an earlier
   one), the steps by kind, the beliefs moved, the operator's messages, a replay of an earlier round's model. */

const script = RESEARCH_PAGE.match(/<script>([\s\S]*)<\/script>/)![1];

/** The page's own round reading, taken out of the page and run as it is. */
function roundsOf(events: unknown[]): any[] {
  const from = script.indexOf('const EXP='), to = script.indexOf('function drawRounds');
  return new Function(script.slice(from, to) + '\nreturn roundsOf(arguments[0]);')(events);
}

test('the page script parses', () => {
  assert.doesNotThrow(() => new Function(script));
});

test('rounds read from events: checks, regressions, models and returns, steps by kind, beliefs, messages, replays of an earlier model', () => {
  let seq = 0;
  const ev = (type: string, round: number | null, data: object) => ({ id: String(++seq), entity: 'run', sequence: seq, type, round, at: null, data });
  const rounds = roundsOf([
    ev('investigation', 1, { requests: [{ view: 'g1', from: 0, to: 3 }, { act: 'g1@0', from: [0, 4], to: [1, 4] }, { memory: 'list', of: 'notes' }] }),
    ev('proposal', 1, { formula: { output: 'A' }, beliefs: [{ id: 'b', stance: 'new' }] }),
    ev('check', 1, { laboratories: [{ place: 'lab1', holds: false, wins: 3, total: 8, rerun: { went_down: 2 } }] }),
    ev('operator_message', null, { messages: [{ id: 'm', text: 'try', by: 'agent:senior' }] }),
    ev('investigation', 2, { requests: [{ replay: 'g1@0', formula: 1 }] }),
    ev('proposal', 2, { formula: { output: 'B' }, beliefs: [{ id: 'b', stance: 'revise' }, { id: 'c', stance: 'drop' }] }),
    ev('check', 2, { laboratories: [{ place: 'lab1', holds: true, wins: 8, total: 8 }], accepted: true }),
    ev('proposal', 3, { formula: { output: 'A' }, beliefs: [] }),
    ev('check', 3, { laboratories: [{ place: 'lab1', holds: false, points: 64, exact: null }] })
  ]);
  assert.deepEqual(rounds.map((r) => r.n), [1, 2, 3]);
  assert.deepEqual([rounds[0].check.w, rounds[0].check.t, rounds[0].check.holds, rounds[0].check.down], [3, 8, false, 2]);
  assert.deepEqual(rounds[0].steps, { exp: 1, obs: 1, rec: 1 });
  assert.equal(rounds[1].msgs.length, 1, 'the message goes with the round it reached');
  assert.deepEqual(rounds[1].retakes, [1], 'a replay of the model of round 1');
  assert.deepEqual([rounds[1].check.accepted, rounds[1].beliefs.revise, rounds[1].beliefs.drop], [true, 1, 1]);
  assert.equal(rounds[2].proposals[0].back, 1, 'the model of round 1 again');
  assert.deepEqual([rounds[2].check.t, rounds[2].check.share], [0, null], 'a world that gives no score per point: held or not, nothing invented');
});
