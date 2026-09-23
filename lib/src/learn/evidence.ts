import { clamp, round } from '../core/hash.ts';

/* ============================================================================
 * Evidence the learner collects for free (zero calls) while the search runs.
 *
 *   revisions    a state judged twice whose value MOVED: which rule moved, by how
 *                much, and whether the move agreed with the truth when it is known.
 *   path cases   the few lines a reviewer would ask for: the line behind the chosen
 *                move, the alternative that nearly won, the least trusted judgment,
 *                and an emphatic judgment the Judge could not back.
 *   triggers     why a ply deserves a consult although nothing was lost yet.
 *   reflections  the doubts of an attempt, grouped, handed to the proposer once.
 *
 * Pure functions over plain records: the host keeps the state (rings, baselines)
 * and the presentation (boards, prose); these decide what counts.
 * ========================================================================== */

/* --- Revisions --------------------------------------------------------------- */

export const REVISION_MIN_DELTA = 0.05;

export interface Belief {
  readonly V: number;
  readonly confidence: number | null;
  readonly atoms: Readonly<Record<string, number>> | null;
  readonly observations?: Readonly<Record<string, number>> | null;
  readonly ply: number;
}

export interface TruthLabel {
  readonly known: boolean;
  readonly winner: string | null;
  readonly plies?: number | null;
  readonly reason?: string | null;
}

export interface Revision {
  readonly state_key: string;
  readonly ply: number;
  readonly side_to_move: string;
  readonly prev_V: number;
  readonly new_V: number;
  readonly delta_V: number;
  readonly prev_atoms: Readonly<Record<string, number>> | null;
  readonly new_atoms: Readonly<Record<string, number>> | null;
  readonly atom_delta: Record<string, number>;
  readonly confidence: number | null;
  readonly source: string;
  readonly oracle: { known: true; winner: string | null; plies: number | null | undefined; reason: string | null | undefined } | null;
  readonly against_truth: boolean | null;
}

/** The belief worth remembering about a judged state. */
export function beliefOf(value: number, confidence: number | null | undefined, atoms: Readonly<Record<string, number>> | null | undefined,
  measured: Readonly<Record<string, number>> | null | undefined, ply: number): Belief {
  return {
    V: round(clamp(value, 0, 1), 4),
    confidence: confidence === null || confidence === undefined ? null : round(clamp(confidence, 0, 1), 4),
    atoms: atoms ? { ...atoms } : null,
    observations: measured ? { ...measured } : null,
    ply
  };
}

/** A revision, or null (first sighting, or a move smaller than `minDelta`). `against_truth` is judged for the
    maximizer: when the truth says it loses, a rising value moves against the truth, and vice versa. */
export function reviseBelief(previous: Belief | undefined, current: Belief, facts: {
  stateKey: string; sideToMove: string; source: string; truth: TruthLabel | null; maximizer: string; minDelta?: number;
}): Revision | null {
  if (!previous) return null;
  const delta = round(current.V - previous.V, 4);
  if (Math.abs(delta) < (facts.minDelta ?? REVISION_MIN_DELTA)) return null;
  const atomDelta: Record<string, number> = {};
  for (const id of Object.keys(current.atoms || {})) {
    if (!previous.atoms || !Number.isFinite(previous.atoms[id])) continue;
    atomDelta[id] = round(current.atoms![id] - previous.atoms[id], 4);
  }
  const known = !!(facts.truth && facts.truth.known === true);
  const winner = known ? facts.truth!.winner : null;
  const againstTruth = !known ? null
    : winner === facts.maximizer ? delta < 0
    : (winner !== null && winner !== 'draw') ? delta > 0
    : null;
  return {
    state_key: facts.stateKey, ply: current.ply, side_to_move: facts.sideToMove,
    prev_V: previous.V, new_V: current.V, delta_V: delta,
    prev_atoms: previous.atoms, new_atoms: current.atoms, atom_delta: atomDelta,
    confidence: current.confidence, source: facts.source,
    oracle: known ? { known: true, winner, plies: facts.truth!.plies, reason: facts.truth!.reason } : null,
    against_truth: againstTruth
  };
}

export interface AtomStat { id: string; revisions: number; sum: number; toward_truth: number; against_truth: number; unknown: number }

/** Fold one revision into per-rule statistics (the same fold for a pass and for the whole run). */
export function foldAtomStat(stats: Record<string, AtomStat>, revision: Pick<Revision, 'atom_delta' | 'against_truth'>): Record<string, AtomStat> {
  for (const id of Object.keys(revision.atom_delta || {})) {
    const stat = stats[id] || (stats[id] = { id, revisions: 0, sum: 0, toward_truth: 0, against_truth: 0, unknown: 0 });
    stat.revisions++;
    stat.sum += revision.atom_delta[id];
    if (revision.against_truth === true) stat.against_truth++;
    else if (revision.against_truth === false) stat.toward_truth++;
    else stat.unknown++;
  }
  return stats;
}

