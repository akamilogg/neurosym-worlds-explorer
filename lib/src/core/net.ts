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
  const start = text.indexOf('{');
  if (start < 0) return null;
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
    else if (ch === '}' && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
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
      let text = '';
      try { text = await response.text(); } catch { text = ''; }
      if (!response.ok) {
        throw new ApiError('http', 'HTTP ' + response.status + ' ' + (response.statusText ?? ''), {
          status: response.status,
          retryable: response.status === 408 || response.status === 429 || response.status >= 500,
          retryAfterMs: readRetryAfter(response.headers),
          body: text.slice(0, 400)
        });
      }
      const data = parseJsonLoose(text);
      if (data === null) throw new ApiError('parse', 'Response body was not valid JSON.', { body: text.slice(0, 400) });
      return { data, status: response.status, latencyMs: Math.round(clock() - startedAt), attempts: attempt + 1 };
    } catch (raw) {
      let error: ApiError;
      if (raw instanceof ApiError) error = raw;
      else if (raw && (raw as Error).name === 'AbortError') {
        error = external?.aborted ? new ApiError('aborted', 'Request aborted by the caller.') : new ApiError('timeout', 'Request aborted after ' + timeoutMs + ' ms.');
      } else error = new ApiError('network', (raw as Error)?.message || 'Network request failed (URL, CORS, connectivity).');
      /* A network-level failure (typically a CORS preflight) is not retried: no retry can fix it. */
      const retryable = error.kind === 'timeout' || (error.kind === 'http' && error.details?.retryable === true);
      if (error.kind === 'aborted' || !retryable || attempt >= retries) throw error;
      const asked = error.details?.retryAfterMs;
      await sleep(typeof asked === 'number' ? asked : backoffMs * Math.pow(2, attempt));
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    }
  }
}
