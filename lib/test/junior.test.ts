import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BlobStore, checkClosed, editionHash, executionHash, exportPackage, normalizePackage, type JuniorPackage } from '../src/junior/package.ts';
import { SessionError, SessionServer, stateId, type JuniorWorker, type WorkerJob, type WorkerResult } from '../src/junior/sessions.ts';
import { processReference, verifySession, type ReferenceVerifier } from '../src/junior/verify.ts';
import { ProcessWorker, VERIFY_PY } from '../src/junior/worker.ts';
import { TRAIN_PY as TRAIN_PY_PATH } from '../src/junior/train.ts';

/* SPEC-METAPOLITICA-APRENDIZAJE MA1: the junior packaged (§4), its sessions (§5.1) and their reconstruction (§5.2). */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'junior-test-'));

function fixture(store: BlobStore, over: Partial<Record<string, unknown>> = {}): JuniorPackage {
  const base = tmp();
  fs.writeFileSync(path.join(base, 'config.json'), '{"model":"tiny"}');
  /* The circuit's configuration the driver reads: what the package declares it serves. */
  fs.writeFileSync(path.join(base, 'chipformer.json'), '{"store":{"slot_bits":10}}');
  fs.mkdirSync(path.join(base, 'shards'));
  fs.writeFileSync(path.join(base, 'shards', 'a.bin'), 'weights');
  const blob = (s: string) => store.put(s);
  return normalizePackage({
    format: 'junior-package@1', name: 'tiny', base: store.putTree(base), prompt: 'Consult your memory.',
    execution: { firmware: blob('fw'), tokenizer: blob('tok'), chat_template: blob('tpl'), driver: blob('drv'), verifier: blob('ver'), circuit: { store: { slot_bits: 10 } }, precision: 'bf16' },
    provenance: { parents: [], reason: 'the base', sources: [] },
    ...over
  });
}

/** A worker in this process: its memory a JSON map, `remember K=V` writes it. Same toy as the Python fake. */
function toyWorker(o: { served?: (job: WorkerJob) => string; gate?: Promise<void>; calls?: WorkerJob[] } = {}): JuniorWorker {
  return {
    async run(job): Promise<WorkerResult> {
      o.calls?.push(job);
      if (o.gate) await o.gate;
      if (job.signal.aborted) return { served: job.execution, terminal: 'infra_failed', text: '', trace: '', ops: [], after: null, usage: null };
      const mem = job.state.twin ? JSON.parse(job.store.get(job.state.twin).toString('utf8')) : {};
      const user = String((job.content as { user: string }).user);
      const ops: unknown[] = [];
      for (const line of user.split('\n')) {
        const m = /^remember (.+?)=(.*)$/.exec(line.trim());
        if (m) { mem[m[1].trim()] = m[2].trim(); ops.push({ op: 'put', name: m[1].trim(), result: 'ok' }); }
      }
      const text = 'ok ' + JSON.stringify(Object.entries(mem).sort());
      const usage = { prompt_tokens: user.length, text_tokens: text.length, circuit_tokens: 0, gpu_ms: 0 };
      if (user.includes('overflow')) return { served: job.execution, terminal: 'limit_reached', text: text.slice(0, 3), trace: JSON.stringify({ fake: user }), ops: [], after: null, usage, reason: 'max_tokens' };
      const twin = JSON.stringify(Object.fromEntries(Object.entries(mem).sort()));
      return { served: o.served ? o.served(job) : job.execution, terminal: 'answered', text, trace: JSON.stringify({ fake: user }), ops,
        after: { neural: Buffer.from('neural:' + twin), twin: Buffer.from(twin) }, usage };
    }
  };
}

const toyReference: ReferenceVerifier = {
  async check({ twin_before, trace, neural_after }) {
    const mem = twin_before ? JSON.parse(twin_before.toString('utf8')) : {};
    const user = JSON.parse(trace.toString('utf8')).fake as string;
    const ops: unknown[] = [];
    for (const line of user.split('\n')) {
      const m = /^remember (.+?)=(.*)$/.exec(line.trim());
      if (m) { mem[m[1].trim()] = m[2].trim(); ops.push({ op: 'put', name: m[1].trim(), result: 'ok' }); }
    }
    const twin = Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(mem).sort())));
    return { twin_after: twin, ops, neural: { ok: neural_after !== null && neural_after.equals(Buffer.concat([Buffer.from('neural:'), twin])) } };
  }
};

test('identity: what can change an answer changes the execution hash; name and provenance do not; defaults are written out', () => {
  const store = new BlobStore(path.join(tmp(), 'blobs'));
  const p = fixture(store);
  assert.equal(p.decoding.temperature, 0);
  assert.equal(p.adapter, null);
  const h = executionHash(p);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(executionHash({ ...p, name: 'other', provenance: { parents: ['x'], reason: 'y', sources: [] } }), h);
  assert.notEqual(editionHash({ ...p, name: 'other' }), editionHash(p));
  assert.notEqual(executionHash({ ...p, prompt: 'Other.' }), h);
  assert.notEqual(executionHash({ ...p, decoding: { ...p.decoding, temperature: 0.7 } }), h);
  assert.notEqual(executionHash({ ...p, execution: { ...p.execution, firmware: store.put('fw2') } }), h);
  const twin = store.put('{}'), neural = store.put('neural:{}');
  assert.notEqual(executionHash({ ...p, memory: { neural, twin } }), h);
  // Written out or left to its default: the same junior.
  const explicit = normalizePackage({ ...p, decoding: { temperature: 0, max_tokens: 4000, max_circuit_tokens: 60000, forced_format: null } });
  assert.equal(executionHash(explicit), h);
  assert.throws(() => normalizePackage({ ...p, decoding: { ...p.decoding, top_k: 3 } }), /unknown fields: top_k/);
  assert.throws(() => normalizePackage({ ...p, memory: { neural, twin: null } }), /both/);
});

