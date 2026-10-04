import fs from 'node:fs';
import path from 'node:path';
import type { Rule } from '../core/types.ts';
import { linksOf } from './links.ts';
import { LINK_QUESTIONS, OBSERVATION_QUESTIONS, ROUND_QUESTIONS, linkTexts, roundTexts } from './judge.ts';
import { FACT_QUESTION, factTexts, recordedPoints } from './facts.ts';
import { auditFile, type MethodAudit } from './audit.ts';

/* ============================================================================
 * THE METHOD AUDIT, calibrated against a person (SPEC-AUDITORIA-METODO §7, MA4). Before the
 * Judge's answers are believed, the operator labels a sample of what it judged - the same texts,
 * the same questions, the same options - WITHOUT seeing the Judge's answers (no anchoring), and
 * the agreement is measured per question. A question the Judge and the person do not agree on is
 * reformulated, or moved to code.
 *
 *   sample:    a stratified sample of judged items of audited runs (experiments, observations,
 *              stretches, facts), with the reference cases the operator names; `label@1`, blind.
 *   page:      a page to label it, on its own (no server): the answers are saved in the browser
 *              and downloaded as the same file, filled.
 *   agreement: per question, how often the person and the Judge agree, Cohen's kappa, the
 *              confusion, and the agreement when the Judge was sure and when it was not.
 * ========================================================================== */

type J = Record<string, any>;

export type Unit = 'experiment' | 'observation' | 'stretch' | 'fact';

export interface LabelItem {
  /** "<run>#<unit id>": a link ("r6.s2"), a stretch ("r9", "r10.reflection") or a fact ("fact:r3/2", its source and its place). */
  readonly id: string;
  readonly run: string;
  readonly unit: Unit;
  readonly ref: string;
  /** When the audit it comes from was made: the agreement is measured against that audit's answers. */
  readonly audited: string;
  /** Exactly what the Judge was shown. */
  readonly texts: Readonly<Record<string, string>>;
  readonly questions: Readonly<Record<string, { readonly instructions: string; readonly options: Readonly<Record<string, string>> }>>;
  /** The operator's answers, an option per question, or "skip". Empty in the sample. */
  readonly operator: Record<string, string>;
  /** Named by the operator as a reference case (SPEC §7). */
  readonly reference?: boolean;
}

export interface LabelFile { readonly format: 'label@1'; readonly created: string; readonly runs: readonly string[]; readonly items: LabelItem[] }

const asQuestions = (rules: Readonly<Record<string, Rule>>) => Object.fromEntries(Object.entries(rules).map(([id, r]) => [id, { instructions: r.instructions, options: r.criteria as Record<string, string> }]));

/** Every item a run's audit had judged, with what the Judge was shown. */
export function judgedItems(journalFile: string): LabelItem[] {
  const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8')) as J;
  const audit = JSON.parse(fs.readFileSync(auditFile(journalFile), 'utf8')) as MethodAudit;
  if (!audit.judged && !audit.extracted) throw new Error(path.basename(journalFile) + ': its audit has no judgements (audit it without --flat)');
  const run = path.basename(journalFile, '.json');
  const record = linksOf(journal);
  const item = (unit: Unit, ref: string, texts: Record<string, string>, rules: Readonly<Record<string, Rule>>): LabelItem =>
    ({ id: run + '#' + ref, run, unit, ref, audited: audit.audited, texts, questions: asQuestions(rules), operator: {} });
  const out: LabelItem[] = [];
  for (const l of record.links) {
    if (audit.judged?.links[l.id]) out.push(item('experiment', l.id, linkTexts(l), LINK_QUESTIONS));
    if (audit.judged?.observations?.[l.id]) out.push(item('observation', l.id, linkTexts(l), OBSERVATION_QUESTIONS));
  }
  for (const s of record.rounds) if (audit.judged?.rounds[s.id]) out.push(item('stretch', s.id, roundTexts(s, record), ROUND_QUESTIONS));
  const recorded = recordedPoints(record);
  for (const src of audit.extracted?.sources ?? []) src.claims.forEach((c, k) => {
    if (c.check?.distribution) out.push(item('fact', 'fact:' + src.id + '/' + k, factTexts(c.text, c.check.points, recorded), FACT_QUESTION));
  });
  return out;
}

/** A stratified sample: the reference cases named, then the units in turn (experiments, observations, stretches, facts), each
    drawn at random with the seed; the same seed draws the same sample. */