export function witnessRow(id: string, stat: AtomStat) {
  const meanDelta = round(stat.sum / stat.revisions, 4);
  return { id, revisions: stat.revisions, mean_delta: meanDelta, direction: meanDelta >= 0 ? 'rising' : 'falling',
    toward_truth: stat.toward_truth, against_truth: stat.against_truth, unknown: stat.unknown };
}

export function witness(stats: Record<string, AtomStat>) {
  return Object.keys(stats).map((id) => witnessRow(id, stats[id])).sort((a, b) => Math.abs(b.mean_delta) - Math.abs(a.mean_delta));
}

export function truthLabelCounts(revisions: readonly Pick<Revision, 'oracle' | 'against_truth'>[]) {
  const counts = { known: 0, toward_truth: 0, against_truth: 0, unknown: 0 };
  for (const r of revisions || []) {
    if (!r.oracle || !r.oracle.known) { counts.unknown++; continue; }
    counts.known++;
    if (r.against_truth === true) counts.against_truth++;
    else if (r.against_truth === false) counts.toward_truth++;
  }
  return counts;
}

/** The journal as an author should read it: per STATE (net displacement), largest first. */
export function revisionsByState(revisions: readonly Revision[]) {
  const byState = new Map<string, {
    state_key: string; ply: number; side_to_move: string; first_V: number; last_V: number; revisions: number;
    atom_delta: Record<string, number>; confidence: number | null; oracle: Revision['oracle']; against_truth: boolean | null; net_V?: number;
  }>();
  for (const r of revisions || []) {
    const current = byState.get(r.state_key);
    if (!current) {
      byState.set(r.state_key, { state_key: r.state_key, ply: r.ply, side_to_move: r.side_to_move, first_V: r.prev_V, last_V: r.new_V,
        revisions: 1, atom_delta: { ...r.atom_delta }, confidence: r.confidence, oracle: r.oracle, against_truth: r.against_truth });
      continue;
    }
    current.ply = r.ply;
    current.last_V = r.new_V;
    current.revisions++;
    for (const id of Object.keys(r.atom_delta || {})) current.atom_delta[id] = round((current.atom_delta[id] || 0) + r.atom_delta[id], 4);
    if (r.oracle) current.oracle = r.oracle;
    if (r.against_truth !== null && r.against_truth !== undefined) current.against_truth = r.against_truth;
  }
  const rows = [...byState.values()];
  for (const row of rows) row.net_V = round(row.last_V - row.first_V, 4);
  return rows.sort((a, b) => Math.abs(b.net_V!) - Math.abs(a.net_V!));
}

/* --- Path cases ------------------------------------------------------------------ */

export const PATH_TIE_MARGIN = 0.15;
export const PATH_COINFLIP_MARGIN = 0.05;
export const PATH_EXTREME_MARGIN = 0.35;

/** One judged leaf with the root move of the line that reached it. */
export interface LeafRecordLike {
  readonly state_key: string;
  readonly root_move: string;
  readonly V: number;
  readonly confidence: number | null;
}

export interface CasePick<R> {
  readonly kind: 'decision_support' | 'near_tie' | 'lowest_confidence' | 'overconfident_extreme';
  readonly record: R;
  readonly why: string;
  readonly extra?: { gap: number };
}

