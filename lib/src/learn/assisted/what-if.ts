import { parseJsonLoose } from '../../core/net.ts';
import type { ChatClient } from '../system2.ts';

/* ============================================================================
 * «WHAT IF…?» (SPEC-Y-SI §2-§4, PLAN-Y-SI Entrega 2): a primitive to open a direction of research. The researcher - either of
 * its two hemispheres - sums up its own course and asks for
 *   a TURN   {"what_if": {"mode": "turn", "situation": "...", "question": "...", "refs": ["model:r4", ...]}}
 *            one relation or assumption that would open a direction, or
 *   a FORK   {"what_if": {"mode": "fork", ...}}
 *            two explanations incompatible in an explicit premise, and what would tell them apart -
 * from an isolated call to System 2 (the same model, with nothing but what the researcher gave it: its situation, its
 * question, and the items of its own memory it named). The answer is a suggestion, never evidence: no verdict depends on it,
 * nothing is run because of it, and what to do with it is the researcher's. It costs an investigation step and one of its
 * calls of `what_if`; its tokens are its own. Its request is logged BEFORE the call (an answer that never came is known to
 * have been asked), its answer after.
 * ========================================================================== */

/** The version of the proposer's instruction (in the journal's configuration: a change of it is another condition). */
export const WHAT_IF_INSTRUCTION_VERSION = 1;

/** How much of its memory it may hand the proposer at once: more is refused, never cut (SPEC-Y-SI §3). */
export const WHAT_IF_CONTEXT_CHARS = 24000;

const PROPOSER = (mode: 'turn' | 'fork'): string => [
  'A researcher, investigating something nobody has described to it, asks you for a NEW DIRECTION. It tells you its situation in its own words, and may add a question and items of its record.',
  'You do not solve its problem, write code, or plan its research: you open a direction it may follow. You may draw on other domains when that brings a difference that matters.',
  mode === 'turn'
    ? 'Give ONE TURN: a relation, assumption or way of seeing that differs from the course it describes, in a sentence or two, as "What if ...?". Answer {"idea": "What if ...?"}.'
    : 'Give a FORK: two explanations, "a" and "b", INCOMPATIBLE in one explicit premise - not two wordings of the same idea - and "difference": what it could observe or try that would tell them apart (without designing the whole experiment). They are provisional: neither has to be right, and both may fail. Answer {"a": "...", "b": "...", "difference": "..."}.',
  'If you find no direction you could defend, say so: {"no_direction": "why, briefly"}.',
  'Answer with ONE JSON object and nothing else.'
].join('\n');

/** What the researcher is told of the tool, in its system (from its first question, under the capability `what_if`). */
export const WHAT_IF_SECTION = [
  'WHAT IF...? When you see your own course - adjusting details without understanding more, an explanation that needs too many untested pieces, the same error coming back - or simply when you want another angle, you may ask for a new DIRECTION, inside "investigate":',
  '  {"what_if": {"mode": "turn" | "fork", "situation": "your own reading of where your research stands and why", "question": "optional: what you want opened", "refs": ["optional: ids of items of your memory, e.g. model:r4, investigation:r4.2, note:<id>"]}}',
  '  "turn" gives you one "idea" - a different relation or assumption; "fork" gives you two explanations "a" and "b", incompatible in a premise, and a "difference" that would tell them apart; "no_direction" says none was found.',
  'It is answered by a fresh mind with nothing but what you give it: write the situation well, and name the items it needs. The answer is a SUGGESTION, never evidence: develop it, reformulate it, test it with your instruments, or leave it. Learning when it helps is part of your method - write it down in your methods. Each costs an investigation step and one of your calls of `what_if` (`what_if_left`).'
].join('\n');

export interface WhatIfRequest { readonly mode: 'turn' | 'fork'; readonly situation: string; readonly question?: string; readonly refs: readonly string[] }

/** A request as written - or why it is not one. */
export function parseWhatIf(q: Record<string, unknown>): WhatIfRequest | string {
  const w = q.what_if && typeof q.what_if === 'object' && !Array.isArray(q.what_if) ? q.what_if as Record<string, unknown> : null;
  if (!w) return '"what_if": { "mode", "situation", "question", "refs" }';
  if (w.mode !== 'turn' && w.mode !== 'fork') return '"mode" is "turn" or "fork"';
  const situation = typeof w.situation === 'string' ? w.situation.trim() : '';
  if (!situation) return '"situation": your own reading of where your research stands - the proposer knows nothing else';
  if (w.question !== undefined && typeof w.question !== 'string') return '"question" is a text';
  if (w.refs !== undefined && (!Array.isArray(w.refs) || !w.refs.every((r) => typeof r === 'string'))) return '"refs": ids of items of your memory';
  const refs = [...new Set(((w.refs ?? []) as string[]).map((r) => r.trim()).filter(Boolean))];
  if (refs.length > 8) return 'at most 8 "refs": choose the items the proposer needs';
  return { mode: w.mode, situation, ...(typeof w.question === 'string' && w.question.trim() ? { question: w.question.trim() } : {}), refs };
}

/** The proposer's answer, read - or why it is none of the forms asked. */
export function readAnswer(mode: 'turn' | 'fork', content: string): Record<string, string> | string {
  const o = parseJsonLoose(content) as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return 'not a JSON object';
  const text = (k: string) => (typeof o[k] === 'string' && (o[k] as string).trim() ? (o[k] as string).trim() : null);
  if (text('no_direction')) return { no_direction: text('no_direction')! };
  if (mode === 'turn') return text('idea') ? { idea: text('idea')! } : 'a turn answers {"idea": "What if ...?"}';
  return text('a') && text('b') && text('difference') ? { a: text('a')!, b: text('b')!, difference: text('difference')! } : 'a fork answers {"a", "b", "difference"}';
}

