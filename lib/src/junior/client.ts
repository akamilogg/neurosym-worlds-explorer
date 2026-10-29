import type { ChatClient } from '../learn/system2.ts';
import type { Receipt, SessionInfo, Limits } from './sessions.ts';

/* ============================================================================
 * The harness's side of a junior's session (SPEC-METAPOLITICA-APRENDIZAJE §5): the session adapter, and a ChatClient
 * over it so a laboratory talks to the junior as to any researcher.
 *
 * Each question of the ChatClient is the next request of its session, `<session>:<n>`, asked from the state the session
 * is at. Cut off, the client asks for the receipt before anything: a published one is the answer; a pending one is waited
 * for; only one the server never heard of is asked again - with the same id, so it is never run twice.
 *
 * A failure of the infrastructure (cancelled, infra_failed) reaches the laboratory as a failure of its provider, never as
 * an answer of the junior; a limit reached is an answer, its prefix measured as it is (§5.1).
 * ========================================================================== */

export class JuniorHttpError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, code: string | null, message: string) { super(message); this.status = status; this.code = code; }
}

type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;

export class JuniorSessionClient {
  readonly url: string;
  private readonly fetch: Fetch;
  constructor(url: string, o: { fetch?: Fetch } = {}) { this.url = url.replace(/\/$/, ''); this.fetch = o.fetch ?? (globalThis.fetch as unknown as Fetch); }

  private async call<T>(method: string, route: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const r = await this.fetch(this.url + route, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(signal ? { signal } : {}) });
    const b = await r.json() as Record<string, unknown>;
    if (r.status !== 200) throw new JuniorHttpError(r.status, typeof b.code === 'string' ? b.code : null, String(b.error ?? 'HTTP ' + r.status));
    return b as T;
  }

  open(o: { run_id: string; pkg: unknown; session_id?: string; state?: unknown; origin?: unknown; continues?: { session_id: string } }): Promise<SessionInfo> { return this.call('POST', '/sessions', o); }
  info(id: string): Promise<SessionInfo> { return this.call('GET', '/sessions/' + encodeURIComponent(id)); }
  restore(id: string): Promise<{ head_id: string; last_receipt: string | null }> { return this.call('POST', '/sessions/' + encodeURIComponent(id) + '/restore', {}); }
  receipt(id: string, request: string): Promise<{ state: 'published'; receipt: Receipt } | { state: 'pending' } | { state: 'unknown' }> {
    return this.call('GET', '/sessions/' + encodeURIComponent(id) + '/receipts/' + encodeURIComponent(request));
  }
  close(id: string): Promise<SessionInfo> { return this.call('POST', '/sessions/' + encodeURIComponent(id) + '/close', {}); }
  cancel(id: string, request_id: string): Promise<{ receipt: Receipt | null }> { return this.call('POST', '/sessions/' + encodeURIComponent(id) + '/cancel', { request_id }); }

  /** Asks once and, cut off, recovers by the receipt: never a blind second run. */
  async ask(id: string, q: { request_id: string; content: unknown; expected: string; limits?: Partial<Limits>; seed?: number | null }, o: { signal?: AbortSignal; pollMs?: number; attempts?: number } = {}): Promise<Receipt> {
    const attempts = o.attempts ?? 5;
    for (let i = 0; ; i++) {
      try { return await this.call<Receipt>('POST', '/sessions/' + encodeURIComponent(id) + '/ask', q, o.signal); } catch (e) {
        if (e instanceof JuniorHttpError || o.signal?.aborted || i + 1 >= attempts) throw e;
      }
      // The connection failed: what does the server know of it?
      for (;;) {
        let r;
        try { r = await this.receipt(id, q.request_id); } catch (e) { if (o.signal?.aborted || i + 1 >= attempts) throw e; break; }
        if (r.state === 'published') return r.receipt;
        if (r.state === 'unknown') break;
        await new Promise((res) => setTimeout(res, o.pollMs ?? 1000));
      }
    }
  }
}

/** A ChatClient over a junior's session: the junior as System 2 of a laboratory. The session must exist; its next request
    number is read from it, so a laboratory resumed asks on from where it stopped. */
export function juniorChat(o: { client: JuniorSessionClient; session_id: string; limits?: Partial<Limits>; seed?: number | null; onReceipt?: (r: Receipt) => void }): ChatClient {
  let next: number | null = null;
  return {
    configuration: { junior_session: o.session_id },
    async complete({ system, user, signal }) {
      const started = Date.now();
      const info = await o.client.info(o.session_id);
      if (info.pending) throw new Error('the junior session has a question pending (' + info.pending + '): resolve it first');
      if (next === null) next = info.receipts;
      const { head_id } = await o.client.restore(o.session_id);
      const request_id = o.session_id + ':' + next;
      const r = await o.client.ask(o.session_id, { request_id, content: { system, user }, expected: head_id, ...(o.limits ? { limits: o.limits } : {}), ...(o.seed !== undefined ? { seed: o.seed } : {}) }, signal ? { signal } : {});
      next++;
      o.onReceipt?.(r);
      if (r.terminal === 'cancelled' || r.terminal === 'infra_failed') throw new Error('the junior did not answer (' + r.terminal + '): ' + (r.reason ?? ''));
      return { content: r.text, latencyMs: Date.now() - started, raw: { receipt: r.request_id, terminal: r.terminal, state_after: r.state_after, served: r.served } };
    }
  };
}
