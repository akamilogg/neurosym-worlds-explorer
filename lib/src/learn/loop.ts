/* ============================================================================
 * The attempt loop: the learner's decisions at every boundary, world-neutral.
 *
 *   measure       the candidate plays a set of trial games with a FROZEN formula
 *   directive     an operator directive overrides the boundary - including acceptance,
 *                 because "it just won" is exactly the local minimum it may escape
 *   accept        only if EVERY game was won; a win obtained while the formula moved
 *                 inside the games is a hypothesis, re-verified in clean games first
 *   curriculum    a clean win may raise the bar (a stronger opponent) instead of ending
 *                 the run; the last winner at a lower bar is the incumbent (the ceiling)
 *   otherwise     consolidate the attempt's doubts once, or ask for the next hypothesis
 *                 from the best score so far; no proposal => the loop stops (the learner
 *                 never invents a formula)
 *
 * Everything concrete (playing, proposing, logging) is a hook. The loop only decides.
 * ========================================================================== */

export interface TrialGame {
  readonly outcome: string;
  readonly plies: number;
  /** Times the formula was revised inside this game (a win with revisions is a hypothesis). */
  readonly midgameChanges?: number;
}

export interface AttemptScore<F> {
  readonly formula: F;
  readonly wins: number;
  readonly total: number;
  readonly perfect: boolean;
  readonly games: readonly TrialGame[];
  cleanVerified?: boolean;
}

export interface LoopHooks<F, E, D> {
  readonly budget: number;
  /** False stops the loop before the next attempt (paused, reset, crashed). */
  isRunning(): boolean;
  onAttemptStart?(attempt: number, candidate: F): void;
  /** Play the trial games with the candidate frozen. A score with total 0 stops the loop. */
  measure(candidate: F, attempt: number): Promise<AttemptScore<F>>;
  onMeasured?(attempt: number, score: AttemptScore<F>): void | Promise<void>;
  /** A queued operator directive, consumed once (null when none). */
  takeDirective?(): D | null;
  directiveCandidate?(candidate: F, attempt: number, score: AttemptScore<F>, directive: D): Promise<F | null>;
  onDirectiveFailed?(attempt: number): void;
  /** A new best score (the highest wins so far). */
  onBest?(attempt: number, score: AttemptScore<F>): void;
  /** Replay the trial games with the formula frozen (the win had mid-game revisions). */
  verifyClean(candidate: F, attempt: number, revisedGames: readonly TrialGame[]): Promise<AttemptScore<F>>;
  onCleanVerification?(attempt: number, clean: AttemptScore<F>, passed: boolean): void;
  /** The curriculum: true when the bar was raised (the same candidate is measured again, harder). */
  escalate?(score: AttemptScore<F>): boolean;
  /** Evidence a lost (or failed-clean) score carries for the next proposal. */
  lossEvidence(score: AttemptScore<F>): E;
  onRejected?(attempt: number, score: AttemptScore<F>, evidence: E): void;
  /** The attempt's recorded doubts answered once at the boundary (null: nothing to answer or no change). */
  consolidate?(attempt: number, score: AttemptScore<F>): Promise<F | null>;
  nextHypothesis(from: F, attempt: number, evidence: E): Promise<F | null>;
  onNoHypothesis?(attempt: number, after: 'clean_verification' | 'rejection'): void;
}

export interface LoopResult<F> {
  /** Won every game (cleanly) at the final bar. */
  readonly accepted: AttemptScore<F> | null;
  /** The last formula that won every game at a LOWER bar before the curriculum rose (the ceiling). */
  readonly incumbent: AttemptScore<F> | null;
  /** The highest score of the run. */
  readonly best: AttemptScore<F> | null;
  readonly attempts: number;
  readonly escalations: number;
  readonly stoppedBy: 'accepted' | 'budget' | 'no_hypothesis' | 'not_running' | 'no_games';
}

export async function runAttempts<F, E, D>(first: F, hooks: LoopHooks<F, E, D>): Promise<LoopResult<F>> {
  let candidate = first;
  let best: AttemptScore<F> | null = null;
  let incumbent: AttemptScore<F> | null = null;
  let escalations = 0;
  let attempts = 0;
  const finish = (accepted: AttemptScore<F> | null, stoppedBy: LoopResult<F>['stoppedBy']): LoopResult<F> =>
    ({ accepted, incumbent, best, attempts, escalations, stoppedBy });
  const climb = (score: AttemptScore<F>): boolean => {
    if (!hooks.escalate || !hooks.escalate(score)) return false;
    incumbent = score;
    escalations++;
    return true;
  };

  for (let attempt = 1; attempt <= hooks.budget; attempt++) {
    if (!hooks.isRunning()) return finish(null, 'not_running');
    attempts = attempt;
    hooks.onAttemptStart?.(attempt, candidate);
    const score = await hooks.measure(candidate, attempt);
    if (!score.total) return finish(null, 'no_games');
    await hooks.onMeasured?.(attempt, score);

    const directive = hooks.takeDirective ? hooks.takeDirective() : null;
    if (directive !== null && directive !== undefined && hooks.directiveCandidate) {
      const forced = await hooks.directiveCandidate(candidate, attempt, score, directive);
      if (forced) { candidate = forced; continue; }
      hooks.onDirectiveFailed?.(attempt);
    }

    if (!best || score.wins > best.wins) { best = score; hooks.onBest?.(attempt, score); }
    const revised = score.games.filter((g) => (g.midgameChanges || 0) > 0);
    if (score.perfect) {
      if (!revised.length) {
        if (climb(score)) continue;
        return finish(score, 'accepted');
      }
      const clean = await hooks.verifyClean(candidate, attempt, revised);
      if (clean.perfect) {
        clean.cleanVerified = true;
        hooks.onCleanVerification?.(attempt, clean, true);
        if (climb(clean)) continue;
        return finish(clean, 'accepted');
      }
      hooks.onCleanVerification?.(attempt, clean, false);
      const repaired = await hooks.nextHypothesis(candidate, attempt, hooks.lossEvidence(clean));
      if (!repaired) { hooks.onNoHypothesis?.(attempt, 'clean_verification'); return finish(null, 'no_hypothesis'); }
      candidate = repaired;
      continue;
    }

    const evidence = hooks.lossEvidence(score);
    hooks.onRejected?.(attempt, score, evidence);
    const consolidated = hooks.consolidate ? await hooks.consolidate(attempt, score) : null;
    if (consolidated) { candidate = consolidated; continue; }
    const next = await hooks.nextHypothesis(best.formula, attempt, evidence);
    if (!next) { hooks.onNoHypothesis?.(attempt, 'rejection'); return finish(null, 'no_hypothesis'); }
    candidate = next;
  }
  return finish(null, 'budget');
}
