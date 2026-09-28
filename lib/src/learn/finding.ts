/* ============================================================================
 * The FINDING of a run (SPEC-OBJETIVO O10): what another agent - or a person - needs to
 * use its result without reading the journal. Derived from the journal by the operator,
 * after the run: System 2 never sees it, and nothing in it is new evidence.
 *
 *   question         the world and the form of the answer it asked for
 *   outcome          accepted, stopped by --quick, out of budget, or the LLM failed
 *   model            the final model, in its own code and words, with its fingerprint
 *   claims           what the learner holds (its beliefs, with their evidence)
 *   tested           where the model was checked when it was accepted: laboratories, the
 *                    family, the blind places - and each place's description
 *   counterexamples  places where a validation failed, and when
 *   limitations      misses the criterion tolerated, checks a model that knows nothing
 *                    also passed, and what the learner itself said it did not settle
 *   operator         what only the operator knows: the grade against the hidden truth, the
 *                    Judge ablation, the truth itself (a real laboratory has none)
 *   cost, reproduce  what it took, and how to run it again
 *
 * The same for every world: a place's facts are kept as its objective reported them.
 * ========================================================================== */

type J = Record<string, any>;
type Facts = Record<string, unknown>;

export interface Finding {
  readonly format: 'finding@1';
  readonly question: { readonly world: string; readonly answer_form?: readonly string[]; readonly verdict_form?: readonly string[] };
  readonly outcome: { readonly status: string; readonly round: number | null; readonly attempt: number | null };
  readonly model: { readonly round: number | null; readonly fingerprint: string | null; readonly law: unknown } | null;
  readonly claims: readonly { readonly id: string; readonly statement: string; readonly status: string; readonly since?: number; readonly evidence: readonly string[] }[];
  readonly tested: {
    readonly places: readonly Facts[];
    readonly at_acceptance: {
      readonly round: number;
      readonly laboratories: readonly Facts[];
      readonly family: readonly Facts[];
      readonly blind: readonly { readonly set: number; readonly ok: boolean; readonly places: readonly Facts[] }[];
    } | null;
    readonly validations: readonly unknown[];
  };
  readonly counterexamples: readonly { readonly round: number; readonly where: 'family' | 'blind'; readonly place: string; readonly facts: Facts }[];
  readonly limitations: {
    readonly tolerated_misses: readonly { readonly place: string; readonly missed: number; readonly points: number }[];
    readonly trivially_passed: readonly unknown[];
    readonly accepted_trivially: boolean;
    readonly learner: { readonly rationale?: string; readonly lessons: readonly string[]; readonly next_experiment?: string } | null;
  };
  readonly operator: { readonly rule_recovery?: Facts; readonly judge?: unknown; readonly truth?: unknown };
  readonly cost: { readonly total?: Facts; readonly to_acceptance?: Facts };
  readonly reproduce: { readonly experiment: string; readonly started?: string; readonly config?: unknown; readonly journal?: string; readonly commit?: string };
}

/** A place's facts as its objective reported them, without the case-by-case trace (it stays in the journal). */
const facts = (p: J): Facts => {
  const { trace: _t, ...rest } = p ?? {};
  return rest;
};

/** How many cases a place that held still missed, when its facts say so (points and agreed / exact). */
function missed(p: J): number | null {
  const good = typeof p?.agreed === 'number' ? p.agreed : typeof p?.exact === 'number' ? p.exact : null;
  return typeof p?.points === 'number' && good !== null ? p.points - good : null;
}