/** The (at most `limit`) lines a reviewer would ask for, each selected by a measured rule, never twice. */
export function selectCases<R extends LeafRecordLike>(records: readonly R[], options: {
  bestMoveKey: string | null; limit: number; floor: number; tieMargin?: number; extremeMargin?: number;
}): CasePick<R>[] {
  if (!records.length) return [];
  const tieMargin = options.tieMargin ?? PATH_TIE_MARGIN;
  const extremeMargin = options.extremeMargin ?? PATH_EXTREME_MARGIN;
  const floor = options.floor;
  const chosen: CasePick<R>[] = [];
  const used = new Set<string>();
  const add = (kind: CasePick<R>['kind'], record: R | null | undefined, why: string, extra?: { gap: number }): void => {
    if (!record || used.has(record.state_key) || chosen.length >= options.limit) return;
    used.add(record.state_key);
    chosen.push(extra ? { kind, record, why, extra } : { kind, record, why });
  };
  const bestPerRoot: Record<string, R> = {};
  for (const r of records) if (!bestPerRoot[r.root_move] || r.V > bestPerRoot[r.root_move].V) bestPerRoot[r.root_move] = r;
  const support = options.bestMoveKey ? bestPerRoot[options.bestMoveKey] : null;
  const alt = Object.keys(bestPerRoot).filter((k) => k !== options.bestMoveKey).map((k) => bestPerRoot[k]).sort((a, b) => b.V - a.V)[0] || null;
  const gap = support && alt ? round(support.V - alt.V, 4) : null;
  if (support) {
    add('decision_support', support, 'this is the line behind the chosen move: the leaf at the end of it returned V ' +
      support.V + (support.confidence === null ? ' with no confidence reported' : ' at confidence ' + support.confidence));
  }
  if (alt && gap !== null && Math.abs(gap) <= tieMargin) {
    add('near_tie', alt, 'this alternative line was within ' + Math.abs(gap) + ' of the chosen one (V ' + alt.V +
      '): the move rests on a difference this small', { gap: Math.abs(gap) });
  }
  const withConfidence = records.filter((r) => r.confidence !== null).sort((a, b) => (a.confidence as number) - (b.confidence as number));
  if (withConfidence.length && (withConfidence[0].confidence as number) < floor) {
    const worst = withConfidence[0];
    add('lowest_confidence', worst, 'Jev least trustworthy judgment on this ply: confidence ' + worst.confidence + ' < floor ' + floor + ' at V ' + worst.V);
  }
  const extreme = records.filter((r) => r.confidence !== null && (r.confidence as number) < floor && Math.abs(r.V - 0.5) >= extremeMargin)
    .sort((a, b) => Math.abs(b.V - 0.5) - Math.abs(a.V - 0.5))[0];
  if (extreme) add('overconfident_extreme', extreme, 'an emphatic judgment Jev could not back: V ' + extreme.V + ' at confidence ' + extreme.confidence);
  return chosen;
}

/* --- Triggers ----------------------------------------------------------------------- */

export const TRIGGER_CLASSES = ['contradiction', 'coin_flip', 'no_belief'] as const;
export type TriggerClass = typeof TRIGGER_CLASSES[number];

export interface Trigger {
  readonly class: TriggerClass;
  readonly text: string;
  toString(): string;
}

export function trigger(cls: TriggerClass, text: string): Trigger {
  return { class: cls, text: String(text), toString() { return this.text; } };
}

/** Why this ply deserves a consult, strongest reason first. Uncertainty alone is NOT a reason (with a Judge
    whose mean confidence is ~0.46 it fired on every ply). `contradiction` is the host's sentence when the
    truth decided the position and the value disagrees with it (null otherwise). */
export function classifyTrigger(signals: {
  contradiction: string | null;
  nearTieGap: number | null;
  commit: { value: number; confidence: number | null } | null;
  floor: number;
  coinflipMargin?: number;
}): Trigger | null {
  if (signals.contradiction) return trigger('contradiction', signals.contradiction);
  const margin = signals.coinflipMargin ?? PATH_COINFLIP_MARGIN;
  if (signals.nearTieGap !== null && Number.isFinite(signals.nearTieGap) && signals.nearTieGap <= margin) {
    return trigger('coin_flip', 'the decision was a coin-flip: the alternative line was within ' + signals.nearTieGap + ' of the chosen one');
  }
  const c = signals.commit;
  if (c && c.value < 0.5 && c.confidence !== null && c.confidence < signals.floor) {
    return trigger('no_belief', 'the engine is committing to a move it does not believe in: V ' + c.value +
      ' at confidence ' + c.confidence + ' (floor ' + signals.floor + ')');
  }
  return null;
}

/* --- Reflections --------------------------------------------------------------------- */

export interface ReflectionLike {
  class: string;
  side_to_move: string;
  ply: number;
  V: number | null;
  confidence: number | null;
  count?: number;
}

/** Append a doubt; two consecutive doubts of the same class with the same side to move are ONE doubt with a
    count (repetition is not evidence). Returns the reflection that now carries it and whether it is new. */
export function appendReflection<R extends ReflectionLike>(list: R[], next: R, cap: number): { reflection: R; added: boolean } {
  const previous = list.length ? list[list.length - 1] : null;
  if (previous && previous.class === next.class && previous.side_to_move === next.side_to_move) {
    previous.count = (previous.count || 1) + 1;
    previous.ply = next.ply;
    if (next.V !== null && Number.isFinite(next.V)) previous.V = next.V;
    if (next.confidence !== null && Number.isFinite(next.confidence)) previous.confidence = next.confidence;
    return { reflection: previous, added: false };
  }
  next.count = next.count || 1;
  list.push(next);
  if (list.length > cap) list.shift();
  return { reflection: next, added: true };
}

/** Doubts per class (weighted by their counts) and the most recent `max` of them. */
export function reflectionWindow<R extends { class: string; count?: number }>(list: readonly R[], max: number) {
  const byClass: Record<string, number> = {};
  for (const cls of TRIGGER_CLASSES) byClass[cls] = 0;
  for (const r of list) byClass[r.class] = (byClass[r.class] || 0) + (r.count || 1);
  const kept = list.slice(Math.max(0, list.length - max));
  return { byClass, kept, omitted: list.length - kept.length };
}
