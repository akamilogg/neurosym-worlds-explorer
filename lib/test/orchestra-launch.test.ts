import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chatFromEnv, endpointsFromEnv, labEndpointsFromEnv } from '../src/orchestra/launch.ts';
import { chatRequestBody, openAiChatClient } from '../src/learn/system2.ts';
import { runAgentOperator } from '../src/orchestra/agent-operator.ts';

test('legacy AGENT_LLM endpoints resolve to senior settings, with new names taking precedence', () => {
  const env = { LLM_URL: 'https://junior.test/chat', LLM_MODEL: 'junior', LLM_KEY: 'junior-key',
    AGENT_LLM_MODEL: 'legacy', AGENT_LLM_URL: 'https://legacy.test/chat', AGENT_LLM_KEY: 'legacy-key' };
  const before = { ...env };
  assert.deepEqual(endpointsFromEnv(env, 'SENIOR_LLM'), { url: env.AGENT_LLM_URL, model: 'legacy', key: 'legacy-key' });
  assert.deepEqual(endpointsFromEnv(env, 'AGENT_LLM'), endpointsFromEnv(env, 'SENIOR_LLM'));
  assert.deepEqual(endpointsFromEnv({ ...env, SENIOR_LLM_MODEL: 'new' }, 'AGENT_LLM'),
    { url: env.AGENT_LLM_URL, model: 'new', key: 'legacy-key' });
  assert.deepEqual(endpointsFromEnv({ LLM_URL: env.LLM_URL, LLM_MODEL: 'same', LLM_KEY: 'key' }, 'SENIOR_LLM'),
    { url: env.LLM_URL, model: 'same', key: 'key' });
  assert.deepEqual(env, before, 'normalization never mutates the script environment');
});

test('same model, separate junior/senior efforts reach the actual Chat Completions requests', async (t) => {
  const bodies: Record<string, unknown>[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 });
  });
  const env = { LLM_URL: 'https://llm.test/chat', LLM_MODEL: 'gpt-6-luna', LLM_REASONING_EFFORT: 'low',
    LLM_TEMPERATURE: '1', LLM_MAX_TOKENS: '4000', SENIOR_LLM_REASONING_EFFORT: 'high', SENIOR_LLM_MAX_TOKENS: '12000' };
  const junior = labEndpointsFromEnv(env).llm;
  const juniorClient = openAiChatClient({ ...junior, url: junior.url!, model: junior.model!, temperature: junior.temperature ?? 0.4 });
  await juniorClient.complete({ system: 'Return JSON.', user: {} });
  const senior = chatFromEnv(env, 'SENIOR_LLM');
  await senior.complete({ system: 'Return JSON.', user: {} });
  assert.deepEqual(bodies.map(b => [b.model, b.reasoning_effort, b.max_completion_tokens]),
    [['gpt-6-luna', 'low', 4000], ['gpt-6-luna', 'high', 12000]]);
  for (const body of bodies) assert.equal('temperature' in body, false);
  assert.deepEqual(senior.configuration, { model: 'gpt-6-luna', response_format: { type: 'json_object' },
    reasoning_effort: 'high', max_completion_tokens: 12000 });
});

test('junior Qwen extras and effort do not leak into the senior; senior tuning is independent', () => {
  const env = { LLM_URL: 'https://llm.test/chat', LLM_MODEL: 'same', LLM_REASONING_EFFORT: 'low', LLM_TEMPERATURE: '1',
    LLM_EXTRA_BODY: '{"chat_template_kwargs":{"reasoning_effort":"low"},"top_p":0.95,"top_k":20}' };
  const senior = chatFromEnv(env, 'SENIOR_LLM').configuration!;
  assert.deepEqual(senior, { model: 'same', temperature: 0.3, response_format: { type: 'json_object' } });
  const own = chatFromEnv({ ...env, SENIOR_LLM_REASONING_EFFORT: 'high',
    SENIOR_LLM_EXTRA_BODY: '{"reasoning_effort":"low","top_p":0.9,"logprobs":true}' }, 'SENIOR_LLM').configuration!;
  assert.deepEqual(own, { model: 'same', response_format: { type: 'json_object' }, reasoning_effort: 'high' });
  const qwenEnv = { ...env, LLM_REASONING_EFFORT: '' };
  const qwen = labEndpointsFromEnv(qwenEnv).llm;
  const qwenBody = chatRequestBody({ ...qwen, model: qwen.model! }, 's', {});
  assert.deepEqual([qwenBody.temperature, qwenBody.chat_template_kwargs, qwenBody.top_p, qwenBody.top_k],
    [1, { reasoning_effort: 'low' }, 0.95, 20]);
  const legacy = chatFromEnv({ ...qwenEnv, AGENT_LLM_MODEL: 'old', SENIOR_LLM_REASONING_EFFORT: 'none' }, 'AGENT_LLM');
  assert.deepEqual([legacy.configuration!.model, legacy.configuration!.reasoning_effort], ['old', 'none']);
});

