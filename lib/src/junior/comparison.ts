import fs from 'node:fs';
import path from 'node:path';
import { measure, promote, type CompetenceManifest } from './competence.ts';
import type { Evaluation } from './evaluate.ts';
import { compareImprovements, productOf, type Improvement } from './learning-policy.ts';
import { readSummaries } from './confirm.ts';
import { executionHash, normalizePackage, type JuniorPackage } from './package.ts';
import { archiveOf, controlOf, runWeightSearch, type WeightSearchConfig } from './weight-search.ts';
import { baseReader, compose, composeVersion, readEdit, readEditSet, readSafetensors } from './weights.ts';

/* ============================================================================
 * THE COMPARISON THAT TELLS WHETHER IT SERVES (SPEC-EDICION-PESOS §8, WE6): six conditions fixed before they start, from
 * the same start and with the same total budget, launched by the operator:
 *
 *   A  no change of weights (prompt, memory, decoding)           a researcher's run: no edit, no lab, no training
 *   B  the strong model's edits one by one                       a researcher's run: edit and the lab, no search
 *   C  random control edits of the same composed size (E6)       the operator's step after B: each of B's edits replaced
 *                                                                by a control of its size, the same lineage, no researcher
 *   D  a search seeded by the strong model                       a researcher's run: edit, the lab and evolve
 *   E  a search with random seeds and code operators only        the operator's step after D: D's first search again, its
 *                                                                seeds only the size of controls
 *   F  distillation and LoRA (MA4, MA5)                          a researcher's run: distill, dataset, train; no edit
 *
 * Every condition is measured under the same competence manifest (they differ in what the run may do, never in what it is
 * measured by). Its product is the last junior promoted against the reference (a researcher's run: its artifact protocol;
 * C and E: the same rule applied to their candidates in their order), compared case by case. The report reads:
 *
 *   H1   B against C and D against E, pair by pair (paired-cases@1): do the strong model's hypotheses beat chance?
 *   H2   for each condition, of the runs whose product improves a probe component (rungs 1-4), how many also improve a
 *        world (rung 6) - on development, and in the operator's external confirmations when there are any
 *   cost what each condition spent, bag by bag
 *   diversity  the niches its searches occupied, and how many of their elites owe material to perturb or reinit
 * ========================================================================== */

export const CONDITIONS = ['A', 'B', 'C', 'D', 'E', 'F'] as const;
/** How a rule's product was chosen: promoted on development (C's twins), on the holdout (a search's candidates), or the
    best of N in selection (a search's candidates without a holdout: never called promoted). */
export type Rule = 'development' | 'holdout' | 'best of N in selection';
export type Condition = typeof CONDITIONS[number];

export interface WeightComparison {
  readonly format: 'weight-comparison@1';
  readonly id: string;
  /** The condition's competence manifest, the reference junior's package, the blobs and the junior's server. */
  readonly competence: string;
  readonly reference: string;
  readonly blobs: string;
  readonly server: string;
  /** Where every condition's runs and worlds are kept: <work>/<condition>-<rep>/. */
  readonly work: string;
  readonly repetitions: number;
  readonly seed: number;
  /** The same for every condition: what each may spend of each bag (a condition that cannot use a bag leaves it). */
  readonly budget: { readonly evaluations: number; readonly edits: number; readonly lab_queries: number; readonly lab_tokens: number; readonly searches: number;
    readonly distillations: number; readonly gpu_hours: number };
  readonly conditions?: readonly Condition[];
  /** The researcher's own arguments (its model, its tokens and rounds): the same for every researcher's run. */
  readonly researcher: readonly string[];
  /** F's trainer. */
  readonly training?: { readonly python: string; readonly backend: 'fake' | 'qwenputer' };
  /** Where the operator puts its external confirmations' summaries (MA6), read by the report. */
  readonly confirmations?: string;
}

