import { stableStringify } from '../core/hash.ts';
import { executionHash, normalizePackage, type BlobId, type BlobStore, type JuniorPackage } from './package.ts';
import {
  EDITABLE, MASK_MANIFEST, WEIGHT_EDIT, adapterKind, baseReader, compose, i64, layerOf, readSafetensors, tensorF32, tensorI64, totalsOf, writeSafetensors,
  type BaseReader, type LoadedEdit, type ModuleSummary, type RawTensor, type SetTotals
} from './weights.ts';

/* ============================================================================
 * THE mask@1 ADAPTER (SPEC-EDICION-PESOS §15.3, WE7a): weights DELETED - per module, the indices of its weight set to zero.
 *
 *   mask.json            its manifest: the start (execution hash) and base, the circuit's layers, each module's indices
 *                        file (by its sha256) and how many it deletes, its bounds, and the measures of §3.3
 *   m<i>.safetensors     a module's indices, I64, strictly increasing inside its matrix
 *
 * Applied in the worker by setting those entries to zero: exact in any precision (zero is zero); a module touched goes
 * through the composition's rule like an edited one (its -0 entries come out +0). Composition represents it
 * as a `sparse` change of value -W at those indices, so its size is measured as an edit's (summaries, totals): applying the
 * mask and composing that change give the same weights, bit for bit (verifyMask checks it).
 *
 * What may be deleted: modules of the layers past the circuit's (the computer is never touched), among the editable ones,
 * at most the fraction the condition authorizes (its manifest's "masks"), per module and in total - a declared bound may
 * only be stricter. A mask is made from a version without an adapter, and a version with one receives nothing more: no
 * edits, no other training (no recipe combines them). What it learned is the host's word, as for any training.
 * ========================================================================== */

export const MASK = 'mask@1';

/** The fraction of a module's entries, and of all the modules' together, a mask may delete. */
export interface MaskBounds { readonly per_module: { readonly max_fraction: number }; readonly total: { readonly max_fraction: number } }

export function maskBoundsProblems(raw: unknown, where = '"masks"'): string[] {
  const b = raw as MaskBounds;
  const ok = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
  if (!b || typeof b !== 'object' || !b.per_module || !b.total) return [where + ': {"per_module": {"max_fraction"}, "total": {"max_fraction"}}'];
  return [...(ok(b.per_module.max_fraction) ? [] : [where + '.per_module.max_fraction: a fraction in [0, 1]']), ...(ok(b.total.max_fraction) ? [] : [where + '.total.max_fraction: a fraction in [0, 1]'])];
}

export interface MaskModule {
  /** The module by its name in the checkpoint (its weight name + ".weight"). */
  readonly module: string;
  readonly shape: readonly [number, number];
  /** Its indices file in the mask's tree, and the SHA-256 of its bytes. */
  readonly file: string;
  readonly sha256: string;
  readonly deleted: number;
}

export interface Mask {
  readonly format: typeof MASK;
  readonly start: string;
  readonly base: BlobId;
  readonly chip_layers: number;
  readonly modules: readonly MaskModule[];
  /** The bounds it was made under: the authorized ones, or the stricter ones it declared. */
  readonly bounds: MaskBounds;
  /** The measures of §3.3, of the equivalent sparse change of -W. */
  readonly summaries: Readonly<Record<string, ModuleSummary>>;
  readonly totals: SetTotals;
}

/** What is wrong with a module's deletion: a module of a layer past the circuit, editable, its indices strictly increasing
    inside its matrix and at least one. */
export function maskModuleProblems(module: string, shape: readonly [number, number], indices: readonly number[], chip: number): string[] {
  const at = 'module ' + module;
  const p: string[] = [];
  const layer = layerOf(module);
  if (layer === null) p.push(at + ': not a module of a layer (model.layers.N...)');
  else if (layer < chip) p.push(at + ': layer ' + layer + ' belongs to the circuit (its first ' + chip + '): the computer is never touched');
  if (!EDITABLE.has(module.split('.').pop()!)) p.push(at + ': among ' + [...EDITABLE].join(', '));
  if (!indices.length) p.push(at + ': no index to delete');
  const n = shape[0] * shape[1];
  for (let k = 0; k < indices.length; k++) if (!(Number.isInteger(indices[k]) && indices[k] >= 0 && indices[k] < n) || (k && indices[k] <= indices[k - 1])) { p.push(at + ': indices strictly increasing, inside its ' + shape[0] + 'x' + shape[1] + ' entries'); break; }
  return p;
}

