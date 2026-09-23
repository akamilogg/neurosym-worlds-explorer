import { round } from './hash.ts';

/* Policy priors: the Judge's distribution over concrete actions. A prior ORDERS the search and never
   removes an action (the harness's invariant I3). The merge is a declared, pure operation:
     single        - the first declared policy rule decides; the others are reported as ignored
     weighted_mean - normalised distributions averaged with policy_weights, then renormalised */

export type PolicyAggregate = 'single' | 'weighted_mean';

export function normaliseDistribution(distribution: Readonly<Record<string, number>> | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  let sum = 0;
  for (const key of Object.keys(distribution || {})) {
    const value = distribution![key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) { out[key] = value; sum += value; }
  }
  if (sum <= 0) return out;
  for (const key of Object.keys(out)) out[key] = round(out[key] / sum, 6);
  return out;
}

export interface PolicyMerge {
  readonly mode: PolicyAggregate;
  readonly prior: Record<string, number>;
  readonly used: string[];
  readonly ignored: string[];
}

export function mergePolicyDistributions(
  entries: ReadonlyArray<{ id: string; distribution: Readonly<Record<string, number>> } | null | undefined>,
  mode: string,
  policyWeights?: Readonly<Record<string, number>>
): PolicyMerge | null {
  const list = entries.filter((e): e is { id: string; distribution: Readonly<Record<string, number>> } => !!e && !!e.distribution);
  if (!list.length) return null;
  if (mode !== 'weighted_mean') {
    return { mode: 'single', prior: normaliseDistribution(list[0].distribution), used: [list[0].id], ignored: list.slice(1).map((e) => e.id) };
  }
  const weights = policyWeights || {};
  const merged: Record<string, number> = {};
  let sum = 0;
  for (const entry of list) {
    const w = Number.isFinite(weights[entry.id]) ? weights[entry.id] : round(1 / list.length, 4);
    sum += w;
    const normalised = normaliseDistribution(entry.distribution);
    for (const key of Object.keys(normalised)) merged[key] = (merged[key] || 0) + w * normalised[key];
  }
  if (sum <= 0) return null;
  for (const key of Object.keys(merged)) merged[key] = round(merged[key] / sum, 6);
  return { mode: 'weighted_mean', prior: merged, used: list.map((e) => e.id), ignored: [] };
}
