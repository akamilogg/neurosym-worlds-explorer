import fs from 'node:fs';
import { stableStringify } from '../core/hash.ts';
import { executionHash, normalizePackage, sha256, type BlobId, type BlobStore, type JuniorPackage } from './package.ts';
import type { IsolatedBackend, ProgramLimits } from './isolation.ts';

/* ============================================================================
 * EDITING THE JUNIOR'S WEIGHTS (SPEC-EDICION-PESOS §3, WE1): an edit is an additive change on Qwen's modules, low-rank or
 * sparse, a hypothesis with its origin and authorship; a version is a STARTING package, a GENOME of edits and the RULE
 * that composes them. The genome composed sits in the package's adapter slot as a tree, weight-edit-set@1, that holds as
 * its own files everything needed to compose it and to verify it: its manifest, each edit with its tensors materialized,
 * and the inputs of each constructor.
 *
 * compose@1, the one rule: for each module touched, its ΔW summed in fp32 in the order of the genome, each low-rank edit
 * rank by rank as an outer product (elementwise: one rounding per product, one per sum, in a fixed order - never a
 * library's matrix product, whose order of summation is the library's and the hardware's), each sparse edit entry by entry;
 * then applied once, W' = bf16(fp32(W_start) + ΔW). It is written here (the reference, without a model) and in the worker
 * (torch, on the GPU) with the same arithmetic: both give the same bits, and the worker says the digest of what it served.
 *
 * Tensors travel as safetensors, written here by a small writer of our own whose bytes are fixed by their content (names
 * sorted, no metadata): an edit is an artifact by its hash.
 * ========================================================================== */

export const WEIGHT_EDIT = 'weight-edit@1';
export const WEIGHT_EDIT_SET = 'weight-edit-set@1';
export const COMPOSE = 'compose@1';
export const SET_MANIFEST = 'set.json';

/** The modules of Qwen an edit may touch (as train.ts): the projections of attention, DeltaNet and the MLP. */
export const EDITABLE = new Set(['q_proj', 'k_proj', 'v_proj', 'o_proj', 'gate_proj', 'up_proj', 'down_proj', 'in_proj_qkvz', 'in_proj_ba', 'out_proj']);

/* --- safetensors, small ---------------------------------------------------------------------------------------------- */

export type DType = 'F32' | 'BF16' | 'I64';
export interface RawTensor { readonly dtype: DType; readonly shape: readonly number[]; readonly bytes: Uint8Array }
const WIDTH: Record<DType, number> = { F32: 4, BF16: 2, I64: 8 };

/** Tensors as safetensors bytes: names sorted, data contiguous in that order, the header padded with spaces to 8 bytes,
    no metadata - the same tensors give the same bytes. */
export function writeSafetensors(tensors: Readonly<Record<string, RawTensor>>): Buffer {
  const names = Object.keys(tensors).sort();
  const header: Record<string, unknown> = {};
  let offset = 0;
  for (const n of names) {
    const t = tensors[n];
    const len = t.shape.reduce((a, b) => a * b, 1) * WIDTH[t.dtype];
    if (t.bytes.length !== len) throw new Error('tensor ' + n + ' has ' + t.bytes.length + ' bytes, its shape says ' + len);
    header[n] = { dtype: t.dtype, shape: [...t.shape], data_offsets: [offset, offset + len] };
    offset += len;
  }
  let h = JSON.stringify(header);
  while ((8 + Buffer.byteLength(h)) % 8) h += ' ';
  const hb = Buffer.from(h, 'utf8');
  const out = Buffer.alloc(8 + hb.length + offset);
  out.writeBigUInt64LE(BigInt(hb.length), 0);
  hb.copy(out, 8);
  let at = 8 + hb.length;
  for (const n of names) { Buffer.from(tensors[n].bytes.buffer, tensors[n].bytes.byteOffset, tensors[n].bytes.length).copy(out, at); at += tensors[n].bytes.length; }
  return out;
}

interface Entry { readonly dtype: string; readonly shape: number[]; readonly data_offsets: [number, number] }

function headerOf(read: (pos: number, len: number) => Buffer, size: number): { entries: Record<string, Entry>; start: number } {
  if (size < 8) throw new Error('not safetensors: too short');
  const n = Number(read(0, 8).readBigUInt64LE(0));
  if (n <= 0 || 8 + n > size) throw new Error('not safetensors: its header does not fit');
  const json = JSON.parse(read(8, n).toString('utf8')) as Record<string, Entry>;
  delete (json as Record<string, unknown>).__metadata__;
  return { entries: json, start: 8 + n };
}

function raw(e: Entry, name: string, bytes: Buffer): RawTensor {
  if (!(e.dtype in WIDTH)) throw new Error('tensor ' + name + ' is ' + e.dtype + ': only F32, BF16 and I64 are read');
  const dtype = e.dtype as DType;
  if (bytes.length !== e.shape.reduce((a, b) => a * b, 1) * WIDTH[dtype]) throw new Error('tensor ' + name + ' does not have the bytes its shape says');
  return { dtype, shape: e.shape, bytes: new Uint8Array(bytes) };
}

export function readSafetensors(buf: Buffer): Record<string, RawTensor> {
  const { entries, start } = headerOf((p, l) => buf.subarray(p, p + l), buf.length);
  const out: Record<string, RawTensor> = {};
  for (const [name, e] of Object.entries(entries)) out[name] = raw(e, name, buf.subarray(start + e.data_offsets[0], start + e.data_offsets[1]));
  return out;
}

/** The names of a safetensors file's tensors and their shapes, its header read alone. */
export function safetensorsIndex(file: string): Record<string, { dtype: string; shape: number[] }> {
  const fd = fs.openSync(file, 'r');
  try {
    const read = (p: number, l: number) => { const b = Buffer.alloc(l); fs.readSync(fd, b, 0, l, p); return b; };
    const { entries } = headerOf(read, fs.fstatSync(fd).size);
    return Object.fromEntries(Object.entries(entries).map(([k, e]) => [k, { dtype: e.dtype, shape: e.shape }]));
  } finally { fs.closeSync(fd); }
}

/** One tensor of a safetensors file, read without reading the rest. */
export function readTensor(file: string, name: string): RawTensor {
  const fd = fs.openSync(file, 'r');
  try {
    const read = (p: number, l: number) => { const b = Buffer.alloc(l); fs.readSync(fd, b, 0, l, p); return b; };
    const { entries, start } = headerOf(read, fs.fstatSync(fd).size);
    const e = entries[name];
    if (!e) throw new Error(file + ' has no tensor ' + name);
    return raw(e, name, read(start + e.data_offsets[0], e.data_offsets[1] - e.data_offsets[0]));
  } finally { fs.closeSync(fd); }
}

export const f32 = (t: RawTensor): Float32Array => {
  if (t.dtype !== 'F32') throw new Error('expected F32, found ' + t.dtype);
  return new Float32Array(t.bytes.slice().buffer);
};
export const i64 = (t: RawTensor): number[] => {
  if (t.dtype !== 'I64') throw new Error('expected I64, found ' + t.dtype);
  return Array.from(new BigInt64Array(t.bytes.slice().buffer), Number);
};
export const tensorF32 = (shape: readonly number[], v: ArrayLike<number>): RawTensor => ({ dtype: 'F32', shape, bytes: new Uint8Array(Float32Array.from(v).buffer) });
export const tensorI64 = (v: readonly number[]): RawTensor => ({ dtype: 'I64', shape: [v.length], bytes: new Uint8Array(BigInt64Array.from(v.map(BigInt)).buffer) });

/* --- bf16 ------------------------------------------------------------------------------------------------------------ */

const F = new Float32Array(1), U = new Uint32Array(F.buffer);
/** A float32 rounded to bf16 bits, to nearest with ties to even (as torch's .to(bfloat16)). */
export function bf16Bits(x: number): number {
  F[0] = x;
  const u = U[0];
  if ((u & 0x7f800000) === 0x7f800000 && (u & 0x7fffff)) return 0x7fc0;
  return ((u + 0x7fff + ((u >>> 16) & 1)) >>> 16) & 0xffff;
}
export function bf16Value(bits: number): number { U[0] = (bits & 0xffff) << 16; return F[0]; }

