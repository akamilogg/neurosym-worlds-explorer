import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { stableStringify } from '../core/hash.ts';

/* ============================================================================
 * The JUNIOR, packaged (SPEC-METAPOLITICA-APRENDIZAJE §4): junior-package@1 is everything that defines a junior - its
 * base checkpoint, adapter, starting prompt, initial memory, decoding and execution - and where it came from. Large
 * bytes (checkpoints, adapters, memories, the firmware, the verifier) live in a blob store by their full SHA-256; the
 * manifest only names them.
 *
 * Its EXECUTION HASH is what serves and is measured: every part that can change an answer, with its defaults written
 * out, and never the provenance. Two packages with one name and another content are two juniors.
 *
 * A package is CLOSED when every blob it names is present with the bytes its hash says - a tree's files too. A hash
 * without its bytes never lets a package be called reconstructible.
 * ========================================================================== */

export const JUNIOR_PACKAGE = 'junior-package@1';

/** A blob's id: the full SHA-256 of its bytes, in hex. */
export type BlobId = string;

export interface JuniorDecoding {
  /** 0 is greedy. The reference driver decodes greedily only: a worker that cannot apply another refuses it before running. */
  readonly temperature: number;
  readonly max_tokens: number;
  /** The circuit's own budget of tokens in one answer (the driver's max_chip). */
  readonly max_circuit_tokens: number;
  /** A forced output format, if the server offers one: a help of the harness, declared as such (§7). */
  readonly forced_format: string | null;
}

export interface JuniorMemory {
  /** The neural snapshot (memory.npz): the store's persistent heads. */
  readonly neural: BlobId | null;
  /** The reference twin of the same store: what the reference verifier starts from (§5.2). Both or neither. */
  readonly twin: BlobId | null;
}

export interface JuniorExecution {
  readonly firmware: BlobId;
  readonly tokenizer: BlobId;
  readonly chat_template: BlobId;
  readonly driver: BlobId;
  /** The reference verifier (§5.2): the same program checks a session and serves the teacher's memory (§8). */
  readonly verifier: BlobId;
  /** The circuit's configuration (chipformer.json's store and chip entries), as it is served. */
  readonly circuit: Readonly<Record<string, unknown>>;
  readonly precision: string;
  readonly quantization: string | null;
}

export interface JuniorProvenance {
  readonly parents: readonly string[];
  readonly reason: string;
  /** Datasets, trainings, runs whose memory was published into it: ids of the records that produced it. */
  readonly sources: readonly string[];
}

export interface JuniorPackage {
  readonly format: typeof JUNIOR_PACKAGE;
  readonly name: string;
  /** The base checkpoint: a tree blob (its files by hash). */
  readonly base: BlobId;
  /** A LoRA adapter (a tree blob), or none. */
  readonly adapter: BlobId | null;
  readonly prompt: string;
  readonly memory: JuniorMemory;
  readonly decoding: JuniorDecoding;
  readonly execution: JuniorExecution;
  readonly provenance: JuniorProvenance;
}

