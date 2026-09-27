import { keyMoments, synthesize, type Moment, type MomentKind, type Synthesis } from './synthesis.ts';
import { framesAnim, messagesAnim, orbitAnim, player, playInTurn, readPositions, reducedMotion, rowsAnim, setFilled, stopAll, triesAnim, type Anim, type Player } from './animate.ts';

/* ============================================================================
 * The run viewer: a visual synthesis of a journal, in the browser. Built after the run,
 * from its data (scripts/journal-view.ts embeds a journal; without one, the page takes a
 * journal dropped on it). No dependencies: plain DOM and SVG.
 *
 *   Síntesis         the most relevant moments, in order; a relevance threshold and "only
 *                    the path to the final model" select which
 *   Progreso         the laboratories' check, round by round, with validation and acceptance
 *   Creencias        each belief's lineage: new, revised, kept, confirmed, dropped
 *   Línea temporal   every moment, lane by kind, round by round
 *   Animaciones      a moment opened plays what the environment showed or what the model tried (animate.ts);
 *                    "Presentar" plays the selected moments in turn
 *   Solo operador    what System 2 never saw: the truth, the grading, the cost, the ablations
 * ========================================================================== */

type El = HTMLElement;
const h = (tag: string, attrs: Record<string, string | number | boolean | undefined> = {}, ...kids: (Node | string | null | undefined | false)[]): El => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') e.className = String(v);
    else if (k === 'text') e.textContent = String(v);
    else e.setAttribute(k, String(v));
  }
  for (const k of kids) if (k !== null && k !== undefined && k !== false) e.append(typeof k === 'string' ? document.createTextNode(k) : k);
  return e;
};
const SVG = 'http://www.w3.org/2000/svg';
const s = (tag: string, attrs: Record<string, string | number> = {}): SVGElement => {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};

const KINDS: Record<MomentKind, { label: string; icon: string; lane: number }> = {
  environment: { label: 'Entorno', icon: '◦', lane: 0 },
  investigate: { label: 'Investigación', icon: '⌕', lane: 1 },
  replay: { label: 'Repetición', icon: '↻', lane: 1 },
  propose: { label: 'Propuesta', icon: '✎', lane: 2 },
  check: { label: 'Comprobación', icon: '✓', lane: 3 },
  validate: { label: 'Validación', icon: '◆', lane: 4 },
  reflect: { label: 'Reflexión', icon: '☰', lane: 5 }
};
const LANES = ['Entorno', 'Investigación', 'Propuesta', 'Comprobación', 'Validación', 'Reflexión'];
const STANCES: Record<string, { label: string; cls: string }> = {
  new: { label: 'nueva', cls: 'st-new' }, revise: { label: 'revisada', cls: 'st-revise' }, confirm: { label: 'confirmada', cls: 'st-confirm' },
  keep: { label: 'mantenida', cls: 'st-keep' }, drop: { label: 'abandonada', cls: 'st-drop' }
};

/* --- The detail of a moment: what it did, with the world's own way of showing it --------------------------------- */

function preview(x: unknown, max = 3000): El {
  const text = typeof x === 'string' ? x : JSON.stringify(x, null, 2) ?? '';
  return h('pre', { class: 'code' }, text.length > max ? text.slice(0, max) + '\n…' : text);
}

/** The symbol filled in every picture of a run: the rarer of the two over all its rows, so pictures compare. */
let filled: string | null = null;
function chooseFilled(journal: Record<string, any>): void {
  const counts = new Map<string, number>();
  for (const e of journal.events ?? []) for (const r of rowsOf(e) ?? []) for (const ch of r) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  filled = counts.size === 2 ? [...counts.entries()].sort((a, b) => a[1] - b[1])[0][0] : null;
  setFilled(filled);
}

