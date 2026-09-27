/* ============================================================================
 * Animations of the viewer: what the environment showed, and what the model tried in a
 * check, played step by step. Each animation is a picture with frames; a player gives it
 * play / pause, a scrubber and a speed, and can be awaited (the presentation mode plays
 * a moment's animations one after another, then moves on). Plain DOM and SVG.
 *
 *   rows       a space-time picture that grows row by row (cells)
 *   messages   texts that arrive one by one, each with its mark (messages)
 *   frames     pictures in turn, as a flip-book (the grid)
 *   orbit      the bodies of a table moving, with their trails (orbit)
 *   tries      a check, case by case: what the model answered against what happened
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

const present = (...xs: (Node | null)[]): Node[] => xs.filter((x): x is Node => x !== null);

/** A picture with frames: `draw(i)` shows frame i (0 ≤ i < frames); `ms` is a frame's time at 1×. */
export interface Anim {
  readonly el: Element;
  readonly frames: number;
  readonly ms: number;
  draw(i: number): void;
  /** The scrubber's caption for frame i. */
  label?(i: number): string;
}

export interface Player {
  readonly el: El;
  /** Plays from the start (or from where it is, if it is paused midway); resolves when it reaches the end or is stopped. */
  play(): Promise<void>;
  stop(): void;
}

export const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Every player on the page, so that closing the drawer or stopping a presentation stops them all. */
const live = new Set<Player>();
export function stopAll(): void { for (const p of live) p.stop(); }

export function player(anim: Anim, title?: string): Player {
  let at = anim.frames - 1;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let done: (() => void) | null = null;
  let speed = 1;
  const button = h('button', { class: 'play', type: 'button', 'aria-label': 'Reproducir' }, '▶');
  const scrub = h('input', { type: 'range', min: 0, max: Math.max(0, anim.frames - 1), step: 1, value: at, 'aria-label': 'Paso' }) as HTMLInputElement;
  const caption = h('span', { class: 'play-label' });
  const speedSel = h('select', { 'aria-label': 'Velocidad' }, ...[0.5, 1, 2, 4].map((x) => h('option', { value: x, selected: x === 1 }, x + '×'))) as HTMLSelectElement;
  const show = (i: number) => {
    at = Math.max(0, Math.min(anim.frames - 1, i));
    anim.draw(at);
    scrub.value = String(at);
    caption.textContent = anim.label ? anim.label(at) : at + 1 + ' / ' + anim.frames;
  };
  const halt = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    button.textContent = '▶'; button.setAttribute('aria-label', 'Reproducir');
    const d = done; done = null; d?.();
  };
  const tick = () => {
    if (at >= anim.frames - 1) { halt(); return; }
    show(at + 1);
    timer = setTimeout(tick, anim.ms / speed);
  };
  const p: Player = {
    el: h('div', { class: 'player' }, title ? h('div', { class: 'player-title' }, title) : null, h('div', { class: 'stage' }, anim.el as Node),
      h('div', { class: 'player-bar' }, button, scrub, caption, speedSel)),
    play() {
      halt();
      if (at >= anim.frames - 1) show(0);
      button.textContent = '❚❚'; button.setAttribute('aria-label', 'Pausa');
      live.add(p);
      return new Promise<void>((resolve) => { done = resolve; timer = setTimeout(tick, anim.ms / speed); });
    },
    stop: halt
  };
  button.addEventListener('click', () => { if (timer) halt(); else void p.play(); });
  scrub.addEventListener('input', () => { halt(); show(Number(scrub.value)); });
  speedSel.addEventListener('change', () => { speed = Number(speedSel.value); });
  show(at);
  return p;
}

/* --- What the environment showed ------------------------------------------------------------------------------------ */

/** The symbol filled in a run's pictures of rows (set by the page, the rarer of two over the whole run). */
let filled: string | null = null;
export function setFilled(symbol: string | null): void { filled = symbol; }
export function filledOf(rows: readonly string[]): string | null {
  const counts = new Map<string, number>();
  for (const r of rows) for (const ch of r) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  if (counts.size > 2) return null;
  return filled && (counts.has(filled) || counts.size < 2) ? filled : [...counts.entries()].sort((a, b) => a[1] - b[1])[0]?.[0] ?? null;
}
export const isPicturable = (rows: readonly string[]): boolean => rows.length > 0 && rows.length <= 120 && !!rows[0].length && rows[0].length <= 80
  && rows.every((r) => r.length === rows[0].length) && filledOf(rows) !== null;

