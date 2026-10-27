import { verifySearch } from '../learn/evolve/verify.ts';
import { artifactsLab } from '../worlds/artifacts/lab.ts';
import type { ArtifactTask } from '../artifacts/task.ts';
import type { SearchManifest } from '../learn/evolve/engine.ts';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { blobsOf, runLaboratory } from './lab-runner.ts';
import { LABS } from '../worlds/labs.ts';
import { JEV_DEFAULT_URL } from '../core/jev.ts';
import type { FetchLike } from '../core/net.ts';
import type { LawLab } from '../learn/lab.ts';
import { compareWorlds, readWorld, verifyWorld } from '../living/record.ts';
import { rebuildLivingSession } from '../living/run-session.ts';

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
  /** Blobs found whose content is not the one their name (its sha256, as the journal cites it) says: never packed. */
  readonly corrupt_blobs: readonly string[];
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
  const dir = path.resolve(outDir ?? base + '.package');
  const folder = path.dirname(path.resolve(journalFile));
  /* Never where the research is: not its folder, nor a folder that holds it; and a folder that exists is replaced only if it is
     a package already (an external review, 16/10/2026: --out pointed at the run's folder erased the run before copying it). */
  const inside = (a: string, b: string) => { const r = path.relative(b, a); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
  if (inside(folder, dir)) throw new Error('a package is never written where its run is (' + dir + ' holds ' + folder + ')');
  if (fs.existsSync(dir)) {
    if (!fs.statSync(dir).isDirectory() || (fs.readdirSync(dir).length && !isPackage(dir))) throw new Error(dir + ' exists and is not a package: it is left as it is');
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(dir, 'blobs'), { recursive: true });
  /* The run's own files: its journal and log, its findings, its agents' records (a senior's notebook and decisions), the audit
     of its method, and the operator's verdicts on its reports of the instrument (its resumption reads them: without them a run
     that had them would not be rebuilt). */
  /* A living world of its own: its session's journal, the record of everything the world did (SPEC-ACONTECIMIENTOS-DEL-MUNDO §14). */
  const own = fs.readdirSync(folder).filter((f) => f === name + '.json' || f === name + '.replay.jsonl' || f === name + '.anomalies.jsonl' || f === name + '.world.jsonl'
    || (f.startsWith(name + '.') && /^\.(finding|finding\.researcher|method|agent-[^.]+)\.json$/.test(f.slice(name.length))));
  for (const f of own) fs.copyFileSync(path.join(folder, f), path.join(dir, f));
  /* Its branches (SPEC-DELEGACION-INVESTIGACIONES §7, §10.3): every one its record names - and its agents' records - wherever it lives (a run resumed may name the branches
     of the run it resumed), each with its folder (its record, its cut, its blobs), by the path its record gives. */
  const named: string[] = [];
  for (const e of (journal.events ?? []) as Record<string, any>[]) if (e.type === 'delegation_requested' && typeof e.journal === 'string') named.push(e.journal);
  for (const f of own.filter((x) => /\.agent-[^.]+\.json$/.test(x))) {
    try { for (const e of (JSON.parse(fs.readFileSync(path.join(folder, f), 'utf8')).delegation_log ?? []) as Record<string, any>[]) if (e.type === 'delegation_requested' && typeof e.journal === 'string') named.push(e.journal); } catch { /* not a record */ }
  }
  for (const rel of [...new Set(named.map((j) => path.dirname(j)))]) {
    const from = path.resolve(folder, rel);
    if (!inside(from, folder) || from === folder || !fs.existsSync(from)) continue;
    fs.cpSync(from, path.join(dir, rel), { recursive: true });
  }
  /* The fund's ledger of its lineage (it may be named after the run that began it): without it, what was spent is not known. */
  const ledger = journal.config?.delegation?.ledger;
  if (typeof ledger === 'string' && fs.existsSync(path.resolve(folder, ledger))) fs.copyFileSync(path.resolve(folder, ledger), path.join(dir, path.basename(ledger)));
  const { dir: blobs, cited } = blobsOf(journalFile);
  const missing: string[] = [], corrupt: string[] = [];
  for (const b of cited) {
    const from = path.join(blobs, b);
    if (!fs.existsSync(from)) missing.push(b);
    else if (sha(from) !== b) corrupt.push(b);
    else fs.copyFileSync(from, path.join(dir, 'blobs', b));
  }
  const finding = fs.existsSync(base + '.finding.json') ? JSON.parse(fs.readFileSync(base + '.finding.json', 'utf8')) : {};
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(packageReport(finding, journal), null, 2));
  const files = listFiles(dir).filter((p) => p !== 'manifest.json' && p !== 'verification.json')
    .map((p) => ({ path: p, sha256: sha(path.join(dir, p)), bytes: fs.statSync(path.join(dir, p)).size }));
  const manifest: PackageManifest = { format: 'research_package@1', run: name, created: new Date().toISOString(), experiment: String(journal.experiment ?? ''),
    commit: journal.commit ?? null, files, missing_blobs: missing, corrupt_blobs: corrupt };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { dir, manifest };
}

