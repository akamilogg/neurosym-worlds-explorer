import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { packRun, packageReport, verifyPackage, type PackageVerification } from './package.ts';

/* ============================================================================
 * A REPORT THAT CAN BE TRACED, IN REVISIONS THAT DO NOT CHANGE (SPEC-RIESGO-MODELOS M1, §6, §7.3, §7.4).
 *
 *   lab model revise <run> [--use "<context of use>"] [--criteria "<criteria>"]
 *       a revision: the validation report of the run as it stands now, closed; every content it cites copied, by its
 *       sha256, to an evidence store that is only read (runs/models/evidence/<sha256>); and its manifest - whose sha256
 *       is the revision. Computed again and the same: the same revision. Anything different: a new one, compared by the
 *       harness with the one approved; if it contradicts it, that approval is suspended.
 *   lab model show <run>       its revisions, each opened (its copies hashed again), its approvals, its state
 *   lab model approve <run> --revision <id> --by "<person>" --conclusion approved|approved_with_limitations|rejected [--note ...]
 *       a person's conclusion on one revision, in a file of its own that names the revision's manifest: a signature never
 *       changes the hash of what it signs. Refused on a revision whose evidence does not hold.
 *
 *   <run>.validation/<revision>/report.json, report.txt, manifest.json    a revision, closed
 *   <run>.validation/approvals/<time>-<revision>.json                     a conclusion signed
 *   <run>.validation/history.jsonl                                         what happened, by whom, and on which revision
 *
 * The harness never concludes: it proposes a conclusion by a rule it states (a draft), compares revisions by a rule it
 * states, and keeps what was signed as it was.
 * ========================================================================== */

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const short = (rev: string): string => rev.slice(0, 16);

export const CONCLUSIONS = ['approved', 'approved_with_limitations', 'rejected'] as const;
export type Conclusion = typeof CONCLUSIONS[number];

export interface ValidationManifest {
  readonly format: 'validation_manifest@1';
  readonly run: string;
  /** The closed report's sha256. */
  readonly report: string;
  /** What is validated: the final model as written, and the artifact's version where there is one. */
  readonly artifact: { readonly model_sha256: string | null; readonly version?: string | null };
  /** The context of use and its criteria, declared by a person (or "not declared"). */
  readonly use_context: string;
  /** Every content the report rests on, by its role, its name in the run and its sha256 (its copy in the evidence store). */
  readonly evidence: readonly { readonly role: string; readonly file: string; readonly sha256: string; readonly bytes: number }[];
}

export interface Approval {
  readonly format: 'model_approval@1';
  readonly revision: string;
  readonly by: string;
  readonly at: string;
  readonly conclusion: Conclusion;
  readonly note: string;
}

