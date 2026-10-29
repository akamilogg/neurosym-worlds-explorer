import http from 'node:http';
import { SessionError, type SessionServer } from './sessions.ts';

/* ============================================================================
 * The junior's server over HTTP (SPEC-METAPOLITICA-APRENDIZAJE §5.1), on the junior's machine, for the harness's clients.
 *
 *   POST /sessions                          open {run_id, pkg, session_id?, state?, origin?, continues?}
 *   GET  /sessions/:id                      where it stands (head, receipts, pending, closed)
 *   POST /sessions/:id/ask                  {request_id, content, expected, limits?, seed?} -> its receipt
 *   GET  /sessions/:id/receipts/:request    published | pending | unknown
 *   POST /sessions/:id/restore              the last state published, its blobs checked
 *   POST /sessions/:id/cancel               {request_id}
 *   POST /memory                           one memory operation on a copy of a twin {pkg, twin, call} -> {result, twin}
 *   POST /render                           a memory read as files {pkg, twin} -> {name: text}
 *   POST /sessions/:id/close
 *   POST /sessions/:id/v1/chat/completions   the next question as an OpenAI chat completion (a laboratory's LLM_URL)
 *
 * A refusal answers 409 with its code (request_conflict, stale_state, busy, closed, pending...); 404 an unknown session;
 * 400 a package or state it cannot open. An answer can take minutes: the connection waits for it.
 * ========================================================================== */

const STATUS: Record<string, number> = { no_session: 404, package_open: 400, bad_state: 400, bad_open: 400, origin_missing: 400, unsupported: 400, exists: 409 };

export async function handleJunior(server: SessionServer, method: string, route: string, body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const parts = route.split('/').filter(Boolean).map(decodeURIComponent);
  try {
    if (parts.length === 1 && parts[0] === 'memory' && method === 'POST') return { status: 200, body: await server.memoryCall(body as Parameters<SessionServer['memoryCall']>[0]) };
    if (parts.length === 1 && parts[0] === 'render' && method === 'POST') return { status: 200, body: await server.render(body as Parameters<SessionServer['render']>[0]) };
    if (parts[0] !== 'sessions') return { status: 404, body: { error: 'see the routes of /sessions' } };
    if (parts.length === 1 && method === 'POST') return { status: 200, body: server.open(body as Parameters<SessionServer['open']>[0]) };
    const id = parts[1];
    if (parts.length === 2 && method === 'GET') return { status: 200, body: server.info(id) };
    if (parts.length === 4 && parts[2] === 'receipts' && method === 'GET') return { status: 200, body: server.receipt(id, parts[3]) };
    if (parts.length >= 4 && method === 'POST' && parts.slice(2).join('/').endsWith('chat/completions')) {
      const r = await server.chat(id, body as Parameters<SessionServer['chat']>[1]);
      if (r.terminal === 'cancelled' || r.terminal === 'infra_failed') return { status: 503, body: { error: { message: 'the junior did not answer (' + r.terminal + '): ' + (r.reason ?? ''), receipt: r.request_id } } };
      const u = r.usage;
      return { status: 200, body: {
        id: r.request_id, object: 'chat.completion', model: r.served,
        choices: [{ index: 0, message: { role: 'assistant', content: r.text }, finish_reason: r.terminal === 'limit_reached' ? 'length' : 'stop' }],
        usage: u ? { prompt_tokens: u.prompt_tokens, completion_tokens: u.text_tokens, total_tokens: u.prompt_tokens + u.text_tokens, circuit_tokens: u.circuit_tokens } : undefined,
        junior: { receipt: r.request_id, state_after: r.state_after, terminal: r.terminal }
      } };
    }
    if (parts.length === 3 && method === 'POST') {
      if (parts[2] === 'ask') return { status: 200, body: await server.ask(id, body as Parameters<SessionServer['ask']>[1]) };
      if (parts[2] === 'restore') return { status: 200, body: server.restore(id) };
      if (parts[2] === 'cancel') return { status: 200, body: { receipt: await server.cancel(id, String(body.request_id)) } };
      if (parts[2] === 'close') return { status: 200, body: server.close(id) };
    }
    return { status: 404, body: { error: method + ' ' + route + ' is not a route' } };
  } catch (e) {
    if (e instanceof SessionError) return { status: STATUS[e.code] ?? 409, body: { error: e.message, code: e.code } };
    return { status: 500, body: { error: String((e as Error)?.message ?? e) } };
  }
}

/** Serves a session server on 127.0.0.1 (the junior's machine; the harness's clients run there too). `port` 0: any free port. */
export function serveJunior(server: SessionServer, o: { port?: number; host?: string } = {}): Promise<{ url: string; close(): Promise<void> }> {
  const host = o.host ?? '127.0.0.1';
  const h = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"not JSON"}'); return; }
      void handleJunior(server, req.method ?? 'GET', (req.url ?? '/').split('?')[0], body)
        .then((r) => res.writeHead(r.status, { 'content-type': 'application/json' }).end(JSON.stringify(r.body)));
    });
  });
  h.requestTimeout = 0;
  h.headersTimeout = 0;
  return new Promise((resolve) => {
    h.listen(o.port ?? 0, host, () => {
      const a = h.address() as { port: number };
      resolve({ url: 'http://' + host + ':' + a.port, close: () => new Promise((r) => { h.closeAllConnections(); h.close(() => r()); }) });
    });
  });
}
