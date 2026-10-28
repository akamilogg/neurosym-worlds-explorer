import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ResearchStore, write } from '../src/console/store.ts';
import { climb, climbAt, positionsAt, progressOf, stateOf, verdictsOf, type ClimbSample, type ClimbView } from '../src/console/climb.ts';
import { DEFAULT_PROGRESS, axisOf, elevation, exactShare, holdingShare, type ProgressMetric } from '../src/learn/progress.ts';
import { ARTIFACTS_PROGRESS } from '../src/worlds/artifacts/lab.ts';
import { serveConsole } from '../src/runtime/console.ts';

/* SPEC-VISTA-ESCALADA: the metric's contract (VE1) and the climb read from records (VE2). */

const higher: ProgressMetric = { id: 'h', label: 'h', unit: 'proporción', direction: 'higher', range: [0, 1], source: 'check' };
const lower: ProgressMetric = { id: 'l', label: 'l', unit: 'Δ', direction: 'lower', source: 'artifact_check' };

test('VE1: improving is always going up, with the metric\'s real values on its axis (§3.2, acceptance 2)', () => {
  const up = axisOf(higher, [0.2, 0.9]);
  assert.deepEqual(up, { bottom: 0, top: 1, scale: 'linear' }, 'a share keeps its natural range');
  const down = axisOf(lower, [0.74, -0.02, 0.3]);
  assert.equal(down.bottom, 0.74); assert.equal(down.top, -0.02);
  assert.ok(elevation(down, -0.02) > elevation(down, 0.3), 'the lower value, the better, stands higher');
  assert.equal(elevation(down, -0.02), 1); assert.equal(elevation(down, 0.74) + 0, 0);
  const log = axisOf({ ...lower, scale: 'log' }, [0.5, 2]);
  assert.ok(Math.abs(elevation(log, 1) - 0.5) < 1e-12, 'a log axis halves at the geometric middle');
  const flat = axisOf(lower, [3, 3]);
  assert.ok(flat.bottom > 3 && flat.top < 3, 'a single value still has an axis around it');
});

test('VE1: the default, plates and cells, and the artifacts\' mountains read only verdicts', () => {
  assert.equal(holdingShare({ laboratories: [{ holds: true }, { holds: false }] }), 0.5);
  assert.equal(holdingShare({}), null);
  assert.equal(exactShare({ laboratories: [{ exact: 12, points: 16 }, { exact: 4, points: 4 }] }), 0.8);
  assert.equal(exactShare({ laboratories: [{ holds: true }] }), null, 'no points, no sample - never a guess');
  assert.deepEqual(progressOf('cells@1').metrics.map((m) => m.id), ['exact_share']);
  assert.deepEqual(progressOf('plates@1').metrics.map((m) => m.id), ['exact_share']);
  assert.equal(progressOf('grid@1'), DEFAULT_PROGRESS, 'a world that declares nothing climbs the default');
  const a = { type: 'artifact_check', laboratories: [{ correct: true, growth: { slope: 0.04 }, ratio: 0.9 }, { correct: false, growth: { slope: -0.1 }, ratio: 1.2 }] };
  assert.equal(ARTIFACTS_PROGRESS.sample('correct', a), 0.5);
  assert.equal(ARTIFACTS_PROGRESS.sample('growth_exponent', a), 0.04, 'the worst place: it holds only where it holds everywhere');
  assert.equal(ARTIFACTS_PROGRESS.sample('cost_ratio', a), 1.2);
  assert.equal(ARTIFACTS_PROGRESS.sample('places_holding', a), null, 'an artifact\'s verdict is not the model\'s');
  assert.equal(ARTIFACTS_PROGRESS.sample('growth_exponent', { type: 'check', laboratories: [{ holds: true }] }), null);
});

