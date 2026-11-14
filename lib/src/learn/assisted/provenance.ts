/* ============================================================================
 * THE PROVENANCE OF EACH HYPOTHESIS (SPEC-INVESTIGACION-EXTERNA §4.1.2): what an actor had in front of it when it proposed
 * something to test, derived from its record (`read_before`), set against where it says the idea comes from (`origin`).
 * Exposure (exposure.ts) says whether anything from outside reached an actor; this says, hypothesis by hypothesis, what
 * was within its reach - never that it caused the idea.
 *
 *   a hypothesis     a message of a senior, an act of the junior that says why, a delegation, a model proposed: each closes
 *                    a stretch of its actor's record
 *   read_before      written by the host: the external snapshots it had read up to then (opened, searched in, links
 *                    listed), the contributions it received and the messages of exposed actors it was given - all of
 *                    them, since what it read stays in its conversation; `fresh`, those of this stretch alone
 *   origin           what it declares: "own", or references ("src:S1#L40-60", "exp:exp1#...", a contribution's id)
 *   class            declared (an external origin it had read) - unacknowledged (reads before it, "own" or nothing
 *                    declared: a possible use not acknowledged, never an accusation) - own (no reads) - declared_unread
 *                    (it cites a source its record does not show it read)
 * ========================================================================== */

type J = Record<string, any>;

export type Origin = 'own' | readonly string[];
export type ProvenanceClass = 'declared' | 'unacknowledged' | 'own' | 'declared_unread';

export interface HypothesisProvenance {
  readonly kind: 'act' | 'delegation' | 'model' | 'message';
  readonly round: number | null;
  /** Where it is in the record: an investigation step's request, a proposal, a senior's decision. */
  readonly ref: string;
  readonly origin: Origin | null;
  readonly read_before: readonly string[];
  /** Of them, those read since its hypothesis before. */
  readonly fresh: readonly string[];
  readonly class: ProvenanceClass;
}

/** An origin as written, or null when none was (or it is not one). */
export function originOf(raw: unknown): Origin | null {
  if (raw === 'own') return 'own';
  if (typeof raw === 'string' && raw.trim()) return [raw.trim().slice(0, 200)];
  if (Array.isArray(raw)) {
    const refs = raw.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim().slice(0, 200)).slice(0, 12);
    if (refs.length === 1 && refs[0] === 'own') return 'own';
    return refs.length ? refs : null;
  }
  return null;
}

