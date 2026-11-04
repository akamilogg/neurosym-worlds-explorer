import fs from 'node:fs';
import path from 'node:path';
import { appendRecord } from './jsonl.ts';
import { normalizePackage, type JuniorPackage } from './package.ts';
import type { CompetenceManifest } from './competence.ts';

/* ============================================================================
 * A SEARCH OF JUNIORS AS THE OPERATOR'S BRANCH (SPEC-EDICION-PESOS §6.6, WE5): the operator launches a weight search with
 * a fund of its own, apart from the researcher's bags; when it ends, the researcher's world makes its elites versions and
 * tells them as a delegated contribution (never an order, never an answer of the world).
 *
 * It keeps the lifecycle every delegated branch has (SPEC-DELEGACION-INVESTIGACIONES), so the operator reads it as any:
 *
 *   <id>.json            its record: the request, and an event per transition (search_started, search_finished, end)
 *   <id>.status.json     its heartbeat and its process, what it has spent so far
 *   <id>.inbox.jsonl     a stop: obeyed before the next candidate
 *   <id>.finding.json    what it found: its elites (genome, niche, deficits, the set that composes them), its cost, why it stopped
 *   <id>.search.jsonl    the search's record (weight-search@1): resumed from it, nothing measured or charged twice
 *   <id>.jobs.jsonl      its own ledger: its fund's bags (edits, evaluations), never the researcher's
 *
 * Its world is an instance of the junior's world of its own (its folder, its ledger), on the same blobs and the same
 * junior server - the one queue of the inference GPU.
 * ========================================================================== */

export interface WeightBranchSpec {
  readonly format: 'weight-search-branch@1';
  readonly id: string;
  readonly question: string;
  /** The researcher's version it starts from (its id in the researcher's world) and that version's package, exported. */
  readonly from: string;
  readonly start: string;
  /** The manifest of the condition, its reference junior's package (the world's base), the blobs and the junior's server. */
  readonly manifest: string;
  readonly reference: string;
  readonly blobs: string;
  readonly server: string;
  /** The seeds, as edits of the act evolve: each with its competence, why and expect. */
  readonly seeds: readonly Record<string, unknown>[];
  readonly control_seeds: number;
  readonly max_candidates: number;
  readonly operators?: Readonly<Record<string, number>>;
  readonly seed?: number;
  /** Its fund: what it may spend, apart from the researcher's bags. */
  readonly fund: { readonly edits: number; readonly evaluations: number };
}

export function branchProblems(raw: unknown): string[] {
  const s = raw as WeightBranchSpec;
  if (!s || s.format !== 'weight-search-branch@1') return ['"format": "weight-search-branch@1"'];
  const p: string[] = [];
  if (typeof s.id !== 'string' || !/^[\w.-]+$/.test(s.id)) p.push('"id": letters, digits, dots and dashes');
  for (const k of ['question', 'from', 'start', 'manifest', 'reference', 'blobs', 'server'] as const) if (typeof s[k] !== 'string' || !s[k]) p.push('"' + k + '"');
  if (!Array.isArray(s.seeds) || !s.seeds.length) p.push('"seeds": the edits it starts from');
  if (!Number.isInteger(s.control_seeds) || s.control_seeds < 1) p.push('"control_seeds": at least 1 (E6)');
  if (!Number.isInteger(s.max_candidates) || s.max_candidates < 0) p.push('"max_candidates"');
  if (!s.fund || !(Number.isInteger(s.fund.edits) && s.fund.edits > 0) || !(Number.isInteger(s.fund.evaluations) && s.fund.evaluations > 0)) p.push('"fund": {"edits", "evaluations"}, whole numbers above 0');
  return p;
}

type J = Record<string, any>;
const readJson = (f: string): J | null => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

/** Runs the branch in `dir`, or resumes it: a branch ended is never run again; one stopped is resumed from its search's
    record. `probes` is a stand-in of the selection probes, for the harness's tests. */
