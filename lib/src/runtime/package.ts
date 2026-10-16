import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { blobsOf, runLaboratory } from './lab-runner.ts';
import { LABS } from '../worlds/labs.ts';
import type { FetchLike } from '../core/net.ts';

/* ============================================================================
 * A RESEARCH PACKAGE (SPEC-RIESGO-MODELOS M1, §6-§7.4; an external audit, 16/10/2026): a run made
 * self-contained, to be carried to another machine, its integrity checked, and its history rebuilt.
 *
 *   lab pack <run>       a folder `<run>.package/`: the journal (its world archived inside), its replay
 *                        log, its findings, its agents' records, the blobs it cites - and
 *                          manifest.json   every file with its sha256 (the package's identity)
 *                          report.json     its results, each by its name (R6), and its limitations
 *   lab verify <package> verification.json, apart from what it verifies (§7.4): each proof by its name
 *                        (R7) - integrity, the reconstruction from its record (replayed offline, no
 *                        request may go out), and what was NOT done: re-execution, reproduction.
 *
 * Nothing here judges the research: it keeps it whole and says what was checked of it, and how.
 * ========================================================================== */

const sha = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export interface PackageManifest {
  readonly format: 'research_package@1';
  readonly run: string;
  readonly created: string;
  readonly experiment: string;
  readonly commit: string | null;
  /** Every file of the package, by its path inside it, with its sha256 and size. */
  readonly files: readonly { readonly path: string; readonly sha256: string; readonly bytes: number }[];
  /** Blobs the journal cites that were not found to carry: the package is then not whole, and says so. */
  readonly missing_blobs: readonly string[];
}

/** The run's results, each by its name (R6) - never one called "correct" - and its limitations, from its finding. */
export function packageReport(finding: Record<string, any>, journal: Record<string, any>): Record<string, unknown> {
  const f = finding ?? {};
  return {
    format: 'research_report@1',
    results: {
      predictive_acceptance_of_the_model: { status: f.outcome?.status ?? null, round: f.outcome?.round ?? null, at_acceptance: f.tested?.at_acceptance ?? null },
      ...(f.artifact ? { predictive_acceptance_of_the_artifact: { status: f.artifact.status, version: f.artifact.version, chain: f.artifact.chain ?? [], lineage: f.artifact.lineage ?? [] } } : {}),
      discriminating_evidence: f.own_tests ?? 'no test of its own registered',
      adequacy_to_a_use: 'no use and no criteria declared for this run',
      mechanistic_recovery: f.operator?.rule_recovery ?? 'no truth known to grade against, or not graded'
    },
    limitations: { counterexamples: f.counterexamples ?? [], ...(f.limitations ?? {}), ...(f.instrument ? { instrument: f.instrument } : {}) },
    cost: f.cost ?? null,
    generating_configuration: { researcher: journal.researcher ?? null, model: journal.config?.llm_model ?? null, config: journal.config ?? null }
  };
}

/** Packs a run: copies what it needs into `<run>.package/` (or `outDir`), writes its report and its manifest. */
export function packRun(journalFile: string, outDir?: string): { dir: string; manifest: PackageManifest } {
  const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
  const base = journalFile.replace(/\.json$/, '');
  const name = path.basename(base);
  const dir = outDir ?? base + '.package';
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'blobs'), { recursive: true });
  const folder = path.dirname(journalFile);
  /* The run's own files: its journal and log, its findings, its agents' records (a senior's notebook and decisions). */
  const own = fs.readdirSync(folder).filter((f) => f === name + '.json' || f === name + '.replay.jsonl' || (f.startsWith(name + '.') && /\.(finding|finding\.researcher|agent-[^.]+)\.json$/.test(f.slice(name.length))));
  for (const f of own) fs.copyFileSync(path.join(folder, f), path.join(dir, f));
  const { dir: blobs, cited } = blobsOf(journalFile);
  const missing: string[] = [];
  for (const b of cited) {
    const from = path.join(blobs, b);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dir, 'blobs', b)); else missing.push(b);
  }
  const finding = fs.existsSync(base + '.finding.json') ? JSON.parse(fs.readFileSync(base + '.finding.json', 'utf8')) : {};
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(packageReport(finding, journal), null, 2));
  const files = listFiles(dir).filter((p) => p !== 'manifest.json' && p !== 'verification.json')
    .map((p) => ({ path: p, sha256: sha(path.join(dir, p)), bytes: fs.statSync(path.join(dir, p)).size }));
  const manifest: PackageManifest = { format: 'research_package@1', run: name, created: new Date().toISOString(), experiment: String(journal.experiment ?? ''),
    commit: journal.commit ?? null, files, missing_blobs: missing };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { dir, manifest };
}

const listFiles = (dir: string, rel = ''): string[] => fs.readdirSync(path.join(dir, rel), { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? listFiles(dir, rel ? rel + '/' + e.name : e.name) : [rel ? rel + '/' + e.name : e.name])).sort();

/** What a verification found, each proof by its name (R7). */
export interface PackageVerification {
  readonly format: 'research_verification@1';
  readonly verified: string;
  readonly manifest_sha256: string;
  readonly integrity: { readonly holds: boolean; readonly changed: readonly string[]; readonly missing: readonly string[]; readonly unlisted: readonly string[]; readonly missing_blobs: readonly string[] };
  /** Guarantee 1 (SPEC-MUNDO-ARTEFACTOS §11): its history rebuilt from its record alone, offline. */
  readonly reconstruction: { readonly holds: boolean; readonly how: string; readonly events_compared: number; readonly first_difference?: number; readonly stopped_by?: string; readonly requests_refused: number };
  /** Guarantees 2 and 3, named so that nobody takes the first for them. */
  readonly re_execution: { readonly done: false; readonly needs: string; readonly environments_recorded: readonly string[] };
  readonly reproduction: { readonly done: false; readonly needs: string };
}

