import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { stableStringify } from '../../core/hash.ts';

/* ============================================================================
 * A junior's answers, raw, as an evaluation already recorded them (SPEC-METAPOLITICA-APRENDIZAJE §7.2).
 *
 * Nothing here decides whether an answer was well formed, a tool call, or a loop. The text is the junior's, cut only
 * when it is longer than ANSWER_TEXT_CAP (the full length stays in `chars`). Counting `<tool_call>` or valid JSON is an
 * instrument the investigator writes (SPEC-INSTRUMENTOS-PROPIOS).
 * ========================================================================== */

/** The most of an answer's text kept on a point. Longer answers keep their first characters; `chars` is the full length. */
export const ANSWER_TEXT_CAP = 4000;

/** The session id of a probe, as probes.ts names it (`p-` and the first 24 hex of the same hash). */
export function probeSessionId(manifestHash: string, execution: string, caseId: string, rep: number): string {
  return 'p-' + createHash('sha256').update(stableStringify([manifestHash, execution, caseId, rep])).digest('hex').slice(0, 24);
}

/** The text an answer carries, and how long it was before the cap. */
export function capText(text: string, cap = ANSWER_TEXT_CAP): { text: string; chars: number } {
  return { text: text.length <= cap ? text : text.slice(0, cap), chars: text.length };
}

/** One answer of the junior, as emitted. No reading of it. */
export interface JuniorAnswer {
  readonly case: string;
  readonly rep: number;
  readonly question: number;
  readonly text: string;
  readonly chars: number;
  readonly terminal: string | null;
  readonly reason: string | null;
  readonly tokens: number | null;
  readonly circuit_tokens: number | null;
  readonly ms: number | null;
  /** The memory operations the receipt listed, in order, or null when the receipt was not read. */
  readonly memory_ops: readonly unknown[] | null;
}

export function answerOf(o: { case: string; rep: number; question: number; text: string; terminal?: string | null; reason?: string | null; tokens?: number | null; circuit_tokens?: number | null; ms?: number | null; memory_ops?: readonly unknown[] | null }): JuniorAnswer {
  const text = capText(o.text);
  return { case: o.case, rep: o.rep, question: o.question, text: text.text, chars: text.chars,
    terminal: o.terminal ?? null, reason: o.reason ?? null, tokens: o.tokens ?? null, circuit_tokens: o.circuit_tokens ?? null, ms: o.ms ?? null,
    memory_ops: o.memory_ops ?? null };
}

/** System 2's answers in a replay log, in order: the message text and the usage the response carried. A failure is not an answer. */
export function llmAnswers(replayFile: string): { text: string; tokens: number | null; circuit_tokens: number | null }[] {
  if (!fs.existsSync(replayFile)) return [];
  const out: { text: string; tokens: number | null; circuit_tokens: number | null }[] = [];
  for (const line of fs.readFileSync(replayFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let e: { channel?: string; text?: string; status?: number; failed?: unknown };
    try { e = JSON.parse(line); } catch { continue; }
    if (e.channel !== 'llm' || e.failed !== undefined || (typeof e.status === 'number' && e.status >= 400)) continue;
    let text = '', tokens: number | null = null, circuit: number | null = null;
    try {
      const body = JSON.parse(String(e.text ?? '')) as { choices?: { message?: { content?: unknown } }[]; usage?: { total_tokens?: number; circuit_tokens?: number } };
      const content = body.choices?.[0]?.message?.content;
      text = typeof content === 'string' ? content : '';
      if (typeof body.usage?.total_tokens === 'number') tokens = body.usage.total_tokens;
      if (typeof body.usage?.circuit_tokens === 'number') circuit = body.usage.circuit_tokens;
    } catch { text = ''; }
    out.push({ text, tokens, circuit_tokens: circuit });
  }
  return out;
}
