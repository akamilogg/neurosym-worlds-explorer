import type { ObserverLike } from '../core/evaluate.ts';
import { lawFormula, type Law, type PredictionSample, type Vec2 } from '../core/predict.ts';
import { jsFunctionRunner } from '../core/code-runner.ts';
import type { Rule } from '../core/types.ts';

/* ============================================================================
 * Ablations of a LAW: how much of the prediction do the observations carry on their
 * own, and what does the Judge add? Information, not a verdict (see ablation.ts).
 *
 *   code-only  the same directions and numeric observations, no Judge: each component's
 *              magnitude is a linear function of the observations (each scaled to [0,1]
 *              by its range), fitted by least squares on samples
 *   flat       the same directions, a constant magnitude per component (fitted): the floor
 *   delegated  no observation of the learner's: the Judge reads the whole table as text
 *              and places each magnitude in the component's range (the other mode of the
 *              architecture; costs one Judge call per point)
 *
 *   code-only matches the law   the observations carry it (a legitimate result: code is readable)
 *   the law beats code-only     the Judge's rules carry something the code does not
 * ========================================================================== */

type Direction = (percept: unknown) => Vec2;

function directions(law: Law): Record<string, Direction> {
  const runner = jsFunctionRunner();
  return Object.fromEntries(Object.entries(law.components).map(([id, c]) => {
    const fn = runner.compile(c.direction.source) as unknown as (p: unknown) => unknown;
    return [id, (p: unknown): Vec2 => {
      const out = fn(p) as number[];
      const n = Math.hypot(out[0], out[1]);
      return n > 0 ? [out[0] / n, out[1] / n] : [0, 0];
    }];
  }));
}

/** Least squares by the normal equations (small systems), with a tiny ridge so a feature that never varies does not
    make the system singular. */
function leastSquares(rows: number[][], targets: number[], damping = 0): number[] {
  const n = rows[0]?.length ?? 0;
  const A = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const b = new Array<number>(n).fill(0);
  rows.forEach((r, k) => { for (let i = 0; i < n; i++) { b[i] += r[i] * targets[k]; for (let j = 0; j < n; j++) A[i][j] += r[i] * r[j]; } });
  const scale = Math.max(1e-300, ...A.map((row, i) => Math.abs(row[i])));
  for (let i = 0; i < n; i++) A[i][i] += 1e-9 * scale + damping * A[i][i];
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (M[c][c] === 0) continue;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => (row[i] === 0 ? 0 : row[n] / row[i]));
}

export interface LawFit<S> {
  /** Per component: the constant and one coefficient per numeric observation used, in the component's V space. */
  readonly coefficients: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly predict: (state: S) => Vec2;
}

/** Fit the code-only reading of `law` (or, with `flat`, a constant per component) on samples. Each component keeps its
    direction, range and SCALE; only the Judge's composition is replaced, by V_k = Σ_j c_kj x_j over the numeric
    observations (each scaled to [0,1] by its range). With a log scale that is not linear in c, so the fit is
    Gauss-Newton with Levenberg damping, from V = 0.5. */
