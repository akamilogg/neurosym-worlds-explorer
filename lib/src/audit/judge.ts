import type { Judge, Rule } from '../core/types.ts';
import type { Link, LinkRecord, Segment } from './links.ts';

/* ============================================================================
 * THE METHOD AUDIT, what the Judge judges (SPEC-AUDITORIA-METODO §5, MA3): closed questions about
 * each experiment link (J1-J4), about each observation a later text cites (J3-J4: a look can be
 * misread or stretched too), and about each stretch between two proposals or reflections (J5-J6).
 * The Judge sees only the link - what the researcher held, asked, was shown (the frames, rows and
 * points themselves, as it saw them), and wrote after - or the stretch in order (the verdicts of
 * the checks it was given, its steps, what closed it), with the neutral contract: nothing of the
 * world beyond what the researcher saw, never the hidden truth (M2). When what is shown is not
 * enough to judge, the answer is `cannot_tell`, never a guess.
 *
 * Each answer is the option the Judge gives the most probability, with that probability and the
 * whole distribution, so that the operator can see how sure it was.
 * ========================================================================== */

export interface Verdict { readonly answer: string; readonly p: number; readonly distribution: Readonly<Record<string, number>>; readonly confidence: number | null }

const choice = (instructions: string, options: Record<string, string>): Rule => ({ type: 'choice', instructions, criteria: options, option: Object.keys(options)[0] });

const READING = choice('Compare result and shown (what the step showed, point by point, exactly as the researcher saw it) with written_after (the researcher\'s next proposal or reflection, and which of its citations point to this step). How does the researcher read what it was shown?', {
  correct: 'it says what was shown, no more and no less',
  overreads: 'it concludes more than was shown (or reads a refused or failed step as if it had tested what it meant to test)',
  underreads: 'it concludes less than was shown, or misses what it shows',
  ignored: 'it does not use this step at all',
  cannot_tell: 'what is shown here is not enough to tell'
});
const SCOPE = choice('Of the claims in written_after that rest on this step: do they declare a scope (general, of the sample, of this point) that fits the evidence?', {
  fitting: 'the scope stated fits the evidence',
  too_broad: 'it claims more generality than the evidence supports',
  too_narrow: 'it claims less than the evidence supports',
  no_claim: 'no claim rests on this step',
  cannot_tell: 'what is shown here is not enough to tell'
});

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
  reading: READING,
  scope: SCOPE
};

/** J3-J4 for an observation a later text cites. */
export const OBSERVATION_QUESTIONS: Readonly<Record<string, Rule>> = { reading: READING, scope: SCOPE };

/** J5-J6: one call per round. */
export const ROUND_QUESTIONS: Readonly<Record<string, Rule>> = {
  refutation: choice('Read timeline in order: the beliefs held at the start, the verdicts of the checks the researcher was given, the steps it took and what each showed, and how it closed. When a verdict or a result contradicted a belief held at the start, what did the researcher do?', {
    revised: 'it revised or dropped the belief',
    kept_with_reason: 'it kept the belief and said explicitly why the contrary result does not refute it',
    kept_without_reason: 'it kept the belief with no reason given',
    no_contrary_evidence: 'no verdict or result contradicted a held belief',
    cannot_tell: 'what is shown here is not enough to tell'
  }),
  control: choice('When the round\'s closing claims that something causes or explains an outcome, does it rest on a comparison (two runs or acts that differ in one thing, or a baseline)?', {
    comparison_used: 'yes: a comparison or baseline supports the causal claim',
    no_comparison: 'a causal claim is made without a comparison or baseline',
    no_causal_claim: 'no causal claim is made',
    cannot_tell: 'what is shown here is not enough to tell'
  })
};

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const text = (v: unknown, n: number): string => clip(typeof v === 'string' ? v : JSON.stringify(v), n);

/** What a step showed, for the Judge: the points the text after it cites first (within a cited range too), then the rest
    while it fits; each as it was shown. What does not fit is said, not hidden. */
