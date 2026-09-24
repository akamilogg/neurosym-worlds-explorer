import { round } from '../core/hash.ts';
import { makeFormula } from '../core/formula.ts';
import { Evaluator, type ObserverLike } from '../core/evaluate.ts';
import { solveAgainstModel } from '../core/truth.ts';
import type { Formula, Judge, MeasureDecl, Rule, World } from '../core/types.ts';

/* ============================================================================
 * Experiments: a hypothesis is not a formula, and it should not cost a game.
 *
 * A PROBE is a hypothesis in words plus the way to test it: a new observation
 * (code over what is perceived) and/or a question to the Judge. The learner runs
 * it over positions whose outcome the truth knows, and reports whether it separates
 * the positions the maximizer wins from those it loses. Each way of testing is
 * reported on its own - the code's number and the Judge's answer never hide each
 * other - and on three kinds of positions:
 *
 *   siblings  the positions the maximizer could reach from ONE won position: those that
 *             keep the win against those that throw it away. This is exactly what the
 *             search asks of a formula - to order the choices it has - and, being compared
 *             within one position, it cannot be fooled by WHERE the positions came from.
 *   in_play   positions still being played: does it PREDICT the outcome? (won positions
 *             come mostly from well-played games, lost ones from the learner's: a probe can
 *             separate them by resembling good play without being able to choose a move)
 *   final     finished positions: is it what winning or losing LOOKS like? (the rules)
 *             (the Judge is never asked about a finished position: only code is tested there)
 *
 * The statistic is the AUC: the probability that a won position (a keeping choice)
 * scores higher than a lost one (a losing choice); 0.5 = no relation. For siblings only
 * pairs from the same position are compared, and the margin counts positions, not pairs.
 * A test is decisive only when the AUC is further from 0.5 than chance would put it
 * with that many samples (two-sided, ~95%):
 *
 *   supported     higher on won positions
 *   inverted      higher on LOST positions: the idea works, the other way round
 *   unsupported   no separation beyond chance
 *   inconclusive  too few labelled positions on one side
 *
 * The registry keeps every hypothesis ever tested, so the proposer builds on what
 * was learned instead of re-testing it. ACTION ACCURACY: in positions where the truth
 * knows which moves keep the win, how often the chosen move is one of them.
 * ========================================================================== */

export interface Probe {
  readonly id: string;
  readonly hypothesis: string;
  /** A new fact to measure (code over the percept). */
  readonly observation?: MeasureDecl;
  /** A question the Judge answers over the percept and the declared facts ({{id}} placeholders allowed). */
  readonly question?: Rule;
}

export type ProbeStatus = 'supported' | 'inverted' | 'unsupported' | 'inconclusive';

export type ProbePositions = 'siblings' | 'in_play' | 'final';

export interface ProbeTest {
  readonly by: 'observation' | 'question';
  readonly positions: ProbePositions;
  /** For siblings: how many won positions (each with keeping and losing choices) were compared. */
  readonly sets?: number;
  readonly samples_win: number;
  readonly samples_loss: number;
  readonly mean_when_win: number | null;
  readonly mean_when_loss: number | null;
  /** P(a won position scores higher than a lost one); 0.5 = no relation. */
  readonly auc: number | null;
  /** How far from 0.5 the AUC had to be, with these samples, to count. */
  readonly margin: number | null;
  readonly status: ProbeStatus;
}

export interface ProbeResult {
  readonly id: string;
  readonly hypothesis: string;
  /** Every way the probe was tested. The fields below repeat the most decisive one (the headline). */
  readonly tests: readonly ProbeTest[];
  readonly tested_by: 'observation' | 'question';
  readonly positions: ProbePositions;
  readonly samples_win: number;
  readonly samples_loss: number;
  readonly mean_when_win: number | null;
  readonly mean_when_loss: number | null;
  /** Mean on won positions minus mean on lost ones (each value on its own [0,1] scale). */
  readonly separation: number | null;
  readonly auc: number | null;
  readonly status: ProbeStatus;
  readonly round: number;
  readonly errors: string[];
}

export interface LabelledPosition<S> {
  readonly state: S;
  /** From the maximizer's point of view, as the truth decided it. */
  readonly label: 'win' | 'loss';
  /** A finished position (its label is its outcome). */
  readonly final?: boolean;
}

