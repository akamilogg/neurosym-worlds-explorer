import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Channel, CHANNEL_ABOUT } from '../src/learn/assisted/channel.ts';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';
import type { LawLab } from '../src/learn/lab.ts';
import type { FetchLike } from '../src/core/net.ts';

/* SPEC-CANAL-MENSAJES, plan step 1: the channel and its delivery. */

test('a notice is delivered once; a pinned message at every opening with its value then, and within a conversation only when it changes', () => {
  const logged: { type: string; data: Record<string, unknown> }[] = [];
  const c = new Channel((type, data) => logged.push({ type, data }));
  let live = 1;
  c.publish('self', { kind: 'pinned', key: 'tasks', body: () => ({ open: live }) });
  c.publish('world', { kind: 'pinned', key: 'accepted', body: 'v1' });
  c.publish('operator', { kind: 'notice', body: 'look at the borders' });
  const first = c.deliver({ round: 1, question: 0, opening: true }) as any;
  assert.deepEqual(first.channel.pinned.map((p: any) => p.key), ['world:accepted', 'self:tasks'], 'by author, in a fixed order');
  assert.equal(first.channel.notices[0].body, 'look at the borders');
  assert.equal(c.deliver({ round: 1, question: 1, opening: false }), null, 'nothing new: nothing added');
  live = 2;
  const changed = c.deliver({ round: 1, question: 2, opening: false }) as any;
  assert.deepEqual(changed.channel.pinned, [{ key: 'self:tasks', from: 'self', value: { open: 2 } }], 'a live value read when delivered; only what changed');
  assert.equal(changed.channel.notices, undefined, 'a notice once');
  c.publish('world', { kind: 'pinned', key: 'accepted', unpin: true });
  assert.deepEqual((c.deliver({ round: 1, question: 3, opening: false }) as any).channel.unpinned, ['world:accepted']);
  const opening = c.deliver({ round: 2, question: 0, opening: true }) as any;
  assert.deepEqual(opening.channel.pinned.map((p: any) => p.key), ['self:tasks'], 'every pinned message again at an opening');
  assert.deepEqual(c.publish('self', { kind: 'pinned' }), { refused: 'a pinned message has a key' });
  assert.ok(logged.some((e) => e.type === 'channel_delivered') && logged.some((e) => e.type === 'channel_published'));
});

type Message = { role: string; content: string };
const llm = { url: 'http://system2.test/chat', model: 'stand-in' };
const parts = (m: Message[]): Record<string, any>[] => m.slice(1).map((x) => { try { return JSON.parse(x.content); } catch { return {}; } });

/** A world that publishes, as any world may: a notice for each episode it draws, and how many it drew, pinned. */
function publishing(): LawLab {
  let drawn = 0;
  return { ...(cellsLab as LawLab), episode: (spec: unknown, rnd: () => number, ctx?: any) => {
    drawn++;
    ctx?.publish?.({ kind: 'notice', body: { drawn } });
    ctx?.publish?.({ kind: 'pinned', key: 'drawn', body: Math.ceil(drawn / 4) });
    return (cellsLab as LawLab).episode(spec as never, rnd, ctx);
  } } as LawLab;
}

