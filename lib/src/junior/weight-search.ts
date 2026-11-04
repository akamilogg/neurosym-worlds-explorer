import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { stableStringify } from '../core/hash.ts';
import { normalizePackage, type BlobStore, type JuniorPackage } from './package.ts';
import {
  baseReader, compose, f32, i64, layerOf, putEdit, readEdit, readSafetensors, seeded, tensorF32, tensorI64,
  type ModuleSummary, type RawTensor, type SetTotals, type WeightEdit
} from './weights.ts';

/* ============================================================================
 * The EVOLUTIONARY SEARCH OF JUNIORS (SPEC-EDICION-PESOS §6, WE4): a genome - an ordered list of weight edits - on a fixed
 * start; its phenotype the version composed by compose@1. Its population starts from the strong model's seeds (distinct
 * hypotheses), random CONTROL seeds of the same modules, rank and composed relative norm (E6: a search without them is
 * refused), and the empty genome (the start). Code operators vary it, deterministic given their seed: scale, drop,
 * combine, retarget, sparsify, and perturb and reinit, which bring material no parent had; refine asks the strong model.
 *
 * Each candidate goes through a CASCADE: bounds and the circuit's validity (else INVALID: kept, never evaluated), the
 * selection probes (an incomplete evaluation leaves it UNMEASURED: no niche, measured later), and, for the elites, whole
 * investigations attached as later evidence. An ARCHIVE by niches keeps the best measured candidate of each niche - its
 * niche from the probes only (which component improves, stays or worsens against the start, within its tolerance) and
 * from where it acts (the layer group and module kind of its largest relative norm); within a niche the worst deficit
 * first decides, then smaller norm, fewer entries changed, the one made earlier. A missing datum never counts as zero.
 *
 * Built on the principles of the evolutionary engine (learn/evolve: stable ids, an event record written before and after
 * each effect, the archive rebuilt from the record without a model, a resumed search charged nothing twice) but not on
 * its policy, which plans file patches asked of an LLM mutator: here most operators are code on tensors.
 * ========================================================================== */

export const WEIGHT_SEARCH = 'weight-search@1';
export const OPERATORS = ['scale', 'drop', 'combine', 'retarget', 'sparsify', 'perturb', 'reinit', 'refine'] as const;
export type Operator = typeof OPERATORS[number];

export interface WeightSearchConfig {
  readonly format: typeof WEIGHT_SEARCH;
  readonly seed: number;
  /** Random control seeds (E6): at least one; built from the strong seeds, cycling over them. */
  readonly control_seeds: number;
  /** Children made by the operators after the seeds. */
  readonly max_candidates: number;
  /** The weight of each operator when one is drawn; an operator absent or at 0 is never used. */
  readonly operators: Readonly<Partial<Record<Operator, number>>>;
  /** The niche: per probe component, how far a deficit may move and still be "the same" as the start's. */
  readonly tolerance: Readonly<Record<string, number>>;
  /** The niche: the layer groups, [from, to] inclusive, fixed before it starts. */
  readonly layer_groups: readonly (readonly [number, number])[];
  /** perturb's noise, as a fraction of the factor's norm. */
  readonly perturb: number;
  /** Whether the elites are investigated whole at the end (evidence that never changes their niche). */
  readonly investigate_elites: boolean;
}

