import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/* ============================================================================
 * The ISOLATED BACKEND for free programs (SPEC-EDICION-PESOS §4.4, WE2): no network, the weights read-only, writing only
 * in its folder, its time, memory and CPU bounded - by the junior machine's own operating system, without Docker or a
 * service to install: Linux user and network namespaces (unshare, of util-linux) and Landlock.
 *
 * It is never assumed. It is AVAILABLE only when its self-test, run in the very isolation a program would get, proves it:
 * a connection attempted and refused, a write outside its folder and one into the base refused, a write inside and a read
 * of the base done. Anywhere else (Windows, a kernel without Landlock, namespaces refused) it is unavailable, with the
 * reason, and an edit of origin `program` is refused. The process sandbox of the artifacts world (processSandbox) never
 * counts as isolated.
 * ========================================================================== */

export const ISOLATE_PY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'junior_isolate.py');
export const ISOLATION_ID = 'linux-userns-landlock@1';

export interface ProgramLimits { readonly timeout_ms: number; readonly memory_bytes: number; readonly cpu_seconds: number; readonly output_bytes: number }

export interface ProgramRun {
  readonly state: 'finished' | 'failed' | 'timeout';
  /** The files the program wrote in its out/ folder, by their path inside it. */
  readonly outputs: Record<string, Buffer>;
  readonly reason: string | null;
  readonly wall_ms: number;
}

export interface IsolatedBackend {
  readonly id: string;
  /** The program's code run on its inputs (written into inputs/), the base checkpoint readable at `base`. */
  run(o: { code: string; inputs: Readonly<Record<string, Buffer>>; base: string; limits: ProgramLimits }): Promise<ProgramRun>;
}

export type Availability = { readonly available: true; readonly backend: IsolatedBackend; readonly proof: Record<string, unknown> } | { readonly available: false; readonly reason: string; readonly proof?: Record<string, unknown> };

const PREFIX = ['unshare', '--user', '--map-root-user', '--net', '--'];

function launch(argv: string[], timeoutMs: number): Promise<{ code: number | null; out: string; err: string; timedOut: boolean; wall_ms: number }> {
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try { child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } }); }
    catch (e) { resolve({ code: null, out: '', err: (e as Error).message, timedOut: false, wall_ms: 0 }); return; }
    let out = '', err = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (c) => { if (out.length < 1 << 20) out += c; });
    child.stderr.on('data', (c) => { if (err.length < 1 << 16) err += c; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: null, out, err: err + e.message, timedOut, wall_ms: Date.now() - started }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err, timedOut, wall_ms: Date.now() - started }); });
  });
}

/** Whether a self-test's answer proves the isolation a program needs. */
export function proves(proof: Record<string, unknown>): string | null {
  const refused = (k: string) => typeof proof[k] === 'string' && (proof[k] as string).startsWith('refused');
  const missing: string[] = [];
  if (!(Number(proof.landlock_abi) >= 1)) missing.push('Landlock (' + String(proof.error ?? 'not in this kernel') + ')');
  if (!refused('network')) missing.push('no network');
  if (!refused('write_outside')) missing.push('no write outside its folder');
  if (!refused('write_base')) missing.push('the weights read-only');
  if (proof.write_inside !== 'done') missing.push('a write inside its folder');
  if (proof.read_base !== 'done') missing.push('a read of the base');
  return missing.length ? 'the self-test did not prove: ' + missing.join(', ') : null;
}

/** The isolated backend of this machine, if its self-test proves it. */
export async function isolatedBackend(o: { python: readonly string[]; platform?: NodeJS.Platform }): Promise<Availability> {
  if ((o.platform ?? process.platform) !== 'linux') return { available: false, reason: 'isolation needs Linux namespaces and Landlock; this machine is ' + (o.platform ?? process.platform) };
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'junior-isolate-'));
  try {
    const base = path.join(work, 'base');
    const sandbox = path.join(work, 'work');
    fs.mkdirSync(base);
    fs.mkdirSync(path.join(sandbox, 'out'), { recursive: true });
    fs.writeFileSync(path.join(base, 'w'), 'weights');
    const r = await launch([...PREFIX, ...o.python, '-I', ISOLATE_PY, 'selftest', sandbox, base], 30_000);
    let proof: Record<string, unknown>;
    try { proof = JSON.parse(r.out.trim().split('\n').pop() ?? ''); } catch { return { available: false, reason: 'the self-test did not run in its namespaces: ' + (r.err.trim().slice(-300) || 'exit ' + r.code) }; }
    const why = proves(proof);
    if (why) return { available: false, reason: why, proof };
    return { available: true, proof, backend: { id: ISOLATION_ID, run: (x) => runProgram(o.python, x) } };
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

async function runProgram(python: readonly string[], o: { code: string; inputs: Readonly<Record<string, Buffer>>; base: string; limits: ProgramLimits }): Promise<ProgramRun> {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'junior-program-'));
  try {
    fs.mkdirSync(path.join(work, 'inputs'));
    fs.mkdirSync(path.join(work, 'out'));
    fs.writeFileSync(path.join(work, 'program.py'), o.code);
    for (const [name, bytes] of Object.entries(o.inputs)) {
      if (!/^[\w.-]+$/.test(name)) return { state: 'failed', outputs: {}, reason: 'an input named ' + name, wall_ms: 0 };
      fs.writeFileSync(path.join(work, 'inputs', name), bytes);
    }
    const limits = path.join(work, 'limits.json');
    fs.writeFileSync(limits, JSON.stringify({ memory_bytes: o.limits.memory_bytes, cpu_seconds: o.limits.cpu_seconds, output_bytes: o.limits.output_bytes }));
    const r = await launch([...PREFIX, ...python, '-I', ISOLATE_PY, 'run', work, o.base, limits], o.limits.timeout_ms);
    if (r.timedOut) return { state: 'timeout', outputs: {}, reason: 'its time ran out (' + o.limits.timeout_ms + ' ms)', wall_ms: r.wall_ms };
    if (r.code !== 0) return { state: 'failed', outputs: {}, reason: 'it exited ' + r.code + ': ' + r.err.trim().slice(-400), wall_ms: r.wall_ms };
    const outputs: Record<string, Buffer> = {};
    let total = 0;
    for (const f of fs.readdirSync(path.join(work, 'out')).sort()) {
      const full = path.join(work, 'out', f);
      if (!fs.statSync(full).isFile()) continue;
      total += fs.statSync(full).size;
      if (total > o.limits.output_bytes) return { state: 'failed', outputs: {}, reason: 'its outputs exceed ' + o.limits.output_bytes + ' bytes', wall_ms: r.wall_ms };
      outputs[f] = fs.readFileSync(full);
    }
    return { state: 'finished', outputs, reason: null, wall_ms: r.wall_ms };
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}