const validationDir = (journal: string) => journal.replace(/\.json$/, '') + '.validation';
const historyFile = (journal: string) => path.join(validationDir(journal), 'history.jsonl');
const readHistory = (journal: string): Record<string, any>[] => {
  try { return fs.readFileSync(historyFile(journal), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};
const appendHistory = (journal: string, entry: Record<string, unknown>) => {
  fs.mkdirSync(validationDir(journal), { recursive: true });
  fs.appendFileSync(historyFile(journal), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
};

/** The evidence store: each content once, by its sha256, only read. A content already there is the same content - checked. */
function store(evidenceDir: string, content: Buffer): string {
  const id = sha(content);
  const at = path.join(evidenceDir, id);
  fs.mkdirSync(evidenceDir, { recursive: true });
  if (fs.existsSync(at)) {
    if (sha(fs.readFileSync(at)) !== id) throw new Error('the evidence store holds ' + id + ' with another content: it is not trusted, and nothing is added to it');
    return id;
  }
  fs.writeFileSync(at, content);
  try { fs.chmodSync(at, 0o444); } catch { /* where the system keeps no such mode, the hash still tells a change */ }
  return id;
}

/** The results the report states as met - what an approval relies on, each by its name - and its limitations, each as a fact. */
export function criteriaOf(report: Record<string, any>): { met: Record<string, boolean>; limitations: string[] } {
  const r = report.results ?? {};
  const v = report.process_verification ?? {};
  const own = r.discriminating_evidence;
  const met: Record<string, boolean> = {
    predictive_acceptance_of_the_model: r.predictive_acceptance_of_the_model?.status === 'accepted',
    ...(r.predictive_acceptance_of_the_artifact ? { predictive_acceptance_of_the_artifact: r.predictive_acceptance_of_the_artifact.status === 'accepted' } : {}),
    ...(own && typeof own === 'object' ? { discriminating_evidence_without_open_counterexamples: (own.counterexamples?.found ?? 0) <= (own.counterexamples?.closed ?? 0) } : {}),
    integrity: v.integrity?.holds === true,
    reconstruction: v.reconstruction?.holds === true
  };
  const l = report.limitations ?? {};
  const limitations = [
    ...(l.counterexamples ?? []).map((c: unknown) => 'counterexample ' + JSON.stringify(c)),
    ...(l.tolerated_misses ?? []).map((c: unknown) => 'tolerated miss ' + JSON.stringify(c)),
    ...(l.trivially_passed ?? []).map((c: unknown) => 'passed trivially ' + JSON.stringify(c)),
    ...(l.accepted_trivially ? ['accepted trivially'] : []),
    ...(l.instrument?.reports ?? []).map((c: Record<string, unknown>) => 'report of the instrument ' + JSON.stringify({ id: c.id, what: c.what, verdict: c.verdict ?? null })),
    ...(l.instrument?.acceptance_held ? ['acceptance held ' + JSON.stringify(l.instrument.acceptance_held)] : [])
  ];
  return { met, limitations };
}

/** How a revision stands against the one approved (§7.4): a result the approval relied on that no longer holds, or a
    limitation it did not have, contradicts it. A rule, stated - never a person's judgment, and never this code's taste. */
export function compareRevisions(approved: Record<string, any>, latest: Record<string, any>): { contradicts: boolean; no_longer_met: string[]; new_limitations: string[] } {
  const a = criteriaOf(approved), b = criteriaOf(latest);
  const no_longer_met = Object.keys(a.met).filter((k) => a.met[k] && !b.met[k]);
  const new_limitations = b.limitations.filter((x) => !a.limitations.includes(x));
  return { contradicts: no_longer_met.length > 0 || new_limitations.length > 0, no_longer_met, new_limitations };
}

/** The conclusion the code proposes, by its rule, as a draft: nobody's conclusion. */
function proposed(report: Record<string, any>): { draft: true; conclusion: Conclusion; rule: string } {
  const { met, limitations } = criteriaOf(report);
  const rule = 'rejected if its evidence does not hold (integrity, reconstruction) or nothing was accepted; approved with limitations if anything is limited; approved otherwise';
  const accepted = met.predictive_acceptance_of_the_model || met.predictive_acceptance_of_the_artifact;
  const conclusion: Conclusion = !met.integrity || !met.reconstruction || !accepted ? 'rejected'
    : limitations.length || Object.values(met).some((x) => !x) ? 'approved_with_limitations' : 'approved';
  return { draft: true, conclusion, rule };
}

/** The validation report of a run (§6), each part with its source (R1), its results apart (R6), its process verified by name (R7). */
function validationReport(journalFile: string, verification: PackageVerification, use: { context: string; criteria: string }): Record<string, any> {
  const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
  const base = journalFile.replace(/\.json$/, '');
  const finding = fs.existsSync(base + '.finding.json') ? JSON.parse(fs.readFileSync(base + '.finding.json', 'utf8')) : {};
  const audit = fs.existsSync(base + '.method.json') ? JSON.parse(fs.readFileSync(base + '.method.json', 'utf8')) : null;
  const end = [...(journal.events ?? [])].reverse().find((e: Record<string, unknown>) => e.type === 'end') ?? {};
  const packaged = packageReport(finding, journal) as Record<string, any>;
  const { verified: _v, manifest_sha256: _m, ...process } = verification;
  const report: Record<string, any> = {
    format: 'validation_report@1',
    run: path.basename(base),
    description: { source: 'journal end, notebook', model: end.final ?? null, ...(finding.artifact ? { artifact: { version: finding.artifact.version, status: finding.artifact.status } } : {}),
      assumptions: [...(end.notebook?.beliefs ?? [])].map((b: Record<string, unknown>) => ({ id: b.id, status: b.status, statement: b.statement })),
      use_context: use.context, criteria: use.criteria },
    results: { source: 'finding', ...packaged.results },
    process_verification: { source: 'a package of the run, verified (lab verify)', ...process, instrument_reports: finding.instrument?.reports ?? [] },
    references: { source: 'finding', baselines: finding.tested?.places?.filter((p: Record<string, unknown>) => p.role === 'reference') ?? [] },
    robustness: robustnessOf(base),
    limitations: { source: 'finding', ...packaged.limitations },
    independence: independenceOf(journal, audit, base),
    ...(audit ? { method_audit: { source: path.basename(base) + '.method.json', measures: audit.measures ?? null } } : {}),
    generating_configuration: { source: 'journal', ...packaged.generating_configuration, variability: 'not characterized (§8.2): context about the process, not evidence about this model' },
    cost: packaged.cost
  };
  report.proposed_conclusion = proposed(report);
  return report;
}

/* --- Robustness (§6.5, R8): the same model, frozen, on places it never saw - its synthetic re-evaluations ------------------- */

const reevaluationFiles = (base: string): string[] => {
  const dir = path.join(base + '.validation', 'reevaluations');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^r\d+\.json$/.test(f)).sort((a, b) => Number(a.slice(1, -5)) - Number(b.slice(1, -5))).map((f) => path.join(dir, f)) : [];
};

function robustnessOf(base: string): Record<string, unknown> {
  const done = reevaluationFiles(base).map((f) => {
    const end = [...(JSON.parse(fs.readFileSync(f, 'utf8')).events ?? [])].reverse().find((e: Record<string, unknown>) => e.type === 'end')?.reevaluation ?? {};
    return { source: path.basename(base) + '.validation/reevaluations/' + path.basename(f), set: end.set, ...(end.model ? { model: { holds_in: end.model.holds_in, places: end.model.places } } : {}),
      ...(end.artifact ? { artifact: { version: end.artifact.version, holds_in: end.artifact.holds_in, places: end.artifact.places } } : {}) };
  });
  return done.length
    ? { synthetic_reevaluations: done, within: 'places of its own family, new to it, the distribution frozen: not the real system it is used on (monitoring)' ,
      not_done: 'other families of its use, interventions' }
    : { done: false, needs: 'the model, its dependencies frozen, evaluated on new episodes, other families of its use and interventions (lab model reevaluate, §9)' };
}

/* --- Independence, in its three dimensions (§7.2), apart - never summed up as "independent: yes or no" ------------------- */

const independenceFile = (journal: string) => path.join(validationDir(journal), 'independence.jsonl');

/** A person's declaration of the organisational independence of a run's validation: who validated, to whom they answer,
    whether they are apart from its development and may challenge it. The harness never computes it; the latest declared
    counts, every one is kept. */
export function declareIndependence(journalFile: string, d: { by: string; validator: string; reportsTo?: string; separate?: string; canChallenge?: string; note?: string }): Record<string, unknown> {
  const journal = path.resolve(journalFile);
  if (!d.by?.trim() || /^agent:/i.test(d.by)) throw new Error('organisational independence is declared by a person: --by "<who>" (never an agent)');
  if (!d.validator?.trim()) throw new Error('--validator "<who validated it>"');
  for (const [k, v] of [['separate', d.separate], ['can-challenge', d.canChallenge]] as const) if (v !== undefined && !['yes', 'no'].includes(v)) throw new Error('--' + k + ' is yes or no');
  const entry = { at: new Date().toISOString(), by: d.by.trim(), validator: d.validator.trim(), ...(d.reportsTo ? { reports_to: d.reportsTo } : {}),
    ...(d.separate ? { separate_from_development: d.separate === 'yes' } : {}), ...(d.canChallenge ? { can_challenge: d.canChallenge === 'yes' } : {}), ...(d.note ? { note: d.note } : {}) };
  fs.mkdirSync(validationDir(journal), { recursive: true });
  fs.appendFileSync(independenceFile(journal), JSON.stringify(entry) + '\n');
  return entry;
}

function independenceOf(journal: Record<string, any>, audit: Record<string, any> | null, base: string): Record<string, unknown> {
  const unknown = 'not recorded';
  const developer = { model: journal.config?.llm_model ?? null, provider: journal.config?.llm_provider ?? unknown };
  /* Who directed it: its agents (a senior, a coach) and the operator's messages. */
  const folder = path.dirname(base);
  const agents = fs.readdirSync(folder).filter((f) => f.startsWith(path.basename(base) + '.agent-') && f.endsWith('.json')).map((f) => {
    const a = JSON.parse(fs.readFileSync(path.join(folder, f), 'utf8'));
    return { agent: a.agent, role: a.role, model: a.llm_config?.model ?? null, provider: a.llm_provider ?? unknown };
  });
  const events = (journal.events ?? []) as Record<string, any>[];
  const operatorMessages = events.filter((e) => e.type === 'operator_message').flatMap((e) => e.messages ?? []).filter((m: Record<string, unknown>) => !String(m.by ?? '').startsWith('agent:')).length;
  /* Who validated it: each grading as it was last done (per kind and subject), the Judge of the method's audit, the checks. */
  const latest = new Map<string, Record<string, any>>();
  for (const e of events) if ('grader_model' in e) latest.set(e.type + '|' + (e.subject ?? ''), e);
  const same = (a: unknown, b: unknown) => (a === unknown || b === unknown || a == null || b == null ? 'unknown' : a === b);
  const validators: Record<string, unknown>[] = [
    ...[...latest.values()].map((e) => ({ role: 'grader' + (e.subject ? ' (' + e.subject + ')' : ''), source: e.type, model: e.grader_model ?? null, provider: e.grader_provider ?? unknown,
      saw: e.saw ?? unknown, saw_reasoning: e.saw_reasoning ?? unknown, framing: e.framing ?? unknown })),
    ...(audit?.judge ? [{ role: 'judge of the method\'s audit', source: path.basename(base) + '.method.json', model: audit.judge, provider: unknown, saw: audit.judge_saw ?? unknown,
      saw_reasoning: audit.judge_saw ? true : unknown, framing: 'the audit\'s questions (J1-J6), fixed in its code' }] : []),
    { role: 'the environment\'s checks', source: 'journal', model: null, provider: null, saw: 'the model as code, run in the world\'s places - never the reasoning', saw_reasoning: false,
      framing: 'the protocol, fixed in code' }
  ];
  return {
    source: 'journal config and events, agent records, the method audit, ' + path.basename(independenceFile(base + '.json')),
    roles: { developer, directors: { agents, operator_messages: operatorMessages }, technical_validators: validators },
    technical_diversity: validators.filter((v) => v.model).map((v) => ({ role: v.role,
      same_model_as_developer: same(v.model, developer.model), same_provider_as_developer: same(v.provider, developer.provider),
      ...(agents.length ? { same_model_as_a_director: agents.some((a) => a.model === v.model) } : {}),
      reading: 'diversity, not independence: different models may share errors, or be framed alike' })),
    separation_of_the_evaluation: validators.map((v) => ({ role: v.role, saw: v.saw, saw_reasoning: v.saw_reasoning, framing: v.framing,
      took_part_in_development: v.model == null ? false : v.model === developer.model && same(v.provider, developer.provider) !== false ? 'its model is the developer\'s' : agents.some((a) => a.model === v.model) ? 'its model is a director\'s' : false })),
    organisational: (() => {
      try { const all = fs.readFileSync(independenceFile(base + '.json'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); return all.length ? { declared: all[all.length - 1], declarations: all.length } : 'declared by a person, never computed: not declared'; }
      catch { return 'declared by a person, never computed: not declared'; }
    })()
  };
}

/** A readable version of the report: the same facts, lines for a person. */
function reportText(report: Record<string, any>, revision: string): string {
  const { met, limitations } = criteriaOf(report);
  const v = report.process_verification;
  return [
    'Validation report of ' + report.run + ', revision ' + short(revision),
    'Context of use: ' + report.description.use_context + (report.description.criteria ? ' - criteria: ' + report.description.criteria : ''),
    '',
    'Results, each apart:',
    ...Object.entries(met).map(([k, x]) => '  ' + k.replace(/_/g, ' ') + ': ' + (x ? 'holds' : 'does not hold')),
    '  adequacy to the use: ' + report.results.adequacy_to_a_use,
    '  mechanistic recovery: ' + JSON.stringify(report.results.mechanistic_recovery),
    '',
    'Process, each proof by its name:',
    '  integrity: ' + (v.integrity.holds ? 'holds' : 'does NOT hold'),
    '  reconstruction from its record (offline): ' + (v.reconstruction.holds ? 'holds' : 'does NOT hold') + ' (' + v.reconstruction.events_compared + ' events)',
    '  re-execution: not done; reproduction: not done; robustness: not done',
    '',
    'Limitations (' + limitations.length + '):', ...limitations.map((l) => '  ' + l),
    '',
    'Independence, in three dimensions (none is a yes or a no):',
    ...report.independence.technical_diversity.map((t: Record<string, unknown>) => '  technical diversity - ' + t.role + ': same model as the developer ' + t.same_model_as_developer + ', same provider ' + t.same_provider_as_developer),
    ...report.independence.separation_of_the_evaluation.map((s: Record<string, unknown>) => '  separation - ' + s.role + ': saw ' + JSON.stringify(s.saw) + '; its reasoning: ' + s.saw_reasoning + '; framed by ' + s.framing + '; took part in development: ' + s.took_part_in_development),
    '  organisational: ' + JSON.stringify(report.independence.organisational),
    '',
    'Proposed conclusion (a draft, by rule - nobody\'s conclusion): ' + report.proposed_conclusion.conclusion,
    '  rule: ' + report.proposed_conclusion.rule
  ].join('\n') + '\n';
}

/** The revisions of a run, in the order they were made. */
const revisionsOf = (journal: string): string[] => readHistory(journal).filter((e) => e.event === 'revision').map((e) => e.revision);
const approvalsOf = (journal: string): Approval[] => {
  const dir = path.join(validationDir(journal), 'approvals');
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) : [];
};

/** Makes the revision of a run as it stands now - or finds it is the latest already. */
export async function reviseRun(journalFile: string, options: { readonly evidenceDir: string; readonly use?: string; readonly criteria?: string; readonly timeoutMs?: number }): Promise<{ revision: string; created: boolean; report: Record<string, any>; comparison?: ReturnType<typeof compareRevisions> & { approved: string } }> {
  const journal = path.resolve(journalFile);
  const base = journal.replace(/\.json$/, '');
  const previous = revisionsOf(journal).at(-1);
  const before = previous ? openRevision(journal, previous, options.evidenceDir) : null;
  const use = { context: options.use ?? before?.report.description.use_context ?? 'not declared', criteria: options.criteria ?? before?.report.description.criteria ?? 'not declared' };

  /* Its process verified as a package would be, in a scratch folder. */
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'revise-'));
  let verification: PackageVerification;
  try { verification = await verifyPackage(packRun(journal, path.join(scratch, 'package')).dir, options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}); }
  finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  const report = validationReport(journal, verification, use);
  const reportBytes = Buffer.from(JSON.stringify(report, null, 2));

  /* What it rests on, copied by its content. */
  const files: [string, string][] = [['journal', base + '.json'], ['replay_log', base + '.replay.jsonl'], ['finding', base + '.finding.json'],
    ['finding_researcher', base + '.finding.researcher.json'], ['method_audit', base + '.method.json'], ['operator_verdicts', base + '.anomalies.jsonl'],
    ['independence_declarations', independenceFile(journal)],
    ...reevaluationFiles(base).map((f) => ['reevaluation', f] as [string, string]),
    ...fs.readdirSync(path.dirname(journal)).filter((f) => f.startsWith(path.basename(base) + '.agent-') && f.endsWith('.json')).map((f) => ['agent_record', path.join(path.dirname(journal), f)] as [string, string])];
  const blobsDir = path.join(path.dirname(journal), 'blobs');
  const evidence: { role: string; file: string; sha256: string; bytes: number }[] = [];
  for (const [role, file] of files) if (fs.existsSync(file)) { const c = fs.readFileSync(file); evidence.push({ role, file: path.basename(file), sha256: store(options.evidenceDir, c), bytes: c.length }); }
  for (const b of verification.integrity.missing_blobs.length || verification.integrity.corrupt_blobs.length ? [] : citedBlobs(journal)) {
    const c = fs.readFileSync(path.join(blobsDir, b));
    evidence.push({ role: 'blob', file: 'blobs/' + b, sha256: store(options.evidenceDir, c), bytes: c.length });
  }
  const useBytes = Buffer.from(JSON.stringify(use));
  const end = [...(JSON.parse(fs.readFileSync(journal, 'utf8')).events ?? [])].reverse().find((e: Record<string, unknown>) => e.type === 'end') ?? {};
  const manifest: ValidationManifest = { format: 'validation_manifest@1', run: path.basename(base), report: store(options.evidenceDir, reportBytes),
    artifact: { model_sha256: end.final ? sha(JSON.stringify(end.final)) : null, ...(report.description.artifact ? { version: report.description.artifact.version } : {}) },
    use_context: store(options.evidenceDir, useBytes), evidence };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
  const revision = store(options.evidenceDir, manifestBytes);
  if (revision === previous) return { revision, created: false, report };

  const dir = path.join(validationDir(journal), short(revision));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), manifestBytes);
  fs.writeFileSync(path.join(dir, 'report.json'), reportBytes);
  fs.writeFileSync(path.join(dir, 'report.txt'), reportText(report, revision));
  appendHistory(journal, { event: 'revision', revision, by: 'harness', ...(previous ? { after: previous } : {}) });

  /* Compared with the one approved, if one is: a contradiction suspends it (the model to be validated again). */
  const approval = approvalsOf(journal).at(-1);
  if (!approval || approval.conclusion === 'rejected') return { revision, created: true, report };
  const approved = openRevision(journal, approval.revision, options.evidenceDir);
  const comparison = { approved: approval.revision, ...compareRevisions(approved.report, report) };
  appendHistory(journal, { event: comparison.contradicts ? 'approval_suspended' : 'compared', revision, by: 'harness', approved: approval.revision,
    no_longer_met: comparison.no_longer_met, new_limitations: comparison.new_limitations });
  return { revision, created: true, report, comparison };
}

