import { asksJudge, type Law, type Measured, type PredictionSample, type Predictor, type Vec2 } from '../core/predict.ts';
import type { Rule } from '../core/types.ts';

/* ============================================================================
 * Ablations of a LAW: what does the Judge add to it? Information, not a verdict (see
 * ablation.ts). Each arm keeps the learner's observations and its OUTPUT code, and
 * changes only where the rules' answers come from:
 *
 *   code-only  no Judge: each rule's answer is a fitted reading of the numeric observations
 *              (a logistic function of them, each scaled to [0,1] by its range), fitted on the
 *              learner's own points through its own output
 *   flat       no Judge and no observation: each rule's answer is a fitted constant - the floor
 *   delegated  the Judge reads the whole table as text instead of the learner's observations
 *              (the other mode of the architecture; one Judge call per point), and the output
 *              still reads what the learner measured
 *
 *   code-only matches the law   the observations carry it (a legitimate result: code is readable)
 *   the law beats code-only     the Judge's rules carry something the code does not
 * A law without rules is code only: there is nothing to ablate.
 * ========================================================================== */

/** Least squares by the normal equations (small systems), with Levenberg damping and a tiny ridge so a feature that
    never varies does not make the system singular. */
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

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

export interface LawFit<S> {
  /** Per rule: the constant and one coefficient per numeric observation (logit scale). Empty for a law without rules. */
  readonly coefficients: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly predict: (state: S) => Vec2;
}

/** Fit the code-only reading of `law` (or, with `flat`, a constant per rule) on samples, through the learner's own output:
    r_i = σ(Σ_j c_ij x_j) over the numeric observations scaled to [0,1]. Levenberg-Marquardt with a numeric Jacobian. */
export function fitLawCodeOnly<S>(predictor: Predictor<S>, law: Law, samples: readonly PredictionSample<S>[],
  options: { flat?: boolean; iterations?: number; maxSamples?: number } = {}): LawFit<S> {
  const ruleIds = Object.keys(law.rules);
  const numeric = options.flat ? [] : Object.entries(law.observations).filter(([, d]) => d.range && d.range[1] > d.range[0]).map(([id]) => id);
  const width = numeric.length + 1;
  const featuresOf = (m: Measured<S>): number[] => [1, ...numeric.map((id) => {
    const [lo, hi] = law.observations[id].range!;
    const v = m.values[id];
    return typeof v === 'number' ? (v - lo) / (hi - lo) : 0.5;
  })];
  const answersOf = (x: number[], c: readonly number[]) =>
    Object.fromEntries(ruleIds.map((id, k) => [id, sigmoid(x.reduce((acc, xj, j) => acc + c[k * width + j] * xj, 0))]));
  const predictWith = (m: Measured<S>, c: readonly number[]) => predictor.answerWith(law, m, answersOf(featuresOf(m), c));
  if (!asksJudge(law)) return { coefficients: {}, predict: (state) => predictor.answerWith(law, predictor.measured(law, state), {}) };
  const step = Math.max(1, Math.ceil(samples.length / (options.maxSamples ?? 160)));
  const data: { m: Measured<S>; t: Vec2 }[] = [];
  for (let i = 0; i < samples.length; i += step) {
    try { const m = predictor.measured(law, samples[i].state); predictWith(m, new Array(ruleIds.length * width).fill(0)); data.push({ m, t: samples[i].target }); }
    catch { /* a point the law cannot answer */ }
  }
  const residualsOf = (c: readonly number[]): number[] | null => {
    const out: number[] = [];
    for (const { m, t } of data) {
      let p: Vec2;
      try { p = predictWith(m, c); } catch { return null; }
      out.push(t[0] - p[0], t[1] - p[1]);
    }
    return out;
  };
  const cost = (r: number[] | null) => (r ? r.reduce((n, v) => n + v * v, 0) : Infinity);
  const c = new Array<number>(ruleIds.length * width).fill(0);
  let current = residualsOf(c);
  let lambda = 1e-3;
  for (let it = 0; it < (options.iterations ?? 40) && current && data.length; it++) {
    /* The Jacobian of the prediction in each parameter, by forward differences. */
    const h = 1e-4;
    const columns = c.map((_, i) => {
      const moved = residualsOf(c.map((v, j) => (j === i ? v + h : v)));
      return moved ? moved.map((r, k) => (current![k] - r) / h) : current!.map(() => 0);
    });
    const rows = current.map((_, k) => columns.map((col) => col[k]));
    const delta = leastSquares(rows, current, lambda);
    const trial = c.map((v, i) => v + delta[i]);
    const next = residualsOf(trial);
    if (cost(next) < cost(current)) {
      const gain = cost(current) - cost(next);
      c.splice(0, c.length, ...trial);
      current = next;
      lambda = Math.max(1e-9, lambda / 3);
      if (gain < 1e-12 * Math.max(1e-300, cost(next))) break;
    } else lambda *= 10;
  }
  const coefficients = Object.fromEntries(ruleIds.map((id, k) => [id, Object.fromEntries(['constant', ...numeric].map((name, j) => [name, c[k * width + j]]))]));
  return { coefficients, predict: (state) => predictWith(predictor.measured(law, state), c) };
}

/* The header and the latest rows: a Judge's text is clipped at 4000 characters, and the latest rows are what matters. */
const RECENT_ROWS = "(p) => { const l = p.table.split('\\n'); return [l[0], ...l.slice(1).slice(-24)].join('\\n'); }";

/** The delegated arm: the same rules, weights and output, but the Judge reads the whole table instead of the learner's
    observations (a rule's citations of them are replaced by a pointer to the table). The output still reads the learner's
    observations: pass them to the Predictor as `measure`. */
export function delegatedLaw(law: Law, tableSource = RECENT_ROWS): Law {
  const cite = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;
  const unquote = (t: string) => t.replace(cite, '[read it from the table]');
  const rules: Record<string, Rule> = {};
  for (const [id, r] of Object.entries(law.rules)) {
    const criteria = Array.isArray(r.criteria) ? r.criteria.map((x) => unquote(String(x)))
      : Object.fromEntries(Object.entries(r.criteria ?? {}).map(([k, v]) => [k, unquote(String(v))]));
    rules[id] = { ...r, instructions: 'The table shows values over time. ' + unquote(r.instructions), criteria } as Rule;
  }
  return { ...law, observations: { observed_table: { definition: 'the whole table, as text', spec: { kind: 'code', lang: 'js', source: tableSource } } }, rules };
}
