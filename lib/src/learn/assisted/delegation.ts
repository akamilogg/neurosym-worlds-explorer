import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Experience } from './experience.ts';
import { searchReader } from '../evolve/experience.ts';
import { EXPORTED_AT_MOST, type SearchManifest } from '../evolve/engine.ts';

/* ============================================================================
 * DELEGATING AN INVESTIGATION FROM ANOTHER (SPEC-DELEGACION-INVESTIGACIONES): a researcher opens a BRANCH to investigate a
 * question and gets its work back. The branch is the general (assisted) investigator, in a run of its own: its task the
 * question, the requester's record readable as experience from a cut fixed when the request was accepted, its own
 * laboratory (the same world in an instance of its own), a fund apart from the requester's budget. The requester goes on
 * meanwhile; when the branch ends, its result reaches it as a message - a delegated contribution, never an order nor an
 * answer of the world.
 *
 *   {"delegate": {"question": "...", "refs": ["model:r4", ...], "expected": "...", "budget": {"rounds": 3, "tokens": N}}}
 *   {"delegation": {"id": "<id>", "status": true}}            its state, what it spent
 *   {"delegation": {"id": "<id>", "read": {<an experience request: list | open | find>}}}   its record, as it stands
 *   {"delegation": {"id": "<id>", "cancel": true}}
 *
 * First delivery: one branch active per requester, no branch delegating in turn, worlds of the common loop whose
 * laboratory is its own (not an environment outside the harness).
 * ========================================================================== */

export interface DelegationConfig {
  /** The fund, in tokens of System 2, for every branch of the run: apart from its own budget, within its total cost. */
  readonly fund: number;
  /** At most per branch: tokens and rounds; and the rounds a branch gets when it asks none. */
  readonly tokens: number;
  readonly rounds: number;
  readonly maxRounds: number;
  /** A branch may be an evolutionary search (SPEC-DELEGACION-EVOLUTIVA): at most this many evaluations, and the workloads
      of each laboratory family in one. Absent, the mode is not enabled. */
  readonly evolve?: { readonly evaluations: number; readonly workloads: number;
    /** Seconds of the machine and of the clock a branch may take (its evaluations; the whole branch). */
    readonly machineSeconds?: number; readonly wallSeconds?: number;
    /** Whether a branch requires a sandbox that isolates files and network: refused where there is none. */
    readonly isolated?: boolean;
    /** Seeds (§8): at most `max` a branch, from the sources the operator authorized. Absent, a request with seeds is refused. */
    readonly seeds?: { readonly max: number; readonly sources: readonly ('own' | 'experience' | 'searches')[] } };
}

/** What an evolutionary request may carry, and what is of a capability not implemented in this delivery (§16, H4):
    refused before anything is spent - never accepted to be ignored. */
const EVOLVE_FIELDS = new Set(['mode', 'question', 'start', 'continue_from', 'refs', 'expected', 'budget', 'seeds']);
const NOT_IMPLEMENTED = new Set(['analogies', 'analogy', 'profile', 'descriptors', 'models', 'mutator', 'islands', 'novelty']);
const BUDGET_FIELDS = new Set(['evaluations', 'tokens', 'rounds']);

/** What the search part of an evolutionary branch may spend of its grant; the rest is the consolidation's, protected (§12). */
const SEARCH_SHARE = 0.75;
/** The requester's record in a branch's experience: after the runs it reads (which keep their labels), the next label. */
export const cutLabel = (experience: readonly string[] | undefined): string => 'exp' + ((experience ?? []).length + 1);
/** The evaluations of an evolutionary branch protected for confirming what it exports (§5). */
const confirmShare = (evaluations: number): number => (evaluations >= 2 ? Math.min(EXPORTED_AT_MOST, Math.max(1, Math.floor(evaluations / 4))) : 0);

/** How a branch is started: a run of the laboratory `lab` with `args`, writing `journal` (a process of its own, or - in
    tests - the same process). */
export type Launcher = (o: { readonly journal: string; readonly lab: string; readonly args: readonly string[]; readonly evolve?: string }) => void | { readonly pid?: number } | Promise<void | { readonly pid?: number }>;

/** Whether a process is alive (a signal 0 asks the system without touching it). */
function processAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !(pid > 0)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string }).code === 'EPERM'; }
}

type J = Record<string, any>;
const readJson = (f: string): J | null => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const endOf = (j: J | null): J | null => (j ? [...(j.events ?? [])].reverse().find((e: J) => e.type === 'end') ?? null : null);

interface Branch {
  readonly id: string;
  readonly round: number;
  readonly question: string;
  /** Its record: a shared branch resumed writes a record of its own, derived from it. */
  journal: string;
  readonly granted: { readonly rounds: number; readonly tokens: number };
  state: 'accepted' | 'running' | 'completed' | 'failed' | 'cancelled';
  /** In a living world (SPEC-ACONTECIMIENTOS-DEL-MUNDO §12): a realization of its own, or a member of the requester's. */
  world?: { readonly mode: 'isolated' | 'shared'; readonly actor?: string };
  spent: number | null;
  delivered: boolean;
  /** Why it failed, when it did not end by itself (its process stopped, it never started). */
  why?: string;
  /** Its process, when its launch told it. */
  pid?: number;
  /** What it spent is not known: what its record showed (at least, all that was observed), and what the fund holds for it
      (its grant - held, never a bound on its spending: the limit is checked between calls, and a call may pass it). */
  uncertain?: Uncertain;
  /** An evolutionary search (its supervisor's record), not a run of the general investigator. */
  mode?: 'evolve';
}

/** A spending not known: observed at least, and held in the fund. */
type Uncertain = { readonly at_least: number; readonly held: number };

/** A branch's spending as its requester reads it, wherever it reads it (its status, its report): what it spent, or - not
    known - nothing as spent, what was observed and what the fund holds for it said apart. */
const spendingOf = (b: Branch): { spent_tokens: number | null; spent_not_known?: { observed_at_least: number; held_in_the_fund: number } } =>
  b.uncertain ? { spent_tokens: null, spent_not_known: { observed_at_least: b.uncertain.at_least, held_in_the_fund: b.uncertain.held } } : { spent_tokens: b.spent };

/** A branch's result as delivered: its spending as observed, and when not known, said so. */
type Result = { id: string; text: string; research_result: string; result_state: string; result_spent: number | null; result_spent_uncertain?: Uncertain };

/** A run's heartbeat older than this: its process is no longer alive (as control.ts reads it). */
const STALE_MS = 15000;
/** How long a branch launched may take to write its first record before it is taken as never started. */
const START_GRACE_MS = 60000;

/** What the senior is told of the tool: the same delegation, from its own reading; the result comes to it. */
export const SENIOR_DELEGATION_SECTION = (c: DelegationConfig): string => 'DELEGATING AN INVESTIGATION. Among your readings you may open a BRANCH: another researcher, with the junior\'s record readable as it stands when you ask, its own laboratory in this same world and its own budget, investigates a question of yours: {"delegate": {"question": "...", "refs": ["optional: items of the junior\'s record"], "expected": "optional", "budget": {"rounds": <n>, "tokens": <n>}}}; {"delegation": {"id": "<id>", "status": true}}, {"delegation": {"id": "<id>", "read": {"experience": "list" | "open" | "find", ...}}} or {"delegation": {"id": "<id>", "cancel": true}}. Its result comes to YOU, at a later call (`branch_results`): a contribution, never evidence until it is tested; what reaches the junior is what you make of it, in your own message. One branch of yours at a time; the fund is ' + c.fund + ' tokens, at most ' + c.tokens + ' tokens and ' + c.maxRounds + ' rounds a branch; each request costs one of your readings.';

