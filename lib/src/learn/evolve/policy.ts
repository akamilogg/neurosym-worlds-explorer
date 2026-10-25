import { cloneJson } from '../../core/hash.ts';

/* ============================================================================
 * The search policy of an evolutionary branch (SPEC-DELEGACION-EVOLUTIVA §6-§7), profile balanced@1: pure state and
 * pure transitions, rebuilt from the branch's events alone - never from the clock, a random generator or a machine.
 *
 *   admission   every correct candidate of a new hash is queued for development, better or not, with or without
 *               `holds`: a quota of attempts each, slots filled by arrival, never taken back for a faster one
 *   repair      a materialized but incorrect program gets a slot of its own, with its own quota
 *   elites      the best by the task's quality, a selection heuristic (§5): never a proof of dominance
 *   archive     cells of measured behaviour, when the evaluator declares descriptors (optional)
 *   turns       [development, exploitation, development, repair, restart], each parent's operator in rotation
 *   stagnation  of generation (attempts with nothing new to run) and of development (blocks of evaluations without
 *               progress), each answered by a declared recovery, never by an endless loop of restarts
 *
 * What the policy decides is a PLAN; what came of it is applied as an event. Nothing here calls a model or runs a program.
 * ========================================================================== */

export type Operator = 'local' | 'rewrite' | 'recombination' | 'repair' | 'restart';
export type Turn = 'development' | 'exploitation' | 'repair' | 'restart';

export interface Profile {
  readonly id: string;
  readonly elites: number;
  readonly development: number;
  readonly repair: number;
  readonly pending: number;
  readonly developmentQuota: number;
  readonly repairQuota: number;
  readonly turns: readonly Turn[];
  readonly operators: readonly Exclude<Operator, 'repair' | 'restart'>[];
  /** Attempts in a row without a new program that ran, before the generation recovery; and its restarts. */
  readonly generationStall: number;
  readonly generationRestarts: number;
  /** Evaluations of new hashes per block, blocks without progress before the development recovery, and its turns. */
  readonly block: number;
  readonly blocksWithoutProgress: number;
  readonly developmentRecovery: readonly ('development' | 'restart')[];
  /** Progress beyond this, in the units of the decisive component of the quality vector (artifacts: the task's margin). */
  readonly tolerance: number;
  readonly cellCapacity: number;
  readonly maxCells: number;
  /** What a mutator's context carries at most: the latest diagnostics of a candidate, and attempts already tried. */
  readonly diagnostics: number;
  readonly tried: number;
}

export function balanced(tolerance: number): Profile {
  return { id: 'balanced@1', elites: 4, development: 8, repair: 2, pending: 32, developmentQuota: 2, repairQuota: 2,
    turns: ['development', 'exploitation', 'development', 'repair', 'restart'], operators: ['local', 'rewrite', 'local', 'recombination'],
    generationStall: 5, generationRestarts: 2, block: 10, blocksWithoutProgress: 2,
    developmentRecovery: ['development', 'restart', 'development', 'restart', 'development'],
    tolerance, cellCapacity: 2, maxCells: 32, diagnostics: 3, tried: 3 };
}

/** What a candidate's evaluation found: whether it ran, whether it is correct, its quality (one component per family,
    lower is better, null where it could not be read), its behaviour (a cell, if the evaluator declares descriptors), and
    what the mutator may be told of it. */
export interface Evaluation {
  readonly executable: boolean;
  readonly correct: 'yes' | 'no' | 'unchecked';
  readonly quality: readonly (number | null)[] | null;
  readonly descriptor: string | null;
  readonly feedback: unknown;
  readonly diagnostics: readonly string[];
  /** The evaluator's identity when measured: evidence of another is stale (§13.1). */
  readonly evaluator: string;
}

export interface Candidate {
  readonly hash: string;
  readonly files: Readonly<Record<string, string>>;
  readonly parents: readonly string[];
  /** The roots of its lineage: the start, a seed or a restart are roots; a mutation inherits them, a recombination joins them. */
  readonly roots: readonly string[];
  /** The attempt that first made it ("start" for the start). */
  readonly origin: string;
  /** Registration order: ties are kept by it. */
  readonly seq: number;
  evaluation: Evaluation | null;
  stale: boolean;
  /** Admitted for development, or for repair, once each: a hash never gets another quota by appearing again. */
  developed: boolean;
  repaired: boolean;
  diagnostics: string[];
  /** When it was last used as a parent (an attempt's number): the least recently used goes first. */
  usedAt: number;
  operatorCursor: number;
}