/* --- weight-edit@1 --------------------------------------------------------------------------------------------------- */

export type Authorship = 'strong' | 'search' | 'control';
export interface Hypothesis { readonly competence: string; readonly mechanism: string; readonly effect: string }
export type Origin =
  | { readonly kind: 'written' }
  | { readonly kind: 'constructor'; readonly constructor: string; readonly args: Readonly<Record<string, unknown>>; readonly base: BlobId; readonly inputs: Readonly<Record<string, string>> }
  /** Code of the strong model, run by an isolated backend (§4.4): its code travels as the input program.py. */
  | { readonly kind: 'program'; readonly backend: string; readonly base: BlobId; readonly inputs: Readonly<Record<string, string>> }
  | { readonly kind: 'operator'; readonly operator: string; readonly parents: readonly string[]; readonly seed?: number };

export interface ModuleEdit {
  /** The module by its name in the checkpoint, its weight being name + ".weight": model.layers.20.mlp.down_proj. */
  readonly module: string;
  readonly encoding: 'lowrank' | 'sparse';
  /** Its weight's shape [d_out, d_in]. */
  readonly shape: readonly [number, number];
  /** The tensors file in the edit's folder, and the SHA-256 of its bytes. */
  readonly file: string;
  readonly sha256: string;
}

export interface WeightEdit {
  readonly format: typeof WEIGHT_EDIT;
  readonly modules: readonly ModuleEdit[];
  readonly hypothesis: Hypothesis;
  readonly origin: Origin;
  readonly authorship: Authorship;
}

/** A module's layer in the combined model, or null when its name has none. */
export function layerOf(module: string): number | null {
  const m = /(?:^|\.)layers\.(\d+)\./.exec(module + '.');
  return m ? Number(m[1]) : null;
}

/** Everything wrong with an edit's manifest, for a starting package whose circuit has `chip` layers. */
/** `programs`: whether an edit of origin program may be accepted here - only when an isolated backend just ran it
    (programEdit), or to check the shape of one already made (composing and verifying it). */
export function editProblems(raw: unknown, chip: number, opts: { programs?: boolean } = {}): string[] {
  const e = raw as WeightEdit;
  if (!e || e.format !== WEIGHT_EDIT) return ['"format": "' + WEIGHT_EDIT + '"'];
  const p: string[] = [];
  const h = e.hypothesis;
  if (!h || [h.competence, h.mechanism, h.effect].some((s) => typeof s !== 'string' || !s.trim())) p.push('"hypothesis": what it corrects ("competence"), how ("mechanism") and what it expects ("effect"), before it is measured');
  if (!['strong', 'search', 'control'].includes(e.authorship)) p.push('"authorship": strong, search or control');
  const o = e.origin as Origin;
  if (!o || !['written', 'constructor', 'program', 'operator'].includes(o.kind)) p.push('"origin": written, constructor, program or operator');
  else if (o.kind === 'program' && !opts.programs) p.push('origin "program": there is no isolated backend for free programs; the process sandbox does not count as one');
  else if (o.kind === 'program' && (typeof o.backend !== 'string' || !/^[0-9a-f]{64}$/.test(String(o.base)) || !o.inputs || !o.inputs['program.py'])) p.push('origin "program": its backend, the base it read and its inputs, its code among them');
  else if (o.kind === 'constructor' && (!CONSTRUCTORS[o.constructor] || !/^[0-9a-f]{64}$/.test(String(o.base)) || !o.inputs || typeof o.inputs !== 'object')) p.push('origin "constructor": one of ' + Object.keys(CONSTRUCTORS).join(', ') + ', the base it read and its inputs');
  else if (o.kind === 'operator' && (typeof o.operator !== 'string' || !Array.isArray(o.parents) || !o.parents.length)) p.push('origin "operator": its operator and its parents');
  if (!Array.isArray(e.modules) || !e.modules.length) return [...p, '"modules": at least one'];
  const seen = new Set<string>();
  for (const m of e.modules) {
    const at = 'module ' + m?.module;
    if (typeof m?.module !== 'string' || seen.has(m.module)) { p.push(at + ': a name, once per edit'); continue; }
    seen.add(m.module);
    const layer = layerOf(m.module);
    if (layer === null) p.push(at + ': not a module of a layer (model.layers.N...)');
    else if (layer < chip) p.push(at + ': layer ' + layer + ' is the circuit\'s (its first ' + chip + '): the computer is never edited');
    if (!EDITABLE.has(m.module.split('.').pop()!)) p.push(at + ': among ' + [...EDITABLE].join(', '));
    if (m.encoding !== 'lowrank' && m.encoding !== 'sparse') p.push(at + ': "encoding" lowrank or sparse');
    if (!Array.isArray(m.shape) || m.shape.length !== 2 || (m.shape as readonly number[]).some((d: number) => !Number.isInteger(d) || d <= 0)) p.push(at + ': "shape" [d_out, d_in]');
    if (typeof m.file !== 'string' || !/^[\w.-]+\.safetensors$/.test(m.file) || !/^[0-9a-f]{64}$/.test(String(m.sha256))) p.push(at + ': its tensors "file" and its "sha256"');
  }
  return p;
}

/** Everything wrong with a module's tensors for its encoding and shape: factors B [d_out, r] and A [r, d_in], finite; or
    indices strictly increasing inside the matrix and values finite. */
export function tensorProblems(m: ModuleEdit, t: Record<string, RawTensor>): string[] {
  const [dout, din] = m.shape;
  const finiteAll = (v: Float32Array) => v.every((x) => Number.isFinite(x));
  if (m.encoding === 'lowrank') {
    const B = t.B, A = t.A;
    if (!B || !A || B.dtype !== 'F32' || A.dtype !== 'F32' || B.shape.length !== 2 || A.shape.length !== 2) return [m.module + ': lowrank needs F32 factors B [d_out, r] and A [r, d_in]'];
    const r = B.shape[1];
    if (B.shape[0] !== dout || A.shape[1] !== din || A.shape[0] !== r || r < 1) return [m.module + ': B is ' + B.shape.join('x') + ' and A ' + A.shape.join('x') + ', the weight ' + dout + 'x' + din];
    if (!finiteAll(f32(B)) || !finiteAll(f32(A))) return [m.module + ': factors with values that are not finite'];
    return [];
  }
  const I = t.indices, V = t.values;
  if (!I || !V || I.dtype !== 'I64' || V.dtype !== 'F32' || I.shape.length !== 1 || V.shape.length !== 1 || I.shape[0] !== V.shape[0] || !I.shape[0]) return [m.module + ': sparse needs I64 indices and F32 values of one length'];
  const idx = i64(I);
  for (let k = 0; k < idx.length; k++) if (!(idx[k] >= 0 && idx[k] < dout * din) || (k && idx[k] <= idx[k - 1])) return [m.module + ': indices strictly increasing, inside its ' + dout + 'x' + din + ' entries'];
  if (!finiteAll(f32(V))) return [m.module + ': values that are not finite'];
  return [];
}

/** What a module's edit represents: the entries of A and B, or its indices and values. */
export const representation = (m: ModuleEdit, t: Record<string, RawTensor>): number =>
  m.encoding === 'lowrank' ? t.B.bytes.length / 4 + t.A.bytes.length / 4 : t.indices.shape[0] * 2;
export const rankOf = (m: ModuleEdit, t: Record<string, RawTensor>): number => m.encoding === 'lowrank' ? t.B.shape[1] : 0;

/** A draft of an edit: the manifest without its files, and each module's tensors. */
export interface EditDraft {
  readonly modules: readonly { readonly module: string; readonly encoding: 'lowrank' | 'sparse'; readonly shape: readonly [number, number]; readonly tensors: Readonly<Record<string, RawTensor>> }[];
  readonly hypothesis: Hypothesis;
  readonly origin: Origin;
  readonly authorship: Authorship;
  /** A constructor's inputs, as files of the edit's folder (inputs/<name>). */
  readonly inputs?: Readonly<Record<string, Buffer>>;
}

/** An edit stored by its hash: its tensors and inputs as blobs, its manifest as a blob whose id is the edit's. Refused,
    nothing stored, when it is wrong for the start's circuit. */