/** Rows of two symbols, growing one row per frame, with the row just added marked. */
export function rowsAnim(rows: readonly string[], steps?: readonly number[], cell = 8): Anim | null {
  if (!isPicturable(rows)) return null;
  const width = rows[0].length, on = filledOf(rows);
  const svg = s('svg', { viewBox: '0 0 ' + width * cell + ' ' + rows.length * cell, class: 'spacetime', role: 'img', 'aria-label': rows.length + ' filas de ' + width + ' celdas' });
  svg.append(s('rect', { x: 0, y: 0, width: width * cell, height: rows.length * cell, class: 'st-bg' }));
  const groups = rows.map((r, y) => {
    const g = s('g', {});
    for (let x = 0; x < width; x++) if (r[x] === on) g.append(s('rect', { x: x * cell + 0.5, y: y * cell + 0.5, width: cell - 1, height: cell - 1, rx: 1, class: 'st-on' }));
    svg.append(g);
    return g;
  });
  const head = s('rect', { x: 0, y: 0, width: width * cell, height: cell, class: 'st-head' });
  svg.append(head);
  return {
    el: svg, frames: rows.length, ms: 160,
    draw(i) { groups.forEach((g, y) => g.setAttribute('display', y <= i ? 'inline' : 'none')); head.setAttribute('y', String(i * cell)); head.setAttribute('display', i < rows.length - 1 ? 'inline' : 'none'); },
    label: (i) => 'paso ' + (steps ? steps[i] : i) + ' · ' + (i + 1) + '/' + rows.length
  };
}

/** Texts arriving one by one, each with the mark the environment gave it. */
export function messagesAnim(messages: readonly { step?: number; text: string; mark?: number }[]): Anim | null {
  if (!messages.length) return null;
  const items = messages.map((m) => h('li', {}, m.mark !== undefined ? h('span', { class: 'mark m' + m.mark }, String(m.mark)) : null, ' ', m.text));
  const list = h('ul', { class: 'msgs anim' }, ...items);
  return {
    el: list, frames: messages.length, ms: 1100,
    draw(i) { items.forEach((li, k) => { li.hidden = k > i; li.classList.toggle('now', k === i); }); },
    label: (i) => 'mensaje ' + (messages[i].step ?? i) + ' · ' + (i + 1) + '/' + messages.length
  };
}

/** Pictures in turn, as a flip-book. */
export function framesAnim(frames: readonly { step?: number; picture: string }[]): Anim | null {
  if (!frames.length) return null;
  const pre = h('pre', { class: 'rows frame' });
  return {
    el: pre, frames: frames.length, ms: 700,
    draw(i) { pre.textContent = String(frames[i].picture); },
    label: (i) => 'paso ' + (frames[i].step ?? i) + ' · ' + (i + 1) + '/' + frames.length
  };
}

/** A table of positions ("t", then "<glyph> x", "<glyph> y" per body) read into series. Null when it is not one. */
export function readPositions(table: string): { t: number[]; bodies: { glyph: string; x: number[]; y: number[] }[] } | null {
  const lines = table.split('\n').filter((l) => l.trim());
  if (lines.length < 3) return null;
  const head = lines[0].trim().split(/\s+/);
  if (head[0] !== 't') return null;
  const cols: { glyph: string; axis: string }[] = [];
  for (let i = 1; i + 1 < head.length; i += 2) cols.push({ glyph: head[i], axis: head[i + 1] });
  if (!cols.length || cols.some((c) => c.axis !== 'x' && c.axis !== 'y')) return null;
  const glyphs = [...new Set(cols.map((c) => c.glyph))];
  const bodies = glyphs.map((glyph) => ({ glyph, x: [] as number[], y: [] as number[] }));
  const t: number[] = [];
  for (const line of lines.slice(1)) {
    const v = line.trim().split(/\s+/).map(Number);
    if (v.length !== 1 + cols.length || v.some((n) => !Number.isFinite(n))) continue;
    t.push(v[0]);
    cols.forEach((c, k) => bodies[glyphs.indexOf(c.glyph)][c.axis as 'x' | 'y'].push(v[1 + k]));
  }
  return t.length >= 2 ? { t, bodies } : null;
}

const BODY_CLASSES = ['b0', 'b1', 'b2', 'b3'];

/** Bounds of some points, padded, as a square-ish view. */
function frameOf(xs: number[], ys: number[], W: number, H: number, pad = 18) {
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const span = Math.max(x1 - x0, y1 - y0, 1e-9);
  const k = Math.min((W - 2 * pad) / span, (H - 2 * pad) / span);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return { X: (x: number) => W / 2 + (x - cx) * k, Y: (y: number) => H / 2 - (y - cy) * k };
}

