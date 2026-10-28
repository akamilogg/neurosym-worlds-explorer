import { captureView, decide, policyHash, type PolicyConfig } from '../learn/assisted/research-policy.ts';
import type { CodeRunner, Judge } from '../core/types.ts';

/* ============================================================================
 * A policy read against a run already made (SPEC-METAPOLITICA-INVESTIGACION §10): at each point where its researcher was
 * about to answer, what the policy would have decided from what it had seen by then. It inspects the policy's
 * decisions; it never measures what would have happened had they been followed - that takes new whole runs (trials).
 * Nothing of it is a trial, a result or a mark of improvement, and it says so in its record.
 * ========================================================================== */

type J = Record<string, any>;

export interface Inspection {
  readonly format: 'policy-inspection@1';
  readonly policy: string;
  readonly run: { readonly experiment: unknown; readonly started: unknown };
  readonly counterfactual: false;
  readonly reading: string;
  readonly decisions: readonly { readonly cut: number; readonly round: number | null; readonly guidance?: unknown; readonly failure?: string; readonly why?: string; readonly judge_calls: number }[];
}

/** The answers of its researcher: where a policy is asked, before each (its cut). */
const ANSWERS = new Set(['investigation', 'proposal', 'reflection', 'round_closed']);

export async function inspectHistory(config: PolicyConfig, journal: J, judge: Judge, runner: CodeRunner, o: { maxDecisions?: number } = {}): Promise<Inspection> {
  const events = (journal.events ?? []) as J[];
  let state: unknown = config.policy.state ?? null;
  const decisions: Inspection['decisions'][number][] = [];
  const guidance: J[] = [];
  for (let i = 0; i < events.length && decisions.length < (o.maxDecisions ?? 200); i++) {
    if (!ANSWERS.has(events[i].type)) continue;
    const capture = captureView(events, i, { question: decisions.length + 1, context: config.context, guidance: [...guidance], resources: { help_left: null }, state });
    const d = await decide(config.policy, capture, judge, { runner, ...(config.limits?.state_bytes ? { stateBytes: config.limits.state_bytes } : {}) });
    if (!d.failure) {
      state = d.state;
      if (d.guidance?.kind === 'advise') guidance.push({ id: 'inspect-' + i, cut: i, focus: d.guidance.focus, template: d.guidance.template, evidence: d.guidance.evidence });
    }
    decisions.push({ cut: i, round: typeof events[i].round === 'number' ? events[i].round : null, judge_calls: d.judge_calls,
      ...(d.failure ? { failure: d.failure, why: d.why } : { guidance: d.guidance }) });
  }
  return { format: 'policy-inspection@1', policy: policyHash(config.policy), run: { experiment: journal.experiment, started: journal.started }, counterfactual: false,
    reading: 'what the policy would have decided at each cut from what it had seen by then - its researcher never received it, and nothing here says what would have happened had it',
    decisions };
}
