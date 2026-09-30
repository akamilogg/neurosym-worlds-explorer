import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { parseJsonLoose } from '../core/net.ts';
import type { ChatClient } from '../learn/system2.ts';
import { LabError, type LabRunOptions } from '../runtime/lab-runner.ts';
import { finding as findingOfRun, runStatus } from '../runtime/control.ts';
import { isGameLab } from '../learn/lab.ts';
import { LABS } from '../worlds/labs.ts';
import { runBatch, type BatchDefinition, type BatchReport, type BatchRun } from './batch.ts';
import { researcherEvents } from './view.ts';

/* ============================================================================
 * The PROJECT PLANNER (SPEC-ORQUESTADOR §5, R3, R3b, R4): an agent that pursues a big GOAL in a
 * loop - state, hypotheses with their predictions, a plan (a batch), its execution, a
 * synthesis, new goals - until a COMPUTABLE criterion says the goal is met, or the budget is
 * spent, or nothing is worth its cost, or the operator stops it.
 *
 *   - The criterion is code over what the runs' researchers found (Q3): never the planner's
 *     opinion. The operator gives it, or approves the one the planner proposes, before any run.
 *   - The planner sees the runs only as their researchers lived them (Q2), and the laboratories
 *     only by their names and options - never what the worlds are: what it decides reaches the
 *     researchers (tasks, messages to branches).
 *   - Its conclusions are references (Q6): each with its support, marked when it rests on one run;
 *     a conclusion a later experiment contradicts is revised.
 *   - Budgets are hierarchical (Q8): the project's tokens pay for its batches and its own calls.
 *   - The human is in charge (Q9): consultive (every batch approved), threshold (approved above
 *     a cost), autonomous; stop at any time. Every decision, with its reason, is in project@1.
 *   - Local minima (§5.5): the state shows, per run that did not get there, the operator's signs
 *     that it is stuck and the alternatives its researcher wrote; the planner may open a BRANCH -
 *     the run's history continued with more rounds and handed to the assisted researcher, with
 *     a first message stating the alternative - or a new assisted run with a task.
 * ========================================================================== */

export type Autonomy = 'consultive' | 'threshold' | 'autonomous';

export interface ProjectGoal {
  /** The question, in words. */
  readonly question: string;
  /** The criterion, as code: `(runs) => boolean | { met: boolean, why: string }` over the runs' summaries. Without it the
      planner proposes one and the operator approves it. */
  readonly criterion?: string;
}

export interface ProjectOptions {
  readonly root: string;
  readonly id: string;
  readonly goal: ProjectGoal;
  readonly budget: { readonly tokens: number; readonly iterations?: number };
  readonly autonomy?: Autonomy;
  /** threshold: batches that cost at most this many tokens go without approval. */
  readonly threshold?: number;
  /** The planner's LLM (the caller wraps it with a replay log to make the project resumable). */
  readonly planner: ChatClient;
  readonly llm: LabRunOptions['llm'];
  readonly judge?: LabRunOptions['judge'];
  readonly fetch?: LabRunOptions['fetch'];
  readonly agentLlm?: (id: string) => ChatClient;
  readonly signal?: AbortSignal;
  readonly print?: (line: string) => void;
  readonly maxRuns?: number;
  readonly pollMs?: number;
}

/** One run as the planner and the criterion see it: its researcher's finding, summarised. */
export interface RunSummary {
  readonly id: string;
  readonly iteration: number;
  readonly condition: string;
  readonly lab: string;
  readonly args: readonly string[];
  readonly level: number | null;
  readonly seed: number | null;
  readonly researcher: string;
  readonly status: string;
  readonly accepted: boolean;
  readonly round: number | null;
  readonly tokens_total: number | null;
  readonly tokens_to_acceptance: number | null;
  readonly help: number;
  readonly journal: string | null;
  /** Its researcher's claims and its last plan. */
  readonly claims: readonly { statement: string; status: string }[];
  readonly next_experiment: string | null;
  /** Operator signs that it is stuck (§5.5), for a run that did not get there. */
  readonly stuck?: { rounds: number; rounds_holding_nowhere: number; distinct_models: number; untested_ideas: readonly string[]; branchable: boolean };
}