/** The bodies of a table moving, each with its trail. */
export function orbitAnim(table: string): Anim | null {
  const pos = readPositions(table);
  if (!pos) return null;
  const W = 420, H = 320;
  const { X, Y } = frameOf(pos.bodies.flatMap((b) => b.x), pos.bodies.flatMap((b) => b.y), W, H);
  const svg = s('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'orbit', role: 'img', 'aria-label': 'Trayectorias de ' + pos.bodies.length + ' cuerpos' });
  svg.append(s('rect', { x: 0, y: 0, width: W, height: H, class: 'st-bg' }));
  const parts = pos.bodies.map((b, k) => {
    const trail = s('polyline', { class: 'trail ' + BODY_CLASSES[k % 4] });
    const dot = s('circle', { r: 6, class: 'body ' + BODY_CLASSES[k % 4] });
    const tag = s('text', { class: 'body-tag' }); tag.textContent = b.glyph;
    svg.append(trail, dot, tag);
    return { b, trail, dot, tag };
  });
  /* At most ~160 frames: long tables are played with a stride. */
  const stride = Math.max(1, Math.ceil(pos.t.length / 160));
  const frames = Math.ceil(pos.t.length / stride);
  return {
    el: svg, frames, ms: 70,
    draw(f) {
      const i = Math.min(pos.t.length - 1, f * stride);
      for (const { b, trail, dot, tag } of parts) {
        trail.setAttribute('points', b.x.slice(0, i + 1).map((x, j) => X(x).toFixed(1) + ',' + Y(b.y[j]).toFixed(1)).join(' '));
        dot.setAttribute('cx', X(b.x[i]).toFixed(1)); dot.setAttribute('cy', Y(b.y[i]).toFixed(1));
        tag.setAttribute('x', (X(b.x[i]) + 9).toFixed(1)); tag.setAttribute('y', (Y(b.y[i]) - 8).toFixed(1));
      }
    },
    label: (f) => 't = ' + pos.t[Math.min(pos.t.length - 1, f * stride)] + ' · fila ' + Math.min(pos.t.length - 1, f * stride)
  };
}

/* --- What the model tried ----------------------------------------------------------------------------------------- */

export interface CellsTry { point: string; before?: string; answer?: string | null; came?: string; error?: string }
export interface MessagesTry { point: string; text?: string; answer?: number | null; mark?: number; agreed?: boolean; error?: string }
export interface OrbitTry { point: string; band?: string; predicted?: number[]; target?: number[]; error?: string }

/** A strip of cells: one symbol filled; cells marked `wrong` outlined. */
function strip(row: string, on: string | null, wrong: ReadonlySet<number> = new Set(), cell = 12): SVGElement {
  const svg = s('svg', { viewBox: '0 0 ' + row.length * cell + ' ' + cell, class: 'strip', role: 'img', 'aria-label': row });
  svg.append(s('rect', { x: 0, y: 0, width: row.length * cell, height: cell, class: 'st-bg' }));
  for (let x = 0; x < row.length; x++) {
    if (row[x] === on) svg.append(s('rect', { x: x * cell + 1, y: 1, width: cell - 2, height: cell - 2, rx: 2, class: 'st-on' }));
    if (wrong.has(x)) svg.append(s('rect', { x: x * cell + 0.75, y: 0.75, width: cell - 1.5, height: cell - 1.5, rx: 2, class: 'st-wrong' }));
  }
  return svg;
}

/** Cells: at each point, the row before, the model's answer and the row that came, with the cells it got wrong outlined. */
export function cellsTries(tries: readonly CellsTry[]): Anim | null {
  if (!tries.length) return null;
  const on = filledOf(tries.flatMap((t) => [t.before, t.came].filter((r): r is string => typeof r === 'string')));
  const body = h('div', { class: 'tries' });
  const tally = h('div', { class: 'tally' });
  const dots = h('div', { class: 'try-dots' }, ...tries.map(() => h('span', { class: 'try-dot' })));
  const el = h('div', {}, body, tally, dots);
  const exact = tries.map((t) => typeof t.answer === 'string' && t.answer === t.came);
  return {
    el, frames: tries.length, ms: 1200,
    draw(i) {
      const t = tries[i];
      const wrong = new Set<number>();
      const answerIsRow = typeof t.answer === 'string' && typeof t.came === 'string' && t.answer.length === t.came.length;
      if (answerIsRow) for (let k = 0; k < t.came!.length; k++) if (t.answer![k] !== t.came![k]) wrong.add(k);
      const line = (label: string, content: Node | string) => h('div', { class: 'try-row' }, h('span', { class: 'try-label' }, label), content);
      body.replaceChildren(...present(
        h('div', { class: 'try-head' }, h('b', {}, t.point), ' ', exact[i] ? h('span', { class: 'ok' }, '✓ exacta') : h('span', { class: 'bad' }, '✗ ' + (t.error ? 'error' : answerIsRow ? wrong.size + ' celda(s) mal' : 'no es una fila'))),
        typeof t.before === 'string' ? line('antes', strip(t.before, on)) : null,
        line('el modelo', answerIsRow ? strip(t.answer!, on, wrong) : h('code', {}, t.error ?? String(t.answer ?? '—'))),
        typeof t.came === 'string' ? line('lo que vino', strip(t.came, on)) : null));
      const upTo = exact.slice(0, i + 1).filter(Boolean).length;
      tally.textContent = 'exactas hasta aquí: ' + upTo + ' / ' + (i + 1);
      Array.from(dots.children).forEach((d, k) => { d.className = 'try-dot' + (k <= i ? (exact[k] ? ' ok' : ' bad') : '') + (k === i ? ' now' : ''); });
    },
    label: (i) => 'caso ' + (i + 1) + '/' + tries.length
  };
}

/** Messages: each text, the model's answer and the mark the environment gave it. */
export function messagesTries(tries: readonly MessagesTry[]): Anim | null {
  if (!tries.length) return null;
  const body = h('div', { class: 'tries' });
  const tally = h('div', { class: 'tally' });
  const dots = h('div', { class: 'try-dots' }, ...tries.map(() => h('span', { class: 'try-dot' })));
  return {
    el: h('div', {}, body, tally, dots), frames: tries.length, ms: 1500,
    draw(i) {
      const t = tries[i];
      const side = typeof t.answer === 'number' ? (t.answer >= 0.5 ? 1 : 0) : null;
      body.replaceChildren(
        h('div', { class: 'try-head' }, h('b', {}, t.point), ' ', t.agreed ? h('span', { class: 'ok' }, '✓ de acuerdo') : h('span', { class: 'bad' }, '✗ ' + (t.error ? 'error' : side === null ? 'no es un número' : 'en desacuerdo'))),
        h('p', { class: 'try-text' }, t.text ?? ''),
        h('div', { class: 'try-row' }, h('span', { class: 'try-label' }, 'el modelo'), t.error ? h('code', {}, t.error) : h('span', {}, typeof t.answer === 'number' ? String(Math.round(t.answer * 1000) / 1000) + ' → ' : '— ', side !== null ? h('span', { class: 'mark m' + side }, String(side)) : '')),
        h('div', { class: 'try-row' }, h('span', { class: 'try-label' }, 'la marca'), t.mark !== undefined ? h('span', { class: 'mark m' + t.mark }, String(t.mark)) : '—'));
      tally.textContent = 'de acuerdo hasta aquí: ' + tries.slice(0, i + 1).filter((x) => x.agreed).length + ' / ' + (i + 1);
      Array.from(dots.children).forEach((d, k) => { d.className = 'try-dot' + (k <= i ? (tries[k].agreed ? ' ok' : ' bad') : '') + (k === i ? ' now' : ''); });
    },
    label: (i) => 'caso ' + (i + 1) + '/' + tries.length
  };
}

/** Orbit: the answer is a pair of numbers per point. Per launch, each number along its rows: what happened (a line) and
    what the model answered (rings), revealed point after point. The scale is compressed (asinh) so that small and large
    values both show; an answer far off is drawn at the edge. */
export function orbitTries(tries: readonly OrbitTry[]): Anim | null {
  const episodeOf = (t: OrbitTry) => t.point.split('@')[0];
  const rowOf = (t: OrbitTry) => Number(t.point.split('@')[1] ?? 0);
  const order = [...new Set(tries.map(episodeOf))];
  const ok = tries.filter((t) => t.target && t.predicted && t.target.every(Number.isFinite) && t.predicted.every(Number.isFinite))
    .sort((a, b) => order.indexOf(episodeOf(a)) - order.indexOf(episodeOf(b)) || rowOf(a) - rowOf(b));
  if (!ok.length) return null;
  const episodes = [...new Set(ok.map(episodeOf))];
  const W = 420, PH = 130, GAP = 26, L = 34, R = 10, H = 2 * PH + GAP + 22;
  const svg = s('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'orbit', role: 'img', 'aria-label': 'Respuesta del modelo frente a lo que ocurrió, por fila' });
  svg.append(s('rect', { x: 0, y: 0, width: W, height: H, class: 'st-bg' }));
  const tag = s('text', { x: L, y: 14, class: 'body-tag' });
  svg.append(tag);
  const panels = [0, 1].map((axis) => {
    const top = 22 + axis * (PH + GAP);
    const name = s('text', { x: 8, y: top + PH / 2 + 4, class: 'body-tag' }); name.textContent = axis ? 'y' : 'x';
    const zero = s('line', { x1: L, x2: W - R, class: 'grid' });
    const line = s('polyline', { class: 'trail b0' });
    const layer = s('g', {});
    svg.append(name, zero, line, layer);
    return { axis, top, zero, line, layer };
  });
  /* Per launch: the rows it spans and a scale per number. */
  const scales = new Map(episodes.map((ep) => {
    const ts = ok.filter((t) => episodeOf(t) === ep);
    const r0 = rowOf(ts[0]), r1 = Math.max(r0 + 1, rowOf(ts[ts.length - 1]));
    const per = [0, 1].map((axis) => {
      const vs = ts.map((t) => t.target![axis]);
      const mags = vs.map(Math.abs).filter((v) => v > 0).sort((a, b) => a - b);
      const unit = mags.length ? mags[Math.floor(mags.length / 2)] : 1;
      const f = (v: number) => Math.asinh(v / unit);
      const lo = Math.min(...vs.map(f)), hi = Math.max(...vs.map(f));
      const pad = Math.max(0.3, (hi - lo) * 0.1);
      return { f, lo: lo - pad, hi: hi + pad };
    });
    return [ep, { X: (row: number) => L + ((row - r0) / (r1 - r0)) * (W - L - R), per }];
  }));
  const legend = h('div', { class: 'legend' }, h('span', {}, h('span', { class: 'sw came' }), ' lo que ocurrió'), h('span', {}, h('span', { class: 'sw guess' }), ' lo que respondió el modelo'));
  return {
    el: h('div', {}, svg, legend), frames: ok.length, ms: 140,
    draw(i) {
      const ep = episodeOf(ok[i]);
      const sc = scales.get(ep)!;
      const shown = ok.slice(0, i + 1).filter((t) => episodeOf(t) === ep);
      for (const p of panels) {
        const { f, lo, hi } = sc.per[p.axis];
        const Y = (v: number) => p.top + PH - ((Math.max(lo, Math.min(hi, f(v))) - lo) / (hi - lo)) * PH;
        p.zero.setAttribute('y1', Y(0).toFixed(1)); p.zero.setAttribute('y2', Y(0).toFixed(1));
        p.line.setAttribute('points', shown.map((t) => sc.X(rowOf(t)).toFixed(1) + ',' + Y(t.target![p.axis]).toFixed(1)).join(' '));
        p.layer.replaceChildren(...shown.map((t, k) => {
          const g = s('g', { class: k === shown.length - 1 ? 'now' : '' });
          const x = sc.X(rowOf(t)), ty = Y(t.target![p.axis]), py = Y(t.predicted![p.axis]);
          g.append(s('line', { x1: x, y1: ty, x2: x, y2: py, class: 'miss' }), s('circle', { cx: x, cy: ty, r: 2.5, class: 'came' }), s('circle', { cx: x, cy: py, r: 4.5, class: 'guess' }));
          return g;
        }));
      }
      tag.textContent = ep + ' (' + (episodes.indexOf(ep) + 1) + '/' + episodes.length + ') · por fila, escala comprimida';
    },
    label: (i) => ok[i].point + (ok[i].band ? ' (' + ok[i].band + ')' : '') + ' · ' + (i + 1) + '/' + ok.length
  };
}

/** The animation of a place's trace, by what its cases carry. */
export function triesAnim(trace: readonly Record<string, unknown>[]): Anim | null {
  if (!trace.length) return null;
  const t = trace[0];
  if ('came' in t || 'before' in t) return cellsTries(trace as unknown as CellsTry[]);
  if ('text' in t || 'mark' in t) return messagesTries(trace as unknown as MessagesTry[]);
  if ('target' in t || 'predicted' in t || trace.some((x) => 'target' in x)) return orbitTries(trace as unknown as OrbitTry[]);
  return null;
}

/** Plays players one after another; resolves when the last one ends (or the chain was cut). */
export async function playInTurn(players: readonly Player[], cut: () => boolean): Promise<void> {
  for (const p of players) {
    if (cut()) return;
    p.el.scrollIntoView?.({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
    await p.play();
  }
}