export function putEdit(store: BlobStore, draft: EditDraft, chip: number, opts: { programs?: boolean } = {}): { id: string } | { problems: string[] } {
  const files: Record<string, Buffer> = {};
  const modules: ModuleEdit[] = draft.modules.map((m, i) => {
    const file = 'm' + i + '.safetensors';
    files[file] = writeSafetensors(m.tensors);
    return { module: m.module, encoding: m.encoding, shape: [m.shape[0], m.shape[1]], file, sha256: sha256(files[file]) };
  });
  const inputs: Record<string, string> = {};
  for (const [name, bytes] of Object.entries(draft.inputs ?? {})) inputs[name] = sha256(bytes);
  const origin = draft.origin.kind === 'constructor' || draft.origin.kind === 'program' ? { ...draft.origin, inputs } : draft.origin;
  const manifest: WeightEdit = { format: WEIGHT_EDIT, modules, hypothesis: draft.hypothesis, origin, authorship: draft.authorship };
  const shape = editProblems(manifest, chip, opts);
  const problems = shape.length ? shape : modules.flatMap((m, i) => tensorProblems(m, draft.modules[i].tensors as Record<string, RawTensor>));
  if (problems.length) return { problems };
  for (const b of Object.values(files)) store.put(b);
  for (const b of Object.values(draft.inputs ?? {})) store.put(b);
  return { id: store.put(stableStringify(manifest)) };
}

export function readEdit(store: BlobStore, id: string): WeightEdit {
  return JSON.parse(store.get(id).toString('utf8')) as WeightEdit;
}

/* --- The start's weights --------------------------------------------------------------------------------------------- */

/** A start's weight by its tensor name, as bf16 bits, read from its checkpoint's tree (sharded or not). */
export type BaseReader = (tensor: string) => { shape: [number, number]; bits: Uint16Array };

export function baseReader(store: BlobStore, base: BlobId): BaseReader {
  const tree = store.tree(base);
  if (!tree) throw new Error('the base ' + base + ' is not a tree');
  let map: Record<string, string> | null = null;
  const index = tree.files['model.safetensors.index.json'];
  if (index) map = (JSON.parse(store.get(index).toString('utf8')) as { weight_map: Record<string, string> }).weight_map;
  const shards = Object.keys(tree.files).filter((f) => f.endsWith('.safetensors')).sort();
  return (tensor) => {
    const candidates = map ? (map[tensor] ? [map[tensor]] : []) : shards;
    for (const f of candidates) {
      const file = store.pathOf(tree.files[f]);
      if (!map && !(tensor in safetensorsIndex(file))) continue;
      const t = readTensor(file, tensor);
      if (t.dtype !== 'BF16' || t.shape.length !== 2) throw new Error(tensor + ' is ' + t.dtype + ' ' + t.shape.join('x') + ': edits compose on bf16 matrices');
      return { shape: [t.shape[0], t.shape[1]], bits: new Uint16Array(t.bytes.slice().buffer) };
    }
    throw new Error('the base has no tensor ' + tensor);
  };
}

/* --- compose@1 ------------------------------------------------------------------------------------------------------- */

/** What composing leaves of a module: its digest after (what the worker must say it served) and before, and its size. */
export interface ModuleSummary {
  readonly shape: readonly [number, number];
  /** sha256 of the module's bf16 bits after, little-endian, after its name and shape. */
  readonly digest: string;
  readonly base_digest: string;
  readonly entries: number;
  /** Entries of W' whose bits differ from W_start's. */
  readonly changed: number;
  /** ‖ΔW_total‖ / ‖W_start‖. */
  readonly relative_norm: number;
  /** Parameters stored for it, over the genome. */
  readonly representation: number;
  /** An upper bound of the composed low-rank part's rank: the sum of the ranks of the genome's low-rank edits on it.
      Conservative by declaration (two rank-1 edits may compose into rank 2, or cancel into 0): the exact numerical rank
      would need a tolerance of its own. */
  readonly rank_bound: number;
  readonly sparse_entries: number;
}

export const moduleDigest = (module: string, shape: readonly number[], bits: Uint16Array): string =>
  sha256(Buffer.concat([Buffer.from(module + '\n' + shape.join('x') + '\n', 'utf8'), Buffer.from(bits.buffer, bits.byteOffset, bits.byteLength)]));

/** The genome's edits read from somewhere: their manifests and each module's tensors. */
export interface LoadedEdit { readonly id: string; readonly edit: WeightEdit; readonly tensors: readonly Record<string, RawTensor>[] }

/** compose@1: every module touched, its ΔW accumulated in fp32 in the genome's order - low-rank rank by rank as outer
    products, sparse entry by entry - applied once to the start's weights and rounded once to bf16. */
export interface Composed {
  readonly summaries: Record<string, ModuleSummary>;
  readonly weights: Record<string, Uint16Array>;
  /** Each module's ‖ΔW‖² and ‖W_start‖², for the totals. */
  readonly squares: Record<string, { readonly delta: number; readonly start: number }>;
}

export function compose(edits: readonly LoadedEdit[], base: BaseReader): Composed {
  const modules = [...new Set(edits.flatMap((e) => e.edit.modules.map((m) => m.module)))].sort();
  const summaries: Record<string, ModuleSummary> = {}, weights: Record<string, Uint16Array> = {}, squares: Composed['squares'] = {};
  for (const name of modules) {
    const W = base(name + '.weight');
    const [dout, din] = W.shape;
    const delta = new Float32Array(dout * din);
    let representationN = 0, rankBound = 0, sparseN = 0;
    for (const e of edits) e.edit.modules.forEach((m, i) => {
      if (m.module !== name) return;
      if (m.shape[0] !== dout || m.shape[1] !== din) throw new Error(e.id + ' edits ' + name + ' as ' + m.shape.join('x') + '; the start\'s is ' + dout + 'x' + din);
      const t = e.tensors[i];
      representationN += representation(m, t);
      if (m.encoding === 'lowrank') {
        const B = f32(t.B), A = f32(t.A), r = t.B.shape[1];
        rankBound += r;
        for (let k = 0; k < r; k++) for (let a = 0; a < dout; a++) {
          const b = B[a * r + k];
          if (b === 0) continue;
          const row = a * din, ak = k * din;
          for (let j = 0; j < din; j++) delta[row + j] = delta[row + j] + Math.fround(b * A[ak + j]);
        }
      } else {
        const idx = i64(t.indices), v = f32(t.values);
        sparseN += idx.length;
        for (let k = 0; k < idx.length; k++) delta[idx[k]] = delta[idx[k]] + v[k];
      }
    });
    const out = new Uint16Array(dout * din);
    let changed = 0, dn = 0, wn = 0;
    /* Every entry of a module touched goes through the rule, as in the worker: -0 + 0 is +0 there too. An entry counts as
       changed when its value differs (+0 and -0 are one value). */
    for (let x = 0; x < out.length; x++) {
      const w = bf16Value(W.bits[x]);
      out[x] = bf16Bits(w + delta[x]);
      /* Finite factors can overflow fp32 in their products and sums (+Infinity and -Infinity summed are NaN), and a
         finite sum can overflow bf16: a composition that is not finite everywhere is no version. */
      if (!Number.isFinite(delta[x]) || !Number.isFinite(w) || !Number.isFinite(bf16Value(out[x])))
        throw new Error(name + ': the composition is not finite at entry ' + x + ' (row ' + Math.floor(x / din) + ', column ' + (x % din) + ')');
      if (bf16Value(out[x]) !== w) changed++;
      dn += delta[x] * delta[x];
      wn += w * w;
    }
    if (!Number.isFinite(dn) || !Number.isFinite(wn)) throw new Error(name + ': its norms are not finite');
    weights[name] = out;
    summaries[name] = { shape: [dout, din], digest: moduleDigest(name, [dout, din], out), base_digest: moduleDigest(name, [dout, din], W.bits), entries: out.length, changed,
      relative_norm: dn === 0 ? 0 : wn === 0 ? Infinity : Math.sqrt(dn / wn), representation: representationN, rank_bound: rankBound, sparse_entries: sparseN };
    squares[name] = { delta: dn, start: wn };
  }
  return { summaries, weights, squares };
}

/* --- Bounds (§3.3) --------------------------------------------------------------------------------------------------- */

