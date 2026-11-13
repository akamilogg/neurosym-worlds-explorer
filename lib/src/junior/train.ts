import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { stableStringify } from '../core/hash.ts';
import type { CompetenceManifest } from './competence.ts';
import { selectionOverlap, type Dataset, type Example } from './distill.ts';
import { datasetRealizations } from './groups.ts';
import { LORA_MODULES, methodProgramProblems } from './method-program.ts';
import { maskBoundsProblems } from './mask.ts';
import { executionHash, normalizePackage, type BlobStore, type JuniorPackage } from './package.ts';
import { materialize } from './worker.ts';

/* ============================================================================
 * RETRAINING without breaking the computer (SPEC-METAPOLITICA-APRENDIZAJE §11, MA5): LoRA on Qwen's layers of the
 * combined model, the compiled layers and their DeltaNet heads frozen.
 *
 * A RECIPE (junior-recipe@1) names exactly what is trained - the layers by index and the modules in each - and is refused
 * when it reaches the circuit (the package's first `chip_layers` layers): a QLoRA is another recipe, quantizing Qwen only.
 * It names its seed, its rates and lengths, its loss mask (the answer only) and the states of example it admits.
 *
 * A TRAINING is an act of the world: the dataset by its hash, the recipe, the parent package; a job of its own process on
 * the training GPU (junior_train.py), never the inference worker. It is reserved before it starts (its GPU hours), its
 * capacity measured first (the peak memory with its lengths and batch: what does not fit is refused with that diagnosis,
 * nothing changed silently), its checkpoints kept so that asked again it goes on from the last; only a finished run
 * publishes its adapter, by hash, and a child package. A dataset that shares a group with the probes of selection is
 * refused (§6.4), its examples kept.
 * ========================================================================== */

export const TRAIN_PY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'junior_train.py');

export interface Recipe {
  readonly format: 'junior-recipe@1';
  readonly method: 'lora' | 'qlora';
  /** Qwen's layers trained, by index in the combined model: every one at or past the circuit's. */
  readonly layers: readonly number[];
  /** The modules trained in each of those layers (q_proj, k_proj, v_proj, o_proj, gate_proj, up_proj, down_proj...). */
  readonly modules: readonly string[];
  readonly rank: number;
  readonly alpha: number;
  readonly dropout: number;
  readonly learning_rate: number;
  readonly epochs: number;
  readonly batch: number;
  readonly max_length: number;
  readonly seed: number;
  /** The loss falls on the answer only: tool results and the prompt are context. */
  readonly mask: 'answer';
  readonly admits: readonly ('verified' | 'demonstration')[];
  /** Most GPU hours it may take: what is reserved. */
  readonly max_gpu_hours: number;
}

const MODULES = LORA_MODULES;

/** A recipe by program (SPEC-INVESTIGACION-EXTERNA §8.2): the method is the researcher's program, run under a profile the
    operator enabled; the host decides what data it reads (the dataset's rows, of examples the recipe admits) and imports
    what it makes, learned from data. No native recipe is registered for it. */
export interface ProgramRecipe {
  readonly format: 'junior-recipe@1';
  readonly method: 'program';
  readonly program: import('./method-program.ts').MethodProgram;
  readonly admits: readonly ('verified' | 'demonstration')[];
}

export const isProgramRecipe = (r: unknown): r is ProgramRecipe => !!r && (r as { method?: unknown }).method === 'program';

/** deletion@1 with SFT (SPEC-EDICION-PESOS §15.3, WE7): a training that learns which weights of gate_proj to delete - a mask
    - in the layers it names, past the circuit's. The host runs it as a method program (its code, programs/deletion_sft.py,
    on the general executor under the training profile named), its capacity measured first; what it makes is imported as
    mask@1, learned from data. Its bounds: never laxer than the condition's "masks". */
export interface DeletionRecipe {
  readonly format: 'junior-recipe@1';
  readonly method: 'deletion@1';
  readonly signal: 'sft';
  /** The execution profile it runs under (the operator's training profile). */
  readonly profile: string;
  readonly layers: readonly number[];
  readonly bounds: import('./mask.ts').MaskBounds;
  /** The fraction of each module's weights whose logit starts below zero (Wanda's lowest): within its bound per module. */
  readonly init_fraction: number;
  readonly epochs: number;
  readonly batch: number;
  readonly max_length: number;
  readonly learning_rate: number;
  /** The mask's slope, rising linearly over the steps. */
  readonly beta: { readonly start: number; readonly end: number };
  readonly seed: number;
  readonly mask: 'answer';
  readonly admits: readonly ('verified' | 'demonstration')[];
  readonly max_gpu_hours: number;
}