test('VE1: a check is its verdicts - the check, its validation, its blind sets (§3.3)', () => {
  const v = verdictsOf('check', { laboratories: [{ holds: true }], accepted: true,
    validation: { family: [{ holds: true }], blind_confirmation: { sets: [{ ok: true, places: [{ holds: false }] }] } } });
  assert.deepEqual(v.map((x) => x.kind), ['check', 'validation', 'blind']);
  assert.equal(v[0].accepted, true);
  assert.deepEqual(verdictsOf('proposal', {}), [], 'what is not a verdict gives no sample');
  assert.deepEqual(verdictsOf('round_closed', {}), [], 'a round without a check gives no sample (acceptance 4)');
  assert.deepEqual(verdictsOf('artifact_check', { laboratories: [] }).map((x) => x.kind), ['artifact']);
});

const s = (t: number, value: number, ref = 'r' + t): ClimbSample => ({ metric: 'h', t, tokens: null, round: null, value, kind: 'check', ref });

/* A view with one group, built by hand: climbAt makes its plateaus, crest and summit. */
const viewOf = (metric: ProgressMetric, climbers: { id: string; samples: ClimbSample[] }[], clock = 100): ClimbView => climbAt({ format: 'climb@1', profile: 'operator', origin: null, clock, at: null,
  groups: [{ key: {}, metrics: [{ ...metric, samples: 0, axis: null, crest: [], summit: null }], ropes: [], events: [],
    climbers: climbers.map((c) => ({ ...c, label: c.id, kind: 'run' as const, joined_at: 0, states: [], budget: { tokens_used: 5, tokens_limit: 10 }, plateaus: [], untimed: 0, positions: c.samples.map((x, i): [number, number] => [x.t, i + 1]) })) }],
  cursor: '', historical: false, notes: [] }, Infinity);

test('VE2: a plateau is a stretch of verdicts that did not beat the best; the crest is the group\'s best so far', () => {
  const plateaus = (xs: ClimbSample[]) => viewOf(higher, [{ id: 'x', samples: xs }]).groups[0].climbers[0].plateaus;
  assert.deepEqual(plateaus([s(0, 0.2), s(1, 0.5), s(2, 0.5), s(3, 0.4), s(4, 0.5), s(5, 0.9)]), [{ metric: 'h', from: 1, to: 4, samples: 3 }]);
  assert.deepEqual(plateaus([s(0, 0.2), s(1, 0.1), s(2, 0.3)]), [], 'two verdicts are not a plateau');
  const two = viewOf(higher, [{ id: 'one', samples: [s(0, 0.2), s(10, 0.6)] }, { id: 'two', samples: [s(5, 0.4), s(12, 0.5)] }]).groups[0].metrics[0];
  assert.deepEqual(two.crest.map((c) => [c.t, c.value, c.climber]), [[0, 0.2, 'one'], [5, 0.4, 'two'], [10, 0.6, 'one']]);
  assert.equal(two.summit!.value, 0.6);
  const down = viewOf(lower, [{ id: 'x', samples: [{ ...s(0, 0.7), metric: 'l' }, { ...s(1, 0.9), metric: 'l' }, { ...s(2, -0.1), metric: 'l' }] }]).groups[0].metrics[0];
  assert.deepEqual(down.crest.map((c) => c.value), [0.7, -0.1]);
});

test('VE4: the climb at an instant holds only what had happened by then, its axis unmoved, its spending unknown (§8, C9)', () => {
  const full = viewOf(higher, [{ id: 'one', samples: [s(0, 0.2), s(10, 0.6), s(20, 0.6), s(30, 0.6), s(40, 0.5)] }, { id: 'two', samples: [s(5, 0.4), s(50, 0.9)] }]);
  full.groups[0].metrics[0].axis = { bottom: 0, top: 1, scale: 'linear' };
  const at = climbAt(full, 25);
  assert.equal(at.at, 25);
  assert.deepEqual(at.groups[0].climbers.map((c) => c.samples.length), [3, 1]);
  assert.deepEqual(at.groups[0].metrics[0].crest.map((c) => c.value), [0.2, 0.4, 0.6]);
  assert.deepEqual(at.groups[0].climbers[0].plateaus, [], 'two flat verdicts by then: no plateau yet');
  assert.deepEqual(climbAt(full, 45).groups[0].climbers[0].plateaus, [{ metric: 'h', from: 10, to: 40, samples: 3 }]);
  assert.deepEqual(at.groups[0].metrics[0].axis, { bottom: 0, top: 1, scale: 'linear' }, 'a replay does not move its mountain');
  assert.equal(at.groups[0].climbers[0].budget.tokens_used, null);
  assert.equal(climbAt(full, 100).groups[0].climbers[0].budget.tokens_used, 5);
  assert.deepEqual(positionsAt(full, 25), { one: 3, two: 1 });
});

