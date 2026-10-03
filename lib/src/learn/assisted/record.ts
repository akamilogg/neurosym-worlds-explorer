import { Notebook, type BeliefStance, type NoteOp } from '../notebook.ts';
import { JournalMemory, type EpisodeEntry, type MemoryOptions, type ModelEntry } from './memory.ts';
import { ownFormula } from '../explorer.ts';
import type { Formula } from '../../core/types.ts';

/* ============================================================================
 * A researcher's RECORD as another reads it, rebuilt from its journal and read with the
 * instruments of a selective memory (`list`, `open`, `find`): the senior who reviews a junior
 * (SPEC-ORQUESTADOR §3.3), and a researcher given the experience of earlier runs
 * (SPEC-INVESTIGADOR-ASISTIDO §12).
 *
 * Exactly what that researcher saw, never more (Q2): its beliefs and notes and methods as it wrote
 * them, its models, each request it made with what the environment answered, the verdicts of
 * its checks, the index of its episodes with their scores. Never the hidden part, the operator's
 * measures, the operator's messages, nor how an episode ended beyond its score (the reason is the
 * world's, not shown).
 * ========================================================================== */

type J = Record<string, any>;
const score = (winner: unknown): number => (winner === 'A' ? 1 : winner === 'B' ? -1 : 0);
const scoreOfResult = (r: unknown): number => (r === 'won' ? 1 : r === 'lost' ? -1 : 0);

/** A researcher's record from its journal, read with the instruments of a selective memory. */
export function journalReader(journal: J, options: Pick<MemoryOptions, 'openLimit' | 'selector' | 'onSelect'> = {}): JournalMemory {
  const notebook = new Notebook();
  const episodes: EpisodeEntry[] = [];
  const models: ModelEntry[] = [];
  const memory = new JournalMemory(notebook, { episodes: () => episodes, models: () => models, ...(options.openLimit ? { openLimit: options.openLimit } : {}),
    ...(options.selector ? { selector: options.selector } : {}), ...(options.onSelect ? { onSelect: options.onSelect } : {}) });
  const steps = new Map<number, number>();
  for (const e of (Array.isArray(journal?.events) ? journal.events : []) as J[]) {
    const round = typeof e.round === 'number' ? e.round : 0;
    const notes = (Array.isArray(e.notes) ? e.notes : []) as NoteOp[];
    switch (e.type) {
      case 'exploration_game': episodes.push({ episode: String(e.game), round: 0, chosen_by: 'the environment, at random', score: score(e.winner), steps: e.plies }); break;
      /* A world of laws logs an exploration episode by its id (`episode: "ep1"`, or `launch` for a launch), next to what the
         journal keeps of it for the operator (`lab.explored`: rows, tables, marks). Only its index entry is the researcher's:
         what it saw of the episode is in the investigations that viewed it. */
      case 'exploration_episode': case 'exploration_launch': {
        const id = e.episode && typeof e.episode === 'object' ? e.episode.id ?? e.episode.episode : e.episode ?? e.launch;
        if (id !== undefined && id !== null) episodes.push({ episode: String(id), round: 0, chosen_by: 'the environment', ...(typeof e.place === 'string' ? { place: e.place } : typeof e.setup === 'string' ? { place: e.setup } : {}) });
        break;
      }
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

