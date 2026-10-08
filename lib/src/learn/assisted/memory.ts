import type { Notebook } from '../notebook.ts';
import type { LineSelector, SelectionRecord } from './sources.ts';

/* ============================================================================
 * SELECTIVE MEMORY for the assisted researcher (SPEC-INVESTIGADOR-ASISTIDO §13): an instrument like
 * `view` or `act`, but over ITS OWN record instead of the world.
 *
 * Without it, the whole notebook travels with every question: a small model drags it all and loses
 * the thread. With it, the notebook travels abridged by a fixed, declared rule (`brief`); the
 * round's own investigation travels whole, as always (hiding what it has just seen made it ask
 * again); and the rest is there to ask for:
 *
 *   {"memory": "list", "of": "<kind>"}             the index of a kind (ids, rounds, the first words)
 *   {"memory": "open", "items": ["<id>", ...]}     items whole
 *   {"memory": "find", "words": "...", "of"?}      the items that hold all the words
 *   ... "select": "what you need"                  the Judge picks, of the items found, those that
 *                                                  speak to it (at the researcher's choice)
 *
 * Nothing is summarised for it: an item is what it wrote or what it was answered, whole; the
 * index shows the first words of what it wrote. The rule of what travels is mechanical (by
 * round), never chosen by the environment. Its record is its own: the researcher's view only,
 * never anything hidden from it.
 * ========================================================================== */

export const MEMORY_KINDS = ['beliefs', 'notes', 'methods', 'episodes', 'models', 'reflections', 'investigations', 'checks'] as const;
export type MemoryKind = typeof MEMORY_KINDS[number];

interface Item { readonly id: string; readonly kind: MemoryKind | 'documents'; readonly round: number; readonly head: string; readonly body: unknown }

/** What the researcher is told once it has a selective memory (appended to its system prompt). */
export const MEMORY_SECTION = [
  'YOUR MEMORY. Your notebook reaches you ABRIDGED, by a fixed rule: your beliefs with their latest stance only; your notes written or updated in the last two rounds whole, older ones by their first words; your methods whole; the episodes of the last two rounds; one line per model, and your latest model whole; your latest reflection. This round\'s investigation travels whole, as always. Everything else (your earlier rounds\' investigations too) is kept, whole, in your memory: `memory` says how many items of each kind it holds.',
  'Three more investigation requests read it (they ask nothing of the environment); like any request, they go inside "investigate": {"investigate": [{"memory": "list", "of": "notes"}, ...]}. {"memory": "list", "of": "beliefs" | "notes" | "methods" | "episodes" | "models" | "reflections" | "investigations" | "checks"} answers the index of that kind (ids, rounds, first words); {"memory": "open", "items": ["<id>", ...]} answers items whole (at most 8); {"memory": "find", "words": "...", "of": "<kind>" (optional)} answers the items that hold all the words. When a find answers too many items, add "select": "what you need": the Judge then picks, of the items found, those that speak to it (by what they are about, not by whether they agree with you - an item that contradicts you speaks to it too).',
  'Item ids: "belief:<id>", "note:<id>", "method:<id>", "episode:<episode>", "model:r<round>", "reflection:r<round>", "investigation:r<round>.<step>" (a request and what it answered), "check:r<round>" (the verdicts you were given). An answer whose requests are ALL memory requests does not count against `steps_left`: `memory_answers_left` says how many such answers you still have this round. With no steps left, only the memory requests of an answer are answered; then propose.',
  'A note you no longer need to see every round can be archived: {"do": "archive", "id": "<id>"} in "notes". It stays in your memory; writing it again brings it back.',
  'What you recall is your own record, not new evidence: what the environment answers decides.'
].join('\n');

const clip = (text: string, n: number): string => (text.length > n ? text.slice(0, n - 1) + '…' : text);
const fold = (s: string): string => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
/** Results travel as the score the interface speaks of (1, 0, -1), never as words of a game. */
const score = (r: string): number | string => (r === 'won' ? 1 : r === 'lost' ? -1 : r === 'draw' ? 0 : r);
/** An answer of only memory requests is free, this many times a round. */
export const FREE_MEMORY_ANSWERS = 4;
const SHOWN = 30;