test('VE4: what a climber was doing', () => {
  assert.equal(stateOf('investigation', { requests: [{ view: 'e1' }, { table: 'x' }] }), 'observa');
  assert.equal(stateOf('investigation', { requests: [{ view: 'e1' }, { act: 'x' }] }), 'actúa');
  assert.equal(stateOf('delegation_requested', {}), 'delega');
  assert.equal(stateOf('world_window', { by: 'wait' }), 'espera');
  assert.equal(stateOf('world_window', { by: 'went_on' }), null);
  assert.equal(stateOf('end', {}), 'parado');
  assert.equal(stateOf('memory_select', {}), null);
});

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'climb-'));
const check = (t: number, round: number, exact: number, extra: Record<string, unknown> = {}) =>
  ({ t, type: 'check', round, laboratories: [{ place: 'lab1', holds: exact === 16, exact, points: 16 }], ...extra });
function workspace() {
  const dir = root(), batch = path.join(dir, 'runs', 'batches', 'b');
  const run = (name: string, started: string, events: unknown[], more: Record<string, unknown> = {}) =>
    write(path.join(batch, name + '.json'), { experiment: 'cells@1', researcher: 'assisted', started, limits: { max_tokens: 1000 }, config: { seed: 1 }, events, ...more });
  write(path.join(batch, 'batch.json'), { format: 'batch@1', definition: { runs: [{ id: 'A', condition: 'alone' }, { id: 'B', condition: 'with a senior' }, { id: 'A2', condition: 'alone' }] } });
  run('A', '2026-10-27T10:00:00.000Z', [
    { t: 1, type: 'investigation', round: 1, requests: [] },
    check(10, 1, 4), { t: 15, type: 'round_closed', round: 2 }, check(20, 3, 8),
    { t: 25, type: 'delegation_requested', id: 'delegation:r3.1', round: 3, question: 'look elsewhere' },
    { t: 30, type: 'operator_message', round: 3, messages: [{ id: 'd1', text: 'try the other place', by: 'agent:senior', directive: true }] },
    { t: 32, type: 'operator_command', id: 'c1', kind: 'focus', accepted: true },
    check(40, 4, 16, { accepted: true, validation: { family: [{ place: 'place1', holds: true, exact: 16, points: 16 }] } }),
    { t: 45, type: 'operator_message', round: 4, messages: [{ id: 'result-delegation:r3.1', text: 'found it', research_result: 'delegation:r3.1' }] },
    { t: 50, type: 'end', stoppedBy: 'budget', console_usage: { llm_tokens_live: 700 } }
  ]);
  run('A2', '2026-10-27T10:00:30.000Z', [check(5, 1, 12)]);
  run('B', '2026-10-27T11:00:00.000Z', [check(10, 1, 16)]);
  /* A branch beside its requester, and the cut it started from - a copy of the requester's past, not a climber. */
  write(path.join(batch, 'A.branches', 'delegation-r3.1.json'), { experiment: 'cells@1', researcher: 'assisted', started: '2026-10-27T10:00:26.000Z', config: { seed: 1 }, events: [check(4, 1, 12)] });
  write(path.join(batch, 'A.branches', 'delegation-r3.1.cut.json'), { experiment: 'cells@1', researcher: 'assisted', started: '2026-10-27T10:00:00.000Z', config: { seed: 1 }, events: [check(10, 1, 4)] });
  return { dir, store: new ResearchStore(dir) };
}