function junior(asked: Message[][]): FetchLike {
  return async (_url, init) => {
    const b = JSON.parse(String(init.body));
    const messages = b.messages as Message[];
    const grading = messages[0].content.startsWith('You grade');
    if (!grading) asked.push(messages);
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
const ARGS = ['--seed', '1', '--level', '1', '--flat', '--no-grade', '--tools', 'view', '--attempts', '3'];

test('in a run: what the world publishes reaches the assisted researcher in parts added to its conversation - each notice once, the pinned at every round - and a resume delivers the same', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-'));
  const asked: Message[][] = [];
  const r = await runLaboratory(publishing(), { args: [...ARGS, '--researcher', 'assisted', '--out', path.join(dir, 'run.json')], root: dir, llm, fetch: junior(asked) });
  assert.ok(asked.every((m) => !m[0].content.includes(CHANNEL_ABOUT)), 'nothing of the channel in its system prompt');
  const channelParts = asked.map((m) => parts(m).filter((p) => p.channel).map((p) => p.channel));
  /* Each notice once in the run: a later question repeats the parts of its round, so count them where they first appear. */
  const seen = new Map<string, number>();
  for (let i = 0; i < asked.length; i++) {
    const before = i > 0 && asked[i][1].content === asked[i - 1][1].content ? channelParts[i - 1].length : 0;
    for (const c of channelParts[i].slice(before)) for (const n of c.notices ?? []) seen.set(n.id, (seen.get(n.id) ?? 0) + 1);
  }
  assert.ok(seen.size >= 3, 'notices were published and delivered: ' + seen.size);
  assert.ok([...seen.values()].every((n) => n === 1), 'each notice delivered once');
  /* The pinned value at the start of every round. */
  const openings = asked.filter((m, i) => i === 0 || m[1].content !== asked[i - 1][1].content).filter((m) => !('task' in parts(m)[0]));
  assert.ok(openings.length >= 3);
  assert.ok(openings.every((m) => parts(m)[1]?.channel?.pinned?.some((p: any) => p.key === 'world:drawn')), 'right after the round\'s first part');
  assert.ok(openings.every((m) => parts(m)[1].channel.about === CHANNEL_ABOUT), 'saying what it is, at every opening');
  /* The conversation only grows. */
  for (let i = 1; i < asked.length; i++) if (asked[i][1].content === asked[i - 1][1].content)
    assert.deepEqual(asked[i].slice(0, asked[i - 1].length), asked[i - 1], 'question ' + i);
  const events = (j: string) => JSON.parse(fs.readFileSync(j, 'utf8')).events.filter((e: any) => e.type === 'channel_delivered').map(({ t: _t, ...e }: any) => e);
  assert.ok(events(r.journal).length >= 3, 'every delivery logged');
  /* Resumed (cut by its tokens, then given more): the same deliveries at the same questions. */
  const cut = await runLaboratory(publishing(), { args: [...ARGS, '--researcher', 'assisted', '--max-tokens', '450', '--no-reflection', '--out', path.join(dir, 'cut.json')], root: dir, llm, fetch: junior([]) });
  assert.equal(cut.stoppedBy, 'token_budget');
  const resumed = await runLaboratory(publishing(), { args: ['--resume', cut.journal, '--out', path.join(dir, 'resumed.json')], root: dir, llm, fetch: junior([]) });
  assert.notEqual(resumed.stoppedBy, 'diverged');
  assert.deepEqual(events(resumed.journal).slice(0, events(cut.journal).length), events(cut.journal));
});

test('the unknown-world researcher has no channel: nothing published reaches it, its prompt unchanged', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-pure-'));
  const asked: Message[][] = [];
  await runLaboratory(publishing(), { args: [...ARGS, '--out', path.join(dir, 'pure.json')], root: dir, llm, fetch: junior(asked) });
  assert.ok(asked.length > 0);
  assert.ok(asked.every((m) => parts(m).every((p) => !p.channel)));
});

/* --- Step 2: what System 2 pins itself (SPEC-CANAL-MENSAJES §6). */

test('its pins as written: a document, a notice or a text, one of them; unpin by id; what cannot be read is a warning', async () => {
  const { parsePins } = await import('../src/learn/assisted/channel.ts');
  const warnings: string[] = [];
  const ops = parsePins([{ do: 'pin', id: 'tasks', document: 'tasks' }, { do: 'pin', id: 'x', text: 'a', document: 'b' }, { do: 'unpin', id: 'note' }, { do: 'keep', id: 'y' }, { do: 'pin', id: 'Bad' }], warnings);
  assert.deepEqual(ops, [{ do: 'pin', id: 'tasks', document: 'tasks' }, { do: 'unpin', id: 'note' }]);
  assert.equal(warnings.length, 3);
});