/** Rows of two symbols as a space-time picture: one row per step, one symbol filled. Null when they are not. */
function spacetime(rows: readonly string[], cell = 8): SVGElement | null {
  if (!rows.length || rows.length > 80) return null;
  const width = rows[0].length;
  if (!width || width > 80 || rows.some((r) => r.length !== width)) return null;
  const counts = new Map<string, number>();
  for (const r of rows) for (const ch of r) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  if (counts.size > 2) return null;
  const on = filled && (counts.has(filled) || counts.size < 2) ? filled : [...counts.entries()].sort((a, b) => a[1] - b[1])[0][0];
  const svg = s('svg', { viewBox: '0 0 ' + width * cell + ' ' + rows.length * cell, class: 'spacetime', role: 'img', 'aria-label': rows.length + ' rows of ' + width + ' cells' });
  svg.append(s('rect', { x: 0, y: 0, width: width * cell, height: rows.length * cell, class: 'st-bg' }));
  rows.forEach((r, y) => { for (let x = 0; x < width; x++) if (r[x] === on) svg.append(s('rect', { x: x * cell + 0.5, y: y * cell + 0.5, width: cell - 1, height: cell - 1, rx: 1, class: 'st-on' })); });
  return svg;
}

/** An animation in a player, collected so the drawer can play them in turn. */
function played(anim: Anim | null, players: Player[], title?: string): El | null {
  if (!anim) return null;
  const p = player(anim, title);
  players.push(p);
  return p.el;
}

/** Rows as an animated picture, with the text beside it on demand. */
function rowsView(rows: readonly string[], players: Player[], steps?: readonly number[]): El {
  const text = h('pre', { class: 'rows' }, rows.map((r, i) => (steps ? String(steps[i]).padStart(3) + '  ' : '') + r).join('\n'));
  const pic = played(rowsAnim(rows, steps), players);
  return pic ? h('div', { class: 'rows-view' }, pic, h('details', {}, h('summary', {}, 'Ver como texto'), text)) : text;
}

/** A table of positions as bodies moving, with the table on demand. */
function tableView(table: string, players: Player[]): El {
  const pic = readPositions(table) ? played(orbitAnim(table), players) : null;
  return pic ? h('div', { class: 'rows-view' }, pic, h('details', {}, h('summary', {}, 'Ver la tabla'), preview(table, 4000))) : preview(table, 2000);
}

/** The rows an event's results carry, for a thumbnail. */
export function rowsOf(e: Record<string, any>): string[] | null {
  if (Array.isArray(e.rows) && e.rows.every((x: unknown) => typeof x === 'string')) return e.rows;
  for (const r of e.results ?? []) {
    if (Array.isArray(r?.rows) && r.rows.every((x: unknown) => typeof x === 'string')) return r.rows;
    if (Array.isArray(r?.rows) && r.rows.length && typeof r.rows[0]?.row === 'string') return r.rows.map((x: any) => x.row);
  }
  return null;
}

/** A result shown the way its world shows it: rows of symbols, pictures, texts with marks, a table. */
function renderResult(res: Record<string, any>, players: Player[]): El {
  if (!res || typeof res !== 'object') return preview(res);
  if (Array.isArray(res.rows) && res.rows.every((r: unknown) => typeof r === 'string')) return rowsView(res.rows, players);
  if (Array.isArray(res.rows) && res.rows.length && typeof res.rows[0]?.row === 'string') return rowsView(res.rows.map((r: any) => r.row), players, res.rows.map((r: any) => r.step));
  if (Array.isArray(res.frames) && res.frames.length) return played(framesAnim(res.frames), players) ?? preview(res.frames);
  if (Array.isArray(res.messages) && res.messages.length) return played(messagesAnim(res.messages.map((m: any) => ({ step: m.step, text: String(m.text), mark: m.mark }))), players) ?? preview(res.messages);
  if (typeof res.table === 'string' && res.table.includes('\n')) return tableView(res.table, players);
  if (Array.isArray(res.values)) return h('ul', { class: 'vals' }, ...res.values.slice(0, 12).map((v: any) => h('li', {}, h('b', {}, String(v.point)), ' → ', h('code', {}, String(v.value ?? v.error)))));
  return preview(res, 1500);
}

/** What the environment showed in an episode, as it happened. */
function environmentView(e: Record<string, any>, players: Player[]): El | null {
  if (Array.isArray(e.rows)) return rowsView(e.rows, players);
  if (Array.isArray(e.messages)) return played(messagesAnim(e.messages), players);
  if (typeof e.table === 'string') return tableView(e.table, players);
  if (Array.isArray(e.frames)) return played(framesAnim(e.frames), players);
  return null;
}

