import fs from 'node:fs';
import { appendRecord } from './jsonl.ts';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { stableStringify } from '../core/hash.ts';
import type { JuniorSessionClient } from './client.ts';
import { executionHash, normalizePackage, type JuniorPackage } from './package.ts';
import type { MemoryState } from './sessions.ts';

/* ============================================================================
 * The junior's INITIAL MEMORY as a lever (SPEC-METAPOLITICA-APRENDIZAJE §7, MA3): files written into its own memory
 * before it starts - methods, reminders of the protocol - loaded as state, never as prompt.
 *
 * The memory lives in the circuit's store: nothing outside the model writes it. So the files are written BY THE JUNIOR, in
 * a writing session of its own: it is given the files and asked to save each with its tools. What it wrote is read back
 * through its reference twin (`render`); the memory is accepted only when it holds exactly the files it started with and
 * the files asked - anything else is refused, never patched from outside. Each attempt is a session of the junior's
 * server, recorded; a memory accepted is kept by what was asked, so the same files on the same junior are written once.
 * ========================================================================== */

export interface MemoryBuild {
  readonly key: string;
  readonly state: MemoryState;
  readonly session: string;
  readonly receipt: string;
  readonly files: Readonly<Record<string, string>>;
  readonly attempts: number;
}

export interface MemoryFailure { readonly error: string; readonly attempts: readonly { readonly session: string; readonly why: string }[] }

/** What the junior is asked in a writing session: the files, and to save each exactly. */
export function writingContent(files: Readonly<Record<string, string>>): { system: string; user: { parts: string[] } } {
  return {
    system: 'You are preparing your own memory before your next investigation. Use your memory tools only.',
    user: { parts: [JSON.stringify({ task: 'Save each of these files in your memory, exactly as given, under its name: one put per file, and append for text that does not fit in one call. Then answer DONE.', files }, null, 2)] }
  };
}

const sha = (v: unknown): string => createHash('sha256').update(stableStringify(v)).digest('hex');

/** Where two readings of a memory differ: names missing, extra or with other text. Empty: the same. */
export function memoryDiff(want: Readonly<Record<string, string>>, got: Readonly<Record<string, string>>): string[] {
  const out: string[] = [];
  for (const [n, t] of Object.entries(want)) if (!(n in got)) out.push('missing ' + n); else if (got[n] !== t) out.push(n + ' differs');
  for (const n of Object.keys(got)) if (!(n in want)) out.push('extra ' + n);
  return out;
}

/** The memory of `pkg` with `files` written on top by the junior itself. `pkg`'s own memory is where it starts. */
export async function buildMemory(o: { client: JuniorSessionClient; pkg: JuniorPackage; files: Readonly<Record<string, string>>; ledger: string; attempts?: number }): Promise<MemoryBuild | MemoryFailure> {
  const pkg = normalizePackage(o.pkg);
  const key = sha({ format: 'memory-write@1', execution: executionHash(pkg), files: o.files });
  if (fs.existsSync(o.ledger)) for (const l of fs.readFileSync(o.ledger, 'utf8').split('\n')) {
    try { const r = JSON.parse(l) as MemoryBuild & { kind?: string }; if (r.kind === 'built' && r.key === key) return r; } catch { /* cut line */ }
  }
  fs.mkdirSync(path.dirname(o.ledger), { recursive: true });
  const start = await o.client.render(pkg, pkg.memory.twin);
  const want = { ...start, ...o.files };
  const attempts: { session: string; why: string }[] = [];
  for (let i = 0; i < (o.attempts ?? 2); i++) {
    const session = 'm-' + key.slice(0, 20) + '-' + i;
    try {
      try { await o.client.info(session); } catch { await o.client.open({ run_id: 'memory:' + key.slice(0, 16), pkg, session_id: session }); }
      const { head_id } = await o.client.restore(session);
      const r = await o.client.ask(session, { request_id: 'write', content: writingContent(o.files), expected: head_id });
      if (r.terminal !== 'answered') { attempts.push({ session, why: 'the junior did not answer whole (' + r.terminal + ')' }); continue; }
      const got = await o.client.render(pkg, r.after.twin);
      const diff = memoryDiff(want, got);
      if (diff.length) { attempts.push({ session, why: 'its memory is not what was asked: ' + diff.slice(0, 6).join(', ') }); continue; }
      const built: MemoryBuild = { key, state: r.after, session, receipt: r.request_id, files: got, attempts: i + 1 };
      appendRecord(o.ledger, { kind: 'built', ...built });
      return built;
    } catch (e) { attempts.push({ session, why: String((e as Error).message ?? e) }); }
  }
  appendRecord(o.ledger, { kind: 'refused', key, attempts });
  return { error: 'the junior did not write the memory asked in ' + attempts.length + ' attempt(s)', attempts };
}
