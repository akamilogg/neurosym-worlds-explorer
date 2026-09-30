import type { AnswerForm, CaseContext, Objective, Place } from '../../learn/objective.ts';
import type { P3Point } from './world.ts';

/* ============================================================================
 * particles3d@1's objective (SPEC-MUNDO-3D §5): PREDICTING, by horizons.
 *
 *   answer     at any row, the next row: a position [x, y, z] for every column
 *   cases      points of episodes never seen, each at several HORIZONS h: from the table up
 *              to row r, the model answers row r+1, then - its answer taken as what happened -
 *              row r+2, and so on; what it answers at r+h is compared with the table's row r+h
 *   verdict    per point, per horizon and per column, three numbers from -1 to 1:
 *              tanh((observed - answered) / (|observed - the last step repeated| + 3σ))
 *   holds      for every horizon, the median over the place's points of the criterion's term is
 *              at most `accept`, and no point threw. The term of a point is, over the particles
 *              (operator knowledge: the markers are not scored), the mean of
 *              |observed - answered|² / (3 σ² (1 + (h+1)² + h²) + (ε |observed - the last step repeated|)²)
 *              σ² is estimated from what is observed (the markers' second differences, pooled
 *              over the places run together). A law that knows the world, starting from the last
 *              two noisy rows, misses by noise of variance σ² (1 + (h+1)² + h²) per axis: its term
 *              is about 1 (the median of χ²₃/3, about 0.8).
 *
 * Horizons: 1, 4, 12 and 30 rows - only those within the world's own predictability at that
 * episode (§5.2): a horizon beyond 80 % of it is not asked, since no law could meet it. The
 * predictability is measured by the operator, by perturbing the start in Blender; System 2
 * is never told it (it sees which horizons are checked).
 * ========================================================================== */

export const P3_ANSWER: AnswerForm = {
  form: ['YOUR ANSWER, at any row of any episode: the NEXT row, as an object with a position [x, y, z] for every column name (e.g. {"A": [x, y, z], "B": [x, y, z], ...}), in the units of the table.'],
  use: 'predict'
};

export function p3Verdict(options: { regression?: boolean } = {}): string[] {
  return ['A CHECK asks your model from a row of an episode for the next row, then - taking its own answer as what happened - for the row after, and so on: at some of those later rows (HORIZONS: "<episode>@<row>+<h>") its answer is compared with what happened.',
    'A VERDICT, at a point and a horizon, is three numbers from -1 to 1 per column (x, y, z); 0 means no difference between your answer and what happened there. What the rest of the range means is for you to work out.',
    ...(options.regression ? ['The points of your previous check in a laboratory are also answered again there by this model: you learn whether your model still holds on them.'] : [])];
}

export const HORIZONS = [1, 4, 12, 30] as const;

/** A point of a check: the table up to a row, the rows that came after (for the horizons asked), which columns are scored. */
export interface P3Case {
  readonly point: string;
  readonly episode: string;
  readonly row: number;
  readonly state: P3Point;
  readonly horizons: readonly number[];
  /** The observed rows at row + h, for each horizon asked. */
  readonly targets: Readonly<Record<number, readonly (readonly number[] | null)[]>>;
  /** OPERATOR ONLY: the columns that are particles (scored). */
  readonly bodies: readonly string[];
  /** The variance of perception estimated from the episode's markers. */
  readonly noise: number;
}

export interface P3Result {
  readonly place: string;
  readonly point: string;
  readonly horizon: number;
  /** Per column, the verdict. */
  readonly verdict: Readonly<Record<string, readonly number[]>>;
  readonly chi: number | null;
  readonly failed?: string;
  /** Operator only (the trace). */
  readonly answered?: Readonly<Record<string, readonly number[]>>;
  readonly came?: Readonly<Record<string, readonly number[] | null>>;
}

export interface P3ObjectiveHost<M, P extends Place> {
  casesIn(place: P, context: CaseContext): readonly P3Case[] | Promise<readonly P3Case[]>;
  answer(model: M, state: P3Point): Promise<unknown>;
  readonly accept: number;
  readonly precision: number;
  readonly regression?: boolean;
}

/** An answer read as positions per column, or why it cannot be. */
export function readAnswer(a: unknown, names: readonly string[]): Record<string, number[]> | string {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return 'the answer must be an object: {"<column>": [x, y, z], ...}';
  const out: Record<string, number[]> = {};
  for (const n of names) {
    const v = (a as Record<string, unknown>)[n];
    if (v === undefined || v === null) continue;
    if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) return 'column ' + n + ' must be [x, y, z] (numbers)';
    out[n] = v as number[];
  }
  return out;
}

/** The state after a row the model answered: that row appended (a column it left out keeps its last position). */
export function appendRow(state: P3Point, answer: Record<string, readonly number[]>): P3Point {
  const last = state.rows[state.rows.length - 1];
  const dt = state.t.length > 1 ? state.t[state.t.length - 1] - state.t[state.t.length - 2] : 1;
  return { t: [...state.t, Number((state.t[state.t.length - 1] + dt).toPrecision(9))], names: state.names,
    rows: [...state.rows, state.names.map((n, j) => answer[n] ?? last[j])] };
}

const median = (xs: readonly number[]) => {
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : 0;
};

