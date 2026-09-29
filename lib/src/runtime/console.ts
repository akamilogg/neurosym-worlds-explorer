import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { findingText } from '../learn/finding.ts';
import { finding, listRuns, orderOutcome, resumeRun, runStatus, send, startRun, stop, type RunInfo, type RunOrder } from './control.ts';
import { describeEvent } from './cli.ts';
import { LABS } from '../worlds/labs.ts';
import { isGameLab } from '../learn/lab.ts';

/* ============================================================================
 * The CONSOLE (SPEC-INVESTIGADOR-ASISTIDO §8, A3): a local page over the control API, the
 * same for both researchers. It lists the runs, follows one live (its events, its current
 * model, its checks, its beliefs, its cost), stops, resumes and starts runs, shows findings
 * and links the visual synthesis. The collaboration controls (message, focus, source) are
 * there for every run and disabled, with the reason, for the unknown-world researcher.
 *
 * Local only: it listens on 127.0.0.1 and answers only requests addressed to it by that name
 * (a page elsewhere cannot reach it by rebinding a name). The keys never pass through it: a
 * run started or resumed here takes them from the console process's environment.
 * ========================================================================== */

export interface ConsoleOptions {
  /** The repository: runs are in <root>/runs. */
  readonly root: string;
  readonly port?: number;
  /** The environment runs started here get (default: this process's). */
  readonly env?: NodeJS.ProcessEnv;
  /** The visual synthesis of a journal, as a page (scripts/journal-view.ts); without it, no synthesis link. */
  readonly synthesis?: (journal: unknown) => Promise<string>;
}

type Json = Record<string, any>;
const readJson = (file: string): Json | null => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

/** A run by its name, among the runs of the folder: never a path from outside it. */
function runByName(root: string, name: string): RunInfo | null {
  return listRuns(path.join(root, 'runs')).find((r) => r.run === name) ?? null;
}

/** What the page shows of a run: its state, its events from `since` in a line each, and what it holds now. */
export function runView(journal: string, since = 0): Json {
  const status = runStatus(journal);
  const j = readJson(journal) ?? {};
  const events: Json[] = Array.isArray(j.events) ? j.events : [];
  const last = (type: string) => [...events].reverse().find((e) => e.type === type);
  const proposal = last('proposal');
  const check = last('check');
  const end = last('end');
  const notebook = end?.notebook;
  const beliefs = Array.isArray(notebook?.beliefs) ? notebook.beliefs.map((b: Json) => ({ id: b.id, statement: b.statement, status: b.status }))
    : (proposal?.beliefs ?? []).map((b: Json) => ({ id: b.id, statement: b.statement ?? '', status: b.stance }));
  return {
    status,
    config: { argv: j.argv ?? [], researcher_policy: j.researcher_policy ?? null, llm_model: j.config?.llm_model ?? null },
    total: events.length,
    events: events.slice(since).map((e, k) => ({ i: since + k, type: e.type, line: describeEvent(e) })),
    model: proposal ? { round: proposal.round, fingerprint: proposal.fingerprint ?? null, law: proposal.law ?? proposal.formula ?? null } : null,
    check: check ? { round: check.round, accepted: Boolean(check.accepted),
      places: [...(check.laboratories ?? []), ...(check.validation?.family ?? [])].map((p: Json) => ({ place: p.place, holds: Boolean(p.holds) })),
      blind: check.validation?.blind_confirmation ? Boolean(check.validation.blind_confirmation.confirmed) : null } : null,
    beliefs,
    finding: status.state === 'ended' ? { operator: findingText(finding(journal, 'operator')), researcher: findingText(finding(journal, 'researcher')) } : null
  };
}

/** The laboratories one can start, with their options (for the page's form). */
export function labsView(): Json[] {
  return Object.entries(LABS).map(([name, lab]) => ({ name, id: lab.id, about: lab.about, kind: isGameLab(lab) ? 'game' : 'law',
    options: lab.options.map((o) => ({ name: o.name, default: o.default, help: o.help })), flags: (lab.flags ?? []).map((f) => ({ name: f.name, help: f.help })) }));
}

const body = (req: http.IncomingMessage): Promise<Json> => new Promise((ok, fail) => {
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
  req.on('end', () => { try { ok(raw ? JSON.parse(raw) : {}); } catch (e) { fail(e); } });
});