export async function runWeightBranch(specFile: string, dir: string, o: { probes?: (pkg: JuniorPackage) => Promise<{ complete: boolean; components: { id: string; quality: number | null }[] }>; heartbeatMs?: number } = {}): Promise<J> {
  const spec = JSON.parse(fs.readFileSync(specFile, 'utf8')) as WeightBranchSpec;
  const problems = branchProblems(spec);
  if (problems.length) throw new Error('the branch: ' + problems.join('; '));
  fs.mkdirSync(dir, { recursive: true });
  const f = (ext: string) => path.join(dir, spec.id + ext);
  const record = readJson(f('.json')) ?? { format: 'weight-search-branch-record@1', request: spec, events: [] as J[] };
  if (record.events.some((e: J) => e.type === 'end')) return readJson(f('.finding.json')) ?? {};
  const event = (e: J) => { record.events.push({ ...e, at: new Date().toISOString() }); fs.writeFileSync(f('.json'), JSON.stringify(record, null, 2)); };
  const { JuniorWorld } = await import('../worlds/junior/lab.ts');
  const manifest = JSON.parse(fs.readFileSync(spec.manifest, 'utf8')) as CompetenceManifest;
  const start = normalizePackage(JSON.parse(fs.readFileSync(spec.start, 'utf8')));
  /* Its world: its own folder and ledger (its fund), the same blobs and server. Its base is the manifest's reference
     junior (what a world of the condition is made from); the search starts from the branch's start package. */
  const base = normalizePackage(JSON.parse(fs.readFileSync(spec.reference, 'utf8')));
  const world = new JuniorWorld({ manifest, base, blobs: spec.blobs, server: spec.server, dir: path.join(dir, spec.id + '.world'), evaluations: spec.fund.evaluations, edits: spec.fund.edits,
    ...(o.probes ? { probes: o.probes } : {}) });
  const stop = new AbortController();
  const status = (phase: string) => fs.writeFileSync(f('.status.json'), JSON.stringify({ pid: process.pid, phase, at: new Date().toISOString(), spent: world.jobs.bags() }, null, 2));
  const inbox = () => { if (fs.existsSync(f('.inbox.jsonl')) && fs.readFileSync(f('.inbox.jsonl'), 'utf8').split('\n').some((l) => { try { return JSON.parse(l).stop === true; } catch { return false; } })) stop.abort(); };
  const beat = setInterval(() => { inbox(); status('search'); }, o.heartbeatMs ?? 5000);
  try {
    if (!record.events.some((e: J) => e.type === 'search_started')) event({ type: 'search_started' });
    status('search');
    inbox();
    const W = await import('../worlds/junior/lab.ts');
    const seeds = spec.seeds.map((s) => W.editOfSeed(s)).filter((x): x is NonNullable<typeof x> => x !== null);
    if (seeds.length !== spec.seeds.length) throw new Error('a seed is not one edit (written, construct or program) with its competence and why');
    const ids: string[] = [];
    for (const s of seeds) {
      const made = await world.makeEdit(start, s.edit, s.hypothesis);
      if ('problems' in made) throw new Error('a seed: ' + made.problems.join('; '));
      ids.push(made.id);
    }
    const S = await import('./weight-search.ts');
    const auth = manifest.weight_search;
    if (!auth) throw new Error('the condition authorizes no search: its manifest has no "weight_search"');
    const config = { format: S.WEIGHT_SEARCH, seed: spec.seed ?? 1, control_seeds: spec.control_seeds, max_candidates: Math.min(spec.max_candidates, auth.max_candidates),
      operators: Object.fromEntries(Object.entries(spec.operators ?? auth.operators).filter(([k]) => k !== 'refine')), tolerance: auth.tolerance, layer_groups: auth.layer_groups,
      perturb: auth.perturb, investigate_elites: auth.investigate_elites } as const;
    const r = await S.runWeightSearch({ config, start, seeds: ids, store: world.blobs, components: world.probeComponents(), evaluator: world.searchEvaluator(start), out: f('.search.jsonl'), signal: stop.signal });
    event({ type: 'search_finished', stoppedBy: r.stoppedBy });
    const { composeVersion } = await import('./weights.ts');
    const elites = [];
    for (const c of r.elites) {
      if (!c.genome.length) continue;
      const v = composeVersion({ store: world.blobs, parent: start, add: c.genome, authorized: manifest.weight_edits, reason: 'an elite of branch ' + spec.id });
      if ('problems' in v) continue;
      elites.push({ niche: c.niche, genome: c.genome, deficits: c.deficits, origin: c.origin,
        record: { adapter: v.adapter, start: v.set.start, genome: v.set.genome, totals: v.set.totals, branch: spec.id, niche: c.niche, origin: c.origin } });
    }
    const counts: Record<string, number> = {};
    for (const c of r.candidates) counts[c.state ?? 'unevaluated'] = (counts[c.state ?? 'unevaluated'] ?? 0) + 1;
    const bags = world.jobs.bags();
    const finding = { format: 'weight-search-finding@1', id: spec.id, from: spec.from, question: spec.question, stoppedBy: r.stoppedBy, counts, elites,
      cost: { edits: bags.edits.spent, evaluations: bags.evaluations.spent, uncertain: { edits: bags.edits.uncertain, evaluations: bags.evaluations.uncertain } } };
    fs.writeFileSync(f('.finding.json'), JSON.stringify(finding, null, 2));
    event({ type: 'end', stoppedBy: r.stoppedBy, elites: elites.length });
    status('ended');
    appendRecord(path.join(dir, 'branches.jsonl'), { id: spec.id, ended: true, elites: elites.length });
    return finding;
  } catch (e) {
    event({ type: 'failed', why: String((e as Error).message ?? e) });
    status('failed');
    throw e;
  } finally { clearInterval(beat); }
}
