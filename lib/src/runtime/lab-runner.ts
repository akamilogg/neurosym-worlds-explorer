import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Observer } from '../core/observer.ts';
import { Evaluator } from '../core/evaluate.ts';
import { JevJudge, JEV_DEFAULT_URL } from '../core/jev.ts';
import { fetchJson, parseJsonLoose, type FetchLike } from '../core/net.ts';
import { Predictor, type Law } from '../core/predict.ts';
import type { MeasureDecl } from '../core/types.ts';
import { nodeVmRunner } from './node-vm.ts';
import { openAiChatClient } from '../learn/system2.ts';
import { replayOnEvidence } from '../learn/gates.ts';
import { reflectionTask, system2Prompt, toolOf, type Tool } from '../learn/prompt.ts';
import { ownLaw, type LawRequest } from '../learn/law-explorer.ts';
import { LawSession, lawFingerprint } from '../learn/law-session.ts';
import { Protocol } from '../learn/protocol.ts';
import { formOf, operatorSummary, tokensOf, type AblationRecord } from '../learn/operator.ts';
import type { Place } from '../learn/objective.ts';
import { isGameLab, type AnyLab, type GameLab, type LabCase, type LabContext, type LabOperatorContext, type LabOptions, type LabRunConfig, type LawLab } from '../learn/lab.ts';
import { findingOf, findingText, findingView, type Finding } from '../learn/finding.ts';
import { ReplayLog } from './replay.ts';
import { runFiles } from './control.ts';
import { assistedSession, assistedSystem, deliveredMessages, operatorClient, type OperatorMessage } from '../learn/assisted/session.ts';
import { Sources, isUrl, judgeSelector, originProblem, sourceFetch } from '../learn/assisted/sources.ts';
import { mulberry32 } from '../worlds/grid/gen.ts';

/* ============================================================================
 * The runner of a LABORATORY (SPEC-OBJETIVO O9): the same for every world that declares
 * itself as a `Lab` (learn/lab.ts). Node-side: files, a VM for the learner's code, the
 * network for the Judge and System 2.
 *
 * Endpoints and keys come from the environment (never from the command line, never
 * written to the journal): JEV_URL, JEV_KEY, JEV_MODEL; LLM_URL, LLM_KEY, LLM_MODEL.
 *
 * The protocol is the researcher's (learn/protocol.ts): it decides from what the world answered.
 * The journal keeps the operator's measures (and, for a world someone wrote, its truth); they
 * never reach System 2 or the Judge.
 * ========================================================================== */

/** The common options, with their defaults (a laboratory may change a default: `Lab.defaults`). */
const COMMON: readonly { name: string; default: string; help: string }[] = [
  { name: 'seed', default: '1', help: 'the world' },
  { name: 'attempts', default: '8', help: 'proposal/check rounds' },
  { name: 'explore', default: '3', help: 'episodes the environment runs in the laboratory before the first proposal' },
  { name: 'steps', default: '3', help: 'investigation answers System 2 may give per round before proposing' },
  { name: 'check-episodes', default: '2', help: 'episodes per place in a check, a validation or a confirmation' },
  { name: 'every', default: '3', help: 'take every N-th step of an episode as a point of a check' },
  { name: 'family', default: '3', help: 'places of the family to validate on' },
  { name: 'validations', default: '3', help: 'how many times System 2 may validate' },
  { name: 'confirm-places', default: '2', help: 'places per blind confirmation set, two sets' },
  { name: 'tools', default: 'all', help: 'the instruments, a,b,... ("all" or "none")' },
  { name: 'focus', default: '', help: 'a facet of the task: what of the answer counts (the laboratory\'s facets; either researcher)' },
  { name: 'task', default: '', help: 'what the operator wants understood, in words (the assisted researcher only)' },
  { name: 'sources-allow', default: '', help: 'origins the assisted researcher may read sources from: directories, URL prefixes or domains, a,b,...' },
  { name: 'memory', default: '', help: '"selective": the assisted researcher\'s notebook travels abridged by a fixed rule, and it recalls the rest itself (list/open/find over its own record; the grid only, for now)' },
  { name: 'out', default: '', help: 'the journal (default runs/<name>-<time>.json)' }
];
const FLAGS: readonly { name: string; help: string }[] = [
  { name: 'quick', help: 'stop the first time System 2 asks to validate, without validating' },
  { name: 'no-ablation', help: 'skip the operator\'s ablation of the Judge' },
  { name: 'no-grade', help: 'skip the operator-only grading of the recovered rule (one LLM call)' },
  { name: 'no-reflection', help: 'skip the final reflection round' },
  { name: 'flat', help: 'CONTROL: a Judge that knows nothing (every answer neutral); the LLM is still consulted' }
];

/** Options that control the run, not the experiment: a resumed run takes them anew (SPEC-OBJETIVO O11). */
const CONTROLS: readonly { name: string; value: string; help: string }[] = [
  { name: 'max-minutes', value: 'N', help: 'stop before asking System 2 again once N minutes have passed (this process)' },
  { name: 'max-tokens', value: 'N', help: 'stop before asking System 2 again once its answers have used N tokens (the whole run)' },
  { name: 'resume', value: 'FILE', help: 'resume the run of that journal in a new one (<journal>.resumed-<time>.json, or --out): its answers are replayed, then it goes on live; the journal resumed is left as it is' },
  { name: 'policy', value: 'P', help: 'the operator\'s policy on researchers: force=<researcher>, or allow=<researcher>,<researcher>' },
  { name: 'agents', value: 'LIST', help: 'the agents that may order this run, and what (SPEC-ORQUESTADOR R1): <id>=<kind>,<kind>;<id>=... (kinds: message, focus, source, stop); without it, no agent may' },
  { name: 'help-budget', value: 'N', help: 'at most N help orders (message, focus, source) accepted in the run, from anyone' }
];
const CONTROL_NAMES = new Set(['out', ...CONTROLS.map((c) => c.name)]);

/** The experiment's arguments, without the run's controls (what a resumed run repeats). */
export function experimentArgs(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--') && CONTROL_NAMES.has(argv[i].slice(2))) { i++; continue; }
    out.push(argv[i]);
  }
  return out;
}

/** The run's budgets given now (a resumed run takes these, and the journal it resumes as --out). */
export function budgetArgs(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) if (['--max-minutes', '--max-tokens', '--agents', '--help-budget'].includes(argv[i])) out.push(argv[i], argv[++i] ?? '');
  return out;
}

/** The command line's help for a laboratory. */
export function labUsage(lab: AnyLab, command: string): string {
  const pad = (s: string) => s.padEnd(22);
  const defaults = { ...Object.fromEntries(COMMON.map((o) => [o.name, o.default])), ...(lab.defaults ?? {}) };
  const regression = lab.regressionByDefault === false
    ? { name: 'regression', help: 'the paired regression: each laboratory\'s previous check answered again by the new model, which must still hold there' }
    : { name: 'no-regression', help: 'do not answer each laboratory\'s previous check again with the new model' };
  return [lab.id + ': ' + lab.about, '', '  ' + command + ' [options]', '', 'Options of this world:',
    ...lab.options.map((o) => '  ' + pad('--' + o.name + ' N') + o.help + ' (default ' + o.default + ')'),
    ...(lab.flags ?? []).map((f) => '  ' + pad('--' + f.name) + f.help),
    'Common options:',
    /* A loop of its own draws its checks its own way: the points of an episode are not its. */
    ...COMMON.filter((o) => !(isGameLab(lab) && (o.name === 'every' || o.name === 'check-episodes'))).map((o) => '  ' + pad('--' + o.name + ' ' + (o.name === 'tools' ? 'LIST' : o.name === 'out' ? 'FILE' : 'N')) + o.help + (defaults[o.name] ? ' (default ' + defaults[o.name] + ')' : '')),
    ...[regression, ...FLAGS].map((f) => '  ' + pad('--' + f.name) + f.help),
    'Run controls (Ctrl+C stops before the next question to System 2; a second Ctrl+C stops at once):',
    ...CONTROLS.map((c) => '  ' + pad('--' + c.name + ' ' + c.value) + c.help),
    '', 'Endpoints and keys come from the environment: LLM_URL, LLM_MODEL, LLM_KEY; JEV_URL, JEV_KEY (not needed with --flat).'].join('\n');
}

/** The commit the run is made from, marked when the working tree has changes (null outside a repository). */
function commitOf(root: string): string | null {
  try {
    const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim();
    return head + (dirty ? '+changes' : '');
  } catch { return null; }
}

/* ============================================================================
 * A laboratory run as a LIBRARY call (SPEC-OBJETIVO O13): no environment variables, no
 * console of its own, no process signals, no process.exit. The caller gives the experiment's
 * arguments, where System 2 and the Judge are, and (optionally) the network, a signal to
 * cancel, and where to print; it gets back why the run stopped, its journal and its finding.
 * A configuration it cannot run is a LabError. The command line (runLab) is a wrapper.
 * ========================================================================== */

/** A configuration the runner cannot run: bad arguments, a journal that cannot be resumed, a missing endpoint. */
export class LabError extends Error {
  readonly code: number;
  constructor(message: string, code = 2) { super(message); this.name = 'LabError'; this.code = code; }
}