/** A deletion as the sparse change of -W it is: the edit composition measures (and composes) exactly. */
export function asSparse(id: string, deletions: readonly { readonly module: string; readonly indices: readonly number[] }[], read: BaseReader): LoadedEdit {
  const modules = deletions.map((d) => {
    const W = read(d.module + '.weight');
    return { module: d.module, shape: W.shape, values: d.indices.map((i) => -bf16ToNumber(W.bits[i])) };
  });
  return { id, edit: { format: WEIGHT_EDIT, modules: modules.map((m, i) => ({ module: m.module, encoding: 'sparse' as const, shape: m.shape, file: 'm' + i + '.safetensors', sha256: '' })),
    hypothesis: { competence: 'mask', mechanism: 'deletion', effect: 'as measured' }, origin: { kind: 'written' }, authorship: 'control' },
    tensors: deletions.map((d, i) => ({ indices: tensorI64(d.indices), values: tensorF32([modules[i].values.length], modules[i].values) })) };
}
const F = new Float32Array(1), U = new Uint32Array(F.buffer);
const bf16ToNumber = (bits: number): number => { U[0] = (bits & 0xffff) << 16; return F[0]; };

/** The weights of the modules a mask touches, with its entries set to zero (what the worker serves). A module touched
    goes through the composition's rule as any edited module does, W' = bf16(fp32(W) + delta): its -0 entries come out +0
    (one value, other bits), so applying the mask and composing its change are the same bits. */
export function applyMask(deletions: readonly { readonly module: string; readonly indices: readonly number[] }[], read: BaseReader): Record<string, Uint16Array> {
  const out: Record<string, Uint16Array> = {};
  for (const d of deletions) {
    const W = read(d.module + '.weight');
    const bits = W.bits.slice();
    for (let x = 0; x < bits.length; x++) if (bits[x] === 0x8000) bits[x] = 0;
    for (const i of d.indices) bits[i] = 0;
    out[d.module] = bits;
  }
  return out;
}

/** Where a fraction is over its bound, per module and in total. */
function overBounds(deletions: readonly { readonly module: string; readonly indices: readonly number[]; readonly entries: number }[], b: MaskBounds): string[] {
  const p: string[] = [];
  let deleted = 0, entries = 0;
  for (const d of deletions) {
    deleted += d.indices.length; entries += d.entries;
    if (!(d.indices.length / d.entries <= b.per_module.max_fraction)) p.push(d.module + ': ' + d.indices.length + ' of ' + d.entries + ' entries deleted, more than ' + b.per_module.max_fraction);
  }
  if (!(entries === 0 || deleted / entries <= b.total.max_fraction)) p.push('in total: ' + deleted + ' of ' + entries + ' entries deleted, more than ' + b.total.max_fraction);
  return p;
}

export type MaskResult = { readonly child: JuniorPackage; readonly mask: Mask; readonly adapter: BlobId } | { readonly problems: readonly string[] };

/** A mask made from a version without an adapter: each module checked, within its bounds (the authorized ones, or stricter
    ones it declares), measured as the sparse change of -W it is; its tree in the child's adapter slot. Refused with what is
    wrong before anything is stored. What the child learned is written by whoever made it (a training: the host). */