export function sample(journalFiles: readonly string[], options: { n?: number; seed?: number; references?: readonly string[] } = {}): LabelFile {
  const all = journalFiles.flatMap(judgedItems);
  const refs = new Set(options.references ?? []);
  const chosen: LabelItem[] = all.filter((i) => refs.has(i.id) || refs.has(i.ref)).map((i) => ({ ...i, reference: true }));
  let state = (options.seed ?? 1) >>> 0;
  const rnd = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
  const pools = (['experiment', 'observation', 'stretch', 'fact'] as Unit[]).map((u) => {
    const pool = all.filter((i) => i.unit === u && !chosen.some((c) => c.id === i.id));
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    return pool;
  });
  const n = options.n ?? 30;
  while (chosen.length < n && pools.some((p) => p.length)) for (const p of pools) if (p.length && chosen.length < n) chosen.push(p.shift()!);
  return { format: 'label@1', created: new Date().toISOString(), runs: journalFiles.map((f) => path.basename(f, '.json')), items: chosen };
}

/** The Judge's answer to one question of an item, from the audit the item came from. */
function judgeAnswer(audit: MethodAudit, item: LabelItem, question: string): { answer: string; p: number } | null {
  if (item.unit === 'fact') {
    const [, ref] = /^fact:(.+)$/.exec(item.ref) ?? [];
    const cut = ref ? ref.lastIndexOf('/') : -1;
    const claim = cut < 0 ? undefined : audit.extracted?.sources.find((s) => s.id === ref.slice(0, cut))?.claims[Number(ref.slice(cut + 1))];
    const best = Object.entries(claim?.check?.distribution ?? {}).sort(([, a], [, b]) => b - a)[0];
    return best ? { answer: best[0], p: best[1] } : null;
  }
  const table = item.unit === 'experiment' ? audit.judged?.links : item.unit === 'observation' ? audit.judged?.observations : audit.judged?.rounds;
  const v = table?.[item.ref]?.[question];
  return v ? { answer: v.answer, p: v.p } : null;
}

export interface QuestionAgreement {
  readonly question: string;
  readonly n: number;
  readonly agreement: number | null;
  readonly kappa: number | null;
  /** Rows: the operator's answer; columns: the Judge's. */
  readonly confusion: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** Agreement where the Judge gave its answer a probability of 0.7 or more, and where less. */
  readonly when_sure: { readonly n: number; readonly agreement: number | null };
  readonly when_unsure: { readonly n: number; readonly agreement: number | null };
  /** usable (kappa >= 0.6 on 10 or more), reformulate (kappa < 0.4 on 10 or more), or too_few / uncertain. */
  readonly reading: 'usable' | 'uncertain' | 'reformulate' | 'too_few';
  readonly disagreements: readonly { item: string; operator: string; judge: string; p: number }[];
}

const ratio = (a: number, b: number): number | null => (b ? Math.round(a / b * 1000) / 1000 : null);

/** Cohen's kappa of two labelings of the same items. */
export function kappa(pairs: readonly [string, string][]): number | null {
  if (!pairs.length) return null;
  const n = pairs.length;
  const po = pairs.filter(([a, b]) => a === b).length / n;
  const labels = [...new Set(pairs.flat())];
  const pe = labels.reduce((s, l) => s + (pairs.filter(([a]) => a === l).length / n) * (pairs.filter(([, b]) => b === l).length / n), 0);
  return pe === 1 ? null : Math.round((po - pe) / (1 - pe) * 1000) / 1000;
}

/** The agreement between the operator's labels and the Judge's answers, per question (a question id per unit: "experiment.reading"). */
export function agreement(labels: LabelFile, journalOf: (run: string) => string): { questions: QuestionAgreement[]; labelled: number; stale: string[] } {
  const audits = new Map<string, MethodAudit>();
  const stale: string[] = [];
  const pairs = new Map<string, { item: string; operator: string; judge: string; p: number }[]>();
  let labelled = 0;
  for (const item of labels.items) {
    if (!Object.values(item.operator ?? {}).some((a) => a && a !== 'skip')) continue;
    labelled++;
    if (!audits.has(item.run)) audits.set(item.run, JSON.parse(fs.readFileSync(auditFile(journalOf(item.run)), 'utf8')));
    const audit = audits.get(item.run)!;
    if (audit.audited !== item.audited) { stale.push(item.id); continue; }
    for (const [q, mine] of Object.entries(item.operator)) {
      if (!mine || mine === 'skip') continue;
      const j = judgeAnswer(audit, item, q);
      if (!j) continue;
      const key = item.unit + '.' + q;
      pairs.set(key, [...(pairs.get(key) ?? []), { item: item.id, operator: mine, judge: j.answer, p: j.p }]);
    }
  }
  const questions = [...pairs.entries()].map(([question, ps]): QuestionAgreement => {
    const agree = ps.filter((x) => x.operator === x.judge).length;
    const k = kappa(ps.map((x) => [x.operator, x.judge]));
    const confusion: Record<string, Record<string, number>> = {};
    for (const x of ps) { confusion[x.operator] ??= {}; confusion[x.operator][x.judge] = (confusion[x.operator][x.judge] ?? 0) + 1; }
    const sure = ps.filter((x) => x.p >= 0.7), unsure = ps.filter((x) => x.p < 0.7);
    const reading = ps.length < 10 ? 'too_few' : k !== null && k >= 0.6 ? 'usable' : k !== null && k < 0.4 ? 'reformulate' : 'uncertain';
    return { question, n: ps.length, agreement: ratio(agree, ps.length), kappa: k, confusion,
      when_sure: { n: sure.length, agreement: ratio(sure.filter((x) => x.operator === x.judge).length, sure.length) },
      when_unsure: { n: unsure.length, agreement: ratio(unsure.filter((x) => x.operator === x.judge).length, unsure.length) },
      reading, disagreements: ps.filter((x) => x.operator !== x.judge) };
  }).sort((a, b) => a.question.localeCompare(b.question));
  return { questions, labelled, stale };
}

