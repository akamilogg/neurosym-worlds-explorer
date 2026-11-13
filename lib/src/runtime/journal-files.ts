import fs from 'node:fs';
import path from 'node:path';
import { appendRecord } from '../junior/jsonl.ts';

/* ============================================================================
 * How a run's journal is written (SPEC-CONSOLIDACION §3.2, CC1 - its writing only):
 *
 *   <run>.events.jsonl  every event appended as one whole line - the durable record. A line cut by a stop is cut away
 *                       before the next is added (the junior's ledgers' rule), and a line broken in the middle is told,
 *                       never skipped.
 *   <run>.json          the whole journal its readers and tools read, written to a temporary and renamed over it: whole or
 *                       not at all. Where the rename is refused (a reader holding it open on Windows), it is tried again;
 *                       past that the temporary stays, pending, and the journal stays the last whole one - never written
 *                       in place, where a stop would leave it cut.
 *   <run>.meta.json     the journal without its events, written the same way whenever it changes: what a resumption
 *                       joins to the record of lines when <run>.json itself cannot be read.
 *
 * All of them belong to ONE execution: the journal and its checkpoint carry its `run_id`, the record of lines names it in
 * its first line ({"journal_run": <id>}), and a temporary is the journal it was writing. A resumption reads the newest
 * complete state OF THAT EXECUTION - the journal or a pending temporary of the same run_id whose events continue the
 * journal's, else the checkpoint of metadata - and its events from the record of lines of the same execution where those
 * continue them and hold more. A state of another execution (a temporary another process left under a name used again)
 * is never taken; one of the same execution that does not continue the others is told, never chosen by its length.
 * ========================================================================== */

export const eventsFileOf = (journalFile: string): string => journalFile.replace(/\.json$/, '') + '.events.jsonl';
export const metaFileOf = (journalFile: string): string => journalFile.replace(/\.json$/, '') + '.meta.json';

const tmpPrefix = (file: string): string => path.basename(file) + '.';

/** Writes a file whole or not at all: to a temporary beside it, renamed over it. A refused rename is tried again; past that
    the temporary is left pending and the file keeps its last whole content. Answers whether it was published. */
export function writeAtomic(file: string, text: string, o: { rename?: (from: string, to: string) => void; wait?: number } = {}): boolean {
  const rename = o.rename ?? fs.renameSync;
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, text);
  for (let k = 0; k < 8; k++) {
    try { rename(tmp, file); return true; } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw e;
      const until = Date.now() + (o.wait ?? 15) * (k + 1);
      while (Date.now() < until) { /* a moment: the reader lets go */ }
    }
  }
  return false;
}

/** One event appended to the record of lines, after cutting any fragment a stop left. */
export function appendEvent(journalFile: string, event: unknown): void { appendRecord(eventsFileOf(journalFile), event); }

/** A new run's record of lines: its first line names the execution it belongs to (a name used before starts again). */
export function startEvents(journalFile: string, runId?: string): void {
  fs.writeFileSync(eventsFileOf(journalFile), runId ? JSON.stringify({ journal_run: runId }) + '\n' : '');
}

const isHeader = (e: unknown): boolean => !!e && typeof e === 'object' && typeof (e as { journal_run?: unknown }).journal_run === 'string' && Object.keys(e).length === 1;

/** The record of lines whole: the execution its first line names (null in a record written before it was named) and its
    events. Null when there is none. A last line cut by a stop is no event; a line broken before the last is a corruption,
    told with its line - never skipped. */
export function eventRecordOf(journalFile: string): { run: string | null; events: Record<string, unknown>[] } | null {
  const f = eventsFileOf(journalFile);
  if (!fs.existsSync(f)) return null;
  const text = fs.readFileSync(f, 'utf8');
  const lines = text.split('\n');
  const whole = lines.slice(0, -1);
  const out: Record<string, unknown>[] = [];
  let run: string | null = null;
  whole.forEach((l, i) => {
    if (!l.trim()) return;
    let e: Record<string, unknown>;
    try { e = JSON.parse(l); } catch { throw new Error(path.basename(f) + ': line ' + (i + 1) + ' is corrupt (a broken line before the last is not a stop: the record cannot be read past it)'); }
    if (isHeader(e)) { if (i === 0) run = e.journal_run as string; return; }
    out.push(e);
  });
  return { run, events: out };
}

/** The events of the record of lines, null when there is none. */
export function eventsOf(journalFile: string): Record<string, unknown>[] | null { return eventRecordOf(journalFile)?.events ?? null; }

