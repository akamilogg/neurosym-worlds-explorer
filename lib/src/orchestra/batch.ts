import fs from 'node:fs';
import path from 'node:path';
import type { ChatClient } from '../learn/system2.ts';
import type { Finding } from '../learn/finding.ts';
import { LabError, runLaboratory, type LabRunOptions } from '../runtime/lab-runner.ts';
import { finding as findingOfRun, runStatus, send } from '../runtime/control.ts';
import { LABS } from '../worlds/labs.ts';
import { runAgentOperator } from './agent-operator.ts';

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
  readonly agent?: { readonly id: string; readonly max_orders?: number; readonly role?: 'coach' | 'senior'; readonly patience?: number };
  /** A BRANCH (SPEC-ORQUESTADOR §5.5): another run's history, continued with more rounds and handed to the assisted
      researcher, with a first message that states the alternative to explore. */
  readonly fork?: { readonly journal: string; readonly attempts: number; readonly message?: string };
}

export interface BatchDefinition {
  readonly format?: 'batch@1';
  readonly id: string;
  readonly runs: readonly BatchRun[];
  /** Runs at once (default 2): the APIs limit it (SPEC-ORQUESTADOR §9.5). */
  readonly concurrency?: number;
  /** The budget in System 2's tokens: in all (shared out equally), or per run. */
  readonly budget?: { readonly tokens?: number; readonly tokens_per_run?: number };
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
    help: f?.assistance?.messages.length ?? 0, ...(error ? { error } : {}) };
}

/** The table by condition, from the rows (researchers' findings only). */
export function batchTable(rows: readonly BatchRunRow[]): ConditionRow[] {
  const conditions = [...new Set(rows.map((r) => r.condition))];
  return conditions.map((condition) => {
    const rs = rows.filter((r) => r.condition === condition && r.status !== 'error' && r.status !== 'not run');
    return { condition, runs: rs.length, accepted: rs.filter((r) => r.accepted).length,
      acceptance_round: spread(rs.map((r) => r.round)), tokens_to_acceptance: spread(rs.map((r) => r.tokens_to_acceptance)),
      tokens_total: spread(rs.map((r) => r.tokens_total)), help: spread(rs.map((r) => r.help)) };
  });
}

/** Whether a run is done: it ended, and not because the batch was stopped (a cancelled run is resumed). */
const ended = (journal: string): boolean => { if (!fs.existsSync(journal)) return false; const s = runStatus(journal); return s.state === 'ended' && s.stoppedBy !== 'cancelled'; };

/** A batch in a few lines, for a person. */
export function batchText(report: BatchReport): string {
  const s = (x: Spread) => (x.median === null ? '-' : x.median + (x.q1 !== x.q3 ? ' [' + x.q1 + '–' + x.q3 + ']' : ''));
  return ['batch ' + report.id + (report.ended ? ' (ended ' + report.ended + ')' : ' (running)'),
    ...report.table.map((c) => '  ' + c.condition + ': ' + c.accepted + '/' + c.runs + ' accepted; round ' + s(c.acceptance_round) + '; tokens to acceptance ' + s(c.tokens_to_acceptance) + '; tokens ' + s(c.tokens_total) + '; help ' + s(c.help)),
    ...report.runs.map((r) => '    ' + r.id + ' [' + r.condition + ']: ' + r.status + (r.round !== null ? ' in round ' + r.round : '') + (r.error ? ' - ' + r.error : '')),
    ...(report.audit.length ? ['  AUDIT (operator only): ' + report.audit.map((a) => a.condition + ' recovery ' + s(a.rule_recovery)).join('; ')] : [])].join('\n');
}

/** Runs a batch (or resumes it): the runs not ended yet, a few at a time; then the table and the audit. */
export async function runBatch(def: BatchDefinition, options: BatchOptions): Promise<BatchReport> {
  if (!def.id || !/^[a-z0-9][a-z0-9_-]*$/i.test(def.id)) throw new LabError('a batch needs an id (letters, digits, - and _)');
  const ids = new Set<string>();
  for (const r of def.runs) {
    if (!r.id || ids.has(r.id) || !/^[a-z0-9][a-z0-9_-]*$/i.test(r.id)) throw new LabError('batch ' + def.id + ': every run needs an id of its own (letters, digits, - and _): ' + JSON.stringify(r.id));
    ids.add(r.id);
    if (!LABS[r.lab]) throw new LabError('batch ' + def.id + ', run ' + r.id + ': no laboratory ' + r.lab + ' (' + Object.keys(LABS).join(', ') + ')');
    if (!r.condition) throw new LabError('batch ' + def.id + ', run ' + r.id + ': which condition does it stand for?');
  }
  const dir = options.dir ?? path.join(options.root, 'runs', 'batches', def.id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'batch.json');
  const before: BatchReport | null = readJson(file);
  const report: BatchReport = { format: 'batch@1', id: def.id, definition: def, dir, started: before?.started ?? new Date().toISOString(), runs: [], table: [], audit: [] };
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

  const one = async (r: BatchRun): Promise<void> => {
    const known = latest.get(r.id);
    if (known && ended(known)) { rows.set(r.id, rowOf(r, known, findingOfRun(known, 'researcher'))); return; }
    const k = known ? (known.match(/\.r(\d+)\.json$/)?.[1] ? Number(known.match(/\.r(\d+)\.json$/)![1]) + 1 : 1) : 0;
    const out = path.join(dir, r.id + (k ? '.r' + k : '') + '.json');
    const budget = perRun ? ['--max-tokens', String(perRun)] : [];
    const agents = [...(r.agent ? [r.agent.id + '=message'] : []), ...(r.fork?.message ? ['planner=message'] : [])];
    const control = [...budget, ...(agents.length ? ['--agents', agents.join(';')] : [])];
    const args = known ? ['--resume', known, ...control, '--out', out]
      : r.fork ? ['--resume', r.fork.journal, '--attempts', String(r.fork.attempts), '--researcher', 'assisted', ...control, '--out', out]
        : [...(r.args ?? []), ...(r.researcher ? ['--researcher', r.researcher] : []), ...control, '--out', out];
    /* A branch's first message waits in its inbox for its first new round. */
    if (!known && r.fork?.message) send(out, { kind: 'message', text: r.fork.message, by: 'agent:planner' });
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
  save();
  fs.writeFileSync(path.join(dir, 'batch.txt'), batchText(report) + '\n');
  return report;
}