export interface Conclusion {
  readonly id: string;
  statement: string;
  status: string;
  support: string[];
  replicated: boolean;
  history: { iteration: number; status: string; why: string }[];
}

export interface ProjectRecord {
  readonly format: 'project@1';
  readonly id: string;
  readonly goal: ProjectGoal;
  criterion: { source: string; by: 'operator' | 'planner'; approved: boolean } | null;
  readonly budget: { readonly tokens: number; readonly iterations?: number };
  readonly autonomy: Autonomy;
  readonly threshold?: number;
  readonly started: string;
  spent: { runs: number; planner: number };
  iterations: { n: number; hypotheses?: unknown[]; plan?: unknown; approval?: { by: string; decision: string; note?: string; at: string }; batch?: string; synthesis?: unknown; criterion?: { met: boolean; why: string } }[];
  conclusions: Conclusion[];
  open_questions: string[];
  events: { at: string; type: string; [k: string]: unknown }[];
  ended?: { at: string; why: string };
}

export const PLANNER_SYSTEM = [
  'You are the PLANNER of a research project. Researchers are AIs that investigate environments nobody has described to them: each run, a researcher proposes models, the environment checks them and says whether they hold, and a run ends accepted (its model held everywhere it was checked) or not.',
  'You pursue the project\'s QUESTION in a loop: state what is known, form hypotheses - each with its PREDICTION, what you expect to see if it is true and if it is false - plan a BATCH of runs that tells them apart, and after it, a SYNTHESIS: which hypotheses the runs confirmed, refuted or left undecided, and what is now concluded.',
  'Principles:',
  '- The project\'s CRITERION decides whether the question is answered: code over the runs, never your opinion.',
  '- You see the runs only as their researchers lived them, and the laboratories only by name and options. You do not know what the environments are, and nothing you send a researcher may claim more than its runs showed.',
  '- Compare runs only within the same researcher, or across conditions you declared beforehand. Replicate before concluding: a conclusion that rests on one run is marked so. Results are references, not truths: when a later run contradicts a conclusion, revise it rather than defend it.',
  '- Spend the budget where it tells hypotheses apart; stop when no hypothesis is worth its cost.',
  '- A run whose researcher got stuck (rounds of variants of one idea, alternatives it wrote down and never tested) can be given a BRANCH: its history continued with more rounds and handed to the assisted researcher, with a first message that holds up an alternative the researcher itself wrote (quote it) - a colleague\'s suggestion, never a fact about the environment. The original run stays as it was. Only a run that ended by using up its rounds (branchable) can be branched.',
  'Batch runs: {"id": "<unique in the project>", "lab": "<name>", "args": ["--seed", "1", "--level", "2", ...], "researcher": "unknown-world" | "assisted", "condition": "<what it stands for>"} or, a branch, {"id": ..., "lab": ..., "condition": ..., "fork": {"of": "<run id>", "attempts": <more than it had>, "message": "..."}}.',
  'Answer ONE JSON object, as the `task` asks.'
].join('\n');

const TASKS = {
  criterion: 'Propose the project\'s criterion: JavaScript `(runs) => ({ met: <boolean>, why: "<text>" })` over the runs (each: id, iteration, condition, lab, args, level, seed, researcher, status, accepted, round, tokens_total, tokens_to_acceptance, help). Answer {"criterion": "<code>", "why": "..."}.',
  plan: 'Plan the next iteration. Answer {"rationale": "...", "hypotheses": [{"id": "...", "statement": "...", "if_true": "...", "if_false": "..."}], "batch": {"runs": [...], "concurrency": <n>}, "budget_tokens": <for the batch>} - or, when nothing more is worth its cost, {"stop": "<why>"}.',
  synthesis: 'The batch ended. Answer {"verdicts": [{"hypothesis": "<id>", "verdict": "confirmed" | "refuted" | "undecided", "runs": ["<run id>"], "why": "..."}], "conclusions": [{"id": "...", "statement": "...", "status": "new" | "kept" | "confirmed" | "revised" | "refuted", "support": ["<run id>"], "replicated": <boolean>, "why": "..."}], "open_questions": ["..."]}.'
};

