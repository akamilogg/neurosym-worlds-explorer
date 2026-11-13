import path from 'node:path';
import { createHash } from 'node:crypto';
import { stableStringify } from '../core/hash.ts';
import type { Availability, ProgramLimits } from './isolation.ts';
import { modulesOfOutputs, putEdit, type EditDraft, type Hypothesis } from './weights.ts';
import { normalizePackage, type BlobStore, type JuniorPackage } from './package.ts';

/* ============================================================================
 * A METHOD AS A PROGRAM (SPEC-INVESTIGACION-EXTERNA §8, IE5): a technique the researcher found and adapted, written as code
 * the host runs under a profile the operator enabled, never registered as a native recipe of the harness.
 *
 *   method-program@1     its code (an entry file and the files it reads), its declared inputs, parameters, seed and the
 *                        format of its product - by content: an edit of it is another version, another identity
 *   execution profile    the operator's (an interpreter and the dependencies it has, by version; CPU, memory, GPU, time,
 *                        outputs): what the program may count on, never something it installs
 *   ABI                  the host writes inputs/job.json (hashes, parameters, seed, profile, limits) and mounts inputs/ and
 *                        the start read-only; the program writes out/, and out/result.json says its format and products.
 *                        Its outputs are never the world's verdict: the fixed evaluator measures what it made.
 *
 * It runs only in a backend whose isolation is proved (isolation.ts: Linux namespaces and Landlock); anywhere else -
 * Windows, a kernel without Landlock, a GPU profile, whose isolation no test proves yet - it is `unavailable`, with why.
 * What a product learned is written by the HOST when it imports it (`learned`), from how it was asked - a recipe of
 * `train` learns from data, an `edit` does not - never by the program.
 * ========================================================================== */

export const METHOD_PROGRAM = 'method-program@1';
export type OutputFormat = 'weight-edit-set@1' | 'lora-adapter' | 'mask@1';
const FORMATS: readonly OutputFormat[] = ['weight-edit-set@1', 'lora-adapter', 'mask@1'];
/** The formats this host imports: a set of edits, a LoRA adapter (importAdapter) and a mask (importMask, mask.ts,
    SPEC-EDICION-PESOS WE7a) - each with its own checks. */
export const IMPORTABLE: ReadonlySet<OutputFormat> = new Set(['weight-edit-set@1', 'lora-adapter', 'mask@1']);

export interface MethodProgram {
  readonly format: typeof METHOD_PROGRAM;
  readonly entrypoint: string;
  /** Its files by name (the entry among them): text. */
  readonly files: Readonly<Record<string, string>>;
  readonly profile: string;
  /** The names of the inputs it reads: exactly these are mounted. */
  readonly inputs: readonly string[];
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly seed: number;
  readonly output_format: OutputFormat;
  /** Where it came from (citations): its origin explained, never a permission. */
  readonly cites?: readonly string[];
}

export interface ExecutionProfile {
  readonly id: string;
  /** The dependencies it offers, by version (part of its identity). */
  readonly dependencies: Readonly<Record<string, string>>;
  readonly limits: ProgramLimits;
  /** A GPU profile: no isolation test proves one yet, so it runs no acquired program (§8.1). */
  readonly gpu: boolean;
}

const NAME = /^[A-Za-z0-9_][\w.-]*$/;

