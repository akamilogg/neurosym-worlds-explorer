import { hashString, stableStringify } from '../core/hash.ts';
import type { ApiError } from '../core/net.ts';
import type { Law } from '../core/predict.ts';
import { parseReflection } from './explorer.ts';
import { lawExplorerPayload, ownLaw, parseLawTurn, type LawRequest } from './law-explorer.ts';
import { RoundConversation } from './system2.ts';
import { Notebook } from './notebook.ts';
import { FREE_MEMORY_ANSWERS, JournalMemory } from './assisted/memory.ts';
import type { ChatClient } from './system2.ts';

/* ============================================================================
 * A session with System 2 for a world whose answer is a MODEL (observations, rules,
 * weights, output): its rounds, its notebook, and one consultation - investigation
 * steps, then a proposal (or, at the end, a reflection). The same for every world: what a
 * world brings is its instruments (`runRequest`), how it names points (`known`), how a
 * proposal is tried on the learner's own points before anything uses it (`failures`),
 * and the protocol's view (places, validations left, the last check).
 *
 * Nothing here knows what the world is. System 2 is told facts and the protocol's
 * verdicts only (SPEC-MUNDO-FISICO I2); the journal gets everything.
 * ========================================================================== */

export interface LawRecord {
  readonly round: number;
  readonly law: Law;
  readonly fingerprint: string;
  /** Operator only: what the host keeps of the law's check, never shown to System 2. */
  test: Record<string, number> | null;
  accepted: boolean;
  /** System 2 asked to validate this law. */
  readonly validate: boolean;
  readonly lessons: string[];
  readonly nextExperiment: string;
}

export interface LawSessionHost<A> {
  readonly llm: ChatClient;
  /** The system prompt (the common one, with the world's interface). */
  readonly system: string;
  /** The world id a law is written for. */
  readonly world: string;
  /** The shape of what is perceived, as the sense describes it. */
  readonly perceptDoc: string;
  /** Investigation answers per round (0 with no instruments). */
  readonly steps: number;
  readonly investigative: boolean;
  /** Acts per round, when the world offers `act`. */
  readonly acts?: number;
  /** The world's act parameters, or why they cannot be read (a world without `act` says so). */
  readonly parseAct: (raw: Record<string, unknown>) => A | string;
  runRequest(request: LawRequest<A>, budget: { acts: number }, round: number): Promise<unknown>;
  /** Whether a reference names an episode or a point of the learner's. */
  known(ref: string): boolean;
  /** A law must compute on points of the learner's own episodes before anything uses it: why it does not. */
  failures(law: Law): string[];
  /** The index of episodes, as the notebook shows it. */
  episodes(): unknown[];
  /** The protocol's view: places known, validations left, the last check. */
  places(): readonly unknown[];
  validationsLeft(): number;
  lastCheck(): unknown;
  /** How an act is echoed back in the prompt's words (default: as parsed). */
  actAsWritten?(act: A): unknown;
  /** Requests of instruments the researcher brings (`runRequest` gets them as `{ extra }`); none by default. */
  extraRequest?(q: Record<string, unknown>): boolean;
  /** The researcher's selective memory over its own record (the assisted one, SPEC-INVESTIGADOR-ASISTIDO §13), built over
      the session: its notebook travels abridged, it recalls the rest itself, and answers of only memory requests are free.
      None by default. */
  memory?(session: LawSession<A>): JournalMemory;
  /** How many times a round it may ask to investigate with no steps left before it counts as a refusal (logged); 0 by
      default. */
  readonly overreach?: number;
  log(type: string, data?: Record<string, unknown>): void;
  say(text: string): void;
  /** Asked before each consultation of System 2: a reason to stop now (cancelled, a budget spent), or null. */
  halt?(): string | null;
}

/** A law's identity: its own code and words (the same law has the same fingerprint). */
export const lawFingerprint = (law: Law): string => hashString(stableStringify(ownLaw(law))).slice(0, 10);