/** What the model tried in each place of a check, case by case (the journal's trace). */
function triesView(places: readonly Record<string, any>[], players: Player[], heading: string): El | null {
  const withTrace = places.filter((p) => Array.isArray(p.trace) && p.trace.length);
  if (!withTrace.length) return null;
  return h('section', { class: 'req' }, h('h4', {}, heading),
    ...withTrace.map((p) => played(triesAnim(p.trace), players, p.place + ' · ' + (p.holds ? 'se sostiene ✓' : 'no se sostiene ✗'))));
}

function detail(m: Moment, players: Player[]): El {
  const e = m.event as Record<string, any>;
  const box = h('div', { class: 'detail-body' },
    h('div', { class: 'kicker' }, KINDS[m.kind].icon + ' ' + KINDS[m.kind].label + ' · ronda ' + m.round + ' · ' + m.t + ' s'),
    h('h3', {}, m.title),
    relevanceBar(m));
  if (m.kind === 'investigate') {
    const reqs: any[] = e.requests ?? [];
    const res: any[] = e.results ?? [];
    reqs.forEach((r, i) => box.append(h('section', { class: 'req' }, h('div', { class: 'req-head' }, h('code', {}, JSON.stringify(r).slice(0, 220))), res[i] !== undefined ? renderResult(res[i], players) : null)));
    for (const n of e.notes ?? []) box.append(h('p', { class: 'note' }, h('b', {}, 'nota ' + n.id + ': '), String(n.text)));
    for (const w of e.warnings ?? []) box.append(h('p', { class: 'warn' }, '⚠ ' + w));
  } else if (m.kind === 'propose') {
    box.append(h('p', {}, String(e.rationale ?? '')));
    for (const b of e.beliefs ?? []) box.append(h('p', { class: 'belief' }, h('span', { class: 'chip ' + (STANCES[b.stance]?.cls ?? '') }, STANCES[b.stance]?.label ?? b.stance), ' ', h('b', {}, String(b.id)), b.statement ? ': ' + b.statement : '', b.why ? h('span', { class: 'why' }, ' — ' + b.why) : null));
    const model = e.law ?? e.formula;
    if (model) box.append(h('details', {}, h('summary', {}, 'El modelo propuesto'), modelView(model)));
  } else if (m.kind === 'reflect') {
    box.append(h('p', {}, String(e.rationale ?? '')));
    for (const l of e.lessons ?? []) box.append(h('p', { class: 'note' }, '· ' + l));
  } else {
    for (const l of m.lines) box.append(h('p', {}, l));
    if (m.kind === 'environment') { const v = environmentView(e, players); if (v) box.append(v); }
    if (m.kind === 'check') { const v = triesView(e.laboratories ?? [], players, 'Lo que intentó el modelo, caso a caso'); if (v) box.append(v); }
    if (m.kind === 'validate') {
      const fam = triesView(e.family ?? [], players, 'En la familia');
      if (fam) box.append(fam);
      (e.blind_confirmation?.sets ?? []).forEach((set: any, k: number) => { const v = triesView(set.places ?? [], players, 'Confirmación ciega ' + (k + 1) + (set.ok ? ' ✓' : ' ✗')); if (v) box.append(v); });
    }
    box.append(h('details', {}, h('summary', {}, 'Datos del evento'), preview(e, 6000)));
  }
  return box;
}

function relevanceBar(m: Moment): El {
  return h('div', { class: 'rel', title: 'relevancia ' + m.relevance.toFixed(2) + (m.onPath ? ' · en el camino al modelo final' : '') },
    h('span', { class: 'rel-track' }, h('span', { class: 'rel-fill', style: 'width:' + Math.round(m.relevance * 100) + '%' })),
    h('span', { class: 'rel-label' }, Math.round(m.relevance * 100) + '%' + (m.onPath ? ' · camino' : '')));
}

/* --- Sections ------------------------------------------------------------------------------------------------------ */