export function methodProgramProblems(raw: unknown): string[] {
  const p = raw as Record<string, any>;
  if (!p || p.format !== METHOD_PROGRAM) return ['"format": "' + METHOD_PROGRAM + '"'];
  const e: string[] = [];
  for (const k of Object.keys(p)) if (!['format', 'entrypoint', 'files', 'profile', 'inputs', 'parameters', 'seed', 'output_format', 'cites'].includes(k)) e.push('"' + k + '": unknown');
  if (!p.files || typeof p.files !== 'object' || !Object.keys(p.files).length || !Object.entries(p.files).every(([k, v]) => NAME.test(k) && typeof v === 'string')) e.push('"files": {"<name>": "<text>"}, names of letters, digits, _ . -');
  if (typeof p.entrypoint !== 'string' || !p.files?.[p.entrypoint]) e.push('"entrypoint": one of its files');
  if (typeof p.profile !== 'string' || !p.profile) e.push('"profile": one the operator enabled');
  if (!Array.isArray(p.inputs) || !p.inputs.every((x: unknown) => typeof x === 'string' && NAME.test(x) && x !== 'job.json' && !String(x).startsWith('prog.'))) e.push('"inputs": the names it reads (not job.json, not prog.*)');
  if (!p.parameters || typeof p.parameters !== 'object' || Array.isArray(p.parameters)) e.push('"parameters": an object');
  if (!Number.isInteger(p.seed)) e.push('"seed": a whole number');
  if (!FORMATS.includes(p.output_format)) e.push('"output_format": ' + FORMATS.join(', '));
  if (p.cites !== undefined && (!Array.isArray(p.cites) || !p.cites.every((x: unknown) => typeof x === 'string'))) e.push('"cites": references');
  return e;
}

export function profileProblems(raw: unknown): string[] {
  const p = raw as Record<string, any>;
  const e: string[] = [];
  if (!p || typeof p.id !== 'string' || !/^[a-z][\w.-]*$/.test(p.id)) e.push('"id"');
  if (!p?.dependencies || typeof p.dependencies !== 'object' || !Object.values(p.dependencies).every((v) => typeof v === 'string')) e.push('"dependencies": {"<package>": "<version>"}');
  const l = p?.limits ?? {};
  for (const k of ['timeout_ms', 'memory_bytes', 'cpu_seconds', 'output_bytes']) if (!(Number.isInteger(l[k]) && l[k] > 0)) e.push('"limits.' + k + '"');
  if (typeof p?.gpu !== 'boolean') e.push('"gpu": true or false');
  return e;
}

const sha = (v: unknown): string => createHash('sha256').update(typeof v === 'string' || Buffer.isBuffer(v) ? v : stableStringify(v)).digest('hex');
/** A program by its content: any edit of it is another identity. */
export const programId = (p: MethodProgram): string => sha({ ...p });
export const profileIdentity = (p: ExecutionProfile): string => sha({ id: p.id, dependencies: p.dependencies, limits: p.limits, gpu: p.gpu });

export interface ProgramJob {
  readonly state: 'finished' | 'failed' | 'timeout' | 'refused' | 'unavailable';
  readonly job: string;
  readonly reason: string | null;
  readonly format?: OutputFormat;
  /** Its products, by their path in out/. */
  readonly products?: Readonly<Record<string, Buffer>>;
  /** What it was given, as mounted (its inputs, job.json, its other files): kept with what it made, so it can be run again. */
  readonly mounted?: Readonly<Record<string, Buffer>>;
  readonly wall_ms?: number;
}

/** A job's identity: the program, its inputs, the start, the profile, its parameters and seed (§8.1). A checkpoint
    resumes only the same identity. */
export function jobIdentity(p: MethodProgram, inputs: Readonly<Record<string, Buffer>>, start: string, profile: ExecutionProfile): string {
  return sha({ contract: METHOD_PROGRAM, program: programId(p), inputs: Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, sha(v)]).sort()), start, profile: profileIdentity(profile),
    parameters: p.parameters, seed: p.seed });
}

/** Runs a program under its profile, where an isolated backend is proved: its inputs exactly the declared ones, job.json
    beside them, its other files as prog.<name>; its result.json read and checked (format, products present). Never
    throws: what happened is the answer. */
