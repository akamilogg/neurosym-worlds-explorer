import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LABS } from '../worlds/labs.ts';
import { worldOptionsIn } from '../orchestra/reader.ts';
import { spread, type BatchReport } from '../orchestra/batch.ts';

/* ============================================================================
 * THE CHARACTERIZATION OF A GENERATING CONFIGURATION (SPEC-RIESGO-MODELOS §8.2, M5): what a configuration of the harness
 * and its LLM produces, measured over the runs of batches - an internal control of the process, never evidence about any one
 * model it produced (R8: a model is evaluated frozen, on its own; this speaks of the generator).
 *
 *   lab model characterize <batch.json> [<batch.json> ...]
 *       runs/models/generators/<provider>-<model>-<config>.json: per configuration, per population (world and code
 *       version), its rates - predictive acceptance of the model and of the artifact, discriminating evidence - each with
 *       its 95% interval (Wilson), its cost, its failure modes, and the batches it was measured on. Measured again, a new
 *       characterization is added; the earlier ones stay.
 * ========================================================================== */

type J = Record<string, any>;
const readJson = (file: string): J | null => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

/** A proportion with its 95% interval (Wilson's score interval: sound with few runs, and with none or all of them). */
export function rate(k: number, n: number): { k: number; n: number; rate: number | null; interval95: [number, number] | null } {
  if (!n) return { k, n, rate: null, interval95: null };
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const centre = (p + z * z / (2 * n)) / d, half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return { k, n, rate: r(p), interval95: [r(Math.max(0, centre - half)), r(Math.min(1, centre + half))] };
}

/** What makes a configuration that generates models: its LLM and how it is tuned, the Judge, the researcher, its agents and
    their models, and the harness's settings - never the world it ran on (its seed, its options): that is its population. */
export function generatorOf(journal: J, folder: string, base: string): { id: string; file: string; configuration: J } {
  const config = { ...(journal.config ?? {}) } as J;
  const lab = Object.values(LABS).find((l) => l.id === journal.experiment);
  const world = new Set(['seed', ...(lab ? Object.keys(worldOptionsIn(lab.options, config)) : [])]);
  const harness = Object.fromEntries(Object.entries(config).filter(([k]) => !world.has(k) && !/^(llm_|jev_)/.test(k)).sort(([a], [b]) => a.localeCompare(b)));
  const agents = fs.existsSync(folder) ? fs.readdirSync(folder).filter((f) => f.startsWith(base + '.agent-') && f.endsWith('.json')).map((f) => readJson(path.join(folder, f)))
    .filter(Boolean).map((a) => ({ role: a!.role, model: a!.llm_config?.model ?? null, provider: a!.llm_provider ?? null })).sort((a, b) => String(a.role).localeCompare(String(b.role))) : [];
  const configuration = { llm_model: config.llm_model ?? null, llm_provider: config.llm_provider ?? null, llm_tuning: config.llm_tuning ?? null,
    jev_model: config.jev_model ?? null, researcher: journal.researcher ?? null, agents, harness };
  const hash = createHash('sha256').update(JSON.stringify(configuration)).digest('hex').slice(0, 10);
  const clean = (s: unknown) => String(s ?? 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 40);
  return { id: hash, file: clean(config.llm_provider) + '-' + clean(config.llm_model) + '-' + hash + '.json', configuration };
}

const FAILURES: Record<string, (end: J) => boolean> = {
  llm_error: (e) => e.stoppedBy === 'llm_error',
  diverged: (e) => e.stoppedBy === 'diverged',
  budget_spent: (e) => ['budget', 'token_budget', 'time_budget'].includes(e.stoppedBy),
  cancelled: (e) => e.stoppedBy === 'cancelled'
};