export function serveConsole(options: ConsoleOptions): Promise<{ url: string; close(): Promise<void> }> {
  const root = options.root;
  const server = http.createServer(async (req, res) => {
    const send_ = (status: number, data: unknown, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(typeof data === 'string' ? data : JSON.stringify(data));
    };
    /* Local only: a request addressed to another name is refused (DNS rebinding). */
    const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
    if (host !== '127.0.0.1' && host !== 'localhost') return send_(403, { error: 'the console answers only on 127.0.0.1' });
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (req.method === 'GET' && url.pathname === '/') return send_(200, CONSOLE_PAGE, 'text/html');
      if (req.method === 'GET' && url.pathname === '/api/labs') return send_(200, labsView());
      if (parts[0] === 'api' && parts[1] === 'runs' && parts.length === 2) {
        if (req.method === 'GET') return send_(200, listRuns(path.join(root, 'runs')));
        if (req.method === 'POST') {
          const b = await body(req);
          if (!LABS[b.lab]) return send_(400, { error: 'unknown laboratory ' + b.lab });
          const args = Array.isArray(b.args) ? b.args.map(String) : [];
          const r = startRun(b.lab, { root, args, ...(b.researcher ? { researcher: String(b.researcher) } : {}), ...(b.policy ? { policy: String(b.policy) } : {}), ...(options.env ? { env: options.env } : {}) });
          return send_(201, { run: path.basename(r.journal, '.json'), pid: r.pid });
        }
      }
      if (parts[0] === 'api' && parts[1] === 'runs' && parts[2]) {
        const run = runByName(root, parts[2]);
        if (!run) return send_(404, { error: 'no run named ' + parts[2] });
        if (req.method === 'GET' && parts.length === 3) return send_(200, runView(run.journal, Number(url.searchParams.get('since') ?? 0) || 0));
        if (req.method === 'POST' && parts[3] === 'orders') {
          if (run.state === 'ended' || run.state === 'interrupted') return send_(409, { error: 'the run is ' + run.state + ': it reads no orders' });
          const b = await body(req);
          const order: RunOrder | null = b.kind === 'stop' ? { kind: 'stop', by: 'console' }
            : b.kind === 'message' && b.text ? { kind: 'message', text: String(b.text), by: 'console' }
            : b.kind === 'focus' && b.facet ? { kind: 'focus', facet: String(b.facet), ...(b.task ? { task: String(b.task) } : {}), by: 'console' }
            : b.kind === 'source' && b.source ? { kind: 'source', source: /^https?:\/\//i.test(String(b.source)) || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(String(b.source)) ? String(b.source) : path.resolve(root, String(b.source)), by: 'console' } : null;
          if (!order) return send_(400, { error: 'an order is stop, message (text), focus (facet) or source (source)' });
          return send_(202, order.kind === 'stop' ? stop(run.journal, 'console') : send(run.journal, order));
        }
        if (req.method === 'GET' && parts[3] === 'orders' && parts[4]) return send_(200, orderOutcome(run.journal, parts[4]));
        if (req.method === 'POST' && parts[3] === 'resume') {
          if (run.state === 'running' || run.state === 'stopping') return send_(409, { error: 'the run is still going' });
          const b = await body(req);
          const r = resumeRun(run.journal, { args: Array.isArray(b.args) ? b.args.map(String) : [], ...(options.env ? { env: options.env } : {}) });
          return send_(201, { run: path.basename(r.journal, '.json'), pid: r.pid });
        }
      }
      if (req.method === 'GET' && parts[0] === 'view' && parts[1]) {
        const run = runByName(root, parts[1]);
        if (!run || !options.synthesis) return send_(404, 'no synthesis', 'text/plain');
        return send_(200, await options.synthesis(readJson(run.journal)), 'text/html');
      }
      return send_(404, { error: 'not found' });
    } catch (e) { return send_(500, { error: String((e as Error).message ?? e) }); }
  });
  return new Promise((ok) => server.listen(options.port ?? 18400, '127.0.0.1', () => {
    const a = server.address() as { port: number };
    ok({ url: 'http://127.0.0.1:' + a.port, close: () => new Promise((r) => server.close(() => r())) });
  }));
}

/* --- The page: one file, no dependencies, the viewer's look ----------------------------------------------------------- */

