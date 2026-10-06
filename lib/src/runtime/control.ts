import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findingOf, findingView, type Finding, type FindingView } from '../learn/finding.ts';
import { LABS } from '../worlds/labs.ts';

/* ============================================================================
 * The CONTROL of laboratory runs (SPEC-INVESTIGADOR-ASISTIDO §4): the same for both
 * researchers, under the command line (A2) and the console (A3). A run is its journal; next
 * to it, besides its replay log and its findings:
 *
 *   <run>.status.json   its live state (running / stopping / ended), pid, heartbeat, round,
 *                       researcher, cost - written by the runner with every event and every
 *                       couple of seconds
 *   <run>.inbox.jsonl   the operator's orders, one per line with an id - written here, never
 *                       by the runner; read by the runner before each question to System 2
 *
 * A run without an `end` whose heartbeat stopped was interrupted: it can be resumed. The keys
 * never pass through here: a run started from here takes them from this process's environment.
 * ========================================================================== */

export type RunState = 'running' | 'stopping' | 'ended' | 'interrupted';

export interface RunInfo {
  /** The run's name: its journal's file name without .json. */
  readonly run: string;
  readonly journal: string;
  readonly lab: string;
  readonly researcher: string;
  readonly state: RunState;
  readonly started: string | null;
  readonly heartbeat: string | null;
  readonly round: number | null;
  readonly stoppedBy: string | null;
  readonly cost: Readonly<Record<string, number>> | null;
  readonly pid: number | null;
}

/** An order to a run. `stop` is obeyed by any researcher; the others are help, which only the assisted one takes. */
export type RunOrder =
  | { readonly kind: 'stop'; readonly by?: string }
  | { readonly kind: 'message'; readonly text: string; readonly by?: string; /** A senior's: an order, not a suggestion (SPEC-ORQUESTADOR §3.3.3). */ readonly directive?: boolean }
  | { readonly kind: 'focus'; readonly facet: string; readonly task?: string; readonly by?: string }
  | { readonly kind: 'source'; readonly source: string; readonly by?: string };

/** The files of a run, from its journal. */
export function runFiles(journal: string): { journal: string; status: string; inbox: string; replay: string; finding: string; researcherFinding: string; log: string } {
  const base = journal.replace(/\.json$/, '');
  return { journal, status: base + '.status.json', inbox: base + '.inbox.jsonl', replay: base + '.replay.jsonl', finding: base + '.finding.json',
    researcherFinding: base + '.finding.researcher.json', log: base + '.log' };
}

const readJson = (file: string): any => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

/** A heartbeat older than this means the run is no longer alive. */
const STALE_MS = 15000;

/** A run's state, from its status file and its journal. */
export function runStatus(journal: string, options: { staleMs?: number; now?: number } = {}): RunInfo {
  const files = runFiles(journal);
  const status = readJson(files.status);
  const j = readJson(journal);
  const end = Array.isArray(j?.events) ? [...j.events].reverse().find((e: { type: string }) => e.type === 'end') : undefined;
  const heartbeat: string | null = status?.heartbeat ?? null;
  const alive = heartbeat !== null && (options.now ?? Date.now()) - Date.parse(heartbeat) < (options.staleMs ?? STALE_MS);
  const state: RunState = end || status?.state === 'ended' ? 'ended' : alive ? (status.state === 'stopping' ? 'stopping' : 'running') : 'interrupted';
  const lastRound = Array.isArray(j?.events) ? [...j.events].reverse().find((e: { round?: unknown }) => typeof e.round === 'number')?.round ?? null : null;
  return {
    run: path.basename(journal, '.json'), journal, lab: String(j?.experiment ?? status?.lab ?? ''),
    researcher: String(j?.researcher ?? status?.researcher ?? 'unknown-world'), state,
    started: j?.started ?? status?.started ?? null, heartbeat, round: status?.round ?? lastRound,
    stoppedBy: end?.stoppedBy ?? status?.stoppedBy ?? null, cost: status?.cost ?? null, pid: status?.pid ?? null
  };
}

/** Whether a file is a run's journal (not one of the files next to it). */
const isJournal = (name: string): boolean => name.endsWith('.json') && !/\.(finding|finding\.researcher|status|method)\.json$/.test(name);

/** The runs in a folder (default: <root>/runs), newest first. */
export function listRuns(folder: string): RunInfo[] {
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder).filter(isJournal).map((f) => runStatus(path.join(folder, f)))
    .filter((r) => r.lab)
    .sort((a, b) => (b.started ?? '').localeCompare(a.started ?? ''));
}