test('a run: it pins its own task list and a text, and they reach it every round - the list in its latest version, within the round when it changes; unpinned, gone; resumed, the same', async () => {
  const { PINS_SECTION } = await import('../src/learn/assisted/channel.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-pins-'));
  const asked: Message[][] = [];
  const answers: FetchLike = async (_url, init) => {
    const b = JSON.parse(String(init.body));
    const messages = b.messages as Message[];
    const grading = messages[0].content.startsWith('You grade');
    if (!grading) asked.push(messages);
    const ps = parts(messages);
    const first = ps[0] ?? {};
    const looked = ps.some((p) => p.investigation_step);
    const round = first.round;
    const content = grading ? { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' }
      : 'task' in first ? { rationale: 'r', beliefs: [{ id: 'same', stance: 'keep', why: 'w' }], lessons: ['l'], next_experiment: 'n' }
      : !looked && round === 1 ? { investigate: [{ view: 'ep1', from: 0, to: 2 }], documents: [{ do: 'write', id: 'tasks', text: '1. look at the rows' }],
        pins: [{ do: 'pin', id: 'tasks', document: 'tasks' }, { do: 'pin', id: 'note', text: 'the borders matter' }] }
      : !looked && round === 2 ? { investigate: [{ view: 'ep1', from: 0, to: 2 }], documents: [{ do: 'write', id: 'tasks', text: '1. done\n2. test the neighbours' }] }
      : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]', validate: false,
        beliefs: [{ id: 'same', stance: round === 1 ? 'new' : 'keep', statement: 'the row repeats', evidence: [] }], lessons: ['l'], next_experiment: 'n',
        ...(round === 2 ? { pins: [{ do: 'unpin', id: 'note' }, { do: 'pin', id: 'old', message: 'm999' }] } : {}) };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
  const r = await runLaboratory(cellsLab, { args: [...ARGS, '--researcher', 'assisted', '--out', path.join(dir, 'run.json')], root: dir, llm, fetch: answers });
  assert.ok(asked.every((m) => m[0].content.includes(PINS_SECTION)), 'its prompt says how to pin');
  const roundOf = (m: Message[]) => parts(m)[0].round;
  const openingOf = (round: number) => asked.find((m) => roundOf(m) === round && !('task' in parts(m)[0]))!;
  const pinnedAt = (m: Message[], key: string) => parts(m).filter((p) => p.channel?.pinned).flatMap((p) => p.channel.pinned).filter((p: any) => p.key === key);
  /* Round 1: pinned after its first answer, so it reaches it at its next question, within the round. */
  const r1 = asked.filter((m) => roundOf(m) === 1);
  assert.equal(pinnedAt(r1[1], 'self:tasks')[0].value.text, '1. look at the rows');
  assert.ok(parts(r1[1]).some((p) => (p.your_pins ?? []).includes('pin tasks')), 'what it pinned, echoed');
  /* Round 2 opens with both; the list rewritten within the round reaches it in its latest version at the next question. */
  const o2 = openingOf(2);
  assert.deepEqual(pinnedAt(o2, 'self:tasks').map((p: any) => p.value.version), [1]);
  assert.equal(pinnedAt(o2, 'self:note')[0].value, 'the borders matter');
  const r2 = asked.filter((m) => roundOf(m) === 2);
  assert.deepEqual(pinnedAt(r2[1], 'self:tasks').map((p: any) => p.value.version), [1, 2], 'within the round, only when it changed');
  /* Round 3: the note was unpinned; a notice it never received cannot be pinned. */
  const o3 = openingOf(3);
  assert.deepEqual(pinnedAt(o3, 'self:tasks').map((p: any) => p.value.text), ['1. done\n2. test the neighbours']);
  assert.equal(pinnedAt(o3, 'self:note').length, 0);
  const events = JSON.parse(fs.readFileSync(r.journal, 'utf8')).events as Record<string, any>[];
  assert.ok(events.some((e) => e.type === 'proposal' && (e.warnings ?? []).some((w: string) => /pin "old": no notice "m999"/.test(w))), 'refused, and said why');
  /* The conversation only grows. */
  for (let i = 1; i < asked.length; i++) if (asked[i][1].content === asked[i - 1][1].content)
    assert.deepEqual(asked[i].slice(0, asked[i - 1].length), asked[i - 1], 'question ' + i);
  /* Resumed, cut by its tokens: no divergence. */
  const cut = await runLaboratory(cellsLab, { args: [...ARGS, '--researcher', 'assisted', '--max-tokens', '350', '--no-reflection', '--out', path.join(dir, 'cut.json')], root: dir, llm, fetch: answers });
  assert.equal(cut.stoppedBy, 'token_budget');
  const resumed = await runLaboratory(cellsLab, { args: ['--resume', cut.journal, '--out', path.join(dir, 'resumed.json')], root: dir, llm, fetch: answers });
  assert.notEqual(resumed.stoppedBy, 'diverged');
  /* --no-pins: neither the line nor its pins. */
  const without: Message[][] = [];
  const counting: FetchLike = async (u, init) => { without.push(JSON.parse(String(init.body)).messages); return answers(u, init); };
  await runLaboratory(cellsLab, { args: [...ARGS, '--researcher', 'assisted', '--no-pins', '--out', path.join(dir, 'nopins.json')], root: dir, llm, fetch: counting });
  assert.ok(without.every((m) => !m[0].content.includes(PINS_SECTION) && parts(m).every((p) => !(p.channel?.pinned ?? []).some((x: any) => x.from === 'self'))), 'nothing of its own pinned');
});

