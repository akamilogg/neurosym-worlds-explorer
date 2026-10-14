import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/* ============================================================================
 * The ARTIFACT, versioned (SPEC-MUNDO-ARTEFACTOS §5): every version is a state of the world, known
 * by the hash of its content, made from another by a patch. Nothing is ever lost: going back is
 * starting from an earlier version. A version is rebuilt exactly from its base and its patches -
 * a run is replayed and resumed with it.
 *
 * A patch replaces or removes whole files: {"files": {"<path>": "<new content>" | null}}. Paths
 * are relative, with "/", inside the artifact; nothing outside it is ever written.
 * ========================================================================== */

export interface ArtifactVersion {
  readonly hash: string;
  /** The version it was made from (null: the base). */
  readonly parent: string | null;
  /** What changed from its parent (null: the base). */
  readonly patch: Patch | null;
  readonly files: ReadonlyMap<string, string>;
}

export interface Patch { readonly files: Readonly<Record<string, string | null>> }

/** What a base may hold, at most. */
export const ARTIFACT_FILES_MAX = 500;
export const ARTIFACT_BYTES_MAX = 5_000_000;
/** A file of the artifact, at most. */
export const ARTIFACT_FILE_MAX = 1_000_000;

/** The hash of a set of files: their paths and contents, in order. */
export function hashOf(files: ReadonlyMap<string, string>): string {
  const h = createHash('sha256');
  for (const p of [...files.keys()].sort()) h.update(p).update('\0').update(files.get(p)!).update('\0');
  return h.digest('hex').slice(0, 16);
}

/** A path inside the artifact in its one written form, or null: relative, "/"-separated, without "." segments (`./a.txt`
    is `a.txt`: the same file, never two entries - an external review, 14/10/2026), no "..", no drive, no absolute. */
export function cleanPath(p: string): string | null {
  const s = String(p).replace(/\\/g, '/').trim();
  if (!s || s.startsWith('/') || /^[a-z]:/i.test(s)) return null;
  const parts = s.split('/').filter((part) => part !== '.');
  if (!parts.length || parts.some((part) => part === '..' || part === '')) return null;
  return parts.join('/');
}

/** Two paths a file system that ignores case would write to one file, or null. */
function collision(paths: Iterable<string>): [string, string] | null {
  const seen = new Map<string, string>();
  for (const p of paths) { const k = p.toLowerCase(); if (seen.has(k)) return [seen.get(k)!, p]; seen.set(k, p); }
  return null;
}

export class ArtifactStore {
  private readonly versions = new Map<string, ArtifactVersion>();
  readonly base: string;

  constructor(files: ReadonlyMap<string, string>) {
    const v: ArtifactVersion = { hash: hashOf(files), parent: null, patch: null, files };
    this.versions.set(v.hash, v);
    this.base = v.hash;
  }

