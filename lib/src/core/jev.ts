import { clamp, cloneJson, round } from './hash.ts';
import { ApiError, fetchJson, type FetchLike } from './net.ts';
import type { Judge, JudgeAnswer, JudgeRequest, Rule } from './types.ts';

/* ============================================================================
 * Jev (TypeSafe POST /v1/systemone) as the Judge - System 1.
 *
 * Request:  { model, state, questions: { id: { type, instructions, criteria } } }
 *   state = the MEASURED facts (no coordinates) for value questions, so two states
 *           that measure the same are the same question; the full position only when
 *           a policy question lists concrete actions.
 * Answers:  choice {probabilities, confidence} | score {score, confidence} | noul {noul}
 *   value + choice -> P(rule.option)      value + score -> score / (levels - 1)
 *   value + noul   -> noul                policy + choice -> the distribution
 * A type mismatch fails the call; a missing number is reported as NaN (the composer
 * counts it as a fallback). Nothing is ever invented, and there is no offline Jev.
 * ========================================================================== */

export const JEV_DEFAULT_URL = 'https://api.typesafe.ai/v1/systemone';
export const JEV_EVALUATION_CONTRACT =
  'Judge only the declared measurements. The board coordinates are intentionally absent; System 2 chose O(s).';
/** When the world is perceived through senses: nothing else about it is known to anyone. */
export const JEV_PERCEPTION_CONTRACT =
  'Judge from what is perceived and from the declared measurements only. Nothing else about this world is known: no rules, no names, no strategy.';

export interface JevJudgeOptions {
  readonly url?: string;
  readonly apiKey?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly retries?: number;
  /** Live calls at once (the harness default is 8). */
  readonly concurrency?: number;
  readonly fetch?: FetchLike;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Host-managed concurrency: resolves to a release function (replaces the built-in semaphore). */
  readonly acquire?: (signal?: AbortSignal) => Promise<() => void>;
  /** Every successful response, parsed (host logs: model, usage, parse warnings, unused ids). */
  readonly onResponse?: (info: { request: JudgeRequest; data: unknown; parsed: ParsedAnswers; latencyMs: number }) => void;
}

export interface JevStats {
  calls: number;
  errors: number;
  peakActive: number;
  latenciesMs: number[];
}

export interface ParsedAnswers {
  readonly answers: Record<string, JudgeAnswer>;
  readonly warnings: string[];
  readonly unusedIds: string[];
}

export function pickNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function confidenceOf(answer: Record<string, unknown>): number | null {
  const c = pickNumber(answer.confidence);
  return c === null ? null : round(clamp(c, 0, 1), 4);
}

/** The option a value choice rule reads: the declared one, else its first criterion. */
export function valueOption(rule: Rule): string | undefined {
  if (rule.option) return rule.option;
  return Array.isArray(rule.criteria) ? undefined : Object.keys(rule.criteria || {})[0];
}

export function parseJevAnswers(data: unknown, questions: Readonly<Record<string, Rule>>): ParsedAnswers {
  const map = data && typeof data === 'object' ? (data as { answers?: unknown }).answers : null;
  if (!map || typeof map !== 'object') throw new ApiError('parse', 'Jev response carries no answers map');
  const raw = map as Record<string, Record<string, unknown> | undefined>;
  const answers: Record<string, JudgeAnswer> = {};
  const warnings: string[] = [];
  for (const id of Object.keys(questions)) {
    const rule = questions[id];
    const answer = raw[id];
    if (!answer) { warnings.push('question `' + id + '` was not answered'); continue; }
    if (answer.type !== rule.type) {
      throw new ApiError('parse', 'question `' + id + '` is declared as a ' + rule.type + ' but was answered as a ' + String(answer.type));
    }
    const confidence = confidenceOf(answer);
    if (rule.type === 'choice') {
      const probabilities = answer.probabilities && typeof answer.probabilities === 'object' ? answer.probabilities as Record<string, unknown> : null;
      if (!probabilities) throw new ApiError('parse', 'choice `' + id + '` reported no probabilities map');
      if (rule.used_as === 'policy') {
        const distribution: Record<string, number> = {};
        for (const key of Object.keys(probabilities)) {
          const p = pickNumber(probabilities[key]);
          if (p !== null) distribution[key] = clamp(p, 0, 1);
        }
        const keys = Object.keys(distribution);
        if (!keys.length) { warnings.push('policy `' + id + '` returned no usable probabilities'); continue; }
        answers[id] = { value: Math.max(...keys.map((k) => distribution[k])), confidence, distribution, raw: answer };
        continue;
      }
      const option = valueOption(rule);
      const p = option === undefined ? null : pickNumber(probabilities[option]);
      if (p === null) warnings.push('choice `' + id + '` reported no "' + String(option) + '" probability');
      answers[id] = { value: p === null ? NaN : clamp(p, 0, 1), confidence, raw: answer };
      continue;
    }
    if (rule.type === 'score') {
      const levels = Array.isArray(rule.criteria) ? rule.criteria.length : 0;
      const score = pickNumber(answer.score);
      if (score === null) warnings.push('score `' + id + '` reported no value');
      answers[id] = { value: score === null ? NaN : clamp(score / Math.max(1, levels - 1), 0, 1), confidence, raw: answer };
      continue;
    }
    const noul = pickNumber(answer.noul);
    if (noul === null) warnings.push('noul `' + id + '` reported no value');
    answers[id] = { value: noul === null ? NaN : clamp(noul, 0, 1), confidence: null, raw: answer };
  }
  const unusedIds = Object.keys(raw).filter((id) => !(id in questions));
  return { answers, warnings, unusedIds };
}

