import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { stableStringify } from '../core/hash.ts';
import type { TrialLauncher } from '../meta/lab.ts';
import type { LabConnection } from '../runtime/lab-runner.ts';
import type { JuniorSessionClient } from './client.ts';
import { competenceHash, competenceProblems, type CompetenceManifest } from './competence.ts';
import { evaluate, promoteEvaluations, type Evaluation } from './evaluate.ts';
import { appendRecord } from './jsonl.ts';
import { BlobStore, checkClosed, executionHash, normalizePackage, treesOf, type JuniorPackage } from './package.ts';

/* ============================================================================
 * CONFIRMATION out of the junior's reach (SPEC-METAPOLITICA-APRENDIZAJE §9, MA6): the operator's service, on the
 * operator's machine, never on the junior's.
 *
 * It holds its own manifest - the reserved cases, their seeds, its evaluator - which nothing on the junior's machine reads.
 * It receives FROZEN packages, exported closed (lab junior package --export), and materializes them itself: every blob
 * checked against its hash and copied into its own store; the junior's store and server are never read. It evaluates them
 * with a junior server of its own, on the confirmation partition, the candidate against the reference junior, by
 * paired-cases@1.
 *
 * Two products. The OPERATOR's report: the verdict, both evaluations, every observation and where its records are. The
 * researcher's SUMMARY, the only thing published: the verdict, which components improve or regress, the two juniors by
 * hash and what they owe to others - distilled from a teacher, trained, a memory published, a forced format - never a
 * case, a trace or a memory. Each summary published exposes the cases it was measured on: a case exposed more than the
 * manifest allows has been used to develop, so the service confirms no more on it (§9: it is development now).
 * ========================================================================== */

export interface ConfirmationSummary {
  readonly format: 'confirmation-summary@1';
  readonly id: string;
  readonly manifest: string;
  readonly candidate: string;
  readonly reference: string;
  readonly verdict: 'promoted' | 'not_promoted' | 'inconclusive';
  readonly components: readonly { readonly id: string; readonly improves: boolean; readonly regresses: boolean }[];
  /** What the candidate owes to others, as its provenance says (P3): declared with its result. */
  readonly provenance: { readonly distilled: boolean; readonly trained: boolean; readonly initial_memory: boolean; readonly forced_format: boolean };
}

export interface ConfirmationReport {
  readonly format: 'confirmation-report@1';
  readonly summary: ConfirmationSummary;
  readonly why: string;
  readonly candidate: Evaluation;
  readonly reference: Evaluation;
  readonly cases: readonly string[];
}

/** A closed package exported to a folder, imported into the service's own store: its manifest read, every blob it names
    (trees walked) checked against its hash on the way. Refused when anything is missing or altered. */
export function importPackage(exportDir: string, store: BlobStore): JuniorPackage {
  const pkg = normalizePackage(JSON.parse(fs.readFileSync(path.join(exportDir, 'package.json'), 'utf8')));
  const from = new BlobStore(path.join(exportDir, 'blobs'));
  const copy = (id: string, tree: boolean): void => {
    if (!from.intact(id)) throw new Error('the export lacks blob ' + id + ' or it does not match its hash');
    if (!store.intact(id)) store.putFile(from.pathOf(id));
    if (tree) { const t = from.tree(id); if (!t) throw new Error('blob ' + id + ' is not a tree'); for (const b of Object.values(t.files)) copy(b, false); }
  };
  const e = pkg.execution;
  for (const b of [pkg.base, pkg.adapter, pkg.memory.neural, pkg.memory.twin, e.firmware, e.tokenizer, e.chat_template, e.driver, e.verifier].filter((x): x is string => x !== null))
    copy(b, treesOf(pkg).includes(b) || (b === e.driver && from.tree(b) !== null));
  const closed = checkClosed(pkg, store);
  if (!closed.closed) throw new Error('the package imported is not closed: ' + [...closed.missing, ...closed.corrupt].join(', '));
  return pkg;
}

/** What a package owes to others, read from its provenance and its parts. */
export function owes(pkg: JuniorPackage): ConfirmationSummary['provenance'] {
  const src = pkg.provenance.sources.join(' ');
  return { distilled: /(^|\s)dataset:/.test(src), trained: pkg.adapter !== null, initial_memory: pkg.memory.twin !== null, forced_format: pkg.decoding.forced_format !== null };
}

export class ConfirmationService {
  readonly root: string;
  readonly manifest: CompetenceManifest;
  readonly manifestHash: string;
  readonly store: BlobStore;
  private readonly client: JuniorSessionClient;
  private readonly launcher: TrialLauncher;
  private readonly judge: LabConnection | undefined;
  private readonly maxExposures: number;

