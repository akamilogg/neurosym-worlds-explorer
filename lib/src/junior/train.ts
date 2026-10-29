import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { stableStringify } from '../core/hash.ts';
import type { CompetenceManifest } from './competence.ts';
import { selectionOverlap, type Dataset, type Example } from './distill.ts';
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

const MODULES = new Set(['q_proj', 'k_proj', 'v_proj', 'o_proj', 'gate_proj', 'up_proj', 'down_proj', 'in_proj_qkvz', 'in_proj_ba', 'out_proj']);

/** Everything wrong with a recipe for a package; empty: it may train. */
export function recipeProblems(raw: unknown, pkg: JuniorPackage): string[] {
  const r = raw as Recipe;
  const e: string[] = [];
  if (!r || r.format !== 'junior-recipe@1') return ['"format": "junior-recipe@1"'];
  if (r.method !== 'lora' && r.method !== 'qlora') e.push('"method": lora or qlora');
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
export function trainingRows(examplesDir: string, ds: Dataset, recipe: Recipe): TrainingRow[] | { error: string } {
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
  if (shared.length) return { state: 'refused', reason: 'the dataset shares groups with the probes that select juniors (' + shared.join(', ') + '): publish another condition that withdraws them from selection first', ...none };
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
  const child = normalizePackage({ ...parent, adapter, provenance: { parents: [executionHash(parent)], reason: 'trained on dataset ' + o.dataset.id + ' with ' + o.recipe.method,
    sources: ['dataset:' + o.dataset.id, 'recipe:' + createHash('sha256').update(stableStringify(o.recipe)).digest('hex'), 'training:' + key] } });
  return { state: 'finished', adapter, child, reason: null, capacity, gpu_hours: r.gpu_hours ?? null, steps: r.steps ?? null, checkpoint: r.checkpoint ?? null };
}