export async function runMethodProgram(o: { readonly program: MethodProgram; readonly profiles: readonly ExecutionProfile[]; readonly inputs: Readonly<Record<string, Buffer>>;
  readonly start: string; readonly startDir: string; readonly availability: Availability;
  /** Where jobs keep their checkpoint/, one folder per job identity: only the same job goes on from it (§8.1). */
  readonly checkpoints?: string }): Promise<ProgramJob> {
  const p = o.program;
  const problems = methodProgramProblems(p);
  const profile = o.profiles.find((x) => x.id === p?.profile);
  const job = problems.length || !profile ? 'refused' : jobIdentity(p, o.inputs, o.start, profile);
  if (problems.length) return { state: 'refused', job, reason: 'the program: ' + problems.join('; ') };
  if (!profile) return { state: 'refused', job, reason: 'no profile ' + p.profile + ' enabled here (' + (o.profiles.map((x) => x.id).join(', ') || 'none') + ')' };
  if (profile.gpu) return { state: 'unavailable', job, reason: 'a GPU profile runs no acquired program until a test proves its isolation (SPEC-INVESTIGACION-EXTERNA §8.1)' };
  if (!o.availability.available) return { state: 'unavailable', job, reason: 'no isolated backend here: ' + o.availability.reason };
  const given = Object.keys(o.inputs).sort(), declared = [...p.inputs].sort();
  if (stableStringify(given) !== stableStringify(declared)) return { state: 'refused', job, reason: 'its inputs are exactly those it declares (' + declared.join(', ') + '); given ' + given.join(', ') };
  const jobFile = { contract: METHOD_PROGRAM, job, program: programId(p), inputs: Object.fromEntries(given.map((k) => [k, sha(o.inputs[k])])), start: o.start, profile: { id: profile.id, identity: profileIdentity(profile), dependencies: profile.dependencies },
    parameters: p.parameters, seed: p.seed, limits: profile.limits, output_format: p.output_format, checkpoint: 'checkpoint/' };
  const mounted: Record<string, Buffer> = { ...o.inputs, 'job.json': Buffer.from(JSON.stringify(jobFile, null, 2)) };
  for (const [name, text] of Object.entries(p.files)) if (name !== p.entrypoint) mounted['prog.' + name] = Buffer.from(text, 'utf8');
  const r = await o.availability.backend.run({ code: p.files[p.entrypoint], inputs: mounted, base: o.startDir, limits: profile.limits,
    ...(o.checkpoints ? { checkpoint: path.join(o.checkpoints, job.slice(0, 32)) } : {}) });
  if (r.state !== 'finished') return { state: r.state, job, reason: r.reason, wall_ms: r.wall_ms };
  let result: { format?: unknown; products?: unknown };
  try { result = JSON.parse((r.outputs['result.json'] ?? Buffer.from('')).toString('utf8')); } catch { return { state: 'failed', job, reason: 'it wrote no readable out/result.json ({"format", "products"})', wall_ms: r.wall_ms }; }
  if (result.format !== p.output_format) return { state: 'failed', job, reason: 'out/result.json says ' + String(result.format) + ', the program declares ' + p.output_format, wall_ms: r.wall_ms };
  const listed = Array.isArray(result.products) ? result.products.map(String) : [];
  const missing = listed.filter((f) => !r.outputs[f]);
  if (!listed.length || missing.length) return { state: 'failed', job, reason: missing.length ? 'products listed and not written: ' + missing.join(', ') : 'out/result.json lists no product', wall_ms: r.wall_ms };
  return { state: 'finished', job, reason: null, format: p.output_format, products: Object.fromEntries(listed.map((f) => [f, r.outputs[f]])), mounted, wall_ms: r.wall_ms };
}

/** A finished job's product imported as an edit of the start: checked like any edit (modules, circuit, encodings), its
    program and job recorded as its inputs. Only the formats this host can verify are imported. */