/** What the researcher is told of the tool, in its system (from its first question, under the capability `delegation`). */
export const DELEGATION_SECTION = (c: DelegationConfig): string => [
  'DELEGATING AN INVESTIGATION. You may open a BRANCH: another researcher, with your record readable as it stands when you ask, its own laboratory in this same world, and its own budget, investigates a question of yours while you go on. Generating or questioning hypotheses, exploring an anomaly, testing an assumption or a rival explanation: any question you can investigate. Inside "investigate":',
  '  {"delegate": {"question": "what to investigate - the branch knows nothing else of your intent", "refs": ["optional: items of your record to start from, e.g. model:r4, note:<id>"], "expected": "optional: what you want back", "budget": {"rounds": <n>, "tokens": <n>}}}',
  '  It answers at once whether it was accepted, with its id and what it was given; its result comes to you later as a message (`research_result`) with its findings, the directions it proposes and what tells them apart, its evidence and its uncertainties - a contribution, never an order: take what serves you, test it with your instruments. {"delegation": {"id": "<id>", "status": true}} says how it goes; {"delegation": {"id": "<id>", "read": {"experience": "list" | "open" | "find", ...}}} reads its record as you read experience; {"delegation": {"id": "<id>", "cancel": true}} stops it.',
  '  One branch at a time. The fund for branches is ' + c.fund + ' tokens in all, at most ' + c.tokens + ' tokens and ' + c.maxRounds + ' rounds a branch (' + c.rounds + ' when you ask none); each request costs a step of yours, the branch\'s work is counted apart.',
  ...(c.evolve ? ['  A branch may also be an EVOLUTIONARY SEARCH: {"delegate": {"mode": "evolve", "question": "...", "start": "optional: a version of yours (default: your latest)", "budget": {"evaluations": <at most ' + c.evolve.evaluations + '>, "tokens": <n>, "rounds": <n>}' + (c.evolve.seeds ? ', "seeds": ["optional, at most ' + c.evolve.seeds.max + ': ' + c.evolve.seeds.sources.map((x) => x === 'own' ? 'artifact:<a version of yours>' : x === 'searches' ? 'search:<a sealed search of yours>#candidate:<program>' : 'exp:<label>#artifact:<a version of a run you read>').join(' | ') + '"]' : '') + '}}. It tries many transformations of programs, runs each on exploration workloads, keeps alternatives and goes on from them; then a researcher consolidates what it found. Its result: candidates whole (adopt one with a change of yours, then your checks), what was measured of each, why to look at each again, and a sealed search you may continue: {"delegate": {"mode": "evolve", "continue_from": "<its hash>", "question": "..."}}.'] : [])
].join('\n');

export class Delegations {
  private readonly branches: Branch[] = [];
  private reserved = 0;
  private spentAll = 0;
  private readonly perRound = new Map<number, number>();
  /* What its record answered to each of its requests, in order, with what it logged then: a resumed run asks them again, and
     is answered as it was - nothing launched again, nothing read of a branch's files that changed since. */
  private readonly answered: { round: number; request: string; answer: Record<string, unknown>; events: J[] }[] = [];
  private readonly o: {
    readonly config: DelegationConfig;
    /** The requester's journal file, and its journal as it stands (for the cut). */
    readonly journalFile: string;
    snapshot(): J;
    /** The laboratory's key, and the arguments of its world (seed, options, Judge) a branch is run with. */
    readonly lab: string;
    readonly worldArgs: readonly string[];
    readonly launcher: Launcher;
    log(type: string, data: Record<string, unknown>): void;
    /** The events of the run it resumes: its requests answered as they were, its branches as they ended. */
    readonly history: readonly J[];
    /** The folder of the record those events were written in (a run resumed in another folder): their paths are relative to
        it. By default, this run's own folder. */
    readonly historyDir?: string;
    /** Why a branch cannot be opened in this world at all (an environment outside the harness), or null. */
    readonly unsupported: string | null;
    /** A living world's (SPEC-ACONTECIMIENTOS-DEL-MUNDO §12): the modes the run allows; an isolated branch's realization - the
        world now, written for it, and the arguments that start it there; a shared branch, a member of this world started in
        this process (or resumed from its record), or why not. */
    readonly living?: {
      readonly modes: readonly ('isolated' | 'shared')[];
      fork(file: string, randomness: 'same' | 'fresh', by: string): { readonly args: readonly string[]; readonly revision: number; readonly tick: number };
      join(o: { readonly id: string; readonly actor: string; readonly journal: string; readonly args: readonly string[]; readonly resume: string | null; readonly stopAs?: string }):
        { readonly journal: string; readonly done: Promise<unknown> } | string;
    };
    /** The runs the requester reads as experience (their files, in its order): a branch reads them too, under the same
        labels - access to the same resources, never a summary of them. */
    readonly experience?: readonly string[];
    /** An evolutionary branch's world and where it starts: present only where the world has an evaluator (artifacts). */
    readonly evolve?: {
      readonly seed: number;
      readonly options: Readonly<Record<string, string>>;
      /** Whether its world's sandbox isolates files and network. */
      readonly isolated: boolean;
      /** A program of the requester's by its name (or its latest, when none is named), by its content. */
      resolveStart(start: string | undefined): { hash: string; files: Readonly<Record<string, string>> } | { error: string };
      /** A version of a run it reads as experience (its label, the version's name), by its content. */
      resolveExperience?(label: string, version: string): { hash: string; files: Readonly<Record<string, string>> } | { error: string };
    };
    /** The fund's ledger, shared by every requester of the run (its junior and its senior): one fund, never one each. */
    readonly ledger?: string;
    /** Who asks, in that ledger. */
    readonly requester?: string;
    /** Whether this requester opens the fund (the run that begins the lineage): its ledger written once, so that a ledger
        missing afterwards is a loss for every requester - never a fresh fund. */
    readonly opens?: boolean;
    /** The clock and its thresholds (tests). */
    now?(): number;
    readonly staleMs?: number;
    readonly startGraceMs?: number;
  };
  /* Branches its record asked for and never saw answered (a stop between the two): reconciled before anything else is decided. */
  private readonly unconfirmed = new Set<string>();

