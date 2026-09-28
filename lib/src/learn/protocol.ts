import type { Objective, Place, Rerun, RunOutput } from './objective.ts';

/* ============================================================================
 * The researcher's PROTOCOL, the same for every objective (SPEC-OBJETIVO §3,
 * SPEC-MODELO-DEL-MUNDO §1.1):
 *
 *   1. Every round the model is CHECKED in the laboratories, on cases never seen. With
 *      the paired regression, each laboratory's previous check is run again with it.
 *   2. When System 2 asks to validate and the model holds in all its laboratories, it
 *      is checked in the family places it has not validated in. A model that held in
 *      all of them at the latest check (the same fingerprint, the same laboratories) is
 *      validated on that check, without a new one that could fail by chance.
 *   3. A family place where it does not hold becomes a laboratory.
 *   4. When it holds in every family place, two blind sets nobody has seen decide.
 *
 * What System 2 is told (`view`) is facts and the protocol's own judgments ("holds",
 * "accepted"), never a statistic over its cases. The journal gets the operator's view.
 * ========================================================================== */

export interface ProtocolOptions<M, P extends Place> {
  /** Every place known: laboratories and the family. The protocol changes roles and marks places seen. */
  readonly places: () => readonly P[];
  /** The places of one blind confirmation set, never shown. */
  readonly blindPlaces: (set: number, round: number) => readonly P[];
  /** Two models with the same fingerprint are the same model. */
  readonly fingerprint: (model: M) => string;
  readonly validations: number;
  /** Blind confirmation sets (default 2). */
  readonly confirmSets?: number;
  /** Run each laboratory's previous check again with the new model. */
  readonly pairedRegression: boolean;
  /** Stop the first time System 2 asks to validate, without validating (to see whether an exploration is promising). */
  readonly quick?: boolean;
  /** Operator: the cost counters to meter per round (e.g. Judge calls, LLM calls). */
  readonly cost?: () => Readonly<Record<string, number>>;
  readonly say?: (line: string) => void;
  /** How System 2 is told the role of a place it knows. */
  readonly roleWords?: { readonly laboratory: string; readonly validated: string };
  /** Operator only: models that know nothing (e.g. "the same row again"), run on the same cases as every check. A place
      where one of them holds too is one whose check cannot tell a model from knowing nothing: journalled, never shown. */
  readonly baselines?: readonly { readonly name: string; readonly model: M }[];
}

/** A model's check in one place. */
export interface PlaceOutcome<P, R> {
  readonly place: P;
  readonly results: readonly R[];
  readonly holds: boolean;
  readonly rerun: Rerun<R> | null;
  /** The host's own detail for this place (RunOutput.detail). */
  readonly detail?: unknown;
  /** Operator only: the baselines that hold here too. */
  readonly baselinesHolding?: readonly string[];
}

export interface BlindSet<P, R> {
  readonly ok: boolean;
  readonly places: readonly PlaceOutcome<P, R>[];
  readonly operator?: Record<string, unknown>;
}

export interface RoundOutcome<P, R> {
  readonly round: number;
  readonly attempt: number;
  readonly laboratories: readonly PlaceOutcome<P, R>[];
  /** The round whose check was reused (the model had held there and asked to validate), or null. */
  readonly reused: number | null;
  /** The model holds in every laboratory. */
  readonly held: boolean;
  readonly askedToValidate: boolean;
  readonly validation: {
    readonly places: readonly PlaceOutcome<P, R>[];
    readonly becameLaboratories: readonly string[];
    readonly blind: readonly BlindSet<P, R>[] | null;
    readonly operator?: Record<string, unknown>;
  } | null;
  /** Why a validation asked for was not run. */
  readonly refused: string | null;
  readonly accepted: boolean;
  /** --quick: System 2 judged its model good; the run stops here, without validating. */
  readonly quickStop: boolean;
  /** Operator only: the check's run-level measures. */
  readonly operator?: Record<string, unknown>;
  /** Operator only: what the round cost (the `cost` counters' change). */
  readonly cost: Readonly<Record<string, number>>;
  /** What System 2 is told of this round (its `last_check`). */
  readonly view: Record<string, unknown>;
  /** For the journal's check event: the same facts with the operator's measures. */
  readonly journal: Record<string, unknown>;
}