test('a closed package: every blob there with its bytes, trees walked; exported, it holds what it needs', () => {
  const dir = tmp();
  const store = new BlobStore(path.join(dir, 'blobs'));
  const p = fixture(store);
  assert.deepEqual(checkClosed(p, store), { closed: true, missing: [], corrupt: [] });
  const shard = store.tree(p.base)!.files['shards/a.bin'];
  fs.writeFileSync(store.pathOf(shard), 'tampered');
  const broken = checkClosed(p, store);
  assert.equal(broken.closed, false);
  assert.deepEqual(broken.corrupt, [shard]);
  fs.writeFileSync(store.pathOf(shard), 'weights');
  fs.rmSync(store.pathOf(p.execution.verifier));
  assert.deepEqual(checkClosed(p, store).missing, [p.execution.verifier]);
  assert.throws(() => exportPackage(p, store, path.join(dir, 'out')), /not closed/);
  store.put('ver');
  const out = exportPackage(p, store, path.join(dir, 'out'));
  assert.equal(checkClosed(p, new BlobStore(path.join(dir, 'out', 'blobs'))).closed, true);
  assert.equal(out.blobs, 9, 'the tree, its three files and five execution blobs');
});

test('one question, one published transition: asked again it is its receipt; another content or a stale state is refused', async () => {
  const dir = tmp();
  const store = new BlobStore(path.join(dir, 'blobs'));
  const calls: WorkerJob[] = [];
  const server = new SessionServer({ root: dir, store, worker: toyWorker({ calls }) });
  const s = server.open({ run_id: 'r1', pkg: fixture(store), session_id: 's1' });
  const start = s.head_id;
  const r1 = await server.ask('s1', { request_id: 'q1', content: { system: 'S', user: 'remember a=1' }, expected: start });
  assert.equal(r1.terminal, 'answered');
  assert.equal(r1.state_before, start);
  assert.notEqual(r1.state_after, start);
  const again = await server.ask('s1', { request_id: 'q1', content: { system: 'S', user: 'remember a=1' }, expected: start });
  assert.deepEqual(again, r1);
  assert.equal(calls.length, 1, 'no inference for a question already published');
  await assert.rejects(server.ask('s1', { request_id: 'q1', content: { system: 'S', user: 'remember a=2' }, expected: start }), (e: SessionError) => e.code === 'request_conflict');
  await assert.rejects(server.ask('s1', { request_id: 'q2', content: { system: 'S', user: 'x' }, expected: start }), (e: SessionError) => e.code === 'stale_state');
  const r2 = await server.ask('s1', { request_id: 'q2', content: { system: 'S', user: 'remember b=2' }, expected: r1.state_after });
  assert.equal(JSON.parse(store.get(r2.after.twin!).toString('utf8')).a, '1', 'the memory carries from one answer to the next');
  // Two sessions of the same junior never share their memory.
  const t = server.open({ run_id: 'r2', pkg: fixture(store), session_id: 's2' });
  assert.equal(t.head_id, start);
  const other = await server.ask('s2', { request_id: 'q1', content: { system: 'S', user: 'remember z=9' }, expected: start });
  assert.equal(JSON.parse(store.get(other.after.twin!).toString('utf8')).a, undefined);
});

test('a limit reached keeps its prefix and the memory before; a version served other than asked is infra, never an answer', async () => {
  const dir = tmp();
  const store = new BlobStore(path.join(dir, 'blobs'));
  const server = new SessionServer({ root: dir, store, worker: toyWorker({ served: (j) => (String((j.content as { user: string }).user).includes('swap') ? 'f'.repeat(64) : j.execution) }) });
  const s = server.open({ run_id: 'r', pkg: fixture(store), session_id: 's' });
  const cut = await server.ask('s', { request_id: 'q1', content: { user: 'remember a=1 overflow' }, expected: s.head_id });
  assert.equal(cut.terminal, 'limit_reached');
  assert.equal(cut.text, 'ok ');
  assert.equal(cut.state_after, s.head_id);
  const swapped = await server.ask('s', { request_id: 'q2', content: { user: 'remember a=1 swap' }, expected: s.head_id });
  assert.equal(swapped.terminal, 'infra_failed');
  assert.match(swapped.reason!, /served f+, not/);
  assert.equal(swapped.state_after, s.head_id);
});

test('a session opened from a snapshot declares its origin; a continuation starts from the last state published', async () => {
  const dir = tmp();
  const store = new BlobStore(path.join(dir, 'blobs'));
  const server = new SessionServer({ root: dir, store, worker: toyWorker() });
  const pkg = fixture(store);
  const s = server.open({ run_id: 'r', pkg, session_id: 'a' });
  const r = await server.ask('a', { request_id: 'q1', content: { user: 'remember k=v' }, expected: s.head_id });
  assert.throws(() => server.open({ run_id: 'r', pkg, state: r.after }), /declares where it comes from/);
  const cut = server.open({ run_id: 'probe', pkg, state: r.after, origin: { cut: 'a/q1' }, session_id: 'cut' });
  assert.equal(cut.head_id, r.state_after);
  const cont = server.open({ run_id: 'r', pkg, continues: { session_id: 'a' }, session_id: 'b' });
  assert.equal(cont.head_id, r.state_after);
  assert.deepEqual(cont.origin, { continues: 'a', receipt: 'q1', state: r.state_after });
  assert.equal(server.restore('a').head_id, r.state_after, 'restoring is the last state published, never the initial one');
});

test('a server stopped mid-question: on restart its failure is published, the memory unchanged, the spending uncertain', async () => {
  const dir = tmp();
  const store = new BlobStore(path.join(dir, 'blobs'));
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const first = new SessionServer({ root: dir, store, worker: toyWorker({ gate }) });
  const s = first.open({ run_id: 'r', pkg: fixture(store), session_id: 's' });
  const lost = first.ask('s', { request_id: 'q1', content: { user: 'remember a=1' }, expected: s.head_id });
  assert.deepEqual(first.receipt('s', 'q1'), { state: 'pending' });
  await assert.rejects(first.ask('s', { request_id: 'q2', content: { user: 'x' }, expected: s.head_id }), (e: SessionError) => e.code === 'busy');
  // Two servers never write one root.
  assert.throws(() => new SessionServer({ root: dir, store, worker: toyWorker() }), (e: SessionError) => e.code === 'root_busy');
  first.stop();
  const second = new SessionServer({ root: dir, store, worker: toyWorker() });
  const r = second.receipt('s', 'q1');
  assert.equal(r.state, 'published');
  if (r.state !== 'published') return;
  assert.equal(r.receipt.terminal, 'infra_failed');
  assert.equal(r.receipt.uncertain, true);
  assert.equal(r.receipt.state_after, s.head_id);
  // A new attempt is another request; the old one can never publish.
  const retry = await second.ask('s', { request_id: 'q1b', content: { user: 'remember a=1' }, expected: s.head_id });
  assert.equal(retry.terminal, 'answered');
  release();
  await assert.rejects(lost, (e: SessionError) => e.code === 'stopped', 'a stopped server never publishes late');
  assert.equal((await verifySession(path.join(dir, 'sessions', 's.jsonl'), store, toyReference)).ok, true);
});