  constructor(o: Delegations['o']) {
    this.o = o;
    if (o.ledger && o.opens && !fs.existsSync(o.ledger) && !o.history.some((e) => e.type === 'delegation_requested')) {
      fs.mkdirSync(path.dirname(o.ledger), { recursive: true });
      fs.writeFileSync(o.ledger, JSON.stringify({ at: new Date().toISOString(), opened: o.config.fund, by: o.requester ?? 'junior' }) + '\n');
    }
    /* A run resumed: its branches as its record left them - opened by its requests, ended by the results delivered to it. */
    let pending: J[] = [];
    for (const e of o.history) {
      if (e.type === 'delegation_requested') {
        this.branches.push({ id: e.id, round: e.round, question: e.question, journal: path.resolve(o.historyDir ?? path.dirname(o.journalFile), e.journal), granted: e.granted, state: 'running', spent: null, delivered: false,
          ...(e.mode === 'evolve' ? { mode: 'evolve' as const } : {}), ...(e.world ? { world: e.world } : {}) });
        this.reserved += Number(e.granted?.tokens) || 0;
        this.perRound.set(e.round, Math.max(this.perRound.get(e.round) ?? 0, Number(String(e.id).split('.').pop()) || 0));
      }
      if (e.type === 'delegation_state') { const b = this.branches.find((x) => x.id === e.id); if (b) { b.state = e.state; if (typeof e.pid === 'number') b.pid = e.pid; if (typeof e.journal === 'string') b.journal = path.resolve(o.historyDir ?? path.dirname(o.journalFile), e.journal); this.restore(b, e.spent, e.uncertain); } }
      if (e.type === 'delegation_requested' || e.type === 'delegation_state' || e.type === 'delegation_cancel_asked') pending.push(e);
      if (e.type === 'delegation_answered') { this.answered.push({ round: e.round, request: e.request, answer: e.answer, events: pending }); pending = []; }
      if (e.type === 'delegation_answered') for (const p of this.answered[this.answered.length - 1].events) if (p.type === 'delegation_requested') this.unconfirmed.delete(p.id);
      if (e.type === 'delegation_requested') this.unconfirmed.add(e.id);
      if (e.type === 'delegation_state' && e.reconciled) this.unconfirmed.delete(e.id);
      /* A senior's: the results it was given at one of its calls. */
      if (e.type === 'branch_result_given') { const b = this.branches.find((x) => x.id === e.id); if (b) { b.delivered = true; b.state = e.state ?? 'completed'; this.restore(b, e.spent, e.uncertain); } }
      if (e.type === 'operator_message') for (const m of (e.messages ?? []) as J[]) if (m.research_result) {
        const b = this.branches.find((x) => x.id === m.research_result);
        if (b) { b.delivered = true; b.state = m.result_state ?? 'completed'; this.restore(b, m.result_spent, m.result_spent_uncertain); }
      }
    }
  }

  /** What it was observed to spend: what it spent, or - not known - what its record showed at least. */
  private observed(b: Branch): number | null { return b.uncertain ? b.uncertain.at_least : b.spent; }

  /** A settlement as its record gives it - a spending observed, and when not known, what the fund held for it (a record of an
      earlier version gave the amount held as its spending, with the least observed). */
  private restore(b: Branch, spent: unknown, u?: J): void {
    if (u && typeof u.at_least === 'number') { const held = typeof u.held === 'number' ? u.held : Number(spent) || b.granted.tokens; this.settle(b, held, false, { at_least: u.at_least, held }); }
    else if (typeof spent === 'number') this.settle(b, spent);
  }

  static accepts(q: Record<string, unknown>): boolean { return q !== null && typeof q === 'object' && ('delegate' in q || 'delegation' in q); }

  fundLeft(): number {
    if (!this.o.ledger) return Math.max(0, this.o.config.fund - this.spentAll - this.reserved);
    const t = this.ledgerNow();
    return 'problem' in t ? 0 : Math.max(0, this.o.config.fund - t.spent - t.reserved);
  }

  /** The fund as its ledger keeps it - or why it cannot be known: a ledger unreadable, or missing where this requester's own
      record has branches (a fresh fund is a ledger absent with nothing booked yet). Never taken as nothing spent. */
  private ledgerNow(): { reserved: number; spent: number } | { problem: string } {
    const read = ledgerOf(this.o.ledger!);
    if ('problem' in read) return read;
    if (read.absent) return { problem: 'its ledger is missing (' + path.basename(this.o.ledger!) + '): what every requester of the run booked is not known' };
    if (!read.entries.some((e) => e.opened !== undefined)) return { problem: 'its ledger was not opened by its run (' + path.basename(this.o.ledger!) + ')' };
    return ledgerTotals(read.entries);
  }

  private key(id: string): string { return (this.o.requester ?? 'junior') + '|' + id; }

  private book(entry: Record<string, unknown>): void {
    if (!this.o.ledger) return;
    fs.mkdirSync(path.dirname(this.o.ledger), { recursive: true });
    fs.appendFileSync(this.o.ledger, JSON.stringify({ at: new Date().toISOString(), requester: this.o.requester ?? 'junior', ...entry }) + '\n');
  }

  private active(): Branch | undefined { return this.branches.find((b) => b.state === 'accepted' || b.state === 'running'); }