/** Operator only: milestones and cost of the run, for the journal (SPEC-OBJETIVO O4). */
export interface ProtocolSummary {
  readonly rounds: number;
  readonly checks: number;
  readonly firstHeld: { readonly round: number; readonly attempt: number } | null;
  readonly validations: readonly { readonly round: number; readonly attempt: number; readonly heldIn: readonly string[]; readonly becameLaboratories: readonly string[]; readonly blindConfirmed: boolean | null }[];
  readonly accepted: { readonly round: number; readonly attempt: number } | null;
  readonly cost: Readonly<Record<string, number>>;
  /** The cost up to the acceptance (null when nothing was accepted). */
  readonly costPerAcceptance: Readonly<Record<string, number>> | null;
  /** Rounds whose laboratory check a baseline passed as well (in every laboratory): checks that tell nothing. */
  readonly trivialChecks: readonly number[];
  /** Whether the acceptance was on validations and confirmations a baseline passed as well. */
  readonly acceptedTrivially: boolean | null;
}

const diff = (now: Readonly<Record<string, number>>, before: Readonly<Record<string, number>>): Record<string, number> =>
  Object.fromEntries(Object.keys(now).map((k) => [k, now[k] - (before[k] ?? 0)]));

export class Protocol<M, P extends Place, K, R extends { readonly place: string }> {
  readonly objective: Objective<M, P, K, R>;
  readonly options: ProtocolOptions<M, P>;
  validationsLeft: number;
  /** What System 2 was told of the latest round (null before the first). */
  lastView: Record<string, unknown> | null = null;
  private readonly previous = new Map<string, { cases: K; results: readonly R[] }>();
  private heldAt: { fingerprint: string; round: number; labs: string; outcomes: readonly PlaceOutcome<P, R>[]; operator?: Record<string, unknown> } | null = null;
  private readonly milestones: { rounds: number; checks: number; firstHeld: ProtocolSummary['firstHeld']; validations: ProtocolSummary['validations'][number][];
    accepted: ProtocolSummary['accepted']; costAtAcceptance: Record<string, number> | null; trivialChecks: number[]; acceptedTrivially: boolean | null } =
    { rounds: 0, checks: 0, firstHeld: null, validations: [], accepted: null, costAtAcceptance: null, trivialChecks: [], acceptedTrivially: null };
  private readonly costAtStart: Readonly<Record<string, number>>;

  constructor(objective: Objective<M, P, K, R>, options: ProtocolOptions<M, P>) {
    this.objective = objective;
    this.options = options;
    this.validationsLeft = options.validations;
    this.costAtStart = this.cost();
  }

  private cost(): Readonly<Record<string, number>> { return this.options.cost?.() ?? {}; }
  private say(line: string): void { this.options.say?.(line); }

  laboratories(): P[] { return this.options.places().filter((p) => p.role === 'laboratory'); }

  /** The places System 2 knows, as it is told of them. */
  placesView(): { place: string; role: string }[] {
    return this.options.places().filter((p) => p.role !== 'confirmation' && p.seen)
      .map((p) => ({ place: p.id, role: p.role === 'laboratory' ? this.options.roleWords?.laboratory ?? 'your laboratory: you can act here'
        : this.options.roleWords?.validated ?? 'a place where your model was validated' }));
  }

  /** A new stage (e.g. a harder opponent after an acceptance): nothing checked before counts, and the validations are
      given back. */
  restart(): void {
    this.previous.clear();
    this.heldAt = null;
    this.validationsLeft = this.options.validations;
  }

  /** Checks a model in some places: fresh cases in each, and - for laboratories in a check, with the paired regression -
      the previous check's cases there run again. */
  async checkIn(model: M, places: readonly P[], context: { round: number; attempt: number; purpose: 'check' | 'validation' | 'blind'; set?: number }): Promise<{ outcomes: PlaceOutcome<P, R>[]; operator?: Record<string, unknown> }> {
    if (!places.length) return { outcomes: [] };
    /* In order, one place after another: drawing cases may act on an environment outside (SPEC-OBJETIVO O12). */
    const drawn: { place: P; cases: K }[] = [];
    for (const [index, place] of places.entries()) drawn.push({ place, cases: await this.objective.casesIn(place, { ...context, index }) });
    const out: RunOutput<R> = await this.objective.run(model, drawn, { round: context.round, attempt: context.attempt, purpose: context.purpose });
    /* Operator only: which baselines hold on the very same cases, per place. */
    let baselines: string[][] | null = null;
    if (this.options.baselines?.length) {
      baselines = drawn.map(() => []);
      for (const b of this.options.baselines) {
        const run = await this.objective.run(b.model, drawn, { round: context.round, attempt: context.attempt, purpose: 'baseline' });
        drawn.forEach(({ place }, i) => { if (this.objective.holds(run.byPlace[i] ?? [], { place })) baselines![i].push(b.name); });
      }
    }
    const outcomes: PlaceOutcome<P, R>[] = [];
    for (const [i, { place, cases }] of drawn.entries()) {
      const results = out.byPlace[i] ?? [];
      let rerun: Rerun<R> | null = null;
      const prev = this.previous.get(place.id);
      if (context.purpose === 'check' && this.options.pairedRegression && prev && place.role === 'laboratory') {
        const again = await this.objective.run(model, [{ place, cases: prev.cases }], { round: context.round, attempt: context.attempt, purpose: 'rerun' });
        rerun = { before: prev.results, now: again.byPlace[0] ?? [] };
      }
      if (context.purpose === 'check' && place.role === 'laboratory') this.previous.set(place.id, { cases, results });
      const holds = this.objective.holds(results, { place, ...(rerun ? { rerun } : {}) });
      outcomes.push({ place, results, holds, rerun, ...(out.detail ? { detail: out.detail[i] } : {}), ...(baselines ? { baselinesHolding: baselines[i] } : {}) });
      this.say('  ' + context.purpose + ' in ' + place.id + ': ' + (this.objective.line ? this.objective.line(results, place, rerun ?? undefined) : results.length + ' cases') + (holds ? ' holds' : ''));
    }
    return { outcomes, ...(out.operator ? { operator: out.operator } : {}) };
  }

