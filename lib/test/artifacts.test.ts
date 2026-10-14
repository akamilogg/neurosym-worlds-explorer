import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArtifactStore, cleanPath, hashOf } from '../src/artifacts/store.ts';
import { dockerAvailable, dockerSandbox, processSandbox, type Sandbox } from '../src/artifacts/sandbox.ts';

/* SPEC-MUNDO-ARTEFACTOS §5 and §10: the artifact versioned by its content, and where it runs. */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-test-'));

test('versions by content: a patch makes another, the same content is the same version, nothing outside the artifact', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.writeFileSync(path.join(dir, 'main.py'), 'print(1)\n');
  fs.writeFileSync(path.join(dir, 'lib', 'util.py'), 'X = 1\n');
  fs.mkdirSync(path.join(dir, '__pycache__'));
  fs.writeFileSync(path.join(dir, '__pycache__', 'junk.pyc'), 'junk');
  const store = ArtifactStore.fromDirectory(dir);
  const base = store.get(store.base)!;
  assert.deepEqual([...base.files.keys()].sort(), ['lib/util.py', 'main.py'], 'without what is excluded');
  const v1 = store.apply(store.base, { files: { 'main.py': 'print(2)\n' } });
  assert.ok(typeof v1 !== 'string');
  assert.equal(v1.parent, store.base);
  const again = store.apply(store.base, { files: { 'main.py': 'print(2)\n' } });
  assert.equal(typeof again !== 'string' && again.hash, v1.hash, 'the same content, the same version');
  const back = store.apply(v1.hash, { files: { 'main.py': 'print(1)\n' } });
  assert.equal(typeof back !== 'string' && back.hash, store.base, 'back to the base is the base');
  assert.match(String(store.apply(store.base, { files: { '../evil.py': 'x' } })), /not a path inside/);
  assert.match(String(store.apply(store.base, { files: { 'C:/x.py': 'x' } })), /not a path inside/);
  assert.match(String(store.apply(store.base, { files: { 'nope.py': null } })), /no file "nope.py"/);
  assert.match(String(store.apply(store.base, { files: {} })), /changes no file/);
  assert.match(String(store.apply(store.base, { files: { 'main.py': 'print(1)\n' } })), /changes nothing/);
  const v2 = store.apply(v1.hash, { files: { 'lib/util.py': null, 'lib/fast.py': 'Y = 2\n' } });
  assert.ok(typeof v2 !== 'string');
  assert.deepEqual(store.diff(store.base, v2.hash), { added: ['lib/fast.py'], removed: ['lib/util.py'], changed: [{ path: 'main.py', before: 9, after: 9 }] });
  const viewed = store.view(v2.hash, 'lib/fast.py');
  assert.ok(typeof viewed !== 'string' && viewed.text === '1: Y = 2\n2: ');
  const out = tmp();
  store.materialize(v2.hash, out);
  assert.equal(fs.readFileSync(path.join(out, 'lib', 'fast.py'), 'utf8'), 'Y = 2\n');
  assert.ok(!fs.existsSync(path.join(out, 'lib', 'util.py')));
  assert.equal(cleanPath('a\\b.py'), 'a/b.py');
  assert.equal(hashOf(new Map([['a', '1'], ['b', '2']])), hashOf(new Map([['b', '2'], ['a', '1']])), 'order does not matter');
});

/** The same checks for any backend: inputs, stdin, outputs, a limit, nothing of the host's secrets. */
async function exercise(sandbox: Sandbox, python: string) {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'main.py'), [
    'import sys, os',
    'data = open("input.txt").read().split()',
    'extra = sys.stdin.read().strip()',
    'open("out.txt", "w").write(str(sum(int(x) for x in data)) + "|" + extra)',
    'print("keys:" + ",".join(sorted(k for k in os.environ if "KEY" in k)))'
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'spin.py'), 'while True: pass\n');
  process.env.LLM_KEY_FOR_TEST = 'secret';
  const r = await sandbox.run(dir, { command: [python, 'src/main.py'], stdin: 'hello', inputs: { 'input.txt': '1 2 3 4' }, outputs: ['out.txt', 'missing.txt'] }, { timeoutMs: 20000 });
  delete process.env.LLM_KEY_FOR_TEST;
  assert.equal(r.exitCode, 0, r.stderr);
  assert.deepEqual(r.outputs, { 'out.txt': '10|hello', 'missing.txt': null });
  assert.equal(r.stdout.trim(), 'keys:', 'no secret of the host reaches the artifact');
  assert.ok(r.wallMs > 0);
  const spin = await sandbox.run(dir, { command: [python, 'src/spin.py'] }, { timeoutMs: 1500 });
  assert.equal(spin.timedOut, true);
  assert.equal(spin.exitCode, null);
  return r;
}

test('process backend (NOT isolated): runs the artifact beside its workload, reads its outputs back, enforces the limit', async () => {
  const r = await exercise(processSandbox(), 'python');
  assert.deepEqual([r.backend, r.isolated, r.cpuMs, r.peakKb], ['process', false, null, null]);
});

const docker = dockerAvailable();
test('docker backend: isolated - no network, the artifact read-only, CPU and memory measured inside', { skip: docker ? false : 'the docker engine is not running' }, async () => {
  const sandbox = dockerSandbox('python:3.11-slim');
  const r = await exercise(sandbox, 'python');
  assert.deepEqual([r.backend, r.isolated], ['docker', true]);
  assert.ok(r.cpuMs !== null && r.peakKb !== null, 'measured by its cgroup');
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'net.py'), 'import socket\ntry:\n  socket.create_connection(("1.1.1.1", 80), timeout=3); print("net")\nexcept Exception: print("no net")\n');
  fs.writeFileSync(path.join(dir, 'write.py'), 'try:\n  open("src/x", "w").write("x"); print("wrote")\nexcept Exception: print("read-only")\n');
  assert.equal((await sandbox.run(dir, { command: ['python', 'src/net.py'] }, { timeoutMs: 20000 })).stdout.trim(), 'no net');
  assert.equal((await sandbox.run(dir, { command: ['python', 'src/write.py'] }, { timeoutMs: 20000 })).stdout.trim(), 'read-only');
});