export const isDeletionRecipe = (r: unknown): r is DeletionRecipe => !!r && (r as { method?: unknown }).method === 'deletion@1';

/** Everything wrong with a deletion@1 recipe for a package (and the condition's bounds, when given). */
export function deletionRecipeProblems(raw: unknown, pkg: JuniorPackage, authorized?: import('./mask.ts').MaskBounds | null): string[] {
  const r = raw as DeletionRecipe;
  const e: string[] = [];
  const known = ['format', 'method', 'signal', 'profile', 'layers', 'bounds', 'init_fraction', 'epochs', 'batch', 'max_length', 'learning_rate', 'beta', 'seed', 'mask', 'admits', 'max_gpu_hours'];
  for (const k of Object.keys(r ?? {})) if (!known.includes(k)) e.push('"' + k + '": unknown');
  if (r?.signal !== 'sft') e.push('"signal": "sft" (GRPO with probe rewards is another stage, not built yet)');
  if (typeof r?.profile !== 'string' || !r.profile) e.push('"profile": the training profile it runs under');
  const chip = Number((pkg.execution.circuit as Record<string, unknown>).chip_layers);
  if (!Number.isInteger(chip) || chip < 0) e.push('the package\'s circuit does not say its chip_layers: what may be deleted cannot be told');
  if (!Array.isArray(r?.layers) || !r.layers.length || r.layers.some((l) => !Number.isInteger(l) || l < 0) || new Set(r.layers).size !== r.layers.length) e.push('"layers": the indices of the layers whose gate_proj it masks, once each');
  else if (Number.isInteger(chip) && r.layers.some((l) => l < chip)) e.push('"layers": ' + r.layers.filter((l) => l < chip).join(', ') + ' belong to the circuit (its first ' + chip + '): the computer is never touched');
  const bp = maskBoundsProblems(r?.bounds, '"bounds"');
  e.push(...bp);
  if (!bp.length && authorized && (r.bounds.per_module.max_fraction > authorized.per_module.max_fraction || r.bounds.total.max_fraction > authorized.total.max_fraction)) e.push('"bounds": laxer than the condition\'s "masks"');
  if (!(typeof r?.init_fraction === 'number' && r.init_fraction >= 0 && r.init_fraction <= 1)) e.push('"init_fraction": a fraction in [0, 1]');
  else if (!bp.length && r.init_fraction > r.bounds.per_module.max_fraction) e.push('"init_fraction": within its bound per module (' + r.bounds.per_module.max_fraction + ')');
  for (const k of ['epochs', 'batch', 'max_length'] as const) if (!Number.isInteger(r?.[k]) || r[k] <= 0) e.push('"' + k + '": a whole number above 0');
  if (!(r?.learning_rate > 0)) e.push('"learning_rate": above 0');
  if (!r?.beta || !(r.beta.start > 0) || !(r.beta.end >= r.beta.start)) e.push('"beta": {"start" > 0, "end" >= start}');
  if (!Number.isInteger(r?.seed)) e.push('"seed": an integer');
  if (r?.mask !== 'answer') e.push('"mask": "answer" (the loss on the answer only)');
  if (!Array.isArray(r?.admits) || !r.admits.length || r.admits.some((a) => a !== 'verified' && a !== 'demonstration')) e.push('"admits": verified, and demonstration only when said');
  if (!(r?.max_gpu_hours > 0)) e.push('"max_gpu_hours": what is reserved for it');
  if (pkg.adapter !== null) e.push('the parent already has an adapter: a mask is trained from a package without one');
  return e;
}

/** The program a deletion@1 recipe runs, for its phase: the host's code, its parameters the recipe's - by content, so the
    same recipe is the same job. */
export const DELETION_PY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'programs', 'deletion_sft.py');
export function deletionProgram(r: DeletionRecipe, phase: 'capacity' | 'train', backend: 'fake' | 'qwenputer'): import('./method-program.ts').MethodProgram {
  return { format: 'method-program@1', entrypoint: 'main.py', files: { 'main.py': fs.readFileSync(DELETION_PY, 'utf8') }, profile: r.profile, inputs: ['dataset.jsonl'],
    parameters: { phase, backend, layers: r.layers, bounds: r.bounds, init_fraction: r.init_fraction, epochs: r.epochs, batch: r.batch, max_length: r.max_length, learning_rate: r.learning_rate, beta: r.beta },
    seed: r.seed, output_format: phase === 'capacity' ? 'capacity@1' : 'mask@1' };
}

