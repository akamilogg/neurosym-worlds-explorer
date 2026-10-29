import { createHash } from 'node:crypto';
import { stableStringify } from '../core/hash.ts';
import { LABS } from '../worlds/labs.ts';

/* ============================================================================
 * The measure of a junior (SPEC-METAPOLITICA-APRENDIZAJE §6.1-§6.5): its manifest, the deficit of each observation, the
 * components of its quality and the decision to promote it.
 *
 * junior-competence-manifest@1 is the operator's. It fixes, before any search, the cases (investigations and probes),
 * the components and their references, the seeds, the limits and the promotion procedure. A candidate never edits it;
 * changing it is another condition.
 *
 * A COMPONENT is the mean deficit of its cases, each case the mean of its repetitions: the case is the unit, never an
 * opportunity pooled with others. Its cases are built alike (§6.3): probes of one component ask as many answers each,
 * and every world gives it as many probes; a world's component is one world at one level, its runs repeated alike.
 * An evaluation that misses anything it needs has no quality: never an elite, never a promotion.
 * ========================================================================== */

export const COMPETENCE_MANIFEST = 'junior-competence-manifest@1';

export type Partition = 'development' | 'confirmation';
export type Mode = 'start' | 'cut';

export interface Component {
  readonly id: string;
  /** 1 protocol, 2 requests, 3 rules, 4 checkable model: from probes. 6 worlds: from investigations. 5 (method) is diagnostic. */
  readonly rung: 1 | 2 | 3 | 4 | 6;
  /** Probes: the state they open from (§6.4); start and cut never share a component. */
  readonly mode?: Mode;
  /** Rung 2: the kind of request it asks for. */
  readonly request?: string;
  /** Rung 6: its laboratory and level. */
  readonly lab?: string;
  readonly level?: string;
  readonly extractor: { readonly id: string; readonly version: number };
  readonly unit: string;
  readonly direction: 'up' | 'down';
  readonly target: number;
  readonly bad: number;
  /** In the component's unit: how much worse it may get before it is a regression. */
  readonly tolerance: number;
  readonly protected?: boolean;
}

export interface InvestigationCase {
  readonly id: string;
  readonly kind: 'investigation';
  readonly lab: string;
  readonly args: readonly string[];
  readonly partition: Partition;
  /** The lineage it belongs to: cases of one group stay in one partition and one use (§6.4). */
  readonly group: string;
  readonly components: readonly string[];
}

export interface ProbeCase {
  readonly id: string;
  readonly kind: 'probe';
  readonly partition: 'development';
  readonly group: string;
  readonly component: string;
  /** Its laboratory (the world it counts for in the component's quotas). */
  readonly lab: string;
  /** The cut: the run's journal, the question it opens before (0-based, System 2's questions), the hash of the cut. */
  readonly cut: { readonly run: string; readonly question: number; readonly hash: string };
  readonly mode: Mode;
  /** Cut mode: the memory it opens with (blob ids). */
  readonly snapshot?: { readonly neural: string | null; readonly twin: string | null };
  readonly competence: string;
  /** The task, visible to the junior (§6.4): its text, given as the evaluator's message after the prefix. */
  readonly instruction: string;
  readonly checker: { readonly id: string; readonly version: number };
  /** Set when it was chosen because of an error of the baseline: it measures the repair of a known error. */
  readonly repairs?: string;
}

export type CompetenceCase = InvestigationCase | ProbeCase;

export interface CompetenceManifest {
  readonly format: typeof COMPETENCE_MANIFEST;
  readonly id: string;
  /** The reference junior: its execution hash. */
  readonly reference: string;
  readonly cases: readonly CompetenceCase[];
  readonly components: readonly Component[];
  /** Runs of each investigation, the same for every one. */
  readonly investigation_repetitions: number;
  readonly execution: Readonly<Record<string, unknown>>;
  /** The seeds every candidate shares: one base, from which each case and repetition takes its own (§6.5). */
  readonly sampling: { readonly seed: number };
  readonly promotion: { readonly procedure: 'paired-cases@1'; readonly alpha: number; readonly permutations: number; readonly seed: number };
  readonly limits: {
    /** An investigation's junior (its harness's --max-tokens and --max-judge-calls), and its args besides. */
    readonly junior_args: readonly string[];
    readonly probe_max_tokens: number;
    readonly timeout_ms: number;
  };
}

