import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FAMILY_INDEX, examOverlap, explorationIndices } from '../src/worlds/grid/family.ts';
import { PEERS_SECTION, PeerChannel, TeamBoard, parsePublication, type BoardEntry } from '../src/learn/assisted/board.ts';
import { Protocol } from '../src/learn/protocol.ts';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { PLACES_SECTION, gridLab } from '../src/worlds/grid/lab.ts';
import type { FetchLike } from '../src/core/net.ts';
import type { Objective, Place } from '../src/learn/objective.ts';
import { userOf } from './support.ts';

/* SPEC-INVESTIGACION-PARALELA: boards to explore (modality A) and a team with a board (modality B). */

const tmp = (prefix: string): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test('E1: the boards of the search and of the exam come from stretches of the family that never meet', () => {
  assert.deepEqual(explorationIndices(3), [501, 502, 503]);
  assert.deepEqual(explorationIndices(2, 10), [511, 512], 'a member of a team: its own stretch');
  assert.equal(examOverlap(4, explorationIndices(3)), null);
  assert.match(examOverlap(4, [FAMILY_INDEX.blind + 1]) ?? '', /outside their stretch/);
  assert.match(examOverlap(4, [3]) ?? '', /outside their stretch/);
  assert.match(examOverlap(600, []) ?? '', /at most 499/);
});

/* --- The protocol: a place to explore is shown as such and never checked; a confirmation may be refused. ------------- */
type P = Place & { holdsHere: boolean };
const objective: Objective<string, P, number, { place: string; ok: boolean }> = {
  answer: { form: [], use: 'predict' },
  verdictForm: [],
  casesIn: () => 1,
  run: async (_m: string, drawn: readonly { place: P }[]) => ({ byPlace: drawn.map(({ place }) => [{ place: place.id, ok: place.holdsHere }]) }),
  holds: (results: readonly { ok: boolean }[]) => results.every((r) => r.ok),
  view: () => ({})
} as unknown as Objective<string, P, number, { place: string; ok: boolean }>;

test('the protocol: a place to explore is the learner\'s, never checked; no blind confirmation when none may be spent', async () => {
  const places: P[] = [{ id: 'lab1', role: 'laboratory', seen: true, holdsHere: true }, { id: 'explore1', role: 'exploration', seen: true, holdsHere: false },
    { id: 'place1', role: 'family', seen: false, holdsHere: true }];
  let blindAsked = 0;
  const protocol = new Protocol(objective, { places: () => places, blindPlaces: () => { blindAsked++; return [{ id: 'blind1', role: 'confirmation', seen: false, holdsHere: true }]; },
    fingerprint: (m) => m, validations: 2, pairedRegression: false, confirm: () => 'the team has spent its 1 blind confirmation' });
  assert.deepEqual(protocol.placesView().map((p) => p.place), ['lab1', 'explore1']);
  assert.match(protocol.placesView()[1].role, /explore.*never checked/);
  const r = await protocol.round('m', { round: 1, attempt: 1, validate: true });
  assert.deepEqual(r.laboratories.map((o) => o.place.id), ['lab1'], 'only laboratories are checked');
  assert.equal(r.accepted, false);
  assert.equal(blindAsked, 0, 'no blind board consulted');
  assert.match(String((r.view.validation as Record<string, unknown>).no_blind_confirmation), /spent/);
  assert.equal((r.journal.validation as Record<string, unknown>).confirmation_refused, 'the team has spent its 1 blind confirmation');
  /* A blind place that is not blind is refused outright. */
  const wrong = new Protocol(objective, { places: () => places, blindPlaces: () => [places[1]], fingerprint: (m) => m, validations: 2, pairedRegression: false });
  await assert.rejects(wrong.round('m', { round: 1, attempt: 1, validate: true }), /not blind: explore1/);
});