/** A file's JSON, or null where it does not read whole. */
function parsed(file: string): Record<string, any> | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
/** Whether `longer` continues `shorter`: the same events, then more (or as many). */
const continues = (longer: readonly unknown[], shorter: readonly unknown[]): boolean => longer.length >= shorter.length && shorter.every((e, i) => same(e, longer[i]));

/** A journal as a resumption reads it. The execution it is is the one last STARTED under the name - the first line of its
    record of lines, written before anything else of a run - else the journal's own (a journal written before executions
    were named). Its newest complete state: the journal if it is of that execution, or a pending temporary of the same
    execution continuing it, else the checkpoint of metadata of that execution; its events from the record of lines where
    those continue them and hold more. A journal of an earlier execution is never returned for the one last started: where
    that one left no state, it is a conflict, told. */
export function readJournalFile(journalFile: string): Record<string, any> {
  const dir = path.dirname(journalFile);
  const main = parsed(journalFile);
  const meta = parsed(metaFileOf(journalFile));
  const record = eventRecordOf(journalFile);
  const isState = (j: Record<string, any> | null): j is Record<string, any> => j !== null && Array.isArray(j.events);
  /* The execution: the start marker of the record of lines; without one, the journal's, else its checkpoint's. */
  const run: string | null = record?.run ?? (isState(main) ? main.run_id : meta?.run_id) ?? null;
  const ours = (j: Record<string, any>): boolean => (j.run_id ?? null) === run;
  const pending = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith(tmpPrefix(journalFile)) && f.endsWith('.tmp')).map((f) => parsed(path.join(dir, f))) : [];
  let j: Record<string, any> | null = isState(main) && ours(main) ? main : null;
  for (const p of pending) {
    if (!isState(p) || !ours(p)) continue;
    if (!j) { j = p; continue; }
    if (continues(p.events, j.events)) { if (p.events.length > j.events.length) j = p; }
    else if (run !== null && !continues(j.events, p.events)) throw new Error(path.basename(journalFile) + ': a pending state of the same execution does not continue the journal (their events part ways): it is not chosen by its length');
  }
  if (!j && meta && ours(meta)) j = { ...meta, events: [] };
  if (!j) {
    if (isState(main)) throw new Error(path.basename(journalFile) + ': it is of execution ' + (main.run_id ?? '(unnamed)') + ', but the last started under this name is ' + run
      + ', and that one left no state to recover (no journal, temporary or checkpoint of its own): a conflict, never resolved by returning the earlier run');
    throw new Error(path.basename(journalFile) + ' cannot be read, and there is no checkpoint of its metadata to recover it from');
  }
  if (record && record.events.length > j.events.length && (record.run ?? null) === (j.run_id ?? null)) {
    if (continues(record.events, j.events)) j = { ...j, events: record.events };
    /* Of the same named execution and parting ways: a corruption, told. Unnamed (written before executions were), whose
       they are cannot be told: not taken. */
    else if (run !== null) throw new Error(path.basename(journalFile) + ': its record of lines does not continue the journal (their events part ways)');
  }
  return j;
}

/** The record of lines written again whole from a journal's events, under its execution: what a tool that changes a
    journal it read (regrade) leaves, so the two never part ways. */
export function rewriteEvents(journalFile: string, runId: string | null, events: readonly unknown[]): void {
  writeAtomic(eventsFileOf(journalFile), (runId ? JSON.stringify({ journal_run: runId }) + '\n' : '') + events.map((e) => JSON.stringify(e) + '\n').join(''));
}

/** Runs `publish` holding the journal's lock (<run>.lock, created exclusively): two tools that change one journal - two
    regradings - publish one after the other, each reading the state then in force inside it. A lock older than
    `staleMs` (a process that died holding it) is taken over. */
export async function withJournalLock<T>(journalFile: string, publish: () => T | Promise<T>, o: { waitMs?: number; staleMs?: number } = {}): Promise<T> {
  const lock = journalFile.replace(/\.json$/, '') + '.lock';
  const until = Date.now() + (o.waitMs ?? 60_000);
  for (;;) {
    try { fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' }); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > (o.staleMs ?? 5 * 60_000)) { fs.rmSync(lock, { force: true }); continue; } } catch { continue; }
      if (Date.now() > until) throw new Error(path.basename(journalFile) + ' is being changed by another process (' + path.basename(lock) + '): not published');
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  try { return await publish(); } finally { fs.rmSync(lock, { force: true }); }
}
