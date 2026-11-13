import fs from 'node:fs';
import path from 'node:path';
import type { TrialLauncher } from '../meta/lab.ts';
import type { LabConnection } from '../runtime/lab-runner.ts';
import type { JuniorSessionClient } from './client.ts';
import { competenceHash, competenceProblems, competenceWarnings, holdoutManifest, measure, promote, type CompetenceManifest, type Measure, type Observation, type Partition, type Promotion } from './competence.ts';
import { executionHash, normalizePackage, type JuniorPackage } from './package.ts';
import { captureCut, runProbes } from './probes.ts';
import { juniorCandidate, juniorTrials } from './trials.ts';

/* ============================================================================
 * A junior EVALUATED under a competence manifest (SPEC-METAPOLITICA-APRENDIZAJE §6.2, §6.3, §10): its investigations as
 * M2 trials, its probes at their cuts, its measure; kept per candidate in the evaluation's folder, never computed twice.
 * The baseline is this evaluation of the reference junior, as it is, before any change is proposed.
 *
 * The measure's link to its manifest is the manifest's hash, recorded beside it: the manifest never holds its baseline.
 * Promotion compares two evaluations under the same manifest with paired-cases@1, from what was measured - no model.
 * ========================================================================== */

export interface Evaluation {
  readonly format: 'junior-evaluation@1';
  readonly manifest: string;
  readonly execution: string;
  readonly partition: Partition;
  readonly temperature: number;
  readonly observations: readonly Observation[];
  readonly measure: Measure;
}

/** A manifest prepared to run: valid, and every probe's cut taken again with the hash it declares. Refused otherwise,
    before anything is reserved. */
export async function prepareManifest(raw: unknown): Promise<{ manifest: CompetenceManifest; hash: string; problems: string[]; warnings: string[] }> {
  const problems = competenceProblems(raw);
  /* What does not stop it from running but bounds what it can decide (SPEC-VALIDEZ-MEDIDA §4.2): told to whoever prepares it. */
  const warnings = problems.length ? [] : competenceWarnings(raw as CompetenceManifest);
  const m = raw as CompetenceManifest;
  if (!problems.length) for (const c of m.cases) {
    if (c.kind !== 'probe') continue;
    try {
      const cut = await captureCut(c.cut.run, c.cut.question);
      if (cut.hash !== c.cut.hash) problems.push('case ' + c.id + ': its cut is not the one declared (' + cut.hash + ')');
      if (cut.lab !== c.lab) problems.push('case ' + c.id + ': its cut is of ' + cut.lab + ', not ' + c.lab);
    } catch (e) { problems.push('case ' + c.id + ': its cut cannot be taken: ' + (e as Error).message); }
  }
  return { manifest: m, hash: problems.length ? '' : competenceHash(m), problems, warnings };
}

const evaluationFile = (dir: string, manifestHash: string, execution: string, partition: Partition) => path.join(dir, 'evaluations', manifestHash.slice(0, 16) + '-' + execution.slice(0, 16) + '-' + partition + '.json');

/** A candidate's whole evaluation on a partition: its investigations, then its probes. What was measured before is taken
    from the trials' ledger and the probes' ledger; only what is missing runs. */
export async function evaluate(o: {
  dir: string; manifest: CompetenceManifest; manifestHash: string; pkg: JuniorPackage; client: JuniorSessionClient; launcher: TrialLauncher;
  partition?: Partition; judge?: LabConnection; fund?: number; judgeFund?: number; signal?: AbortSignal;
}): Promise<Evaluation> {
  const partition = o.partition ?? 'development';
  const pkg = normalizePackage(o.pkg);
  const execution = executionHash(pkg);
  fs.mkdirSync(path.join(o.dir, 'evaluations'), { recursive: true });
  const observations: Observation[] = [];
  if (o.manifest.cases.some((c) => c.kind === 'investigation' && c.partition === partition)) {
    const trials = juniorTrials(path.join(o.dir, 'trials'), o.manifest, o.launcher, { ...(o.fund !== undefined ? { fund: o.fund } : {}), ...(o.judgeFund !== undefined ? { judgeFund: o.judgeFund } : {}) });
    const { investigationObservations } = await import('./trials.ts');
    observations.push(...investigationObservations(o.manifest, await trials.runCandidate(juniorCandidate({ pkg, execution, client: o.client, timeoutMs: o.manifest.limits.timeout_ms }), partition, o.signal)));
  }
  if (partition === 'development' && !o.signal?.aborted)
    observations.push(...await runProbes(o.manifest, o.manifestHash, { pkg, execution, client: o.client, ledger: path.join(o.dir, 'probes.jsonl'), ...(o.judge ? { judge: o.judge } : {}), ...(o.signal ? { signal: o.signal } : {}) }));
  const e: Evaluation = { format: 'junior-evaluation@1', manifest: o.manifestHash, execution, partition, temperature: pkg.decoding.temperature, observations, measure: measure(o.manifest, partition, pkg.decoding.temperature, observations) };
  fs.writeFileSync(evaluationFile(o.dir, o.manifestHash, execution, partition), JSON.stringify(e, null, 2));
  return e;
}