let orders = 0;

/** Writes an order in a run's inbox; the run reads it before its next question to System 2 (and acknowledges it in its
    journal: `operator_command`, or `operator_command_refused` with the reason). */
export function send(journal: string, order: RunOrder): { id: string } {
  const id = 'order-' + Date.now().toString(36) + '-' + (++orders) + '-' + process.pid;
  fs.appendFileSync(runFiles(journal).inbox, JSON.stringify({ id, at: new Date().toISOString(), ...order }) + '\n');
  return { id };
}

export const stop = (journal: string, by?: string): { id: string } => send(journal, { kind: 'stop', ...(by ? { by } : {}) });

/** What the journal says of an order: accepted, refused (with why), or not read yet. */
export function orderOutcome(journal: string, id: string): { state: 'pending' | 'accepted' | 'refused'; reason?: string } {
  const e = (readJson(journal)?.events ?? []).find((x: { id?: string; type: string }) => x.id === id && /^operator_command/.test(x.type));
  return !e ? { state: 'pending' } : e.type === 'operator_command' ? { state: 'accepted' } : { state: 'refused', reason: e.reason };
}

/** A run's finding: the file the runner wrote, or derived from the journal (a run that has not ended has a partial one). */
export function finding(journal: string, view: FindingView = 'operator'): Finding {
  const files = runFiles(journal);
  const written = readJson(view === 'operator' ? files.finding : files.researcherFinding);
  if (written) return written as Finding;
  const f = findingOf(readJson(journal) ?? {}, { journal: path.basename(journal) });
  return findingView(f, view);
}

/** Follows a run's journal: `onEvent` gets each new event (polling). Returns the function that stops following. */
export function watch(journal: string, onEvent: (event: Record<string, unknown>) => void, options: { intervalMs?: number } = {}): () => void {
  let seen = 0;
  const tick = (): void => {
    const events = readJson(journal)?.events;
    if (!Array.isArray(events)) return;
    for (const e of events.slice(seen)) onEvent(e);
    seen = events.length;
  };
  tick();
  const timer = setInterval(tick, options.intervalMs ?? 1000);
  return () => clearInterval(timer);
}

/** The folder of the library (lib/), where the runner's script is. */
const LIB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Starts a run in a process of its own and returns at once: its journal (to follow, order, resume) and its pid. The
    process takes the endpoints and keys from `env` (default: this process's environment); its output goes to <run>.log. */
export function startRun(lab: string, options: { root: string; args?: readonly string[]; researcher?: string; policy?: string; env?: NodeJS.ProcessEnv; name?: string }): { journal: string; pid: number } {
  const journal = path.join(options.root, 'runs', (options.name ?? lab) + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
  return launch(journal, ['--lab', lab, ...(options.args ?? []), ...(options.researcher ? ['--researcher', options.researcher] : []), ...(options.policy ? ['--policy', options.policy] : []),
    '--out', journal], options.env);
}

/** Resumes a run in a process of its own, as a run derived from it (the journal resumed stays as it was). */
export function resumeRun(journal: string, options: { args?: readonly string[]; policy?: string; env?: NodeJS.ProcessEnv } = {}): { journal: string; pid: number } {
  const lab = Object.entries(LAB_IDS).find(([, id]) => id === readJson(journal)?.experiment)?.[0];
  if (!lab) throw new Error('not a resumable journal of a known laboratory: ' + journal);
  const derived = journal.replace(/\.json$/, '') + '.resumed-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
  return launch(derived, ['--lab', lab, '--resume', journal, ...(options.args ?? []), ...(options.policy ? ['--policy', options.policy] : []), '--out', derived], options.env);
}

/** The laboratories' names on the command line, by the id their journals carry. */
const LAB_IDS: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(LABS).map(([name, lab]) => [name, lab.id]));

function launch(journal: string, args: readonly string[], env?: NodeJS.ProcessEnv): { journal: string; pid: number } {
  fs.mkdirSync(path.dirname(journal), { recursive: true });
  const out = fs.openSync(runFiles(journal).log, 'a');
  const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings=ExperimentalWarning', path.join(LIB, 'scripts', 'run-lab.ts'), ...args],
    { cwd: LIB, env: env ?? process.env, detached: true, stdio: ['ignore', out, out], windowsHide: true });
  child.unref();
  fs.closeSync(out);
  return { journal, pid: child.pid ?? -1 };
}
