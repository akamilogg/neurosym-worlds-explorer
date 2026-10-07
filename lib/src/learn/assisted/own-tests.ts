/* ============================================================================
 * Tests of the researcher's own (SPEC-PRUEBAS-PROPIAS, T2): the assisted researcher designs the
 * test its model must pass - a protocol (an act of the world), its model and a rival, frozen by
 * their fingerprints when registered, before anyone looks. When the round closes the environment
 * runs the protocol and answers as a check does: whether each model holds there. A test is
 * SEVERE when the model holds and the rival does not; a valid test the model fails stays open
 * as a COUNTEREXAMPLE of that model until a later model holds on its episode (a regression,
 * never a prediction). Informative only: what counts for acceptance is the protocol's (T3).
 *
 * The world is the laboratory's: the protocol is read by its `act.parse`, what an experiment is
 * by its `act.identity` and `episodeIdentity`, its public rivals are `lab.rivals`, and the
 * verdict is its objective's. Nothing of a world here.
 * ========================================================================== */

/** What the assisted researcher is told of its tests, with the public rivals of its laboratory. */
export function ownTestsSection(rivals: readonly { readonly name: string; readonly about: string }[], identities: boolean, need = 0): string {
  return [
    'TESTS OF YOUR OWN. Before you trust a model, you may design the test that would refute it, as an investigation request: {"register_test": {"protocol": { ...an act... }, "model": <a round of yours, or a draft>, "rival": <another round or draft' + (rivals.length ? ', or "rival:<name>"' : '') + '>, "claim": "what your model predicts there that the rival does not, and why", "kind": "new" | "replicate", "place": "<one of your laboratories>"}}.',
    'It is registered before anyone looks: the model and the rival are frozen as they are then, and the test is a prediction of that model only. ' + (identities ? '"new" must be an experiment you have not seen (what is stimulated or changed and for how long - not what you record); "replicate", one you have seen.' : 'This environment cannot tell new experiments: only "replicate" one of your own acts.'),
    'The rival must explain what both models have already seen as well as yours does: it must hold in at least as many of your laboratories, on the points of your latest checks there. A test costs one act.',
    'When the round closes the environment runs the protocol (an episode "test<n>", yours to study) and answers with your next check, in `your_tests`: whether your model holds there, whether the rival does, and whether the test was severe - yours holds and the rival does not. A rival that cannot answer there makes no test severe.',
    'A valid test your model fails stays open, in `open_counterexamples`, until a later model of yours holds on its episode.'
    + (need > 0 ? '\nIN THIS RUN THEY COUNT: a model of yours is confirmed in the places nobody has seen only once it has passed ' + need + ' severe test' + (need > 1 ? 's' : '') + ' registered with that very model (a test registered with another model never counts as its prediction), holds on the episodes of your other tests or has their counterexamples closed, and has no counterexample of its own open. Until then a validation stops after your family places.' : '')
    + (rivals.length ? '\nRivals you may name: ' + rivals.map((r) => '"rival:' + r.name + '" (' + r.about + ')').join('; ') + '.' : '')
  ].join('\n');
}

export interface OwnTestsHost<L, A, E> {
  parseAct(raw: Record<string, unknown>): A | string;
  asWritten(act: A): unknown;
  /** The place an act asks for (default: the first laboratory), and whether it is one of the learner's laboratories. */
  placeOf(act: A): string;
  laboratories(): readonly string[];
  /** The experiment an act is in a place (null: it cannot be said, or it names what the run does not have). */
  identity(place: string, act: A): string | null;
  /** Whether the laboratory can say what an experiment is at all. */
  readonly identities: boolean;
  /** The identities of the episodes the learner has seen, and its own acts as written (JSON). */
  seen(): { readonly identities: ReadonlyMap<string, string>; readonly acts: ReadonlyMap<string, string> };
  /** A model by a round of the learner's, or a draft it wrote; or why not. */
  model(ref: unknown): L | string;
  rival(name: string): L | null;
  rivalNames(): readonly string[];
  fingerprint(law: L): string;
  /** OPERATOR ONLY: a model as the journal keeps it (for the audit's questions on the test). */
  describe?(law: L): unknown;
  /** In how many of the learner's laboratories the model holds on the points of its latest check there; null with none. */
  sharedHolds(law: L): Promise<number | null>;
  /** The protocol run as an episode of the learner's (named `id`), or null when the environment refuses it. */
  start(place: string, act: A, id: string, round: number): Promise<E | null>;
  /** The points of that episode a check is made of. */
  cases(place: string, id: string, episode: E): readonly unknown[];
  /** The objective's verdict on a model at those points: whether it holds, and what the learner is told of them. */
  evaluate(law: L, place: string, cases: readonly unknown[], round: number): Promise<{ holds: boolean; view: Record<string, unknown> }>;
  /** Whether a model answers in the form asked at every point (a rival that cannot answer refutes nothing). */
  answers(law: L, cases: readonly unknown[]): Promise<boolean>;
  log(type: string, data: Record<string, unknown>): void;
}

