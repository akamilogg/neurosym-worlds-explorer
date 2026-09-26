import type { Formula } from '../core/types.ts';
import { describeTest, type ProbeResult } from './experiments.ts';
import { formulaHash } from '../core/formula.ts';

/* ============================================================================
 * The lab notebook: the explorer's own, carried from one round to the next.
 *
 * The explorer knows it has a notebook and decides what goes in it. The harness only
 * keeps the FACTS of what the explorer did and what happened, never curated
 * experience and never anything the explorer could not have observed itself:
 *
 *   beliefs     every belief ever held, with its history. Each answer must take a stance
 *               on every belief still held (keep | revise | confirm | drop), citing
 *               evidence; a belief left without a stance is reported back.
 *   notes       what the explorer chose to write down (text, and references to positions
 *               of its own games - "game@turn"), and to forget.
 *   methods     how it investigates: strategies it found for using its tools together
 *               (what worked, what wasted its steps). Its own, never the world's rules.
 *   lessons     its own words and next experiment, returned verbatim.
 *   games       the index of games played: who chose the moves, the result, the length.
 *   rounds      the lineage of its formulas: what changed, what its probes said, how
 *               the games went.
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

export interface NoteOp {
  readonly do: 'write' | 'forget';
  readonly id: string;
  readonly text?: string;
  /** Its own games ("g5") or positions of them ("g5@4", "try3"). */
  readonly positions?: readonly string[];
}

export interface Note { readonly id: string; text: string; positions: string[]; readonly written: number; updated: number }
export interface Method { readonly id: string; text: string; readonly written: number; updated: number }

export interface GameRecord {
  readonly id: string;
  readonly round: number;
  /** Who chose the learner's moves ("exploration: at random", "your formula of round N"). */
  readonly how: string;
  readonly result: 'won' | 'lost' | 'draw';
  readonly turns: number;
}

export interface RoundRecord {
  readonly round: number;
  readonly formula: { observations: Record<string, string>; rules: Record<string, string>; weights: Record<string, number> };
  readonly changes: { added: string[]; removed: string[]; reweighted: string[] } | null;
  /** Its probes as facts (no verdict), with their code. */
  probes: { id: string; hypothesis: string; code: unknown; tests: Record<string, unknown>[] }[];
  /** Same exactly when the formula is the same. */
  readonly fingerprint: string;
  readonly games: { results: string[]; wins: number; of: number }[];
  readonly lessons: string[];
  readonly next_experiment: string;
}

