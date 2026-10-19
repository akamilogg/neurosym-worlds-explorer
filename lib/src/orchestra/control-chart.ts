import fs from 'node:fs';
import path from 'node:path';
import { generatorOf } from '../runtime/generators.ts';
import { METRICS, valuesOf } from './references.ts';

/* ============================================================================
 * STATISTICAL CONTROL, WHEN THE DATA ALLOW IT (SPEC-CONTROL-ARNES K5, §6.3).
 *
 *   lab control <batch.json> [<batch.json> ...] --condition C [--metric o1] [--min-subgroups 20]
 *
 * A group of comparable runs (the same world, code version and generating configuration) followed across batches, in the
 * order they began. Before any chart, its assumptions are checked and said one by one (after the NIST handbook of
 * statistical engineering, for charts of proportions):
 *   enough comparable subgroups (batches; for a continuous metric, runs) - fewer, and only §6.2 is said
 *   subgroups of a defined size (a proportion needs at least 2 runs in each)
 *   independence between runs (distinct seeds; no member of a team that shares a board; no branch of another run)
 *   the normal approximation of a chart of proportions (n·p and n·(1-p) at least 5 in every subgroup)
 *   a stable probability: assumed - it is what the chart examines; its signals are where it may not hold
 * Binary results: a p chart (limits per subgroup, 3 sigma). Continuous ones: an individuals and moving range chart.
 * Its signals - a point beyond a limit, eight in a row on one side of the centre - are INDICATIONS OF A SPECIAL CAUSE TO
 * INVESTIGATE, never a diagnosis; and no label of "in control" or "out of control" is ever given.
 * ========================================================================== */

type J = Record<string, any>;
const readJson = (file: string): J | null => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const r4 = (x: number) => Math.round(x * 10000) / 10000;

export interface Assumption { readonly assumption: string; readonly holds: boolean | 'assumed'; readonly detail: string }
export interface Signal { readonly at: string; readonly rule: string; readonly reading: string }

interface Subgroup { batch: string; started: string; runs: { journal: string; seed: unknown; value: number | null; team: boolean; branch: boolean }[] }

/** The charts of a condition across batches, one per group of comparable runs found in it. */
export function controlCharts(batchFiles: readonly string[], o: { condition: string; metric?: string; minSubgroups?: number }): Record<string, unknown>[] {
  const metric = o.metric ?? 'o1';
  const m = METRICS[metric];
  if (!m) throw new Error('metric ' + metric + ' (one of ' + Object.keys(METRICS).join(', ') + ')');
  const min = o.minSubgroups ?? 20;
  const reports = batchFiles.map((f) => { const r = readJson(f); if (!r || r.format !== 'batch@1') throw new Error(f + ' is not a batch report'); return r; })
    .sort((a, b) => String(a.started).localeCompare(String(b.started)));
  /* Its runs, by group of comparable runs, a subgroup per batch. */
  const series = new Map<string, { key: J; subgroups: Subgroup[] }>();
  for (const report of reports) for (const row of (report.runs ?? []) as J[]) {
    if (row.condition !== o.condition || !row.journal || !fs.existsSync(row.journal)) continue;
    const journal = readJson(row.journal)!;
    const key = { world: String(journal.experiment), code_version: journal.commit ?? null, generator: generatorOf(journal, path.dirname(row.journal), path.basename(row.journal, '.json')).id };
    const id = JSON.stringify(key);
    const s = series.get(id) ?? { key, subgroups: [] as Subgroup[] };
    let sub = s.subgroups.find((g) => g.batch === report.id);
    if (!sub) { sub = { batch: report.id, started: report.started, runs: [] }; s.subgroups.push(sub); }
    const def = ((report.definition?.runs ?? []) as J[]).find((r) => r.id === row.id);
    sub.runs.push({ journal: row.journal, seed: journal.config?.seed, value: valuesOf(row.journal)[metric], team: Boolean(journal.config?.team), branch: Boolean(def?.fork) });
    series.set(id, s);
  }
  return [...series.values()].map(({ key, subgroups }) => chartOf(key, subgroups, metric, Boolean(m.binary), min));
}

