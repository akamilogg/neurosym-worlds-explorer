/* ============================================================================
 * A SYNTHESIS of a run, built from its journal after the fact: what System 2 did, what
 * came of it, and which of its steps mattered.
 *
 * Every journal (grid, orbit, cells, messages) is read the same way. Its events become
 * MOMENTS - the environment's episodes, investigation steps, proposals, checks and
 * validations, reflections - each with a RELEVANCE from 0 to 1:
 *
 *   - a check that changed the verdict (the model held for the first time, stopped holding,
 *     a validation, the acceptance) is relevant by itself;
 *   - a proposal is relevant by the beliefs it created, revised, confirmed or dropped;
 *   - an investigation step is relevant when what it produced or looked at was CITED later as
 *     evidence by a belief - most of all by one the learner still held at the end.
 *
 * The PATH is the set of moments that led to the final model: the proposals of the beliefs
 * held at the end, the investigations whose episodes those beliefs cite, and the checks
 * they cite ("round N"). Operator-only measures (truth, grades, ablations, cost) are kept
 * apart and labelled so: System 2 never saw them.
 * ========================================================================== */

export type MomentKind = 'environment' | 'investigate' | 'replay' | 'propose' | 'check' | 'validate' | 'reflect';

export interface Moment {
  readonly id: string;
  readonly kind: MomentKind;
  readonly round: number;
  /** Seconds since the start of the run. */
  readonly t: number;
  readonly title: string;
  /** Short lines for a card. */
  readonly lines: readonly string[];
  readonly relevance: number;
  readonly onPath: boolean;
  /** Names of episodes and points this moment produced or looked at. */
  readonly refs: readonly string[];
  /** The raw event (for the detail view). */
  readonly event: Record<string, unknown>;
}

export interface BeliefStep { readonly round: number; readonly stance: string; readonly statement: string; readonly why: string; readonly evidence: readonly string[] }
export interface BeliefLine { readonly id: string; readonly statement: string; readonly status: string; readonly steps: readonly BeliefStep[] }

export interface ProgressPoint {
  readonly round: number;
  /** Share of the laboratories' cases that went right (0..1), or of laboratories that held when there is no count. */
  readonly value: number;
  readonly label: string;
  readonly held: boolean;
  readonly validated: boolean | null;
  readonly accepted: boolean;
  readonly reused: boolean;
}

export interface Synthesis {
  readonly meta: {
    readonly experiment: string;
    readonly world: string;
    readonly seed: number | null;
    readonly level: number | null;
    readonly model: string | null;
    readonly started: string | null;
    readonly seconds: number;
    readonly outcome: string;
    readonly acceptedRound: number | null;
    readonly rounds: number;
  };
  readonly moments: readonly Moment[];
  readonly beliefs: readonly BeliefLine[];
  readonly progress: readonly ProgressPoint[];
  /** The final model, as the learner wrote it. */
  readonly finalModel: unknown;
  readonly operator: {
    readonly truth: unknown;
    readonly grades: unknown;
    readonly score: number | null;
    readonly form: string | null;
    readonly summary: unknown;
    readonly ablations: readonly unknown[];
  };
}

type Ev = Record<string, any>;

const EPISODE_OF = /^([A-Za-z][A-Za-z0-9-]*?)(?:@\d+(?:[/–-]\d+)?)?$/;
/** The episode a reference names ("g9@10" -> "g9", "act18" -> "act18", "check1-lab1-2@23" -> "check1-lab1-2"); null for "round 3". */
export function episodeOf(ref: string): string | null {
  const r = String(ref).trim();
  if (/^round\s+\d+$/i.test(r)) return null;
  const at = r.indexOf('@');
  const base = at >= 0 ? r.slice(0, at) : r;
  return EPISODE_OF.test(base) ? base : null;
}
/** "round 3" -> 3. */
export const roundCited = (ref: string): number | null => { const m = /^round\s+(\d+)$/i.exec(String(ref).trim()); return m ? Number(m[1]) : null; };

const clip = (s: unknown, n = 160): string => { const t = typeof s === 'string' ? s : JSON.stringify(s) ?? ''; return t.length > n ? t.slice(0, n - 1) + '…' : t; };

/** What a laboratory's check says, whatever the world: right cases over cases, or held. */
function labScore(lab: Ev): { right: number; total: number } | null {
  if (typeof lab.wins === 'number' && typeof lab.total === 'number') return { right: lab.wins, total: lab.total };
  if (typeof lab.exact === 'number' && typeof lab.points === 'number') return { right: lab.exact, total: lab.points };
  if (typeof lab.agreed === 'number' && typeof lab.points === 'number') return { right: lab.agreed, total: lab.points };
  return null;
}