const PROBE_CHECKERS = new Set(['protocol', 'request', 'rules', 'proposal']);

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Everything wrong with a manifest; an empty list is a manifest that may run. It is refused before any inference. */
export function competenceProblems(raw: unknown): string[] {
  const m = raw as CompetenceManifest;
  if (!m || m.format !== COMPETENCE_MANIFEST) return ['"format": "' + COMPETENCE_MANIFEST + '"'];
  const e: string[] = [];
  if (typeof m.id !== 'string' || !/^[\w.-]+$/.test(m.id)) e.push('"id": letters, digits, dots and dashes');
  if (typeof m.reference !== 'string' || !/^[0-9a-f]{64}$/.test(m.reference)) e.push('"reference": the execution hash of the reference junior');
  if (!Number.isInteger(m.investigation_repetitions) || m.investigation_repetitions < 1) e.push('"investigation_repetitions": a whole number above 0');
  if (!m.sampling || !Number.isInteger(m.sampling.seed)) e.push('"sampling": {"seed": an integer}');
  const pr = m.promotion;
  if (!pr || pr.procedure !== 'paired-cases@1' || !(pr.alpha > 0 && pr.alpha < 1) || !(Number.isInteger(pr.permutations) && pr.permutations >= 1000) || !Number.isInteger(pr.seed))
    e.push('"promotion": {"procedure": "paired-cases@1", "alpha" in (0,1), "permutations" >= 1000, "seed"}');
  const l = m.limits;
  if (!l || !Array.isArray(l.junior_args) || !(l.probe_max_tokens > 0) || !(l.timeout_ms > 0)) e.push('"limits": {"junior_args", "probe_max_tokens", "timeout_ms"}');
  else {
    const bounded = (k: string) => l.junior_args.includes(k) && Number(l.junior_args[l.junior_args.indexOf(k) + 1]) > 0;
    if (!bounded('--max-tokens') || !bounded('--max-judge-calls')) e.push('"limits.junior_args": its --max-tokens and --max-judge-calls, what each investigation is reserved');
  }
  if (!m.execution || typeof m.execution !== 'object') e.push('"execution": the harness, checkers, snapshot formats, tools, Judge and teacher as they run');

  const comps = new Map<string, Component>();
  for (const [i, c] of (Array.isArray(m.components) ? m.components : []).entries()) {
    const at = 'component ' + (c?.id ?? '#' + i);
    if (typeof c?.id !== 'string' || comps.has(c.id)) { e.push(at + ': a unique "id"'); continue; }
    comps.set(c.id, c);
    if (![1, 2, 3, 4, 6].includes(c.rung)) e.push(at + ': "rung" 1-4 or 6 (method, rung 5, is diagnostic: no component of selection)');
    if (c.rung <= 4 && c.mode !== 'start' && c.mode !== 'cut') e.push(at + ': a probe component names its "mode", start or cut');
    if (c.rung === 2 && typeof c.request !== 'string') e.push(at + ': rung 2 names the kind of "request"');
    if (c.rung === 6 && (!LABS[c.lab ?? ''] || typeof c.level !== 'string')) e.push(at + ': rung 6 names its "lab" and "level"');
    if (!c.extractor || typeof c.extractor.id !== 'string' || !Number.isInteger(c.extractor.version)) e.push(at + ': a versioned "extractor"');
    if (typeof c.unit !== 'string' || !c.unit) e.push(at + ': its "unit"');
    if (!finite(c.target) || !finite(c.bad) || c.target === c.bad) e.push(at + ': "target" and "bad" finite and distinct');
    else if ((c.direction === 'up') !== (c.target > c.bad) || (c.direction !== 'up' && c.direction !== 'down')) e.push(at + ': "direction" up has target above bad, down below');
    if (!finite(c.tolerance) || c.tolerance < 0) e.push(at + ': "tolerance" >= 0 in its unit');
  }
  if (!comps.size) e.push('"components": at least one');

  const ids = new Set<string>();
  const groups = new Map<string, Partition>();
  const uses = new Map<string, number>();
  const quota = new Map<string, Map<string, number>>();
  for (const [i, c] of (Array.isArray(m.cases) ? m.cases : []).entries()) {
    const at = 'case ' + (c?.id ?? '#' + i);
    if (typeof c?.id !== 'string' || ids.has(c.id)) { e.push(at + ': a unique "id"'); continue; }
    ids.add(c.id);
    if (typeof c.group !== 'string' || !c.group) e.push(at + ': its "group" (the lineage of its run)');
    else {
      const seen = groups.get(c.group);
      if (seen && seen !== c.partition) e.push(at + ': group ' + c.group + ' is in both partitions');
      groups.set(c.group, c.partition);
    }
    if (!LABS[c.lab]) e.push(at + ': no laboratory "' + c.lab + '"');
    if (c.kind === 'investigation') {
      if (c.partition !== 'development' && c.partition !== 'confirmation') e.push(at + ': "partition" development or confirmation');
      if (!Array.isArray(c.args)) e.push(at + ': the "args" of its world');
      for (const k of c.components ?? []) {
        const comp = comps.get(k);
        if (!comp) e.push(at + ': no component ' + k);
        else if (comp.rung !== 6) e.push(at + ': an investigation scores rung 6, not ' + k);
        else if (comp.lab !== c.lab) e.push(at + ': component ' + k + ' is of ' + comp.lab);
        uses.set(k, (uses.get(k) ?? 0) + 1);
      }
    } else if (c.kind === 'probe') {
      if (c.partition !== 'development') e.push(at + ': a probe comes from development only');
      const comp = comps.get(c.component);
      if (!comp) e.push(at + ': no component ' + c.component);
      else {
        if (comp.rung > 4) e.push(at + ': a probe scores rungs 1-4');
        if (comp.mode !== c.mode) e.push(at + ': its mode ' + c.mode + ' is not its component\'s ' + comp.mode);
        uses.set(comp.id, (uses.get(comp.id) ?? 0) + 1);
        const q = quota.get(comp.id) ?? new Map<string, number>();
        q.set(c.lab, (q.get(c.lab) ?? 0) + 1);
        quota.set(comp.id, q);
      }
      if (!c.cut || typeof c.cut.run !== 'string' || !Number.isInteger(c.cut.question) || c.cut.question < 0 || typeof c.cut.hash !== 'string') e.push(at + ': its "cut" {run, question, hash}');
      if (c.mode !== 'start' && c.mode !== 'cut') e.push(at + ': "mode" start or cut');
      if (c.mode === 'cut' && !c.snapshot) e.push(at + ': a cut probe declares the "snapshot" it opens with');
      if (c.mode === 'start' && c.snapshot) e.push(at + ': a start probe opens with the candidate\'s own memory: no snapshot');
      if (typeof c.instruction !== 'string' || !c.instruction.trim()) e.push(at + ': its visible "instruction"');
      if (typeof c.competence !== 'string' || !c.competence) e.push(at + ': the "competence" it asks for');
      if (!c.checker || !PROBE_CHECKERS.has(c.checker.id) || !Number.isInteger(c.checker.version)) e.push(at + ': a "checker" among ' + [...PROBE_CHECKERS].join(', ') + ', versioned');
    } else e.push(at + ': "kind" investigation or probe');
  }
  if (!ids.size) e.push('"cases": at least one');
  for (const id of comps.keys()) if (!uses.get(id)) e.push('component ' + id + ': no case scores it');
  for (const [id, q] of quota) {
    const counts = new Set(q.values());
    if (counts.size > 1) e.push('component ' + id + ': every world gives it as many probes (' + [...q].map(([lab, n]) => lab + ' ' + n).join(', ') + ')');
  }
  return e;
}