export interface MemoryOptions {
  /** The selector of `find` (the Judge); none in a run without one. */
  readonly selector?: LineSelector;
  readonly onSelect?: (record: SelectionRecord & { readonly items: readonly string[]; readonly kept?: readonly string[] }) => void;
  /** Where its episodes and its models are kept when the notebook does not keep them (a world whose model is a law keeps
      them itself): each as the researcher is shown it. Default: the notebook's. */
  readonly episodes?: () => readonly EpisodeEntry[];
  readonly models?: () => readonly ModelEntry[];
  /** Items larger than this many characters are opened clipped (their beginning, and how large they are), unless the
      request asks for them `"whole": true`. None by default: the researcher's own memory opens items whole. */
  readonly openLimit?: number;
}

/** An episode as the researcher's index shows it. */
export type EpisodeEntry = Readonly<Record<string, unknown>> & { readonly episode: string; readonly round: number };
/** A model it proposed, whole, as it is shown it; `brief` keeps the latest whole and the others by these fields. */
export type ModelEntry = Readonly<Record<string, unknown>> & { readonly round: number; readonly fingerprint: string; readonly model: unknown };

export class JournalMemory {
  private readonly notebook: Notebook;
  private readonly options: MemoryOptions;
  private readonly investigations: Item[] = [];
  private readonly checks: Item[] = [];

  constructor(notebook: Notebook, options: MemoryOptions = {}) { this.notebook = notebook; this.options = options; }

  /** Whether an investigation request is one of these. */
  static accepts(q: Record<string, unknown>): boolean { return typeof q.memory === 'string'; }

  /** A step of the round's investigation, as it was asked and answered. */
  recordInvestigation(round: number, step: number, entry: { requests: unknown; results: unknown; warnings?: unknown }): void {
    const kinds = Array.isArray(entry.requests) ? entry.requests.map((r) => Object.keys((r ?? {}) as object).find((k) => !['from', 'to', 'on', 'of', 'items', 'words', 'select', 'model'].includes(k)) ?? '?') : [];
    this.investigations.push({ id: 'investigation:r' + round + '.' + step, kind: 'investigations', round, head: kinds.join(', '), body: entry });
  }

  /** The verdicts it was given at a round's check, as it was given them. */
  recordCheck(round: number, view: unknown): void {
    if (!view || this.checks.some((c) => c.round === round)) return;
    this.checks.push({ id: 'check:r' + round, kind: 'checks', round, head: clip(JSON.stringify(view), 120), body: view });
  }