export function importProduct(store: BlobStore, start: JuniorPackage, job: ProgramJob, o: { readonly program: MethodProgram; readonly backend: string; readonly hypothesis: Hypothesis }): { id: string } | { problems: string[] } {
  if (job.state !== 'finished' || !job.products || !job.format) return { problems: ['nothing to import: the job ' + job.state + (job.reason ? ' (' + job.reason + ')' : '')] };
  if (!IMPORTABLE.has(job.format)) return { problems: ['a product in ' + job.format + ' is not importable here yet (importable: ' + [...IMPORTABLE].join(', ') + ')'] };
  if (job.format === 'lora-adapter') return { problems: ['a LoRA adapter is not an edit: it is imported as the adapter of a child (importAdapter)'] };
  if (job.format === 'mask@1') return { problems: ['a mask is not an edit: it is imported as the adapter of a child (importMask)'] };
  const read = modulesOfOutputs(job.products);
  if ('problems' in read) return read;
  const p = normalizePackage(start);
  const chip = Number((p.execution.circuit as Record<string, unknown>).chip_layers);
  /* Its code and everything it was given, as an edit of origin "program" keeps them: run again on them, it must give the same. */
  const draft: EditDraft = { modules: read.modules, hypothesis: o.hypothesis, authorship: 'strong',
    inputs: { ...(job.mounted ?? {}), 'program.py': Buffer.from(o.program.files[o.program.entrypoint], 'utf8') },
    origin: { kind: 'program', backend: o.backend, base: p.base, inputs: {} } };
  return putEdit(store, draft, chip, { programs: true });
}

/** The modules a LoRA may adapt (the junior's recipes and a program's adapter alike). */
export const LORA_MODULES: ReadonlySet<string> = new Set(['q_proj', 'k_proj', 'v_proj', 'o_proj', 'gate_proj', 'up_proj', 'down_proj', 'in_proj_qkvz', 'in_proj_ba', 'out_proj']);

/** A safetensors file's header (its tensors by name: dtype, shape, offsets), read without its data; or why it is not one. */
export function safetensorsHeader(bytes: Buffer): Record<string, { dtype: string; shape: number[]; data_offsets: [number, number] }> | { problem: string } {
  if (bytes.length < 8) return { problem: 'too short to be a safetensors file' };
  const n = Number(bytes.readBigUInt64LE(0));
  if (!Number.isSafeInteger(n) || n <= 0 || 8 + n > bytes.length) return { problem: 'its header length does not fit the file' };
  let h: Record<string, any>;
  try { h = JSON.parse(bytes.subarray(8, 8 + n).toString('utf8')); } catch { return { problem: 'its header is not JSON' }; }
  const data = bytes.length - 8 - n;
  const out: Record<string, { dtype: string; shape: number[]; data_offsets: [number, number] }> = {};
  for (const [name, t] of Object.entries(h)) {
    if (name === '__metadata__') continue;
    if (!t || typeof t.dtype !== 'string' || !Array.isArray(t.shape) || !t.shape.every((d: unknown) => Number.isInteger(d) && (d as number) >= 0)
      || !Array.isArray(t.data_offsets) || t.data_offsets.length !== 2 || !(t.data_offsets[0] >= 0 && t.data_offsets[1] >= t.data_offsets[0] && t.data_offsets[1] <= data)) return { problem: 'tensor ' + name + ' is not described whole' };
    out[name] = { dtype: t.dtype, shape: t.shape, data_offsets: [t.data_offsets[0], t.data_offsets[1]] };
  }
  return out;
}

/** The base's dimensions, from its config.json, when the store has it: what each module's adapter must fit. */
export interface BaseDims { readonly layers: number; readonly hidden: number; readonly intermediate: number; readonly q: number; readonly kv: number }
export function baseDimsOf(config: Record<string, any> | null): BaseDims | null {
  const c = config?.text_config ?? config;
  const n = (k: string): number | null => (Number.isInteger(c?.[k]) && c[k] > 0 ? c[k] as number : null);
  const layers = n('num_hidden_layers'), hidden = n('hidden_size'), intermediate = n('intermediate_size'), heads = n('num_attention_heads');
  if (!layers || !hidden || !intermediate || !heads) return null;
  const head = n('head_dim') ?? hidden / heads;
  return { layers, hidden, intermediate, q: heads * head, kv: (n('num_key_value_heads') ?? heads) * head };
}
const DIMS: Readonly<Record<string, (d: BaseDims) => [number, number]>> = {
  q_proj: (d) => [d.hidden, d.q], k_proj: (d) => [d.hidden, d.kv], v_proj: (d) => [d.hidden, d.kv], o_proj: (d) => [d.q, d.hidden],
  gate_proj: (d) => [d.hidden, d.intermediate], up_proj: (d) => [d.hidden, d.intermediate], down_proj: (d) => [d.intermediate, d.hidden]
};
const DTYPES = new Set(['F16', 'BF16', 'F32']);