/** Everything wrong with a recipe for a package; empty: it may train. */
export function recipeProblems(raw: unknown, pkg: JuniorPackage): string[] {
  const r = raw as Recipe;
  const e: string[] = [];
  if (!r || r.format !== 'junior-recipe@1') return ['"format": "junior-recipe@1"'];
  if (isDeletionRecipe(r)) return deletionRecipeProblems(r, pkg);
  if (isProgramRecipe(r)) {
    const p = r as unknown as ProgramRecipe;
    const out = methodProgramProblems(p.program).map((x) => '"program": ' + x);
    if (!Array.isArray(p.admits) || !p.admits.length || p.admits.some((a) => a !== 'verified' && a !== 'demonstration')) out.push('"admits": verified, and demonstration only when said');
    if (p.program && Array.isArray(p.program.inputs) && !p.program.inputs.includes('dataset.jsonl')) out.push('"program.inputs": it learns from data: dataset.jsonl, the rows the host mounts');
    if (pkg.adapter !== null) out.push('the parent already has an adapter: train from a package without one');
    return out;
  }
  if (r.method !== 'lora' && r.method !== 'qlora') e.push('"method": lora, qlora, deletion@1 or program');
  const chip = Number((pkg.execution.circuit as Record<string, unknown>).chip_layers);
  if (!Number.isInteger(chip) || chip < 0) e.push('the package\'s circuit does not say its chip_layers: what may be trained cannot be told from what may not');
  if (!Array.isArray(r.layers) || !r.layers.length || r.layers.some((l) => !Number.isInteger(l) || l < 0)) e.push('"layers": the indices of the layers trained');
  else if (Number.isInteger(chip) && r.layers.some((l) => l < chip)) e.push('"layers": ' + r.layers.filter((l) => l < chip).join(', ') + ' are the circuit\'s (its first ' + chip + '): the computer is never trained');
  if (!Array.isArray(r.modules) || !r.modules.length || r.modules.some((m) => !MODULES.has(m))) e.push('"modules": among ' + [...MODULES].join(', '));
  for (const k of ['rank', 'alpha', 'epochs', 'batch', 'max_length'] as const) if (!Number.isInteger(r[k]) || r[k] <= 0) e.push('"' + k + '": a whole number above 0');
  if (!(r.learning_rate > 0) || !(r.dropout >= 0 && r.dropout < 1)) e.push('"learning_rate" above 0 and "dropout" in [0, 1)');
  if (!Number.isInteger(r.seed)) e.push('"seed": an integer');
  if (r.mask !== 'answer') e.push('"mask": "answer" (the loss on the answer only)');
  if (!Array.isArray(r.admits) || !r.admits.length || r.admits.some((a) => a !== 'verified' && a !== 'demonstration')) e.push('"admits": verified, and demonstration only when said');
  if (!(r.max_gpu_hours > 0)) e.push('"max_gpu_hours": what is reserved for it');
  if (pkg.adapter !== null) e.push('the parent already has an adapter: train from a package without one (a second adapter on top is another recipe)');
  return e;
}

/** A row: the input exactly as the junior is asked it, the memory calls the answer needed - each a decision, its result
    what the junior then read - and the answer. The trainer translates each call into the junior's own protocol. */
export interface TrainingRow {
  readonly id: string; readonly system: string; readonly user: readonly string[];
  readonly calls: readonly { readonly op: string; readonly name?: string; readonly text?: string; readonly result: string }[];
  readonly answer: string;
}

/** A dataset's rows as the trainer reads them: the effective sequence of decisions and observations, never the answer
    alone - an answer that read its memory is trained with what it read in its context. */
export function trainingRows(examplesDir: string, ds: Dataset, recipe: Pick<Recipe, 'admits'>): TrainingRow[] | { error: string } {
  const byId = new Map<string, Example>();
  for (const f of fs.existsSync(examplesDir) ? fs.readdirSync(examplesDir) : []) {
    try { const e = JSON.parse(fs.readFileSync(path.join(examplesDir, f), 'utf8')) as Example; byId.set(e.id, e); } catch { /* not an example */ }
  }
  const rows: TrainingRow[] = [];
  for (const id of ds.examples) {
    const e = byId.get(id);
    if (!e) return { error: 'no example ' + id };
    if (!recipe.admits.includes(e.state as 'verified')) return { error: 'example ' + id + ' is ' + e.state + ': the recipe does not admit it' };
    if (e.target === null) return { error: 'example ' + id + ' has no target' };
    const calls = e.teacher.memory.calls.map((c) => ({ op: c.op, ...(c.name !== undefined ? { name: c.name } : {}), ...(c.text !== undefined ? { text: c.text } : {}), result: c.result }));
    rows.push({ id, system: e.input.system, user: [...e.input.user.parts], calls, answer: e.target });
  }
  return rows;
}

