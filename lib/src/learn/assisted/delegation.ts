import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Experience } from './experience.ts';

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
}

/** How a branch is started: a run of the laboratory `lab` with `args`, writing `journal` (a process of its own, or - in
    tests - the same process). */
export type Launcher = (o: { readonly journal: string; readonly lab: string; readonly args: readonly string[] }) => void;

type J = Record<string, any>;
const readJson = (f: string): J | null => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const endOf = (j: J | null): J | null => (j ? [...(j.events ?? [])].reverse().find((e: J) => e.type === 'end') ?? null : null);

interface Branch {
  readonly id: string;
  readonly round: number;
  readonly question: string;
  readonly journal: string;
  readonly granted: { readonly rounds: number; readonly tokens: number };
  state: 'accepted' | 'running' | 'completed' | 'failed' | 'cancelled';
  spent: number | null;
  delivered: boolean;
}

/** What the senior is told of the tool: the same delegation, from its own reading; the result comes to it. */
export const SENIOR_DELEGATION_SECTION = (c: DelegationConfig): string => 'DELEGATING AN INVESTIGATION. Among your readings you may open a BRANCH: another researcher, with the junior\'s record readable as it stands when you ask, its own laboratory in this same world and its own budget, investigates a question of yours: {"delegate": {"question": "...", "refs": ["optional: items of the junior\'s record"], "expected": "optional", "budget": {"rounds": <n>, "tokens": <n>}}}; {"delegation": {"id": "<id>", "status": true}}, {"delegation": {"id": "<id>", "read": {"experience": "list" | "open" | "find", ...}}} or {"delegation": {"id": "<id>", "cancel": true}}. Its result comes to YOU, at a later call (`branch_results`): a contribution, never evidence until it is tested; what reaches the junior is what you make of it, in your own message. One branch of yours at a time; the fund is ' + c.fund + ' tokens, at most ' + c.tokens + ' tokens and ' + c.maxRounds + ' rounds a branch; each request costs one of your readings.';

