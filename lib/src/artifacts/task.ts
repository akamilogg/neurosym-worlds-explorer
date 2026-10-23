/* ============================================================================
 * An ARTIFACT TASK (SPEC-MUNDO-ARTEFACTOS §4): what a world of artifacts declares, fixed before the
 * researcher's first turn and never touched by it.
 *
 *   base        the artifact it starts from (a directory)
 *   run         how a version runs on one workload: the command, the files it is given, the files
 *               it leaves; the same for a data script and for "train and evaluate a policy"
 *               (Microduck, §14.3): what a run measures comes back as JSON the task reads
 *   families    the workloads, by family, each a place: laboratories (where it acts), the
 *               family (where it validates), the blind ones (reserved for confirmation)
 *   oracle      whether a candidate's run is correct - against the reference's run on the same
 *               workload, or on its own (properties, constraints)
 *   objective   the metric to improve, which way, by how much, with how many repetitions; the
 *               constraints the others must keep
 *
 * The SCORE is the task's, never the artifact's: the researcher changes the artifact (a reward
 * included, §14.2), never how it is judged.
 * ========================================================================== */

/** One workload: the case a version runs on, from a family, with its own seed. */
export interface Workload {
  readonly family: string;
  readonly id: string;
  readonly seed: number;
  /** What is known of it before any run (the percept's part: §7). */
  readonly params: Readonly<Record<string, number | string | boolean>>;
}

/** What a run of a version on a workload produced, as the sandbox saw it and as the task reads it. */
export interface RunOutcome {
  readonly workload: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** The task's metrics of this run (e.g. wall_ms, peak_kb, a score) - null where it could not read them. */
  readonly metrics: Readonly<Record<string, number>> | null;
  /** What the run left, as the oracle compares it (the task decides what: a file, a digest). */
  readonly output: string | null;
  readonly stderr: string;
}

export interface Family {
  readonly id: string;
  readonly about: string;
  /** Where it serves: a laboratory (the researcher acts and is checked), the family (validation), blind (confirmation). */
  readonly role: 'laboratory' | 'family' | 'blind';
  /** Its workloads, n of them, from a seed: the same seed gives the same workloads. */
  workloads(seed: number, n: number): readonly Workload[];
  /** What a candidate must do here: be better by the margin (default), or only not be worse - a family where nothing is to
      be gained, kept to see that nothing breaks (the task's author decides which, before any run). */
  readonly requires?: 'better' | 'not_worse';
}

export interface Objective {
  /** The metric to improve, and which way. */
  readonly metric: string;
  readonly direction: 'min' | 'max';
  /** How much better a candidate must be to count as better (0.1: 10 %), with the given confidence. */
  readonly margin: number;
  /** In a family that only requires not being worse: by how much worse it may be, at most (default: the margin). */
  readonly tolerance?: number;
  readonly confidence: number;
  /** Runs of each version per workload, reference and candidate interleaved. */
  readonly repetitions: number;
  /** Other metrics that may not get worse than by this ratio (1.1: at most 10 % worse). */
  readonly constraints?: readonly { readonly metric: string; readonly direction: 'min' | 'max'; readonly maxRatio: number }[];
  /** A verdict on how the metric GROWS, not on its size: the candidate's metric over the reference's as a workload parameter
      grows (its size), the slope of their log-log line - better where it falls by at least `margin` (a slope below -margin)
      with the confidence. Workloads whose parameter is at most `floor` measure what costs the same at any size (starting,
      reading): set apart from each version's runs before the slope is taken, so a fixed cost never passes for growth. */
  readonly growth?: { readonly param: string; readonly floor: number };
}

