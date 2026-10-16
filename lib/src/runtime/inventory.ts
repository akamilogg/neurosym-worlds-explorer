import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LABS } from '../worlds/labs.ts';
import { isGameLab } from '../learn/lab.ts';
import { worldOptionsIn } from '../orchestra/reader.ts';
import { readVerdicts } from '../learn/anomalies.ts';
import { openRevision, validationState } from './validation.ts';
import { experimentArgs, runLaboratory, type LabConnection } from './lab-runner.ts';

/* ============================================================================
 * THE INVENTORY OF MODELS (SPEC-RIESGO-MODELOS M3, §4, §5, §8.1): runs/models/inventory.json (model_inventory@1).
 *
 *   lab model register <run> --owner "<person>" [--id ID] [--use ...] [--criteria ...] [--influence low|medium|high]
 *                      [--consequence low|medium|high] [--criticality "<the organisation's class>"] [--review-days N]
 *   lab model list                          the models, each with its state
 *   lab model check [<id>]                  their execution dependencies and instrument as they are now, against what was
 *                                           inventoried; the context of use of their latest revision; their review date;
 *                                           the operator's verdicts; their approvals - and their state, with its cause
 *   lab model retire <id> --by "<person>"   no longer in use
 *
 * A model has three layers (§4): the configuration that generated it (changing it changes no accepted model), the artifact
 * accepted (its fingerprint), and its execution dependencies (changing one may change its behaviour: validate again). The
 * inventory keeps what each was when inventoried; `check` says what changed and why its state changed - by whom, on which
 * revision. The harness never approves: a state that is a conclusion comes from a person's signature (M1).
 * ========================================================================== */

export interface InventoryEntry {
  readonly id: string;
  /** The run, by its journal's path relative to the repository. */
  readonly run: string;
  readonly experiment: string;
  readonly world: { readonly seed: unknown; readonly options: Record<string, string> };
  readonly commit: string | null;
  readonly layers: {
    readonly generating_configuration: Record<string, unknown>;
    readonly artifact: { readonly model_sha256: string | null; readonly model: unknown; readonly version?: string | null };
    execution_dependencies: Record<string, unknown>;
  };
  readonly owner: string;
  use_context: string;
  criteria: string;
  readonly criticality: { readonly influence?: string; readonly consequence?: string; readonly classification?: string };
  status: string;
  /** Each change of state: when, by whom (a person, or the harness's checks), its cause, and the revision it refers to. */
  history: { readonly at: string; readonly status: string; readonly by: string; readonly cause: string; readonly revision?: string;
    /** A cause found by the harness's checks, that keeps it to validate again until a person signs after it. */
    readonly trigger?: true;
    /** Inventoried again from the approval signed then. */
    readonly rebaselined?: string }[];
  dates: { readonly registered: string; last_validation: string | null; next_review: string | null };
  readonly review_days: number | null;
  /** The operator's verdicts of `bug` known when inventoried (a new one is a change of the instrument, §8.1). */
  bugs_known: number;
  /** Its synthetic re-evaluations (§9), each with its journal and what came of it. */
  reevaluations?: { readonly at: string; readonly journal: string; readonly set: number; readonly model?: unknown; readonly artifact?: unknown; readonly below_criteria: boolean }[];
}

interface Inventory { readonly format: 'model_inventory@1'; models: InventoryEntry[] }

const AXES = ['low', 'medium', 'high'];
const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '..');
const sha = (x: string) => createHash('sha256').update(x).digest('hex');

export const inventoryFile = (root: string) => path.join(root, 'runs', 'models', 'inventory.json');
export function readInventory(root: string): Inventory {
  try { return JSON.parse(fs.readFileSync(inventoryFile(root), 'utf8')); } catch { return { format: 'model_inventory@1', models: [] }; }
}
function writeInventory(root: string, inv: Inventory): void {
  fs.mkdirSync(path.dirname(inventoryFile(root)), { recursive: true });
  const tmp = inventoryFile(root) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(inv, null, 2));
  fs.renameSync(tmp, inventoryFile(root));
}

/** The instrument of a world: its own code and the code it uses outside the harness (an artifact world's sandbox and store),
    found by its imports - never the harness's own (learn, runtime, orchestra, core, audit), which is not the world. */