test('cancelling a question publishes its failure; its worker is invalidated and the memory stays', async () => {
  const dir = tmp();
  const store = new BlobStore(path.join(dir, 'blobs'));
  let invalidated = 0;
  const worker = { ...toyWorker({ gate: new Promise(() => {}) }), invalidate: () => { invalidated++; } };
  const server = new SessionServer({ root: dir, store, worker });
  const s = server.open({ run_id: 'r', pkg: fixture(store), session_id: 's' });
  const p = server.ask('s', { request_id: 'q1', content: { user: 'remember a=1' }, expected: s.head_id });
  await new Promise((r) => setTimeout(r, 10));
  const c = await server.cancel('s', 'q1');
  assert.equal(c!.terminal, 'cancelled');
  assert.equal((await p).terminal, 'cancelled');
  assert.equal(invalidated, 1);
  assert.equal(server.info('s').head_id, s.head_id);
});

test('verify rebuilds a session from a preloaded memory with no model; it finds an altered receipt, blob or memory', async () => {
  const dir = tmp();
  const store = new BlobStore(path.join(dir, 'blobs'));
  const twin = store.put(JSON.stringify({ seed: 'x' })), neural = store.put('neural:' + JSON.stringify({ seed: 'x' }));
  const server = new SessionServer({ root: dir, store, worker: toyWorker() });
  const s = server.open({ run_id: 'r', pkg: fixture(store, { memory: { neural, twin } }), session_id: 's' });
  const r1 = await server.ask('s', { request_id: 'q1', content: { user: 'remember a=1' }, expected: s.head_id });
  await server.ask('s', { request_id: 'q2', content: { user: 'remember b=2' }, expected: r1.state_after });
  const file = path.join(dir, 'sessions', 's.jsonl');
  const good = await verifySession(file, store, toyReference);
  assert.deepEqual({ ok: good.ok, receipts: good.receipts, checked: good.memory_checked }, { ok: true, receipts: 2, checked: 2 });
  const unchecked = await verifySession(file, store, null);
  assert.equal(unchecked.ok, false);
  assert.match(unchecked.problems[0], /unchecked/);
  // An altered receipt breaks the chain.
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, text.replace('"text":"ok [[\\"a\\",\\"1\\"]', '"text":"ok [[\\"a\\",\\"2\\"]'));
  assert.match((await verifySession(file, store, toyReference)).problems.join(), /breaks the chain/);
  fs.writeFileSync(file, text);
  // A memory that is not what the reference rebuilds.
  const lying: ReferenceVerifier = { async check(i) { const o = await toyReference.check(i); return 'error' in o ? o : { ...o, twin_after: Buffer.from('{}') }; } };
  assert.match((await verifySession(file, store, lying)).problems.join(), /memory after is not/);
  // A trace lost.
  fs.rmSync(store.pathOf(r1.trace!));
  assert.match((await verifySession(file, store, toyReference)).problems.join(), /trace: blob .* missing/);
});

const python = ['python', 'python3'].find((p) => spawnSync(p, ['--version']).status === 0);

test('the Python worker and verifier (fake backend): a session served by the process and verified by the package program', { skip: !python && 'no Python' }, async () => {
  const dir = tmp();
  const store = new BlobStore(path.join(dir, 'blobs'));
  const worker = new ProcessWorker({ python: [python!], backend: 'fake', work: path.join(dir, 'work') });
  const server = new SessionServer({ root: dir, store, worker });
  try {
  const s = server.open({ run_id: 'r', pkg: fixture(store), session_id: 's' });
  const r1 = await server.ask('s', { request_id: 'q1', content: { system: 'S', user: 'remember a=1' }, expected: s.head_id });
  assert.equal(r1.terminal, 'answered');
  assert.equal(r1.served, server.info('s').execution);
  const r2 = await server.ask('s', { request_id: 'q2', content: { user: 'remember b=2\noverflow' }, expected: r1.state_after, limits: { max_tokens: 5 } });
  assert.equal(r2.terminal, 'limit_reached');
  assert.equal(r2.limits.effective.max_tokens, 5);
  const r3 = await server.ask('s', { request_id: 'q3', content: { user: 'remember b=2' }, expected: r2.state_after });
  assert.deepEqual(JSON.parse(store.get(r3.after.twin!).toString('utf8')), { a: '1', b: '2' });
  worker.invalidate();
  const report = await verifySession(path.join(dir, 'sessions', 's.jsonl'), store, processReference([python!, VERIFY_PY, '--backend', 'fake']));
  assert.deepEqual(report.problems, []);
  assert.equal(report.memory_checked, 2);
  // The qwenputer backend refuses what the driver cannot serve, before any inference.
  const strict = new SessionServer({ root: tmp(), store, worker: new ProcessWorker({ python: [python!], backend: 'qwenputer', work: path.join(dir, 'w2') }) });
  const p = fixture(store);
  assert.throws(() => strict.open({ run_id: 'r', pkg: { ...p, decoding: { ...p.decoding, temperature: 0.7 } } }), /greedily/);
  strict.stop();
  } finally { server.stop(); }
});

test('stateId names a state by both its blobs', () => {
  assert.notEqual(stateId({ neural: null, twin: null }), stateId({ neural: 'a'.repeat(64), twin: 'b'.repeat(64) }));
});

