/* ============================================================================
 * Reports of the instrument (SPEC-CALIBRACION-INSTRUMENTOS §4): in a simulated world the code IS
 * the reality, and a fault in it is a false law the researcher learns in earnest. The assisted
 * researcher and its senior may say, in any of their answers, that the environment did something
 * its interface does not say: an `instrument_report`. It is a suspicion about the instrument -
 * never a belief, never evidence about the world - logged for the operator, and costs no step.
 * ========================================================================== */

export const INSTRUMENT_KINDS = ['accepted_but_not_applied', 'inconsistent_answer', 'impossible_value', 'not_what_the_interface_says', 'other'] as const;
export type InstrumentKind = typeof INSTRUMENT_KINDS[number];

export interface InstrumentReport {
  readonly what: string;
  readonly evidence: readonly string[];
  readonly kind: InstrumentKind;
}

/** What the assisted researcher is told of the instrument: that it may fail, how to check it, and how to report it. */
export const INSTRUMENT_SECTION = [
  'THE INSTRUMENT. The environment you investigate is an instrument people built, and it may fail. An act it accepted and did not apply, two different answers to the same request, a value no world could give, an answer that is not what its interface says: until shown otherwise, that is a fault of the instrument, not a law of the world.',
  'You can check the instrument with the instruments you have: ask for the same act again (does it answer the same?), make an intervention where it must change something, and read what the environment echoes of your own request.',
  'When you suspect it, say so in any of your answers: "instrument_report": {"what": "<what the environment did that does not fit what its interface says>", "evidence": ["<episodes, points, steps>"], "kind": "accepted_but_not_applied" | "inconsistent_answer" | "impossible_value" | "not_what_the_interface_says" | "other"}. It costs no step, and the operator reads it.',
  'A report is not a belief about the environment and not evidence: until the operator answers it, build nothing on the episodes it names.'
].join('\n');

/** The reports in an answer (`instrument_report`: one, or a list), or none: one with no `what` is not a report. */
export function instrumentReports(said: Record<string, unknown> | null): InstrumentReport[] {
  const raw = said?.instrument_report;
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  const out: InstrumentReport[] = [];
  for (const r of list as Record<string, unknown>[]) {
    const what = typeof r?.what === 'string' ? r.what.trim() : '';
    if (!what) continue;
    const kind = (INSTRUMENT_KINDS as readonly string[]).includes(String(r.kind)) ? r.kind as InstrumentKind : 'other';
    out.push({ what, evidence: (Array.isArray(r.evidence) ? r.evidence : []).map(String), kind });
  }
  return out;
}
