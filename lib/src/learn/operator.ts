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

/** What a grade may rest on (06/10/2026, after a grader read a learner's disclaimers - "the observations do not identify a
    pathway" - as the true statement itself, and called the learner's measured observations false because no true statement
    mentioned them). Shared by every grader. */
export const GRADING_RIGOR = 'A statement of NOT KNOWING is not knowing: when the learner says it has not identified, cannot tell, leaves open or does not establish what a true statement says, that statement is "absent" - a disclaimer, a caveat, a limitation or an open question never makes a grade "exact" or "partial", however well it names what is missing. '
  + 'Grade "partial" only for a claim the learner positively makes that holds part of the true statement. '
  + '"false_beliefs" are the learner\'s claims that a TRUE statement CONTRADICTS. A claim is never false merely because no true statement mentions it: the true statements are not everything true of the environment, and what the learner observed beyond them is not false for that.';

/** The grader's version: 2 since a false belief is a claim the learner made, quoted (SPEC-CALIBRACION-INSTRUMENTOS §11.2,
    08/10/2026, after a grader took the form of a model - continuous outputs from kernels - for a claim that there are no
    discrete regimes). */
export const GRADER_VERSION = 2;

/** Added to every grader's system prompt from version 2. */
export const FALSE_BELIEF_RULE = 'A FALSE BELIEF is a claim the learner ITSELF MAKES about the mechanism - in its words, a belief, a note, the definition of an observation or its reflection - that a TRUE statement contradicts. '
  + 'The FORM of its model is not a claim: computing continuous values, using kernels, a table, rules or code says how it predicts, not that the mechanism is otherwise; a model can implement what a true statement says in many forms. '
  + 'Give each false belief as {"claim": ..., "quote": "the learner\'s exact words, copied", "where": "belief <id>" | "note <id>" | "observation <id>" | "reflection" | "model", "contradicted_by": "<id of the true statement>"}. '
  + 'Without the learner\'s exact words it is not a false belief: leave it out.';

/** Normalized for finding a quote in what the learner wrote: lower case, no quotes or escapes, whitespace collapsed. */
const plain = (text: string): string => text.toLowerCase().replace(/\\[nrt]/g, ' ').replace(/[\\"'`“”‘’]/g, '').replace(/\s+/g, ' ').trim();

/** The false beliefs a grader of version 2 gave, kept only when their quote is in what the learner wrote (`learner`, as the
    grader was given it); the others are discarded and kept apart, to review the grader. */
export function quotedFalseBeliefs(given: unknown, learner: unknown): { false_beliefs: unknown[]; false_beliefs_discarded: unknown[]; grader_version: number } {
  const all = Array.isArray(given) ? given : [];
  const text = plain(typeof learner === 'string' ? learner : JSON.stringify(learner));
  const kept: unknown[] = [], discarded: unknown[] = [];
  for (const b of all) {
    const quote = b && typeof b === 'object' && typeof (b as { quote?: unknown }).quote === 'string' ? plain((b as { quote: string }).quote) : '';
    (quote.length >= 8 && text.includes(quote) ? kept : discarded).push(b);
  }
  return { false_beliefs: kept, false_beliefs_discarded: discarded, grader_version: GRADER_VERSION };
}

/** For the operator's grader: a model that reproduces a law is not a statement of its structure. A lookup table (or a
    fit over cases) that agrees with the law shows its OUTPUTS; a statement about its STRUCTURE - what it depends on, a
    symmetry, a count, a threshold - is exact only when the learner states or computes that structure. */
export const GRADING_STRUCTURE = GRADING_RIGOR + ' '
  + 'Separate PREDICTING from UNDERSTANDING: a lookup table, a list of cases or a fit that merely agrees with a true statement shows its outputs, not its structure. '
  + 'For a statement about the structure of the law (what it depends on, a symmetry, a count, a threshold, a compact form), grade "exact" only when the learner states that structure or its code computes it as such; '
  + 'a table or case list that happens to agree with it is "partial", and say so in the evidence. '
  + 'Also say how the learner\'s final model expresses the law: "compact" (it computes the structure), "table" (it enumerates cases or outputs) or "mixed", in a field "form" with a one-line "form_evidence".';

/** How the learner's model expresses the law, as the grader read it. */
export const formOf = (parsed: { form?: unknown; form_evidence?: unknown } | null): { form: string | null; form_evidence: string | null } => ({
  form: parsed && ['compact', 'table', 'mixed'].includes(String(parsed.form)) ? String(parsed.form) : null,
  form_evidence: parsed && typeof parsed.form_evidence === 'string' ? parsed.form_evidence : null
});

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