test('over HTTP: a connection cut after publishing is recovered by its receipt, never run twice; the ChatClient chains states', async () => {
  const { serveJunior } = await import('../src/junior/http.ts');
  const { JuniorSessionClient, juniorChat } = await import('../src/junior/client.ts');
  const dir = tmp();
  const store = new BlobStore(path.join(dir, 'blobs'));
  const calls: WorkerJob[] = [];
  const server = new SessionServer({ root: dir, store, worker: toyWorker({ calls }) });
  const h = await serveJunior(server);
  try {
    let cut = 1;
    const flaky = (async (url: string, init?: Parameters<typeof fetch>[1]) => {
      const r = await fetch(url, init);
      if (url.endsWith('/ask') && cut-- > 0) { await r.text(); throw new TypeError('fetch failed'); }
      return r;
    }) as never;
    const client = new JuniorSessionClient(h.url, { fetch: flaky });
    await client.open({ run_id: 'r', pkg: fixture(store), session_id: 's' });
    const chat = juniorChat({ client, session_id: 's' });
    const a = await chat.complete({ system: 'S', user: 'remember a=1' });
    assert.match(a.content, /"a","1"/);
    assert.equal(calls.length, 1, 'the cut question was recovered by its receipt');
    const b = await chat.complete({ system: 'S', user: 'remember b=2' });
    assert.match(b.content, /"b","2"/);
    assert.equal((b.raw as { receipt: string }).receipt, 's:1');
    // A laboratory resumed: a new client asks on from where the session is.
    const again = juniorChat({ client: new JuniorSessionClient(h.url), session_id: 's' });
    const c = await again.complete({ system: 'S', user: 'remember c=3' });
    assert.equal((c.raw as { receipt: string }).receipt, 's:2');
    // A refusal is the server's word, with its code.
    await assert.rejects(new JuniorSessionClient(h.url).ask('s', { request_id: 'x', content: {}, expected: 'nope' }), (e: { code: string }) => e.code === 'stale_state');
    await assert.rejects(new JuniorSessionClient(h.url).info('none'), (e: { status: number }) => e.status === 404);
  } finally { server.stop(); await h.close(); }
});

test('the providers proxy: keys stay on its machine, the most is reserved before sending, usage settles, a bag that cannot hold refuses', async () => {
  const { ProviderProxy, tokenHash } = await import('../src/junior/proxy.ts');
  const dir = tmp();
  const seen: { auth: string | null; body: string }[] = [];
  const upstream = (async (_url: string, init?: { headers?: Record<string, string>; body?: string }) => {
    seen.push({ auth: init?.headers?.authorization ?? null, body: String(init?.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }), { status: 200 });
  }) as unknown as typeof fetch;
  const config = {
    upstreams: { strong: { url: 'https://provider.example/api', key_env: 'STRONG_KEY' } },
    bags: { teacher: { tokens: 3000, calls: 10 } },
    clients: { [tokenHash('client-token')]: { bag: 'teacher', upstreams: ['strong'] } },
    ledger: path.join(dir, 'proxy.ledger.jsonl')
  };
  assert.throws(() => new ProviderProxy(config, { env: {} }), /STRONG_KEY/);
  const proxy = new ProviderProxy(config, { env: { STRONG_KEY: 'sk-secret' }, fetch: upstream });
  const ask = (max: number, token = 'client-token') => proxy.handle('POST', '/strong/v1/chat/completions', { authorization: 'Bearer ' + token }, JSON.stringify({ model: 'm', max_tokens: max, messages: [] }));
  assert.equal((await ask(100, 'wrong')).status, 401);
  assert.equal((await proxy.handle('POST', '/strong/v1/chat/completions', { authorization: 'Bearer client-token' }, JSON.stringify({ model: 'm', messages: [] }))).status, 400);
  const ok = await ask(1000);
  assert.equal(ok.status, 200);
  assert.equal(seen[0].auth, 'Bearer sk-secret');
  assert.equal(proxy.status().teacher.spent.tokens, 150);
  assert.equal((await ask(5000)).status, 402, 'a call the bag cannot hold is never sent');
  assert.equal(seen.length, 1);
  assert.doesNotMatch(fs.readFileSync(config.ledger, 'utf8'), /sk-secret|client-token/);
  // A reservation left open by a stop is spent as uncertain when the proxy comes back.
  fs.appendFileSync(config.ledger, JSON.stringify({ kind: 'reserve', id: '99-1', bag: 'teacher', tokens: 700 }) + '\n');
  const back = new ProviderProxy(config, { env: { STRONG_KEY: 'sk-secret' }, fetch: upstream });
  assert.deepEqual([back.status().teacher.spent.tokens, back.status().teacher.uncertain_tokens], [850, 700]);
  assert.throws(() => new ProviderProxy({ ...config, clients: { 'client-token': { bag: 'teacher', upstreams: ['strong'] } } }, { env: { STRONG_KEY: 'k' } }), /SHA-256/);
});

test('the machine check: every piece covered and every check holding, or no investigation starts', async () => {
  const { checkMachine } = await import('../src/junior/setup.ts');
  const dir = tmp();
  const checks = [
    { id: 'backup', covers: ['backups'], kind: 'writable', path: dir },
    { id: 'snap', covers: ['snapshots'], kind: 'command', argv: [process.execPath, '-e', 'process.exit(0)'] },
    { id: 'keys', covers: ['keys'], kind: 'no_keys', allow: ['LLM_KEY'] },
    { id: 'proxy', covers: ['proxy'], kind: 'http', url: 'http://proxy.test/status', expect: [200, 401] },
    { id: 'egress', covers: ['egress'], kind: 'unreachable', url: 'https://example.com' },
    { id: 'disk', covers: ['limits'], kind: 'disk_free', path: dir, min_gb: 0 }
  ];
  const fakeFetch = (async (url: string) => { if (url.includes('proxy.test')) return new Response('{}', { status: 401 }); throw new TypeError('blocked'); }) as unknown as typeof fetch;
  const ready = await checkMachine({ format: 'junior-machine-check@1', checks }, { env: { LLM_KEY: 'client', PATH: '/bin' }, fetch: fakeFetch });
  assert.deepEqual(ready.results.filter((r) => !r.ok), []);
  assert.equal(ready.ok, true);
  const leaky = await checkMachine({ format: 'junior-machine-check@1', checks }, { env: { OPENAI_API_KEY: 'sk' }, fetch: fakeFetch });
  assert.equal(leaky.ok, false);
  assert.match(leaky.results.find((r) => r.id === 'keys')!.detail, /OPENAI_API_KEY/);
  const partial = await checkMachine({ format: 'junior-machine-check@1', checks: checks.slice(0, 5) }, { env: {}, fetch: fakeFetch });
  assert.deepEqual(partial.uncovered, ['limits']);
  assert.equal(partial.ok, false);
});