export interface ProbeOptions {
  readonly minSamples?: number;
  /** Minimum per side on FINISHED positions (fewer distinct endings exist; default min(3, minSamples)). */
  readonly minFinalSamples?: number;
  /** Two-sided critical value for the AUC under no relation (default 1.96, ~95%). */
  readonly z?: number;
  readonly round?: number;
  readonly signal?: AbortSignal;
}

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Mann-Whitney AUC: ties count half. */
export function auc(win: readonly number[], loss: readonly number[]): number | null {
  if (!win.length || !loss.length) return null;
  let wins = 0;
  for (const w of win) for (const l of loss) wins += w > l ? 1 : w === l ? 0.5 : 0;
  return wins / (win.length * loss.length);
}

export function classify(win: number[], loss: number[], options: { minSamples?: number; z?: number } = {}):
  { auc: number | null; margin: number | null; separation: number | null; status: ProbeStatus } {
  const mw = mean(win), ml = mean(loss);
  const separation = mw !== null && ml !== null ? round(mw - ml, 4) : null;
  const a = auc(win, loss);
  const minSamples = options.minSamples ?? 6;
  if (a === null || win.length < minSamples || loss.length < minSamples) {
    return { auc: a === null ? null : round(a, 4), margin: null, separation, status: 'inconclusive' };
  }
  /* The spread of the AUC when there is no relation (Hanley-McNeil null variance). */
  const n1 = win.length, n2 = loss.length;
  const margin = (options.z ?? 1.96) * Math.sqrt((n1 + n2 + 1) / (12 * n1 * n2));
  const status: ProbeStatus = a >= 0.5 + margin ? 'supported' : a <= 0.5 - margin ? 'inverted' : 'unsupported';
  return { auc: round(a, 4), margin: round(margin, 4), separation, status };
}

type Tested = ProbeTest & { separation: number | null };

function testOf(by: ProbeTest['by'], positions: ProbeTest['positions'], win: number[], loss: number[], options: ProbeOptions): Tested {
  const c = classify(win, loss, options);
  const mw = mean(win), ml = mean(loss);
  return {
    by, positions, samples_win: win.length, samples_loss: loss.length,
    mean_when_win: mw === null ? null : round(mw, 4), mean_when_loss: ml === null ? null : round(ml, 4),
    auc: c.auc, margin: c.margin, status: c.status, separation: c.separation
  };
}

/** One won position and the positions its mover could reach from it, split by the truth. */
export interface SiblingSet<S> {
  readonly keep: readonly S[];
  readonly lose: readonly S[];
}

/** AUC over pairs taken WITHIN each set (a keeping choice against a losing one of the same position). The margin
    counts sets, not pairs: pairs of one position are not independent evidence. */
export function siblingTest(sets: readonly { keep: number[]; lose: number[] }[], options: { minSamples?: number; z?: number } = {}):
  { auc: number | null; margin: number | null; status: ProbeStatus; sets: number; keep: number[]; lose: number[] } {
  let score = 0, pairs = 0, used = 0;
  const keep: number[] = [], lose: number[] = [];
  for (const s of sets) {
    if (!s.keep.length || !s.lose.length) continue;
    used++;
    keep.push(...s.keep);
    lose.push(...s.lose);
    for (const k of s.keep) for (const l of s.lose) { score += k > l ? 1 : k === l ? 0.5 : 0; pairs++; }
  }
  const a = pairs ? score / pairs : null;
  if (a === null || used < (options.minSamples ?? 6)) return { auc: a === null ? null : round(a, 4), margin: null, status: 'inconclusive', sets: used, keep, lose };
  const margin = (options.z ?? 1.96) * Math.sqrt((2 * used + 1) / (12 * used * used));
  const status: ProbeStatus = a >= 0.5 + margin ? 'supported' : a <= 0.5 - margin ? 'inverted' : 'unsupported';
  return { auc: round(a, 4), margin: round(margin, 4), status, sets: used, keep, lose };
}