const readJson = (file: string): any => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => { const t = setTimeout(resolve, ms); signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true }); });
const tokensOf = (raw: unknown): number => Number((raw as { usage?: { total_tokens?: number } } | null)?.usage?.total_tokens ?? 0) || 0;
const argValue = (args: readonly string[], name: string): number | null => { const i = args.indexOf('--' + name); return i >= 0 && Number.isFinite(Number(args[i + 1])) ? Number(args[i + 1]) : null; };

/** The files of a project. */
export function projectFiles(root: string, id: string): { dir: string; record: string; inbox: string; status: string; report: string } {
  const dir = path.join(root, 'runs', 'projects', id);
  return { dir, record: path.join(dir, 'project.json'), inbox: path.join(dir, 'project.inbox.jsonl'), status: path.join(dir, 'project.status.json'), report: path.join(dir, 'project.txt') };
}

/** An order to a project: approve or reject the plan (or the criterion) waiting for approval, or stop. */
export type ProjectOrder = { kind: 'approve'; note?: string; by?: string } | { kind: 'reject'; note: string; by?: string } | { kind: 'stop'; by?: string };
export function sendProject(root: string, id: string, order: ProjectOrder): void {
  const f = projectFiles(root, id);
  fs.mkdirSync(f.dir, { recursive: true });
  fs.appendFileSync(f.inbox, JSON.stringify({ at: new Date().toISOString(), ...order }) + '\n');
}

/** The criterion as a function. */
export function compileCriterion(source: string): (runs: readonly RunSummary[]) => { met: boolean; why: string } {
  let fn: unknown;
  try { fn = new vm.Script('(' + source + ')').runInNewContext({ Math, JSON, Number, Array, Object, String }, { timeout: 1000 }); } catch (e) { throw new LabError('the criterion does not compile: ' + String((e as Error)?.message ?? e)); }
  if (typeof fn !== 'function') throw new LabError('the criterion must be a function (runs) => ...');
  return (runs) => {
    const out = (fn as (r: unknown) => unknown)(JSON.parse(JSON.stringify(runs)));
    return typeof out === 'boolean' ? { met: out, why: '' } : { met: Boolean((out as { met?: unknown })?.met), why: String((out as { why?: unknown })?.why ?? '') };
  };
}

/** A run's summary, from its researcher's finding and its journal as the researcher lived it (with the operator's signs
    that it is stuck, §5.5). */
function summarize(iteration: number, run: BatchRun, row: BatchReport['runs'][number]): RunSummary {
  const f = row.journal && fs.existsSync(row.journal) ? findingOfRun(row.journal, 'researcher') : null;
  const args = run.fork ? [] : [...(run.args ?? [])];
  const base: RunSummary = {
    id: run.id, iteration, condition: run.condition, lab: run.lab, args, level: argValue(args, 'level'), seed: argValue(args, 'seed'),
    researcher: row.researcher, status: row.status, accepted: row.accepted, round: row.round, tokens_total: row.tokens_total, tokens_to_acceptance: row.tokens_to_acceptance,
    help: row.help, journal: row.journal, claims: (f?.claims ?? []).map((c) => ({ statement: c.statement, status: c.status })), next_experiment: f?.limitations.learner?.next_experiment ?? null
  };
  if (row.accepted || !row.journal || !fs.existsSync(row.journal)) return base;
  const events = researcherEvents(readJson(row.journal) ?? {});
  const checks = events.filter((e) => e.type === 'check');
  const ideas = [...new Set(events.flatMap((e) => [e.next_experiment, ...(e.notes ?? []).map((n: { text?: string }) => n.text)]).filter((x): x is string => typeof x === 'string' && /rival|altern|instead|might|could|test whether|state-depend/i.test(x)))].slice(-4);
  return { ...base, stuck: {
    rounds: checks.length,
    rounds_holding_nowhere: checks.filter((c) => !c.laboratories.some((p: { holds: boolean }) => p.holds)).length,
    distinct_models: new Set(events.filter((e) => e.type === 'proposal').map((e) => e.fingerprint)).size,
    untested_ideas: ideas.map((t) => t.slice(0, 300)),
    branchable: row.status === 'budget' && !isGameLab(LABS[run.lab])
  } };
}