/** What is wrong with a LoRA adapter a program made (SPEC-INVESTIGACION-EXTERNA §8.2): its config (a plain LoRA - rank,
    alpha, its modules among those a recipe may adapt, nothing saved whole, no bias) and its tensors read from the header
    (only lora_A and lora_B of layers past the circuit's, their rank the config's, their shapes the base's where its
    dimensions are known). Empty: it may be imported. */
export function loraProblems(products: Readonly<Record<string, Buffer>>, chip: number, dims: BaseDims | null): string[] {
  const p: string[] = [];
  const cfgBytes = products['adapter_config.json'], weights = products['adapter_model.safetensors'];
  if (!cfgBytes || !weights) return ['a LoRA adapter is adapter_config.json and adapter_model.safetensors'];
  const extra = Object.keys(products).filter((f) => f !== 'adapter_config.json' && f !== 'adapter_model.safetensors' && f !== 'README.md');
  if (extra.length) p.push('files that are not the adapter: ' + extra.join(', '));
  let c: Record<string, any>;
  try { c = JSON.parse(cfgBytes.toString('utf8')); } catch { return ['adapter_config.json is not JSON']; }
  if (c.peft_type !== undefined && c.peft_type !== 'LORA') p.push('"peft_type": LORA (' + String(c.peft_type) + ' is another method)');
  if (!Number.isInteger(c.r) || c.r <= 0) p.push('"r": its rank, a whole number above 0');
  if (!(Number(c.lora_alpha) > 0)) p.push('"lora_alpha": above 0');
  const targets: string[] = Array.isArray(c.target_modules) ? c.target_modules.map(String) : [];
  if (!targets.length || targets.some((m) => !LORA_MODULES.has(m))) p.push('"target_modules": among ' + [...LORA_MODULES].join(', '));
  if (c.modules_to_save !== undefined && c.modules_to_save !== null && !(Array.isArray(c.modules_to_save) && !c.modules_to_save.length)) p.push('"modules_to_save": an adapter saves no module whole');
  if (c.bias !== undefined && c.bias !== 'none') p.push('"bias": none');
  if (c.use_dora) p.push('"use_dora": a plain LoRA');
  const header = safetensorsHeader(weights);
  if ('problem' in header) return [...p, 'adapter_model.safetensors: ' + header.problem];
  const names = Object.keys(header);
  if (!names.length) p.push('adapter_model.safetensors holds no tensor');
  const pairs = new Map<string, { A?: number[]; B?: number[] }>();
  for (const name of names) {
    const m = /(?:^|\.)layers\.(\d+)\.(?:.*\.)?([A-Za-z0-9_]+)\.lora_([AB])(?:\.default)?\.weight$/.exec(name);
    if (!m) { p.push('tensor ' + name + ': not a lora_A or lora_B of a layer'); continue; }
    const layer = Number(m[1]), mod = m[2], t = header[name];
    if (layer < chip) p.push('tensor ' + name + ': layer ' + layer + ' belongs to the circuit (its first ' + chip + '): the computer is never adapted');
    if (dims && layer >= dims.layers) p.push('tensor ' + name + ': the base has ' + dims.layers + ' layers');
    if (!targets.includes(mod)) p.push('tensor ' + name + ': ' + mod + ' is not among its target_modules');
    if (!DTYPES.has(t.dtype)) p.push('tensor ' + name + ': dtype ' + t.dtype + ' (F16, BF16 or F32)');
    if (t.shape.length !== 2) { p.push('tensor ' + name + ': not a matrix'); continue; }
    const key = layer + '.' + mod;
    const pair = pairs.get(key) ?? {};
    pair[m[3] as 'A' | 'B'] = t.shape;
    pairs.set(key, pair);
  }
  for (const [key, { A, B }] of pairs) {
    if (!A || !B) { p.push(key + ': lora_A and lora_B go together'); continue; }
    if (A[0] !== c.r || B[1] !== c.r) p.push(key + ': its rank is not r ' + c.r + ' (A ' + A.join('x') + ', B ' + B.join('x') + ')');
    const mod = key.split('.')[1];
    const want = dims && DIMS[mod] ? DIMS[mod](dims) : null;
    if (want && (A[1] !== want[0] || B[0] !== want[1])) p.push(key + ': its shapes do not fit the base ' + mod + ' (' + want[0] + ' in, ' + want[1] + ' out)');
  }
  return p;
}

