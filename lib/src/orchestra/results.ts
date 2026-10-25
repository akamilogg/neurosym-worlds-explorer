import fs from 'node:fs';
import { adoptedOf } from './traces.ts';
import path from 'node:path';
import { describe, rate, type Described, type Rate } from '../runtime/statistics.ts';
import { generatorOf } from '../runtime/generators.ts';
import { agentUsage } from './agent-operator.ts';
import { processTraces, type ProcessTraces } from './traces.ts';

/* ============================================================================
 * RESULTS APART, AND WHAT THEY COST (SPEC-CONTROL-ARNES K1, §4.1, §4.2, §6.1, §6.2; SPEC-RIESGO-MODELOS M2).
 *
 * A run's results, each by its name - never one called "correct":
 *   O1 predictive acceptance (of its model; of its artifact, where there is one)
 *   O2 discriminating evidence: severe tests of its own its final model passed as preregistered, with the Judge's answer on
 *      whether each rival was genuine (from the method's audit, when there is one)
 *   O3 adequacy to a use: yes, no or not evaluable, by criteria declared BEFORE the batch
 *   O4 mechanistic recovery, where there is a truth: continuous, with its grader's version
 * and its cost: every part of it (the junior, its agents), tokens, money and time - an unknown cost is unknown, never zero.
 *
 * A group of comparable runs (§6.1: the same condition, world, code version, generating configuration and criteria) is
 * described with its uncertainty (§6.2): proportions with their denominator and Wilson's interval; counts and continuous
 * values with median, quartiles and a bootstrap interval, or "insufficient evidence". No label of control.
 * ========================================================================== */

type J = Record<string, any>;
const readJson = (file: string): J | null => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

/** One condition of a criterion of adequacy, as declared. */
export type Condition = 'model_accepted' | 'artifact_accepted' | { readonly severe_tests_at_least: number } | { readonly recovery_at_least: number };
/** A criterion of adequacy to a use, declared before the batch (§4.1 O3): every condition must hold. */
export interface Criterion { readonly description?: string; readonly require: readonly Condition[] }
export type Criteria = Readonly<Record<string, Criterion>>;

/** Whether criteria are well declared (what the batch refuses to start with). */
export function criteriaProblems(criteria: unknown): string[] {
  if (criteria === undefined) return [];
  if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) return ['"criteria": { "<id>": { "require": [conditions] } }'];
  const out: string[] = [];
  for (const [id, c] of Object.entries(criteria as Record<string, any>)) {
    if (!Array.isArray(c?.require) || !c.require.length) { out.push('criterion ' + id + ': "require": a list of conditions'); continue; }
    for (const x of c.require) {
      const ok = x === 'model_accepted' || x === 'artifact_accepted' || (x && typeof x === 'object' && Object.keys(x).length === 1
        && ((typeof x.severe_tests_at_least === 'number' && x.severe_tests_at_least >= 0) || (typeof x.recovery_at_least === 'number' && x.recovery_at_least >= 0 && x.recovery_at_least <= 1)));
      if (!ok) out.push('criterion ' + id + ': ' + JSON.stringify(x) + ' is not a condition ("model_accepted", "artifact_accepted", {"severe_tests_at_least": n}, {"recovery_at_least": x})');
    }
  }
  return out;
}

export interface RunResults {
  readonly o1_predictive_acceptance: { readonly model: boolean; readonly artifact?: boolean };
  readonly o2_discriminating_evidence: { readonly severe_passed_as_preregistered: number | null; readonly tests: readonly { readonly test: string; readonly rival: string }[] };
  readonly o3_adequacy: Readonly<Record<string, 'yes' | 'no' | 'not evaluable'>> | 'no criteria declared';
  readonly o4_mechanistic_recovery: { readonly score: number; readonly grader_version: number | null } | 'no truth to grade against, or not graded';
  /** A fact, put side by side - never a false acceptance (§4.1). */
  readonly prediction_and_mechanism?: { readonly accepted: true; readonly recovery: number };
  readonly cost: RunCost;
}