const isBlob = (v: unknown): v is BlobId => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
export const sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** A file's SHA-256 read in pieces: a checkpoint's shards are larger than a buffer may be. */
export function sha256File(file: string): string {
  const h = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(8 << 20);
    for (let n: number; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

const KEYS = {
  top: ['format', 'name', 'base', 'adapter', 'prompt', 'memory', 'decoding', 'execution', 'provenance'],
  memory: ['neural', 'twin'],
  decoding: ['temperature', 'max_tokens', 'max_circuit_tokens', 'forced_format'],
  execution: ['firmware', 'tokenizer', 'chat_template', 'driver', 'verifier', 'circuit', 'precision', 'quantization'],
  provenance: ['parents', 'reason', 'sources']
} as const;

const DEFAULTS = { decoding: { temperature: 0, max_tokens: 4000, max_circuit_tokens: 60000, forced_format: null }, quantization: null, adapter: null } as const;

function record(v: unknown, where: string, allowed: readonly string[]): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(where + ' must be an object');
  const extra = Object.keys(v).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Error(where + ' has unknown fields: ' + extra.join(', '));
  return v as Record<string, unknown>;
}

/** A package with every default written out, or an error naming what is wrong. Unknown fields are refused: an option
    the server would ignore is never accepted silently. */
export function normalizePackage(raw: unknown): JuniorPackage {
  const p = record(raw, 'the package', KEYS.top);
  if (p.format !== JUNIOR_PACKAGE) throw new Error('format must be ' + JUNIOR_PACKAGE);
  if (typeof p.name !== 'string' || !p.name) throw new Error('name must be a non-empty string');
  if (!isBlob(p.base)) throw new Error('base must be a blob id (sha256)');
  const adapter = p.adapter ?? DEFAULTS.adapter;
  if (adapter !== null && !isBlob(adapter)) throw new Error('adapter must be a blob id or null');
  if (typeof p.prompt !== 'string') throw new Error('prompt must be a string');
  const m = record(p.memory ?? { neural: null, twin: null }, 'memory', KEYS.memory);
  const neural = m.neural ?? null, twin = m.twin ?? null;
  if ((neural === null) !== (twin === null)) throw new Error('memory needs both its neural snapshot and its reference twin, or neither');
  if (neural !== null && (!isBlob(neural) || !isBlob(twin))) throw new Error('memory.neural and memory.twin must be blob ids');
  const d = record(p.decoding ?? {}, 'decoding', KEYS.decoding);
  const decoding: JuniorDecoding = {
    temperature: d.temperature === undefined ? DEFAULTS.decoding.temperature : Number(d.temperature),
    max_tokens: d.max_tokens === undefined ? DEFAULTS.decoding.max_tokens : Number(d.max_tokens),
    max_circuit_tokens: d.max_circuit_tokens === undefined ? DEFAULTS.decoding.max_circuit_tokens : Number(d.max_circuit_tokens),
    forced_format: (d.forced_format ?? DEFAULTS.decoding.forced_format) as string | null
  };
  if (!Number.isFinite(decoding.temperature) || decoding.temperature < 0) throw new Error('decoding.temperature must be a number >= 0');
  for (const k of ['max_tokens', 'max_circuit_tokens'] as const)
    if (!Number.isInteger(decoding[k]) || decoding[k] <= 0) throw new Error('decoding.' + k + ' must be a positive integer');
  if (decoding.forced_format !== null && typeof decoding.forced_format !== 'string') throw new Error('decoding.forced_format must be a string or null');
  const e = record(p.execution, 'execution', KEYS.execution);
  for (const k of ['firmware', 'tokenizer', 'chat_template', 'driver', 'verifier'] as const)
    if (!isBlob(e[k])) throw new Error('execution.' + k + ' must be a blob id');
  record(e.circuit, 'execution.circuit', Object.keys(e.circuit ?? {}));
  if (typeof e.precision !== 'string' || !e.precision) throw new Error('execution.precision must be a string');
  const quantization = e.quantization ?? DEFAULTS.quantization;
  if (quantization !== null && typeof quantization !== 'string') throw new Error('execution.quantization must be a string or null');
  const pr = record(p.provenance ?? { parents: [], reason: '', sources: [] }, 'provenance', KEYS.provenance);
  const strings = (v: unknown, w: string): string[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new Error(w + ' must be a list of strings');
    return [...v] as string[];
  };
  return {
    format: JUNIOR_PACKAGE, name: p.name, base: p.base, adapter: adapter as BlobId | null, prompt: p.prompt,
    memory: { neural: neural as BlobId | null, twin: twin as BlobId | null }, decoding,
    execution: { firmware: e.firmware as BlobId, tokenizer: e.tokenizer as BlobId, chat_template: e.chat_template as BlobId, driver: e.driver as BlobId,
      verifier: e.verifier as BlobId, circuit: e.circuit as Record<string, unknown>, precision: e.precision, quantization: quantization as string | null },
    provenance: { parents: strings(pr.parents, 'provenance.parents'), reason: typeof pr.reason === 'string' ? pr.reason : '', sources: strings(pr.sources, 'provenance.sources') }
  };
}

/** What serves and is measured (P4): every part that can change an answer, its defaults written out; never the name,
    the provenance, paths or dates. Full SHA-256 over key-sorted JSON. */
export function executionHash(pkg: JuniorPackage): string {
  const { name: _name, provenance: _provenance, ...served } = normalizePackage(pkg);
  return sha256(stableStringify(served));
}

/** The edition's identity: the whole manifest, provenance included. */
export function editionHash(pkg: JuniorPackage): string {
  return sha256(stableStringify(normalizePackage(pkg)));
}

/** Every blob a package names, at its top level (trees are walked by the store). */
export function blobsOf(pkg: JuniorPackage): BlobId[] {
  const e = pkg.execution;
  return [pkg.base, pkg.adapter, pkg.memory.neural, pkg.memory.twin, e.firmware, e.tokenizer, e.chat_template, e.driver, e.verifier]
    .filter((b): b is BlobId => b !== null);
}

/** The blobs a package names that are trees: its base checkpoint and its adapter. */
export function treesOf(pkg: JuniorPackage): BlobId[] {
  return [pkg.base, pkg.adapter].filter((b): b is BlobId => b !== null);
}

/* --- The blob store ------------------------------------------------------------------------------------------------- */

/** A tree blob: a directory, as the sorted map of its files to their blobs. */
export interface BlobTree { readonly format: 'blob-tree@1'; readonly files: Readonly<Record<string, BlobId>> }

/** Blobs by their full SHA-256, one file each, under a folder of its own. Writes go to a temporary file renamed into
    place: a blob is there whole or not at all. */
export class BlobStore {
  readonly root: string;
  constructor(root: string) { this.root = root; fs.mkdirSync(root, { recursive: true }); }

  pathOf(id: BlobId): string { return path.join(this.root, id.slice(0, 2), id); }
  has(id: BlobId): boolean { return fs.existsSync(this.pathOf(id)); }

  put(bytes: string | Uint8Array): BlobId {
    const id = sha256(bytes);
    const target = this.pathOf(id);
    if (fs.existsSync(target)) return id;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = target + '.' + process.pid + '.' + Math.random().toString(36).slice(2) + '.tmp';
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, target);
    return id;
  }

  /** A file stored by its hash without reading it whole: copied beside its place, checked, renamed into it. */
  putFile(file: string): BlobId {
    const id = sha256File(file);
    const target = this.pathOf(id);
    if (fs.existsSync(target)) return id;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = target + '.' + process.pid + '.' + Math.random().toString(36).slice(2) + '.tmp';
    fs.copyFileSync(file, tmp);
    if (sha256File(tmp) !== id) { fs.rmSync(tmp, { force: true }); throw new Error(file + ' changed while it was stored'); }
    fs.renameSync(tmp, target);
    return id;
  }

  /** Whether the blob's bytes still match its hash, read in pieces. */
  intact(id: BlobId): boolean { return this.has(id) && sha256File(this.pathOf(id)) === id; }

  get(id: BlobId): Buffer {
    const bytes = fs.readFileSync(this.pathOf(id));
    if (sha256(bytes) !== id) throw new Error('blob ' + id + ' does not match its hash');
    return bytes;
  }

  /** A directory as a tree blob: each file stored by its hash, the tree itself a blob. */
  putTree(dir: string): BlobId {
    const files: Record<string, BlobId> = {};
    const walk = (d: string, rel: string): void => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const r = rel ? rel + '/' + entry.name : entry.name;
        if (entry.isDirectory()) walk(path.join(d, entry.name), r);
        else if (entry.isFile()) files[r] = this.putFile(path.join(d, entry.name));
      }
    };
    walk(dir, '');
    return this.put(stableStringify({ format: 'blob-tree@1', files }));
  }

  /** The blob read as a tree, or null if it is not one. */
  tree(id: BlobId): BlobTree | null {
    try {
      const t = JSON.parse(this.get(id).toString('utf8'));
      return t && t.format === 'blob-tree@1' && t.files && typeof t.files === 'object' ? t as BlobTree : null;
    } catch { return null; }
  }

  /** A tree written back as a directory (each file checked against its hash on the way). */
  materialize(id: BlobId, dir: string): void {
    const t = this.tree(id);
    if (!t) throw new Error('blob ' + id + ' is not a tree');
    for (const [rel, blob] of Object.entries(t.files)) {
      const target = path.join(dir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (!this.intact(blob)) throw new Error('blob ' + blob + ' (' + rel + ') is missing or does not match its hash');
      fs.copyFileSync(this.pathOf(blob), target);
    }
  }
}

