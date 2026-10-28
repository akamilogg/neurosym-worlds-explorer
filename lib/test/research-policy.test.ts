import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PolicyRunner, captureView, checkPolicy, decide, policyHash, readPolicyConfig, rebuildDecision, type ResearchPolicy } from '../src/learn/assisted/research-policy.ts';
import { operatorClient } from '../src/learn/assisted/session.ts';
import { Channel } from '../src/learn/assisted/channel.ts';
import { nodeVmRunner } from '../src/runtime/node-vm.ts';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { packRun, verifyPackage } from '../src/runtime/package.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';
import type { Judge } from '../src/core/types.ts';
import type { FetchLike } from '../src/core/net.ts';

/* SPEC-METAPOLITICA-INVESTIGACION, M1: a research policy usable and rebuilt - its artifact, its capture, its decisions, its
   advice through the channel, its budget. With a Judge and a junior standing in. */

const runner = nodeVmRunner({ timeoutMs: 2000 });
const code = (source: string) => ({ kind: 'code' as const, lang: 'js', source });

/** A policy of code only: it advises to contrast after two checks that held nowhere, once; otherwise it keeps silent. */
const CONTRAST: ResearchPolicy = {
  format: 'research-policy@1', contract: 'research-view@1',
  observations: { failed: { definition: 'checks that held nowhere', spec: code('(p) => p.events.filter((e) => e.type === "check" && (e.laboratories || []).every((l) => !l.holds)).length'), range: [0, 1000] } },
  composition: code(`(p, m) => {
    const failed = p.events.filter((e) => e.type === 'check' && (e.laboratories || []).every((l) => !l.holds));
    if (m.observations.failed >= 2 && !p.state.advised) return { guidance: { kind: 'advise', focus: 'contrast', template: 'distinguish',
      arguments: { checks: m.observations.failed }, evidence: failed.map((e) => e.id), judgments: [] }, state: { advised: true } };
    return { guidance: { kind: 'abstain', reason: m.observations.failed < 2 ? 'nothing to contrast yet' : 'already advised' }, state: p.state };
  }`),
  state: { advised: false },
  templates: { distinguish: { text: '{{checks}} checks held nowhere: look for an observation your alternatives predict differently before the next change.', arguments: ['checks'] } },
  provenance: { parents: [], reason: 'a test' }
};

/** The same with a rule the Judge answers: it advises to reframe only where the Judge says the beliefs repeat one idea. */
const REFRAME: ResearchPolicy = {
  ...CONTRAST,
  rules: { one_idea: { type: 'score', instructions: 'Do the beliefs written lately ({{failed}} failed checks) state variants of one mechanism?', criteria: ['distinct mechanisms', 'one mechanism'] } },
  composition: code(`(p, m) => m.rules.one_idea > 0.5
    ? { guidance: { kind: 'advise', focus: 'reframe', template: 'reframe', arguments: {}, evidence: [], judgments: ['one_idea'] }, state: p.state }
    : { guidance: { kind: 'abstain', reason: 'distinct mechanisms in play' }, state: p.state }`),
  templates: { reframe: { text: 'Your recent beliefs look like variants of one mechanism: write down an alternative and what would tell them apart.' } }
};

const check = (round: number, holds: boolean) => ({ t: round * 10, type: 'check', round, laboratories: [{ place: 'lab1', holds, exact: holds ? 16 : 3, points: 16 }] });
const COURSE = [
  { t: 1, type: 'exploration_episode', episode: 'ep1', rows: ['HIDDEN-ROWS'] },
  { t: 2, type: 'investigation', round: 1, requests: [{ view: 'ep1' }, { act: { x: 1 } }], results: [{ rows: ['a'] }, { refused: 'no acts left' }] },
  { t: 3, type: 'proposal', round: 1, rationale: 'it repeats', beliefs: [{ id: 'b', stance: 'new', statement: 'repeats' }] },
  check(1, false),
  { t: 12, type: 'operator_rule_recovery', round: 1, truth: 'HIDDEN-TRUTH' },
  check(2, false),
  check(3, true)
];
const judgeSaying = (value: number, seen: unknown[] = []): Judge => ({ id: 'stand-in', async judge(r) { seen.push(r); return Object.fromEntries(Object.keys(r.questions).map((k) => [k, { value, confidence: null }])); } });

