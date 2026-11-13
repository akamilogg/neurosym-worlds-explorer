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
 * A resumption reads the newest complete state: the journal or a pending temporary, whichever holds more, else the
 * checkpoint of metadata; its events from the record of lines where that holds more.
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

/** A new run's record of lines, empty (a name used before starts again). */
export function startEvents(journalFile: string): void { fs.writeFileSync(eventsFileOf(journalFile), ''); }

/** The events of the record of lines, null when there is none. A last line cut by a stop is no event; a line broken
    before the last is a corruption, told with its line - never skipped. */
export function eventsOf(journalFile: string): Record<string, unknown>[] | null {
  const f = eventsFileOf(journalFile);
  if (!fs.existsSync(f)) return null;
  const text = fs.readFileSync(f, 'utf8');
  const lines = text.split('\n');
  const whole = text.endsWith('\n') ? lines.slice(0, -1) : lines.slice(0, -1);
  const out: Record<string, unknown>[] = [];
  whole.forEach((l, i) => {
    if (!l.trim()) return;
    try { out.push(JSON.parse(l)); } catch { throw new Error(path.basename(f) + ': line ' + (i + 1) + ' is corrupt (a broken line before the last is not a stop: the record cannot be read past it)'); }
  });
  return out;
}

/** A file's JSON, or null where it does not read whole. */
function parsed(file: string): Record<string, any> | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** A journal as a resumption reads it: the newest complete state (the journal, or a pending temporary holding more), else
    the checkpoint of metadata; its events from the record of lines where that holds more. */
export function readJournalFile(journalFile: string): Record<string, any> {
  const dir = path.dirname(journalFile);
  const pending = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith(tmpPrefix(journalFile)) && f.endsWith('.tmp')).map((f) => parsed(path.join(dir, f))) : [];
  const states = [parsed(journalFile), ...pending].filter((j): j is Record<string, any> => j !== null && Array.isArray(j.events));
  let j = states.sort((a, b) => b.events.length - a.events.length)[0] ?? null;
  if (!j) {
    const meta = parsed(metaFileOf(journalFile));
    if (!meta) throw new Error(path.basename(journalFile) + ' cannot be read, and there is no checkpoint of its metadata to recover it from');
    j = { ...meta, events: [] };
  }
  const lines = eventsOf(journalFile);
  if (lines && lines.length > j.events.length) j = { ...j, events: lines };
  return j;
}