  /** Seeds by their ids in the run's catalog (§8), each from a source the operator authorized, by its content:
        artifact:<version>                          a version of the requester's
        search:<sealed hash>#candidate:<program>    a candidate of a sealed search of an evolutionary branch of its own
        exp:<label>#artifact:<version>              a version of a run it reads as experience
      Any that cannot be taken refuses the request: never a seed silently left out. */
  private seedsOf(raw: unknown): { seeds: J[] } | { error: string } {
    const allowed = this.o.config.evolve?.seeds;
    if (!allowed) return { error: 'not enabled in this run' };
    if (!Array.isArray(raw) || !raw.length || !raw.every((x) => typeof x === 'string')) return { error: 'ids of the run\'s catalog, e.g. "artifact:<version>", "search:<hash>#candidate:<program>", "exp:<label>#artifact:<version>"' };
    if (raw.length > allowed.max) return { error: 'at most ' + allowed.max + ' a branch' };
    const out: J[] = [];
    for (const id of raw as string[]) {
      const own = /^artifact:(.+)$/.exec(id), search = /^search:([^#]+)#candidate:(.+)$/.exec(id), exp = /^exp:([^#]+)#artifact:(.+)$/.exec(id);
      const source = own ? 'own' : search ? 'searches' : exp ? 'experience' : null;
      if (!source) return { error: 'no such id "' + id + '"' };
      if (!allowed.sources.includes(source as 'own')) return { error: 'its source (' + source + ') is not authorized in this run: "' + id + '"' };
      let got: { hash: string; files: Readonly<Record<string, string>> } | { error: string };
      if (own) got = this.o.evolve!.resolveStart(own[1]);
      else if (search) {
        const m = this.branches.filter((x) => x.mode === 'evolve').map((x) => readJson(evolveFiles(x.journal).manifest) as SearchManifest | null).find((x) => x?.hash === search[1]);
        const c = m?.state.candidates[search[2]];
        got = !m ? { error: 'no sealed search ' + search[1] + ' of yours' } : !c ? { error: 'no candidate ' + search[2] + ' in it' } : { hash: c.hash, files: c.files };
      } else got = this.o.evolve!.resolveExperience ? this.o.evolve!.resolveExperience(exp![1], exp![2]) : { error: 'no run read as experience' };
      if ('error' in got) return { error: got.error + ' ("' + id + '")' };
      /* Every source here worked on this same task: what it knew is declared with it. */
      out.push({ id, source: own ? 'requester' : search ? 'search' : 'experience', hash: got.hash, files: got.files, knows_task: true });
    }
    return { seeds: out };
  }

  /** Its cost settled: the reservation released, what it spent kept (in the shared ledger too, once). */
  private settle(b: Branch, spent: number, live = false, uncertain?: Uncertain): void {
    if (b.spent !== null) return;
    b.spent = spent;
    if (uncertain) b.uncertain = uncertain;
    this.reserved = Math.max(0, this.reserved - b.granted.tokens);
    this.spentAll += spent;
    if (!live || !this.o.ledger) return;
    const read = ledgerOf(this.o.ledger);
    if (!('problem' in read) && !read.entries.some((e) => keyOf(e) === this.key(b.id) && e.settle !== undefined)) this.book({ id: b.id, settle: spent, ...(uncertain ? { uncertain: true, at_least: uncertain.at_least, held: uncertain.held } : {}) });
  }

  /** A branch that did not end by itself: never started (nothing spent), or stopped (its spending not known: its grant held in
      the fund, what was observed kept apart). */
  private fail(b: Branch, l: { state: string; why: string; spent: number }): void {
    b.state = 'failed';
    b.why = l.why;
    if (l.state === 'never') this.settle(b, 0, true);
    else this.settle(b, b.granted.tokens, true, { at_least: l.spent, held: b.granted.tokens });
  }

  /** A branch its record asked for and never saw answered: running if its record exists, otherwise never started - said so,
      and its reservation released. Never launched again: its requester may ask again. */
  private reconcile(): void {
    for (const id of [...this.unconfirmed]) {
      this.unconfirmed.delete(id);
      const b = this.branches.find((x) => x.id === id);
      if (!b || b.state !== 'running') continue;
      const l = this.liveness(b);
      if (l.state === 'alive' || l.state === 'starting' || l.state === 'ended') { this.o.log('delegation_state', { id, state: 'running', reconciled: true, why: l.why }); continue; }
      this.fail(b, l);
      this.o.log('delegation_state', { id, state: 'failed', reconciled: true, why: l.why, spent: this.observed(b), ...(b.uncertain ? { uncertain: b.uncertain } : {}) });
    }
  }

  /** How a branch's run stands, by its record and its heartbeat - never by a file's existence alone: ended; alive (its
      heartbeat fresh); starting (no record yet, within the grace of a launch); dead (its record without an end, its heartbeat
      stopped); never (no record, the grace past). */
  private liveness(b: Branch): { state: 'ended' | 'alive' | 'starting' | 'dead' | 'never'; why: string; spent: number } {
    const now = this.o.now?.() ?? Date.now();
    const stale = this.o.staleMs ?? STALE_MS, grace = this.o.startGraceMs ?? START_GRACE_MS;
    const journal = readJson(b.journal);
    if (endOf(journal)) return { state: 'ended', why: 'it ended', spent: 0 };
    const status = readJson(b.journal.replace(/\.json$/, '') + '.status.json');
    const beat = status?.heartbeat ? Date.parse(status.heartbeat) : NaN;
    const spentSoFar = Number(status?.cost?.llm_tokens) || 0;
    if (Number.isFinite(beat) && now - beat < stale) return { state: 'alive', why: 'its process is alive (its heartbeat is fresh)', spent: 0 };
    /* A heartbeat late is not a death: its process is asked, when it is known. */
    const pid = typeof status?.pid === 'number' ? status.pid : b.pid;
    if (processAlive(pid)) return { state: 'alive', why: 'its process is alive (its heartbeat late)', spent: 0 };
    if (journal || status || fs.existsSync(b.journal)) {
      const since = Number.isFinite(beat) ? beat : fs.statSync(fs.existsSync(b.journal) ? b.journal : b.journal.replace(/\.json$/, '') + '.status.json').mtimeMs;
      return now - since < grace ? { state: 'starting', why: 'its record began and its heartbeat is not yet stale for long', spent: 0 }
        : { state: 'dead', why: 'its process stopped without ending' + (typeof pid === 'number' ? ' (process ' + pid + ' is gone)' : ' (its process could not be confirmed alive)')
          + ': what it spent is not known - its grant is kept booked, its record showed at least ' + spentSoFar + ' tokens', spent: spentSoFar };
    }
    const cut = b.journal.replace(/\.json$/, '') + '.cut.json';
    const asked = fs.existsSync(cut) ? fs.statSync(cut).mtimeMs : 0;
    return now - asked < grace ? { state: 'starting', why: 'launched and not yet started: within the grace of a launch', spent: 0 }
      : { state: 'never', why: 'it left no record in the grace of a launch' + (typeof b.pid === 'number' ? ' and its process ' + b.pid + ' is gone' : '') + ': taken as never started, nothing spent', spent: 0 };
  }

  /** Whether a branch ended and its result is still to give (what calls a requester that is not asked every round). */
  hasResults(): boolean {
    this.refresh();
    return this.branches.some((b) => !b.delivered && (b.state === 'completed' || b.state === 'failed' || b.state === 'cancelled'));
  }

  async run(q: Record<string, unknown>, round: number): Promise<Record<string, unknown>> {
    const request = JSON.stringify(q);
    /* Asked again by a run that resumes it: answered as it was, with what it logged then. */
    const head = this.answered[0];
    if (head && head.round === round && head.request === request) {
      this.answered.shift();
      /* Logged again as they were - their paths made relative to this run's folder, wherever its history was written. */
      for (const { t: _t, type, ...e } of head.events) this.o.log(type, rebaseDelegationEvent(e, this.o.historyDir ?? path.dirname(this.o.journalFile), path.dirname(this.o.journalFile)));
      this.o.log('delegation_answered', { round, request, answer: head.answer });
      /* A shared branch acts in this very world: a run that derives the world again resumes it here, from its own record, at
         the same request - never left out, or the world would not be the one recorded. */
      for (const e of head.events) if (e.type === 'delegation_requested' && e.world?.mode === 'shared') this.rejoin(e.id);
      return head.answer;
    }
    this.reconcile();
    const answer = await this.answer(q, round);
    this.o.log('delegation_answered', { round, request, answer });
    return answer;
  }

  private async answer(q: Record<string, unknown>, round: number): Promise<Record<string, unknown>> {
    if ('delegate' in q) {
      const r = q.delegate && typeof q.delegate === 'object' && !Array.isArray(q.delegate) ? q.delegate as J : null;
      return await this.decide(r, typeof r?.question === 'string' ? r.question.trim() : '', round);
    }
    const d = q.delegation && typeof q.delegation === 'object' ? q.delegation as J : null;
    const b = d ? this.branches.find((x) => x.id === d.id) : undefined;
    if (!d || !b) return { delegation: d?.id ?? null, error: 'no branch ' + JSON.stringify(d?.id ?? null) + ' of yours' + (this.branches.length ? ' (yours: ' + this.branches.map((x) => x.id).join(', ') + ')' : '') };
    this.refresh();
    if (d.cancel === true) {
      if (b.state !== 'accepted' && b.state !== 'running') return { delegation: b.id, state: b.state, error: 'it has ended already' };
      fs.mkdirSync(path.dirname(b.journal), { recursive: true });
      fs.appendFileSync(b.journal.replace(/\.json$/, '') + '.inbox.jsonl', JSON.stringify({ id: 'cancel-' + b.id, kind: 'stop', by: 'requester' }) + '\n');
      this.o.log('delegation_cancel_asked', { id: b.id, round });
      return { delegation: b.id, state: b.state, cancel: 'asked: it stops before its next question, and its result so far comes to you' };
    }
    if (d.read && typeof d.read === 'object') {
      const journal = readJson(b.journal);
      if (!journal) return { delegation: b.id, error: 'its record is not there yet' };
      if (b.mode === 'evolve') {
        const files = evolveFiles(b.journal);
        const manifest = readJson(files.manifest) as SearchManifest | null;
        if (!manifest) return { delegation: b.id, state: b.state, error: 'its search has not finished yet: its record is read once it is sealed' };
        const reader = new Experience([{ label: 'branch', journal: { researcher: 'evolutionary search' }, sameWorld: true, reader: searchReader(manifest, readLines(files.search) as never) }]);
        return { delegation: b.id, state: b.state, read: await reader.run({ ...(d.read as J), run: 'branch' }) };
      }
      const reader = new Experience([{ label: 'branch', journal, sameWorld: true }]);
      return { delegation: b.id, state: b.state, read: await reader.run({ ...(d.read as J), run: 'branch' }) };
    }
    return { delegation: b.id, state: b.state, granted: b.granted, ...(b.spent !== null ? spendingOf(b) : {}), fund_left: this.fundLeft() };
  }

  /** A shared branch resumed from its record, in this process, as its requester derives the world again. */
  private rejoin(id: string): void {
    const b = this.branches.find((x) => x.id === id);
    if (!b || !b.world || b.world.mode !== 'shared' || !this.o.living || !fs.existsSync(b.journal)) return;
    /* Ended in its record: replayed to where it stopped, and stopped as it stopped - its acts in this world, the same. */
    const ended = endOf(readJson(b.journal));
    const j = this.o.living.join({ id, actor: b.world.actor!, journal: b.journal, args: [], resume: b.journal, ...(ended ? { stopAs: String(ended.stoppedBy) } : {}) });
    if (typeof j === 'string') { this.fail(b, { state: 'never', why: 'it could not be resumed: ' + j, spent: 0 }); this.o.log('delegation_state', { id, state: 'failed', why: b.why, spent: 0 }); return; }
    b.journal = j.journal;
    b.state = 'running';
    this.o.log('delegation_state', { id, state: 'running', resumed: true, journal: path.relative(path.dirname(this.o.journalFile), j.journal).split(path.sep).join('/') });
  }

  private async decide(r: J | null, question: string, round: number): Promise<Record<string, unknown>> {
    if (!question) return { delegate: null, error: '"question": what to investigate - the branch knows nothing else of your intent' };
    if (this.o.unsupported) return { delegate: { question }, error: 'not here: ' + this.o.unsupported };
    /* In a living world: a realization of its own (the default) or a member of this one - as the run allows, never another. */
    const living = this.o.living;
    if (r!.world !== undefined && !living) return { delegate: { question }, error: '"world": only a living world has realizations to choose between' };
    const worldMode = (r!.world ?? 'isolated') as string;
    const randomness = (r!.randomness ?? 'fresh') as string;
    if (living) {
      if (!['isolated', 'shared'].includes(worldMode)) return { delegate: { question }, error: '"world": "isolated" (a realization of its own) or "shared" (a member of this world)' };
      if (!living.modes.includes(worldMode as 'isolated')) return { delegate: { question, world: worldMode }, error: 'the mode "' + worldMode + '" is not available in this run (it allows: ' + living.modes.join(', ') + '): refused, nothing replaced' };
      if (r!.randomness !== undefined && (worldMode !== 'isolated' || !['same', 'fresh'].includes(randomness))) return { delegate: { question }, error: '"randomness": "same" or "fresh", for an isolated branch' };
      if (r!.mode === 'evolve') return { delegate: { question }, error: 'an evolutionary search has no living world to search in' };
    }
    const mode = r!.mode ?? 'investigate';
    if (mode !== 'investigate' && mode !== 'evolve') return { delegate: { question }, error: '"mode": "investigate" (the default) or "evolve" - not ' + JSON.stringify(mode) };
    if (mode === 'investigate' && (r!.start !== undefined || r!.continue_from !== undefined || r!.seeds !== undefined)) return { delegate: { question }, error: '"start", "continue_from" and "seeds" are of "mode": "evolve"' };
    const notYet = Object.keys(r!).filter((k) => NOT_IMPLEMENTED.has(k));
    if (notYet.length) return { delegate: { question, mode }, error: 'not implemented in this delivery: ' + notYet.map((k) => '"' + k + '"').join(', ') + ' - refused before anything is spent' };
    if (mode === 'evolve') {
      if (!this.o.config.evolve) return { delegate: { question, mode }, error: 'the evolutionary mode is not enabled in this run' };
      if (!this.o.evolve) return { delegate: { question, mode }, error: 'no evaluator for an evolutionary search in this world' };
      if (r!.start !== undefined && r!.continue_from !== undefined) return { delegate: { question, mode }, error: '"start" or "continue_from", not both' };
      const unknown = [...Object.keys(r!).filter((k) => !EVOLVE_FIELDS.has(k)), ...Object.keys((r!.budget ?? {}) as J).filter((k) => !BUDGET_FIELDS.has(k)).map((k) => 'budget.' + k)];
      if (unknown.length) return { delegate: { question, mode }, error: 'unknown field(s): ' + unknown.join(', ') + ' (' + [...EVOLVE_FIELDS].join(', ') + '; budget: ' + [...BUDGET_FIELDS].join(', ') + ')' };
      if (this.o.config.evolve.isolated && !this.o.evolve.isolated) return { delegate: { question, mode }, error: 'it requires a sandbox that isolates files and network, and this one does not (isolated: false): refused before anything is spent' };
      if (r!.seeds !== undefined) {
        const seeds = this.seedsOf(r!.seeds);
        if ('error' in seeds) return { delegate: { question, mode }, error: '"seeds": ' + seeds.error };
      }
    }
    if (r!.refs !== undefined && (!Array.isArray(r!.refs) || !r!.refs.every((x: unknown) => typeof x === 'string'))) return { delegate: { question }, error: '"refs": ids of items of your record' };
    if (this.o.ledger) { const t = this.ledgerNow(); if ('problem' in t) return { delegate: { question }, error: 'the fund cannot be known: ' + t.problem + ' - no branch is opened until it can' }; }
    const active = this.active();
    if (active) return { delegate: { question }, error: 'one branch at a time: ' + active.id + ' is ' + active.state, fund_left: this.fundLeft() };
    const c = this.o.config;
    const asked = (r!.budget ?? {}) as J;
    const rounds = Math.max(1, Math.min(c.maxRounds, Number.isInteger(asked.rounds) ? asked.rounds : c.rounds));
    const tokens = Math.min(c.tokens, this.fundLeft(), Number(asked.tokens) > 0 ? Math.floor(Number(asked.tokens)) : c.tokens);
    if (tokens <= 0) return { delegate: { question }, error: 'the fund for branches is spent', fund_left: 0 };
    /* An evolutionary branch: where it starts (a program of the requester's by its content, or a sealed search of one of its
       branches), checked before anything is reserved. */
    let evolve: { start: { hash: string; files: Readonly<Record<string, string>> } | null; continueFrom: string | null; evaluations: number; seeds: J[] } | null = null;
    if (mode === 'evolve') {
      const evaluations = Math.max(1, Math.min(c.evolve!.evaluations, Number.isInteger(asked.evaluations) ? asked.evaluations : c.evolve!.evaluations));
      if (r!.continue_from !== undefined) {
        const from = this.branches.find((x) => x.mode === 'evolve' && (x.id === r!.continue_from || readJson(evolveFiles(x.journal).manifest)?.hash === r!.continue_from));
        const manifest = from ? evolveFiles(from.journal).manifest : null;
        if (!from || !manifest || !fs.existsSync(manifest)) return { delegate: { question, mode }, error: '"continue_from": a sealed search of an evolutionary branch of yours, by its id or its hash' };
        if (from.state === 'running' || from.state === 'accepted') return { delegate: { question, mode }, error: '"continue_from": ' + from.id + ' has not ended: a search is continued once its origin is settled' };
        evolve = { start: null, continueFrom: manifest, evaluations, seeds: [] };
      } else {
        const start = this.o.evolve!.resolveStart(typeof r!.start === 'string' ? r!.start.replace(/^artifact:/, '') : undefined);
        if ('error' in start) return { delegate: { question, mode }, error: '"start": ' + start.error };
        evolve = { start, continueFrom: null, evaluations, seeds: [] };
      }
      if (r!.seeds !== undefined) evolve.seeds = (this.seedsOf(r!.seeds) as { seeds: J[] }).seeds;
    }
    const k = (this.perRound.get(round) ?? 0) + 1;
    this.perRound.set(round, k);
    const id = 'delegation:r' + round + '.' + k;
    const base = this.o.journalFile.replace(/\.json$/, '');
    const name = id.replace(/[^a-z0-9.]+/gi, '-');
    const journal = path.join(base + '.branches', name + '.json');
    /* The requester's work as it stands now, fixed: what the branch may read, whatever the requester does next. */
    const cutFile = path.join(base + '.branches', name + '.cut.json');
    const snap = this.o.snapshot();
    /* Never what the requester is not told: the hidden part of its world stays out of the file the branch is given. */
    const { hidden_from_the_learner: _hidden, ...seen } = snap;
    const cut = { ...seen, events: [...(snap.events ?? []), { type: 'end', stoppedBy: 'cut_for_delegation', cut_of: id }] };
    const cutText = JSON.stringify(cut);
    fs.mkdirSync(path.dirname(cutFile), { recursive: true });
    fs.writeFileSync(cutFile, cutText);
    const refs = (r!.refs ?? []) as string[];
    const expected = typeof r!.expected === 'string' && r!.expected.trim() ? r!.expected.trim() : null;
    const task = ['A DELEGATED INVESTIGATION. Another researcher, investigating this same environment, asks you:', question,
      ...(expected ? ['What it wants back: ' + expected] : []),
      ...(refs.length ? ['Where it suggests you start, in its record: ' + refs.join(', ')] : []),
      'Its record, as it stood when it asked, is readable as experience (run "' + cutLabel(this.o.experience) + '"): its beliefs, notes, models and experiments - its word, not evidence; test what you take from it here' + (worldMode === 'shared' && living ? '.' : ', in your own laboratory.'),
      ...((this.o.experience ?? []).length ? ['The records it reads as experience are readable to you too, under the same labels it uses: ' + this.o.experience!.map((_f, i) => 'exp' + (i + 1)).join(', ') + '.'] : []),
      ...(worldMode === 'shared' && living ? ['You are a member of ITS very world: what you do there is done in its world too, and you may write to it ("researcher") or read what it writes to you.'] : []),
      'Investigate with your own instruments. What you find goes back to it: write it down as you go - what you investigated, what you found, the directions you propose and what tells them apart, your evidence apart from your interpretation, the alternatives you ruled out, your uncertainties. Strengthening its view, refuting an alternative, or finding no direction you can defend are results too. You need not end with a model: close your rounds when a model would add nothing.'].join('\n');
    /* A living world's branch: its world given by its mode - a snapshot of this one, or a member's place in it. */
    const actor = living && worldMode === 'shared' ? 'branch-' + name.replace(/^delegation-/, '').replace(/[^a-z0-9]+/gi, '-') : null;
    let worldOf: Record<string, unknown> | null = null;
    let worldArgs = [...this.o.worldArgs];
    const without = (xs: string[], keys: readonly string[]) => { const out: string[] = []; for (let i = 0; i < xs.length; i++) { if (keys.includes(xs[i])) { i++; continue; } out.push(xs[i]); } return out; };
    if (living && worldMode === 'isolated') {
      const forkFile = path.join(base + '.branches', name + '.fork.json');
      const f = living.fork(forkFile, randomness as 'same', id);
      worldArgs = [...without(worldArgs, ['--fork', '--fork-randomness']), ...f.args];
      worldOf = { mode: 'isolated', randomness, revision: f.revision, tick: f.tick, fork: path.relative(path.dirname(this.o.journalFile), forkFile).split(path.sep).join('/') };
    } else if (living) {
      worldArgs = [...without(worldArgs, ['--actor', '--explore']), '--actor', actor!, '--explore', '0'];
      worldOf = { mode: 'shared', actor };
    }
    const args = [...worldArgs, '--researcher', 'assisted', '--attempts', String(rounds), '--max-tokens', String(tokens), '--task', task,
      '--experience', [...(this.o.experience ?? []), cutFile].join(','), '--experience-mode', 'meta', '--experience-scope', 'all', '--no-grade', '--no-ablation'];
    const granted = { rounds, tokens, ...(evolve ? { evaluations: evolve.evaluations } : {}) };
    /* Its supervisor's request: the search's part of the grant and the consolidation's, protected (§12). */
    const specFile = path.join(base + '.branches', name + '.evolve.json');
    if (evolve) {
      const search = Math.floor(tokens * SEARCH_SHARE);
      fs.writeFileSync(specFile, JSON.stringify({ format: 'evolution-branch@1', id, question, expected, refs, cut: cutFile, seed: this.o.evolve!.seed, options: this.o.evolve!.options,
        worldArgs: this.o.worldArgs, start: evolve.start, continueFrom: evolve.continueFrom, seeds: evolve.seeds, experience: this.o.experience ?? [], exploration: { workloads: c.evolve!.workloads, seed: 104729 * (round + 1) + k },
        /* Of its evaluations, a quarter (at least one, from two on) protected for confirming what it exports: the search
           and its confirmations never run more than were granted. */
        limits: { evaluations: evolve.evaluations - confirmShare(evolve.evaluations), attempts: evolve.evaluations * 3, tokens: search, ...(c.evolve!.machineSeconds ? { machineSeconds: c.evolve!.machineSeconds } : {}) },
        confirmations: confirmShare(evolve.evaluations),
        ...(c.evolve!.wallSeconds ? { wallSeconds: c.evolve!.wallSeconds } : {}), consolidation: { tokens: tokens - search, rounds } }, null, 2));
    }
    /* Recorded before it is started: who asked what, with what, from which cut, in which laboratory, and what is reserved. */
    this.o.log('delegation_requested', { id, round, question, refs, ...(expected ? { expected } : {}), granted,
      ...(evolve ? { mode: 'evolve', evolve: path.relative(path.dirname(this.o.journalFile), specFile).split(path.sep).join('/'),
        ...(evolve.start ? { start: evolve.start.hash } : {}), ...(evolve.continueFrom ? { continue_from: readJson(evolve.continueFrom)?.hash } : {}),
        ...(evolve.seeds.length ? { seeds: evolve.seeds.map((x) => ({ id: x.id, source: x.source, hash: x.hash, knows_task: x.knows_task })) } : {}) } : {}),
      journal: path.relative(path.dirname(this.o.journalFile), journal).split(path.sep).join('/'),
      cut: { file: path.relative(path.dirname(this.o.journalFile), cutFile).split(path.sep).join('/'), sha256: createHash('sha256').update(cutText).digest('hex'), events: (snap.events ?? []).length },
      laboratory: worldOf?.mode === 'shared' ? 'this very world, as a member of it: what it does there is done in yours' : worldOf ? 'a realization of its own of this world, as it is now: what it does there is not done in yours'
        : 'the same world (its seed and options), in an instance of its own: what it does there is not done in yours', args, ...(worldOf ? { world: worldOf } : {}) });
    const b: Branch = { id, round, question, journal, granted, state: 'accepted', spent: null, delivered: false, ...(evolve ? { mode: 'evolve' as const } : {}),
      ...(worldOf ? { world: { mode: worldOf.mode as 'isolated', ...(actor ? { actor } : {}) } } : {}) };
    this.branches.push(b);
    this.reserved += tokens;
    /* The fund is one for the run: reserved in its ledger, and checked again - another requester may have reserved meanwhile. */
    this.book({ id, reserve: tokens });
    const after = this.o.ledger ? this.ledgerNow() : null;
    if (after && ('problem' in after || after.spent + after.reserved > this.o.config.fund)) {
      b.state = 'failed';
      this.o.log('delegation_state', { id, state: 'failed', why: 'the fund was taken meanwhile by another requester of the run', spent: 0 });
      this.settle(b, 0, true);
      return { delegation: id, state: 'failed', error: 'the fund for branches is spent', fund_left: this.fundLeft() };
    }
    let launched: void | { readonly pid?: number };
    /* A shared branch: a member of this world, in this process. */
    if (living && worldMode === 'shared') {
      const j = living.join({ id, actor: actor!, journal, args, resume: null });
      if (typeof j === 'string') {
        b.state = 'failed';
        this.o.log('delegation_state', { id, state: 'failed', why: 'it could not join the world: ' + j, spent: 0 });
        this.settle(b, 0, true);
        return { delegation: id, state: 'failed', error: 'it could not join the world: ' + j, fund_left: this.fundLeft() };
      }
      b.state = 'running';
      this.o.log('delegation_state', { id, state: 'running', world: 'shared', actor });
      return { delegation: id, state: 'accepted', world: 'shared', member: actor, granted, fund_left: this.fundLeft(),
        note: 'it acts in this world as a member, and may write to you; its result comes to you as a message when it ends' };
    }
    try { launched = await this.o.launcher({ journal, lab: this.o.lab, args, ...(evolve ? { evolve: specFile } : {}) }); }
    catch (e) {
      b.state = 'failed';
      this.o.log('delegation_state', { id, state: 'failed', why: 'it could not be started: ' + String((e as Error)?.message ?? e).slice(0, 200), spent: 0 });
      this.settle(b, 0, true);
      return { delegation: id, state: 'failed', error: 'it could not be started', fund_left: this.fundLeft() };
    }
    b.state = 'running';
    if (launched && typeof launched.pid === 'number') b.pid = launched.pid;
    this.o.log('delegation_state', { id, state: 'running', ...(b.pid !== undefined ? { pid: b.pid } : {}) });
    return { delegation: id, state: 'accepted', ...(worldOf ? { world: worldOf.mode, ...(worldOf.mode === 'isolated' ? { randomness, from_tick: worldOf.tick } : {}) } : {}), ...(evolve ? { mode: 'evolve', ...(evolve.start ? { start: evolve.start.hash } : { continue_from: readJson(evolve.continueFrom!)?.hash }) } : {}), granted, fund_left: this.fundLeft(),
      note: 'its result comes to you as a message when it ends; go on meanwhile' };
  }

  /** The branches that ended since, read from their records: their state, what they spent (the reservation released). Nothing is
      logged here: when a branch ended depends on the clock, and is recorded only with the message that delivers its result. */
  refresh(): void {
    for (const b of this.branches) {
      if (b.state !== 'running' && b.state !== 'accepted') continue;
      const end = endOf(readJson(b.journal));
      if (!end) {
        const l = this.liveness(b);
        if (l.state === 'dead' || l.state === 'never') this.fail(b, l);
        continue;
      }
      const finding = readJson(b.journal.replace(/\.json$/, '.finding.json'));
      const spent = Number(finding?.cost?.total?.llm_tokens) || Number(end.console_usage?.llm_tokens_live ?? 0) + Number(end.console_usage?.llm_tokens_replayed ?? 0);
      b.state = end.stoppedBy === 'cancelled' ? 'cancelled' : end.stoppedBy === 'llm_error' || end.stoppedBy === 'diverged' || end.stoppedBy === 'failed' ? 'failed' : 'completed';
      /* A spending its record says it does not know (answers without usage, a phase whose cost was not told): held at its
         grant, what was observed apart - never released as if it were what it spent (an external review, 25/10/2026). */
      const unknown = (Array.isArray(finding?.cost?.unknown) && finding.cost.unknown.length > 0) || end.console_usage?.usage_unknown === true;
      if (unknown) this.settle(b, b.granted.tokens, true, { at_least: spent, held: b.granted.tokens });
      else this.settle(b, spent, true);
    }
  }

  /** The results to deliver now: each branch ended and not delivered yet, once. */
  results(): Result[] {
    this.refresh();
    const out: Result[] = [];
    for (const b of this.branches) {
      if (b.delivered || (b.state !== 'completed' && b.state !== 'failed' && b.state !== 'cancelled')) continue;
      b.delivered = true;
      out.push({ id: 'result-' + b.id, research_result: b.id, result_state: b.state, result_spent: this.observed(b), ...(b.uncertain ? { result_spent_uncertain: b.uncertain } : {}),
        text: 'RESEARCH RESULT of your branch ' + b.id + ' (a delegated contribution, not an order nor an answer of the environment): ' + JSON.stringify(reportOf(b)) });
    }
    return out;
  }

  /** Records that a result was given (a requester whose deliveries are not messages of its run: a senior). */
  given(r: Result): void {
    this.o.log('branch_result_given', { id: r.research_result, state: r.result_state, spent: r.result_spent, ...(r.result_spent_uncertain ? { uncertain: r.result_spent_uncertain } : {}) });
  }

  /** At the requester's end: its branches still running asked to stop (their partial results kept in their records). */
  close(): Record<string, unknown> {
    for (const b of this.branches) if (b.state === 'running' || b.state === 'accepted') {
      fs.appendFileSync(b.journal.replace(/\.json$/, '') + '.inbox.jsonl', JSON.stringify({ id: 'close-' + b.id, kind: 'stop', by: 'requester' }) + '\n');
      this.o.log('delegation_cancel_asked', { id: b.id, why: 'its requester ended' });
    }
    /* What was spent, as observed (a spending not known, at least what was seen); what the fund holds for those apart. */
    const uncertain = this.branches.filter((b) => b.uncertain);
    return { fund: this.o.config.fund, spent: this.branches.reduce((a, b) => a + (this.observed(b) ?? 0), 0), reserved: this.reserved,
      ...(uncertain.length ? { held_uncertain: uncertain.reduce((a, b) => a + b.uncertain!.held, 0) } : {}),
      branches: this.branches.map((b) => ({ id: b.id, journal: path.relative(path.dirname(this.o.journalFile), b.journal).split(path.sep).join('/'), state: b.state, spent: this.observed(b), granted: b.granted,
        ...(b.uncertain ? { spent_uncertain: b.uncertain } : {}) })) };
  }
}

/** A delegation event's paths (its branch's record, its cut, its request), written relative to the folder of the record
    that holds it, made relative to another folder: what a run resumed or continued in another folder keeps of its history
    (27/10/2026: a continuation in another folder looked for its branch there, took it as never started, and settled it at
    nothing). Absolute paths, and paths of no event of this kind, are left as they are. */
export function rebaseDelegationEvent<T extends Record<string, any>>(e: T, fromDir: string, toDir: string): T {
  if (path.resolve(fromDir) === path.resolve(toDir)) return e;
  const re = (p: unknown) => (typeof p === 'string' && !path.isAbsolute(p) ? path.relative(toDir, path.resolve(fromDir, p)).split(path.sep).join('/') : p);
  const out: Record<string, any> = { ...e };
  if (typeof out.journal === 'string') out.journal = re(out.journal);
  if (typeof out.evolve === 'string') out.evolve = re(out.evolve);
  if (out.cut && typeof out.cut === 'object' && typeof out.cut.file === 'string') out.cut = { ...out.cut, file: re(out.cut.file) };
  return out as T;
}

/** The fund's ledger: every reservation and settlement of every requester of the run, in order. */
function ledgerOf(file: string): { entries: J[]; absent: boolean } | { problem: string } {
  if (!fs.existsSync(file)) return { entries: [], absent: true };
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { problem: 'its ledger cannot be read: ' + String((e as Error)?.message ?? e).slice(0, 120) }; }
  const entries: J[] = [];
  for (const [i, line] of text.split('\n').filter(Boolean).entries()) {
    try { entries.push(JSON.parse(line)); } catch { return { problem: 'its ledger is broken at line ' + (i + 1) + ': what was booked there is not known' }; }
  }
  return { entries, absent: false };
}
/** A booking's key: its requester and its branch - two requesters may number their branches alike. */
const keyOf = (e: J): string => String(e.requester ?? 'junior') + '|' + String(e.id);
/** What is reserved and not settled, and what was spent, in all. */
function ledgerTotals(entries: readonly J[]): { reserved: number; spent: number } {
  const settled = new Map<string, number>();
  for (const e of entries) if (e.settle !== undefined) settled.set(keyOf(e), Number(e.settle) || 0);
  let reserved = 0, spent = 0;
  for (const e of entries) if (e.reserve !== undefined && !settled.has(keyOf(e))) reserved += Number(e.reserve) || 0;
  for (const v of settled.values()) spent += v;
  return { reserved, spent };
}

const readLines = (f: string): J[] => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : []);
/** An evolutionary branch's files, beside its record (runtime/evolve-branch.ts writes them). */
const evolveFiles = (journal: string) => { const base = journal.replace(/\.json$/, ''); return { manifest: base + '.search.manifest.json', search: base + '.search.jsonl' }; };