export const CONSOLE_PAGE = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Consola de laboratorios</title>
<style>
:root { color-scheme: light; --page: #f9f9f7; --surface: #fcfcfb; --surface-2: #f3f2ef; --border: #e2e1dc; --text: #0b0b0b; --text-2: #52514e; --muted: #7a7973;
  --accent: #2a78d6; --good: #0ca30c; --critical: #d03b3b; --warn: #eb6834; --assisted: #4a3aa7; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { color-scheme: dark; --page: #0d0d0d; --surface: #1a1a19; --surface-2: #232321; --border: #33332f;
  --text: #ffffff; --text-2: #c3c2b7; --muted: #8f8e86; --accent: #3987e5; --warn: #d95926; --assisted: #9085e9; } }
:root[data-theme="dark"] { color-scheme: dark; --page: #0d0d0d; --surface: #1a1a19; --surface-2: #232321; --border: #33332f; --text: #ffffff; --text-2: #c3c2b7;
  --muted: #8f8e86; --accent: #3987e5; --warn: #d95926; --assisted: #9085e9; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
header { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--border); background: var(--surface); flex-wrap: wrap; }
h1 { font-size: 20px; margin: 0; } h2 { font-size: 17px; margin: 0; } h3 { font-size: 14px; margin: 14px 0 6px; color: var(--text-2); text-transform: uppercase; letter-spacing: .04em; }
main { display: grid; grid-template-columns: minmax(260px, 340px) 1fr; gap: 16px; padding: 16px; max-width: 1400px; margin: 0 auto; }
@media (max-width: 860px) { main { grid-template-columns: 1fr; } }
.panel { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 14px; }
.runs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.run { border: 1px solid var(--border); border-radius: 10px; padding: 8px 10px; cursor: pointer; background: var(--surface); }
.run:hover, .run:focus-visible { border-color: var(--accent); outline: none; }
.run.sel { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.run-name { font: 12px ui-monospace, Menlo, Consolas, monospace; overflow-wrap: anywhere; color: var(--text-2); }
.row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-top: 4px; font-size: 13px; }
.pill { display: inline-flex; align-items: center; gap: 5px; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; border: 1px solid var(--border); white-space: nowrap; }
.pill.r-unknown { color: var(--text-2); } .pill.r-assisted { color: #fff; background: var(--assisted); border-color: var(--assisted); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
.s-running .dot { background: var(--good); animation: pulse 1.4s infinite; } .s-stopping .dot { background: var(--warn); }
.s-interrupted .dot { background: var(--critical); } .s-ended .dot { background: var(--muted); }
@keyframes pulse { 50% { opacity: .3; } }
@media (prefers-reduced-motion: reduce) { .s-running .dot { animation: none; } }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; margin: 12px 0; }
.tile { background: var(--surface-2); border-radius: 8px; padding: 8px 10px; } .tile .k { font-size: 12px; color: var(--text-2); } .tile .v { font-size: 18px; font-weight: 650; }
button, select, input, textarea { font: inherit; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 5px 10px; }
button { cursor: pointer; font-weight: 600; } button:hover:not(:disabled) { border-color: var(--accent); } button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
button:disabled, input:disabled, textarea:disabled, select:disabled { opacity: .5; cursor: not-allowed; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.collab { border: 1px dashed var(--border); border-radius: 10px; padding: 10px; margin-top: 12px; }
.collab textarea { width: 100%; min-height: 60px; resize: vertical; }
.collab .why { font-size: 13px; color: var(--text-2); margin: 0 0 8px; }
.feedback { font-size: 13px; margin-top: 6px; } .ok { color: var(--good); } .bad { color: var(--critical); }
.timeline { font: 12.5px/1.5 ui-monospace, Menlo, Consolas, monospace; background: var(--surface-2); border-radius: 8px; padding: 8px 10px; max-height: 340px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
.timeline .ev-check, .timeline .ev-end { font-weight: 700; } .timeline .ev-operator_command_refused { color: var(--critical); } .timeline .ev-operator_command { color: var(--good); }
pre.code { font: 12px/1.45 ui-monospace, Menlo, Consolas, monospace; background: var(--surface-2); border-radius: 8px; padding: 8px 10px; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 300px; overflow: auto; }
table { border-collapse: collapse; width: 100%; font-size: 13px; } th, td { text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--border); }
.holds { color: var(--good); font-weight: 600; } .not { color: var(--critical); font-weight: 600; }
.muted { color: var(--text-2); font-size: 13px; } .empty { color: var(--muted); padding: 24px; text-align: center; }
dialog { border: 1px solid var(--border); border-radius: 12px; background: var(--surface); color: var(--text); max-width: 520px; width: calc(100vw - 32px); }
dialog label { display: block; margin: 8px 0 2px; font-size: 13px; color: var(--text-2); } dialog select, dialog input { width: 100%; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; } @media (max-width: 700px) { .two { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<header>
  <div><h1>Consola de laboratorios</h1><div class="muted">Los runs de los dos investigadores: seguirlos, pararlos, reanudarlos y, en el asistido, colaborar.</div></div>
  <button class="primary" id="new">Nuevo run</button>
</header>
<main>
  <section class="panel" aria-label="Runs"><h2>Runs</h2><ul class="runs" id="runs"></ul></section>
  <section class="panel" id="detail" aria-live="polite"><div class="empty">Elige un run.</div></section>
</main>
<dialog id="start">
  <form method="dialog" id="start-form">
    <h2>Nuevo run</h2>
    <label for="f-lab">Laboratorio</label><select id="f-lab"></select>
    <div class="muted" id="f-about"></div>
    <label for="f-researcher">Investigador</label>
    <select id="f-researcher"><option value="unknown-world">mundo desconocido (aprende sólo del mundo)</option><option value="assisted">asistido (el operador puede escribirle)</option></select>
    <label for="f-args">Argumentos del experimento</label><input id="f-args" placeholder="--seed 1 --level 1">
    <div class="muted" id="f-options"></div>
    <label for="f-policy">Política del operador (opcional)</label><input id="f-policy" placeholder="force=unknown-world  o  allow=unknown-world,assisted">
    <p class="muted">Las claves las pone el entorno del proceso de la consola; nunca pasan por esta página.</p>
    <div class="actions"><button value="cancel">Cancelar</button><button class="primary" id="f-go" value="go">Lanzar</button></div>
    <div class="feedback" id="f-feedback"></div>
  </form>
</dialog>
<script>
const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v); } for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : String(k)); return e; };
const api = async (url, opts = {}) => { const r = await fetch(url, { ...opts, headers: { 'content-type': 'application/json' } }); const b = await r.json().catch(() => ({})); if (!r.ok) throw new Error(b.error || r.statusText); return b; };
const STATE = { running: 'en curso', stopping: 'parando', ended: 'terminado', interrupted: 'interrumpido' };
const RESEARCHER = { 'unknown-world': 'mundo desconocido', assisted: 'asistido' };
const researcherPill = (r) => el('span', { class: 'pill ' + (r === 'assisted' ? 'r-assisted' : 'r-unknown'), title: r === 'assisted' ? 'Investigador asistido: puede recibir ayuda del operador' : 'Investigador de mundo desconocido: aprende sólo de lo que responde el mundo' }, RESEARCHER[r] || r);
const statePill = (s) => el('span', { class: 'pill s-' + s }, el('span', { class: 'dot' }), STATE[s] || s);
let selected = null, since = 0, timeline = null, labs = [], shownState = null;