export function shownFor(l: Link, budget = 4000): string {
  const entries = Object.entries(l.shown);
  if (!entries.length) return '(nothing shown point by point: only the result)';
  const cites = l.after?.cites_this ?? [];
  const cited = (point: string): boolean => {
    const m = /^(.+)@(\d+)$/.exec(point);
    return cites.some((c) => {
      if (c === point || (m && c === m[1])) return true;
      /* A cited range of the same episode ("g1@2-5") holds the point when its step is within. */
      const range = /^(.+)@(\d+)(?:\s*[–-]\s*(\d+))?$/.exec(c);
      return Boolean(m && range && range[1] === m[1] && Number(range[2]) <= Number(m[2]) && Number(m[2]) <= Number(range[3] ?? range[2]));
    });
  };
  const ordered = [...entries.filter(([k]) => cited(k)), ...entries.filter(([k]) => !cited(k))];
  const out: string[] = [];
  let used = 0, left = 0;
  for (const [k, v] of ordered) {
    const piece = k + (cited(k) ? ' (cited after)' : '') + ':\n' + v;
    if (used + piece.length > budget) { left++; continue; }
    out.push(piece); used += piece.length;
  }
  return out.join('\n\n') + (left ? '\n\n(' + left + ' more points were shown and are not included here)' : '');
}

/** The texts the Judge is shown of a link. */
export function linkTexts(l: Link): Record<string, string> {
  return {
    held_before: text(l.before.beliefs.map((b) => b.id + ': ' + b.statement).join('\n') || '(none)', 3000),
    ...(l.before.operator_message ? { operator_message: text(l.before.operator_message, 1500) } : {}),
    requests: text(l.requests, 1200),
    result: text(l.result, 2500),
    shown: shownFor(l),
    written_after: l.after
      ? text({ rationale: l.after.rationale, beliefs: l.after.beliefs, citations_of_this_step: l.after.cites_this }, 4000)
      : '(the run ended before writing anything after this step)'
  };
}

/** The texts the Judge is shown of a stretch, in the order the researcher lived it: what it held, the verdicts of the checks
    it was given, its steps with what they showed, and what closed it. */
export function roundTexts(r: Segment, record: LinkRecord): Record<string, string> {
  const links = record.links.filter((l) => r.links.includes(l.id) && l.kind !== 'recall');
  const timeline = [
    { held_at_start: r.held.map((b) => b.id + ': ' + b.statement) },
    ...r.checks_before.map((c) => ({ verdict_of_a_check_it_was_given: c })),
    ...links.map((l) => ({ step: l.id, requests: l.requests, result: l.result, shown: shownFor(l, 800) })),
    { closed_by: r.closed_by ?? '(nothing closed it)' }
  ];
  return { timeline: text(timeline, 9000) };
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
  /** J3-J4 of the observations a later text cites. */
  readonly observations: Readonly<Record<string, Record<string, Verdict | null>>>;
  readonly rounds: Readonly<Record<string, Record<string, Verdict | null>>>;
  readonly calls: number;
  readonly errors: readonly string[];
}

/** J1-J4 for each experiment link, J3-J4 for each cited observation, J5-J6 for each stretch something closed. */
export async function judgeMethod(record: LinkRecord, judge: Judge): Promise<Judgements> {
  const links: Record<string, Record<string, Verdict | null>> = {};
  const observations: Record<string, Record<string, Verdict | null>> = {};
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
  await Promise.all(record.links.filter((l) => l.kind === 'observation' && (l.after?.cites_this.length ?? 0) > 0).map(async (l) => {
    const v = await ask(linkTexts(l), OBSERVATION_QUESTIONS, l.id);
    if (v) observations[l.id] = v;
  }));
  await Promise.all(record.rounds.filter((r) => r.closed_by).map(async (r) => {
    const v = await ask(roundTexts(r, record), ROUND_QUESTIONS, r.id);
    if (v) rounds[r.id] = v;
  }));
  return { links, observations, rounds, calls, errors };
}