/** The laboratories of a check event, in the protocol's shape (older orbit journals kept { held: {...} }). */
function labsOf(e: Ev): Ev[] {
  const l = e.laboratories;
  if (Array.isArray(l)) return l;
  if (l && typeof l === 'object' && l.held && typeof l.held === 'object') return Object.entries(l.held).map(([place, holds]) => ({ place, holds }));
  return [];
}

function describeRequest(r: Ev): string {
  const k = Object.keys(r)[0];
  const v = r[k];
  if (k === 'act') return 'act ' + clip(typeof v === 'string' ? v + (r.from ? ' ' + JSON.stringify(r.from) + '→' + JSON.stringify(r.to) : '') : v, 90);
  if (k === 'view') return 'view ' + v + (r.from !== undefined ? ' ' + r.from + '–' + r.to : '');
  if (k === 'inspect') return 'inspect ' + v;
  if (k === 'replay') return 'replay from ' + v;
  if (k === 'simulate') return 'simulate from ' + v;
  if (k === 'measure') return 'measure on ' + (Array.isArray(r.on) ? r.on.length + ' point(s)' : '?');
  if (k === 'table') return 'table on ' + (r.on ?? 'episodes');
  return k;
}

/** Names a request looked at, and names its result produced. */
function refsOf(req: Ev, res: Ev | undefined): string[] {
  const out: string[] = [];
  const k = Object.keys(req)[0];
  const v = req[k];
  if (typeof v === 'string') { const e = episodeOf(v); if (e) out.push(e); }
  if (Array.isArray(req.on)) for (const p of req.on) { const e = episodeOf(String(p)); if (e) out.push(e); }
  if (res && typeof res === 'object') {
    for (const key of ['name', 'episode']) if (typeof res[key] === 'string') out.push(res[key]);
  }
  return [...new Set(out)];
}

