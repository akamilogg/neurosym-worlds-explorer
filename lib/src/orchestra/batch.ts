import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { batchTimes, criteriaProblems, groupResults, type Criteria, type GroupResults } from './results.ts';
import { compareConditions, compareWithReference, comparisonProblems, conditionComparisonProblems, type ComparisonDeclared, type ConditionsDeclared } from './references.ts';
import { coverage, designProblems, expandDesign, type BatchTemplate, type Variation } from './design.ts';
import path from 'node:path';
import type { ChatClient } from '../learn/system2.ts';
import type { Finding } from '../learn/finding.ts';
import { LabError, runLaboratory, type LabRunOptions } from '../runtime/lab-runner.ts';
import { finding as findingOfRun, runStatus, send } from '../runtime/control.ts';
import { LABS } from '../worlds/labs.ts';
import { agentFile, agentUsage, runAgentOperator } from './agent-operator.ts';

/* ============================================================================
 * The ORCHESTRATOR (SPEC-ORQUESTADOR §4, R2): a BATCH of runs declared beforehand - each with
 * its laboratory, its arguments, its researcher and the CONDITION it stands for - run with a
 * limited concurrency and a budget shared out among them, and compared by condition.
 *
 * The comparison is made ONLY of what the researchers' findings say (Q2, Q7): acceptance and
 * its round, the cost, where the model held, the help received; replicas as a median and a
 * spread, never one run. The operator's view (the grading against the truth) goes to a
 * separate AUDIT, marked as such, which never goes back to any researcher.
 *
 * A batch is resumable: a run that ended is not run again, and one that was cut is resumed
 * (a run derived from it, SPEC-OBJETIVO O11). The report (batch@1) lives next to the runs.
 * ========================================================================== */

export interface BatchRun {
  readonly id: string;
  readonly lab: string;
  readonly args?: readonly string[];
  readonly researcher?: 'unknown-world' | 'assisted';
  /** The condition it stands for: runs are compared within a condition, and conditions only as declared (Q7). */
  readonly condition: string;
  /** An agent operator that follows it (an assisted run): its id and how many orders it may send. */
  /** An agent operator that follows the run: a coach (default) or a senior (SPEC-ORQUESTADOR §3.3). */
  readonly agent?: { readonly id: string; readonly max_orders?: number; readonly role?: 'coach' | 'senior'; readonly patience?: number;
    /** A senior gives the junior its first hypothesis before it asks anything (SPEC-ORQUESTADOR §3.3.4): the default; false,
        the junior starts on its own. */
    readonly opening?: boolean };
  /** A BRANCH (SPEC-ORQUESTADOR §5.5): another run's history, continued with more rounds and handed to the assisted
      researcher, with a first message that states the alternative to explore. */
  readonly fork?: { readonly journal: string; readonly attempts: number; readonly message?: string;
    /** Tests of its own required from its new rounds on (SPEC-PRUEBAS-PROPIAS §13): `--own-tests N` given to the continuation. */
    readonly own_tests?: number };
  /** Messages of the operator scheduled in advance (SPEC-INVESTIGADOR-ASISTIDO §6.1): each held until its round begins,
      then delivered with its first question - a nudge given at a round chosen beforehand, the same for every run that
      declares it. Help like any other message: in the finding, and in the help budget. */
  readonly messages?: readonly { readonly round: number; readonly text: string; readonly pin?: string }[];
}

