import { Notebook, type BeliefStance, type Method, type Note, type NotebookBelief, type NoteOp } from '../learn/notebook.ts';
import { MEMORY_KINDS, type JournalMemory } from '../learn/assisted/memory.ts';

/* ============================================================================
 * The SENIOR as a researcher with a memory of its own (SPEC-ORQUESTADOR §3.3.1).
 *
 *   its conversation   one for the whole run, that only grows: its opening (its notebook and the
 *                      run so far), then for each decision only what is new - the rounds completed
 *                      since, why it is called, its readings, what it decided. Nothing sent is
 *                      rewritten, so each decision reuses the prefix of every earlier one (what a
 *                      provider's cache keeps). It consolidates it itself, as the junior does its
 *                      round: the harness never summarises for it.
 *   its notebook       beliefs with stances and evidence from the junior's record, notes, methods -
 *                      the junior's Notebook, written with the same fields in any of its answers.
 *                      Its own: the junior never sees it.
 *   its memory         list / open / find read its own notebook and decisions too (`my_*`), next to
 *                      the junior's record.
 *   its state          kept in its record (`agent@1`, field `senior`): a run resumed loads the state
 *                      of the run it derives from, and the senior goes on where it was.
 * ========================================================================== */

type J = Record<string, any>;

/** What survives between its decisions and across a resumed run. */
export interface SeniorState {
  notebook: { beliefs: NotebookBelief[]; notes: Note[]; methods: Method[] };
  /** Its conversation since its latest consolidation: the opening first, then what each decision added. */
  conversation: Record<string, unknown>[];
  /** The latest round of the junior's run its conversation has been given. */
  since: number;
  consolidations: number;
  /** Its messages already followed up (by their place among its messages), and rounds it was called during. */
  followed_up: number[];
  called_in_round: number[];
}

export const emptySeniorState = (): SeniorState => ({ notebook: { beliefs: [], notes: [], methods: [] }, conversation: [], since: 0, consolidations: 0, followed_up: [], called_in_round: [] });

/** Its notebook, from its state. */
export function seniorNotebook(state: SeniorState): Notebook {
  const nb = new Notebook();
  for (const b of state.notebook.beliefs) nb.beliefs.set(b.id, JSON.parse(JSON.stringify(b)));
  for (const n of state.notebook.notes) nb.notes.set(n.id, { ...n, positions: [...(n.positions ?? [])] });
  for (const m of state.notebook.methods) nb.methods.set(m.id, { ...m });
  return nb;
}

export function keepNotebook(state: SeniorState, nb: Notebook): void {
  state.notebook = { beliefs: [...nb.beliefs.values()], notes: [...nb.notes.values()], methods: [...nb.methods.values()] };
}

/** Its notebook as it travels: every belief held with its latest stance, its notes and its methods whole. */
export function notebookBrief(nb: Notebook): Record<string, unknown> {
  const beliefs = [...nb.beliefs.values()];
  return {
    beliefs_held: beliefs.filter((b) => b.status !== 'dropped').map((b) => {
      const h = b.history[b.history.length - 1];
      return { id: b.id, statement: b.statement, status: b.status, since_round: b.since, latest: 'round ' + h.round + ': ' + h.stance + (h.why ? ' - ' + h.why : '') + (h.evidence.length ? ' [' + h.evidence.join(', ') + ']' : '') };
    }),
    beliefs_dropped: beliefs.filter((b) => b.status === 'dropped').map((b) => ({ id: b.id, statement: b.statement })),
    notes: [...nb.notes.values()].filter((n) => !n.archived).map((n) => ({ id: n.id, text: n.text, updated_round: n.updated })),
    methods: [...nb.methods.values()].map((m) => ({ id: m.id, text: m.text, updated_round: m.updated }))
  };
}

/** What it wrote in an answer, applied to its notebook at `round`: the parts of the answer it used, and what was refused. */
export function writeNotebook(nb: Notebook, round: number, answer: J): { wrote: Record<string, unknown>; warnings: string[] } {
  const wrote: Record<string, unknown> = {};
  const warnings: string[] = [];
  if (Array.isArray(answer.beliefs) && answer.beliefs.length) { warnings.push(...nb.applyStances(round, answer.beliefs as BeliefStance[]).warnings); wrote.beliefs = answer.beliefs; }
  /* A note of its own cites the junior's record by name (items, points): nothing of the junior's to check it against here. */
  if (Array.isArray(answer.notes) && answer.notes.length) { warnings.push(...nb.applyNotes(round, (answer.notes as NoteOp[]).map((n) => ({ ...n, positions: [] })), () => true)); wrote.notes = answer.notes; }
  if (Array.isArray(answer.methods) && answer.methods.length) { warnings.push(...nb.applyMethods(round, answer.methods as NoteOp[])); wrote.methods = answer.methods; }
  return { wrote, warnings };
}

/* --- Its memory: the junior's record, and its own notebook and decisions (`my_*`) ------------------------------------- */