/** The finding of a journal (any world run through the protocol). `meta`: what the journal does not hold. */
export function findingOf(journal: J, meta: { journal?: string; commit?: string } = {}): Finding {
  const events: J[] = Array.isArray(journal.events) ? journal.events : [];
  const end: J = [...events].reverse().find((e) => e.type === 'end') ?? {};
  const checks = events.filter((e) => e.type === 'check');
  const summary: J = end.operator_summary ?? {};
  const acceptedRound: number | null = summary.accepted?.round ?? events.find((e) => e.type === 'accepted')?.round ?? null;
  const acceptance = acceptedRound !== null ? [...checks].reverse().find((c) => c.round === acceptedRound && c.accepted) : undefined;

  /* The final model: the lab runner writes the model itself; orbit wraps it as { round, fingerprint, test, law }. */
  const final: J | null = end.final ?? null;
  const wrapped = Boolean(final && !('observations' in final) && final.law && typeof final.law === 'object');
  const law = wrapped ? final!.law : final;
  const proposals = events.filter((e) => e.type === 'proposal');
  const round: number | null = (wrapped ? final!.round : null) ?? acceptedRound ?? proposals[proposals.length - 1]?.round ?? null;
  const fingerprint: string | null = (wrapped ? final!.fingerprint : null) ?? proposals.find((p) => p.round === round)?.fingerprint ?? null;

  const beliefs: J[] = Array.isArray(end.notebook?.beliefs) ? end.notebook.beliefs : [];
  const claims = beliefs.filter((b) => b.status !== 'dropped').map((b) => {
    const last = Array.isArray(b.history) ? b.history[b.history.length - 1] : undefined;
    return { id: String(b.id), statement: String(b.statement ?? ''), status: String(b.status ?? ''), ...(typeof b.since === 'number' ? { since: b.since } : {}),
      evidence: Array.isArray(last?.evidence) ? last.evidence.map(String) : [] };
  });

  const blindSets: J[] = acceptance?.validation?.blind_confirmation?.sets ?? [];
  const atAcceptance = acceptance ? {
    round: acceptance.round as number,
    laboratories: (acceptance.laboratories ?? []).map(facts),
    family: (acceptance.validation?.family ?? []).map(facts),
    blind: blindSets.map((s, i) => ({ set: i + 1, ok: Boolean(s.ok), places: (s.places ?? []).map(facts) }))
  } : null;

  const counterexamples: { round: number; where: 'family' | 'blind'; place: string; facts: Facts }[] = [];
  for (const c of checks) {
    for (const p of c.validation?.family ?? []) if (p.holds === false) counterexamples.push({ round: c.round, where: 'family', place: String(p.place), facts: facts(p) });
    for (const s of c.validation?.blind_confirmation?.sets ?? []) for (const p of s.places ?? []) if (p.holds === false) counterexamples.push({ round: c.round, where: 'blind', place: String(p.place), facts: facts(p) });
  }

  const tolerated: { place: string; missed: number; points: number }[] = [];
  if (atAcceptance) {
    for (const p of [...atAcceptance.laboratories, ...atAcceptance.family, ...atAcceptance.blind.flatMap((s) => s.places)] as J[]) {
      const m = p.holds ? missed(p) : null;
      if (m) tolerated.push({ place: String(p.place), missed: m, points: p.points });
    }
  }

  const reflections: J[] = events.filter((e) => e.type === 'reflection');
  const last = reflections[reflections.length - 1];
  /* The grade against the hidden truth: of a rule (grid, cells, messages) or of a law (orbit). */
  const recovery = [...events].reverse().find((e) => e.type === 'operator_rule_recovery' || e.type === 'operator_law_recovery');
  const status = String(end.stoppedBy ?? (acceptedRound !== null ? 'accepted' : 'unfinished'));
  const places: J[] = end.places ?? journal.hidden_from_the_learner?.places ?? [];
  const commit = meta.commit ?? journal.commit;

  return {
    format: 'finding@1',
    question: { world: String(journal.experiment ?? ''), ...(journal.objective?.answer ? { answer_form: journal.objective.answer } : {}),
      ...(journal.objective?.verdict ? { verdict_form: journal.objective.verdict } : {}) },
    outcome: { status, round: status === 'accepted' ? acceptedRound : round, attempt: summary.accepted?.attempt ?? acceptance?.attempt ?? null },
    model: law ? { round, fingerprint, law } : null,
    claims,
    tested: { places: places.map((p) => ({ ...p })), at_acceptance: atAcceptance, validations: summary.validations ?? [] },
    counterexamples,
    limitations: {
      tolerated_misses: tolerated,
      trivially_passed: summary.trivial_checks ?? [],
      accepted_trivially: Boolean(summary.accepted_trivially),
      learner: last ? { ...(last.rationale ? { rationale: String(last.rationale) } : {}), lessons: (last.lessons ?? []).map(String),
        ...(last.next_experiment ? { next_experiment: String(last.next_experiment) } : {}) } : null
    },
    operator: {
      ...(recovery && !recovery.error ? { rule_recovery: { score: recovery.score, form: recovery.form, grades: recovery.grades, false_beliefs: recovery.false_beliefs } } : {}),
      ...(summary.judge ? { judge: summary.judge } : {}),
      ...(journal.hidden_from_the_learner?.truth ? { truth: journal.hidden_from_the_learner.truth } : {})
    },
    cost: { ...(summary.cost ? { total: summary.cost } : {}), ...(summary.cost_per_acceptance ? { to_acceptance: summary.cost_per_acceptance } : {}) },
    reproduce: { experiment: String(journal.experiment ?? ''), ...(journal.started ? { started: journal.started } : {}), ...(journal.config ? { config: journal.config } : {}),
      ...(meta.journal ? { journal: meta.journal } : {}), ...(commit ? { commit } : {}) }
  };
}

/** A finding in a few lines, for a person (the console, a report). */
export function findingText(f: Finding): string {
  const lines: string[] = [];
  lines.push(f.question.world + ': ' + (f.outcome.status === 'accepted' ? 'accepted in round ' + f.outcome.round : f.outcome.status)
    + (f.model?.fingerprint ? ' (model ' + f.model.fingerprint + ')' : ''));
  for (const c of f.claims) lines.push('  claim [' + c.status + '] ' + c.statement);
  const a = f.tested.at_acceptance;
  if (a) {
    const held = (ps: readonly Facts[]) => ps.map((p) => String(p.place) + (p.holds ? '' : ' (not)')).join(', ');
    lines.push('  held in: laboratories ' + held(a.laboratories) + (a.family.length ? '; family ' + held(a.family) : '')
      + (a.blind.length ? '; blind ' + a.blind.map((s) => held(s.places)).join(' | ') : ''));
  }
  for (const c of f.counterexamples) lines.push('  counterexample: round ' + c.round + ', ' + c.where + ' ' + c.place);
  for (const t of f.limitations.tolerated_misses) lines.push('  tolerated: ' + t.missed + ' of ' + t.points + ' missed in ' + t.place);
  if (f.limitations.accepted_trivially) lines.push('  WARNING: a model that knows nothing passed the accepting check too');
  if (f.limitations.learner?.next_experiment) lines.push('  open (the learner): ' + f.limitations.learner.next_experiment);
  if (f.operator.rule_recovery) lines.push('  operator: rule recovery ' + String(f.operator.rule_recovery.score) + ' (' + String(f.operator.rule_recovery.form ?? '') + ')');
  if (f.cost.total) lines.push('  cost: ' + Object.entries(f.cost.total).map(([k, v]) => k + ' ' + String(v)).join(', '));
  return lines.join('\n');
}