test('M1: the artifact holds to its contract, and its identity is what runs', () => {
  assert.deepEqual(checkPolicy(CONTRAST), []);
  assert.deepEqual(checkPolicy(REFRAME), []);
  assert.ok(checkPolicy({ ...CONTRAST, templates: { t: { text: 'uses {{x}}' } } }).some((e) => /declare/.test(e)));
  assert.ok(checkPolicy({ ...CONTRAST, format: 'other' }).length);
  assert.ok(checkPolicy({ ...CONTRAST, composition: { kind: 'code', lang: 'js' } }).length);
  assert.equal(policyHash(CONTRAST), policyHash({ ...CONTRAST, provenance: { parents: ['x'], reason: 'other' } }), 'provenance is not what runs');
  assert.notEqual(policyHash(CONTRAST), policyHash({ ...CONTRAST, state: { advised: true } }));
  assert.throws(() => readPolicyConfig('{"policy": {"format": "research-policy@1"}}', () => ''), /contract/);
  assert.throws(() => readPolicyConfig(JSON.stringify({ policy: CONTRAST, limits: { advice: 0 } }), () => ''), /whole number/);
  assert.deepEqual(readPolicyConfig(JSON.stringify({ policy: 'p.json', limits: { advice: 2 } }), () => JSON.stringify(CONTRAST)).limits, { advice: 2 });
});

test('M1: it sees only its prefix, as the researcher lived it - what ran, was refused, clipped and left out said', () => {
  const c = captureView(COURSE, 4, { question: 5, guidance: [], resources: {}, state: null });
  assert.deepEqual(c.events.map((e) => e.id), ['e0', 'e1', 'e2', 'e3'], 'nothing after its cut');
  assert.ok(!JSON.stringify(c).includes('HIDDEN'), 'never what the researcher was not given');
  assert.deepEqual(c.events[1].results.map((r: any) => r.status), ['ok', 'refused']);
  const all = captureView(COURSE, COURSE.length, { question: 9, guidance: [], resources: {}, state: null, context: { events: 2, text: 5 } });
  assert.deepEqual(all.events.map((e) => e.id), ['e5', 'e6'], 'the latest within its window; e4 was never the researcher\'s');
  assert.deepEqual(all.omitted, { events: 4, first_kept: 'e5' });
  const clipped = captureView(COURSE, 3, { question: 5, guidance: [], resources: {}, state: null, context: { events: 10, text: 5 } });
  assert.ok(clipped.truncated.includes('e2.rationale') && clipped.truncated.some((t) => t.startsWith('e1.results')));
  assert.ok(c.facts && typeof c.facts.holding_nowhere_in_a_row === 'number', 'facts of its course, computed on this view');
});

