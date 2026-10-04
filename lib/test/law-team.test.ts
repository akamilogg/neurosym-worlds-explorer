import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';
import { LABS } from '../src/worlds/labs.ts';
import { TeamBoard } from '../src/learn/assisted/board.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';

/* SPEC-INVESTIGACION-PARALELA §5 in a world of laws: the same team and board as in the grid - a member publishes with the
   records behind its evidence, another reads the version its round opens - with the world's own episodes, acts and steps. */

type Script = (user: Record<string, any>, done: number) => unknown | null;
const PROPOSAL = (round: number, evidence: string[] = []) => ({ rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]',
  validate: false, beliefs: [{ id: 'b', stance: round === 1 ? 'new' : 'keep', statement: 's', ...(evidence.length ? { evidence } : {}) }], lessons: ['l'] });
function system2(script: Script, asked: Record<string, any>[] = []): FetchLike {
  return async (_url, init) => {
    const b = JSON.parse(String(init.body));
    const sys = b.messages[0].content as string;
    const user = JSON.parse(userOf(b));
    asked.push({ system: sys, user });
    const content = sys.startsWith('You grade') ? { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' }
      : 'task' in user ? { rationale: 'r', beliefs: [{ id: 'b', stance: 'keep', why: 'w' }], lessons: ['l'], next_experiment: 'n' }
      : script(user, (user.investigation ?? []).length) ?? PROPOSAL(user.round);
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
}
const tmp = (prefix: string): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const llm = { url: 'http://system2.test/chat', model: 'stand-in' };
const CELLS = ['--seed', '1', '--level', '1', '--attempts', '2', '--flat', '--no-grade', '--no-reflection'];
const events = (journal: string, type: string): Record<string, any>[] => JSON.parse(fs.readFileSync(journal, 'utf8')).events.filter((e: { type: string }) => e.type === type);

/* a: round 1 looks, acts from the first row it saw, and publishes what it found with its evidence. */
const memberA: Script = (user, done) => {
  if (user.round !== 1) return null;
  if (done === 0) return { investigate: [{ view: 'ep1', from: 0, to: 2 }] };
  if (done === 1) return { investigate: [{ act: { row: user.investigation[0].results[0].rows[0].row } }] };
  if (done === 2) return { investigate: [{ publish: { kind: 'result', claim: 'the row moves on as seen', intervention: 'started from the first row', observed: 'the same steps',
    evidence: ['ep1', 'ep1@1', user.investigation[1].results[0].name, 'r1.2'] } }] };
  return null;
};
/* b: the board is closed in round 1; in round 2 it reads it, opens a's entry and the record behind one piece of evidence. */
const memberB: Script = (user, done) => {
  if (user.round === 1 && done === 0) return { investigate: [{ peers: 'list' }] };
  if (user.round === 2 && done === 0) return { investigate: [{ peers: 'list' }, { peers: 'open', items: ['a#1'] }] };
  if (user.round === 2 && done === 1) {
    const act = user.investigation[0].results[1].items[0].evidence.find((x: { ref: string }) => x.ref.startsWith('act')).ref;
    return { investigate: [{ peers: 'open', item: 'a#1', evidence: act }] };
  }
  if (user.round === 2) return PROPOSAL(2, ['peer:a#1', 'ep1@0']);
  return null;
};

test('a world of laws in a team: a member publishes with the records behind its evidence; another reads the version its round opens; resumed, the same', async () => {
  const dir = tmp('law-team-');
  const teamDir = path.join(dir, 'team');
  new TeamBoard(teamDir, { id: 'pair', members: ['a', 'b'], window: 1, exchange: true, confirmations: 1 });
  const askedB: Record<string, any>[] = [];
  const member = (id: string, script: Script, asked?: Record<string, any>[]) => runLaboratory(cellsLab, {
    args: [...CELLS, '--researcher', 'assisted', '--team', teamDir, '--member', id, '--out', path.join(dir, id + '.json')], root: dir, llm, fetch: system2(script, asked) });
  const [a, b] = await Promise.all([member('a', memberA), member('b', memberB, askedB)]);
  assert.ok(askedB[0].system.includes('YOUR TEAM'), 'its prompt says what the board is');
  assert.ok(!/size, pieces/.test(askedB[0].system), 'in words of no world');
  assert.match(askedB[1].user.investigation[0].results[0].error, /closed this round: it opens in round 2/);
  const at2 = askedB.find((q) => q.user.round === 2 && q.user.investigation?.length === 2)!.user.investigation;
  const r2 = [...at2[0].results, ...at2[1].results];
  assert.equal(r2[0].version, 1);
  assert.deepEqual(r2[0].entries.map((e: { id: string }) => e.id), ['a#1']);
  assert.deepEqual(r2[0].entries[0].world, [{ place: 'lab1', same_place_for_the_whole_team: true }], 'where it was observed, said by the environment');
  assert.deepEqual(r2[1].items[0].evidence.map((x: { ref: string }) => x.ref.replace(/^act\d+$/, 'act<n>')), ['ep1', 'ep1@1', 'act<n>', 'r1.2']);
  assert.equal(r2[2].record.act.accepted, true, 'the act as it was answered');
  assert.ok(r2[2].record.rows.length > 1, 'and the episode it made, as a view shows it');
  /* What the board keeps: each piece of evidence with its record. */
  const entry = JSON.parse(fs.readFileSync(path.join(teamDir, 'board', 'entries', 'a.1.json'), 'utf8'));
  assert.equal(entry.evidence[1].record.step, 1);
  assert.equal(entry.evidence[1].record.rows.length, 1, 'a point is its step only');
  assert.ok(entry.evidence[3].record.results[0].accepted, 'an investigation step as it was asked and answered');
  /* The operator keeps the key of each intervention, apart. */
  const kept = events(a.journal, 'operator_interventions');
  assert.equal(kept.length, 1);
  assert.match(kept[0].interventions[0].key, /^act\|lab1\|/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(teamDir, 'board', 'operator', 'a.1.json'), 'utf8')).keys, [kept[0].interventions[0].key]);
  /* The findings say it: what a published, what b read, and that b's belief rests on the board too. */
  assert.deepEqual(a.finding.parallel?.team?.published, ['a#1']);
  assert.ok(b.finding.parallel?.team?.read.some((r) => r.startsWith('v1 open a#1')));
  assert.ok(b.finding.claims[0].grounded?.includes('peers'));
  /* Resumed: its reads come from its log, whatever the board holds now; a's publication is found, not added again. */
  fs.writeFileSync(path.join(teamDir, 'board', 'versions', 'v1.json'), JSON.stringify({ format: 'board-version@1', team: 'pair', version: 1, entries: [] }));
  const again = await runLaboratory(cellsLab, { args: ['--resume', b.journal, '--out', path.join(dir, 'b2.json')], root: dir, llm, fetch: system2(memberB) });
  assert.notEqual(again.stoppedBy, 'diverged');
  const end = events(again.journal, 'end')[0];
  assert.ok(end.replay.replayed.peer >= 1 && !end.replay.live.peer, 'every read of the board replayed');
  const aAgain = await runLaboratory(cellsLab, { args: ['--resume', a.journal, '--out', path.join(dir, 'a2.json')], root: dir, llm, fetch: system2(memberA) });
  assert.notEqual(aAgain.stoppedBy, 'diverged');
  assert.ok(events(aAgain.journal, 'peer_publish').every((e) => e.replayed));
  assert.equal(fs.readdirSync(path.join(teamDir, 'board', 'entries')).length, 1);
});

test('every world of laws may be investigated by a team; none of them has boards to explore', async () => {
  const { checkTeam, runTeam } = await import('../src/orchestra/team.ts');
  for (const name of ['cells', 'messages', 'orbit', 'tank', 'particles3d']) assert.equal((LABS as Record<string, { teams?: boolean }>)[name].teams, true, name);
  const def = { id: 'pair', lab: 'cells', condition: 'communicated', args: CELLS, window: 1, confirmations: 1, members: [{ id: 'a' }, { id: 'b' }] };
  assert.throws(() => checkTeam({ ...def, explore_places: 1 }), /has no boards to explore/);
  const root = tmp('law-team@1-');
  const report = await runTeam(def, { root, llm, fetch: system2((user, done) => (user.round === 1 && done === 0 ? { investigate: [{ view: 'ep1', from: 0, to: 1 }] } : null)) });
  assert.deepEqual(report.members.map((m) => m.status), ['budget', 'budget']);
  assert.ok(report.audit?.models_by_window.length, 'the models each member held, by window: a law\'s print');
  assert.equal(report.audit?.models_by_window[0].members, 2);
});