/** A page to label a sample on its own: no server, the answers kept in the browser as they are given, and downloaded as the
    same file with them filled. The Judge's answers are not in it. */
export function labelPage(labels: LabelFile): string {
  const data = JSON.stringify(labels).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Etiquetado de la auditoría</title>
<style>
:root { --bg: #fbfbf9; --fg: #1d1d1b; --muted: #6b6a64; --line: #deddd6; --accent: #2a78d6; --card: #ffffff; --ok: #0c7a0c; }
@media (prefers-color-scheme: dark) { :root { --bg: #161615; --fg: #ecebe6; --muted: #9c9b94; --line: #34332f; --accent: #5aa0ef; --card: #1f1f1d; --ok: #4fc04f; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
main { max-width: 980px; margin: 0 auto; padding: 16px; }
header { position: sticky; top: 0; background: var(--bg); padding: 8px 0; border-bottom: 1px solid var(--line); display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 14px; margin: 14px 0; }
.card.done { border-color: var(--ok); }
h2 { font-size: 15px; margin: 0 0 6px; } .muted { color: var(--muted); font-size: 13px; }
details { margin: 6px 0; } summary { cursor: pointer; color: var(--accent); }
pre { white-space: pre-wrap; word-break: break-word; background: var(--bg); border: 1px solid var(--line); padding: 8px; border-radius: 6px; font: 13px/1.35 ui-monospace, monospace; max-height: 420px; overflow: auto; }
fieldset { border: 1px solid var(--line); border-radius: 6px; margin: 10px 0; } legend { font-weight: 600; }
label { display: block; padding: 2px 0; } button { font: inherit; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--line); background: var(--card); color: var(--fg); cursor: pointer; }
button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
</style></head><body><main>
<header><strong>Etiquetado ciego</strong><span id="progress" class="muted"></span><button class="primary" id="save">Descargar etiquetas</button>
<span class="muted">Responde con lo que muestran los textos, como lo haría el juez. "skip" si no puedes decidir.</span></header>
<div id="items"></div></main>
<script>
const labels = ${data};
const key = 'audit-labels:' + labels.created;
try { const kept = JSON.parse(localStorage.getItem(key) || '{}'); for (const it of labels.items) if (kept[it.id]) it.operator = kept[it.id]; } catch (e) {}
const keep = () => { try { localStorage.setItem(key, JSON.stringify(Object.fromEntries(labels.items.map((i) => [i.id, i.operator])))); } catch (e) {} };
const el = (tag, attrs, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs || {})) { if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); } for (const c of kids) e.append(c); return e; };
const done = (it) => Object.keys(it.questions).every((q) => it.operator[q]);
function progress() { document.getElementById('progress').textContent = labels.items.filter(done).length + ' de ' + labels.items.length + ' completos'; }
const root = document.getElementById('items');
labels.items.forEach((it, n) => {
  const card = el('div', { class: 'card' + (done(it) ? ' done' : '') });
  card.append(el('h2', {}, (n + 1) + '. ' + it.unit + ' ' + it.ref + (it.reference ? ' (caso de referencia)' : '')), el('div', { class: 'muted' }, it.run));
  for (const [name, text] of Object.entries(it.texts)) card.append(el('details', name === 'shown' || name === 'timeline' || name === 'claim' ? { open: '' } : {}, el('summary', {}, name), el('pre', {}, text)));
  for (const [q, def] of Object.entries(it.questions)) {
    const fs = el('fieldset', {}, el('legend', {}, q), el('div', { class: 'muted' }, def.instructions));
    for (const [opt, desc] of [...Object.entries(def.options), ['skip', 'I cannot decide']]) {
      const input = el('input', { type: 'radio', name: it.id + '/' + q, value: opt, onchange: () => { it.operator[q] = opt; keep(); card.className = 'card' + (done(it) ? ' done' : ''); progress(); } });
      if (it.operator[q] === opt) input.checked = true;
      fs.append(el('label', {}, input, ' ' + opt + ': ' + desc));
    }
    card.append(fs);
  }
  root.append(card);
});
progress();
document.getElementById('save').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(labels, null, 2)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: 'labels.json' }); document.body.append(a); a.click(); a.remove();
});
</script></body></html>
`;
}
