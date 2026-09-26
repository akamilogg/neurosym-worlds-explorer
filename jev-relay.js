/* ============================================================================
 * jev-relay.js - local development relay for the TypeSafe (Jev) API
 * ----------------------------------------------------------------------------
 * WHY THIS EXISTS: api.typesafe.ai answers the CORS preflight with
 * "400 Disallowed CORS origin" for every origin outside its allow-list, so a web
 * page cannot call POST /v1/systemone directly (the browser kills the request at
 * the OPTIONS stage and the JS only sees "Failed to fetch"). This relay listens
 * on loopback, keeps the API key on the SERVER side, honours the vendor contract
 * 1:1 and makes the call for the page. It can also serve the harness itself, so
 * the page and the API share one origin and CORS disappears completely.
 *
 * Node stdlib only - no dependencies.
 *
 * Usage (PowerShell):
 *   $env:TYPESAFE_API_KEY='sk-...'; node jev-relay.js
 * Usage (bash):
 *   export TYPESAFE_API_KEY='sk-...'; node jev-relay.js
 * Offline proof of this file:
 *   node jev-relay.js --selftest
 *
 * Routes:
 *   OPTIONS *                  -> 204 + CORS headers (the page never talks to istio)
 *   POST    /api/jev           -> forwards {model, state, questions} to the upstream
 *   GET     /health            -> relay status, no Jev call
 *   GET     /                  -> the harness, served from this origin
 *   GET     /fox-hounds-harness.html
 *   GET     /favicon.ico       -> 204
 * ========================================================================== */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  host: '127.0.0.1',                                          // loopback: never exposed by default
  port: 8787,
  upstream: 'https://api.typesafe.ai/v1/systemone',
  timeoutMs: 30000,
  maxBodyBytes: 1048576,                                      // 1 MiB
  maxResponseBytes: 2097152,                                  // 2 MiB
  allowOrigin: '*',                                           // no cookies are used, so * is legal
  apiKey: '',                                                  // placeholder: set TYPESAFE_API_KEY in the environment
  defaultModel: '',                                           // used only when the client omits `model`
  fetchImpl: null,
  log: null
};
const STATIC_FILES = {
  '/': 'fox-hounds-harness.html',
  '/fox-hounds-harness.html': 'fox-hounds-harness.html',
  '/favicon.ico': null                                        // 204, no body
};
const RELAY_API_PATH = '/api/jev';

class RelayError extends Error {
  constructor(status, errorType, message) {
    super(message);
    this.status = status;
    this.errorType = errorType;
  }
}
function numberOf(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function readEnvConfig(env) {
  const source = env || process.env;
  return {
    host: source.JEV_RELAY_HOST || DEFAULTS.host,
    port: numberOf(source.JEV_RELAY_PORT, DEFAULTS.port),
    upstream: source.JEV_UPSTREAM || DEFAULTS.upstream,
    timeoutMs: numberOf(source.JEV_TIMEOUT_MS, DEFAULTS.timeoutMs),
    maxBodyBytes: numberOf(source.JEV_MAX_BODY_BYTES, DEFAULTS.maxBodyBytes),
    allowOrigin: source.JEV_ALLOW_ORIGIN || DEFAULTS.allowOrigin,
    apiKey: source.TYPESAFE_API_KEY || DEFAULTS.apiKey,
    defaultModel: source.JEV_MODEL || ''
  };
}
/* The key is never logged and never echoed: only this fingerprint is. */
function maskKey(key) {
  if (!key) return null;
  return key.length <= 8 ? 'set (' + key.length + ' chars)' : key.slice(0, 3) + '...' + key.slice(-4);
}
function corsHeaders(cfg) {
  return {
    'Access-Control-Allow-Origin': cfg.allowOrigin,
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
    'Access-Control-Expose-Headers': 'x-relay-ms, x-upstream-status'
  };
}
function sendJson(res, status, payload, headers) {
  const body = JSON.stringify(payload);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  }, headers || {}));
  res.end(body);
}
/* Mirrors the vendor error shape so the harness logs relay and upstream failures alike. */
function sendRelayError(res, status, errorType, message, headers) {
  sendJson(res, status, { detail: { error_type: errorType, message: message } }, headers);
}
/* Reads the body under a size cap. Once the cap is passed, the rest of the stream is
   drained (up to a hard cap) so the client receives a clean 413 instead of a reset; a
   body beyond the hard cap gets the socket closed. */
