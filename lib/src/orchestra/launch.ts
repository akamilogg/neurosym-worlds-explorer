import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { JEV_DEFAULT_URL } from '../core/jev.ts';
import { openAiChatClient, type ChatClient } from '../learn/system2.ts';
import { ReplayLog } from '../runtime/replay.ts';
import { LabError, type LabRunOptions } from '../runtime/lab-runner.ts';
import { projectFiles, type Autonomy, type ProjectGoal } from './project.ts';

/* ============================================================================
 * Launching the orchestra from the command line and the console (Node only). The keys come
 * only from the process's environment (SPEC-ORQUESTADOR §6):
 *
 *   LLM_URL, LLM_MODEL, LLM_KEY                    the researchers' System 2
 *   PLANNER_LLM_URL, PLANNER_LLM_MODEL, _KEY       the planner (default: the researchers')
 *   AGENT_LLM_URL, AGENT_LLM_MODEL, AGENT_LLM_KEY  the agent operators (default: the researchers')
 *   JEV_URL, JEV_KEY, JEV_MODEL                    the Judge
 *
 * A project's planner goes through a replay log of its own (planner.replay.<n>.jsonl next to the
 * project): resumed, it decides the same up to where it was (Q5).
 * ========================================================================== */

export interface ProjectFile {
  readonly id: string;
  readonly question: string;
  readonly criterion?: string;
  readonly budget: { readonly tokens: number; readonly iterations?: number };
  readonly autonomy?: Autonomy;
  readonly threshold?: number;
  readonly max_runs?: number;
}

/** The endpoints of a role from the environment (a role's own, else the researchers'). */
export function endpointsFromEnv(env: NodeJS.ProcessEnv, role: 'LLM' | 'PLANNER_LLM' | 'AGENT_LLM'): { url?: string; model?: string; key?: string } {
  const pick = (k: string) => env[role + '_' + k] || env['LLM_' + k];
  return { url: pick('URL'), model: pick('MODEL'), key: pick('KEY') };
}

/** The researchers' System 2 and the Judge, as runLaboratory takes them. */
export function labEndpointsFromEnv(env: NodeJS.ProcessEnv): { llm: LabRunOptions['llm']; judge: LabRunOptions['judge'] } {
  return { llm: { url: env.LLM_URL, key: env.LLM_KEY, model: env.LLM_MODEL }, judge: { url: env.JEV_URL || JEV_DEFAULT_URL, key: env.JEV_KEY, model: env.JEV_MODEL } };
}

/** An agent's or the planner's client, through a replay log when one is given. */
export function chatFromEnv(env: NodeJS.ProcessEnv, role: 'PLANNER_LLM' | 'AGENT_LLM', replay?: { file: string; from?: string; channel: string }): ChatClient {
  const e = endpointsFromEnv(env, role);
  if (!e.url || !e.model) throw new LabError('the ' + (role === 'PLANNER_LLM' ? 'planner' : 'agent') + ' needs an LLM: ' + role + '_URL and ' + role + '_MODEL (or LLM_URL and LLM_MODEL)');
  const log = replay ? new ReplayLog(replay.file, replay.from ? { from: replay.from } : {}) : null;
  return openAiChatClient({ url: e.url, apiKey: e.key, model: e.model, jsonMode: true, temperature: 0.3, timeoutMs: 180000, retries: 1, ...(log ? { fetch: log.wrap(replay!.channel) } : {}) });
}

/** The planner's replay logs of a project, oldest first: the next one to write, and the latest to replay. */
export function plannerLogs(dir: string): { next: string; latest?: string } {
  const logs = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^planner\.replay\.\d+\.jsonl$/.test(f)).sort((a, b) => Number(a.split('.')[2]) - Number(b.split('.')[2])) : [];
  const latest = logs.at(-1);
  return { next: path.join(dir, 'planner.replay.' + (latest ? Number(latest.split('.')[2]) + 1 : 1) + '.jsonl'), ...(latest ? { latest: path.join(dir, latest) } : {}) };
}

const LIB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Starts (or resumes) a project in a process of its own; its goal file is kept in the project's folder. */
export function startProject(root: string, goal: ProjectFile | null, id: string, env?: NodeJS.ProcessEnv): { dir: string; pid: number } {
  const files = projectFiles(root, id);
  fs.mkdirSync(files.dir, { recursive: true });
  const goalFile = path.join(files.dir, 'goal.json');
  if (goal) fs.writeFileSync(goalFile, JSON.stringify(goal, null, 2));
  else if (!fs.existsSync(goalFile)) throw new LabError('no project ' + id + ' to resume');
  const out = fs.openSync(path.join(files.dir, 'project.log'), 'a');
  const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings=ExperimentalWarning', path.join(LIB, 'scripts', 'run-project.ts'), '--root', root, '--project', id],
    { cwd: LIB, env: env ?? process.env, detached: true, stdio: ['ignore', out, out], windowsHide: true });
  child.unref();
  fs.closeSync(out);
  return { dir: files.dir, pid: child.pid ?? -1 };
}

/** A goal file, checked. */
export function readProjectFile(file: string): ProjectFile {
  let g: ProjectFile;
  try { g = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new LabError('cannot read ' + file + ': ' + String((e as Error).message ?? e)); }
  if (!g.id || !g.question || !(g.budget?.tokens > 0)) throw new LabError(file + ': a project needs id, question and budget.tokens');
  if (g.autonomy && !['consultive', 'threshold', 'autonomous'].includes(g.autonomy)) throw new LabError(file + ': autonomy is consultive, threshold or autonomous');
  return g;
}

export type { ProjectGoal };