const isPackage = (dir: string): boolean => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).format === 'research_package@1'; } catch { return false; }
};

const listFiles = (dir: string, rel = ''): string[] => fs.readdirSync(path.join(dir, rel), { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? listFiles(dir, rel ? rel + '/' + e.name : e.name) : [rel ? rel + '/' + e.name : e.name])).sort();

/** What a verification found, each proof by its name (R7). */
export interface PackageVerification {
  readonly format: 'research_verification@1';
  readonly verified: string;
  readonly manifest_sha256: string;
  /** Each file against its manifest, and each blob the journal cites against its content: a reference whose content is not
      the one it names is no evidence, whatever the manifest says of the file. */
  readonly integrity: { readonly holds: boolean; readonly changed: readonly string[]; readonly missing: readonly string[]; readonly unlisted: readonly string[];
    readonly missing_blobs: readonly string[]; readonly corrupt_blobs: readonly string[] };
  /** Guarantee 1 (SPEC-MUNDO-ARTEFACTOS §11): its history rebuilt from its record alone, offline. */
  readonly reconstruction: { readonly holds: boolean; readonly how: string; readonly events_compared: number; readonly first_difference?: number;
    readonly end_differs?: readonly string[]; readonly stopped_by?: string; readonly recorded_stop?: string; readonly requests_refused: number;
    /** Events after its end: the operator's later readings (a regrade), not a part of the run rebuilt. */
    readonly later_readings?: number };
  /** Guarantees 2 and 3, named so that nobody takes the first for them. */
  /** A living world's (SPEC-ACONTECIMIENTOS-DEL-MUNDO §14): its session's journal holding together (transitions, deliveries,
      receipts, firings, counters), and derived again by the reconstruction, entry by entry. */
  readonly world?: { readonly holds: boolean; readonly record: ReturnType<typeof verifyWorld>; readonly rebuilt: ReturnType<typeof compareWorlds> | { readonly holds: false; readonly why: string } };
  /** Each evolutionary search it holds, rebuilt from its record without a model or a measure (SPEC-DELEGACION-EVOLUTIVA §13). */
  readonly searches: readonly { readonly file: string; readonly holds: boolean; readonly why: string }[];
  readonly re_execution: { readonly done: false; readonly needs: string; readonly environments_recorded: readonly string[] };
  readonly reproduction: { readonly done: false; readonly needs: string };
}

/** The stops that leave a record short: a reconstruction stops where they did. */
const STOPS_SHORT = new Set(['token_budget', 'time_budget', 'cancelled']);

/** What of a run's end belongs to the process that wrote it, not to its research: its time, how its answers came (live or
    replayed), what it resumed and carried, where to resume it. Everything else of its end must come out the same. */
const END_OF_THE_PROCESS = new Set(['t', 'type', 'replay', 'console_usage', 'resume', 'resumed_from', 'blobs_carried']);

