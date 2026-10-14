import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/* ============================================================================
 * Where an artifact runs (SPEC-MUNDO-ARTEFACTOS §10): one interface, so that a backend that
 * isolates can come later without changing anything that runs artifacts. Today one backend,
 * with no dependency (the author's rule, 14/10/2026: no Docker):
 *
 *   process   a local process in a fresh working directory, the artifact copied beside its
 *             workload, an empty environment (no secret of the host), a time limit, its output
 *             clipped. It is NOT isolated: it can reach the network and the files the user can.
 *             Only for artifacts the operator trusts.
 *
 * Every run says which backend ran it and whether it was isolated.
 * ========================================================================== */

export interface Limits {
  /** Wall time of the command, at most (ms). */
  readonly timeoutMs: number;
  /** stdout and stderr kept, at most (characters each). */
  readonly outputMax?: number;
}

export interface Execution {
  /** The command, run in the working directory, the artifact at `src/`. */
  readonly command: readonly string[];
  /** What the command reads on its standard input. */
  readonly stdin?: string;
  /** Files written to the working directory before the command runs (the workload). */
  readonly inputs?: Readonly<Record<string, string>>;
  /** Files of the working directory read back after it (its outputs). */
  readonly outputs?: readonly string[];
}

export interface RunResult {
  readonly backend: 'process';
  readonly isolated: boolean;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  /** The files read back, or null where the command did not write them. */
  readonly outputs: Readonly<Record<string, string | null>>;
  /** Wall time of the command alone (ms). */
  readonly wallMs: number;
  /** CPU time (ms) and peak memory (KB), where the backend measures them; null otherwise. */
  readonly cpuMs: number | null;
  readonly peakKb: number | null;
}

export interface Sandbox {
  readonly backend: 'process';
  readonly isolated: boolean;
  /** Runs one execution of the artifact written at `artifactDir`. */
  run(artifactDir: string, execution: Execution, limits: Limits): Promise<RunResult>;
}

const OUTPUT_MAX = 20000;
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + '\n[... ' + (s.length - n) + ' more characters]' : s);

/** A fresh working directory with the workload's files, and the artifact beside it. */
function workdir(inputs: Readonly<Record<string, string>> | undefined): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-run-'));
  for (const [name, content] of Object.entries(inputs ?? {})) {
    if (!name || name.includes('..') || path.isAbsolute(name)) throw new Error('an input file is a plain name inside the working directory: "' + name + '"');
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return dir;
}

const readBack = (dir: string, names: readonly string[] | undefined): Record<string, string | null> =>
  Object.fromEntries((names ?? []).map((n) => { const f = path.join(dir, n); return [n, fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null]; }));

/** Runs a command with a timeout and what it reads; resolves with what came out. */
function spawnWith(cmd: string, args: readonly string[], o: { cwd?: string; stdin?: string; timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<{ code: number | null; timedOut: boolean; stdout: string; stderr: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const child = spawn(cmd, [...args], { cwd: o.cwd, env: o.env, windowsHide: true });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', (d) => { if (stdout.length < 4 * OUTPUT_MAX) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < 4 * OUTPUT_MAX) stderr += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, o.timeoutMs);
    child.on('error', (e) => { stderr += String(e.message); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, stdout, stderr, ms: Number(process.hrtime.bigint() - t0) / 1e6 });
    });
    if (o.stdin !== undefined) child.stdin.end(o.stdin); else child.stdin.end();
  });
}

/** NOT isolated: a local process, the artifact copied beside the workload. For development and the harness's own tests. */
export function processSandbox(): Sandbox {
  return {
    backend: 'process', isolated: false,
    async run(artifactDir, execution, limits) {
      const dir = workdir(execution.inputs);
      try {
        fs.cpSync(artifactDir, path.join(dir, 'src'), { recursive: true });
        const [cmd, ...args] = execution.command;
        /* Nothing of the host's environment but what finds the runtime. */
        const env = { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', TEMP: dir, TMP: dir, HOME: dir };
        const r = await spawnWith(cmd, args, { cwd: dir, stdin: execution.stdin, timeoutMs: limits.timeoutMs, env });
        const max = limits.outputMax ?? OUTPUT_MAX;
        return { backend: 'process', isolated: false, exitCode: r.timedOut ? null : r.code, timedOut: r.timedOut, stdout: clip(r.stdout, max), stderr: clip(r.stderr, max),
          outputs: readBack(dir, execution.outputs), wallMs: r.ms, cpuMs: null, peakKb: null };
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
  };
}