/** Whether a package is closed in a store (§4): every blob it names there with its bytes, trees walked. The missing and
    the corrupt are named; an empty list of both is a closed package. */
export function checkClosed(pkg: JuniorPackage, store: BlobStore): { closed: boolean; missing: BlobId[]; corrupt: BlobId[] } {
  const missing: BlobId[] = [], corrupt: BlobId[] = [];
  const seen = new Set<BlobId>();
  const visit = (id: BlobId, tree: boolean): void => {
    if (seen.has(id)) return;
    seen.add(id);
    if (!store.has(id)) { missing.push(id); return; }
    if (!store.intact(id)) { corrupt.push(id); return; }
    if (!tree) return;
    const t = store.tree(id);
    if (!t) { corrupt.push(id); return; }
    for (const b of Object.values(t.files)) visit(b, false);
  };
  const p = normalizePackage(pkg);
  /* The driver may be a folder (a tree): its files are part of the package too. */
  for (const b of blobsOf(p)) visit(b, treesOf(p).includes(b) || (b === p.execution.driver && store.has(b) && store.intact(b) && store.tree(b) !== null));
  return { closed: !missing.length && !corrupt.length, missing, corrupt };
}

/** A closed package exported to a folder of its own: its manifest and every blob it needs, nothing else. Refuses an open one. */
export function exportPackage(pkg: JuniorPackage, store: BlobStore, dir: string): { manifest: string; blobs: number } {
  const check = checkClosed(pkg, store);
  if (!check.closed) throw new Error('the package is not closed: ' + [...check.missing.map((m) => 'missing ' + m), ...check.corrupt.map((c) => 'corrupt ' + c)].join(', '));
  const out = new BlobStore(path.join(dir, 'blobs'));
  let blobs = 0;
  const p = normalizePackage(pkg);
  const copy = (id: BlobId, tree: boolean): void => {
    if (out.has(id)) return;
    out.putFile(store.pathOf(id));
    blobs++;
    if (tree) for (const b of Object.values(store.tree(id)!.files)) copy(b, false);
  };
  for (const b of blobsOf(p)) copy(b, treesOf(p).includes(b) || (b === p.execution.driver && store.tree(b) !== null));
  const manifest = path.join(dir, 'package.json');
  fs.writeFileSync(manifest, JSON.stringify(normalizePackage(pkg), null, 2) + '\n');
  return { manifest, blobs };
}