export interface Slot { hash: string; quota: number }
export interface RepairSlot { origin: string; work: string; quota: number }
export interface Cell { occupants: string[]; lastSelected: number; opened: number }

export interface SearchState {
  readonly profile: Profile;
  attempts: number;
  candidates: Record<string, Candidate>;
  order: string[];
  development: Slot[];
  pending: string[];
  repairs: RepairSlot[];
  elites: string[];
  cells: Record<string, Cell>;
  archivedCells: string[];
  cursors: { turn: number; development: number; repair: number; elite: number; cell: number; exploitArchive: boolean };
  generation: { misses: number; restartsLeft: number; diagnostics: string[] };
  progress: { blockStart: number[] | null; evaluations: number; progressed: boolean; blocksWithout: number; recovery: number | null };
  /** Attempts already tried, by operator and lineage: what the mutator is told not to repeat. */
  tried: Record<string, { hash: string | null; result: string }[]>;
  /** What became of every decision that is not an attempt (admissions, retirements, recoveries): the policy's own account. */
  log: Record<string, unknown>[];
}

export interface Plan {
  readonly attempt: string;
  readonly turn: Turn;
  readonly operator: Operator;
  readonly parents: readonly string[];
  readonly recovery: 'generation' | 'development' | null;
}

export function initialState(profile: Profile): SearchState {
  return { profile, attempts: 0, candidates: {}, order: [], development: [], pending: [], repairs: [], elites: [], cells: {}, archivedCells: [],
    cursors: { turn: 0, development: 0, repair: 0, elite: 0, cell: 0, exploitArchive: false },
    generation: { misses: 0, restartsLeft: 0, diagnostics: [] },
    progress: { blockStart: null, evaluations: 0, progressed: false, blocksWithout: 0, recovery: null }, tried: {}, log: [] };
}

/* --- Quality: lower is better, a vector compared worst component first ------------------------------------------ */

/** The vector a comparison reads: each family's component from worst to best, an absent one the worst of all. */
export function comparable(quality: readonly (number | null)[] | null): number[] | null {
  if (!quality || !quality.length || quality.every((q) => q === null)) return null;
  return quality.map((q) => (q === null || !Number.isFinite(q) ? Infinity : q)).sort((a, b) => b - a);
}

