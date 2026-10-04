import { parseJsonLoose } from '../core/net.ts';
import type { Judge } from '../core/types.ts';
import type { ChatClient } from '../learn/system2.ts';
import { citesIn, type LinkRecord } from './links.ts';
import { checkFact, pointsOf, recordedPoints, type FactCheck } from './facts.ts';

/* ============================================================================
 * THE METHOD AUDIT, what each text claims (SPEC-AUDITORIA-METODO §5, MA2) - the same for every
 * world. An LLM turns the free text of each proposal, reflection and operator's message into
 * structured claims: what is claimed, as what (a fact seen at points, a pattern of a sample, a
 * hypothesis), and the points or steps it cites. The facts are then checked against what the run
 * recorded as shown at their points (facts.ts, O6), by the Judge.
 *
 * The extractor structures; it judges nothing and corrects nothing. It is shown the text and what
 * was shown at the points the text cites, nothing hidden. It should be of another family than the
 * researcher audited, so that no one reads themselves kindly: the audit says when it is not.
 * ========================================================================== */

type J = Record<string, any>;

export type ClaimKind = 'fact' | 'hypothesis' | 'sample_pattern';

export interface Claim {
  readonly text: string;
  readonly kind: ClaimKind;
  readonly cites: readonly string[];
  readonly check?: FactCheck;
}

export interface Source {
  /** "r<round>", "r<round>.reflection", or "message:<question>" for an operator's message. */
  readonly id: string;
  readonly author: 'researcher' | 'operator';
  readonly by?: string;
  readonly round: number | null;
  readonly claims: readonly Claim[];
  readonly error?: string;
}

export const EXTRACT_SYSTEM = [
  'You structure what a text claims. You judge nothing, and you never correct the text: you write down what it says, as it says it.',
  'The text is written by a researcher about an environment it investigates (a proposal or a reflection of its own), or by someone who advises it (a message). Under `shown` you are given what was shown at the points the text cites, so that you can tell which claim a citation belongs to; do not use it to change a claim.',
  'For each distinct claim of the text, give: "text" (the claim, briefly, in the text\'s words, keeping every detail it states: places, values, steps), "kind" and "cites" (the references the text gives for that claim: points like "g20@6" or "ep1@3-5", steps like "round 3 investigation step 2"; [] if none).',
  '"kind" is "fact" when the claim states that something was observed at particular points (it happened there); "sample_pattern" when it states a regularity of a recorded sample (in these episodes, every loss ended ...); "hypothesis" when it proposes a rule or an explanation, however firmly it is stated.',
  'Answer only JSON: {"claims": [{"text": "...", "kind": "fact" | "hypothesis" | "sample_pattern", "cites": [...]}]}.'
].join('\n');

const KINDS: readonly ClaimKind[] = ['fact', 'hypothesis', 'sample_pattern'];

/** The text of a proposal or reflection as the extractor reads it. */
function closerText(e: J): string {
  const beliefs: J[] = Array.isArray(e.beliefs) ? e.beliefs : [];
  return [
    e.rationale ? 'Rationale: ' + String(e.rationale) : '',
    ...beliefs.map((b) => 'Belief ' + String(b.id) + ' (' + String(b.stance ?? '') + '): ' + String(b.statement ?? '') + (b.why ? ' Why: ' + String(b.why) : '') + (Array.isArray(b.evidence) && b.evidence.length ? ' Evidence: ' + b.evidence.join(', ') : '')),
    ...(Array.isArray(e.lessons) && e.lessons.length ? ['Lessons: ' + e.lessons.join(' | ')] : [])
  ].filter(Boolean).join('\n');
}

/** The texts of a run that make claims: its proposals and reflections, and the operator's messages to it. */
export function sourcesOf(journal: J): { id: string; author: 'researcher' | 'operator'; by?: string; round: number | null; text: string }[] {
  const out: { id: string; author: 'researcher' | 'operator'; by?: string; round: number | null; text: string }[] = [];
  for (const e of (journal?.events ?? []) as J[]) {
    if (e.type === 'proposal' || e.type === 'reflection') out.push({ id: 'r' + e.round + (e.type === 'reflection' ? '.reflection' : ''), author: 'researcher', round: typeof e.round === 'number' ? e.round : null, text: closerText(e) });
    if (e.type === 'operator_message') for (const m of (e.messages ?? []) as J[]) {
      if (m.text) out.push({ id: 'message:' + e.question + (e.messages.length > 1 ? '.' + m.id : ''), author: 'operator', ...(m.by ? { by: String(m.by) } : {}), round: null, text: String(m.text) });
    }
  }
  return out;
}

/** Each text's claims, structured; with a Judge, the facts among them checked against what was shown at their points. */
export async function extractClaims(journal: J, record: LinkRecord, llm: ChatClient, judge: Judge | null, options: { maxShown?: number } = {}): Promise<Source[]> {
  const recorded = recordedPoints(record);
  const out: Source[] = [];
  for (const s of sourcesOf(journal)) {
    const shown: Record<string, string> = {};
    for (const p of citesIn(s.text).points) for (const point of pointsOf(p.ref, 4)) {
      const content = recorded.get(point);
      if (content && Object.keys(shown).length < (options.maxShown ?? 8)) shown[point] = content;
    }
    try {
      const answer = await llm.complete({ system: EXTRACT_SYSTEM, user: { text: s.text, shown } });
      const parsed = parseJsonLoose(answer.content) as { claims?: J[] } | null;
      const claims: Claim[] = [];
      for (const c of (parsed?.claims ?? []).filter((x) => x && typeof x.text === 'string')) {
        const kind: ClaimKind = KINDS.includes(c.kind) ? c.kind : 'hypothesis';
        const cites = Array.isArray(c.cites) ? c.cites.map(String) : [];
        claims.push({ text: String(c.text), kind, cites, ...(kind === 'fact' ? { check: await checkFact(String(c.text), cites, recorded, judge) } : {}) });
      }
      out.push({ id: s.id, author: s.author, ...(s.by ? { by: s.by } : {}), round: s.round, claims });
    } catch (e) {
      out.push({ id: s.id, author: s.author, ...(s.by ? { by: s.by } : {}), round: s.round, claims: [], error: String((e as Error)?.message ?? e).slice(0, 200) });
    }
  }
  return out;
}

/** The measures of the claims: by kind, and the facts checked - true, false, unverifiable - by who said them; and claims by
    kind against what the check found (a false fact stated as a fact is the method's failure, not a hypothesis that failed). */
export function factMeasures(sources: readonly Source[]): J {
  const claims = sources.flatMap((s) => s.claims.map((c) => ({ ...c, author: s.author })));
  const count = (f: (c: typeof claims[number]) => boolean) => claims.filter(f).length;
  const checked = (author?: string) => {
    const of = claims.filter((c) => c.check && (!author || c.author === author));
    const t = of.filter((c) => c.check!.status === 'true').length, f = of.filter((c) => c.check!.status === 'false').length;
    return { checked: of.length, true: t, false: f, unverifiable: of.length - t - f, accuracy: t + f ? Math.round(t / (t + f) * 1000) / 1000 : null };
  };
  return {
    claims: claims.length,
    by_kind: Object.fromEntries(KINDS.map((k) => [k, count((c) => c.kind === k)])),
    facts: checked(), facts_of_the_researcher: checked('researcher'), facts_of_the_operator: checked('operator'),
    false_facts: claims.filter((c) => c.check?.status === 'false').map((c) => ({ author: c.author, text: c.text, points: c.check!.points, detail: c.check!.detail })),
    sources_failed: sources.filter((s) => s.error).length
  };
}