function chartOf(key: J, subgroups: Subgroup[], metric: string, binary: boolean, min: number): Record<string, unknown> {
  const runs = subgroups.flatMap((g) => g.runs.filter((r) => typeof r.value === 'number').map((r) => ({ ...r, batch: g.batch })));
  const independent = subgroups.every((g) => new Set(g.runs.map((r) => JSON.stringify(r.seed))).size === g.runs.length) && runs.every((r) => !r.team && !r.branch);
  const assumptions: Assumption[] = [
    binary ? { assumption: 'enough comparable subgroups', holds: subgroups.length >= min, detail: subgroups.length + ' batches, ' + min + ' asked' }
      : { assumption: 'enough comparable runs', holds: runs.length >= min, detail: runs.length + ' runs, ' + min + ' asked' },
    ...(binary ? [{ assumption: 'subgroups of a defined size', holds: subgroups.every((g) => g.runs.length >= 2), detail: 'runs per batch: ' + subgroups.map((g) => g.runs.length).join(', ') }] : []),
    { assumption: 'independence between runs', holds: independent, detail: 'distinct seeds within each batch; no member of a team sharing a board; no branch of another run' }
  ];
  const k = runs.reduce((a, r) => a + (r.value ?? 0), 0), n = runs.length;
  const pbar = n ? k / n : 0;
  if (binary) assumptions.push({ assumption: 'the normal approximation of a chart of proportions', holds: subgroups.every((g) => g.runs.length * pbar >= 5 && g.runs.length * (1 - pbar) >= 5),
    detail: 'n·p and n·(1-p) at least 5 in every batch (p = ' + r4(pbar) + ')' });
  assumptions.push({ assumption: 'a stable probability', holds: 'assumed', detail: 'it is what the chart examines: its signals are where it may not hold' });
  const met = assumptions.every((a) => a.holds !== false);
  const base = { group: key, metric, assumptions };
  if (!met) return { ...base, chart: null, reading: 'its assumptions are not met: what is said of it is the description of §6.2, no chart' };
  const signals: Signal[] = [];
  const reading = 'an indication of a special cause, to investigate - not a diagnosis';
  const side = (xs: { at: string; above: boolean | null }[]) => {
    let run = 0, last: boolean | null = null;
    for (const x of xs) {
      if (x.above === null) { run = 0; last = null; continue; }
      run = x.above === last ? run + 1 : 1; last = x.above;
      if (run === 8) signals.push({ at: x.at, rule: 'eight in a row on one side of the centre', reading });
    }
  };
  if (binary) {
    const points = subgroups.map((g) => {
      const ni = g.runs.filter((r) => typeof r.value === 'number').length, pi = ni ? g.runs.reduce((a, r) => a + (r.value ?? 0), 0) / ni : 0;
      const sigma = Math.sqrt(pbar * (1 - pbar) / Math.max(1, ni));
      return { batch: g.batch, n: ni, p: r4(pi), lower: r4(Math.max(0, pbar - 3 * sigma)), upper: r4(Math.min(1, pbar + 3 * sigma)) };
    });
    for (const p of points) if (p.p > p.upper || p.p < p.lower) signals.push({ at: p.batch, rule: 'beyond a limit (3 sigma)', reading });
    side(points.map((p) => ({ at: p.batch, above: p.p === pbar ? null : p.p > pbar })));
    return { ...base, chart: { kind: 'p chart', centre: r4(pbar), points }, signals, reading: signals.length ? 'indications of special causes, to investigate' : 'no indication of a special cause by these rules' };
  }
  const xs = runs.map((r) => r.value as number);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const mrs = xs.slice(1).map((x, i) => Math.abs(x - xs[i]));
  const mrbar = mrs.length ? mrs.reduce((a, b) => a + b, 0) / mrs.length : 0;
  const upper = mean + 2.66 * mrbar, lower = mean - 2.66 * mrbar;
  const points = runs.map((r) => ({ batch: r.batch, run: path.basename(r.journal, '.json'), x: r4(r.value as number) }));
  for (const p of points) if (p.x > upper || p.x < lower) signals.push({ at: p.batch + '/' + p.run, rule: 'beyond a limit (individuals, 2.66 moving ranges)', reading });
  side(points.map((p) => ({ at: p.batch + '/' + p.run, above: p.x === mean ? null : p.x > mean })));
  return { ...base, chart: { kind: 'individuals and moving range chart', centre: r4(mean), lower: r4(lower), upper: r4(upper), moving_range: r4(mrbar), points }, signals,
    reading: signals.length ? 'indications of special causes, to investigate' : 'no indication of a special cause by these rules' };
}
