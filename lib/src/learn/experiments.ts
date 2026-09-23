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
 * it over positions already played whose outcome the truth knows, and reports
 * whether it separates the positions the maximizer wins from those it loses:
 *
 *   supported     higher on won positions (by at least the threshold)
 *   inverted      higher on LOST positions: the idea works, the other way round
 *   unsupported   no separation
 *   inconclusive  too few labelled positions on one side
 *
 * The registry keeps every hypothesis ever tested, so the proposer builds on what
 * was learned instead of re-testing it. ACTION ACCURACY: in positions where the truth
 * knows which moves keep the win, how often the chosen move is one of them.
 * ========================================================================== */

export interface Probe {
  readonly id: string;
  readonly hypothesis: string;
  /** A new fact to measure (code over the percept); its value alone is tested when there is no question. */
  readonly observation?: MeasureDecl;
  /** A question the Judge answers over the percept and the declared facts ({{id}} placeholders allowed). */
  readonly question?: Rule;
}

export type ProbeStatus = 'supported' | 'inverted' | 'unsupported' | 'inconclusive';

export interface ProbeResult {
  readonly id: string;
  readonly hypothesis: string;
  readonly tested_by: 'observation' | 'question';
  readonly samples_win: number;
  readonly samples_loss: number;
  readonly mean_when_win: number | null;
  readonly mean_when_loss: number | null;
  /** Signed: mean on won positions minus mean on lost ones (on the value's own [0,1] scale). */
  readonly separation: number | null;
  readonly status: ProbeStatus;
  readonly round: number;
  readonly errors: string[];
}

export interface LabelledPosition<S> {
  readonly state: S;
  /** From the maximizer's point of view, as the truth decided it. */
  readonly label: 'win' | 'loss';
}

export interface ProbeOptions {
  readonly threshold?: number;
  readonly minSamples?: number;
  readonly round?: number;
  readonly signal?: AbortSignal;
}

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function classify(win: number[], loss: number[], threshold: number, minSamples: number): { separation: number | null; status: ProbeStatus } {
  const mw = mean(win), ml = mean(loss);
  if (win.length < minSamples || loss.length < minSamples || mw === null || ml === null) return { separation: mw !== null && ml !== null ? round(mw - ml, 4) : null, status: 'inconclusive' };
  const separation = round(mw - ml, 4);
  return { separation, status: separation >= threshold ? 'supported' : (separation <= -threshold ? 'inverted' : 'unsupported') };
}

/** Run probes over labelled positions. Observation-only probes cost nothing; question probes cost Judge calls
    (cached per percept + facts, so a repeated picture is paid once). */
export async function runProbes<S>(probes: readonly Probe[], positions: readonly LabelledPosition<S>[], context: {
  observer: ObserverLike<S>; judge: Judge; base: Formula; maximizer: string;
}, options: ProbeOptions = {}): Promise<ProbeResult[]> {
  const threshold = options.threshold ?? 0.15;
  const minSamples = options.minSamples ?? 6;
  const results: ProbeResult[] = [];
  for (const probe of probes) {
    const errors: string[] = [];
    const observations: Record<string, MeasureDecl> = { ...context.base.observations };
    if (probe.observation) observations['probe_' + probe.id] = probe.observation;
    const win: number[] = [];
    const loss: number[] = [];
    if (probe.question) {
      const formula = makeFormula({ world: context.base.world, observations, rules: { [probe.id]: { ...probe.question, used_as: 'value' } },
        weights: { [probe.id]: 1 }, meta: { source: 'probe' } });
      const ev = new Evaluator<S>(context.observer, context.judge, { maximizer: context.maximizer, strictMeasures: false });
      for (const p of positions) {
        try {
          const r = await ev.eval(formula, p.state, options.signal);
          const v = r.answers[probe.id]?.value;
          if (Number.isFinite(v)) (p.label === 'win' ? win : loss).push(v as number);
        } catch (error) {
          if ((error as { kind?: string })?.kind === 'aborted') throw error;
          if (errors.length < 3) errors.push(String((error as Error)?.message || error));
        }
      }
    } else if (probe.observation) {
      const id = 'probe_' + probe.id;
      const range = probe.observation.range;
      for (const p of positions) {
        /* Measured WITH the base observations: the senses are what a perception-only measure reads. */
        const o = context.observer.observe(p.state, { ...context.base.observations, [id]: probe.observation });
        const v = o.values[id];
        const own = o.errors.find((e) => e.id === id);
        if (own && errors.length < 3) errors.push(own.error);
        if (!Number.isFinite(v) || !range || !(range[1] > range[0])) continue;
        (p.label === 'win' ? win : loss).push((v - range[0]) / (range[1] - range[0]));
      }
    } else {
      errors.push('a probe needs an observation or a question');
    }
    const { separation, status } = classify(win, loss, threshold, minSamples);
    results.push({
      id: probe.id, hypothesis: probe.hypothesis, tested_by: probe.question ? 'question' : 'observation',
      samples_win: win.length, samples_loss: loss.length,
      mean_when_win: mean(win) === null ? null : round(mean(win)!, 4), mean_when_loss: mean(loss) === null ? null : round(mean(loss)!, 4),
      separation, status, round: options.round ?? 0, errors
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
