import fs from 'node:fs';
import path from 'node:path';
import type { TrialLauncher } from '../meta/lab.ts';
import type { LabConnection } from '../runtime/lab-runner.ts';
import type { JuniorSessionClient } from './client.ts';
import { competenceHash, competenceProblems, measure, promote, type CompetenceManifest, type Measure, type Observation, type Partition, type Promotion } from './competence.ts';
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
export async function prepareManifest(raw: unknown): Promise<{ manifest: CompetenceManifest; hash: string; problems: string[] }> {
  const problems = competenceProblems(raw);
  const m = raw as CompetenceManifest;
  if (!problems.length) for (const c of m.cases) {
    if (c.kind !== 'probe') continue;
    try {
      const cut = await captureCut(c.cut.run, c.cut.question);
      if (cut.hash !== c.cut.hash) problems.push('case ' + c.id + ': its cut is not the one declared (' + cut.hash + ')');
      if (cut.lab !== c.lab) problems.push('case ' + c.id + ': its cut is of ' + cut.lab + ', not ' + c.lab);
    } catch (e) { problems.push('case ' + c.id + ': its cut cannot be taken: ' + (e as Error).message); }
  }
  return { manifest: m, hash: problems.length ? '' : competenceHash(m), problems };
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

/** paired-cases@1 between two evaluations of the same manifest and partition; anything else is refused. */
export function promoteEvaluations(m: CompetenceManifest, manifestHash: string, reference: Evaluation, candidate: Evaluation): Promotion {
  for (const [w, e] of [['reference', reference], ['candidate', candidate]] as const)
    if (e.manifest !== manifestHash) return { verdict: 'inconclusive', why: 'the ' + w + ' was measured under another manifest', components: [] };
  if (reference.partition !== candidate.partition) return { verdict: 'inconclusive', why: 'measured on different partitions', components: [] };
  if (reference.execution !== m.reference) return { verdict: 'inconclusive', why: 'the reference evaluated is not the manifest\'s reference junior', components: [] };
  /* The measure is rebuilt from the observations: what was recorded, not what an evaluation file says it computed. */
  return promote(m, measure(m, reference.partition, reference.temperature, reference.observations), measure(m, candidate.partition, candidate.temperature, candidate.observations));
}
