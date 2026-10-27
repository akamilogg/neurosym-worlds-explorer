import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { platesLab } from '../src/worlds/plates/lab.ts';
import { platesAdapter, type PlatesFrame, type PlatesState } from '../src/worlds/plates/world.ts';
import { LivingSession, WorldJournal, type ActorDecl, type LivingWorldAdapter, type PolicyActor } from '../src/living/world.ts';
import { runLivingSession, type SessionPlan } from '../src/living/run-session.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';

/* SPEC-ACONTECIMIENTOS-DEL-MUNDO, H2: several members in one world - researchers and actors that are not -, the junior's
   exclusive authority over its body, the channels and what is shared. Acceptance tests 2, 5, 6, 9, 11, 15; 12 for the
   publication and delivery of messages; 17 with a member that leaves; no advantage from the order of answers within the
   window's time; the exchange replayed. */

const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), name + '-'));
const MESSAGES = { messages_per_window: 2, message_chars: 200, delivery_per_decision: 8 };
function world(actors: readonly (string | ActorDecl)[], o: { file?: string | null; from?: string; limits?: Record<string, number>; adapter?: LivingWorldAdapter<PlatesState, PlatesFrame>; seed?: number } = {}) {
  return new LivingSession({ adapter: (o.adapter ?? platesAdapter) as never, id: 'world:h2', config: { layout: 5 }, seed: o.seed ?? 5, actors,
    clock: { decision_interval: 3, horizon: 120 }, limits: { calls_per_window: 4, intents_per_window: 3, ...MESSAGES, ...(o.limits ?? {}) },
    journal: new WorldJournal(o.file ?? null, o.from ? { from: o.from } : {}) });
}
const plate = (s: LivingSession<unknown, unknown>, a: string) => s.observe(a).view as PlatesFrame;
const emptyWell = (f: PlatesFrame): string => { const i = f.colony.replace(/\//g, '').split('').findIndex((c, k) => c === '0' && f.nutrient.replace(/\//g, '')[k] !== '0'); return 'ABCD'[Math.floor(i / 6)] + (i % 6 + 1); };
const lines = (f: string) => fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const strip = (entries: Record<string, unknown>[]) => entries.map(({ at: _a, ...e }) => e);

test('2: members decide on one revision; a conflict and compatible acts resolved by the seed\'s order, whoever sealed first', () => {
  const play = (first: 'a' | 'b') => {
    const s = world(['a', 'b']);
    assert.equal(s.observe('a').revision, s.observe('b').revision, 'the same revision for both');
    const well = emptyWell(plate(s, 'a'));
    const batch = [{ kind: 'inoculate', params: { well } }, { kind: 'feed', params: { well: 'A1', amount: 2 } }];
    for (const who of first === 'a' ? ['a', 'b'] : ['b', 'a']) assert.ok(s.seal(who, batch).every((r) => r.accepted), 'each valid on the revision it saw');
    const w = s.runWindow()!;
    return { outcomes: w.outcomes.map((o) => [o.intent, o.outcome]), plate: plate(s, 'a') };
  };
  const one = play('a'), two = play('b');
  assert.deepEqual(one, two, 'who sealed first changes nothing');
  const inoculations = one.outcomes.filter(([i]) => (i as string).endsWith(':1'));
  assert.deepEqual(inoculations.map(([, o]) => o).sort(), ['applied', 'conflict'], 'one well, one colony: the second is a conflict, without its effects');
  assert.ok(one.outcomes.filter(([i]) => (i as string).endsWith(':2')).every(([, o]) => o === 'applied'), 'feeding the same well twice: compatible, both');
  /* The order rotates: across windows each member comes first in turn. */
  const file = path.join(tmp('h2-2'), 'w.world.jsonl');
  const s = world(['a', 'b'], { file });
  for (let k = 0; k < 4; k++) { s.seal('a', []); s.seal('b', []); s.runWindow(); }
  const firsts = lines(file).filter((e) => /\.prepare$/.test(e.key)).map((e) => e.order[0]);
  assert.deepEqual(new Set(firsts).size, 2);
  assert.notEqual(firsts[0], firsts[1]);
});

test('5: a direct message reaches its recipient only, after its window; global reaches every member then, each with its own receipt; a newcomer reads history only as allowed', () => {
  const dir = tmp('h2-5');
  const file = path.join(dir, 'w.world.jsonl');
  const s = world(['a', 'b', 'c'], { file, limits: { actors: 5 } });
  assert.equal(s.send('a', { actor: 'b' }, 'notice', { text: 'B4 grows' }).accepted, true);
  assert.equal(s.send('c', { channel: 'global' }, 'notice', { text: 'to all' }).accepted, true);
  assert.deepEqual(s.inbox('b').messages, [], 'never in the middle of the window it was published in');
  for (const a of ['a', 'b', 'c']) s.seal(a, []);
  s.runWindow();
  assert.deepEqual(s.inbox('b').messages.map((m) => m.body.text), ['B4 grows', 'to all']);
  assert.deepEqual(s.inbox('c').messages.map((m) => m.body.text), [], 'A→B does not reach C, nor its own global');
  assert.deepEqual(s.inbox('a').messages.map((m) => m.body.text), ['to all']);
  s.receive('a', s.inbox('a').messages.map((m) => m.id), 'delivered');
  s.receive('b', s.inbox('b').messages.map((m) => m.id), 'delivered');
  const keys = lines(file).map((e) => e.key);
  assert.ok(keys.includes('r.a.message:w1.c.1') && keys.includes('r.b.message:w1.c.1'), 'one receipt per recipient');
  assert.equal(s.use.messages, 2, 'a global message counted once');
  assert.equal(s.use.deliveries, 3, 'its deliveries, per recipient');
  /* A newcomer: nothing of the past delivered; its history as allowed. */
  assert.deepEqual(s.join({ id: 'd', kind: 'researcher' }), { accepted: true });
  assert.deepEqual(s.join({ id: 'e', kind: 'researcher', history: false }), { accepted: true });
  assert.deepEqual(s.inbox('d').messages, []);
  assert.deepEqual(s.history('d').messages.map((m) => m.body.text), ['to all']);
  assert.deepEqual(s.history('e').messages, [], 'without the permission: from its joining on');
  /* An identity is the session's: a message carries the sender the session knows, whatever it says. */
  s.send('b', { actor: 'a' }, 'notice', { text: 'hi', from: 'c' });
  for (const a of ['a', 'b', 'c', 'd', 'e']) s.seal(a, []);
  s.runWindow();
  const m = s.inbox('a').messages.find((x) => x.body.text === 'hi')!;
  assert.equal(m.from, 'b');
});

test('11: limits of members, messages, size, intents and calls - refused whole, never cut; nothing counted twice', () => {
  const s = world(['a', 'b'], { limits: { actors: 2, messages_per_window: 1 } });
  assert.match((s.join({ id: 'c', kind: 'researcher' }) as { reason: string }).reason, /at most 2 members/);
  assert.equal(s.send('a', { actor: 'b' }, 'notice', { text: 'one' }).accepted, true);
  assert.match((s.send('a', { actor: 'b' }, 'notice', { text: 'two' }) as { reason: string }).reason, /at most 1 messages of yours in one window/);
  assert.match((s.send('b', { actor: 'a' }, 'notice', { text: 'x'.repeat(500) }) as { reason: string }).reason, /nothing of it was cut, nothing was sent/);
  assert.match(s.seal('a', Array.from({ length: 4 }, () => ({ kind: 'feed', params: { well: 'A1', amount: 1 } })))[0].reason!, /at most 3 intents/);
  for (let k = 0; k < 3; k++) assert.equal(s.call('b'), false);
  assert.equal(s.call('b'), true, 'its fourth call: its batch sealed empty');
  assert.equal(s.use.calls, 4);
  assert.throws(() => world(['a', 'a']), /same id/);
  assert.throws(() => new LivingSession({ adapter: platesAdapter as never, id: 'x', config: {}, seed: 1, actors: ['a'], clock: { decision_interval: 1, horizon: 5 },
    limits: { calls_per_window: 1, intents_per_window: 1, messages_per_window: 2 }, journal: new WorldJournal(null) }), /size/);
  /* Without a limit of messages, nobody may publish: nothing is unlimited by default. */
  const quiet = new LivingSession({ adapter: platesAdapter as never, id: 'q', config: {}, seed: 1, actors: ['a', 'b'], clock: { decision_interval: 1, horizon: 5 },
    limits: { calls_per_window: 1, intents_per_window: 1 }, journal: new WorldJournal(null) });
  assert.match((quiet.send('a', { actor: 'b' }, 'notice', { text: 'x' }) as { reason: string }).reason, /nobody may publish/);
});

test('15: actors that are not researchers decide from their own view and inbox only; a hypothesis told to them they read', () => {
  /* A spy policy: what it is given, each window. */
  const given: string[][] = [];
  const spy: PolicyActor<PlatesFrame> = { kind: 'adversary', initial: () => 0, decide: (o) => { given.push(Object.keys(o).sort()); return { intents: [], state: (o.state as number) + 1 }; } };
  const adapter = { ...platesAdapter, policies: { ...platesAdapter.policies, spy: () => spy } };
  const s = world(['a', { id: 'x', kind: 'adversary', policy: 'spy', actions: ['drain'] }], { adapter });
  s.seal('a', []); s.runWindow();
  assert.deepEqual(given[0], ['inbox', 'state', 'view', 'window'], 'its view, its inbox, its own state: nothing of anyone else');
  /* The adversary reads what it was told: told of a well, it drains it. */
  const t = world(['a', { id: 'adv', kind: 'adversary', policy: 'adversary', actions: ['drain'] }]);
  const rich = (() => { const n = plate(t, 'a').nutrient.replace(/\//g, ''); const i = n.split('').findIndex((c) => Number(c) >= 4); return 'ABCD'[Math.floor(i / 6)] + (i % 6 + 1); })();
  t.send('a', { actor: 'adv' }, 'notice', { text: 'my hypothesis: ' + rich + ' feeds the colony next to it' });
  t.seal('a', []); t.runWindow();
  t.seal('a', []);
  const w = t.runWindow()!;
  assert.ok(w.outcomes.some((o) => o.intent.startsWith('adv:') && o.outcome === 'applied'), 'it acted on what it was told');
  /* A researcher may not drain: the permission is the manifest's. */
  const u = world(['a', { id: 'c', kind: 'policy', policy: 'consumer', actions: ['drain'] }]);
  assert.match(u.seal('a', [{ kind: 'drain', params: { well: 'A1', amount: 1 } }])[0].reason!, /you may not "drain"/);
  /* A population: its variation and selection in its state, the same from the same seed. */
  const pop = (seed: number) => { const p = world(['a', { id: 'p', kind: 'population', policy: 'population', params: { size: 3, every: 2 }, actions: ['drain'] }], { seed });
    for (let k = 0; k < 6; k++) { p.seal('a', []); p.runWindow(); } return p.close('end'); };
  assert.deepEqual(pop(9).state, pop(9).state);
  assert.throws(() => world(['a', { id: 'z', kind: 'policy', policy: 'nobody', actions: [] }]), /no policy "nobody"/);
});

test('12 (messages): stopped after a publication and before its delivery - derived again, published once, received once', () => {
  const dir = tmp('h2-12');
  const first = path.join(dir, 'a.world.jsonl');
  const play = (file: string, from?: string) => {
    const s = world(['a', 'b'], { file, ...(from ? { from } : {}) });
    s.send('a', { actor: 'b' }, 'notice', { text: 'look at C3' });
    s.seal('a', []); s.seal('b', []); s.runWindow();
    s.receive('b', s.inbox('b').messages.map((m) => m.id), 'delivered');
    s.send('b', { channel: 'global' }, 'notice', { text: 'seen' });
    s.seal('a', []); s.seal('b', []); s.runWindow();
    s.receive('a', s.inbox('a').messages.map((m) => m.id), 'delivered');
    return s;
  };
  play(first);
  const all = lines(first);
  const cut = all.findIndex((e) => e.key === 'm.message:1');
  fs.writeFileSync(first, all.slice(0, cut + 1).map((e) => JSON.stringify(e)).join('\n') + '\n');
  const second = path.join(dir, 'b.world.jsonl');
  const s = play(second, first);
  const keys = lines(second).map((e) => e.key);
  assert.equal(new Set(keys).size, keys.length, 'nothing twice');
  assert.deepEqual(keys, all.map((e) => e.key), 'every publication and receipt, once');
  assert.equal(s.journal.diverged.length, 0);
});

test('17 (a member leaves): what it began goes on; its messages stay; nobody waits for it; nothing reaches it any more', () => {
  const s = world(['a', 'b']);
  s.send('b', { channel: 'global' }, 'notice', { text: 'before leaving' });
  s.seal('a', []); s.seal('b', [{ kind: 'clean', params: { well: 'B2' } }]);
  s.runWindow();
  s.seal('b', [{ kind: 'clean', params: { well: 'C3' } }]);
  s.retire('b', 'its budget ended');
  assert.equal(s.ready(), false, 'a still decides');
  s.seal('a', []);
  s.settle();
  assert.equal(s.window, 2, 'nobody waits for the member that left');
  assert.ok(s.windowRecord(2)!.outcomes.some((o) => o.intent === 'b:2' && o.outcome === 'applied'), 'what it had decided before leaving is applied');
  s.seal('a', []); s.settle();
  assert.equal(s.window, 3, 'the world goes on without it');
  assert.equal(s.actorState('b'), 'stopped');
  assert.match((s.send('a', { actor: 'b' }, 'notice', { text: 'x' }) as { reason: string }).reason, /left the session/);
  assert.deepEqual(s.history('a').messages.map((m) => m.body.text), ['before leaving'], 'what it published stays');
  assert.equal(s.close('end').status, 'completed');
});

test('a window waits only so long: the member that did not seal is a timeout, its batch decided on a passed revision is late', async () => {
  const dir = tmp('h2-timeout');
  const s = world(['a', 'b'], { file: path.join(dir, 'w.world.jsonl'), limits: { window_ms: 40 } });
  s.seal('a', [{ kind: 'feed', params: { well: 'A1', amount: 1 } }]);
  const w = await s.commit('a');
  assert.deepEqual(w!.timeouts, ['b']);
  assert.ok(lines(path.join(dir, 'w.world.jsonl')).some((e) => e.key === 'w1.timeout'));
  assert.match(s.seal('b', [{ kind: 'feed', params: { well: 'A2', amount: 1 } }], 0)[0].reason!, /late: you decided on revision 0/);
  assert.equal(s.summary().members && (s.summary().members as Record<string, { timeouts: number }>).b.timeouts, 1);
  s.close('end');
});

test('9: the junior alone acts for its body; its senior is no member of the world', () => {
  const s = world(['a']);
  assert.throws(() => s.seal('a:senior', [{ kind: 'feed', params: { well: 'A1', amount: 1 } }]), /no actor/);
  assert.deepEqual(s.members().map((m) => m.id), ['a']);
});

/* --- Two researchers in one world --------------------------------------------------------------------------------------- */

const MODEL = { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.frames[p.frames.length - 1].colony', validate: false, lessons: ['l'], next_experiment: 'n', beliefs: [] };
const reply = (content: unknown) => { const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } }); return { ok: true, status: 200, text: async () => text, headers: { get: () => null } }; };

const SCRIPTS: Record<string, Record<number, unknown[]>> = {
  /* a: acts, then shares what it watched and cites it to b, then proposes. */
  a: { 1: [{ investigate: [{ act: { feed: 'A1', amount: 2 } }] },
    { investigate: [{ share: { episode: 'act3', to: 'b', text: 'what feeding did' } }, { send: { to: 'b', text: 'I fed A1', refs: ['act3'] } }, { send: { to: 'b', text: 'not mine', refs: ['from-b-act9'] } }] },
    MODEL], 2: [MODEL] },
  /* b: looks until its window goes on, then reads what came: the shared copy, a reference that gives no access, a re-share. */
  b: { 1: [{ investigate: [{ observe: true }] }, { investigate: [{ observe: true }] }, { investigate: [{ observe: true }] }, { investigate: [{ observe: true }] },
    { investigate: [{ view: 'from-a--act3', from: 0, to: 1 }, { view: 'a:act3', from: 0, to: 1 }] },
    { investigate: [{ share: { episode: 'from-a--act3', to: 'a' } }, { members: true }, { read: { channel: 'global' } }] },
    MODEL], 2: [MODEL] }
};

async function pair(dir: string, delays: Record<string, number> = {}) {
  const asked: Record<string, Record<string, any>[]> = { a: [], b: [] };
  const fetchOf = (actor: string): FetchLike => async (_url, init) => {
    await new Promise((r) => setTimeout(r, delays[actor] ?? 0));
    const user = JSON.parse(userOf(JSON.parse(String(init.body))));
    asked[actor].push(user);
    if ('task' in user) return reply({ rationale: 'r', beliefs: [], lessons: ['l'], next_experiment: 'n' });
    const steps = SCRIPTS[actor][user.round] ?? [MODEL];
    return reply(steps[Math.min((user.investigation ?? []).length, steps.length - 1)]);
  };
  const plan: SessionPlan = { seed: 2, clock: { decision_interval: 3, horizon: 200 }, explore: 2,
    limits: { calls_per_window: 2, intents_per_window: 3, messages_per_window: 3, message_chars: 300, delivery_per_decision: 8, window_ms: 20000 },
    actors: [{ id: 'a', kind: 'researcher', rounds: 2, steps: 8, acts: 3 }, { id: 'b', kind: 'researcher', rounds: 2, steps: 8, acts: 3 },
      { id: 'consumer', kind: 'policy', policy: 'consumer', actions: ['drain'] }] };
  const r = await runLivingSession(platesLab, { plan, dir, name: 'pair', root: dir, args: ['--flat', '--no-grade', '--no-reflection', '--no-ablation'],
    connection: (actor) => ({ llm: { url: 'http://x.test/c', model: 's' }, fetch: fetchOf(actor) }) });
  const events = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8')).events as Record<string, any>[];
  return { r, asked, a: events(r.runs.a.journal!), b: events(r.runs.b.journal!) };
}

test('6, 9 and the exchange: two researchers in one world - a copy shared keeps its version, a reference gives no access, nothing of another\'s re-shared; what reaches the junior reaches its senior\'s view', async () => {
  const { r, asked, a, b } = await pair(tmp('h2-pair'));
  assert.equal(r.runs.a.error, undefined, String(r.runs.a.error));
  assert.equal(r.runs.b.error, undefined, String(r.runs.b.error));
  const shared = a.find((e) => e.type === 'material_shared');
  assert.ok(shared?.id, JSON.stringify(shared));
  /* A reference to material it does not own: refused. */
  const steps = asked.a.filter((u) => u.round === 1).at(-1)!.investigation as Record<string, any>[];
  assert.match(steps[1].results[2].reason, /cites your own material only/);
  /* b got the copy, with its version and its author; it can view it; "a:act3" gives it nothing. */
  const delivered = b.filter((e) => e.type === 'channel_delivered').flatMap((e) => e.delivered.notices ?? []);
  const notice = delivered.find((n: any) => n.from === 'actor:a' && n.body.shared);
  assert.ok(notice, 'the shared copy reached b through its channel');
  assert.equal(notice.body.shared.version_hash, shared.version_hash, 'the same version');
  assert.equal(notice.body.shared.episode, 'from-a--act3');
  const bSteps = asked.b.filter((u) => u.round === 1).at(-1)!.investigation as Record<string, any>[];
  const viewed = bSteps.find((s) => s.requests?.[0]?.view === 'from-a--act3')!;
  assert.ok(viewed.results[0].frames?.length, 'it views the copy');
  assert.equal(viewed.results[1].error, 'no such episode', 'a reference is not access');
  const reshare = bSteps.find((s) => s.requests?.[0]?.share)!;
  assert.match(reshare.results[0].reason, /share what is yours: from-a--act3 is what a shared with you/);
  assert.ok(reshare.results[1].members.some((m: any) => m.id === 'consumer' && m.kind === 'policy'));
  /* 9: what reached the junior is in its channel's record - what its senior is given, as it was. */
  assert.ok(b.some((e) => e.type === 'channel_delivered' && JSON.stringify(e.delivered).includes('actor:a')));
  /* The session: each run left it, then it closed; its members and their counts. */
  assert.equal(r.summary.status, 'completed');
  const members = r.summary.members as Record<string, any>;
  assert.equal(members.a.state, 'stopped');
  assert.ok(members.consumer.applied > 0, 'the consumer acted every window');
});

test('the order of answers within the window\'s time changes nothing: the same world, the same exchange', async () => {
  const one = await pair(tmp('h2-order-1'), { a: 25, b: 0 });
  const two = await pair(tmp('h2-order-2'), { a: 0, b: 25 });
  assert.deepEqual(strip(lines(one.r.world)), strip(lines(two.r.world)));
  assert.deepEqual(one.asked.b.map((u) => u.investigation?.length ?? 0), two.asked.b.map((u) => u.investigation?.length ?? 0));
});
