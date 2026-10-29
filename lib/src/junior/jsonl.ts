import fs from 'node:fs';
import path from 'node:path';

/* ============================================================================
 * Append-only JSONL ledgers (SPEC-METAPOLITICA-APRENDIZAJE §5.1, §7.1): a line is there whole or not at all.
 *
 * A process stopped while it wrote leaves a last line cut. A reader skips it; a writer must never append after it, or the
 * next record is glued to the fragment and is lost with it (or breaks a chain). So before every append the file is made
 * to end at its last whole line: a fragment with no newline after it is cut away. Records are written with their
 * newline in one write, and synced when they publish something.
 * ========================================================================== */

/** Cuts a trailing fragment (bytes after the last newline) from a ledger; answers how many bytes it cut. */
export function trimFragment(file: string): number {
  if (!fs.existsSync(file)) return 0;
  const size = fs.statSync(file).size;
  if (size === 0) return 0;
  const fd = fs.openSync(file, 'r+');
  try {
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, size - 1);
    if (last[0] === 0x0a) return 0;
    /* Back from the end to the last newline: everything after it is the fragment. */
    const chunk = Buffer.alloc(64 * 1024);
    let pos = size;
    while (pos > 0) {
      const start = Math.max(0, pos - chunk.length);
      const n = fs.readSync(fd, chunk, 0, pos - start, start);
      const i = chunk.subarray(0, n).lastIndexOf(0x0a);
      if (i >= 0) { fs.ftruncateSync(fd, start + i + 1); return size - (start + i + 1); }
      pos = start;
    }
    fs.ftruncateSync(fd, 0);
    return size;
  } finally { fs.closeSync(fd); }
}

/** Appends one record as one whole line, after cutting any fragment a stop left; `sync` when it publishes something. */
export function appendRecord(file: string, record: unknown, o: { sync?: boolean } = {}): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  trimFragment(file);
  const fd = fs.openSync(file, 'a');
  try { fs.writeSync(fd, JSON.stringify(record) + '\n'); if (o.sync) fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