/** Characterizes the configurations of the runs of some batches, and writes each (added to what it had). */
export function characterize(root: string, batchFiles: readonly string[]): { file: string; id: string; runs: number }[] {
  type Row = { batch: string; journal: string; experiment: string; commit: string | null; end: J; finding: J; agentsJunior: J[] };
  const groups = new Map<string, { gen: ReturnType<typeof generatorOf>; rows: Row[] }>();
  for (const bf of batchFiles) {
    const report = readJson(bf) as BatchReport | null;
    if (!report || report.format !== 'batch@1') throw new Error(bf + ' is not a batch report (batch.json)');
    for (const r of report.runs) {
      if (!r.journal || !fs.existsSync(r.journal)) continue;
      const journal = readJson(r.journal);
      if (!journal) continue;
      const end = [...(journal.events ?? [])].reverse().find((e: J) => e.type === 'end') ?? {};
      const base = path.basename(r.journal, '.json');
      const gen = generatorOf(journal, path.dirname(r.journal), base);
      const finding = readJson(r.journal.replace(/\.json$/, '.finding.json')) ?? {};
      const g = groups.get(gen.id) ?? { gen, rows: [] };
      g.rows.push({ batch: report.id, journal: path.relative(root, r.journal).split(path.sep).join('/'), experiment: String(journal.experiment), commit: journal.commit ?? null, end, finding, agentsJunior: [] });
      groups.set(gen.id, g);
    }
  }
  const out: { file: string; id: string; runs: number }[] = [];
  const dir = path.join(root, 'runs', 'models', 'generators');
  fs.mkdirSync(dir, { recursive: true });
  for (const { gen, rows } of groups.values()) {
    /* A population: the world, and the version of the code it ran on (criteria are not declared per run yet). */
    const populations = [...new Set(rows.map((r) => r.experiment + '|' + (r.commit ?? 'unknown')))].map((key) => {
      const rs = rows.filter((r) => r.experiment + '|' + (r.commit ?? 'unknown') === key);
      const withArtifact = rs.filter((r) => r.finding.artifact);
      const discriminating = rs.filter((r) => (r.finding.own_tests?.severe ?? 0) > 0 && (r.finding.own_tests?.counterexamples?.found ?? 0) <= (r.finding.own_tests?.counterexamples?.closed ?? 0));
      return {
        world: rs[0].experiment, code_version: rs[0].commit,
        runs: rs.length,
        predictive_acceptance_of_the_model: rate(rs.filter((r) => r.finding.outcome?.status === 'accepted').length, rs.length),
        ...(withArtifact.length ? { predictive_acceptance_of_the_artifact: rate(withArtifact.filter((r) => r.finding.artifact.status === 'accepted').length, withArtifact.length) } : {}),
        discriminating_evidence: { ...rate(discriminating.length, rs.length), meaning: 'severe tests of its own, and no counterexample left open' },
        adequacy_to_a_use: 'no use and no criteria declared for these runs',
        cost: { tokens_total: spread(rs.map((r) => Number(r.finding.cost?.total?.llm_tokens) || null)), llm_calls: spread(rs.map((r) => Number(r.finding.cost?.total?.llm_calls) || null)) },
        failure_modes: Object.fromEntries(Object.entries(FAILURES).map(([k, f]) => [k, rate(rs.filter((r) => f(r.end)).length, rs.length)])),
        insubordination: 'not measured',
        runs_measured: rs.map((r) => r.journal)
      };
    });
    const file = path.join(dir, gen.file);
    const before = readJson(file);
    const characterization = { measured: new Date().toISOString(), from_batches: [...new Set(rows.map((r) => r.batch))], populations,
      known_limits: populations.flatMap((p) => Object.entries(p.failure_modes).filter(([, v]) => (v as { k: number }).k > 0).map(([k, v]) => p.world + ': ' + k + ' in ' + (v as { k: number; n: number }).k + ' of ' + (v as { n: number }).n + ' runs')),
      alternative: 'none characterized' };
    fs.writeFileSync(file, JSON.stringify({ format: 'generator_characterization@1', id: gen.id, configuration: gen.configuration,
      reading: 'an internal control of the process that generates models: never evidence about any one of them (R8)',
      characterizations: [...(before?.characterizations ?? []), characterization] }, null, 2));
    out.push({ file, id: gen.id, runs: rows.length });
  }
  return out;
}