test('lab junior: a directory stored as a tree, a package checked closed and exported, a session verified', async () => {
  const { labCli } = await import('../src/runtime/cli.ts');
  const dir = tmp();
  const store = new BlobStore(path.join(dir, 'blobs'));
  const lines: string[] = [];
  const ctx = { root: dir, out: (l: string) => { lines.push(l); } };
  const base = tmp();
  fs.writeFileSync(path.join(base, 'w.bin'), 'w');
  assert.equal(await labCli(['junior', 'store', base, '--blobs', path.join(dir, 'blobs')], ctx as never), 0);
  assert.match(lines.at(-1)!, /^tree [0-9a-f]{64}$/);
  const pkg = fixture(store);
  fs.writeFileSync(path.join(dir, 'pkg.json'), JSON.stringify(pkg));
  assert.equal(await labCli(['junior', 'package', path.join(dir, 'pkg.json'), '--blobs', path.join(dir, 'blobs'), '--export', path.join(dir, 'export')], ctx as never), 0);
  assert.ok(lines.includes('execution ' + executionHash(pkg)));
  assert.ok(fs.existsSync(path.join(dir, 'export', 'package.json')));
  const server = new SessionServer({ root: path.join(dir, 'srv'), store, worker: toyWorker() });
  const s = server.open({ run_id: 'r', pkg, session_id: 's' });
  await server.ask('s', { request_id: 'q', content: { user: 'remember a=1' }, expected: s.head_id });
  server.stop();
  const ledger = path.join(dir, 'srv', 'sessions', 's.jsonl');
  assert.equal(await labCli(['junior', 'verify', ledger, '--blobs', path.join(dir, 'blobs')], ctx as never), 1, 'without its verifier the memory is unchecked');
  if (python) {
    assert.equal(await labCli(['junior', 'verify', ledger, '--blobs', path.join(dir, 'blobs'), '--python', python, '--backend', 'fake'], ctx as never), 0);
    assert.equal(lines.at(-1), 'verified');
  }
});

test('a memory read as files through the Python worker (fake backend)', { skip: !python && 'no Python' }, async () => {
  const dir = tmp();
  const store = new BlobStore(path.join(dir, 'blobs'));
  const worker = new ProcessWorker({ python: [python!], backend: 'fake', work: path.join(dir, 'work') });
  const server = new SessionServer({ root: dir, store, worker });
  try {
    const pkg = fixture(store);
    const s = server.open({ run_id: 'r', pkg, session_id: 's' });
    const r = await server.ask('s', { request_id: 'q', content: { user: 'remember note=keep the protocol' }, expected: s.head_id });
    assert.deepEqual(await server.render({ pkg, twin: r.after.twin }), { note: 'keep the protocol' });
    assert.deepEqual(await server.render({ pkg, twin: null }), {});
  } finally { server.stop(); }
});

/* --- An external review of MA1-MA5 (29/10/2026): each failure it reproduced, reproduced here. ----------------------- */

test('review 1: what is served is what the worker loaded, checked against the package - another tokenizer is no answer', { skip: !python && 'no Python' }, async () => {
  const dir = tmp();
  const store = new BlobStore(path.join(dir, 'blobs'));
  const worker = new ProcessWorker({ python: [python!], backend: 'fake', work: path.join(dir, 'work') });
  const server = new SessionServer({ root: dir, store, worker });
  try {
    const pkg = fixture(store);
    const s = server.open({ run_id: 'r', pkg, session_id: 's' });
    const r1 = await server.ask('s', { request_id: 'q1', content: { user: 'remember a=1' }, expected: s.head_id });
    assert.equal(r1.terminal, 'answered');
    /* What the driver reads changed under the package: the next answer is not the package's. */
    const loadedTokenizer = path.join(dir, 'work', 'packages', executionHash(pkg), 'base', 'tokenizer.json');
    fs.writeFileSync(loadedTokenizer, 'another tokenizer');
    assert.equal(store.get(pkg.execution.tokenizer).toString('utf8'), 'tok', 'the blob itself is untouched');
    const r2 = await server.ask('s', { request_id: 'q2', content: { user: 'remember b=2' }, expected: r1.state_after });
    assert.equal(r2.terminal, 'infra_failed');
    assert.match(r2.reason ?? '', /served unverified.*tokenizer/);
    assert.equal(r2.state_after, r1.state_after);
  } finally { server.stop(); }
});

test('review 2: verify finds a neural snapshot that is not the memory its twin is', async () => {
  const dir = tmp();
  const store = new BlobStore(path.join(dir, 'blobs'));
  const liar: JuniorWorker = { async run(job) {
    const r = await toyWorker().run(job);
    return r.after ? { ...r, after: { neural: Buffer.from('not a snapshot at all'), twin: r.after.twin } } : r;
  } };
  const server = new SessionServer({ root: dir, store, worker: liar });
  const s = server.open({ run_id: 'r', pkg: fixture(store), session_id: 's' });
  await server.ask('s', { request_id: 'q', content: { user: 'remember a=1' }, expected: s.head_id });
  server.stop();
  const report = await verifySession(path.join(dir, 'sessions', 's.jsonl'), store, toyReference);
  assert.equal(report.ok, false);
  assert.match(report.problems.join(), /neural snapshot is not the memory its twin is/);
  const silent: ReferenceVerifier = { async check(i) { const o = await toyReference.check(i); if ('error' in o) return o; const { neural: _n, ...rest } = o; return rest; } };
  const unchecked = await verifySession(path.join(dir, 'sessions', 's.jsonl'), store, silent);
  assert.equal(unchecked.ok, false);
  assert.match(unchecked.incomplete.join(), /did not check its neural snapshot/, 'a snapshot not checked leaves the verification incomplete');
});

