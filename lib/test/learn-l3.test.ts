import test from 'node:test';
import assert from 'node:assert/strict';
import { toFormulaDiff } from '../src/learn/diff.ts';
import { consensusPayload, judgeConsensus, openAiChatClient, parseVote } from '../src/learn/system2.ts';
import { makeFormula } from '../src/core/formula.ts';
import { harnessNet, loadHarness, mulberry32 } from './support.ts';

/* L3 parity: System 2 as a client (the chat-completions request) and the consensus judge (votes, quorum,
   narrow restricted to measurable kinds, blinded payload) reproduce the baseline harness byte for byte. */

const plain = (v: unknown): any => JSON.parse(JSON.stringify(v));

function scriptedLlm(answers: string[]) {
  const bodies: any[] = [];
  let i = 0;
  return {
    bodies,
    fetch: async (_url: string, init: any) => {
      bodies.push(JSON.parse(String(init.body)));
      const content = answers[i++ % answers.length];
      if (content === '!500') return { ok: false, status: 500, statusText: 'boom', text: async () => 'down', headers: { get: () => null } };
      const text = JSON.stringify({ choices: [{ message: { content } }] });
      return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
    }
  };
}

function shellOf(rules: any) {
  return makeFormula({ world: 'foxhounds@1', observations: rules.observations || {}, rules: rules.battery || {}, weights: rules.weights || {},
    policy_weights: rules.policyWeights || {}, confidence_floor: rules.confidenceFloor,
    meta: { version: rules.version, source: rules.source, rationale: rules.rationale, evidence: rules.evidence ?? null, warnings: rules.warnings || [] } });
}

const VOTES = [
  JSON.stringify({ decision: 'apply', kinds: ['weights'], reason: 'fits' }),
  JSON.stringify({ decision: 'narrow', kinds: ['weights'], reason: 'partly' }),
  JSON.stringify({ decision: 'reject', kinds: [], reason: 'no' }),
  'not json at all',
  JSON.stringify({ decision: 'NARROW', kinds: ['confidence_floor', 'battery.instructions:x'], reason: 'only the floor' }),
  JSON.stringify({ decision: 'maybe' }),
  '!500'
];

test('the consensus judge reproduces the harness: requests, votes, quorum and the narrow restriction', async () => {
  const h = loadHarness().learner;
  const base = h.normalizeRules(h.DEFAULT_RULES, { fallback: h.DEFAULT_RULES, source: 'bootstrap' }).rules;
  const rnd = mulberry32(3);
  const decisions = new Set<string>();
  for (let trial = 0; trial < 25; trial++) {
    const cand = plain(base);
    cand.version = base.version + 1;
    cand.weights = { cats_win_forecast: rnd(), mouse_containment: rnd() };
    if (trial % 3 === 0) cand.confidenceFloor = 0.6;
    if (trial % 4 === 0) cand.battery.cats_win_forecast.instructions += ' More.';
    const script = Array.from({ length: 3 }, () => VOTES[Math.floor(rnd() * VOTES.length)]);
    const cases = [{ kind: 'near_tie', why: 'close', leaf: { value: 0.5, confidence: 0.3, atoms: { cats_win_forecast: 0.4 } } }];
    Object.assign(h.config, { llmUrl: 'https://llm.example/v1/chat/completions', llmKey: 'sk-test', llmModel: 'gpt-x', llmTemperature: 0.3,
      llmJsonMode: true, llmTimeoutMs: 5000, llmRetries: 0 });

    const theirsLlm = scriptedLlm(script);
    harnessNet.fetch = theirsLlm.fetch as any;
    const theirs = await h.judgeRuleDiffConsensus(base, cand, { cases, oracle: null, witness: [], formulaReplay: null });

    const mineLlm = scriptedLlm(script);
    const diff = toFormulaDiff(shellOf(base), shellOf(cand));
    const evidence = theirsLlm.bodies.length ? JSON.parse(theirsLlm.bodies[0].messages[1].content).evidence : {};
    const client = openAiChatClient({ url: h.config.llmUrl, apiKey: 'sk-test', model: 'gpt-x', temperature: 0.3, jsonMode: true,
      timeoutMs: 5000, retries: 0, fetch: mineLlm.fetch as any });
    const mine = await judgeConsensus(diff, consensusPayload(diff, evidence), { client, systemPrompt: h.buildJudgeSystemPrompt(),
      describeError: (e: any) => e.kind + ': ' + e.message + (e.details && e.details.body ? ' | response: ' + e.details.body : '') });

    assert.deepEqual(mineLlm.bodies, theirsLlm.bodies, 'the same requests, byte for byte');
    if (!theirs) { assert.equal(mine, null); decisions.add('none'); continue; }
    assert.ok(mine);
    assert.equal(mine!.decision, theirs.decision);
    assert.deepEqual(plain(mine!.votes), plain(theirs.votes));
    assert.deepEqual(plain(mine!.applied_fields), plain(theirs.applied_fields));
    assert.deepEqual(plain(mine!.diff), plain(theirs.diff));
    if (!script.includes('!500')) assert.equal(mine!.reason, theirs.reason);
    decisions.add(mine!.decision);
  }
  assert.ok(decisions.size >= 3, [...decisions].join(','));
});

test('a vote is read in a closed vocabulary or discarded', () => {
  assert.deepEqual(parseVote('{"decision":"Apply","kinds":["weights",3],"reason":"ok"}'), { decision: 'apply', kinds: ['weights'], reason: 'ok' });
  assert.equal(parseVote('{"decision":"approve"}').decision, null);
  assert.equal(parseVote('prose').decision, null);
});