/* --- Step 3: the world publishes; the finding keeps the chain (SPEC-CANAL-MENSAJES §5, plan step 3). */

test('every version of the artifact accepted reaches the researcher as a notice of the world, and the finding keeps the chain: the last is the product', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-artifact-'));
  /* A world with an artifact of its own: a version holds where its name begins with "good" (the verdict is the world's). */
  const lab = { ...(cellsLab as LawLab),
    blindPlaces: (spec: unknown, set: number) => [{ id: 'blind' + set, spec }],
    artifact: {
      known: () => true,
      check: async (_spec: unknown, version: string) => ({ holds: version.startsWith('good'), view: { correct: true, better: version.startsWith('good') }, journal: { version } })
    } } as unknown as LawLab;
  const asked: Message[][] = [];
  const answers: FetchLike = async (_url, init) => {
    const b = JSON.parse(String(init.body));
    const messages = b.messages as Message[];
    const grading = messages[0].content.startsWith('You grade');
    if (!grading) asked.push(messages);
    const first = parts(messages)[0] ?? {};
    const round = first.round;
    const content = grading ? { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' }
      : 'task' in first ? { rationale: 'r', beliefs: [{ id: 'same', stance: 'keep', why: 'w' }], lessons: ['l'], next_experiment: 'n' }
      : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]', validate: false,
        beliefs: [{ id: 'same', stance: round === 1 ? 'new' : 'keep', statement: 'the row repeats', evidence: [] }], lessons: ['l'], next_experiment: 'n',
        ...(round === 1 ? { artifact: 'good1', validate_artifact: true } : round === 2 ? { artifact: 'good2', validate_artifact: true } : {}) };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
  const r = await runLaboratory(lab, { args: [...ARGS, '--researcher', 'assisted', '--out', path.join(dir, 'run.json')], root: dir, llm, fetch: answers });
  const events = JSON.parse(fs.readFileSync(r.journal, 'utf8')).events as Record<string, any>[];
  assert.deepEqual(events.filter((e) => e.type === 'artifact_accepted').map((e) => e.version), ['good1', 'good2'], 'each version accepted, against the reference');
  /* The notice of the first acceptance opens round 2; of the second, round 3. */
  const opening = (round: number) => asked.find((m) => parts(m)[0].round === round && !('task' in parts(m)[0]))!;
  const notices = (m: Message[]) => parts(m).filter((p) => p.channel?.notices).flatMap((p) => p.channel.notices);
  assert.deepEqual(notices(opening(2)).map((n: any) => [n.from, n.body.artifact_accepted.version]), [['world', 'good1']]);
  assert.deepEqual(notices(opening(3)).map((n: any) => n.body.artifact_accepted.version), ['good2']);
  /* The finding: the last version is the product, and the chain in order. */
  assert.equal(r.finding.artifact?.status, 'accepted');
  assert.equal(r.finding.artifact?.version, 'good2');
  assert.deepEqual(r.finding.artifact?.chain, [{ version: 'good1', round: 1 }, { version: 'good2', round: 2 }]);
});

/* --- Step 5: the grid, likewise (its client delivers the channel; it publishes its budget and its researcher's pins). */

test('the grid has the channel too: its budget pinned, what it pins at every round, the conversation only growing', async () => {
  const { gridLab } = await import('../src/worlds/grid/lab.ts');
  const { PINS_SECTION } = await import('../src/learn/assisted/channel.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-grid-'));
  const asked: Message[][] = [];
  const grid: FetchLike = async (_url, init) => {
    const b = JSON.parse(String(init.body));
    const messages = b.messages as Message[];
    const grading = messages[0].content.startsWith('You grade');
    if (!grading) asked.push(messages);
    const first = parts(messages)[0] ?? {};
    const content = grading ? { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' }
      : 'task' in first ? { rationale: 'r', beliefs: [{ id: 'b', stance: 'keep', why: 'w' }], lessons: ['l'], next_experiment: 'n' }
      : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p, m) => 0.5', validate: false, beliefs: [{ id: 'b', stance: first.round === 1 ? 'new' : 'keep', statement: 's' }], lessons: ['l'],
        ...(first.round === 1 ? { pins: [{ do: 'pin', id: 'note', text: 'the other side moves first' }] } : {}) };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
  await runLaboratory(gridLab, { args: ['--seed', '22', '--explore', '1', '--variants', '1', '--family', '1', '--family-variants', '1', '--confirm-places', '1', '--levels', '2', '--depth', '1',
    '--steps', '0', '--flat', '--no-ablation', '--no-grade', '--attempts', '3', '--researcher', 'assisted', '--out', path.join(dir, 'grid.json')], root: dir, llm, fetch: grid });
  assert.ok(asked.every((m) => m[0].content.includes(PINS_SECTION)));
  const opening = (round: number) => asked.find((m) => parts(m)[0].round === round && !('task' in parts(m)[0]))!;
  const keys = (m: Message[]) => parts(m).flatMap((p) => p.channel?.pinned ?? []).map((p: any) => p.key);
  assert.ok(keys(opening(1)).includes('harness:budget'));
  assert.ok(!keys(opening(1)).includes('self:note'));
  assert.ok(keys(opening(2)).includes('self:note') && keys(opening(3)).includes('self:note'), 'what it pinned, at every round after');
  for (let i = 1; i < asked.length; i++) if (asked[i][1].content === asked[i - 1][1].content)
    assert.deepEqual(asked[i].slice(0, asked[i - 1].length), asked[i - 1], 'question ' + i);
});