export interface RunCost {
  readonly tokens: { readonly junior: number | null; readonly agents: number | null;
    /** What its branches spent (SPEC-DELEGACION-INVESTIGACIONES §6): direct, delegated and total, never counted twice. */
    readonly delegated: number | null; readonly total_at_least: number;
    /** What the fund holds for branches whose spending is not known (§10.4): held, neither spent nor a bound - apart. */
    readonly delegated_held_uncertain?: number;
    /** Of the delegated cost, what its evolutionary branches spent, by phase (SPEC-DELEGACION-EVOLUTIVA §15). */
    readonly evolutionary?: { readonly branches: number; readonly search: number; readonly consolidation: number | null; readonly attempts: number; readonly evaluations: number;
      readonly machine_seconds: number; readonly exported: number; readonly adopted: number; readonly adopted_accepted: number } };
  readonly money: { readonly known: number; readonly unknown: readonly string[] };
  readonly seconds: number | null;
  readonly judge_calls: number | null;
  /** The parts whose cost was not reported: the totals are then lower bounds. */
  readonly unknown: readonly string[];
}

const evaluate = (c: Condition, r: { model: boolean; artifact?: boolean; severe: number | null; recovery: number | null }): boolean | null =>
  c === 'model_accepted' ? r.model
  : c === 'artifact_accepted' ? (r.artifact === undefined ? null : r.artifact)
  : 'severe_tests_at_least' in c ? (r.severe === null ? null : r.severe >= c.severe_tests_at_least)
  : r.recovery === null ? null : r.recovery >= c.recovery_at_least;

/** A run's results apart and its cost, from its record (journal, finding, the method's audit, its agents' records). */
export function runResults(journalFile: string, criteria?: Criteria): RunResults & { readonly started: string | null; readonly ended_at_seconds: number | null } {
  const journal = readJson(journalFile) ?? {};
  const base = journalFile.replace(/\.json$/, '');
  const finding = readJson(base + '.finding.json') ?? {};
  const audit = readJson(base + '.method.json');
  const events = (journal.events ?? []) as J[];
  const end = [...events].reverse().find((e) => e.type === 'end') ?? {};
  const model = finding.outcome?.status === 'accepted';
  const artifact = finding.artifact ? finding.artifact.status === 'accepted' : undefined;
  /* O2: the severe ones among the tests its final model passed as preregistered, with the Judge's reading of each rival. */
  const severe = new Set(events.filter((e) => e.type === 'test_result' && e.severe).map((e) => String(e.test)));
  const passed = (finding.own_tests?.final_model?.passed_preregistered ?? null) as string[] | null;
  const severePassed = passed ? passed.filter((t) => severe.has(String(t))) : null;
  const judgedTests = (audit?.judged?.tests ?? {}) as Record<string, Record<string, { answer?: string } | null>>;
  const o2 = { severe_passed_as_preregistered: finding.own_tests ? severePassed?.length ?? 0 : null,
    tests: (severePassed ?? []).map((t) => ({ test: String(t), rival: judgedTests[t]?.rival?.answer ?? 'not judged' })) };
  const rec = finding.operator?.rule_recovery;
  const recovery = typeof rec?.score === 'number' ? rec.score : null;
  const o3: RunResults['o3_adequacy'] = criteria && Object.keys(criteria).length
    ? Object.fromEntries(Object.entries(criteria).map(([id, c]) => {
      const vs = c.require.map((x) => evaluate(x, { model, artifact, severe: o2.severe_passed_as_preregistered, recovery }));
      return [id, vs.some((v) => v === false) ? 'no' : vs.some((v) => v === null) ? 'not evaluable' : 'yes'];
    }))
    : 'no criteria declared';
  /* Its cost, every part: the junior's tokens (a lower bound when its provider did not report them), its agents'. */
  const unknown: string[] = [];
  const junior = typeof finding.cost?.total?.llm_tokens === 'number' ? finding.cost.total.llm_tokens : null;
  if (junior === null) unknown.push('the junior\'s tokens');
  else if (end.console_usage?.usage_unknown) unknown.push('part of the junior\'s tokens (its provider did not report them all)');
  let agentTokens: number | null = null, money = 0, agentDelegated = 0, held = heldOf(end.delegation);
  let uncertainBranches = ((end.delegation?.branches ?? []) as J[]).filter((b) => b.spent_uncertain).length;
  const moneyUnknown: string[] = ['the junior\'s (no price recorded)'];
  for (const f of fs.existsSync(path.dirname(journalFile)) ? fs.readdirSync(path.dirname(journalFile)).filter((x) => x.startsWith(path.basename(base) + '.agent-') && x.endsWith('.json')) : []) {
    const rec = readJson(path.join(path.dirname(journalFile), f));
    const u = agentUsage(rec);
    /* Its branches' work, delegated: counted with the run's delegated cost, never twice. */
    if (typeof rec?.delegation?.spent === 'number') agentDelegated += rec.delegation.spent;
    held += heldOf(rec?.delegation);
    uncertainBranches += ((rec?.delegation?.branches ?? []) as J[]).filter((b) => b.spent_uncertain).length;
    agentTokens = (agentTokens ?? 0) + u.tokens_in + u.tokens_out;
    if (u.cost > 0) money += u.cost; else if (u.calls) moneyUnknown.push(f.replace(/^.*\.agent-|\.json$/g, '') + '\'s (its provider reported no price)');
  }
  const seconds = typeof end.t === 'number' ? end.t : null;
  const delegated = typeof end.delegation?.spent === 'number' || agentDelegated ? (Number(end.delegation?.spent) || 0) + agentDelegated : null;
  if (end.delegation && (end.delegation.branches ?? []).some((b: J) => b.spent === null)) unknown.push('a branch still running when it ended (its tokens not counted)');
  if (uncertainBranches) unknown.push(uncertainBranches + ' branch(es) stopped without ending: what they spent is not known - counted at what was observed, a lower bound; what the fund holds for them is apart (delegated_held_uncertain), not a bound either: the limit is checked between calls');
  return {
    o1_predictive_acceptance: { model, ...(artifact !== undefined ? { artifact } : {}) },
    o2_discriminating_evidence: o2,
    o3_adequacy: o3,
    o4_mechanistic_recovery: recovery !== null ? { score: recovery, grader_version: rec.grader_version ?? null } : 'no truth to grade against, or not graded',
    ...(model && recovery !== null ? { prediction_and_mechanism: { accepted: true, recovery } } : {}),
    cost: { tokens: { junior, agents: agentTokens, delegated, total_at_least: (junior ?? 0) + (agentTokens ?? 0) + (delegated ?? 0), ...(held ? { delegated_held_uncertain: held } : {}), ...evolutionaryOf(journalFile, events) }, money: { known: Math.round(money * 1e6) / 1e6, unknown: moneyUnknown },
      seconds, judge_calls: typeof end.jev?.calls === 'number' ? end.jev.calls : null, unknown },
    started: journal.started ?? null, ended_at_seconds: seconds
  };
}