export class LawSession<A> {
  readonly host: LawSessionHost<A>;
  readonly laws: LawRecord[] = [];
  readonly notebook = new Notebook();
  currentRound = 0;
  /** Set when the LLM service refuses the account itself (no credit, bad key): nothing further can be asked. */
  fatal: string | null = null;
  /** Set when the host stopped the session (`halt`): nothing further is asked. */
  halted: string | null = null;
  private unaddressed: string[] = [];
  /** Its selective memory, when the host gives it one. */
  readonly memory: JournalMemory | null;

  constructor(host: LawSessionHost<A>) { this.host = host; this.memory = host.memory?.(this) ?? null; }

  latest(): LawRecord | null { return this.laws[this.laws.length - 1] ?? null; }
  lawOfRound(round: number): Law | null { return this.laws.find((l) => l.round === round)?.law ?? null; }
  /** A round of its own, a draft it wrote, or (null) its latest law. */
  lawOf(ref: number | Law | null): Law | null { return ref === null ? this.latest()?.law ?? null : typeof ref === 'number' ? this.lawOfRound(ref) : ref; }

  /** Its notebook as it reads it: its own entries, the episodes, every model it tried with what came of it. */
  notebookBrief(): Record<string, unknown> {
    const last = this.latest();
    /* With a selective memory, abridged by its fixed rule (its episodes and models included). */
    if (this.memory) return { ...this.memory.brief(this.currentRound, this.unaddressed), ...(last ? { your_last_lessons: last.lessons, your_planned_next_experiment: last.nextExperiment } : {}) };
    const { episodes: _g, models: _r, ...own } = this.notebook.brief(this.unaddressed) as Record<string, unknown>;
    return {
      ...own,
      episodes: this.host.episodes(),
      models: this.laws.map((l) => ({ round: l.round, fingerprint: l.fingerprint, model: ownLaw(l.law), accepted: l.accepted })),
      ...(last ? { your_last_lessons: last.lessons, your_planned_next_experiment: last.nextExperiment } : {})
    };
  }