/** Where a model is served: an OpenAI-compatible chat URL (System 2) or the Judge's URL, and the key and model to use. */
export interface LabConnection {
  readonly url?: string; readonly key?: string; readonly model?: string;
  /** System 2 only, for models that need it (a slow local one, a reasoning one): how long to wait for an answer (default
      180 s), whether to ask for JSON mode (default yes; some servers mishandle it with reasoning models), and max_tokens
      (default: the endpoint's). Unset, the request is the same as ever. */
  readonly timeoutMs?: number; readonly jsonMode?: boolean; readonly maxTokens?: number;
  /** Its temperature (default 0.4), and fields the endpoint takes besides the standard ones (e.g. vLLM's
      chat_template_kwargs: {"reasoning_effort": "medium"}). Both are recorded in the journal's config. */
  readonly temperature?: number; readonly extraBody?: Readonly<Record<string, unknown>>;
}

export interface LabRunOptions {
  /** The experiment's arguments, as on the command line (e.g. ['--seed', '1', '--level', '3']); the run controls too. */
  readonly args: readonly string[];
  /** Where runs/ goes by default, and the repository whose commit the journal records. */
  readonly root: string;
  /** System 2: an OpenAI-compatible /chat/completions URL and a model. */
  readonly llm: LabConnection;
  /** The Judge (not needed with --flat). */
  readonly judge?: LabConnection;
  /** The network (default: the global fetch). Everything that comes over it is logged for --resume. */
  readonly fetch?: FetchLike;
  /** Aborted: the run stops before its next question to System 2 (a budget, not a hard stop). */
  readonly signal?: AbortSignal;
  /** Where the run's lines go (default: nowhere). */
  readonly print?: (line: string) => void;
  /** Told the journal's file as soon as it is known. */
  readonly onJournal?: (file: string) => void;
  /** Which researcher (SPEC-INVESTIGADOR-ASISTIDO §3.1): as asked by whoever starts the run (default unknown-world;
      `--researcher` in the arguments says the same). */
  readonly researcher?: Researcher;
  /** The operator's policy: the researchers allowed, or the one forced (`--policy` in the arguments says the same). */
  readonly policy?: ResearcherPolicy;
}

/** The two researchers (SPEC-INVESTIGADOR-ASISTIDO): the one that learns only from what the world answers, and the one the
    operator may help. */
export const RESEARCHERS = ['unknown-world', 'assisted'] as const;
export type Researcher = typeof RESEARCHERS[number];
export interface ResearcherPolicy { readonly allow?: readonly Researcher[]; readonly force?: Researcher }

