import { journalReader } from './record.ts';
import type { JournalMemory } from './memory.ts';
import type { LineSelector, SelectionRecord } from './sources.ts';

/* ============================================================================
 * EXPERIENCE for the assisted researcher (SPEC-INVESTIGADOR-ASISTIDO §12): the records of earlier
 * investigations - other runs' journals, as their researchers saw them - read with the same
 * instruments as its own memory (`list`, `open`, `find`, and `select` with the Judge).
 *
 *   {"experience": "runs"}                                       the runs it may read, and what they are
 *   {"experience": "list", "run": "exp1", "of": "<kind>"}        the index of a kind in that run
 *   {"experience": "open", "run": "exp1", "items": ["<id>"]}     items whole (large ones clipped)
 *   {"experience": "find", "words": "...", "run"?, "of"?, "select"?}
 *
 * Only the researcher's view of each run (orchestra/reader.ts): what it wrote and what its world
 * answered. Never the hidden part of a world, the operator's measures, nor the operator's
 * messages to that researcher. A run's file is its operator's: the researcher knows it by a label.
 *
 * Two modes, declared by the operator and kept apart in the journal and the finding:
 *   transfer  runs of OTHER worlds only: whether a way of investigating carries over;
 *   meta      runs of this same world may be given too: a researcher that investigates the
 *             investigations of others. Its result is not a measure of investigating from nothing.
 * ========================================================================== */

export type ExperienceMode = 'transfer' | 'meta';
export const EXPERIENCE_MODES: readonly ExperienceMode[] = ['transfer', 'meta'];
/** What of each run it may read: everything its researcher saw and wrote (`all`: beliefs, observations, models,
    experiments...), or only the methods its researcher wrote in its notebook (`methods`): to tell a way of investigating
    that carries over from knowledge of a domain that does. */
export type ExperienceScope = 'all' | 'methods';
export const EXPERIENCE_SCOPES: readonly ExperienceScope[] = ['all', 'methods'];

/** A run given as experience: its journal, and what the operator knows of it. */
export interface ExperienceRun {
  readonly label: string;
  readonly journal: Record<string, any>;
  readonly sameWorld: boolean;
  /** A record that is not an assisted journal (an evolutionary search), read through an adapter of its own. */
  readonly reader?: { counts(): Record<string, number>; run(q: Record<string, unknown>): Promise<unknown> };
}

/** What it is told once it has experience (appended to its system prompt). `guidance`: it may read the help each run's
    researcher was delivered (SPEC-METAPOLITICA-INVESTIGACION §7) - said only then, so a run without it asks as before. */
export const experienceSection = (mode: ExperienceMode, scope: ExperienceScope = 'all', guidance = false): string => [
  (scope === 'all'
    ? 'EXPERIENCE. You may read the records of earlier investigations by other researchers: what each wrote (beliefs, notes, methods, models, reflections), each request it made with what its environment answered, and the verdicts of its checks. '
    : 'EXPERIENCE. You may read the METHODS other researchers wrote in their notebooks during earlier investigations: the ways of investigating they kept, and nothing else of their records. ') +
  (mode === 'transfer'
    ? 'They investigated OTHER environments: what worked there may not work here, and a rule of theirs is not a rule of yours.'
    : 'Some may have investigated this same environment (`experience: "runs"` says which): their conclusions may be wrong or incomplete, as yours may be.'),
  'Four more investigation requests read them; like any request, they go inside "investigate", and each answer that holds them counts as a step: {"experience": "runs"} answers the runs you may read (labels like "exp1", whether the environment was this one or another, and how many items of each kind each holds); ' +
  (scope === 'all'
    ? '{"experience": "list", "run": "<label>", "of": "beliefs" | "notes" | "methods" | "episodes" | "models" | "reflections" | "investigations" | "checks"} answers the index of that kind;'
    : '{"experience": "list", "run": "<label>"} answers the index of its methods (ids "method:<id>");') + ' {"experience": "open", "run": "<label>", "items": ["<id>", ...]} answers items (at most 8; a large one clipped unless you add "whole": true); {"experience": "find", "words": "...", "run": "<label>" (optional: every run)' + (scope === 'all' ? ', "of": "<kind>" (optional)' : '') + '} answers the items that hold all the words, and with "select": "what you need" the Judge picks those that speak to it.',
  'What you take from a record is someone\'s word about their environment, not evidence about yours: test it here. When a belief or a method of yours comes from a record, cite it in its evidence as "exp:<label>#<item id>", next to the points of your episodes that support it.',
  ...(guidance ? ['{"experience": "guidance", "run": "<label>"} answers the help its researcher was delivered - who gave it (the operator, its senior, a research policy...), at which question and round, its words, and what the researcher reported or did next; that a step followed some help does not say the help caused it.'] : [])
].join('\n');

