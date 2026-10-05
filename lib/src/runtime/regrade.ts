import fs from 'node:fs';
import path from 'node:path';
import { parseJsonLoose } from '../core/net.ts';
import { Notebook, type Note, type NotebookBelief } from '../learn/notebook.ts';
import { formOf } from '../learn/operator.ts';
import { findingOf, findingView, type Finding } from '../learn/finding.ts';
import { isGameLab } from '../learn/lab.ts';
import type { ChatClient } from '../learn/system2.ts';
import { LABS } from '../worlds/labs.ts';
import { GRID_GRADING_SYSTEM } from '../worlds/grid/lab.ts';
import { LabError } from './lab-runner.ts';
import { methodOf } from '../audit/audit.ts';
import { worldOptionsIn } from '../orchestra/reader.ts';

/* ============================================================================
 * Grading a finished run AGAIN (operator only): the same grader the run used - how well the
 * learner's own words state each hidden rule - asked of another model. For a run whose grading
 * failed (the grid grades with the run's own model; a small local one may refuse it), or to
 * compare graders. The learner is read as the run left it (its notebook at the end); the truth
 * from the journal's hidden part. The new grading is appended to the journal as one more event
 * (`regraded`, with its grader), and the findings are written again from it: the latest grading
 * is the one they report.
 * ========================================================================== */

type J = Record<string, any>;

/** The notebook the run ended with, as the grader reads it. */
function learnerOf(end: J): { beliefs: unknown; dropped: unknown; notes: unknown; reflections: unknown } {
  const nb = new Notebook();
  for (const b of (end?.notebook?.beliefs ?? []) as NotebookBelief[]) nb.beliefs.set(b.id, b);
  for (const n of (end?.notebook?.notes ?? []) as Note[]) nb.notes.set(n.id, n);
  nb.reflections.push(...((end?.notebook?.reflections ?? []) as Notebook['reflections']));
  const brief = nb.brief();
  return { beliefs: brief.beliefs_held, dropped: brief.beliefs_dropped, notes: brief.notes, reflections: nb.reflections };
}

export interface Regrade { readonly score: number | null; readonly event: J; readonly finding: Finding }

export async function regrade(journalFile: string, llm: ChatClient, graderModel: string): Promise<Regrade> {
  const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8')) as J;
  const lab = Object.values(LABS).find((l) => l.id === journal.experiment);
  if (!lab) throw new LabError('grade: ' + path.basename(journalFile) + ' is not a run of a known laboratory');
  const events = (journal.events ?? []) as J[];
  const end = [...events].reverse().find((e) => e.type === 'end');
  if (!end) throw new LabError('grade: the run has not ended');
  const before = [...events].reverse().find((e) => e.type === 'operator_rule_recovery' || e.type === 'operator_law_recovery');
  /* The truth the run kept; else, for a world of laws that has one, the laboratory's own from the run's spec and options
     (a run whose truth could not be read when it ran). */
  const kept = (before?.truth ?? journal.hidden_from_the_learner?.truth) as { id: string; statement: string }[] | undefined;
  const spec = journal.hidden_from_the_learner?.spec;
  const truth = kept?.length ? kept : !isGameLab(lab) && lab.truth && spec ? lab.truth(spec, worldOptionsIn(lab.options, journal.config ?? {})) as { id: string; statement: string }[] : kept;
  if (!Array.isArray(truth) || !truth.length) throw new LabError('grade: the run keeps no truth to grade against');
  const learner = learnerOf(end);
  let system: string, user: string, type: string;
  if (isGameLab(lab)) {
    const glyphs = journal.hidden_from_the_learner?.glyphs ?? {};
    system = GRID_GRADING_SYSTEM; type = 'operator_rule_recovery';
    user = JSON.stringify({ true_rules: truth, picture_glyphs: { learner: glyphs.you, other: glyphs.other }, learner });
  } else {
    if (!lab.grading) throw new LabError('grade: ' + lab.id + ' has no grader');
    system = lab.grading.system; type = lab.grading.event ?? 'operator_rule_recovery';
    const glossary = journal.hidden_from_the_learner?.glossary;
    user = JSON.stringify({ true_statements: truth, ...(glossary ? { learner_names: glossary } : {}), learner: { [lab.grading.finalKey ?? 'final_model']: end.final ?? null, ...learner } });
  }
  let event: J;
  try {
    const content = (await llm.complete({ system, user })).content;
    const parsed = parseJsonLoose(content) as { grades?: { id: string; grade: string }[]; false_beliefs?: unknown[] } | null;
    const grades = (parsed?.grades ?? []).filter((g) => truth.some((t) => t.id === g.id));
    const score = Math.round(grades.reduce((n, g) => n + (g.grade === 'exact' ? 1 : g.grade === 'partial' ? 0.5 : 0), 0) / truth.length * 100) / 100;
    event = { type, truth, grades, false_beliefs: parsed?.false_beliefs ?? [], score, ...formOf(parsed as Record<string, unknown> | null), grader_model: graderModel };
  } catch (e) {
    event = { type, truth, error: String((e as Error)?.message ?? e), grader_model: graderModel };
  }
  /* Appended after the end, marked: the run is as it was; this is the operator's later reading of it. */
  const last = events.length ? Number(events[events.length - 1].t ?? 0) : 0;
  const stamped = { t: last, ...event, regraded: new Date().toISOString() };
  journal.events = [...events, stamped];
  fs.writeFileSync(journalFile, JSON.stringify(journal, null, 2));
  const finding = findingOf(JSON.parse(JSON.stringify(journal)), { journal: path.basename(journalFile), ...methodOf(journalFile) });
  fs.writeFileSync(journalFile.replace(/\.json$/, '') + '.finding.json', JSON.stringify(finding, null, 2));
  fs.writeFileSync(journalFile.replace(/\.json$/, '') + '.finding.researcher.json', JSON.stringify(findingView(finding, 'researcher'), null, 2));
  return { score: typeof event.score === 'number' ? event.score : null, event: stamped, finding };
}