function header(syn: Synthesis): El {
  const m = syn.meta;
  const ok = m.acceptedRound !== null;
  const sum = syn.operator.summary as Record<string, any> | null;
  const cost = sum?.cost ?? {};
  const tile = (label: string, value: string, sub?: string) => h('div', { class: 'tile' }, h('div', { class: 'tile-label' }, label), h('div', { class: 'tile-value' }, value), sub ? h('div', { class: 'tile-sub' }, sub) : null);
  const firstHeld = syn.progress.find((p) => p.held);
  return h('header', { class: 'top' },
    h('div', { class: 'title-row' },
      h('div', {}, h('h1', {}, m.world + (m.level !== null ? ' · nivel ' + m.level : '')),
        h('p', { class: 'sub' }, [m.experiment, m.seed !== null ? 'seed ' + m.seed : '', m.model ?? '', m.started ? new Date(m.started).toLocaleString() : '', Math.round(m.seconds) + ' s'].filter(Boolean).join(' · '))),
      h('div', { class: 'badge ' + (ok ? 'good' : 'neutral') }, h('span', { class: 'badge-icon', 'aria-hidden': 'true' }, ok ? '✓' : '■'), ok ? 'Aceptado en la ronda ' + m.acceptedRound : 'No aceptado (' + m.outcome + ')')),
    h('div', { class: 'tiles' },
      tile('Rondas', String(m.rounds)),
      tile('Se sostuvo por primera vez', firstHeld ? 'ronda ' + firstHeld.round : '—'),
      tile('Llamadas al LLM', cost.llm_calls !== undefined ? String(cost.llm_calls) : '—', cost.llm_tokens ? Math.round(cost.llm_tokens / 1000) + 'k tokens' : undefined),
      tile('Llamadas a Jev', cost.jev_calls !== undefined ? String(cost.jev_calls) : '—', cost.jev_not_asked ? cost.jev_not_asked + ' sin preguntar' : undefined),
      tile('Reglas recuperadas', syn.operator.score !== null ? Math.round(syn.operator.score * 100) + '%' : '—', syn.operator.form ? 'forma: ' + syn.operator.form : 'solo operador')));
}

function synthesisSection(syn: Synthesis, open: (m: Moment) => void, present: (ms: readonly Moment[]) => void): El {
  const state = { threshold: 0.6, pathOnly: false };
  const list = h('ol', { class: 'story' });
  const count = h('span', { class: 'muted' });
  const draw = () => {
    const ms = keyMoments(syn, state);
    count.textContent = ms.length + ' de ' + syn.moments.length + ' momentos';
    list.replaceChildren(...ms.map((m) => {
      const li = h('li', { class: 'card k-' + m.kind + (m.onPath ? ' on-path' : ''), tabindex: 0 },
        h('div', { class: 'card-head' }, h('span', { class: 'round' }, 'R' + m.round), h('span', { class: 'kind' }, KINDS[m.kind].icon + ' ' + KINDS[m.kind].label), relevanceBar(m)),
        h('div', { class: 'card-title' }, m.title),
        ...m.lines.slice(0, 3).map((l) => h('div', { class: 'card-line' }, l)));
      /* What the world showed, at a glance (rows of symbols as a picture). */
      const rows = rowsOf(m.event as Record<string, any>);
      const thumb = rows && filled && rows.some((r) => r.includes(filled!)) ? spacetime(rows.slice(0, 26), 4) : null;
      if (thumb) { thumb.setAttribute('class', 'spacetime thumb'); li.append(thumb); }
      li.dataset.moment = m.id;
      li.addEventListener('click', () => open(m));
      li.addEventListener('keydown', (ev) => { if ((ev as KeyboardEvent).key === 'Enter') open(m); });
      return li;
    }));
  };
  const slider = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: state.threshold, 'aria-label': 'relevancia mínima' }) as HTMLInputElement;
  const sliderValue = h('output', {}, Math.round(state.threshold * 100) + '%');
  slider.addEventListener('input', () => { state.threshold = Number(slider.value); sliderValue.textContent = Math.round(state.threshold * 100) + '%'; draw(); });
  const path = h('input', { type: 'checkbox' }) as HTMLInputElement;
  path.addEventListener('change', () => { state.pathOnly = path.checked; draw(); });
  draw();
  const show = h('button', { class: 'present', type: 'button' }, '▶ Presentar');
  show.addEventListener('click', () => present(keyMoments(syn, state)));
  return h('section', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', {}, 'Síntesis'), h('div', { class: 'head-right' }, count, show)),
    h('p', { class: 'hint' }, 'Los momentos más relevantes, en el orden en que ocurrieron. La relevancia sube cuando lo que un paso produjo o miró fue citado después como evidencia por una creencia, y cuando una comprobación cambió el veredicto. El camino: lo que llevó al modelo final. Al abrir un momento se anima lo que mostró el entorno o lo que intentó el modelo; «Presentar» recorre los momentos seleccionados uno tras otro.'),
    h('div', { class: 'controls' },
      h('label', {}, 'Relevancia mínima ', slider, ' ', sliderValue),
      h('label', {}, path, ' solo el camino al modelo final')),
    list);
}