async function refreshRuns() {
  const runs = await api('/api/runs');
  const ul = $('runs');
  ul.replaceChildren(...(runs.length ? runs.map((r) => el('li', { class: 'run' + (r.run === selected ? ' sel' : ''), tabindex: 0, onclick: () => select(r.run), onkeydown: (e) => { if (e.key === 'Enter') select(r.run); } },
    el('div', { class: 'row' }, el('strong', {}, r.lab), researcherPill(r.researcher), statePill(r.state)),
    el('div', { class: 'run-name' }, r.run),
    el('div', { class: 'row muted' }, r.round != null ? 'ronda ' + r.round : '', r.stoppedBy ? ' · ' + r.stoppedBy : '')))
    : [el('li', { class: 'empty' }, 'Aún no hay runs. Lanza uno con «Nuevo run».')]));
}

function tile(k, v) { return el('div', { class: 'tile' }, el('div', { class: 'k' }, k), el('div', { class: 'v' }, v)); }

async function select(run) { selected = run; since = 0; timeline = null; await refreshRuns(); await refreshDetail(true); }

async function order(kind, extra, feedback) {
  feedback.className = 'feedback'; feedback.textContent = 'enviando…';
  try {
    const { id } = await api('/api/runs/' + encodeURIComponent(selected) + '/orders', { method: 'POST', body: JSON.stringify({ kind, ...extra }) });
    for (let i = 0; i < 60; i++) {
      const o = await api('/api/runs/' + encodeURIComponent(selected) + '/orders/' + encodeURIComponent(id));
      if (o.state !== 'pending') { feedback.className = 'feedback ' + (o.state === 'accepted' ? 'ok' : 'bad'); feedback.textContent = o.state === 'accepted' ? 'aceptada' : 'rechazada: ' + o.reason; return; }
      await new Promise((r) => setTimeout(r, 500));
    }
    feedback.textContent = 'escrita; el run la leerá antes de su próxima pregunta a System 2';
  } catch (e) { feedback.className = 'feedback bad'; feedback.textContent = e.message; }
}