/** A branch's report, by its mode. */
function reportOf(b: Branch): Record<string, unknown> { return b.mode === 'evolve' ? evolveReportOf(b) : investigationReportOf(b); }

/** An evolutionary branch's report (§4): its candidates, materialized and runnable (their files whole), what was measured
    of each against the start and whether a confirmation on new workloads held it, why to look at each again, the state of
    their explanations (the consolidation's, or `unreviewed`), its sealed search to continue from, and its cost by phase -
    never empty for lacking a notebook. */
function evolveReportOf(b: Branch): Record<string, unknown> {
  const record = readJson(b.journal) ?? {};
  const events = (record.events ?? []) as J[];
  const end = endOf(record) ?? {};
  const finished = events.find((e) => e.type === 'search_finished');
  const manifest = readJson(evolveFiles(b.journal).manifest) as SearchManifest | null;
  const why = new Map<string, string>();
  for (const e of readLines(evolveFiles(b.journal).search)) if (e.type === 'candidate' && e.result === 'new' && e.hash && e.why) why.set(e.hash, e.why);
  const s = manifest?.state;
  const startHash = s?.order[0];
  const start = startHash ? s!.candidates[startHash] : undefined;
  const confirmed = new Map(((finished?.confirmations ?? []) as J[]).map((c) => [c.program, c]));
  const candidates = ((finished?.exported ?? []) as string[]).filter((h) => s?.candidates[h]).map((h) => {
    const c = s!.candidates[h];
    const conf = confirmed.get(h);
    return { program: h, files: c.files, parents: c.parents, origin: c.origin, correct: c.evaluation?.correct ?? 'unchecked', quality: c.evaluation?.quality ?? null,
      measures: c.evaluation?.feedback ?? null, roles: [s!.elites.includes(h) ? 'elite' : '', s!.development.some((d) => d.hash === h) ? 'in development' : ''].filter(Boolean),
      ...(why.has(h) ? { declared_why: why.get(h) } : {}),
      confirmation: !conf ? 'not confirmed' : conf.not_confirmed ? 'not confirmed: ' + conf.not_confirmed : { on: 'new workloads of the same families', correct: conf.correct, quality: conf.quality } };
  });
  const cons = end.consolidation ?? null;
  /* A consolidation may have no record at all (skipped: the branch's wall time was spent). */
  const consJournal = typeof cons?.journal === 'string' ? path.resolve(path.dirname(b.journal), cons.journal) : null;
  const consolidation = consJournal && cons.state === 'reviewed'
    ? investigationReportOf({ ...b, journal: consJournal, mode: undefined })
    : { state: 'unreviewed', why: events.find((e) => e.type === 'consolidation_failed')?.why ?? cons?.why ?? (consJournal ? 'its consolidation did not end' : 'no consolidation ran') };
  const finding = readJson(b.journal.replace(/\.json$/, '.finding.json'));
  return {
    branch: b.id, mode: 'evolve', question: b.question, state: b.state, ...(b.why ? { why: b.why } : {}), ...spendingOf(b),
    search: finished ? { stoppedBy: finished.stoppedBy, attempts: finished.cost?.attempts, evaluations: finished.cost?.evaluations, sealed: finished.hash,
      continue_with: '{"delegate": {"mode": "evolve", "continue_from": "' + finished.hash + '", "question": "..."}}' } : 'it did not finish',
    start: start ? { program: start.hash, correct: start.evaluation?.correct ?? 'unchecked', quality: start.evaluation?.quality ?? null } : null,
    candidates,
    adopt: 'a candidate is adopted by a change of yours with its files (whole): {"act": {"change": {"from": "<base or a version of yours>", "files": {...}, "why": "...", "expect": "..."}}} - then your own checks, as any version',
    consolidation,
    ...(finding?.cost ? { cost: { search: finding.cost.search, consolidation: finding.cost.consolidation, ...(finding.cost.unknown ? { unknown: finding.cost.unknown } : {}) } } : {}),
    record: 'read the search whole: {"delegation": {"id": "' + b.id + '", "read": {"experience": "list", "of": "candidates"}}} (also "attempts", "decisions")'
  };
}