/** What the researcher is told of the tool, in its system (from its first question, under the capability `delegation`). */
export const DELEGATION_SECTION = (c: DelegationConfig): string => [
  'DELEGATING AN INVESTIGATION. You may open a BRANCH: another researcher, with your record readable as it stands when you ask, its own laboratory in this same world, and its own budget, investigates a question of yours while you go on. Generating or questioning hypotheses, exploring an anomaly, testing an assumption or a rival explanation: any question you can investigate. Inside "investigate":',
  '  {"delegate": {"question": "what to investigate - the branch knows nothing else of your intent", "refs": ["optional: items of your record to start from, e.g. model:r4, note:<id>"], "expected": "optional: what you want back", "budget": {"rounds": <n>, "tokens": <n>}}}',
  '  It answers at once whether it was accepted, with its id and what it was given; its result comes to you later as a message (`research_result`) with its findings, the directions it proposes and what tells them apart, its evidence and its uncertainties - a contribution, never an order: take what serves you, test it with your instruments. {"delegation": {"id": "<id>", "status": true}} says how it goes; {"delegation": {"id": "<id>", "read": {"experience": "list" | "open" | "find", ...}}} reads its record as you read experience; {"delegation": {"id": "<id>", "cancel": true}} stops it.',
  '  One branch at a time. The fund for branches is ' + c.fund + ' tokens in all, at most ' + c.tokens + ' tokens and ' + c.maxRounds + ' rounds a branch (' + c.rounds + ' when you ask none); each request costs a step of yours, the branch\'s work is counted apart.'
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
    /** Why a branch cannot be opened in this world at all (an environment outside the harness), or null. */
    readonly unsupported: string | null;
  };

  constructor(o: Delegations['o']) {
    this.o = o;
    /* A run resumed: its branches as its record left them - opened by its requests, ended by the results delivered to it. */
    let pending: J[] = [];
    for (const e of o.history) {
      if (e.type === 'delegation_requested') {
        this.branches.push({ id: e.id, round: e.round, question: e.question, journal: path.resolve(path.dirname(o.journalFile), e.journal), granted: e.granted, state: 'running', spent: null, delivered: false });
        this.reserved += Number(e.granted?.tokens) || 0;
        this.perRound.set(e.round, Math.max(this.perRound.get(e.round) ?? 0, Number(String(e.id).split('.').pop()) || 0));
      }
      if (e.type === 'delegation_state') { const b = this.branches.find((x) => x.id === e.id); if (b) { b.state = e.state; if (typeof e.spent === 'number') this.settle(b, e.spent); } }
      if (e.type === 'delegation_requested' || e.type === 'delegation_state' || e.type === 'delegation_cancel_asked') pending.push(e);
      if (e.type === 'delegation_answered') { this.answered.push({ round: e.round, request: e.request, answer: e.answer, events: pending }); pending = []; }
      /* A senior's: the results it was given at one of its calls. */
      if (e.type === 'branch_result_given') { const b = this.branches.find((x) => x.id === e.id); if (b) { b.delivered = true; b.state = e.state ?? 'completed'; if (typeof e.spent === 'number') this.settle(b, e.spent); } }
      if (e.type === 'operator_message') for (const m of (e.messages ?? []) as J[]) if (m.research_result) {
        const b = this.branches.find((x) => x.id === m.research_result);
        if (b) { b.delivered = true; b.state = m.result_state ?? 'completed'; if (typeof m.result_spent === 'number') this.settle(b, m.result_spent); }
      }
    }
  }

  static accepts(q: Record<string, unknown>): boolean { return q !== null && typeof q === 'object' && ('delegate' in q || 'delegation' in q); }

  fundLeft(): number { return Math.max(0, this.o.config.fund - this.spentAll - this.reserved); }

  private active(): Branch | undefined { return this.branches.find((b) => b.state === 'accepted' || b.state === 'running'); }

  /** Its cost settled: the reservation released, what it spent kept. */
  private settle(b: Branch, spent: number): void {
    if (b.spent !== null) return;
    b.spent = spent;
    this.reserved = Math.max(0, this.reserved - b.granted.tokens);
    this.spentAll += spent;
  }

  async run(q: Record<string, unknown>, round: number): Promise<Record<string, unknown>> {
    const request = JSON.stringify(q);
    /* Asked again by a run that resumes it: answered as it was, with what it logged then. */
    const head = this.answered[0];
    if (head && head.round === round && head.request === request) {
      this.answered.shift();
      for (const { t: _t, type, ...e } of head.events) this.o.log(type, e);
      this.o.log('delegation_answered', { round, request, answer: head.answer });
      return head.answer;
    }
    const answer = await this.answer(q, round);
    this.o.log('delegation_answered', { round, request, answer });
    return answer;
  }

  private async answer(q: Record<string, unknown>, round: number): Promise<Record<string, unknown>> {
    if ('delegate' in q) {
      const r = q.delegate && typeof q.delegate === 'object' && !Array.isArray(q.delegate) ? q.delegate as J : null;
      return this.decide(r, typeof r?.question === 'string' ? r.question.trim() : '', round);
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
      const reader = new Experience([{ label: 'branch', journal, sameWorld: true }]);
      return { delegation: b.id, state: b.state, read: await reader.run({ ...(d.read as J), run: 'branch' }) };
    }
    return { delegation: b.id, state: b.state, granted: b.granted, ...(b.spent !== null ? { spent_tokens: b.spent } : {}), fund_left: this.fundLeft() };
  }

  private decide(r: J | null, question: string, round: number): Record<string, unknown> {
    if (!question) return { delegate: null, error: '"question": what to investigate - the branch knows nothing else of your intent' };
    if (this.o.unsupported) return { delegate: { question }, error: 'not here: ' + this.o.unsupported };
    if (r!.refs !== undefined && (!Array.isArray(r!.refs) || !r!.refs.every((x: unknown) => typeof x === 'string'))) return { delegate: { question }, error: '"refs": ids of items of your record' };
    const active = this.active();
    if (active) return { delegate: { question }, error: 'one branch at a time: ' + active.id + ' is ' + active.state, fund_left: this.fundLeft() };
    const c = this.o.config;
    const asked = (r!.budget ?? {}) as J;
    const rounds = Math.max(1, Math.min(c.maxRounds, Number.isInteger(asked.rounds) ? asked.rounds : c.rounds));
    const tokens = Math.min(c.tokens, this.fundLeft(), Number(asked.tokens) > 0 ? Math.floor(Number(asked.tokens)) : c.tokens);
    if (tokens <= 0) return { delegate: { question }, error: 'the fund for branches is spent', fund_left: 0 };
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
      'Its record, as it stood when it asked, is readable as experience (run "exp1"): its beliefs, notes, models and experiments - its word, not evidence; test what you take from it here, in your own laboratory.',
      'Investigate with your own instruments. What you find goes back to it: write it down as you go - what you investigated, what you found, the directions you propose and what tells them apart, your evidence apart from your interpretation, the alternatives you ruled out, your uncertainties. Strengthening its view, refuting an alternative, or finding no direction you can defend are results too. You need not end with a model: close your rounds when a model would add nothing.'].join('\n');
    const args = [...this.o.worldArgs, '--researcher', 'assisted', '--attempts', String(rounds), '--max-tokens', String(tokens), '--task', task,
      '--experience', cutFile, '--experience-mode', 'meta', '--experience-scope', 'all', '--no-grade', '--no-ablation'];
    const granted = { rounds, tokens };
    /* Recorded before it is started: who asked what, with what, from which cut, in which laboratory, and what is reserved. */
    this.o.log('delegation_requested', { id, round, question, refs, ...(expected ? { expected } : {}), granted,
      journal: path.relative(path.dirname(this.o.journalFile), journal).split(path.sep).join('/'),
      cut: { file: path.relative(path.dirname(this.o.journalFile), cutFile).split(path.sep).join('/'), sha256: createHash('sha256').update(cutText).digest('hex'), events: (snap.events ?? []).length },
      laboratory: 'the same world (its seed and options), in an instance of its own: what it does there is not done in yours', args });
    const b: Branch = { id, round, question, journal, granted, state: 'accepted', spent: null, delivered: false };
    this.branches.push(b);
    this.reserved += tokens;
    try { this.o.launcher({ journal, lab: this.o.lab, args }); }
    catch (e) {
      b.state = 'failed';
      this.o.log('delegation_state', { id, state: 'failed', why: 'it could not be started: ' + String((e as Error)?.message ?? e).slice(0, 200), spent: 0 });
      this.settle(b, 0);
      return { delegation: id, state: 'failed', error: 'it could not be started', fund_left: this.fundLeft() };
    }
    b.state = 'running';
    this.o.log('delegation_state', { id, state: 'running' });
    return { delegation: id, state: 'accepted', granted, fund_left: this.fundLeft(), note: 'its result comes to you as a message when it ends; go on meanwhile' };
  }

  /** The branches that ended since, read from their records: their state, what they spent (the reservation released). Nothing is
      logged here: when a branch ended depends on the clock, and is recorded only with the message that delivers its result. */
  refresh(): void {
    for (const b of this.branches) {
      if (b.state !== 'running' && b.state !== 'accepted') continue;
      const end = endOf(readJson(b.journal));
      if (!end) continue;
      const spent = Number(readJson(b.journal.replace(/\.json$/, '.finding.json'))?.cost?.total?.llm_tokens) || Number(end.console_usage?.llm_tokens_live ?? 0) + Number(end.console_usage?.llm_tokens_replayed ?? 0);
      b.state = end.stoppedBy === 'cancelled' ? 'cancelled' : end.stoppedBy === 'llm_error' || end.stoppedBy === 'diverged' ? 'failed' : 'completed';
      this.settle(b, spent);
    }
  }

  /** The results to deliver now: each branch ended and not delivered yet, once. */
  results(): { id: string; text: string; research_result: string; result_state: string; result_spent: number | null }[] {
    this.refresh();
    const out: { id: string; text: string; research_result: string; result_state: string; result_spent: number | null }[] = [];
    for (const b of this.branches) {
      if (b.delivered || (b.state !== 'completed' && b.state !== 'failed' && b.state !== 'cancelled')) continue;
      b.delivered = true;
      out.push({ id: 'result-' + b.id, research_result: b.id, result_state: b.state, result_spent: b.spent,
        text: 'RESEARCH RESULT of your branch ' + b.id + ' (a delegated contribution, not an order nor an answer of the environment): ' + JSON.stringify(reportOf(b)) });
    }
    return out;
  }

  /** Records that a result was given (a requester whose deliveries are not messages of its run: a senior). */
  given(r: { research_result: string; result_state: string; result_spent: number | null }): void {
    this.o.log('branch_result_given', { id: r.research_result, state: r.result_state, spent: r.result_spent });
  }

  /** At the requester's end: its branches still running asked to stop (their partial results kept in their records). */
  close(): Record<string, unknown> {
    for (const b of this.branches) if (b.state === 'running' || b.state === 'accepted') {
      fs.appendFileSync(b.journal.replace(/\.json$/, '') + '.inbox.jsonl', JSON.stringify({ id: 'close-' + b.id, kind: 'stop', by: 'requester' }) + '\n');
      this.o.log('delegation_cancel_asked', { id: b.id, why: 'its requester ended' });
    }
    return { fund: this.o.config.fund, spent: this.spentAll, reserved: this.reserved,
      branches: this.branches.map((b) => ({ id: b.id, journal: path.relative(path.dirname(this.o.journalFile), b.journal).split(path.sep).join('/'), state: b.state, spent: b.spent, granted: b.granted })) };
  }
}