/** `force=assisted`, `allow=unknown-world,assisted`. */
export function parsePolicy(text: string): ResearcherPolicy {
  const out: { allow?: Researcher[]; force?: Researcher } = {};
  for (const part of text.split(';').map((x) => x.trim()).filter(Boolean)) {
    const [k, v] = part.split('=').map((x) => x.trim());
    const names = (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    const bad = names.filter((n) => !(RESEARCHERS as readonly string[]).includes(n));
    if (bad.length || !names.length) throw new LabError('--policy: unknown researcher ' + (bad.join(', ') || '(none)') + ' (researchers: ' + RESEARCHERS.join(', ') + ')');
    if (k === 'force' && names.length === 1) out.force = names[0] as Researcher;
    else if (k === 'allow') out.allow = names as Researcher[];
    else throw new LabError('--policy: use force=<researcher> or allow=<researcher>,<researcher>');
  }
  return out;
}

/** Who runs, from what was asked and the operator's policy; a researcher the policy does not allow is a LabError. */
export function chooseResearcher(asked: Researcher, policy: ResearcherPolicy | null): Researcher {
  const used = policy?.force ?? asked;
  if (policy?.allow && !policy.allow.includes(used)) throw new LabError('the operator\'s policy does not allow the ' + used + ' researcher (allowed: ' + policy.allow.join(', ') + ')');
  return used;
}

export interface LabResult {
  /** accepted, quick_stop, budget, cancelled, time_budget, token_budget, diverged, llm_error... */
  readonly stoppedBy: string;
  readonly journal: string;
  /** The operator's finding (with all its measures, for audit). */
  readonly findingFile: string;
  readonly finding: Finding;
  /** The researcher's (without what only the operator knows): what another agent is given (SPEC-OBJETIVO O14). */
  readonly researcherFile: string;
  readonly researcher: Finding;
  /** Which researcher ran it. */
  readonly researcherUsed: Researcher;
}

/** The command line: --help, the endpoints from the environment, Ctrl+C as a cancel (twice: stop at once), exit codes. */
export async function runLab(lab: AnyLab, given: readonly string[], context: { root: string; command: string }): Promise<void> {
  if (given.includes('--help') || given.includes('-h')) { console.log(labUsage(lab, context.command)); return; }
  const env = process.env;
  const controller = new AbortController();
  let journal = '';
  const onSignal = (): void => {
    if (controller.signal.aborted) { console.log('stopped at once' + (journal ? '; resume with --resume ' + journal : '')); process.exit(130); }
    controller.abort();
    console.log('stopping before the next question to System 2 (Ctrl+C again to stop at once)');
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    const result = await runLaboratory(lab, {
      args: given, root: context.root, signal: controller.signal, print: (line) => console.log(line), onJournal: (file) => { journal = file; },
      llm: { url: env.LLM_URL, key: env.LLM_KEY, model: env.LLM_MODEL, ...llmTuning(env) },
      judge: { url: env.JEV_URL || JEV_DEFAULT_URL, key: env.JEV_KEY, model: env.JEV_MODEL }
    });
    if (result.stoppedBy === 'diverged') process.exitCode = 3;
  } catch (e) {
    if (e instanceof LabError) { console.error(e.message); process.exit(e.code); }
    throw e;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

export async function runLaboratory(lab: AnyLab, options: LabRunOptions): Promise<LabResult> {
  /* --- Configuration ---------------------------------------------------------------- */
  const given = options.args;
  /* Resuming: the experiment's arguments are the journal's; the budgets are the ones given now. */
  const r = given.indexOf('--resume');
  const resumeFrom = r >= 0 ? given[r + 1] : undefined;
  let previous: Record<string, any> | null = null;
  if (resumeFrom) {
    try { previous = JSON.parse(fs.readFileSync(resumeFrom, 'utf8')); } catch (e) { throw new LabError('--resume: cannot read ' + resumeFrom + ': ' + String((e as Error).message ?? e)); }
    if (previous!.experiment !== lab.id || !Array.isArray(previous!.argv)) throw new LabError('--resume: ' + resumeFrom + ' is not a resumable journal of ' + lab.id);
    /* Without its log, a resumed run would ask everything again: costs and acts repeated. */
    const log = resumeFrom.replace(/\.json$/, '') + '.replay.jsonl';
    if (!fs.existsSync(log)) throw new LabError('--resume: the log of ' + resumeFrom + ' is missing (' + log + '): without it every request would be made again, so the run is not resumed');
  }
  /* A CONTINUATION: `--resume <journal> --attempts N` gives more rounds to a run that used up its own. The run is replayed as
     it was - its ending too (the reflection and the grading it ended with are part of its history) - and then goes on. */
  const ga = given.indexOf('--attempts');
  const moreRounds = previous && ga >= 0 && given[ga + 1] ? Number(given[ga + 1]) : null;
  const continuedFrom = previous && moreRounds !== null ? Number(previous.config?.attempts) : null;
  if (previous && moreRounds !== null) {
    const end = [...(previous.events as Record<string, any>[])].reverse().find((e) => e.type === 'end');
    if (isGameLab(lab)) throw new LabError('--attempts with --resume: ' + lab.id + ' has a loop of its own; it cannot be given more rounds yet');
    if (!end || end.stoppedBy !== 'budget') throw new LabError('--attempts with --resume: only a run that ended by using up its rounds can be given more (this one: ' + (end ? end.stoppedBy : 'did not end') + '); resume it without --attempts');
    if (!(moreRounds > continuedFrom!)) throw new LabError('--attempts with --resume: give it more than the ' + continuedFrom + ' rounds it had');
  }
  /* A resumed run is a run of its own, derived from the one it resumes, which stays as it was (its provenance). */
  const o = given.indexOf('--out');
  const derived = previous ? (o >= 0 && given[o + 1] ? given[o + 1] : resumeFrom!.replace(/\.json$/, '') + (continuedFrom !== null ? '.continued-' : '.resumed-') + new Date().toISOString().replace(/[:.]/g, '-') + '.json') : null;
  const kept = previous ? (previous.argv as string[]).filter((a, i, all) => !(continuedFrom !== null && (a === '--attempts' || all[i - 1] === '--attempts'))) : [];
  const argv: readonly string[] = previous ? [...kept, ...(continuedFrom !== null ? ['--attempts', String(moreRounds)] : []), ...budgetArgs(given), '--out', derived!] : given;
  /* The rounds after which the run's history had an ending (a continuation replays each where it was). */
  const endings: number[] = [...((previous?.continuations as number[] | undefined) ?? []), ...(continuedFrom !== null ? [continuedFrom] : [])];
  const defaults: Record<string, string> = { ...Object.fromEntries(COMMON.map((o) => [o.name, o.default])), ...(lab.defaults ?? {}) };
  /* An option under its name or one of its aliases (an earlier runner's). */
  const aliasesOf = (name: string): string[] => [name, ...Object.entries(lab.aliases ?? {}).filter(([, to]) => to === name).map(([from]) => from),
    ...(lab.options.find((o) => o.name === name)?.aliases ?? [])];
  const arg = (name: string, fallback = defaults[name] ?? ''): string => {
    for (const n of aliasesOf(name)) { const i = argv.indexOf('--' + n); if (i >= 0 && argv[i + 1]) return argv[i + 1]; }
    return fallback;
  };
  const flag = (name: string): boolean => argv.includes('--' + name);
  const worldOptions: LabOptions = {
    ...Object.fromEntries(lab.options.map((o) => [o.name, arg(o.name, o.default)])),
    ...Object.fromEntries((lab.flags ?? []).map((f) => [f.name, String(flag(f.name))]))
  };
  const camel = (s: string) => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  const ALL: readonly Tool[] = (isGameLab(lab) ? lab.tools : lab.interface({}).tools) as readonly Tool[];
  const parseTools = (value: string): Tool[] => {
    if (value === 'all') return [...ALL];
    if (value === 'none') return [];
    const asked = value.split(',').map((t) => t.trim()).filter(Boolean).map((t) => toolOf(t) ?? t);
    const unknown = asked.filter((t) => !(ALL as readonly string[]).includes(t));
    if (unknown.length) throw new LabError('--tools: unknown ' + unknown.join(', ') + ' (tools: ' + ALL.join(', ') + ', or all / none)');
    return ALL.filter((t) => asked.includes(t));
  };
  const cfg = {
    seed: Number(arg('seed')),
    ...Object.fromEntries(Object.entries(worldOptions).map(([k, v]) => [camel(k), v === 'true' ? true : v === 'false' ? false : Number.isFinite(Number(v)) ? Number(v) : v])),
    attempts: Number(arg('attempts')),
    explore: Number(arg('explore')),
    steps: Number(arg('steps')),
    checkEpisodes: Math.max(1, Number(arg('check-episodes'))),
    every: Math.max(1, Number(arg('every'))),
    family: Math.max(1, Number(arg('family'))),
    validations: Math.max(1, Number(arg('validations'))),
    confirmPlaces: Math.max(1, Number(arg('confirm-places'))),
    regression: lab.regressionByDefault === false ? flag('regression') : !flag('no-regression'),
    tools: parseTools(arg('tools')),
    quick: flag('quick'),
    ablation: !flag('no-ablation') && !flag('quick'),
    grade: !flag('no-grade'),
    reflection: !flag('no-reflection') && !flag('quick'),
    flat: flag('flat'),
    ...(arg('focus') ? { focus: arg('focus') } : {}),
    ...(arg('task') ? { task: arg('task') } : {}),
    ...(arg('sources-allow') ? { sources_allow: arg('sources-allow') } : {}),
    ...(arg('memory') ? { memory: arg('memory') } : {})
  };
  Object.defineProperty(cfg, '__options', { value: worldOptions, enumerable: false });
  Object.defineProperty(worldOptions, '__focus', { value: arg('focus') || '', enumerable: false });
  Object.defineProperty(worldOptions, '__task', { value: arg('task') || '', enumerable: false });
  Object.defineProperty(worldOptions, '__sources_allow', { value: originsOf(arg('sources-allow'), options.root), enumerable: false });
  /* The researcher: as the run it resumes had it, or as asked; then the operator's policy decides. */
  /* A continuation may hand the run to the ASSISTED researcher (`--researcher assisted` with `--attempts`): its history stays
     the unknown-world researcher's, word for word, ending included; from its new rounds on the operator may help. Never
     the other way, and never without new rounds. */
  const gr = given.indexOf('--researcher');
  const askedNow = previous && gr >= 0 && given[gr + 1] ? given[gr + 1] : null;
  if (askedNow && askedNow !== previous!.researcher) {
    if (continuedFrom === null) throw new LabError('--researcher with --resume: the researcher changes only when the run is given more rounds (--attempts)');
    if (askedNow !== 'assisted') throw new LabError('--researcher with --resume: a run can only be handed to the assisted researcher, never back');
  }
  const assistedAfter: number | null = previous?.assisted_after_attempts ?? (askedNow === 'assisted' && previous!.researcher !== 'assisted' ? continuedFrom : null);
  const askedText = assistedAfter !== null ? 'assisted' : previous?.researcher ?? (arg('researcher', '') || options.researcher || 'unknown-world');
  if (!(RESEARCHERS as readonly string[]).includes(askedText)) throw new LabError('--researcher: unknown ' + askedText + ' (researchers: ' + RESEARCHERS.join(', ') + ')');
  const p = given.indexOf('--policy');
  const policy: ResearcherPolicy | null = options.policy ?? (p >= 0 && given[p + 1] ? parsePolicy(given[p + 1]) : null);
  const researcher = chooseResearcher(askedText as Researcher, policy);
  parseAgentPolicy(arg('agents', ''));
  const focus = arg('focus') || null;
  if (focus && (isGameLab(lab) || !lab.facets?.some((f) => f.id === focus)))
    throw new LabError('--focus: ' + focus + ' is not a facet of ' + lab.id + (!isGameLab(lab) && lab.facets ? ' (facets: ' + lab.facets.map((f) => f.id).join(', ') + ')' : ' (it has none)'));
  if (arg('task') && researcher !== 'assisted') throw new LabError('--task: a statement of what to understand is help: only the assisted researcher takes it');
  if (arg('sources-allow') && researcher !== 'assisted') throw new LabError('--sources-allow: sources are help: only the assisted researcher reads them');
  for (const o of originsOf(arg('sources-allow'), options.root)) { const problem = originProblem(o); if (problem) throw new LabError('--sources-allow: ' + problem); }
  /* The assisted researcher of a laboratory with a loop of its own (the grid) takes the operator's messages and may have a
     selective memory; focus, a task and sources are not built for it yet (A7). */
  if (researcher === 'assisted' && isGameLab(lab) && (arg('task') || arg('sources-allow') || arg('focus')))
    throw new LabError('the assisted researcher of ' + lab.id + ' takes messages and a selective memory; a task, a focus and sources are not built for it yet (SPEC-INVESTIGADOR-ASISTIDO, A7)');
  if (arg('memory') && arg('memory') !== 'selective') throw new LabError('--memory: the only memory is "selective"');
  if (arg('memory') && researcher !== 'assisted') throw new LabError('--memory: a selective memory changes what the researcher is given: only the assisted researcher has one');
  if (arg('memory') && !isGameLab(lab)) throw new LabError('--memory: the selective memory is built for the grid only, for now (SPEC-INVESTIGADOR-ASISTIDO §13)');
  if (!options.llm.url || !options.llm.model) throw new LabError('System 2 is needed: its URL and model (LLM_URL and LLM_MODEL on the command line; LLM_KEY if the endpoint needs one).');
  if (!cfg.flat && !options.judge?.key) throw new LabError('The Judge is needed: its key (JEV_KEY on the command line), or run the --flat control.');

  /* --- The run's common services: System 2 and the Judge (their answers logged), the journal, stopping ---------------- */
  const run = openRun(lab, options, { argv, previous, resumeFrom: resumeFrom ?? null, cfg, arg, config: {}, researcher, asked: askedText as Researcher, policy });
  options.onJournal?.(run.outFile);
  /* A divergence ends the run where it is: whatever the loop was doing is left, and nothing more is written. */
  /* The assisted researcher of a laboratory with a loop of its own: the operator's messages with its questions (resuming,
     delivered again at the same questions), and its selective memory, with the Judge to select for it (none in --flat). */
  const services = isGameLab(lab) && researcher === 'assisted'
    ? { ...run.services, llm: operatorClient(run.services.llm, { take: () => run.operator.take(), scheduled: deliveredMessages(previous) }, run.log),
      assisted: { memory: arg('memory') === 'selective', ...(cfg.flat ? {} : { selector: judgeSelector(run.judge) }) } }
    : run.services;
  const body = isGameLab(lab)
    ? lab.run(services).then((result) => {
      const finished = run.finish({ stoppedBy: result.stoppedBy, halted: result.halted ?? null }, result.end);
      run.say('done: ' + result.stoppedBy + (result.halted ? '; resume with --resume ' + run.outFile : '') + '; journal ' + run.outFile);
      return finished;
    })
    : runLawLab(lab, run, { cfg, worldOptions, ctx: { seed: cfg.seed, options: worldOptions, family: cfg.family, every: cfg.every, checkEpisodes: cfg.checkEpisodes,
      confirmPlaces: cfg.confirmPlaces, explore: cfg.explore }, previous, resumeFrom: resumeFrom ?? null, endings, assistedAfter });
  body.catch(() => { /* after a divergence, the loop left behind may fail: nothing of it is kept */ });
  return Promise.race([body, run.diverged]);
}

/** The origins of `--sources-allow`: URL prefixes and domains as they are, paths from the root. */
function originsOf(list: string, root: string): string[] {
  return list.split(',').map((o) => o.trim()).filter(Boolean)
    .map((o) => (isUrl(o) || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(o) ? o : path.resolve(root, o)));
}

/* ============================================================================
 * The run's common services, the same for every laboratory.
 * ========================================================================== */

interface OpenRun {
  readonly services: import('../learn/lab.ts').LabServices;
  readonly judge: JevJudge;
  readonly llm: ReturnType<typeof openAiChatClient>;
  readonly llmUse: { calls: number; tokens: number };
  readonly replay: ReplayLog;
  readonly journal: Record<string, any>;
  readonly outFile: string;
  readonly commit: string | null;
  /** The environment outside, when the laboratory has one. */
  readonly effects?: { request(route: string, body: unknown): Promise<unknown> };
  /** The operator's messages accepted and not yet delivered (the assisted researcher takes them). */
  readonly operator: { take(): OperatorMessage[] };
  /** Sources (on the web or on the disk), read through the run's log (channel "source"): a resumed run is answered what the
      first read, and reads live from there. */
  readonly sourceFetch: FetchLike;
  log(type: string, data?: Record<string, unknown>): void;
  say(text: string): void;
  halt(): string | null;
  /** The end of the run: the end event (common fields, then the laboratory's), the finding, the warnings. */
  finish(stop: { stoppedBy: string; halted: string | null }, end: Record<string, unknown>): LabResult;
  /** Settles with the run's result when a resumed run diverges (the run ends there). */
  readonly diverged: Promise<LabResult>;
}

function openRun(lab: AnyLab, options: LabRunOptions, o: { argv: readonly string[]; previous: Record<string, any> | null; resumeFrom: string | null;
  cfg: LabRunConfig & Record<string, unknown>; arg: (name: string, fallback?: string) => string; config: Record<string, unknown>;
  researcher: Researcher; asked: Researcher; policy: ResearcherPolicy | null }): OpenRun {
  const { argv, previous, resumeFrom, cfg, arg, researcher } = o;
  const network: FetchLike = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const maxMinutes = Number(arg('max-minutes', '0')) || null;
  const maxTokens = Number(arg('max-tokens', '0')) || null;
  const flatFetch = async (_u: string, init: { body?: string }) => {
    const body = JSON.parse(String(init.body));
    const answers: Record<string, unknown> = {};
    for (const [id, q] of Object.entries<any>(body.questions)) {
      answers[id] = q.type === 'choice' ? { type: 'choice', probabilities: Object.fromEntries(Object.keys(q.criteria).map((k, i) => [k, i === 0 ? 0.5 : 0.25])), confidence: 0.3 }
        : q.type === 'score' ? { type: 'score', score: Math.floor((q.criteria.length - 1) / 2), confidence: 0.3 } : { type: 'noul', noul: 0.5 };
    }
    const text = JSON.stringify({ answers });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
  /* Every answer that comes over the network is logged as it arrives, next to the journal: the run can be resumed. */
  const started = new Date();
  const outFile = arg('out') || path.join(options.root, 'runs', lab.runName(cfg.seed, worldOptionsOf(cfg)) + '-' + started.toISOString().replace(/[:.]/g, '-') + '.json');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const logOf = (journalFile: string) => journalFile.replace(/\.json$/, '') + '.replay.jsonl';
  /* A request the log of the resumed run does not answer, while answers still wait there: the run diverged. It stops. */
  let onDiverge: (d: { channel: string; pending: number }) => void = () => {};
  const replay = new ReplayLog(logOf(outFile), { ...(previous ? { from: logOf(resumeFrom!) } : {}), onDiverge: (d) => onDiverge(d) });
  const judge = new JevJudge(cfg.flat
    ? { url: JEV_DEFAULT_URL, apiKey: 'flat', fetch: flatFetch as never }
    : { url: options.judge?.url || JEV_DEFAULT_URL, apiKey: options.judge?.key, model: options.judge?.model, timeoutMs: 90000, retries: 4, retryNetwork: true, concurrency: 8, fetch: replay.wrap('jev', network) });
  const llmUse = { calls: 0, tokens: 0 };
  const llm = openAiChatClient({ url: options.llm.url!, apiKey: options.llm.key, model: options.llm.model!, jsonMode: options.llm.jsonMode ?? true, temperature: options.llm.temperature ?? 0.4,
    timeoutMs: options.llm.timeoutMs ?? 180000, retries: 1, ...(options.llm.maxTokens ? { maxTokens: options.llm.maxTokens } : {}),
    ...(options.llm.extraBody ? { extraBody: options.llm.extraBody } : {}), fetch: replay.wrap('llm', network),
    onRequest: () => { llmUse.calls++; }, onAnswer: (a) => { llmUse.tokens += tokensOf(a.raw); } });

  const commit = commitOf(options.root);
  const journal: Record<string, any> = {
    experiment: lab.id, started: started.toISOString(), ...(commit ? { commit } : {}),
    /* Who ran it, what was asked, and under which policy of the operator (SPEC-INVESTIGADOR-ASISTIDO §3.1). */
    researcher, researcher_requested: o.asked, researcher_policy: o.policy,
    /* The experiment's arguments (never a key: those come from the environment), for --resume. */
    argv: experimentArgs(argv),
    ...(previous ? { resumed: { from: path.basename(resumeFrom!), from_started: previous.started, from_commit: previous.commit ?? null } } : {}),
    config: { ...cfg, ...o.config, llm_model: options.llm.model, ...llmTuningRecord(options.llm), jev_model: cfg.flat ? null : options.judge?.model ?? null },
    /* Filled by the laboratory: what the learner is never told. */
    hidden_from_the_learner: {},
    events: [] as unknown[]
  };
  /* Once a divergence has ended the run where it was, the loop left behind writes nothing more. */
  let closed = false;
  const log = (type: string, data: Record<string, unknown> = {}): void => {
    if (closed) return;
    journal.events.push({ t: Math.round((Date.now() - started.getTime()) / 1000), type, ...data });
    fs.writeFileSync(outFile, JSON.stringify(journal, null, 2));
    writeStatus();
  };

  /* --- The run as an object with a state, and its operator's inbox (SPEC-INVESTIGADOR-ASISTIDO §4.1) ---------------
     <run>.status.json: its live state, rewritten with every event and a heartbeat. <run>.inbox.jsonl: orders of the
     operator, one per line, read before each question to System 2 and with the heartbeat. `stop` is control and is obeyed
     by any researcher; message, focus and source are help, and the unknown-world researcher refuses them - the refusal is
     logged, so the journal says it was tried and that nothing reached System 2. */
  const files = runFiles(outFile);
  /* Who may help and how much (SPEC-ORQUESTADOR R1): the agents allowed and their orders, and the run's help budget. A
     person's orders are never refused for being a person's; an agent's are, outside its policy. */
  const agentPolicy = parseAgentPolicy(arg('agents', ''));
  const helpBudget = Number(arg('help-budget', '')) > 0 ? Number(arg('help-budget', '')) : null;
  if (agentPolicy.size) journal.agents = Object.fromEntries([...agentPolicy].map(([id, kinds]) => [id, [...kinds]]));
  if (helpBudget !== null) journal.help_budget = helpBudget;
  const HELP = new Set(['message', 'focus', 'source']);
  /* The help already accepted in the history it resumes counts too. */
  let helpUsed = ((previous?.events ?? []) as Record<string, any>[]).filter((e) => e.type === 'operator_command' && e.accepted && HELP.has(e.kind)).length;
  let state: 'running' | 'stopping' | 'ended' = 'running';
  let stoppedBy: string | null = null;
  let stopRequested = false;
  let consumed = 0;
  const waiting: OperatorMessage[] = [];
  const lastRound = (): number | null => { for (let i = journal.events.length - 1; i >= 0; i--) if (typeof journal.events[i].round === 'number') return journal.events[i].round; return null; };
  function writeStatus(): void {
    try {
      fs.writeFileSync(files.status, JSON.stringify({ run: path.basename(outFile, '.json'), journal: outFile, lab: lab.id, researcher, state, pid: process.pid,
        started: started.toISOString(), heartbeat: new Date().toISOString(), round: lastRound(), events: journal.events.length,
        cost: { llm_calls: llmUse.calls, llm_tokens: llmUse.tokens, jev_calls: judge.stats.calls }, ...(stoppedBy ? { stoppedBy } : {}) }, null, 2));
    } catch { /* the state is a convenience: a run never stops for it */ }
  }
  function pollInbox(): void {
    if (closed || !fs.existsSync(files.inbox)) return;
    const lines = fs.readFileSync(files.inbox, 'utf8').split('\n');
    const complete = lines.slice(0, -1);
    for (const line of complete.slice(consumed)) {
      consumed++;
      if (!line.trim()) continue;
      let order: { id?: string; kind?: string; by?: string } = {};
      try { order = JSON.parse(line); } catch { log('operator_command_refused', { reason: 'not an order (not JSON)' }); continue; }
      const who = { id: order.id ?? null, kind: order.kind ?? null, ...(order.by ? { by: order.by } : {}) };
      const agent = typeof order.by === 'string' && order.by.startsWith('agent:') ? order.by.slice(6) : null;
      if (agent !== null && !agentPolicy.get(agent)?.has(String(order.kind))) {
        log('operator_command_refused', { ...who, reason: 'agent ' + agent + ' may not send ' + order.kind + ' to this run'
          + (agentPolicy.size ? ' (agents: ' + [...agentPolicy].map(([id, k]) => id + '=' + [...k].join(',')).join('; ') + ')' : ' (no agent may: --agents)') });
        continue;
      }
      if (researcher === 'assisted' && HELP.has(String(order.kind)) && helpBudget !== null && helpUsed >= helpBudget) {
        log('operator_command_refused', { ...who, reason: 'the help budget of this run is spent (' + helpBudget + ')' });
        continue;
      }
      if (order.kind === 'stop') {
        stopRequested = true;
        state = 'stopping';
        log('operator_command', { ...who, accepted: true });
        say('the operator asks to stop: stopping before the next question to System 2');
      } else if (researcher === 'assisted' && order.kind === 'message' && typeof (order as { text?: unknown }).text === 'string' && (order as { text: string }).text.trim()) {
        /* Delivered with the next question to System 2, and logged then (operator_message), with that question's number. */
        waiting.push({ id: String(order.id ?? 'message-' + consumed), text: (order as { text: string }).text, ...(order.by ? { by: order.by } : {}), at: new Date().toISOString() });
        log('operator_command', { ...who, accepted: true }); helpUsed++;
      } else if (researcher === 'assisted' && order.kind === 'focus') {
        const facet = String((order as { facet?: unknown }).facet ?? '');
        const task = typeof (order as { task?: unknown }).task === 'string' ? (order as { task: string }).task : undefined;
        const facets = isGameLab(lab) ? [] : lab.facets ?? [];
        if (!facets.some((f) => f.id === facet)) log('operator_command_refused', { ...who, reason: 'no facet ' + JSON.stringify(facet) + ' in ' + lab.id + (facets.length ? ' (facets: ' + facets.map((f) => f.id).join(', ') + ')' : '') });
        else {
          /* Delivered with the next question, and applied then: what counts, and the prompt that says so. */
          waiting.push({ id: String(order.id ?? 'focus-' + consumed), text: 'The operator changes what counts: facet "' + facet + '"' + (task ? '. What they want understood: ' + task : '') + '. The interface says what counts now.',
            ...(order.by ? { by: order.by } : {}), at: new Date().toISOString(), focus: { facet, ...(task ? { task } : {}) } });
          log('operator_command', { ...who, accepted: true }); helpUsed++;
        }
      } else if (researcher === 'assisted' && order.kind === 'source') {
        const where = String((order as { source?: unknown }).source ?? '');
        const problem = !where ? 'an origin of sources is a directory, a URL prefix or a domain' : isGameLab(lab) ? 'the assisted researcher of ' + lab.id + ' reads no sources yet (A7)' : originProblem(where);
        if (problem) log('operator_command_refused', { ...who, reason: problem });
        else {
          /* Delivered with the next question, and allowed from then on (sources_allowed). */
          waiting.push({ id: String(order.id ?? 'source-' + consumed), text: 'The operator allows you to read sources from ' + where + '.',
            ...(order.by ? { by: order.by } : {}), at: new Date().toISOString(), source: where });
          log('operator_command', { ...who, accepted: true }); helpUsed++;
        }
      } else if (order.kind === 'message' || order.kind === 'focus' || order.kind === 'source') {
        log('operator_command_refused', { ...who, reason: researcher === 'assisted' ? 'a message needs a text' : 'the ' + researcher + ' researcher learns only from what the world answers: it takes no ' + order.kind });
      } else log('operator_command_refused', { ...who, reason: 'unknown order ' + JSON.stringify(order.kind) });
    }
  }
  const heartbeat = setInterval(() => { pollInbox(); writeStatus(); }, 2000);
  heartbeat.unref?.();
  const print = options.print ?? (() => {});
  const say = (text: string): void => { if (!closed) print('[' + Math.round((Date.now() - started.getTime()) / 1000) + 's] ' + text); };
  let settleDiverged: (r: LabResult) => void = () => {};
  const diverged = new Promise<LabResult>((resolve) => { settleDiverged = resolve; });
  onDiverge = (d) => {
    log('diverged', { channel: d.channel, answers_still_waiting: d.pending });
    say('STOPPED: the resumed run diverged from ' + resumeFrom + ' (' + d.channel + ', ' + d.pending + ' logged answers still waiting); this journal stops here, the one it resumes is unchanged');
    const result = finish({ stoppedBy: 'diverged', halted: null }, {
      note: 'the resumed run asked something the run it resumes did not: the code or the configuration changed. This journal stops here; the one it resumes is unchanged.' });
    /* The loop left behind writes nothing more. */
    closed = true;
    settleDiverged(result);
  };
  /* Stopping: the caller's signal (Ctrl+C on the command line) and the budgets are asked before each question to System 2. */
  const halt = (): string | null => (pollInbox(), options.signal?.aborted || stopRequested) ? 'cancelled'
    : maxMinutes !== null && Date.now() - started.getTime() >= maxMinutes * 60000 ? 'time_budget'
    : maxTokens !== null && llmUse.tokens >= maxTokens ? 'token_budget' : null;

  /* An environment outside (SPEC-OBJETIVO O12): each request done once, by a key that is the same when the run is resumed
     (the run's lineage and the request's place in it), and what it answered logged like System 2's answers. */
  const external = !isGameLab(lab) && lab.external ? lab.external.url(worldOptionsOf(cfg)) : null;
  let effects: { request(route: string, body: unknown): Promise<unknown> } | undefined;
  if (external) {
    const lineage = previous?.effects_id ?? lab.id + ':' + started.toISOString();
    journal.effects_id = lineage;
    const envFetch = replay.wrap('env', network);
    let sequence = 0;
    effects = {
      async request(route, body) {
        const key = lineage + '#' + (++sequence);
        return (await fetchJson(external.replace(/\/$/, '') + route, { method: 'POST', body, headers: { 'Idempotency-Key': key }, fetch: envFetch,
          timeoutMs: 15000, retries: 3, retryNetwork: true })).data;
      }
    };
  }
  if (previous?.commit && commit && previous.commit !== commit) say('WARNING: resuming a run made from ' + previous.commit + ' with ' + commit + ': if the code changed what it asks, the replay diverges');
  const services = { cfg, options: worldOptionsOf(cfg), llm, llmUse, judge, codeRunner: () => nodeVmRunner({ timeoutMs: 2000 }), journal, log, say, halt };
  writeStatus();
  function finish(stop: { stoppedBy: string; halted: string | null }, end: Record<string, unknown>): LabResult {
      state = 'ended';
      stoppedBy = stop.stoppedBy;
      clearInterval(heartbeat);
      log('end', {
        stoppedBy: stop.stoppedBy, ...(stop.halted ? { halted: stop.halted, resume: 'the same command with --resume ' + outFile } : {}),
        /* OPERATOR ONLY (SPEC-OBJETIVO O11): answers replayed from the log and asked live; unused ones mean the resumed run diverged. */
        replay: replay.stats(),
        ...end
      });
      /* OPERATOR ONLY (SPEC-OBJETIVO O10): the finding, next to the journal, read as it was written. */
      const finding = findingOf(JSON.parse(JSON.stringify(journal)), { journal: path.basename(outFile) });
      const findingFile = outFile.replace(/\.json$/, '') + '.finding.json';
      fs.writeFileSync(findingFile, JSON.stringify(finding, null, 2));
      /* OPERATOR ONLY above; the researcher's view is what another agent is given (SPEC-OBJETIVO O14). */
      const researcherView = findingView(finding, 'researcher');
      const researcherFile = outFile.replace(/\.json$/, '') + '.finding.researcher.json';
      fs.writeFileSync(researcherFile, JSON.stringify(researcherView, null, 2));
      if (!closed) print(findingText(finding));
      say('finding ' + findingFile);
      if (replay.pending() && stop.stoppedBy !== 'diverged') say('WARNING: ' + replay.pending() + ' logged answers were never asked for again: the resumed run diverged from the first');
      return { stoppedBy: stop.stoppedBy, journal: outFile, findingFile, finding, researcherFile, researcher: researcherView, researcherUsed: researcher };
  }
  return { services, judge, llm, llmUse, replay, journal, outFile, commit, log, say, halt, ...(effects ? { effects } : {}), finish, diverged,
    operator: { take: () => waiting.splice(0, waiting.length) },
    sourceFetch: replay.wrap('source', sourceFetch(network)) };
}

/** The world's options, kept on the configuration under their own names (see runLab). */
const worldOptionsOf = (cfg: Record<string, unknown>): LabOptions => (cfg.__options ?? {}) as LabOptions;

/* ============================================================================
 * The loop of a laboratory whose model is a LAW (cells, messages, orbit).
 * ========================================================================== */

async function runLawLab(lab: LawLab, run: OpenRun, o: { cfg: LabRunConfig & Record<string, any>; worldOptions: LabOptions; ctx: LabContext; previous: Record<string, any> | null; resumeFrom: string | null; endings: readonly number[]; assistedAfter: number | null }): Promise<LabResult> {
  const { cfg, worldOptions, previous, resumeFrom, endings, assistedAfter } = o;
  /* Handed to the assisted researcher after some rounds: until then it is the unknown-world researcher, as it was. */
  let helping = assistedAfter === null;
  const ctx: LabContext = { ...o.ctx, ...(run.effects ? { effects: run.effects } : {}) };
  const { judge, llm, llmUse, replay, journal, outFile, log, say, halt } = run;
  if (assistedAfter !== null) journal.assisted_after_attempts = assistedAfter;
  const acts = lab.act && worldOptions.acts !== undefined ? Number(worldOptions.acts) : undefined;
  if (acts !== undefined) journal.config = { ...journal.config, acts };
  const tools: ReadonlySet<Tool> = new Set(cfg.tools as Tool[]);
  const investigative = cfg.tools.length > 0;
  /* The facet in force (SPEC-INVESTIGADOR-ASISTIDO §6.2): set at the start, changed by the operator in an assisted run. */
  let focus: string | null = (worldOptions.__focus as string | undefined) || null;
  let task: string | null = (worldOptions.__task as string | undefined) || null;
  const promptFor = (f: string | null) => system2Prompt(lab.interface({ regression: cfg.regression, ...(f ? { focus: f } : {}) }), tools);
  const SYSTEM_PROMPT = promptFor(focus);

  /* --- The world, as the operator knows it and as the learner perceives it ------------- */
  type Spec = unknown;
  type Point = unknown;
  type Case = LabCase<Point> & Record<string, unknown>;
  interface LabPlace extends Place { readonly spec: Spec }
  const spec: Spec = lab.generate(cfg.seed, worldOptions);
  const places = new Map<string, LabPlace>();
  const start = lab.places ? lab.places(spec, ctx) : {
    laboratories: [{ id: 'lab1', spec }],
    family: Array.from({ length: cfg.family }, (_, j) => ({ id: 'place' + (j + 1), spec: lab.placeOf(spec, j + 1, worldOptions) }))
  };
  for (const p of start.laboratories) places.set(p.id, { ...p, role: 'laboratory', seen: true });
  for (const p of start.family) places.set(p.id, { ...p, role: 'family', seen: false });
  const labs = () => [...places.values()].filter((p) => p.role === 'laboratory');

  const world = lab.world();
  const runner = nodeVmRunner({ timeoutMs: 2000 });
  const observer = new Observer<Point>(world, { kinds: ['code'], runners: [runner], perceive: (s) => lab.perceive(s) });
  const evaluator = new Evaluator<Point>(observer, judge, { maximizer: 'nature', runners: [runner] });
  /* An answer as given, and as compared with what happened (Lab.compare; by default the same). */
  const predictor = new Predictor<Point, unknown>(evaluator, (s) => lab.perceive(s), { runners: [runner], ...(lab.compare ? { answer: (a: unknown, s: Point) => lab.compare!(a, s) } : {}) });

  /* A truth only where the world was written by someone (optional: nothing but the grade depends on it). */
  const truth = lab.truth?.(spec, worldOptions) ?? null;
  Object.assign(journal.hidden_from_the_learner, { spec, ...(truth ? { truth } : {}), ...(lab.operator?.hidden?.(spec, ctx) ?? {}),
    places: [...places.values()].map((p) => ({ id: p.id, role: p.role, ...lab.placeInfo(p.spec) })) });
  /* --- The learner's episodes ------------------------------------------------------------ */
  interface StoredEpisode { readonly id: string; readonly place: string; readonly round: number; readonly by: string; readonly data: unknown }
  const episodes = new Map<string, StoredEpisode>();
  let counter = 0;
  const store = (id: string, place: LabPlace, round: number, by: string, data: unknown) => { const e = { id, place: place.id, round, by, data }; episodes.set(id, e); return e; };
  const episodeIndex = () => [...episodes.values()].map((e) => ({ episode: e.id, place: e.place, round: e.round, by: e.by, ...(lab.indexInfo?.(e.data) ?? {}), steps: lab.steps(e.data) }));

  /** "ep3@5": the point at step 5 of ep3, with what is shown there. */
  const resolve = (ref: string): { state: Point; shown: Record<string, unknown> } | null => {
    const m = /^([a-z][a-z0-9-]*)@(\d+)$/.exec(ref.trim());
    const e = m ? episodes.get(m[1]) : undefined;
    return m && e ? lab.at(e.data, Number(m[2])) : null;
  };
  const specOf = (placeId: string): Spec => places.get(placeId)?.spec ?? spec;
  const ownEpisodes = () => [...episodes.values()].filter((e) => e.by === 'you' || e.by === 'the environment');
  const ownPoints = (): Case[] => ownEpisodes().flatMap((e) => lab.cases(specOf(e.place), e.id, e.data, lab.ownEvery));
  const checkPoints = new Map<number, Case[]>();

  const explore = async (): Promise<void> => {
    const rnd = mulberry32(lab.explorationSeed(cfg.seed, worldOptions));
    const drawn: { place: string; episode: unknown }[] = [];
    if (lab.explore) drawn.push(...await lab.explore(labs().map((p) => ({ id: p.id, spec: p.spec })), rnd, cfg.explore, ctx));
    else for (let k = 0; k < cfg.explore; k++) drawn.push({ place: 'lab1', episode: await lab.episode(places.get('lab1')!.spec, rnd, ctx) });
    for (const d of drawn) {
      const e = store('ep' + (++counter), places.get(d.place)!, 0, 'the environment', d.episode);
      log('exploration_episode', { episode: e.id, ...lab.explored(e.data, d.place) });
    }
  };

  /* --- The objective and the protocol ------------------------------------------------------------ */
  const answerOf = async (law: Law, state: Point) => (await predictor.predict(law, state)).answer;
  const objective = lab.objective<Law, LabPlace>({
    async casesIn(place, c) {
      /* Fresh episodes in the place; a check's and a validation's become the learner's, a blind confirmation's never. */
      const drawn: unknown[] = [];
      if (lab.checkEpisodes) drawn.push(...await lab.checkEpisodes(place.spec, c, ctx));
      else {
        const rnd = mulberry32(cfg.seed * 7717 + c.round * 101 + c.index * 7 + (c.purpose === 'validation' ? 5000 : c.purpose === 'blind' ? 100000 * (1 + (c.set ?? 0)) : 0));
        for (let k = 0; k < cfg.checkEpisodes; k++) drawn.push(await lab.episode(place.spec, rnd, ctx));
      }
      const cases: Case[] = [];
      drawn.forEach((data, k) => {
        const id = c.purpose === 'blind' ? place.id + '-' + k : (c.purpose === 'check' ? 'check' : 'valid') + c.round + '-' + place.id + '-' + (k + 1);
        if (c.purpose !== 'blind') store(id, place, c.round, 'the ' + c.purpose + ' of round ' + c.round, data);
        cases.push(...lab.cases(place.spec, id, data, cfg.every));
      });
      if (c.purpose !== 'blind') checkPoints.set(c.round, [...(checkPoints.get(c.round) ?? []), ...cases]);
      return cases;
    },
    answer: (law, state) => answerOf(law, state),
    compared: async (law, state) => (await predictor.predict(law, state)).compared,
    focus: () => focus,
    episode: (id) => episodes.get(id)?.data,
    regression: cfg.regression
  }, worldOptions);
  /* What was asked, in the interface's words (the finding's question). */
  journal.objective = { answer: objective.answer.form, verdict: objective.verdictForm };
  let blindCounter = 0;
  const protocol = new Protocol(objective, {
    places: () => [...places.values()],
    blindPlaces: (set: number, round: number) => (lab.blindPlaces
      ? lab.blindPlaces(spec, set, round, ctx)
      : Array.from({ length: cfg.confirmPlaces }, () => { const k = ++blindCounter; return { id: 'blind' + k, spec: lab.placeOf(spec, 1000 + k, worldOptions) }; }))
      .map((p) => ({ ...p, role: 'confirmation' as const, seen: false })),
    fingerprint: (law) => lawFingerprint(law),
    validations: cfg.validations, pairedRegression: cfg.regression, quick: cfg.quick,
    cost: () => ({ jev_calls: judge.stats.calls, jev_not_asked: evaluator.stats.judgeUnread, llm_calls: llmUse.calls, llm_tokens: llmUse.tokens }),
    ...(lab.roleWords ? { roleWords: lab.roleWords } : {}),
    /* OPERATOR ONLY: models that know nothing. If one holds too, the check could not tell a model from knowing nothing. */
    baselines: lab.baselines(spec).map(({ name, source }) => ({ name, model: { world: world.id, observations: {}, rules: {}, weights: {}, output: { kind: 'code' as const, lang: 'js', source } } })),
    say
  });

  /* --- Instruments ------------------------------------------------------------------------ */

  /** A law must compute on points of the learner's own episodes and answer in the form asked (no Judge call). */
  const failures = (law: Law): string[] => {
    const points: Point[] = lab.trial ? ownEpisodes().slice(-4).flatMap((e) => lab.trial!.points(e.data)) : ownPoints().slice(-8).map((p) => p.state);
    const errors = replayOnEvidence(observer, law.observations, points.map((state) => ({ state }))).errors.slice(0, 4).map((e) => (e.observation ?? '') + ': ' + e.error);
    if (errors.length) return errors;
    const neutral = Object.fromEntries(Object.keys(law.rules).map((id) => [id, 0.5]));
    for (const p of points.slice(0, lab.trial?.answers ?? 4)) {
      try {
        const issue = lab.answerIssue(predictor.rawAnswerWith(law, predictor.measured(law, p), neutral));
        if (issue) return ['output: ' + issue];
      } catch (e) { return ['output: ' + String((e as Error).message ?? e)]; }
    }
    return [];
  };

  const runRequest = async (req: LawRequest<unknown>, budget: { acts: number }): Promise<unknown> => {
    /* A researcher's own instrument is answered by that researcher (the assisted one's library), never by the world. */
    if ('extra' in req) return { error: 'no such instrument here' };
    const kind = (['view', 'inspect', 'act', 'measure', 'simulate', 'table'] as const).find((k) => k in req)!;
    if (!tools.has(kind)) return { [kind]: (req as Record<string, unknown>)[kind], error: '"' + kind + '" is not available in this experiment' };
    if ('view' in req) {
      const e = episodes.get(req.view);
      if (!e) return { view: req.view, error: 'no such episode' };
      return { view: e.id, ...lab.view(e.data, Math.max(0, req.from), Math.max(0, req.to)) };
    }
    if ('act' in req) {
      if (!lab.act) return { act: req.act, error: '"act" is not available in this experiment' };
      if (budget.acts <= 0) return { act: req.act, error: 'no acts left this round' };
      const place = places.get(lab.act.place(req.act) ?? 'lab1');
      if (!place || place.role !== 'laboratory') return { act: req.act, error: 'you can act only in your laboratories: ' + labs().map((l) => l.id).join(', ') };
      const id = 'act' + (counter + 1);
      const data = await lab.act.start(place.spec, req.act, id, ctx);
      /* The environment answers only whether it accepted: never why not. */
      if (data === null) return { act: req.act, accepted: false };
      budget.acts--;
      counter++;
      const e = store(id, place, session.currentRound, 'you', data);
      return { act: req.act, accepted: true, name: e.id, ...lab.act.shown(e.data) };
    }
    if ('measure' in req) {
      const decl: MeasureDecl = { spec: { kind: 'code', lang: 'js', source: req.measure.source }, ...(req.measure.range ? { range: req.measure.range } : {}) };
      return { measure: req.measure.source, values: req.on.map((ref) => {
        const r = resolve(ref);
        if (!r) return { point: ref, error: 'no such point' };
        const o = observer.observe(r.state, { m: decl });
        const err = o.errors.find((e) => e.id === 'm');
        return err ? { point: ref, error: err.error } : { point: ref, value: o.values.m ?? o.texts.m };
      }) };
    }
    if ('inspect' in req) {
      const law = session.lawOf(req.law);
      const r = resolve(req.inspect);
      if (!law) return { inspect: req.inspect, error: 'there is no model yet: name a draft' };
      if (!r) return { inspect: req.inspect, error: 'no such point' };
      const f = typeof req.law === 'object' && req.law ? failures(law) : [];
      if (f.length) return { inspect: req.inspect, error: 'your draft failed on points of your episodes: ' + f.join(' | ') };
      try {
        /* A model taken apart: its rules are answered even when its output does not read them. */
        const pr = await predictor.predict(law, r.state, { askRules: true });
        return { inspect: req.inspect, your_observations_measured: pr.observations,
          ...(pr.evaluation ? { each_rule_answered: lab.present?.rules ? lab.present.rules(pr.rules) : pr.rules, V: pr.V } : { the_judge_was_not_asked: true }),
          your_answer: lab.present?.answer ? lab.present.answer(pr.answer) : pr.answer, ...(Object.keys(pr.parts).length ? { your_output_also_returned: pr.parts } : {}), ...r.shown };
      } catch (e) { return { inspect: req.inspect, error: String((e as Error).message ?? e) }; }
    }
    if ('simulate' in req) {
      if (!lab.simulate) return { simulate: req.simulate, error: '"simulate" is not available in this experiment' };
      const law = session.lawOf(req.law);
      const r = resolve(req.simulate);
      if (!law) return { simulate: req.simulate, error: 'there is no model yet: name a draft' };
      if (!r) return { simulate: req.simulate, error: 'no such point' };
      const cannot = lab.simulate.from?.(r.state) ?? null;
      if (cannot) return { simulate: req.simulate, error: cannot };
      const f = typeof req.law === 'object' && req.law ? failures(law) : [];
      if (f.length) return { simulate: req.simulate, error: 'your draft failed on points of your episodes: ' + f.join(' | ') };
      const [id, at] = req.simulate.split('@');
      const seen = episodes.get(id)!.data;
      let state = r.state;
      const steps: unknown[] = [];
      try {
        for (let k = 0; k < req.rows; k++) {
          const a = await answerOf(law, state);
          const next = lab.simulate.step(state, a, seen, Number(at) + k + 1);
          if (typeof next === 'string') return { simulate: req.simulate, error: next, steps };
          state = next.state;
          steps.push({ step: Number(at) + k + 1, ...next.shown });
        }
      } catch (e) { return { simulate: req.simulate, error: String((e as Error).message ?? e), steps }; }
      return { simulate: req.simulate, steps };
    }
    /* table: code on every point of its episodes or of the checks, with what is shown there - and, where the laboratory
       says so, what its latest model answered there. */
    const decl: MeasureDecl = { spec: { kind: 'code', lang: 'js', source: req.table.source }, ...(req.table.range ? { range: req.table.range } : {}) };
    const points = req.on === 'checks' ? [...checkPoints.values()].flat().slice(-60) : ownPoints().slice(-60);
    const latest = lab.residual ? session.latest()?.law ?? null : null;
    const rows: unknown[] = [];
    for (const p of points) {
      const o = observer.observe(p.state, { m: decl });
      const err = o.errors.find((e) => e.id === 'm');
      let residual: unknown;
      if (lab.residual) {
        residual = null;
        if (latest) {
          try { residual = lab.residual(p, (await predictor.predict(latest, p.state)).compared); } catch (e) { residual = { error: String((e as Error).message ?? e) }; }
        }
      }
      rows.push({ point: p.point, ...(err ? { error: err.error } : { value: o.values.m ?? o.texts.m }), ...lab.shown(p), ...(lab.residual ? { residual } : {}) });
    }
    return { table: req.table.source, on: req.on, ...(lab.residual ? { residuals_of: latest ? 'your latest model' : 'no model yet' } : {}), rows };
  };

  const sessionHost: import('../learn/law-session.ts').LawSessionHost<unknown> = {
    llm, system: SYSTEM_PROMPT, world: world.id, perceptDoc: lab.perceptDoc, steps: cfg.steps, investigative,
    ...(lab.act && tools.has('act') && acts !== undefined ? { acts } : {}),
    parseAct: lab.act ? (raw) => lab.act!.parse(raw) : () => 'act is not available in this experiment',
    ...(lab.act?.asWritten ? { actAsWritten: (a: unknown) => lab.act!.asWritten!(a) } : {}),
    runRequest: (r, budget) => runRequest(r, budget),
    known: (ref) => episodes.has(ref.trim()) || resolve(ref) !== null,
    failures,
    episodes: episodeIndex,
    places: () => protocol.placesView(), validationsLeft: () => protocol.validationsLeft, lastCheck: () => protocol.lastView,
    log, say, halt
  };
  /* The sources the assisted researcher may read (SPEC-INVESTIGADOR-ASISTIDO §6.3): the origins the operator allows, at the
     start and during the run. It reads them itself; the Judge picks lines for it only when it asks (`find` with `select`),
     and a --flat run has no Judge. What the Judge scored is the operator's (source_select). */
  const sources = new Sources({ allow: (worldOptions.__sources_allow as unknown as string[] | undefined) ?? [], fetch: run.sourceFetch,
    ...(cfg.flat ? {} : { selector: judgeSelector(judge) }), onSelect: (record) => log('source_select', { round: session.currentRound, ...record }) });

  /* The researcher that runs: the unknown-world one's session as it is, or the assisted one's (its own prompt, and the
     operator's messages with its questions; resuming, delivered again at the same questions). */
  const session: LawSession<unknown> = journal.researcher === 'assisted'
    ? assistedSession(sessionHost, {
      /* Before it is handed over, nothing of the assisted researcher's: its prompt is the unknown-world one, and a message
         sent meanwhile waits for its first new round. */
      take: () => (helping ? run.operator.take() : []), scheduled: deliveredMessages(previous),
      system: () => (helping ? assistedSystem(promptFor(focus)) : promptFor(focus)), task: () => (helping ? task : null),
      /* A focus is applied when it is delivered: the checks from here on are of the new facet, from a fresh stage. */
      onDeliver: (m, question) => {
        if (m.source) { sources.allow(m.source); log('sources_allowed', { question, origin: m.source }); }
        if (!m.focus) return;
        focus = m.focus.facet === 'all' ? null : m.focus.facet;
        if (m.focus.task) task = m.focus.task;
        protocol.restart();
        log('focus_changed', { question, facet: m.focus.facet, ...(m.focus.task ? { task: m.focus.task } : {}) });
      },
      sources
    })
    : new LawSession<unknown>(sessionHost);

  /* --- Operator only ------------------------------------------------------------------------- */
  const operatorContext: LabOperatorContext<Spec, Case> = {
    spec, ctx, ablation: cfg.ablation, predictor, observer, log, say, own: ownPoints,
    stats: () => ({ judge: judge.stats, evaluator: evaluator.stats })
  };

  /** The same model with every rule answering 0.5 (a Judge that knows nothing), on the same points: what the rules add,
      per place (the family's places are where a reader of meaning should matter). A laboratory may ablate its own way. */
  const ablations: AblationRecord[] = [];
  const ablate = async (law: Law, round: number, detail: unknown): Promise<void> => {
    const points = checkPoints.get(round) ?? [];
    if (lab.operator?.ablate) {
      const a = await lab.operator.ablate({ law, round, detail, cases: points }, operatorContext);
      if (a) ablations.push(a);
      return;
    }
    if (!Object.keys(law.rules).length) { log('operator_ablation_flat_judge', { round, note: 'the model has no rules: nothing is asked of the Judge' }); return; }
    const neutral = Object.fromEntries(Object.keys(law.rules).map((id) => [id, 0.5]));
    let model = 0, flat = 0;
    const byPlace: Record<string, { model: number; flat: number; points: number }> = {};
    for (const p of points) {
      const place = episodes.get(p.point.split('@')[0])?.place ?? 'lab1';
      const w = (byPlace[place] ??= { model: 0, flat: 0, points: 0 });
      w.points++;
      try { if (lab.agrees(await answerOf(law, p.state), p)) { model++; w.model++; } } catch { /* a miss */ }
      try { if (lab.agrees(predictor.rawAnswerWith(law, predictor.measured(law, p.state), neutral), p)) { flat++; w.flat++; } } catch { /* a miss */ }
    }
    ablations.push({ round, model, withoutJudge: flat, better: 'higher' });
    log('operator_ablation_flat_judge', { round, points: points.length, ['model_' + lab.agreement]: model, ['flat_judge_' + lab.agreement]: flat, by_place: byPlace });
    say('  [operator] ablation: model ' + model + '/' + points.length + ' ' + lab.agreement + ', every rule at 0.5: ' + flat + '/' + points.length);
  };

  const gradeRecovery = async (final: Law | null): Promise<void> => {
    if (!truth?.length || !lab.grading) return;
    const event = lab.grading.event ?? 'operator_rule_recovery';
    const brief = session.notebook.brief();
    const learned = { [lab.grading.finalKey ?? 'final_model']: final ? ownLaw(final) : null, beliefs: brief.beliefs_held, dropped: brief.beliefs_dropped, notes: brief.notes, reflections: session.notebook.reflections };
    try {
      const content = (await llm.complete({ system: lab.grading.system, user: JSON.stringify({ true_statements: truth, learner: learned }) })).content;
      const parsed = parseJsonLoose(content) as { grades?: { id: string; grade: string }[]; false_beliefs?: unknown[] } | null;
      const grades = (parsed?.grades ?? []).filter((g) => truth.some((t) => t.id === g.id));
      const score = Math.round(grades.reduce((n, g) => n + (g.grade === 'exact' ? 1 : g.grade === 'partial' ? 0.5 : 0), 0) / truth.length * 100) / 100;
      log(event, { truth, grades, false_beliefs: parsed?.false_beliefs ?? [], score, ...formOf(parsed as Record<string, unknown> | null), grader_model: journal.config.llm_model });
      say('operator: recovery ' + score + (grades.length ? ' (' + grades.map((g) => g.id + ':' + g.grade).join(' ') + ')' : ''));
    } catch (e) { log(event, { truth, error: String((e as Error).message ?? e) }); }
  };

  /* --- The run ------------------------------------------------------------------------------- */
  say(lab.id + ' seed ' + cfg.seed + ' ' + lab.headline(spec) + '; journal ' + outFile);
  log('start', { ...(lab.operator?.start?.(spec, ctx) ?? {}), ...(previous ? { resumed_from: resumeFrom, answers_logged: replay.pending() } : {}) });
  await explore();
  let accepted: { law: Law; round: number } | null = null;
  let satisfied: { law: Law; round: number } | null = null;
  if (endings.length) journal.continuations = [...endings];
  for (let attempt = 1; attempt <= cfg.attempts && !session.fatal && !session.halted; attempt++) {
    /* Where the run's history had an ending (it used up its rounds and was given more): that ending, as it was. */
    if (endings.includes(attempt - 1)) {
      if (cfg.reflection) { say('the ending of the run it continues (round ' + (attempt - 1) + '): its reflection'); await session.consult('reflect', reflectionTask(investigative)); }
      if (session.fatal || session.halted) break;
      if (cfg.grade) await gradeRecovery(session.latest()?.law ?? null);
      /* The rounds it was given then: up to the next ending of its history, or to now. */
      const to = endings.find((e) => e > attempt - 1) ?? cfg.attempts;
      log('budget_extended', { after_attempts: attempt - 1, to_attempts: to, round: session.currentRound });
      say('more rounds: ' + (attempt - 1) + ' → ' + to);
      if (assistedAfter === attempt - 1) {
        helping = true;
        log('researcher_switched', { to: 'assisted', after_attempts: attempt - 1, round: session.currentRound });
        say('from here on, the assisted researcher: the operator may help');
      }
    }
    const record = await session.consult('propose');
    if (!record) { if (session.fatal) break; continue; }
    const outcome = await protocol.round(record.law, { round: record.round, attempt, validate: record.validate });
    record.accepted = outcome.accepted;
    const detail = outcome.laboratories[0]?.detail ?? null;
    const own = lab.operator?.check?.({ law: record.law, round: record.round, reused: outcome.reused, detail, cost: outcome.cost,
      cases: checkPoints.get(outcome.reused ?? record.round) ?? [] }, operatorContext) ?? {};
    if (own.test) record.test = own.test;
    log('check', { ...outcome.journal, jev: { calls: judge.stats.calls, errors: judge.stats.errors }, ...(own.journal ?? {}) });
    if (own.say) say(own.say);
    if (outcome.accepted) say('  ACCEPTED');
    if (outcome.quickStop) {
      satisfied = { law: record.law, round: record.round };
      log('quick_stop', { round: record.round, held_in_laboratories: Object.fromEntries(outcome.laboratories.map((o) => [o.place.id, o.holds])), law: ownLaw(record.law) });
      say('  --quick: System 2 judges its model good in round ' + record.round + ' (in its laboratories: ' + (outcome.held ? 'holds' : 'does NOT hold') + ')');
      break;
    }
    if ((cfg.ablation || lab.operator?.ablates?.(worldOptions)) && outcome.reused === null) await ablate(record.law, record.round, detail);
    if (outcome.accepted) { accepted = { law: record.law, round: record.round }; log('accepted', { round: record.round }); break; }
  }
  if (cfg.reflection && !session.fatal && !session.halted) {
    say('reflection round: the model is final; System 2 looks back');
    await session.consult('reflect', reflectionTask(investigative));
  }
  const final = accepted?.law ?? session.latest()?.law ?? null;
  if (cfg.grade && !session.fatal && !session.halted) await gradeRecovery(final);
  const result = run.finish({ stoppedBy: session.fatal ? 'llm_error' : accepted ? 'accepted' : satisfied ? 'quick_stop' : session.halted ?? 'budget', halted: session.halted }, {
    ...(session.fatal ? { llm_error: session.fatal } : {}),
    final: final ? ownLaw(final) : null,
    places: [...places.values()].map((p) => ({ id: p.id, role: p.role, seen: p.seen, ...lab.placeInfo(p.spec) })),
    notebook: session.notebook, episodes: episodeIndex(),
    jev: { calls: judge.stats.calls, errors: judge.stats.errors },
    ...(lab.operator?.end?.(session.laws.map((l) => ({ round: l.round, fingerprint: l.fingerprint, test: l.test })), operatorContext) ?? {}),
    /* OPERATOR ONLY (SPEC-OBJETIVO O4): milestones and cost of the run. */
    operator_summary: operatorSummary(protocol.summary(), ablations)
  });
  say('done: ' + (session.halted && !accepted ? 'stopped (' + session.halted + '); resume with --resume ' + outFile + '; ' : '') + (accepted ? 'accepted in round ' + accepted.round : satisfied ? 'stopped by --quick in round ' + satisfied.round : 'not accepted') + '; journal ' + outFile);
  return result;
}

/** An agents' policy: `<id>=<kind>,<kind>;<id>=...`, as the agents and the orders each may send. */
export function parseAgentPolicy(text: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const part of text.split(';').map((p) => p.trim()).filter(Boolean)) {
    const [id, kinds] = part.split('=');
    if (!id || !kinds) throw new LabError('--agents: "' + part + '" is not <id>=<kind>,<kind>');
    const set = new Set(kinds.split(',').map((k) => k.trim()).filter(Boolean));
    for (const k of set) if (!['message', 'focus', 'source', 'stop'].includes(k)) throw new LabError('--agents: unknown order ' + k + ' (message, focus, source, stop)');
    out.set(id.trim().replace(/^agent:/, ''), set);
  }
  return out;
}

/** System 2's tuning from the environment, for models that need it: LLM_TIMEOUT_MS, LLM_JSON_MODE (0 or false: off),
    LLM_MAX_TOKENS, LLM_TEMPERATURE, LLM_EXTRA_BODY (a JSON object added to the request's body, e.g.
    {"chat_template_kwargs": {"reasoning_effort": "medium"}, "top_p": 0.95, "top_k": 20}). None set: nothing changes. */
export function llmTuning(env: NodeJS.ProcessEnv): Pick<LabConnection, 'timeoutMs' | 'jsonMode' | 'maxTokens' | 'temperature' | 'extraBody'> {
  const n = (v: string | undefined) => (v && Number(v) > 0 ? Number(v) : undefined);
  const timeoutMs = n(env.LLM_TIMEOUT_MS), maxTokens = n(env.LLM_MAX_TOKENS);
  const json = env.LLM_JSON_MODE;
  const t = env.LLM_TEMPERATURE;
  const temperature = t !== undefined && t !== '' && Number.isFinite(Number(t)) && Number(t) >= 0 ? Number(t) : undefined;
  if (t !== undefined && t !== '' && temperature === undefined) throw new LabError('LLM_TEMPERATURE must be a number from 0');
  let extraBody: Record<string, unknown> | undefined;
  if (env.LLM_EXTRA_BODY) {
    try { extraBody = JSON.parse(env.LLM_EXTRA_BODY); } catch (e) { throw new LabError('LLM_EXTRA_BODY is not JSON: ' + String((e as Error).message ?? e)); }
    if (!extraBody || typeof extraBody !== 'object' || Array.isArray(extraBody)) throw new LabError('LLM_EXTRA_BODY must be a JSON object');
  }
  return { ...(timeoutMs ? { timeoutMs } : {}), ...(maxTokens ? { maxTokens } : {}), ...(json !== undefined && json !== '' ? { jsonMode: !/^(0|false|no|off)$/i.test(json) } : {}),
    ...(temperature !== undefined ? { temperature } : {}), ...(extraBody ? { extraBody } : {}) };
}

/** What the journal keeps of System 2's tuning (the model's behaviour depends on it): only what was set. */
function llmTuningRecord(c: LabConnection): Record<string, unknown> {
  const t = { ...(c.temperature !== undefined ? { temperature: c.temperature } : {}), ...(c.extraBody ? { extra_body: c.extraBody } : {}),
    ...(c.jsonMode !== undefined ? { json_mode: c.jsonMode } : {}), ...(c.maxTokens ? { max_tokens: c.maxTokens } : {}), ...(c.timeoutMs ? { timeout_ms: c.timeoutMs } : {}) };
  return Object.keys(t).length ? { llm_tuning: t } : {};
}
