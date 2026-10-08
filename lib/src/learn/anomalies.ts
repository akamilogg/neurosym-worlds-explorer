import fs from 'node:fs';
import type { InstrumentKind } from './instrument.ts';

/* ============================================================================
 * The life of an anomaly (SPEC-CALIBRACION-INSTRUMENTOS §5, A4). A report of the instrument
 * (`instrument_report`, by the junior or its senior) is PENDING until the operator gives it a
 * verdict - `bug` (a fault of the instrument), `world` (it is the world) or `unclear` (still
 * questioned). While it is pending or unclear, the places of the episodes it cites are
 * QUESTIONED: nothing is erased, the run goes on, and an acceptance whose checks pass through a
 * questioned place waits for the verdict. A report that cites no episode questions the whole
 * instrument. A `bug` invalidates what it cites, and an acceptance through its places is void
 * (the fix is a branch of the run, §6); a `world` lifts the mark.
 *
 * The operator's verdicts are written next to the journal (`<run>.anomalies.jsonl`, one per
 * line), by `lab anomaly` or the console; a run that is going takes them as they come and logs
 * each (`anomaly_verdict`); a run that ended keeps them there, for its finding and the console.
 * ========================================================================== */

export const VERDICTS = ['bug', 'world', 'unclear'] as const;
export type Verdict = typeof VERDICTS[number];

export interface ReportRecord {
  readonly id: string;
  readonly by: string;
  readonly round?: number;
  readonly what: string;
  readonly evidence: readonly string[];
  readonly kind: InstrumentKind;
}

export interface VerdictRecord {
  readonly report: string;
  readonly verdict: Verdict;
  readonly text?: string;
  readonly at?: string;
}

export type ReportState = ReportRecord & { readonly state: Verdict | 'pending'; readonly text?: string };

/** Where a run's verdicts are kept: next to its journal. */
export const anomalyFile = (journal: string): string => journal.replace(/\.json$/, '') + '.anomalies.jsonl';

/** Writes the operator's verdict on a report (it is the run's to take, when it goes on). */
export function writeVerdict(journal: string, v: VerdictRecord): void {
  fs.appendFileSync(anomalyFile(journal), JSON.stringify({ at: new Date().toISOString(), ...v }) + '\n');
}

/** A verdict as written, or why it is not one. */
export function parseVerdict(raw: unknown): VerdictRecord | string {
  const v = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
  if (!v || typeof v.report !== 'string' || !v.report) return 'a verdict names its report';
  if (!(VERDICTS as readonly string[]).includes(String(v.verdict))) return 'a verdict is ' + VERDICTS.join(', ');
  return { report: v.report, verdict: v.verdict as Verdict, ...(typeof v.text === 'string' && v.text.trim() ? { text: v.text.trim() } : {}), ...(typeof v.at === 'string' ? { at: v.at } : {}) };
}

/** The verdicts written for a run (lines that are not one are skipped). */
export function readVerdicts(journal: string): VerdictRecord[] {
  let text = '';
  try { text = fs.readFileSync(anomalyFile(journal), 'utf8'); } catch { return []; }
  const out: VerdictRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const v = parseVerdict(JSON.parse(line)); if (typeof v !== 'string') out.push(v); } catch { /* not a verdict */ }
  }
  return out;
}

/** The reports a journal logged. */
export function reportsOf(events: readonly Record<string, any>[]): ReportRecord[] {
  return events.filter((e) => e.type === 'instrument_report' && typeof e.id === 'string').map((e) => ({ id: e.id, by: String(e.by ?? 'junior'),
    ...(typeof e.round === 'number' ? { round: e.round } : {}), what: String(e.what ?? ''), evidence: (e.evidence ?? []).map(String), kind: e.kind }));
}

/** Each report with its latest verdict (pending when it has none). */
export function reportStates(reports: readonly ReportRecord[], verdicts: readonly VerdictRecord[]): ReportState[] {
  return reports.map((r) => {
    const v = [...verdicts].reverse().find((x) => x.report === r.id);
    return { ...r, state: v ? v.verdict : 'pending', ...(v?.text ? { text: v.text } : {}) };
  });
}

/** A run's reports with their state, from its journal and the verdicts next to it (those a resumed run took from the history
    it resumes too): what the operator reads of a run going or ended. */
export function runAnomalies(journal: string): ReportState[] {
  let events: Record<string, any>[] = [];
  try { events = JSON.parse(fs.readFileSync(journal, 'utf8')).events ?? []; } catch { return []; }
  const inherited = events.filter((e) => e.type === 'anomaly_verdict' && e.from_history).map((e) => parseVerdict(e)).filter((v): v is VerdictRecord => typeof v !== 'string');
  return reportStates(reportsOf(events), [...inherited, ...readVerdicts(journal)]);
}

/** Whether a report still questions what it cites: pending, or unclear. */
export const questions = (r: ReportState): boolean => r.state === 'pending' || r.state === 'unclear';

/** The places a report questions: those of the episodes it cites (`ep3`, `ep3@5`) or the places it names; every place
    when it cites none (the instrument as a whole). */
export function placesQuestioned(r: ReportRecord, placeOf: (ref: string) => string | null): readonly string[] | 'all' {
  const places = new Set<string>();
  for (const ref of r.evidence) { const p = placeOf(ref.trim().split('@')[0]); if (p) places.add(p); }
  return places.size ? [...places] : 'all';
}

/** The reports an acceptance through these places cannot do without: those still questioning them, and those found a fault
    of the instrument there (nothing in this run rests on such a place again: the fix is a branch, §6). */
export function holding(states: readonly ReportState[], through: readonly string[], placeOf: (ref: string) => string | null): string[] {
  return states.filter((r) => r.state !== 'world' && r.kind !== 'missing_instrument').filter((r) => { const q = placesQuestioned(r, placeOf); return q === 'all' || q.some((p) => through.includes(p)); }).map((r) => r.id);
}
