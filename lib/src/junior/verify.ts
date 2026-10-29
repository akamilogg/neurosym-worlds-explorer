import { spawn } from 'node:child_process';
import { stableStringify } from '../core/hash.ts';
import { sha256, type BlobStore } from './package.ts';
import { readLedger, stateId, type MemoryState, type Receipt } from './sessions.ts';

/* ============================================================================
 * Rebuilding a junior's session from its ledger (SPEC-METAPOLITICA-APRENDIZAJE §5.2), without network nor inference.
 *
 * The harness checks what is its own: the ledger's chain, every blob present with its bytes, each question's content
 * against its hash, the chain of states (the state after one answer is the state before the next), and that only a
 * complete answer changes the memory.
 *
 * The memory itself is checked by the REFERENCE VERIFIER, the program of the package (§4, execution.verifier): it is
 * given the reference twin of the state before, the question and the trace, and answers the twin after and the
 * operations it read. It is never reimplemented here: one program checks sessions and serves the teacher's memory (§8).
 * ========================================================================== */

/** What the reference is given: the twin before, the question, the trace, and the neural snapshot the answer published
    after - which it must find to be a snapshot of its own store's kind, and the one its twin after corresponds to. */
export interface ReferenceInput { readonly twin_before: Buffer | null; readonly content: unknown; readonly trace: Buffer; readonly circuit: unknown; readonly neural_after: Buffer | null }
/** `neural.checked: false`: the reference could not say whether the snapshot is the same memory as its twin - the
    verification is incomplete, never ok. */
export type ReferenceOutput = { readonly twin_after: Buffer | null; readonly ops: readonly unknown[]; readonly neural?: { readonly ok: boolean; readonly checked?: boolean; readonly why?: string } } | { readonly error: string };

export interface ReferenceVerifier { check(input: ReferenceInput): Promise<ReferenceOutput> }

export interface VerifyReport {
  readonly ok: boolean;
  readonly session: string | null;
  readonly receipts: number;
  /** Answers whose memory the reference verifier rebuilt and matched. */
  readonly memory_checked: number;
  readonly problems: readonly string[];
  /** What could not be checked: a verification with anything here is incomplete, never ok. */
  readonly incomplete: readonly string[];
}

/** A session checked from its ledger file. Without a reference verifier, everything but the memory's content is checked,
    and the report says so: a session is never called verified on its hashes alone. */
