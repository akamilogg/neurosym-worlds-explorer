import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BlobStore, checkClosed, editionHash, executionHash, exportPackage, normalizePackage, type JuniorPackage } from '../src/junior/package.ts';
import { SessionError, SessionServer, stateId, type JuniorWorker, type WorkerJob, type WorkerResult } from '../src/junior/sessions.ts';
import { processReference, verifySession, type ReferenceVerifier } from '../src/junior/verify.ts';
import { ProcessWorker, VERIFY_PY } from '../src/junior/worker.ts';

/* SPEC-METAPOLITICA-APRENDIZAJE MA1: the junior packaged (§4), its sessions (§5.1) and their reconstruction (§5.2). */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'junior-test-'));

function fixture(store: BlobStore, over: Partial<Record<string, unknown>> = {}): JuniorPackage {
  const base = tmp();
  fs.writeFileSync(path.join(base, 'config.json'), '{"model":"tiny"}');
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
  async check({ twin_before, trace }) {
    const mem = twin_before ? JSON.parse(twin_before.toString('utf8')) : {};
    const user = JSON.parse(trace.toString('utf8')).fake as string;
    const ops: unknown[] = [];
    for (const line of user.split('\n')) {
      const m = /^remember (.+?)=(.*)$/.exec(line.trim());
      if (m) { mem[m[1].trim()] = m[2].trim(); ops.push({ op: 'put', name: m[1].trim(), result: 'ok' }); }
    }
    return { twin_after: Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(mem).sort()))), ops };
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
  const shard = Object.values(store.tree(p.base)!.files)[1];
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
  assert.equal(out.blobs, 8, 'the tree, its two files and five execution blobs');
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