  /** What System 2 is told of a place's check: whether its model holds there, the verdict of each case, and the paired
      regression. */
  private placeView(o: PlaceOutcome<P, R>): Record<string, unknown> {
    return { place: o.place.id, your_model_holds_here: o.holds, ...this.objective.view(o.results, o.place),
      ...(o.rerun ? { your_previous_check_run_again: this.objective.rerunView ? this.objective.rerunView(o.rerun, o.place) : { cases: o.rerun.now.length } } : {}) };
  }

  /** The operator's record of a place's check. */
  private placeJournal(o: PlaceOutcome<P, R>): Record<string, unknown> {
    const trace = this.objective.trace?.(o.results, o.place);
    return { place: o.place.id, holds: o.holds, ...(this.objective.operatorView?.(o.results, o.place) ?? {}),
      ...(trace?.length ? { trace } : {}),
      ...(o.baselinesHolding?.length ? { baselines_that_hold_too: o.baselinesHolding } : {}),
      ...(o.rerun ? { rerun: this.objective.rerunView ? this.objective.rerunView(o.rerun, o.place) : { cases: o.rerun.now.length } } : {}) };
  }

  /** One round of the protocol for a model System 2 proposed. */
  async round(model: M, context: { round: number; attempt: number; validate: boolean }): Promise<RoundOutcome<P, R>> {
    const { round, attempt } = context;
    const costBefore = this.cost();
    this.milestones.rounds++;
    const labs = this.laboratories();
    const labIds = labs.map((l) => l.id).join(',');
    const fingerprint = this.options.fingerprint(model);
    /* 1. The check in the laboratories - or the check this very model held in, when it asks to validate. */
    const reused = context.validate && this.heldAt && this.heldAt.fingerprint === fingerprint && this.heldAt.labs === labIds ? this.heldAt : null;
    let laboratories: readonly PlaceOutcome<P, R>[];
    let operator: Record<string, unknown> | undefined;
    if (reused) {
      laboratories = reused.outcomes;
      operator = reused.operator;
      this.say('  this model held in every laboratory in round ' + reused.round + ': validated on that check, without checking again');
    } else {
      const check = await this.checkIn(model, labs, { round, attempt, purpose: 'check' });
      laboratories = check.outcomes;
      operator = check.operator;
      this.milestones.checks++;
    }
    const held = laboratories.length > 0 && laboratories.every((o) => o.holds);
    if (!reused) this.heldAt = held ? { fingerprint, round, labs: labIds, outcomes: laboratories, ...(operator ? { operator } : {}) } : null;
    if (held && !this.milestones.firstHeld) this.milestones.firstHeld = { round, attempt };
    const trivial = (os: readonly PlaceOutcome<P, R>[]) => os.length > 0 && os.every((o) => (o.baselinesHolding?.length ?? 0) > 0);
    const checkTrivial = this.options.baselines?.length ? trivial(laboratories) : null;
    if (checkTrivial && !reused) this.milestones.trivialChecks.push(round);

    /* 2. The validation, when System 2 asks for it and its model holds in its laboratories. */
    const quickStop = !!this.options.quick && context.validate;
    let validation: RoundOutcome<P, R>['validation'] = null;
    let refused: string | null = null;
    let accepted = false;
    if (context.validate && !quickStop) {
      if (!held) refused = 'your model does not yet hold in every one of your laboratories: nothing was spent';
      else if (this.validationsLeft <= 0) refused = 'you have no validations left';
      else {
        this.validationsLeft--;
        this.heldAt = null;
        /* Every family place: the ones seen before are checked again (a regression). */
        const family = this.options.places().filter((p) => p.role === 'family');
        for (const f of family) f.seen = true;
        const fam = await this.checkIn(model, family, { round, attempt, purpose: 'validation' });
        /* A place where the model does not hold becomes a laboratory. */
        const becameLaboratories = fam.outcomes.filter((o) => !o.holds).map((o) => { o.place.role = 'laboratory'; return o.place.id; });
        /* 3. It holds everywhere: places nobody has seen decide. */
        let blind: BlindSet<P, R>[] | null = null;
        if (!becameLaboratories.length) {
          blind = [];
          for (let set = 0; set < (this.options.confirmSets ?? 2); set++) {
            const c = await this.checkIn(model, this.options.blindPlaces(set, round), { round, attempt, purpose: 'blind', set });
            blind.push({ ok: c.outcomes.length > 0 && c.outcomes.every((o) => o.holds), places: c.outcomes, ...(c.operator ? { operator: c.operator } : {}) });
          }
          accepted = blind.every((b) => b.ok);
        }
        validation = { places: fam.outcomes, becameLaboratories, blind, ...(fam.operator ? { operator: fam.operator } : {}) };
        this.milestones.validations.push({ round, attempt, heldIn: fam.outcomes.filter((o) => o.holds).map((o) => o.place.id), becameLaboratories, blindConfirmed: blind ? accepted : null });
        this.say('  validation (' + (this.options.validations - this.validationsLeft) + '/' + this.options.validations + ')' +
          (becameLaboratories.length ? ': now laboratories: ' + becameLaboratories.join(', ') : ': holds in every family place; blind confirmation ' + (accepted ? 'CONFIRMED' : 'NOT confirmed')));
      }
      if (refused) this.say('  validation refused: ' + refused);
    }
    const costNow = this.cost();
    if (accepted && !this.milestones.accepted) {
      this.milestones.accepted = { round, attempt };
      this.milestones.costAtAcceptance = diff(costNow, this.costAtStart);
      if (this.options.baselines?.length && validation) this.milestones.acceptedTrivially = trivial(validation.places) && (validation.blind ?? []).every((b) => trivial(b.places));
    }

    const view: Record<string, unknown> = {
      round,
      ...(reused ? { not_checked_again: 'this model already held in every one of your laboratories in round ' + reused.round + ': these are the verdicts of that check' } : {}),
      laboratories: laboratories.map((o) => this.placeView(o)),
      ...(validation ? { validation: { validated_in: validation.places.map((o) => this.placeView(o)), ...(validation.becameLaboratories.length ? { now_your_laboratories: validation.becameLaboratories } : {}) } }
        : refused ? { validation: { refused } } : {}),
      accepted,
      validations_left: this.validationsLeft
    };
    this.lastView = view;
    const cost = diff(costNow, costBefore);
    const journal: Record<string, unknown> = {
      round, attempt, ...(reused ? { reused_check_of_round: reused.round } : {}),
      laboratories: laboratories.map((o) => this.placeJournal(o)), ...(operator ? { check_operator: operator } : {}),
      ...(checkTrivial !== null ? { check_is_trivial: checkTrivial } : {}),
      asked_to_validate: context.validate,
      ...(validation ? { validation: {
        family: validation.places.map((o) => this.placeJournal(o)), ...(validation.operator ? { family_operator: validation.operator } : {}),
        became_laboratories: validation.becameLaboratories,
        ...(validation.blind ? { blind_confirmation: { confirmed: accepted, sets: validation.blind.map((b) => ({ ok: b.ok, places: b.places.map((o) => this.placeJournal(o)), ...(b.operator ? { operator: b.operator } : {}) })) } } : {})
      } } : refused ? { validation: { refused } } : {}),
      accepted, validations_left: this.validationsLeft, cost
    };
    return { round, attempt, laboratories, reused: reused ? reused.round : null, held, askedToValidate: context.validate, validation, refused, accepted, quickStop,
      ...(operator ? { operator } : {}), cost, view, journal };
  }

  /** Operator only: the run's milestones and cost (SPEC-OBJETIVO O4). */
  summary(): ProtocolSummary {
    const m = this.milestones;
    return { rounds: m.rounds, checks: m.checks, firstHeld: m.firstHeld, validations: m.validations, accepted: m.accepted,
      cost: diff(this.cost(), this.costAtStart), costPerAcceptance: m.costAtAcceptance, trivialChecks: m.trivialChecks, acceptedTrivially: m.acceptedTrivially };
  }
}