/** The laboratories as the planner may know them: names, options and defaults - not what they are (Q2). */
function catalogue(): Record<string, { options: Record<string, string>; facets?: string[] }> {
  return Object.fromEntries(Object.entries(LABS).map(([name, lab]) => [name, isGameLab(lab)
    ? { options: Object.fromEntries(lab.options.map((o) => [o.name, o.default])) }
    : { options: Object.fromEntries(lab.options.filter((o) => o.name !== 'service').map((o) => [o.name, o.default])), ...(lab.facets ? { facets: lab.facets.map((x) => x.id) } : {}) }]));
}

/** Pursues a project's goal (or resumes it: its record, its batches and - through the planner's replay log - its
    decisions are taken up where they were). */
export async function runProject(o: ProjectOptions): Promise<ProjectRecord> {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(o.id)) throw new LabError('a project needs an id (letters, digits, - and _)');
  if (!(o.budget.tokens > 0)) throw new LabError('a project needs a budget in tokens');
  const files = projectFiles(o.root, o.id);
  fs.mkdirSync(files.dir, { recursive: true });
  const say = o.print ?? (() => {});
  const previous: ProjectRecord | null = readJson(files.record);
  const record: ProjectRecord = { format: 'project@1', id: o.id, goal: o.goal, criterion: null, budget: o.budget, autonomy: o.autonomy ?? 'consultive',
    ...(o.threshold !== undefined ? { threshold: o.threshold } : {}), started: previous?.started ?? new Date().toISOString(),
    spent: { runs: 0, planner: 0 }, iterations: [], conclusions: [], open_questions: [], events: [] };
  /* Decisions of the operator already given (resuming): approvals are taken up where they were. */
  const given = (previous?.events ?? []).filter((e) => e.type === 'operator_decision');
  let consumed = 0, stopRequested = false;
  const log = (type: string, data: Record<string, unknown> = {}) => { record.events.push({ at: new Date().toISOString(), type, ...data }); save(); };
  const writeStatus = () => fs.writeFileSync(files.status, JSON.stringify({ project: o.id, state: record.ended ? 'ended' : waiting ? 'waiting' : 'running', waiting_for: waiting, heartbeat: new Date().toISOString(),
    pid: process.pid, spent: record.spent, budget: record.budget, iterations: record.iterations.length }, null, 2));
  const save = () => { fs.writeFileSync(files.record, JSON.stringify(record, null, 2)); writeStatus(); };
  /* A heartbeat while batches run (they take long): the project is alive. */
  const beat = setInterval(() => { try { writeStatus(); } catch { /* a convenience */ } }, 2000);
  beat.unref?.();
  let waiting: string | null = null;
  /** The operator's orders since the last look. */
  const inbox = (): ProjectOrder[] => {
    if (!fs.existsSync(files.inbox)) return [];
    const lines = fs.readFileSync(files.inbox, 'utf8').split('\n').filter((l) => l.trim());
    const fresh = lines.slice(consumed).map((l) => { try { return JSON.parse(l) as ProjectOrder; } catch { return null; } }).filter((x): x is ProjectOrder => !!x);
    consumed = lines.length;
    for (const order of fresh) if (order.kind === 'stop') { stopRequested = true; log('operator_decision', { decision: 'stop', by: order.by ?? 'operator' }); }
    return fresh.filter((x) => x.kind !== 'stop');
  };
  /** Waits for the operator to approve or reject (resuming: the decision already given, in order). */
  const approval = async (what: string): Promise<{ decision: 'approve' | 'reject'; note?: string; by: string }> => {
    const earlier = given.shift();
    if (earlier && (earlier.decision === 'approve' || earlier.decision === 'reject')) {
      log('operator_decision', { what, decision: earlier.decision, ...(earlier.note ? { note: earlier.note } : {}), by: earlier.by, replayed: true });
      return { decision: earlier.decision as 'approve' | 'reject', ...(earlier.note ? { note: String(earlier.note) } : {}), by: String(earlier.by ?? 'operator') };
    }
    waiting = what;
    log('awaiting_approval', { what });
    say('project ' + o.id + ': waiting for the operator to approve ' + what + ' (lab project approve ' + o.id + ')');
    while (!o.signal?.aborted && !stopRequested) {
      const order = inbox().find((x) => x.kind === 'approve' || x.kind === 'reject');
      if (order) {
        waiting = null;
        log('operator_decision', { what, decision: order.kind, ...(order.note ? { note: order.note } : {}), by: order.by ?? 'operator' });
        return { decision: order.kind as 'approve' | 'reject', ...(order.note ? { note: order.note } : {}), by: order.by ?? 'operator' };
      }
      save();
      await sleep(o.pollMs ?? 1000, o.signal);
    }
    waiting = null;
    return { decision: 'reject', note: 'stopped', by: 'operator' };
  };
  /** One consultation of the planner, counted in the project's budget. */
  const ask = async (task: keyof typeof TASKS, state: unknown): Promise<Record<string, any>> => {
    const answer = await o.planner.complete({ system: PLANNER_SYSTEM, user: { task: TASKS[task], state } });
    record.spent.planner += tokensOf(answer.raw);
    const parsed = parseJsonLoose(answer.content);
    log('planner', { task, answer: parsed ?? answer.content });
    return (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, any>;
  };
  const left = () => o.budget.tokens - record.spent.runs - record.spent.planner;
  const runs: RunSummary[] = [];
  const runsById = new Map<string, RunSummary>();
  const stateOf = (extra: Record<string, unknown> = {}) => ({
    question: o.goal.question, criterion: record.criterion?.source ?? null, laboratories: catalogue(),
    budget: { tokens: o.budget.tokens, spent: record.spent.runs + record.spent.planner, left: left(), ...(o.budget.iterations ? { iterations: o.budget.iterations, done: record.iterations.length } : {}) },
    runs: runs.map(({ journal: _j, ...r }) => r), conclusions: record.conclusions.map(({ history: _h, ...c }) => c), open_questions: record.open_questions,
    iterations: record.iterations.map((it) => ({ n: it.n, hypotheses: it.hypotheses, synthesis: it.synthesis, approval: it.approval })), ...extra
  });
  const end = (why: string) => { clearInterval(beat); record.ended = { at: new Date().toISOString(), why }; log('ended', { why }); fs.writeFileSync(files.report, projectText(record)); say('project ' + o.id + ': ended - ' + why); return record; };

  inbox();
  /* --- The criterion: the operator's, or the planner's once the operator approves it (Q3). -------------------------- */
  let criterion: ReturnType<typeof compileCriterion>;
  if (o.goal.criterion) {
    criterion = compileCriterion(o.goal.criterion);
    record.criterion = { source: o.goal.criterion, by: 'operator', approved: true };
  } else {
    for (;;) {
      const proposed = await ask('criterion', stateOf());
      try { criterion = compileCriterion(String(proposed.criterion ?? '')); } catch (e) { log('criterion_refused', { error: String((e as Error).message) }); continue; }
      record.criterion = { source: String(proposed.criterion), by: 'planner', approved: false };
      const d = await approval('the criterion');
      if (stopRequested || o.signal?.aborted) return end('stopped by the operator before the criterion was approved');
      if (d.decision === 'approve') { record.criterion.approved = true; break; }
      log('criterion_rejected', { note: d.note ?? '' });
    }
  }
  save();

  /* --- The loop -------------------------------------------------------------------------------------------------- */
  let operatorNote: string | null = null;
  for (let n = 1; ; n++) {
    inbox();
    if (stopRequested || o.signal?.aborted) return end('stopped by the operator');
    if (o.budget.iterations && n > o.budget.iterations) return end('the iterations of the budget are spent');
    if (left() <= 0) return end('the budget is spent');
    const iteration: ProjectRecord['iterations'][number] = { n };
    record.iterations.push(iteration);
    /* Plan (a plan the checks refuse is asked again, with why). */
    let plan: Record<string, any> = {};
    let errors: string[] = [];
    for (let tries = 0; tries < 3; tries++) {
      plan = await ask('plan', stateOf({ iteration: n, ...(errors.length ? { your_plan_was_refused: errors } : {}), ...(operatorNote ? { operator_note: operatorNote } : {}) }));
      if (typeof plan.stop === 'string') break;
      errors = checkPlan(plan, runsById, left(), o.maxRuns ?? 8);
      if (!errors.length) break;
      log('plan_refused', { iteration: n, errors });
    }
    if (typeof plan.stop === 'string') { iteration.plan = { stop: plan.stop }; return end('the planner: ' + plan.stop); }
    if (errors.length) return end('the planner could not make a valid plan: ' + errors.join('; '));
    iteration.hypotheses = plan.hypotheses ?? [];
    iteration.plan = { rationale: plan.rationale, batch: plan.batch, budget_tokens: plan.budget_tokens };
    save();
    /* Approval (R4): consultive, every batch; threshold, above its cost; autonomous, none. */
    const cost = Number(plan.budget_tokens);
    const needs = record.autonomy === 'consultive' || (record.autonomy === 'threshold' && !(cost <= (o.threshold ?? 0)));
    if (needs) {
      const d = await approval('the plan of iteration ' + n + ' (' + cost + ' tokens)');
      iteration.approval = { by: d.by, decision: d.decision, ...(d.note ? { note: d.note } : {}), at: new Date().toISOString() };
      if (stopRequested || o.signal?.aborted) return end('stopped by the operator');
      if (d.decision === 'reject') { operatorNote = d.note ?? 'rejected'; log('plan_rejected', { iteration: n, note: operatorNote }); continue; }
    } else iteration.approval = { by: 'autonomy:' + record.autonomy, decision: 'approve', at: new Date().toISOString() };
    operatorNote = null;
    /* Execute. */
    const defRuns: BatchRun[] = (plan.batch.runs as Record<string, any>[]).map((r) => ({
      id: String(r.id), lab: String(r.lab), condition: String(r.condition),
      ...(r.fork ? { fork: { journal: runsById.get(String(r.fork.of))!.journal!, attempts: Number(r.fork.attempts), ...(r.fork.message ? { message: String(r.fork.message) } : {}) } }
        : { args: (r.args ?? []).map(String), ...(r.researcher ? { researcher: r.researcher } : {}) }),
      ...(r.agent ? { agent: { id: String(r.agent.id ?? r.agent), ...(r.agent.max_orders ? { max_orders: Number(r.agent.max_orders) } : {}) } } : {})
    }));
    const def: BatchDefinition = { format: 'batch@1', id: o.id + '-i' + n, runs: defRuns, concurrency: Math.max(1, Number(plan.batch.concurrency) || 2), budget: { tokens: Math.min(cost, left()) } };
    iteration.batch = path.join(files.dir, 'batches', 'i' + n, 'batch.json');
    save();
    say('project ' + o.id + ': iteration ' + n + ' - ' + defRuns.length + ' runs');
    const report = await runBatch(def, { root: o.root, dir: path.dirname(iteration.batch), llm: o.llm, ...(o.judge ? { judge: o.judge } : {}), ...(o.fetch ? { fetch: o.fetch } : {}),
      ...(o.agentLlm ? { agentLlm: o.agentLlm } : {}), ...(o.signal ? { signal: o.signal } : {}), print: say });
    record.spent.runs += report.runs.reduce((s, r) => s + (r.tokens_total ?? 0), 0);
    for (const row of report.runs) {
      const s = summarize(n, defRuns.find((d) => d.id === row.id)!, row);
      runs.push(s);
      runsById.set(s.id, s);
    }
    if (o.signal?.aborted) return end('stopped by the operator');
    /* Synthesis: hypotheses against what the runs showed; the conclusions, with their support and history (Q6). */
    const synthesis = await ask('synthesis', stateOf({ iteration: n, hypotheses: iteration.hypotheses, batch: { table: report.table, runs: report.runs.map((r) => r.id) } }));
    iteration.synthesis = { verdicts: synthesis.verdicts ?? [], open_questions: synthesis.open_questions ?? [] };
    for (const c of (synthesis.conclusions ?? []) as Record<string, any>[]) {
      const known = record.conclusions.find((x) => x.id === c.id);
      const support = (c.support ?? []).map(String).filter((id: string) => runsById.has(id));
      if (known) {
        known.statement = String(c.statement ?? known.statement); known.status = String(c.status ?? known.status);
        known.support = [...new Set([...known.support, ...support])]; known.replicated = Boolean(c.replicated) && known.support.length > 1;
        known.history.push({ iteration: n, status: known.status, why: String(c.why ?? '') });
      } else record.conclusions.push({ id: String(c.id), statement: String(c.statement ?? ''), status: String(c.status ?? 'new'), support,
        replicated: Boolean(c.replicated) && support.length > 1, history: [{ iteration: n, status: String(c.status ?? 'new'), why: String(c.why ?? '') }] });
    }
    record.open_questions = (synthesis.open_questions ?? []).map(String);
    /* The criterion decides (Q3). */
    let verdict: { met: boolean; why: string };
    try { verdict = criterion!(runs); } catch (e) { verdict = { met: false, why: 'the criterion failed: ' + String((e as Error)?.message ?? e) }; }
    iteration.criterion = verdict;
    save();
    if (verdict.met) return end('the criterion is met' + (verdict.why ? ': ' + verdict.why : ''));
  }
}

