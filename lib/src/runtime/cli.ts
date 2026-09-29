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
 *   lab focus <run> <facet>        help
 *   lab source <run> <file|dir>    help
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
  'lab focus <run> <facet>                                   change its focus (only the assisted researcher)',
  'lab source <run> <file|dir>                               give it a source (only the assisted researcher)',
  'lab stop <run>                                            stop it before its next question to System 2',
  'lab resume <run> [--max-tokens N] [--max-minutes N]       resume it as a run derived from it',
  'lab finding <run> [--view researcher]                     its finding (the operator\'s view by default)',
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
          : command === 'focus' ? { kind: 'focus', facet: String(args[1] ?? ''), by: 'operator' }
          : command === 'source' ? { kind: 'source', source: path.resolve(String(args[1] ?? '')), by: 'operator' }
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