/** The sibling sets of won positions where the choice matters (some moves keep the win, some throw it away). */
export function siblingSets<S, A>(world: World<S, A>, positions: readonly S[], maximizer: string, respond: (s: S) => A | null,
  options: { max?: number; budget?: number } = {}): SiblingSet<S>[] {
  const out: SiblingSet<S>[] = [];
  const seen = new Set<string>();
  for (const s of positions) {
    if (out.length >= (options.max ?? 16)) break;
    if (world.outcome(s).over || world.toMove(s) !== maximizer) continue;
    const key = world.key(s);
    if (seen.has(key)) continue;
    seen.add(key);
    const moves = world.actions(s, maximizer);
    const winners = winningMoves(world, s, maximizer, respond, options.budget ?? 40000);
    if (!winners || !winners.length || winners.length === moves.length) continue;
    const kept = new Set(winners.map((m) => world.actionKey ? world.actionKey(m) : JSON.stringify(m)));
    const keep: S[] = [], lose: S[] = [];
    for (const m of moves) (kept.has(world.actionKey ? world.actionKey(m) : JSON.stringify(m)) ? keep : lose).push(world.step(s, m));
    out.push({ keep, lose });
  }
  return out;
}

/** Run probes over labelled positions (and sibling sets). Observation tests cost nothing; question tests cost Judge
    calls (cached per percept + facts, so a repeated picture is paid once). */
export async function runProbes<S>(probes: readonly Probe[], positions: readonly LabelledPosition<S>[], context: {
  observer: ObserverLike<S>; judge: Judge; base: Formula; maximizer: string; siblings?: readonly SiblingSet<S>[];
}, options: ProbeOptions = {}): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  const inPlay = positions.filter((p) => !p.final);
  const finals = positions.filter((p) => p.final);
  const siblings = context.siblings ?? [];
  for (const probe of probes) {
    const errors: string[] = [];
    const tests: Tested[] = [];
    const split = async (set: readonly LabelledPosition<S>[], value: (s: S) => Promise<number | null>): Promise<[number[], number[]]> => {
      const win: number[] = [], loss: number[] = [];
      for (const p of set) { const v = await value(p.state); if (v !== null) (p.label === 'win' ? win : loss).push(v); }
      return [win, loss];
    };
    const bySiblings = async (by: ProbeTest['by'], value: (s: S) => Promise<number | null>): Promise<void> => {
      if (!siblings.length) return;
      const sets: { keep: number[]; lose: number[] }[] = [];
      for (const set of siblings) {
        const keep: number[] = [], lose: number[] = [];
        for (const s of set.keep) { const v = await value(s); if (v !== null) keep.push(v); }
        for (const s of set.lose) { const v = await value(s); if (v !== null) lose.push(v); }
        sets.push({ keep, lose });
      }
      const t = siblingTest(sets, options);
      const mk = mean(t.keep), ml = mean(t.lose);
      tests.push({ by, positions: 'siblings', sets: t.sets, samples_win: t.keep.length, samples_loss: t.lose.length,
        mean_when_win: mk === null ? null : round(mk, 4), mean_when_loss: ml === null ? null : round(ml, 4),
        auc: t.auc, margin: t.margin, status: t.status, separation: mk !== null && ml !== null ? round(mk - ml, 4) : null });
    };
    if (probe.observation) {
      const id = 'probe_' + probe.id;
      const decl = probe.observation;
      const range = decl.range;
      const value = async (state: S): Promise<number | null> => {
        /* Measured WITH the base observations: the senses are what a perception-only measure reads. */
        const o = context.observer.observe(state, { ...context.base.observations, [id]: decl });
        const v = o.values[id];
        const own = o.errors.find((e) => e.id === id);
        if (own && errors.length < 3) errors.push(own.error);
        if (!Number.isFinite(v) || !range || !(range[1] > range[0])) return null;
        return (v - range[0]) / (range[1] - range[0]);
      };
      await bySiblings('observation', value);
      tests.push(testOf('observation', 'in_play', ...await split(inPlay, value), options));
      if (finals.length) tests.push(testOf('observation', 'final', ...await split(finals, value), { ...options, minSamples: options.minFinalSamples ?? Math.min(3, options.minSamples ?? 6) }));
    }
    if (probe.question) {
      const observations: Record<string, MeasureDecl> = { ...context.base.observations };
      if (probe.observation) observations['probe_' + probe.id] = probe.observation;
      const formula = makeFormula({ world: context.base.world, observations, rules: { [probe.id]: { ...probe.question, used_as: 'value' } },
        weights: { [probe.id]: 1 }, meta: { source: 'probe' } });
      const ev = new Evaluator<S>(context.observer, context.judge, { maximizer: context.maximizer, strictMeasures: false });
      const value = async (state: S): Promise<number | null> => {
        try {
          const r = await ev.eval(formula, state, options.signal);
          const v = r.answers[probe.id]?.value;
          return Number.isFinite(v) ? v as number : null;
        } catch (error) {
          if ((error as { kind?: string })?.kind === 'aborted') throw error;
          if (errors.length < 3) errors.push(String((error as Error)?.message || error));
          return null;
        }
      };
      await bySiblings('question', value);
      tests.push(testOf('question', 'in_play', ...await split(inPlay, value), options));
    }
    if (!tests.length) errors.push('a probe needs an observation or a question');
    /* Decisive first (a decisive ordering of siblings above all: it is what the search uses), then unsupported,
       inconclusive last; within a rank, the AUC furthest from 0.5. */
    const rank: Record<ProbeStatus, number> = { supported: 2, inverted: 2, unsupported: 1, inconclusive: 0 };
    const decisiveness = (t: ProbeTest): number =>
      rank[t.status] + (t.positions === 'siblings' && rank[t.status] === 2 ? 1 : 0) + (t.auc === null ? 0 : Math.abs(t.auc - 0.5));
    const head = tests.slice().sort((a, b) => decisiveness(b) - decisiveness(a))[0];
    results.push({
      id: probe.id, hypothesis: probe.hypothesis,
      tests: tests.map(({ separation: _separation, ...t }) => t),
      tested_by: head?.by ?? (probe.question ? 'question' : 'observation'), positions: head?.positions ?? 'in_play',
      samples_win: head?.samples_win ?? 0, samples_loss: head?.samples_loss ?? 0,
      mean_when_win: head?.mean_when_win ?? null, mean_when_loss: head?.mean_when_loss ?? null,
      separation: head?.separation ?? null, auc: head?.auc ?? null, status: head?.status ?? 'inconclusive',
      round: options.round ?? 0, errors
    });
  }
  return results;
}

