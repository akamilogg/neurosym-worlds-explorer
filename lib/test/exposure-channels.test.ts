import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exposureOf } from '../src/learn/assisted/exposure.ts';
import { TeamBoard, boardExposure, type BoardEntry } from '../src/learn/assisted/board.ts';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';

/* SPEC-INVESTIGACION-EXTERNA §4.1.1: exposure carried by every channel between actors - the runs given as experience (a
   branch's cut among them), branch results, and what the team's board showed - from what its author had, never from citing. */

const EXPOSED = { direct: true, via: [], since: { event: 0, type: 'source_acquired' } };
const MODEL = { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]', validate: false, lessons: ['l'], next_experiment: 'n', beliefs: [] };

test('exposure through experience: a run given an exposed run as experience is exposed through it, from the start', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exposure-exp-'));
  /* A finished run of another world, exposed: it acquired a page. */
  fs.writeFileSync(path.join(dir, 'other.json'), JSON.stringify({ experiment: 'plates@1', researcher: 'assisted', config: { seed: 9 },
    events: [{ type: 'source_acquired', state: 'acquired', snapshot: 'S1' }, { type: 'end', stoppedBy: 'budget' }] }));
  fs.writeFileSync(path.join(dir, 'clean.json'), JSON.stringify({ experiment: 'plates@1', researcher: 'assisted', config: { seed: 8 }, events: [{ type: 'end', stoppedBy: 'budget' }] }));
  const fetch: FetchLike = async (_u, init) => {
    const user = JSON.parse(userOf(JSON.parse(String(init.body))));
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify('task' in user ? { rationale: 'r', beliefs: [], lessons: ['l'], next_experiment: 'n' } : MODEL) } }], usage: { total_tokens: 10 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
  const r = await runLaboratory(cellsLab, { args: ['--seed', '1', '--level', '1', '--researcher', 'assisted', '--flat', '--no-grade', '--no-reflection', '--no-ablation', '--attempts', '1',
    '--experience', 'clean.json,other.json', '--out', path.join(dir, 'run.json')], root: dir, llm: { url: 'http://x.test/v1/chat/completions', model: 's' }, fetch });
  const j = JSON.parse(fs.readFileSync(r.journal, 'utf8'));
  const given = j.events.find((e: any) => e.type === 'experience');
  assert.equal(given.runs[0].external_exposure, undefined, 'a run not exposed carries nothing');
  assert.equal(given.runs[1].external_exposure.direct, true);
  const x = exposureOf(j);
  assert.deepEqual([x.direct, x.via], [false, ['run:other.json']]);
  assert.equal(x.since?.type, 'experience');
});

test('exposure through the board: its author\'s exposure kept apart by the operator, never on the entry; a reader shown it is exposed through that peer', () => {
  const board = new TeamBoard(fs.mkdtempSync(path.join(os.tmpdir(), 'exposure-board-')), { id: 't', members: ['a', 'b'], window: 1, exchange: true, confirmations: 1 });
  const entry = (member: string, n: number): BoardEntry => ({ id: member + '#' + n, member, n, round: 1, window: 0, kind: 'result', claim: 'c', intervention: 'i', observed: 'o', scope: 's', world: [], evidence: [] } as never);
  board.publish(entry('a', 1), { places: [], keys: [], external_exposure: { ...EXPOSED, via: ['run:x.json'] } });
  board.publish(entry('b', 1), { places: [], keys: [] });
  assert.ok(!fs.readFileSync(path.join(board.dir, 'board', 'entries', 'a.1.json'), 'utf8').includes('external_exposure'), 'what its peers read carries no mark');
  assert.deepEqual(boardExposure(board, { peers: 'list' }, { entries: [{ id: 'a#1' }, { id: 'b#1' }] }), { direct: false, via: ['peer:a', 'run:x.json'], since: null });
  assert.equal(boardExposure(board, { peers: 'open', items: ['b#1'] }, {}), null, 'shown only what was not exposed');
  assert.deepEqual(boardExposure(board, { peers: 'open', item: 'a#1', evidence: 'ep1' }, {})?.via, ['peer:a', 'run:x.json']);
  /* The reader's record: exposed through the board, by that peer. */
  const x = exposureOf({ events: [{ type: 'peer_read', round: 2, peers: 'list', from: 'board', external_exposure: { direct: false, via: ['peer:a'], since: null } }] });
  assert.deepEqual([x.direct, x.via], [false, ['board', 'peer:a']]);
});

test('exposure through branch results: what its branch brought, in the record of whoever was given it', () => {
  const x = exposureOf({ events: [{ type: 'branch_result_given', id: 'delegation:r1.1', state: 'completed', from: 'branch:delegation:r1.1', external_exposure: { direct: true, via: ['branch:delegation:r1.1'], since: null } }] });
  assert.deepEqual([x.direct, x.via], [false, ['branch:delegation:r1.1']]);
});