export function searchConfigProblems(raw: unknown, components: readonly string[]): string[] {
  const c = raw as WeightSearchConfig;
  if (!c || c.format !== WEIGHT_SEARCH) return ['"format": "' + WEIGHT_SEARCH + '"'];
  const p: string[] = [];
  if (!Number.isInteger(c.seed)) p.push('"seed": an integer');
  if (!Number.isInteger(c.control_seeds) || c.control_seeds < 1) p.push('"control_seeds": at least 1 - a search without random controls of the same size proves nothing (E6)');
  if (!Number.isInteger(c.max_candidates) || c.max_candidates < 0) p.push('"max_candidates": a whole number');
  if (!c.operators || typeof c.operators !== 'object' || Object.entries(c.operators).some(([k, w]) => !(OPERATORS as readonly string[]).includes(k) || !(typeof w === 'number' && w >= 0)))
    p.push('"operators": weights >= 0 among ' + OPERATORS.join(', '));
  if (!c.tolerance || components.some((k) => !(typeof c.tolerance[k] === 'number' && c.tolerance[k] >= 0))) p.push('"tolerance": a number >= 0 for each probe component (' + components.join(', ') + ')');
  if (!Array.isArray(c.layer_groups) || !c.layer_groups.length || c.layer_groups.some((g) => !Array.isArray(g) || g.length !== 2 || !Number.isInteger(g[0]) || !Number.isInteger(g[1]) || g[1] < g[0]))
    p.push('"layer_groups": [[from, to], ...], fixed before it starts');
  if (!(typeof c.perturb === 'number' && c.perturb > 0 && c.perturb <= 1)) p.push('"perturb": a fraction in (0, 1]');
  if (typeof c.investigate_elites !== 'boolean') p.push('"investigate_elites": true or false');
  return p;
}

/** What the search asks of the world it searches in. Each call charges its own bag (idempotent by what it is asked) and
    throws OutOfBudget when the bag cannot hold it. */
export interface SearchEvaluator {
  /** The genome composed from the start within the bounds: the version, or why it is invalid. Charges `edits`. */
  compose(genome: readonly string[]): Promise<{ pkg: JuniorPackage; summaries: Readonly<Record<string, ModuleSummary>>; totals: SetTotals } | { invalid: string }>;
  valid(pkg: JuniorPackage): Promise<true | string>;
  /** The selection probes: each probe component's deficit, null where it is missing. Charges `evaluations`. */
  probes(pkg: JuniorPackage): Promise<{ complete: boolean; components: readonly { id: string; quality: number | null }[] }>;
  /** Whole investigations, for an elite: evidence only. */
  investigate?(pkg: JuniorPackage): Promise<unknown>;
  /** refine: the strong model reads a candidate and proposes one edit (its id), or none. */
  refine?(o: { genome: readonly string[]; deficits: Readonly<Record<string, number | null>> }): Promise<string | null>;
}

export class OutOfBudget extends Error {
  readonly bag: string;
  constructor(bag: string, message: string) { super(message); this.bag = bag; }
}

export type CandidateState = 'invalid' | 'unmeasured' | 'measured';

export interface Candidate {
  readonly id: string;
  readonly genome: readonly string[];
  readonly origin: { readonly kind: 'start' | 'strong' | 'control' | 'operator'; readonly operator?: Operator; readonly parents?: readonly string[]; readonly seed?: number; readonly step?: number };
  readonly seq: number;
  state?: CandidateState;
  reason?: string;
  deficits?: Readonly<Record<string, number | null>>;
  totals?: SetTotals;
  location?: string;
  niche?: string;
}

const genomeId = (g: readonly string[]): string => createHash('sha256').update(stableStringify(g)).digest('hex').slice(0, 24);

/** Where a composed intervention acts: the layer group and module kind of its largest relative norm ("none" for the start). */
export function locationOf(summaries: Readonly<Record<string, ModuleSummary>> | undefined, groups: WeightSearchConfig['layer_groups']): string {
  const entries = Object.entries(summaries ?? {});
  if (!entries.length) return 'none';
  const [module] = entries.sort((a, b) => b[1].relative_norm - a[1].relative_norm || (a[0] < b[0] ? -1 : 1))[0];
  const layer = layerOf(module) ?? -1;
  const g = groups.findIndex(([lo, hi]) => layer >= lo && layer <= hi);
  return (g < 0 ? 'ungrouped' : 'g' + g) + ':' + module.split('.').pop();
}

/** A measured candidate's niche: per probe component the sign of its change against the start (within its tolerance),
    and where it acts. Null when anything it needs is missing: an unmeasured candidate has no niche. */