test('invalid senior effort is rejected before spending a request', () => {
  assert.throws(() => chatFromEnv({ LLM_URL: 'https://llm.test/chat', LLM_MODEL: 'same',
    SENIOR_LLM_REASONING_EFFORT: 'ultra' }, 'SENIOR_LLM'), /SENIOR_LLM_REASONING_EFFORT/);
});

test('vLLM receives independent junior/senior extra bodies for the same Qwen model', async (t) => {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 });
  });
  const juniorExtra = { chat_template_kwargs: { reasoning_effort: 'low' }, top_p: 0.95, top_k: 20 };
  const seniorExtra = { chat_template_kwargs: { reasoning_effort: 'high' }, top_p: 0.95, top_k: 20 };
  const env = { LLM_URL: 'https://vllm.test/v1/chat/completions', LLM_MODEL: 'qwen-served-model', LLM_TEMPERATURE: '1',
    LLM_EXTRA_BODY: JSON.stringify(juniorExtra), SENIOR_LLM_TEMPERATURE: '1', SENIOR_LLM_EXTRA_BODY: JSON.stringify(seniorExtra),
    AGENT_LLM_EXTRA_BODY: '{"chat_template_kwargs":{"reasoning_effort":"medium"}}' };
  const before = { ...env };
  const junior = labEndpointsFromEnv(env).llm;
  await openAiChatClient({ ...junior, url: junior.url!, model: junior.model!, jsonMode: true }).complete({ system: 'Return JSON.', user: {} });
  const senior = chatFromEnv(env, 'SENIOR_LLM');
  await senior.complete({ system: 'Return JSON.', user: {} });
  assert.equal(requests.length, 2);
  for (const { url, body } of requests) {
    assert.equal(url, env.LLM_URL);
    assert.deepEqual([body.model, body.temperature, body.top_p, body.top_k], ['qwen-served-model', 1, 0.95, 20]);
    assert.equal('reasoning_effort' in body, false, 'vLLM effort stays inside chat_template_kwargs');
    assert.equal('extra_body' in body, false, 'provider fields are merged into the actual request');
  }
  assert.deepEqual(requests[0].body.chat_template_kwargs, juniorExtra.chat_template_kwargs);
  assert.deepEqual(requests[1].body, { ...requests[0].body, chat_template_kwargs: seniorExtra.chat_template_kwargs },
    'same model and sampling, only the nested effort differs');
  assert.deepEqual(senior.configuration!.chat_template_kwargs, seniorExtra.chat_template_kwargs);
  const legacyOnly = { ...env, SENIOR_LLM_EXTRA_BODY: '' };
  assert.deepEqual(chatFromEnv(legacyOnly, 'SENIOR_LLM').configuration!.chat_template_kwargs, { reasoning_effort: 'medium' });
  assert.deepEqual(env, before, 'neither role mutates the existing extra body');
  assert.throws(() => chatFromEnv({ ...env, SENIOR_LLM_EXTRA_BODY: '{broken' }, 'SENIOR_LLM'), /SENIOR_LLM_EXTRA_BODY is not JSON/);
});

test('senior journal declares its model and request parameters without credentials or messages', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'senior-tuning-'));
  const llm = chatFromEnv({ LLM_URL: 'https://llm.test/chat', LLM_MODEL: 'gpt-6-luna', LLM_KEY: 'private-key',
    SENIOR_LLM_REASONING_EFFORT: 'high' }, 'SENIOR_LLM');
  const controller = new AbortController();
  controller.abort();
  const result = await runAgentOperator({ id: 'senior', role: 'senior', journal: path.join(dir, 'run.json'), llm, signal: controller.signal });
  const record = JSON.parse(fs.readFileSync(result.file, 'utf8'));
  assert.deepEqual(record.llm_config, { model: 'gpt-6-luna', response_format: { type: 'json_object' }, reasoning_effort: 'high' });
  assert.equal(JSON.stringify(record).includes('private-key'), false);
});