export interface BatchDefinition {
  readonly format?: 'batch@1';
  readonly id: string;
  readonly runs: readonly BatchRun[];
  /** Runs at once (default 2): the APIs limit it (SPEC-ORQUESTADOR §9.5). */
  readonly concurrency?: number;
  /** The budget in System 2's tokens: in all (shared out equally), or per run. */
  readonly budget?: { readonly tokens?: number; readonly tokens_per_run?: number };
  /** Criteria of adequacy to a use, declared BEFORE the batch (SPEC-CONTROL-ARNES §4.1 O3): each run is yes, no or not
      evaluable by each, and each has its own efficiency. */
  readonly criteria?: Criteria;
  /** Comparisons with frozen references, declared BEFORE the batch with their margin (SPEC-CONTROL-ARNES §6.2.1, §6.4):
      a condition of this batch, paired by seed with the reference's runs. */
  readonly compare?: readonly ComparisonDeclared[];
  /** A design (SPEC-CONTROL-ARNES K3, §7): the runs made from a template and its variation, the same seeds in every condition. */
  readonly template?: BatchTemplate;
  readonly vary?: Variation;
  /** Comparisons of two of its conditions, declared before it runs with their margin (§4.3, §6.2.1): b against a. */
  readonly compare_conditions?: readonly ConditionsDeclared[];
}

export interface BatchOptions {
  readonly root: string;
  /** Where the batch's runs and report go (default <root>/runs/batches/<id>). */
  readonly dir?: string;
  readonly llm: LabRunOptions['llm'];
  /** A team's member on a model of its own (SPEC-INVESTIGACION-PARALELA §5.1): its System 2, by its id (default `llm`). */
  readonly llmFor?: (member: string) => LabRunOptions['llm'] | undefined;
  readonly judge?: LabRunOptions['judge'];
  readonly fetch?: LabRunOptions['fetch'];
  readonly signal?: AbortSignal;
  readonly print?: (line: string) => void;
  /** The LLM of an agent operator, by its id. */
  readonly agentLlm?: (id: string) => ChatClient;
}

export interface BatchRunRow {
  readonly id: string;
  readonly condition: string;
  readonly lab: string;
  readonly researcher: string;
  /** Its journal (the latest of its chain: a run cut and resumed is its derived run). */
  readonly journal: string | null;
  readonly status: string;
  readonly accepted: boolean;
  readonly round: number | null;
  readonly tokens_total: number | null;
  readonly tokens_to_acceptance: number | null;
  readonly help: number;
  /** Its tests of its own (SPEC-PRUEBAS-PROPIAS §9), when it registered any. */
  readonly own_tests?: { readonly registered: number; readonly severe: number; readonly by_senior: number; readonly counterexamples: number; readonly closed: number; readonly preregistered_final: number | null };
  /** Its agent operator, when it had one: what it cost over the run (and the runs it resumed), and how much of its input the
      provider took from its cache. */
  readonly agent?: { readonly id: string; readonly decisions: number; readonly calls: number; readonly tokens_in: number; readonly cached_share: number | null; readonly cost: number };
  readonly error?: string;
}

export interface Spread { readonly median: number | null; readonly q1: number | null; readonly q3: number | null }
export interface ConditionRow {
  readonly condition: string;
  readonly runs: number;
  readonly accepted: number;
  readonly acceptance_round: Spread;
  readonly tokens_to_acceptance: Spread;
  readonly tokens_total: Spread;
  readonly help: Spread;
  /** Per run: severe tests of its own, and counterexamples found (SPEC-PRUEBAS-PROPIAS §10). */
  readonly severe_tests: Spread;
  readonly counterexamples: Spread;
}

export interface BatchReport {
  readonly format: 'batch@1';
  readonly id: string;
  readonly definition: BatchDefinition;
  readonly dir: string;
  readonly started: string;
  ended?: string;
  runs: BatchRunRow[];
  table: ConditionRow[];
  /** AUDIT (the operator's view): never shown to a researcher, nor to an agent that helps one. */
  audit: { readonly condition: string; readonly rule_recovery: Spread }[];
  /** Its results apart and their cost, by group of comparable runs, with their uncertainty (SPEC-CONTROL-ARNES K1); the
      operator's view too (mechanistic recovery is in it). */
  results?: { readonly groups: GroupResults[]; readonly times: Record<string, unknown>; readonly comparisons?: readonly Record<string, unknown>[];
    readonly condition_comparisons?: readonly Record<string, unknown>[]; readonly reading: string };
  /** What was declared when it began - its criteria and its comparisons, preregistered - and every definition it had since:
      a batch resumed never presents results of runs made under another design, and what is declared later is marked so. */
  preregistered?: { readonly at: string; readonly criteria: Criteria; readonly compare: readonly ComparisonDeclared[]; readonly compare_conditions: readonly ConditionsDeclared[]; readonly note?: string };
  definition_history?: { readonly at: string; readonly sha256: string }[];
  /** Its design, when it was made from a template: what it covers of the perturbations of §7, and what it leaves uncovered. */
  design?: { readonly runs: number; readonly covered: readonly string[]; readonly uncovered: readonly string[] };
}

