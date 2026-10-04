import fs from 'node:fs';
import path from 'node:path';
import { findingText } from '../learn/finding.ts';
import { finding, listRuns, orderOutcome, resumeRun, runStatus, send, startRun, watch, type RunInfo, type RunOrder } from './control.ts';

/* ============================================================================
 * The command line of the control API (SPEC-INVESTIGADOR-ASISTIDO §5, A2): the same for both
 * researchers. A run is named by its journal's path, its name in runs/ (with or without
 * .json), a prefix that names only one, or `last` (the newest).
 *
 *   lab start <lab> [--researcher R] [--policy P] [the experiment's arguments...]
 *   lab list
 *   lab status <run>
 *   lab watch <run>
 *   lab send <run> "<text>"        help: only the assisted researcher takes it
 *   lab focus <run> <facet> [task] help
 *   lab source <run> <origin>      help
 *   lab stop <run>
 *   lab resume <run> [--max-tokens N] [--max-minutes N] [--policy P]
 *   lab finding <run> [--view researcher]
 *
 * The keys never pass through here: a run started or resumed takes them from this process's
 * environment (LLM_URL, LLM_MODEL, LLM_KEY; JEV_URL, JEV_KEY).
 * ========================================================================== */

export interface CliContext {
  /** The repository: runs are in <root>/runs. */
  readonly root: string;
  readonly out: (line: string) => void;
  readonly env?: NodeJS.ProcessEnv;
  /** How long to wait for a run to acknowledge an order (ms). */
  readonly ackMs?: number;
  /** Stops `watch` (tests); by default it follows until the run ends. */
  readonly signal?: AbortSignal;
}

export const CLI_USAGE = [
  'lab start <lab> [--researcher R] [--policy P] [args...]   start a run in a process of its own (labs: cells, messages, orbit, grid, tank)',
  'lab list                                                  the runs, newest first',
  'lab status <run>                                          a run\'s state and its latest events',
  'lab watch <run>                                           its events as they come, until it ends',
  'lab send <run> "<text>"                                   a message to its researcher (only the assisted researcher takes it)',
  'lab focus <run> <facet> [what to understand]              change its focus (only the assisted researcher)',
  'lab source <run> <dir|url|domain>                         allow it an origin of sources (only the assisted researcher)',
  'lab stop <run>                                            stop it before its next question to System 2',
  'lab resume <run> [--max-tokens N] [--max-minutes N]       resume it as a run derived from it',
  'lab finding <run> [--view researcher]                     its finding (the operator\'s view by default)',
  '',
  'The orchestra (SPEC-ORQUESTADOR):',
  'lab agent <run> [--id coach] [--max-orders N]             an agent operator follows the run (it needs --agents coach=message on the run)',
  '          [--role senior] [--patience N]                   a senior: when the run is stuck, it reviews the junior record and proposes a hypothesis',
  'lab grade <run>                                           grade a finished run again (operator only), with GRADER_LLM_* (default LLM_*)',
  'lab audit <run> [--flat]                                  audit its method (operator only): links, citations, controls; J1-J6 by the Judge (JEV_*), or code only with --flat',
  'lab batch <batch.json>                                    run (or resume) a batch of runs and compare them by condition',
  'lab project start <goal.json>                             a project of the planner, in a process of its own',
  'lab project list | status <id>                            the projects; one\'s state and report',
  'lab project approve <id> [note] | reject <id> <note>      decide what it waits for (a criterion, a plan)',
  'lab project stop <id> | resume <id>                       stop it; resume it (its decisions are taken up where they were)',
  '',
  '<run>: a journal\'s path, its name in runs/, a prefix of it, or `last`. Keys come from the environment only.'
].join('\n');

/** A run named on the command line, as a journal's path. */
export function resolveRun(root: string, name: string | undefined): string {
  if (!name) throw new Error('name a run (lab list shows them)');
  if (fs.existsSync(name) && name.endsWith('.json')) return path.resolve(name);
  const runs = listRuns(path.join(root, 'runs'));
  if (name === 'last') { if (!runs.length) throw new Error('there are no runs yet'); return runs[0].journal; }
  const exact = runs.find((r) => r.run === name || r.run + '.json' === name);
  if (exact) return exact.journal;
  const prefixed = runs.filter((r) => r.run.startsWith(name));
  if (prefixed.length === 1) return prefixed[0].journal;
  throw new Error(prefixed.length ? 'several runs start with ' + name + ': ' + prefixed.slice(0, 5).map((r) => r.run).join(', ') : 'no run named ' + name);
}