const clip = (text: string, n: number): string => (text.length > n ? text.slice(0, n - 1) + '…' : text);
const ID = /^[a-z][a-z0-9_]{0,47}$/;

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
  readonly notes = new Map<string, Note>();
  readonly methods = new Map<string, Method>();
  readonly rounds: RoundRecord[] = [];
  readonly games: GameRecord[] = [];
  /** Rounds where it only looked back (no formula): what it concluded. */
  readonly reflections: { round: number; rationale: string; lessons: string[]; next_experiment: string }[] = [];

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

  /** Write or forget notes. `known(ref)` says whether a "game@turn" reference exists. */
  applyNotes(round: number, ops: readonly NoteOp[], known: (ref: string) => boolean): string[] {
    const warnings: string[] = [];
    for (const op of ops) {
      if (!ID.test(op.id)) { warnings.push('note id "' + op.id + '" must be lowercase snake_case'); continue; }
      if (op.do === 'forget') {
        if (!this.notes.delete(op.id)) warnings.push('note "' + op.id + '" does not exist');
        continue;
      }
      const text = (op.text ?? '').trim();
      if (!text) { warnings.push('note "' + op.id + '" has no text'); continue; }
      const positions = (op.positions ?? []).filter((p) => { const ok = known(p); if (!ok) warnings.push('note "' + op.id + '": no point "' + p + '"'); return ok; });
      const old = this.notes.get(op.id);
      if (old) { old.text = clip(text, 1200); old.positions = positions; old.updated = round; }
      else this.notes.set(op.id, { id: op.id, text: clip(text, 1200), positions, written: round, updated: round });
    }
    return warnings;
  }

  /** Write or forget methods (no positions: a method is about investigating, not about one game). */
  applyMethods(round: number, ops: readonly NoteOp[]): string[] {
    const warnings: string[] = [];
    for (const op of ops) {
      if (!ID.test(op.id)) { warnings.push('method id "' + op.id + '" must be lowercase snake_case'); continue; }
      if (op.do === 'forget') {
        if (!this.methods.delete(op.id)) warnings.push('method "' + op.id + '" does not exist');
        continue;
      }
      const text = (op.text ?? '').trim();
      if (!text) { warnings.push('method "' + op.id + '" has no text'); continue; }
      const old = this.methods.get(op.id);
      if (old) { old.text = clip(text, 800); old.updated = round; }
      else this.methods.set(op.id, { id: op.id, text: clip(text, 800), written: round, updated: round });
    }
    return warnings;
  }

  addGames(games: readonly GameRecord[]): void { this.games.push(...games); }

  recordReflection(round: number, rationale: string, lessons: readonly string[], nextExperiment: string): void {
    this.reflections.push({ round, rationale, lessons: [...lessons], next_experiment: nextExperiment });
  }

  recordRound(round: number, formula: Formula, lessons: readonly string[], nextExperiment: string): RoundRecord {
    const summary = summarize(formula);
    const previous = this.rounds.length ? this.rounds[this.rounds.length - 1].formula : null;
    const record: RoundRecord = { round, formula: summary, fingerprint: formulaHash(formula).slice(0, 10), changes: changesBetween(previous, summary), probes: [], games: [],
      lessons: [...lessons], next_experiment: nextExperiment };
    this.rounds.push(record);
    return record;
  }

  private round(round: number): RoundRecord | undefined { return this.rounds.find((r) => r.round === round); }

  recordProbes(round: number, results: readonly ProbeResult[]): void {
    const r = this.round(round);
    if (!r) return;
    r.probes = results.map((p) => ({
      id: p.id, hypothesis: clip(p.hypothesis, 200), code: p.code ?? null, tests: p.tests.map((t) => describeTest(t))
    }));
  }

  recordGames(round: number, results: readonly string[]): void {
    this.round(round)?.games.push({ results: [...results], wins: results.filter((r) => r === 'won').length, of: results.length });
  }

  /** The notebook as the explorer reads it. */
  brief(unaddressed: readonly string[] = []): Record<string, unknown> {
    /* Results travel as the score the interface speaks of (1, 0, -1), never as words of a game. */
    const score = (r: string): number | string => (r === 'won' ? 1 : r === 'lost' ? -1 : r === 'draw' ? 0 : r);
    const beliefs = [...this.beliefs.values()];
    const last = this.rounds[this.rounds.length - 1];
    return {
      beliefs_held: beliefs.filter((b) => b.status !== 'dropped').map((b) => ({
        id: b.id, statement: b.statement, status: b.status, since_round: b.since,
        history: b.history.map((h) => 'round ' + h.round + ': ' + h.stance + (h.why ? ' - ' + clip(h.why, 200) : '') + (h.evidence.length ? ' [' + h.evidence.join(', ') + ']' : ''))
      })),
      beliefs_dropped: beliefs.filter((b) => b.status === 'dropped').map((b) => ({ id: b.id, statement: b.statement, why: b.history[b.history.length - 1].why })),
      ...(unaddressed.length ? { you_took_no_stance_on: [...unaddressed] } : {}),
      notes: [...this.notes.values()].map((n) => ({ id: n.id, text: n.text, points: n.positions, written_round: n.written, updated_round: n.updated })),
      methods: [...this.methods.values()].map((m) => ({ id: m.id, text: m.text, written_round: m.written, updated_round: m.updated })),
      /* The common vocabulary of the prompt (prompt.ts): episodes, steps, models. */
      episodes: this.games.map((g) => ({ episode: g.id, round: g.round, chosen_by: g.how, score: score(g.result), steps: g.turns })),
      models: this.rounds.map((r) => ({ round: r.round, fingerprint: r.fingerprint, model: r.formula, ...(r.changes ? { changes: r.changes } : {}), probes: r.probes,
        episodes: r.games.map((g) => ({ scores: g.results.map(score), scored_1: g.wins, of: g.of })) })),
      ...(this.reflections.length ? { reflections: this.reflections } : {}),
      ...(last ? { your_last_lessons: last.lessons, your_planned_next_experiment: last.next_experiment } : {})
    };
  }

  toJSON(): Record<string, unknown> {
    return { beliefs: [...this.beliefs.values()], notes: [...this.notes.values()], methods: [...this.methods.values()], games: this.games, rounds: this.rounds, reflections: this.reflections };
  }
}
