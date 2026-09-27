import type { ProtocolSummary } from './protocol.ts';

/* ============================================================================
 * Operator-only measures common to every objective (SPEC-OBJETIVO O4). They go to the
 * journal and nowhere else: never to System 2, never to the Judge.
 *
 *   milestones   rounds, checks, the first round the model held in its laboratories,
 *                each validation, the acceptance
 *   cost         Judge calls (and evaluations it was not asked: an output that read none
 *                of the rules), LLM calls and tokens - in all, and up to the acceptance
 *   the Judge    what the rules of the Judge add: per ablated round, the model's score
 *                against the same observations with no Judge
 * ========================================================================== */

/** One round's ablation: the model's score and the same model's without the Judge, on the same cases. */
export interface AblationRecord {
  readonly round: number;
  readonly model: number;
  readonly withoutJudge: number;
  /** Which way is better for this score (wins: higher; an error: lower). */
  readonly better: 'higher' | 'lower';
}

/** The tokens an OpenAI-compatible answer reports (0 when it reports none). */
export function tokensOf(raw: unknown): number {
  const usage = (raw as { usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number } } | null)?.usage;
  if (!usage) return 0;
  return usage.total_tokens ?? ((usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0));
}

/** What the Judge's rules added, over the ablated rounds. */
export function judgeContribution(ablations: readonly AblationRecord[], tolerance = 1e-9): Record<string, unknown> {
  const sign = (a: AblationRecord) => {
    const d = a.better === 'higher' ? a.model - a.withoutJudge : a.withoutJudge - a.model;
    return Math.abs(d) <= tolerance * Math.max(1, Math.abs(a.model)) ? 0 : Math.sign(d);
  };
  return {
    rounds_ablated: ablations.length,
    judge_changed_nothing: ablations.filter((a) => sign(a) === 0).length,
    judge_helped: ablations.filter((a) => sign(a) > 0).length,
    judge_hurt: ablations.filter((a) => sign(a) < 0).length,
    by_round: ablations.map((a) => ({ round: a.round, model: a.model, without_judge: a.withoutJudge }))
  };
}

/** The journal's operator summary of a run. */
export function operatorSummary(summary: ProtocolSummary, ablations: readonly AblationRecord[] = []): Record<string, unknown> {
  return {
    rounds: summary.rounds, checks: summary.checks,
    first_held: summary.firstHeld,
    validations: summary.validations.map((v) => ({ round: v.round, attempt: v.attempt, held_in: v.heldIn, became_laboratories: v.becameLaboratories, blind_confirmed: v.blindConfirmed })),
    accepted: summary.accepted,
    cost: summary.cost,
    cost_per_acceptance: summary.costPerAcceptance,
    /* Checks a model that knows nothing passed too (only when the run declares baselines). */
    trivial_checks: summary.trivialChecks,
    accepted_trivially: summary.acceptedTrivially,
    judge: judgeContribution(ablations)
  };
}
