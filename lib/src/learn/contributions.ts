import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/* ============================================================================
 * ADOPTABLE ARTIFACTS (SPEC-INVESTIGACION-EXTERNA §7.1, IE8): what a contribution carries that its recipient can USE in
 * its world, not only read. Each laboratory declares the formats it takes as a contribution (`Lab.contributions`), how
 * their bytes are checked with no world at hand, and the world's own act that adopts one. Adopting is never a privileged
 * act: it is the act the researcher would have written with those bytes - the same bags, checks and evaluator - with the
 * contribution it came from kept beside it (`contributed`).
 *
 *   {"act": {"adopt": {"contribution": "<id>", "artifact": "<id or name>", ...what the world's act needs}}}
 *
 * The artifact is read from the run's own blobs (kept by content when it was delivered) and from a contribution the run
 * RECEIVED: one it was never given cannot be adopted.
 * ========================================================================== */

/** An artifact a contribution carries: its bytes kept by content, its format among those its recipient's world takes. */
export interface ContributedArtifact {
  readonly id: string;
  readonly format: string;
  readonly name: string;
  readonly bytes: number;
}

/** Where what is adopted came from, kept with what the world makes of it. */
export interface Contributed {
  readonly contribution: string;
  readonly artifact: string;
  readonly by: string;
}

/** A format a world takes as a contribution. */
export interface ContributionFormat<A = unknown> {
  readonly id: string;
  /** What it is and what adopting it does, for the agent that contributes and the researcher that adopts. */
  readonly about: string;
  /** What the researcher writes in `adopt` besides "contribution" and "artifact". */
  readonly form: string;
  readonly max_bytes: number;
  /** What is wrong with its bytes, with no world at hand (an agent checks before it delivers; delivery refuses it too). */
  check(bytes: Buffer): string[];
  /** The world's own act that adopts it, from the researcher's fields, or why it cannot. */
  adopt(bytes: Buffer, raw: Readonly<Record<string, unknown>>, contributed: Contributed): A | string;
}

type J = Record<string, any>;
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** The contributions a run's record says it received, with their artifacts. */
export function receivedContributions(events: readonly J[]): { id: string; by: string; artifacts: ContributedArtifact[] }[] {
  const out = new Map<string, { id: string; by: string; artifacts: ContributedArtifact[] }>();
  for (const e of events) {
    if (e?.type !== 'operator_message') continue;
    for (const m of (Array.isArray(e.messages) ? e.messages : []) as J[]) {
      const c = m?.contribution;
      if (!c || typeof c.id !== 'string') continue;
      const artifacts = (Array.isArray(c.artifacts) ? c.artifacts : []).filter((a: J) => a && typeof a.id === 'string' && /^[0-9a-f]{64}$/.test(a.id) && typeof a.format === 'string')
        .map((a: J) => ({ id: a.id, format: a.format, name: String(a.name ?? a.id.slice(0, 12)), bytes: Number(a.bytes) || 0 }));
      if (!out.has(c.id)) out.set(c.id, { id: c.id, by: String(m.by ?? 'unknown'), artifacts });
    }
  }
  return [...out.values()];
}

/** Resolves an `adopt` act into the world's own: its contribution received, its artifact's bytes from the run's blobs
    (checked against their id), its format one the world takes, and the world's act made from them. */
export function resolveAdoption<A>(raw: unknown, o: { readonly formats: readonly ContributionFormat<A>[]; readonly events: readonly J[]; readonly blobs: string }): A | string {
  const form = '"adopt": {"contribution": "<its id>", "artifact": "<the artifact\'s id or name>", ...}';
  const a = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as J : null;
  if (!a || typeof a.contribution !== 'string' || typeof a.artifact !== 'string') return form;
  if (!o.formats.length) return 'this world adopts no contributions';
  const c = receivedContributions(o.events).find((x) => x.id === a.contribution);
  if (!c) return 'no contribution ' + a.contribution + ' reached you';
  const art = c.artifacts.find((x) => x.id === a.artifact || x.name === a.artifact || (a.artifact.length >= 8 && x.id.startsWith(a.artifact)));
  if (!art) return 'the contribution ' + c.id + ' carries no artifact ' + a.artifact + (c.artifacts.length ? ' (it carries: ' + c.artifacts.map((x) => x.name).join(', ') + ')' : ' (it carries none)');
  const format = o.formats.find((f) => f.id === art.format);
  if (!format) return 'this world does not take ' + art.format + ' (it takes: ' + o.formats.map((f) => f.id).join(', ') + ')';
  let bytes: Buffer;
  try { bytes = fs.readFileSync(path.join(o.blobs, art.id)); } catch { return 'the artifact ' + art.name + ' is not kept beside this run'; }
  if (sha(bytes) !== art.id) return 'the artifact ' + art.name + ' kept here is not what was delivered';
  const problems = format.check(bytes);
  if (problems.length) return 'the artifact ' + art.name + ': ' + problems.slice(0, 4).join('; ');
  const { contribution: _c, artifact: _a, ...fields } = a;
  return format.adopt(bytes, fields, { contribution: c.id, artifact: art.id, by: c.by });
}

/** The lines that tell a researcher how to adopt what a contribution carries: only in the message that delivers one. */
export function adoptionHelp(id: string, artifacts: readonly ContributedArtifact[], formats: readonly ContributionFormat[]): string {
  const usable = artifacts.filter((a) => formats.some((f) => f.id === a.format));
  if (!usable.length) return '';
  return '\n\nIt carries artifacts you may ADOPT as an act of yours (one of your acts, your bags, your checks; it is evaluated as anything of yours, and what comes of it stays marked as adopted from this contribution):\n'
    + usable.map((a) => {
      const f = formats.find((x) => x.id === a.format)!;
      return '- ' + a.name + ' (' + a.format + ', ' + a.bytes + ' bytes): ' + f.about + '\n  {"act": {"adopt": {"contribution": "' + id + '", "artifact": "' + a.name + '", ' + f.form + '}}}';
    }).join('\n');
}