function readBody(req, maxBytes) {
  const hardCap = maxBytes * 4;
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let size = 0;
    let overflow = false;
    let settled = false;
    const fail = function (error) { if (!settled) { settled = true; reject(error); } };
    const tooLarge = function () { return new RelayError(413, 'request_too_large', 'Request body exceeds ' + maxBytes + ' bytes.'); };
    req.on('data', function (chunk) {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        overflow = true;
        if (size > hardCap) {
          fail(tooLarge());
          req.destroy();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', function () {
      if (settled) return;
      if (overflow) { fail(tooLarge()); return; }
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', function (error) { fail(error); });
  });
}
/* --- Upstream call --------------------------------------------------------- */
/* Fast, local validation of the vendor contract: a malformed body fails here in
   microseconds instead of costing a remote round trip (and a confusing 422). Every
   other field the client sent is forwarded untouched. */
function validateRelayBody(raw, cfg) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RelayError(400, 'invalid_body', 'Body must be a JSON object.');
  }
  const body = Object.assign({}, raw);
  if (!body.model && cfg.defaultModel) body.model = cfg.defaultModel;
  if (typeof body.model !== 'string' || !body.model.trim()) {
    throw new RelayError(400, 'missing_model', 'Body must carry fetchable `model` (or set JEV_MODEL on the relay).');
  }
  if (!body.state || typeof body.state !== 'object') {
    throw new RelayError(400, 'missing_state', 'Body must carry `state`.');
  }
  if (!body.questions || typeof body.questions !== 'object') {
    throw new RelayError(400, 'missing_questions', 'Body must carry a `questions` object.');
  }
  return body;
}
/* Aborts on relay timeout OR when the browser gives up, so a cancelled search does
   not keep paying for Jev calls nobody will read. */
