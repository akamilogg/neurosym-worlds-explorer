import { clamp } from '../core/hash.ts';
import { ApiError, fetchJson, parseJsonLoose, type FetchLike } from '../core/net.ts';
import type { FormulaDiff } from './diff.ts';

/* ============================================================================
 * System 2 as a client, and the consensus judge built on it.
 *
 * System 2 is an LLM behind an OpenAI-compatible chat-completions endpoint. It only
 * ever returns TEXT: every proposal crosses the learner's gates, and every vote is
 * parsed into a closed vocabulary (apply | reject | narrow) or discarded.
 *
 * J3 consensus: N independent requests, a declared quorum, and a BLINDED payload -
 * the proposer's rationale never travels, so a judge cannot agree with a story it
 * was told. It runs only when the measured judges (J1/J2) are silent, and a
 * consultation without a usable vote is NOT an approval.
 * ========================================================================== */

export interface ChatAnswer {
  readonly content: string;
  readonly latencyMs: number;
  readonly raw: unknown;
}

export interface ChatClient {
  complete(request: { system: string; user: unknown; signal?: AbortSignal | null }): Promise<ChatAnswer>;
}

export interface ChatClientOptions {
  readonly url: string;
  readonly apiKey?: string;
  readonly model: string;
  readonly temperature?: number;
  /** Ask for response_format json_object. */
  readonly jsonMode?: boolean;
  readonly timeoutMs?: number;
  readonly retries?: number;
  readonly fetch?: FetchLike;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Every request, counted before it can fail (a failed call is a call). */
  readonly onRequest?: () => void;
  readonly onAnswer?: (answer: ChatAnswer) => void;
}

const clock = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** The request body exactly as the harness sends it. */
export function chatRequestBody(options: Pick<ChatClientOptions, 'model' | 'temperature' | 'jsonMode'>, system: string, user: unknown): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: options.model,
    temperature: clamp(options.temperature ?? 0.3, 0, 2),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify(user, null, 2) }
    ]
  };
  if (options.jsonMode) body.response_format = { type: 'json_object' };
  return body;
}

export function openAiChatClient(options: ChatClientOptions | (() => ChatClientOptions)): ChatClient {
  const read = typeof options === 'function' ? options : () => options;
  return {
    async complete({ system, user, signal }) {
      const o = read();
      o.onRequest?.();
      if (!o.url) throw new ApiError('network', 'No LLM endpoint configured.');
      const started = clock();
      const response = await fetchJson(o.url, {
        body: chatRequestBody(o, system, user),
        headers: o.apiKey ? { Authorization: 'Bearer ' + o.apiKey } : {},
        timeoutMs: o.timeoutMs ?? 30000,
        retries: o.retries ?? 1,
        signal: signal ?? null,
        fetch: o.fetch,
        sleep: o.sleep
      });
      const data = response.data as { choices?: Array<{ message?: { content?: string } }> } | null;
      const content = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : null;
      if (!content) throw new ApiError('parse', 'LLM response contained no choices[0].message.content.');
      const answer = { content, latencyMs: Math.round(clock() - started), raw: response.data };
      o.onAnswer?.(answer);
      return answer;
    }
  };
}

/* --- J3: consensus ------------------------------------------------------------------ */

export const JUDGE_CONSENSUS = 'consensus' as const;
export const CONSENSUS_VOTES = 3;
export const CONSENSUS_QUORUM = 2;

export interface Vote {
  readonly decision: 'apply' | 'reject' | 'narrow' | null;
  readonly kinds: string[];
  readonly reason: string;
}