export interface WeightBoundsPart {
  readonly max_changed_fraction: number;
  readonly max_relative_norm: number;
  readonly max_representation: number;
  /** Bounds each module's rank_bound (the sum of its low-rank edits' ranks), not its numerical rank. */
  readonly max_rank: number;
  readonly max_sparse_entries: number;
}
/** The bounds an authorized manifest fixes for its condition, per module and in total. A candidate may declare stricter. */
export interface WeightBounds { readonly per_module: WeightBoundsPart; readonly total: Pick<WeightBoundsPart, 'max_changed_fraction' | 'max_relative_norm' | 'max_representation'> }

const PART = ['max_changed_fraction', 'max_relative_norm', 'max_representation', 'max_rank', 'max_sparse_entries'] as const;
const TOTAL = ['max_changed_fraction', 'max_relative_norm', 'max_representation'] as const;

export function boundsProblems(raw: unknown, where = '"weight_edits"'): string[] {
  const b = raw as WeightBounds;
  const ok = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const p: string[] = [];
  if (!b || typeof b !== 'object' || !b.per_module || !b.total) return [where + ': {"per_module": {' + PART.join(', ') + '}, "total": {' + TOTAL.join(', ') + '}}'];
  for (const k of PART) if (!ok(b.per_module[k])) p.push(where + '.per_module.' + k + ': a finite number >= 0');
  for (const k of TOTAL) if (!ok(b.total[k])) p.push(where + '.total.' + k + ': a finite number >= 0');
  if (b.per_module.max_changed_fraction > 1 || b.total.max_changed_fraction > 1) p.push(where + ': a changed fraction is at most 1');
  return p;
}

/** Where a declared bound is laxer than the authorized one (a candidate may only tighten them). */
export function laxer(declared: WeightBounds, authorized: WeightBounds): string[] {
  return [...PART.filter((k) => declared.per_module[k] > authorized.per_module[k]).map((k) => 'per_module.' + k),
    ...TOTAL.filter((k) => declared.total[k] > authorized.total[k]).map((k) => 'total.' + k)];
}

export interface SetTotals { readonly entries: number; readonly changed: number; readonly changed_fraction: number; readonly relative_norm: number; readonly representation: number }

/** The measures of the composed intervention over its bounds: every module's, and the total's. */
export function outOfBounds(summaries: Record<string, ModuleSummary>, totals: SetTotals, b: WeightBounds): string[] {
  /* Within means "at most", written so that a measure that is not a number is never within. */
  const over = (x: number, bound: number) => !(x <= bound);
  const p: string[] = [];
  for (const [m, s] of Object.entries(summaries)) {
    const pm = b.per_module;
    if (over(s.changed / s.entries, pm.max_changed_fraction)) p.push(m + ': ' + s.changed + ' of ' + s.entries + ' entries changed, more than ' + pm.max_changed_fraction);
    if (over(s.relative_norm, pm.max_relative_norm)) p.push(m + ': relative norm ' + s.relative_norm + ' above ' + pm.max_relative_norm);
    if (over(s.representation, pm.max_representation)) p.push(m + ': ' + s.representation + ' parameters stored, above ' + pm.max_representation);
    if (over(s.rank_bound, pm.max_rank)) p.push(m + ': its low-rank edits sum rank ' + s.rank_bound + ', above ' + pm.max_rank);
    if (over(s.sparse_entries, pm.max_sparse_entries)) p.push(m + ': ' + s.sparse_entries + ' sparse entries above ' + pm.max_sparse_entries);
  }
  if (over(totals.changed_fraction, b.total.max_changed_fraction)) p.push('in total: ' + totals.changed + ' of ' + totals.entries + ' entries changed, more than ' + b.total.max_changed_fraction);
  if (over(totals.relative_norm, b.total.max_relative_norm)) p.push('in total: relative norm ' + totals.relative_norm + ' above ' + b.total.max_relative_norm);
  if (over(totals.representation, b.total.max_representation)) p.push('in total: ' + totals.representation + ' parameters stored, above ' + b.total.max_representation);
  return p;
}

/** The totals over the modules touched: entries and changes summed, the relative norm of the whole intervention. */
export function totalsOf(c: Composed): SetTotals {
  let entries = 0, changed = 0, dn = 0, wn = 0, rep = 0;
  for (const [m, s] of Object.entries(c.summaries)) {
    entries += s.entries; changed += s.changed; dn += c.squares[m].delta; wn += c.squares[m].start; rep += s.representation;
  }
  return { entries, changed, changed_fraction: entries ? changed / entries : 0, relative_norm: dn === 0 ? 0 : wn === 0 ? Infinity : Math.sqrt(dn / wn), representation: rep };
}

/* --- weight-edit-set@1 ----------------------------------------------------------------------------------------------- */

export interface EditSet {
  readonly format: typeof WEIGHT_EDIT_SET;
  readonly rule: typeof COMPOSE;
  /** The starting package by its execution hash, and the base checkpoint its weights come from. */
  readonly start: string;
  readonly base: BlobId;
  readonly chip_layers: number;
  /** The edits in order, by id: each one's folder is edits/<id>/. */
  readonly genome: readonly string[];
  /** The bounds it was composed under: the authorized ones, or the stricter ones it declared. */
  readonly bounds: WeightBounds;
  readonly summaries: Readonly<Record<string, ModuleSummary>>;
  readonly totals: SetTotals;
}

/** The kind of a package's adapter: none, a LoRA, or a set of edits. */
export function adapterKind(store: BlobStore, pkg: JuniorPackage): 'none' | 'lora' | 'edits' {
  if (pkg.adapter === null) return 'none';
  const t = store.tree(pkg.adapter);
  return t && t.files[SET_MANIFEST] ? 'edits' : 'lora';
}

export function readEditSet(store: BlobStore, adapter: BlobId): EditSet | null {
  const t = store.tree(adapter);
  if (!t || !t.files[SET_MANIFEST]) return null;
  return JSON.parse(store.get(t.files[SET_MANIFEST]).toString('utf8')) as EditSet;
}

/** The genome's edits read from a set's own tree: its files only, never the store's other blobs. */
export function editsInTree(store: BlobStore, adapter: BlobId): LoadedEdit[] {
  const t = store.tree(adapter)!;
  const set = readEditSet(store, adapter)!;
  const file = (rel: string): Buffer => {
    const b = t.files[rel];
    if (!b) throw new Error('the set\'s tree has no file ' + rel);
    return store.get(b);
  };
  return set.genome.map((id) => {
    const bytes = file('edits/' + id + '/edit.json');
    if (sha256(bytes) !== id) throw new Error('edit ' + id + ' does not match its hash');
    const edit = JSON.parse(bytes.toString('utf8')) as WeightEdit;
    const tensors = edit.modules.map((m) => {
      const b = file('edits/' + id + '/' + m.file);
      if (sha256(b) !== m.sha256) throw new Error('edit ' + id + ': ' + m.file + ' does not match its hash');
      return readSafetensors(b);
    });
    return { id, edit, tensors };
  });
}

export interface ComposeRequest {
  readonly store: BlobStore;
  /** The package the version derives from: without an adapter (the start), or with a set of edits (its genome extended). */
  readonly parent: JuniorPackage;
  /** The edits added, in order, by id (stored with putEdit). */
  readonly add: readonly string[];
  readonly authorized: WeightBounds | null | undefined;
  /** Stricter bounds the candidate declares, if any. */
  readonly declared?: WeightBounds;
  readonly reason?: string;
}

export type ComposeResult = { readonly child: JuniorPackage; readonly set: EditSet; readonly adapter: BlobId } | { readonly problems: readonly string[] };

/** A version: the parent's genome (none for a start) with edits added, composed from the start, its tree holding every
    file needed to compose it again and verify it, in the child package's adapter slot. Refused with what is wrong - a
    parent with a LoRA, an edit wrong for the circuit, a composed intervention out of bounds - before anything is stored. */
