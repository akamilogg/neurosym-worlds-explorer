/* ============================================================================
 * THE METHOD AUDIT, what code observes (SPEC-AUDITORIA-METODO §3-§4, MA1): from a finished
 * journal, the LINKS of its investigation - each step with what was held before it, what it
 * asked, what the world answered, and what the researcher wrote after - and the facts about
 * them that need no opinion:
 *
 *   O1 experiments the world refused (an act it did not accept, a replay that erred), and what
 *      cited them after: a refusal can be evidence itself (a move is not legal) or a test that never
 *      ran (the act it meant to make did not happen) - which one is for the judgement (J3), not code;
 *   O2 citations: each point (`g20@6`, `ep1@3-5`) or step ("round 3 investigation step 2")
 *      a proposal cites - did it exist, had the researcher seen it, by then;
 *   O3 orphan steps: never cited after, by step, by an episode they made, or by a point they showed;
 *   O4 comparisons: requests from the same point that differ (two acts, a replay with two models),
 *      the same request made again (a replication), and a replay set against the episode it starts
 *      from (what another model does where the recorded one went on);
 *   O5 how each belief moved: its stances, round by round.
 *
 * It reads only what the researcher saw and wrote, never the hidden part of the world nor the
 * operator's measures (M2): a method is judged by what was in front of the researcher. The
 * audit is the operator's (M1): nothing of it ever reaches a researcher.
 * ========================================================================== */

type J = Record<string, any>;

/** Instruments that put an idea to the test; those that look; those that read a record (its own, others', sources). */
export const EXPERIMENT_KINDS = new Set(['act', 'replay', 'simulate', 'try', 'launch', 'play']);
export const OBSERVATION_KINDS = new Set(['view', 'inspect', 'table', 'measure']);
const AUX = new Set(['from', 'to', 'on', 'range', 'as', 'model', 'formula', 'of', 'items', 'item', 'words', 'select', 'whole', 'run', 'in', 'steps', 'place']);

export type LinkKind = 'experiment' | 'observation' | 'recall';

export interface Link {
  /** "r<round>.s<step>": the step as the researcher's own record numbers it. */
  readonly id: string;
  readonly round: number;
  readonly step: number;
  readonly kind: LinkKind;
  readonly instruments: readonly string[];
  /** What it held before the step: its beliefs not dropped, and the operator's message it had not yet answered. */
  readonly before: { readonly beliefs: readonly { id: string; statement: string }[]; readonly operator_message?: string };
  readonly requests: readonly unknown[];
  /** What the world answered, made compact by code: no pictures beyond a few, tables clipped. */
  readonly result: readonly unknown[];
  /** Whether the world refused any of its experiments (O1). */
  readonly refused: boolean;
  /** Episodes it made (an act's, a replay's), and points it showed. */
  readonly made: readonly string[];
  /** The next proposal or reflection, and what of it cites this step. */
  readonly after: { readonly round: number; readonly type: string; readonly rationale: string;
    readonly beliefs: readonly { id: string; stance: string; statement?: string; why?: string; evidence?: readonly string[] }[];
    readonly cites_this: readonly string[] } | null;
}

export interface Citation {
  readonly round: number;
  readonly in: string;
  readonly ref: string;
  /** missing: it named nothing the researcher had by then; unseen: it existed, but that point was never shown to it. */
  readonly status: 'seen' | 'unseen' | 'missing';
}

export interface ControlGroup {
  /** paired: requests from the same point that differ; replicated: the same request again; against_recorded: a replay
      from a point of an episode already played, which it is set against. */
  readonly kind: 'paired' | 'replicated' | 'against_recorded';
  readonly point: string;
  readonly instrument: string;
  readonly members: readonly { link: string; request: unknown; result: unknown }[];
  /** Whether a later proposal or reflection cites any of them. */
  readonly used: boolean;
}

export interface LinkRecord {
  readonly links: readonly Link[];
  readonly citations: readonly Citation[];
  readonly refused: readonly { link: string; request: unknown; result: unknown; cited_after: readonly string[] }[];
  readonly orphans: readonly string[];
  readonly controls: readonly ControlGroup[];
  readonly beliefs: readonly { id: string; statement: string; stances: readonly { round: number; stance: string }[] }[];
  /** Per round: the beliefs held at its start, the links it made, and the proposal or reflection that closed it. */
  readonly rounds: readonly { round: number; held: readonly { id: string; statement: string }[]; links: readonly string[];
    closed_by: { type: string; rationale: string; beliefs: readonly unknown[] } | null }[];
}

const POINT = /\b([A-Za-z][\w-]*?\d+)@(\d+)(?:\s*[–-]\s*(\d+))?/g;
const STEP_REFS = [/round\s+(\d+),?\s+(?:investigation\s+)?step\s+(\d+)/gi, /investigation:r(\d+)\.(\d+)/gi];