function progressSection(syn: Synthesis): El {
  const P = syn.progress;
  const box = h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', {}, 'Comprobaciones en el laboratorio')),
    h('p', { class: 'hint' }, 'La proporción de casos acertados en cada comprobación; punto relleno si el modelo se sostuvo. ◆ validación, ★ aceptación.'));
  if (!P.length) { box.append(h('p', { class: 'muted' }, 'Sin comprobaciones.')); return box; }
  const W = 640, H = 230, L = 44, R = 20, T = 30, B = 34;
  const xs = (i: number) => L + (P.length === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (P.length - 1));
  const ys = (v: number) => T + (1 - v) * (H - T - B);
  const svg = s('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'chart', role: 'img', 'aria-label': 'Progreso de las comprobaciones por ronda' });
  for (const g of [0, 0.5, 1]) {
    svg.append(s('line', { x1: L, x2: W - R, y1: ys(g), y2: ys(g), class: 'grid' }));
    const t = s('text', { x: L - 8, y: ys(g) + 4, class: 'axis', 'text-anchor': 'end' }); t.textContent = Math.round(g * 100) + '%'; svg.append(t);
  }
  P.forEach((p, i) => { const t = s('text', { x: xs(i), y: H - 12, class: 'axis', 'text-anchor': 'middle' }); t.textContent = 'R' + p.round; svg.append(t); });
  svg.append(s('polyline', { points: P.map((p, i) => xs(i) + ',' + ys(p.value)).join(' '), class: 'line' }));
  const tip = h('div', { class: 'tip', role: 'status' });
  P.forEach((p, i) => {
    const g = s('g', { class: 'pt', tabindex: 0 });
    g.append(s('circle', { cx: xs(i), cy: ys(p.value), r: 14, class: 'hit' }));
    g.append(s('circle', { cx: xs(i), cy: ys(p.value), r: 5, class: p.held ? 'dot held' : 'dot' }));
    if (p.validated !== null) { const d = s('text', { x: xs(i), y: ys(p.value) - 12, class: 'glyph', 'text-anchor': 'middle' }); d.textContent = p.accepted ? '★' : '◆'; g.append(d); }
    const show = () => { tip.textContent = 'Ronda ' + p.round + ': ' + p.label + (p.held ? ' · se sostiene' : ' · no se sostiene') + (p.reused ? ' · comprobación reutilizada' : '') + (p.validated === null ? '' : p.accepted ? ' · validado y aceptado' : p.validated ? ' · validado, confirmación ciega fallida' : ' · validación fallida'); tip.classList.add('on'); };
    g.addEventListener('mouseenter', show); g.addEventListener('focus', show);
    g.addEventListener('mouseleave', () => tip.classList.remove('on')); g.addEventListener('blur', () => tip.classList.remove('on'));
    svg.append(g);
  });
  const table = h('table', { class: 'data' }, h('thead', {}, h('tr', {}, h('th', {}, 'Ronda'), h('th', {}, 'Resultado'), h('th', {}, 'Se sostiene'), h('th', {}, 'Validación'))),
    h('tbody', {}, ...P.map((p) => h('tr', {}, h('td', {}, String(p.round)), h('td', {}, p.label), h('td', {}, p.held ? 'sí' : 'no'), h('td', {}, p.validated === null ? '—' : p.accepted ? 'aceptado' : p.validated ? 'familia ✓, ciega ✗' : 'falló')))));
  box.append(h('div', { class: 'chart-wrap scroll' }, svg, tip), h('details', {}, h('summary', {}, 'Ver como tabla'), table));
  return box;
}