export function fitLawCodeOnly<S>(observer: ObserverLike<S>, perceive: (state: S) => unknown, law: Law, samples: readonly PredictionSample<S>[],
  options: { flat?: boolean; iterations?: number } = {}): LawFit<S> {
  const dirs = directions(law);
  const comps = Object.keys(law.components);
  const numeric = options.flat ? [] : Object.entries(law.observations).filter(([, d]) => d.range && d.range[1] > d.range[0]).map(([id]) => id);
  const width = numeric.length + 1;
  const features = (state: S): { dirs: Vec2[]; x: number[] } => {
    const o = observer.observe(state, lawFormula(law).observations);
    const x = [1, ...numeric.map((id) => {
      const [lo, hi] = law.observations[id].range!;
      const v = o.values[id];
      return typeof v === 'number' ? (v - lo) / (hi - lo) : 0.5;
    })];
    const p = perceive(state);
    return { dirs: comps.map((id) => dirs[id](p)), x };
  };
  /* The magnitude of a component for a (not clamped) V, and its derivative: the fit may pass through V outside [0,1]. */
  const mag = (k: number, v: number): [number, number] => {
    const c = law.components[comps[k]];
    const [lo, hi] = c.range;
    if (c.scale === 'log') { const m = Math.exp(Math.log(lo) + v * (Math.log(hi) - Math.log(lo))); return [m, m * (Math.log(hi) - Math.log(lo))]; }
    return [lo + v * (hi - lo), hi - lo];
  };
  const data: { f: { dirs: Vec2[]; x: number[] }; t: Vec2 }[] = [];
  for (const s of samples) { try { data.push({ f: features(s.state), t: s.target }); } catch { /* a point the observations cannot read */ } }
  const c = new Array<number>(comps.length * width).fill(0);
  for (let k = 0; k < comps.length; k++) c[k * width] = 0.5;
  const residuals = (params: readonly number[]) => {
    const rows: number[][] = [];
    const res: number[] = [];
    for (const { f, t } of data) {
      const pred: [number, number] = [0, 0];
      const grads: number[][] = [new Array<number>(params.length).fill(0), new Array<number>(params.length).fill(0)];
      f.dirs.forEach((d, k) => {
        const v = f.x.reduce((acc, xj, j) => acc + params[k * width + j] * xj, 0);
        const [m, dm] = mag(k, v);
        pred[0] += m * d[0]; pred[1] += m * d[1];
        for (const axis of [0, 1]) for (let j = 0; j < width; j++) grads[axis][k * width + j] = d[axis] * dm * f.x[j];
      });
      for (const axis of [0, 1]) { rows.push(grads[axis]); res.push(t[axis] - pred[axis]); }
    }
    return { rows, res, cost: res.reduce((n, r) => n + r * r, 0) };
  };
  let lambda = 1e-3;
  let current = residuals(c);
  for (let it = 0; it < (options.iterations ?? 60) && data.length; it++) {
    const step = leastSquares(current.rows, current.res, lambda);
    const trial = c.map((v, i) => v + step[i]);
    const next = residuals(trial);
    if (Number.isFinite(next.cost) && next.cost < current.cost) {
      const gain = current.cost - next.cost;
      c.splice(0, c.length, ...trial);
      current = next;
      lambda = Math.max(1e-9, lambda / 3);
      if (gain < 1e-12 * Math.max(1e-300, next.cost)) break;
    } else lambda *= 10;
  }
  const coefficients = Object.fromEntries(comps.map((id, k) => [id, Object.fromEntries(['constant', ...numeric].map((name, j) => [name, c[k * width + j]]))]));
  return {
    coefficients,
    predict: (state) => {
      const f = features(state);
      let v: Vec2 = [0, 0];
      f.dirs.forEach((d, k) => {
        const [m] = mag(k, f.x.reduce((acc, xj, j) => acc + c[k * width + j] * xj, 0));
        v = [v[0] + m * d[0], v[1] + m * d[1]];
      });
      return v;
    }
  };
}

/* The header and the latest rows: a Judge's text is clipped at 4000 characters, and the latest rows are what matters. */
const RECENT_ROWS = "(p) => { const l = p.table.split('\\n'); return [l[0], ...l.slice(1).slice(-24)].join('\\n'); }";

export function delegatedLaw(law: Law, tableSource = RECENT_ROWS): Law {
  const rules: Record<string, Rule> = {};
  const components: Record<string, Law['components'][string]> = {};
  for (const [id, c] of Object.entries(law.components)) {
    const rule = 'delegated_' + id;
    rules[rule] = {
      type: 'noul', used_as: 'value',
      instructions: 'The observed table shows how some bodies moved. Estimate how far the next position of the last symbol departs from repeating its last step, '
        + 'measured along one direction, as a fraction between the smallest (0) and the largest (1) plausible size'
        + (c.scale === 'log' ? ' on a logarithmic scale' : '') + '.',
      criteria: { yes: 'large', no: 'small' }
    };
    components[id] = { ...c, weights: { [rule]: 1 } };
  }
  return { world: law.world, observations: { observed_table: { definition: 'the whole table, as text', spec: { kind: 'code', lang: 'js', source: tableSource } } }, rules, components };
}