/** The promotion of a candidate that came out of a search (SPEC-VALIDEZ-MEDIDA §4.3): the same procedure between the same
    evaluations, measured on the manifest's holdout alone - the cases the search never selected on. Null without a
    holdout: such a candidate is the best of N in selection, never promoted. */
export function promoteOnHoldout(m: CompetenceManifest, manifestHash: string, reference: Evaluation, candidate: Evaluation): Promotion | null {
  const held = holdoutManifest(m);
  if (!held) return null;
  const checked = promoteEvaluations(m, manifestHash, reference, candidate, held);
  if (checked.verdict === 'inconclusive' && !checked.components.length) return checked;
  /* It answers for every component, not only the holdout's: one without cases there is judged on all of development, where
     selecting on the probes favours none of it - a candidate that sinks it is not promoted, whatever it gains on the holdout
     (SPEC-VALIDEZ-MEDIDA §4.3). The holdout's components are judged on the holdout alone, where nothing was selected. */
  const inHoldout = new Set(held.components.map((c) => c.id));
  const whole = promoteEvaluations(m, manifestHash, reference, candidate);
  const outside = whole.components.filter((c) => !inHoldout.has(c.id));
  if (whole.verdict === 'inconclusive' && !whole.components.length) return whole;
  const sunk = outside.filter((c) => c.regresses);
  const components = [...checked.components, ...outside.map((c) => ({ ...c, improves: false }))];
  if (sunk.length) return { verdict: 'not_promoted', why: 'it regresses outside the holdout, on development: ' + sunk.map((c) => c.id).join(', '), components };
  return { ...checked, components };
}

/** The one rule that promotes a candidate, whatever path presents it - the researcher's check, the operator's rule in C
    and E (SPEC-VALIDEZ-MEDIDA §4.3): one no search selected, on all of development; one a search selected, on the holdout
    alone (promoteOnHoldout); and without a holdout, never - it may be adopted and investigated further, but it is the best
    of N in selection, not a promotion. */
export function promoteCandidate(m: CompetenceManifest, manifestHash: string, reference: Evaluation, candidate: Evaluation, o: { readonly fromSearch: boolean }): Promotion {
  if (!o.fromSearch) return promoteEvaluations(m, manifestHash, reference, candidate);
  const held = promoteOnHoldout(m, manifestHash, reference, candidate);
  if (held) return held;
  const whole = promoteEvaluations(m, manifestHash, reference, candidate);
  return { verdict: whole.verdict === 'promoted' ? 'inconclusive' : whole.verdict,
    why: 'a candidate a search selected, with no holdout to promote it on: the best of N in selection, never a promotion' + (whole.verdict === 'promoted' ? '' : ' (' + whole.why + ')'),
    components: whole.components.map((c) => ({ ...c, improves: false })) };
}

/** paired-cases between two evaluations of the same manifest and partition; anything else is refused. `on`: a part of the
    manifest to measure them on (its holdout), the evaluations still those of `m`. */
export function promoteEvaluations(m: CompetenceManifest, manifestHash: string, reference: Evaluation, candidate: Evaluation, on?: CompetenceManifest): Promotion {
  for (const [w, e] of [['reference', reference], ['candidate', candidate]] as const)
    if (e.manifest !== manifestHash) return { verdict: 'inconclusive', why: 'the ' + w + ' was measured under another manifest', components: [] };
  if (reference.partition !== candidate.partition) return { verdict: 'inconclusive', why: 'measured on different partitions', components: [] };
  if (reference.execution !== m.reference) return { verdict: 'inconclusive', why: 'the reference evaluated is not the manifest\'s reference junior', components: [] };
  /* The measure is rebuilt from the observations: what was recorded, not what an evaluation file says it computed. */
  const by = on ?? m;
  return promote(by, measure(by, reference.partition, reference.temperature, reference.observations), measure(by, candidate.partition, candidate.temperature, candidate.observations));
}