export function comparisonProblems(raw: unknown): string[] {
  const m = raw as WeightComparison;
  if (!m || m.format !== 'weight-comparison@1') return ['"format": "weight-comparison@1"'];
  const p: string[] = [];
  if (typeof m.id !== 'string' || !/^[\w.-]+$/.test(m.id)) p.push('"id": letters, digits, dots and dashes');
  for (const k of ['competence', 'reference', 'blobs', 'server', 'work'] as const) if (typeof m[k] !== 'string' || !m[k]) p.push('"' + k + '"');
  if (!Number.isInteger(m.repetitions) || m.repetitions < 1) p.push('"repetitions": at least 1');
  if (!Number.isInteger(m.seed)) p.push('"seed"');
  const b = m.budget as Record<string, number> | undefined;
  for (const k of ['evaluations', 'edits', 'lab_queries', 'lab_tokens', 'searches', 'distillations', 'gpu_hours']) if (!b || !(typeof b[k] === 'number' && b[k] >= 0)) p.push('"budget.' + k + '": a number >= 0');
  const conds = m.conditions ?? CONDITIONS;
  if (!Array.isArray(conds) || conds.some((c) => !(CONDITIONS as readonly string[]).includes(c))) p.push('"conditions": among A-F');
  if (conds.includes('C') && !conds.includes('B')) p.push('C is made from B\'s edits: B must run too');
  if (conds.includes('E') && !conds.includes('D')) p.push('E is made from D\'s seeds: D must run too');
  if (conds.includes('F') && !m.training) p.push('F trains: "training": {"python", "backend"}');
  if (!Array.isArray(m.researcher)) p.push('"researcher": the researcher\'s arguments, the same for every run');
  return p;
}

export interface PlannedRun {
  readonly condition: Condition;
  readonly rep: number;
  /** A researcher's run (lab start junior <args>), or a step of the operator after the run it is made from. */
  readonly kind: 'run' | 'control-edits' | 'control-search';
  readonly work: string;
  readonly journal?: string;
  readonly args?: readonly string[];
  readonly after?: { readonly condition: Condition; readonly rep: number };
}

const dirOf = (m: WeightComparison, c: Condition, rep: number) => path.join(m.work, c + '-' + rep);

/** The runs of the comparison, each condition's arguments from the one budget: what differs is only what it may do. */
export function planComparison(m: WeightComparison): PlannedRun[] {
  const problems = comparisonProblems(m);
  if (problems.length) throw new Error('the comparison: ' + problems.join('; '));
  const b = m.budget;
  const common = (c: Condition, rep: number) => ['--manifest', m.competence, '--package', m.reference, '--blobs', m.blobs, '--server', m.server, '--work', path.join(dirOf(m, c, rep), 'world'),
    '--seed', String(m.seed + rep), '--out', path.join(dirOf(m, c, rep), 'journal.json'), '--evaluations', String(b.evaluations)];
  const none = ['--edits', '0', '--lab-queries', '0', '--searches', '0', '--distillations', '0', '--gpu-hours', '0'];
  const weights = (searches: number) => ['--edits', String(b.edits), '--lab-queries', String(b.lab_queries), '--lab-tokens', String(b.lab_tokens), '--searches', String(searches), '--distillations', '0', '--gpu-hours', '0'];
  const args: Partial<Record<Condition, (rep: number) => string[]>> = {
    A: (rep) => [...common('A', rep), ...none],
    B: (rep) => [...common('B', rep), ...weights(0)],
    D: (rep) => [...common('D', rep), ...weights(b.searches)],
    F: (rep) => [...common('F', rep), '--edits', '0', '--lab-queries', '0', '--searches', '0', '--distillations', String(b.distillations), '--gpu-hours', String(b.gpu_hours),
      '--train-python', m.training!.python, '--train-backend', m.training!.backend]
  };
  const out: PlannedRun[] = [];
  for (let rep = 0; rep < m.repetitions; rep++) for (const c of m.conditions ?? CONDITIONS) {
    const work = dirOf(m, c, rep);
    if (c === 'C') out.push({ condition: c, rep, kind: 'control-edits', work, after: { condition: 'B', rep } });
    else if (c === 'E') out.push({ condition: c, rep, kind: 'control-search', work, after: { condition: 'D', rep } });
    else out.push({ condition: c, rep, kind: 'run', work, journal: path.join(work, 'journal.json'), args: [...args[c]!(rep), ...m.researcher] });
  }
  return out;
}

/* --- C and E: the operator's steps, from the runs they are made from -------------------------------------------------------- */