/* --- The board ----------------------------------------------------------------------------------------------------- */
const entry = (member: string, n: number, round: number, board: TeamBoard, claim = 'c'): BoardEntry => ({ id: member + '#' + n, member, n, round, window: board.windowOf(round),
  kind: 'result', claim, world: [], evidence: [{ ref: 'g1', record: { episode: 'g1', frames: [] } }] });

test('the board: versions sealed once every member passed them, publications idempotent, the exam counted team-wide', async () => {
  const board = new TeamBoard(tmp('board-'), { id: 't', members: ['a', 'b'], window: 2, exchange: true, confirmations: 1 });
  assert.equal(board.readableAt(1), null);
  assert.equal(board.readableAt(3), 1);
  assert.equal(board.readableAt(4), null);
  board.reach('a', 1); board.reach('b', 1);
  assert.deepEqual(board.publish(entry('a', 1, 1, board), { keys: ['k1'] }), { id: 'a#1', window: 1 });
  assert.deepEqual(board.publish(entry('a', 1, 1, board)), { id: 'a#1', window: 1, replayed: true }, 'published again: nothing added');
  assert.match(board.publish(entry('a', 1, 1, board, 'other words')).conflict ?? '', /the first stays/);
  assert.equal(board.entries().length, 1);
  board.reach('a', 3);
  assert.equal(board.sealed(1), null, 'b has not finished round 2');
  const waiting = board.version(1, { pollMs: 10 });
  board.publish(entry('b', 1, 2, board));
  board.reach('b', 3);
  const v1 = await waiting;
  assert.deepEqual(v1.entries.map((e) => e.id), ['a#1', 'b#1']);
  board.publish(entry('a', 2, 3, board));
  board.reach('a', 5); board.reach('b', 5);
  assert.deepEqual(board.sealed(1)!.entries.map((e) => e.id), ['a#1', 'b#1'], 'a sealed version never changes');
  assert.deepEqual(board.sealed(2)!.entries.map((e) => e.id), ['a#1', 'b#1', 'a#2']);
  assert.deepEqual(board.operatorOf('a#1'), { keys: ['k1'] });
  /* Blind boards: none twice in the team, the same ones for the same key. */
  const a1 = board.blindBoards('a', 'c1.s0', 3), b1 = board.blindBoards('b', 'c1.s0', 3);
  assert.deepEqual(a1, [1001, 1002, 1003]);
  assert.deepEqual(b1, [1004, 1005, 1006]);
  assert.deepEqual(board.blindBoards('a', 'c1.s0', 3), a1, 'a resumed run is given what it was given');
  assert.equal(board.confirm('a', 'c1', 4), null);
  assert.equal(board.confirm('a', 'c1', 4), null, 'the same confirmation again: nothing spent');
  assert.match(board.confirm('b', 'c1', 4) ?? '', /spent its 1 blind confirmation/);
  /* A member that ended no longer holds a window open. */
  board.end('b');
  board.reach('a', 7);
  assert.ok(board.sealed(3));
  assert.throws(() => new TeamBoard(board.dir, { id: 't', members: ['a'], window: 2, exchange: true, confirmations: 1 }), /declared otherwise/);
});

test('a publication is checked: its kind, its claim, and evidence for a result or a dead end', () => {
  assert.match(String(parsePublication({ kind: 'idea', claim: 'x' })), /"kind"/);
  assert.match(String(parsePublication({ kind: 'dead_end', claim: 'x' })), /needs "evidence"/);
  assert.deepEqual(parsePublication({ kind: 'method', claim: ' compare two boards ' }), { kind: 'method', claim: 'compare two boards', evidence: [] });
  assert.match(PEERS_SECTION(3), /rounds 4, 7, 10/);
});