export async function verifySession(file: string, store: BlobStore, reference: ReferenceVerifier | null): Promise<VerifyReport> {
  const problems: string[] = [], incomplete: string[] = [];
  let lines;
  try { lines = readLedger(file); } catch (e) { return { ok: false, session: null, receipts: 0, memory_checked: 0, problems: [(e as Error).message], incomplete: [] }; }
  const open = lines.find((l) => l.kind === 'open');
  if (!open) return { ok: false, session: null, receipts: 0, memory_checked: 0, problems: ['the ledger has no open'], incomplete: [] };
  if (lines[0] !== open) problems.push('the ledger does not begin with its open');
  const circuit = (open.package as { execution?: { circuit?: unknown } })?.execution?.circuit ?? null;
  const blob = (id: string | null, what: string): Buffer | null => {
    if (id === null) return null;
    if (!store.intact(id)) { problems.push(what + ': blob ' + id + ' is missing or does not match its hash'); return null; }
    return store.get(id);
  };
  let head = open.state as MemoryState;
  blob(head.neural, 'opening state'); blob(head.twin, 'opening state');
  let receipts = 0, checked = 0, pending: string | null = null;
  for (const l of lines) {
    if (l.kind === 'intent') {
      if (pending) problems.push('intent ' + l.request_id + ' while ' + pending + ' had no receipt');
      if (l.state_before !== stateId(head)) problems.push('intent ' + l.request_id + ' starts from ' + l.state_before + ', the session was at ' + stateId(head));
      pending = String(l.request_id);
      continue;
    }
    if (l.kind !== 'receipt') continue;
    const r = l.receipt as Receipt;
    receipts++;
    const at = 'receipt ' + r.request_id;
    if (pending !== r.request_id) problems.push(at + ' has no intent of its own');
    pending = null;
    if (r.state_before !== stateId(head)) problems.push(at + ' starts from ' + r.state_before + ', the session was at ' + stateId(head));
    if (r.state_after !== stateId(r.after)) problems.push(at + ': its state id does not match its blobs');
    const content = blob(r.content, at + ' content');
    if (content && sha256(stableStringify({ content: JSON.parse(content.toString('utf8')), limits: r.limits.requested ?? {}, seed: r.seed ?? null })) !== r.content_hash)
      problems.push(at + ': its content does not match its hash');
    if (r.terminal !== 'answered' && r.state_after !== r.state_before) problems.push(at + ': ' + r.terminal + ' changed the memory');
    const neuralAfter = blob(r.after.neural, at + ' state after');
    const twinAfter = blob(r.after.twin, at + ' state after');
    const trace = r.trace === null ? null : blob(r.trace, at + ' trace');
    if (r.terminal === 'answered') {
      if (!reference) { /* counted as unchecked below */ }
      else if (!trace || !content) problems.push(at + ': nothing to replay');
      else {
        const out = await reference.check({ twin_before: head.twin === null ? null : store.get(head.twin), content: JSON.parse(content.toString('utf8')), trace, circuit, neural_after: neuralAfter });
        if ('error' in out) problems.push(at + ': the reference verifier refused it: ' + out.error);
        else {
          const want = out.twin_after === null ? null : sha256(out.twin_after);
          if (want !== (r.after.twin ?? null) || (twinAfter !== null) !== (out.twin_after !== null)) problems.push(at + ': the memory after is not what the reference rebuilds');
          if (stableStringify(out.ops) !== stableStringify(r.ops)) problems.push(at + ': its memory operations are not those the reference reads in its trace');
          /* The memory a later question restores is the neural snapshot: a twin that matches says nothing of it. */
          if (!out.neural) incomplete.push(at + ': the reference did not check its neural snapshot');
          else if (out.neural.checked === false) incomplete.push(at + ': its neural snapshot was not shown to be the memory its twin is: ' + (out.neural.why ?? ''));
          else if (!out.neural.ok) problems.push(at + ': its neural snapshot is not the memory its twin is: ' + (out.neural.why ?? 'it does not correspond'));
          checked++;
        }
      }
    }
    head = r.after;
  }
  const answered = lines.filter((l) => l.kind === 'receipt' && (l.receipt as Receipt).terminal === 'answered').length;
  if (!reference && answered) problems.push('no reference verifier: the memory of ' + answered + ' answer(s) is unchecked');
  return { ok: problems.length === 0 && incomplete.length === 0, session: String(open.session_id), receipts, memory_checked: checked, problems, incomplete };
}

/** The reference verifier as a process: the package's own program, given one JSON on stdin, answering one JSON on stdout.
    Its command is the operator's (the interpreter and the verifier materialized from the package); no network is needed. */
export function processReference(command: readonly string[], timeoutMs = 120_000): ReferenceVerifier {
  return {
    check(input) {
      return new Promise((resolve) => {
        const child = spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '', err = '';
        const timer = setTimeout(() => { child.kill(); resolve({ error: 'the verifier took longer than ' + Math.round(timeoutMs / 1000) + ' s' }); }, timeoutMs);
        child.stdout.on('data', (c) => { out += c; });
        child.stderr.on('data', (c) => { err += c; });
        child.on('error', (e) => { clearTimeout(timer); resolve({ error: 'the verifier did not start: ' + e.message }); });
        child.on('close', (code) => {
          clearTimeout(timer);
          try {
            const a = JSON.parse(out.trim().split('\n').pop() ?? '');
            if (a.error) resolve({ error: String(a.error) });
            else resolve({ twin_after: a.twin_after === null ? null : Buffer.from(a.twin_after, 'base64'), ops: a.ops ?? [],
              ...(a.neural ? { neural: { ok: a.neural.ok === true, ...(a.neural.checked === false ? { checked: false } : {}), ...(a.neural.why ? { why: String(a.neural.why) } : {}) } } : {}) });
          } catch { resolve({ error: 'the verifier answered nothing readable (exit ' + code + ')' + (err ? ': ' + err.trim().slice(-400) : '') }); }
        });
        child.stdin.end(JSON.stringify({
          twin_before: input.twin_before === null ? null : input.twin_before.toString('base64'),
          content: input.content, trace: input.trace.toString('utf8'), circuit: input.circuit,
          neural_after: input.neural_after === null ? null : input.neural_after.toString('base64')
        }));
      });
    }
  };
}
