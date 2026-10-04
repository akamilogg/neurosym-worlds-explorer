import type { Judge, Rule } from '../core/types.ts';
import type { Link, LinkRecord } from './links.ts';

/* ============================================================================
 * THE METHOD AUDIT, what the Judge judges (SPEC-AUDITORIA-METODO §5, MA3): closed questions about
 * each experiment link (J1-J4) and about each round (J5-J6). The Judge sees only the link - what
 * the researcher held, asked, was answered, and wrote after - with the neutral contract: nothing
 * of the world beyond what the researcher saw, never the hidden truth (M2).
 *
 * Each answer is the option the Judge gives the most probability, with that probability and the
 * whole distribution, so that the operator can see how sure it was.
 * ========================================================================== */

export interface Verdict { readonly answer: string; readonly p: number; readonly distribution: Readonly<Record<string, number>>; readonly confidence: number | null }

const choice = (instructions: string, options: Record<string, string>): Rule => ({ type: 'choice', instructions, criteria: options, option: Object.keys(options)[0] });

/** J1-J4: one call per experiment link. */
export const LINK_QUESTIONS: Readonly<Record<string, Rule>> = {
  purpose: choice('Read held_before, operator_message (if any), requests and result. Did the step put to the test a hypothesis that was alive before it?', {
    own: 'it tests one of the hypotheses the researcher held before the step',
    operator: 'it tests a hypothesis the operator\'s message proposed',
    partly: 'it bears on a held hypothesis, but only indirectly or for part of it',
    none: 'it tests none of the hypotheses that were alive',
    no_hypothesis: 'no hypothesis was stated before the step: it explores'
  }),
  discrimination: choice('Suppose the hypothesis the step bears on were false. Would the result of this step have come out differently?', {
    yes: 'yes: the result tells the hypothesis apart from its alternatives',
    no: 'no: the same result was expected whether or not the hypothesis holds',
    undetermined: 'it cannot be told from what is shown'
  }),
  reading: choice('Compare result with written_after (the researcher\'s next proposal or reflection, and which of its citations point to this step). How does the researcher read the result?', {
    correct: 'it says what the result shows, no more and no less',
    overreads: 'it concludes more than the result shows (or reads a refused or failed step as if it had tested what it meant to test)',
    underreads: 'it concludes less than the result shows, or misses what it shows',
    ignored: 'it does not use this result at all'
  }),
  scope: choice('Of the claims in written_after that rest on this step: do they declare a scope (general, of the sample, of this point) that fits the evidence?', {
    fitting: 'the scope stated fits the evidence',
    too_broad: 'it claims more generality than the evidence supports',
    too_narrow: 'it claims less than the evidence supports',
    no_claim: 'no claim rests on this step'
  })
};

/** J5-J6: one call per round. */
export const ROUND_QUESTIONS: Readonly<Record<string, Rule>> = {
  refutation: choice('Read held_at_start, the round\'s results, and how the round closed. When a result contradicted a belief held at the start, what did the researcher do?', {
    revised: 'it revised or dropped the belief',
    kept_with_reason: 'it kept the belief and said explicitly why the contrary result does not refute it',
    kept_without_reason: 'it kept the belief with no reason given',
    no_contrary_evidence: 'no result of the round contradicted a held belief'
  }),
  control: choice('When the round\'s closing claims that something causes or explains an outcome, does it rest on a comparison (two runs or acts that differ in one thing, or a baseline)?', {
    comparison_used: 'yes: a comparison or baseline supports the causal claim',
    no_comparison: 'a causal claim is made without a comparison or baseline',
    no_causal_claim: 'no causal claim is made'
  })
};

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const text = (v: unknown, n: number): string => clip(typeof v === 'string' ? v : JSON.stringify(v), n);

/** The texts the Judge is shown of a link. */
export function linkTexts(l: Link): Record<string, string> {
  return {
    held_before: text(l.before.beliefs.map((b) => b.id + ': ' + b.statement).join('\n') || '(none)', 3000),
    ...(l.before.operator_message ? { operator_message: text(l.before.operator_message, 1500) } : {}),
    requests: text(l.requests, 1200),
    result: text(l.result, 2500),
    written_after: l.after
      ? text({ rationale: l.after.rationale, beliefs: l.after.beliefs, citations_of_this_step: l.after.cites_this }, 4000)
      : '(the run ended before writing anything after this step)'
  };
}

/** The texts the Judge is shown of a round. */
export function roundTexts(r: LinkRecord['rounds'][number], record: LinkRecord): Record<string, string> {
  const links = record.links.filter((l) => r.links.includes(l.id) && l.kind !== 'recall');
  return {
    held_at_start: text(r.held.map((b) => b.id + ': ' + b.statement).join('\n') || '(none)', 3000),
    results: text(links.map((l) => ({ step: l.id, requests: l.requests, result: l.result })), 4000),
    closed_by: r.closed_by ? text(r.closed_by, 4000) : '(the round was not closed)'
  };
}

/** One judgement: the option with the most probability, and the distribution. */
function verdicts(answers: Record<string, { value: number; confidence: number | null; raw?: unknown }>, questions: Readonly<Record<string, Rule>>): Record<string, Verdict | null> {
  const out: Record<string, Verdict | null> = {};
  for (const id of Object.keys(questions)) {
    const raw = (answers[id]?.raw ?? {}) as { probabilities?: Record<string, unknown> };
    const dist = Object.fromEntries(Object.entries(raw.probabilities ?? {}).map(([k, v]) => [k, Number(v)]).filter(([, v]) => Number.isFinite(v as number))) as Record<string, number>;
    const best = Object.entries(dist).sort(([, a], [, b]) => b - a)[0];
    out[id] = best ? { answer: best[0], p: Math.round(best[1] * 1000) / 1000, distribution: dist, confidence: answers[id]?.confidence ?? null } : null;
  }
  return out;
}

export interface Judgements {
  readonly links: Readonly<Record<string, Record<string, Verdict | null>>>;
  readonly rounds: Readonly<Record<string, Record<string, Verdict | null>>>;
  readonly calls: number;
  readonly errors: readonly string[];
}

/** J1-J4 for each experiment link, J5-J6 for each round that ran a step. */
export async function judgeMethod(record: LinkRecord, judge: Judge): Promise<Judgements> {
  const links: Record<string, Record<string, Verdict | null>> = {};
  const rounds: Record<string, Record<string, Verdict | null>> = {};
  const errors: string[] = [];
  let calls = 0;
  const ask = async (texts: Record<string, string>, questions: Readonly<Record<string, Rule>>, where: string) => {
    calls++;
    try {
      return verdicts(await judge.judge({ world: 'method-audit', rulesOfTheWorld: '', sideToMove: '', measurements: {}, texts, questions }) as never, questions);
    } catch (e) { errors.push(where + ': ' + String((e as Error)?.message ?? e).slice(0, 200)); return null; }
  };
  await Promise.all(record.links.filter((l) => l.kind === 'experiment').map(async (l) => {
    const v = await ask(linkTexts(l), LINK_QUESTIONS, l.id);
    if (v) links[l.id] = v;
  }));
  await Promise.all(record.rounds.filter((r) => r.links.length).map(async (r) => {
    const v = await ask(roundTexts(r, record), ROUND_QUESTIONS, 'round ' + r.round);
    if (v) rounds['r' + r.round] = v;
  }));
  return { links, rounds, calls, errors };
}