test('M1: it decides by code, or with the Judge - facts and judgments apart; it may keep silent; what does not hold is said', async () => {
  const at = (cut: number, state: unknown = { advised: false }) => captureView(COURSE, cut, { question: 1, guidance: [], resources: {}, state });
  const silent = await decide(CONTRAST, at(4), judgeSaying(0.5), { runner });
  assert.equal(silent.guidance?.kind, 'abstain');
  const advice = await decide(CONTRAST, at(6), judgeSaying(0.5), { runner });
  assert.deepEqual(advice.guidance, { kind: 'advise', focus: 'contrast', template: 'distinguish', arguments: { checks: 2 }, evidence: ['e3', 'e5'], judgments: [] });
  assert.equal(advice.judge_calls, 0, 'code only: the Judge is never asked');
  assert.deepEqual(advice.state, { advised: true });
  assert.equal((await decide(CONTRAST, at(0), judgeSaying(0.5), { runner })).failure, 'no_context');
  const seen: any[] = [];
  const judged = await decide(REFRAME, at(6), judgeSaying(0.9, seen), { runner });
  assert.deepEqual(judged.rules, { one_idea: 0.9 });
  assert.deepEqual(judged.guidance && judged.guidance.kind === 'advise' && judged.guidance.judgments, ['one_idea']);
  assert.equal(judged.judge_calls, 1);
  assert.match(seen[0].questions.one_idea.instructions, /2 failed checks/, 'the Judge reads the facts it was given');
  const failing: Judge = { id: 'down', judge: async () => { throw new Error('503'); } };
  assert.equal((await decide(REFRAME, at(6), failing, { runner })).failure, 'judge_failed');
  const mute: Judge = { id: 'mute', judge: async () => ({}) };
  assert.equal((await decide(REFRAME, at(6), mute, { runner })).failure, 'judge_failed', 'an unanswered rule is no neutral answer');
  for (const [name, source] of [
    ['evidence it never read', `(p) => ({ guidance: { kind: 'advise', focus: 'develop', template: 'distinguish', arguments: { checks: 1 }, evidence: ['e99'], judgments: [] }, state: p.state })`],
    ['a template it has not', `(p) => ({ guidance: { kind: 'advise', focus: 'develop', template: 'none', arguments: {}, evidence: [], judgments: [] }, state: p.state })`],
    ['an argument not declared', `(p) => ({ guidance: { kind: 'advise', focus: 'develop', template: 'distinguish', arguments: { checks: 1, more: 2 }, evidence: [], judgments: [] }, state: p.state })`],
    ['a focus of no kind', `(p) => ({ guidance: { kind: 'advise', focus: 'win', template: 'distinguish', arguments: { checks: 1 }, evidence: [], judgments: [] }, state: p.state })`],
    ['a judgment that is no rule', `(p) => ({ guidance: { kind: 'advise', focus: 'develop', template: 'distinguish', arguments: { checks: 1 }, evidence: [], judgments: ['x'] }, state: p.state })`],
    ['a state over its limit', `(p) => ({ guidance: { kind: 'abstain', reason: 'r' }, state: 'x'.repeat(5000) })`],
    ['code that throws', `(p) => { throw new Error('bad') }`]
  ] as const) assert.equal((await decide({ ...CONTRAST, composition: code(source) }, at(6), judgeSaying(0.5), { runner })).failure, 'invalid_output', name);
});

test('M1: a decision is rebuilt from its record, without the Judge', async () => {
  const c = captureView(COURSE, 6, { question: 1, guidance: [], resources: {}, state: { advised: false } });
  const d = await decide(REFRAME, c, judgeSaying(0.8), { runner });
  assert.deepEqual(rebuildDecision(REFRAME, c, d.rules, runner), { guidance: d.guidance, state: d.state });
  assert.notDeepEqual(rebuildDecision(REFRAME, c, { one_idea: 0.1 }, runner), { guidance: d.guidance, state: d.state }, 'other answers, another decision');
});

/** A run's journal standing in: events, help, and the policy's runner over them. */
function host(o: { events?: any[]; help?: number | null; judge?: Judge; previous?: any[] } = {}) {
  const events: any[] = o.events ?? [...COURSE.slice(0, 6)];
  let help = o.help === undefined ? null : o.help;
  return { events, helpLeft: () => help, spentHelp: () => help, h: { events: () => events, log: (type: string, data: any) => { events.push({ type, ...data }); },
    judge: o.judge ?? judgeSaying(0.5), runner, helpLeft: () => help, spendHelp: () => { if (help !== null) help--; }, previous: o.previous } };
}

test('M1: its advice is a notice from agent:research-policy, paid once from the run\'s help; no help left, no inference', async () => {
  const x = host({ help: 1 });
  const r = new PolicyRunner({ policy: CONTRAST }, x.h);
  const m = await r.advise(7, true);
  assert.ok(m && m.by === 'agent:research-policy' && !m.directive, 'advice, never a directive');
  assert.match(m!.text, /^2 checks held nowhere/);
  assert.deepEqual((m as any).advice.evidence, ['e3', 'e5']);
  assert.equal(x.helpLeft(), 0, 'one delivery of help');
  const types = x.events.slice(6).map((e) => e.type);
  assert.deepEqual(types, ['research_policy_requested', 'research_policy_decided', 'research_policy_delivered']);
  assert.equal(x.events[6].cut, 6, 'the cut, taken before its own record');
  assert.equal(await r.advise(8, true), null, 'it advised already: it keeps silent, free');
  const calls: unknown[] = [];
  const poor = host({ help: 0, judge: judgeSaying(0.9, calls) });
  assert.equal(await new PolicyRunner({ policy: REFRAME }, poor.h).advise(7, true), null);
  assert.equal(calls.length, 0, 'no help left: the Judge is not asked');
  assert.equal(poor.events.find((e) => e.type === 'research_policy_decided').failure, 'limit');
  const counted: unknown[] = [];
  const limited = host({ judge: judgeSaying(0.2, counted) });
  const lr = new PolicyRunner({ policy: REFRAME, limits: { evaluations: 1 } }, limited.h);
  await lr.advise(7, true); await lr.advise(8, true);
  assert.equal(counted.length, 1, 'its evaluations spent: no more inference');
  assert.equal(limited.events.filter((e) => e.type === 'research_policy_decided').at(-1).failure, 'limit');
  const replaying = host();
  assert.equal(await new PolicyRunner({ policy: CONTRAST }, replaying.h).advise(7, false), null, 'never while its history replays');
  assert.equal(replaying.events.length, 6);
});