/** A vote in the closed vocabulary, or decision null with the reason it was unusable. */
export function parseVote(content: string): Vote {
  const parsed = parseJsonLoose(content) as { decision?: unknown; kinds?: unknown; reason?: unknown } | null;
  const decision = parsed && typeof parsed.decision === 'string' ? parsed.decision.toLowerCase() : null;
  if (decision !== 'apply' && decision !== 'reject' && decision !== 'narrow') {
    return { decision: null, kinds: [], reason: 'unusable answer: ' + String(content || '').slice(0, 120) };
  }
  const kinds = parsed && Array.isArray(parsed.kinds) ? parsed.kinds.filter((k): k is string => typeof k === 'string') : [];
  return { decision, kinds, reason: String(parsed!.reason || '').slice(0, 300) };
}

export interface ConsensusVerdict {
  readonly decision: 'apply' | 'reject' | 'narrow';
  readonly judge: typeof JUDGE_CONSENSUS;
  readonly votes: { apply: number; reject: number; narrow: number };
  readonly applied_fields: string[];
  readonly diff: FormulaDiff;
  readonly reason: string;
  readonly usable: number;
}

/** The blinded payload a judge reads: the diff and the evidence, never the author's rationale. */
export function consensusPayload(diff: FormulaDiff, evidence: Record<string, unknown>): Record<string, unknown> {
  return {
    task: 'judge_rule_diff',
    instruction: 'Decide whether applying this change is justified by the evidence. The rationale of the system that proposed it is deliberately withheld.',
    proposed_change: { from_version: diff.from_version, to_version: diff.to_version, kinds: diff.kinds, fields: diff.fields, summary: diff.summary },
    evidence,
    acceptance_criterion: 'The games decide in the end: a change you approve is re-measured, and one with mid-game corrections is re-verified cleanly.'
  };
}

/** Independent votes over the same blinded payload. Null when no vote was usable (never an approval).
    A narrow verdict applies only the MEASURABLE kinds the votes named: a judge cannot ask for a field a
    replay cannot check, whatever it says. */
export async function judgeConsensus(diff: FormulaDiff, payload: Record<string, unknown>, options: {
  client: ChatClient; systemPrompt: string; votes?: number; quorum?: number; signal?: AbortSignal | null;
  describeError?: (error: unknown) => string;
}): Promise<ConsensusVerdict | null> {
  const n = options.votes ?? CONSENSUS_VOTES;
  const quorum = options.quorum ?? CONSENSUS_QUORUM;
  const votes = { apply: 0, reject: 0, narrow: 0 };
  const votedKinds: Record<string, number> = {};
  const reasons: string[] = [];
  let usable = 0;
  for (let i = 0; i < n; i++) {
    try {
      const answer = await options.client.complete({ system: options.systemPrompt, user: payload, signal: options.signal });
      const vote = parseVote(answer.content);
      if (!vote.decision) { reasons.push('unusable: ' + vote.reason); continue; }
      usable++;
      votes[vote.decision]++;
      for (const kind of vote.kinds) votedKinds[kind] = (votedKinds[kind] || 0) + 1;
      reasons.push(vote.decision + (vote.reason ? ': ' + vote.reason : ''));
    } catch (error) {
      if (error && (error as { kind?: string }).kind === 'aborted') throw error;
      reasons.push('error: ' + (options.describeError ? options.describeError(error) : String((error as Error)?.message || error)));
    }
  }
  if (!usable) return null;
  const decision = votes.apply >= quorum ? 'apply' : (votes.narrow >= quorum ? 'narrow' : 'reject');
  const named = diff.narrowable.filter((kind) => (votedKinds[kind] || 0) >= 1);
  const applied = decision === 'narrow' && named.length ? named
    : (decision === 'narrow' ? diff.narrowable : (decision === 'apply' ? diff.kinds : []));
  return {
    decision, judge: JUDGE_CONSENSUS, votes, applied_fields: applied, diff, usable,
    reason: 'consensus ' + votes.apply + '/' + votes.reject + '/' + votes.narrow + ' over ' + usable +
      ' usable vote(s) (quorum ' + quorum + '/' + n + '): ' + reasons.slice(0, 3).join(' | ')
  };
}
