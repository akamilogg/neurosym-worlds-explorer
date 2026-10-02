import { Notebook, type BeliefStance, type NoteOp } from '../learn/notebook.ts';
import { JournalMemory, type EpisodeEntry, type ModelEntry } from '../learn/assisted/memory.ts';
import { ownFormula } from '../learn/explorer.ts';
import type { Formula } from '../core/types.ts';

/* ============================================================================
 * A researcher's RECORD as another agent reads it (SPEC-ORQUESTADOR §3.3): the senior who
 * reviews a junior's work gets the same instruments the junior's selective memory has -
 * `list`, `open`, `find` - over what the junior did and was answered, rebuilt from its journal.
 *
 * Exactly what the junior saw, never more (Q2): its beliefs and notes and methods as it wrote
 * them, its models, each request it made with what the environment answered, the verdicts of
 * its checks, the index of its episodes with their scores. Never the hidden part, the operator's
 * measures, nor how an episode ended beyond its score (the reason is the world's, not shown).
 * ========================================================================== */

type J = Record<string, any>;
const score = (winner: unknown): number => (winner === 'A' ? 1 : winner === 'B' ? -1 : 0);
const scoreOfResult = (r: unknown): number => (r === 'won' ? 1 : r === 'lost' ? -1 : 0);

/** The junior's record from its journal, read with the instruments of a selective memory. */
export function journalReader(journal: J): JournalMemory {
  const notebook = new Notebook();
  const episodes: EpisodeEntry[] = [];
  const models: ModelEntry[] = [];
  const memory = new JournalMemory(notebook, { episodes: () => episodes, models: () => models });
  const steps = new Map<number, number>();
  for (const e of (Array.isArray(journal?.events) ? journal.events : []) as J[]) {
    const round = typeof e.round === 'number' ? e.round : 0;
    const notes = (Array.isArray(e.notes) ? e.notes : []) as NoteOp[];
    switch (e.type) {
      case 'exploration_game': episodes.push({ episode: String(e.game), round: 0, chosen_by: 'the environment, at random', score: score(e.winner), steps: e.plies }); break;
      case 'exploration_episode': if (e.episode && typeof e.episode === 'object') episodes.push({ round: 0, ...e.episode, episode: String(e.episode.id ?? e.episode.episode ?? '') }); break;
      case 'played_by_the_learner': episodes.push({ episode: String(e.game), round, from: e.from, chosen_by: e.how, score: scoreOfResult(e.result), steps: e.turns }); break;
      case 'investigation': {
        notebook.applyNotes(round, notes, () => true);
        const step = (steps.get(round) ?? 0) + 1;
        steps.set(round, step);
        memory.recordInvestigation(round, step, { requests: e.requests, ...(e.results !== undefined ? { results: e.results } : { results: '(not recorded in this journal)' }), ...(e.warnings?.length ? { warnings: e.warnings } : {}) });
        break;
      }
      case 'investigation_refused': {
        const step = (steps.get(round) ?? 0) + 1;
        steps.set(round, step);
        memory.recordInvestigation(round, step, { requests: e.requests, results: 'refused: ' + String(e.reason ?? '') });
        break;
      }
      case 'methods': notebook.applyMethods(round, (e.methods ?? []) as NoteOp[]); break;
      case 'proposal': {
        notebook.applyStances(round, (e.beliefs ?? []) as BeliefStance[]);
        notebook.applyNotes(round, notes, () => true);
        const model = e.law ?? (e.formula ? ownFormula(e.formula as Formula) : null);
        if (model) models.push({ round, fingerprint: String(e.fingerprint ?? 'r' + round), model, rationale: e.rationale, lessons: e.lessons, next_experiment: e.next_experiment });
        break;
      }
      case 'reflection':
        notebook.applyStances(round, (e.beliefs ?? []) as BeliefStance[]);
        notebook.applyNotes(round, notes, () => true);
        notebook.recordReflection(round, String(e.rationale ?? ''), (e.lessons ?? []) as string[], String(e.next_experiment ?? ''));
        break;
      case 'check':
        /* The verdicts as the junior is given them: per place, how many episodes scored 1, whether it holds, the reruns. */
        memory.recordCheck(round, { laboratories: (e.laboratories ?? []).map((p: J) => ({ place: p.place, holds: p.holds, ...(p.wins !== undefined ? { scored_1: p.wins, of: p.total } : {}), ...(p.rerun ? { rerun: { went_up: p.rerun.went_up, went_down: p.rerun.went_down } } : {}) })),
          ...(e.validation ? { validation: { family: (e.validation.family ?? []).map((p: J) => ({ place: p.place, holds: p.holds, ...(p.wins !== undefined ? { scored_1: p.wins, of: p.total } : {}) })) } } : {}),
          ...(e.accepted ? { accepted: true } : {}) });
        break;
      default: break;
    }
  }
  return memory;
}

/** Signs that a researcher is stuck (SPEC-ORQUESTADOR §5.5), from what it did and was told - each a fact of its record. */
export interface StuckSignals {
  /** Its latest checks in a row where its model held in no place. */
  readonly holding_nowhere_in_a_row: number;
  /** Requests it made more than once in its latest round. */
  readonly repeated_requests: number;
  /** Times it asked to investigate with no steps left in its latest round. */
  readonly insisted_without_steps: number;
  /** Distinct models among its latest proposals (few: variants of one idea). */
  readonly distinct_models_lately: number;
  /** The signs, in words: empty when there is none. */
  readonly signs: readonly string[];
}

export function stuckSignals(journal: J, patience = 3): StuckSignals {
  const events = (Array.isArray(journal?.events) ? journal.events : []) as J[];
  const checks = events.filter((e) => e.type === 'check');
  let nowhere = 0;
  for (let i = checks.length - 1; i >= 0 && !(checks[i].laboratories ?? []).some((p: J) => p.holds); i--) nowhere++;
  const last = Math.max(0, ...events.filter((e) => typeof e.round === 'number').map((e) => e.round as number));
  const asked = events.filter((e) => e.type === 'investigation' && e.round === last).flatMap((e) => (e.requests ?? []).map((q: unknown) => JSON.stringify(q)));
  const repeated = asked.length - new Set(asked).size;
  const insisted = events.filter((e) => e.type === 'investigation_refused' && e.round === last).length;
  const recent = events.filter((e) => e.type === 'proposal').slice(-patience);
  const distinct = new Set(recent.map((e) => e.fingerprint ?? JSON.stringify(e.formula?.observations ? Object.keys(e.formula.observations) : e.law))).size;
  const signs = [
    ...(nowhere >= patience ? [nowhere + ' checks in a row where its model held in no place'] : []),
    ...(repeated >= 2 ? [repeated + ' requests repeated in its latest round'] : []),
    ...(insisted >= 2 ? ['it asked to investigate ' + insisted + ' times with no steps left in its latest round'] : [])
  ];
  return { holding_nowhere_in_a_row: nowhere, repeated_requests: repeated, insisted_without_steps: insisted, distinct_models_lately: distinct, signs };
}
