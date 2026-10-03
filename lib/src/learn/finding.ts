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
 *   operator         what only the operator measured: the Judge ablation and, for a world
 *                    someone wrote, its truth and the grade against it (a real laboratory has
 *                    none: its finding is complete without them)
 *   cost, reproduce  what it took, and how to run it again
 *
 * The same for every world: a place's facts are kept as its objective reported them.
 *
 * Two VIEWS (SPEC-OBJETIVO O14). The operator's (the one above) is for audit: it keeps every
 * measure of the operator - the Judge ablation, what it computed with what only it has (a
 * solver's view of each move, a known law's score) and, for a world someone wrote, its truth
 * and the grade against it. The researcher's is for another agent that will use or extend
 * the result: only what the world answered. The operator part is gone, a place is only its
 * name and role (the operator's description of it is gone), and of a place's facts only what
 * anyone could observe is kept - whether the model held, and the counts of its cases. A fact
 * is kept only if it is known to be observable: a new measure of the operator stays out
 * until it is added here.
 * ========================================================================== */

type J = Record<string, any>;
type Facts = Record<string, unknown>;

export type FindingView = 'operator' | 'researcher';

export interface Finding {
  readonly format: 'finding@1';
  /** Whose view: the operator's (every measure, for audit) or a researcher's (only what the world answered). */
  readonly view: FindingView;
  /** Which researcher produced it (SPEC-INVESTIGADOR-ASISTIDO): the unknown-world one learns only from what the world
      answered; the assisted one may have been helped (what help, in `assistance`). */
  readonly researcher: string;
  readonly question: { readonly world: string; readonly answer_form?: readonly string[]; readonly verdict_form?: readonly string[];
    /** The facet the task was about at the start, and what the operator wanted understood (assisted). */
    readonly focus?: string; readonly task?: string };
  readonly outcome: { readonly status: string; readonly round: number | null; readonly attempt: number | null };
  readonly model: { readonly round: number | null; readonly fingerprint: string | null; readonly law: unknown } | null;
  readonly claims: readonly { readonly id: string; readonly statement: string; readonly status: string; readonly since?: number; readonly evidence: readonly string[];
    /** Assisted researcher: where its evidence comes from - the world (points of episodes), the operator's messages, sources. */
    readonly grounded?: readonly ('world' | 'operator' | 'sources' | 'experience')[] }[];
  /** Assisted researcher (SPEC-INVESTIGADOR-ASISTIDO §7): what help it had. It is provenance, so both views keep it. */
  readonly assistance?: {
    readonly messages: readonly { readonly id: string; readonly question: number; readonly text: string; readonly by?: string; readonly at?: string;
      /** Whether a person or an agent (SPEC-ORQUESTADOR R1) wrote it. */
      readonly author?: 'person' | 'agent' }[];
    /** The run's help budget, if it had one. */
    readonly help_budget?: number;
    readonly focus_changes: readonly unknown[];
    /** Handed to the assisted researcher after these rounds of the unknown-world researcher's. */
    readonly assisted_after_attempts?: number;
    /** Sources: the origins the operator allowed, and what the researcher opened and looked for in them. */
    readonly sources: { readonly origins: readonly string[]; readonly opened: readonly string[]; readonly found: readonly string[] };
    /** Its selective memory (§13): what it recalled of its own record - lists, items opened, finds (with what the Judge kept). */
    readonly memory?: { readonly mode: string; readonly listed: readonly string[]; readonly opened: readonly string[]; readonly found: readonly string[]; readonly selections: number };
    /** The records of earlier runs it was given (§12), in which mode, and what it read of them. A run given experience of
        its own world (`meta`) is not a measure of investigating from nothing: `prior_knowledge_of_this_world` says so. */
    readonly experience?: { readonly mode: string; readonly scope: string; readonly prior_knowledge_of_this_world: boolean;
      readonly runs: readonly { readonly label: string; readonly same_world: boolean; readonly researcher: string; readonly model: string | null }[];
      readonly read: readonly string[]; readonly selections: number };
  };
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
  /** The operator's view only. */
  readonly operator?: { readonly rule_recovery?: Facts; readonly judge?: unknown; readonly truth?: unknown };
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
  const assisted = journal.researcher === 'assisted';
  /* Where a piece of evidence comes from: a message of the operator, a source, or the world (a point or an episode). */
  const origin = (ref: string): 'world' | 'operator' | 'sources' | 'experience' => (/^operator:/.test(ref) ? 'operator' : /^src:/.test(ref) ? 'sources' : /^exp:/.test(ref) ? 'experience' : 'world');
  const claims = beliefs.filter((b) => b.status !== 'dropped').map((b) => {
    /* The latest evidence it cited: a reflection may confirm a belief without citing anything again. */
    const last = Array.isArray(b.history) ? [...b.history].reverse().find((h: J) => Array.isArray(h.evidence) && h.evidence.length) : undefined;
    const evidence: string[] = Array.isArray(last?.evidence) ? last.evidence.map(String) : [];
    return { id: String(b.id), statement: String(b.statement ?? ''), status: String(b.status ?? ''), ...(typeof b.since === 'number' ? { since: b.since } : {}),
      evidence, ...(assisted ? { grounded: (['world', 'operator', 'sources', 'experience'] as const).filter((o) => evidence.some((r) => origin(r) === o)) } : {}) };
  });
  const requests: J[] = events.filter((e) => e.type === 'investigation').flatMap((e) => (Array.isArray(e.requests) ? e.requests : []));
  const given = events.find((e) => e.type === 'experience');
  const assistance = assisted ? {
    messages: events.filter((e) => e.type === 'operator_message').flatMap((e) => (e.messages ?? []).map((m: J) => ({ id: String(m.id), question: e.question, text: String(m.text ?? ''),
      ...(m.by ? { by: String(m.by) } : {}), ...(m.at ? { at: String(m.at) } : {}), author: String(m.by ?? '').startsWith('agent:') ? 'agent' as const : 'person' as const }))),
    ...(typeof journal.help_budget === 'number' ? { help_budget: journal.help_budget } : {}),
    focus_changes: events.filter((e) => e.type === 'focus_changed'),
    /* A run handed to the assisted researcher: after how many rounds (before them, the unknown-world researcher). */
    ...(typeof journal.assisted_after_attempts === 'number' ? { assisted_after_attempts: journal.assisted_after_attempts } : {}),
    sources: {
      origins: [...String(journal.config?.sources_allow ?? '').split(',').map((o) => o.trim()).filter(Boolean),
        ...events.filter((e) => e.type === 'sources_allowed').map((e) => String(e.origin))],
      /* What it read, as its investigation asked for it. */
      opened: requests.filter((r) => typeof r.open === 'string').map((r) => String(r.open) + (r.from !== undefined || r.to !== undefined ? '#L' + (r.from ?? 1) + '-' + (r.to ?? '') : '')),
      found: requests.filter((r) => typeof r.find === 'string').map((r) => String(r.find) + ' in ' + String(r.in ?? '') + (r.select ? ' (select: ' + String(r.select) + ')' : ''))
    },
    ...(journal.config?.memory ? { memory: {
      mode: String(journal.config.memory),
      listed: requests.filter((r) => r.memory === 'list').map((r) => String(r.of ?? '(counts)')),
      opened: requests.filter((r) => r.memory === 'open').flatMap((r) => (Array.isArray(r.items) ? r.items : [r.item]).map(String)),
      found: requests.filter((r) => r.memory === 'find').map((r) => String(r.words ?? '') + (r.of ? ' of ' + String(r.of) : '') + (r.select ? ' (select: ' + String(r.select) + ')' : '')),
      selections: events.filter((e) => e.type === 'memory_select').length
    } } : {}),
    ...(given ? { experience: {
      mode: String(given.mode),
      scope: String(given.scope ?? 'all'),
      prior_knowledge_of_this_world: (given.runs ?? []).some((r: J) => r.same_world || r.knows_this_world),
      runs: (given.runs ?? []).map((r: J) => ({ label: String(r.label), same_world: Boolean(r.same_world), researcher: String(r.researcher ?? ''), model: r.model ?? null })),
      read: requests.filter((r) => typeof r.experience === 'string').map((r) => String(r.experience) + (r.run ? ' ' + String(r.run) : '') + (r.of ? ' of ' + String(r.of) : '')
        + (Array.isArray(r.items) ? ' ' + r.items.map(String).join(', ') : '') + (r.words ? ' "' + String(r.words) + '"' : '') + (r.select ? ' (select: ' + String(r.select) + ')' : '')),
      selections: events.filter((e) => e.type === 'experience_select').length
    } } : {})
  } : undefined;

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
  /* The grade against the truth, where the world has one: of a rule (grid, cells, messages, tank) or of a law (orbit). */
  const recovery = [...events].reverse().find((e) => e.type === 'operator_rule_recovery' || e.type === 'operator_law_recovery');
  const status = String(end.stoppedBy ?? (acceptedRound !== null ? 'accepted' : 'unfinished'));
  const places: J[] = end.places ?? journal.hidden_from_the_learner?.places ?? [];
  const commit = meta.commit ?? journal.commit;

  return {
    format: 'finding@1',
    view: 'operator',
    researcher: String(journal.researcher ?? 'unknown-world'),
    question: { world: String(journal.experiment ?? ''), ...(journal.config?.focus ? { focus: String(journal.config.focus) } : {}), ...(journal.config?.task ? { task: String(journal.config.task) } : {}),
      ...(journal.objective?.answer ? { answer_form: journal.objective.answer } : {}),
      ...(journal.objective?.verdict ? { verdict_form: journal.objective.verdict } : {}) },
    outcome: { status, round: status === 'accepted' ? acceptedRound : round, attempt: summary.accepted?.attempt ?? acceptance?.attempt ?? null },
    model: law ? { round, fingerprint, law } : null,
    claims,
    ...(assistance ? { assistance } : {}),
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

/** The facts of a place anyone could observe: whether the model held there, and the counts of its cases. */
const OBSERVED = new Set(['place', 'holds', 'points', 'agreed', 'exact', 'failed', 'not_a_number', 'not_a_row', 'cells_wrong', 'wins', 'total', 'chi2_by_band']);
const observed = (p: Facts): Facts => Object.fromEntries(Object.entries(p).filter(([k]) => OBSERVED.has(k)));

/** A finding as a given audience may read it: the operator's as it is, or a researcher's without what only the operator knows. */
export function findingView(f: Finding, view: FindingView): Finding {
  if (view === 'operator') return f;
  const { operator: _hidden, ...rest } = f;
  const a = f.tested.at_acceptance;
  return {
    ...rest,
    view: 'researcher',
    tested: {
      places: f.tested.places.map((p) => ({ id: p.id, role: p.role, ...(p.seen !== undefined ? { seen: p.seen } : {}) })),
      at_acceptance: a ? { round: a.round, laboratories: a.laboratories.map(observed), family: a.family.map(observed),
        blind: a.blind.map((s) => ({ set: s.set, ok: s.ok, places: s.places.map(observed) })) } : null,
      validations: f.tested.validations
    },
    counterexamples: f.counterexamples.map((c) => ({ ...c, facts: observed(c.facts) }))
  };
}

/** A finding in a few lines, for a person (the console, a report). */
export function findingText(f: Finding): string {
  const lines: string[] = [];
  lines.push(f.question.world + ': ' + (f.outcome.status === 'accepted' ? 'accepted in round ' + f.outcome.round : f.outcome.status)
    + (f.model?.fingerprint ? ' (model ' + f.model.fingerprint + ')' : ''));
  for (const c of f.claims) lines.push('  claim [' + c.status + '] ' + c.statement + (c.grounded ? '  (from: ' + (c.grounded.join(', ') || 'nothing cited') + ')' : ''));
  if (f.assistance) lines.push('  assisted: ' + f.assistance.messages.length + ' message(s) of the operator' + (f.assistance.focus_changes.length ? ', ' + f.assistance.focus_changes.length + ' change(s) of focus' : '')
    + (f.assistance.sources.opened.length ? ', ' + f.assistance.sources.opened.length + ' read(s) of sources' : '')
    + (f.assistance.memory ? ', memory ' + f.assistance.memory.mode + ' (' + (f.assistance.memory.listed.length + f.assistance.memory.opened.length + f.assistance.memory.found.length) + ' recall(s))' : '')
    + (f.assistance.experience ? ', experience ' + f.assistance.experience.mode + ' (' + f.assistance.experience.scope + ') of ' + f.assistance.experience.runs.length + ' run(s) (' + f.assistance.experience.read.length + ' read(s))'
      + (f.assistance.experience.prior_knowledge_of_this_world ? ' - WITH PRIOR KNOWLEDGE OF THIS WORLD' : '') : ''));
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
  if (f.operator?.rule_recovery) lines.push('  operator: rule recovery ' + String(f.operator.rule_recovery.score) + ' (' + String(f.operator.rule_recovery.form ?? '') + ')');
  if (f.cost.total) lines.push('  cost: ' + Object.entries(f.cost.total).map(([k, v]) => k + ' ' + String(v)).join(', '));
  return lines.join('\n');
}