type World = import('../worlds/junior/lab.ts').JuniorWorld;
export interface StepDeps {
  /** The world a step works in (its own folder and ledger, the comparison's budget). */
  readonly world: (dir: string) => World | Promise<World>;
  /** A junior evaluated on development (the world's own, unless replaced for the harness's tests). */
  readonly evaluate?: (world: World, pkg: JuniorPackage) => Promise<Evaluation | string>;
}

const readJsonl = (f: string): Record<string, any>[] => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : []);

/** The promotion rule of a condition without a researcher: its candidates in order, each evaluated and compared with the
    reference (paired-cases@1); the product the last one promoted, or the reference. Each candidate's package kept in
    <work>/packages/<execution>.json: what the operator exports for its external confirmation. */
async function productByRule(world: World, work: string, candidates: readonly JuniorPackage[], deps: StepDeps, fromSearch = false): Promise<{ product: string; evaluation: Evaluation | null; package: string; checked: { candidate: string; verdict: string }[]; rule: Rule }> {
  const ev = deps.evaluate ?? ((w: World, p: JuniorPackage) => w.evaluatePackage(p));
  const { promoteEvaluations, promoteOnHoldout } = await import('./evaluate.ts');
  /* Candidates that came out of a search were selected on the probes: promoted only on the holdout the search never saw;
     without one the rule's product is the best of N in selection, and is called so - never promoted (SPEC-VALIDEZ-MEDIDA §4.3). */
  const rule: Rule = !fromSearch ? 'development' : world.manifest.holdout?.length ? 'holdout' : 'best of N in selection';
  const keep = (p: JuniorPackage) => { const f = path.join(work, 'packages', executionHash(p) + '.json'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(p, null, 2)); return f; };
  const ref = await ev(world, world.base);
  let product = executionHash(world.base), evaluation: Evaluation | null = typeof ref === 'string' ? null : ref, pkgFile = keep(world.base);
  const checked: { candidate: string; verdict: string }[] = [];
  if (typeof ref === 'string') return { product, evaluation: null, package: pkgFile, checked, rule };
  for (const p of candidates) {
    const id = executionHash(p);
    const e = await ev(world, p);
    if (typeof e === 'string') { checked.push({ candidate: id, verdict: 'not evaluated: ' + e }); if (/bags cannot hold/.test(e)) break; continue; }
    const v = rule === 'holdout' ? promoteOnHoldout(world.manifest, world.manifestHash, ref, e)! : promoteEvaluations(world.manifest, world.manifestHash, ref, e);
    checked.push({ candidate: id, verdict: rule === 'best of N in selection' && v.verdict === 'promoted' ? 'best of N in selection' : v.verdict });
    if (v.verdict === 'promoted') { product = id; evaluation = e; pkgFile = keep(p); }
  }
  return { product, evaluation, package: pkgFile, checked, rule };
}

/** C: each of B's edited versions has a twin made from ITS IMMEDIATE PARENT - the package B edited, its prompt, memory and
    decoding exactly as they were then (changes made between B's edits included), its adapter taken away so the whole
    genome composes from the immutable checkpoint - only the intervention on weights replaced: its genome the controls of
    B's genome - each control random, in the edit's modules, of its rank or
    count - scaled module by module so that the twin's COMPOSED relative norm is B's (edits of B that cancel or reinforce
    each other are matched as they compose), verified by composing it again. Checked in B's order by the rule. Its result
    kept in <work>/result.json; asked again, read from there. */