const citedBlobs = (journal: string): string[] => {
  const text = fs.readFileSync(journal, 'utf8');
  return [...new Set([...text.matchAll(/"sha256":\s*"([0-9a-f]{64})"[^}]*"kept":\s*true/g)].map((m) => m[1]))];
};

/** Opens a revision: its manifest by its id, and every copy it names hashed again (§7.4: a discrepancy is an error of
    integrity, and blocks any signature on it). */
export function openRevision(journalFile: string, revision: string, evidenceDir: string): { manifest: ValidationManifest; report: Record<string, any>; integrity: { holds: boolean; problems: string[] } } {
  const journal = path.resolve(journalFile);
  const full = revisionsOf(journal).find((r) => r === revision || r.startsWith(revision));
  if (!full) throw new Error('no revision ' + revision + ' of ' + path.basename(journal));
  const problems: string[] = [];
  const copy = (id: string, what: string): Buffer | null => {
    const at = path.join(evidenceDir, id);
    if (!fs.existsSync(at)) { problems.push(what + ': its copy ' + short(id) + ' is missing from the evidence store'); return null; }
    const c = fs.readFileSync(at);
    if (sha(c) !== id) { problems.push(what + ': its copy ' + short(id) + ' does not hold the content it names'); return null; }
    return c;
  };
  const m = copy(full, 'the manifest');
  const local = path.join(validationDir(journal), short(full), 'manifest.json');
  const manifest = JSON.parse((m ?? fs.readFileSync(local)).toString('utf8')) as ValidationManifest;
  if (fs.existsSync(local) && sha(fs.readFileSync(local)) !== full) problems.push('the manifest beside the run is not the revision\'s: the store\'s copy is what counts');
  const r = copy(manifest.report, 'the report');
  for (const e of manifest.evidence) copy(e.sha256, e.role + ' (' + e.file + ')');
  copy(manifest.use_context, 'the context of use');
  const localReport = path.join(validationDir(journal), short(full), 'report.json');
  if (fs.existsSync(localReport) && sha(fs.readFileSync(localReport)) !== manifest.report) problems.push('the report beside the run is not the revision\'s: the store\'s copy is what counts');
  const report = JSON.parse((r ?? fs.readFileSync(localReport)).toString('utf8'));
  return { manifest, report, integrity: { holds: !problems.length, problems } };
}

