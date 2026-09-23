import type { Formula } from '../core/types.ts';
import type { ProbeResult } from './experiments.ts';

/* ============================================================================
 * The lab notebook: what the explorer carries from one hypothesis to the next.
 *
 * A reasoning model carries its own trace from step to step. Here the trace is
 * external, structured and honest: the explorer writes its beliefs, lessons and
 * next experiment; the harness writes what actually happened (probe results, games,
 * the moment each game was thrown away). Nothing in it can be invented after the fact.
 *
 *   beliefs     every belief ever held, with its history. Each answer must take a
 *               stance on every belief still held (keep | revise | confirm | drop),
 *               citing evidence; a belief left without a stance is reported back.
 *   rounds      the formula's lineage: what changed, what the probes said, how the
 *               games went (wins AND partial credit), what the code alone did.
 *   lessons     the explorer's own words, returned verbatim next round.
 *   episodes    experience CURATED, not a sliding window: every win, the critical
 *               moment of every loss (the position before the move that threw the
 *               win away, and after it - never the move that would have kept it),
 *               the best losses, and the latest games.
 * ========================================================================== */

export type Stance = 'new' | 'keep' | 'revise' | 'confirm' | 'drop';
export const STANCES: readonly Stance[] = ['new', 'keep', 'revise', 'confirm', 'drop'];

export interface BeliefStance {
  readonly id: string;
  readonly stance: Stance;
  readonly statement?: string;
  readonly why?: string;
  readonly evidence?: readonly string[];
}

export interface NotebookBelief {
  readonly id: string;
  statement: string;
  status: 'held' | 'confirmed' | 'dropped';
  readonly since: number;
  readonly history: { round: number; stance: Stance; statement: string; why: string; evidence: string[] }[];
}

export interface EpisodeRecord {
  readonly id: string;
  readonly round: number;
  /** How the moves were chosen ("exploration: ...", "trial: ..."). */
  readonly how: string;
  readonly result: 'won' | 'lost' | 'draw';
  /** One rendering per turn, from the first position to the last. */
  readonly frames: readonly string[];
  /** Index of the frame BEFORE the learner's move that threw a won position away (null: never happened or unknown). */
  readonly critical?: number | null;
  /** The learner's turns played while its position was still won (partial credit; null when unknown). */
  readonly heldWinTurns?: number | null;
  /** Whether the learner's side chose these moves itself (a trial) rather than at random. */
  readonly ownPlay: boolean;
}

export interface TrialRecord {
  readonly level: string | number;
  readonly wins: number;
  readonly total: number;
  readonly results: readonly string[];
  readonly held_win_turns: readonly (number | null)[];
  readonly action_accuracy: number | null;
}

export interface RoundRecord {
  readonly round: number;
  readonly formula: { observations: Record<string, string>; rules: Record<string, string>; weights: Record<string, number> };
  readonly changes: { added: string[]; removed: string[]; reweighted: string[] } | null;
  probes: { id: string; hypothesis: string; status: string; auc: number | null; tests: string[] }[];
  readonly trials: TrialRecord[];
  code_only?: { wins: number; total: number } | null;
  readonly lessons: string[];
  readonly next_experiment: string;
}

const clip = (text: string, n: number): string => (text.length > n ? text.slice(0, n - 1) + '…' : text);

function summarize(formula: Formula): RoundRecord['formula'] {
  const observations: Record<string, string> = {};
  for (const [id, d] of Object.entries(formula.observations)) {
    if ((d.spec as { kind?: string }).kind === 'sense') continue;
    observations[id] = clip(d.definition || (d.spec as { source?: string }).source || '', 140);
  }
  const rules: Record<string, string> = {};
  for (const [id, r] of Object.entries(formula.rules)) rules[id] = clip(r.instructions, 200);
  return { observations, rules, weights: { ...formula.weights } };
}

