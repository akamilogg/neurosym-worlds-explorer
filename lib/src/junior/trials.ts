import { Trials, type MetaManifest, type TrialCandidate, type TrialLauncher, type TrialResult } from '../meta/lab.ts';
import type { JuniorSessionClient } from './client.ts';
import type { CompetenceManifest, InvestigationCase, Observation, Partition } from './competence.ts';
import type { JuniorPackage } from './package.ts';

/* ============================================================================
 * A junior's INVESTIGATIONS as M2 trials (SPEC-METAPOLITICA-APRENDIZAJE §6): the same reservations, ledger and
 * reconciliation, with a junior package as the candidate.
 *
 * Each launch opens a session of its own on the junior's server and points the child's System 2 at it (its OpenAI route):
 * the laboratory talks to the junior as to any researcher. A launch that resumes a trial continues the session of the
 * launch before it, from the last state that session published - its history is replayed from the trial's record without
 * asking the junior again.
 *
 * Its quality is read as the manifest's rung-6 components: each case's world accepted (1) or not (0), by the extractor its
 * component declares; a trial that measures nothing (infra, cancelled, unfunded) leaves its observation without a value.
 * ========================================================================== */

/** The manifest of M2 trials for a competence manifest's investigations: the same cases, args and repetitions. */
export function investigationManifest(m: CompetenceManifest): MetaManifest {
  const comps = new Map(m.components.map((c) => [c.id, c]));
  return {
    format: 'meta-lab@1',
    id: m.id + '-investigations',
    junior: { args: [...m.limits.junior_args] },
    repetitions: m.investigation_repetitions,
    cases: m.cases.filter((c): c is InvestigationCase => c.kind === 'investigation').map((c) => ({
      id: c.id, lab: c.lab, args: [...c.args], partition: c.partition, kind: c.components.join('+'),
      criterion: c.components.some((k) => comps.get(k)?.extractor.id === 'artifact_accepted') ? 'artifact_accepted' as const : 'model_accepted' as const
    }))
  };
}

/** Session ids are file names: a launch `t-…#n` is the session `t-….Ln`. */
const sessionOf = (launch: string): string => launch.replace(/[^\w.-]/g, '.').replace(/\.(\d+)$/, '.L$1');

/** A junior package as a trial candidate. `server`: its server's URL, whose sessions the children talk to. */
export function juniorCandidate(o: { pkg: JuniorPackage; execution: string; client: JuniorSessionClient; timeoutMs?: number }): TrialCandidate {
  return {
    config: 'junior:' + o.execution,
    label: o.execution,
    args: [],
    async connect({ trial, launch }) {
      const n = Number(launch.split('#').pop());
      const sid = sessionOf(launch);
      const previous = n > 0 ? sessionOf(trial + '#' + (n - 1)) : null;
      try { await o.client.info(sid); } catch {
        let continues = false;
        if (previous) { try { await o.client.info(previous); continues = true; } catch { /* its launch never opened one */ } }
        await o.client.open({ run_id: trial, pkg: o.pkg, session_id: sid, ...(continues ? { continues: { session_id: previous! } } : {}) });
      }
      return { url: o.client.url + '/sessions/' + encodeURIComponent(sid) + '/v1/chat/completions', key: 'junior-session', model: o.execution,
        jsonMode: false, temperature: o.pkg.decoding.temperature, ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) };
    }
  };
}

/** The trials of a competence manifest's investigations, with a launcher whose System 2 is each candidate's session. */
export function juniorTrials(dir: string, m: CompetenceManifest, launcher: TrialLauncher, o: { fund?: number; judgeFund?: number } = {}): Trials {
  return new Trials(dir, investigationManifest(m), launcher, o);
}

/** Observations of the rung-6 components from a candidate's trials: solved 1, not solved 0, nothing where it measured nothing. */
export function investigationObservations(m: CompetenceManifest, ran: readonly { case: string; rep: number; result: TrialResult }[]): Observation[] {
  const out: Observation[] = [];
  for (const r of ran) {
    const c = m.cases.find((x) => x.id === r.case);
    if (!c || c.kind !== 'investigation') continue;
    for (const k of c.components) {
      const measured = r.result.state === 'ended' && r.result.solved !== null;
      out.push({ component: k, case: c.id, rep: r.rep, value: measured ? (r.result.solved ? 1 : 0) : null,
        state: measured ? 'measured' : r.result.state === 'ended' ? 'error' : r.result.state, ...(r.result.why ? { why: r.result.why } : {}) });
    }
  }
  return out;
}

/** Runs a candidate's investigations on a partition and answers their observations. */
export async function runInvestigations(trials: Trials, m: CompetenceManifest, candidate: TrialCandidate, partition: Partition, signal?: AbortSignal): Promise<Observation[]> {
  return investigationObservations(m, await trials.runCandidate(candidate, partition, signal));
}