export function instrumentOf(experiment: string): { lab: string; paths: string[]; fingerprint: string } | null {
  const key = Object.keys(LABS).find((k) => LABS[k].id === experiment);
  if (!key) return null;
  const HARNESS = new Set(['learn', 'runtime', 'orchestra', 'core', 'audit', 'worlds']);
  const files = (dir: string): string[] => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => e.isDirectory() ? files(path.join(dir, e.name)) : /\.(ts|js|py|json)$/.test(e.name) ? [path.join(dir, e.name)] : []) : [];
  const dirs = new Set([path.join(SRC, 'worlds', key)]);
  for (const f of files(path.join(SRC, 'worlds', key))) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/from\s+'(\.\.?\/[^']+)'/g)) {
      const rel = path.relative(SRC, path.resolve(path.dirname(f), m[1])).split(path.sep);
      if (rel[0] && !rel[0].startsWith('..') && !HARNESS.has(rel[0]) && rel.length > 1) dirs.add(path.join(SRC, rel[0]));
    }
  }
  const all = [...dirs].flatMap(files).sort();
  /* Its content as committed would be: line endings as LF, so a checkout on any system gives the same fingerprint. */
  const fingerprint = sha(all.map((f) => path.relative(SRC, f).split(path.sep).join('/') + '\n' + sha(fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n'))).join('\n')).slice(0, 16);
  return { lab: key, paths: [...dirs].map((d) => 'lib/src/' + path.relative(SRC, d).split(path.sep).join('/')), fingerprint };
}

/** Whether the instrument changed between the run's commit and now (git's word; null when it cannot tell). */
function instrumentChangedSince(commit: string | null, paths: readonly string[]): boolean | null {
  if (!commit) return null;
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: SRC, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    execFileSync('git', ['diff', '--quiet', commit, '--', ...paths], { cwd: top, stdio: 'ignore' });
    return false;
  } catch (e) { return (e as { status?: number }).status === 1 ? true : null; }
}

/** What the model of a run needs to give an answer, as it is now: the runtime that executes its code, the Judge when its law
    has rules (with its model), the instrument of its world, and what its world says it needs (§4). */
export async function dependenciesNow(journal: Record<string, any>): Promise<Record<string, unknown>> {
  const end = [...(journal.events ?? [])].reverse().find((e: Record<string, unknown>) => e.type === 'end') ?? {};
  const rules = end.final?.rules && Object.keys(end.final.rules).length;
  const instrument = instrumentOf(String(journal.experiment));
  const lab = Object.values(LABS).find((l) => l.id === journal.experiment);
  let world: Record<string, unknown> = {};
  if (lab && !isGameLab(lab) && lab.dependencies) {
    try { world = await lab.dependencies(lab.generate(Number(journal.config?.seed) || 1, worldOptionsIn(lab.options, journal.config ?? {}), journal.world_archive) as never); }
    catch (e) { world = { world: 'not computable now: ' + String((e as Error).message ?? e).slice(0, 200) }; }
  }
  return { runtime: { node: process.version }, judge: rules ? { model: journal.config?.jev_model ?? null } : 'none: its law has no rules',
    instrument: instrument ? { lab: instrument.lab, fingerprint: instrument.fingerprint } : 'unknown', ...world };
}

/** What changed among two sets of dependencies, by name (the facts beside a fingerprint are not compared twice). */
function changedDependencies(was: Record<string, unknown>, now: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(was), ...Object.keys(now)])].filter((k) => !k.endsWith('_facts') && JSON.stringify(was[k]) !== JSON.stringify(now[k]));
}

const person = (who: string | undefined, role: string): string => {
  if (!who?.trim() || /^agent:/i.test(who)) throw new Error(role + ' is a person: never an agent');
  return who.trim();
};

