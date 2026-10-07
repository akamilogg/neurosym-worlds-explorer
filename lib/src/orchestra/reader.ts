import { journalReader } from '../learn/assisted/record.ts';
import { explorerSystem } from '../learn/explorer.ts';
import { system2Prompt, type Tool } from '../learn/prompt.ts';
import { isGameLab } from '../learn/lab.ts';
import { LABS } from '../worlds/labs.ts';
import { GRID_PERCEPT_DOC } from '../worlds/grid/sense.ts';
import { ownTestsSection } from '../learn/assisted/own-tests.ts';

/* ============================================================================
 * A researcher's RECORD as another agent reads it (SPEC-ORQUESTADOR §3.3): the senior who
 * reviews a junior's work gets the same instruments the junior's selective memory has -
 * `list`, `open`, `find` - over what the junior did and was answered, rebuilt from its journal
 * (`journalReader`, kept in learn/assisted/record.ts: a researcher given experience reads with it too).
 *
 * Exactly what the junior saw, never more (Q2): its beliefs and notes and methods as it wrote
 * them, its models, each request it made with what the environment answered, the verdicts of
 * its checks, the index of its episodes with their scores. Never the hidden part, the operator's
 * measures, nor how an episode ended beyond its score (the reason is the world's, not shown).
 * ========================================================================== */

export { journalReader };

type J = Record<string, any>;

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
  /** Investigation answers of its latest round that only looked (view, inspect, reading its memory or sources), when it ran
      no experiment at all in that round (act, replay, table, measure, simulate): it doubts, or investigates too much, and
      does not get to a hypothesis it tests. 0 when it experimented. */
  readonly only_looking: number;
  /** Episodes of its earlier checks that scored LOWER when run again with its newer models, over its latest checks: its
      changes keep undoing what worked. */
  readonly regressions: number;
  /** Checks since its best one (the most episodes scoring 1, as a share) that did not match it: no progress, or going back. */
  readonly checks_since_best: number;
  /** The round in course (the latest it acted in), and whether a sign is about it: then it can still be helped in it. */
  readonly current_round: number;
  readonly in_round: boolean;
  /** The signs, in words: empty when there is none. */
  readonly signs: readonly string[];
}

/** Instruments that put an idea to the test (the rest only look at what was recorded or read). */
const EXPERIMENTS = new Set(['act', 'replay', 'table', 'measure', 'simulate', 'launch', 'play', 'try']);

/** `patience`: checks in a row holding nowhere before it is a sign; `looking`: answers of a round only looking; `window`:
    the latest checks where regressions are counted, and the checks without matching its best before that is a sign. */
export function stuckSignals(journal: J, patience = 3, looking = 3, window = 2): StuckSignals {
  const events = (Array.isArray(journal?.events) ? journal.events : []) as J[];
  const checks = events.filter((e) => e.type === 'check');
  let nowhere = 0;
  for (let i = checks.length - 1; i >= 0 && !(checks[i].laboratories ?? []).some((p: J) => p.holds); i--) nowhere++;
  const last = Math.max(0, ...events.filter((e) => typeof e.round === 'number').map((e) => e.round as number));
  const asked = events.filter((e) => e.type === 'investigation' && e.round === last).flatMap((e) => (e.requests ?? []).map((q: unknown) => JSON.stringify(q)));
  const repeated = asked.length - new Set(asked).size;
  const insisted = events.filter((e) => e.type === 'investigation_refused' && e.round === last).length;
  const answers = events.filter((e) => e.type === 'investigation' && e.round === last);
  const experimented = answers.some((e) => (e.requests ?? []).some((q: J) => EXPERIMENTS.has(Object.keys(q ?? {})[0] ?? '')));
  /* Round 1 is for looking: there is no model yet. From the next one, a round of only looking is a sign. */
  const onlyLooking = experimented || last <= 1 ? 0 : answers.length;
  /* Its checks, as it was given them: how many episodes scored 1 of how many, and how many run again scored lower. */
  const scored = checks.map((c) => {
    const labs = (c.laboratories ?? []) as J[];
    const wins = labs.reduce((n, p) => n + (Number(p.wins) || 0), 0), total = labs.reduce((n, p) => n + (Number(p.total) || 0), 0);
    return { share: total ? wins / total : 0, wins, total, round: c.round, down: labs.reduce((n, p) => n + (Number(p.rerun?.went_down) || 0), 0) };
  });
  const regressions = scored.slice(-window).reduce((n, c) => n + c.down, 0);
  /* Its best share so far, and the latest check that reached it (matching it counts): the checks since, below it. */
  const top = Math.max(0, ...scored.map((c) => c.share));
  let best = -1;
  scored.forEach((c, i) => { if (c.share === top && top > 0) best = i; });
  const sinceBest = best < 0 ? 0 : scored.length - 1 - best;
  const recent = events.filter((e) => e.type === 'proposal').slice(-patience);
  const distinct = new Set(recent.map((e) => e.fingerprint ?? JSON.stringify(e.formula?.observations ? Object.keys(e.formula.observations) : e.law))).size;
  const signs = [
    ...(nowhere >= patience ? [nowhere + ' checks in a row where its model held in no place'] : []),
    ...(repeated >= 2 ? [repeated + ' requests repeated in its latest round'] : []),
    ...(insisted >= 2 ? ['it asked to investigate ' + insisted + ' times with no steps left in its latest round'] : []),
    ...(onlyLooking >= looking ? ['it spent ' + onlyLooking + ' investigation answers of its latest round only looking, with no experiment (no act, replay, table or measure)'] : []),
    ...(regressions >= 2 ? [regressions + ' episodes of its earlier checks scored lower when run again with its newer models (its last ' + Math.min(window, scored.length) + ' checks): its changes undo what worked'] : []),
    ...(sinceBest >= window && best >= 0 ? ['its best check (' + scored[best].wins + ' of ' + scored[best].total + ' scored 1, round ' + scored[best].round + ') has not been matched in the ' + sinceBest + ' checks since'] : [])
  ];
  return { holding_nowhere_in_a_row: nowhere, repeated_requests: repeated, insisted_without_steps: insisted, distinct_models_lately: distinct,
    only_looking: onlyLooking, regressions, checks_since_best: sinceBest, current_round: last, in_round: insisted >= 2 || onlyLooking >= looking, signs };
}