/** The confidence of one evaluation, exactly as the harness reads it: the first value-choice answer
    that reports one (declaration order), else the first score answer. Noul carries none. */
export function evaluationConfidence(answers: Readonly<Record<string, JudgeAnswer>>, rules: Readonly<Record<string, Rule>>): number | null {
  let choice: number | null = null;
  let other: number | null = null;
  for (const id of Object.keys(rules)) {
    const rule = rules[id];
    const a = answers[id];
    if (!a || rule.used_as === 'policy') continue;
    if (rule.type === 'choice' && choice === null) choice = a.confidence;
    else if (rule.type === 'score' && other === null) other = a.confidence;
  }
  return choice ?? other;
}

export function jevWireQuestions(questions: Readonly<Record<string, Rule>>): Record<string, { type: string; instructions: string; criteria: unknown }> {
  const out: Record<string, { type: string; instructions: string; criteria: unknown }> = {};
  for (const id of Object.keys(questions)) {
    const q = questions[id];
    out[id] = { type: q.used_as === 'policy' ? 'choice' : q.type, instructions: q.instructions, criteria: cloneJson(q.criteria) };
  }
  return out;
}

export function jevWireState(request: JudgeRequest): Record<string, unknown> {
  const ctx = request.context ?? {};
  const errors = request.measurementErrors && request.measurementErrors.length ? { measurement_errors: request.measurementErrors.slice() } : {};
  if (request.position) {
    return { ...request.position, measurements: { ...request.measurements }, ...errors };
  }
  if (request.percepts && Object.keys(request.percepts).length) {
    return {
      evaluation_contract: JEV_PERCEPTION_CONTRACT,
      perception: { ...request.percepts },
      measurements: { ...request.measurements },
      side_to_move: request.sideToMove,
      ...(ctx.opponent !== undefined ? { opponent: ctx.opponent } : {}),
      judgment_formula_hash: ctx.judgment_hash ?? null,
      ...errors
    };
  }
  const wire: Record<string, unknown> = {
    rules_of_the_game: request.rulesOfTheWorld,
    evaluation_contract: JEV_EVALUATION_CONTRACT,
    measurements: { ...request.measurements },
    side_to_move: request.sideToMove,
    opponent: ctx.opponent ?? null,
    rules_engine_says: 'the game is in progress',
    judgment_formula_hash: ctx.judgment_hash ?? null,
    ...errors
  };
  return wire;
}

export class JevJudge implements Judge {
  readonly id: string;
  readonly stats: JevStats = { calls: 0, errors: 0, peakActive: 0, latenciesMs: [] };
  private readonly options: JevJudgeOptions;
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(options: JevJudgeOptions = {}) {
    this.options = options;
    this.id = 'jev:' + (options.model ?? 'jev-latest');
  }

  private async acquire(signal?: AbortSignal): Promise<void> {
    const limit = Math.max(1, this.options.concurrency ?? 8);
    while (this.active >= limit) await new Promise<void>((resolve) => this.waiters.push(resolve));
    if (signal?.aborted) throw new ApiError('aborted', 'Aborted while queued for a Jev slot.');
    this.active++;
    this.stats.peakActive = Math.max(this.stats.peakActive, this.active);
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    this.waiters.shift()?.();
  }

  async judge(request: JudgeRequest, signal?: AbortSignal): Promise<Record<string, JudgeAnswer>> {
    let release: () => void = () => this.release();
    if (this.options.acquire) release = await this.options.acquire(signal);
    else await this.acquire(signal);
    this.stats.calls++;
    try {
      const response = await fetchJson(this.options.url ?? JEV_DEFAULT_URL, {
        body: { state: jevWireState(request), model: this.options.model ?? 'jev-latest', questions: jevWireQuestions(request.questions) },
        headers: this.options.apiKey ? { Authorization: 'Bearer ' + this.options.apiKey } : {},
        timeoutMs: this.options.timeoutMs ?? 20000,
        retries: this.options.retries ?? 2,
        signal: signal ?? null,
        fetch: this.options.fetch,
        sleep: this.options.sleep
      });
      this.stats.latenciesMs.push(response.latencyMs);
      const parsed = parseJevAnswers(response.data, request.questions);
      this.options.onResponse?.({ request, data: response.data, parsed, latencyMs: response.latencyMs });
      return parsed.answers;
    } catch (error) {
      this.stats.errors++;
      throw error;
    } finally {
      release();
    }
  }
}