/** Registers the model of a run in the inventory (§5): a person owns it and declares its use. */
export async function registerModel(root: string, journalFile: string, o: { owner: string; id?: string; use?: string; criteria?: string; influence?: string; consequence?: string;
  criticality?: string; reviewDays?: number; evidenceDir: string }): Promise<InventoryEntry> {
  const owner = person(o.owner, 'the owner');
  for (const [k, v] of [['influence', o.influence], ['consequence', o.consequence]] as const) if (v !== undefined && !AXES.includes(v)) throw new Error('--' + k + ' is one of ' + AXES.join(', '));
  const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
  const end = [...(journal.events ?? [])].reverse().find((e: Record<string, unknown>) => e.type === 'end');
  if (!end) throw new Error('the run has not ended: there is no model to inventory');
  const state = validationState(journalFile, o.evidenceDir);
  const latest = state.latest ? openRevision(journalFile, state.latest, o.evidenceDir).report : null;
  const use = o.use ?? (latest?.description.use_context !== 'not declared' ? latest?.description.use_context : undefined);
  if (!use) throw new Error('a model is inventoried for a use: --use "<context of use>" (or a revision that declares one)');
  const inv = readInventory(root);
  const run = path.relative(root, path.resolve(journalFile)).split(path.sep).join('/');
  if (inv.models.some((m) => m.run === run && m.status !== 'retired')) throw new Error('the model of ' + run + ' is in the inventory already');
  const lab = Object.values(LABS).find((l) => l.id === journal.experiment);
  const finding = (() => { try { return JSON.parse(fs.readFileSync(journalFile.replace(/\.json$/, '.finding.json'), 'utf8')); } catch { return {}; } })();
  const id = o.id ?? 'm-' + sha(run + '\n' + JSON.stringify(end.final ?? null)).slice(0, 10);
  if (inv.models.some((m) => m.id === id)) throw new Error('there is a model ' + id + ' already');
  const at = new Date().toISOString();
  const instrument = instrumentOf(String(journal.experiment));
  const changedSinceRun = instrument ? instrumentChangedSince(journal.commit ?? null, instrument.paths) : null;
  const entry: InventoryEntry = {
    id, run, experiment: String(journal.experiment),
    world: { seed: journal.config?.seed ?? null, options: lab ? worldOptionsIn(lab.options, journal.config ?? {}) : {} },
    commit: journal.commit ?? null,
    layers: {
      generating_configuration: { researcher: journal.researcher ?? null, llm_model: journal.config?.llm_model ?? null, llm_tuning: journal.config?.llm_tuning ?? null,
        jev_model: journal.config?.jev_model ?? null, harness: journal.config ?? null, agents: journal.agents ?? null, help_budget: journal.help_budget ?? null },
      artifact: { model_sha256: end.final ? sha(JSON.stringify(end.final)) : null, model: end.final ?? null, ...(finding.artifact ? { version: finding.artifact.version ?? null } : {}) },
      execution_dependencies: await dependenciesNow(journal)
    },
    owner, use_context: use, criteria: o.criteria ?? latest?.description.criteria ?? 'not declared',
    criticality: { ...(o.influence ? { influence: o.influence } : {}), ...(o.consequence ? { consequence: o.consequence } : {}), ...(o.criticality ? { classification: o.criticality } : {}) },
    status: 'in_validation', history: [{ at, status: 'in_validation', by: owner, cause: 'registered' }],
    dates: { registered: at, last_validation: null, next_review: o.reviewDays ? new Date(Date.now() + o.reviewDays * 86400000).toISOString() : null },
    review_days: o.reviewDays ?? null,
    bugs_known: readVerdicts(journalFile).filter((v) => v.verdict === 'bug').length
  };
  if (changedSinceRun) entry.history.push({ at, status: 'revalidate', by: 'harness', cause: 'instrument: its code (' + instrument!.paths.join(', ') + ') changed since the run\'s commit ' + String(journal.commit).slice(0, 10), trigger: true });
  inv.models.push(entry);
  writeInventory(root, inv);
  return (await checkModels(root, { id, evidenceDir: o.evidenceDir }))[0].entry;
}

/** Checks the models (all, or one): what changed since they were inventoried, and where each stands now (§8.1).
    - A trigger (a dependency, the instrument, the context of use, the review date, a run gone) puts it in `revalidate`, by
      the harness, with its cause - and it stays there until a person signs a revision after it.
    - A signature after the last trigger validates the model as it is then: its dependencies, its instrument's faults and its
      context of use are inventoried again from that moment, and its next review counted from it.
    - Otherwise its state is its validation's (M1): in validation, a conclusion signed, or suspended by a revision. */