const endOf = (j: Record<string, any>) => [...(j.events ?? [])].reverse().find((e: Record<string, unknown>) => e.type === 'end') as Record<string, any> | undefined;

/** System 2 as the run had it, but nowhere: its model, its endpoint's path and its tuning as recorded (they are in what makes
    each request that request), at a host that does not exist. A journal from before its path was recorded (16/10/2026) names
    none: the path given, or the usual one. */
export function offlineConnection(config: Record<string, any>, llmPath?: string) {
  const t = (config.llm_tuning ?? {}) as Record<string, any>;
  return { url: 'http://offline.invalid' + (config.llm_path ?? llmPath ?? '/v1/chat/completions'), model: String(config.llm_model ?? 'offline'), provider: config.llm_provider ?? null,
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
  const journalName = manifest.run + '.json';
  const { cited } = blobsOf(path.join(dir, journalName));
  const missingBlobs = [...new Set([...(manifest.missing_blobs ?? []), ...cited.filter((b) => !present.includes('blobs/' + b))])];
  const corruptBlobs = [...new Set([...(manifest.corrupt_blobs ?? []), ...cited.filter((b) => present.includes('blobs/' + b) && sha(path.join(dir, 'blobs', b)) !== b)])];
  const integrity = { holds: !changed.length && !missing.length && !unlisted.length && !missingBlobs.length && !corruptBlobs.length,
    changed, missing, unlisted, missing_blobs: missingBlobs, corrupt_blobs: corruptBlobs };

  /* The reconstruction: the run resumed from its own record in a scratch copy, offline. */
  const lab = Object.values(LABS).find((l) => l.id === manifest.experiment);
  const original = JSON.parse(fs.readFileSync(path.join(dir, journalName), 'utf8'));
  let reconstruction: PackageVerification['reconstruction'];
  let worldProof: PackageVerification['world'] | undefined;
  if (!lab) reconstruction = { holds: false, how: 'no laboratory "' + manifest.experiment + '" in this code', events_compared: 0, requests_refused: 0 };
  else {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-'));
    fs.cpSync(dir, scratch, { recursive: true });
    let refused = 0;
    const offline: FetchLike = async () => { refused++; throw new Error('verification is offline: an answer the record does not hold is not asked'); };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10 * 60 * 1000);
    let stoppedBy = 'unknown';
    const recordedStop = endOf(original)?.stoppedBy as string | undefined;
    try {
      const r = await runLaboratory(lab, { args: ['--resume', path.join(scratch, journalName), '--out', path.join(scratch, 'rebuilt.json')], root: scratch,
        llm: offlineConnection(original.config ?? {}, options.llmPath), fetch: offline, signal: controller.signal, print: () => {},
        /* The Judge as the run had it, answering only from the record: no key is needed where nothing goes out. */
        ...(original.config?.flat ? {} : { judge: { url: 'http://offline.invalid' + (original.config?.jev_path ?? new URL(JEV_DEFAULT_URL).pathname), key: 'offline', provider: original.config?.jev_provider ?? null, ...(original.config?.jev_model ? { model: String(original.config.jev_model) } : {}) } }),
        /* Where the record stopped short - a budget, a cancellation - the reconstruction stops there too, never goes on. */
        ...(recordedStop && STOPS_SHORT.has(recordedStop) ? { stopAsRecorded: recordedStop } : {}) });
      stoppedBy = r.stoppedBy;
    } catch (e) { stoppedBy = 'error: ' + String((e as Error).message ?? e).slice(0, 200); } finally { clearTimeout(timer); }
    const rebuilt = fs.existsSync(path.join(scratch, 'rebuilt.json')) ? JSON.parse(fs.readFileSync(path.join(scratch, 'rebuilt.json'), 'utf8')) : { events: [] };
    /* Its living world, if it had one of its own: the record against what the reconstruction derived. */
    if (original.world && !original.world.shared && fs.existsSync(path.join(dir, manifest.run + '.world.jsonl'))) {
      const record = verifyWorld(readWorld(path.join(dir, manifest.run + '.world.jsonl')));
      const again = fs.existsSync(path.join(scratch, 'rebuilt.world.jsonl')) ? compareWorlds(readWorld(path.join(dir, manifest.run + '.world.jsonl')), readWorld(path.join(scratch, 'rebuilt.world.jsonl')))
        : { holds: false as const, why: 'no world was derived again' };
      worldProof = { holds: record.holds && again.holds, record, rebuilt: again };
    }
    /* Its events, as they were, up to the original's end: the same, one by one (their time aside). */
    /* What the record kept must come out the same, field by field (its time aside); what this code records beyond it - a field
       a later version of the harness adds - is new, not a difference. */
    const same = (was: Record<string, unknown>, now: Record<string, unknown> | undefined) => now !== undefined
      && Object.keys(was).every((k) => k === 't' || JSON.stringify(was[k]) === JSON.stringify(now[k]));
    /* The run is its events up to its end; what came after (a regrade, appended marked) is a later reading of it by the
       operator - kept, counted, and not a part of what is rebuilt. */
    const untilEnd = (events: Record<string, unknown>[]) => { const i = events.findIndex((e) => e.type === 'end'); return (i < 0 ? events : events.slice(0, i)).filter((e) => e.type !== 'start'); };
    const before = untilEnd(original.events as Record<string, unknown>[]);
    const after = untilEnd(rebuilt.events as Record<string, unknown>[]);
    const laterReadings = (original.events as Record<string, unknown>[]).length - (original.events as Record<string, unknown>[]).findIndex((e) => e.type === 'end') - 1;
    let first: number | undefined;
    for (let i = 0; i < before.length; i++) if (!same(before[i], after[i])) { first = i; break; }
    if (first === undefined && after.length > before.length) first = before.length;
    /* And its end - the final model, the artifact's state, what it counted: the same, but for what a reconstruction changes. */
    const a = endOf(original) ?? {}, b = endOf(rebuilt) ?? {};
    const endDiffers = Object.keys(a).filter((k) => !END_OF_THE_PROCESS.has(k) && JSON.stringify(a[k]) !== JSON.stringify(b[k]));
    reconstruction = { holds: first === undefined && !endDiffers.length && stoppedBy !== 'diverged' && !stoppedBy.startsWith('error'),
      how: 'resumed from its own replay log in a scratch copy, offline: every answer from the record, none asked again', events_compared: before.length,
      ...(first !== undefined ? { first_difference: first } : {}), ...(endDiffers.length ? { end_differs: endDiffers } : {}), stopped_by: stoppedBy,
      ...(recordedStop ? { recorded_stop: recordedStop } : {}), requests_refused: refused,
      ...(laterReadings > 0 && endOf(original) ? { later_readings: laterReadings } : {}) };
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  /* Its evolutionary searches: each rebuilt from its record and compared with the manifest it sealed. */
  const searchFiles = present.filter((p) => p.endsWith('.search.jsonl') && present.includes(p.replace(/\.jsonl$/, '.manifest.json')));
  const manifests = new Map<string, SearchManifest>();
  for (const p of present.filter((x) => x.endsWith('.search.manifest.json'))) { try { const m = JSON.parse(fs.readFileSync(path.join(dir, p), 'utf8')); manifests.set(m.hash, m); } catch { /* not one */ } }
  const searches: { file: string; holds: boolean; why: string }[] = [];
  for (const p of searchFiles) {
    /* Its task, from the branch's request beside it: its verdicts are computed again from their evidence. */
    const request = path.join(dir, p.replace(/\.search\.jsonl$/, '.evolve.json'));
    let task: ArtifactTask | undefined;
    try { const r = JSON.parse(fs.readFileSync(request, 'utf8')); task = (artifactsLab.generate(r.seed, r.options) as { world: { task: ArtifactTask } }).world.task; } catch { /* no request: rebuilt only */ }
    searches.push({ file: p, ...(await verifySearch(path.join(dir, p), path.join(dir, p.replace(/\.jsonl$/, '.manifest.json')), (h) => manifests.get(h) ?? null, task)) });
  }
  const environments = [...new Set(JSON.stringify(original).match(/"fingerprint":\s*"[0-9a-f]{16}"/g) ?? [])].map((m) => m.replace(/.*"([0-9a-f]{16})"/, '$1'));
  return {
    format: 'research_verification@1', verified: new Date().toISOString(), manifest_sha256: sha(manifestFile), integrity, reconstruction, ...(worldProof ? { world: worldProof } : {}), searches,
    re_execution: { done: false, needs: 'the same acts run again against the instrument now, with its dependencies and environment as recorded, and compared with what was recorded', environments_recorded: environments },
    reproduction: { done: false, needs: 'the experiment repeated, its conclusion judged again by the criteria it declared (the same verdict, not the same numbers)' }
  };
}

/* --- A shared session's package (SPEC-ACONTECIMIENTOS-DEL-MUNDO §14, §17.2 test 13) --------------------------------------
   The whole of it: its plan and its world's journal, every researcher's run with its log and findings, their branches and
   blobs - and its verification rebuilds the whole session offline, every researcher at once, never one alone. */

export interface SessionPackageManifest {
  readonly format: 'session_package@1';
  readonly session: string;
  readonly created: string;
  readonly adapter: string;
  readonly files: readonly { readonly path: string; readonly sha256: string; readonly bytes: number }[];
}

/** Packs a shared session from its record (`<name>.session.json`): every file of its name in its folder, and its blobs. */
export function packSession(sessionFile: string, outDir?: string): { dir: string; manifest: SessionPackageManifest } {
  const s = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  if (s.format !== 'living-session@1') throw new Error(sessionFile + ' is not a shared session\'s record');
  const folder = path.dirname(path.resolve(sessionFile));
  const name = path.basename(sessionFile).replace(/\.session\.json$/, '');
  const dir = path.resolve(outDir ?? path.join(folder, '..', name + '.session-package'));
  const inside = (a: string, b: string) => { const r = path.relative(b, a); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
  if (inside(folder, dir) || inside(dir, folder)) throw new Error('a package is never written where its session is');
  if (fs.existsSync(dir)) {
    if (!fs.statSync(dir).isDirectory() || (fs.readdirSync(dir).length && !isSessionPackage(dir))) throw new Error(dir + ' exists and is not a package: it is left as it is');
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
  for (const e of fs.readdirSync(folder, { withFileTypes: true })) {
    if (!e.name.startsWith(name + '.') || /\.(status\.json|log|inbox\.jsonl)$/.test(e.name)) continue;
    fs.cpSync(path.join(folder, e.name), path.join(dir, e.name), { recursive: true });
  }
  if (fs.existsSync(path.join(folder, 'blobs'))) fs.cpSync(path.join(folder, 'blobs'), path.join(dir, 'blobs'), { recursive: true });
  const files = listFiles(dir).filter((p) => p !== 'manifest.json' && p !== 'verification.json')
    .map((p) => ({ path: p, sha256: sha(path.join(dir, p)), bytes: fs.statSync(path.join(dir, p)).size }));
  const manifest: SessionPackageManifest = { format: 'session_package@1', session: name, created: new Date().toISOString(), adapter: String(s.adapter), files };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { dir, manifest };
}

const isSessionPackage = (dir: string): boolean => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).format === 'session_package@1'; } catch { return false; }
};