/** Per horizon, the median of the criterion's terms. */
export function p3Bands(results: readonly P3Result[]): Record<string, number> {
  const scored = results.filter((r) => !r.failed && r.chi !== null);
  const hs = [...new Set(scored.map((r) => r.horizon))].sort((a, b) => a - b);
  return Object.fromEntries(hs.map((h) => ['h' + h, median(scored.filter((r) => r.horizon === h).map((r) => r.chi!))]));
}

export function p3Objective<M, P extends Place>(host: P3ObjectiveHost<M, P>): Objective<M, P, readonly P3Case[], P3Result> {
  const holdsOn = (results: readonly P3Result[]) => {
    const bands = p3Bands(results);
    return Object.keys(bands).length > 0 && !results.some((r) => r.failed) && Object.values(bands).every((m) => m <= host.accept);
  };
  /** One point: the model answers row after row from its own answers; at each horizon, the verdict and the term. */
  async function runCase(model: M, place: string, c: P3Case, noise: number): Promise<P3Result[]> {
    const out: P3Result[] = [];
    const last = c.state.rows[c.state.rows.length - 1], before = c.state.rows[c.state.rows.length - 2];
    let state = c.state;
    const hMax = Math.max(...c.horizons);
    for (let k = 1; k <= hMax; k++) {
      let answer: Record<string, number[]> | string;
      try { answer = readAnswer(await host.answer(model, state), c.state.names); } catch (e) { answer = String((e as Error)?.message ?? e); }
      if (typeof answer === 'string') {
        for (const h of c.horizons.filter((x) => x >= k)) out.push({ place, point: c.point + '+' + h, horizon: h, verdict: {}, chi: null, failed: answer });
        return out;
      }
      state = appendRow(state, answer);
      if (!c.horizons.includes(k)) continue;
      const came = c.targets[k];
      const verdict: Record<string, number[]> = {}, answered: Record<string, number[]> = {}, seen: Record<string, readonly number[] | null> = {};
      const terms: number[] = [];
      c.state.names.forEach((n, j) => {
        const obs = came[j], pred = state.rows[state.rows.length - 1][j];
        seen[n] = obs;
        if (!obs || !pred || !last[j] || !before?.[j]) return;
        const lin = [0, 1, 2].map((a) => last[j]![a] + k * (last[j]![a] - before[j]![a]));
        const scale = Math.hypot(obs[0] - lin[0], obs[1] - lin[1], obs[2] - lin[2]);
        verdict[n] = [0, 1, 2].map((a) => Math.round(Math.tanh((obs[a] - pred[a]) / (scale + 3 * Math.sqrt(noise) + 1e-12)) * 1000) / 1000);
        answered[n] = [...pred];
        if (c.bodies.includes(n)) {
          const err2 = (obs[0] - pred[0]) ** 2 + (obs[1] - pred[1]) ** 2 + (obs[2] - pred[2]) ** 2;
          terms.push(err2 / (3 * noise * (1 + (k + 1) ** 2 + k * k) + (host.precision * scale) ** 2 + 1e-24));
        }
      });
      out.push({ place, point: c.point + '+' + k, horizon: k, verdict, chi: terms.length ? terms.reduce((s, v) => s + v, 0) / terms.length : null, answered, came: seen });
    }
    return out;
  }
  return {
    answer: P3_ANSWER,
    verdictForm: p3Verdict({ regression: host.regression }),
    casesIn: (place, context) => host.casesIn(place, context),
    async run(model, cases) {
      /* One pooled noise estimate over the places run together. */
      const all = cases.flatMap((c) => c.cases);
      const noise = all.length ? all.reduce((s, c) => s + c.noise, 0) / all.length : 0;
      const byPlace: P3Result[][] = [];
      for (const { place, cases: k } of cases) {
        const rs: P3Result[] = [];
        for (const c of k) rs.push(...await runCase(model, place.id, c, noise));
        byPlace.push(rs);
      }
      return { byPlace, operator: { noise_variance: Number(noise.toPrecision(4)) } };
    },
    holds: (results, { rerun }) => holdsOn(results) && (!rerun || holdsOn(rerun.now)),
    view(results) {
      /* Facts only: per episode, the verdict at each point and horizon (a point where the model threw says so). */
      const byEpisode = new Map<string, unknown[]>();
      for (const r of results) {
        const id = r.point.split('@')[0];
        byEpisode.set(id, [...(byEpisode.get(id) ?? []), r.failed ? { point: r.point, error: r.failed.slice(0, 160) } : { point: r.point, verdict: r.verdict }]);
      }
      return { episodes: [...byEpisode.entries()].map(([episode, points]) => ({ episode, points })) };
    },
    rerunView: (rerun) => ({ points: rerun.now.length, your_model_holds_on_them: holdsOn(rerun.now) }),
    trace: (results) => results.slice(0, 60).map((r) => ({ point: r.point, ...(r.failed ? { error: r.failed.slice(0, 120) } : { answered: r.answered, came: r.came }) })),
    operatorView: (results) => ({ chi2_by_horizon: p3Bands(results), points: results.length, failed: results.filter((r) => r.failed).length }),
    line: (results, _place, rerun) => Object.entries(p3Bands(results)).map(([h, m]) => h + ' ' + Number(m.toPrecision(3))).join(', ')
      + (results.some((r) => r.failed) ? ' (a point threw)' : '') + (rerun ? ' (run again: ' + (holdsOn(rerun.now) ? 'holds' : 'does not hold') + ')' : '')
  };
}