export interface GroupResults {
  readonly group: { readonly condition: string; readonly world: string; readonly code_version: string | null; readonly generator: string; readonly criteria: readonly string[] };
  readonly runs: number;
  readonly o1_predictive_acceptance: { readonly model: Rate; readonly artifact?: Rate };
  readonly o2_severe_passed_as_preregistered: Described;
  readonly o3_adequacy: Readonly<Record<string, { readonly yes: Rate; readonly evaluable: number; readonly not_evaluable: number; readonly coverage: number | null;
    /** When it was declared: before the batch began (preregistered), or after. */
    readonly declared?: string }>> | 'no criteria declared';
  readonly o4_mechanistic_recovery: Described;
  readonly cost: { readonly tokens_total_at_least: Described; readonly tokens_sum_at_least: number; readonly money_known_sum: number; readonly money_unknown_in: number; readonly seconds: Described; readonly seconds_sum: number };
  /** Runs that meet each criterion (O1 always among them), per the group's whole cost: the criterion always said. */
  readonly efficiency: Readonly<Record<string, { readonly runs_meeting: number; readonly per_million_tokens: number | null }>>;
  /** How its runs went (K4, §4.3): a description, never a performance. */
  readonly process: {
    readonly first_round_holding_in_its_laboratories: Described; readonly runs_never_holding: number;
    readonly steps: { readonly looking: Described; readonly experimenting: Described; readonly recalling: Described; readonly other: Described };
    readonly proposals_returned: Described;
    readonly directives: { readonly given: number; readonly reported_carried_out: number; readonly reported_not_carried_out: number; readonly not_reported: number };
    readonly told_its_senior: number;
    readonly reading: string;
  };
}