const readJson = (file: string): any => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

/** The median and the quartiles of some numbers (null when there are none). */
export function spread(values: readonly (number | null | undefined)[]): Spread {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { median: null, q1: null, q3: null };
  const at = (q: number) => { const i = (v.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i); return Number((v[lo] + (v[hi] - v[lo]) * (i - lo)).toPrecision(6)); };
  return { median: at(0.5), q1: at(0.25), q3: at(0.75) };
}

/** A run's row, from its researcher's finding (a batch's, a team's). */
export function rowOf(def: BatchRun, journal: string | null, f: Finding | null, error?: string): BatchRunRow {
  const cost = (f?.cost.total ?? {}) as Record<string, number>, toAcc = (f?.cost.to_acceptance ?? {}) as Record<string, number>;
  const accepted = f?.outcome.status === 'accepted';
  return { id: def.id, condition: def.condition, lab: def.lab, researcher: f?.researcher ?? def.researcher ?? (def.fork ? 'assisted' : 'unknown-world'), journal,
    status: error ? 'error' : f?.outcome.status ?? 'not run', accepted, round: accepted ? f!.outcome.round : null,
    tokens_total: typeof cost.llm_tokens === 'number' ? cost.llm_tokens : null, tokens_to_acceptance: accepted && typeof toAcc.llm_tokens === 'number' ? toAcc.llm_tokens : null,
    help: f?.assistance?.messages.length ?? 0, ...(f?.own_tests ? { own_tests: { registered: f.own_tests.registered, severe: f.own_tests.severe, by_senior: f.own_tests.by.senior,
      counterexamples: f.own_tests.counterexamples.found, closed: f.own_tests.counterexamples.closed, preregistered_final: f.own_tests.final_model?.passed_preregistered.length ?? null } } : {}),
    ...(agentRow(def, journal)), ...(error ? { error } : {}) };
}

/** What a run's agent operator cost, from its record next to the run's journal. */
function agentRow(def: BatchRun, journal: string | null): { agent?: BatchRunRow['agent'] } {
  if (!def.agent || !journal) return {};
  const record = readJson(agentFile(journal, def.agent.id));
  if (!record) return {};
  const u = agentUsage(record);
  return { agent: { id: def.agent.id, decisions: u.decisions, calls: u.calls, tokens_in: u.tokens_in, cached_share: u.cached_share, cost: u.cost } };
}

/** A batch's results apart and their cost, by group of comparable runs (SPEC-CONTROL-ARNES K1, §6.1-§6.2), and its times. */
export function batchResults(report: BatchReport, root: string): NonNullable<BatchReport['results']> {
  const rows = report.runs.filter((r) => r.journal && fs.existsSync(r.journal)).map((r) => ({ condition: r.condition, journal: r.journal! }));
  /* What was declared after the batch began is not preregistered, and is said so beside each result. */
  const pre = report.preregistered;
  const when = (declared: boolean) => (pre ? (declared ? 'before the batch began' : 'after it began: not preregistered') : 'not recorded');
  const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  const comparisons = (report.definition.compare ?? []).map((c) => ({ ...compareWithReference(root, report as unknown as Record<string, any>, c), declared: when(!!pre?.compare.some((p) => same(p, c))) }));
  const conditionComparisons = (report.definition.compare_conditions ?? []).map((c) => ({ ...compareConditions(report as unknown as Record<string, any>, c), declared: when(!!pre?.compare_conditions.some((p) => same(p, c))) }));
  const groups = groupResults(rows, report.definition.criteria).map((g) => (typeof g.o3_adequacy === 'string' ? g
    : { ...g, o3_adequacy: Object.fromEntries(Object.entries(g.o3_adequacy).map(([id, x]) => [id, { ...x, declared: when(!!pre && same(pre.criteria[id], report.definition.criteria?.[id])) }])) }));
  return { groups, times: batchTimes(report.started, report.ended, rows, report.definition.criteria),
    ...(comparisons.length ? { comparisons } : {}), ...(conditionComparisons.length ? { condition_comparisons: conditionComparisons } : {}),
    reading: 'each result apart, none called correct; groups only of comparable runs; proportions with their denominator and Wilson\'s interval, the rest with a bootstrap interval or "insufficient evidence"; no label of control' };
}