/** A finished job's LoRA adapter imported (§8.2): checked as above, stored as a tree blob - the adapter of a child of the
    start, which must have none. Its config and weights only; what it learned is the host's to write. */
export function importAdapter(store: BlobStore, start: JuniorPackage, job: ProgramJob): { adapter: string } | { problems: string[] } {
  if (job.state !== 'finished' || !job.products || job.format !== 'lora-adapter') return { problems: ['nothing to import: the job ' + job.state + (job.reason ? ' (' + job.reason + ')' : '') + (job.format && job.format !== 'lora-adapter' ? ', its product ' + job.format : '')] };
  const p = normalizePackage(start);
  if (p.adapter !== null) return { problems: ['the start already has an adapter: a program adapts a package without one'] };
  const chip = Number((p.execution.circuit as Record<string, unknown>).chip_layers);
  if (!Number.isInteger(chip) || chip < 0) return { problems: ['the circuit of the package does not say its chip_layers: what may be adapted cannot be told'] };
  /* The base's dimensions, where its config is in the store. */
  let dims: BaseDims | null = null;
  try { const t = store.tree(p.base); const f = t?.files['config.json']; dims = f && store.has(f) ? baseDimsOf(JSON.parse(store.get(f).toString('utf8'))) : null; } catch { dims = null; }
  const problems = loraProblems(job.products, chip, dims);
  if (problems.length) return { problems };
  const files: Record<string, string> = {};
  for (const name of ['adapter_config.json', 'adapter_model.safetensors']) files[name] = store.put(job.products[name]);
  return { adapter: store.put(stableStringify({ format: 'blob-tree@1', files })) };
}

/** A finished job's mask@1 imported (SPEC-EDICION-PESOS §15.3): its deletions read from modules.json and their indices
    files, made a mask of the start (putMask: circuit, bounds, measures) within the condition's "masks" bounds. */
export async function importMask(store: BlobStore, start: JuniorPackage, job: ProgramJob, authorized: import('./mask.ts').MaskBounds | null | undefined, declared?: import('./mask.ts').MaskBounds): Promise<{ adapter: string } | { problems: string[] }> {
  if (job.state !== 'finished' || !job.products || job.format !== 'mask@1') return { problems: ['nothing to import: the job ' + job.state + (job.reason ? ' (' + job.reason + ')' : '') + (job.format && job.format !== 'mask@1' ? ', its product ' + job.format : '')] };
  const K = await import('./mask.ts');
  const read = K.deletionsOfOutputs(job.products);
  if ('problems' in read) return read;
  const made = K.putMask(store, start, read.deletions, { authorized, ...(declared ? { declared } : {}) });
  return 'problems' in made ? { problems: [...made.problems] } : { adapter: made.adapter };
}
