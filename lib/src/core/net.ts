/* ============================================================================
 * Network core, ported from the harness: every call is timeout-bounded, retried with
 * exponential backoff (honouring Retry-After) only when retrying can help (timeouts,
 * 408/429/5xx), and every failure is CLASSIFIED - never swallowed.
 * `fetch` and `sleep` are injectable so tests and non-browser hosts need no globals.
 * ========================================================================== */

export type ApiErrorKind = 'timeout' | 'http' | 'parse' | 'network' | 'aborted';

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly details: { status?: number; retryable?: boolean; retryAfterMs?: number | null; body?: string } | null;
  constructor(kind: ApiErrorKind, message: string, details?: ApiError['details']) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.details = details ?? null;
  }
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; statusText?: string; text(): Promise<string>; headers?: { get(name: string): string | null } }>;

export interface FetchJsonOptions {
  readonly method?: string;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  readonly timeoutMs?: number;
  readonly retries?: number;
  readonly backoffMs?: number;
  /** Retry network-level failures too. Off by default: in a browser they are usually CORS, which no retry fixes;
      a long unattended run on a server host wants them retried (a dropped connection is transient there). */
  readonly retryNetwork?: boolean;
  readonly signal?: AbortSignal | null;
  readonly fetch?: FetchLike;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface FetchJsonResult {
  readonly data: unknown;
  readonly status: number;
  readonly latencyMs: number;
  readonly attempts: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const clock = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Retry-After (RFC 9110): seconds or an HTTP date, capped at 30 s. */
function readRetryAfter(headers?: { get(name: string): string | null }): number | null {
  const raw = headers && typeof headers.get === 'function' ? headers.get('retry-after') : null;
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30000);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.max(0, Math.min(at - Date.now(), 30000));
}

/** LLM/vendor-tolerant JSON: the body, or the first balanced object inside it. */
export function parseJsonLoose(text: string): unknown {
  if (typeof text !== 'string' || !text.trim()) return null;
  try { return JSON.parse(text); } catch { /* fall through */ }
  /* A reasoning model's thinking (<think>...</think>, <thinking>...</thinking>) is not its answer, even when it drafts JSON
     there: it is left out; an unclosed one (the answer was cut) leaves nothing. A code fence around the answer too. */
  const answer = text.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '').replace(/<(think|thinking|reasoning)>[\s\S]*$/i, '').replace(/```(?:json)?/gi, '');
  if (answer !== text) {
    if (!answer.trim()) return null;
    try { return JSON.parse(answer.trim()); } catch { /* fall through */ }
    text = answer;
  }
  /* The first balanced {...} that parses: prose before the object may hold braces of its own (e.g. LaTeX "x^{-2}"). */
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    const end = balancedEnd(text, start);
    if (end < 0) continue;
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* try the next brace */ }
  }
  return null;
}

/** Where the object opened at `start` closes (strings skipped), or -1. */
function balancedEnd(text: string, start: number): number {
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

export async function fetchJson(url: string, options: FetchJsonOptions = {}): Promise<FetchJsonResult> {
  const doFetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  if (typeof doFetch !== 'function') throw new ApiError('network', 'no fetch implementation in this host');
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? 15000;
  const retries = options.retries ?? 0;
  const backoffMs = options.backoffMs ?? 500;
  const external = options.signal ?? null;
  const startedAt = clock();
  for (let attempt = 0; ; attempt++) {
    if (external?.aborted) throw new ApiError('aborted', 'Request aborted by the caller.');
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    external?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(url, {
        method: options.method ?? 'POST',
        headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
        body: options.body === undefined || options.body === null ? undefined : JSON.stringify(options.body),
        signal: controller.signal
      });
      /* The body can arrive long after the headers (OpenRouter answers 200 at once and sends keep-alive
         comments while the model works). A body cut by OUR timeout is a timeout - retryable - never an
         empty string later misreported as "not valid JSON". */
      let text: string;
      try {
        text = await response.text();
      } catch (readError) {
        if (controller.signal.aborted) {
          throw external?.aborted ? new ApiError('aborted', 'Request aborted by the caller.')
            : new ApiError('timeout', 'The response body did not finish within ' + timeoutMs + ' ms (the headers had arrived: HTTP ' + response.status + ').');
        }
        throw new ApiError('network', 'The response body could not be read: ' + ((readError as Error)?.message || String(readError)));
      }
      const contentType = response.headers && typeof response.headers.get === 'function' ? response.headers.get('content-type') : null;
      if (response.ok && !text.trim()) {
        throw new ApiError('http', 'Empty response body (HTTP ' + response.status + (contentType ? ', ' + contentType : '') + ')',
          { status: response.status, retryable: true, retryAfterMs: null, body: '' });
      }
      if (!response.ok) {
        throw new ApiError('http', 'HTTP ' + response.status + ' ' + (response.statusText ?? ''), {
          status: response.status,
          retryable: response.status === 408 || response.status === 429 || response.status >= 500,
          retryAfterMs: readRetryAfter(response.headers),
          body: text.slice(0, 400)
        });
      }
      const data = parseJsonLoose(text);
      if (data === null) {
        throw new ApiError('parse', 'Response body was not valid JSON (HTTP ' + response.status + (contentType ? ', ' + contentType : '') +
          ', ' + text.length + ' chars).', { status: response.status, body: text.slice(0, 400) });
      }
      return { data, status: response.status, latencyMs: Math.round(clock() - startedAt), attempts: attempt + 1 };
    } catch (raw) {
      let error: ApiError;
      if (raw instanceof ApiError) error = raw;
      else if (raw && (raw as Error).name === 'AbortError') {
        error = external?.aborted ? new ApiError('aborted', 'Request aborted by the caller.') : new ApiError('timeout', 'Request aborted after ' + timeoutMs + ' ms.');
      } else error = new ApiError('network', (raw as Error)?.message || 'Network request failed (URL, CORS, connectivity).');
      /* A network-level failure (typically a CORS preflight) is not retried unless the host asks: no retry fixes CORS. */
      const retryable = error.kind === 'timeout' || (error.kind === 'http' && error.details?.retryable === true) || (error.kind === 'network' && options.retryNetwork === true);
      if (error.kind === 'aborted' || !retryable || attempt >= retries) throw error;
      const asked = error.details?.retryAfterMs;
      await sleep(typeof asked === 'number' ? asked : backoffMs * Math.pow(2, attempt));
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    }
  }
}