export function nicheOf(c: Pick<Candidate, 'deficits' | 'location'>, start: Readonly<Record<string, number | null>>, components: readonly string[], tolerance: Readonly<Record<string, number>>): string | null {
  if (!c.deficits || !c.location) return null;
  const signs: string[] = [];
  for (const k of components) {
    const d = c.deficits[k], s = start[k];
    if (typeof d !== 'number' || typeof s !== 'number') return null;
    signs.push(d < s - tolerance[k] ? '+' : d > s + tolerance[k] ? '-' : '=');
  }
  return signs.join('') + '@' + c.location;
}

/** The rule of quality within a niche (§6.5): the deficits compared from the worst component to the best, lower wins;
    then the smaller composed relative norm, fewer entries changed, the one made earlier. Negative: a is better. */
export function better(a: Candidate, b: Candidate, components: readonly string[]): number {
  const v = (c: Candidate) => components.map((k) => c.deficits![k] as number).sort((x, y) => y - x);
  const va = v(a), vb = v(b);
  for (let i = 0; i < va.length; i++) if (va[i] !== vb[i]) return va[i] - vb[i];
  const na = a.totals?.relative_norm ?? 0, nb = b.totals?.relative_norm ?? 0;
  if (na !== nb) return na - nb;
  const ca = a.totals?.changed ?? 0, cb = b.totals?.changed ?? 0;
  if (ca !== cb) return ca - cb;
  return a.seq - b.seq;
}

/** The archive from the record alone, without a model: every measured candidate's niche computed again from its measures,
    the best of each niche kept. */
export function archiveOf(events: readonly Record<string, any>[], config: Pick<WeightSearchConfig, 'tolerance'>, components: readonly string[]): { start: Record<string, number | null> | null; elites: Map<string, Candidate>; candidates: Map<string, Candidate> } {
  const candidates = new Map<string, Candidate>();
  for (const e of events) {
    if (e.type === 'candidate' && !candidates.has(e.id)) candidates.set(e.id, { id: e.id, genome: e.genome, origin: e.origin, seq: e.seq });
    if (e.type === 'evaluated' && candidates.has(e.id)) Object.assign(candidates.get(e.id)!, { state: e.state, reason: e.reason, deficits: e.deficits, totals: e.totals, location: e.location });
  }
  const startC = [...candidates.values()].find((c) => c.origin.kind === 'start');
  const start = startC?.state === 'measured' ? startC.deficits as Record<string, number | null> : null;
  const elites = new Map<string, Candidate>();
  if (start) for (const c of [...candidates.values()].sort((a, b) => a.seq - b.seq)) {
    if (c.state !== 'measured') continue;
    const n = nicheOf(c, start, components, config.tolerance);
    c.niche = n ?? undefined;
    if (!n) continue;
    const held = elites.get(n);
    if (!held || better(c, held, components) < 0) elites.set(n, c);
  }
  return { start, elites, candidates };
}

/* --- Operators on edits: new edits by their hash, their origin and seed kept ----------------------------------------------- */

interface Loaded { readonly edit: WeightEdit; readonly tensors: Record<string, RawTensor>[] }
const load = (store: BlobStore, id: string): Loaded => { const edit = readEdit(store, id); return { edit, tensors: edit.modules.map((m) => readSafetensors(store.get(m.sha256))) }; };

