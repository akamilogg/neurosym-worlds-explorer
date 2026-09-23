import { round } from '../core/hash.ts';
import { compose } from '../core/formula.ts';
import type { Formula } from '../core/types.ts';
import { hasEvaluableChange, narrowFormula, toFormulaDiff, type FormulaDiff } from './diff.ts';

/* ============================================================================
 * Measured judges: a proposal is not applied because its author believes in it.
 *
 *   J1 MEASUREMENT  the truth had already contradicted the value where the consult was
 *                   triggered, and the candidate is not less decisive there -> apply.
 *   J2 REPLAY       the candidate composes the answers the Judge ALREADY gave on the
 *                   triggering lines strictly more decisively -> apply.
 *   narrow          neither can be shown: apply only what a replay can measure
 *                   (weights, policy weights, floor); the rest waits for the games.
 *   null            silence: only then is a consensus judge (L3) worth its calls.
 * The games and the clean re-verification stay the final word (L4).
 * Zero calls: everything here re-composes answers already paid for.
 * ========================================================================== */

export const JUDGE_MEASURED = 'measurement' as const;
/** A candidate may not be less decisive than the current formula by more than this. */
export const PREFILTER_TOLERANCE = 0.01;

/** One line of evidence as the judge reads it: the Judge's answers at its leaf. */
export interface ReplayCase {
  readonly atoms: Readonly<Record<string, number>> | null | undefined;
}

export interface Prefilter {
  readonly ok: boolean;
  readonly before: number | null;
  readonly after: number | null;
  readonly cases: number;
  readonly reason: string;
}

export interface MeasuredVerdict {
  readonly decision: 'apply' | 'reject' | 'narrow';
  readonly judge: typeof JUDGE_MEASURED;
  readonly votes: null;
  readonly applied_fields: string[];
  readonly diff: FormulaDiff;
  readonly reason: string;
  /** The formula to apply when decision is "narrow". */
  readonly narrowed?: Formula;
}

/** Cases whose answers cover every weighted rule of both formulas (anything less would compose a guess). */
export function usableCases<C extends ReplayCase>(cases: readonly C[], previousWeights: Readonly<Record<string, number>>, candidateWeights: Readonly<Record<string, number>>): C[] {
  const ids = [...new Set([...Object.keys(previousWeights || {}), ...Object.keys(candidateWeights || {})])];
  return (cases || []).filter((c) => c && c.atoms && ids.every((id) => Number.isFinite(c.atoms![id])));
}

/** Mean distance of the composed value from 0.5: how much the formula commits on these lines. */
export function decisiveness(cases: readonly ReplayCase[], weights: Readonly<Record<string, number>>): number {
  if (!cases.length) return 0;
  const edges = cases.map((c) => Math.abs(compose(c.atoms || {}, weights).value - 0.5));
  return edges.reduce((a, b) => a + b, 0) / edges.length;
}

export function prefilter(previous: Formula, candidate: Formula, cases: readonly ReplayCase[], tolerance = PREFILTER_TOLERANCE): Prefilter {
  const usable = usableCases(cases, previous.weights, candidate.weights);
  if (usable.length < 2) {
    return { ok: true, before: null, after: null, cases: usable.length, reason: 'not enough composed answers to prefilter (the clean games stay the test)' };
  }
  const before = round(decisiveness(usable, previous.weights), 4);
  const after = round(decisiveness(usable, candidate.weights), 4);
  const ok = after >= before - tolerance;
  return {
    ok, before, after, cases: usable.length,
    reason: ok
      ? 'prefilter passed: decisiveness over the ' + usable.length + ' triggering line(s) ' + before + ' -> ' + after
      : 'the candidate would make the composition LESS decisive over the ' + usable.length +
        ' line(s) that triggered the consult (' + before + ' -> ' + after + ', tolerance ' + tolerance + ')'
  };
}

export interface MeasuredJudgeOptions {
  /** The lines that triggered the consult, with the answers the Judge gave at their leaves. */
  readonly cases?: readonly ReplayCase[];
  /** The truth had already decided the position AND contradicted the value. */
  readonly contradicted?: boolean;
  readonly tolerance?: number;
  /** Versions the run has already used (a narrowed formula's version is floored above them). */
  readonly ledgerVersions?: readonly (number | undefined)[];
}

export function judgeMeasured(previous: Formula, candidate: Formula, options: MeasuredJudgeOptions = {}): MeasuredVerdict | null {
  const diff = toFormulaDiff(previous, candidate);
  const base = { judge: JUDGE_MEASURED, votes: null, applied_fields: [] as string[], diff };
  if (!hasEvaluableChange(previous, candidate)) {
    return { ...base, decision: 'reject', reason: 'nothing Jev evaluates moved (prose only)' };
  }
  const pf = prefilter(previous, candidate, options.cases || [], options.tolerance);
  const silent = pf.before === null || pf.after === null;
  const measured = silent
    ? 'the replay was SILENT over ' + pf.cases + ' triggering line(s) (fewer than 2 usable composed answers - the clean games are the test)'
    : pf.before + ' -> ' + pf.after + ' over ' + pf.cases + ' triggering line(s)';
  if (!pf.ok) return { ...base, decision: 'reject', reason: 'the replay refuses it: ' + pf.reason };
  if (options.contradicted === true) {
    return { ...base, decision: 'apply', applied_fields: diff.kinds,
      reason: 'it answers a CONTRADICTION between the rules and the value at this ply (' + measured + ')' };
  }
  if (!silent && (pf.after as number) > (pf.before as number)) {
    return { ...base, decision: 'apply', applied_fields: diff.kinds, reason: 'the replay measures it as strictly more decisive (' + measured + ')' };
  }
  const narrowed = narrowFormula(previous, candidate, diff.narrowable, options.ledgerVersions);
  if (narrowed) {
    return { ...base, decision: 'narrow', applied_fields: diff.narrowable, narrowed,
      reason: (silent
        ? 'the replay was SILENT (it measured nothing over the ' + pf.cases + ' triggering line(s)), so only the '
        : 'the replay cannot measure a gain over the ' + pf.cases + ' triggering line(s), so only the ') +
        diff.narrowable.join(', ') + ' are applied; the rest is queued for the next attempt' };
  }
  return null;
}