function changesBetween(before: RoundRecord['formula'] | null, after: RoundRecord['formula']): RoundRecord['changes'] {
  if (!before) return null;
  const ids = (f: RoundRecord['formula']) => [...Object.keys(f.observations).map((o) => 'observation ' + o), ...Object.keys(f.rules).map((r) => 'rule ' + r)];
  const was = ids(before), now = ids(after);
  return {
    added: now.filter((x) => !was.includes(x)),
    removed: was.filter((x) => !now.includes(x)),
    reweighted: Object.keys(after.weights).filter((r) => r in before.weights && Math.abs(before.weights[r] - after.weights[r]) >= 0.05)
  };
}

export class Notebook {
  readonly beliefs = new Map<string, NotebookBelief>();
  readonly rounds: RoundRecord[] = [];
  readonly episodes: EpisodeRecord[] = [];

  /** Apply the explorer's stances. Returns what was refused (as warnings) and the beliefs it said nothing about. */
  applyStances(round: number, stances: readonly BeliefStance[]): { warnings: string[]; unaddressed: string[] } {
    const warnings: string[] = [];
    const touched = new Set<string>();
    for (const s of stances) {
      const known = this.beliefs.get(s.id);
      const entry = { round, stance: s.stance, statement: s.statement ?? known?.statement ?? '', why: s.why ?? '', evidence: [...(s.evidence ?? [])] };
      if (s.stance === 'new') {
        if (known) { warnings.push('belief "' + s.id + '" already exists: use keep, revise, confirm or drop'); continue; }
        if (!s.statement) { warnings.push('new belief "' + s.id + '" has no statement'); continue; }
        this.beliefs.set(s.id, { id: s.id, statement: s.statement, status: 'held', since: round, history: [entry] });
        touched.add(s.id);
        continue;
      }
      if (!known) { warnings.push('belief "' + s.id + '" does not exist (stance "' + s.stance + '" ignored)'); continue; }
      if (s.stance === 'revise') {
        if (!s.statement) { warnings.push('revised belief "' + s.id + '" has no new statement'); continue; }
        known.statement = s.statement;
        known.status = 'held';
      } else if (s.stance === 'confirm') known.status = 'confirmed';
      else if (s.stance === 'drop') known.status = 'dropped';
      else if (known.status === 'dropped') known.status = 'held';
      known.history.push(entry);
      touched.add(s.id);
    }
    const unaddressed = [...this.beliefs.values()].filter((b) => b.status !== 'dropped' && !touched.has(b.id) && b.since < round).map((b) => b.id);
    return { warnings, unaddressed };
  }

  recordRound(round: number, formula: Formula, lessons: readonly string[], nextExperiment: string): RoundRecord {
    const summary = summarize(formula);
    const previous = this.rounds.length ? this.rounds[this.rounds.length - 1].formula : null;
    const record: RoundRecord = { round, formula: summary, changes: changesBetween(previous, summary), probes: [], trials: [],
      code_only: null, lessons: [...lessons], next_experiment: nextExperiment };
    this.rounds.push(record);
    return record;
  }

  private round(round: number): RoundRecord | undefined { return this.rounds.find((r) => r.round === round); }

  recordProbes(round: number, results: readonly ProbeResult[]): void {
    const r = this.round(round);
    if (!r) return;
    r.probes = results.map((p) => ({
      id: p.id, hypothesis: clip(p.hypothesis, 200), status: p.status, auc: p.auc,
      tests: p.tests.map((t) => t.by + ' on ' + t.positions.replace('_', ' ') + ' positions: ' + t.status + (t.auc === null ? '' : ' (auc ' + t.auc + ')'))
    }));
  }

  recordTrial(round: number, trial: TrialRecord): void { this.round(round)?.trials.push(trial); }

  recordCodeOnly(round: number, wins: number, total: number): void {
    const r = this.round(round);
    if (r) r.code_only = { wins, total };
  }

  addEpisodes(episodes: readonly EpisodeRecord[]): void { this.episodes.push(...episodes); }