/** The help a researcher was delivered, as its journal shows it (SPEC-METAPOLITICA-INVESTIGACION §7): for each message, who
    gave it, when (its question, its round, the cut - how many events came before), its words, and its response - the
    report of a directive, what the researcher told its senior, and the first thing it wrote after (a proposal's rationale,
    a round closed, a reflection), or unknown. The results of its branches are their own, not help. Never the private record
    of whoever gave it. */
export function deliveredGuidance(journal: Record<string, any>, clip = 600): Record<string, unknown> {
  const events = (Array.isArray(journal?.events) ? journal.events : []) as Record<string, any>[];
  const cut = (s: unknown): string => { const t = typeof s === 'string' ? s : JSON.stringify(s ?? ''); return t.length > clip ? t.slice(0, clip) + '…' : t; };
  const out: Record<string, unknown>[] = [];
  let round = 0;
  events.forEach((e, i) => {
    if (typeof e.round === 'number') round = e.round;
    if (e.type !== 'operator_message') return;
    for (const m of (e.messages ?? []) as Record<string, any>[]) {
      if (m.research_result) continue;
      const after = events.slice(i + 1);
      const report = after.find((x) => x.type === 'directive_report' && x.id === m.id);
      const told = after.filter((x) => x.type === 'junior_report').slice(0, 1)[0];
      const next = after.find((x) => (x.type === 'proposal' || x.type === 'reflection' || x.type === 'round_closed'));
      out.push({ id: m.id, author: m.by ?? 'operator', kind: m.directive ? 'directive' : m.by === 'agent:research-policy' ? 'advice' : 'message', question: e.question ?? null, round, cut: i,
        text: cut(m.text), ...(m.advice ? { advice: { focus: m.advice.focus, evidence: m.advice.evidence } } : {}),
        response: report || told || next ? { ...(report ? { report: report.not_done ? { not_done: cut(report.not_done) } : { done: cut(report.done) } } : {}),
          ...(told ? { to_senior: cut(told.text) } : {}), ...(next ? { next: { type: next.type, round: next.round ?? null, ...(next.rationale || next.why ? { words: cut(next.rationale ?? next.why) } : {}) } } : {}) } : 'unknown' });
    }
  });
  return out.length ? { delivered: out } : { delivered: [], none: 'this record holds no help delivered to its researcher' };
}

export class Experience {
  private readonly runs: readonly ExperienceRun[];
  private readonly readers = new Map<string, Pick<JournalMemory, 'counts' | 'run'>>();
  private readonly options: { readonly selector?: LineSelector; readonly onSelect?: (record: SelectionRecord & Record<string, unknown>) => void; readonly openLimit?: number; readonly scope?: ExperienceScope; readonly guidance?: boolean };
  private readonly scope: ExperienceScope;

  constructor(runs: readonly ExperienceRun[], options: { selector?: LineSelector; onSelect?: (record: SelectionRecord & Record<string, unknown>) => void; openLimit?: number; scope?: ExperienceScope; guidance?: boolean } = {}) {
    this.runs = runs;
    this.options = options;
    this.scope = options.scope ?? 'all';
  }

  /** Whether an investigation request is one of these. */
  static accepts(q: Record<string, unknown>): boolean { return typeof q.experience === 'string'; }