export async function runControlEdits(m: WeightComparison, rep: number, deps: StepDeps): Promise<Improvement & { checked: unknown; skipped: unknown }> {
  const work = dirOf(m, 'C', rep), result = path.join(work, 'result.json');
  if (fs.existsSync(result)) return JSON.parse(fs.readFileSync(result, 'utf8'));
  fs.mkdirSync(work, { recursive: true });
  const bWorld = path.join(dirOf(m, 'B', rep), 'world');
  const fromB = readJsonl(path.join(bWorld, 'edits.jsonl'));
  const world = await deps.world(path.join(work, 'world'));
  const { scaleModules } = await import('./weight-search.ts');
  const twins: JuniorPackage[] = [];
  const made: { twin_of: string; execution: string; package: string }[] = [];
  const skipped: { version: string; why: string }[] = [];
  const individual = new Map<string, string | null>();
  for (const [i, r] of fromB.entries()) {
    const record = r.record as { adapter: string; start: string; genome: string[] };
    /* The package B edited (packages/<from>.json, kept by B's world when it made the edit): everything but its weights. */
    const parentFile = path.join(bWorld, 'packages', String(r.from) + '.json');
    if (!fs.existsSync(parentFile)) { skipped.push({ version: r.version, why: 'the package it was edited from is not among B\'s' }); continue; }
    const start = normalizePackage({ ...JSON.parse(fs.readFileSync(parentFile, 'utf8')), adapter: null });
    const chip = Number((start.execution.circuit as Record<string, unknown>).chip_layers);
    const base = baseReader(world.blobs, start.base);
    const norms = (id: string) => Object.fromEntries(Object.entries(compose([{ id, edit: readEdit(world.blobs, id), tensors: readEdit(world.blobs, id).modules.map((x) => readSafetensors(world.blobs.get(x.sha256))) }], base).summaries).map(([k, s]) => [k, s.relative_norm]));
    const raw = record.genome.map((id, k) => {
      if (!individual.has(id)) individual.set(id, controlOf(world.blobs, chip, id, m.seed * 104729 + rep * 997 + i * 100 + k, norms(id), norms));
      return individual.get(id)!;
    });
    if (raw.some((g) => g === null)) { skipped.push({ version: r.version, why: 'a control of one of its edits could not be made' }); continue; }
    /* The size that counts is the composed one: B's set as it composes, against the raw twin's, module by module. */
    const target = readEditSet(world.blobs, record.adapter)?.summaries;
    if (!target) { skipped.push({ version: r.version, why: 'B\'s set is not in the store' }); continue; }
    const first = composeVersion({ store: world.blobs, parent: start, add: raw as string[], authorized: world.manifest.weight_edits, reason: 'condition C (raw)' });
    const got = 'problems' in first ? null : first.set.summaries;
    if (!got) { skipped.push({ version: r.version, why: 'its raw twin does not compose: ' + (first as { problems: readonly string[] }).problems.join('; ') }); continue; }
    const factors = Object.fromEntries(Object.keys(target).map((mod) => [mod, got[mod]?.relative_norm > 0 ? target[mod].relative_norm / got[mod].relative_norm : 0]));
    const scaled = (raw as string[]).map((id, k) => scaleModules(world.blobs, chip, id, factors, m.seed * 104729 + rep * 997 + i * 100 + k + 50));
    if (scaled.some((g) => g === null)) { skipped.push({ version: r.version, why: 'its controls could not be scaled' }); continue; }
    const v = composeVersion({ store: world.blobs, parent: start, add: scaled as string[], authorized: world.manifest.weight_edits, reason: 'condition C' });
    if ('problems' in v) { skipped.push({ version: r.version, why: 'its twin does not compose: ' + v.problems.join('; ') }); continue; }
    const off = Object.keys(target).filter((mod) => Math.abs((v.set.summaries[mod]?.relative_norm ?? 0) - target[mod].relative_norm) > 1e-3 * Math.max(1e-3, target[mod].relative_norm));
    if (off.length) { skipped.push({ version: r.version, why: 'its composed size does not match B\'s at ' + off.join(', ') }); continue; }
    /* Paid as any composed candidate. */
    const paid = await world.searchEvaluator(start).compose(scaled as string[]).catch((e: Error) => ({ invalid: e.message }));
    if ('invalid' in paid) { skipped.push({ version: r.version, why: paid.invalid }); continue; }
    twins.push(v.child);
    const twinFile = path.join(work, 'packages', executionHash(v.child) + '.json');
    fs.mkdirSync(path.dirname(twinFile), { recursive: true });
    fs.writeFileSync(twinFile, JSON.stringify(v.child, null, 2));
    made.push({ twin_of: r.version, execution: executionHash(v.child), package: twinFile });
  }
  const rule = await productByRule(world, work, twins, deps);
  const out = { condition: 'C', state: (rule.evaluation ? 'ended' : 'interrupted') as Improvement['state'], product: rule.product, evaluation: rule.evaluation!, cost: spentOf(path.join(work, 'world', 'jobs.jsonl')),
    checked: rule.checked, skipped, twins: made, package: rule.package };
  fs.writeFileSync(result, JSON.stringify(out, null, 2));
  return out;
}