function gaussian(r: () => number): number {
  const u = Math.max(1e-12, r() + 0.5), v = r() + 0.5;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const norm = (x: Float32Array): number => Math.sqrt(x.reduce((s, v) => s + v * v, 0));

/** A new edit from a parent edit, its tensors transformed module by module, its origin the operator with its seed. */
function derive(store: BlobStore, chip: number, parent: string, op: Operator | 'control', seed: number, f: (m: WeightEdit['modules'][number], t: Record<string, RawTensor>, r: () => number) => { module?: string; tensors: { readonly [k: string]: RawTensor | undefined } } | null, authorship: 'search' | 'control' = 'search'): string | null {
  const p = load(store, parent);
  const r = seeded(seed);
  const modules = [];
  for (let i = 0; i < p.edit.modules.length; i++) {
    const m = p.edit.modules[i];
    const out = f(m, p.tensors[i], r);
    if (!out) return null;
    const tensors = Object.fromEntries(Object.entries(out.tensors).filter((x): x is [string, RawTensor] => x[1] !== undefined));
    modules.push({ module: out.module ?? m.module, encoding: m.encoding, shape: [m.shape[0], m.shape[1]] as [number, number], tensors });
  }
  const made = putEdit(store, { modules, authorship, origin: { kind: 'operator', operator: op, parents: [parent], seed },
    hypothesis: { competence: p.edit.hypothesis.competence, mechanism: op + ' of ' + parent.slice(0, 12) + ': ' + p.edit.hypothesis.mechanism, effect: p.edit.hypothesis.effect } }, chip);
  return 'id' in made ? made.id : null;
}

const scaled = (t: RawTensor, k: number): RawTensor => tensorF32(t.shape, Array.from(f32(t), (x) => x * k));
const random = (shape: readonly number[], r: () => number): RawTensor => tensorF32(shape, Array.from({ length: shape.reduce((a, b) => a * b, 1) }, () => gaussian(r)));
const withNorm = (t: RawTensor, n: number): RawTensor => { const x = f32(t); const m = norm(x); return m > 0 ? scaled(t, n / m) : t; };

export const EDIT_OPERATORS = {
  scale: (store: BlobStore, chip: number, id: string, seed: number) => derive(store, chip, id, 'scale', seed, (m, t, r) => {
    const k = Math.exp(Math.log(0.25) + (r() + 0.5) * (Math.log(2) - Math.log(0.25)));
    return { tensors: m.encoding === 'lowrank' ? { B: scaled(t.B, k), A: t.A } : { indices: t.indices, values: scaled(t.values, k) } };
  }),
  sparsify: (store: BlobStore, chip: number, id: string, seed: number) => derive(store, chip, id, 'sparsify', seed, (m, t) => {
    if (m.encoding !== 'sparse') return null;
    const idx = i64(t.indices), v = f32(t.values);
    if (idx.length < 2) return null;
    const keep = idx.map((x, k) => [x, v[k]] as const).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]) || a[0] - b[0]).slice(0, Math.ceil(idx.length / 2)).sort((a, b) => a[0] - b[0]);
    return { tensors: { indices: tensorI64(keep.map((x) => x[0])), values: tensorF32([keep.length], keep.map((x) => x[1])) } };
  }),
  perturb: (store: BlobStore, chip: number, id: string, seed: number, fraction: number) => derive(store, chip, id, 'perturb', seed, (m, t, r) => {
    if (m.encoding !== 'lowrank') return null;
    const B = f32(t.B), noise = f32(random(t.B.shape, r));
    const k = fraction * norm(B) / (norm(noise) || 1);
    return { tensors: { B: tensorF32(t.B.shape, Array.from(B, (x, i) => x + k * noise[i])), A: t.A } };
  }),
  reinit: (store: BlobStore, chip: number, id: string, seed: number) => derive(store, chip, id, 'reinit', seed, (m, t, r) => {
    if (m.encoding !== 'lowrank') return null;
    return { tensors: { B: withNorm(random(t.B.shape, r), norm(f32(t.B))), A: withNorm(random(t.A.shape, r), norm(f32(t.A))) } };
  }),
  retarget: (store: BlobStore, chip: number, id: string, seed: number, base: ReturnType<typeof baseReader>) => derive(store, chip, id, 'retarget', seed, (m, t, r) => {
    const layer = layerOf(m.module);
    if (layer === null) return null;
    const to = layer + (r() < 0 ? -1 : 1);
    if (to < chip) return null;
    const module = m.module.replace('layers.' + layer + '.', 'layers.' + to + '.');
    try { const s = base(module + '.weight').shape; if (s[0] !== m.shape[0] || s[1] !== m.shape[1]) return null; } catch { return null; }
    return { module, tensors: t };
  })
};

/** A control seed for a strong one (E6): random factors (or entries) in the same modules, of the same rank (or count),
    scaled so each module's composed relative norm is the strong seed's. */