/** < 0 when a is better than b: lexicographic on the worst-first vectors, the smaller first. */
export function compare(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? Infinity, y = b[i] ?? Infinity;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Whether `now` is better than `before` by more than the tolerance, in the decisive component. */
function improved(now: readonly number[] | null, before: readonly number[] | null, tolerance: number): boolean {
  if (!now) return false;
  if (!before) return true;
  for (let i = 0; i < Math.max(now.length, before.length); i++) {
    const x = now[i] ?? Infinity, y = before[i] ?? Infinity;
    if (x !== y) return x === Infinity ? false : y === Infinity ? true : y - x > tolerance;
  }
  return false;
}

const vectorOf = (c: Candidate | undefined): number[] | null => (c && !c.stale && c.evaluation?.correct === 'yes' ? comparable(c.evaluation.quality) : null);
const lineageKey = (roots: readonly string[]) => [...roots].sort().join('+');
const shareRoots = (a: Candidate, b: Candidate) => a.roots.some((r) => b.roots.includes(r));

/** The candidates the search goes on from: in development, elites, archived in a cell, waiting, under repair. */
export function active(s: SearchState): string[] {
  return [...new Set([...s.development.map((d) => d.hash), ...s.elites, ...Object.values(s.cells).flatMap((c) => c.occupants), ...s.pending, ...s.repairs.map((r) => r.work)])];
}

function best(s: SearchState): number[] | null {
  let out: number[] | null = null;
  for (const h of s.order) { const v = vectorOf(s.candidates[h]); if (v && (!out || compare(v, out) < 0)) out = v; }
  return out;
}

/* --- Registering what was made, and what was found ------------------------------------------------------------- */

/** A program made: by the start, a seed or an attempt. Its lineage: a restart or a seed is a root of its own; a mutation
    inherits its parent's roots; a recombination joins theirs. A hash already known keeps its first origin and lineage. */
export function register(s: SearchState, c: { hash: string; files: Readonly<Record<string, string>>; parents: readonly string[]; origin: string; root: boolean }): { duplicate: boolean } {
  if (s.candidates[c.hash]) { s.log.push({ event: 'duplicate', hash: c.hash, origin: c.origin }); return { duplicate: true }; }
  const roots = c.root ? [c.hash] : [...new Set(c.parents.flatMap((p) => s.candidates[p]?.roots ?? []))].sort();
  s.candidates[c.hash] = { hash: c.hash, files: { ...c.files }, parents: [...c.parents], roots: roots.length ? roots : [c.hash], origin: c.origin, seq: s.order.length,
    evaluation: null, stale: false, developed: false, repaired: false, diagnostics: [], usedAt: -1, operatorCursor: 0 };
  s.order.push(c.hash);
  return { duplicate: false };
}

/** A diagnostic for the next attempt of a candidate's line (a duplicate, an invalid patch, a failure), the latest kept. */
export function diagnose(s: SearchState, hash: string, text: string): void {
  const c = s.candidates[hash];
  if (!c) return;
  c.diagnostics.push(text);
  if (c.diagnostics.length > s.profile.diagnostics) c.diagnostics.splice(0, c.diagnostics.length - s.profile.diagnostics);
}

/** What a mutator answered to a plan, as the attempt's result: what the policy counts (quotas, generation misses, tried). */
export function responded(s: SearchState, plan: Plan, r: { kind: 'new'; hash: string } | { kind: 'duplicate'; hash: string } | { kind: 'invalid'; why: string } | { kind: 'transport'; why: string } | { kind: 'uncertain' }): void {
  /* A transport failure is the infrastructure's: no response, no quota consumed, never a miss of generation. */
  if (r.kind === 'transport') { s.log.push({ event: 'transport', attempt: plan.attempt, why: r.why }); return; }
  /* The quota is consumed when the response is registered - a duplicate or an invalid patch included; an uncertain call
     keeps it consumed (it is never dispatched again to give a quota back). */
  const parent = plan.parents[0];
  if (plan.turn === 'development' && parent) {
    const slot = s.development.find((d) => d.hash === parent);
    if (slot) { slot.quota--; if (slot.quota <= 0) { s.development = s.development.filter((d) => d !== slot); s.log.push({ event: 'development_done', hash: parent }); fill(s); } }
  }
  if (plan.turn === 'repair' && parent) {
    const slot = s.repairs.find((x) => x.work === parent);
    if (slot) { slot.quota--; if (slot.quota <= 0) { s.repairs = s.repairs.filter((x) => x !== slot); s.log.push({ event: 'repair_done', origin: slot.origin, work: slot.work }); } }
  }
  if (r.kind === 'uncertain') { s.log.push({ event: 'uncertain', attempt: plan.attempt }); return; }
  const key = plan.operator + ':' + (parent ? lineageKey(s.candidates[parent]?.roots ?? []) : 'restart');
  const list = (s.tried[key] ??= []);
  list.push({ hash: r.kind === 'invalid' ? null : r.hash, result: r.kind === 'new' ? 'made' : r.kind === 'duplicate' ? 'a duplicate of ' + r.hash : 'invalid: ' + r.why });
  if (list.length > s.profile.tried) list.splice(0, list.length - s.profile.tried);
  if (r.kind === 'duplicate' && parent) diagnose(s, parent, 'your previous answer from this program was ' + r.hash + ', a program already known: it was not run again');
  if (r.kind === 'invalid' && parent) diagnose(s, parent, 'your previous answer from this program was refused: ' + r.why);
  /* A miss of generation, unless it made a new program (whether it runs is known after its evaluation). */
  if (r.kind !== 'new') miss(s, r.kind === 'duplicate' ? 'a duplicate of ' + r.hash : 'invalid: ' + r.why);
}

function miss(s: SearchState, why: string): void {
  s.generation.misses++;
  s.generation.diagnostics.push(why);
  if (s.generation.diagnostics.length > s.profile.generationStall) s.generation.diagnostics.splice(0, s.generation.diagnostics.length - s.profile.generationStall);
  if (s.generation.misses >= s.profile.generationStall && s.generation.restartsLeft === 0) {
    s.generation.restartsLeft = s.profile.generationRestarts;
    s.generation.misses = 0;
    s.log.push({ event: 'generation_recovery', diagnostics: [...s.generation.diagnostics] });
  }
}

/** A candidate's evaluation, from an attempt or a re-evaluation: its admission (development, repair), the elites, the
    archive, and the progress of the block (only for a new hash: a re-evaluation updates evidence, never fills a block). */
export function evaluated(s: SearchState, hash: string, e: Evaluation, o: { plan: Plan | null; reevaluation: boolean }): void {
  const c = s.candidates[hash];
  if (!c) return;
  const before = best(s);
  const wasIncorrect = o.plan?.turn === 'repair';
  c.evaluation = e;
  c.stale = false;
  for (const d of e.diagnostics) diagnose(s, hash, d);
  if (!o.reevaluation) {
    if (e.executable) { s.generation.misses = 0; } else miss(s, 'it did not run: ' + (e.diagnostics[0] ?? 'no diagnostic'));
  }
  let progress = false;
  if (e.correct === 'yes') {
    if (!c.developed && !s.pending.includes(hash) && !s.development.some((d) => d.hash === hash)) {
      if (s.pending.length >= s.profile.pending) s.log.push({ event: 'not_admitted', hash, why: 'admission_capacity' });
      else { s.pending.push(hash); s.log.push({ event: 'queued', hash }); }
    }
    /* A repair that made a failed program correct frees its slot and is progress. */
    const slot = o.plan ? s.repairs.find((x) => x.work === o.plan!.parents[0]) : undefined;
    if (wasIncorrect && slot) { s.repairs = s.repairs.filter((x) => x !== slot); s.log.push({ event: 'repaired', origin: slot.origin, hash }); progress = true; }
    if (archive(s, hash)) progress = true;
  } else if (e.correct === 'no') {
    const slot = o.plan?.turn === 'repair' ? s.repairs.find((x) => x.work === o.plan!.parents[0]) : undefined;
    /* A repair still incorrect updates its slot's working version, on the same quota: never a slot of its own. */
    if (slot) { slot.work = hash; c.repaired = true; s.log.push({ event: 'repair_continues', origin: slot.origin, work: hash }); }
    else if (!c.repaired) {
      if (s.repairs.length >= s.profile.repair) s.log.push({ event: 'not_admitted_for_repair', hash, why: 'repair_capacity' });
      else { s.repairs.push({ origin: hash, work: hash, quota: s.profile.repairQuota }); c.repaired = true; s.log.push({ event: 'repair_admitted', hash }); }
    }
  }
  fill(s);
  elites(s);
  if (o.reevaluation) return;
  const p = s.progress;
  if (p.evaluations === 0) p.blockStart = before;
  if (progress) p.progressed = true;
  p.evaluations++;
  if (p.evaluations >= s.profile.block) {
    /* The block measured from its start: an improvement beyond the tolerance, a cell opened, a program repaired. */
    if (improved(best(s), p.blockStart, s.profile.tolerance)) p.progressed = true;
    closeBlock(s);
  }
}

/* A block closed: with progress or without; two in a row without start the development recovery. */
function closeBlock(s: SearchState): void {
  const p = s.progress;
  p.blocksWithout = p.progressed ? 0 : p.blocksWithout + 1;
  s.log.push({ event: 'block', progressed: p.progressed, without: p.blocksWithout });
  p.evaluations = 0;
  p.progressed = false;
  p.blockStart = best(s);
  if (p.blocksWithout >= s.profile.blocksWithoutProgress && p.recovery === null) {
    p.recovery = 0;
    p.blocksWithout = 0;
    s.log.push({ event: 'development_recovery' });
  }
}

/** Development slots filled by arrival from the queue: a candidate with its quota pending is never displaced. */
function fill(s: SearchState): void {
  while (s.development.length < s.profile.development && s.pending.length) {
    const hash = s.pending.shift()!;
    const c = s.candidates[hash];
    if (!c || c.developed) continue;
    c.developed = true;
    s.development.push({ hash, quota: s.profile.developmentQuota });
    s.log.push({ event: 'development_admitted', hash });
  }
}

/** The elites: the best correct candidates by quality, ties kept by registration - a selection, not a proof. */
function elites(s: SearchState): void {
  const ranked = s.order.filter((h) => vectorOf(s.candidates[h]) !== null)
    .sort((a, b) => compare(vectorOf(s.candidates[a])!, vectorOf(s.candidates[b])!) || s.candidates[a].seq - s.candidates[b].seq);
  s.elites = ranked.slice(0, s.profile.elites);
}

/** Into its cell, when it has a descriptor: the best by quality and, if there is room, the most recent of another
    lineage. Whether a cell was opened - an event, never a premium on its occupant's quality. */
function archive(s: SearchState, hash: string): boolean {
  const c = s.candidates[hash], key = c.evaluation?.descriptor;
  if (!key || vectorOf(c) === null || s.archivedCells.includes(key)) return false;
  const opened = !s.cells[key];
  if (opened) {
    const open = Object.keys(s.cells);
    if (open.length >= s.profile.maxCells) {
      /* Full: the least recently selected cell is archived, its record whole. */
      const old = open.sort((a, b) => s.cells[a].lastSelected - s.cells[b].lastSelected || s.cells[a].opened - s.cells[b].opened)[0];
      delete s.cells[old];
      s.archivedCells.push(old);
      s.log.push({ event: 'cell_archived', cell: old });
    }
    s.cells[key] = { occupants: [], lastSelected: -1, opened: s.attempts };
    s.log.push({ event: 'cell_opened', cell: key, hash });
  }
  const cell = s.cells[key];
  const all = [...new Set([...cell.occupants, hash])];
  const byQuality = [...all].sort((a, b) => compare(vectorOf(s.candidates[a])!, vectorOf(s.candidates[b])!) || s.candidates[a].seq - s.candidates[b].seq);
  const top = byQuality[0];
  const other = all.filter((h) => h !== top && !shareRoots(s.candidates[h], s.candidates[top])).sort((a, b) => s.candidates[b].seq - s.candidates[a].seq)[0];
  const keep = [top, ...(other ? [other] : [])];
  for (const h of byQuality) if (keep.length < s.profile.cellCapacity && !keep.includes(h)) keep.push(h);
  cell.occupants = keep.slice(0, s.profile.cellCapacity);
  return opened;
}

/* --- The next plan ------------------------------------------------------------------------------------------------ */

/** The next attempt: its turn, operator and parents. A recovery decides instead of the cycle while it lasts (the
    generation's first, the development's paused meanwhile). Nothing moves until it is dispatched (`dispatched`). */
export function next(s: SearchState): Plan {
  const attempt = 'attempt:' + (s.attempts + 1);
  let recovery: Plan['recovery'] = null, wanted: Turn, forceRewrite = false;
  if (s.generation.restartsLeft > 0) { wanted = 'restart'; recovery = 'generation'; }
  else if (s.progress.recovery !== null) {
    const step = s.profile.developmentRecovery[s.progress.recovery];
    wanted = step; recovery = 'development'; forceRewrite = step === 'development';
  } else wanted = s.profile.turns[s.cursors.turn % s.profile.turns.length];
  /* An empty set is replaced: development, exploitation, restart, in that order - never an incorrect program as an elite. */
  const order: Turn[] = [wanted, ...(['development', 'exploitation', 'restart'] as Turn[]).filter((t) => t !== wanted)];
  for (const turn of order) {
    const parent = turn === 'restart' ? null : pick(s, turn);
    if (turn !== 'restart' && parent === null) continue;
    let operator: Operator = turn === 'restart' ? 'restart' : turn === 'repair' ? 'repair'
      : forceRewrite ? 'rewrite' : s.profile.operators[s.candidates[parent!].operatorCursor % s.profile.operators.length];
    let parents = parent ? [parent] : [];
    if (operator === 'recombination') {
      const second = partner(s, parent!);
      if (second) parents = [parent!, second]; else operator = 'rewrite';
    }
    return { attempt, turn, operator, parents, recovery };
  }
  return { attempt, turn: 'restart', operator: 'restart', parents: [], recovery };
}

/** Exploitation's source this time: the archive when it alternates to it (or there are no elites), else the elites. */
const fromArchive = (s: SearchState): boolean => Object.values(s.cells).some((c) => c.occupants.length) && (s.cursors.exploitArchive || !s.elites.length);
const nextCell = (s: SearchState): string | undefined => Object.keys(s.cells).filter((k) => s.cells[k].occupants.length)
  .sort((a, b) => s.cells[a].lastSelected - s.cells[b].lastSelected || s.cells[a].opened - s.cells[b].opened)[0];

/** Whom a turn would take: development and repair in rotation over their slots; exploitation alternating the elites and
    the archive, its cells from the least recently selected and their occupants in rotation. */
function pick(s: SearchState, turn: Turn): string | null {
  if (turn === 'development') {
    const slots = s.development.filter((d) => d.quota > 0);
    return slots.length ? slots[s.cursors.development % slots.length].hash : null;
  }
  if (turn === 'repair') {
    const slots = s.repairs.filter((r) => r.quota > 0);
    return slots.length ? slots[s.cursors.repair % slots.length].work : null;
  }
  if (turn === 'exploitation') {
    if (fromArchive(s)) { const occ = s.cells[nextCell(s)!].occupants; return occ[s.cursors.cell % occ.length]; }
    return s.elites.length ? s.elites[s.cursors.elite % s.elites.length] : null;
  }
  return null;
}

/** A recombination's second parent: the correct active candidate least recently used, of another lineage; failing that,
    another hash; none, no recombination. */
function partner(s: SearchState, first: string): string | null {
  const a = s.candidates[first];
  const pool = active(s).filter((h) => h !== first && s.candidates[h]?.evaluation?.correct === 'yes' && !s.candidates[h].stale)
    .sort((x, y) => s.candidates[x].usedAt - s.candidates[y].usedAt || s.candidates[x].seq - s.candidates[y].seq);
  return pool.find((h) => !shareRoots(s.candidates[h], a)) ?? pool[0] ?? null;
}

/** A plan dispatched: what it moves - the ordinary turn cursor always, the rotation of the set it took from, its parents'
    use and the first one's operator cursor, and the recovery that decided it. */
export function dispatched(s: SearchState, plan: Plan): void {
  s.attempts++;
  s.cursors.turn++;
  if (plan.turn === 'development') s.cursors.development++;
  if (plan.turn === 'repair') s.cursors.repair++;
  if (plan.turn === 'exploitation') {
    if (fromArchive(s)) { const k = nextCell(s); if (k) s.cells[k].lastSelected = s.attempts; s.cursors.cell++; }
    else s.cursors.elite++;
    s.cursors.exploitArchive = !s.cursors.exploitArchive;
  }
  for (const p of plan.parents) { const c = s.candidates[p]; if (c) c.usedAt = s.attempts; }
  const c = plan.parents[0] ? s.candidates[plan.parents[0]] : undefined;
  if (c && plan.turn !== 'repair') c.operatorCursor++;
  if (plan.recovery === 'generation') s.generation.restartsLeft--;
  else if (plan.recovery === 'development' && s.progress.recovery !== null) {
    s.progress.recovery++;
    if (s.progress.recovery >= s.profile.developmentRecovery.length) {
      s.progress.recovery = null;
      s.progress.evaluations = 0; s.progress.progressed = false; s.progress.blockStart = best(s);
      s.log.push({ event: 'development_recovery_done' });
    }
  }
}

/** The candidates the search would go on from whose evidence is stale: re-evaluated first, by registration order. */
export function staleActive(s: SearchState): string[] {
  return active(s).filter((h) => s.candidates[h]?.stale).sort((a, b) => s.candidates[a].seq - s.candidates[b].seq);
}

/** Evidence of another evaluator, marked stale: not for elites, the archive or a comparison until measured again. */
export function markStale(s: SearchState, evaluator: string): number {
  let n = 0;
  for (const h of s.order) { const c = s.candidates[h]; if (c.evaluation && c.evaluation.evaluator !== evaluator) { c.stale = true; n++; } }
  elites(s);
  return n;
}

export const copyState = (s: SearchState): SearchState => cloneJson(s);