/** E: D's first search again FROM ITS EXACT START (the package its record keeps), its seeds only the size of its controls -
    no strong seed evaluated, nor a parent; its elites checked by the rule in the order of their quality. Kept in
    <work>/result.json. */
export async function runControlSearch(m: WeightComparison, rep: number, deps: StepDeps): Promise<Improvement & { checked: unknown; niches: number }> {
  const work = dirOf(m, 'E', rep), result = path.join(work, 'result.json');
  if (fs.existsSync(result)) return JSON.parse(fs.readFileSync(result, 'utf8'));
  fs.mkdirSync(work, { recursive: true });
  const searches = path.join(dirOf(m, 'D', rep), 'world', 'searches');
  const first = fs.existsSync(searches) ? fs.readdirSync(searches).filter((f) => f.endsWith('.jsonl')).sort().map((f) => readJsonl(path.join(searches, f))).map((ev) => ev.find((e) => e.type === 'search_started')).filter(Boolean)[0] : undefined;
  const world = await deps.world(path.join(work, 'world'));
  if (!first || !first.start_package) {
    const rule = await productByRule(world, work, [], deps);
    const out = { condition: 'E', state: 'interrupted' as const, product: rule.product, evaluation: rule.evaluation!, cost: spentOf(path.join(work, 'world', 'jobs.jsonl')),
      checked: first ? 'D\'s search keeps no start package: E cannot start where it started' : 'D opened no search: E has nothing to mirror', niches: 0, package: rule.package };
    fs.writeFileSync(result, JSON.stringify(out, null, 2));
    return out;
  }
  const start = normalizePackage(first.start_package);
  if (executionHash(start) !== first.start_execution) throw new Error('D\'s search keeps a start package that is not its start');
  const config = first.config as WeightSearchConfig;
  const r = await runWeightSearch({ config, start, seeds: first.seeds, store: world.blobs, components: world.probeComponents(), evaluator: world.searchEvaluator(start), out: path.join(work, 'search.jsonl'), controlsOnly: true });
  const { better } = await import('./weight-search.ts');
  const elites = [...r.elites].filter((c) => c.genome.length).sort((a, b) => better(a, b, world.probeComponents()));
  const candidates: JuniorPackage[] = [];
  for (const c of elites) {
    const v = composeVersion({ store: world.blobs, parent: start, add: c.genome, authorized: world.manifest.weight_edits, reason: 'condition E' });
    if (!('problems' in v)) candidates.push(v.child);
  }
  /* In the order of their quality, the best last: the rule keeps the last promoted, so the best one promoted wins. */
  const rule = await productByRule(world, work, candidates.reverse(), deps, true);
  const out = { condition: 'E', state: (rule.evaluation ? 'ended' : 'interrupted') as Improvement['state'], product: rule.product, evaluation: rule.evaluation!, cost: spentOf(path.join(work, 'world', 'jobs.jsonl')),
    checked: rule.checked, niches: r.elites.length, package: rule.package, rule: rule.rule, candidates: candidates.length };
  fs.writeFileSync(result, JSON.stringify(out, null, 2));
  return out;
}

/** What a world's ledger says was spent, bag by bag (read only: a live ledger is never written by reading it). */
export function spentOf(ledger: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of readJsonl(ledger)) if (l.kind === 'finished' && l.spent) for (const [k, v] of Object.entries(l.spent as Record<string, number>)) out[k] = (out[k] ?? 0) + v;
  return out;
}

/* --- The report ------------------------------------------------------------------------------------------------------------- */

export interface ConditionRun extends Improvement { readonly rep: number }