export interface TrainResult { readonly state: 'finished' | 'refused' | 'failed' | 'stopped'; readonly adapter: string | null; readonly child: JuniorPackage | null; readonly reason: string | null;
  readonly capacity: unknown; readonly gpu_hours: number | null; readonly steps: number | null; readonly checkpoint: string | null }

/** Runs the trainer once, one JSON in and one out, killed with the signal. */
function runTrainer(python: readonly string[], args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, any>> {
  return new Promise((resolve) => {
    const child = spawn(python[0], [...python.slice(1), TRAIN_PY], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const stop = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', stop);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => resolve({ state: 'failed', reason: 'the trainer did not start: ' + e.message }));
    child.on('close', (code) => {
      signal?.removeEventListener('abort', stop);
      try { resolve(JSON.parse(out.trim().split('\n').pop() ?? '')); }
      catch { resolve({ state: signal?.aborted ? 'stopped' : 'failed', reason: 'the trainer answered nothing readable (exit ' + code + ')' + (err ? ': ' + err.trim().slice(-400) : '') }); }
    });
    child.stdin.end(JSON.stringify(args));
  });
}

export { datasetRealizations } from './groups.ts';

/** A training from a parent package and a dataset: capacity first, then the run (going on from its last checkpoint), then
    the adapter stored as a tree blob and the child package. Refused before anything runs when the recipe reaches the
    circuit or the dataset shares a group with the selection probes. */
export async function train(o: { python: readonly string[]; backend: 'fake' | 'qwenputer'; work: string; store: BlobStore; parent: JuniorPackage; dataset: Dataset; examplesDir: string;
  recipe: Recipe; manifest: CompetenceManifest; signal?: AbortSignal }): Promise<TrainResult> {
  const none = { adapter: null, child: null, capacity: null, gpu_hours: null, steps: null, checkpoint: null };
  const parent = normalizePackage(o.parent);
  const problems = recipeProblems(o.recipe, parent);
  if (problems.length) return { state: 'refused', reason: 'the recipe: ' + problems.join('; '), ...none };
  const shared = selectionOverlap(o.dataset, o.manifest);
  if (shared.length) return { state: 'refused', reason: 'the dataset shares groups with the cases that select or confirm juniors (' + shared.join(', ') + '): publish another condition that withdraws them from selection first', ...none };
  const rows = trainingRows(o.examplesDir, o.dataset, o.recipe);
  if ('error' in rows) return { state: 'refused', reason: rows.error, ...none };
  const key = createHash('sha256').update(stableStringify({ parent: executionHash(parent), dataset: o.dataset.id, recipe: o.recipe })).digest('hex');
  const dir = path.join(o.work, 'trainings', key.slice(0, 24));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'rows.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const files = o.backend === 'fake' ? { base: null, firmware: null } : materialize(parent, executionHash(parent), o.store, path.join(o.work, 'packages'));
  const common = { backend: o.backend, base: files.base, circuit: parent.execution.circuit, prompt: parent.prompt, recipe: o.recipe, rows: path.join(dir, 'rows.jsonl'), dir };
  const capacity = await runTrainer(o.python, { op: 'capacity', ...common }, o.signal);
  if (capacity.state !== 'fits') return { state: capacity.state === 'does_not_fit' ? 'refused' : 'failed', reason: capacity.reason ?? 'the capacity was not measured', ...none, capacity };
  const r = await runTrainer(o.python, { op: 'train', ...common }, o.signal);
  if (r.state !== 'finished') return { state: o.signal?.aborted ? 'stopped' : r.state === 'stopped' ? 'stopped' : 'failed', reason: r.reason ?? null, ...none, capacity, gpu_hours: r.gpu_hours ?? null, steps: r.steps ?? null, checkpoint: r.checkpoint ?? null };
  const adapter = o.store.putTree(path.join(dir, 'adapter'));
  /* The realizations of what it learned from (SPEC-VALIDEZ-MEDIDA §5.2): the runs its examples were cut from; none declared
     when one of them cannot be read - the confirmation refuses what does not say where it learned. */
  const learned = datasetRealizations(o.examplesDir, o.dataset);
  const child = normalizePackage({ ...parent, adapter, provenance: { parents: [executionHash(parent)], reason: 'trained on dataset ' + o.dataset.id + ' with ' + o.recipe.method,
    sources: ['dataset:' + o.dataset.id, 'recipe:' + createHash('sha256').update(stableStringify(o.recipe)).digest('hex'), 'training:' + key],
    ...(learned ? { realizations: learned } : {}) } });
  return { state: 'finished', adapter, child, reason: null, capacity, gpu_hours: r.gpu_hours ?? null, steps: r.steps ?? null, checkpoint: r.checkpoint ?? null };
}