test('M1: what came while it decided makes its capture old - not given as current advice', async () => {
  let x: ReturnType<typeof host>;
  const meanwhile: Judge = { id: 'slow', async judge(r) { x.events.push({ type: 'world_window', window: 9 }); return { one_idea: { value: 0.9, confidence: null } }; } };
  x = host({ judge: meanwhile });
  assert.equal(await new PolicyRunner({ policy: REFRAME }, x.h).advise(7, true), null);
  assert.equal(x.events.at(-1).reason, 'stale');
});

test('M1: a run resumed uses its decisions again - no Judge, no second payment; one decided and never delivered is delivered then', async () => {
  const calls: unknown[] = [];
  const first = host({ help: 3, judge: judgeSaying(0.9, calls) });
  await new PolicyRunner({ policy: REFRAME }, first.h).advise(7, true);
  assert.equal(calls.length, 1);
  const again = host({ help: 3, judge: judgeSaying(0.9, calls), previous: first.events });
  assert.equal(await new PolicyRunner({ policy: REFRAME }, again.h).advise(7, true), null, 'delivered then: the resumed run delivers it with that question\'s messages');
  assert.equal(calls.length, 1, 'never asked again');
  assert.equal(again.helpLeft(), 3, 'never paid again');
  assert.deepEqual(again.events.slice(6).map(({ t: _t, ...e }) => e), first.events.slice(6).map(({ t: _t, ...e }) => e), 'its record again, word for word');
  assert.equal(PolicyRunner.delivered(first.events), 1);
  const cutShort = first.events.filter((e) => e.type !== 'research_policy_delivered');
  const resumed = host({ help: 3, judge: judgeSaying(0.9, calls), previous: cutShort });
  const m = await new PolicyRunner({ policy: REFRAME }, resumed.h).advise(7, true);
  assert.ok(m, 'decided, never delivered: delivered now');
  assert.equal(calls.length, 1, 'from its record');
  assert.equal(resumed.helpLeft(), 2);
});

test('M1: through the junior\'s client - absent, nothing changes; present, its advice reaches it in the channel after what reached it', async () => {
  const asked: any[] = [];
  const llm = { async complete(r: any) { asked.push(r); return { content: '{}', raw: {} } as any; } };
  const logs: any[] = [];
  const make = (advise?: (q: number) => Promise<any>) => {
    const ch = new Channel(() => {});
    const waiting = [{ id: 'op1', text: 'look at the edges', by: 'operator', at: 'now' }];
    return operatorClient(llm as any, { take: () => waiting.splice(0), messages: () => ch, ...(advise ? { advise } : {}) }, (type, data) => logs.push({ type, ...data }));
  };
  await make().complete({ system: 's', user: { task: 'x' } } as any);
  const plain = JSON.stringify(asked[0]);
  const order: string[] = [];
  await make(async (q) => { order.push('advise:' + logs.filter((l) => l.type === 'operator_message').length); return { id: 'research-policy:rp-q' + q, text: 'contrast', by: 'agent:research-policy', at: 'now' }; })
    .complete({ system: 's', user: { task: 'x' } } as any);
  const notices = (asked[1].user as any).channel.notices;
  assert.deepEqual(notices.map((n: any) => n.from), ['operator', 'agent:research-policy']);
  assert.deepEqual(order, ['advise:2'], 'decided after what reached it was recorded');
  assert.equal(logs.filter((l) => l.type === 'operator_message').at(-1).messages[0].by, 'agent:research-policy');
  await make(async () => null).complete({ system: 's', user: { task: 'x' } } as any);
  assert.equal(JSON.stringify(asked[2]), plain, 'a policy that keeps silent asks what was asked without one');
});