  /** Every item, built from the notebook as it is now and what was recorded. */
  private items(): Item[] {
    const nb = this.notebook;
    return [
      ...[...nb.beliefs.values()].map((b) => ({ id: 'belief:' + b.id, kind: 'beliefs' as const, round: b.history[b.history.length - 1]?.round ?? b.since,
        head: '[' + b.status + '] ' + clip(b.statement, 140), body: b })),
      ...[...nb.notes.values()].map((n) => ({ id: 'note:' + n.id, kind: 'notes' as const, round: n.updated, head: (n.archived ? '[archived] ' : '') + clip(n.text, 140),
        body: { id: n.id, text: n.text, points: n.positions, written_round: n.written, updated_round: n.updated, ...(n.archived ? { archived: true } : {}) } })),
      ...[...nb.methods.values()].map((m) => ({ id: 'method:' + m.id, kind: 'methods' as const, round: m.updated, head: clip(m.text, 140), body: m })),
      ...(this.options.episodes ? this.options.episodes().map((e) => ({ id: 'episode:' + e.episode, kind: 'episodes' as const, round: e.round,
        head: clip(JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'episode' && k !== 'round'))), 140), body: e }))
        : nb.games.map((g) => ({ id: 'episode:' + g.id, kind: 'episodes' as const, round: g.round, head: 'score ' + score(g.result) + ', ' + g.turns + ' steps, ' + g.how,
        body: { episode: g.id, round: g.round, chosen_by: g.how, score: score(g.result), steps: g.turns } }))),
      ...(this.options.models ? this.options.models().map((m) => ({ id: 'model:r' + m.round, kind: 'models' as const, round: m.round,
        head: clip(JSON.stringify(Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'model'))), 140), body: m })) : []),
      ...(this.options.models ? [] : nb.rounds).map((r) => ({ id: 'model:r' + r.round, kind: 'models' as const, round: r.round,
        head: r.fingerprint + (r.games.length ? ', scored 1 in ' + r.games.reduce((a, g) => a + g.wins, 0) + ' of ' + r.games.reduce((a, g) => a + g.of, 0) : '') + ': ' + Object.keys(r.formula.observations).join(', '),
        body: { round: r.round, fingerprint: r.fingerprint, model: r.formula, ...(r.changes ? { changes: r.changes } : {}), episodes: r.games.map((g) => ({ scores: g.results.map(score), scored_1: g.wins, of: g.of })),
          lessons: r.lessons, next_experiment: r.next_experiment } })),
      /* Its own documents (SPEC-INVESTIGADOR-ASISTIDO §14.1): a kind only once it has one, so a record without them reads
         as it did. */
      ...[...nb.documents.values()].map((d) => ({ id: 'document:' + d.id, kind: 'documents' as const, round: d.updated, head: clip(d.text, 140),
        body: { id: d.id, text: d.text, written_round: d.written, updated_round: d.updated, versions: d.versions } })),
      ...nb.reflections.map((r) => ({ id: 'reflection:r' + r.round, kind: 'reflections' as const, round: r.round, head: clip(r.rationale || r.lessons.join(' '), 140), body: r })),
      ...this.investigations,
      ...this.checks
    ];
  }

  /** How many items of each kind it holds. */
  counts(): Record<string, number> {
    const all = this.items();
    return Object.fromEntries(this.kinds().map((k) => [k, all.filter((i) => i.kind === k).length]));
  }

  /** The kinds it holds: `documents` once it has written one. */
  private kinds(): string[] {
    return [...MEMORY_KINDS, ...(this.notebook.documents.size ? ['documents'] : [])];
  }

  /** The notebook as it travels by default: the fixed rule (MEMORY_SECTION), at `round`. */
  brief(round: number, unaddressed: readonly string[] = []): Record<string, unknown> {
    const nb = this.notebook;
    const recent = (r: number): boolean => r >= round - 1;
    const beliefs = [...nb.beliefs.values()];
    const last = nb.rounds[nb.rounds.length - 1];
    const notes = [...nb.notes.values()].filter((n) => !n.archived);
    const reflection = nb.reflections[nb.reflections.length - 1];
    return {
      beliefs_held: beliefs.filter((b) => b.status !== 'dropped').map((b) => {
        const h = b.history[b.history.length - 1];
        return { id: b.id, statement: b.statement, status: b.status, since_round: b.since,
          latest: 'round ' + h.round + ': ' + h.stance + (h.why ? ' - ' + clip(h.why, 200) : '') + (h.evidence.length ? ' [' + h.evidence.join(', ') + ']' : ''),
          ...(b.history.length > 1 ? { earlier_stances: b.history.length - 1 } : {}) };
      }),
      beliefs_dropped: beliefs.filter((b) => b.status === 'dropped').map((b) => ({ id: b.id, statement: clip(b.statement, 160) })),
      ...(unaddressed.length ? { you_took_no_stance_on: [...unaddressed] } : {}),
      notes: notes.map((n) => recent(n.updated)
        ? { id: n.id, text: n.text, points: n.positions, written_round: n.written, updated_round: n.updated }
        : { id: n.id, first_words: clip(n.text, 160), updated_round: n.updated }),
      ...(nb.notes.size > notes.length ? { notes_archived: nb.notes.size - notes.length } : {}),
      methods: [...nb.methods.values()].map((m) => ({ id: m.id, text: m.text, written_round: m.written, updated_round: m.updated })),
      episodes: this.options.episodes ? this.options.episodes().filter((e) => recent(e.round))
        : nb.games.filter((g) => recent(g.round)).map((g) => ({ episode: g.id, round: g.round, chosen_by: g.how, score: score(g.result), steps: g.turns })),
      models: this.options.models ? this.options.models().map((m, i, all) => (i === all.length - 1 ? m : Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'model'))))
        : nb.rounds.map((r) => r === last
        ? { round: r.round, fingerprint: r.fingerprint, model: r.formula, ...(r.changes ? { changes: r.changes } : {}), episodes: r.games.map((g) => ({ scores: g.results.map(score), scored_1: g.wins, of: g.of })) }
        : { round: r.round, fingerprint: r.fingerprint, scored_1: r.games.reduce((a, g) => a + g.wins, 0), of: r.games.reduce((a, g) => a + g.of, 0) }),
      ...(reflection ? { latest_reflection: reflection } : {}),
      ...(last ? { your_last_lessons: last.lessons, your_planned_next_experiment: last.next_experiment } : {})
    };
  }

  /** One of these requests, answered. */
  async run(q: Record<string, unknown>): Promise<unknown> {
    const what = String(q.memory);
    const of = typeof q.of === 'string' ? q.of : null;
    if (of !== null && !this.kinds().includes(of)) return { memory: what, error: '"of" is one of ' + this.kinds().join(', ') };
    const pool = this.items().filter((i) => of === null || i.kind === of);
    if (what === 'list') {
      if (of === null) return { memory: 'list', items: this.counts(), note: 'add "of": <kind> for the index of a kind' };
      const shown = pool.slice(-60);
      return { memory: 'list', of, total: pool.length, index: shown.map((i) => ({ id: i.id, round: i.round, first_words: i.head })),
        ...(pool.length > shown.length ? { note: 'the latest ' + shown.length + ' of ' + pool.length + '; find reaches every one' } : {}) };
    }
    if (what === 'open') {
      const ids = (Array.isArray(q.items) ? q.items : typeof q.item === 'string' ? [q.item] : []).map(String).slice(0, 8);
      if (!ids.length) return { memory: 'open', error: '"items": the ids to open' };
      const all = this.items();
      const limit = q.whole === true ? undefined : this.options.openLimit;
      return { memory: 'open', items: ids.map((id) => {
        const it = all.find((i) => i.id === id);
        if (!it) return { id, error: 'no such item' };
        const text = limit ? JSON.stringify(it.body) : '';
        return limit && text.length > limit
          ? { id, round: it.round, clipped: { size: text.length, beginning: text.slice(0, limit) }, note: 'clipped: open it with "whole": true to read it entire' }
          : { id, round: it.round, item: it.body };
      }) };
    }
    if (what === 'find') {
      const words = typeof q.words === 'string' ? q.words : typeof q.find === 'string' ? q.find : '';
      const terms = fold(words).split(/\s+/).filter(Boolean);
      const select = typeof q.select === 'string' && q.select.trim() ? q.select : null;
      const head = { memory: 'find', words, ...(of ? { of } : {}), ...(select ? { select } : {}) };
      if (!terms.length) return { ...head, error: '"words": what to find' };
      const found = pool.map((i) => ({ i, text: JSON.stringify(i.body) })).filter((x) => terms.every((t) => fold(x.text).includes(t)))
        .map(({ i, text }) => {
          const at = Math.max(0, fold(text).indexOf(terms[0]) - 100);
          return { id: i.id, round: i.round, first_words: i.head, excerpt: (at > 0 ? '…' : '') + clip(text.slice(at), 320) };
        });
      if (select) {
        if (!this.options.selector) return { ...head, matches: found.length, items: found.slice(0, SHOWN), note: 'there is no Judge in this run: "select" is not available' };
        const candidates = found.slice(0, 120);
        try {
          const scores = candidates.length ? await this.options.selector(select, candidates.map((f) => f.first_words + ' | ' + f.excerpt)) : [];
          if (scores.length !== candidates.length || (candidates.length && scores.every((s) => !Number.isFinite(s)))) throw new Error('the Judge gave no scores');
          const picked = candidates.map((f, k) => ({ f, s: Number.isFinite(scores[k]) ? scores[k] : 0 })).filter((x) => x.s > 0).sort((x, y) => y.s - x.s).slice(0, 12).map((x) => x.f);
          this.options.onSelect?.({ need: select, lines: candidates.length, scores, items: candidates.map((f) => f.id), kept: picked.map((f) => f.id) });
          return { ...head, matches: found.length, selected: picked.length, items: picked,
            ...(found.length > candidates.length ? { note: 'the Judge saw the first ' + candidates.length + ' of ' + found.length + ' items' } : {}) };
        } catch (e) {
          const error = String((e as Error)?.message ?? e);
          this.options.onSelect?.({ need: select, lines: candidates.length, error, items: candidates.map((f) => f.id) });
          return { ...head, matches: found.length, items: found.slice(0, SHOWN), note: 'the Judge could not select (' + error.slice(0, 80) + '): the first items found' };
        }
      }
      return { ...head, matches: found.length, items: found.slice(0, SHOWN),
        ...(found.length > SHOWN ? { note: found.length + ' items hold these words: the first ' + SHOWN + ' are shown. Use other words, "of": <kind>, or "select": "what you need".' } : {}) };
    }
    return { memory: what, error: 'memory is "list", "open" or "find"' };
  }
}