export function controlOf(store: BlobStore, chip: number, strong: string, seed: number, targetNorms: Readonly<Record<string, number>>, measureNorm: (id: string) => Record<string, number>): string | null {
  const first = derive(store, chip, strong, 'control', seed, (m, t, r) => {
    if (m.encoding === 'lowrank') return { tensors: { B: random(t.B.shape, r), A: random(t.A.shape, r) } };
    const n = t.indices.shape[0], total = m.shape[0] * m.shape[1];
    const picked = new Set<number>();
    while (picked.size < Math.min(n, total)) picked.add(Math.floor((r() + 0.5) * total) % total);
    const idx = [...picked].sort((a, b) => a - b);
    return { tensors: { indices: tensorI64(idx), values: random([idx.length], r) } };
  }, 'control');
  if (!first) return null;
  const got = measureNorm(first);
  /* Scaled once to the strong seed's composed relative norm, module by module (linear in the scale). */
  return derive(store, chip, first, 'control', seed + 1, (m, t) => {
    const k = got[m.module] > 0 ? (targetNorms[m.module] ?? 0) / got[m.module] : 0;
    if (!(k > 0) || !Number.isFinite(k)) return null;
    return { tensors: m.encoding === 'lowrank' ? { B: scaled(t.B, k), A: t.A } : { indices: t.indices, values: scaled(t.values, k) } };
  }, 'control');
}

/** Whether the strong seeds are distinct hypotheses: no two alike in their modules and their origin (§6.2). */
export function distinctSeeds(store: BlobStore, ids: readonly string[]): string | null {
  const seen = new Map<string, string>();
  for (const id of ids) {
    const e = readEdit(store, id);
    const sig = stableStringify([e.modules.map((m) => m.module).sort(), e.origin.kind, e.origin.kind === 'constructor' ? e.origin.constructor : null]);
    if (seen.has(sig)) return 'seeds ' + seen.get(sig)!.slice(0, 12) + ' and ' + id.slice(0, 12) + ' are the same hypothesis (the same modules and origin): ask for distinct mechanisms or modules';
    seen.set(sig, id);
  }
  return null;
}

/* --- The search ---------------------------------------------------------------------------------------------------------- */

export interface SearchResult {
  readonly stoppedBy: string;
  readonly candidates: readonly Candidate[];
  readonly elites: readonly Candidate[];
  readonly evidence: Readonly<Record<string, unknown>>;
}

/** A search from a start (a package without an adapter) and the strong model's seeds (edit ids), recorded in `out`: a
    record there is resumed - every candidate it evaluated is served from it, never evaluated or charged again. */