export interface ArtifactTask {
  readonly id: string;
  readonly about: string;
  /** The directory of the base artifact. */
  readonly base: string;
  /** How a version runs on a workload: its command (the artifact at `src/`), its input files, the files it leaves. */
  readonly run: {
    command(w: Workload, repetition: number): readonly string[];
    inputs(w: Workload): Readonly<Record<string, string>>;
    readonly outputs: readonly string[];
    readonly timeoutMs: number;
    /** Commands whose output names what the artifact runs on (its interpreter's version...): part of the environment's
        fingerprint (§11, re-execution). */
    readonly environment?: readonly (readonly string[])[];
  };
  /** What a run measured and what it left, read from the files it left and the sandbox's measures. */
  read(files: Readonly<Record<string, string | null>>, measured: { readonly wallMs: number; readonly stdout: string }): { metrics: Record<string, number> | null; output: string | null };
  readonly families: readonly Family[];
  /** Whether a candidate's run is correct, given the reference's on the same workload. */
  oracle(candidate: RunOutcome, reference: RunOutcome, w: Workload): { readonly ok: boolean; readonly why?: string };
  readonly objective: Objective;
}

/* --- The verdict (§8): correct everywhere, better by the margin with the confidence, no constraint broken ------------ */

/** A seeded generator (the same verdict on the same measures). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const median = (xs: readonly number[]): number => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const geomean = (xs: readonly number[]): number => Math.exp(xs.reduce((a, x) => a + Math.log(x), 0) / xs.length);

/** One workload's measures: the reference's and the candidate's runs, interleaved. */
export interface Paired { readonly workload: Workload; readonly reference: readonly RunOutcome[]; readonly candidate: readonly RunOutcome[] }

export interface Verdict {
  readonly holds: boolean;
  /** Every run of the candidate correct, per the oracle. */
  readonly correct: boolean;
  readonly incorrect: readonly { readonly workload: string; readonly why: string }[];
  /** The candidate's metric over the reference's (geometric mean over workloads of the medians' ratio), and its interval. */
  readonly ratio: number | null;
  readonly interval: readonly [number, number] | null;
  readonly better: boolean;
  readonly constraints: readonly { readonly metric: string; readonly ratio: number | null; readonly ok: boolean }[];
  readonly why: string;
  /** With an objective on growth: the slope of the candidate's metric over the reference's against the size (log-log), its
      interval, the sizes it was taken on, and what each version's fixed cost was taken to be. */
  readonly growth?: { readonly slope: number; readonly interval: readonly [number, number]; readonly sizes: readonly number[]; readonly fixed: { readonly reference: number; readonly candidate: number } };
}

/** The ratio candidate / reference of a metric per workload (medians of its repetitions), oriented so that < 1 is better. */
function ratios(pairs: readonly Paired[], metric: string, direction: 'min' | 'max'): number[] | null {
  const out: number[] = [];
  for (const p of pairs) {
    const r = p.reference.map((x) => x.metrics?.[metric]).filter((x): x is number => typeof x === 'number' && x > 0);
    const c = p.candidate.map((x) => x.metrics?.[metric]).filter((x): x is number => typeof x === 'number' && x > 0);
    if (!r.length || !c.length) return null;
    out.push(direction === 'min' ? median(c) / median(r) : median(r) / median(c));
  }
  return out;
}

/** The verdict on a candidate against the reference, on the same workloads (SPEC-MUNDO-ARTEFACTOS §8): correct in every run,
    better than the reference by the margin - the upper end of a bootstrap interval of the geometric mean ratio below 1 - margin -
    and no constraint broken. Deterministic: the bootstrap's generator is seeded by the measures' count. */