export function composeVersion(r: ComposeRequest): ComposeResult {
  const parent = normalizePackage(r.parent);
  const kind = adapterKind(r.store, parent);
  if (kind === 'lora') return { problems: ['the parent has a LoRA adapter: combining a trained adapter with edits is another recipe, which does not exist'] };
  if (!r.authorized) return { problems: ['the condition authorizes no edits: its manifest fixes no "weight_edits" bounds'] };
  const bp = boundsProblems(r.authorized);
  if (bp.length) return { problems: bp };
  if (r.declared) {
    const dp = [...boundsProblems(r.declared, 'the declared bounds'), ...laxer(r.declared, r.authorized).map((k) => 'the declared bound ' + k + ' is laxer than the authorized one')];
    if (dp.length) return { problems: dp };
  }
  const chip = Number((parent.execution.circuit as Record<string, unknown>).chip_layers);
  if (!Number.isInteger(chip) || chip < 0) return { problems: ['the package\'s circuit does not say its chip_layers: what may be edited cannot be told from what may not'] };
  const before = kind === 'edits' ? readEditSet(r.store, parent.adapter!)! : null;
  if (before && before.base !== parent.base) return { problems: ['the parent\'s set composes on another base than the parent\'s'] };
  const start = before ? before.start : executionHash(parent);
  const genome = [...(before?.genome ?? []), ...r.add];
  if (!r.add.length) return { problems: ['no edit to add'] };
  if (new Set(genome).size !== genome.length) return { problems: ['an edit appears twice in the genome'] };
  const loaded: LoadedEdit[] = [];
  const problems: string[] = [];
  for (const id of genome) {
    if (!r.store.has(id)) { problems.push('no edit ' + id); continue; }
    const edit = readEdit(r.store, id);
    const ep = editProblems(edit, chip, { programs: true });
    if (ep.length) { problems.push(...ep.map((x) => id.slice(0, 12) + ': ' + x)); continue; }
    if ((edit.origin.kind === 'constructor' || edit.origin.kind === 'program') && edit.origin.base !== parent.base) { problems.push(id.slice(0, 12) + ': its ' + edit.origin.kind + ' read another base than the start\'s'); continue; }
    const tensors = edit.modules.map((m) => readSafetensors(r.store.get(m.sha256)));
    const tp = edit.modules.flatMap((m, i) => tensorProblems(m, tensors[i]));
    if (tp.length) { problems.push(...tp.map((x) => id.slice(0, 12) + ': ' + x)); continue; }
    loaded.push({ id, edit, tensors });
  }
  if (problems.length) return { problems };
  let composed;
  try { composed = compose(loaded, baseReader(r.store, parent.base)); } catch (e) { return { problems: [(e as Error).message] }; }
  const totals = totalsOf(composed);
  const bounds = r.declared ?? r.authorized;
  const out = outOfBounds(composed.summaries, totals, bounds);
  if (out.length) return { problems: ['the composed intervention is out of bounds: ' + out.join('; ')] };
  const set: EditSet = { format: WEIGHT_EDIT_SET, rule: COMPOSE, start, base: parent.base, chip_layers: chip, genome, bounds, summaries: composed.summaries, totals };
  /* The tree: its manifest, and each edit's manifest, tensors and inputs, as files of its own. */
  const files: Record<string, BlobId> = { [SET_MANIFEST]: r.store.put(stableStringify(set)) };
  for (const e of loaded) {
    files['edits/' + e.id + '/edit.json'] = e.id;
    for (const m of e.edit.modules) files['edits/' + e.id + '/' + m.file] = m.sha256;
    if (e.edit.origin.kind === 'constructor' || e.edit.origin.kind === 'program') for (const [name, h] of Object.entries(e.edit.origin.inputs)) {
      if (!r.store.has(h)) return { problems: [e.id.slice(0, 12) + ': its input ' + name + ' is not in the store'] };
      files['edits/' + e.id + '/inputs/' + name] = h;
    }
  }
  const adapter = r.store.put(stableStringify({ format: 'blob-tree@1', files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : 1)) }));
  const child = normalizePackage({ ...parent, adapter, provenance: { parents: [executionHash(parent)], reason: r.reason ?? 'edited: ' + r.add.length + ' edit(s) added to its genome',
    sources: [...r.add.map((id) => 'edit:' + id), 'edit-set:' + adapter] } });
  return { child, set, adapter };
}

/** A set verified from its own tree, without a model: every edit read and checked from its files, the genome composed
    again from the start's base by its rule, the summaries compared module by module, and each constructor run again
    with the inputs the tree carries. Every measure it records is computed again and compared - per module and in total -
    and its bounds applied to them: valid bounds, never laxer than the authorized ones when those are given. Problems
    named; an empty list is a set that composes as it says, measures what it says and keeps within its bounds. */
export function verifyEditSet(store: BlobStore, pkg: JuniorPackage, authorized?: WeightBounds): string[] {
  const p = normalizePackage(pkg);
  if (adapterKind(store, p) !== 'edits') return ['the package has no set of edits'];
  const set = readEditSet(store, p.adapter!)!;
  if (set.format !== WEIGHT_EDIT_SET || set.rule !== COMPOSE) return ['the set is not ' + WEIGHT_EDIT_SET + ' with rule ' + COMPOSE];
  if (set.base !== p.base) return ['the set composes on another base than the package\'s'];
  const chip = Number((p.execution.circuit as Record<string, unknown>).chip_layers);
  if (!Number.isInteger(chip) || set.chip_layers !== chip) return ['the set says the circuit has ' + set.chip_layers + ' layers; the package\'s circuit says ' + (Number.isInteger(chip) ? chip : 'nothing')];
  const bp = boundsProblems(set.bounds, 'the set\'s bounds');
  if (bp.length) return bp;
  if (authorized) {
    const lax = laxer(set.bounds, authorized);
    if (lax.length) return lax.map((k) => 'the set\'s bound ' + k + ' is laxer than the authorized one');
  }
  const problems: string[] = [];
  let loaded: LoadedEdit[];
  try { loaded = editsInTree(store, p.adapter!); } catch (e) { return [(e as Error).message]; }
  for (const e of loaded) {
    problems.push(...editProblems(e.edit, set.chip_layers, { programs: true }).map((x) => e.id.slice(0, 12) + ': ' + x));
    problems.push(...e.edit.modules.flatMap((m, i) => tensorProblems(m, e.tensors[i as number] as Record<string, RawTensor>)).map((x) => e.id.slice(0, 12) + ': ' + x));
  }
  if (problems.length) return problems;
  const read = baseReader(store, p.base);
  try {
    const again = compose(loaded, read);
    for (const [m, s] of Object.entries(set.summaries)) {
      const a = again.summaries[m];
      if (!a) problems.push(m + ': summarized but not composed');
      else if (a.digest !== s.digest || a.base_digest !== s.base_digest) problems.push(m + ': composed again, it gives other weights than the set says');
      else if (stableStringify(a) !== stableStringify(s)) problems.push(m + ': its measures are not the ones the set records');
    }
    for (const m of Object.keys(again.summaries)) if (!set.summaries[m]) problems.push(m + ': composed but not summarized');
    const totals = totalsOf(again);
    if (stableStringify(totals) !== stableStringify(set.totals)) problems.push('its totals are not the ones the set records');
    problems.push(...outOfBounds(again.summaries, totals, set.bounds).map((x) => 'out of its bounds: ' + x));
  } catch (e) { problems.push((e as Error).message); }
  const t = store.tree(p.adapter!)!;
  for (const e of loaded) {
    const origin = e.edit.origin;
    if (origin.kind === 'program') {
      const missing = Object.keys(origin.inputs).filter((n) => t.files['edits/' + e.id + '/inputs/' + n] !== origin.inputs[n]);
      if (missing.length) problems.push(e.id.slice(0, 12) + ': its inputs ' + missing.join(', ') + ' do not travel in the tree');
      /* A program runs again only in its isolated backend: verifyPrograms does it; without one it stays incomplete. */
      else problems.push(INCOMPLETE + e.id.slice(0, 12) + ' is a program: only its isolated backend can run it again');
      continue;
    }
    if (e.edit.origin.kind !== 'constructor') continue;
    const o = e.edit.origin;
    const inputs: Record<string, Buffer> = {};
    for (const [name, h] of Object.entries(o.inputs)) {
      const b = t.files['edits/' + e.id + '/inputs/' + name];
      if (!b || b !== h) { problems.push(e.id.slice(0, 12) + ': its input ' + name + ' does not travel in the tree'); continue; }
      inputs[name] = store.get(b);
    }
    const c = CONSTRUCTORS[o.constructor];
    try {
      const built = c.build(o.args, inputs, read);
      if ('problems' in built) { problems.push(e.id.slice(0, 12) + ': ' + built.problems.join('; ')); continue; }
      const same = built.modules.length === e.edit.modules.length && built.modules.every((m, i) => m.module === e.edit.modules[i].module
        && sha256(writeSafetensors(m.tensors)) === e.edit.modules[i].sha256)
        && stableStringify(Object.fromEntries(Object.entries(built.inputs).map(([k, v]) => [k, sha256(v)]))) === stableStringify(o.inputs);
      if (!same) problems.push(e.id.slice(0, 12) + ': ' + o.constructor + ' run again with its inputs does not give its values');
    } catch (err) { problems.push(e.id.slice(0, 12) + ': ' + (err as Error).message); }
  }
  return problems;
}

