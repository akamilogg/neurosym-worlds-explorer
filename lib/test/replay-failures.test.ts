import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReplayLog } from '../src/runtime/replay.ts';
import type { FetchLike } from '../src/core/net.ts';

/* A failure is part of the record (27/10/2026: a run whose Judge failed in every call could not be resumed - its failures
   were never logged, so the resumed run asked again and diverged). */

const init = (body: string) => ({ method: 'POST', headers: {}, body, signal: new AbortController().signal });
const reply = (status: number, text: string) => ({ ok: status < 400, status, text: async () => text, headers: { get: () => null } });

test('an error of the service and a request never answered are logged, and served again as they were', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-fail-'));
  const first = path.join(dir, 'a.jsonl');
  let asked = 0;
  const live: FetchLike = async (_u, i) => { asked++; if (i.body === 'down') throw new TypeError('fetch failed'); return i.body === 'bad' ? reply(500, '{"error":"boom"}') : reply(200, '{"ok":1}'); };
  const a = new ReplayLog(first).wrap('jev', live);
  assert.equal((await a('http://j.test/v1', init('bad'))).status, 500);
  await assert.rejects(a('http://j.test/v1', init('down')), /fetch failed/);
  assert.equal((await a('http://j.test/v1', init('fine'))).status, 200);
  assert.equal(asked, 3);
  /* Resumed: the same three, none asked of the network. */
  const offline: FetchLike = async () => { throw new Error('never asked'); };
  const b = new ReplayLog(path.join(dir, 'b.jsonl'), { from: first }).wrap('jev', offline);
  const bad = await b('http://j.test/v1', init('bad'));
  assert.deepEqual([bad.ok, bad.status, await bad.text()], [false, 500, '{"error":"boom"}']);
  await assert.rejects(b('http://j.test/v1', init('down')), /fetch failed/);
  assert.equal((await b('http://j.test/v1', init('fine'))).status, 200);
});

test('a log written before failures were kept: a channel its record says failed in every call is answered as failed, never a divergence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-old-'));
  const old = path.join(dir, 'old.jsonl');
  /* Its answers of System 2 only: the Judge's failures never logged. */
  fs.writeFileSync(old, ['one', 'two'].map((b) => JSON.stringify({ channel: 'llm', key: keyOf('llm', b), status: 200, text: '{"a":"' + b + '"}' })).join('\n') + '\n');
  const offline: FetchLike = async () => { throw new Error('never asked'); };
  const log = new ReplayLog(path.join(dir, 'new.jsonl'), { from: old, failed: ['jev'], stallMs: 50 });
  const llm = log.wrap('llm', offline), jev = log.wrap('jev', offline);
  assert.equal((await llm('http://l.test/v1', init('one'))).status, 200);
  const judged = await jev('http://j.test/v1', init('a question'));
  assert.equal(judged.status, 424, 'failed, as its record says');
  assert.equal((await llm('http://l.test/v1', init('two'))).status, 200, 'and the run goes on');
  assert.equal(log.stats().failures_as_recorded?.jev, 1);
  assert.equal(log.divergence(), undefined);
  /* Without that record, the same request is a divergence. */
  const strict = new ReplayLog(path.join(dir, 'strict.jsonl'), { from: old, stallMs: 50 });
  await assert.rejects(strict.wrap('jev', offline)('http://j.test/v1', init('a question')), /diverged/);
});

import { requestIdentity } from '../src/runtime/replay.ts';
function keyOf(channel: string, body: string): string { return requestIdentity(channel, 'http://l.test/v1', { method: 'POST', body }); }