export function putMask(store: BlobStore, parent: JuniorPackage, deletions: readonly { readonly module: string; readonly indices: readonly number[] }[],
  o: { readonly authorized: MaskBounds | null | undefined; readonly declared?: MaskBounds; readonly reason?: string }): MaskResult {
  const p = normalizePackage(parent);
  if (p.adapter !== null) return { problems: ['the start already has an adapter (' + adapterKind(store, p) + '): a mask is made from a version without one'] };
  if (!o.authorized) return { problems: ['the condition authorizes no masks: its manifest fixes no "masks" bounds'] };
  const bp = maskBoundsProblems(o.authorized);
  if (bp.length) return { problems: bp };
  if (o.declared) {
    const dp = maskBoundsProblems(o.declared, 'the declared bounds');
    if (dp.length) return { problems: dp };
    const lax = [...(o.declared.per_module.max_fraction > o.authorized.per_module.max_fraction ? ['per_module.max_fraction'] : []), ...(o.declared.total.max_fraction > o.authorized.total.max_fraction ? ['total.max_fraction'] : [])];
    if (lax.length) return { problems: lax.map((k) => 'the declared bound ' + k + ' is laxer than the authorized one') };
  }
  const chip = Number((p.execution.circuit as Record<string, unknown>).chip_layers);
  if (!Number.isInteger(chip) || chip < 0) return { problems: ['the circuit of the package does not say its chip_layers: what may be deleted cannot be told'] };
  if (!deletions.length) return { problems: ['no module to delete from'] };
  const read = baseReader(store, p.base);
  const problems: string[] = [];
  const seen = new Set<string>();
  const shaped: { module: string; indices: readonly number[]; shape: readonly [number, number]; entries: number }[] = [];
  for (const d of deletions) {
    if (seen.has(d.module)) { problems.push('module ' + d.module + ': once per mask'); continue; }
    seen.add(d.module);
    let shape: readonly [number, number];
    try { shape = read(d.module + '.weight').shape; } catch (e) { problems.push('module ' + d.module + ': ' + (e as Error).message); continue; }
    const mp = maskModuleProblems(d.module, shape, d.indices, chip);
    if (mp.length) { problems.push(...mp); continue; }
    shaped.push({ module: d.module, indices: d.indices, shape, entries: shape[0] * shape[1] });
  }
  if (problems.length) return { problems };
  const bounds = o.declared ?? o.authorized;
  const over = overBounds(shaped, bounds);
  if (over.length) return { problems: ['the mask deletes more than its bounds allow: ' + over.join('; ')] };
  let composed;
  try { composed = compose([asSparse('mask', shaped, read)], read); } catch (e) { return { problems: [(e as Error).message] }; }
  const sorted = [...shaped].sort((a, b) => (a.module < b.module ? -1 : 1));
  const files: Record<string, BlobId> = {};
  const modules: MaskModule[] = sorted.map((d, i) => {
    const bytes = writeSafetensors({ indices: tensorI64(d.indices) });
    const file = 'm' + i + '.safetensors';
    files[file] = store.put(bytes);
    return { module: d.module, shape: [d.shape[0], d.shape[1]], file, sha256: files[file], deleted: d.indices.length };
  });
  const mask: Mask = { format: MASK, start: executionHash(p), base: p.base, chip_layers: chip, modules, bounds, summaries: composed.summaries, totals: totalsOf(composed) };
  files[MASK_MANIFEST] = store.put(stableStringify(mask));
  const adapter = store.put(stableStringify({ format: 'blob-tree@1', files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))) }));
  const child = normalizePackage({ ...p, adapter, provenance: { parents: [executionHash(p)], reason: o.reason ?? 'masked: ' + mask.totals.entries + ' entries measured, ' + modules.reduce((n, m) => n + m.deleted, 0) + ' deleted',
    sources: ['mask:' + adapter] } });
  return { child, mask, adapter };
}

export function readMask(store: BlobStore, adapter: BlobId): Mask | null {
  const t = store.tree(adapter);
  if (!t || !t.files[MASK_MANIFEST]) return null;
  return JSON.parse(store.get(t.files[MASK_MANIFEST]).toString('utf8')) as Mask;
}

/** A mask's deletions read from its own tree, each file checked against its hash. */
export function deletionsInTree(store: BlobStore, adapter: BlobId): { module: string; indices: number[] }[] {
  const t = store.tree(adapter)!;
  const mask = readMask(store, adapter)!;
  return mask.modules.map((m) => {
    const b = t.files[m.file];
    if (!b || b !== m.sha256) throw new Error(m.module + ': its indices ' + m.file + ' do not travel in the tree');
    const raw = readSafetensors(store.get(b)) as Record<string, RawTensor>;
    if (!raw.indices || raw.indices.dtype !== 'I64' || raw.indices.shape.length !== 1) throw new Error(m.module + ': its file holds no I64 indices');
    return { module: m.module, indices: i64(raw.indices) };
  });
}

/** A mask verified from its own tree, without a model: its modules checked, its bounds valid (never laxer than the
    authorized ones when given) and kept, its measures computed again - and applying it gives the weights composing its
    sparse change of -W gives, bit for bit, the digests it records. Problems named; empty: the mask is what it says. */
