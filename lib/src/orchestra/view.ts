/* ============================================================================
 * What an AGENT may see of a run (SPEC-ORQUESTADOR Q2): never more than the researcher it
 * helps. From a journal, only what the researcher did - its proposals, investigations,
 * beliefs, notes, lessons, plans, reflections - and what the environment told it: whether its
 * model held in each place, whether it was accepted. Never the hidden part of the journal, the
 * operator's measures (ablations, baselines, traces of what happened, the grading against the
 * truth), nor the world's description.
 * ========================================================================== */

import { formulaFingerprint, ownFingerprint } from '../learn/law-session.ts';

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
      case 'proposal': out.push({ type: e.type, round: e.round, rationale: e.rationale, beliefs: e.beliefs, notes: e.notes, law: e.law, ...(e.formula ? { formula: e.formula } : {}), fingerprint: e.fingerprint,
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
      case 'directive_report': out.push({ type: e.type, question: e.question, id: e.id, done: e.done, ...(e.not_done ? { not_done: e.not_done } : {}) }); break;
      case 'junior_report': out.push({ type: e.type, question: e.question, text: e.text }); break;
      case 'document_written': out.push({ type: e.type, round: e.round, id: e.id, do: e.do, ...(typeof e.text === 'string' ? { text: e.text } : {}) }); break;
      case 'end': out.push({ type: e.type, stoppedBy: e.stoppedBy }); break;
      default: break;
    }
  }
  return out;
}

/** A model as a reviewer reads it: what each observation computes in code, what each rule asks the Judge, and how the output
    combines them - the whole of it, each part clipped. Its output alone hides where the model leaves its work to the Judge. */
export function modelDigest(law: J): J {
  const code = (v: J): string => clip(v?.spec?.source ?? v?.source ?? (typeof v === 'string' ? v : JSON.stringify(v)), 220);
  const obs = Object.entries((law?.observations ?? {}) as J);
  const rules = Object.entries((law?.rules ?? {}) as J);
  const out = law?.output;
  return {
    observations: Object.fromEntries(obs.slice(0, 12).map(([id, v]) => [id, code(v)])), ...(obs.length > 12 ? { observations_not_shown: obs.length - 12 } : {}),
    rules_for_the_judge: Object.fromEntries(rules.slice(0, 8).map(([id, v]) => [id, { type: (v as J)?.type, asks: clip((v as J)?.instructions, 220) }])), ...(rules.length > 8 ? { rules_not_shown: rules.length - 8 } : {}),
    output: clip(typeof out === 'string' ? out : out?.source ?? JSON.stringify(out), 500)
  };
}

/** The state of each experiment of the researcher's own (an episode it asked for with `act`), from what it did after
    (SPEC-ORQUESTADOR §3.3.5): "done" (the episode came), "read" (it viewed, inspected, measured or tabled it) or "used"
    (it cited it as evidence: in a belief, a note, its rationale or a report). Bookkeeping of its own record, never a
    judgment of what the episode shows. */
export function experimentStates(journal: J): { episode: string; round: number; state: 'done' | 'read' | 'used' }[] {
  const states = new Map<string, { episode: string; round: number; state: 'done' | 'read' | 'used' }>();
  const rank = { done: 0, read: 1, used: 2 } as const;
  const mark = (text: unknown, to: 'read' | 'used') => {
    if (!states.size) return;
    const t = typeof text === 'string' ? text : JSON.stringify(text ?? '');
    for (const [name, x] of states) if (rank[x.state] < rank[to] && new RegExp('(^|[^A-Za-z0-9_])' + name + '(?![0-9])').test(t)) x.state = to;
  };
  for (const e of (Array.isArray(journal?.events) ? journal.events : []) as J[]) {
    if (e.type === 'investigation') {
      const results = (e.results ?? []) as J[];
      (e.requests ?? []).forEach((q: J, i: number) => {
        if (q?.act !== undefined) {
          const r = results[i];
          if (r?.accepted && typeof r.name === 'string') states.set(r.name, { episode: r.name, round: Number(e.round), state: 'done' });
        } else if (q?.replay !== undefined && typeof results[i]?.episode === 'string') {
          /* A replay of the grid: the episode it played is an experiment of its own (what it replayed from, it used). */
          mark(q, 'read');
          states.set(results[i].episode, { episode: results[i].episode, round: Number(e.round), state: 'done' });
        } else if (q?.table !== undefined && (q.on === 'episodes' || q.on === undefined)) { for (const x of states.values()) if (x.state === 'done') x.state = 'read'; }
        else mark(q, 'read');
      });
    } else if (e.type === 'proposal' || e.type === 'reflection') {
      mark({ rationale: e.rationale, beliefs: e.beliefs, notes: e.notes, lessons: e.lessons }, 'used');
    } else if (e.type === 'directive_report') mark([e.done, e.not_done], 'used');
    else if (e.type === 'junior_report') mark(e.text, 'used');
  }
  return [...states.values()];
}