const short = (v: unknown, n = 90): string => { const t = typeof v === 'string' ? v : JSON.stringify(v) ?? ''; return t.length > n ? t.slice(0, n - 1) + '…' : t; };

/** One event of a journal, in one line a person reads. */
export function describeEvent(e: Record<string, any>): string {
  const at = typeof e.t === 'number' ? '[' + e.t + 's] ' : '';
  const r = typeof e.round === 'number' ? 'round ' + e.round + ': ' : '';
  switch (e.type) {
    case 'start': return at + 'started' + (e.resumed_from ? ' (resuming ' + path.basename(String(e.resumed_from)) + ')' : '');
    case 'exploration_episode': case 'exploration_game': case 'exploration_launch': return at + 'the environment ran ' + (e.episode ?? e.game ?? e.launch);
    case 'investigation': return at + r + 'investigates: ' + (e.requests ?? []).map((q: Record<string, unknown>) => Object.keys(q)[0] + (typeof Object.values(q)[0] === 'string' ? ' ' + Object.values(q)[0] : '')).join(', ');
    case 'proposal': return at + r + 'proposes a model' + (e.fingerprint ? ' ' + e.fingerprint : '') + (e.beliefs?.length ? '; beliefs ' + e.beliefs.map((b: { id: string; stance: string }) => b.id + ':' + b.stance).join(' ') : '');
    case 'check': return at + r + 'check: ' + (e.laboratories ?? []).map((p: { place: string; holds: boolean }) => p.place + (p.holds ? ' holds' : ' does not hold')).join(', ')
      + (e.validation?.family?.length ? '; validation: ' + e.validation.family.map((p: { place: string; holds: boolean }) => p.place + (p.holds ? ' holds' : ' not')).join(', ') : '')
      + (e.validation?.blind_confirmation ? '; blind: ' + (e.validation.blind_confirmation.confirmed ? 'confirmed' : 'not confirmed') : '') + (e.accepted ? '  ACCEPTED' : '');
    case 'accepted': return at + r + 'accepted';
    case 'reflection': return at + r + 'reflects: ' + short(e.rationale);
    case 'halted': return at + r + 'stopped before asking System 2 again (' + e.reason + ')';
    case 'operator_command': return at + 'the operator\'s ' + e.kind + (e.by ? ' (' + e.by + ')' : '') + ': accepted';
    case 'operator_message': return at + 'with question ' + e.question + ', System 2 is given the operator\'s message' + ((e.messages ?? []).length > 1 ? 's' : '') + ': '
      + (e.messages ?? []).map((m: { text: string }) => '"' + short(m.text, 70) + '"').join(', ');
    case 'sources_allowed': return at + 'from question ' + e.question + ', it may read sources from ' + e.origin;
    case 'source_select': return at + 'the Judge picked lines for "' + e.need + '" among ' + e.lines + (e.error ? ' (failed: ' + e.error + ')' : '');
    case 'researcher_switched': return at + 'after round ' + e.after_attempts + ', the run is handed to the assisted researcher: the operator may help';
    case 'budget_extended': return at + 'more rounds: ' + e.after_attempts + ' → ' + e.to_attempts;
    case 'focus_changed': return at + 'from question ' + e.question + ', what counts is the facet ' + e.facet + (e.task ? ' (to understand: ' + e.task + ')' : '');
    case 'operator_command_refused': return at + 'the operator\'s ' + (e.kind ?? 'order') + ': refused - ' + e.reason;
    case 'diverged': return at + 'DIVERGED from the run it resumes (' + e.channel + ')';
    case 'end': return at + 'ended: ' + e.stoppedBy + (e.resume ? ' (resumable)' : '');
    default: return at + r + e.type;
  }
}

const table = (runs: readonly RunInfo[]): string[] => {
  if (!runs.length) return ['no runs yet'];
  const rows = runs.map((r) => [r.run, r.lab, r.researcher, r.state, r.round === null ? '-' : String(r.round), r.stoppedBy ?? '-',
    r.cost ? String(r.cost.llm_calls ?? '-') + ' llm / ' + String(r.cost.jev_calls ?? '-') + ' jev' : '-']);
  const head = ['run', 'lab', 'researcher', 'state', 'round', 'stopped by', 'cost'];
  const width = head.map((h, i) => Math.max(h.length, ...rows.map((x) => x[i].length)));
  const line = (x: string[]) => x.map((c, i) => c.padEnd(width[i])).join('  ');
  return [line(head), ...rows.map(line)];
};