function modelText(m) {
  if (!m || !m.law) return 'Aún no hay modelo.';
  const law = m.law, out = [];
  for (const [id, o] of Object.entries(law.observations || {})) out.push('observación ' + id + ': ' + (o.definition || '') + '\\n  ' + (o.source || (o.spec && o.spec.source) || ''));
  for (const [id, r] of Object.entries(law.rules || {})) out.push('regla ' + id + ': ' + (r.instructions || ''));
  if (law.output) out.push('salida:\\n  ' + (law.output.source || law.output));
  return (m.fingerprint ? 'ronda ' + m.round + ' · ' + m.fingerprint + '\\n\\n' : '') + out.join('\\n');
}

async function refreshDetail(full = false) {
  if (!selected) return;
  let v;
  try { v = await api('/api/runs/' + encodeURIComponent(selected) + '?since=' + (full || !timeline ? 0 : since)); }
  catch (e) { timeline = null; $('detail').replaceChildren(el('div', { class: 'empty' }, /no run named/.test(e.message) ? 'Esperando a que el run escriba su journal…' : e.message)); return; }
  const s = v.status, pure = s.researcher !== 'assisted', live = s.state === 'running' || s.state === 'stopping';
  /* A run that changes state is drawn again: its pills, and which controls it takes. */
  if (!full && timeline && shownState !== s.state) return refreshDetail(true);
  shownState = s.state;
  if (full || !timeline) {
    timeline = el('div', { class: 'timeline', id: 'timeline', role: 'log', 'aria-label': 'Eventos del run' });
    const fb = el('div', { class: 'feedback' });
    const msg = el('textarea', { id: 'msg', placeholder: 'Un mensaje para el investigador…', disabled: pure || !live });
    const facet = el('input', { placeholder: 'faceta', disabled: pure || !live }), source = el('input', { placeholder: 'carpeta, URL o dominio', disabled: pure || !live });
    $('detail').replaceChildren(
      el('div', { class: 'row' }, el('h2', {}, s.lab), researcherPill(s.researcher), statePill(s.state)),
      el('div', { class: 'run-name' }, s.run),
      el('div', { class: 'tiles', id: 'tiles' }),
      el('div', { class: 'actions' },
        el('button', { disabled: !live, onclick: () => order('stop', {}, fb) }, 'Parar'),
        el('button', { disabled: live, onclick: async () => { try { const r = await api('/api/runs/' + encodeURIComponent(selected) + '/resume', { method: 'POST', body: '{}' }); await select(r.run); } catch (e) { fb.className = 'feedback bad'; fb.textContent = e.message; } } }, 'Reanudar'),
        el('a', { href: '/view/' + encodeURIComponent(s.run), target: '_blank', rel: 'noopener' }, 'Síntesis visual')),
      fb,
      el('div', { class: 'collab' },
        el('h3', {}, 'Colaborar'),
        pure ? el('p', { class: 'why' }, 'El investigador de mundo desconocido aprende sólo de lo que responde el mundo: no acepta mensajes, foco ni fuentes. Parar y reanudar sí, porque son control, no información para System 2.')
          : live ? null : el('p', { class: 'why' }, 'El run no está en curso: no lee órdenes.'),
        msg, el('div', { class: 'actions' }, el('button', { disabled: pure || !live, onclick: () => order('message', { text: msg.value }, fb) }, 'Enviar mensaje'),
          facet, el('button', { disabled: pure || !live, onclick: () => order('focus', { facet: facet.value }, fb) }, 'Cambiar foco'),
          source, el('button', { disabled: pure || !live, onclick: () => order('source', { source: source.value }, fb) }, 'Permitir origen'))),
      el('h3', {}, 'Eventos'), timeline,
      el('div', { class: 'two' }, el('div', {}, el('h3', {}, 'Modelo actual'), el('pre', { class: 'code', id: 'model' })),
        el('div', {}, el('h3', {}, 'Última comprobación'), el('div', { id: 'check' }), el('h3', {}, 'Creencias'), el('div', { id: 'beliefs' }))),
      el('div', { id: 'finding' }));
    since = 0;
  }
  for (const e of v.events) timeline.append(el('div', { class: 'ev-' + e.type }, e.line));
  if (v.events.length) timeline.scrollTop = timeline.scrollHeight;
  since = v.total;
  const c = s.cost || {};
  $('tiles').replaceChildren(tile('estado', STATE[s.state] || s.state), tile('ronda', s.round ?? '–'), tile('motivo', s.stoppedBy || '–'),
    tile('llamadas al LLM', c.llm_calls ?? '–'), tile('tokens', c.llm_tokens ?? '–'), tile('llamadas a Jev', c.jev_calls ?? '–'));
  $('model').textContent = modelText(v.model);
  $('check').replaceChildren(v.check ? el('table', {}, el('tr', {}, el('th', {}, 'lugar'), el('th', {}, 'ronda ' + v.check.round)),
    ...v.check.places.map((p) => el('tr', {}, el('td', {}, p.place), el('td', { class: p.holds ? 'holds' : 'not' }, p.holds ? 'se sostiene' : 'no se sostiene'))),
    v.check.blind != null ? el('tr', {}, el('td', {}, 'a ciegas'), el('td', { class: v.check.blind ? 'holds' : 'not' }, v.check.blind ? 'confirmado' : 'no confirmado')) : null)
    : el('div', { class: 'muted' }, 'Aún no hay comprobaciones.'));
  $('beliefs').replaceChildren(...(v.beliefs.length ? v.beliefs.map((b) => el('div', { class: 'muted' }, '[' + b.status + '] ' + b.statement)) : [el('div', { class: 'muted' }, 'Aún no hay creencias.')]));
  if (v.finding && !$('finding').childElementCount) {
    const pre = el('pre', { class: 'code' }, v.finding.operator);
    $('finding').append(el('h3', {}, 'Finding'), el('div', { class: 'actions' },
      el('button', { onclick: () => { pre.textContent = v.finding.operator; } }, 'Vista del operador'),
      el('button', { onclick: () => { pre.textContent = v.finding.researcher; } }, 'Vista del investigador')), pre);
  }
}