export const competenceHash = (m: CompetenceManifest): string => createHash('sha256').update(stableStringify(m)).digest('hex');

/** The seed of a case and repetition: from the manifest's, the same for every candidate (§6.5). */
export function seedOf(m: CompetenceManifest, caseId: string, rep: number): number {
  return parseInt(createHash('sha256').update(stableStringify([m.sampling.seed, caseId, rep])).digest('hex').slice(0, 8), 16);
}

/** Answers a probe asks of a candidate (§6.3): one with deterministic decoding, four if it samples. */
export const probeRepetitions = (temperature: number): number => (temperature === 0 ? 1 : 4);

/* --- Deficits and quality -------------------------------------------------------------------------------------------- */

/** d(x) = clamp((target - x) / (target - bad), 0, 1): 0 at the target or beyond, 1 at the reference unfavourable or beyond. */
export function deficit(c: Pick<Component, 'target' | 'bad'>, x: number): number {
  if (!Number.isFinite(x)) throw new Error('a value that is not finite has no deficit');
  return Math.min(1, Math.max(0, (c.target - x) / (c.target - c.bad)));
}

/** One observation: a case's repetition, its value in the component's unit, or why it measures nothing. A failure of the
    junior is a value (its checker says 0); infra, cancelled and unfunded are not. */
