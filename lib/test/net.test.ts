import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, fetchJson } from '../src/core/net.ts';

/* The transport must say what happened. Seen in a real run against OpenRouter: the 200 headers arrive at
   once, the body later; a body cut by our own timeout used to become "" and then "not valid JSON". */

const ok = (text: string) => ({ ok: true, status: 200, text: async () => text, headers: { get: (h: string) => (h === 'content-type' ? 'application/json' : null) } });

test('a body cut by the timeout is a TIMEOUT (retried), not a parse error', async () => {
  let calls = 0;
  const slowBody = async (_u: string, init: any) => {
    calls++;
    if (calls === 1) {
      return { ok: true, status: 200, headers: { get: () => null }, text: () => new Promise<string>((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }) };
    }
    return ok('{"fine":true}');
  };
  const r = await fetchJson('https://x', { fetch: slowBody as any, timeoutMs: 30, retries: 1, sleep: async () => {} });
  assert.deepEqual(r.data, { fine: true });
  assert.equal(r.attempts, 2);
  await assert.rejects(() => fetchJson('https://x', { fetch: (async (_u: string, init: any) => ({ ok: true, status: 200, headers: { get: () => null },
    text: () => new Promise<string>((_r, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))) })) as any,
    timeoutMs: 20, retries: 0 }), (e: ApiError) => e.kind === 'timeout' && /did not finish within 20 ms/.test(e.message));
});

test('an empty 200 body is retried, and a non-JSON body says status, type and size', async () => {
  let n = 0;
  const flaky = async () => (++n === 1 ? ok('   ') : ok('{"a":1}'));
  assert.deepEqual((await fetchJson('https://x', { fetch: flaky as any, retries: 1, sleep: async () => {} })).data, { a: 1 });
  await assert.rejects(() => fetchJson('https://x', { fetch: (async () => ok('<html>oops</html>')) as any }),
    (e: ApiError) => e.kind === 'parse' && /HTTP 200, application\/json, 17 chars/.test(e.message) && e.details!.body === '<html>oops</html>');
});

test('keep-alive comments before the JSON (OpenRouter) are tolerated', async () => {
  const r = await fetchJson('https://x', { fetch: (async () => ok(': OPENROUTER PROCESSING\n\n: OPENROUTER PROCESSING\n\n{"choices":[{"message":{"content":"{\\"v\\":1}"}}]}')) as any });
  assert.equal((r.data as any).choices[0].message.content, '{"v":1}');
});

test('a network-level failure is retried only when the host asks (a browser CORS failure never is)', async () => {
  let n = 0;
  const flaky = async () => { if (++n === 1) throw new TypeError('fetch failed'); return ok('{"fine":true}'); };
  await assert.rejects(() => fetchJson('https://x', { fetch: flaky as any, retries: 2, sleep: async () => {} }), (e: ApiError) => e.kind === 'network');
  n = 0;
  const r = await fetchJson('https://x', { fetch: flaky as any, retries: 2, retryNetwork: true, sleep: async () => {} });
  assert.deepEqual(r.data, { fine: true });
  assert.equal(r.attempts, 2);
});