/** The lines of the results for a person. */
function resultsText(results: NonNullable<BatchReport['results']>): string[] {
  const p = (r: { k: number; n: number; interval95: [number, number] | null }) => r.k + '/' + r.n + (r.interval95 ? ' [' + r.interval95.join(', ') + ']' : '');
  const d = (x: Record<string, any>) => x.n === 0 ? 'none' : x.evidence === 'insufficient evidence' ? 'insufficient evidence (' + x.values.join(', ') + ')' : 'median ' + x.median + ' [' + x.median_interval95.join(', ') + '], q ' + x.q1 + '-' + x.q3 + ', n ' + x.n;
  return ['  RESULTS APART (K1; the operator\'s view), by group of comparable runs:',
    ...results.groups.flatMap((g) => ['    ' + g.group.condition + ' (' + g.group.world + ', code ' + String(g.group.code_version ?? 'unknown').slice(0, 10) + ', generator ' + g.group.generator + '): ' + g.runs + ' runs',
      '      O1 model accepted ' + p(g.o1_predictive_acceptance.model) + (g.o1_predictive_acceptance.artifact ? '; artifact ' + p(g.o1_predictive_acceptance.artifact) : ''),
      '      O2 severe tests passed as preregistered: ' + d(g.o2_severe_passed_as_preregistered as Record<string, any>),
      '      O3 ' + (typeof g.o3_adequacy === 'string' ? g.o3_adequacy : Object.entries(g.o3_adequacy).map(([id, x]) => id + ' ' + p(x.yes) + ' of the evaluable (' + x.not_evaluable + ' not evaluable, coverage ' + x.coverage + ')').join('; ')),
      '      O4 mechanistic recovery: ' + d(g.o4_mechanistic_recovery as Record<string, any>),
      '      cost: tokens at least ' + g.cost.tokens_sum_at_least + ' in all, per run ' + d(g.cost.tokens_total_at_least as Record<string, any>) + '; money known ' + g.cost.money_known_sum + (g.cost.money_unknown_in ? ' (unknown in ' + g.cost.money_unknown_in + ' runs: a lower bound)' : ''),
      '      efficiency: ' + Object.entries(g.efficiency).map(([id, e]) => id + ' ' + e.runs_meeting + ' runs, ' + e.per_million_tokens + ' per million tokens').join('; '),
      '      process (a description): first round holding in its laboratories ' + d(g.process.first_round_holding_in_its_laboratories as Record<string, any>) + (g.process.runs_never_holding ? ' (' + g.process.runs_never_holding + ' never)' : '')
        + '; steps looking ' + d(g.process.steps.looking as Record<string, any>) + ', experimenting ' + d(g.process.steps.experimenting as Record<string, any>) + ', recalling ' + d(g.process.steps.recalling as Record<string, any>)
        + '; proposals returned ' + d(g.process.proposals_returned as Record<string, any>)
        + (g.process.directives.given ? '; directives ' + g.process.directives.given + ': reported carried out ' + g.process.directives.reported_carried_out + ', not carried out ' + g.process.directives.reported_not_carried_out + ', not reported ' + g.process.directives.not_reported : '')
        + (g.process.told_its_senior ? '; told its senior ' + g.process.told_its_senior + ' times' : '')]),
    '    times: ' + JSON.stringify(results.times),
    ...(results.condition_comparisons ?? []).map((c: Record<string, any>) => '    ' + c.b + ' against ' + c.a + ' [' + c.metric + ']: ' + c.comparison.conclusion + ' (effect ' + c.comparison.effect
      + (c.comparison.interval95 ? ' [' + c.comparison.interval95.join(', ') + ']' : '') + ', margin ' + c.comparison.margin + ', ' + c.comparison.pairs + ' paired seeds'
      + (c.comparison.discordant ? ', discordant ' + c.comparison.discordant.better_now + ' better / ' + c.comparison.discordant.worse_now + ' worse' : '')
      + (c.not_controlled ? '; NOT controlled: ' + c.not_controlled.join(', ') : '') + ')'),
    ...(results.comparisons ?? []).map((c: Record<string, any>) => '    compared with reference ' + c.reference + ' [' + c.condition + ', ' + c.metric + ']: '
      + (c.refused ? 'refused - ' + c.refused : c.comparison.conclusion + ' (effect ' + c.comparison.effect + (c.comparison.interval95 ? ' [' + c.comparison.interval95.join(', ') + ']' : '') + ', margin ' + c.comparison.margin
        + ', ' + c.comparison.pairs + ' paired seeds' + (c.groups.differ_in.length ? '; the groups differ in ' + c.groups.differ_in.join(', ') : '') + ')'))];
}

