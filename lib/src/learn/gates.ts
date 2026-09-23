import { round } from '../core/hash.ts';
import type { ObserverLike } from '../core/evaluate.ts';
import type { MeasureDecl } from '../core/types.ts';

/* ============================================================================
 * Gates a proposal crosses BEFORE any judge or game spends anything on it.
 *
 *   J0 provenance    a proposal made with evidence in hand must cite it: an index of a
 *                    shown case, a labelled state, or the operator's directive. Creativity
 *                    without evidence is not a hypothesis.
 *   executability    every declared measure is computed over exactly the boards that
 *                    motivated the proposal; a measure that fails, or that does not repeat
 *                    its own number on the same board (not a fact), refuses the formula.
 * ========================================================================== */

/** What a consult put in front of the proposer, reduced to what can be cited. */
export interface CitableEvidence {
  /** How many cases (or reflections) the brief showed, addressable by index. */
  readonly cases?: number;
  /** State keys of labelled truths (a loss report), addressable by index or by key. */
  readonly truthKeys?: readonly string[];
  /** The one state the evidence is anchored on (e.g. the losing ply), addressable by key. */
  readonly anchorKey?: string | null;
  /** The operator issued a directive for this consult. */
  readonly directive?: boolean;
}

export interface EvidenceRef {
  readonly case?: unknown;
  readonly state_key?: unknown;
  readonly operator_directive?: unknown;
  readonly why?: unknown;
}

/** J0. `evidence` null = the consult showed nothing, so no citation is required. */
export function validateEvidenceRef(ref: EvidenceRef | null | undefined, evidence: CitableEvidence | null): boolean {
  if (!evidence) return true;
  if (!ref || typeof ref !== 'object') return false;
  if (evidence.directive && ref.operator_directive === true) return true;
  const caseCount = evidence.cases || 0;
  const truths = evidence.truthKeys || [];
  const anchor = typeof evidence.anchorKey === 'string' ? evidence.anchorKey : null;
  /* Nothing addressable and no directive: there is nothing to point at, so nothing is required. */
  if (!caseCount && !truths.length && !evidence.directive && !anchor) return true;
  if (Number.isInteger(ref.case) && (ref.case as number) >= 0) {
    if (caseCount && (ref.case as number) < caseCount) return true;
    if (truths.length && (ref.case as number) < truths.length) return true;
  }
  if (typeof ref.state_key === 'string' && (truths.length || anchor)) {
    if (anchor && ref.state_key === anchor) return true;
    if (truths.includes(ref.state_key)) return true;
  }
  return false;
}

/* --- Executability and determinism over the evidence ----------------------------- */

export interface ReplayEntry<S> {
  readonly state: S | null;
  readonly id?: string | null;
  readonly label?: string | null;
}

export interface ReplayError {
  readonly case_index: number;
  readonly case_id: string | null;
  readonly observation?: string;
  readonly error: string;
}

export interface ReplayRow {
  readonly case_index: number;
  readonly case_id: string | null;
  readonly outcome_label: string;
  readonly measurements: Readonly<Record<string, number>>;
}

export interface ReplayReport {
  readonly valid: boolean;
  readonly declared_observations: string[];
  readonly evaluated_boards: number;
  readonly rows: ReplayRow[];
  readonly variation: Record<string, { samples: number; min: number | null; max: number | null; spread: number | null }>;
  readonly errors: ReplayError[];
}

/** Measures to check twice: by default the ones whose spec is "code" (catalogue ops are pure by construction). */
const isCode = (decl: MeasureDecl | undefined): boolean => !!decl && !!decl.spec && (decl.spec as { kind?: string }).kind === 'code';

export function replayOnEvidence<S>(observer: ObserverLike<S>, observations: Readonly<Record<string, MeasureDecl>>, entries: readonly ReplayEntry<S>[],
  options: { checkTwice?: (decl: MeasureDecl) => boolean } = {}): ReplayReport {
  const ids = Object.keys(observations || {});
  const checkTwice = options.checkTwice ?? isCode;
  const rows: ReplayRow[] = [];
  const errors: ReplayError[] = [];
  (entries || []).forEach((entry, index) => {
    const caseId = entry?.id ?? null;
    if (!entry || !entry.state) { errors.push({ case_index: index, case_id: caseId, error: 'leaf board is unavailable' }); return; }
    const measured = observer.observe(entry.state, observations);
    const twice = ids.filter((id) => checkTwice(observations[id]));
    if (twice.length) {
      /* The senses travel with the subset: a measure computed from what is perceived needs the percept. */
      const subset: Record<string, MeasureDecl> = {};
      for (const id of ids) if ((observations[id]?.spec as { kind?: string } | undefined)?.kind === 'sense') subset[id] = observations[id];
      for (const id of twice) subset[id] = observations[id];
      const again = observer.observe(entry.state, subset);
      for (const id of twice) {
        if (Object.prototype.hasOwnProperty.call(measured.values, id) && measured.values[id] !== again.values[id]) {
          errors.push({ case_index: index, case_id: caseId, observation: id,
            error: 'non-deterministic: the same board measured ' + measured.values[id] + ' and then ' + again.values[id] });
        }
      }
    }
    for (const e of measured.errors) errors.push({ case_index: index, case_id: caseId, observation: e.id, error: e.error });
    if (measured.count !== ids.length) errors.push({ case_index: index, case_id: caseId, error: 'computed ' + measured.count + '/' + ids.length + ' declared observations' });
    rows.push({ case_index: index, case_id: caseId, outcome_label: entry.label || 'unresolved', measurements: measured.values });
  });
  const variation: ReplayReport['variation'] = {};
  for (const id of ids) {
    const values = rows.map((r) => r.measurements[id]).filter((v) => Number.isFinite(v));
    variation[id] = {
      samples: values.length,
      min: values.length ? Math.min(...values) : null,
      max: values.length ? Math.max(...values) : null,
      spread: values.length ? round(Math.max(...values) - Math.min(...values), 4) : null
    };
  }
  return { valid: rows.length > 0 && errors.length === 0, declared_observations: ids, evaluated_boards: rows.length, rows, variation, errors };
}