export async function runWeightSearch(o: { config: WeightSearchConfig; start: JuniorPackage; seeds: readonly string[]; store: BlobStore; components: readonly string[]; evaluator: SearchEvaluator; out: string; signal?: AbortSignal }): Promise<SearchResult> {
  const problems = searchConfigProblems(o.config, o.components);
  if (problems.length) throw new Error('the search: ' + problems.join('; '));
  const start = normalizePackage(o.start);
  if (start.adapter !== null) throw new Error('a search starts from a version without an adapter: its genome is composed from it');
  if (!o.seeds.length) throw new Error('a search needs the strong model\'s seeds');
  const distinct = distinctSeeds(o.store, o.seeds);
  if (distinct) throw new Error(distinct);
  const chip = Number((start.execution.circuit as Record<string, unknown>).chip_layers);
  const base = baseReader(o.store, start.base);

  const recorded: Record<string, any>[] = fs.existsSync(o.out) ? fs.readFileSync(o.out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const served = new Map<string, Record<string, any>>(recorded.filter((e) => e.type === 'evaluated').map((e) => [e.id, e]));
  const events: Record<string, any>[] = [];
  fs.writeFileSync(o.out, '');
  const log = (e: Record<string, any>) => { events.push(e); fs.appendFileSync(o.out, JSON.stringify(e) + '\n'); };
  log({ type: 'search_started', config: o.config, start: start.base, seeds: o.seeds, components: o.components });

  const candidates = new Map<string, Candidate>();
  const summariesOf = new Map<string, Readonly<Record<string, ModuleSummary>>>();
  let seq = 0, stoppedBy = '';

  const evaluate = async (genome: readonly string[], origin: Candidate['origin']): Promise<Candidate | null> => {
    const id = genomeId(genome);
    if (candidates.has(id)) { log({ type: 'duplicate', id, origin }); return candidates.get(id)!; }
    const c: Candidate = { id, genome, origin, seq: seq++ };
    candidates.set(id, c);
    log({ type: 'candidate', id, genome, origin, seq: c.seq });
    const known = served.get(id);
    if (known) {
      Object.assign(c, { state: known.state, reason: known.reason, deficits: known.deficits, totals: known.totals, location: known.location });
      if (known.summaries) summariesOf.set(id, known.summaries);
      log(known);
      return c;
    }
    let result: Record<string, any>;
    try {
      if (!genome.length) {
        const m = await o.evaluator.probes(start);
        result = m.complete ? { state: 'measured', deficits: Object.fromEntries(m.components.map((k) => [k.id, k.quality])), location: 'none' } : { state: 'unmeasured', reason: 'its probes were not all measured', deficits: Object.fromEntries(m.components.map((k) => [k.id, k.quality])) };
      } else {
        const v = await o.evaluator.compose(genome);
        if ('invalid' in v) result = { state: 'invalid', reason: v.invalid };
        else {
          const valid = await o.evaluator.valid(v.pkg);
          if (valid !== true) result = { state: 'invalid', reason: valid, totals: v.totals };
          else {
            const m = await o.evaluator.probes(v.pkg);
            const deficits = Object.fromEntries(m.components.map((k) => [k.id, k.quality]));
            const complete = m.complete && o.components.every((k) => typeof deficits[k] === 'number');
            summariesOf.set(id, v.summaries);
            result = { state: complete ? 'measured' : 'unmeasured', ...(complete ? {} : { reason: 'its probes were not all measured' }), deficits, totals: v.totals,
              location: locationOf(v.summaries, o.config.layer_groups), summaries: v.summaries };
          }
        }
      }
    } catch (e) {
      if (e instanceof OutOfBudget) { stoppedBy = 'budget: ' + e.bag; log({ type: 'stopped', id, why: e.message }); return null; }
      throw e;
    }
    Object.assign(c, { state: result.state, reason: result.reason, deficits: result.deficits, totals: result.totals, location: result.location });
    log({ type: 'evaluated', id, ...result });
    return c;
  };

  /* The population: the start, the strong seeds, the controls. */
  const startC = await evaluate([], { kind: 'start' });
  if (!startC || startC.state !== 'measured') stoppedBy ||= 'the start could not be measured: no niche can be told';
  for (const s of o.seeds) { if (stoppedBy) break; await evaluate([s], { kind: 'strong' }); }
  for (let i = 0; i < o.config.control_seeds && !stoppedBy; i++) {
    const strong = o.seeds[i % o.seeds.length];
    const target = summariesOf.get(genomeId([strong]));
    if (!target) { log({ type: 'control_skipped', strong, why: 'its strong seed has no composed norms (invalid or not composed)' }); continue; }
    const norms = Object.fromEntries(Object.entries(target).map(([m, s]) => [m, s.relative_norm]));
    const measureNorm = (id: string) => Object.fromEntries(Object.entries(compose([{ id, ...load(o.store, id) }], base).summaries).map(([m, s]) => [m, s.relative_norm]));
    const control = controlOf(o.store, chip, strong, o.config.seed * 7919 + i * 2, norms, measureNorm);
    if (!control) { log({ type: 'control_skipped', strong, why: 'no control of its size could be made' }); continue; }
    await evaluate([control], { kind: 'control', parents: [strong], seed: o.config.seed * 7919 + i * 2 });
  }

  /* The operators, step by step: a parent drawn from the archive's elites, an operator drawn by its weight among those
     that apply, the child evaluated through the cascade. */
  const weights = OPERATORS.map((k) => [k, o.config.operators[k] ?? 0] as const).filter(([k, w]) => w > 0 && (k !== 'refine' || o.evaluator.refine));
  for (let step = 0; step < o.config.max_candidates && !stoppedBy; step++) {
    if (o.signal?.aborted) { stoppedBy = 'cancelled'; break; }
    const r = seeded(o.config.seed * 1000003 + step);
    const { elites } = archiveOf(events, o.config, o.components);
    const pool = [...elites.values()].filter((c) => c.genome.length).sort((a, b) => a.seq - b.seq);
    const parents = pool.length ? pool : [...candidates.values()].filter((c) => c.state === 'measured' && c.genome.length).sort((a, b) => a.seq - b.seq);
    if (!parents.length || !weights.length) { stoppedBy = parents.length ? 'no operator' : 'no measured parent'; break; }
    const parent = parents[Math.floor((r() + 0.5) * parents.length) % parents.length];
    const total = weights.reduce((a, [, w]) => a + w, 0);
    let pick = (r() + 0.5) * total, op: Operator = weights[0][0];
    for (const [k, w] of weights) { if (pick < w) { op = k; break; } pick -= w; }
    const seed = o.config.seed * 1000003 + step;
    const at = Math.floor((r() + 0.5) * parent.genome.length) % parent.genome.length;
    let child: string[] | null = null;
    const replace = (made: string | null) => made ? parent.genome.map((g, i) => (i === at ? made : g)) : null;
    if (op === 'drop') child = parent.genome.filter((_, i) => i !== at);
    else if (op === 'combine') {
      const others = parents.filter((p) => p.id !== parent.id);
      if (others.length) { const other = others[Math.floor((r() + 0.5) * others.length) % others.length]; child = [...parent.genome, ...other.genome.filter((g) => !parent.genome.includes(g))]; }
    } else if (op === 'refine') {
      const made = await o.evaluator.refine!({ genome: parent.genome, deficits: parent.deficits ?? {} });
      child = made ? [...parent.genome, made] : null;
    } else if (op === 'perturb') child = replace(EDIT_OPERATORS.perturb(o.store, chip, parent.genome[at], seed, o.config.perturb));
    else if (op === 'retarget') child = replace(EDIT_OPERATORS.retarget(o.store, chip, parent.genome[at], seed, base));
    else child = replace(EDIT_OPERATORS[op](o.store, chip, parent.genome[at], seed));
    if (!child) { log({ type: 'operator_inapplicable', step, operator: op, parent: parent.id }); continue; }
    await evaluate(child, { kind: 'operator', operator: op, parents: [parent.id], seed, step });
  }
  stoppedBy ||= 'max_candidates';

  /* Whole investigations for the elites: evidence attached, their niche unchanged. */
  const { elites } = archiveOf(events, o.config, o.components);
  const evidence: Record<string, unknown> = {};
  if (o.config.investigate_elites && o.evaluator.investigate) for (const c of [...elites.values()].sort((a, b) => a.seq - b.seq)) {
    const served = recorded.find((e) => e.type === 'investigated' && e.id === c.id);
    if (served) { evidence[c.id] = served.evidence; log(served); continue; }
    try {
      const v = c.genome.length ? await o.evaluator.compose(c.genome) : { pkg: start };
      if ('invalid' in v) continue;
      evidence[c.id] = await o.evaluator.investigate(v.pkg);
      log({ type: 'investigated', id: c.id, evidence: evidence[c.id] });
    } catch (e) { if (e instanceof OutOfBudget) { log({ type: 'stopped', id: c.id, why: e.message }); break; } throw e; }
  }
  log({ type: 'search_finished', stoppedBy });
  const rebuilt = archiveOf(events, o.config, o.components);
  return { stoppedBy, candidates: [...rebuilt.candidates.values()], elites: [...rebuilt.elites.values()].sort((a, b) => a.seq - b.seq), evidence };
}