function beliefsSection(syn: Synthesis): El {
  const rounds = Array.from({ length: Math.max(1, syn.meta.rounds) }, (_, i) => i + 1);
  const box = h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', {}, 'Creencias')),
    h('p', { class: 'hint' }, 'Cada creencia de System 2, ronda a ronda. Pasa el ratón por una celda para ver lo que afirmaba y por qué.'),
    h('div', { class: 'legend' }, ...Object.values(STANCES).map((st) => h('span', {}, h('span', { class: 'chip ' + st.cls }, st.label)))));
  if (!syn.beliefs.length) { box.append(h('p', { class: 'muted' }, 'Sin creencias registradas.')); return box; }
  const table = h('table', { class: 'lineage' }, h('thead', {}, h('tr', {}, h('th', {}, 'Creencia'), ...rounds.map((r) => h('th', {}, 'R' + r)), h('th', {}, 'Al final'))));
  const body = h('tbody');
  for (const b of syn.beliefs) {
    const byRound = new Map(b.steps.map((st) => [st.round, st]));
    body.append(h('tr', {},
      h('th', { scope: 'row', title: b.statement }, h('b', {}, b.id), h('div', { class: 'stmt' }, b.statement)),
      ...rounds.map((r) => {
        const st = byRound.get(r);
        return h('td', {}, st ? h('span', { class: 'chip ' + (STANCES[st.stance]?.cls ?? ''), title: (STANCES[st.stance]?.label ?? st.stance) + ': ' + st.statement + (st.why ? '\n\nPor qué: ' + st.why : '') + (st.evidence.length ? '\n\nEvidencia: ' + st.evidence.join(', ') : '') }, STANCES[st.stance]?.label ?? st.stance) : '');
      }),
      h('td', {}, b.status)));
  }
  table.append(body);
  box.append(h('div', { class: 'scroll' }, table));
  return box;
}

function timelineSection(syn: Synthesis, open: (m: Moment) => void): El {
  const rounds = syn.meta.rounds + 1;
  const W = 900, laneH = 34, L = 110, T = 24, H = T + LANES.length * laneH + 10;
  const colW = (W - L - 10) / rounds;
  const svg = s('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'timeline', role: 'img', 'aria-label': 'Línea temporal por ronda y tipo de momento' });
  LANES.forEach((name, i) => {
    const t = s('text', { x: L - 10, y: T + i * laneH + laneH / 2 + 4, class: 'axis', 'text-anchor': 'end' }); t.textContent = name; svg.append(t);
    svg.append(s('line', { x1: L, x2: W - 10, y1: T + (i + 1) * laneH, y2: T + (i + 1) * laneH, class: 'grid' }));
  });
  for (let r = 0; r < rounds; r++) {
    const t = s('text', { x: L + r * colW + colW / 2, y: 14, class: 'axis', 'text-anchor': 'middle' }); t.textContent = r === 0 ? 'inicio' : 'R' + r; svg.append(t);
    if (r) svg.append(s('line', { x1: L + r * colW, x2: L + r * colW, y1: T, y2: H - 10, class: 'grid' }));
  }
  const slots = new Map<string, number>();
  for (const m of syn.moments) {
    const lane = KINDS[m.kind].lane, key = m.round + ':' + lane;
    const k = slots.get(key) ?? 0; slots.set(key, k + 1);
    const cx = L + m.round * colW + 10 + (k * 14) % Math.max(14, colW - 20), cy = T + lane * laneH + laneH / 2;
    const g = s('g', { class: 'mark k-' + m.kind + (m.onPath ? ' on-path' : ''), tabindex: 0 });
    const title = s('title'); title.textContent = 'R' + m.round + ' · ' + m.title; g.append(title);
    g.append(s('circle', { cx, cy, r: 3 + 6 * m.relevance, 'fill-opacity': 0.35 + 0.65 * m.relevance }));
    g.addEventListener('click', () => open(m));
    g.addEventListener('keydown', (ev) => { if ((ev as KeyboardEvent).key === 'Enter') open(m); });
    svg.append(g);
  }
  return h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', {}, 'Línea temporal')),
    h('p', { class: 'hint' }, 'Todos los momentos, por tipo y por ronda. El tamaño es la relevancia; el borde marca el camino al modelo final. Haz clic en uno para verlo.'),
    h('div', { class: 'scroll' }, svg));
}