/** The snapshot a reference names ("src:S1#L4-9" → "S1"; an actor's "senior.S1" kept whole). */
const snapshotOf = (ref: string): string | null => {
  const m = /^src:([A-Za-z0-9_.-]+?)(?:#.*)?$/.exec(ref);
  return m ? m[1] : null;
};
const external = (ref: string): boolean => /^src:/.test(ref);

/** Its class: what it declared, against what it had read. */
export function classify(origin: Origin | null, readBefore: readonly string[], everRead: ReadonlySet<string>): ProvenanceClass {
  const cited = origin === 'own' || origin === null ? [] : origin.filter(external);
  if (cited.length) {
    const unread = cited.some((r) => { const s = snapshotOf(r); return s !== null && !everRead.has(s) && ![...everRead].some((x) => x.endsWith('.' + s) || s.endsWith('.' + x)); });
    return unread ? 'declared_unread' : 'declared';
  }
  /* What it declared is not a source (its own, the experience, a contribution named) - or nothing. */
  if (origin !== null && origin !== 'own' && origin.length) return readBefore.length && !origin.some((r) => readBefore.some((x) => r.includes(x) || x.includes(r))) ? 'unacknowledged' : 'declared';
  return readBefore.length ? 'unacknowledged' : 'own';
}

const READS = new Set(['open', 'find', 'links', 'search']);
const failed = (r: unknown): boolean => {
  const x = r as J | null;
  return !x || typeof x !== 'object' || typeof x.error === 'string' || ['not_allowed', 'unavailable', 'refused', 'budget_exhausted', 'provider_error', 'network_error', 'http_error', 'unsupported_media'].includes(String(x.state));
};
/** What an external reading names: its snapshot (or search), or null for a reading of something else (a document of
    A6's allowlist on disk, the journal's memory). */
export function readingOf(q: J, r: J | null): string | null {
  const key = Object.keys(q).find((k) => READS.has(k));
  if (!key || failed(r)) return null;
  if (key === 'search') return typeof r?.query === 'string' ? 'search:' + r.query : 'search:' + JSON.stringify(q.search).slice(0, 60);
  const snap = typeof r?.snapshot === 'string' ? r.snapshot : null;
  if (snap) return snap;
  const target = String(q[key] === true ? q.in ?? '' : key === 'find' ? q.in ?? '' : q[key]);
  return /^https?:\/\//.test(target) || /(^|\.)S\d+$/.test(target) ? target : null;
}

/** The hypotheses of a run's journal (its junior, or a branch), each with what it had in front of it - empty where it
    had no external sources and received nothing from an exposed actor. */
export function hypothesesOf(journal: J | null | undefined): HypothesisProvenance[] {
  const events: J[] = Array.isArray(journal?.events) ? journal!.events : [];
  const out: HypothesisProvenance[] = [];
  let since: string[] = [];
  const ever = new Set<string>();
  const within: string[] = [];
  const add = (x: string) => { if (!since.includes(x)) since.push(x); if (!within.includes(x)) within.push(x); };
  const close = (kind: HypothesisProvenance['kind'], round: number | null, ref: string, origin: Origin | null) => {
    out.push({ kind, round, ref, origin, read_before: [...within], fresh: since, class: classify(origin, within, ever) });
    since = [];
  };
  const step = new Map<number, number>();
  for (const e of events) {
    if (e.type === 'operator_message') {
      for (const m of (Array.isArray(e.messages) ? e.messages : []) as J[]) {
        if (m?.contribution?.id) add('contribution:' + m.contribution.id);
        else if (m?.external_exposure && (m.external_exposure.direct || m.external_exposure.via?.length)) add('message:' + String(m.id ?? m.by ?? 'message'));
        /* A senior's message is a hypothesis of its own: what it had read and what it declared, as its order carried them. */
        if (Array.isArray(m?.read_before) || m?.origin !== undefined) {
          const rb = (Array.isArray(m.read_before) ? m.read_before : []).map(String);
          out.push({ kind: 'message', round: e.question ?? null, ref: 'message:' + String(m.id ?? ''), origin: originOf(m.origin), read_before: rb, fresh: (Array.isArray(m.fresh) ? m.fresh : []).map(String),
            class: (m.provenance as ProvenanceClass) ?? classify(originOf(m.origin), rb, new Set(rb)) });
        }
      }
    }
    if (e.type === 'investigation' && Array.isArray(e.requests)) {
      const n = (step.get(e.round) ?? 0) + 1;
      step.set(e.round, n);
      e.requests.forEach((q: J, k: number) => {
        const r = Array.isArray(e.results) ? e.results[k] : null;
        const read = q && typeof q === 'object' ? readingOf(q, r) : null;
        if (read) { add(read); ever.add(read); return; }
        const ref = 'investigation:r' + e.round + '.' + n + '#' + (k + 1);
        if (q?.delegate && typeof q.delegate === 'object') close('delegation', e.round ?? null, ref, originOf(q.origin ?? q.delegate.origin));
        else if (q?.act && typeof q.act === 'object') {
          const kind = Object.keys(q.act)[0];
          const body = kind ? q.act[kind] : null;
          if (body && typeof body === 'object' && typeof body.why === 'string') close('act', e.round ?? null, ref, originOf(q.origin));
        }
      });
    }
    if (e.type === 'proposal') close('model', e.round ?? null, 'model:r' + e.round, originOf(e.origin));
  }
  /* Nothing worth saying where nothing external was ever within its reach. */
  return out.some((h) => h.read_before.length || h.origin !== null) ? out : [];
}

/** How many of each class. */
export function provenanceCounts(hs: readonly HypothesisProvenance[]): Record<ProvenanceClass, number> {
  const c: Record<ProvenanceClass, number> = { declared: 0, unacknowledged: 0, own: 0, declared_unread: 0 };
  for (const h of hs) c[h.class]++;
  return c;
}