/** A person's conclusion on a revision, signed in a file of its own (§7.3). */
export function approveRevision(journalFile: string, revision: string, a: { readonly by: string; readonly conclusion: string; readonly note?: string; readonly evidenceDir: string }): Approval {
  const journal = path.resolve(journalFile);
  if (!a.by?.trim() || /^agent:/i.test(a.by)) throw new Error('an approval is a person\'s: --by "<who>" (never an agent)');
  if (!(CONCLUSIONS as readonly string[]).includes(a.conclusion)) throw new Error('a conclusion is one of ' + CONCLUSIONS.join(', '));
  const opened = openRevision(journal, revision, a.evidenceDir);
  if (!opened.integrity.holds) throw new Error('its evidence does not hold, so it cannot be signed: ' + opened.integrity.problems.join('; '));
  const full = revisionsOf(journal).find((r) => r === revision || r.startsWith(revision))!;
  const approval: Approval = { format: 'model_approval@1', revision: full, by: a.by.trim(), at: new Date().toISOString(), conclusion: a.conclusion as Conclusion, note: a.note ?? '' };
  const dir = path.join(validationDir(journal), 'approvals');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, approval.at.replace(/[:.]/g, '-') + '-' + short(full) + '.json'), JSON.stringify(approval, null, 2));
  appendHistory(journal, { event: 'approval', revision: full, by: approval.by, conclusion: approval.conclusion });
  return approval;
}