/** Where the researcher's prompt stops describing its work and starts describing the shape of its own answer. */
const ANSWER_SHAPE = 'When you propose, answer with ONE JSON object and nothing else:';

/** A run's world options, from its journal's configuration (kept there under camel-cased names). */
export const worldOptionsIn = (options: readonly { name: string; default: string }[], config: J): Record<string, string> =>
  Object.fromEntries(options.map((o) => { const v = config[o.name.replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase())]; return [o.name, v === undefined ? o.default : String(v)]; }));

/** The brief the junior works under, word for word: the common prompt (persona, method, instruments, protocol) and its
    world's interface, as its run built them - without the shape of a proposal, which is the junior's to answer, not a
    reviewer's. Null when the journal's world is not known here. */
export function juniorBrief(journal: J): string | null {
  const lab = Object.values(LABS).find((l) => l.id === journal?.experiment);
  if (!lab) return null;
  const config = (journal?.config ?? {}) as J;
  const tools = new Set((Array.isArray(config.tools) ? config.tools : []) as Tool[]);
  const prompt = isGameLab(lab) ? explorerSystem(tools as never)
    : system2Prompt(lab.interface({ regression: config.regression !== false, world: worldOptionsIn(lab.options, config),
      ...(typeof config.focus === 'string' && config.focus ? { focus: config.focus } : {}) }), tools);
  const at = prompt.indexOf(ANSWER_SHAPE);
  return (at >= 0 ? prompt.slice(0, at) : prompt).trimEnd();
}

/** How the junior may test its model with tests of its own (SPEC-PRUEBAS-PROPIAS T2), as it is told; null when it cannot
    (not the assisted researcher, or a laboratory where it does not act). */
export function juniorTests(journal: J): string | null {
  const lab = Object.values(LABS).find((l) => l.id === journal?.experiment);
  if (!lab || isGameLab(lab) || !lab.act || journal?.researcher !== 'assisted') return null;
  const config = (journal?.config ?? {}) as J;
  if (Array.isArray(config.tools) && !config.tools.includes('act')) return null;
  const spec = lab.generate(Number(config.seed) || 1, worldOptionsIn(lab.options, config));
  return ownTestsSection(lab.rivals?.(spec) ?? [], Boolean(lab.act.identity && lab.episodeIdentity), Number(config.ownTests) || 0);
}

/** What the junior's code receives at a point (its `percept`, given in every round's message, not in its brief): the
    fields its observations and output can read. Null when the journal's world is not known here. */
export function juniorPercept(journal: J): string | null {
  const lab = Object.values(LABS).find((l) => l.id === journal?.experiment);
  if (!lab) return null;
  return isGameLab(lab) ? GRID_PERCEPT_DOC : lab.perceptDoc;
}

/** A follow-up the senior owes (SPEC-ORQUESTADOR §3.3): the junior got its latest message and then ran an experiment.
    `message` is that message's place among the junior's messages from it (each is followed up once); `experiment` the
    item of the junior's record that holds the experiment and what it was answered. Null when none is due. */
export function followUpDue(journal: J, id: string): { message: number; text: string; experiment: string; round: number; requests: unknown } | null {
  const events = (Array.isArray(journal?.events) ? journal.events : []) as J[];
  const by = 'agent:' + id;
  let delivered = -1, at = -1, text = '';
  events.forEach((e, i) => {
    if (e.type !== 'operator_message') return;
    const m = (e.messages ?? []).find((x: J) => x.by === by);
    if (m) { delivered++; at = i; text = String(m.text ?? ''); }
  });
  if (at < 0) return null;
  /* The ids of the junior's record count its investigation answers, refused ones too, round by round. */
  const steps = new Map<number, number>();
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.type !== 'investigation' && e.type !== 'investigation_refused') continue;
    const round = typeof e.round === 'number' ? e.round : 0;
    const step = (steps.get(round) ?? 0) + 1;
    steps.set(round, step);
    if (i > at && e.type === 'investigation' && (e.requests ?? []).some((q: J) => EXPERIMENTS.has(Object.keys(q ?? {})[0] ?? '')))
      return { message: delivered, text, experiment: 'investigation:r' + round + '.' + step, round, requests: e.requests };
  }
  return null;
}