/* --- In a run ------------------------------------------------------------------------------------------------------------ */

type Message = { role: string; content: string };
const parts = (m: Message[]): Record<string, any>[] => m.slice(1).map((x) => { try { return JSON.parse(x.content); } catch { return {}; } });
function junior(asked: Message[][]): FetchLike {
  return async (_url, init) => {
    const messages = JSON.parse(String(init.body)).messages as Message[];
    const grading = messages[0].content.startsWith('You grade');
    if (!grading) asked.push(messages);
    const ps = parts(messages), first = ps[0] ?? {};
    const content = grading ? { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' }
      : 'task' in first ? { rationale: 'r', beliefs: [{ id: 'same', stance: 'keep', why: 'w' }], lessons: ['l'], next_experiment: 'n' }
      : !ps.some((p) => p.investigation_step) ? { investigate: [{ view: 'ep1', from: 0, to: 2 }] }
      : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]', validate: false,
        beliefs: [{ id: 'same', stance: first.round === 1 ? 'new' : 'keep', statement: 'the row repeats', evidence: [] }], lessons: ['l'], next_experiment: 'n' };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
}
const llm = { url: 'http://system2.test/chat', model: 'stand-in' };
const ARGS = ['--seed', '1', '--level', '1', '--flat', '--no-grade', '--tools', 'view', '--researcher', 'assisted'];

test('M1: in a run, with no senior - its advice delivered, recorded, rebuilt, paid; resumed without asking again; refused where it cannot run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-policy-'));
  /* A policy that advises once its researcher has been checked at all. */
  const policy: ResearchPolicy = { ...CONTRAST,
    composition: code(`(p, m) => p.events.some((e) => e.type === 'check') && !p.state.advised
      ? { guidance: { kind: 'advise', focus: 'develop', template: 'distinguish', arguments: { checks: m.observations.failed }, evidence: p.events.filter((e) => e.type === 'check').map((e) => e.id), judgments: [] }, state: { advised: true } }
      : { guidance: { kind: 'abstain', reason: 'not yet' }, state: p.state }`) };
  fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify({ policy, limits: { advice: 3 } }));
  const asked: Message[][] = [];
  const r = await runLaboratory(cellsLab, { args: [...ARGS, '--attempts', '3', '--help-budget', '2', '--research-policy', 'policy.json', '--out', path.join(dir, 'run.json')], root: dir, llm, fetch: junior(asked) });
  const j = JSON.parse(fs.readFileSync(r.journal, 'utf8'));
  assert.equal(j.config.research_policy.hash, policyHash(policy), 'part of the condition');
  assert.deepEqual(j.research_policy.policy, policy, 'kept whole');
  const delivered = j.events.filter((e: any) => e.type === 'research_policy_delivered' && e.message);
  assert.equal(delivered.length, 1);
  const given = j.events.find((e: any) => e.type === 'operator_message' && e.messages.some((m: any) => m.by === 'agent:research-policy'));
  assert.ok(given && given.question === delivered[0].question);
  const after = asked.find((m) => JSON.stringify(parts(m)).includes('agent:research-policy'));
  assert.ok(after, 'it reached the researcher in its channel');
  for (const d of j.events.filter((e: any) => e.type === 'research_policy_decided' && e.guidance)) {
    const req = j.events.find((e: any) => e.type === 'research_policy_requested' && e.id === d.id);
    assert.deepEqual(rebuildDecision(policy, req.capture, d.rules, runner), { guidance: d.guidance, state: d.state });
  }
  /* Its package: the run rebuilt offline, and every decision rebuilt from its record with no Judge. */
  const pkg = packRun(r.journal, path.join(dir, 'package'));
  const v = await verifyPackage(pkg.dir);
  assert.ok(v.reconstruction.holds, JSON.stringify(v.reconstruction));
  const decisions = j.events.filter((e: any) => e.type === 'research_policy_decided' && e.guidance).length;
  assert.ok(decisions > 1, 'its silences are decisions too');
  assert.deepEqual(v.research_policy, { holds: true, decisions, rebuilt: decisions, problems: [] });
  const resumed = await runLaboratory(cellsLab, { args: ['--resume', r.journal, '--attempts', '4', '--out', path.join(dir, 'more.json')], root: dir, llm, fetch: junior([]) });
  assert.notEqual(resumed.stoppedBy, 'diverged');
  const k = JSON.parse(fs.readFileSync(resumed.journal, 'utf8'));
  assert.equal(k.events.filter((e: any) => e.type === 'research_policy_delivered' && e.message).length, 1, 'no second advice');
  assert.equal(k.events.filter((e: any) => e.type === 'operator_message' && e.messages.some((m: any) => m.by === 'agent:research-policy')).length, 1);
  await assert.rejects(runLaboratory(cellsLab, { args: ['--seed', '1', '--level', '1', '--flat', '--no-grade', '--research-policy', 'policy.json', '--attempts', '1', '--out', path.join(dir, 'pure.json')], root: dir, llm, fetch: junior([]) }), /only the assisted researcher/);
  fs.writeFileSync(path.join(dir, 'judged.json'), JSON.stringify(REFRAME));
  await assert.rejects(runLaboratory(cellsLab, { args: [...ARGS, '--research-policy', 'judged.json', '--attempts', '1', '--out', path.join(dir, 'flat.json')], root: dir, llm, fetch: junior([]) }), /knows nothing/);
});

