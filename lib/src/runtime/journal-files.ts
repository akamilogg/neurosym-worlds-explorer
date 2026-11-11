import fs from 'node:fs';

/* ============================================================================
 * How a run's journal is written (SPEC-CONSOLIDACION §3.2, CC1 - its writing only): every event appended as one line to
 * <run>.events.jsonl, the durable record; <run>.json, the whole journal its readers and tools read, written to a temporary
 * file and renamed over it - a reader never finds it half written (V16 of REPASO-2026-11-10). Resuming, the record of lines
 * rules: where <run>.json holds fewer events than it, the events are taken from it.
 * ========================================================================== */

/** The record of lines beside a journal. */
export const eventsFileOf = (journalFile: string): string => journalFile.replace(/\.json$/, '') + '.events.jsonl';

/** Writes a file whole or not at all: to a temporary beside it, renamed over it. Where the rename is refused for a moment (a
    reader holding the file open on Windows) it is tried again; past that, written in place, as before. */
export function writeAtomic(file: string, text: string): void {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, text);
  for (let k = 0; k < 5; k++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break;
      const until = Date.now() + 10 * (k + 1);
      while (Date.now() < until) { /* a moment: the reader lets go */ }
    }
  }
  fs.writeFileSync(file, text);
  try { fs.rmSync(tmp, { force: true }); } catch { /* left behind: harmless */ }
}

/** One event appended to the record of lines. */
export function appendEvent(journalFile: string, event: unknown): void {
  fs.appendFileSync(eventsFileOf(journalFile), JSON.stringify(event) + '\n');
}

/** A new run's record of lines, empty (a name used before starts again). */
export function startEvents(journalFile: string): void { fs.writeFileSync(eventsFileOf(journalFile), ''); }

/** The events of the record of lines: every whole line, a last line cut by a stop left out. Null when there is none. */
export function eventsOf(journalFile: string): Record<string, unknown>[] | null {
  const f = eventsFileOf(journalFile);
  if (!fs.existsSync(f)) return null;
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}

/** A journal as a resumed run reads it: <run>.json, its events from the record of lines where that holds more. */
export function readJournalFile(journalFile: string): Record<string, any> {
  const j = JSON.parse(fs.readFileSync(journalFile, 'utf8')) as Record<string, any>;
  const lines = eventsOf(journalFile);
  if (lines && lines.length > (Array.isArray(j.events) ? j.events.length : 0)) j.events = lines;
  return j;
}
