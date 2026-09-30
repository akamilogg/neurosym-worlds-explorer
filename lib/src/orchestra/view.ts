/* ============================================================================
 * What an AGENT may see of a run (SPEC-ORQUESTADOR Q2): never more than the researcher it
 * helps. From a journal, only what the researcher did - its proposals, investigations,
 * beliefs, notes, lessons, plans, reflections - and what the environment told it: whether its
 * model held in each place, whether it was accepted. Never the hidden part of the journal, the
 * operator's measures (ablations, baselines, traces of what happened, the grading against the
 * truth), nor the world's description.
 * ========================================================================== */

type J = Record<string, any>;

const clip = (s: unknown, n: number): string => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
const held = (ps: unknown): { place: string; holds: boolean }[] => (Array.isArray(ps) ? ps : []).map((p: J) => ({ place: String(p.place), holds: Boolean(p.holds) }));

/** The events of a run as its researcher lived them: an allow-list, field by field. */
export function researcherEvents(journal: J): J[] {
  const out: J[] = [];
  for (const e of (Array.isArray(journal?.events) ? journal.events : []) as J[]) {
    switch (e.type) {
      case 'exploration_episode': out.push({ type: e.type, episode: e.episode }); break;
      case 'investigation': out.push({ type: e.type, round: e.round, requests: e.requests }); break;
      case 'proposal': out.push({ type: e.type, round: e.round, rationale: e.rationale, beliefs: e.beliefs, notes: e.notes, law: e.law, fingerprint: e.fingerprint,
        lessons: e.lessons, next_experiment: e.next_experiment }); break;
      case 'proposal_refused': out.push({ type: e.type, round: e.round, errors: e.errors }); break;
      case 'check': out.push({ type: e.type, round: e.round, laboratories: held(e.laboratories),
        ...(e.validation ? { validation: { family: held(e.validation.family), blind: (e.validation.blind_confirmation?.sets ?? []).map((s: J) => Boolean(s.ok)) } } : {}),
        ...(e.accepted ? { accepted: true } : {}) }); break;
      case 'reflection': out.push({ type: e.type, round: e.round, rationale: e.rationale, beliefs: e.beliefs, notes: e.notes, lessons: e.lessons, next_experiment: e.next_experiment }); break;
      case 'methods': out.push({ type: e.type, round: e.round, methods: e.methods }); break;
      case 'operator_message': out.push({ type: e.type, question: e.question, messages: (e.messages ?? []).map((m: J) => ({ id: m.id, text: m.text, by: m.by })) }); break;
      case 'operator_command': case 'operator_command_refused': out.push({ type: e.type, id: e.id, kind: e.kind, by: e.by, ...(e.reason ? { reason: e.reason } : {}) }); break;
      case 'focus_changed': case 'sources_allowed': case 'researcher_switched': case 'budget_extended': case 'accepted': case 'halted':
        { const { t: _t, ...rest } = e; out.push(rest); break; }
      case 'end': out.push({ type: e.type, stoppedBy: e.stoppedBy }); break;
      default: break;
    }
  }
  return out;
}

/** A run in a few hundred words, as an agent reads it: the latest rounds in full, the earlier ones counted. */
export function runDigest(journal: J, options: { rounds?: number } = {}): J {
  const events = researcherEvents(journal);
  const rounds = new Map<number, J>();
  const at = (r: number) => { if (!rounds.has(r)) rounds.set(r, { round: r }); return rounds.get(r)!; };
  for (const e of events) {
    if (typeof e.round !== 'number') continue;
    const r = at(e.round);
    if (e.type === 'investigation') r.investigated = [...(r.investigated ?? []), ...(e.requests ?? []).map((q: J) => Object.keys(q)[0] + (q.act ? ' ' + clip(JSON.stringify(q.act), 160) : q.measure ? ' ' + clip(q.measure.source, 120) : q.table ? ' ' + clip(q.table.source, 120) : ''))];
    if (e.type === 'proposal' || e.type === 'reflection') Object.assign(r, {
      kind: e.type, rationale: clip(e.rationale, 700),
      beliefs: (e.beliefs ?? []).map((b: J) => ({ id: b.id, stance: b.stance, ...(b.statement ? { statement: clip(b.statement, 240) } : {}) })),
      notes: (e.notes ?? []).map((n: J) => ({ id: n.id, text: clip(n.text, 400) })),
      lessons: (e.lessons ?? []).map((l: unknown) => clip(l, 200)), next_experiment: clip(e.next_experiment, 400),
      ...(e.law ? { model: clip(typeof e.law.output === 'string' ? e.law.output : JSON.stringify(e.law), 500), fingerprint: e.fingerprint } : {})
    });
    if (e.type === 'check') Object.assign(r, { holds: Object.fromEntries(e.laboratories.map((p: J) => [p.place, p.holds])), ...(e.validation ? { validation: e.validation } : {}), ...(e.accepted ? { accepted: true } : {}) });
  }
  const all = [...rounds.values()].sort((a, b) => a.round - b.round);
  const keep = options.rounds ?? 6;
  const end = events.find((e) => e.type === 'end');
  return {
    world: String(journal?.experiment ?? ''),
    researcher: String(journal?.researcher ?? 'unknown-world'),
    ...(end ? { ended: end.stoppedBy } : {}),
    rounds_so_far: all.length,
    ...(all.length > keep ? { earlier_rounds: all.slice(0, -keep).map((r) => ({ round: r.round, kind: r.kind, holds: r.holds, fingerprint: r.fingerprint })) } : {}),
    latest_rounds: all.slice(-keep),
    help_received: events.filter((e) => e.type === 'operator_message').flatMap((e) => e.messages.map((m: J) => ({ question: e.question, by: m.by, text: clip(m.text, 300) }))),
    orders_refused: events.filter((e) => e.type === 'operator_command_refused').map((e) => ({ kind: e.kind, by: e.by, reason: e.reason }))
  };
}