/** A problem of verification that is not a contradiction but a check not done (§10): a program not run again. */
export const INCOMPLETE = 'incomplete: ';

/** Program edits run again in their isolated backend: each one's code and inputs from the set's tree, the base where the
    backend reads it; the tensors it writes compared with the edit's. Answers verifyEditSet's problems with those checks
    done: each program confirmed drops its `incomplete`, each one that differs becomes a contradiction. */
export async function verifyPrograms(store: BlobStore, pkg: JuniorPackage, backend: IsolatedBackend, baseDir: string, limits: ProgramLimits, authorized?: WeightBounds): Promise<string[]> {
  const p = normalizePackage(pkg);
  const problems = verifyEditSet(store, p, authorized);
  if (adapterKind(store, p) !== 'edits') return problems;
  const t = store.tree(p.adapter!)!;
  let loaded: LoadedEdit[];
  try { loaded = editsInTree(store, p.adapter!); } catch { return problems; }
  const out = problems.filter((x) => !x.startsWith(INCOMPLETE));
  for (const e of loaded) {
    const o = e.edit.origin;
    if (o.kind !== 'program') continue;
    if (o.backend !== backend.id) { out.push(INCOMPLETE + e.id.slice(0, 12) + ' was run by ' + o.backend + ', this backend is ' + backend.id); continue; }
    const inputs: Record<string, Buffer> = {};
    for (const n of Object.keys(o.inputs)) inputs[n] = store.get(t.files['edits/' + e.id + '/inputs/' + n]);
    const { 'program.py': code, ...rest } = inputs;
    const again = await runProgramEdit(backend, code.toString('utf8'), rest, baseDir, limits);
    if ('problems' in again) { out.push(e.id.slice(0, 12) + ': run again, ' + again.problems.join('; ')); continue; }
    const same = again.modules.length === e.edit.modules.length && again.modules.every((m, i) => m.module === e.edit.modules[i].module && m.encoding === e.edit.modules[i].encoding
      && sha256(writeSafetensors(m.tensors)) === e.edit.modules[i].sha256);
    if (!same) out.push(e.id.slice(0, 12) + ': its program run again does not give its values');
  }
  return out;
}

/** A program's outputs read as an edit's modules: out/modules.json lists them ({module, encoding, shape, file}), each
    file a safetensors with B and A, or indices and values. */
async function runProgramEdit(backend: IsolatedBackend, code: string, inputs: Record<string, Buffer>, baseDir: string, limits: ProgramLimits): Promise<{ modules: EditDraft['modules'] } | { problems: string[] }> {
  const r = await backend.run({ code, inputs, base: baseDir, limits });
  if (r.state !== 'finished') return { problems: ['the program ' + r.state + ': ' + (r.reason ?? '')] };
  let list: { module: string; encoding: 'lowrank' | 'sparse'; shape: [number, number]; file: string }[];
  try { list = JSON.parse(r.outputs['modules.json'].toString('utf8')); } catch { return { problems: ['the program wrote no readable out/modules.json'] }; }
  if (!Array.isArray(list) || !list.length) return { problems: ['out/modules.json lists no module'] };
  const modules: EditDraft['modules'][number][] = [];
  for (const m of list) {
    const b = r.outputs[m?.file];
    if (!b) return { problems: ['out/' + m?.file + ' is missing'] };
    try { modules.push({ module: m.module, encoding: m.encoding, shape: m.shape, tensors: readSafetensors(b) }); } catch (e) { return { problems: ['out/' + m.file + ': ' + (e as Error).message] }; }
  }
  return { modules };
}

/** An edit written by a program of the strong model, run in the isolated backend: refused when there is none (the process
    sandbox never counts). Its code and inputs recorded as its inputs, its outputs materialized and checked like any edit. */
export async function programEdit(store: BlobStore, start: JuniorPackage, o: { code: string; inputs: Record<string, Buffer>; backend: IsolatedBackend | null; baseDir: string; limits: ProgramLimits;
  hypothesis: Hypothesis; authorship: Authorship }): Promise<{ id: string } | { problems: string[] }> {
  if (!o.backend) return { problems: ['origin "program": there is no isolated backend for free programs; the process sandbox does not count as one'] };
  if ('program.py' in o.inputs) return { problems: ['an input may not be named program.py: that is the code'] };
  const p = normalizePackage(start);
  const chip = Number((p.execution.circuit as Record<string, unknown>).chip_layers);
  const r = await runProgramEdit(o.backend, o.code, o.inputs, o.baseDir, o.limits);
  if ('problems' in r) return r;
  return putEdit(store, { modules: r.modules, hypothesis: o.hypothesis, authorship: o.authorship, inputs: { ...o.inputs, 'program.py': Buffer.from(o.code, 'utf8') },
    origin: { kind: 'program', backend: o.backend.id, base: p.base, inputs: {} } }, chip, { programs: true });
}

/* --- Closed constructors (§4.3) -------------------------------------------------------------------------------------- */

export interface Built { readonly modules: EditDraft['modules']; readonly inputs: Record<string, Buffer> }
export interface Constructor {
  /** What it builds, from its arguments, its inputs (files) and the start's weights; its inputs as it records them. */
  build(args: Readonly<Record<string, unknown>>, inputs: Readonly<Record<string, Buffer>>, base: BaseReader): Built | { problems: string[] };
}

/** project_out@1: the direction d taken out of a module's output. d is normalized inside, d̂ = d/‖d‖, and recorded so;
    ΔW = −d̂·(d̂ᵀW), of rank 1: B = −d̂, A = d̂ᵀW, each A_j summed over i in ascending order in float64 and rounded once.
    Its arguments checked first: d finite, not null, of the module's output dimension. */
const projectOut: Constructor = {
  build(args, inputs, base) {
    const module = args.module;
    if (typeof module !== 'string' || !EDITABLE.has(module.split('.').pop()!)) return { problems: ['project_out: "module", an editable module'] };
    const file = inputs['d.safetensors'];
    if (!file) return { problems: ['project_out: its input d.safetensors with the tensor d'] };
    const t = readSafetensors(file);
    if (!t.d || t.d.dtype !== 'F32' || t.d.shape.length !== 1) return { problems: ['project_out: d, an F32 vector'] };
    const d = f32(t.d);
    const W = base(module + '.weight');
    const [dout, din] = W.shape;
    if (d.length !== dout) return { problems: ['project_out: d has ' + d.length + ' entries, the output of ' + module + ' ' + dout] };
    if (!d.every((x) => Number.isFinite(x))) return { problems: ['project_out: d has values that are not finite'] };
    let n2 = 0;
    for (const x of d) n2 += x * x;
    if (!(n2 > 0)) return { problems: ['project_out: d is the null vector: there is no direction to take out'] };
    const norm = Math.sqrt(n2);
    const dh = Float32Array.from(d, (x) => x / norm);
    const A = new Float32Array(din);
    for (let j = 0; j < din; j++) {
      let s = 0;
      for (let i = 0; i < dout; i++) s += dh[i] * bf16Value(W.bits[i * din + j]);
      A[j] = s;
    }
    const B = Float32Array.from(dh, (x) => -x);
    return {
      modules: [{ module, encoding: 'lowrank', shape: [dout, din], tensors: { B: tensorF32([dout, 1], B), A: tensorF32([1, din], A) } }],
      inputs: { 'd.safetensors': writeSafetensors({ d: tensorF32([dout], d), d_hat: tensorF32([dout], dh) }) }
    };
  }
};