const kindOf = (q: unknown): string => Object.keys((q ?? {}) as object).find((k) => !AUX.has(k)) ?? '?';
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** What the world answered to one request, compact: the facts of it, the bulk clipped. */
export function compactResult(q: unknown, r: unknown): unknown {
  if (!r || typeof r !== 'object') return r;
  const x = r as J;
  if (x.error) return { error: clip(String(x.error), 300) };
  const k = kindOf(q);
  const keep: J = {};
  for (const [key, v] of Object.entries(x)) {
    if (key === 'frames' && Array.isArray(v)) { keep.frames_shown = v.length; continue; }
    if (key === 'rows' && Array.isArray(v)) { keep.rows = v.length; keep.first_rows = v.slice(0, 3).map((row) => clip(JSON.stringify(row), 300)); continue; }
    if (typeof v === 'string') { keep[key] = clip(v, k === 'act' || key === 'picture' ? 600 : 400); continue; }
    if (v && typeof v === 'object') { keep[key] = clipDeep(v); continue; }
    keep[key] = v;
  }
  return keep;
}
/** A structured part of an answer as it is, or its text clipped when it is large. */
function clipDeep(v: unknown): unknown {
  const s = JSON.stringify(v);
  return s.length <= 600 ? v : clip(s, 600);
}

/** The points a text cites, and the steps. */
export function citesIn(text: string): { points: { episode: string; from: number; to: number; ref: string }[]; steps: { round: number; step: number; ref: string }[] } {
  const points = [...text.matchAll(POINT)].map((m) => ({ episode: m[1], from: Number(m[2]), to: m[3] !== undefined ? Number(m[3]) : Number(m[2]), ref: m[0] }));
  const steps = STEP_REFS.flatMap((re) => [...text.matchAll(re)].map((m) => ({ round: Number(m[1]), step: Number(m[2]), ref: m[0] })));
  return { points, steps };
}

