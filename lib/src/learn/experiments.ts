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
  /** P(a won position scores higher than a lost one); 0.5 = no relation. With game scores: of two positions from
      games with different scores, P(the one from the higher-scored game has the higher value). */
  readonly auc: number | null;
  /** How far from 0.5 the AUC had to be, with these samples, to count. */
  readonly margin: number | null;
  readonly status: ProbeStatus;
  /** In play and final: positions and mean value per game score (highest score first). */
  readonly by_score?: readonly { readonly score: number; readonly positions: number; readonly mean: number | null }[];
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
  /** What was measured and asked, so the explorer can read (and reuse) its own probe later. */
  readonly code?: { observation?: string; range?: readonly [number, number]; question?: string };
}

export interface LabelledPosition<S> {
  readonly state: S;
  /** From the maximizer's point of view, as the truth decided it. */
  readonly label: 'win' | 'loss';
  /** How the game it comes from ended for the maximizer, from -1 to 1 (default: 1 for a win, -1 for a loss).
      Probes compare positions by this score, so a draw is neither a win nor a loss. */
  readonly score?: number;
  /** A finished position (its label is its outcome). */
  readonly final?: boolean;
}

export const scoreOf = (p: { label: 'win' | 'loss'; score?: number }): number => p.score ?? (p.label === 'win' ? 1 : -1);

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

/** A value measured on a position, with the score of the game it comes from. */
export interface Scored { readonly value: number; readonly score: number }

/** Of two samples with different scores, P(the higher-scored one has the higher value); ties count half. */
export function concordance(samples: readonly Scored[]): number | null {
  let hits = 0, pairs = 0;
  for (let i = 0; i < samples.length; i++) for (let j = i + 1; j < samples.length; j++) {
    const a = samples[i], b = samples[j];
    if (a.score === b.score) continue;
    const [hi, lo] = a.score > b.score ? [a, b] : [b, a];
    hits += hi.value > lo.value ? 1 : hi.value === lo.value ? 0.5 : 0;
    pairs++;
  }
  return pairs ? hits / pairs : null;
}

/** Like `classify`, over any number of game scores. Decisive needs two scores with minSamples each; the margin is
    the 95th percentile of |AUC - 0.5| with the scores shuffled (seeded: the same samples give the same margin). */
export function classifyScored(samples: readonly Scored[], options: { minSamples?: number; permutations?: number } = {}):
  { auc: number | null; margin: number | null; status: ProbeStatus } {
  const a = concordance(samples);
  const counts = new Map<number, number>();
  for (const x of samples) counts.set(x.score, (counts.get(x.score) ?? 0) + 1);
  const minSamples = options.minSamples ?? 6;
  if (a === null || [...counts.values()].filter((n) => n >= minSamples).length < 2) return { auc: a === null ? null : round(a, 4), margin: null, status: 'inconclusive' };
  let seed = (samples.length * 7919 + 1) >>> 0;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const scores = samples.map((x) => x.score);
  const spread: number[] = [];
  for (let k = 0; k < (options.permutations ?? 400); k++) {
    for (let i = scores.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [scores[i], scores[j]] = [scores[j], scores[i]]; }
    spread.push(Math.abs((concordance(samples.map((x, i) => ({ value: x.value, score: scores[i] }))) ?? 0.5) - 0.5));
  }
  spread.sort((x, y) => x - y);
  const margin = Math.max(spread[Math.ceil(0.95 * spread.length) - 1], 1e-9);
  const status: ProbeStatus = a >= 0.5 + margin ? 'supported' : a <= 0.5 - margin ? 'inverted' : 'unsupported';
  return { auc: round(a, 4), margin: round(margin, 4), status };
}

function testOf(by: ProbeTest['by'], positions: ProbeTest['positions'], samples: readonly Scored[], options: ProbeOptions): Tested {
  const c = classifyScored(samples, options);
  const win = samples.filter((x) => x.score > 0).map((x) => x.value), loss = samples.filter((x) => x.score < 0).map((x) => x.value);
  const mw = mean(win), ml = mean(loss);
  const by_score = [...new Set(samples.map((x) => x.score))].sort((a, b) => b - a).map((score) => {
    const m = mean(samples.filter((x) => x.score === score).map((x) => x.value));
    return { score, positions: samples.filter((x) => x.score === score).length, mean: m === null ? null : round(m, 4) };
  });
  return {
    by, positions, samples_win: win.length, samples_loss: loss.length,
    mean_when_win: mw === null ? null : round(mw, 4), mean_when_loss: ml === null ? null : round(ml, 4),
    auc: c.auc, margin: c.margin, status: c.status, by_score,
    separation: mw !== null && ml !== null ? round(mw - ml, 4) : null
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
    const split = async (set: readonly LabelledPosition<S>[], value: (s: S) => Promise<number | null>): Promise<Scored[]> => {
      const out: Scored[] = [];
      for (const p of set) { const v = await value(p.state); if (v !== null) out.push({ value: v, score: scoreOf(p) }); }
      return out;
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
      tests.push(testOf('observation', 'in_play', await split(inPlay, value), options));
      if (finals.length) tests.push(testOf('observation', 'final', await split(finals, value), { ...options, minSamples: options.minFinalSamples ?? Math.min(3, options.minSamples ?? 6) }));
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
      tests.push(testOf('question', 'in_play', await split(inPlay, value), options));
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
      round: options.round ?? 0, errors,
      code: { ...(probe.observation ? { observation: (probe.observation.spec as { source?: string }).source, range: probe.observation.range } : {}),
        ...(probe.question ? { question: probe.question.instructions } : {}) }
    });
  }
  return results;
}

/** A test as FACTS, with no verdict: the explorer compares them with its own hypothesis (whose direction only it
    knows). "Chance could explain it" is the one statistical fact it cannot see by itself in a handful of numbers. */
export function describeTest(t: ProbeTest): Record<string, unknown> {
  const where = t.positions === 'siblings' ? 'choices from one point' : t.positions === 'final' ? 'final points' : 'points in play';
  const chance = t.status === 'inconclusive' ? 'too few points to say' : t.status === 'unsupported' ? 'yes' : 'no';
  /* By the score each episode ended with: what the scores mean is for the explorer to work out. */
  if (t.by_score) return {
    tested: t.by, on: where,
    by_episode_score: t.by_score.map((g) => ({ episode_score: g.score, points: g.positions, mean: g.mean })),
    auc: t.auc, could_chance_explain_the_difference: chance
  };
  return {
    tested: t.by, on: where,
    mean_in_won_games: t.mean_when_win, mean_in_lost_games: t.mean_when_loss,
    auc: t.auc,
    positions: t.positions === 'siblings' ? { compared: t.sets ?? 0 } : { from_won_games: t.samples_win, from_lost_games: t.samples_loss },
    could_chance_explain_the_difference: t.status === 'inconclusive' ? 'too few positions to say' : t.status === 'unsupported' ? 'yes' : 'no'
  };
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