/** The results of a batch's runs, by group of comparable runs (§6.1), each described with its uncertainty (§6.2). */
export function groupResults(rows: readonly { readonly condition: string; readonly journal: string }[], criteria?: Criteria): GroupResults[] {
  const groups = new Map<string, { key: GroupResults['group']; runs: (RunResults & { started: string | null })[]; traces: ProcessTraces[] }>();
  for (const row of rows) {
    const journal = readJson(row.journal);
    if (!journal) continue;
    const gen = generatorOf(journal, path.dirname(row.journal), path.basename(row.journal, '.json'));
    const key = { condition: row.condition, world: String(journal.experiment), code_version: journal.commit ?? null, generator: gen.id, criteria: Object.keys(criteria ?? {}) };
    const id = JSON.stringify(key);
    const g = groups.get(id) ?? { key, runs: [] as (RunResults & { started: string | null })[], traces: [] as ProcessTraces[] };
    g.runs.push(runResults(row.journal, criteria));
    g.traces.push(processTraces(row.journal));
    groups.set(id, g);
  }
  return [...groups.values()].map(({ key, runs, traces }) => {
    const artifacts = runs.filter((r) => r.o1_predictive_acceptance.artifact !== undefined);
    const meets: Record<string, number> = { O1_model_accepted: runs.filter((r) => r.o1_predictive_acceptance.model).length };
    const o3: GroupResults['o3_adequacy'] = criteria && Object.keys(criteria).length ? Object.fromEntries(Object.keys(criteria).map((id) => {
      const v = runs.map((r) => (r.o3_adequacy as Record<string, string>)[id]);
      const evaluable = v.filter((x) => x === 'yes' || x === 'no').length, yes = v.filter((x) => x === 'yes').length;
      meets[id] = yes;
      return [id, { yes: rate(yes, evaluable), evaluable, not_evaluable: v.length - evaluable, coverage: runs.length ? Math.round(evaluable / runs.length * 1000) / 1000 : null }];
    })) : 'no criteria declared';
    const tokens = runs.map((r) => r.cost.tokens.total_at_least);
    const tokensSum = tokens.reduce((a, b) => a + b, 0);
    return {
      group: key, runs: runs.length,
      o1_predictive_acceptance: { model: rate(meets.O1_model_accepted, runs.length), ...(artifacts.length ? { artifact: rate(artifacts.filter((r) => r.o1_predictive_acceptance.artifact).length, artifacts.length) } : {}) },
      o2_severe_passed_as_preregistered: describe(runs.map((r) => r.o2_discriminating_evidence.severe_passed_as_preregistered)),
      o3_adequacy: o3,
      o4_mechanistic_recovery: describe(runs.map((r) => (typeof r.o4_mechanistic_recovery === 'object' ? r.o4_mechanistic_recovery.score : null))),
      cost: { tokens_total_at_least: describe(tokens), tokens_sum_at_least: tokensSum, money_known_sum: Math.round(runs.reduce((a, r) => a + r.cost.money.known, 0) * 1e6) / 1e6,
        money_unknown_in: runs.filter((r) => r.cost.money.unknown.length).length, seconds: describe(runs.map((r) => r.cost.seconds)), seconds_sum: runs.reduce((a, r) => a + (r.cost.seconds ?? 0), 0) },
      efficiency: Object.fromEntries(Object.entries(meets).map(([id, k]) => [id, { runs_meeting: k, per_million_tokens: tokensSum ? Math.round(k / tokensSum * 1e6 * 1000) / 1000 : null }])),
      process: {
        first_round_holding_in_its_laboratories: describe(traces.map((t) => t.first_round_holding_in_its_laboratories)),
        runs_never_holding: traces.filter((t) => t.first_round_holding_in_its_laboratories === null).length,
        steps: { looking: describe(traces.map((t) => t.steps.looking)), experimenting: describe(traces.map((t) => t.steps.experimenting)),
          recalling: describe(traces.map((t) => t.steps.recalling)), other: describe(traces.map((t) => t.steps.other)) },
        proposals_returned: describe(traces.map((t) => t.proposals_returned)),
        directives: { given: sum(traces, (t) => t.directives.given), reported_carried_out: sum(traces, (t) => t.directives.reported_carried_out),
          reported_not_carried_out: sum(traces, (t) => t.directives.reported_not_carried_out), not_reported: sum(traces, (t) => t.directives.not_reported) },
        told_its_senior: sum(traces, (t) => t.told_its_senior),
        reading: 'a description of how its runs went, never their performance: the effect of a senior or an opening only from controlled comparisons (compare_conditions)'
      }
    };
  });
}