test('M3: in the grid too, a laboratory with a loop of its own - advice delivered, rebuilt, and refused only where it cannot run', async () => {
  const { gridLab } = await import('../src/worlds/grid/lab.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-policy-grid-'));
  const policy: ResearchPolicy = { ...CONTRAST,
    composition: code(`(p) => p.events.some((e) => e.type === 'check') && !p.state.advised
      ? { guidance: { kind: 'advise', focus: 'contrast', template: 'distinguish', arguments: { checks: 1 }, evidence: [], judgments: [] }, state: { advised: true } }
      : { guidance: { kind: 'abstain', reason: 'not yet' }, state: p.state }`) };
  fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify(policy));
  const asked: Message[][] = [];
  const grid: FetchLike = async (_url, init) => {
    const messages = JSON.parse(String(init.body)).messages as Message[];
    const grading = messages[0].content.startsWith('You grade');
    if (!grading) asked.push(messages);
    const first = parts(messages)[0] ?? {};
    const content = grading ? { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' }
      : 'task' in first ? { rationale: 'r', beliefs: [{ id: 'b', stance: 'keep', why: 'w' }], lessons: ['l'], next_experiment: 'n' }
      : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p, m) => 0.5', validate: false, beliefs: [{ id: 'b', stance: first.round === 1 ? 'new' : 'keep', statement: 's' }], lessons: ['l'] };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
  const r = await runLaboratory(gridLab, { args: ['--seed', '22', '--explore', '1', '--variants', '1', '--family', '1', '--family-variants', '1', '--confirm-places', '1', '--levels', '2', '--depth', '1',
    '--steps', '0', '--flat', '--no-ablation', '--no-grade', '--attempts', '3', '--researcher', 'assisted', '--research-policy', 'policy.json', '--out', path.join(dir, 'grid.json')], root: dir, llm, fetch: grid });
  const j = JSON.parse(fs.readFileSync(r.journal, 'utf8'));
  assert.equal(j.events.filter((e: any) => e.type === 'research_policy_delivered' && e.message).length, 1);
  assert.ok(asked.some((m) => JSON.stringify(m).includes('agent:research-policy')), 'it reached the researcher');
  for (const d of j.events.filter((e: any) => e.type === 'research_policy_decided' && e.guidance)) {
    const req = j.events.find((e: any) => e.type === 'research_policy_requested' && e.id === d.id);
    assert.deepEqual(rebuildDecision(policy, req.capture, d.rules, runner), { guidance: d.guidance, state: d.state });
  }
});