test('review 3: a line cut by a stop is cut away before the next record; the chain holds after', async () => {
  const dir = tmp();
  const store = new BlobStore(path.join(dir, 'blobs'));
  const first = new SessionServer({ root: dir, store, worker: toyWorker() });
  const s = first.open({ run_id: 'r', pkg: fixture(store), session_id: 's' });
  const r1 = await first.ask('s', { request_id: 'q1', content: { user: 'remember a=1' }, expected: s.head_id });
  first.stop();
  const file = path.join(dir, 'sessions', 's.jsonl');
  fs.appendFileSync(file, '{"kind":"intent","request_id":"q2","cont');
  const second = new SessionServer({ root: dir, store, worker: toyWorker() });
  const r2 = await second.ask('s', { request_id: 'q2', content: { user: 'remember b=2' }, expected: r1.state_after });
  assert.equal(r2.terminal, 'answered');
  second.stop();
  const report = await verifySession(file, store, toyReference);
  assert.deepEqual(report.problems, []);
  assert.equal(report.receipts, 2);
  /* Every ledger of the junior appends the same way. */
  const { appendRecord } = await import('../src/junior/jsonl.ts');
  const other = path.join(dir, 'other.jsonl');
  fs.writeFileSync(other, '{"a":1}\n{"b":');
  appendRecord(other, { c: 3 });
  assert.equal(fs.readFileSync(other, 'utf8'), '{"a":1}\n{"c":3}\n');
});

test('review 4: the proxy reserves a bound before sending - one completion per call, its input bounded by its bytes', async () => {
  const { ProviderProxy, tokenHash } = await import('../src/junior/proxy.ts');
  const dir = tmp();
  let sent = 0;
  const upstream = (async () => { sent++; return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }], usage: { total_tokens: 1010 } }), { status: 200 }); }) as unknown as typeof fetch;
  const config = { upstreams: { strong: { url: 'https://provider.example/api', key_env: 'K' } }, bags: { b: { tokens: 200, calls: 10 } },
    clients: { [tokenHash('t')]: { bag: 'b', upstreams: ['strong'] } }, ledger: path.join(dir, 'l.jsonl') };
  const proxy = new ProviderProxy(config, { env: { K: 'k' }, fetch: upstream });
  const call = (body: Record<string, unknown>) => proxy.handle('POST', '/strong/v1/chat/completions', { authorization: 'Bearer t' }, JSON.stringify(body));
  assert.equal((await call({ model: 'm', max_tokens: 50, n: 2, messages: [{ role: 'user', content: 'hi' }] })).status, 400, 'several completions are never proxied');
  assert.equal((await call({ model: 'm', max_tokens: 50, best_of: 3, messages: [] })).status, 400);
  const long = 'x'.repeat(400);
  assert.equal((await call({ model: 'm', max_tokens: 50, messages: [{ role: 'user', content: long }] })).status, 402, 'its input, bounded by its bytes, does not fit');
  assert.equal(sent, 0, 'nothing was sent that the bag could not hold');
});

test('review 6: running out of its declared time is the junior\'s measured limit, its prefix kept - never a failure of the infrastructure', { skip: !python && 'no Python' }, async () => {
  const dir = tmp();
  const store = new BlobStore(path.join(dir, 'blobs'));
  const server = new SessionServer({ root: dir, store, worker: new ProcessWorker({ python: [python!], backend: 'fake', work: path.join(dir, 'work') }), graceMs: 5000 });
  try {
    const s = server.open({ run_id: 'r', pkg: fixture(store), session_id: 's' });
    const r = await server.ask('s', { request_id: 'q', content: { user: 'remember a=1 sleep 3' }, expected: s.head_id, limits: { timeout_ms: 300 } });
    assert.equal(r.terminal, 'limit_reached');
    assert.equal(r.reason, 'timeout');
    assert.equal(r.text, 'ok ');
    assert.ok(r.usage !== null && !r.uncertain);
    assert.equal(r.state_after, s.head_id);
  } finally { server.stop(); }
});

/* --- A second review of MA1-MA5 (29/10/2026), against a stand-in of Qwenputer's driver that keeps its contracts
   (test/fixtures/fake-driver: the store's keys and token ids, the circuit printing inside qwen()). ------------------ */

const FAKE_DRIVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-driver');

function drivenPackage(store: BlobStore) {
  const base = tmp();
  fs.writeFileSync(path.join(base, 'chipformer.json'), JSON.stringify({ chip_layers: 2, store: { slot_bits: 10 } }));
  fs.writeFileSync(path.join(base, 'tokenizer.json'), JSON.stringify({ of: 'the checkpoint' }));
  return normalizePackage({ format: 'junior-package@1', name: 'driven', base: store.putTree(base), prompt: '',
    execution: { firmware: store.put('firmware'), tokenizer: store.put(JSON.stringify({ of: 'the package' })), chat_template: store.put('the template of the package'),
      driver: store.putTree(FAKE_DRIVER), verifier: store.put('v'), circuit: { chip_layers: 2, store: { slot_bits: 10 } }, precision: 'bf16' } });
}

test('review 2: the driver of the package imported from its folder with none installed; what running it generates is not its identity, a file added is', { skip: !python && 'no Python' }, async () => {
  const dir = tmp();
  const store = new BlobStore(path.join(dir, 'blobs'));
  const pkg = drivenPackage(store);
  const server = new SessionServer({ root: dir, store, worker: new ProcessWorker({ python: [python!], backend: 'qwenputer', work: path.join(dir, 'work') }) });
  try {
    const s = server.open({ run_id: 'r', pkg, session_id: 's' });
    const r1 = await server.ask('s', { request_id: 'q1', content: { user: 'compute' }, expected: s.head_id });
    assert.equal(r1.terminal, 'answered', r1.reason ?? '');
    assert.equal(r1.served, executionHash(pkg));
    assert.equal(r1.text, 'ARESULTnswer');
    const drv = path.join(dir, 'work', 'drivers', pkg.execution.driver);
    assert.ok(!fs.existsSync(path.join(drv, 'chipformer', '__pycache__')), 'running it wrote no bytecode next to it');
    fs.mkdirSync(path.join(drv, 'chipformer', '__pycache__'), { recursive: true });
    fs.writeFileSync(path.join(drv, 'chipformer', '__pycache__', 'x.cpython-311.pyc'), 'bytecode');
    const r2 = await server.ask('s', { request_id: 'q2', content: { user: 'compute' }, expected: r1.state_after });
    assert.equal(r2.served, executionHash(pkg), 'a cache is not part of the driver');
    fs.writeFileSync(path.join(drv, 'chipformer', 'extra.py'), 'x = 1');
    const r3 = await server.ask('s', { request_id: 'q3', content: { user: 'compute' }, expected: r2.state_after });
    assert.equal(r3.terminal, 'infra_failed');
    assert.match(r3.reason ?? '', /driver/);
  } finally { server.stop(); }
});