const sum = <T>(xs: readonly T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0);

/** The batch's times (§4.2), three apart: its duration on the clock, the time to its first run meeting each criterion, and
    the resources it accumulated (the sum of its runs' durations, apart from the clock - its runs ran in parallel). */
export function batchTimes(started: string, ended: string | undefined, rows: readonly { readonly journal: string }[], criteria?: Criteria): Record<string, unknown> {
  const t0 = Date.parse(started);
  const runs = rows.map((r) => ({ r: runResults(r.journal, criteria) })).filter((x) => x.r.started && x.r.ended_at_seconds !== null);
  const at = (x: { r: { started: string | null; ended_at_seconds: number | null } }) => Date.parse(x.r.started!) + x.r.ended_at_seconds! * 1000 - t0;
  const first = (meets: (r: RunResults) => boolean) => { const ms = runs.filter((x) => meets(x.r)).map(at).sort((a, b) => a - b)[0]; return ms === undefined ? 'none met it' : Math.round(ms / 1000); };
  return {
    duration_seconds: ended ? Math.round((Date.parse(ended) - t0) / 1000) : 'not ended',
    seconds_to_first: { O1_model_accepted: first((r) => r.o1_predictive_acceptance.model),
      ...Object.fromEntries(Object.keys(criteria ?? {}).map((id) => [id, first((r) => (r.o3_adequacy as Record<string, string>)[id] === 'yes')])) },
    accumulated_run_seconds: runs.reduce((a, x) => a + (x.r.ended_at_seconds ?? 0), 0)
  };
}

/** What a summary of branches holds for those whose spending is not known (a summary of an earlier version: its grant each). */
const heldOf = (d: J | undefined): number => typeof d?.held_uncertain === 'number' ? d.held_uncertain
  : ((d?.branches ?? []) as J[]).filter((b) => b.spent_uncertain).reduce((a, b) => a + (Number(b.spent_uncertain.held ?? b.granted?.tokens) || 0), 0);

/** Its evolutionary branches, apart: what each phase spent (from each branch's finding, never counted twice - it is
    already in the delegated cost), how much they searched, what they exported, what it adopted, and of that, what its
    world accepted. */
function evolutionaryOf(journalFile: string, events: readonly J[]): { evolutionary?: NonNullable<RunResults['cost']['tokens']['evolutionary']> } {
  const branches = events.filter((e) => e.type === 'delegation_requested' && e.mode === 'evolve' && typeof e.journal === 'string');
  if (!branches.length) return {};
  let search = 0, consolidation: number | null = 0, attempts = 0, evaluations = 0, machine = 0, exported = 0;
  for (const b of branches) {
    const file = path.resolve(path.dirname(journalFile), b.journal);
    const finding = readJson(file.replace(/\.json$/, '.finding.json'));
    const rec = readJson(file);
    const done = ((rec?.events ?? []) as J[]).find((e) => e.type === 'search_finished');
    search += Number(finding?.cost?.search?.llm_tokens) || 0;
    const c = finding?.cost?.consolidation?.llm_tokens;
    consolidation = consolidation === null || typeof c !== 'number' ? (typeof c === 'number' || !finding ? consolidation : null) : consolidation + c;
    attempts += Number(done?.cost?.attempts) || 0;
    evaluations += Number(done?.cost?.evaluations) || 0;
    machine += Number(done?.cost?.machine_seconds) || 0;
    exported += ((done?.exported ?? []) as unknown[]).length;
  }
  const adopted = adoptedOf(journalFile, events);
  const accepted = new Set(events.filter((e) => e.type === 'artifact_accepted').map((e) => String(e.version)));
  return { evolutionary: { branches: branches.length, search, consolidation, attempts, evaluations, machine_seconds: Math.round(machine * 10) / 10, exported, adopted: adopted.length,
    adopted_accepted: adopted.filter((v) => accepted.has(v)).length } };
}