export async function checkModels(root: string, o: { id?: string; evidenceDir: string; now?: Date }): Promise<{ entry: InventoryEntry; changed: boolean; causes: string[] }[]> {
  const inv = readInventory(root);
  const now = o.now ?? new Date();
  const at = now.toISOString();
  const out: { entry: InventoryEntry; changed: boolean; causes: string[] }[] = [];
  for (const m of inv.models.filter((x) => !o.id || x.id === o.id || x.id.startsWith(o.id))) {
    if (m.status === 'retired') { out.push({ entry: m, changed: false, causes: [] }); continue; }
    const journalFile = path.resolve(root, m.run);
    const causes: string[] = [];
    let status = m.status;
    if (!fs.existsSync(journalFile)) causes.push('its run is gone: ' + m.run);
    else {
      const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
      const deps = await dependenciesNow(journal);
      const bugs = readVerdicts(journalFile).filter((v) => v.verdict === 'bug').length;
      const state = validationState(journalFile, o.evidenceDir);
      const latest = state.latest ? openRevision(journalFile, state.latest, o.evidenceDir).report : null;
      const lastTrigger = [...m.history].reverse().find((h) => h.trigger);
      if (state.approval) m.dates.last_validation = state.approval.at;
      /* Signed after the last trigger: the model as it is now is the one validated. */
      if (lastTrigger && state.approval && state.approval.at > lastTrigger.at && !m.history.some((h) => h.rebaselined === state.approval!.at)) {
        m.layers.execution_dependencies = deps;
        m.bugs_known = bugs;
        if (latest) { m.use_context = latest.description.use_context; m.criteria = latest.description.criteria; }
        if (m.review_days) m.dates.next_review = new Date(Date.parse(state.approval.at) + m.review_days * 86400000).toISOString();
        m.history.push({ at, status: m.status, by: 'harness', cause: 'inventoried again: signed by ' + state.approval.by + ' after the last trigger', revision: state.approval.revision, rebaselined: state.approval.at });
      }
      for (const k of changedDependencies(m.layers.execution_dependencies, deps))
        causes.push((k === 'instrument' ? 'instrument' : 'dependency') + ': ' + k + ' was ' + JSON.stringify(m.layers.execution_dependencies[k]) + ', now ' + JSON.stringify(deps[k]));
      if (bugs > m.bugs_known) causes.push('instrument: ' + (bugs - m.bugs_known) + ' fault(s) of the instrument confirmed by the operator since it was inventoried');
      if (latest && (latest.description.use_context !== m.use_context || latest.description.criteria !== m.criteria))
        causes.push('context: its latest revision is for "' + latest.description.use_context + '" (' + latest.description.criteria + '), the inventory for "' + m.use_context + '" (' + m.criteria + ')');
      if (m.dates.next_review && at >= m.dates.next_review) causes.push('date: its review was due ' + m.dates.next_review);
      const open = [...m.history].reverse().find((h) => h.trigger);
      const cleared = !open || [...m.history].reverse().find((h) => h.rebaselined)?.at! > open.at;
      status = causes.length || !cleared ? 'revalidate' : state.status === 'not revised' ? 'in_validation' : state.status;
      if (!causes.length && status !== m.status) {
        const signed = state.approval && status === state.approval.conclusion;
        m.history.push({ at, status, by: signed ? state.approval!.by : 'harness', cause: signed ? 'signed' + (state.approval!.note ? ': ' + state.approval!.note : '') : status === 'revalidate' ? String(state.note ?? 'suspended by a revision') : 'its validation: ' + status,
          ...(signed ? { revision: state.approval!.revision } : state.latest ? { revision: state.latest } : {}) });
      }
    }
    const cause = causes.join('; ');
    if (causes.length && cause !== [...m.history].reverse().find((h) => h.trigger)?.cause) m.history.push({ at, status: 'revalidate', by: 'harness', cause, trigger: true });
    if (causes.length) status = 'revalidate';
    out.push({ entry: m, changed: status !== m.status, causes });
    m.status = status;
  }
  writeInventory(root, inv);
  return out;
}

/** A SYNTHETIC RE-EVALUATION (§9, `lab model reevaluate`): the model frozen, with its dependencies as inventoried, checked by
    its world's protocol on new places of its family - each re-evaluation a stretch of its own. Measured within that frozen
    distribution only: it says nothing of the real system it is used on (that is monitoring, which the harness cannot do).
    A dependency that is not as inventoried makes it a validation of something else: refused. Below its criteria - not holding
    in some new place, where its acceptance asked every one - the model is to validate again, the cause said. */