  /** One round: investigation steps, then a proposal - or, with `reflect`, a reflection (the law is final). */
  async consult(mode: 'propose' | 'reflect', reflectionTask: string | null = null): Promise<LawRecord | null> {
    const h = this.host;
    if (this.fatal || this.halted) return null;
    this.currentRound++;
    const round = this.currentRound;
    const b = this.latest();
    let refused: string[] = [];
    const investigation: unknown[] = [];
    let steps = 0, refusals = 0, free = 0, overreach = 0;
    const budget = { acts: h.acts ?? 0 };
    const memory = this.memory;
    /* The verdicts it was given on its latest model, kept in its memory by that model's round. */
    if (memory && b) memory.recordCheck(b.round, h.lastCheck());
    const talk = new RoundConversation();
    const counters = (): Record<string, unknown> => ({ ...(h.investigative ? { steps_left: Math.max(0, h.steps - (steps - free)) } : {}),
      ...(h.acts !== undefined ? { acts_left: budget.acts } : {}), ...(memory ? { memory_answers_left: FREE_MEMORY_ANSWERS - free, memory: memory.counts() } : {}) });
    let told: string[] = refused;
    let written: Record<string, unknown> = {};
    while (refusals < 3 && steps - free - overreach <= h.steps + 3) {
      const halt = h.halt?.() ?? null;
      if (halt) {
        this.halted = halt;
        h.log('halted', { round, step: steps, reason: halt });
        h.say('stopping before asking System 2 again: ' + halt);
        return null;
      }
      const stepsLeft = h.investigative ? Math.max(0, h.steps - (steps - free)) : 0;
      if (refused !== told && refused.length) { talk.add({ your_previous_answer_was_refused: refused, ...written, ...counters() }); written = {}; }
      told = refused;
      talk.open(() => ({ ...lawExplorerPayload({ round, perceptDoc: h.perceptDoc, notebook: this.notebookBrief(), law: b?.law ?? null, lawRound: b?.round ?? null,
        setups: h.places(), validationsLeft: h.validationsLeft(), lastTest: h.lastCheck(), task: mode === 'reflect' ? reflectionTask : null }), ...counters() }));
      const payload = talk.question();
      h.say('round ' + round + (steps ? ' step ' + steps : '') + ': consulting System 2 (' + Math.round(JSON.stringify(payload).length / 1024) + ' KB)');
      steps++;
      let content = '';
      try {
        content = (await h.llm.complete({ system: h.system, user: payload })).content;
      } catch (error) {
        const status = (error as ApiError)?.details?.status;
        if (status === 401 || status === 402 || status === 403) {
          this.fatal = String((error as Error)?.message || error);
          h.log('llm_fatal', { round, status, error: this.fatal });
          h.say('the LLM service refused the account (HTTP ' + status + '): stopping');
          return null;
        }
        refusals++;
        h.log('proposal_failed', { round, error: String((error as Error)?.message || error) });
        continue;
      }
      const turn = parseLawTurn<A>(content, { world: h.world, round, parseAct: h.parseAct, ...(h.extraRequest ? { extraRequest: (q) => h.extraRequest!(q) } : {}), ...(memory ? { archive: true } : {}) });
      const noteWarnings = [...this.notebook.applyNotes(round, turn.notes, (ref) => h.known(ref)), ...this.notebook.applyMethods(round, turn.methods)];
      written = { ...(turn.notes.length ? { your_notes: turn.notes } : {}), ...(turn.methods.length ? { your_methods: turn.methods } : {}) };
      if (turn.notes.length) h.say('  notes: ' + turn.notes.map((n) => n.do + ' ' + n.id).join(', '));
      if (turn.methods.length) { h.say('  methods: ' + turn.methods.map((m) => m.do + ' ' + m.id).join(', ')); h.log('methods', { round, methods: turn.methods }); }
      if (turn.kind === 'investigate') {
        /* With a memory: an answer of only memory requests asks nothing of the world and is free, a few times a round; with
           no steps left, the memory requests of an answer are still answered (the rest not, said so). */
        let requests = turn.requests;
        const warnings = [...turn.warnings];
        const recalls = memory ? requests.filter((r) => 'extra' in r && JournalMemory.accepts(r.extra)) : [];
        let onlyMemory = memory !== null && requests.length > 0 && recalls.length === requests.length && free < FREE_MEMORY_ANSWERS;
        if (!onlyMemory && memory !== null && stepsLeft <= 0 && recalls.length && free < FREE_MEMORY_ANSWERS) {
          requests = recalls; onlyMemory = true;
          warnings.push('no investigation steps left this round: only your memory requests were answered');
        }
        if (onlyMemory) free++;
        else if (stepsLeft <= 0) {
          refused = [h.investigative ? 'no investigation steps left this round: answer with your proposal now' : 'there is no investigating in this experiment: answer with your proposal'];
          /* A researcher allowed to may insist a few times before it is a refusal (a round without a proposal ends the run). */
          if (h.investigative && overreach < (h.overreach ?? 0)) {
            overreach++;
            h.log('investigation_refused', { round, reason: 'no investigation steps left', reminders_left: (h.overreach ?? 0) - overreach, requests: requests.map((r) => ('extra' in r ? r.extra : r)) });
            h.say('  refused: no investigation steps left (reminder ' + overreach + ' of ' + h.overreach + ')');
          } else {
            refusals++;
            h.say('  refused: ' + refused[0] + ' (refusal ' + refusals + ' of 3)');
          }
          continue;
        }
        const results: unknown[] = [];
        for (const r of requests) results.push(await h.runRequest(r, budget, round));
        /* Echoed in the prompt's words, and a draft as it wrote it, never as the host's objects. */
        const modelOf = (l: number | Law | null) => (l !== null && typeof l === 'object' ? ownLaw(l) : l);
        const asWritten = requests.map((r) => 'simulate' in r ? { simulate: r.simulate, model: modelOf(r.law), steps: r.rows }
          : 'inspect' in r ? { inspect: r.inspect, model: modelOf(r.law) }
          : 'act' in r ? { act: h.actAsWritten ? h.actAsWritten(r.act) : r.act } : 'extra' in r ? r.extra : r);
        const entry = { step: investigation.length + 1, requests: asWritten, results, ...(warnings.length || noteWarnings.length ? { warnings: [...warnings, ...noteWarnings] } : {}) };
        investigation.push(entry);
        talk.add({ investigation_step: entry, ...written, ...counters() });
        written = {};
        memory?.recordInvestigation(round, entry.step, entry);
        h.log('investigation', { round, requests: asWritten, results, warnings: [...warnings, ...noteWarnings], notes: turn.notes, ...(onlyMemory ? { free: true } : {}) });
        h.say('  investigates: ' + requests.map((r, i) => {
          const res = results[i] as { error?: string };
          const k = Object.keys('extra' in r ? r.extra : r)[0];
          return k + (res?.error ? ' (' + res.error.slice(0, 60) + ')' : '');
        }).join('; '));
        refused = [];
        continue;
      }
      if (mode === 'reflect') {
        const r = parseReflection(content, round);
        if (!r.ok) { refused = r.errors; refusals++; h.log('reflection_refused', { round, errors: r.errors, content }); continue; }
        const stances = this.notebook.applyStances(round, r.reflection.beliefs);
        this.unaddressed = stances.unaddressed;
        this.notebook.recordReflection(round, r.reflection.rationale, r.reflection.lessons, r.reflection.nextExperiment);
        h.log('reflection', { round, investigation_steps: investigation.length, rationale: r.reflection.rationale, beliefs: r.reflection.beliefs, notes: turn.notes,
          lessons: r.reflection.lessons, next_experiment: r.reflection.nextExperiment, stance_warnings: stances.warnings, note_warnings: noteWarnings });
        for (const l of r.reflection.lessons) h.say('  lesson: ' + l);
        return null;
      }
      const parsed = turn.parse;
      if (!parsed.ok) {
        refused = parsed.errors; refusals++;
        h.log('proposal_refused', { round, errors: parsed.errors, content });
        h.say('  refused: ' + parsed.errors.slice(0, 3).join(' | '));
        continue;
      }
      const failures = h.failures(parsed.proposal.law);
      if (failures.length) {
        refused = ['your model failed on points of your episodes: ' + failures.join(' | ')]; refusals++;
        h.log('proposal_refused', { round, errors: refused, content });
        h.say('  refused: ' + refused[0].slice(0, 200));
        continue;
      }
      const p = parsed.proposal;
      const stances = this.notebook.applyStances(round, p.beliefs);
      this.unaddressed = stances.unaddressed;
      const record: LawRecord = { round, law: p.law, fingerprint: lawFingerprint(p.law), test: null, accepted: false, validate: p.validate, lessons: p.lessons, nextExperiment: p.nextExperiment };
      this.laws.push(record);
      h.log('proposal', { round, investigation_steps: investigation.length, rationale: p.rationale, beliefs: p.beliefs, notes: turn.notes, law: ownLaw(p.law),
        fingerprint: record.fingerprint, lessons: p.lessons, next_experiment: p.nextExperiment, warnings: [...p.warnings, ...stances.warnings, ...noteWarnings] });
      h.say('  proposes: ' + Object.keys(p.law.observations).length + ' observations, ' + Object.keys(p.law.rules).length + ' rules' + (p.law.output ? ', output in code' : '') +
        '; beliefs ' + p.beliefs.map((x) => x.id + ':' + x.stance).join(' ') + (p.validate ? '; asks to validate' : ''));
      return record;
    }
    h.log('no_proposal', { round, refusals });
    return null;
  }
}