/** A branch's report, from its record: what it investigated and found, in its own words, with the references to the whole. */
function reportOf(b: Branch): Record<string, unknown> {
  const journal = readJson(b.journal) ?? {};
  const events = (journal.events ?? []) as J[];
  const end = endOf(journal) ?? {};
  const nb = (end.notebook ?? {}) as J;
  const reflections = events.filter((e) => e.type === 'reflection');
  const last = reflections[reflections.length - 1] ?? [...events].reverse().find((e) => e.type === 'proposal') ?? null;
  const beliefs = ((nb.beliefs ?? []) as J[]).map((x) => ({ id: x.id, status: x.status, statement: x.statement }));
  return {
    branch: b.id, question: b.question, state: b.state, rounds: events.filter((e) => e.type === 'proposal' || e.type === 'round_closed').length, spent_tokens: b.spent,
    beliefs, notes: ((nb.notes ?? []) as J[]).map((n) => ({ id: n.id, text: String(n.text ?? '').slice(0, 600) })),
    ...(last ? { its_last_word: { ...(last.rationale ? { rationale: last.rationale } : {}), ...(last.lessons ? { lessons: last.lessons } : {}), ...(last.next_experiment ? { next_experiment: last.next_experiment } : {}),
      ...(last.open_questions ? { open_questions: last.open_questions } : {}) } } : {}),
    closings: events.filter((e) => e.type === 'round_closed').map((e) => e.why),
    ...(end.final ? { its_last_model: end.final } : {}),
    record: 'read it whole: {"delegation": {"id": "' + b.id + '", "read": {"experience": "list", "of": "notes"}}} and the other kinds'
  };
}