export async function reevaluateModel(root: string, id: string, o: { evidenceDir: string; judge?: LabConnection; places?: number; fetch?: import('../core/net.ts').FetchLike }): Promise<{ entry: InventoryEntry; reevaluation: Record<string, any> }> {
  const inv = readInventory(root);
  const m = inv.models.find((x) => x.id === id || x.id.startsWith(id));
  if (!m) throw new Error('no model ' + id + ' in the inventory');
  if (m.status === 'retired') throw new Error(m.id + ' is retired');
  const journalFile = path.resolve(root, m.run);
  const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
  const lab = Object.values(LABS).find((l) => l.id === journal.experiment);
  if (!lab || isGameLab(lab)) throw new Error('re-evaluation is for the worlds whose model is a law: ' + journal.experiment + ' is not one');
  const deps = await dependenciesNow(journal);
  const changed = changedDependencies(m.layers.execution_dependencies, deps);
  if (changed.length) throw new Error('its dependencies are not as inventoried (' + changed.join(', ') + '): a re-evaluation now would evaluate something else - check it (lab model check) and validate it again');
  const end = [...(journal.events ?? [])].reverse().find((e: Record<string, unknown>) => e.type === 'end') ?? {};
  const rules = end.final?.rules && Object.keys(end.final.rules).length;
  const inventoriedJudge = (m.layers.execution_dependencies.judge as { model?: string | null } | string);
  if (rules) {
    if (!o.judge?.key) throw new Error('its law has rules: the Judge is needed (JEV_KEY), with the model it was inventoried with');
    const want = typeof inventoriedJudge === 'object' ? inventoriedJudge.model ?? null : null;
    if ((o.judge.model ?? null) !== want) throw new Error('the Judge configured (' + (o.judge.model ?? 'its default') + ') is not the one inventoried (' + (want ?? 'its default') + ')');
  }
  const n = m.reevaluations?.length ?? 0;
  const out = path.join(journalFile.replace(/\.json$/, '') + '.validation', 'reevaluations', 'r' + (n + 1) + '.json');
  const args = experimentArgs(journal.argv ?? []).filter((a) => a !== '--flat');
  const r = await runLaboratory(lab, { args: [...args, ...(rules ? [] : ['--flat']), '--no-grade', '--out', out], root,
    llm: { url: 'http://offline.invalid/v1/chat/completions', model: 'none' }, ...(rules ? { judge: o.judge } : {}), ...(o.fetch ? { fetch: o.fetch } : {}),
    reevaluate: { run: m.run, model: end.final ?? null, version: (m.layers.artifact.version ?? null) as string | null, events: journal.events ?? [], set: 9000 + n, ...(o.places ? { places: o.places } : {}) } });
  const rec = [...(JSON.parse(fs.readFileSync(r.journal, 'utf8')).events ?? [])].reverse().find((e: Record<string, unknown>) => e.type === 'end')?.reevaluation ?? {};
  if (rec.refused) throw new Error('re-evaluation refused: ' + rec.refused);
  const below = [rec.model, rec.artifact].some((x) => x && x.holds_in < x.places);
  const at = new Date().toISOString();
  const said = [rec.model ? 'its model holds in ' + rec.model.holds_in + ' of ' + rec.model.places + ' new places' : '', rec.artifact ? 'its artifact in ' + rec.artifact.holds_in + ' of ' + rec.artifact.places : ''].filter(Boolean).join('; ');
  (m.reevaluations ??= []).push({ at, journal: path.relative(root, r.journal).split(path.sep).join('/'), set: 9000 + n, ...(rec.model ? { model: rec.model } : {}), ...(rec.artifact ? { artifact: rec.artifact } : {}), below_criteria: below });
  if (below) { m.history.push({ at, status: 'revalidate', by: 'harness', cause: 'reevaluation: ' + said + ' - below its criteria', trigger: true }); m.status = 'revalidate'; }
  else m.history.push({ at, status: m.status, by: 'harness', cause: 'reevaluation: ' + said });
  writeInventory(root, inv);
  return { entry: m, reevaluation: rec };
}

/** A model no longer in use: a person says so. */
export function retireModel(root: string, id: string, by: string, note = ''): InventoryEntry {
  const who = person(by, 'who retires a model');
  const inv = readInventory(root);
  const m = inv.models.find((x) => x.id === id || x.id.startsWith(id));
  if (!m) throw new Error('no model ' + id + ' in the inventory');
  m.history.push({ at: new Date().toISOString(), status: 'retired', by: who, cause: note || 'retired' });
  m.status = 'retired';
  writeInventory(root, inv);
  return m;
}