/* Shared pieces of the constructors: each fixes its arithmetic (float64 sums in ascending order, one rounding to fp32). */

type Problems = { problems: string[] };
const fail = (name: string, why: string): Problems => ({ problems: [name + ': ' + why] });

function editableModule(name: string, args: Readonly<Record<string, unknown>>): string | Problems {
  const m = args.module;
  if (typeof m !== 'string' || !EDITABLE.has(m.split('.').pop()!)) return fail(name, '"module", an editable module');
  return m;
}

function alphaOf(name: string, args: Readonly<Record<string, unknown>>): number | Problems {
  const a = args.alpha;
  if (typeof a !== 'number' || !Number.isFinite(a) || a === 0) return fail(name, '"alpha", a finite number other than 0');
  return a;
}

/** A vector normalized as a direction: finite, not null, of its dimension; v/‖v‖ with ‖v‖ summed in float64. */
function direction(name: string, what: string, v: Float32Array | Float64Array, dim: number): Float32Array | Problems {
  if (v.length !== dim) return fail(name, what + ' has ' + v.length + ' entries, ' + dim + ' expected');
  if (!v.every((x) => Number.isFinite(x))) return fail(name, what + ' has values that are not finite');
  let n2 = 0;
  for (const x of v) n2 += x * x;
  if (!(n2 > 0) || !Number.isFinite(n2)) return fail(name, what + ' is the null vector (or its norm is not finite): there is no direction');
  const n = Math.sqrt(n2);
  return Float32Array.from(v, (x) => x / n);
}

const valueOf = (W: { bits: Uint16Array }, i: number): number => bf16Value(W.bits[i]);

/** ΔW = α·U·(UᵀW) for orthonormal directions U (k of them, each of d_out): B = α·U (rounded once), A = UᵀW, each A_rj
    summed over i in ascending order in float64 and rounded once. */
function scaleSubspace(U: readonly Float32Array[], alpha: number, W: { shape: [number, number]; bits: Uint16Array }): { B: RawTensor; A: RawTensor } {
  const [dout, din] = W.shape, k = U.length;
  const B = new Float32Array(dout * k), A = new Float32Array(k * din);
  for (let r = 0; r < k; r++) {
    for (let i = 0; i < dout; i++) B[i * k + r] = alpha * U[r][i];
    const acc = new Float64Array(din);
    for (let i = 0; i < dout; i++) {
      const u = U[r][i];
      if (u === 0) continue;
      const row = i * din;
      for (let j = 0; j < din; j++) acc[j] += u * valueOf(W, row + j);
    }
    for (let j = 0; j < din; j++) A[r * din + j] = acc[j];
  }
  return { B: tensorF32([dout, k], B), A: tensorF32([k, din], A) };
}

/** add_direction@1: ΔW = α·û·v̂ᵀ, u of the module's output and v of its input, both normalized inside and recorded so. */
const addDirection: Constructor = {
  build(args, inputs, base) {
    const N = 'add_direction';
    const module = editableModule(N, args);
    if (typeof module !== 'string') return module;
    const alpha = alphaOf(N, args);
    if (typeof alpha !== 'number') return alpha;
    const file = inputs['uv.safetensors'];
    if (!file) return fail(N, 'its input uv.safetensors with the tensors u and v');
    const t = readSafetensors(file);
    if (!t.u || !t.v || t.u.dtype !== 'F32' || t.v.dtype !== 'F32') return fail(N, 'u and v, F32 vectors');
    const W = base(module + '.weight');
    const [dout, din] = W.shape;
    const u = direction(N, 'u', f32(t.u), dout), v = direction(N, 'v', f32(t.v), din);
    if (!(u instanceof Float32Array)) return u;
    if (!(v instanceof Float32Array)) return v;
    return {
      modules: [{ module, encoding: 'lowrank', shape: [dout, din], tensors: { B: tensorF32([dout, 1], Array.from(u, (x) => alpha * x)), A: tensorF32([1, din], v) } }],
      inputs: { 'uv.safetensors': writeSafetensors({ u: t.u, v: t.v, u_hat: tensorF32([dout], u), v_hat: tensorF32([din], v) }) }
    };
  }
};

/** mean_difference@1: the direction from the mean activation of the cases of `b` to that of `a`, in the module's output,
    taken from activation files the lab recorded (one row per case); ΔW = α·d̂·(d̂ᵀW), α = −1 taking it out. */
const meanDifference: Constructor = {
  build(args, inputs, base) {
    const N = 'mean_difference';
    const module = editableModule(N, args);
    if (typeof module !== 'string') return module;
    const alpha = alphaOf(N, args);
    if (typeof alpha !== 'number') return alpha;
    const sides = [args.a, args.b];
    if (sides.some((x) => !Array.isArray(x) || !x.length || x.some((f) => typeof f !== 'string'))) return fail(N, '"a" and "b", the activation files of each side');
    const W = base(module + '.weight');
    const [dout, din] = W.shape;
    const means: Float64Array[] = [];
    const kept: Record<string, Buffer> = {};
    for (const side of sides as string[][]) {
      const sum = new Float64Array(dout);
      let rows = 0;
      for (const f of side) {
        const b = inputs[f];
        if (!b) return fail(N, 'no input ' + f);
        kept[f] = b;
        const t = readSafetensors(b)[module];
        if (!t || t.dtype !== 'F32' || t.shape.length !== 2 || t.shape[1] !== dout) return fail(N, f + ' has no F32 activations [cases, ' + dout + '] of ' + module);
        const x = f32(t);
        if (!x.every((y) => Number.isFinite(y))) return fail(N, f + ' has values that are not finite');
        for (let r = 0; r < t.shape[0]; r++) for (let i = 0; i < dout; i++) sum[i] += x[r * dout + i];
        rows += t.shape[0];
      }
      if (!rows) return fail(N, 'a side without cases');
      means.push(sum.map((x) => x / rows));
    }
    if ((sides[0] as string[]).some((f) => (sides[1] as string[]).includes(f))) return fail(N, 'a file on both sides');
    const d = direction(N, 'the mean difference', means[0].map((x, i) => x - means[1][i]), dout);
    if (!(d instanceof Float32Array)) return d;
    const { B, A } = scaleSubspace([d], alpha, W);
    return { modules: [{ module, encoding: 'lowrank', shape: [dout, din], tensors: { B, A } }], inputs: { ...kept, 'direction.safetensors': writeSafetensors({ d_hat: tensorF32([dout], d) }) } };
  }
};

/** A seeded generator (mulberry32): the same start vectors on every machine. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  };
}

/** Modified Gram-Schmidt in float64, in order: a column that vanishes is replaced by the next seeded vector. */
function orthonormalize(Q: Float64Array[], next: () => number): void {
  for (let r = 0; r < Q.length; r++) {
    for (let tries = 0; ; tries++) {
      for (let p = 0; p < r; p++) {
        let dot = 0;
        for (let i = 0; i < Q[r].length; i++) dot += Q[p][i] * Q[r][i];
        for (let i = 0; i < Q[r].length; i++) Q[r][i] -= dot * Q[p][i];
      }
      let n2 = 0;
      for (const x of Q[r]) n2 += x * x;
      if (n2 > 1e-24 || tries > 4) { const n = Math.sqrt(n2) || 1; for (let i = 0; i < Q[r].length; i++) Q[r][i] /= n; break; }
      for (let i = 0; i < Q[r].length; i++) Q[r][i] = next();
    }
  }
}