/** A model as its parts: each observation's code, each rule's question for the judge, the weights, the output code. */
function modelView(model: Record<string, any>): El {
  const code = (x: any) => (typeof x === 'string' ? x : typeof x?.source === 'string' ? x.source : typeof x?.spec?.source === 'string' ? x.spec.source : null);
  const box = h('div', { class: 'model' });
  const obs = Object.entries(model.observations ?? {}).filter(([, d]: [string, any]) => code(d) !== null);
  if (obs.length) box.append(h('h3', {}, 'Observaciones (código)'), ...obs.map(([id, d]: [string, any]) => h('div', { class: 'part' },
    h('div', {}, h('b', {}, id), d.definition ? h('span', { class: 'muted' }, ' — ' + d.definition) : null, d.range ? h('span', { class: 'muted' }, ' · rango ' + JSON.stringify(d.range)) : h('span', { class: 'muted' }, ' · texto para el juez')),
    h('pre', { class: 'code' }, String(code(d))))));
  const rules = Object.entries(model.rules ?? {});
  if (rules.length) box.append(h('h3', {}, 'Reglas (preguntas para el juez, Jev)'), ...rules.map(([id, r]: [string, any]) => h('div', { class: 'part' },
    h('div', {}, h('b', {}, id), h('span', { class: 'muted' }, ' · peso ' + (model.weights?.[id] ?? '—'))), h('p', { class: 'question' }, String(r.instructions ?? '')))));
  const out = code(model.output);
  box.append(h('h3', {}, 'Respuesta'), out ? h('pre', { class: 'code' }, out) : h('p', { class: 'muted' }, 'V: la suma ponderada de las reglas.'));
  return box;
}

function modelSection(syn: Synthesis): El {
  const m = syn.finalModel as Record<string, any> | null;
  return h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', {}, 'Modelo final')),
    m && typeof m === 'object' ? modelView(m) : h('p', { class: 'muted' }, 'Sin modelo.'));
}

function operatorSection(syn: Synthesis): El {
  const o = syn.operator;
  const grades = Array.isArray(o.grades) ? o.grades as any[] : [];
  const truth = Array.isArray(o.truth) ? o.truth as any[] : [];
  return h('section', { class: 'panel operator' },
    h('div', { class: 'panel-head' }, h('h2', {}, '🔒 Solo para el operador'), h('span', { class: 'muted' }, 'System 2 nunca vio nada de esto')),
    truth.length ? h('div', {}, h('h3', {}, 'La verdad oculta y cómo la recuperó'),
      h('table', { class: 'data' }, h('thead', {}, h('tr', {}, h('th', {}, 'Afirmación verdadera'), h('th', {}, 'Nota'), h('th', {}, 'Evidencia'))),
        h('tbody', {}, ...truth.map((t) => { const g = grades.find((x) => x.id === t.id); return h('tr', {}, h('td', {}, String(t.statement ?? t.id)), h('td', {}, g ? h('span', { class: 'grade g-' + g.grade }, g.grade) : '—'), h('td', { class: 'small' }, g?.evidence ?? '')); })))) : null,
    o.form ? h('p', {}, 'Forma del modelo final según el grader: ', h('b', {}, o.form)) : null,
    o.summary ? h('details', {}, h('summary', {}, 'Resumen del operador (hitos, coste, Jev)'), preview(o.summary, 6000)) : null,
    o.ablations.length ? h('details', {}, h('summary', {}, 'Ablaciones (' + o.ablations.length + ')'), preview(o.ablations, 8000)) : null);
}

/* --- The page ------------------------------------------------------------------------------------------------------ */