/** Why a plan cannot run, or nothing. */
function checkPlan(plan: Record<string, any>, known: ReadonlyMap<string, RunSummary>, left: number, maxRuns: number): string[] {
  const errors: string[] = [];
  const list = plan.batch?.runs;
  if (!Array.isArray(list) || !list.length) return ['a plan needs batch.runs'];
  if (list.length > maxRuns) errors.push('at most ' + maxRuns + ' runs in a batch');
  const cost = Number(plan.budget_tokens);
  if (!(cost > 0)) errors.push('budget_tokens: how many tokens the batch may spend');
  else if (cost > left) errors.push('budget_tokens ' + cost + ' is more than the ' + left + ' left');
  const ids = new Set<string>();
  for (const r of list as Record<string, any>[]) {
    const id = String(r.id ?? '');
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id) || ids.has(id) || known.has(id)) errors.push('run id ' + JSON.stringify(id) + ': unique in the project, letters, digits, - and _');
    ids.add(id);
    if (!LABS[String(r.lab)]) errors.push('run ' + id + ': no laboratory ' + r.lab);
    if (!r.condition) errors.push('run ' + id + ': which condition does it stand for?');
    if (r.fork) {
      const of = known.get(String(r.fork.of));
      if (!of) errors.push('run ' + id + ': fork of an unknown run ' + r.fork.of);
      else if (!of.stuck?.branchable) errors.push('run ' + id + ': ' + r.fork.of + ' cannot be branched (only a run that ended by using up its rounds)');
      else if (!(Number(r.fork.attempts) > 0)) errors.push('run ' + id + ': fork.attempts');
      else if (String(r.lab) !== of.lab) errors.push('run ' + id + ': a branch of ' + of.id + ' is in ' + of.lab);
    } else if (r.args !== undefined && (!Array.isArray(r.args) || r.args.some((a: unknown) => typeof a !== 'string'))) errors.push('run ' + id + ': args are strings');
    if (r.researcher && !['unknown-world', 'assisted'].includes(r.researcher)) errors.push('run ' + id + ': researcher unknown-world or assisted');
  }
  return errors;
}