/** The table by condition, from the rows (researchers' findings only). */
export function batchTable(rows: readonly BatchRunRow[]): ConditionRow[] {
  const conditions = [...new Set(rows.map((r) => r.condition))];
  return conditions.map((condition) => {
    const rs = rows.filter((r) => r.condition === condition && r.status !== 'error' && r.status !== 'not run');
    return { condition, runs: rs.length, accepted: rs.filter((r) => r.accepted).length,
      acceptance_round: spread(rs.map((r) => r.round)), tokens_to_acceptance: spread(rs.map((r) => r.tokens_to_acceptance)),
      tokens_total: spread(rs.map((r) => r.tokens_total)), help: spread(rs.map((r) => r.help)),
      severe_tests: spread(rs.map((r) => r.own_tests?.severe ?? 0)), counterexamples: spread(rs.map((r) => r.own_tests?.counterexamples ?? 0)) };
  });
}

/** Whether a run is done: it ended, and not because the batch was stopped (a cancelled run is resumed). */
const ended = (journal: string): boolean => { if (!fs.existsSync(journal)) return false; const s = runStatus(journal); return s.state === 'ended' && s.stoppedBy !== 'cancelled'; };

/** A batch in a few lines, for a person. */
export function batchText(report: BatchReport): string {
  const s = (x: Spread) => (x.median === null ? '-' : x.median + (x.q1 !== x.q3 ? ' [' + x.q1 + '–' + x.q3 + ']' : ''));
  return ['batch ' + report.id + (report.ended ? ' (ended ' + report.ended + ')' : ' (running)'),
    ...(report.design ? ['  design: ' + report.design.runs + ' runs from a template; covers ' + (report.design.covered.join('; ') || 'nothing of §7')
      + (report.design.uncovered.length ? '; leaves UNCOVERED ' + report.design.uncovered.join('; ') : '')] : []),
    ...report.table.map((c) => '  ' + c.condition + ': ' + c.accepted + '/' + c.runs + ' accepted; round ' + s(c.acceptance_round) + '; tokens to acceptance ' + s(c.tokens_to_acceptance) + '; tokens ' + s(c.tokens_total) + '; help ' + s(c.help)
      + (c.severe_tests.median || c.counterexamples.median ? '; severe tests ' + s(c.severe_tests) + '; counterexamples ' + s(c.counterexamples) : '')),
    ...report.runs.map((r) => '    ' + r.id + ' [' + r.condition + ']: ' + r.status + (r.round !== null ? ' in round ' + r.round : '') + (r.error ? ' - ' + r.error : '')
      + (r.own_tests ? '; tests ' + r.own_tests.registered + ' (' + r.own_tests.severe + ' severe, ' + r.own_tests.by_senior + ' by the senior), counterexamples ' + r.own_tests.counterexamples + ' (' + r.own_tests.closed + ' closed)' : '')
      + (r.agent ? '; agent:' + r.agent.id + ' ' + r.agent.decisions + ' decisions, ' + r.agent.calls + ' calls, ' + Math.round(r.agent.tokens_in / 1000) + 'k tokens in'
        + (r.agent.cached_share !== null ? ' (' + Math.round(r.agent.cached_share * 100) + '% cached)' : '') + ', $' + r.agent.cost : '')),
    ...(report.audit.length ? ['  AUDIT (operator only): ' + report.audit.map((a) => a.condition + ' recovery ' + s(a.rule_recovery)).join('; ')] : []),
    ...(report.results ? resultsText(report.results) : [])].join('\n');
}