test('review 2: a timeout keeps what the generation emitted - what the circuit printed and its count - as limit_reached', { skip: !python && 'no Python' }, async () => {
  const dir = tmp();
  const store = new BlobStore(path.join(dir, 'blobs'));
  const server = new SessionServer({ root: dir, store, worker: new ProcessWorker({ python: [python!], backend: 'qwenputer', work: path.join(dir, 'work') }), graceMs: 5000 });
  try {
    const s = server.open({ run_id: 'r', pkg: drivenPackage(store), session_id: 's' });
    const r = await server.ask('s', { request_id: 'q', content: { user: 'slow' }, expected: s.head_id, limits: { timeout_ms: 300 } });
    assert.deepEqual([r.terminal, r.reason], ['limit_reached', 'timeout']);
    assert.match(r.text, /^ARESULTn/, 'the answer of the circuit is in the prefix');
    assert.equal(r.usage?.circuit_tokens, 6);
  } finally { server.stop(); }
});

test('review 2: the simulator of the teacher and render take the forms of the store - token ids, None, whole keys', { skip: !python && 'no Python' }, async () => {
  const dir = tmp();
  const store = new BlobStore(path.join(dir, 'blobs'));
  const pkg = drivenPackage(store);
  const server = new SessionServer({ root: dir, store, worker: new ProcessWorker({ python: [python!], backend: 'qwenputer', work: path.join(dir, 'work') }) });
  try {
    const put = await server.memoryCall({ pkg, twin: null, call: { op: 'put', name: 'memo', text: 'hello there' } });
    assert.equal(put.result, 'ok');
    /* What the circuit prints is what the junior would read: the value as the store keeps it. */
    assert.equal((await server.memoryCall({ pkg, twin: put.twin, call: { op: 'get', name: 'memo' } })).result, 'hello there\n');
    /* Read as files, the protocol's newline after each value is not the file's (review 3). */
    assert.deepEqual(await server.render({ pkg, twin: put.twin }), { memo: 'hello there' });
    const own = await server.memoryCall({ pkg, twin: put.twin, call: { op: 'put', name: 'two', text: 'line one\n' } });
    assert.deepEqual(await server.render({ pkg, twin: own.twin }), { memo: 'hello there', two: 'line one\n' }, 'a newline of the content stays');
    /* Review 4: a file built by append is its chunks, each read as the value it was, then joined. */
    const call = async (twin: string | null, op: 'put' | 'append', name: string, text: string) => (await server.memoryCall({ pkg, twin, call: { op, name, text } })).twin;
    let t = await call(null, 'put', 'memo', 'hello');
    t = await call(t, 'append', 'memo', 'world');
    assert.deepEqual(await server.render({ pkg, twin: t }), { memo: 'helloworld' });
    t = await call(t, 'append', 'memo', '!');
    assert.deepEqual(await server.render({ pkg, twin: t }), { memo: 'helloworld!' }, 'several appends');
    let u = await call(null, 'put', 'notes', 'a\nb');
    u = await call(u, 'append', 'notes', '\nc\n');
    u = await call(u, 'append', 'notes', 'd');
    assert.deepEqual(await server.render({ pkg, twin: u }), { notes: 'a\nb\nc\nd' }, 'the content\'s own newlines, inside and at the end of a chunk, stay');
    /* A call holds at most CMAX (104) tokens: more is cut, and the reading says so - a memory asked with more is not what was asked. */
    const long = 'x'.repeat(150);
    const cut = await server.render({ pkg, twin: await call(null, 'put', 'big', long) });
    assert.equal(cut.big.length, 104);
    const { memoryDiff } = await import('../src/junior/memory.ts');
    assert.deepEqual(memoryDiff({ big: long }, cut), ['big differs']);
    let whole = await call(null, 'put', 'big', 'x'.repeat(100));
    whole = await call(whole, 'append', 'big', 'x'.repeat(50));
    assert.deepEqual(memoryDiff({ big: long }, await server.render({ pkg, twin: whole })), [], 'split by append, it fits');
    const full = 'y'.repeat(103) + String.fromCharCode(10);
    assert.deepEqual(await server.render({ pkg, twin: await call(null, 'put', 'full', full) }), { full }, 'a chunk filled to CMAX keeps its own last newline');
  } finally { server.stop(); }
});

test('review 2: without the neural snapshot shown to be the memory of its twin, a verification is incomplete - never ok', { skip: !python && 'no Python' }, async () => {
  const dir = tmp();
  const store = new BlobStore(path.join(dir, 'blobs'));
  const pkg = drivenPackage(store);
  const server = new SessionServer({ root: dir, store, worker: new ProcessWorker({ python: [python!], backend: 'qwenputer', work: path.join(dir, 'work') }) });
  try {
    const s = server.open({ run_id: 'r', pkg, session_id: 's' });
    await server.ask('s', { request_id: 'q', content: { user: 'compute' }, expected: s.head_id });
  } finally { server.stop(); }
  const files = path.join(dir, 'work', 'packages', executionHash(pkg));
  const reference = processReference([python!, VERIFY_PY, '--backend', 'qwenputer', '--firmware', path.join(files, 'firmware.elf'), '--tokenizer', path.join(files, 'base', 'tokenizer.json'), '--driver', path.join(dir, 'work', 'drivers', pkg.execution.driver)]);
  const report = await verifySession(path.join(dir, 'sessions', 's.jsonl'), store, reference);
  assert.deepEqual(report.problems, [], 'the stream and the twin are rebuilt');
  assert.equal(report.ok, false);
  assert.match(report.incomplete.join(), /not shown to be the memory its twin is/);
});