/** The project's report, for a person: what was asked, done, known (with its support), left open, and its cost. */
export function projectText(r: ProjectRecord): string {
  const lines = ['PROJECT ' + r.id, 'Question: ' + r.goal.question, 'Criterion (' + (r.criterion?.by ?? '-') + (r.criterion?.approved ? ', approved' : '') + '): ' + (r.criterion?.source ?? '-'),
    'Autonomy: ' + r.autonomy + (r.threshold !== undefined ? ' (threshold ' + r.threshold + ' tokens)' : ''), ''];
  for (const it of r.iterations) {
    lines.push('Iteration ' + it.n + (it.approval ? ' (' + it.approval.decision + ' by ' + it.approval.by + (it.approval.note ? ': ' + it.approval.note : '') + ')' : ''));
    for (const h of (it.hypotheses ?? []) as Record<string, any>[]) lines.push('  hypothesis ' + h.id + ': ' + h.statement + ' | if true: ' + (h.if_true ?? '') + ' | if false: ' + (h.if_false ?? ''));
    for (const v of ((it.synthesis as Record<string, any> | undefined)?.verdicts ?? []) as Record<string, any>[]) lines.push('  ' + v.hypothesis + ' ' + String(v.verdict).toUpperCase() + ' (' + (v.runs ?? []).join(', ') + '): ' + (v.why ?? ''));
    if (it.criterion) lines.push('  criterion: ' + (it.criterion.met ? 'MET' : 'not met') + (it.criterion.why ? ' - ' + it.criterion.why : ''));
  }
  lines.push('', 'Conclusions (references, not truths):');
  for (const c of r.conclusions) lines.push('  [' + c.status + (c.replicated ? ', replicated' : ', rests on ' + c.support.length + ' run' + (c.support.length === 1 ? '' : 's')) + '] ' + c.statement + ' (' + c.support.join(', ') + ')');
  if (r.open_questions.length) lines.push('', 'Open:', ...r.open_questions.map((q) => '  - ' + q));
  lines.push('', 'Cost: ' + (r.spent.runs + r.spent.planner) + ' of ' + r.budget.tokens + ' tokens (runs ' + r.spent.runs + ', planner ' + r.spent.planner + ')');
  if (r.ended) lines.push('Ended: ' + r.ended.why);
  return lines.join('\n') + '\n';
}

/** A project's state (for the command line and the console). */
export function projectStatus(root: string, id: string): { record: ProjectRecord | null; status: Record<string, unknown> | null; alive: boolean } {
  const f = projectFiles(root, id);
  const status = readJson(f.status);
  return { record: readJson(f.record), status, alive: !!status?.heartbeat && Date.now() - Date.parse(status.heartbeat) < 15000 && status.state !== 'ended' };
}

/** The projects under <root>/runs/projects. */
export function listProjects(root: string): string[] {
  const dir = path.join(root, 'runs', 'projects');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, 'project.json'))) : [];
}

/** Runs of a project that ended, as the batch reports hold them (a run's state from its journal). */
export const runEnded = (journal: string): boolean => fs.existsSync(journal) && runStatus(journal).state === 'ended';