export interface WhatIfOptions {
  /** System 2, for an isolated call: the same model, none of the researcher's conversation. */
  readonly llm: ChatClient;
  /** Which hemisphere asks: its ids say so, and the other sees them. */
  readonly who: 'junior' | 'senior';
  /** Calls of `what_if` in the run. */
  readonly max: number;
  /** The items of its memory, opened whole - or the ids that are not there. */
  resolve(refs: readonly string[]): Promise<{ items: readonly Record<string, unknown>[] } | { missing: readonly string[] }>;
  log(type: string, data: Record<string, unknown>): void;
  /** Told of each request, as it is made (the other hemisphere's channel). */
  onRequested?(entry: { id: string; by: string; mode: string; situation: string }): void;
  /** The calls already made (a senior's, kept in its state from one call to the next). */
  readonly used?: number;
  /** Told of each answer of the proposer, raw (its usage, where the caller counts it). */
  onAnswer?(answer: { readonly raw?: unknown }): void;
  /** Why not to call now (a budget spent, a stop) - asked before each call; null: go on. */
  halt?(): string | null;
  /** The id of the next request, when the caller keeps the count (a senior, from one of its calls to the next). */
  nextId?(round: number): string;
}

/** What the senior is told of the tool, in its system (SPEC-Y-SI §8.3): the same primitive, from its own reading. */
export const SENIOR_WHAT_IF_SECTION = 'WHAT IF...? You may ask, among your readings, for a new direction for the research: {"what_if": {"mode": "turn" | "fork", "situation": "your reading of where the research stands", "question": "optional", "refs": ["ids of the junior\'s record or of yours"]}} - answered by a fresh mind with nothing but what you give it ("idea"; or "a", "b" and a "difference"; or "no_direction"). It is a suggestion, never evidence: what reaches the junior is what you make of it, in your own message. The junior is told that you asked, and what; it sees its own requests too. Each costs one of your readings and one of the calls of `what_if` (`what_if_left`).';

export class WhatIf {
  private readonly o: WhatIfOptions;
  private used: number;
  private readonly perRound = new Map<number, number>();

  constructor(o: WhatIfOptions) { this.o = o; this.used = o.used ?? 0; }

  static accepts(q: Record<string, unknown>): boolean { return q !== null && typeof q === 'object' && 'what_if' in q; }

  left(): number { return Math.max(0, this.o.max - this.used); }
  calls(): number { return this.used; }

  async run(q: Record<string, unknown>, round: number): Promise<Record<string, unknown>> {
    const req = parseWhatIf(q);
    if (typeof req === 'string') return { what_if: q.what_if ?? null, error: req };
    if (this.left() <= 0) return { what_if: { mode: req.mode }, error: 'no calls of what_if left in this run (' + this.o.max + ')', what_if_left: 0 };
    /* Only what it named, whole: an item missing, or more than the proposer can take, is refused - never cut. */
    const resolved = req.refs.length ? await this.o.resolve(req.refs) : { items: [] };
    if ('missing' in resolved) return { what_if: { mode: req.mode, refs: req.refs }, error: 'not in your memory: ' + resolved.missing.join(', '), what_if_left: this.left() };
    const context = { mode: req.mode, situation: req.situation, ...(req.question ? { question: req.question } : {}), ...(resolved.items.length ? { items: resolved.items } : {}) };
    const size = JSON.stringify(context).length;
    if (size > WHAT_IF_CONTEXT_CHARS) return { what_if: { mode: req.mode, refs: req.refs }, error: 'too much for the proposer (' + size + ' characters, at most ' + WHAT_IF_CONTEXT_CHARS + '): name fewer or smaller items', what_if_left: this.left() };
    const stop = this.o.halt?.() ?? null;
    if (stop) return { what_if: { mode: req.mode }, error: 'not asked: ' + stop, what_if_left: this.left() };
    const k = (this.perRound.get(round) ?? 0) + 1;
    this.perRound.set(round, k);
    const id = this.o.nextId ? this.o.nextId(round) : 'what_if:' + this.o.who + ':r' + round + '.' + k;
    this.used++;
    /* Asked: logged before the call, so that a call whose answer never came is known to have been made. */
    this.o.log('what_if_requested', { id, by: this.o.who, round, mode: req.mode, situation: req.situation, ...(req.question ? { question: req.question } : {}), refs: req.refs, instruction_version: WHAT_IF_INSTRUCTION_VERSION });
    this.o.onRequested?.({ id, by: this.o.who, mode: req.mode, situation: req.situation });
    let content = '';
    try { const a = await this.o.llm.complete({ system: PROPOSER(req.mode), user: context }); this.o.onAnswer?.(a as { raw?: unknown }); content = a.content; }
    catch (e) {
      const error = 'the proposer did not answer: ' + String((e as Error)?.message ?? e).slice(0, 200);
      this.o.log('what_if', { id, by: this.o.who, round, error });
      return { id, mode: req.mode, error, what_if_left: this.left() };
    }
    const answer = readAnswer(req.mode, content);
    if (typeof answer === 'string') {
      this.o.log('what_if', { id, by: this.o.who, round, error: 'its answer is none of the forms asked: ' + answer, content: content.slice(0, 2000) });
      return { id, mode: req.mode, error: 'the proposer answered in none of the forms asked; nothing to develop from it', what_if_left: this.left() };
    }
    this.o.log('what_if', { id, by: this.o.who, round, mode: req.mode, answer });
    return { id, mode: req.mode, ...answer, generated: 'a suggestion, never evidence: what to do with it is yours', what_if_left: this.left() };
  }
}