/* The senior is the other half of the same researcher: everything the junior was told between its answers reaches it too,
   as it was delivered - with nothing chosen on the way (SPEC-CANAL-MENSAJES §9). */
test('in a run with a senior: every pinned message and every notice delivered to the junior before a call of the senior reaches the senior', async () => {
  const { runAgentOperator } = await import('../src/orchestra/agent-operator.ts');
  const { send } = await import('../src/runtime/control.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-mirror-'));
  const out = path.join(dir, 'run.json');
  let n = 0;
  const stuck: FetchLike = async (u, init) => {
    await new Promise((r) => setTimeout(r, 40));
    if (++n === 2) send(out, { kind: 'message', text: 'look at the borders', by: 'operator' });
    return junior([])(u, init);
  };
  const seen: Record<string, any>[][] = [];
  const senior = { complete: async (r: any) => {
    seen.push([...r.user.parts]);
    return { content: JSON.stringify({ decision: 'wait', why: 'reading' }), latencyMs: 0, raw: null };
  } };
  const controller = new AbortController();
  const run = runLaboratory(publishing(), { args: [...ARGS, '--researcher', 'assisted', '--task', 'Find the rule of the rows.', '--agents', 'senior=message', '--out', out], root: dir, llm, fetch: stuck });
  const agent = runAgentOperator({ id: 'senior', role: 'senior', patience: 1, journal: out, llm: senior as never, pollMs: 10, maxOrders: 3, signal: controller.signal });
  await run;
  controller.abort();
  await agent;
  assert.ok(seen.length >= 1, 'the senior was called');
  const toSenior = seen.flat().filter((p) => p.channel).map((p) => p.channel);
  const pinnedToSenior = new Map<string, string>();
  for (const c of toSenior) for (const p of c.pinned ?? []) pinnedToSenior.set(p.key + '=' + JSON.stringify(p.value), p.key);
  const noticesToSenior = new Set(toSenior.flatMap((c) => (c.notices ?? []).map((x: any) => JSON.stringify(x.body))));
  /* What the junior was delivered before the senior's last call. */
  const record = JSON.parse(fs.readFileSync(out, 'utf8'));
  const agentRecord = JSON.parse(fs.readFileSync(out.replace(/\.json$/, '.agent-senior.json'), 'utf8'));
  const lastCall = Math.max(...agentRecord.decisions.map((d: any) => d.rounds));
  const before = record.events.filter((e: any) => e.type === 'channel_delivered' && e.round <= lastCall);
  assert.ok(before.length >= 1);
  const keys = new Set(before.flatMap((e: any) => (e.delivered.pinned ?? []).map((p: any) => p.key)));
  assert.ok(keys.has('operator:task') && keys.has('harness:budget') && keys.has('world:drawn'), [...keys].join(', '));
  for (const k of keys) assert.ok([...pinnedToSenior.values()].includes(k as string), 'pinned "' + k + '" reached the senior');
  for (const e of before) for (const x of e.delivered.notices ?? []) assert.ok(noticesToSenior.has(JSON.stringify(x.body)), 'a notice reached the senior: ' + JSON.stringify(x.body).slice(0, 80));
  assert.ok(toSenior.some((c) => (c.pinned ?? []).some((p: any) => p.key === 'operator:task' && p.value === 'Find the rule of the rows.')), 'the task, word for word');
});