async function openStart() {
  if (!labs.length) labs = await api('/api/labs');
  const sel = $('f-lab');
  sel.replaceChildren(...labs.map((l) => el('option', { value: l.name }, l.name + ' (' + l.id + ')')));
  const show = () => { const l = labs.find((x) => x.name === sel.value); $('f-about').textContent = l ? l.about : ''; $('f-options').textContent = l ? 'Opciones: ' + l.options.map((o) => '--' + o.name + ' (' + o.default + ')').join(', ') + (l.flags.length ? '; ' + l.flags.map((f) => '--' + f.name).join(', ') : '') : ''; };
  sel.onchange = show; show();
  $('f-feedback').textContent = '';
  $('start').showModal();
}
$('new').onclick = openStart;
$('start-form').onsubmit = async (e) => {
  if (e.submitter && e.submitter.value !== 'go') return;
  e.preventDefault();
  const args = $('f-args').value.trim() ? $('f-args').value.trim().split(/\\s+/) : [];
  try {
    const r = await api('/api/runs', { method: 'POST', body: JSON.stringify({ lab: $('f-lab').value, researcher: $('f-researcher').value, args, policy: $('f-policy').value.trim() || undefined }) });
    $('start').close();
    setTimeout(() => select(r.run), 1500);
  } catch (err) { $('f-feedback').className = 'feedback bad'; $('f-feedback').textContent = err.message; }
};
refreshRuns();
setInterval(() => { refreshRuns(); refreshDetail(); }, 1500);
</script>
</body>
</html>
`;
