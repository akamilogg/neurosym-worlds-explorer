import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { stableStringify } from '../../core/hash.ts';

/* ============================================================================
 * What the investigator is shown of a junior's answers (SPEC-METAPOLITICA-APRENDIZAJE §7.2).
 *
 * Read from records the evaluation already wrote — a trial's journal and its replay, a probe's line — never by asking
 * the junior again. The text is cut (the first and last N characters, and only a window of answers) so a run that
 * looped does not fill the investigator's context. It is not a point of the model: the check still predicts the value
 * from what is known before the answer.
 * ========================================================================== */

/** Characters kept from each end of an answer. An answer that fits in twice this is kept whole. */
export const EXCERPT_CHARS = 160;
/** Answers returned with a run and with `view` of its episode: the first half and the last, when there are more. */
export const ANSWERS_WITH_RUN = 4;
/** Answers `view_trial` returns for one case. Still a window, still cut. */
export const ANSWERS_ON_DEMAND = 12;

/** The session id of a probe, as probes.ts names it (`p-` and the first 24 hex of the same hash). */
export function probeSessionId(manifestHash: string, execution: string, caseId: string, rep: number): string {
  return 'p-' + createHash('sha256').update(stableStringify([manifestHash, execution, caseId, rep])).digest('hex').slice(0, 24);
}

/** Native tool-call syntax, as Qwenputer writes it (`<tool_call>`, `<function=`), not the JSON the harness parses. */
export function nativeToolCall(text: string): boolean {
  return /<tool_call\b|<function=/i.test(text);
}

/** The first and last `n` characters. `tail` is null when the whole text was kept. */
export function excerptOf(text: string, n = EXCERPT_CHARS): { chars: number; head: string; tail: string | null } {
  if (text.length <= n * 2) return { chars: text.length, head: text, tail: null };
  return { chars: text.length, head: text.slice(0, n), tail: text.slice(-n) };
}

const ACCEPTED = new Set(['investigation', 'proposal', 'reflection', 'round_closed', 'consolidated']);
const ANSWER_TYPES = new Set([...ACCEPTED, 'investigation_refused', 'proposal_refused', 'reflection_refused']);

export interface AnswerReading {
  readonly protocol_ok: boolean | null;
  readonly requests_well_formed: boolean | null;
  readonly investigation: boolean;
  readonly proposal: boolean;
}

/** What the harness logged of one answer. Null where no event was logged for it: the text is still shown, the reading is not invented. */
export function readingOf(ev: Record<string, unknown> | null): AnswerReading {
  if (!ev) return { protocol_ok: null, requests_well_formed: null, investigation: false, proposal: false };
  const type = String(ev.type ?? '');
  const investigation = type === 'investigation';
  const proposal = type === 'proposal';
  let requests_well_formed: boolean | null = null;
  if (investigation) {
    const results = Array.isArray(ev.results) ? ev.results : [];
    const warnings = Array.isArray(ev.warnings) ? ev.warnings : [];
    const requests = Array.isArray(ev.requests) ? ev.requests : [];
    const errored = results.some((x) => x && typeof x === 'object' && 'error' in (x as object) && (x as { error?: unknown }).error);
    const ignored = warnings.some((w) => /ignored/.test(String(w)));
    requests_well_formed = requests.length > 0 && !errored && !ignored;
  } else if (type === 'proposal_refused' || type === 'investigation_refused' || type === 'reflection_refused') requests_well_formed = false;
  return { protocol_ok: ACCEPTED.has(type), requests_well_formed, investigation, proposal };
}