export const OWN_KINDS = ['my_beliefs', 'my_notes', 'my_methods', 'my_decisions'] as const;
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const fold = (s: string): string => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

interface OwnItem { readonly id: string; readonly kind: string; readonly round: number; readonly head: string; readonly body: unknown }

function ownItems(nb: Notebook, decisions: readonly J[]): OwnItem[] {
  return [
    ...[...nb.beliefs.values()].map((b) => ({ id: 'my_belief:' + b.id, kind: 'my_beliefs', round: b.history[b.history.length - 1]?.round ?? b.since, head: '[' + b.status + '] ' + clip(b.statement, 140), body: b })),
    ...[...nb.notes.values()].map((n) => ({ id: 'my_note:' + n.id, kind: 'my_notes', round: n.updated, head: clip(n.text, 140), body: n })),
    ...[...nb.methods.values()].map((m) => ({ id: 'my_method:' + m.id, kind: 'my_methods', round: m.updated, head: clip(m.text, 140), body: m })),
    ...decisions.map((d, i) => ({ id: 'my_decision:' + (i + 1), kind: 'my_decisions', round: Number(d.rounds) || 0,
      head: String(d.decision) + ': ' + clip(String(d.text ?? d.why ?? ''), 130),
      body: { decision: d.decision, at_round: d.rounds, ...(d.text ? { text: d.text } : {}), ...(d.why ? { why: d.why } : {}), ...(d.read ? { read: d.read } : {}), ...(d.evidence ? { evidence: d.evidence } : {}), ...(d.outcome ? { outcome: d.outcome } : {}) } }))
  ];
}

/** Its readings: the junior's record (as before), and what it wrote and decided itself. */
export function seniorMemory(junior: JournalMemory, nb: Notebook, decisions: () => readonly J[]) {
  const own = () => ownItems(nb, decisions());
  const isOwn = (s: unknown) => typeof s === 'string' && s.startsWith('my_');
  const counts = (): Record<string, number> => ({ ...junior.counts(), ...Object.fromEntries(OWN_KINDS.map((k) => [k, own().filter((i) => i.kind === k).length])) });
  return {
    counts,
    async run(q: J): Promise<unknown> {
      const what = String(q.memory);
      const of = typeof q.of === 'string' ? q.of : null;
      if (of !== null && !isOwn(of) && !(MEMORY_KINDS as readonly string[]).includes(of)) return { memory: what, error: '"of" is one of ' + [...MEMORY_KINDS, ...OWN_KINDS].join(', ') };
      if (what === 'list') {
        if (of === null) return { memory: 'list', items: counts(), note: 'add "of": <kind> for the index of a kind' };
        if (!isOwn(of)) return junior.run(q);
        const pool = own().filter((i) => i.kind === of);
        return { memory: 'list', of, total: pool.length, index: pool.slice(-60).map((i) => ({ id: i.id, round: i.round, first_words: i.head })) };
      }
      if (what === 'open') {
        const ids = (Array.isArray(q.items) ? q.items : typeof q.item === 'string' ? [q.item] : []).map(String).slice(0, 8);
        const mine = ids.filter(isOwn), theirs = ids.filter((id) => !isOwn(id));
        const all = own();
        const fromOwn = mine.map((id) => { const it = all.find((i) => i.id === id); return it ? { id, round: it.round, item: it.body } : { id, error: 'no such item' }; });
        const fromJunior = theirs.length ? (((await junior.run({ ...q, items: theirs })) as { items?: unknown[] }).items ?? []) : [];
        if (!ids.length) return { memory: 'open', error: '"items": the ids to open' };
        /* In the order it asked. */
        const byId = new Map([...fromOwn, ...(fromJunior as J[])].map((x) => [String(x.id), x]));
        return { memory: 'open', items: ids.map((id) => byId.get(id) ?? { id, error: 'no such item' }) };
      }
      if (what === 'find') {
        const words = typeof q.words === 'string' ? q.words : '';
        const terms = fold(words).split(/\s+/).filter(Boolean);
        if (!terms.length) return { memory: 'find', words, error: '"words": what to find' };
        const mine = (of === null || isOwn(of)) ? own().filter((i) => of === null || i.kind === of).map((i) => ({ i, text: JSON.stringify(i.body) }))
          .filter((x) => terms.every((t) => fold(x.text).includes(t))).map(({ i }) => ({ id: i.id, round: i.round, first_words: i.head })) : [];
        if (of !== null && isOwn(of)) return { memory: 'find', words, of, matches: mine.length, items: mine.slice(0, 30) };
        const theirs = (await junior.run(q)) as J;
        return { ...theirs, ...(mine.length ? { yours: mine.slice(0, 30) } : {}) };
      }
      return { memory: what, error: 'memory is "list", "open" or "find"' };
    }
  };
}

/** About how many tokens a conversation takes (4 characters a token: an estimate, for when to consolidate). */
export const tokensOf = (parts: readonly unknown[], system = ''): number => Math.round((system.length + parts.reduce<number>((n, p) => n + JSON.stringify(p).length, 0)) / 4);