/** A researcher's run as an Improvement: its product from its journal, the product's evaluation from its world. */
export function improvementOf(m: WeightComparison, manifest: CompetenceManifest, manifestHash: string, c: Condition, rep: number, reference: string): ConditionRun {
  const work = dirOf(m, c, rep);
  const cost = spentOf(path.join(work, 'world', 'jobs.jsonl'));
  if (c === 'C' || c === 'E') {
    const f = path.join(work, 'result.json');
    if (!fs.existsSync(f)) return { condition: c, rep, state: 'interrupted', product: reference, evaluation: null as never, cost };
    return { ...(JSON.parse(fs.readFileSync(f, 'utf8')) as Improvement), rep };
  }
  const journal = path.join(work, 'journal.json');
  if (!fs.existsSync(journal)) return { condition: c, rep, state: 'interrupted', product: reference, evaluation: null as never, cost };
  const { product, state } = productOf(journal, reference);
  const pkgFile = path.join(work, 'world', 'packages', product + '.json');
  const exec = fs.existsSync(pkgFile) ? executionHash(normalizePackage(JSON.parse(fs.readFileSync(pkgFile, 'utf8')))) : null;
  const evFile = exec ? path.join(work, 'world', 'evaluations', manifestHash.slice(0, 16) + '-' + exec.slice(0, 16) + '-development.json') : null;
  const evaluation = evFile && fs.existsSync(evFile) ? JSON.parse(fs.readFileSync(evFile, 'utf8')) as Evaluation : null;
  return { condition: c, rep, state: evaluation ? state : 'interrupted', product, evaluation: evaluation as Evaluation, cost };
}

export interface ComparisonReport {
  readonly format: 'weight-comparison-report@1';
  readonly id: string;
  readonly h1: { readonly B_vs_C: ReturnType<typeof compareImprovements> | null; readonly D_vs_E: ReturnType<typeof compareImprovements> | null };
  readonly h2: Readonly<Record<string, { runs: number; measured: number; probes_improved: number; worlds_improved: number; transferred: number; confirmed: number; confirmed_worlds: number }>>;
  readonly cost: Readonly<Record<string, Record<string, number>>>;
  readonly diversity: Readonly<Record<string, { searches: number; niches: number; from_new_material: number }>>;
  /** C's and E's products, run by run: how the rule chose each - on development, on the holdout, or the best of N in
      selection (E without a holdout: a product never to be read as promoted). */
  readonly rules: Readonly<Record<string, readonly (Rule | null)[]>>;
}

/** The report from what the runs and steps left, without a model: every comparison computed again from the observations. */
export function comparisonReport(m: WeightComparison, o: { manifest: CompetenceManifest; manifestHash: string; reference: string; referenceEvaluation: Evaluation | null; searches?: (c: Condition, rep: number) => Record<string, any>[][] }): ComparisonReport {
  const conds = m.conditions ?? CONDITIONS;
  const runs = new Map<Condition, ConditionRun[]>();
  for (const c of conds) runs.set(c, Array.from({ length: m.repetitions }, (_, rep) => improvementOf(m, o.manifest, o.manifestHash, c, rep, o.reference)));
  const pairs = (refC: Condition, candC: Condition) => (runs.has(refC) && runs.has(candC)
    ? compareImprovements(o.manifest, runs.get(refC)!.map((r, i) => ({ reference: r, candidate: runs.get(candC)![i] }))) : null);
  const rungOf = new Map(o.manifest.components.map((c) => [c.id, c.rung]));
  const summaries = m.confirmations ? readSummaries(m.confirmations) : [];
  const h2: Record<string, ComparisonReport['h2'][string]> = {};
  for (const [c, rs] of runs) {
    const row = { runs: rs.length, measured: 0, probes_improved: 0, worlds_improved: 0, transferred: 0, confirmed: 0, confirmed_worlds: 0 };
    for (const r of rs) {
      if (r.state !== 'ended' || !r.evaluation || !o.referenceEvaluation) continue;
      const ma = measure(o.manifest, 'development', o.referenceEvaluation.temperature, o.referenceEvaluation.observations);
      const mb = measure(o.manifest, 'development', r.evaluation.temperature, r.evaluation.observations);
      if (!ma.complete || !mb.complete) continue;
      row.measured++;
      const p = promote(o.manifest, ma, mb);
      const probes = p.components.some((x) => x.improves && (rungOf.get(x.id) ?? 6) <= 4), worlds = p.components.some((x) => x.improves && rungOf.get(x.id) === 6);
      if (probes) row.probes_improved++;
      if (worlds) row.worlds_improved++;
      if (probes && worlds) row.transferred++;
      const conf = summaries.find((s) => s.candidate === r.evaluation.execution);
      if (conf?.verdict === 'promoted') { row.confirmed++; if (conf.components.some((x) => x.improves && rungOf.get(x.id) === 6)) row.confirmed_worlds++; }
    }
    h2[c] = row;
  }
  const cost: Record<string, Record<string, number>> = {};
  for (const [c, rs] of runs) { const sum: Record<string, number> = {}; for (const r of rs) for (const [k, v] of Object.entries(r.cost)) sum[k] = (sum[k] ?? 0) + v; cost[c] = sum; }
  const diversity: Record<string, { searches: number; niches: number; from_new_material: number }> = {};
  for (const c of conds.filter((x) => x === 'D' || x === 'E')) {
    const row = { searches: 0, niches: 0, from_new_material: 0 };
    for (let rep = 0; rep < m.repetitions; rep++) for (const events of o.searches?.(c, rep) ?? searchesOf(m, c, rep)) {
      const started = events.find((e) => e.type === 'search_started');
      if (!started) continue;
      row.searches++;
      const a = archiveOf(events, started.config, started.components);
      row.niches += a.elites.size;
      for (const e of a.elites.values()) if (owesNewMaterial(e.id, a.candidates)) row.from_new_material++;
    }
    diversity[c] = row;
  }
  const rules: Record<string, (Rule | null)[]> = {};
  for (const c of conds.filter((x) => x === 'C' || x === 'E')) rules[c] = (runs.get(c) ?? []).map((r) => ((r as { rule?: Rule }).rule ?? (c === 'C' ? 'development' : null)));
  return { format: 'weight-comparison-report@1', id: m.id, h1: { B_vs_C: pairs('C', 'B'), D_vs_E: pairs('E', 'D') }, h2, cost, diversity, rules };
}