/** The links of a journal, and what code observes of them. */
export function linksOf(journal: J): LinkRecord {
  const events: J[] = Array.isArray(journal?.events) ? journal.events : [];
  const beliefs = new Map<string, { statement: string; status: string; stances: { round: number; stance: string }[] }>();
  /* What the researcher had by each moment: episodes it knew of, and the points it had been shown. */
  const exists = new Set<string>();
  const seenAll = new Set<string>();
  const seen = new Map<string, Set<number>>();
  const show = (ep: string, from: number, to: number): void => {
    const s = seen.get(ep) ?? new Set<number>();
    for (let i = from; i <= Math.min(to, from + 2000); i++) s.add(i);
    seen.set(ep, s);
    exists.add(ep);
  };
  const pointOf = (p: unknown): { ep: string; step: number } | null => {
    const m = typeof p === 'string' ? /^(.+)@(\d+)$/.exec(p) : null;
    return m ? { ep: m[1], step: Number(m[2]) } : null;
  };
  const links: Link[] = [];
  const stepsInRound = new Map<number, number>();
  const pendingLinks: Link[] = [];
  const citations: Citation[] = [];
  const closers: { round: number; type: string; text: string; beliefs: J[] }[] = [];
  const rounds = new Map<number, { held: { id: string; statement: string }[]; links: string[]; closed_by: LinkRecord['rounds'][number]['closed_by'] }>();
  let operatorMessage: string | null = null;
  const held = (): { id: string; statement: string }[] => [...beliefs.entries()].filter(([, b]) => b.status !== 'drop').map(([id, b]) => ({ id, statement: b.statement }));
  const roundOf = (r: number) => {
    if (!rounds.has(r)) rounds.set(r, { held: held(), links: [], closed_by: null });
    return rounds.get(r)!;
  };

  /* Each link is told what of the next proposal or reflection cites it. */
  const close = (e: J, type: string): void => {
    const round = typeof e.round === 'number' ? e.round : 0;
    const entries: J[] = Array.isArray(e.beliefs) ? e.beliefs : [];
    const text = [String(e.rationale ?? ''), ...entries.flatMap((b) => [String(b.statement ?? ''), String(b.why ?? ''), ...(Array.isArray(b.evidence) ? b.evidence.map(String) : [])]),
      ...(Array.isArray(e.lessons) ? e.lessons.map(String) : [])].join('\n');
    const { points, steps } = citesIn(text);
    for (const p of points) {
      const s = seen.get(p.episode);
      const status: Citation['status'] = !exists.has(p.episode) ? 'missing'
        : seenAll.has(p.episode) || (s && Array.from({ length: p.to - p.from + 1 }, (_, i) => p.from + i).every((i) => s.has(i))) ? 'seen' : 'unseen';
      citations.push({ round, in: type, ref: p.ref, status });
    }
    for (const st of steps) {
      const status: Citation['status'] = links.some((l) => l.round === st.round && l.step === st.step) ? 'seen' : 'missing';
      citations.push({ round, in: type, ref: st.ref, status });
    }
    const after = { round, type, rationale: String(e.rationale ?? ''),
      beliefs: entries.map((b) => ({ id: String(b.id), stance: String(b.stance ?? ''), ...(b.statement ? { statement: String(b.statement) } : {}), ...(b.why ? { why: String(b.why) } : {}),
        ...(Array.isArray(b.evidence) && b.evidence.length ? { evidence: b.evidence.map(String) } : {}) })) };
    for (const l of pendingLinks.splice(0)) {
      const cites = citingRefs(l, points, steps, text);
      (l as { after: Link['after'] }).after = { ...after, cites_this: cites };
    }
    closers.push({ round, type, text, beliefs: entries });
    roundOf(round).closed_by = { type, rationale: after.rationale, beliefs: after.beliefs };
    for (const b of entries) {
      const id = String(b.id);
      const was = beliefs.get(id);
      const stance = String(b.stance ?? '');
      beliefs.set(id, { statement: String(b.statement ?? was?.statement ?? ''), status: stance === 'drop' ? 'drop' : stance, stances: [...(was?.stances ?? []), { round, stance }] });
    }
    operatorMessage = null;
  };

  for (const e of events) {
    switch (e.type) {
      case 'exploration_game': if (e.game) exists.add(String(e.game)); break;
      case 'exploration_episode': case 'exploration_launch': {
        const id = e.episode && typeof e.episode === 'object' ? e.episode.id ?? e.episode.episode : e.episode ?? e.launch;
        if (id) exists.add(String(id));
        break;
      }
      case 'played_by_the_learner': if (e.game) exists.add(String(e.game)); break;
      case 'check':
        /* The episodes of a check are the researcher's to look at from then on, and the points its verdict showed
           ("check8-lab1-2@4+1": from step 4, one ahead) it has seen. */
        for (const m of JSON.stringify(e.laboratories ?? []).matchAll(/"(check[\w-]*?\d+)(?:@(\d+)(?:\+(\d+))?)?"/g)) {
          exists.add(m[1]);
          if (m[2] !== undefined) show(m[1], Number(m[2]), Number(m[2]) + Number(m[3] ?? 0));
        }
        break;
      case 'operator_message': operatorMessage = (e.messages ?? []).map((m: J) => String(m.text ?? '')).join('\n\n') || operatorMessage; break;
      case 'investigation': {
        const round = typeof e.round === 'number' ? e.round : 0;
        const step = (stepsInRound.get(round) ?? 0) + 1;
        stepsInRound.set(round, step);
        const requests: unknown[] = Array.isArray(e.requests) ? e.requests : [];
        const results: unknown[] = Array.isArray(e.results) ? e.results : [];
        const instruments = requests.map(kindOf);
        const kind: LinkKind = instruments.some((k) => EXPERIMENT_KINDS.has(k)) ? 'experiment' : instruments.some((k) => OBSERVATION_KINDS.has(k)) ? 'observation' : 'recall';
        const made: string[] = [];
        let refused = false;
        const r0 = roundOf(round);
        requests.forEach((q, i) => {
          const x = (results[i] ?? {}) as J, k = instruments[i], qq = q as J;
          if (EXPERIMENT_KINDS.has(k) && (x.error || x.accepted === false)) refused = true;
          if (k === 'view' && !x.error) {
            const ep = String(qq.view);
            const frames: J[] = Array.isArray(x.frames) ? x.frames : [];
            if (frames.length) for (const f of frames) show(ep, Number(f.step), Number(f.step));
            else show(ep, Number(qq.from ?? 0), Number(qq.to ?? qq.from ?? 0));
            if (typeof x.table === 'string') seenAll.add(ep);
          }
          if (k === 'table' && Array.isArray(x.rows)) for (const row of x.rows as J[]) { const p = pointOf(row.point); if (p) show(p.ep, p.step, p.step); }
          for (const field of ['inspect', 'act', 'replay', 'simulate']) { const p = pointOf(qq[field]); if (p && !x.error) show(p.ep, p.step, p.step); }
          for (const name of [x.name, x.episode].filter((n) => typeof n === 'string')) {
            made.push(String(name)); exists.add(String(name));
            if (x.table || x.picture) seenAll.add(String(name));
          }
        });
        const link: Link = { id: 'r' + round + '.s' + step, round, step, kind, instruments,
          before: { beliefs: held(), ...(operatorMessage ? { operator_message: operatorMessage } : {}) },
          requests, result: requests.map((q, i) => compactResult(q, results[i])), refused, made, after: null };
        links.push(link);
        pendingLinks.push(link);
        r0.links.push(link.id);
        break;
      }
      case 'proposal': close(e, 'proposal'); break;
      case 'reflection': close(e, 'reflection'); break;
      default: break;
    }
  }

  /* O1: the experiments the world refused, and what cited them after. */
  const later = (round: number) => closers.filter((c) => c.round >= round);
  const refusals = links.flatMap((l) => l.requests.map((q, i) => ({ l, q, r: l.result[i] as J, k: l.instruments[i] }))
    .filter(({ k, r }) => EXPERIMENT_KINDS.has(k) && r && (r.error || r.accepted === false))
    .map(({ l, q, r }) => ({ link: l.id, request: q, result: r,
      cited_after: later(l.round).flatMap((c) => { const { steps } = citesIn(c.text); return steps.filter((s) => s.round === l.round && s.step === l.step).map(() => c.type + ' of round ' + c.round); }) })));
  /* O3: steps no later proposal or reflection cites in any way. */
  const orphans = links.filter((l) => l.kind !== 'recall' && !later(l.round).some((c) => { const { points, steps } = citesIn(c.text); return citingRefs(l, points, steps, c.text).length > 0; })).map((l) => l.id);
  /* O4: requests from the same point that differ. */
  const groups = new Map<string, ControlGroup['members'][number][]>();
  for (const l of links) l.requests.forEach((q, i) => {
    const k = l.instruments[i];
    if (!['act', 'replay', 'simulate'].includes(k)) return;
    const point = typeof (q as J)[k] === 'string' ? String((q as J)[k]) : JSON.stringify((q as J)[k]);
    const key = k + ' ' + point;
    groups.set(key, [...(groups.get(key) ?? []), { link: l.id, request: q, result: l.result[i] }]);
  });
  const used = (members: ControlGroup['members']): boolean => {
    const ids = new Set(members.map((m) => m.link));
    const first = Math.min(...members.map((m) => links.find((l) => l.id === m.link)!.round));
    return later(first).some((c) => { const { points, steps } = citesIn(c.text); return links.filter((l) => ids.has(l.id)).some((l) => citingRefs(l, points, steps, c.text).length > 0); });
  };
  const controls: ControlGroup[] = [];
  for (const [key, members] of groups) {
    const [instrument, ...rest] = key.split(' ');
    const point = rest.join(' ');
    const distinct = new Set(members.map((m) => JSON.stringify(m.request))).size;
    if (members.length > 1) { controls.push({ kind: distinct > 1 ? 'paired' : 'replicated', point, instrument, members, used: used(members) }); continue; }
    /* A lone replay from a point of a recorded episode: set against how that episode went on. */
    if (instrument === 'replay' && pointOf(point)) controls.push({ kind: 'against_recorded', point, instrument, members, used: used(members) });
  }
  return {
    links, citations, refused: refusals, orphans, controls,
    beliefs: [...beliefs.entries()].map(([id, b]) => ({ id, statement: b.statement, stances: b.stances })),
    rounds: [...rounds.entries()].sort(([a], [b]) => a - b).map(([round, r]) => ({ round, ...r }))
  };
}