/** Cyclic Jacobi on a small symmetric matrix, a fixed number of sweeps: its eigenvalues and eigenvectors (columns). */
function jacobi(T: number[][], sweeps = 60): { values: number[]; vectors: number[][] } {
  const k = T.length, a = T.map((r) => [...r]), v: number[][] = T.map((_, i) => T.map((__, j) => (i === j ? 1 : 0) as number));
  for (let s = 0; s < sweeps; s++) for (let p = 0; p < k; p++) for (let q = p + 1; q < k; q++) {
    if (Math.abs(a[p][q]) < 1e-300) continue;
    const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
    const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
    const c = 1 / Math.sqrt(t * t + 1), sn = t * c;
    for (let r = 0; r < k; r++) { const x = a[r][p], y = a[r][q]; a[r][p] = c * x - sn * y; a[r][q] = sn * x + c * y; }
    for (let r = 0; r < k; r++) { const x = a[p][r], y = a[q][r]; a[p][r] = c * x - sn * y; a[q][r] = sn * x + c * y; }
    for (let r = 0; r < k; r++) { const x = v[r][p], y = v[r][q]; v[r][p] = c * x - sn * y; v[r][q] = sn * x + c * y; }
  }
  return { values: a.map((r, i) => r[i]), vectors: v };
}

/** The k first left singular directions of W, deterministically: subspace iteration on W·Wᵀ from seeded start vectors
    (a fixed number of iterations, float64 sums in ascending order), then Rayleigh-Ritz on the k×k projection, sorted by
    singular value. The same code gives the same bits everywhere; it approximates, it does not claim exactness. */
export function topSingular(W: { shape: [number, number]; bits: Uint16Array }, k: number, iterations = 48): { U: Float32Array[]; s: number[] } {
  const [dout, din] = W.shape;
  const next = seeded(0x5eed + k);
  const Q: Float64Array[] = Array.from({ length: k }, () => Float64Array.from({ length: dout }, next));
  const wt = (q: Float64Array): Float64Array => {
    const y = new Float64Array(din);
    for (let i = 0; i < dout; i++) { const qi = q[i]; if (qi === 0) continue; const row = i * din; for (let j = 0; j < din; j++) y[j] += qi * valueOf(W, row + j); }
    return y;
  };
  const w = (y: Float64Array): Float64Array => {
    const z = new Float64Array(dout);
    for (let i = 0; i < dout; i++) { let s = 0; const row = i * din; for (let j = 0; j < din; j++) s += valueOf(W, row + j) * y[j]; z[i] = s; }
    return z;
  };
  orthonormalize(Q, next);
  for (let it = 0; it < iterations; it++) {
    for (let r = 0; r < k; r++) Q[r] = w(wt(Q[r]));
    orthonormalize(Q, next);
  }
  const Y = Q.map(wt);
  const T = Y.map((a) => Y.map((b) => { let s = 0; for (let j = 0; j < din; j++) s += a[j] * b[j]; return s; }));
  const { values, vectors } = jacobi(T);
  const order = values.map((x, i) => [x, i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]).map(([, i]) => i);
  const U = order.map((c) => {
    const u = new Float64Array(dout);
    for (let r = 0; r < k; r++) { const f = vectors[r][c]; for (let i = 0; i < dout; i++) u[i] += f * Q[r][i]; }
    let n2 = 0; for (const x of u) n2 += x * x;
    const n = Math.sqrt(n2) || 1;
    return Float32Array.from(u, (x) => x / n);
  });
  return { U, s: order.map((c) => Math.sqrt(Math.max(0, values[c]))) };
}

/** top_singular@1: ΔW = α·U_k·(U_kᵀW) on the module's k first singular directions (α = −1 takes them out); the
    directions and singular values recorded. */
const topSingularC: Constructor = {
  build(args, _inputs, base) {
    const N = 'top_singular';
    const module = editableModule(N, args);
    if (typeof module !== 'string') return module;
    const alpha = alphaOf(N, args);
    if (typeof alpha !== 'number') return alpha;
    const W = base(module + '.weight');
    const [dout, din] = W.shape;
    const k = args.k;
    if (!Number.isInteger(k) || (k as number) < 1 || (k as number) > Math.min(16, dout, din)) return fail(N, '"k", a whole number from 1 to ' + Math.min(16, dout, din));
    const { U, s } = topSingular(W, k as number);
    const { B, A } = scaleSubspace(U, alpha, W);
    const flat = new Float32Array(U.length * dout);
    U.forEach((u, r) => flat.set(u, r * dout));
    return { modules: [{ module, encoding: 'lowrank', shape: [dout, din], tensors: { B, A } }],
      inputs: { 'singular.safetensors': writeSafetensors({ U: tensorF32([U.length, dout], flat), s: tensorF32([s.length], s) }) } };
  }
};

/** scale_rows@1 / scale_cols@1: the chosen rows (or columns) scaled by 1 + α, as a sparse change α·W on their entries. */
function scaleLines(kind: 'rows' | 'cols'): Constructor {
  return {
    build(args, _inputs, base) {
      const N = 'scale_' + kind;
      const module = editableModule(N, args);
      if (typeof module !== 'string') return module;
      const alpha = alphaOf(N, args);
      if (typeof alpha !== 'number') return alpha;
      const W = base(module + '.weight');
      const [dout, din] = W.shape;
      const lines = args[kind], limit = kind === 'rows' ? dout : din;
      if (!Array.isArray(lines) || !lines.length || lines.some((x, i) => !Number.isInteger(x) || x < 0 || x >= limit || (i > 0 && x <= lines[i - 1])))
        return fail(N, '"' + kind + '", strictly increasing indices below ' + limit);
      const idx: number[] = [], val: number[] = [];
      const add = (x: number) => { const w = valueOf(W, x); if (w !== 0) { idx.push(x); val.push(alpha * w); } };
      if (kind === 'rows') for (const i of lines as number[]) for (let j = 0; j < din; j++) add(i * din + j);
      else for (let i = 0; i < dout; i++) for (const j of lines as number[]) add(i * din + j);
      if (!idx.length) return fail(N, 'the lines chosen are all zero: nothing to scale');
      return { modules: [{ module, encoding: 'sparse', shape: [dout, din], tensors: { indices: tensorI64(idx), values: tensorF32([val.length], val) } }], inputs: {} };
    }
  };
}

export const CONSTRUCTORS: Readonly<Record<string, Constructor>> = {
  'project_out@1': projectOut, 'add_direction@1': addDirection, 'mean_difference@1': meanDifference,
  'top_singular@1': topSingularC, 'scale_rows@1': scaleLines('rows'), 'scale_cols@1': scaleLines('cols')
};

/** An edit built by a closed constructor and stored: its values materialized, its inputs recorded as it read them. */
export function construct(store: BlobStore, start: JuniorPackage, o: { constructor: string; args: Record<string, unknown>; inputs: Record<string, Buffer>; hypothesis: Hypothesis; authorship: Authorship }): { id: string } | { problems: string[] } {
  const c = CONSTRUCTORS[o.constructor];
  if (!c) return { problems: ['no constructor ' + o.constructor + ': among ' + Object.keys(CONSTRUCTORS).join(', ')] };
  const p = normalizePackage(start);
  const chip = Number((p.execution.circuit as Record<string, unknown>).chip_layers);
  let built;
  try { built = c.build(o.args, o.inputs, baseReader(store, p.base)); } catch (e) { return { problems: [(e as Error).message] }; }
  if ('problems' in built) return built;
  return putEdit(store, { modules: built.modules, hypothesis: o.hypothesis, authorship: o.authorship, inputs: built.inputs,
    origin: { kind: 'constructor', constructor: o.constructor, args: o.args, base: p.base, inputs: {} } }, chip);
}

/** Where a worker's report of the weights it served differs from the set its package carries, or null. */
export function weightsMismatch(store: BlobStore, pkg: JuniorPackage, loaded: Readonly<Record<string, { base: string; edited: string }>> | null | undefined): string | null {
  if (adapterKind(store, pkg) !== 'edits') return null;
  const set = readEditSet(store, pkg.adapter!)!;
  if (!loaded) return 'the worker did not say the weights it composed';
  const wrong: string[] = [];
  for (const [m, s] of Object.entries(set.summaries)) {
    const l = loaded[m];
    if (!l) wrong.push(m + ' (not composed)');
    else if (l.base !== s.base_digest) wrong.push(m + ' (its start is not the checkpoint\'s tensor)');
    else if (l.edited !== s.digest) wrong.push(m + ' (composed into other weights)');
  }
  for (const m of Object.keys(loaded)) if (!set.summaries[m]) wrong.push(m + ' (composed but not in the set)');
  return wrong.length ? 'its edited weights are not the set\'s: ' + wrong.join(', ') : null;
}

