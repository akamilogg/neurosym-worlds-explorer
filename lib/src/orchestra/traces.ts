import fs from 'node:fs';

/* ============================================================================
 * TRACES OF THE PROCESS, WITHOUT VALUATION (SPEC-CONTROL-ARNES K4, §4.3): how a run went, as a description - never as "losses"
 * or "performance". The effect of a senior or of its opening is attributed only by controlled comparisons (K3, §6.2.1):
 * counting the orders adopted is not enough, an order adopted may make the model worse.
 *
 *   rounds until the first model that holds in all its laboratories
 *   steps of investigation by type: looking, experimenting, recalling (each kind of request by its name)
 *   proposals returned (refused as not a model)
 *   the senior's directives, and what the junior said of each: carried out, not carried out (with its reason), not reported;
 *   what it told its senior of its own (where it may disagree)
 * ========================================================================== */

type J = Record<string, any>;

/** The kinds of a request of investigation, by what it does: it looks at what is there, acts on the world, or recalls. */
const KIND: Readonly<Record<string, 'looking' | 'experimenting' | 'recalling' | 'asking_a_direction'>> = {
  view: 'looking', inspect: 'looking', table: 'looking', measure: 'looking', episode: 'looking', series: 'looking', source: 'looking', instrument: 'looking',
  act: 'experimenting', try: 'experimenting', replay: 'experimenting', register_test: 'experimenting',
  memory: 'recalling',
  what_if: 'asking_a_direction'
};

export interface ProcessTraces {
  readonly rounds: number;
  readonly first_round_holding_in_its_laboratories: number | null;
  readonly steps: { readonly looking: number; readonly experimenting: number; readonly recalling: number; readonly asking_a_direction: number; readonly other: number; readonly by_request: Readonly<Record<string, number>> };
  readonly proposals_returned: number;
  /** Rounds it closed itself without a new model (PLAN-Y-SI, Entrega 1). */
  readonly rounds_closed: number;
  /** Its requests of «what if…?», by hemisphere (SPEC-Y-SI). */
  readonly what_if: { readonly junior: number; readonly senior: number };
  readonly directives: { readonly given: number; readonly reported_carried_out: number; readonly reported_not_carried_out: number; readonly not_reported: number };
  readonly told_its_senior: number;
  readonly other_help: number;
  readonly reading: string;
}

export function processTraces(journalFile: string): ProcessTraces {
  let journal: J = {};
  try { journal = JSON.parse(fs.readFileSync(journalFile, 'utf8')); } catch { /* an empty trace */ }
  const events = (journal.events ?? []) as J[];
  const rounds = Math.max(0, ...events.filter((e) => e.type === 'proposal' || e.type === 'check' || e.type === 'round_closed').map((e) => Number(e.round) || 0));
  const holding = events.find((e) => e.type === 'check' && Array.isArray(e.laboratories) && e.laboratories.length && e.laboratories.every((l: J) => l.holds));
  const byRequest: Record<string, number> = {};
  for (const e of events) if (e.type === 'investigation') for (const r of (e.requests ?? []) as J[]) {
    const kind = r && typeof r === 'object' ? Object.keys(r)[0] ?? 'unknown' : 'unknown';
    byRequest[kind] = (byRequest[kind] ?? 0) + 1;
  }
  const steps = { looking: 0, experimenting: 0, recalling: 0, asking_a_direction: 0, other: 0 };
  for (const [k, n] of Object.entries(byRequest)) steps[KIND[k] ?? 'other'] += n;
  /* The directives (the senior's messages it was told to carry out), and what it reported of each. */
  const messages = events.filter((e) => e.type === 'operator_message').flatMap((e) => (e.messages ?? []) as J[]);
  const directives = messages.filter((m) => m.directive);
  const reports = new Map<string, J>();
  for (const e of events.filter((x) => x.type === 'directive_report')) reports.set(String(e.id), e);
  const reported = directives.map((d) => reports.get(String(d.id)));
  return {
    rounds,
    first_round_holding_in_its_laboratories: holding ? Number(holding.round) : null,
    steps: { ...steps, by_request: byRequest },
    proposals_returned: events.filter((e) => e.type === 'proposal_refused').length,
    rounds_closed: events.filter((e) => e.type === 'round_closed').length,
    what_if: { junior: events.filter((e) => e.type === 'what_if_requested' && e.by === 'junior').length, senior: events.filter((e) => e.type === 'what_if_requested' && String(e.by).startsWith('agent:')).length },
    directives: { given: directives.length, reported_carried_out: reported.filter((r) => r && !r.not_done).length,
      reported_not_carried_out: reported.filter((r) => r?.not_done).length, not_reported: reported.filter((r) => !r).length },
    told_its_senior: events.filter((e) => e.type === 'junior_report').length,
    other_help: messages.filter((m) => !m.directive).length,
    reading: 'a description of how it went - never its performance; effects only from controlled comparisons'
  };
}