/** A branch's report, from its record: what it investigated and found, in its own words, with the references to the whole. */
function investigationReportOf(b: Branch): Record<string, unknown> {
  const journal = readJson(b.journal) ?? {};
  const events = (journal.events ?? []) as J[];
  const end = endOf(journal) ?? {};
  const nb = (end.notebook ?? {}) as J;
  const reflections = events.filter((e) => e.type === 'reflection');
  const last = reflections[reflections.length - 1] ?? [...events].reverse().find((e) => e.type === 'proposal') ?? null;
  const beliefs = ((nb.beliefs ?? []) as J[]).map((x) => ({ id: x.id, status: x.status, statement: x.statement }));
  return {
    branch: b.id, question: b.question, state: b.state, ...(b.why ? { why: b.why } : {}), rounds: events.filter((e) => e.type === 'proposal' || e.type === 'round_closed').length, ...spendingOf(b),
    beliefs, notes: ((nb.notes ?? []) as J[]).map((n) => ({ id: n.id, text: String(n.text ?? '').slice(0, 600) })),
    ...(last ? { its_last_word: { ...(last.rationale ? { rationale: last.rationale } : {}), ...(last.lessons ? { lessons: last.lessons } : {}), ...(last.next_experiment ? { next_experiment: last.next_experiment } : {}),
      ...(last.open_questions ? { open_questions: last.open_questions } : {}) } } : {}),
    closings: events.filter((e) => e.type === 'round_closed').map((e) => e.why),
    ...(end.final ? { its_last_model: end.final } : {}),
    record: 'read it whole: {"delegation": {"id": "' + b.id + '", "read": {"experience": "list", "of": "notes"}}} and the other kinds'
  };
}