/** The value of an option in the command's arguments, and the arguments without it. */
function take(args: string[], name: string): string | undefined {
  const i = args.indexOf('--' + name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

/** Waits for a run to read an order and says what came of it. */
async function acknowledged(journal: string, id: string, ctx: CliContext): Promise<string> {
  const until = Date.now() + (ctx.ackMs ?? 15000);
  for (;;) {
    const o = orderOutcome(journal, id);
    if (o.state === 'accepted') return 'accepted';
    if (o.state === 'refused') return 'refused: ' + o.reason;
    if (runStatus(journal).state === 'ended' || runStatus(journal).state === 'interrupted') return 'not read: the run is ' + runStatus(journal).state;
    if (Date.now() > until) return 'written; the run has not read it yet (it reads orders before its next question to System 2)';
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Runs one command; returns the exit code (0 fine, 1 a failure, 2 a bad command). */
export async function labCli(argv: readonly string[], ctx: CliContext): Promise<number> {
  const [command, ...rest] = argv;
  const args = [...rest];
  const out = ctx.out;
  try {
    switch (command) {
      case 'start': {
        const lab = args.shift();
        if (!lab) { out('lab start <lab> ...'); return 2; }
        const researcher = take(args, 'researcher'), policy = take(args, 'policy');
        const { journal, pid } = startRun(lab, { root: ctx.root, args, ...(researcher ? { researcher } : {}), ...(policy ? { policy } : {}), ...(ctx.env ? { env: ctx.env } : {}) });
        out('started ' + path.basename(journal, '.json') + ' (pid ' + pid + ')');
        out('journal ' + journal);
        out('follow it: lab watch ' + path.basename(journal, '.json'));
        return 0;
      }
      case 'list': {
        for (const l of table(listRuns(path.join(ctx.root, 'runs')))) out(l);
        return 0;
      }
      case 'status': {
        const journal = resolveRun(ctx.root, args[0]);
        const s = runStatus(journal);
        out(s.run + ': ' + s.lab + ', ' + s.researcher + ' researcher, ' + s.state + (s.stoppedBy ? ' (' + s.stoppedBy + ')' : '') + (s.round !== null ? ', round ' + s.round : ''));
        if (s.cost) out('cost: ' + Object.entries(s.cost).map(([k, v]) => k + ' ' + v).join(', '));
        if (s.heartbeat) out('heartbeat: ' + s.heartbeat + (s.pid ? ' (pid ' + s.pid + ')' : ''));
        const events = (JSON.parse(fs.readFileSync(journal, 'utf8')).events ?? []) as Record<string, unknown>[];
        for (const e of events.slice(-8)) out('  ' + describeEvent(e));
        return 0;
      }
      case 'watch': {
        const journal = resolveRun(ctx.root, args[0]);
        /* Until the run ends, its heartbeat stops (interrupted), or the caller stops watching. */
        await new Promise<void>((done) => {
          let ended = false;
          const finish = (): void => {
            if (ended) return;
            ended = true;
            stopWatching();
            clearInterval(alive);
            done();
          };
          const stopWatching = watch(journal, (e) => { out(describeEvent(e)); if (e.type === 'end') setTimeout(finish, 0); }, { intervalMs: 500 });
          const alive = setInterval(() => {
            if (runStatus(journal).state !== 'interrupted') return;
            out('the run was interrupted (its heartbeat stopped): lab resume ' + path.basename(journal, '.json'));
            finish();
          }, 2000);
          ctx.signal?.addEventListener('abort', finish, { once: true });
        });
        return 0;
      }
      case 'send': case 'focus': case 'source': case 'stop': {
        const journal = resolveRun(ctx.root, args[0]);
        const order: RunOrder = command === 'send' ? { kind: 'message', text: args.slice(1).join(' '), by: 'operator' }
          : command === 'focus' ? { kind: 'focus', facet: String(args[1] ?? ''), ...(args.length > 2 ? { task: args.slice(2).join(' ') } : {}), by: 'operator' }
          : command === 'source' ? { kind: 'source', source: originOf(String(args[1] ?? '')), by: 'operator' }
          : { kind: 'stop', by: 'operator' };
        if (command !== 'stop' && !args[1]) { out('lab ' + command + ' <run> <' + (command === 'send' ? 'text' : command === 'focus' ? 'facet' : 'file|dir') + '>'); return 2; }
        const state = runStatus(journal).state;
        if (state === 'ended' || state === 'interrupted') { out('the run is ' + state + ': it reads no orders' + (state === 'interrupted' ? ' (lab resume it first)' : '')); return 1; }
        const { id } = send(journal, order);
        const outcome = await acknowledged(journal, id, ctx);
        out(order.kind + ' ' + outcome);
        return outcome.startsWith('refused') ? 1 : 0;
      }
      case 'resume': {
        const journal = resolveRun(ctx.root, args.shift());
        const policy = take(args, 'policy');
        const r = resumeRun(journal, { args, ...(policy ? { policy } : {}), ...(ctx.env ? { env: ctx.env } : {}) });
        out('resumed as ' + path.basename(r.journal, '.json') + ' (pid ' + r.pid + '); the run it resumes is left as it was');
        out('journal ' + r.journal);
        return 0;
      }
      case 'finding': {
        const journal = resolveRun(ctx.root, args[0]);
        const view = take(args, 'view') === 'researcher' ? 'researcher' : 'operator';
        const f = finding(journal, view);
        out('(' + view + ' view, ' + f.researcher + ' researcher)');
        out(findingText(f));
        return 0;
      }
      case 'grade': {
        const journal = resolveRun(ctx.root, args[0]);
        const env = ctx.env ?? process.env;
        const { chatFromEnv, endpointsFromEnv } = await import('../orchestra/launch.ts');
        const { regrade } = await import('./regrade.ts');
        const model = endpointsFromEnv(env, 'GRADER_LLM').model ?? '';
        const r = await regrade(journal, chatFromEnv(env, 'GRADER_LLM'), model);
        if (r.score === null) { out('the grading failed: ' + String(r.event.error)); return 1; }
        out('rule recovery ' + r.score + ' (graded by ' + model + '): ' + (r.event.grades as { id: string; grade: string }[]).map((g) => g.id + ':' + g.grade).join(' '));
        out('appended to ' + path.basename(journal) + '; findings written again');
        return 0;
      }
      case 'audit': {
        const journal = resolveRun(ctx.root, args[0]);
        const env = ctx.env ?? process.env;
        const flat = args.includes('--flat');
        const { auditMethod, auditFile } = await import('../audit/audit.ts');
        const { JevJudge, JEV_DEFAULT_URL } = await import('../core/jev.ts');
        if (!flat && !env.JEV_KEY) { out('the Judge is needed: JEV_KEY (or --flat for what code observes only)'); return 1; }
        const judge = flat ? null : new JevJudge({ url: env.JEV_URL || JEV_DEFAULT_URL, apiKey: env.JEV_KEY, model: env.JEV_MODEL || undefined, timeoutMs: 90000, retries: 4, retryNetwork: true, concurrency: 8 });
        const a = await auditMethod(journal, judge);
        const m = a.measures;
        out('links: ' + m.links.experiment + ' experiments, ' + m.links.observation + ' observations, ' + m.links.recall + ' readings of a record');
        out('citations: ' + m.citations.seen + ' seen, ' + m.citations.unseen + ' not seen, ' + m.citations.missing + ' to nothing; refused experiments ' + m.refused_experiments.count + ' (' + m.refused_experiments.cited_after + ' cited after)');
        out('orphan steps ' + m.orphan_steps.count + '; controls ' + m.controls.groups + ' (' + m.controls.used + ' used); beliefs ' + m.beliefs.count + ' (' + m.beliefs.revised + ' revised, ' + m.beliefs.dropped + ' dropped)');
        if (m.judged) out('judged (' + a.judge + ', ' + (a.judged?.calls ?? 0) + ' calls' + (a.judged?.errors.length ? ', ' + a.judged.errors.length + ' failed' : '') + '): complete chains ' + m.judged.complete_chains + '; reading ' + JSON.stringify(m.judged.reading) + '; refutation ' + JSON.stringify(m.judged.refutation));
        out('outcome, beside it: ' + JSON.stringify(a.outcome.checks.map((c: { scored_1?: number; of?: number; holds: boolean }) => c.scored_1 !== undefined ? c.scored_1 + '/' + c.of : c.holds ? 'holds' : 'fails')) + (a.outcome.rule_recovery !== undefined ? ', rule recovery ' + a.outcome.rule_recovery : ''));
        out('written to ' + path.basename(auditFile(journal)) + '; the operator\'s finding links it');
        return 0;
      }
      case 'agent': {
        const journal = resolveRun(ctx.root, args.shift());
        const role = take(args, 'role') === 'senior' ? 'senior' as const : 'coach' as const;
        const id = take(args, 'id') ?? role, max = take(args, 'max-orders'), patience = take(args, 'patience');
        const env = ctx.env ?? process.env;
        const { chatFromEnv } = await import('../orchestra/launch.ts');
        const { runAgentOperator } = await import('../orchestra/agent-operator.ts');
        out('agent:' + id + ' follows ' + path.basename(journal, '.json') + ' (the run must allow it: --agents ' + id + '=message)');
        const r = await runAgentOperator({ id, journal, role, llm: chatFromEnv(env, 'AGENT_LLM'), ...(max ? { maxOrders: Number(max) } : {}), ...(patience ? { patience: Number(patience) } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}), say: out });
        out('the run ended; the agent\'s decisions: ' + r.file);
        return 0;
      }
      case 'batch': {
        const file = args[0];
        if (!file) { out('lab batch <batch.json>'); return 2; }
        const env = ctx.env ?? process.env;
        const { runBatch, batchText } = await import('../orchestra/batch.ts');
        const { chatFromEnv, labEndpointsFromEnv } = await import('../orchestra/launch.ts');
        const def = JSON.parse(fs.readFileSync(file, 'utf8'));
        const report = await runBatch(def, { root: ctx.root, ...labEndpointsFromEnv(env), agentLlm: () => chatFromEnv(env, 'AGENT_LLM'), ...(ctx.signal ? { signal: ctx.signal } : {}), print: out });
        out(batchText(report));
        out('report: ' + path.join(report.dir, 'batch.json'));
        return 0;
      }
      case 'project': {
        const sub = args.shift();
        const { listProjects, projectStatus, projectText, sendProject } = await import('../orchestra/project.ts');
        const { readProjectFile, startProject } = await import('../orchestra/launch.ts');
        if (sub === 'start') {
          if (!args[0]) { out('lab project start <goal.json>'); return 2; }
          const goal = readProjectFile(args[0]);
          const r = startProject(ctx.root, goal, goal.id, ctx.env);
          out('project ' + goal.id + ' started (pid ' + r.pid + '): ' + r.dir);
          out('follow it: lab project status ' + goal.id);
          return 0;
        }
        if (sub === 'list') {
          const ids = listProjects(ctx.root);
          if (!ids.length) out('no projects yet');
          for (const id of ids) { const s = projectStatus(ctx.root, id); out(id + ': ' + (s.record?.ended ? 'ended (' + s.record.ended.why + ')' : String(s.status?.state ?? '?') + (s.alive ? '' : ' (not running)')) + (s.status?.waiting_for ? ' - waiting for ' + s.status.waiting_for : '')); }
          return 0;
        }
        const id = args.shift();
        if (!id) { out('lab project ' + (sub ?? '<command>') + ' <id>'); return 2; }
        if (sub === 'status') {
          const s = projectStatus(ctx.root, id);
          if (!s.record) { out('no project ' + id); return 1; }
          out(id + ': ' + (s.record.ended ? 'ended' : String(s.status?.state ?? '?') + (s.alive ? '' : ' (not running: lab project resume ' + id + ')')) + (s.status?.waiting_for ? ' - WAITING for you to approve ' + s.status.waiting_for : ''));
          const it = s.record.iterations.at(-1);
          if (s.status?.waiting_for && it?.plan) out('the plan: ' + JSON.stringify(it.plan, null, 2));
          if (s.status?.waiting_for && s.record.criterion && !s.record.criterion.approved) out('the criterion: ' + s.record.criterion.source);
          out(projectText(s.record));
          return 0;
        }
        if (sub === 'approve' || sub === 'reject' || sub === 'stop') {
          const note = args.join(' ');
          if (sub === 'reject' && !note) { out('lab project reject <id> <note: what to change>'); return 2; }
          sendProject(ctx.root, id, sub === 'stop' ? { kind: 'stop', by: 'operator' } : sub === 'approve' ? { kind: 'approve', ...(note ? { note } : {}), by: 'operator' } : { kind: 'reject', note, by: 'operator' });
          out(sub + ' sent to project ' + id);
          return 0;
        }
        if (sub === 'resume') {
          const s = projectStatus(ctx.root, id);
          if (s.alive) { out('project ' + id + ' is still going'); return 1; }
          if (s.record?.ended) { out('project ' + id + ' ended: ' + s.record.ended.why); return 1; }
          const r = startProject(ctx.root, null, id, ctx.env);
          out('project ' + id + ' resumed (pid ' + r.pid + ')');
          return 0;
        }
        out('lab project start|list|status|approve|reject|stop|resume');
        return 2;
      }
      case undefined: case 'help': case '--help': case '-h':
        out(CLI_USAGE);
        return command ? 0 : 2;
      default:
        out('unknown command ' + command + '\n' + CLI_USAGE);
        return 2;
    }
  } catch (e) {
    out(String((e as Error).message ?? e));
    return 1;
  }
}

/** An origin as the operator wrote it: a URL prefix or a domain as it is, a path made absolute. */
function originOf(o: string): string {
  return /^https?:\/\//i.test(o) || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(o) ? o : path.resolve(o);
}