/** Where the model of a run stands: its revisions, its approvals, and its state - from what was signed and what the harness
    found since (§5, §7.4). */
export function validationState(journalFile: string, evidenceDir: string): { status: string; approval: Approval | null; latest: string | null; note?: string;
  revisions: { revision: string; integrity: { holds: boolean; problems: string[] } }[]; history: Record<string, any>[] } {
  const journal = path.resolve(journalFile);
  const history = readHistory(journal);
  const revisions = revisionsOf(journal).map((r) => ({ revision: r, integrity: openRevision(journal, r, evidenceDir).integrity }));
  const latest = revisions.at(-1)?.revision ?? null;
  const approval = approvalsOf(journal).at(-1) ?? null;
  if (!approval) return { status: revisions.length ? 'in_validation' : 'not revised', approval: null, latest, revisions, history };
  let signed = history.length - 1;
  while (signed >= 0 && !(history[signed].event === 'approval' && history[signed].revision === approval.revision)) signed--;
  const since = history.slice(signed + 1);
  const suspended = since.find((e) => e.event === 'approval_suspended');
  if (suspended) return { status: 'revalidate', approval, latest, note: 'suspended by revision ' + short(suspended.revision) + ': ' + [...suspended.no_longer_met.map((k: string) => k + ' no longer holds'), ...suspended.new_limitations.map((l: string) => 'new: ' + l)].join('; '), revisions, history };
  return { status: approval.conclusion, approval, latest, ...(latest && latest !== approval.revision ? { note: 'a later revision, unsigned, contradicts nothing: ' + short(latest) } : {}), revisions, history };
}