/* --- Runs of the grid, System 2 standing in ----------------------------------------------------------------------- */
const DRAFT = { observations: {}, rules: {}, weights: {}, output: '(p, m) => 0.5' };
const PROPOSAL = (round: number) => ({ rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p, m) => 0.5', validate: false,
  beliefs: [{ id: 'b', stance: round === 1 ? 'new' : 'keep', statement: 's', evidence: round > 1 ? ['peer:a#1', 'g1@0'] : ['g1@0'] }], lessons: ['l'] });
type Script = (user: Record<string, any>, done: number) => unknown | null;
function system2(script: Script, asked: Record<string, any>[] = []): FetchLike {
  return async (_url, init) => {
    const b = JSON.parse(String(init.body));
    const user = JSON.parse(userOf(b));
    asked.push({ system: b.messages[0].content as string, user });
    const content = script(user, (user.investigation ?? []).length) ?? PROPOSAL(user.round);
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
}
const GRID = ['--seed', '22', '--attempts', '2', '--explore', '1', '--variants', '1', '--family', '1', '--family-variants', '1', '--confirm-places', '1', '--levels', '2', '--depth', '1',
  '--flat', '--no-grade', '--no-reflection', '--no-ablation', '--plays', '3'];
const llm = { url: 'http://system2.test/chat', model: 'stand-in' };
const events = (journal: string, type: string): Record<string, any>[] => JSON.parse(fs.readFileSync(journal, 'utf8')).events.filter((e: { type: string }) => e.type === type);

/* Round 1: two replays in two places of one step, an act in a place to explore and a table narrowed to it. */
const explorer: Script = (user, done) => user.round === 1 && done === 0
  ? { investigate: [{ replay: 'g2@0', model: DRAFT }, { replay: 'g3@0', model: DRAFT }, { replay: 'g1@0', model: DRAFT }, { table: { source: '(p) => 1', range: [0, 1] }, on: 'in_play', place: 'explore1' }] }
  : null;

test('modality A: boards to explore are the assisted researcher\'s - shown, played on, never checked - and serial or concurrent play the same episodes', async () => {
  const dir = tmp('explore-');
  const asked: Record<string, any>[] = [];
  const args = [...GRID, '--researcher', 'assisted', '--explore-places', '2'];
  const a = await runLaboratory(gridLab, { args: [...args, '--out', path.join(dir, 'concurrent.json')], root: dir, llm, fetch: system2(explorer, asked) });
  assert.ok(asked[0].system.includes(PLACES_SECTION), 'its prompt says what its places are');
  assert.deepEqual(asked[0].user.places.map((p: { place: string }) => p.place), ['lab1', 'explore1', 'explore2']);
  const games = asked[0].user.notebook.episodes.map((e: { episode: string; chosen_by?: string; how?: string }) => e.episode);
  assert.deepEqual(games, ['g1', 'g2', 'g3'], 'one exploration episode in the laboratory and in each place to explore');
  const step = asked[1].user.investigation[0].results;
  assert.deepEqual(step.slice(0, 3).map((r: { episode?: string }) => r.episode), ['g4', 'g5', 'g6'], 'replays named in the order asked, once all ended');
  assert.equal(step[3].place, 'explore1');
  assert.ok(step[3].rows.every((r: { point: string }) => r.point.startsWith('g2@')), 'a table narrowed to one place');
  const played = events(a.journal, 'played_by_the_learner');
  assert.deepEqual(played.map((e) => e.from), ['g2@0', 'g3@0', 'g1@0']);
  const clock = events(a.journal, 'step_clock');
  assert.equal(clock[0].mode, 'concurrent');
  assert.deepEqual(clock[0].replays.map((r: { place: string }) => r.place), ['explore1', 'explore2', 'lab1']);
  const checks = events(a.journal, 'check');
  assert.ok(checks.every((c) => c.laboratories.every((l: { place: string }) => l.place === 'lab1')), 'never checked where it explores');
  assert.equal(a.finding.parallel?.exploration_places, 2);
  /* The same requests, serially: the same episodes; only the clock differs. */
  const b = await runLaboratory(gridLab, { args: [...args, '--place-concurrency', 'serial', '--out', path.join(dir, 'serial.json')], root: dir, llm, fetch: system2(explorer) });
  const strip = (j: string) => events(j, 'investigation').map((e) => JSON.stringify(e.results));
  assert.deepEqual(strip(b.journal), strip(a.journal));
  assert.equal(events(b.journal, 'step_clock')[0].mode, 'serial');
});

test('boards to explore are help: the unknown-world researcher does not take them; and they never are a board of the exam', async () => {
  const dir = tmp('explore-');
  await assert.rejects(runLaboratory(gridLab, { args: [...GRID, '--explore-places', '1', '--out', path.join(dir, 'a.json')], root: dir, llm, fetch: system2(() => null) }), /only the assisted researcher/);
  /* Without them, the run is as it was: no section, no step clock. */
  const asked: Record<string, any>[] = [];
  const r = await runLaboratory(gridLab, { args: [...GRID, '--researcher', 'assisted', '--out', path.join(dir, 'b.json')], root: dir, llm, fetch: system2(explorer, asked) });
  assert.ok(!asked[0].system.includes('YOUR PLACES'));
  assert.equal(events(r.journal, 'step_clock').length, 0);
  assert.equal(r.finding.parallel, undefined);
});

/* --- Modality B: two members, a board every round ------------------------------------------------------------------ */
const memberA: Script = (user, done) => user.round === 1 && done === 0
  ? { investigate: [{ act: 'g1@0', from: [0, 0], to: [1, 1] }, { publish: { kind: 'result', claim: 'this step is not there yet', evidence: ['r1.1'] } }] }
  : user.round === 1 && done === 1 ? { investigate: [
    { publish: { kind: 'dead_end', claim: 'that move is refused at the start', intervention: 'act from g1@0', observed: 'refused', scope: 'the start of lab1', evidence: ['g1', 'r1.1'] } },
    { publish: { kind: 'result', claim: 'episodes start in the picture of g1@0', evidence: ['g1@0'] } }] }
  : null;
const memberB: Script = (user, done) => user.round === 1 && done === 0 ? { investigate: [{ peers: 'list' }] }
  : user.round === 2 && done === 0 ? { investigate: [{ peers: 'list' }, { peers: 'open', items: ['a#1'] }, { peers: 'open', item: 'a#1', evidence: 'g1' }] }
  : user.round === 2 && done === 1 ? { investigate: [{ peers: 'find', words: 'refused start' }] }
  : null;

test('modality B: a member publishes with its evidence; another reads the version its round opens, records included; resumed, it reads the same', async () => {
  const dir = tmp('team-');
  const teamDir = path.join(dir, 'team');
  new TeamBoard(teamDir, { id: 'pair', members: ['a', 'b'], window: 1, exchange: true, confirmations: 2 });
  const askedB: Record<string, any>[] = [];
  const member = (id: string, script: Script, asked?: Record<string, any>[]) => runLaboratory(gridLab, {
    args: [...GRID, '--researcher', 'assisted', '--team', teamDir, '--member', id, '--explore-places', '1', '--explore-offset', id === 'a' ? '0' : '10', '--out', path.join(dir, id + '.json')],
    root: dir, llm, fetch: system2(script, asked) });
  const [a, b] = await Promise.all([member('a', memberA), member('b', memberB, askedB)]);
  assert.ok(askedB[0].system.includes('YOUR TEAM'), 'its prompt says what the board is');
  assert.match(askedB[1].user.investigation[0].results[0].error, /closed this round: it opens in round 2/);
  /* Round 2: version 1, with what a published in round 1. */
  const r2 = askedB.find((q) => q.user.round === 2 && q.user.investigation?.length === 1)!.user.investigation[0].results;
  assert.equal(r2[0].version, 1);
  assert.deepEqual(r2[0].entries.map((e: { id: string }) => e.id), ['a#1', 'a#2']);
  assert.deepEqual(r2[0].entries[0].world[0], { place: 'lab1', board: '8x5', pieces: { yours: 2, other: 1 }, same_board_for_the_whole_team: true }, 'where it was observed, said by the environment');
  assert.deepEqual(r2[1].items[0].evidence.map((x: { ref: string }) => x.ref), ['g1', 'r1.1']);
  assert.match(r2[1].items[0].evidence[1].what, /investigation step r1.1/);
  assert.equal(r2[2].record.episode, 'g1');
  assert.ok(r2[2].record.frames.length > 1, 'the record the environment gave, whole');
  const step = r2[1].items[0].evidence;
  assert.ok(step, 'opened');
  const entryA = JSON.parse(fs.readFileSync(path.join(teamDir, 'board', 'entries', 'a.1.json'), 'utf8'));
  assert.equal(entryA.evidence[1].record.results[0].accepted, false, 'what the act was answered, as it was answered');
  assert.deepEqual(a.finding.parallel?.team?.published, ['a#1', 'a#2']);
  assert.ok(b.finding.parallel?.team?.read.some((r) => r.startsWith('v1 open a#1')));
  assert.deepEqual(b.finding.claims[0].grounded, ['world', 'peers'], 'a belief from the board is cited as such');
  assert.ok(events(a.journal, 'operator_interventions').length >= 1, 'the operator keeps the key of each intervention');
  assert.ok((JSON.parse(fs.readFileSync(path.join(teamDir, 'board', 'operator', 'a.1.json'), 'utf8')).keys as string[]).length >= 1);
  /* Resumed: its reads come from its log, whatever the board holds now, and a's publications are not added again. */
  fs.writeFileSync(path.join(teamDir, 'board', 'versions', 'v1.json'), JSON.stringify({ format: 'board-version@1', team: 'pair', version: 1, entries: [] }));
  const again = await runLaboratory(gridLab, { args: ['--resume', b.journal, '--out', path.join(dir, 'b2.json')], root: dir, llm, fetch: system2(memberB) });
  assert.notEqual(again.stoppedBy, 'diverged');
  const end = events(again.journal, 'end')[0];
  assert.ok(end.replay.replayed.peer >= 1 && !end.replay.live.peer, 'every read of the board replayed');
  const aAgain = await runLaboratory(gridLab, { args: ['--resume', a.journal, '--out', path.join(dir, 'a2.json')], root: dir, llm, fetch: system2(memberA) });
  assert.notEqual(aAgain.stoppedBy, 'diverged');
  assert.ok(events(aAgain.journal, 'peer_publish').every((e) => e.replayed), 'published again: found there');
  assert.equal(fs.readdirSync(path.join(teamDir, 'board', 'entries')).length, 2);
});

test('a team: who may be a member, and of which team', async () => {
  const dir = tmp('team-');
  const teamDir = path.join(dir, 'team');
  new TeamBoard(teamDir, { id: 'pair', members: ['a', 'b'], window: 1, exchange: true, confirmations: null });
  const run = (extra: string[]) => runLaboratory(gridLab, { args: [...GRID, ...extra, '--out', path.join(dir, 'x.json')], root: dir, llm, fetch: system2(() => null) });
  await assert.rejects(run(['--team', teamDir, '--member', 'a']), /only the assisted researcher reads it/);
  await assert.rejects(run(['--researcher', 'assisted', '--team', teamDir, '--member', 'z']), /no member z/);
  await assert.rejects(run(['--researcher', 'assisted', '--member', 'a']), /--team/);
  /* A laboratory that does not declare teams is refused (every world of laws does now: law-team.test.ts). */
  const { cellsLab } = await import('../src/worlds/cells/lab.ts');
  await assert.rejects(runLaboratory({ ...cellsLab, teams: false }, { args: ['--researcher', 'assisted', '--team', teamDir, '--member', 'a', '--flat', '--out', path.join(dir, 'y.json')], root: dir, llm, fetch: system2(() => null) }), /cannot be investigated by a team yet/);
  assert.ok(PeerChannel.acceptsRead({ peers: 'list' }) && PeerChannel.acceptsPublish({ publish: {} }));
});

/* --- PB2: the team as a batch of the orchestra ---------------------------------------------------------------------- */
test('team@1: members at once, each its role and its stretch; the budget declared; the team measured apart', async () => {
  const { runTeam, checkTeam, perMemberTokens } = await import('../src/orchestra/team.ts');
  const root = tmp('team@1-');
  /* One System 2 for the whole team: which member asks is in its role, the first message it was given. */
  const roleOf = (user: Record<string, any>): string => [...(user.operator_messages?.new ?? []), ...(user.operator_messages?.earlier ?? [])].map((m: { text: string }) => m.text).join(' ');
  const both: Script = (user, done) => {
    const a = /refute/.test(roleOf(user));
    if (user.round === 1 && done === 0) return { investigate: [{ act: 'g1@0', from: [0, 0], to: [1, 1] }] };
    if (a && user.round === 1 && done === 1) return { investigate: [{ publish: { kind: 'dead_end', claim: 'refused at the start', evidence: ['r1.1'] } }] };
    if (!a && user.round === 2 && done === 0) return { investigate: [{ peers: 'list' }, { peers: 'open', items: ['a#1'] }] };
    return null;
  };
  const def = { id: 'pair', lab: 'grid', condition: 'communicated', args: GRID, window: 1, confirmations: 1, explore_places: 1,
    budget: { mode: 'fixed' as const, tokens: 100000, coordination_tokens: 20000 },
    members: [{ id: 'a', role: 'You try to refute the team\'s rule.' }, { id: 'b', role: 'You identify the rule.' }] };
  assert.equal(perMemberTokens(def), 40000, '(B - coordination) / N');
  assert.equal(perMemberTokens({ ...def, budget: { mode: 'extended', tokens: 100000, exchange_tokens_per_member: 5000 } }), 55000, 'B / N, exchange on top');
  assert.throws(() => checkTeam({ ...def, explore_places: 0, members: [{ id: 'a', researcher: 'unknown-world' }] }), /without exchange/);
  const lines: string[] = [];
  const report = await runTeam(def, { root, llm, fetch: system2(both), print: (l) => lines.push(l) });
  assert.deepEqual(report.members.map((m) => [m.id, m.explore_offset]), [['a', 0], ['b', 20]]);
  const a = JSON.parse(fs.readFileSync(report.members[0].journal!, 'utf8'));
  assert.deepEqual(a.argv.slice(a.argv.indexOf('--explore-places'), a.argv.indexOf('--explore-places') + 4), ['--explore-places', '1', '--explore-offset', '0']);
  assert.equal(a.events.find((e: { type: string }) => e.type === 'operator_message').messages[0].by, 'agent:team', 'its role, from above');
  assert.equal(report.budget?.per_member, 40000);
  assert.equal(report.budget?.within, true);
  assert.deepEqual(report.team.board.entries, { result: 0, dead_end: 1, method: 0 });
  assert.equal(report.audit?.duplication.shared, 1, 'the same act on the same board by both members');
  assert.deepEqual(report.audit?.dead_ends.map((d) => [d.member, d.entry, d.repeated_after]), [['b', 'a#1', false]]);
  assert.ok(report.audit?.models_by_window.length);
  assert.ok(fs.readFileSync(path.join(report.dir, 'team.txt'), 'utf8').includes('AUDIT (operator only)'));
  /* Run again: its members ended, nothing is run again. */
  const again = await runTeam(def, { root, llm, fetch: system2(() => { throw new Error('nothing should be asked'); }) });
  assert.deepEqual(again.members.map((m) => m.status), report.members.map((m) => m.status));
});