/** Every hypothesis ever tested, latest result per id. */
export class HypothesisRegistry {
  private readonly byId = new Map<string, ProbeResult>();
  private readonly history: ProbeResult[] = [];
  record(results: readonly ProbeResult[]): void {
    for (const r of results) { this.byId.set(r.id, r); this.history.push(r); }
  }
  current(): ProbeResult[] { return [...this.byId.values()]; }
  all(): ProbeResult[] { return this.history.slice(); }
  summary() {
    const count = (s: ProbeStatus) => this.current().filter((r) => r.status === s).length;
    return { tested: this.byId.size, supported: count('supported'), inverted: count('inverted'), unsupported: count('unsupported'), inconclusive: count('inconclusive') };
  }
}

/* --- Action accuracy ------------------------------------------------------------ */

/** The maximizer's moves that keep a won position won against the opponent model (null when the truth cannot say). */
export function winningMoves<S, A>(world: World<S, A>, state: S, maximizer: string, respond: (s: S) => A | null, budget = 60000): A[] | null {
  const moves = world.actions(state, maximizer);
  const winners: A[] = [];
  for (const m of moves) {
    const v = solveAgainstModel(world, world.step(state, m), maximizer, respond, { budget });
    if (v.exhausted) return null;
    if (v.winner === maximizer) winners.push(m);
  }
  return winners;
}

export interface ActionSample { readonly winning: boolean; readonly available: number; readonly keeping: number }

/** How often the chosen move keeps a won position won (only positions that are won and not trivially so count). */
export function actionAccuracy(samples: readonly ActionSample[]) {
  const counted = samples.filter((s) => s.keeping > 0 && s.keeping < s.available);
  const hits = counted.filter((s) => s.winning).length;
  return { plies: counted.length, kept_the_win: hits, rate: counted.length ? round(hits / counted.length, 4) : null,
    note: 'plies where the position was won and at least one move would have thrown it away' };
}