interface Registered<L, A> {
  readonly id: string;
  readonly round: number;
  readonly by: string;
  readonly act: A;
  readonly place: string;
  readonly kind: 'new' | 'replicate';
  readonly identity: string | null;
  readonly model: L;
  readonly rival: L;
  readonly rivalName: string | null;
  readonly claim: string;
}

interface Counterexample { readonly test: string; readonly model: string; readonly episode: string; readonly place: string; readonly cases: readonly unknown[]; readonly round: number }

export class OwnTests<L, A, E> {
  private readonly host: OwnTestsHost<L, A, E>;
  private n = 0;
  private pending: Registered<L, A>[] = [];
  private results: Record<string, unknown>[] = [];
  private open: Counterexample[] = [];
  /** Every valid test run: of which model, on which episode, and how it came out. */
  private valid: { readonly test: string; readonly model: string; readonly episode: string; readonly place: string; readonly cases: readonly unknown[]; readonly holds: boolean; readonly severe: boolean }[] = [];

  constructor(host: OwnTestsHost<L, A, E>) { this.host = host; }

  static accepts(q: Record<string, unknown>): boolean { return q.register_test !== undefined; }

  /** A request to register a test: registered (it costs one act), or why not. */
  async register(q: Record<string, unknown>, round: number, budget: { acts: number }, by = 'you'): Promise<Record<string, unknown>> {
    const h = this.host;
    const rt = q.register_test && typeof q.register_test === 'object' ? q.register_test as Record<string, unknown> : null;
    const refuse = (why: string) => ({ register_test: rt ? { ...(rt.claim ? { claim: rt.claim } : {}) } : q.register_test, registered: false, error: why });
    if (!rt) return refuse('"register_test" is { protocol, model, rival, claim, kind, place }');
    const raw = rt.protocol && typeof rt.protocol === 'object' && !Array.isArray(rt.protocol) ? { ...(rt.protocol as Record<string, unknown>), ...(typeof rt.place === 'string' ? { place: rt.place } : {}) } : null;
    if (!raw) return refuse('"protocol" is an act, as you would ask for one');
    const act = h.parseAct(raw);
    if (typeof act === 'string') return refuse('the protocol: ' + act);
    const place = h.placeOf(act);
    if (!h.laboratories().includes(place)) return refuse('a test runs in one of your laboratories: ' + h.laboratories().join(', '));
    if (rt.model === undefined) return refuse('"model": a round of yours, or a draft');
    const model = h.model(rt.model);
    if (typeof model === 'string') return refuse('the model: ' + model);
    if (rt.rival === undefined) return refuse('"rival": another round of yours, a draft' + (h.rivalNames().length ? ', or "rival:<name>" (' + h.rivalNames().join(', ') + ')' : ''));
    let rival: L | string;
    let rivalName: string | null = null;
    if (typeof rt.rival === 'string' && rt.rival.startsWith('rival:')) {
      rivalName = rt.rival.slice(6);
      rival = h.rival(rivalName) ?? 'no rival "' + rivalName + '"' + (h.rivalNames().length ? ' (rivals: ' + h.rivalNames().join(', ') + ')' : ' in this environment');
    } else rival = h.model(rt.rival);
    if (typeof rival === 'string') return refuse('the rival: ' + rival);
    if (h.fingerprint(model) === h.fingerprint(rival)) return refuse('the rival is the model itself');
    const kind = rt.kind === 'replicate' ? 'replicate' : 'new';
    const identity = h.identity(place, act);
    const seen = h.seen();
    if (kind === 'new') {
      if (!h.identities) return refuse('this environment cannot tell a new experiment: only "replicate" one of your own acts');
      if (identity === null) return refuse('the protocol names what this environment does not have');
      if (seen.identities.has(identity)) return refuse('not new: you have seen this experiment (' + seen.identities.get(identity) + ')');
    } else {
      const was = identity !== null ? seen.identities.get(identity) : seen.acts.get(JSON.stringify(h.asWritten(act)));
      if (!was) return refuse('a replication is of an experiment you have seen: this one you have not');
    }
    if (budget.acts <= 0) return refuse('no acts left this round');
    /* §5: the rival must explain the evidence both have seen as well as the model. */
    const [m, r] = [await h.sharedHolds(model), await h.sharedHolds(rival)];
    if (m === null || r === null) return refuse('there is no shared evidence yet: register a test after a check');
    if (r < m) return refuse('the rival does not explain what both have seen: it holds in ' + r + ' of your laboratories, your model in ' + m);
    budget.acts--;
    const directive = typeof rt.directive === 'string' && rt.directive ? rt.directive : null;
    if (directive) by = 'senior';
    const t: Registered<L, A> = { id: 't' + (++this.n), round, by, act, place, kind, identity, model, rival, rivalName, claim: typeof rt.claim === 'string' ? rt.claim : '' };
    this.pending.push(t);
    h.log('test_registered', { test: t.id, round, by, ...(directive ? { directive } : {}), protocol: h.asWritten(act), place, kind, identity, model: h.fingerprint(model),
      rival: rivalName ? 'rival:' + rivalName : h.fingerprint(rival), claim: t.claim, shared: { model_holds_in: m, rival_holds_in: r },
      ...(h.describe ? { model_law: h.describe(model), rival_law: h.describe(rival) } : {}) });
    return { register_test: t.id, registered: true, runs: 'when this round closes; its result comes with your next check, in your_tests' };
  }