  /** The base from a directory: its text files (none of `exclude`, e.g. node_modules, .git), within the limits. */
  static fromDirectory(dir: string, options: { exclude?: readonly string[] } = {}): ArtifactStore {
    const exclude = new Set(options.exclude ?? ['.git', 'node_modules', '__pycache__']);
    const files = new Map<string, string>();
    let bytes = 0;
    const walk = (rel: string) => {
      for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
        if (exclude.has(entry.name)) continue;
        const r = rel ? rel + '/' + entry.name : entry.name;
        if (entry.isDirectory()) { walk(r); continue; }
        if (!entry.isFile()) continue;
        const text = fs.readFileSync(path.join(dir, r), 'utf8');
        bytes += text.length;
        files.set(r, text);
        if (files.size > ARTIFACT_FILES_MAX || bytes > ARTIFACT_BYTES_MAX) throw new Error('the artifact is larger than ' + ARTIFACT_FILES_MAX + ' files or ' + ARTIFACT_BYTES_MAX + ' bytes');
      }
    };
    walk('');
    const clash = collision(files.keys());
    if (clash) throw new Error('"' + clash[0] + '" and "' + clash[1] + '" would be one file where case is ignored');
    return new ArtifactStore(files);
  }

  get(hash: string): ArtifactVersion | null { return this.versions.get(hash) ?? null; }
  all(): ArtifactVersion[] { return [...this.versions.values()]; }

  /** A new version: `parent` with `patch` applied - or why not. The same content is the same version (its hash). */
  apply(parent: string, patch: Patch): ArtifactVersion | string {
    const from = this.versions.get(parent);
    if (!from) return 'no version "' + parent + '"';
    const entries = Object.entries(patch?.files ?? {});
    if (!entries.length) return 'the patch changes no file: {"files": {"<path>": "<new content>" | null}}';
    const twice = collision(entries.map(([p]) => cleanPath(p)).filter((p): p is string => p !== null));
    if (twice) return 'the patch names one file twice: "' + twice[0] + '" and "' + twice[1] + '"';
    const files = new Map(from.files);
    for (const [p, content] of entries) {
      const clean = cleanPath(p);
      if (!clean) return 'not a path inside the artifact: "' + p + '"';
      if (content === null) { if (!files.delete(clean)) return 'the version has no file "' + clean + '" to remove'; continue; }
      if (typeof content !== 'string') return 'the content of "' + clean + '" must be text, or null to remove it';
      if (content.length > ARTIFACT_FILE_MAX) return '"' + clean + '" is larger than ' + ARTIFACT_FILE_MAX + ' characters';
      files.set(clean, content);
    }
    if (files.size > ARTIFACT_FILES_MAX) return 'the artifact would have more than ' + ARTIFACT_FILES_MAX + ' files';
    const clash = collision(files.keys());
    if (clash) return '"' + clash[0] + '" and "' + clash[1] + '" would be one file where case is ignored: rename one';
    const hash = hashOf(files);
    if (hash === from.hash) return 'the patch changes nothing';
    const known = this.versions.get(hash);
    if (known) return known;
    const v: ArtifactVersion = { hash, parent, patch: { files: Object.fromEntries(entries.map(([p, c]) => [cleanPath(p)!, c])) }, files };
    this.versions.set(hash, v);
    return v;
  }

  /** A version written to a directory (new or emptied first): what a sandbox runs. */
  materialize(hash: string, dir: string): void {
    const v = this.versions.get(hash);
    if (!v) throw new Error('no version "' + hash + '"');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    for (const [p, content] of v.files) {
      const file = path.join(dir, ...p.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
  }

  /** What differs between two versions, file by file: added, removed, changed (with their sizes). */
  diff(a: string, b: string): { added: string[]; removed: string[]; changed: { path: string; before: number; after: number }[] } | string {
    const va = this.versions.get(a), vb = this.versions.get(b);
    if (!va || !vb) return 'no version "' + (va ? b : a) + '"';
    const added = [...vb.files.keys()].filter((p) => !va.files.has(p)).sort();
    const removed = [...va.files.keys()].filter((p) => !vb.files.has(p)).sort();
    const changed = [...vb.files.keys()].filter((p) => va.files.has(p) && va.files.get(p) !== vb.files.get(p)).sort()
      .map((p) => ({ path: p, before: va.files.get(p)!.length, after: vb.files.get(p)!.length }));
    return { added, removed, changed };
  }

  /** Lines from..to of a file of a version, numbered. */
  view(hash: string, file: string, from = 1, to = from + 199): { file: string; lines: [number, number]; of: number; text: string } | string {
    const v = this.versions.get(hash);
    if (!v) return 'no version "' + hash + '"';
    const clean = cleanPath(file);
    const content = clean ? v.files.get(clean) : undefined;
    if (content === undefined) return 'the version has no file "' + file + '" (its files: ' + [...v.files.keys()].slice(0, 40).join(', ') + ')';
    const lines = content.split('\n');
    const a = Math.max(1, Math.floor(from)), b = Math.min(lines.length, Math.max(a, Math.floor(to)), a + 399);
    return { file: clean!, lines: [a, b], of: lines.length, text: lines.slice(a - 1, b).map((l, i) => (a + i) + ': ' + l).join('\n') };
  }
}
