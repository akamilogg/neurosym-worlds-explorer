import type { FetchLike } from '../../core/net.ts';

/* ============================================================================
 * SEARCHING THE WEB (SPEC-INVESTIGACION-EXTERNA §5.1, IE1): a provider behind one interface, its answer normalized and kept.
 *
 * A result is a lead: its snippet is not a reading of the document. The order is the provider's; what to read is the
 * researcher's. The first real provider is Brave Web Search over HTTP (no SDK): GET /res/v1/web/search with q, count and
 * offset, the key from WEB_SEARCH_KEY in X-Subscription-Token - never in the URL, never logged.
 * ========================================================================== */

export type Freshness = 'day' | 'week' | 'month' | 'year';

/** source-search@1 as a provider receives it: the query the researcher wrote (nothing else of the run goes out). */
export interface SearchRequest { readonly query: string; readonly limit: number; readonly offset: number; readonly language?: string; readonly freshness?: Freshness }

export interface SearchResult { readonly title: string; readonly url: string; readonly snippet: string; readonly published?: string }

/** What a provider answered: its results in its order, whether there are more, and its raw answer (kept by hash). */
export interface ProviderAnswer {
  readonly state: 'answered' | 'provider_error' | 'unavailable';
  readonly results: readonly SearchResult[];
  readonly more: boolean;
  readonly raw: string | null;
  /** Each HTTP request sent - a unit of `search_calls` each, failed or not. */
  readonly attempts: readonly { readonly status?: number; readonly error?: string; readonly waited_ms?: number }[];
  readonly why?: string;
  /** The key was refused: the capability stops, and the researcher is told. */
  readonly auth_failed?: boolean;
}

export interface SearchProvider {
  readonly id: string;
  /** Its adapter's version and its endpoint, identified (not its key). */
  readonly version: string;
  search(request: SearchRequest, o: { readonly signal?: AbortSignal; readonly maxSends: number }): Promise<ProviderAnswer>;
}

const FRESH: Record<Freshness, string> = { day: 'pd', week: 'pw', month: 'pm', year: 'py' };

export const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

/** Brave Web Search over HTTP. `fetch` is the network's; the key the host's (WEB_SEARCH_KEY), sent as a header only. */
export function braveProvider(o: { readonly fetch: FetchLike; readonly key: string | undefined; readonly endpoint?: string; readonly sleep?: (ms: number) => Promise<void> }): SearchProvider {
  const endpoint = o.endpoint ?? BRAVE_ENDPOINT;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return {
    id: 'brave', version: 'brave-web-search@1 ' + endpoint,
    async search(q, s) {
      if (!o.key) return { state: 'unavailable', results: [], more: false, raw: null, attempts: [], why: 'no key for the search provider in this environment (WEB_SEARCH_KEY)' };
      const params = new URLSearchParams({ q: q.query, count: String(q.limit), offset: String(q.offset) });
      if (q.freshness) params.set('freshness', FRESH[q.freshness]);
      if (q.language) params.set('search_lang', q.language);
      const attempts: { status?: number; error?: string; waited_ms?: number }[] = [];
      for (let k = 0; k < 3; k++) {
        if (attempts.length >= s.maxSends) return { state: 'provider_error', results: [], more: false, raw: null, attempts, why: 'no searches left in the bag (search_calls)' };
        let r: Awaited<ReturnType<FetchLike>>;
        try { r = await o.fetch(endpoint + '?' + params.toString(), { method: 'GET', headers: { Accept: 'application/json', 'X-Subscription-Token': o.key }, signal: s.signal ?? AbortSignal.timeout(30_000) }); }
        catch (e) { attempts.push({ error: String((e as Error)?.message ?? e).slice(0, 200) }); if (k < 2) { await sleep(1000 * (k + 1)); continue; } return { state: 'provider_error', results: [], more: false, raw: null, attempts, why: attempts.at(-1)!.error }; }
        const text = await r.text();
        if (r.status === 401 || r.status === 403) { attempts.push({ status: r.status }); return { state: 'provider_error', results: [], more: false, raw: text.slice(0, 2000), attempts, why: 'the provider refused the key (HTTP ' + r.status + ')', auth_failed: true }; }
        if ((r.status === 429 || r.status >= 500) && k < 2) {
          const after = Number(r.headers?.get('retry-after'));
          const wait = Math.min(Number.isFinite(after) ? after * 1000 : 1000 * (k + 1), 10_000);
          attempts.push({ status: r.status, waited_ms: wait });
          await sleep(wait);
          continue;
        }
        attempts.push({ status: r.status });
        if (!r.ok) return { state: 'provider_error', results: [], more: false, raw: text.slice(0, 2000), attempts, why: 'HTTP ' + r.status };
        let body: { web?: { results?: { title?: string; url?: string; description?: string; page_age?: string }[] }; query?: { more_results_available?: boolean } };
        try { body = JSON.parse(text); } catch { return { state: 'provider_error', results: [], more: false, raw: text.slice(0, 2000), attempts, why: 'the provider\'s answer is not JSON' }; }
        const results = (body.web?.results ?? []).filter((x) => typeof x.url === 'string').map((x) => ({ title: strip(x.title ?? ''), url: x.url!, snippet: strip(x.description ?? ''), ...(x.page_age ? { published: x.page_age } : {}) }));
        return { state: 'answered', results, more: body.query?.more_results_available === true, raw: text, attempts };
      }
      return { state: 'provider_error', results: [], more: false, raw: null, attempts, why: 'the provider did not answer' };
    }
  };
}

const strip = (s: string): string => s.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** A provider of fixed answers, for tests: each query answers its results (or a failure), sliced as asked. */
export function fakeProvider(answers: Readonly<Record<string, readonly SearchResult[] | { readonly fail: string; readonly auth?: boolean }>>): SearchProvider {
  return {
    id: 'fake', version: 'fake@1',
    async search(q, s) {
      if (s.maxSends < 1) return { state: 'provider_error', results: [], more: false, raw: null, attempts: [], why: 'no searches left in the bag (search_calls)' };
      const a = answers[q.query] ?? [];
      if ('fail' in a) return { state: 'provider_error', results: [], more: false, raw: null, attempts: [{ status: a.auth ? 401 : 500 }], why: a.fail, ...(a.auth ? { auth_failed: true } : {}) };
      const all = a as readonly SearchResult[];
      return { state: 'answered', results: all.slice(q.offset, q.offset + q.limit), more: all.length > q.offset + q.limit, raw: JSON.stringify(all), attempts: [{ status: 200 }] };
    }
  };
}