test('VE2: climbers from records only - groups by comparability, branches hanging from their requester (§4, acceptance 1, 3)', () => {
  const { store } = workspace();
  const v = climb(store, ['batches/b/A', 'batches/b/A2', 'batches/b/B'], 'operator');
  assert.equal(v.groups.length, 2, 'two conditions are two panels, never one axis');
  const alone = v.groups.find((g) => g.key.condition === 'alone')!, senior = v.groups.find((g) => g.key.condition === 'with a senior')!;
  assert.deepEqual(alone.climbers.map((c) => c.id).sort(), ['batches/b/A', 'batches/b/A.branches/delegation-r3.1', 'batches/b/A2']);
  const a = alone.climbers.find((c) => c.id === 'batches/b/A')!, branch = alone.climbers.find((c) => c.kind === 'branch')!;
  assert.equal(branch.parent, 'batches/b/A');
  assert.equal(branch.joined_at, 25, 'a branch joins when it was asked for');
  assert.deepEqual(a.samples.map((x) => [x.t, x.value, x.kind]), [[10, 0.25, 'check'], [20, 0.5, 'check'], [40, 1, 'check'], [40, 1, 'validation']]);
  assert.equal(a.samples.filter((x) => x.accepted).length, 1, 'the summit where the protocol accepted');
  assert.deepEqual(a.samples.map((x) => x.round), [1, 3, 4, 4], 'round 2, closed without a check, has no sample');
  assert.deepEqual(a.budget, { tokens_used: 700, tokens_limit: 1000 });
  assert.equal(alone.climbers.find((c) => c.id === 'batches/b/A2')!.joined_at, 30);
  assert.deepEqual(alone.metrics[0].crest.map((c) => c.value), [0.25, 0.5, 0.75, 1]);
  assert.equal(alone.metrics[0].summit!.value, 1);
  assert.deepEqual(alone.ropes.map((r) => [r.kind, r.from, r.to, r.t]), [
    ['branch_opened', 'batches/b/A', 'batches/b/A.branches/delegation-r3.1', 25],
    ['directive', 'senior', 'batches/b/A', 30],
    ['branch_result', 'batches/b/A.branches/delegation-r3.1', 'batches/b/A', 45]], 'each rope at its delivery, from who sent it');
  assert.deepEqual(alone.events.map((e) => [e.kind, e.origin, e.t]), [['operator_command', 'operator', 32], ['end', 'harness', 50]]);
  assert.equal(senior.climbers.length, 1);
  assert.ok(a.samples.every((x) => /^[0-9a-f]{16}:\d+$/.test(x.ref)), 'every sample opens its event (acceptance 5)');
  assert.ok(a.states.some((x) => x.state === 'delega'));
});

test('VE2: the researchers\' profile gives only what they received; a cut, only what it holds; a cursor says unchanged', () => {
  const { dir, store } = workspace();
  write(path.join(dir, 'runs', 'art.json'), { experiment: 'artifacts@1', started: '2026-10-27T10:00:00.000Z', config: { seed: 1 }, events: [
    { t: 3, type: 'artifact_check', round: 1, laboratories: [{ place: 'p', correct: true, growth: { slope: 0.3 } }], told: { version: 'v1', laboratories: [{ place: 'p', your_artifact_holds_here: false, correct: true, better: false }] } }] });
  const op = climb(store, ['art'], 'operator'), re = climb(store, ['art'], 'researcher');
  assert.equal(op.groups[0].metrics.find((m) => m.id === 'growth_exponent')!.samples, 1);
  assert.equal(re.groups[0].metrics.find((m) => m.id === 'growth_exponent')!.samples, 0, 'what was kept for the operator gives no sample (acceptance 7)');
  assert.equal(re.groups[0].metrics.find((m) => m.id === 'correct')!.samples, 1, 'what it was told of its artifact does');
  const cut = climb(store, ['batches/b/A'], 'operator', { 'batches/b/A': 2 });
  assert.equal(cut.historical, true);
  assert.equal(cut.groups[0].climbers.length, 1, 'a cut adds no branch whose record runs past it');
  assert.equal(cut.groups[0].climbers[0].samples.length, 1);
  assert.equal(cut.groups[0].climbers[0].budget.tokens_used, null, 'a cut does not know what it had spent then');
  const live = climb(store, ['batches/b/A'], 'operator');
  assert.equal(climb(store, ['batches/b/A'], 'operator').cursor, live.cursor);
  write(path.join(dir, 'runs', 'batches', 'b', 'A.json'), { experiment: 'cells@1', started: '2026-10-27T10:00:00.000Z', config: { seed: 1 }, events: [check(10, 1, 4), check(70, 2, 16)] });
  assert.notEqual(climb(store, ['batches/b/A'], 'operator').cursor, live.cursor);
});

