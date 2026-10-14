import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

/* ============================================================================
 * Where an artifact runs (SPEC-MUNDO-ARTEFACTOS §10). One interface, two backends:
 *
 *   docker    isolated: a fresh container per run, no network, limits of CPU, memory and
 *             processes, the artifact mounted read-only, a fresh working directory. Wall time,
 *             CPU and peak memory are measured INSIDE the container (its cgroup), so starting
 *             the container never counts as the artifact's time.
 *   process   a local process, NOT isolated: for development and for the harness's own tests,
 *             with artifacts of its own. What it measures is the host's view (wall time only).
 *
 * Every run says which backend ran it and whether it was isolated.
 * ========================================================================== */

export interface Limits {
  /** Wall time of the command, at most (ms). */
  readonly timeoutMs: number;
  /** Memory (MB) and CPUs (docker). */
  readonly memoryMb?: number;
  readonly cpus?: number;
  /** Processes at once (docker). */
  readonly pids?: number;
  /** stdout and stderr kept, at most (characters each). */
  readonly outputMax?: number;
}

export interface Execution {
  /** The command, run in the working directory, the artifact at `src/` (read-only in docker). */
  readonly command: readonly string[];
  /** What the command reads on its standard input. */
  readonly stdin?: string;
  /** Files written to the working directory before the command runs (the workload). */
  readonly inputs?: Readonly<Record<string, string>>;
  /** Files of the working directory read back after it (its outputs). */
  readonly outputs?: readonly string[];
}

export interface RunResult {
  readonly backend: 'docker' | 'process';
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
  readonly backend: 'docker' | 'process';
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

/** The script the container runs: the command timed inside, then what its cgroup says of CPU and memory, on a last line. */
const MEASURE = [
  'start=$(date +%s%N)',
  'timeout -s KILL "$LIMIT_S" "$@" < /work/stdin',
  'code=$?',
  'end=$(date +%s%N)',
  'cpu=$(sed -n "s/^usage_usec //p" /sys/fs/cgroup/cpu.stat 2>/dev/null)',
  'peak=$(cat /sys/fs/cgroup/memory.peak 2>/dev/null)',
  'echo "@@measure@@ $code $(( (end - start) / 1000 )) ${cpu:--} ${peak:--}" >&2',
  'exit $code'
].join('\n');

/** Isolated: a fresh container per run, with no network and the given limits, from `image`. */
export function dockerSandbox(image: string, options: { docker?: string } = {}): Sandbox {
  const docker = options.docker ?? 'docker';
  return {
    backend: 'docker', isolated: true,
    async run(artifactDir, execution, limits) {
      const dir = workdir({ ...(execution.inputs ?? {}), stdin: execution.stdin ?? '', 'measure.sh': MEASURE });
      try {
        const args = ['run', '--rm', '--network', 'none', '--read-only', '--tmpfs', '/tmp:rw,size=64m',
          '--memory', (limits.memoryMb ?? 512) + 'm', '--memory-swap', (limits.memoryMb ?? 512) + 'm', '--cpus', String(limits.cpus ?? 1), '--pids-limit', String(limits.pids ?? 128),
          '--mount', 'type=bind,src=' + path.resolve(artifactDir) + ',dst=/work/src,readonly',
          '--mount', 'type=bind,src=' + dir + ',dst=/work',
          '-e', 'LIMIT_S=' + Math.max(1, Math.ceil(limits.timeoutMs / 1000)), '-w', '/work', image, 'sh', '/work/measure.sh', ...execution.command];
        /* The container's own start is outside the command's limit: a margin, the command timed inside. */
        const r = await spawnWith(docker, args, { timeoutMs: limits.timeoutMs + 15000 });
        const m = /@@measure@@ (-?\d+) (\d+) (\S+) (\S+)\s*$/.exec(r.stderr);
        const stderr = r.stderr.replace(/@@measure@@[^\n]*\n?$/, '');
        const wallMs = m ? Number(m[2]) / 1000 : r.ms;
        /* Killed by its limit inside (137 from `timeout -s KILL`), or the container overran its margin. */
        const timedOut = r.timedOut || (m !== null && Number(m[1]) === 137 && wallMs >= limits.timeoutMs - 50) || wallMs > limits.timeoutMs;
        const max = limits.outputMax ?? OUTPUT_MAX;
        return { backend: 'docker', isolated: true, exitCode: timedOut ? null : m ? Number(m[1]) : r.code, timedOut, stdout: clip(r.stdout, max), stderr: clip(stderr, max),
          outputs: readBack(dir, execution.outputs), wallMs,
          cpuMs: m && m[3] !== '-' ? Number(m[3]) / 1000 : null, peakKb: m && m[4] !== '-' ? Math.round(Number(m[4]) / 1024) : null };
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
  };
}

/** Whether docker answers here (its engine running), and its server version; null when it does not. */
export function dockerAvailable(docker = 'docker'): string | null {
  const r = spawnSync(docker, ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}