test('review 2: the trainer translates a memory call with the token ids of the package, its result out of the loss', { skip: !python && 'no Python' }, () => {
  const script = [
    'import sys, json', 'sys.path.insert(0, ' + JSON.stringify(FAKE_DRIVER) + ')', 'sys.path.insert(0, ' + JSON.stringify(path.dirname(TRAIN_PY_PATH)) + ')',
    'import junior_train as T', 'from transformers import AutoTokenizer', 'tok = AutoTokenizer.from_pretrained("x")',
    'row = {"system": "S", "user": ["U"], "calls": [{"op": "get", "name": "memo", "result": "hi"}, {"op": "list", "result": "memo"}], "answer": "A"}',
    'ids, labels = T.encode(tok, row, "", 4096)', 'print(json.dumps({"labels": labels, "ids": ids}))'
  ].join('\n');
  const r = spawnSync(python!, ['-c', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const { labels, ids } = JSON.parse(r.stdout.trim()) as { labels: number[]; ids: number[] };
  const code = (s: string) => [...s].map((c) => c.charCodeAt(0));
  const trained = labels.filter((l) => l !== -100);
  assert.deepEqual(trained.slice(0, 11), [1, 2, ...code('get'), 3, ...code('memo'), 5], 'the call in the protocol of the junior, its name as token ids');
  assert.deepEqual(trained.slice(11, 11 + 7), [1, 2, ...code('list'), 5], 'a call without a name passes None');
  assert.deepEqual(trained.slice(-2), [code('A')[0], 10], 'the answer, then its end');
  const read = ids.findIndex((t, i) => t === code('h')[0] && ids[i + 1] === code('i')[0]);
  assert.ok(read > 0 && labels[read] === -100, 'what it read is context, out of the loss');
});

/* --- A third review (29/10/2026). ------------------------------------------------------------------------------------- */

test('review 3: two versions with one driver - only their prompt differs - are served by the same process, one after the other', { skip: !python && 'no Python' }, async () => {
  const dir = tmp();
  const store = new BlobStore(path.join(dir, 'blobs'));
  const a = drivenPackage(store);
  const b = normalizePackage({ ...a, prompt: 'Another prompt.' });
  assert.notEqual(executionHash(a), executionHash(b));
  const server = new SessionServer({ root: dir, store, worker: new ProcessWorker({ python: [python!], backend: 'qwenputer', work: path.join(dir, 'work') }) });
  try {
    const sa = server.open({ run_id: 'r', pkg: a, session_id: 'a' });
    const ra = await server.ask('a', { request_id: 'q', content: { user: 'compute' }, expected: sa.head_id });
    const sb = server.open({ run_id: 'r', pkg: b, session_id: 'b' });
    const rb = await server.ask('b', { request_id: 'q', content: { user: 'compute' }, expected: sb.head_id });
    assert.deepEqual([ra.terminal, rb.terminal], ['answered', 'answered'], rb.reason ?? '');
    assert.equal(rb.served, executionHash(b));
    assert.equal(fs.readdirSync(path.join(dir, 'work', 'drivers')).length, 1, 'one folder for the one driver');
  } finally { server.stop(); }
});

/* --- The neural snapshot against its twin (29/10/2026): the circuit's own executor, run on the recorded stream from the
   state before, must leave exactly the rows published - as chipformer.rv.storecheck checks its store. ---------------- */

test('a verification complete: the circuit, run on the recorded stream from the state before, leaves exactly the snapshot published', { skip: !python && 'no Python' }, async () => {
  const dir = tmp();
  const store = new BlobStore(path.join(dir, 'blobs'));
  const pkg = drivenPackage(store);
  const server = new SessionServer({ root: dir, store, worker: new ProcessWorker({ python: [python!], backend: 'qwenputer', work: path.join(dir, 'work') }) });
  try {
    const s = server.open({ run_id: 'r', pkg, session_id: 's' });
    const r1 = await server.ask('s', { request_id: 'q1', content: { user: 'compute' }, expected: s.head_id });
    await server.ask('s', { request_id: 'q2', content: { user: 'compute again' }, expected: r1.state_after });
  } finally { server.stop(); }
  const files = path.join(dir, 'work', 'packages', executionHash(pkg));
  const args = [python!, VERIFY_PY, '--backend', 'qwenputer', '--firmware', path.join(files, 'firmware.elf'), '--tokenizer', path.join(files, 'base', 'tokenizer.json'),
    '--driver', path.join(dir, 'work', 'drivers', pkg.execution.driver)];
  const complete = await verifySession(path.join(dir, 'sessions', 's.jsonl'), store, processReference([...args, '--base', path.join(files, 'base')]));
  assert.deepEqual([complete.problems, complete.incomplete, complete.ok, complete.memory_checked], [[], [], true, 2]);
  const without = await verifySession(path.join(dir, 'sessions', 's.jsonl'), store, processReference(args));
  assert.equal(without.ok, false);
  assert.match(without.incomplete.join(), /no --base/);
});

test('a snapshot whose rows are not those the circuit leaves is refused, row by row', { skip: !python && 'no Python' }, () => {
  const base = tmp();
  fs.writeFileSync(path.join(base, 'chipformer.json'), JSON.stringify({ chip_layers: 2, store: {} }));
  fs.writeFileSync(path.join(base, 'fw'), 'firmware');
  const script = [
    'import sys, json, base64, pickle, types',
    'sys.path.insert(0, ' + JSON.stringify(FAKE_DRIVER) + ')', 'sys.path.insert(0, ' + JSON.stringify(path.dirname(VERIFY_PY)) + ')',
    'import junior_verify as V',
    'from chipformer.rv import store as ST',
    'dev = ST.Device(); s = ST.StoreSession(None, None, None, dev=dev); s.call("put", [109], [104])',
    'snap = lambda v: base64.b64encode(json.dumps({"files": [{"0": [v]}]}).encode()).decode()',
    'args = types.SimpleNamespace(base=' + JSON.stringify(base) + ', firmware=' + JSON.stringify(path.join(base, 'fw')) + ')',
    'inp = {"trace": json.dumps({"prompt_ids": [1, 2], "stream": [1, 2, 3]}), "neural_before": snap(1.0)}',
    'same = V.neural_check(dict(inp, neural_after=snap(1.0)), dev, None, args)',
    'other = V.neural_check(dict(inp, neural_after=snap(3.0)), dev, None, args)',
    'print(json.dumps({"same": same, "other": other, "diff": V.snapshot_diff({"h": [{"0": [1.0], "1": [2.0]}]}, {"h": [{"0": [1.0]}]})}))'
  ].join('\n');
  const r = spawnSync(python!, ['-c', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.deepEqual(out.same, { ok: true });
  assert.equal(out.other.ok, false);
  assert.notEqual(out.other.checked, false, 'a difference found is a refusal, not an incomplete check');
  assert.match(out.other.why, /not those the circuit leaves: files\[0\] row 0 differs/);
  assert.match(out.diff[0], /rows \[0, 1\] against \[0\]/);
});