function searchesOf(m: WeightComparison, c: Condition, rep: number): Record<string, any>[][] {
  if (c === 'E') return [readJsonl(path.join(dirOf(m, 'E', rep), 'search.jsonl'))].filter((x) => x.length);
  const dir = path.join(dirOf(m, c, rep), 'world', 'searches');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().map((f) => readJsonl(path.join(dir, f))) : [];
}

/** Whether a candidate's lineage passes through perturb or reinit: material no seed had. */
function owesNewMaterial(id: string, candidates: ReadonlyMap<string, import('./weight-search.ts').Candidate>): boolean {
  const seen = new Set<string>();
  const walk = (x: string): boolean => {
    if (seen.has(x)) return false;
    seen.add(x);
    const c = candidates.get(x);
    if (!c) return false;
    if (c.origin.operator === 'perturb' || c.origin.operator === 'reinit') return true;
    return (c.origin.parents ?? []).some(walk);
  };
  return walk(id);
}

/** The report as text for the operator. */
export function reportText(r: ComparisonReport): string {
  const h1 = (name: string, x: ReturnType<typeof compareImprovements> | null) => x === null ? '- ' + name + ': not run' : '- ' + name + ': ' + x.improved + ' better, ' + x.worse + ' worse, ' + x.inconclusive + ' inconclusive, ' + x.incomplete + ' incomplete';
  const lines = ['# Comparison ' + r.id, '', '## H1: the strong model against chance', h1('B against C', r.h1.B_vs_C), h1('D against E', r.h1.D_vs_E), '', '## H2: do probe gains reach the worlds?',
    '| condition | runs | measured | probes improved | worlds improved | both | confirmed | confirmed in worlds |', '|---|---|---|---|---|---|---|---|',
    ...Object.entries(r.h2).map(([c, x]) => '| ' + [c, x.runs, x.measured, x.probes_improved, x.worlds_improved, x.transferred, x.confirmed, x.confirmed_worlds].join(' | ') + ' |'),
    '', '## Cost', ...Object.entries(r.cost).map(([c, x]) => '- ' + c + ': ' + (Object.entries(x).map(([k, v]) => k + ' ' + v).join(', ') || 'nothing')),
    '', '## Diversity', ...Object.entries(r.diversity).map(([c, x]) => '- ' + c + ': ' + x.searches + ' searches, ' + x.niches + ' niches, ' + x.from_new_material + ' of their elites from perturb or reinit'),
    '', '## How the rule chose the products of C and E', ...Object.entries(r.rules ?? {}).map(([c, x]) => '- ' + c + ': ' + x.map((k) => k ?? 'not recorded').join(', ')
      + (x.includes('best of N in selection') ? ' (a candidate chosen on the probes it was selected on: not promoted)' : ''))];
  return lines.join('\n') + '\n';
}

export type { JuniorPackage };