export interface Observation {
  readonly component: string;
  readonly case: string;
  readonly rep: number;
  readonly value: number | null;
  readonly state: 'measured' | 'infra' | 'cancelled' | 'unfunded' | 'error';
  readonly why?: string;
}

export interface ComponentMeasure {
  readonly id: string;
  /** Mean deficit of its cases; null where its evaluation is incomplete. */
  readonly quality: number | null;
  /** Each case's mean deficit (its repetitions), and its mean value in the unit. */
  readonly cases: Readonly<Record<string, { readonly deficit: number | null; readonly value: number | null; readonly reps: number }>>;
  readonly complete: boolean;
  readonly missing: readonly string[];
}

export interface Measure {
  readonly complete: boolean;
  /** Components in the manifest's order; quality null for an incomplete one. */
  readonly components: readonly ComponentMeasure[];
  /** The engine's vector (lower better), names kept; null when anything is incomplete. */
  readonly vector: readonly number[] | null;
}

/** Which cases and how many repetitions each component needs of a candidate on a partition. */
export function needs(m: CompetenceManifest, partition: Partition, temperature: number): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>(m.components.map((c) => [c.id, new Map<string, number>()]));
  for (const c of m.cases) {
    if (c.partition !== partition) continue;
    if (c.kind === 'investigation') for (const k of c.components) out.get(k)?.set(c.id, m.investigation_repetitions);
    else out.get(c.component)?.set(c.id, probeRepetitions(temperature));
  }
  return out;
}

/** A candidate's measure from its observations (§6.3): per case the mean of its repetitions' deficits, per component the
    mean of its cases. Anything it needs and lacks - a repetition never run, failed by the infrastructure, a value that is
    not finite - leaves its component without quality and the measure incomplete. */
export function measure(m: CompetenceManifest, partition: Partition, temperature: number, observations: readonly Observation[]): Measure {
  const need = needs(m, partition, temperature);
  const components: ComponentMeasure[] = [];
  for (const comp of m.components) {
    const cases: Record<string, { deficit: number | null; value: number | null; reps: number }> = {};
    const missing: string[] = [];
    const want = need.get(comp.id)!;
    if (!want.size) missing.push('no case of the ' + partition + ' partition');
    for (const [caseId, reps] of want) {
      const ds: number[] = [], xs: number[] = [];
      for (let r = 0; r < reps; r++) {
        const o = observations.find((x) => x.component === comp.id && x.case === caseId && x.rep === r);
        if (!o) { missing.push(caseId + '#' + r + ' not run'); continue; }
        if (o.state !== 'measured' || o.value === null || !Number.isFinite(o.value)) { missing.push(caseId + '#' + r + ' ' + o.state + (o.why ? ' (' + o.why + ')' : '')); continue; }
        ds.push(deficit(comp, o.value)); xs.push(o.value);
      }
      const whole = ds.length === reps;
      cases[caseId] = { deficit: whole ? ds.reduce((a, b) => a + b, 0) / reps : null, value: whole ? xs.reduce((a, b) => a + b, 0) / reps : null, reps: ds.length };
    }
    const complete = !missing.length;
    const vals = Object.values(cases).map((c) => c.deficit as number);
    components.push({ id: comp.id, quality: complete ? vals.reduce((a, b) => a + b, 0) / vals.length : null, cases, complete, missing });
  }
  const complete = components.every((c) => c.complete);
  return { complete, components, vector: complete ? components.map((c) => c.quality as number) : null };
}