export function judge(task: ArtifactTask, pairs: readonly Paired[], requires: 'better' | 'not_worse' = 'better'): Verdict {
  const o = task.objective;
  const incorrect: { workload: string; why: string }[] = [];
  for (const p of pairs) {
    p.candidate.forEach((c, i) => {
      const ref = p.reference[i] ?? p.reference[0];
      if (c.timedOut) { incorrect.push({ workload: p.workload.id, why: 'timed out' }); return; }
      if (c.exitCode !== 0) { incorrect.push({ workload: p.workload.id, why: 'exited with ' + c.exitCode + (c.stderr ? ': ' + c.stderr.slice(0, 200) : '') }); return; }
      const v = task.oracle(c, ref, p.workload);
      if (!v.ok) incorrect.push({ workload: p.workload.id, why: v.why ?? 'not correct' });
    });
  }
  const correct = incorrect.length === 0;
  if (o.growth) return judgeGrowth(task, pairs, requires, correct, incorrect);
  const rs = ratios(pairs, o.metric, o.direction);
  let ratio: number | null = null, interval: [number, number] | null = null, better = false;
  if (rs && rs.length) {
    ratio = geomean(rs);
    const rnd = mulberry32(rs.length * 7919 + pairs.length);
    const boots: number[] = [];
    for (let b = 0; b < 2000; b++) boots.push(geomean(rs.map(() => rs[Math.floor(rnd() * rs.length)])));
    boots.sort((a, b) => a - b);
    const tail = (1 - o.confidence) / 2;
    interval = [boots[Math.floor(tail * boots.length)], boots[Math.min(boots.length - 1, Math.ceil((1 - tail) * boots.length) - 1)]];
    better = requires === 'better' ? interval[1] < 1 - o.margin : interval[1] < 1 + (o.tolerance ?? o.margin);
  }
  const constraints = (o.constraints ?? []).map((k) => {
    const cr = ratios(pairs, k.metric, k.direction);
    const r = cr && cr.length ? geomean(cr) : null;
    return { metric: k.metric, ratio: r, ok: r !== null && r <= k.maxRatio };
  });
  const holds = correct && better && constraints.every((k) => k.ok);
  const why = !correct ? incorrect.length + ' incorrect run(s)'
    : ratio === null ? 'the metric "' + o.metric + '" could not be read'
    : !better ? (requires === 'better' ? 'not better by ' + Math.round(o.margin * 100) + '%' : 'worse by more than ' + Math.round((o.tolerance ?? o.margin) * 100) + '%')
      + ' with ' + Math.round(o.confidence * 100) + '% confidence (ratio ' + ratio.toFixed(3) + ', interval ' + interval!.map((x) => x.toFixed(3)).join('–') + ')'
    : constraints.find((k) => !k.ok) ? 'a constraint broken: ' + constraints.filter((k) => !k.ok).map((k) => k.metric).join(', ')
    : requires === 'better' ? 'correct, and better by ' + Math.round((1 - ratio) * 100) + '%' : 'correct, and not worse (ratio ' + ratio.toFixed(3) + ')';
  return { holds, correct, incorrect, ratio, interval, better, constraints, why };
}

/** The verdict on growth (Objective.growth): correct in every run, and the candidate's metric over the reference's falling as the
    size grows - the upper end of a bootstrap interval of the log-log slope below -margin (or, where only not being worse is
    asked, below the tolerance). Each version's fixed cost - the median of its runs at the floor's sizes - is set apart first
    (never below a twentieth of what was measured). Its growth is read only where the work stands out from the fixed cost: the
    reference's at the largest size at least its fixed cost again. The interval holds every variation measured: the bootstrap
    resamples the workloads within each size and the repetitions within each run, seeded by the count. */