  /** At the close of a round: each test registered runs, and is answered with the next check. */
  async runPending(round: number): Promise<void> {
    const h = this.host;
    for (const t of this.pending.splice(0)) {
      const episode = 'test' + t.id.slice(1);
      const data = await h.start(t.place, t.act, episode, round);
      if (data === null) { this.answer(t, { valid: false, why: 'the environment refused the protocol' }); continue; }
      const cases = h.cases(t.place, episode, data);
      if (!cases.length) { this.answer(t, { episode, valid: false, why: 'its episode has no points to check' }); continue; }
      const model = await h.evaluate(t.model, t.place, cases, round);
      const rivalAnswers = await h.answers(t.rival, cases);
      const rival = rivalAnswers ? await h.evaluate(t.rival, t.place, cases, round) : null;
      const severe = model.holds && rival !== null && !rival.holds;
      if (!model.holds) this.open.push({ test: t.id, model: h.fingerprint(t.model), episode, place: t.place, cases, round });
      this.valid.push({ test: t.id, model: h.fingerprint(t.model), episode, place: t.place, cases, holds: model.holds, severe });
      this.answer(t, { episode, valid: true, model_holds: model.holds, rival_holds: rival ? rival.holds : null, ...(rival ? {} : { rival_could_not_answer: true }), severe,
        ...(model.holds ? {} : { counterexample: true }), verdicts: model.view });
    }
  }

  /** A later model: each open counterexample it holds on is closed - by regression, never as a prediction. */
  async closeBy(law: L, round: number): Promise<void> {
    const h = this.host;
    for (const c of [...this.open]) {
      if (c.model === h.fingerprint(law)) continue;
      if (!(await h.evaluate(law, c.place, c.cases, round)).holds) continue;
      this.open = this.open.filter((x) => x !== c);
      h.log('counterexample_closed', { test: c.test, round, by: 'regression', model: h.fingerprint(law) });
      this.results.push({ test: c.test, counterexample_closed: 'your model of round ' + round + ' holds on ' + c.episode });
    }
  }

  /** What the learner is told with its next check: the results since, and the counterexamples still open. */
  view(): Record<string, unknown> {
    const out = { ...(this.results.length ? { your_tests: this.results.splice(0) } : {}),
      ...(this.open.length ? { open_counterexamples: this.open.map((c) => ({ test: c.test, episode: c.episode, of_model: c.model })) } : {}) };
    return out;
  }

  /** Of a model (SPEC-PRUEBAS-PROPIAS §7): the severe tests it passed as registered with it - its predictions - and the tests
      registered with other models it holds on too, their episodes answered again (a regression, never a prediction); and
      the valid tests it neither holds on nor has a closed counterexample for. */
  async standing(law: L, round: number): Promise<{ preregistered: string[]; regression: string[]; failing: string[] }> {
    const h = this.host, fp = h.fingerprint(law);
    const out = { preregistered: [] as string[], regression: [] as string[], failing: [] as string[] };
    for (const v of this.valid) {
      if (v.model === fp) {
        if (v.severe) out.preregistered.push(v.test);
        if (!v.holds && this.open.some((c) => c.test === v.test)) out.failing.push(v.test);
        continue;
      }
      if ((await h.evaluate(law, v.place, v.cases, round)).holds) out.regression.push(v.test);
      else if (this.open.some((c) => c.test === v.test)) out.failing.push(v.test);
    }
    return out;
  }

  /** `--own-tests N`, before a blind confirmation is spent: why this model may not be confirmed yet, or null. */
  async requirement(law: L, need: number, round: number): Promise<string | null> {
    const s = await this.standing(law, round);
    if (s.preregistered.length < need) return 'your model has passed ' + s.preregistered.length + ' of the ' + need + ' severe tests of your own it needs - tests registered with this very model, before they ran';
    if (s.failing.length) return 'your model does not hold on the episodes of your tests ' + s.failing.join(', ') + ', whose counterexamples are open';
    return null;
  }

  /** The operator's count (the finding's). */
  summary(): Record<string, unknown> {
    return { registered: this.n, valid: this.valid.length, severe: this.valid.filter((v) => v.severe).length,
      counterexamples: this.valid.filter((v) => !v.holds).length, open_counterexamples: this.open.map((c) => c.test) };
  }

  private answer(t: Registered<L, A>, r: Record<string, unknown>): void {
    const result = { test: t.id, claim: t.claim, kind: t.kind, ...r };
    this.results.push(result);
    const { verdicts: _v, ...logged } = result as Record<string, unknown>;
    this.host.log('test_result', { ...logged, round: t.round, by: t.by });
  }
}