/** System 2 as the run had it, but nowhere: its model, its endpoint's path and its tuning as recorded (they are in what makes
    each request that request), at a host that does not exist. A journal from before its path was recorded (16/10/2026) names
    none: the path given, or the usual one. */
function offlineConnection(config: Record<string, any>, llmPath?: string) {
  const t = (config.llm_tuning ?? {}) as Record<string, any>;
  return { url: 'http://offline.invalid' + (config.llm_path ?? llmPath ?? '/v1/chat/completions'), model: String(config.llm_model ?? 'offline'),
    ...(t.temperature !== undefined ? { temperature: t.temperature } : {}), ...(t.extra_body ? { extraBody: t.extra_body } : {}),
    ...(t.reasoning_effort !== undefined ? { reasoningEffort: t.reasoning_effort } : {}), ...(t.json_mode !== undefined ? { jsonMode: t.json_mode } : {}),
    ...(t.max_tokens ? { maxTokens: t.max_tokens } : {}) };
}

/** Verifies a package: its integrity against its manifest, then its history rebuilt from its record in a scratch folder, with
    no request allowed out (an answer its log does not hold is a failure of the reconstruction, never asked again). */
export async function verifyPackage(dir: string, options: { readonly timeoutMs?: number; readonly llmPath?: string } = {}): Promise<PackageVerification> {
  const manifestFile = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as PackageManifest;
  const listed = new Map(manifest.files.map((f) => [f.path, f.sha256]));
  const present = listFiles(dir).filter((p) => p !== 'manifest.json' && p !== 'verification.json');
  const changed = manifest.files.filter((f) => present.includes(f.path) && sha(path.join(dir, f.path)) !== f.sha256).map((f) => f.path);
  const missing = manifest.files.filter((f) => !present.includes(f.path)).map((f) => f.path);
  const unlisted = present.filter((p) => !listed.has(p));
  const integrity = { holds: !changed.length && !missing.length && !unlisted.length && !manifest.missing_blobs.length, changed, missing, unlisted, missing_blobs: manifest.missing_blobs };

  /* The reconstruction: the run resumed from its own record in a scratch copy, offline. */
  const lab = Object.values(LABS).find((l) => l.id === manifest.experiment);
  const journalName = manifest.run + '.json';
  const original = JSON.parse(fs.readFileSync(path.join(dir, journalName), 'utf8'));
  let reconstruction: PackageVerification['reconstruction'];
  if (!lab) reconstruction = { holds: false, how: 'no laboratory "' + manifest.experiment + '" in this code', events_compared: 0, requests_refused: 0 };
  else {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-'));
    fs.cpSync(dir, scratch, { recursive: true });
    let refused = 0;
    const offline: FetchLike = async () => { refused++; throw new Error('verification is offline: an answer the record does not hold is not asked'); };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10 * 60 * 1000);
    let stoppedBy = 'unknown';
    try {
      const r = await runLaboratory(lab, { args: ['--resume', path.join(scratch, journalName), '--out', path.join(scratch, 'rebuilt.json')], root: scratch,
        llm: offlineConnection(original.config ?? {}, options.llmPath), fetch: offline, signal: controller.signal, print: () => {} });
      stoppedBy = r.stoppedBy;
    } catch (e) { stoppedBy = 'error: ' + String((e as Error).message ?? e).slice(0, 200); } finally { clearTimeout(timer); }
    const rebuilt = fs.existsSync(path.join(scratch, 'rebuilt.json')) ? JSON.parse(fs.readFileSync(path.join(scratch, 'rebuilt.json'), 'utf8')) : { events: [] };
    /* Its events, as they were, up to the original's end: the same, one by one (their time aside). */
    const strip = (e: Record<string, unknown>) => { const { t: _t, ...rest } = e; return JSON.stringify(rest); };
    const before = (original.events as Record<string, unknown>[]).filter((e) => e.type !== 'start' && e.type !== 'end');
    const after = (rebuilt.events as Record<string, unknown>[]).filter((e) => e.type !== 'start' && e.type !== 'end');
    let first: number | undefined;
    for (let i = 0; i < before.length; i++) if (strip(before[i]) !== (after[i] ? strip(after[i]) : '')) { first = i; break; }
    reconstruction = { holds: first === undefined && stoppedBy !== 'diverged' && !stoppedBy.startsWith('error'),
      how: 'resumed from its own replay log in a scratch copy, offline: every answer from the record, none asked again', events_compared: before.length,
      ...(first !== undefined ? { first_difference: first } : {}), stopped_by: stoppedBy, requests_refused: refused };
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const environments = [...new Set(JSON.stringify(original).match(/"fingerprint":\s*"[0-9a-f]{16}"/g) ?? [])].map((m) => m.replace(/.*"([0-9a-f]{16})"/, '$1'));
  return {
    format: 'research_verification@1', verified: new Date().toISOString(), manifest_sha256: sha(manifestFile), integrity, reconstruction,
    re_execution: { done: false, needs: 'the same acts run again against the instrument now, with its dependencies and environment as recorded, and compared with what was recorded', environments_recorded: environments },
    reproduction: { done: false, needs: 'the experiment repeated, its conclusion judged again by the criteria it declared (the same verdict, not the same numbers)' }
  };
}
