import { clamp, round } from '../core/hash.ts';
import { makeFormula } from '../core/formula.ts';
import type { ObserverLike } from '../core/evaluate.ts';
import type { Formula, Judge } from '../core/types.ts';
import type { LabelledPosition } from './experiments.ts';

/* ============================================================================
 * Ablation: how much of the judgement do the observations carry ON THEIR OWN?
 *
 * The same observations, no Judge: V(s) is a fixed linear reading of the measured
 * values, each weighted by how well it separates won from lost positions (its sign
 * and size fitted on labelled positions). Deterministic and local.
 *
 * It is INFORMATION, not a verdict: code is interpretable and deterministic too, and a
 * formula whose observations already decide the game is a legitimate result. What the
 * comparison tells the reader is WHERE the strategy lives:
 *
 *   code-only wins as much as the formula   the observations carry it
 *   code-only loses where the formula wins  the Judge's rules carry it
 * ========================================================================== */

export interface CodeOnlyFit {
  /** Per measured observation: signed separation (won minus lost, on its own [0,1] scale). */
  readonly weights: Readonly<Record<string, number>>;
  readonly ranges: Readonly<Record<string, readonly [number, number]>>;
  readonly samples: { win: number; loss: number };
}

export const CODE_ONLY_RULE = 'code_only';

/** Fit the linear reading of `formula`'s numeric observations on labelled positions. */
export function fitCodeOnly<S>(observer: ObserverLike<S>, formula: Formula, positions: readonly LabelledPosition<S>[]): CodeOnlyFit {
  const ranges: Record<string, readonly [number, number]> = {};
  for (const [id, d] of Object.entries(formula.observations)) {
    if (d.range && d.range[1] > d.range[0]) ranges[id] = d.range;
  }
  const sums: Record<string, { win: number[]; loss: number[] }> = Object.fromEntries(Object.keys(ranges).map((id) => [id, { win: [], loss: [] }]));
  let win = 0, loss = 0;
  for (const p of positions) {
    const o = observer.observe(p.state, formula.observations);
    if (p.label === 'win') win++; else loss++;
    for (const [id, [lo, hi]] of Object.entries(ranges)) {
      const v = o.values[id];
      if (Number.isFinite(v)) sums[id][p.label].push(clamp((v - lo) / (hi - lo), 0, 1));
    }
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const weights: Record<string, number> = {};
  for (const id of Object.keys(ranges)) {
    const sep = mean(sums[id].win) - mean(sums[id].loss);
    weights[id] = Number.isFinite(sep) ? round(sep, 4) : 0;
  }
  return { weights, ranges, samples: { win, loss } };
}

/** The same observations, one rule the local judge answers: the formula to search with in the ablation. */
export function codeOnlyFormula(formula: Formula): Formula {
  return makeFormula({
    world: formula.world, observations: formula.observations,
    rules: { [CODE_ONLY_RULE]: { type: 'noul', used_as: 'value', instructions: 'linear reading of the observations (ablation)', criteria: { yes: '', no: '' } } },
    weights: { [CODE_ONLY_RULE]: 1 }, meta: { source: 'ablation:code-only' }
  });
}

/** V = 0.5 + sum_i w_i (x_i - 0.5) / sum_i |w_i| : 1 when every observation sits at its winning end. */
export function codeOnlyJudge(fit: CodeOnlyFit): Judge {
  const total = Object.values(fit.weights).reduce((a, w) => a + Math.abs(w), 0);
  return {
    id: 'ablation:code-only',
    async judge(request) {
      let v = 0.5;
      if (total > 0) {
        let acc = 0;
        for (const [id, w] of Object.entries(fit.weights)) {
          const x = request.measurements[id];
          const [lo, hi] = fit.ranges[id];
          if (Number.isFinite(x)) acc += w * (clamp((x - lo) / (hi - lo), 0, 1) - 0.5);
        }
        v = clamp(0.5 + acc / total, 0, 1);
      }
      return { [CODE_ONLY_RULE]: { value: round(v, 4), confidence: null } };
    }
  };
}