/** What of a proposal's citations points at this link: its step, an episode it made, or a point it showed. */
function citingRefs(l: Link, points: { episode: string; from: number; to: number; ref: string }[], steps: { round: number; step: number; ref: string }[], text: string): string[] {
  const refs = steps.filter((s) => s.round === l.round && s.step === l.step).map((s) => s.ref);
  /* An episode it made, named on its own or within a range ("g94–g96"). */
  for (const ep of l.made) {
    if (new RegExp('(^|[^\\w@-])' + escape(ep) + '(?![\\w@])').test(text)) { refs.push(ep); continue; }
    const m = /^([A-Za-z]+)(\d+)$/.exec(ep);
    if (m) for (const r of text.matchAll(new RegExp('\\b' + m[1] + '(\\d+)\\s*[–-]\\s*(?:' + m[1] + ')?(\\d+)\\b', 'g')))
      if (Number(r[1]) <= Number(m[2]) && Number(m[2]) <= Number(r[2])) refs.push(r[0]);
  }
  for (const p of points) {
    if (l.made.includes(p.episode)) { refs.push(p.ref); continue; }
    l.requests.forEach((q, i) => {
      const k = l.instruments[i], x = q as J;
      if (k === 'view' && String(x.view) === p.episode && !(p.to < Number(x.from ?? 0) || p.from > Number(x.to ?? Number.MAX_SAFE_INTEGER))) refs.push(p.ref);
      for (const field of ['inspect', 'act', 'replay', 'simulate']) if (typeof x[field] === 'string' && x[field] === p.episode + '@' + p.from) refs.push(p.ref);
    });
  }
  return [...new Set(refs)];
}

/** A text as a literal part of a regular expression. */
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
