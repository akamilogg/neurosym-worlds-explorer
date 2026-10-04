import fs from 'node:fs';
import path from 'node:path';
import type { Judge } from '../core/types.ts';
import { linksOf, type LinkRecord } from './links.ts';
import { judgeMethod, type Judgements, type Verdict } from './judge.ts';
import { findingOf } from '../learn/finding.ts';

/* ============================================================================
 * THE METHOD AUDIT of a finished run (SPEC-AUDITORIA-METODO, MA1 + MA3): its links and what code
 * observes of them, the Judge's closed answers about them (none in --flat), and the measures
 * derived from both - written as `method_audit@1` next to the journal (`<run>.method.json`).
 *
 * One more metric, beside the outcome (check, validation and, where a truth exists, rule
 * recovery), never combined with it into one mark. The journal is left as it was; the
 * operator's finding links the audit; the researcher's never does (M1).
 * ========================================================================== */

type J = Record<string, any>;

export interface MethodAudit {
  readonly format: 'method_audit@1';
  readonly run: string;
  readonly audited: string;
  readonly researcher: string;
  readonly model: string | null;
  /** Who judged J1-J6: the Judge's model, or null (a --flat audit: code only). */
  readonly judge: string | null;
  readonly measures: Measures;
  /** The outcome, as the run reports it: beside the method, not combined with it. */
  readonly outcome: J;
  readonly observed: Omit<LinkRecord, 'links' | 'rounds'> & { readonly links: readonly J[] };
  readonly judged: Judgements | null;
}

export interface Measures {
  readonly links: { readonly experiment: number; readonly observation: number; readonly recall: number };
  readonly refused_experiments: { readonly count: number; readonly cited_after: number };
  readonly citations: { readonly total: number; readonly seen: number; readonly unseen: number; readonly missing: number; readonly accuracy: number | null };
  readonly orphan_steps: { readonly count: number; readonly share: number | null };
  readonly controls: { readonly groups: number; readonly used: number; readonly paired: number; readonly replicated: number; readonly against_recorded: number };
  readonly beliefs: { readonly count: number; readonly revised: number; readonly dropped: number };
  /** From the Judge (null without it): shares of the experiment links (or rounds) by answer. */
  readonly judged?: {
    readonly complete_chains: number | null;
    readonly purpose: Readonly<Record<string, number>>;
    readonly discrimination: Readonly<Record<string, number>>;
    readonly reading: Readonly<Record<string, number>>;
    readonly scope: Readonly<Record<string, number>>;
    /** J3-J4 of the observations a later text cites. */
    readonly observation_reading: Readonly<Record<string, number>>;
    readonly observation_scope: Readonly<Record<string, number>>;
    readonly refutation: Readonly<Record<string, number>>;
    readonly control: Readonly<Record<string, number>>;
  };
}

const share = (n: number, of: number): number | null => (of ? Math.round(n / of * 1000) / 1000 : null);

/** How the answers to one question split, as shares. */
function split(all: readonly Record<string, Verdict | null>[], question: string): Record<string, number> {
  const answers = all.map((v) => v[question]?.answer).filter((a): a is string => Boolean(a));
  const out: Record<string, number> = {};
  for (const a of answers) out[a] = (out[a] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).map(([k, n]) => [k, share(n, answers.length)!]));
}