export function verifyMask(store: BlobStore, pkg: JuniorPackage, authorized?: MaskBounds): string[] {
  const p = normalizePackage(pkg);
  if (adapterKind(store, p) !== 'mask') return ['the package has no mask'];
  const mask = readMask(store, p.adapter!)!;
  if (mask.format !== MASK) return ['the mask is not ' + MASK];
  if (mask.base !== p.base) return ['the mask deletes from another base than the package\'s'];
  const chip = Number((p.execution.circuit as Record<string, unknown>).chip_layers);
  if (!Number.isInteger(chip) || mask.chip_layers !== chip) return ['the mask says the circuit has ' + mask.chip_layers + ' layers; the package\'s circuit says ' + (Number.isInteger(chip) ? chip : 'nothing')];
  const bp = maskBoundsProblems(mask.bounds, 'the mask\'s bounds');
  if (bp.length) return bp;
  if (authorized && (mask.bounds.per_module.max_fraction > authorized.per_module.max_fraction || mask.bounds.total.max_fraction > authorized.total.max_fraction)) return ['the mask\'s bounds are laxer than the authorized ones'];
  let deletions: { module: string; indices: number[] }[];
  try { deletions = deletionsInTree(store, p.adapter!); } catch (e) { return [(e as Error).message]; }
  const read = baseReader(store, p.base);
  const problems: string[] = [];
  const shaped = deletions.map((d, i) => {
    const shape = mask.modules[i].shape;
    problems.push(...maskModuleProblems(d.module, shape, d.indices, chip));
    if (d.indices.length !== mask.modules[i].deleted) problems.push(d.module + ': it deletes ' + d.indices.length + ', the mask says ' + mask.modules[i].deleted);
    return { ...d, shape, entries: shape[0] * shape[1] };
  });
  if (problems.length) return problems;
  problems.push(...overBounds(shaped, mask.bounds).map((x) => 'out of its bounds: ' + x));
  try {
    const again = compose([asSparse('mask', shaped, read)], read);
    if (stableStringify(again.summaries) !== stableStringify(mask.summaries)) problems.push('its measures are not the ones the mask records');
    if (stableStringify(totalsOf(again)) !== stableStringify(mask.totals)) problems.push('its totals are not the ones the mask records');
    /* Applying it and composing its sparse change of -W: the same weights, bit for bit. */
    const applied = applyMask(shaped, read);
    for (const d of shaped) if (Buffer.compare(Buffer.from(applied[d.module].buffer), Buffer.from(again.weights[d.module].buffer)) !== 0) problems.push(d.module + ': applying the mask and composing its change give other weights');
  } catch (e) { problems.push((e as Error).message); }
  return problems;
}

/** A program's mask@1 product read (SPEC-INVESTIGACION-EXTERNA §8.2): modules.json lists each module and its file, each
    file an I64 `indices` tensor. */
export function deletionsOfOutputs(outputs: Readonly<Record<string, Buffer>>): { deletions: { module: string; indices: number[] }[] } | { problems: string[] } {
  let list: unknown;
  try { list = JSON.parse((outputs['modules.json'] ?? Buffer.from('')).toString('utf8')); } catch { return { problems: ['a mask@1 product lists its modules in modules.json: [{"module", "file"}]'] }; }
  if (!Array.isArray(list) || !list.length) return { problems: ['modules.json: [{"module", "file"}], at least one'] };
  const deletions: { module: string; indices: number[] }[] = [];
  for (const m of list as { module?: unknown; file?: unknown }[]) {
    if (typeof m?.module !== 'string' || typeof m.file !== 'string' || !outputs[m.file]) return { problems: ['modules.json: each module with a file it wrote (' + String(m?.file) + ')'] };
    let t: Record<string, RawTensor>;
    try { t = readSafetensors(outputs[m.file]); } catch { return { problems: [m.file + ': not a safetensors file'] }; }
    if (!t.indices || t.indices.dtype !== 'I64' || t.indices.shape.length !== 1) return { problems: [m.file + ': an I64 "indices" tensor'] };
    deletions.push({ module: m.module, indices: i64(t.indices) });
  }
  return { deletions };
}

/** Wanda's scores of a module (SPEC-EDICION-PESOS §15.5): |W_ij| * ||X_j||, the norm of input channel j the square root of
    its sum of squares (input_norms). Row-major, as the weight. */
export function wandaScores(W: { readonly shape: readonly [number, number]; readonly bits: Uint16Array }, sumsq: ArrayLike<number>): Float64Array {
  const [dout, din] = W.shape;
  if (sumsq.length !== din) throw new Error('the input norms have ' + sumsq.length + ' channels; the weight takes ' + din);
  const norms = Array.from({ length: din }, (_, j) => Math.sqrt(sumsq[j]));
  const out = new Float64Array(dout * din);
  for (let i = 0; i < dout; i++) for (let j = 0; j < din; j++) out[i * din + j] = Math.abs(bf16ToNumber(W.bits[i * din + j])) * norms[j];
  return out;
}
