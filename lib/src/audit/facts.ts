import type { Judge, Rule } from '../core/types.ts';
import type { LinkRecord } from './links.ts';

/* ============================================================================
 * THE METHOD AUDIT, facts that can be checked (SPEC-AUDITORIA-METODO O6, MA2) - the same for every
 * world. A claim that something was observed at points cites them; code gathers what the run
 * recorded as shown at those points (the frames, rows, messages, values the researcher saw - read
 * by their form, `shownBy`, never by the world), and the Judge says whether that supports the
 * claim, contradicts it, or cannot tell. Code never reads a picture or a table: what a world draws
 * is its own business. A claim whose points were never shown is `unverifiable` without asking.
 * ========================================================================== */

export interface FactCheck {
  readonly status: 'true' | 'false' | 'unverifiable';
  /** The Judge's answer (supported, contradicted, cannot_tell) with its probability, or why it was not asked. */
  readonly detail: string;
  readonly points: readonly string[];
  readonly distribution?: Readonly<Record<string, number>>;
}

export const FACT_QUESTION: Readonly<Record<string, Rule>> = {
  fact: { type: 'choice', option: 'supported', instructions: 'Read claim, then shown: what was recorded as shown at the points the claim cites, exactly as it was shown. Does what was shown at those points support the claim?',
    criteria: {
      supported: 'what was shown at those points is what the claim says',
      contradicted: 'what was shown at those points is not what the claim says',
      cannot_tell: 'what was shown is not enough to tell'
    } }
};

/** Every point the run recorded as shown, with what was shown there (the first time it was). */
export function recordedPoints(record: LinkRecord): Map<string, string> {
  const out = new Map<string, string>();
  for (const l of record.links) for (const [point, content] of Object.entries(l.shown)) if (!out.has(point)) out.set(point, content);
  return out;
}

/** The points a citation names: "g1@3", or each point of a range "g1@0-2" (a few at most). */
export function pointsOf(cite: string, most = 6): string[] {
  const m = /^(.+?)@(\d+)(?:\s*[–-]\s*(\d+))?$/.exec(cite.trim());
  if (!m) return [];
  const from = Number(m[2]), to = Math.min(Number(m[3] ?? m[2]), from + most - 1);
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => m[1] + '@' + (from + i));
}

/** A claim of a fact checked: what was shown at its points, judged. Without a Judge, or with nothing shown, unverifiable. */
export async function checkFact(claim: string, cites: readonly string[], recorded: Map<string, string>, judge: Judge | null): Promise<FactCheck> {
  const points = [...new Set(cites.flatMap((c) => pointsOf(c)))];
  const shown = points.filter((p) => recorded.has(p));
  if (!shown.length) return { status: 'unverifiable', detail: points.length ? 'nothing was recorded as shown at ' + points.join(', ') : 'it cites no point', points };
  if (!judge) return { status: 'unverifiable', detail: 'not judged (no Judge in this audit)', points: shown };
  const texts = { claim, shown: shown.map((p) => p + ':\n' + recorded.get(p)).join('\n\n').slice(0, 6000) };
  const answers = await judge.judge({ world: 'method-audit', rulesOfTheWorld: '', sideToMove: '', measurements: {}, texts, questions: FACT_QUESTION });
  const raw = (answers.fact?.raw ?? {}) as { probabilities?: Record<string, unknown> };
  const distribution = Object.fromEntries(Object.entries(raw.probabilities ?? {}).map(([k, v]) => [k, Number(v)]).filter(([, v]) => Number.isFinite(v as number))) as Record<string, number>;
  const best = Object.entries(distribution).sort(([, a], [, b]) => b - a)[0];
  if (!best) return { status: 'unverifiable', detail: 'the Judge gave no answer', points: shown };
  const status = best[0] === 'supported' ? 'true' : best[0] === 'contradicted' ? 'false' : 'unverifiable';
  return { status, detail: best[0] + ' (p ' + Math.round(best[1] * 1000) / 1000 + ')', points: shown, distribution };
}