  /** What the explorer reads about its own past: beliefs, lineage, its last lessons and plan. */
  brief(unaddressed: readonly string[] = []): Record<string, unknown> {
    const beliefs = [...this.beliefs.values()];
    const last = this.rounds[this.rounds.length - 1];
    return {
      beliefs_held: beliefs.filter((b) => b.status !== 'dropped').map((b) => ({
        id: b.id, statement: b.statement, status: b.status, since_round: b.since,
        history: b.history.map((h) => 'round ' + h.round + ': ' + h.stance + (h.why ? ' - ' + clip(h.why, 200) : '') + (h.evidence.length ? ' [' + h.evidence.join(', ') + ']' : ''))
      })),
      beliefs_dropped: beliefs.filter((b) => b.status === 'dropped').map((b) => ({
        id: b.id, statement: b.statement, why: b.history[b.history.length - 1].why
      })),
      ...(unaddressed.length ? { you_took_no_stance_on: [...unaddressed] } : {}),
      rounds: this.rounds.map((r) => ({
        round: r.round, formula: r.formula, ...(r.changes ? { changes: r.changes } : {}), probes: r.probes,
        games: r.trials.map((t) => ({ opponent_level: t.level, wins: t.wins, of: t.total, results: t.results,
          turns_still_winning: t.held_win_turns, move_quality: t.action_accuracy })),
        ...(r.code_only ? { observations_alone_won: r.code_only.wins + ' of ' + r.code_only.total } : {})
      })),
      ...(last ? { your_last_lessons: last.lessons, your_planned_next_experiment: last.next_experiment } : {})
    };
  }

  /** Experience curated for the explorer. `keyframes` of a game: its start, its critical moment and its end. */
  memory(options: { wins?: number; critical?: number; bestLosses?: number } = {}): Record<string, unknown> {
    const eps = this.episodes;
    const full = (e: EpisodeRecord) => ({ case: e.id, how: e.how, result: e.result, turns: e.frames.length - 1, frames: e.frames });
    const keyframes = (e: EpisodeRecord) => {
      const idx = [...new Set([0, ...(e.critical !== null && e.critical !== undefined ? [e.critical, e.critical + 1] : []), e.frames.length - 1])]
        .filter((i) => i >= 0 && i < e.frames.length).sort((a, b) => a - b);
      return { case: e.id, how: e.how, result: e.result, turns: e.frames.length - 1,
        ...(e.heldWinTurns !== null && e.heldWinTurns !== undefined ? { turns_still_winning: e.heldWinTurns } : {}),
        key_frames: idx.map((i) => ({ turn: i, frame: e.frames[i] })) };
    };
    const shown = new Set<string>();
    const wins = eps.filter((e) => e.result === 'won').slice(-(options.wins ?? 3));
    wins.forEach((e) => shown.add(e.id));
    const critical = eps.filter((e) => e.ownPlay && e.result !== 'won' && e.critical !== null && e.critical !== undefined)
      .slice(-(options.critical ?? 6)).map((e) => ({
        case: e.id, turn: e.critical, before_your_move: e.frames[e.critical!], after_your_move: e.frames[e.critical! + 1],
        note: 'before this move your position could still be won; after it, it could not'
      }));
    const bestLosses = eps.filter((e) => e.ownPlay && e.result !== 'won' && !shown.has(e.id) && (e.heldWinTurns ?? 0) > 0)
      .sort((a, b) => (b.heldWinTurns ?? 0) - (a.heldWinTurns ?? 0)).slice(0, options.bestLosses ?? 1);
    bestLosses.forEach((e) => shown.add(e.id));
    const latestRound = eps.length ? eps[eps.length - 1].round : 0;
    const latest = eps.filter((e) => e.round === latestRound && !shown.has(e.id));
    /* Before the first trial there is nothing to curate: the exploration games are shown whole. */
    const firstLook = !eps.some((e) => e.ownPlay);
    return {
      wins: wins.map(full),
      critical_moments: critical,
      best_losses: bestLosses.map(full),
      latest_games: firstLook ? latest.map(full) : latest.map(keyframes),
      total_games_played: eps.length
    };
  }

  toJSON(): Record<string, unknown> {
    return { beliefs: [...this.beliefs.values()], rounds: this.rounds,
      episodes: this.episodes.map((e) => ({ id: e.id, round: e.round, how: e.how, result: e.result, turns: e.frames.length - 1, critical: e.critical ?? null, held: e.heldWinTurns ?? null })) };
  }
}
