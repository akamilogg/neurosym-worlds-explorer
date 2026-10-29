import fs from 'node:fs';
import path from 'node:path';
import { findingText } from '../learn/finding.ts';
import { LabError } from './lab-runner.ts';
import { LABS } from '../worlds/labs.ts';
import { VERDICTS, runAnomalies, writeVerdict, type Verdict } from '../learn/anomalies.ts';
import { readManifest } from '../living/manifest.ts';
import { continueSessionAt, startSessionAt } from './control.ts';
import { finding, listRuns, orderOutcome, resumeRun, runStatus, send, startRun, watch, type RunInfo, type RunOrder } from './control.ts';

/* ============================================================================
 * The command line of the control API (SPEC-INVESTIGADOR-ASISTIDO §5, A2): the same for both
 * researchers. A run is named by its journal's path, its name in runs/ (with or without
 * .json), a prefix that names only one, or `last` (the newest).
 *
 *   lab start <lab> [--researcher R] [--policy P] [the experiment's arguments...]
 *   lab live <manifest.json>       a living world's session, as its manifest declares it (SPEC-ACONTECIMIENTOS-DEL-MUNDO §16)
 *   lab list
 *   lab status <run>
 *   lab watch <run>
 *   lab send <run> "<text>"        help: only the assisted researcher takes it
 *   lab focus <run> <facet> [task] help
 *   lab source <run> <origin>      help
 *   lab stop <run>
 *   lab resume <run> [--max-tokens N] [--max-minutes N] [--policy P]
 *   lab finding <run> [--view researcher]
 *   lab anomaly <run> [<report> bug|world|unclear [note]]
 *   lab pack <run> [--out dir]     a research package of it (SPEC-RIESGO-MODELOS M1)
 *   lab verify <package>           its integrity and its reconstruction, each by its name
 *   lab model revise|show|approve <run>   revisions of its validation report, closed; a person's conclusion on one
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
  'lab start <lab> [--researcher R] [--policy P] [args...]   start a run in a process of its own (labs: ' + Object.keys(LABS).join(', ') + ')',
  'lab live <manifest.json>                                  a living world\'s session, as its manifest declares it (living-world@1)',
  'lab world <run|session> <op> ...                         control of a living world by the operator: programs, pause/resume/close, join/retire, say/pin, status',
  'lab junior store|package|verify|check|probe ...           the junior packaged and served (SPEC-METAPOLITICA-APRENDIZAJE MA1)',
  'lab list                                                  the runs, newest first',
  'lab status <run>                                          a run\'s state and its latest events',
  'lab watch <run>                                           its events as they come, until it ends',
  'lab send <run> "<text>"                                   a message to its researcher (only the assisted researcher takes it)',
  'lab focus <run> <facet> [what to understand]              change its focus (only the assisted researcher)',
  'lab source <run> <dir|url|domain>                         allow it an origin of sources (only the assisted researcher)',
  'lab stop <run>                                            stop it before its next question to System 2',
  'lab resume <run> [--max-tokens N] [--max-minutes N]       resume it as a run derived from it',
  'lab finding <run> [--view researcher]                     its finding (the operator\'s view by default)',
  'lab anomaly <run> [<report> bug|world|unclear [note]]     its reports of the instrument and their state; or the operator\'s verdict on one',
  '',
  'The orchestra (SPEC-ORQUESTADOR):',
  'lab agent <run> [--id coach] [--max-orders N]             an agent operator follows the run (it needs --agents coach=message on the run)',
  '          [--role senior] [--patience N]                   a senior: when the run is stuck, it reviews the junior record and proposes a hypothesis',
  'lab grade <run> [--senior [id]]                          grade a finished run again (operator only), with GRADER_LLM_* (default LLM_*); --senior: its senior\'s own notebook',
  'lab audit <run> [--flat] [--extract]                      audit its method (operator only): links, citations, controls; J1-J6 by the Judge (JEV_*), or code only with --flat;',
  '                                                           --extract: each text\'s claims structured by AUDIT_LLM_* (default LLM_*), the facts among them checked',
  'lab audit sample <run>[,<run>] [--n 30] [--seed N] [--with <ids>]  a blind sample of what the Judge judged in audited runs, and a page to label it',
  'lab audit agreement <labels.json>                        the agreement of the operator\'s labels with the Judge, per question (kappa, confusion)',
  'lab pack <run> [--out dir]                                a research package of it: its record, its blobs, a report of its results each by its name, a manifest of hashes',
  'lab verify <package> [--llm-path /v1/...]                 check a package: its integrity, its history rebuilt offline from its record; what was not done, said (verification.json)',
  'lab model revise <run> [--use "<context>"] [--criteria "<criteria>"]   a revision of its validation report, closed: its evidence copied by content (runs/models/evidence)',
  'lab model show <run>                                      its revisions (each opened, its copies hashed again), its approvals, its state',
  'lab model approve <run> --revision <id> --by "<person>" --conclusion approved|approved_with_limitations|rejected [--note "..."]',
  '                                                           a person\'s conclusion on one revision, in a file of its own; refused if its evidence does not hold',
  'lab model register <run> --owner "<person>" [--use ..] [--criteria ..] [--influence|--consequence low|medium|high] [--criticality ..] [--review-days N]',
  '                                                           the model of a run in the inventory (runs/models/inventory.json), its execution dependencies as they are now',
  'lab model independence <run> --by "<person>" --validator "<who>" [--reports-to ..] [--separate yes|no] [--can-challenge yes|no]',
  '                                                           a person declares the organisational independence of its validation (the harness never computes it)',
  'lab model characterize <batch.json> [...]                 the generating configurations of the runs of batches: rates with their 95% intervals, cost, failure modes (§8.2)',
  'lab model reevaluate <id> [--places N]                    its model frozen, its dependencies as inventoried, checked on new places of its family (§9)',
  'lab model list | check [<id>] | retire <id> --by "<person>"   the inventory; what changed since (dependencies, instrument, context, date, verdicts) and each state with its cause',
  'lab batch <batch.json>                                    run (or resume) a batch of runs and compare them by condition',
  'lab batch results <runs/batches/<id>/batch.json>           its results apart (O1-O4) and their cost by group of comparable runs, with their uncertainty, computed again',
  'lab control <batch.json> [...] --condition C [--metric M] [--min-subgroups 20]   a control chart of a group across batches, only if its assumptions hold; signals are indications to investigate',
  'lab reference freeze <batch.json> --condition C --name N --by "<person>" [--supersedes OLD]   a group\'s distribution frozen with its runs\' hash (runs/references)',
  'lab reference show <name>                                 a reference, and whether it holds; a batch compares itself with one as its definition declares ("compare")',
  'lab team <team.json>                                      run (or resume) a team on worlds of one family, with or without a board (SPEC-INVESTIGACION-PARALELA)',
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
  /* The runs of runs/, and of its batches and teams (runs/batches/<batch>/<run>): a batch's run is named by its own name,
     or <batch>/<run> when several batches have one of that name. */
  const runs = [...listRuns(path.join(root, 'runs')), ...['batches', 'teams'].flatMap((d) => {
    const dir = path.join(root, 'runs', d);
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((b) => fs.statSync(path.join(dir, b)).isDirectory())
      .flatMap((b) => listRuns(path.join(dir, b)).map((r) => ({ ...r, run: b + '/' + r.run, short: r.run }))) : [];
  })].sort((a, b) => (b.started ?? '').localeCompare(a.started ?? '')) as (RunInfo & { short?: string })[];
  if (name === 'last') { if (!runs.length) throw new Error('there are no runs yet'); return runs[0].journal; }
  const byShort = runs.filter((r) => r.short === name || r.short + '.json' === name);
  if (byShort.length === 1) return byShort[0].journal;
  if (byShort.length > 1) throw new Error('several batches have a run named ' + name + ': ' + byShort.map((r) => r.run).join(', ') + ' - name it <batch>/<run>');
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
    case 'accepted': return at + r + 'accepted' + (e.released_by ? ' (it waited for ' + e.released_by.join(', ') + ': no fault of the instrument)' : '');
    case 'instrument_report': return at + r + 'REPORT OF THE INSTRUMENT ' + e.id + ' by ' + e.by + ' (' + e.kind + '): ' + short(e.what) + ' - lab anomaly <run> ' + e.id + ' bug|world|unclear';
    case 'anomaly_verdict': return at + 'the operator\'s verdict on ' + e.report + ': ' + e.verdict + (e.from_history ? ' (from the run it resumes)' : '');
    case 'anomaly_verdict_refused': return at + 'a verdict refused: ' + e.reason;
    case 'acceptance_void': return at + 'the acceptance of round ' + e.round + ' is void: ' + (e.faults ?? []).join(', ') + ' found a fault of the instrument';
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
    /* A living world (SPEC-ACONTECIMIENTOS-DEL-MUNDO). */
    case 'world_window': return at + r + 'window ' + e.window + ' (ticks ' + e.from + '-' + e.to + ', ' + e.by + ')' + ((e.outcomes ?? []).length ? ': ' + e.outcomes.map((o: { intent: string; outcome: string }) => o.intent + ' ' + o.outcome).join(', ') : '') + (e.timeouts?.length ? '; timed out: ' + e.timeouts.join(', ') : '');
    case 'message_sent': return at + r + (e.refused ? 'a message refused: ' + e.refused : 'wrote to ' + ('actor' in (e.to ?? {}) ? e.to.actor : 'everyone') + ': ' + short(e.text));
    case 'material_shared': return at + r + (e.refused ? 'a share refused: ' + e.refused : 'shared ' + (e.episode ?? e.document));
    case 'messages_delivered': return at + r + 'received ' + (e.messages ?? []).length + ' message(s)' + (e.waiting ? ', ' + e.waiting + ' waiting' : '');
    case 'world_help': return at + r + 'the operator\'s word reached it: ' + short(e.text);
    case 'watcher': return at + r + (e.refused ? 'a watcher refused: ' + e.refused : 'watches ' + e.id + ' (version ' + e.version + ')');
    case 'perturbation_asked': return at + r + 'asked for ' + e.program + (e.refused ? ' (refused: ' + e.refused + ')' : '');
    case 'world_closed': return at + r + 'the world was closed';
    case 'world_diverged': return at + 'DIVERGED from the world it continues, at ' + e.key;
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
      case 'meta': {
        /* The meta-laboratory (SPEC-METAPOLITICA-INVESTIGACION, M2): the corpus, a policy read against a run, trials, a search
           over policies, and their verification - all in runs/meta. */
        const sub = args.shift();
        const env = ctx.env ?? process.env;
        const readJson = (f: string) => JSON.parse(fs.readFileSync(fs.existsSync(path.resolve(f)) ? path.resolve(f) : path.resolve(ctx.root, f), 'utf8'));
        const metaDir = path.join(ctx.root, 'runs', 'meta');
        const { indexCorpus } = await import('../meta/corpus.ts');
        const { Trials, inProcessLauncher, policyEvaluator, verifyTrials, manifestProblems } = await import('../meta/lab.ts');
        const { readPolicyConfig } = await import('../learn/assisted/research-policy.ts');
        const { nodeVmRunner } = await import('./node-vm.ts');
        const policyAt = (f: string) => { const at = fs.existsSync(path.resolve(f)) ? path.resolve(f) : path.resolve(ctx.root, f); return readPolicyConfig(fs.readFileSync(at, 'utf8'), (x) => fs.readFileSync(path.resolve(path.dirname(at), x), 'utf8')); };
        if (sub === 'index') {
          const index = indexCorpus(path.join(ctx.root, 'runs'));
          fs.mkdirSync(metaDir, { recursive: true });
          const file = take(args, 'out') ?? path.join(metaDir, 'corpus.json');
          fs.writeFileSync(file, JSON.stringify(index, null, 2));
          const byWorld: Record<string, number> = {};
          for (const e of index.entries) byWorld[e.world] = (byWorld[e.world] ?? 0) + 1;
          out(index.entries.length + ' runs in ' + Object.keys(index.lineages).length + ' lineages: ' + Object.entries(byWorld).map(([w, n]) => w + ' ' + n).join(', '));
          out('rebuildable ' + index.entries.filter((e) => e.material.rebuild).length + ', with help delivered ' + index.entries.filter((e) => Object.keys(e.help.delivered).length).length);
          out('index ' + file);
          return 0;
        }
        if (sub === 'inspect') {
          const [policyFile, journalFile] = args;
          if (!policyFile || !journalFile) { out('lab meta inspect <policy.json> <journal.json>'); return 2; }
          const { inspectHistory } = await import('../meta/inspect.ts');
          const { JevJudge } = await import('../core/jev.ts');
          const { labEndpointsFromEnv } = await import('../orchestra/launch.ts');
          const judge = labEndpointsFromEnv(env).judge;
          const r = await inspectHistory(policyAt(policyFile), readJson(journalFile), new JevJudge({ ...(judge?.url ? { url: judge.url } : {}), ...(judge?.key ? { apiKey: judge.key } : {}), ...(judge?.model ? { model: judge.model } : {}) }), nodeVmRunner({ timeoutMs: 2000 }));
          for (const d of r.decisions) out('cut ' + d.cut + (d.round !== null ? ' (round ' + d.round + ')' : '') + ': ' + (d.failure ? d.failure + ' - ' + d.why : JSON.stringify(d.guidance)));
          out(r.reading);
          return 0;
        }
        if (sub === 'trials' || sub === 'search' || sub === 'verify') {
          const [manifestFile, policyFile] = args;
          if (!manifestFile || (sub !== 'verify' && !policyFile)) { out('lab meta ' + sub + ' <meta-lab.json>' + (sub === 'verify' ? '' : ' <policy.json>') + (sub === 'search' ? ' [--evaluations N] [--attempts N] [--tokens N]' : sub === 'trials' ? ' [--partition development|confirmation]' : '')); return 2; }
          const manifest = readJson(manifestFile);
          const problems = manifestProblems(manifest);
          if (problems.length) { out('the manifest is refused, nothing was run:'); for (const e of problems) out('  ' + e); return 2; }
          const dir = path.join(metaDir, manifest.id);
          if (sub === 'verify') {
            const v = await verifyTrials(dir, manifest, nodeVmRunner({ timeoutMs: 2000 }));
            out((v.holds ? 'holds' : 'DOES NOT HOLD') + ': ' + v.trials + ' trials, ' + v.decisions + ' decisions of their policies rebuilt with no Judge, ' + v.searches + ' searches rebuilt with no model nor measure');
            for (const p of v.problems) out('  ' + p);
            return v.holds ? 0 : 1;
          }
          /* The fund for trials (§11): every launch reserved from it before it is dispatched and settled after - in all, for the
             trials of this meta-laboratory. A search must be given one: its tokens limit only its mutator. */
          const fundGiven = take(args, 'trial-tokens');
          const fund = fundGiven !== undefined ? Number(fundGiven) : undefined;
          if (fund !== undefined && !(fund > 0)) { out('--trial-tokens: the tokens its trials may spend in all, a number above 0'); return 2; }
          if (sub === 'search' && fund === undefined) { out('lab meta search needs --trial-tokens N: the tokens its trials may spend in all (its --tokens limit only its mutator)'); return 2; }
          /* And the calls of the Judge its trials may make in all, reserved the same way. */
          const judgeGiven = take(args, 'trial-judge-calls');
          const judgeFund = judgeGiven !== undefined ? Number(judgeGiven) : undefined;
          if (judgeFund !== undefined && !(judgeFund > 0)) { out('--trial-judge-calls: the calls of the Judge its trials may make in all, a number above 0'); return 2; }
          if (sub === 'search' && judgeFund === undefined) { out('lab meta search needs --trial-judge-calls N: the calls of the Judge its trials may make in all'); return 2; }
          const { labEndpointsFromEnv, chatFromEnv } = await import('../orchestra/launch.ts');
          const ends = labEndpointsFromEnv(env);
          const trials = new Trials(dir, manifest, inProcessLauncher({ root: dir, llm: ends.llm, ...(ends.judge ? { judge: ends.judge } : {}) }), { ...(fund !== undefined ? { fund } : {}), ...(judgeFund !== undefined ? { judgeFund } : {}) });
          const config = policyAt(policyFile);
          if (sub === 'trials') {
            const partition = (take(args, 'partition') ?? 'development') as 'development' | 'confirmation';
            const ran = await trials.run(config.policy, partition);
            for (const t of ran) out(t.case + '#' + t.rep + ' ' + t.result.state + (t.result.solved !== null ? (t.result.solved ? ' solved' : ' not solved') : '') + ', ' + t.result.advice + ' advice' + (t.result.policy_errors ? ', ' + t.result.policy_errors + ' policy errors' : '') + (t.result.why ? ' (' + t.result.why + ')' : ''));
            out('trials have spent or hold ' + trials.spent() + ' tokens' + (fund !== undefined ? ' of ' + fund : '') + ' and ' + trials.spent(undefined, 'judge_calls') + ' calls of the Judge' + (judgeFund !== undefined ? ' of ' + judgeFund : ''));
            return 0;
          }
          const { runSearch } = await import('../learn/evolve/engine.ts');
          const { balanced } = await import('../learn/evolve/policy.ts');
          const { chatMutator } = await import('../learn/evolve/mutator.ts');
          const n = (k: string, d: number) => Math.max(1, Math.floor(Number(take(args, k) ?? d)) || d);
          /* A search never overwrites another: a record of its own each time, or the one it resumes read and continued into a
             new one. */
          const resumeGiven = take(args, 'resume');
          const searches = path.join(dir, 'searches');
          fs.mkdirSync(searches, { recursive: true });
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const resumeFile = resumeGiven ? (fs.existsSync(path.resolve(resumeGiven)) ? path.resolve(resumeGiven) : path.join(searches, resumeGiven)) : null;
          if (resumeFile && !fs.existsSync(resumeFile)) { out('--resume: no search record ' + resumeGiven); return 2; }
          const outFile = path.join(searches, (resumeFile ? path.basename(resumeFile, '.jsonl') + '.resumed-' : 'search-') + stamp + '.jsonl');
          if (fs.existsSync(outFile)) { out('a search is already recorded as ' + outFile + ': nothing is overwritten'); return 2; }
          const recorded = resumeFile ? fs.readFileSync(resumeFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : undefined;
          /* Its evaluations bounded by what the fund can hold: one is every development trial, each reserving its junior's limit. */
          const { trialsPerEvaluation, juniorMaxTokens, juniorMaxJudgeCalls } = await import('../meta/lab.ts');
          const perEvaluation = trialsPerEvaluation(manifest) * juniorMaxTokens(manifest);
          const perEvaluationJudge = trialsPerEvaluation(manifest) * juniorMaxJudgeCalls(manifest);
          const affordable = Math.max(0, Math.min(Math.floor((fund! - trials.spent()) / perEvaluation), Math.floor((judgeFund! - trials.spent(undefined, 'judge_calls')) / perEvaluationJudge)));
          const evaluations = Math.min(n('evaluations', 6), affordable + (recorded ? recorded.filter((e) => e.type === 'evaluation').length : 0));
          if (evaluations < 1) { out('the fund for trials (' + fund + ' tokens, ' + trials.spent() + ' spent or held; ' + judgeFund + ' calls of the Judge, ' + trials.spent(undefined, 'judge_calls') + ' made or held) cannot hold one evaluation (' + perEvaluation + ' tokens and ' + perEvaluationJudge + ' calls reserved): nothing was run'); return 2; }
          const controller = new AbortController();
          const { manifest: sealed } = await runSearch({ evaluator: policyEvaluator(trials, config.policy, { signal: controller.signal, onUnfunded: () => controller.abort() }),
            mutator: chatMutator(chatFromEnv(env, 'AGENT_LLM')), profile: balanced(0), signal: controller.signal,
            question: 'a research policy that helps this junior solve more of its tasks', limits: { evaluations, attempts: n('attempts', 12), tokens: n('tokens', 400000) },
            out: outFile, ...(recorded ? { recorded, live: true } : {}) });
          const sealedFile = outFile.replace(/\.jsonl$/, '.manifest.json');
          fs.writeFileSync(sealedFile, JSON.stringify(sealed, null, 2));
          out('search ' + sealed.stoppedBy + ': ' + sealed.cost.evaluations + ' evaluations; its mutator ' + sealed.cost.tokens + ' tokens; its trials ' + trials.spent() + ' tokens of the fund ' + fund + ' and ' + trials.spent(undefined, 'judge_calls') + ' calls of the Judge of ' + judgeFund + '; ' + sealedFile);
          return 0;
        }
        out('lab meta index | inspect <policy> <journal> | trials <meta-lab.json> <policy> [--trial-tokens N] [--trial-judge-calls N] | search <meta-lab.json> <policy> --trial-tokens N --trial-judge-calls N [--resume FILE] | verify <meta-lab.json>');
        return 2;
      }
      case 'live': {
        /* A shared session continued from its record: a session of its own beside it, more rounds where they ran out. */
        const resumeGiven = take(args, 'resume');
        if (resumeGiven) {
          const sessionFile = fs.existsSync(path.resolve(resumeGiven)) ? path.resolve(resumeGiven) : path.resolve(ctx.root, resumeGiven);
          if (!/\.session\.json$/.test(sessionFile) || !fs.existsSync(sessionFile)) { out('lab live --resume <x.session.json> [--more-rounds N]'); return 2; }
          const more = Number(take(args, 'more-rounds') ?? 0);
          const dir = path.dirname(sessionFile) + '.continued-' + new Date().toISOString().replace(/[:.]/g, '-');
          const { pid } = continueSessionAt(dir, 'session', sessionFile, more, ctx.env);
          out('the session goes on (pid ' + pid + ') in ' + dir + (more > 0 ? ', ' + more + ' more rounds where they ran out' : ''));
          return 0;
        }
        const file = args.shift();
        if (!file) { out('lab live <manifest.json>'); return 2; }
        let raw: unknown;
        /* Where it is said to be: from here, or from the repository. */
        const where = fs.existsSync(path.resolve(file)) ? path.resolve(file) : path.resolve(ctx.root, file);
        try { raw = JSON.parse(fs.readFileSync(where, 'utf8')); } catch (e) { out('cannot read the manifest ' + file + ': ' + String((e as Error).message ?? e)); return 2; }
        const m = readManifest(raw, LABS);
        if ('errors' in m) { out('the manifest is refused, nothing was started:'); for (const e of m.errors) out('  ' + e); return 2; }
        if (m.args) {
          const { journal, pid } = startRun(m.lab, { root: ctx.root, args: [...m.args, ...args], ...(ctx.env ? { env: ctx.env } : {}) });
          out('started ' + path.basename(journal, '.json') + ' (pid ' + pid + '), a living world: ' + m.lab + ', its researcher ' + m.actor);
          out('journal ' + journal);
          out('follow it: lab watch ' + path.basename(journal, '.json'));
          return 0;
        }
        /* Several members: a shared session, its researchers' runs and its journal in a folder of their own. */
        const name = m.lab + '-s' + m.plan.seed + '-' + new Date().toISOString().replace(/[:.]/g, '-');
        const dir = path.join(ctx.root, 'runs', name);
        const { pid } = startSessionAt(dir, 'session', where, ctx.env);
        out('started a shared session of ' + m.lab + ' (pid ' + pid + '): ' + m.plan.actors.map((a) => a.id + ' (' + a.kind + ')').join(', '));
        out('folder ' + dir + ': the run of each researcher is session.<id>.json, the world session.world.jsonl');
        return 0;
      }
      case 'junior': {
        /* The junior packaged and served (SPEC-METAPOLITICA-APRENDIZAJE MA1): its blobs, its package, a session verified from
           its ledger, the machine checked, the driver's resources measured. The server and the proxy are scripts of their own. */
        const usage = 'lab junior store <dir|file> --blobs <dir> | package <manifest.json> --blobs <dir> [--export <dir>] | verify <session.jsonl> --blobs <dir> [--python P --backend fake|qwenputer --firmware F --tokenizer T] | check <machine-check.json> | probe <manifest.json> --blobs <dir> --python P [--backend B] --lengths 1024,4096 --work <dir> | cut <run.json> <question> | manifest <competence.json> | evaluate <competence.json> <package.json> --blobs <dir> --server <url> --dir <dir> [--partition development|confirmation] | promote <competence.json> <reference-evaluation.json> <candidate-evaluation.json>';
        const sub = args.shift();
        const file = (f: string) => fs.existsSync(path.resolve(f)) ? path.resolve(f) : path.resolve(ctx.root, f);
        const J = await import('../junior/package.ts');
        const blobsDir = take(args, 'blobs');
        if (sub === 'check') {
          const f = args.shift();
          if (!f) { out(usage); return 2; }
          const { checkMachine } = await import('../junior/setup.ts');
          const r = await checkMachine(JSON.parse(fs.readFileSync(file(f), 'utf8')), ctx.env ? { env: ctx.env } : {});
          for (const x of r.results) out((x.ok ? 'ok   ' : 'FAIL ') + x.id + ': ' + x.detail);
          for (const p of r.uncovered) out('FAIL ' + p + ': no check covers it');
          out(r.ok ? 'the machine is ready' : 'the machine is NOT ready: no investigation starts on it');
          return r.ok ? 0 : 1;
        }
        if (sub === 'cut') {
          const run = args.shift(), q = Number(args.shift());
          if (!run || !Number.isInteger(q) || q < 0) { out(usage); return 2; }
          const { captureCut } = await import('../junior/probes.ts');
          const cut = await captureCut(file(run), q);
          out('cut ' + cut.hash);
          out('lab ' + cut.lab + ', question ' + q + ', ' + cut.events_before + ' events before it, ' + cut.content.user.parts.length + ' user parts');
          return 0;
        }
        if (sub === 'manifest' || sub === 'promote') {
          const f = args.shift();
          if (!f) { out(usage); return 2; }
          const { prepareManifest, promoteEvaluations } = await import('../junior/evaluate.ts');
          const prepared = await prepareManifest(JSON.parse(fs.readFileSync(file(f), 'utf8')));
          if (prepared.problems.length) { out('the manifest is refused, nothing runs:'); for (const p of prepared.problems) out('  ' + p); return 2; }
          if (sub === 'manifest') { out('manifest ' + prepared.hash + ': valid, every cut taken again as declared'); return 0; }
          const [refFile, candFile] = [args.shift(), args.shift()];
          if (!refFile || !candFile) { out(usage); return 2; }
          const p = promoteEvaluations(prepared.manifest, prepared.hash, JSON.parse(fs.readFileSync(file(refFile), 'utf8')), JSON.parse(fs.readFileSync(file(candFile), 'utf8')));
          out(p.verdict + ': ' + p.why);
          for (const c of p.components) out('  ' + c.id + ': mean delta ' + (c.mean_delta ?? 0).toFixed(4) + ', p ' + (c.p ?? 1).toFixed(4) + (c.improves ? ', improves' : '') + (c.regresses ? ', REGRESSES' : ''));
          return 0;
        }
        if (!blobsDir) { out(usage); return 2; }
        const store = new J.BlobStore(file(blobsDir));
        if (sub === 'evaluate') {
          const [mf, pf] = [args.shift(), args.shift()];
          const server = take(args, 'server'), dir = take(args, 'dir'), partition = (take(args, 'partition') ?? 'development') as 'development' | 'confirmation';
          if (!mf || !pf || !server || !dir) { out(usage); return 2; }
          const { prepareManifest, evaluate } = await import('../junior/evaluate.ts');
          const prepared = await prepareManifest(JSON.parse(fs.readFileSync(file(mf), 'utf8')));
          if (prepared.problems.length) { out('the manifest is refused, nothing runs:'); for (const p of prepared.problems) out('  ' + p); return 2; }
          const pkg = J.normalizePackage(JSON.parse(fs.readFileSync(file(pf), 'utf8')));
          if (!J.checkClosed(pkg, store).closed) { out('the package is not closed in the store: nothing runs'); return 1; }
          const { inProcessLauncher } = await import('../meta/lab.ts');
          const { JuniorSessionClient } = await import('../junior/client.ts');
          const { labEndpointsFromEnv } = await import('../orchestra/launch.ts');
          const ends = labEndpointsFromEnv(ctx.env ?? process.env);
          const e = await evaluate({ dir: path.resolve(dir), manifest: prepared.manifest, manifestHash: prepared.hash, pkg, client: new JuniorSessionClient(server), partition,
            launcher: inProcessLauncher({ root: path.resolve(dir), llm: { url: '', model: undefined }, ...(ends.judge ? { judge: ends.judge } : {}) }), ...(ends.judge ? { judge: ends.judge } : {}) });
          out('junior ' + e.execution + ' on ' + partition + ': ' + (e.measure.complete ? 'complete' : 'INCOMPLETE'));
          for (const c of e.measure.components) out('  ' + c.id + ': ' + (c.quality === null ? 'no quality (' + c.missing.slice(0, 3).join('; ') + ')' : 'deficit ' + c.quality.toFixed(4)));
          return e.measure.complete ? 0 : 1;
        }
        if (sub === 'store') {
          const f = args.shift();
          if (!f) { out(usage); return 2; }
          const p = file(f);
          out((fs.statSync(p).isDirectory() ? 'tree ' + store.putTree(p) : 'blob ' + store.putFile(p)));
          return 0;
        }
        const f = args.shift();
        if (!f) { out(usage); return 2; }
        if (sub === 'package' || sub === 'probe') {
          let pkg;
          try { pkg = J.normalizePackage(JSON.parse(fs.readFileSync(file(f), 'utf8'))); } catch (e) { out('the package is refused: ' + (e as Error).message); return 2; }
          const execution = J.executionHash(pkg);
          const closed = J.checkClosed(pkg, store);
          if (sub === 'package') {
            out('execution ' + execution);
            out('edition   ' + J.editionHash(pkg));
            for (const m of closed.missing) out('missing ' + m);
            for (const c of closed.corrupt) out('corrupt ' + c);
            out(closed.closed ? 'closed: every blob is in the store with its bytes' : 'NOT closed: it cannot be served nor called reconstructible');
            const exp = take(args, 'export');
            if (exp && closed.closed) out('exported ' + J.exportPackage(pkg, store, path.resolve(exp)).blobs + ' blobs to ' + path.resolve(exp));
            return closed.closed ? 0 : 1;
          }
          if (!closed.closed) { out('the package is not closed: nothing to measure'); return 1; }
          const { ProcessWorker } = await import('../junior/worker.ts');
          const python = take(args, 'python') ?? 'python', work = take(args, 'work'), lengths = (take(args, 'lengths') ?? '').split(',').map(Number).filter((n) => n > 0);
          if (!work || !lengths.length) { out(usage); return 2; }
          const w = new ProcessWorker({ python: [python, '-u'], backend: (take(args, 'backend') ?? 'qwenputer') as 'qwenputer' | 'fake', work: path.resolve(work) });
          try { out(JSON.stringify(await w.probe(pkg, execution, store, lengths), null, 2)); } finally { w.invalidate(); }
          return 0;
        }
        if (sub === 'verify') {
          const { verifySession, processReference } = await import('../junior/verify.ts');
          const { VERIFY_PY } = await import('../junior/worker.ts');
          const python = take(args, 'python'), backend = take(args, 'backend'), firmware = take(args, 'firmware'), tokenizer = take(args, 'tokenizer');
          const reference = python && backend ? processReference([python, VERIFY_PY, '--backend', backend, ...(firmware ? ['--firmware', firmware] : []), ...(tokenizer ? ['--tokenizer', tokenizer] : [])]) : null;
          const r = await verifySession(file(f), store, reference);
          out('session ' + r.session + ': ' + r.receipts + ' receipts, the memory of ' + r.memory_checked + ' rebuilt by the reference');
          for (const p of r.problems) out('  ' + p);
          out(r.ok ? 'verified' : 'NOT verified');
          return r.ok ? 0 : 1;
        }
        out(usage);
        return 2;
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
      case 'world': {
        /* The operator's control of a living world (SPEC-ACONTECIMIENTOS-DEL-MUNDO §10, §16): its programs; pausing, resuming,
           closing it; its members joining and leaving; the operator's word to a member or to all (help, where it is
           received) and what it pins before one; its status. A run's, or a shared session's (`<folder>` or `<x>.session.json`). */
        const OPS = ['add', 'replace', 'disable', 'fire', 'pause', 'resume', 'close', 'join', 'retire', 'say', 'pin', 'promote', 'status'];
        const usage = 'lab world <run|session> add|replace <program.json> | disable|fire <program> | pause | resume | close | join <actor.json> | retire <member> | say <member|global> <text> | pin <member> <key> <text> | promote <branch member> [budget] | status';
        const target = String(args[0] ?? ''), op = String(args[1] ?? '');
        if (!target || !OPS.includes(op)) { out(usage); return 2; }
        const given = fs.existsSync(path.resolve(target)) ? path.resolve(target) : path.resolve(ctx.root, target);
        const sessionFile = /\.session\.json$/.test(given) ? given : fs.existsSync(given) && fs.statSync(given).isDirectory()
          ? fs.readdirSync(given).filter((f) => f.endsWith('.session.json')).map((f) => path.join(given, f))[0] ?? null : null;
        const sessionLive = !sessionFile && fs.existsSync(given) && fs.statSync(given).isDirectory() ? given : null;
        const readFile = (f: string) => { try { return JSON.parse(fs.readFileSync(path.resolve(f), 'utf8')); } catch (e) { throw new LabError('cannot read ' + f + ': ' + String((e as Error).message ?? e)); } };
        const rest = args.slice(2);
        const order: Record<string, unknown> = { kind: 'world', op, by: 'operator',
          ...(op === 'add' || op === 'replace' ? { program: readFile(rest[0] ?? '') } : {}), ...(op === 'disable' || op === 'fire' || op === 'retire' || op === 'promote' ? { target: rest[0] } : {}),
          ...(op === 'promote' && rest[1] ? { budget: Number(rest[1]) } : {}),
          ...(op === 'join' ? { actor: readFile(rest[0] ?? '') } : {}), ...(op === 'say' ? { to: rest[0], text: rest.slice(1).join(' ') } : {}),
          ...(op === 'pin' ? { to: rest[0], key: rest[1], text: rest.slice(2).join(' ') } : {}) };
        /* A shared session: its folder holds its inbox, its status beside its world's journal. */
        const folder = sessionFile ? path.dirname(sessionFile) : sessionLive;
        if (folder) {
          const name = sessionFile ? path.basename(sessionFile).replace(/\.session\.json$/, '') : 'session';
          if (op === 'status') { const st = path.join(folder, name + '.world.status.json'); out(fs.existsSync(st) ? fs.readFileSync(st, 'utf8') : 'no status yet: ' + st); return 0; }
          if (sessionFile && readFile(sessionFile).state !== 'running') { out('the session has ended: it reads no orders'); return 1; }
          const id = 'order-' + Date.now().toString(36);
          fs.appendFileSync(path.join(folder, name + '.inbox.jsonl'), JSON.stringify({ id, ...order, kind: undefined }) + '\n');
          out('world ' + op + ' sent to the session (' + id + '); what came of it: ' + path.join(folder, name + '.orders.jsonl'));
          return 0;
        }
        const journal = resolveRun(ctx.root, target);
        if (op === 'status') { const st = journal.replace(/\.json$/, '') + '.world.status.json'; out(fs.existsSync(st) ? fs.readFileSync(st, 'utf8') : 'no living world, or no status yet'); return 0; }
        const state = runStatus(journal).state;
        if (state === 'ended' || state === 'interrupted') { out('the run is ' + state + ': it reads no orders'); return 1; }
        const { id } = send(journal, order as RunOrder);
        const outcome = await acknowledged(journal, id, ctx);
        out('world ' + op + ' ' + outcome);
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
      case 'anomaly': {
        /* SPEC-CALIBRACION-INSTRUMENTOS §5.2: the reports of the instrument, and the operator's verdict on one - written next
           to the journal; a run that goes takes it before its next question (and with its heartbeat). */
        const journal = resolveRun(ctx.root, args[0]);
        const [report, verdict, ...note] = args.slice(1);
        const states = runAnomalies(journal);
        if (!report) {
          if (!states.length) out('no reports of the instrument in ' + path.basename(journal, '.json'));
          for (const r of states) out(r.id + ' [' + r.state + '] by ' + r.by + (r.round !== undefined ? ', round ' + r.round : '') + ' (' + r.kind + '): ' + r.what
            + (r.evidence.length ? ' - evidence ' + r.evidence.join(', ') : '') + (r.text ? ' - note: ' + r.text : ''));
          return 0;
        }
        if (!(VERDICTS as readonly string[]).includes(String(verdict))) { out('lab anomaly <run> <report> ' + VERDICTS.join('|') + ' [note]'); return 2; }
        if (!states.some((r) => r.id === report)) { out('no report ' + report + ' in this run' + (states.length ? ' (its reports: ' + states.map((r) => r.id).join(', ') + ')' : '')); return 1; }
        writeVerdict(journal, { report, verdict: verdict as Verdict, ...(note.length ? { text: note.join(' ') } : {}) });
        const s = runStatus(journal).state;
        out(report + ': ' + verdict + (s === 'running' || s === 'stopping' ? ' - the run takes it before its next question' : ' - kept next to the run (it is ' + s + '): its finding and the console read it'
          + (s === 'interrupted' ? '; a resumed run applies it from the start' : '')));
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
        const { regrade, gradeSenior } = await import('./regrade.ts');
        const model = endpointsFromEnv(env, 'GRADER_LLM').model ?? '';
        /* --senior [id]: what the run's senior understood, from its own notebook (SPEC-ORQUESTADOR §3.3.1). */
        const s = args.indexOf('--senior');
        if (s >= 0) {
          const id = args[s + 1] && !args[s + 1].startsWith('--') ? args[s + 1] : 'senior';
          const { agentFile } = await import('../orchestra/agent-operator.ts');
          const g = await gradeSenior(journal, agentFile(journal, id), chatFromEnv(env, 'GRADER_LLM'), model);
          if (g.score === null) { out('the grading failed: ' + String(g.event.error)); return 1; }
          out('the senior\'s recovery ' + g.score + ' (graded by ' + model + '): ' + (g.event.grades as { id: string; grade: string }[]).map((x) => x.id + ':' + x.grade).join(' '));
          out('appended to ' + path.basename(agentFile(journal, id)));
          return 0;
        }
        const r = await regrade(journal, chatFromEnv(env, 'GRADER_LLM'), model);
        if (r.score === null) { out('the grading failed: ' + String(r.event.error)); return 1; }
        out('rule recovery ' + r.score + ' (graded by ' + model + '): ' + (r.event.grades as { id: string; grade: string }[]).map((g) => g.id + ':' + g.grade).join(' '));
        out('appended to ' + path.basename(journal) + '; findings written again');
        return 0;
      }
      case 'model': {
        const sub = args.shift();
        const evidenceDir = path.join(ctx.root, 'runs', 'models', 'evidence');
        /* The inventory (M3): its models, their dependencies and their state. */
        if (sub === 'characterize') {
          if (!args.length) { out('lab model characterize <batch.json> [<batch.json> ...]'); return 2; }
          const { characterize } = await import('./generators.ts');
          for (const g of characterize(ctx.root, args.map((a) => path.resolve(a)))) out(g.id + ': ' + g.runs + ' runs -> ' + path.relative(ctx.root, g.file));
          return 0;
        }
        if (sub === 'reevaluate') {
          const inv = await import('./inventory.ts');
          const id = args.shift(), places = take(args, 'places');
          if (!id) { out('lab model reevaluate <id> [--places N]'); return 2; }
          const env = ctx.env ?? process.env;
          const { JEV_DEFAULT_URL } = await import('../core/jev.ts');
          const r = await inv.reevaluateModel(ctx.root, id, { evidenceDir, ...(Number(places) > 0 ? { places: Number(places) } : {}),
            ...(env.JEV_KEY ? { judge: { url: env.JEV_URL || JEV_DEFAULT_URL, key: env.JEV_KEY, ...(env.JEV_MODEL ? { model: env.JEV_MODEL } : {}) } } : {}) });
          const said = (x: { holds_in: number; places: number } | undefined, what: string) => (x ? what + ' holds in ' + x.holds_in + ' of ' + x.places + ' new places' : '');
          out([said(r.reevaluation.model, 'its model'), said(r.reevaluation.artifact, 'its artifact')].filter(Boolean).join('; ') + ' -> ' + r.entry.status);
          return r.entry.status === 'revalidate' ? 1 : 0;
        }
        if (sub === 'list' || sub === 'check' || sub === 'retire') {
          const inv = await import('./inventory.ts');
          const line = (m: import('./inventory.ts').InventoryEntry) => m.id + '  ' + m.status.padEnd(26) + m.experiment + '  ' + m.run + '  owner ' + m.owner + '  use: ' + m.use_context;
          if (sub === 'list') {
            const models = inv.readInventory(ctx.root).models;
            if (!models.length) out('no model in the inventory (lab model register <run> --owner "<person>" --use "<context>")');
            for (const m of models) out(line(m));
            return 0;
          }
          if (sub === 'retire') {
            const id = args.shift(), by = take(args, 'by'), note = take(args, 'note');
            if (!id || !by) { out('lab model retire <id> --by "<person>" [--note "..."]'); return 2; }
            out(line(inv.retireModel(ctx.root, id, by, note ?? '')));
            return 0;
          }
          const results = await inv.checkModels(ctx.root, { evidenceDir, ...(args[0] ? { id: args[0] } : {}) });
          for (const r of results) out(line(r.entry) + (r.changed ? '  (changed)' : '') + (r.causes.length ? '\n    ' + r.causes.join('\n    ') : ''));
          return results.some((r) => r.entry.status === 'revalidate') ? 1 : 0;
        }
        const journal = resolveRun(ctx.root, args.shift());
        if (sub === 'register') {
          const inv = await import('./inventory.ts');
          const owner = take(args, 'owner'), id = take(args, 'id'), use = take(args, 'use'), criteria = take(args, 'criteria'), influence = take(args, 'influence'),
            consequence = take(args, 'consequence'), criticality = take(args, 'criticality'), days = take(args, 'review-days');
          if (!owner) { out('lab model register <run> --owner "<person>" [--use "..."] [--criteria "..."] [--influence low|medium|high] [--consequence low|medium|high] [--criticality "..."] [--review-days N] [--id ID]'); return 2; }
          const m = await inv.registerModel(ctx.root, journal, { owner, evidenceDir, ...(id ? { id } : {}), ...(use ? { use } : {}), ...(criteria ? { criteria } : {}), ...(influence ? { influence } : {}),
            ...(consequence ? { consequence } : {}), ...(criticality ? { criticality } : {}), ...(Number(days) > 0 ? { reviewDays: Number(days) } : {}) });
          out(m.id + ' registered: ' + m.status + '; its execution dependencies as they are now: ' + JSON.stringify(Object.fromEntries(Object.entries(m.layers.execution_dependencies).filter(([k]) => !k.endsWith('_facts')))));
          return 0;
        }
        const v = await import('./validation.ts');
        if (sub === 'independence') {
          const by = take(args, 'by'), validator = take(args, 'validator'), reportsTo = take(args, 'reports-to'), separate = take(args, 'separate'), canChallenge = take(args, 'can-challenge'), note = take(args, 'note');
          if (!by || !validator) { out('lab model independence <run> --by "<person>" --validator "<who validated it>" [--reports-to "..."] [--separate yes|no] [--can-challenge yes|no] [--note "..."]'); return 2; }
          v.declareIndependence(journal, { by, validator, ...(reportsTo ? { reportsTo } : {}), ...(separate ? { separate } : {}), ...(canChallenge ? { canChallenge } : {}), ...(note ? { note } : {}) });
          out('declared; it goes into its next revision (lab model revise)');
          return 0;
        }
        if (sub === 'revise') {
          const use = take(args, 'use'), criteria = take(args, 'criteria');
          const r = await v.reviseRun(journal, { evidenceDir, ...(use ? { use } : {}), ...(criteria ? { criteria } : {}) });
          out((r.created ? 'revision ' : 'unchanged: the latest revision is ') + r.revision.slice(0, 16) + ' (proposed, as a draft: ' + r.report.proposed_conclusion.conclusion + ')');
          if (r.comparison) out(r.comparison.contradicts ? 'it contradicts the approved revision ' + r.comparison.approved.slice(0, 16) + ': the approval is suspended (revalidate) - '
            + [...r.comparison.no_longer_met.map((k) => k + ' no longer holds'), ...r.comparison.new_limitations.map((l) => 'new: ' + l)].join('; ')
            : 'it contradicts nothing of the approved revision ' + r.comparison.approved.slice(0, 16) + ': the approval stands');
          return 0;
        }
        if (sub === 'show') {
          const s = v.validationState(journal, evidenceDir);
          out('state: ' + s.status + (s.approval ? ' (signed by ' + s.approval.by + ' on ' + s.approval.revision.slice(0, 16) + ', ' + s.approval.at + ')' : '') + (s.note ? ' - ' + s.note : ''));
          for (const r of s.revisions) out('  revision ' + r.revision.slice(0, 16) + ': ' + (r.integrity.holds ? 'its evidence holds' : 'INTEGRITY ERROR - ' + r.integrity.problems.join('; ')));
          return s.revisions.every((r) => r.integrity.holds) ? 0 : 1;
        }
        if (sub === 'approve') {
          const revision = take(args, 'revision'), by = take(args, 'by'), conclusion = take(args, 'conclusion'), note = take(args, 'note');
          if (!revision || !by || !conclusion) { out('lab model approve <run> --revision <id> --by "<person>" --conclusion ' + v.CONCLUSIONS.join('|') + ' [--note "..."]'); return 2; }
          const a = v.approveRevision(journal, revision, { by, conclusion, ...(note ? { note } : {}), evidenceDir });
          out(a.conclusion + ', by ' + a.by + ', on revision ' + a.revision.slice(0, 16));
          return 0;
        }
        out('lab model revise|show|approve|register|independence <run> ... | list | check [<id>] | retire <id>');
        return 2;
      }
      case 'pack': {
        /* A shared living world's session: the whole of it, by its record. */
        if (/\.session\.json$/.test(String(args[0] ?? ''))) {
          const { packSession } = await import('./package.ts');
          const outDir = take(args.slice(1), 'out') ?? take(args, 'out');
          const given = String(args[0]);
          const { dir, manifest } = packSession(fs.existsSync(path.resolve(given)) ? path.resolve(given) : path.resolve(ctx.root, given), outDir ? path.resolve(outDir) : undefined);
          out('packed the session ' + manifest.session + ': ' + manifest.files.length + ' files into ' + dir);
          return 0;
        }
        const journal = resolveRun(ctx.root, args.shift());
        const { packRun } = await import('./package.ts');
        const outDir = take(args, 'out');
        const { dir, manifest } = packRun(journal, outDir ? path.resolve(outDir) : undefined);
        out('packed ' + manifest.files.length + ' files into ' + dir + (manifest.missing_blobs.length ? '; ' + manifest.missing_blobs.length + ' cited blobs not found' : '')
          + (manifest.corrupt_blobs.length ? '; ' + manifest.corrupt_blobs.length + ' cited blobs whose content is not the one they name, left out' : '')
          + (manifest.missing_blobs.length || manifest.corrupt_blobs.length ? ': the package is not whole' : ''));
        return manifest.missing_blobs.length || manifest.corrupt_blobs.length ? 1 : 0;
      }
      case 'verify': {
        const dir = path.resolve(args[0] ?? '');
        if (!fs.existsSync(path.join(dir, 'manifest.json'))) { out('not a package (no manifest.json): ' + dir); return 1; }
        if (JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).format === 'session_package@1') {
          const { verifySessionPackage } = await import('./package.ts');
          const v = await verifySessionPackage(dir) as Record<string, any>;
          fs.writeFileSync(path.join(dir, 'verification.json'), JSON.stringify(v, null, 2));
          out('integrity: ' + (v.integrity.holds ? 'holds' : 'does NOT hold'));
          out('its world\u2019s journal: ' + (v.world_record.holds ? 'holds' : 'does NOT hold: ' + v.world_record.problems.join('; ')));
          out('the whole session rebuilt offline: ' + (v.reconstruction.holds ? 'holds' : 'does NOT hold'));
          return v.integrity.holds && v.world_record.holds && v.reconstruction.holds ? 0 : 1;
        }
        const { verifyPackage } = await import('./package.ts');
        const llmPath = take(args, 'llm-path');
        const v = await verifyPackage(dir, llmPath ? { llmPath } : {});
        fs.writeFileSync(path.join(dir, 'verification.json'), JSON.stringify(v, null, 2));
        const i = v.integrity, r = v.reconstruction;
        out('integrity: ' + (i.holds ? 'holds' : 'does NOT hold' + (i.changed.length ? '; changed ' + i.changed.join(', ') : '') + (i.missing.length ? '; missing ' + i.missing.join(', ') : '') + (i.unlisted.length ? '; not in its manifest ' + i.unlisted.join(', ') : '') + (i.missing_blobs.length ? '; ' + i.missing_blobs.length + ' blobs never packed' : '')));
        out('reconstruction from its record (offline): ' + (r.holds ? 'holds' : 'does NOT hold') + ' - ' + r.events_compared + ' events compared' + (r.first_difference !== undefined ? ', the first different at ' + r.first_difference : '') + ', stopped by ' + r.stopped_by + (r.requests_refused ? ', ' + r.requests_refused + ' requests it would have made refused' : ''));
        if (v.world) out('its living world: ' + (v.world.holds ? 'holds' : 'does NOT hold') + ' - its journal ' + (v.world.record.holds ? 'holds together' : 'does not: ' + v.world.record.problems.join('; '))
          + ', derived again ' + (v.world.rebuilt.holds ? 'the same' : 'differently'));
        for (const s of v.searches) out('evolutionary search ' + s.file + ': ' + (s.holds ? 'holds' : 'does NOT hold') + ' - ' + s.why);
        out('re-execution: not done; reproduction: not done (verification.json says what each needs)');
        return i.holds && r.holds && (!v.world || v.world.holds) && v.searches.every((s) => s.holds) ? 0 : 1;
      }
      case 'audit': {
        /* Calibration against a person (MA4): a blind sample to label, and the agreement of the labels with the Judge. */
        if (args[0] === 'sample') {
          args.shift();
          const runs = (args.shift() ?? '').split(',').filter(Boolean).map((r) => resolveRun(ctx.root, r));
          const n = Number(take(args, 'n') ?? 30), seed = Number(take(args, 'seed') ?? 1), refs = (take(args, 'with') ?? '').split(',').filter(Boolean);
          const { sample, labelPage } = await import('../audit/calibration.ts');
          const labels = sample(runs, { n, seed, references: refs });
          const outFile = path.resolve(take(args, 'out') ?? path.join(path.dirname(runs[0]), 'labels-' + labels.created.replace(/[:.]/g, '-') + '.json'));
          fs.writeFileSync(outFile, JSON.stringify(labels, null, 2));
          fs.writeFileSync(outFile.replace(/\.json$/, '') + '.html', labelPage(labels));
          const by: Record<string, number> = {};
          for (const i of labels.items) by[i.unit] = (by[i.unit] ?? 0) + 1;
          out(labels.items.length + ' items to label ' + JSON.stringify(by) + (refs.length ? ', ' + labels.items.filter((i) => i.reference).length + ' of them reference cases' : '') + '; the Judge\'s answers are not in it');
          out('label them in ' + path.basename(outFile.replace(/\.json$/, '') + '.html') + ' (open it in a browser; "Descargar etiquetas" saves them), then: lab audit agreement <the labels file>');
          return 0;
        }
        if (args[0] === 'agreement') {
          const file = path.resolve(args[1] ?? '');
          const { agreement } = await import('../audit/calibration.ts');
          const labels = JSON.parse(fs.readFileSync(file, 'utf8'));
          const a = agreement(labels, (run) => resolveRun(ctx.root, run));
          out(a.labelled + ' items labelled' + (a.stale.length ? '; ' + a.stale.length + ' left out: their run was audited again after the sample (' + a.stale.slice(0, 3).join(', ') + ')' : ''));
          for (const q of a.questions) out(q.question + ': n ' + q.n + ', agreement ' + q.agreement + ', kappa ' + q.kappa + ' -> ' + q.reading
            + ' (sure ' + q.when_sure.agreement + ' of ' + q.when_sure.n + ', unsure ' + q.when_unsure.agreement + ' of ' + q.when_unsure.n + ')');
          fs.writeFileSync(file.replace(/\.json$/, '') + '.agreement.json', JSON.stringify(a, null, 2));
          out('written to ' + path.basename(file.replace(/\.json$/, '') + '.agreement.json'));
          return 0;
        }
        const journal = resolveRun(ctx.root, args[0]);
        const env = ctx.env ?? process.env;
        const flat = args.includes('--flat');
        const { auditMethod, auditFile } = await import('../audit/audit.ts');
        const { JevJudge, JEV_DEFAULT_URL } = await import('../core/jev.ts');
        if (!flat && !env.JEV_KEY) { out('the Judge is needed: JEV_KEY (or --flat for what code observes only)'); return 1; }
        const judge = flat ? null : new JevJudge({ url: env.JEV_URL || JEV_DEFAULT_URL, apiKey: env.JEV_KEY, model: env.JEV_MODEL || undefined, timeoutMs: 90000, retries: 4, retryNetwork: true, concurrency: 8 });
        let extractor: { llm: import('../learn/system2.ts').ChatClient; model: string } | null = null;
        if (args.includes('--extract')) {
          const { chatFromEnv, endpointsFromEnv } = await import('../orchestra/launch.ts');
          extractor = { llm: chatFromEnv(env, 'AUDIT_LLM'), model: endpointsFromEnv(env, 'AUDIT_LLM').model ?? '' };
        }
        const a = await auditMethod(journal, judge, extractor);
        const m = a.measures;
        out('links: ' + m.links.experiment + ' experiments, ' + m.links.observation + ' observations, ' + m.links.recall + ' readings of a record');
        out('citations: ' + m.citations.seen + ' seen, ' + m.citations.unseen + ' not seen, ' + m.citations.missing + ' to nothing; refused experiments ' + m.refused_experiments.count + ' (' + m.refused_experiments.cited_after + ' cited after)');
        out('orphan steps ' + m.orphan_steps.count + '; controls ' + m.controls.groups + ' (' + m.controls.used + ' used); beliefs ' + m.beliefs.count + ' (' + m.beliefs.revised + ' revised, ' + m.beliefs.dropped + ' dropped)');
        if (m.judged) out('judged (' + a.judge + ', ' + (a.judged?.calls ?? 0) + ' calls' + (a.judged?.errors.length ? ', ' + a.judged.errors.length + ' failed' : '') + '): complete chains ' + m.judged.complete_chains + '; reading ' + JSON.stringify(m.judged.reading) + '; refutation ' + JSON.stringify(m.judged.refutation));
        if (a.extracted) {
          const c = a.measures.claims as { claims: number; by_kind: Record<string, number>; facts: { checked: number; true: number; false: number; unverifiable: number }; false_facts: { author: string; text: string }[] };
          out('claims (' + a.extracted.model + (a.extracted.same_model_as_researcher ? ', THE SAME MODEL AS THE RESEARCHER' : '') + '): ' + c.claims + ' ' + JSON.stringify(c.by_kind) + '; facts checked ' + c.facts.checked + ': ' + c.facts.true + ' true, ' + c.facts.false + ' false, ' + c.facts.unverifiable + ' unverifiable');
          for (const f of c.false_facts.slice(0, 5)) out('  false (' + f.author + '): ' + f.text);
        }
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
        const r = await runAgentOperator({ id, journal, role, root: ctx.root, llm: chatFromEnv(env, 'SENIOR_LLM'), ...(max ? { maxOrders: Number(max) } : {}), ...(patience ? { patience: Number(patience) } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}), say: out });
        out('the run ended; the agent\'s decisions: ' + r.file);
        return 0;
      }
      case 'batch': {
        /* Its results computed again from its runs as they are (a regrade, an audit since): nothing is run. */
        if (args[0] === 'results') {
          const reportFile = path.resolve(args[1] ?? '');
          const { batchResults, batchText } = await import('../orchestra/batch.ts');
          const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
          if (report.format !== 'batch@1') { out('not a batch report (batch.json): ' + reportFile); return 2; }
          report.results = batchResults(report, ctx.root);
          fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
          fs.writeFileSync(path.join(path.dirname(reportFile), 'batch.txt'), batchText(report) + '\n');
          out(batchText(report));
          return 0;
        }
        const file = args[0];
        if (!file) { out('lab batch <batch.json>'); return 2; }
        const env = ctx.env ?? process.env;
        const { runBatch, batchText } = await import('../orchestra/batch.ts');
        const { chatFromEnv, labEndpointsFromEnv } = await import('../orchestra/launch.ts');
        const def = JSON.parse(fs.readFileSync(file, 'utf8'));
        const report = await runBatch(def, { root: ctx.root, ...labEndpointsFromEnv(env), agentLlm: () => chatFromEnv(env, 'SENIOR_LLM'), ...(ctx.signal ? { signal: ctx.signal } : {}), print: out });
        out(batchText(report));
        out('report: ' + path.join(report.dir, 'batch.json'));
        return 0;
      }
      case 'control': {
        const files = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] ?? '').startsWith('--')).map((a) => path.resolve(a));
        const condition = take(args, 'condition'), metric = take(args, 'metric'), min = take(args, 'min-subgroups');
        if (!condition || !files.length) { out('lab control <batch.json> [...] --condition C [--metric o1|artifact|o4|severe|tokens|seconds] [--min-subgroups 20]'); return 2; }
        const { controlCharts } = await import('../orchestra/control-chart.ts');
        const charts = controlCharts(files, { condition, ...(metric ? { metric } : {}), ...(Number(min) > 0 ? { minSubgroups: Number(min) } : {}) });
        const dir = path.join(ctx.root, 'runs', 'control');
        fs.mkdirSync(dir, { recursive: true });
        const outFile = path.join(dir, condition.replace(/[^a-z0-9_-]/gi, '_') + '-' + (metric ?? 'o1') + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
        fs.writeFileSync(outFile, JSON.stringify({ format: 'control@1', condition, metric: metric ?? 'o1', batches: files.map((f) => path.relative(ctx.root, f)), charts }, null, 2));
        for (const c of charts as Record<string, any>[]) {
          out('group ' + JSON.stringify(c.group) + ':');
          for (const a of c.assumptions) out('  ' + (a.holds === true ? 'holds' : a.holds === 'assumed' ? 'assumed' : 'NOT MET') + ' - ' + a.assumption + ' (' + a.detail + ')');
          out('  ' + c.reading + (c.signals?.length ? ': ' + c.signals.map((s: Record<string, string>) => s.at + ' (' + s.rule + ')').join('; ') : ''));
        }
        if (!charts.length) out('no run of condition ' + condition + ' in those batches');
        out('written to ' + path.relative(ctx.root, outFile));
        return 0;
      }
      case 'reference': {
        const sub = args.shift();
        const refs = await import('../orchestra/references.ts');
        if (sub === 'freeze') {
          const batchFile = path.resolve(args.shift() ?? ''), condition = take(args, 'condition'), name = take(args, 'name'), by = take(args, 'by'), generator = take(args, 'generator'), supersedes = take(args, 'supersedes');
          if (!condition || !name || !by) { out('lab reference freeze <batch.json> --condition C --name N --by "<person>" [--generator G] [--supersedes OLD]'); return 2; }
          const r = refs.freezeReference(ctx.root, batchFile, { condition, name, by, ...(generator ? { generator } : {}), ...(supersedes ? { supersedes } : {}) });
          out('reference ' + r.name + ' frozen: ' + r.runs.length + ' runs of ' + r.group.condition + ' (' + r.group.world + ', code ' + String(r.group.code_version ?? 'unknown').slice(0, 10) + ', generator ' + r.group.generator + ')'
            + (r.supersedes ? '; it supersedes ' + r.supersedes + ', which stays' : ''));
          return 0;
        }
        if (sub === 'show') {
          const o = refs.openReference(ctx.root, args[0] ?? '');
          out(o.reference.name + ': ' + o.reference.runs.length + ' runs of ' + o.reference.group.condition + ', frozen ' + o.reference.frozen + ' by ' + o.reference.by + (o.reference.supersedes ? ', superseding ' + o.reference.supersedes : ''));
          out(o.holds ? 'it holds' : 'it does NOT hold: ' + o.problems.join('; '));
          return o.holds ? 0 : 1;
        }
        out('lab reference freeze|show ...');
        return 2;
      }
      case 'team': {
        const file = args[0];
        if (!file) { out('lab team <team.json>'); return 2; }
        const env = ctx.env ?? process.env;
        const { runTeam, teamText } = await import('../orchestra/team.ts');
        const { chatFromEnv, labEndpointsFromEnv } = await import('../orchestra/launch.ts');
        const def = JSON.parse(fs.readFileSync(file, 'utf8'));
        const report = await runTeam(def, { root: ctx.root, ...labEndpointsFromEnv(env), agentLlm: () => chatFromEnv(env, 'SENIOR_LLM'), ...(ctx.signal ? { signal: ctx.signal } : {}), print: out });
        out(teamText(report));
        out('report: ' + path.join(report.dir, 'team-report.json'));
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
    out(failureText(e));
    return 1;
  }
}

/** What a failure says on the console: a configuration error by its message; anything else with its kind and where it
    came from, so that a failure never ends a command without a trace (an error's message may be empty). */
export function failureText(e: unknown): string {
  if (e instanceof LabError) return e.message;
  if (e === undefined || e === null || e === '') return 'a failure that says nothing: ' + JSON.stringify(e);
  const err = e as Error | undefined;
  return (err?.stack || (err?.name ? err.name + ': ' : '') + String(err?.message ?? e)) || 'a failure that says nothing: ' + JSON.stringify(e);
}

/** An origin as the operator wrote it: a URL prefix or a domain as it is, a path made absolute. */
function originOf(o: string): string {
  return /^https?:\/\//i.test(o) || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(o) ? o : path.resolve(o);
}