test('VE2: the endpoint serves the climb, unchanged since a cursor, and opens one of its verdicts', async () => {
  const { dir } = workspace();
  const c = await serveConsole({ root: dir, port: 0, env: {} });
  try {
    const base = c.url + '/api/research/';
    const q = 'climb?entities=' + encodeURIComponent(JSON.stringify(['batches/b/A'])) + '&profile=researcher';
    const v = await (await fetch(base + q)).json() as any;
    assert.equal(v.format, 'climb@1');
    const again = await (await fetch(base + q + '&since=' + v.cursor)).json() as any;
    assert.deepEqual(again, { format: 'climb@1', cursor: v.cursor, unchanged: true });
    const ref = v.groups[0].climbers[0].samples[0].ref;
    const e = await (await fetch(base + 'climb-event?entity=batches%2Fb%2FA&ref=' + encodeURIComponent(ref) + '&profile=researcher')).json() as any;
    assert.equal(e.type, 'check');
    const html = await (await fetch(c.url + '/research')).text();
    assert.ok(html.includes('data-tab="climb"'));
    assert.doesNotThrow(() => new Function(html.split('<script>')[1].split('</script>')[0]));
  } finally { await c.close(); }
});

test('VE4: a replay at an instant is what a cut at that instant holds (acceptance 8)', () => {
  const { store } = workspace();
  const ids = ['batches/b/A', 'batches/b/A2', 'batches/b/B'];
  const full = climb(store, ids, 'operator');
  for (const t of [0, 12, 26, 31, 44, 47]) {
    const replay = climbAt(full, t);
    const cut = climb(store, full.groups.flatMap((g) => g.climbers.map((c) => c.id)), 'operator', positionsAt(full, t));
    for (const g of replay.groups) {
      const h = cut.groups.find((x) => JSON.stringify(x.key) === JSON.stringify(g.key))!;
      for (const c of g.climbers) {
        const d = h.climbers.find((x) => x.id === c.id)!;
        assert.deepEqual(d.samples, c.samples, 'samples at ' + t);
        assert.deepEqual(d.plateaus, c.plateaus);
        assert.deepEqual(d.states, c.states);
        assert.equal(d.kind, c.kind, 'a branch in a cut still hangs from its requester');
      }
      assert.deepEqual(h.metrics.map((m) => m.crest), g.metrics.map((m) => m.crest), 'crest at ' + t);
      assert.deepEqual(h.ropes, g.ropes, 'ropes at ' + t);
      assert.deepEqual(h.events.filter((e) => e.kind !== 'resumed'), g.events.filter((e) => e.kind !== 'resumed'), 'events at ' + t);
    }
  }
});