/** Verifies a shared session's package: its integrity; its world's journal holding together; and the whole session rebuilt
    offline - its world derived again entry by entry, every researcher's events the same - each proof by its name. */
export async function verifySessionPackage(dir: string, options: { readonly timeoutMs?: number } = {}): Promise<Record<string, unknown>> {
  const manifestFile = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as SessionPackageManifest;
  const present = listFiles(dir).filter((p) => p !== 'manifest.json' && p !== 'verification.json');
  const listed = new Map(manifest.files.map((f) => [f.path, f.sha256]));
  const changed = manifest.files.filter((f) => present.includes(f.path) && sha(path.join(dir, f.path)) !== f.sha256).map((f) => f.path);
  const missing = manifest.files.filter((f) => !present.includes(f.path)).map((f) => f.path);
  const unlisted = present.filter((p) => !listed.has(p));
  const integrity = { holds: !changed.length && !missing.length && !unlisted.length, changed, missing, unlisted };
  const sessionFile = path.join(dir, manifest.session + '.session.json');
  const recorded = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  const worldEntries = readWorld(path.join(dir, String(recorded.world)));
  const record = verifyWorld(worldEntries);
  const lab = Object.values(LABS).find((l) => l.id === manifest.adapter) as LawLab | undefined;
  let rebuilt: Record<string, unknown> = { holds: false, why: 'no laboratory "' + manifest.adapter + '" in this code' };
  if (lab) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-session-'));
    fs.cpSync(dir, scratch, { recursive: true });
    let refused = 0;
    const offline: FetchLike = async () => { refused++; throw new Error('verification is offline: an answer the record does not hold is not asked'); };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10 * 60 * 1000);
    try {
      const out = path.join(scratch, 'rebuilt');
      const r = await rebuildLivingSession(lab, { sessionFile: path.join(scratch, manifest.session + '.session.json'), dir: out, name: 'rebuilt', root: scratch, signal: controller.signal,
        connection: (actor) => {
          const j = JSON.parse(fs.readFileSync(path.join(scratch, String(recorded.runs[actor].journal)), 'utf8'));
          return { llm: offlineConnection(j.config ?? {}), fetch: offline,
            ...(j.config?.flat ? {} : { judge: { url: 'http://offline.invalid' + (j.config?.jev_path ?? new URL(JEV_DEFAULT_URL).pathname), key: 'offline', ...(j.config?.jev_model ? { model: String(j.config.jev_model) } : {}) } }) };
        } });
      const world = compareWorlds(worldEntries, readWorld(r.world));
      /* Every researcher's events, as they were, up to its end. */
      const members = Object.fromEntries(Object.entries((recorded.runs ?? {}) as Record<string, { journal: string | null }>).map(([id, run]) => {
        if (!run.journal) return [id, { holds: false, why: 'no record' }];
        const was = (JSON.parse(fs.readFileSync(path.join(dir, run.journal), 'utf8')).events ?? []) as Record<string, unknown>[];
        const file = r.runs[id]?.journal;
        const now = file && fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')).events ?? []) as Record<string, unknown>[] : [];
        const until = (es: Record<string, unknown>[]) => { const i = es.findIndex((e) => e.type === 'end'); return (i < 0 ? es : es.slice(0, i)).filter((e) => e.type !== 'start'); };
        const a = until(was), b = until(now);
        let first: number | undefined;
        for (let i = 0; i < a.length; i++) if (!b[i] || !Object.keys(a[i]).every((k) => k === 't' || JSON.stringify(a[i][k]) === JSON.stringify(b[i][k]))) { first = i; break; }
        return [id, { holds: first === undefined && !r.runs[id]?.error, events_compared: a.length, ...(first !== undefined ? { first_difference: first } : {}), ...(r.runs[id]?.error ? { error: r.runs[id].error } : {}) }];
      }));
      rebuilt = { holds: world.holds && Object.values(members).every((m) => (m as { holds: boolean }).holds) && refused === 0, world, members, requests_refused: refused,
        how: 'the whole session rebuilt in a scratch copy, offline: its world derived again against its journal, every researcher resumed from its own log at once' };
    } catch (e) { rebuilt = { holds: false, why: String((e as Error).message ?? e).slice(0, 300) }; }
    finally { clearTimeout(timer); fs.rmSync(scratch, { recursive: true, force: true }); }
  }
  return { format: 'session_verification@1', verified: new Date().toISOString(), manifest_sha256: sha(manifestFile), integrity, world_record: record, reconstruction: rebuilt,
    re_execution: { done: false, needs: 'the same decisions applied again to the adapter, live, and compared' }, reproduction: { done: false, needs: 'the session run again, its conclusions judged again by its criteria' } };
}