export function measuresOf(record: LinkRecord, judged: Judgements | null): Measures {
  const count = (k: string) => record.links.filter((l) => l.kind === k).length;
  const c = (s: string) => record.citations.filter((x) => x.status === s).length;
  const looked = record.links.filter((l) => l.kind !== 'recall').length;
  const revised = record.beliefs.filter((b) => b.stances.some((s) => s.stance === 'revise')).length;
  const dropped = record.beliefs.filter((b) => b.stances.some((s) => s.stance === 'drop')).length;
  const links = judged ? Object.values(judged.links) : [];
  const looks = judged ? Object.values(judged.observations) : [];
  const rounds = judged ? Object.values(judged.rounds) : [];
  const complete = links.filter((v) => ['own', 'operator'].includes(v.purpose?.answer ?? '') && v.discrimination?.answer === 'yes' && v.reading?.answer === 'correct' && v.scope?.answer === 'fitting').length;
  return {
    links: { experiment: count('experiment'), observation: count('observation'), recall: count('recall') },
    refused_experiments: { count: record.refused.length, cited_after: record.refused.filter((r) => r.cited_after.length).length },
    citations: { total: record.citations.length, seen: c('seen'), unseen: c('unseen'), missing: c('missing'), accuracy: share(c('seen'), record.citations.length) },
    orphan_steps: { count: record.orphans.length, share: share(record.orphans.length, looked) },
    controls: { groups: record.controls.length, used: record.controls.filter((g) => g.used).length,
      paired: record.controls.filter((g) => g.kind === 'paired').length, replicated: record.controls.filter((g) => g.kind === 'replicated').length,
      against_recorded: record.controls.filter((g) => g.kind === 'against_recorded').length },
    beliefs: { count: record.beliefs.length, revised, dropped },
    ...(judged ? { judged: {
      complete_chains: share(complete, links.length),
      purpose: split(links, 'purpose'), discrimination: split(links, 'discrimination'), reading: split(links, 'reading'), scope: split(links, 'scope'),
      observation_reading: split(looks, 'reading'), observation_scope: split(looks, 'scope'),
      refutation: split(rounds, 'refutation'), control: split(rounds, 'control')
    } } : {})
  };
}

/** The outcome as the run reports it: its checks, whether a model was accepted, and the latest rule recovery (operator). */
export function outcomeOf(journal: J): J {
  const events: J[] = journal.events ?? [];
  const checks = events.filter((e) => e.type === 'check').map((e) => {
    const labs: J[] = e.laboratories ?? [];
    return { round: e.round, holds: labs.every((p) => p.holds) && labs.length > 0, ...(labs.some((p) => p.wins !== undefined) ? { scored_1: labs.reduce((n, p) => n + (Number(p.wins) || 0), 0), of: labs.reduce((n, p) => n + (Number(p.total) || 0), 0) } : {}),
      ...(e.accepted ? { accepted: true } : {}) };
  });
  const recovery = [...events].reverse().find((e) => (e.type === 'operator_rule_recovery' || e.type === 'operator_law_recovery') && !e.error);
  const end = [...events].reverse().find((e) => e.type === 'end');
  return { checks, accepted: checks.some((c) => c.accepted), stopped_by: end?.stoppedBy ?? null, ...(recovery ? { rule_recovery: recovery.score ?? null } : {}) };
}

/** Audits a finished run; with no Judge, only what code observes. Writes `<run>.method.json` and returns it. */
export async function auditMethod(journalFile: string, judge: (Judge & { readonly id: string }) | null): Promise<MethodAudit> {
  const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8')) as J;
  if (!(journal.events ?? []).some((e: J) => e.type === 'end')) throw new Error('audit: the run has not ended (M1: the audit is of a finished run)');
  const record = linksOf(journal);
  const judged = judge ? await judgeMethod(record, judge) : null;
  const { links, rounds: _rounds, ...rest } = record;
  const audit: MethodAudit = {
    format: 'method_audit@1', run: path.basename(journalFile), audited: new Date().toISOString(),
    researcher: String(journal.researcher ?? 'unknown-world'), model: journal.config?.llm_model ?? null,
    judge: judge ? judge.id : null,
    measures: measuresOf(record, judged),
    outcome: outcomeOf(journal),
    observed: { ...rest, links: links.map((l) => ({ id: l.id, kind: l.kind, instruments: l.instruments, refused: l.refused, made: l.made, cited_by: l.after?.cites_this ?? [] })) },
    judged
  };
  fs.writeFileSync(auditFile(journalFile), JSON.stringify(audit, null, 2));
  /* The operator's finding links it; the researcher's is left as it was (M1). */
  const finding = findingOf(journal, { journal: path.basename(journalFile), ...methodOf(journalFile) });
  fs.writeFileSync(journalFile.replace(/\.json$/, '') + '.finding.json', JSON.stringify(finding, null, 2));
  return audit;
}

/** The audit of a run for its operator's finding, when there is one. */
export function methodOf(journalFile: string): { method?: { file: string; judge: string | null; measures: unknown } } {
  try {
    const a = JSON.parse(fs.readFileSync(auditFile(journalFile), 'utf8')) as MethodAudit;
    return { method: { file: path.basename(auditFile(journalFile)), judge: a.judge, measures: a.measures } };
  } catch { return {}; }
}

export const auditFile = (journalFile: string): string => journalFile.replace(/\.json$/, '') + '.method.json';