async function callUpstream(cfg, body, clientSignal) {
  const controller = new AbortController();
  const onClientAbort = function () { controller.abort(); };
  if (clientSignal) clientSignal.addEventListener('abort', onClientAbort);
  const timer = setTimeout(function () { controller.abort(); }, cfg.timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await cfg.fetchImpl(cfg.upstream, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: 'Bearer ' + cfg.apiKey
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await response.text();
    if (Buffer.byteLength(text) > cfg.maxResponseBytes) {
      throw new RelayError(502, 'upstream_too_large', 'Upstream response exceeded ' + cfg.maxResponseBytes + ' bytes.');
    }
    return { status: response.status, statusText: response.statusText || '', text: text, elapsedMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
    if (clientSignal) clientSignal.removeEventListener('abort', onClientAbort);
  }
}
function sizeLabel(bytes) {
  return bytes < 1024 ? bytes + 'B' : (bytes / 1024).toFixed(1) + 'kB';
}
function logLine(logger, fields) {
  const parts = [new Date().toISOString(), fields.method, fields.route, String(fields.status)];
  if (Number.isFinite(fields.elapsedMs)) parts.push(fields.elapsedMs + 'ms');
  if (fields.model) parts.push('model=' + fields.model);
  if (Number.isFinite(fields.bodyBytes)) parts.push('body=' + sizeLabel(fields.bodyBytes));
  if (fields.note) parts.push(fields.note);
  logger(parts.join('  '));
}
/* --- Request handlers ------------------------------------------------------ */
function createClientAbort(res) {
  const controller = new AbortController();
  res.on('close', function () {
    if (!res.writableEnded) controller.abort();          // the page navigated away / pressed Reset
  });
  return controller;
}
async function handleRelayPost(req, res, cfg, logger) {
  const cors = corsHeaders(cfg);
  const startedAt = Date.now();
  const clientAbort = createClientAbort(res);
  try {
    const raw = await readBody(req, cfg.maxBodyBytes);
    const bodyBytes = Buffer.byteLength(raw);
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new RelayError(400, 'invalid_json', 'Request body is not valid JSON.');
    }
    const body = validateRelayBody(parsed, cfg);
    const upstream = await callUpstream(cfg, body, clientAbort.signal);
    logLine(logger, {
      method: 'POST', route: RELAY_API_PATH, status: upstream.status, elapsedMs: Date.now() - startedAt,
      model: body.model, bodyBytes: bodyBytes, note: 'upstream ' + upstream.elapsedMs + 'ms'
    });
    res.writeHead(upstream.status, Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(upstream.text),
      'Cache-Control': 'no-store',
      'x-upstream-status': String(upstream.status),
      'x-relay-ms': String(upstream.elapsedMs)
    }, cors));
    res.end(upstream.text);
  } catch (error) {
    if (clientAbort.signal.aborted) {
      logLine(logger, { method: 'POST', route: RELAY_API_PATH, status: 499, elapsedMs: Date.now() - startedAt, note: 'client gone -> upstream aborted' });
      return;
    }
    const isRelay = error instanceof RelayError;
    const timedOut = !isRelay && error && error.name === 'AbortError';
    const status = isRelay ? error.status : (timedOut ? 504 : 502);
    const errorType = isRelay ? error.errorType : (timedOut ? 'upstream_timeout' : 'upstream_unreachable');
    const message = isRelay ? error.message
      : (timedOut ? 'Upstream did not answer within ' + cfg.timeoutMs + ' ms.'
        : 'Cannot reach ' + cfg.upstream + ': ' + ((error && error.message) || 'unknown error'));
    logLine(logger, { method: 'POST', route: RELAY_API_PATH, status: status, elapsedMs: Date.now() - startedAt, note: errorType });
    sendRelayError(res, status, errorType, message, cors);
  }
}
function handleHealth(res, cfg) {
  sendJson(res, 200, {
    ok: true,
    upstream: cfg.upstream,
    keyPresent: !!cfg.apiKey,
    key: maskKey(cfg.apiKey),
    model: cfg.defaultModel || null,
    timeoutMs: cfg.timeoutMs
  }, corsHeaders(cfg));
}
const staticCache = new Map();
/* Whitelist only: a path outside STATIC_FILES never touches the disk. */
async function serveStatic(req, res, cfg, logger, pathname) {
  const fileName = STATIC_FILES[pathname];
  if (fileName === undefined) return false;
  const cors = corsHeaders(cfg);
  if (fileName === null) {
    res.writeHead(204, cors);
    res.end();
    return true;
  }
  let file = staticCache.get(fileName);
  if (!file) {
    try {
      file = await fs.promises.readFile(path.join(__dirname, fileName));
      staticCache.set(fileName, file);
    } catch (error) {
      logLine(logger, { method: req.method, route: pathname, status: 404, note: 'missing ' + fileName });
      sendRelayError(res, 404, 'relay_error', 'Cannot read ' + fileName + ' next to the relay.', cors);
      return true;
    }
  }
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': file.length,
    'Cache-Control': 'no-store'
  });
  res.end(req.method === 'HEAD' ? undefined : file);
  return true;
}
async function handleRequest(req, res, cfg, logger) {
  let pathname = '/';
  try {
    pathname = new URL(req.url || '/', 'http://relay.local').pathname;
  } catch (error) {
    sendRelayError(res, 400, 'bad_request', 'Malformed request URL.', corsHeaders(cfg));
    return;
  }
  if (req.method === 'OPTIONS') {                        // the real preflight, answered locally
    res.writeHead(204, corsHeaders(cfg));
    res.end();
    return;
  }
  if (req.method === 'GET' && pathname === '/health') {
    handleHealth(res, cfg);
    return;
  }
  if (pathname === RELAY_API_PATH) {
    if (req.method !== 'POST') {
      res.writeHead(405, Object.assign({ Allow: 'POST, OPTIONS', 'Content-Type': 'application/json; charset=utf-8' }, corsHeaders(cfg)));
      res.end(JSON.stringify({ detail: { error_type: 'method_not_allowed', message: RELAY_API_PATH + ' accepts POST only.' } }));
      return;
    }
    await handleRelayPost(req, res, cfg, logger);
    return;
  }
  if ((req.method === 'GET' || req.method === 'HEAD') && await serveStatic(req, res, cfg, logger, pathname)) return;
  sendRelayError(res, 404, 'not_found', 'No route for ' + req.method + ' ' + pathname, corsHeaders(cfg));
}
function createRelay(options) {
  const cfg = Object.assign({}, DEFAULTS, options || {});
  cfg.fetchImpl = cfg.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const logger = cfg.log || function (line) { console.log(line); };
  if (!cfg.fetchImpl) throw new Error('This relay needs global fetch (Node 18 or newer).');
  const server = http.createServer(function (req, res) {
    handleRequest(req, res, cfg, logger).catch(function (error) {
      if (!res.headersSent) sendRelayError(res, 500, 'relay_error', 'Relay failed: ' + error.message, corsHeaders(cfg));
    });
  });
  server.relayConfig = cfg;                              // exposed so the self-test can inspect it
  return server;
}
function printBanner(cfg) {
  const base = 'http://' + cfg.host + ':' + cfg.port;
  [
    '',
    'Jev relay listening on ' + base,
    '  harness on the same origin (no CORS at all): ' + base + '/fox-hounds-harness.html',
    '  endpoint for the harness field             : ' + base + RELAY_API_PATH,
    '  upstream                                   : ' + cfg.upstream,
    '  API key                                    : ' + maskKey(cfg.apiKey) + ' (server side only)',
    '  CORS                                       : ' + cfg.allowOrigin,
    ''
  ].forEach(function (line) { console.log(line); });
}
function printHelp() {
  [
    'jev-relay.js - local relay for POST /v1/systemone (api.typesafe.ai)',
    '',
    'Environment:',
    '  TYPESAFE_API_KEY   required, stays on this machine',
    '  JEV_RELAY_PORT     default 8787        JEV_RELAY_HOST  default 127.0.0.1',
    '  JEV_UPSTREAM       default https://api.typesafe.ai/v1/systemone',
    '  JEV_TIMEOUT_MS     default 30000       JEV_ALLOW_ORIGIN default *',
    '  JEV_MAX_BODY_BYTES default 1048576     JEV_MODEL      optional fallback model',
    '',
    'Flags: --selftest (offline proof of this file), --help'
  ].forEach(function (line) { console.log(line); });
}
async function main(argv) {
  const args = argv || [];
  if (args.indexOf('--help') >= 0) {
    printHelp();
    return 0;
  }
  if (args.indexOf('--selftest') >= 0) return runSelfTest();
  const cfg = readEnvConfig();
  if (!cfg.apiKey) {
    console.error("Missing TYPESAFE_API_KEY. Set it first, e.g. $env:TYPESAFE_API_KEY='sk-...'  (PowerShell)");
    return 1;
  }
  const server = createRelay(cfg);
  try {
    await new Promise(function (resolve, reject) {
      server.once('error', reject);
      server.listen(cfg.port, cfg.host, resolve);
    });
  } catch (error) {
    console.error(error && error.code === 'EADDRINUSE'
      ? 'Port ' + cfg.port + ' is already in use - set JEV_RELAY_PORT to another port.'
      : 'Cannot listen on ' + cfg.host + ':' + cfg.port + ' - ' + (error && error.message));
    return 1;
  }
  printBanner(cfg);
  const shutdown = function () { server.close(function () { process.exit(0); }); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return 0;
}
if (require.main === module) {
  main(process.argv.slice(2))
    .then(function (code) { process.exitCode = code; })
    .catch(function (error) {
      console.error('relay fatal: ' + (error && error.stack ? error.stack : error));
      process.exitCode = 1;
    });
}
/* --- Offline self-test (node jev-relay.js --selftest) ---------------------- */
function fakeResponse(status, text) {
  return {
    status: status,
    statusText: status === 200 ? 'OK' : 'Error',
    text: function () { return Promise.resolve(text); }
  };
}
const SAMPLE_ANSWERS = {
  model: 'jev-1.13.0',
  answers: {
    outcome: { type: 'choice', choice: 'cats_win', probabilities: { cats_win: 0.72, mouse_win: 0.26, draw: 0.02 }, confidence: 0.9 },
    cat_advantage: { type: 'score', score: 3, legend: { 0: 'worst' }, probabilities: { 0: 0.1 }, confidence: 0.8 },
    trap: { type: 'noul', noul: 0.4 },
    blocked: { type: 'noul', noul: 0.3 }
  },
  usage: { input_tokens: 420, output_tokens: 14 }
};
/* Stands in for the vendor: records the calls, so the test can prove what left the box. */
function createUpstreamStub() {
  const state = { mode: 'ok', calls: [], lastSignal: null };
  const fetchImpl = function (url, init) {
    state.calls.push({ url: url, headers: init.headers || {}, body: JSON.parse(init.body) });
    state.lastSignal = init.signal;
    if (state.mode === 'network') return Promise.reject(new TypeError('fetch failed'));
    if (state.mode === 'hang') {
      return new Promise(function (resolve, reject) {
        init.signal.addEventListener('abort', function () {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    }
    if (state.mode === 'http-422') {
      return Promise.resolve(fakeResponse(422, JSON.stringify({ detail: [{ loc: ['body', 'model'], msg: 'field required' }] })));
    }
    return Promise.resolve(fakeResponse(200, JSON.stringify(SAMPLE_ANSWERS)));
  };
  return { fetchImpl: fetchImpl, state: state };
}
function request(port, method, pathname, options) {
  const opts = options || {};
  return new Promise(function (resolve, reject) {
    const req = http.request({
      host: '127.0.0.1', port: port, method: method, path: pathname,
      headers: Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {})
    }, function (res) {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', function (chunk) { text += chunk; });
      res.on('end', function () { resolve({ status: res.statusCode, headers: res.headers, body: text }); });
    });
    req.on('error', reject);
    if (opts.body !== undefined) req.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    req.end();
    if (opts.abortAfterMs) setTimeout(function () { req.destroy(); }, opts.abortAfterMs);
  });
}
async function runSelfTest() {
  const checks = [];
  const check = function (name, pass, detail) {
    checks.push({ name: name, pass: !!pass, detail: detail === undefined ? '' : String(detail) });
  };
  const logs = [];
  const stub = createUpstreamStub();
  const apiKey = 'test-key-abcdef123456';
  const server = createRelay({
    port: 0, apiKey: apiKey, fetchImpl: stub.fetchImpl, timeoutMs: 400, maxBodyBytes: 2048,
    log: function (line) { logs.push(line); }
  });
  await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  const payload = {
    model: 'jev-latest',
    state: { board_ascii: 'x' },
    questions: { q: { type: 'noul', instructions: 'i', criteria: { true: 'y', false: 'n' } } }
  };
  try {
    /* The browser's preflight never reaches istio-envoy any more. */
    const pre = await request(port, 'OPTIONS', '/api/jev', {
      headers: { Origin: 'http://localhost:8080', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' }
    });
    check('the preflight is answered locally with 204', pre.status === 204, pre.status);
    check('the preflight allows any origin, POST and the Authorization header',
      pre.headers['access-control-allow-origin'] === '*' &&
      /POST/.test(pre.headers['access-control-allow-methods'] || '') &&
      /authorization/i.test(pre.headers['access-control-allow-headers'] || ''),
      pre.headers['access-control-allow-origin'] + ' ' + pre.headers['access-control-allow-headers']);

    const health = await request(port, 'GET', '/health', {});
    const healthBody = JSON.parse(health.body);
    check('health reports the upstream and that a key is loaded',
      health.status === 200 && healthBody.keyPresent === true && healthBody.upstream.indexOf('api.typesafe.ai') > 0);
    check('health never echoes the key', healthBody.key !== apiKey && health.body.indexOf(apiKey) < 0, healthBody.key);

    const page = await request(port, 'GET', '/', {});
    check('the harness is served from the relay origin',
      page.status === 200 && /text\/html/.test(page.headers['content-type'] || '') && page.body.indexOf('<html') >= 0, page.status);
    const notWhitelisted = await request(port, 'GET', '/index.html', {});
    const traversal = await request(port, 'GET', '/..%2findex.html', {});
    check('the static whitelist refuses everything else',
      notWhitelisted.status === 404 && traversal.status === 404, notWhitelisted.status + '/' + traversal.status);

    const ok = await request(port, 'POST', '/api/jev', { body: payload });
    check('a valid leaf is forwarded and the vendor body returned verbatim',
      ok.status === 200 && JSON.parse(ok.body).answers.outcome.probabilities.cats_win === 0.72, ok.status);
    check('the relay injects the API key server-side',
      stub.state.calls[0].headers.Authorization === 'Bearer ' + apiKey);
    check('the vendor contract crosses untouched (model, state, questions)',
      stub.state.calls[0].body.model === payload.model &&
      JSON.stringify(stub.state.calls[0].body.state) === JSON.stringify(payload.state) &&
      stub.state.calls[0].body.questions.q.type === 'noul');
    check('the relay reports upstream status and latency',
      ok.headers['x-upstream-status'] === '200' && Number.isFinite(Number(ok.headers['x-relay-ms'])),
      ok.headers['x-upstream-status'] + ' / ' + ok.headers['x-relay-ms'] + 'ms');

    stub.state.mode = 'http-422';
    const rejected = await request(port, 'POST', '/api/jev', { body: payload });
    check('a vendor 422 is passed through byte for byte',
      rejected.status === 422 && JSON.parse(rejected.body).detail[0].loc[1] === 'model', rejected.status);
    stub.state.mode = 'ok';
/* Local validation: fail fast, never relay garbage to the vendor. */
    const callsBefore = stub.state.calls.length;
    const badJson = await request(port, 'POST', '/api/jev', { body: '{ not json' });
    const noModel = await request(port, 'POST', '/api/jev', { body: { state: {}, questions: {} } });
    const noState = await request(port, 'POST', '/api/jev', { body: { model: 'jev-latest', questions: {} } });
    const noQuestions = await request(port, 'POST', '/api/jev', { body: { model: 'jev-latest', state: {} } });
    check('malformed bodies are refused without touching the vendor',
      badJson.status === 400 && noModel.status === 400 && noState.status === 400 && noQuestions.status === 400 &&
      stub.state.calls.length === callsBefore,
      badJson.status + '/' + noModel.status + '/' + noState.status + '/' + noQuestions.status);
    check('the refusal names the offending field',
      JSON.parse(noModel.body).detail.message.indexOf('model') > 0, JSON.parse(noModel.body).detail.error_type);
    const tooBig = await request(port, 'POST', '/api/jev', { body: '{"model":"jev-latest","pad":"' + 'x'.repeat(4096) + '"}' });
    check('an oversized body is rejected with 413', tooBig.status === 413, tooBig.status);
    const wrongMethod = await request(port, 'GET', '/api/jev', {});
    check('only POST is accepted on the relay endpoint', wrongMethod.status === 405, wrongMethod.status);
    const noRoute = await request(port, 'GET', '/nope', {});
    check('unknown routes answer 404', noRoute.status === 404, noRoute.status);

    /* Upstream failures become explicit relay errors the page can log. */
    stub.state.mode = 'network';
    const unreachable = await request(port, 'POST', '/api/jev', { body: payload });
    check('an unreachable upstream becomes a 502 relay error',
      unreachable.status === 502 && JSON.parse(unreachable.body).detail.error_type === 'upstream_unreachable', unreachable.status);
    stub.state.mode = 'hang';
    const timedOut = await request(port, 'POST', '/api/jev', { body: payload });
    check('a hanging upstream becomes a 504 after the relay timeout',
      timedOut.status === 504 && JSON.parse(timedOut.body).detail.error_type === 'upstream_timeout', timedOut.status);
    const abandoned = await request(port, 'POST', '/api/jev', { body: payload, abortAfterMs: 80 })
      .catch(function () { return { status: 0 }; });
    await new Promise(function (resolve) { setTimeout(resolve, 150); });
    check('a browser that gives up aborts the upstream call',
      abandoned.status === 0 && !!stub.state.lastSignal && stub.state.lastSignal.aborted === true,
      abandoned.status + ' / aborted=' + (stub.state.lastSignal ? stub.state.lastSignal.aborted : 'no signal'));

    check('no log line ever contains the API key',
      logs.every(function (line) { return line.indexOf(apiKey) < 0; }), logs.length + ' lines');
    check('every relayed call is logged with status and latency',
      logs.some(function (line) { return line.indexOf('POST  /api/jev  200') >= 0; }), logs[0] || 'no lines');
  } finally {
    await new Promise(function (resolve) { server.close(resolve); });
  }
  checks.forEach(function (item) {
    console.log((item.pass ? 'OK   ' : 'FAIL ') + 'relay: ' + item.name + (item.detail ? ' [' + item.detail + ']' : ''));
  });
  const failed = checks.filter(function (item) { return !item.pass; });
  console.log('');
  console.log(failed.length
    ? 'RELAY SELF-TEST FAILED (' + failed.length + '/' + checks.length + ')'
    : 'RELAY SELF-TEST PASSED (' + checks.length + ' checks)');
  return failed.length ? 1 : 0;
}