/** One probe is one answer. Its reaction may be several events; any of them that the harness accepted counts. */
export function readingOfReaction(events: readonly Record<string, unknown>[]): AnswerReading {
  let protocol_ok = false, investigation = false, proposal = false, requests_well_formed = false, saw = false;
  for (const ev of events) {
    if (!ANSWER_TYPES.has(String(ev.type ?? ''))) continue;
    const r = readingOf(ev);
    if (r.protocol_ok) protocol_ok = true;
    if (r.investigation) { investigation = true; saw = true; if (r.requests_well_formed) requests_well_formed = true; }
    if (r.proposal) proposal = true;
  }
  return { protocol_ok, requests_well_formed: saw ? requests_well_formed : (protocol_ok ? null : false), investigation, proposal };
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

/** The journal events that are one answer of System 2, in order. A call that failed (`proposal_failed`) is not one. */
export function journalAnswers(journalFile: string): Record<string, unknown>[] {
  if (!fs.existsSync(journalFile)) return [];
  let events: Record<string, unknown>[] = [];
  try { events = (JSON.parse(fs.readFileSync(journalFile, 'utf8')).events ?? []) as Record<string, unknown>[]; } catch { return []; }
  return events.filter((e) => ANSWER_TYPES.has(String(e.type ?? '')));
}

export interface AnswerView {
  readonly n: number;
  readonly protocol_ok: boolean | null;
  readonly requests_well_formed: boolean | null;
  readonly investigation: boolean;
  readonly proposal: boolean;
  readonly native_tool_call: boolean;
  readonly memory_ops: number | null;
  readonly tokens: number | null;
  readonly circuit_tokens: number | null;
  readonly ms: number | null;
  readonly terminal: string | null;
  readonly chars: number;
  readonly head: string;
  readonly tail: string | null;
}

export interface CaseBehavior {
  readonly case: string;
  readonly kind: 'investigation' | 'probe';
  readonly rep: number;
  readonly questions: number;
  readonly protocol_ok: number;
  readonly requests_well_formed: number;
  readonly investigations: number;
  readonly proposals: number;
  readonly native_tool_call: number;
  readonly tokens: number | null;
  readonly circuit_tokens: number | null;
  readonly ms: number | null;
  /** False when the journal and the replay do not have the same number of answers: a reading without an event is null. */
  readonly aligned: boolean;
  readonly answers: readonly AnswerView[];
  /** Answers not included in `answers` (the middle of a long run). */
  readonly omitted: number;
  readonly note?: string;
}

export interface RawAnswer {
  readonly reading: AnswerReading;
  readonly text: string;
  readonly tokens: number | null;
  readonly circuit_tokens: number | null;
  readonly ms: number | null;
  readonly memory_ops: number | null;
  readonly terminal: string | null;
}

/** The first half of the window and the last, so a loop at the end is visible and the start is too. */
export function windowOf<T>(xs: readonly T[], limit: number): { shown: T[]; omitted: number; indexes: number[] } {
  if (xs.length <= limit) return { shown: [...xs], omitted: 0, indexes: xs.map((_, i) => i) };
  const head = Math.ceil(limit / 2);
  const tail = limit - head;
  const indexes = [...xs.slice(0, head).map((_, i) => i), ...xs.slice(-tail).map((_, i) => xs.length - tail + i)];
  return { shown: indexes.map((i) => xs[i]), omitted: xs.length - limit, indexes };
}

const sumNum = (xs: readonly (number | null)[]): number | null => (xs.every((x) => x === null) ? null : xs.reduce<number>((a, b) => a + (b ?? 0), 0));

/** One case, as the investigator reads it: the counts over every answer, the text of only the window. */
export function caseBehavior(o: { case: string; kind: 'investigation' | 'probe'; rep: number; answers: readonly RawAnswer[]; aligned: boolean; limit: number; note?: string }): CaseBehavior {
  const view = (a: RawAnswer, n: number): AnswerView => {
    const ex = excerptOf(a.text);
    return { n, ...a.reading, native_tool_call: nativeToolCall(a.text), memory_ops: a.memory_ops, tokens: a.tokens, circuit_tokens: a.circuit_tokens,
      ms: a.ms, terminal: a.terminal, chars: ex.chars, head: ex.head, tail: ex.tail };
  };
  const w = windowOf(o.answers, o.limit);
  const known = (f: (a: RawAnswer) => boolean | null): number => o.answers.filter((a) => f(a) === true).length;
  return {
    case: o.case, kind: o.kind, rep: o.rep, questions: o.answers.length,
    protocol_ok: known((a) => a.reading.protocol_ok), requests_well_formed: known((a) => a.reading.requests_well_formed),
    investigations: known((a) => a.reading.investigation), proposals: known((a) => a.reading.proposal),
    native_tool_call: o.answers.filter((a) => nativeToolCall(a.text)).length,
    tokens: sumNum(o.answers.map((a) => a.tokens)), circuit_tokens: sumNum(o.answers.map((a) => a.circuit_tokens)), ms: sumNum(o.answers.map((a) => a.ms)),
    aligned: o.aligned, answers: w.indexes.map((i) => view(o.answers[i], i)), omitted: w.omitted, ...(o.note ? { note: o.note } : {})
  };
}

/** Counts only: what an index may carry. The excerpts stay in the episode the investigator opens. */
export function behaviorTally(cases: readonly CaseBehavior[]): { cases: number; questions: number; protocol_ok: number; requests_well_formed: number; investigations: number; proposals: number; native_tool_call: number } {
  const s = (f: (c: CaseBehavior) => number) => cases.reduce((a, c) => a + f(c), 0);
  return { cases: cases.length, questions: s((c) => c.questions), protocol_ok: s((c) => c.protocol_ok), requests_well_formed: s((c) => c.requests_well_formed),
    investigations: s((c) => c.investigations), proposals: s((c) => c.proposals), native_tool_call: s((c) => c.native_tool_call) };
}

/** Pair a journal's answers with the replay's texts. The longer side is kept; the missing reading is null, not guessed. */
export function pairTrial(events: readonly Record<string, unknown>[], texts: readonly { text: string; tokens: number | null; circuit_tokens: number | null }[]): { answers: RawAnswer[]; aligned: boolean } {
  const n = Math.max(events.length, texts.length);
  const answers: RawAnswer[] = [];
  for (let i = 0; i < n; i++) {
    const t = texts[i];
    answers.push({ reading: readingOf(events[i] ?? null), text: t?.text ?? '', tokens: t?.tokens ?? null, circuit_tokens: t?.circuit_tokens ?? null, ms: null, memory_ops: null, terminal: null });
  }
  return { answers, aligned: events.length === texts.length };
}