function judgeGrowth(task: ArtifactTask, pairs: readonly Paired[], requires: 'better' | 'not_worse', correct: boolean, incorrect: readonly { workload: string; why: string }[]): Verdict {
  const o = task.objective, g = o.growth!;
  const valuesOf = (runs: readonly RunOutcome[]): number[] => runs.map((x) => x.metrics?.[o.metric]).filter((x): x is number => typeof x === 'number' && x > 0);
  const size = (p: Paired) => Number(p.workload.params[g.param]);
  /* Each workload's measures, both versions, as numbers: what every estimate below is computed from. */
  const runs = pairs.map((p) => ({ n: size(p), reference: valuesOf(p.reference), candidate: valuesOf(p.candidate) }));
  const unread = runs.some((r) => !r.reference.length || !r.candidate.length);
  const floor = runs.filter((r) => r.n <= g.floor), ladder = runs.filter((r) => r.n > g.floor);
  const sizes = [...new Set(ladder.map((r) => r.n))].sort((a, b) => a - b);
  type Draw = (xs: readonly number[]) => number[];
  /* The estimate from one draw of the measures: the slope, the fixed costs, and the reference's work at the largest size. */
  const estimate = (pick: Draw, within: (rs: typeof runs) => typeof runs) => {
    const fixedOf = (who: 'reference' | 'candidate') => median(within(floor).map((r) => median(pick(r[who]))));
    const fixed = { reference: fixedOf('reference'), candidate: fixedOf('candidate') };
    const net = (v: number, f: number) => Math.max(v - f, v / 20);
    const points = sizes.flatMap((n) => within(ladder.filter((r) => r.n === n)).map((r) => {
      const ref = median(pick(r.reference)), cand = median(pick(r.candidate));
      return { x: Math.log(n), y: Math.log(net(cand, fixed.candidate) / net(ref, fixed.reference)), work: ref - fixed.reference, top: n === sizes[sizes.length - 1] };
    }));
    const mx = points.reduce((a, q) => a + q.x, 0) / points.length, my = points.reduce((a, q) => a + q.y, 0) / points.length;
    const slope = points.reduce((a, q) => a + (q.x - mx) * (q.y - my), 0) / points.reduce((a, q) => a + (q.x - mx) ** 2, 0);
    return { slope, fixed, work: median(points.filter((q) => q.top).map((q) => q.work)) };
  };
  let growth: Verdict['growth'] | undefined, better = false, faint: string | null = null;
  if (!unread && floor.length && sizes.length >= 2) {
    const point = estimate((xs) => [...xs], (rs) => rs);
    if (!(point.work >= point.fixed.reference)) faint = 'its work does not stand out from its fixed cost: at the largest size the reference spends ' + Math.round(Math.max(0, point.work)) + ' over a fixed ' + Math.round(point.fixed.reference);
    else {
      const rnd = mulberry32(runs.length * 7919 + runs.reduce((a, r) => a + r.reference.length + r.candidate.length, 0));
      const resample = <T,>(xs: readonly T[]): T[] => xs.map(() => xs[Math.floor(rnd() * xs.length)]);
      const boots: number[] = [];
      for (let b = 0; b < 2000; b++) boots.push(estimate(resample, (rs) => resample(rs)).slope);
      boots.sort((a, b) => a - b);
      const tail = (1 - o.confidence) / 2;
      const interval: [number, number] = [boots[Math.floor(tail * boots.length)], boots[Math.min(boots.length - 1, Math.ceil((1 - tail) * boots.length) - 1)]];
      better = requires === 'better' ? interval[1] < -o.margin : interval[1] < (o.tolerance ?? o.margin);
      growth = { slope: point.slope, interval, sizes, fixed: point.fixed };
    }
  }
  const holds = correct && better;
  const fmt = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(3);
  const why = !correct ? incorrect.length + ' incorrect run(s)'
    : !growth ? 'how "' + o.metric + '" grows could not be read (' + (faint ?? (unread ? 'a run measured nothing' : !floor.length ? 'no workload at the floor, where a fixed cost is measured' : 'fewer than two sizes above ' + g.floor)) + ')'
    : !better ? (requires === 'better' ? 'its ' + o.metric + ' does not grow more slowly than the reference\'s by n^' + fmt(-o.margin)
      : 'its ' + o.metric + ' grows faster than the reference\'s by more than n^' + fmt(o.tolerance ?? o.margin))
      + ' with ' + Math.round(o.confidence * 100) + '% confidence (slope ' + fmt(growth.slope) + ', interval ' + growth.interval.map(fmt).join(' – ') + ')'
    : requires === 'better' ? 'correct, and its ' + o.metric + ' grows more slowly than the reference\'s (slope ' + fmt(growth.slope) + ')'
    : 'correct, and it grows no faster than the reference (slope ' + fmt(growth.slope) + ')';
  return { holds, correct, incorrect, ratio: null, interval: null, better, constraints: [], why, ...(growth ? { growth } : {}) };
}