/* --- Promotion: paired-cases@1 --------------------------------------------------------------------------------------- */

/** A seeded generator (mulberry32): the permutations are the manifest's, the same every time. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One-sided p of a paired sign-flip permutation test that the mean of `d` is above 0: exact up to 20 cases, otherwise
    `permutations` seeded flips (the observed one counted). */
export function signFlipP(d: readonly number[], permutations: number, seed: number): number {
  const n = d.length;
  if (!n) return 1;
  const observed = d.reduce((a, b) => a + b, 0);
  const eps = 1e-12;
  if (n <= 20) {
    let hits = 0;
    const total = 1 << n;
    for (let mask = 0; mask < total; mask++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += mask & (1 << i) ? -d[i] : d[i];
      if (s >= observed - eps) hits++;
    }
    return hits / total;
  }
  const r = rng(seed);
  let hits = 1;
  for (let k = 0; k < permutations; k++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += r() < 0.5 ? -d[i] : d[i];
    if (s >= observed - eps) hits++;
  }
  return hits / (permutations + 1);
}

export interface PromotionComponent {
  readonly id: string;
  /** Mean of d_ref - d_cand over its cases (positive: the candidate is better). */
  readonly mean_delta: number | null;
  readonly p: number | null;
  readonly improves: boolean;
  readonly regresses: boolean;
}

export interface Promotion {
  readonly verdict: 'promoted' | 'not_promoted' | 'inconclusive';
  readonly why: string;
  readonly components: readonly PromotionComponent[];
}

/** paired-cases@1 (§6.5): per component the paired difference of deficits per case. A protected component worse beyond its
    tolerance: not_promoted. Otherwise, a component whose improvement holds under the sign-flip test with Holm's correction:
    promoted. Neither: inconclusive. Any evidence missing, on either side: inconclusive. It asks no model. */
export function promote(m: CompetenceManifest, reference: Measure, candidate: Measure): Promotion {
  if (!reference.complete || !candidate.complete) return { verdict: 'inconclusive', why: 'the evidence is incomplete: ' + (!reference.complete ? 'the reference' : 'the candidate') + ' lacks measures', components: [] };
  const rows: { id: string; delta: number; p: number; regresses: boolean }[] = [];
  for (const comp of m.components) {
    const r = reference.components.find((c) => c.id === comp.id)!, c = candidate.components.find((x) => x.id === comp.id)!;
    const ids = Object.keys(r.cases).sort();
    if (stableStringify(ids) !== stableStringify(Object.keys(c.cases).sort())) return { verdict: 'inconclusive', why: 'component ' + comp.id + ' was measured on other cases', components: [] };
    const d = ids.map((k) => (r.cases[k].deficit as number) - (c.cases[k].deficit as number));
    const delta = d.reduce((a, b) => a + b, 0) / d.length;
    const tol = comp.tolerance / Math.abs(comp.target - comp.bad);
    rows.push({ id: comp.id, delta, p: signFlipP(d, m.promotion.permutations, m.promotion.seed), regresses: !!comp.protected && delta < -tol - 1e-12 });
  }
  /* Holm over the components: the smallest p first, each against alpha over the ones left. */
  const order = rows.map((r, i) => ({ i, p: r.delta > 0 ? r.p : 1 })).sort((a, b) => a.p - b.p);
  const improves = new Set<number>();
  for (let k = 0; k < order.length; k++) {
    if (order[k].p <= m.promotion.alpha / (order.length - k)) improves.add(order[k].i); else break;
  }
  const components = rows.map((r, i) => ({ id: r.id, mean_delta: r.delta, p: r.p, improves: improves.has(i), regresses: r.regresses }));
  const regressed = components.filter((c) => c.regresses);
  if (regressed.length) return { verdict: 'not_promoted', why: 'a protected component regresses beyond its tolerance: ' + regressed.map((c) => c.id).join(', '), components };
  const better = components.filter((c) => c.improves);
  if (better.length) return { verdict: 'promoted', why: 'it improves ' + better.map((c) => c.id).join(', ') + ' and no protected component regresses', components };
  return { verdict: 'inconclusive', why: 'no regression and no improvement that holds', components };
}