  constructor(o: { root: string; manifest: CompetenceManifest; client: JuniorSessionClient; launcher: TrialLauncher; judge?: LabConnection; maxExposures?: number }) {
    const problems = competenceProblems(o.manifest);
    if (problems.length) throw new Error('the confirmation manifest: ' + problems.join('; '));
    if (!o.manifest.cases.some((c) => c.partition === 'confirmation')) throw new Error('the confirmation manifest has no confirmation case');
    for (const comp of o.manifest.components) if (!o.manifest.cases.some((c) => c.partition === 'confirmation' && c.kind === 'investigation' && c.components.includes(comp.id)))
      throw new Error('component ' + comp.id + ' has no confirmation case: a confirmation measures only what it can measure');
    this.root = o.root;
    this.manifest = o.manifest;
    this.manifestHash = competenceHash(o.manifest);
    this.store = new BlobStore(path.join(o.root, 'blobs'));
    this.client = o.client;
    this.launcher = o.launcher;
    this.judge = o.judge;
    this.maxExposures = o.maxExposures ?? 3;
  }

  private ledger(): string { return path.join(this.root, 'confirmations.jsonl'); }

  /** How many published summaries each reserved case was measured for. */
  exposures(): Record<string, number> {
    const out: Record<string, number> = {};
    if (!fs.existsSync(this.ledger())) return out;
    for (const l of fs.readFileSync(this.ledger(), 'utf8').split('\n')) {
      try { const e = JSON.parse(l); if (e.kind === 'published') for (const c of e.cases ?? []) out[c] = (out[c] ?? 0) + 1; } catch { /* a cut line */ }
    }
    return out;
  }

  /** A candidate confirmed against the reference: both imported, both evaluated here on the reserved cases, the verdict.
      The operator's report and the summary to publish are written apart; the summary is all that leaves. */
  async confirm(candidateExport: string, referenceExport: string, signal?: AbortSignal): Promise<{ report: string; summary: string; verdict: ConfirmationSummary['verdict'] }> {
    const cases = this.manifest.cases.filter((c) => c.partition === 'confirmation').map((c) => c.id);
    const exposed = this.exposures();
    const worn = cases.filter((c) => (exposed[c] ?? 0) >= this.maxExposures);
    if (worn.length) throw new Error('cases ' + worn.join(', ') + ' were exposed ' + this.maxExposures + ' times: they are development now; reserve new ones');
    const candidate = importPackage(candidateExport, this.store);
    const reference = importPackage(referenceExport, this.store);
    if (executionHash(reference) !== this.manifest.reference) throw new Error('the reference given is not the manifest\'s reference junior');
    const run = (pkg: JuniorPackage) => evaluate({ dir: path.join(this.root, 'evaluation'), manifest: this.manifest, manifestHash: this.manifestHash, pkg, client: this.client,
      launcher: this.launcher, partition: 'confirmation', ...(this.judge ? { judge: this.judge } : {}), ...(signal ? { signal } : {}) });
    const ref = await run(reference);
    const cand = await run(candidate);
    const p = promoteEvaluations(this.manifest, this.manifestHash, ref, cand);
    const body = { format: 'confirmation-summary@1' as const, manifest: this.manifestHash, candidate: executionHash(candidate), reference: executionHash(reference), verdict: p.verdict,
      components: p.components.map((c) => ({ id: c.id, improves: c.improves, regresses: c.regresses })), provenance: owes(candidate) };
    const summary: ConfirmationSummary = { ...body, id: createHash('sha256').update(stableStringify(body)).digest('hex').slice(0, 24) };
    const report: ConfirmationReport = { format: 'confirmation-report@1', summary, why: p.why, candidate: cand, reference: ref, cases };
    const reportFile = path.join(this.root, 'reports', summary.id + '.json');
    const summaryFile = path.join(this.root, 'outbox', summary.id + '.json');
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    fs.mkdirSync(path.dirname(summaryFile), { recursive: true });
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
    /* Only a whole measure is published: an incomplete one exposes the cases and says nothing. */
    if (cand.measure.complete && ref.measure.complete) {
      fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
      appendRecord(this.ledger(), { kind: 'published', id: summary.id, candidate: summary.candidate, verdict: summary.verdict, cases, at: new Date().toISOString() }, { sync: true });
    } else appendRecord(this.ledger(), { kind: 'incomplete', id: summary.id, candidate: summary.candidate, at: new Date().toISOString() }, { sync: true });
    return { report: reportFile, summary: cand.measure.complete && ref.measure.complete ? summaryFile : '', verdict: summary.verdict };
  }
}

/** The summaries a researcher may read: confirmation-summary@1 files only, any other field dropped. */
export function readSummaries(dir: string): ConfirmationSummary[] {
  if (!dir || !fs.existsSync(dir)) return [];
  const out: ConfirmationSummary[] = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (s.format !== 'confirmation-summary@1') continue;
      out.push({ format: s.format, id: String(s.id), manifest: String(s.manifest), candidate: String(s.candidate), reference: String(s.reference), verdict: s.verdict,
        components: (s.components ?? []).map((c: Record<string, unknown>) => ({ id: String(c.id), improves: c.improves === true, regresses: c.regresses === true })),
        provenance: { distilled: !!s.provenance?.distilled, trained: !!s.provenance?.trained, initial_memory: !!s.provenance?.initial_memory, forced_format: !!s.provenance?.forced_format } });
    } catch { /* not a summary */ }
  }
  return out;
}