export function synthesize(journal: Ev): Synthesis {
  const events: Ev[] = Array.isArray(journal.events) ? journal.events : [];
  const end: Ev = [...events].reverse().find((e) => e.type === 'end') ?? {};
  const cfg: Ev = journal.config ?? {};

  /* --- Beliefs: from the final notebook, else rebuilt from the proposals' stances -------------------------------- */
  const beliefs: BeliefLine[] = [];
  const nb = end.notebook?.beliefs;
  if (Array.isArray(nb)) {
    for (const b of nb) beliefs.push({ id: String(b.id), statement: String(b.statement ?? ''), status: String(b.status ?? ''),
      steps: (b.history ?? []).map((h: Ev) => ({ round: Number(h.round), stance: String(h.stance), statement: String(h.statement ?? b.statement ?? ''), why: String(h.why ?? ''), evidence: (h.evidence ?? []).map(String) })) });
  } else {
    const by = new Map<string, BeliefStep[]>();
    for (const e of events.filter((x) => x.type === 'proposal' || x.type === 'reflection')) {
      for (const b of e.beliefs ?? []) {
        const steps = by.get(b.id) ?? [];
        steps.push({ round: Number(e.round), stance: String(b.stance), statement: String(b.statement ?? steps[steps.length - 1]?.statement ?? ''), why: String(b.why ?? ''), evidence: (b.evidence ?? []).map(String) });
        by.set(b.id, steps);
      }
    }
    for (const [id, steps] of by) {
      const last = steps[steps.length - 1];
      beliefs.push({ id, statement: last.statement, status: last.stance === 'drop' ? 'dropped' : 'held', steps });
    }
  }

  /* --- What was cited: by every belief change, and by the beliefs held at the end ------------------------------- */
  const cited = new Map<string, number>();
  const citedFinal = new Set<string>();
  const roundsCitedFinal = new Set<number>();
  for (const b of beliefs) {
    const held = b.status !== 'dropped';
    for (const s of b.steps) {
      const weight = s.stance === 'keep' ? 0.5 : 1;
      for (const ref of s.evidence) {
        const ep = episodeOf(ref);
        if (ep) {
          cited.set(ep, (cited.get(ep) ?? 0) + weight);
          if (held) citedFinal.add(ep);
        }
        const r = roundCited(ref);
        if (r !== null && held) roundsCitedFinal.add(r);
      }
    }
  }
  /* The round each surviving belief was born or last revised in: its proposal is on the path. */
  const pathProposalRounds = new Set<number>();
  for (const b of beliefs.filter((x) => x.status !== 'dropped')) {
    for (const s of b.steps) if (s.stance === 'new' || s.stance === 'revise') pathProposalRounds.add(s.round);
  }

  /* --- Moments ---------------------------------------------------------------------------------------------------- */
  const moments: Moment[] = [];
  let lastHeld: boolean | null = null;
  let acceptedRound: number | null = null;
  const progress: ProgressPoint[] = [];
  const pushed = new Set<string>();
  const id = (kind: string, round: number, t: number) => { let k = kind + '-' + round + '-' + t, n = 0; while (pushed.has(k + (n ? '-' + n : ''))) n++; const v = k + (n ? '-' + n : ''); pushed.add(v); return v; };
  const citeScore = (refs: readonly string[]) => {
    let s = 0, final = false;
    for (const r of refs) { s = Math.max(s, cited.get(r) ?? 0); if (citedFinal.has(r)) final = true; }
    return { s: Math.min(1, s / 2), final };
  };

  for (const e of events) {
    const round = Number(e.round ?? 0);
    const t = Number(e.t ?? 0);
    if (e.type === 'exploration_game' || e.type === 'exploration_episode' || e.type === 'exploration_launch') {
      const ep = String(e.game ?? e.episode ?? e.launch ?? '');
      const c = citeScore([ep]);
      moments.push({ id: id('environment', 0, t), kind: 'environment', round: 0, t, title: 'The environment ran ' + ep,
        lines: e.winner !== undefined ? ['ended: ' + (e.winner ?? 'draw') + ' by ' + e.reason + ' after ' + e.plies + ' steps'] : [],
        relevance: 0.1 + 0.6 * c.s, onPath: c.final, refs: [ep], event: e });
    } else if (e.type === 'investigation') {
      const reqs: Ev[] = e.requests ?? [];
      const results: Ev[] = e.results ?? [];
      const refs = [...new Set(reqs.flatMap((r, i) => refsOf(r, results[i])))];
      const c = citeScore(refs);
      const notes: Ev[] = e.notes ?? [];
      moments.push({ id: id('investigate', round, t), kind: 'investigate', round, t,
        title: 'Investigates: ' + [...new Set(reqs.map((r) => Object.keys(r)[0]))].join(', ') + (reqs.length ? '' : '(nothing ran)'),
        lines: [...reqs.slice(0, 6).map(describeRequest), ...notes.map((n) => 'note ' + n.id + ': ' + clip(n.text, 120)), ...(e.warnings ?? []).map((w: string) => '⚠ ' + clip(w, 120))],
        relevance: 0.15 + 0.7 * c.s + (notes.length ? 0.1 : 0), onPath: c.final, refs, event: e });
    } else if (e.type === 'played_by_the_learner') {
      const refs = [String(e.game)];
      const c = citeScore(refs);
      moments.push({ id: id('replay', round, t), kind: 'replay', round, t, title: 'Replays from ' + e.from + ' with ' + e.how,
        lines: ['result: ' + e.result + ' (' + e.turns + ' steps, ' + e.reason + ')'], relevance: 0.15 + 0.7 * c.s, onPath: c.final, refs, event: e });
    } else if (e.type === 'proposal') {
      const stances: Ev[] = e.beliefs ?? [];
      const changes = stances.filter((b) => b.stance === 'new' || b.stance === 'revise' || b.stance === 'drop');
      const confirms = stances.filter((b) => b.stance === 'confirm');
      const model: Ev = e.law ?? e.formula ?? {};
      const obs = Object.keys(model.observations ?? {}).filter((k) => k !== 'picture');
      const rules = Object.keys(model.rules ?? {});
      moments.push({ id: id('propose', round, t), kind: 'propose', round, t,
        title: 'Proposes a model' + (changes.length ? ' - ' + changes.map((b) => b.stance + ' ' + b.id).join(', ') : ''),
        lines: [clip(e.rationale, 260), obs.length + ' observation(s), ' + rules.length + ' rule(s)' + (model.output ? ', output in code' : '') + (e.fingerprint ? ' · ' + e.fingerprint : ''),
          ...changes.map((b) => b.stance + ' ' + b.id + ': ' + clip(b.statement || b.why || '', 140))],
        relevance: Math.min(1, 0.3 + 0.2 * changes.length + 0.1 * confirms.length), onPath: pathProposalRounds.has(round), refs: [], event: e });
    } else if (e.type === 'check') {
      const labs = labsOf(e);
      const scores = labs.map(labScore);
      const counted = scores.filter((s): s is { right: number; total: number } => !!s);
      const held = labs.length > 0 && labs.every((l) => l.holds);
      const value = counted.length ? counted.reduce((n, s) => n + s.right, 0) / Math.max(1, counted.reduce((n, s) => n + s.total, 0))
        : labs.filter((l) => l.holds).length / Math.max(1, labs.length);
      const v: Ev | null = e.validation && !e.validation.refused ? e.validation : null;
      const blind = v?.blind_confirmation;
      const accepted = !!e.accepted;
      if (accepted && acceptedRound === null) acceptedRound = round;
      const reused = e.reused_check_of_round !== undefined;
      progress.push({ round, value, label: counted.length ? counted.map((s) => s.right + '/' + s.total).join(' · ') : labs.map((l) => l.place + (l.holds ? ' ✓' : ' ✗')).join(' '),
        held, validated: v ? !(v.became_laboratories ?? []).length : null, accepted, reused });
      const changed = lastHeld !== null && held !== lastHeld;
      const first = lastHeld === null || (held && lastHeld === false);
      lastHeld = held;
      moments.push({ id: id('check', round, t), kind: 'check', round, t,
        title: (reused ? 'Check of round ' + e.reused_check_of_round + ' reused' : 'Check in the laboratories') + ': ' + (held ? 'holds' : 'does not hold'),
        lines: [labs.map((l, i) => l.place + ' ' + (scores[i] ? scores[i]!.right + '/' + scores[i]!.total : '') + (l.holds ? ' ✓' : ' ✗') + (l.rerun ? ' (run again)' : '')).join(' · '),
          ...(e.validation?.refused ? ['validation refused: ' + e.validation.refused] : []),
          ...(e.check_is_trivial ? ['operator: a baseline that knows nothing held too'] : [])],
        relevance: accepted ? 1 : held && first ? 0.85 : changed ? 0.7 : 0.35, onPath: roundsCitedFinal.has(round) || accepted || (held && first), refs: [], event: e });
      if (v) {
        const became: string[] = v.became_laboratories ?? [];
        const fam: Ev[] = v.family ?? [];
        moments.push({ id: id('validate', round, t), kind: 'validate', round, t,
          title: accepted ? 'Validated and confirmed blind: ACCEPTED' : became.length ? 'Validation: it does not hold in ' + became.join(', ') : 'Validation: holds in the family; blind confirmation failed',
          lines: [fam.map((f) => { const s = labScore(f); return f.place + ' ' + (s ? s.right + '/' + s.total : '') + (f.holds ? ' ✓' : ' ✗'); }).join(' · '),
            ...(blind ? ['blind: ' + (blind.sets ?? []).map((s: Ev) => (s.ok ? '✓' : '✗')).join(' ')] : []),
            ...(became.length ? ['now laboratories: ' + became.join(', ')] : [])],
          relevance: accepted ? 1 : 0.9, onPath: true, refs: [], event: v });
      }
    } else if (e.type === 'reflection') {
      moments.push({ id: id('reflect', round, t), kind: 'reflect', round, t, title: 'Reflects on the run',
        lines: [clip(e.rationale, 300), ...(e.lessons ?? []).map((l: string) => 'lesson: ' + clip(l, 160))], relevance: 0.6, onPath: false, refs: [], event: e });
    }
  }

  const rounds = Math.max(0, ...moments.map((m) => m.round));
  const grading: Ev | undefined = [...events].reverse().find((e) => e.type === 'operator_rule_recovery' || e.type === 'operator_law_recovery');
  const ablations = events.filter((e) => /ablation/.test(String(e.type)));
  const startEv: Ev = journal.hidden_from_the_learner ?? {};
  const outcome = String(end.stoppedBy ?? (acceptedRound !== null ? 'accepted' : 'unfinished'));
  const final = end.final?.law ?? end.final ?? (end.accepted?.formula) ?? end.best?.formula ?? null;
  return {
    meta: {
      experiment: String(journal.experiment ?? '?'),
      world: String(startEv.spec?.id ?? journal.experiment ?? '?'),
      seed: typeof cfg.seed === 'number' ? cfg.seed : null,
      level: typeof cfg.level === 'number' ? cfg.level : null,
      model: typeof cfg.llm_model === 'string' ? cfg.llm_model : null,
      started: typeof journal.started === 'string' ? journal.started : null,
      seconds: Math.max(0, ...events.map((e) => Number(e.t ?? 0))),
      outcome, acceptedRound, rounds
    },
    moments, beliefs, progress, finalModel: final,
    operator: {
      truth: grading?.truth ?? startEv.truth ?? null,
      grades: grading?.grades ?? null,
      score: typeof grading?.score === 'number' ? grading.score : null,
      form: typeof grading?.form === 'string' ? grading.form : null,
      summary: end.operator_summary ?? null,
      ablations
    }
  };
}

/** The most relevant moments, in the order they happened: a synthesis of the run. */
export function keyMoments(s: Synthesis, options: { threshold?: number; pathOnly?: boolean; max?: number } = {}): Moment[] {
  const threshold = options.threshold ?? 0.6;
  const picked = s.moments.filter((m) => m.relevance >= threshold && (!options.pathOnly || m.onPath));
  const max = options.max ?? Infinity;
  if (picked.length <= max) return picked;
  const keep = new Set([...picked].sort((a, b) => b.relevance - a.relevance).slice(0, max).map((m) => m.id));
  return picked.filter((m) => keep.has(m.id));
}