/** A run in a few hundred words, as an agent reads it: the latest rounds in full, the earlier ones counted. */
export function runDigest(journal: J, options: { rounds?: number } = {}): J {
  const events = researcherEvents(journal);
  const rounds = new Map<number, J>();
  const at = (r: number) => { if (!rounds.has(r)) rounds.set(r, { round: r }); return rounds.get(r)!; };
  const firstOf = new Map<string, number>();
  for (const e of events) {
    if (typeof e.round !== 'number') continue;
    const r = at(e.round);
    if (e.type === 'investigation') r.investigated = [...(r.investigated ?? []), ...(e.requests ?? []).map((q: J) => Object.keys(q)[0] + (q.act ? ' ' + clip(JSON.stringify(q.act), 160) : q.measure ? ' ' + clip(q.measure.source, 120) : q.table ? ' ' + clip(q.table.source, 120) : ''))];
    if (e.type === 'proposal' || e.type === 'reflection') Object.assign(r, {
      kind: e.type, rationale: clip(e.rationale, 700),
      beliefs: (e.beliefs ?? []).map((b: J) => ({ id: b.id, stance: b.stance, ...(b.statement ? { statement: clip(b.statement, 240) } : {}) })),
      notes: (e.notes ?? []).map((n: J) => ({ id: n.id, text: clip(n.text, 400) })),
      lessons: (e.lessons ?? []).map((l: unknown) => clip(l, 200)), next_experiment: clip(e.next_experiment, 400),
      ...(e.law ? { model: modelDigest(e.law), fingerprint: e.fingerprint } : e.formula ? { model: modelDigest(e.formula), fingerprint: e.fingerprint } : {})
    });
    /* The same model proposed again, whatever whitespace it differs in (SPEC-CALIBRACION-INSTRUMENTOS §11.1). */
    if (e.type === 'proposal' && (e.law || e.formula)) {
      const id = e.law ? ownFingerprint({ ...e.law }) : formulaFingerprint(e.formula);
      const first = firstOf.get(id);
      if (first === undefined) firstOf.set(id, e.round); else r.same_model_as_round = first;
    }
    if (e.type === 'document_written') r.documents = [...(r.documents ?? []), { id: e.id, do: e.do, ...(e.text ? { begins: clip(e.text, 300) } : {}) }];
    if (e.type === 'methods') r.methods = [...(r.methods ?? []), ...(e.methods ?? []).map((m: J) => ({ id: m.id, ...(m.do ? { do: m.do } : {}), ...(m.text ? { text: clip(m.text, 300) } : {}) }))];
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
    /* Its experiments it has not yet cited as evidence: what it still owes reading or using, without an order spent on it. */
    ...(() => { const open = experimentStates(journal).filter((x) => x.state !== 'used'); return open.length ? { its_experiments_not_yet_used: open.slice(-12).map((x) => ({ episode: x.episode, round: x.round, state: x.state === 'done' ? 'not read yet' : 'read, not cited as evidence' })) } : {}; })(),
    help_received: events.filter((e) => e.type === 'operator_message').flatMap((e) => e.messages.map((m: J) => ({ question: e.question, by: m.by, text: clip(m.text, 300) }))),
    orders_refused: events.filter((e) => e.type === 'operator_command_refused').map((e) => ({ kind: e.kind, by: e.by, reason: e.reason }))
  };
}