  private reader(label: string): Pick<JournalMemory, 'counts' | 'run'> | null {
    const run = this.runs.find((r) => r.label === label);
    if (!run) return null;
    if (run.reader) return run.reader;
    if (!this.readers.has(label)) {
      this.readers.set(label, journalReader(run.journal, { openLimit: this.options.openLimit ?? 4000,
        ...(this.options.selector ? { selector: this.options.selector } : {}),
        onSelect: (record) => this.options.onSelect?.({ run: label, ...record }) }));
    }
    return this.readers.get(label)!;
  }

  /** How many items of each kind a run holds, as far as the scope lets it read. */
  private counts(label: string): Record<string, number> {
    const all = this.reader(label)!.counts();
    return this.scope === 'all' ? all : { methods: all.methods ?? 0 };
  }

  /** One of these requests, answered. */
  async run(q: Record<string, unknown>): Promise<unknown> {
    const what = String(q.experience);
    const labels = this.runs.map((r) => r.label);
    if (what === 'runs') {
      return { experience: 'runs', runs: this.runs.map((r) => ({ run: r.label, environment: r.sameWorld ? 'this same one' : 'another',
        researcher: r.reader ? r.journal.researcher : r.journal.researcher === 'assisted' ? 'assisted' : 'unaided', items: this.counts(r.label) })) };
    }
    if (what === 'guidance') {
      if (!this.options.guidance) return { experience: what, error: 'the help delivered in these runs is not given to you' };
      const r = this.runs.find((x) => x.label === q.run);
      if (!r) return { experience: what, error: '"run": which run (' + labels.join(', ') + ')' };
      if (r.reader) return { experience: what, run: r.label, delivered: [], none: 'this record is not a researcher\'s: no help was delivered in it' };
      return { experience: what, run: r.label, ...deliveredGuidance(r.journal) };
    }
    if (!['list', 'open', 'find'].includes(what)) return { experience: what, error: 'experience is "runs", "list", "open" or "find"' + (this.options.guidance ? ' or "guidance"' : '') };
    /* Only the fields of these requests pass to the reader, and the operation is the one asked as "experience": a field of
       the request (a "memory" of its own) never changes what was checked against the scope. */
    const run = q.run;
    const rest: Record<string, unknown> = Object.fromEntries(Object.entries(q).filter(([k]) => FIELDS.has(k)));
    /* Only methods: every request is narrowed to them, and anything else is not there to read. */
    let refusedIds: string[] = [];
    if (this.scope === 'methods') {
      if (rest.of !== undefined && rest.of !== 'methods') return { experience: what, ...(run ? { run } : {}), error: 'only the methods of these runs are given' };
      if (what !== 'open') rest.of = 'methods';
      else {
        const ids = (Array.isArray(rest.items) ? rest.items : typeof rest.item === 'string' ? [rest.item] : []).map(String);
        refusedIds = ids.filter((id) => !id.startsWith('method:'));
        rest.items = ids.filter((id) => id.startsWith('method:'));
        delete rest.item;
        if (!(rest.items as string[]).length) return { experience: what, ...(run ? { run } : {}), error: 'only the methods of these runs are given (ids "method:<id>")' };
      }
    }
    const memoryRequest = { ...rest, memory: what };
    if (typeof run === 'string') {
      const reader = this.reader(run);
      if (!reader) return { experience: what, run, error: 'no such run (runs: ' + labels.join(', ') + ')' };
      const answer = strip(await reader.run(memoryRequest));
      if (refusedIds.length) answer.items = [...(answer.items as unknown[] ?? []), ...refusedIds.map((id) => ({ id, error: 'only the methods of these runs are given' }))];
      return { experience: what, run, ...answer };
    }
    if (what !== 'find') return { experience: what, error: '"run": which run (' + labels.join(', ') + ')' };
    const answers: unknown[] = [];
    for (const label of labels) answers.push({ run: label, ...strip(await this.reader(label)!.run(memoryRequest)) });
    return { experience: 'find', runs: answers };
  }
}

/** The fields a request of experience may carry to the reader (besides its operation and its run). */
const FIELDS = new Set(['of', 'items', 'item', 'words', 'find', 'select', 'whole']);

/** A memory answer without its own word for the request (`memory`), told here as `experience`. */
function strip(answer: unknown): Record<string, unknown> {
  const { memory: _, ...rest } = (answer ?? {}) as Record<string, unknown>;
  return rest;
}
