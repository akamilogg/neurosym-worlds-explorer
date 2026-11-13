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
/** The formats this host imports today: a set of edits. LoRA from a program and mask@1 (SPEC-EDICION-PESOS WE7a) are
    declared, and answered as not importable until their checks exist. */
export const IMPORTABLE: ReadonlySet<OutputFormat> = new Set(['weight-edit-set@1']);

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
  readonly start: string; readonly startDir: string; readonly availability: Availability }): Promise<ProgramJob> {
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
    parameters: p.parameters, seed: p.seed, limits: profile.limits, output_format: p.output_format };
  const mounted: Record<string, Buffer> = { ...o.inputs, 'job.json': Buffer.from(JSON.stringify(jobFile, null, 2)) };
  for (const [name, text] of Object.entries(p.files)) if (name !== p.entrypoint) mounted['prog.' + name] = Buffer.from(text, 'utf8');
  const r = await o.availability.backend.run({ code: p.files[p.entrypoint], inputs: mounted, base: o.startDir, limits: profile.limits });
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