/** Runs a batch (or resumes it): the runs not ended yet, a few at a time; then the table and the audit. */
export async function runBatch(declared: BatchDefinition, options: BatchOptions): Promise<BatchReport> {
  /* A design: its runs made from its template, the same seeds under every condition. */
  const designWrong = designProblems(declared);
  if (designWrong.length) throw new LabError('batch ' + declared.id + ': ' + designWrong.join('; '));
  const def: BatchDefinition = declared.template && declared.vary ? { ...declared, runs: expandDesign(declared.template, declared.vary) } : declared;
  if (!def.id || !/^[a-z0-9][a-z0-9_-]*$/i.test(def.id)) throw new LabError('a batch needs an id (letters, digits, - and _)');
  const ids = new Set<string>();
  for (const r of def.runs) {
    if (!r.id || ids.has(r.id) || !/^[a-z0-9][a-z0-9_-]*$/i.test(r.id)) throw new LabError('batch ' + def.id + ': every run needs an id of its own (letters, digits, - and _): ' + JSON.stringify(r.id));
    ids.add(r.id);
    if (!LABS[r.lab]) throw new LabError('batch ' + def.id + ', run ' + r.id + ': no laboratory ' + r.lab + ' (' + Object.keys(LABS).join(', ') + ')');
    if (!r.condition) throw new LabError('batch ' + def.id + ', run ' + r.id + ': which condition does it stand for?');
  }
  const wrong = [...criteriaProblems(def.criteria), ...comparisonProblems(options.root, def.compare),
    ...conditionComparisonProblems([...new Set(def.runs.map((r) => r.condition))], def.compare_conditions)];
  if (wrong.length) throw new LabError('batch ' + def.id + ': ' + wrong.join('; '));
  const dir = options.dir ?? path.join(options.root, 'runs', 'batches', def.id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'batch.json');
  const before: BatchReport | null = readJson(file);
  /* Resumed: its runs as they were declared when it began - never others under the same name (an external review, 19/10/2026:
     a design changed from level 1 to level 2 kept the runs of level 1 and saved the definition of level 2). */
  if (before) {
    const substance = (runs: readonly BatchRun[]) => JSON.stringify(runs.map((r) => ({ id: r.id, condition: r.condition, lab: r.lab, args: r.args ?? [], researcher: r.researcher ?? null,
      agent: r.agent ?? null, fork: r.fork ?? null, messages: r.messages ?? null })));
    if (substance(before.definition.runs) !== substance(def.runs))
      throw new LabError('batch ' + def.id + ' began with other runs: a batch resumed keeps its runs as declared - a new design is a new batch (another id)');
  }
  const started = before?.started ?? new Date().toISOString();
  const sha = createHash('sha256').update(JSON.stringify(def)).digest('hex');
  const history = [...(before?.definition_history ?? [])];
  if (history[history.length - 1]?.sha256 !== sha) history.push({ at: new Date().toISOString(), sha256: sha });
  const preregistered = before?.preregistered ?? (before
    ? { at: before.started, criteria: before.definition.criteria ?? {}, compare: before.definition.compare ?? [], compare_conditions: before.definition.compare_conditions ?? [],
      note: 'taken from the definition it was saved with before this was recorded: when each was declared is not known' }
    : { at: started, criteria: def.criteria ?? {}, compare: def.compare ?? [], compare_conditions: def.compare_conditions ?? [] });
  const report: BatchReport = { format: 'batch@1', id: def.id, definition: def, dir, started, runs: [], table: [], audit: [], preregistered, definition_history: history,
    ...(def.template && def.vary ? { design: { runs: def.runs.length, ...coverage(def.template, def.vary) } } : {}) };
  if (report.design?.uncovered.length) options.print?.('batch ' + def.id + ': its design leaves uncovered - ' + report.design.uncovered.join('; '));
  const latest = new Map<string, string>((before?.runs ?? []).filter((r) => r.journal).map((r) => [r.id, r.journal!]));
  const rows = new Map<string, BatchRunRow>();
  const save = () => {
    report.runs = def.runs.map((r) => rows.get(r.id) ?? rowOf(r, latest.get(r.id) ?? null, null));
    report.table = batchTable(report.runs);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
  };
  /* What the batch says goes to its console and, with the time, to batch.log next to its runs: a batch cut short leaves its
     story behind. */
  const print = options.print ?? (() => {});
  const say = (line: string): void => {
    print(line);
    try { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(path.join(dir, 'batch.log'), new Date().toISOString() + ' ' + line + '\n'); } catch { /* the console has it */ }
  };
  const traceOf = (e: unknown): string => String((e as Error)?.stack || (e as Error)?.message || e);
  const perRun = def.budget?.tokens_per_run ?? (def.budget?.tokens ? Math.floor(def.budget.tokens / Math.max(1, def.runs.length)) : null);

  /** An argument as given, or - "@run:<id>" - the journal that run of this batch ended with. */
  const runRef = (a: string): string => {
    const m = /^@run:(.+)$/.exec(a);
    if (!m) return a;
    const id = m[1];
    if (!def.runs.some((x) => x.id === id)) throw new Error('"' + a + '": this batch has no run "' + id + '"');
    const j = latest.get(id);
    if (!j || !fs.existsSync(j)) throw new Error('"' + a + '": run "' + id + '" has no journal yet (declare it before this run, with concurrency 1)');
    if (runStatus(j).state !== 'ended') throw new Error('"' + a + '": run "' + id + '" has not ended (' + runStatus(j).state + ')');
    return j;
  };

  const one = async (r: BatchRun): Promise<void> => {
    /* A run that failed before it wrote a journal (a bad argument) is started afresh, never resumed. */
    const known = ((j) => (j && fs.existsSync(j) ? j : undefined))(latest.get(r.id));
    if (known && ended(known)) { rows.set(r.id, rowOf(r, known, findingOfRun(known, 'researcher'))); return; }
    const k = known ? (known.match(/\.r(\d+)\.json$/)?.[1] ? Number(known.match(/\.r(\d+)\.json$/)![1]) + 1 : 1) : 0;
    const out = path.join(dir, r.id + (k ? '.r' + k : '') + '.json');
    const budget = perRun ? ['--max-tokens', String(perRun)] : [];
    const agents = [...(r.agent ? [r.agent.id + '=message'] : []), ...(r.fork?.message ? ['planner=message'] : [])];
    const control = [...budget, ...(agents.length ? ['--agents', agents.join(';')] : [])];
    /* A fresh run followed by a senior starts from its first hypothesis; a resumed one has it in its history. */
    const opening = r.agent?.role === 'senior' && r.agent.opening !== false ? ['--opening', r.agent.id] : [];
    /* "@run:<id>" in a run's arguments is the journal another run of this batch ended with - wherever it is (a resumed run's
       has a suffix), never a path written by hand (c302closed-staged-n2-3: B looked for A under another batch's id). */
    let own: string[];
    try { own = known || r.fork ? [] : (r.args ?? []).map((a) => runRef(a)); } catch (e) {
      rows.set(r.id, rowOf(r, out, null, String((e as Error)?.message ?? e)));
      say('batch ' + def.id + ': ' + r.id + ' failed: ' + String((e as Error)?.message ?? e));
      save();
      return;
    }
    const args = known ? ['--resume', known, ...control, '--out', out]
      : r.fork ? ['--resume', r.fork.journal, '--attempts', String(r.fork.attempts), '--researcher', 'assisted', ...(r.fork.own_tests ? ['--own-tests', String(r.fork.own_tests)] : []), ...control, '--out', out]
        : [...own, ...(r.researcher ? ['--researcher', r.researcher] : []), ...control, ...opening, '--out', out];
    /* A branch's first message waits in its inbox for its first new round. */
    if (!known && r.fork?.message) send(out, { kind: 'message', text: r.fork.message, by: 'agent:planner' });
    /* Messages scheduled in advance wait in its inbox, each for its round. */
    if (!known) for (const m of r.messages ?? []) send(out, { kind: 'message', text: m.text, by: 'operator', round: m.round, ...(m.pin ? { pin: m.pin } : {}) });
    latest.set(r.id, out);
    save();
    say('batch ' + def.id + ': ' + r.id + ' [' + r.condition + '] ' + (known ? 'resumed' : 'started'));
    const controller = new AbortController();
    /* An agent that fails is said and the run goes on without it: its failure never takes the batch down. */
    const agent = r.agent && options.agentLlm
      ? runAgentOperator({ id: r.agent.id, journal: out, llm: options.agentLlm(r.agent.id), maxOrders: r.agent.max_orders, ...(r.agent.role ? { role: r.agent.role } : {}), ...(r.agent.patience ? { patience: r.agent.patience } : {}), signal: controller.signal, say })
        .catch((e) => { say('batch ' + def.id + ': ' + r.id + ': agent:' + r.agent!.id + ' failed and stopped following the run: ' + traceOf(e)); }) : null;
    try {
      const result = await runLaboratory(LABS[r.lab], { args, root: options.root, llm: options.llm, ...(options.judge ? { judge: options.judge } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.signal ? { signal: options.signal } : {}) });
      rows.set(r.id, rowOf(r, result.journal, result.researcher));
      say('batch ' + def.id + ': ' + r.id + ' ' + result.stoppedBy);
    } catch (e) {
      rows.set(r.id, rowOf(r, out, null, String((e as Error)?.message ?? e)));
      say('batch ' + def.id + ': ' + r.id + ' failed: ' + traceOf(e));
    } finally {
      controller.abort();
      await agent;
      save();
    }
  };

  /* A few at a time, in the order declared. */
  const queue = [...def.runs];
  const workers = Array.from({ length: Math.max(1, Math.min(def.concurrency ?? 2, queue.length)) }, async () => {
    while (queue.length && !options.signal?.aborted) await one(queue.shift()!);
  });
  await Promise.all(workers);
  save();
  /* AUDIT: the operator's view, by condition - apart. */
  report.audit = [...new Set(def.runs.map((r) => r.condition))].map((condition) => ({ condition,
    rule_recovery: spread(report.runs.filter((r) => r.condition === condition && r.journal && fs.existsSync(r.journal))
      .map((r) => Number((findingOfRun(r.journal!, 'operator').operator?.rule_recovery as { score?: number } | undefined)?.score))) }));
  if (!options.signal?.aborted && report.runs.every((r) => r.status !== 'not run' && (r.error || (r.journal && ended(r.journal))))) report.ended = new Date().toISOString();
  report.results = batchResults(report, options.root);
  save();
  fs.writeFileSync(path.join(dir, 'batch.txt'), batchText(report) + '\n');
  return report;
}