export function mount(root: El, journal: Record<string, unknown>): void {
  const syn = synthesize(journal);
  chooseFilled(journal);
  const drawer = h('aside', { class: 'drawer', 'aria-hidden': 'true' });
  /* Each opening gets a number: an older chain of animations stops when a newer one starts. */
  let opening = 0;
  const close = () => { opening++; stopAll(); drawer.classList.remove('open'); drawer.setAttribute('aria-hidden', 'true'); stopShow(); };
  /** Opens a moment and plays its animations in turn; resolves when they end (at once without animations). */
  const show = (m: Moment, autoplay: boolean): Promise<boolean> => {
    const mine = ++opening;
    stopAll();
    const players: Player[] = [];
    const body = detail(m, players);
    drawer.replaceChildren(h('button', { class: 'close', 'aria-label': 'Cerrar' }, '×'), body);
    drawer.querySelector('.close')!.addEventListener('click', close);
    drawer.classList.add('open'); drawer.setAttribute('aria-hidden', 'false');
    drawer.scrollTop = 0;
    root.querySelectorAll('.card.current').forEach((c) => c.classList.remove('current'));
    root.querySelector('.card[data-moment="' + CSS.escape(m.id) + '"]')?.classList.add('current');
    if (!autoplay || !players.length) return Promise.resolve(players.length > 0);
    return playInTurn(players, () => mine !== opening).then(() => true);
  };
  const open = (m: Moment) => { stopShow(); void show(m, !reducedMotion()); };

  /* The presentation: the selected moments, one after another, each with its animations. */
  let presenting = 0;
  const bar = h('div', { class: 'show-bar', role: 'status', hidden: true });
  const stopShow = () => { presenting++; bar.hidden = true; };
  const present = async (ms: readonly Moment[]) => {
    if (!ms.length) return;
    const run = ++presenting;
    let i = 0, paused = false;
    const pos = h('span', {});
    const pauseBtn = h('button', { type: 'button' }, '❚❚');
    const prev = h('button', { type: 'button', 'aria-label': 'Anterior' }, '⏮');
    const next = h('button', { type: 'button', 'aria-label': 'Siguiente' }, '⏭');
    const end = h('button', { type: 'button', 'aria-label': 'Terminar' }, '✕');
    bar.replaceChildren(h('b', {}, 'Presentación'), pos, prev, pauseBtn, next, end);
    bar.hidden = false;
    let jump: (() => void) | null = null;
    let moved = false;
    const go = (k: number) => { i = Math.max(0, Math.min(ms.length - 1, k)); moved = true; jump?.(); };
    prev.addEventListener('click', () => go(i - 1));
    next.addEventListener('click', () => go(i + 1));
    end.addEventListener('click', () => { close(); });
    pauseBtn.addEventListener('click', () => {
      paused = !paused;
      pauseBtn.textContent = paused ? '▶' : '❚❚';
      if (paused) { opening++; stopAll(); } else go(i);
    });
    while (run === presenting && i < ms.length) {
      moved = false;
      const at = i;
      pos.textContent = (at + 1) + ' / ' + ms.length + ' · R' + ms[at].round + ' · ' + KINDS[ms[at].kind].label;
      document.querySelector('.card[data-moment="' + CSS.escape(ms[at].id) + '"]')?.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
      /* Wait for the moment's animations, then a pause to read it; a jump or an unpause cuts the wait. */
      const waited = new Promise<void>((resolve) => { jump = resolve; });
      const played = show(ms[at], !paused && !reducedMotion()).then((animated) => new Promise<void>((r) => setTimeout(r, animated ? 1500 : 3500)));
      await Promise.race([waited, paused ? new Promise<void>(() => {}) : played]);
      if (run !== presenting) return;
      if (paused) { await waited; if (run !== presenting) return; }
      if (!moved) i++;
    }
    if (run === presenting) bar.hidden = true;
  };
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') close(); });
  root.replaceChildren(header(syn), synthesisSection(syn, open, (ms) => void present(ms)), progressSection(syn), beliefsSection(syn), timelineSection(syn, open), modelSection(syn), operatorSection(syn), drawer, bar);
  document.title = syn.meta.world + ' · síntesis del run';
}

/** Without an embedded journal: a place to drop one (or pick a file). */
function dropZone(root: El): void {
  const input = h('input', { type: 'file', accept: '.json,application/json' }) as HTMLInputElement;
  const zone = h('div', { class: 'drop' }, h('h1', {}, 'Síntesis de un run'), h('p', {}, 'Suelta aquí el journal de un run (runs/*.json) o elígelo:'), input, h('p', { class: 'err' }));
  const load = async (file: File) => {
    try { mount(root, JSON.parse(await file.text())); }
    catch (e) { zone.querySelector('.err')!.textContent = 'No se pudo leer: ' + String((e as Error).message ?? e); }
  };
  input.addEventListener('change', () => { if (input.files?.[0]) void load(input.files[0]); });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); const f = (e as DragEvent).dataTransfer?.files?.[0]; if (f) void load(f); });
  root.replaceChildren(zone);
}

export function boot(): void {
  const root = document.getElementById('app')!;
  const data = document.getElementById('journal');
  if (data && data.textContent && data.textContent.trim()) mount(root, JSON.parse(data.textContent));
  else dropZone(root);
}