test('VE5: in a living world, ropes between members where a delivery is recorded, and the world\'s record for the operator only', () => {
  const dir = root(), runs = path.join(dir, 'runs', 'live');
  const member = (actor: string, events: unknown[]) => write(path.join(runs, actor + '.json'), { experiment: 'plates@1', researcher: 'assisted', started: '2026-10-27T10:00:00.000Z',
    config: { seed: 1 }, world: { session: 's1', adapter: 'plates@1', actor, shared: true, journal: 's1.world.jsonl' }, events });
  member('alice', [
    { t: 2, type: 'world_window', round: 1, window: 1, by: 'alice' },
    { t: 3, type: 'message_sent', round: 1, to: 'bob', id: 'message:w1.alice.1', text: 'the rim grows' },
    { t: 4, type: 'message_sent', round: 1, to: 'bob', refused: 'too many' },
    { t: 6, type: 'world_window', round: 1, window: 2, by: 'wait', timeouts: ['bob'] }]);
  member('bob', [
    { t: 2.5, type: 'world_window', round: 1, window: 1, by: 'went_on' },
    { t: 7, type: 'messages_delivered', round: 1, messages: ['message:w1.alice.1', 'message:w1.alice.9'] },
    { t: 8, type: 'world_help', round: 1, message: 'message:w2.operator.1', text: 'look at the rim' }]);
  fs.writeFileSync(path.join(runs, 's1.world.jsonl'), [
    { key: 'manifest', actors: [{ id: 'alice', kind: 'researcher' }, { id: 'bob', kind: 'researcher' }] },
    { key: 'w1.commit', window: 1, from: 0, to: 9, outcomes: [], occurred: [{ kind: 'spill', well: 'A1', tick: 3 }], effects: [{ firing: 'f1', tick: 4 }] },
    { key: 'fire.p1@4', program: 'p1', mode: 'now', label: 'drought', at: 4 }].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const store = new ResearchStore(dir);
  const op = climb(store, ['live/alice', 'live/bob'], 'operator');
  assert.equal(op.groups.length, 1, 'members of one world climb one mountain');
  const g = op.groups[0];
  assert.deepEqual(g.ropes.map((r) => [r.kind, r.from, r.to, r.t]), [['message', 'live/alice', 'live/bob', 7], ['announcement', 'operator', 'live/bob', 8]],
    'drawn at delivery; a refused message and one not sent by a member are no rope');
  const kinds = g.events.map((e) => e.kind);
  assert.ok(kinds.includes('world_occurred') && kinds.includes('operator_fire') && kinds.includes('operator_firing') && kinds.includes('window_timeout'));
  assert.equal(g.events.find((e) => e.kind === 'world_occurred')!.t, 2, 'a window placed on the clock by the first member that logged it');
  assert.ok(g.climbers.find((c) => c.id === 'live/alice')!.states.some((x) => x.state === 'espera'));
  const re = climb(store, ['live/alice', 'live/bob'], 'researcher');
  assert.ok(!re.groups[0].events.some((e) => e.kind === 'world_occurred' || e.kind === 'operator_fire' || e.kind === 'window_timeout'), 'what happened unperceived, and others\' timeouts, are the operator\'s (§9)');
  assert.deepEqual(re.groups[0].ropes.map((r) => r.kind), ['message', 'announcement'], 'what reached the researchers they perceived');
  assert.ok(re.groups[0].climbers.find((c) => c.id === 'live/alice')!.states.some((x) => x.state === 'espera'));
});

test('VE6: a climb exported whole replays with no server and nothing from outside (acceptance 9)', async () => {
  const { dir } = workspace();
  const c = await serveConsole({ root: dir, port: 0, env: {} });
  try {
    const q = 'climb-export?entities=' + encodeURIComponent(JSON.stringify(['batches/b/A'])) + '&profile=researcher';
    const r = await fetch(c.url + '/api/research/' + q);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.ok(!/<(link|img|iframe)\b/i.test(html) && !/\b(src|href)\s*=\s*["']?(https?:)?\/\//i.test(html), 'no resource from outside');
    const js = html.split('<script>')[1].split('</script>')[0];
    assert.doesNotThrow(() => new Function(js));
    const data = JSON.parse(js.split('const DATA=')[1].split(';const EVENTS=')[0]);
    assert.equal(data.format, 'climb@1'); assert.equal(data.profile, 'researcher');
    const events = JSON.parse(js.split(';const EVENTS=')[1].split(';\nconst $=')[0]);
    const refs = data.groups.flatMap((g: any) => g.climbers.flatMap((x: any) => x.samples.map((s: any) => s.ref)));
    assert.ok(refs.length && refs.every((ref: string) => events.some((e: any) => e.id === ref)), 'every sample opens its event offline');
    assert.ok(!events.some((e: any) => e.type === 'operator_command'), 'only what this profile received');
    assert.ok(js.includes('window.CLIMB_STATIC=true'));
  } finally { await c.close(); }
});
