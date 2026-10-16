import { LABS } from '../worlds/labs.ts';
import type { BatchRun } from './batch.ts';

/* ============================================================================
 * A BATCH DESIGNED FROM A TEMPLATE (SPEC-CONTROL-ARNES K3, §4.3, §7): the same runs under each condition, with the same
 * seeds - so that conditions are compared seed by seed (§6.2.1), never by their intervals side by side.
 *
 *   "template": { "lab", "args", "researcher", "agent", "messages" }     what every run has
 *   "vary": { "seeds": [1, 2, 3],
 *             "conditions": { "<name>": { "args": [...], "agent": {...} | null, "researcher", "messages" } },
 *             "args": { "--level": ["1", "2"], "--attempts": ["6", "12"] } }   varied in every condition, crossed
 *   "compare_conditions": [{ "a": "<condition>", "b": "<condition>", "metric", "margin", "relative" }]
 *             declared before: b against a, paired by seed and world
 *
 * The design says which perturbations of §7 it leaves uncovered (seeds, places, names, senior, opening, budgets): a
 * configuration characterized with one seed and one world is not characterized.
 * ========================================================================== */

type Agent = BatchRun['agent'];
export interface BatchTemplate {
  readonly lab: string;
  readonly args?: readonly string[];
  readonly researcher?: BatchRun['researcher'];
  readonly agent?: Agent;
  readonly messages?: BatchRun['messages'];
}
export interface Variation {
  readonly seeds: readonly number[];
  readonly conditions: Readonly<Record<string, { readonly args?: readonly string[]; readonly agent?: Agent | null; readonly researcher?: BatchRun['researcher']; readonly messages?: BatchRun['messages'] }>>;
  readonly args?: Readonly<Record<string, readonly string[]>>;
}

/** Whether a design is declared well (what the batch refuses to start with). */
export function designProblems(def: { readonly runs?: readonly unknown[]; readonly template?: BatchTemplate; readonly vary?: Variation }): string[] {
  if (!def.template && !def.vary) return [];
  const out: string[] = [];
  if (def.runs?.length) out.push('a batch is declared either by its runs or by a template and its variation, not both');
  if (!def.template || !LABS[def.template.lab]) out.push('"template": its "lab" (' + Object.keys(LABS).join(', ') + ')');
  if (!def.vary || !Array.isArray(def.vary.seeds) || !def.vary.seeds.length || !def.vary.seeds.every((s) => Number.isInteger(s))) out.push('"vary": its "seeds", integers');
  if (!def.vary?.conditions || !Object.keys(def.vary.conditions).length) out.push('"vary": its "conditions", each with what it changes');
  for (const name of Object.keys(def.vary?.conditions ?? {})) if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) out.push('condition ' + JSON.stringify(name) + ': letters, digits, - and _');
  for (const [k, vs] of Object.entries(def.vary?.args ?? {})) if (!k.startsWith('--') || !Array.isArray(vs) || !vs.length) out.push('"vary.args": ' + k + ' is "--name": [values]');
  const given = [...(def.template?.args ?? []), ...Object.values(def.vary?.conditions ?? {}).flatMap((c) => c.args ?? [])];
  if (given.includes('--seed')) out.push('the seeds are the variation\'s ("vary.seeds"), never in the args');
  return out;
}

/** The runs of a design: every condition, with every seed and every combination of what is varied. */
export function expandDesign(template: BatchTemplate, vary: Variation): BatchRun[] {
  let combos: { id: string; args: string[] }[] = [{ id: '', args: [] }];
  for (const [k, vs] of Object.entries(vary.args ?? {})) combos = combos.flatMap((c) => vs.map((v) => ({ id: c.id + '-' + k.slice(2) + v, args: [...c.args, k, v] })));
  const runs: BatchRun[] = [];
  for (const [condition, c] of Object.entries(vary.conditions)) for (const seed of vary.seeds) for (const combo of combos) {
    const agent = c.agent === null ? undefined : c.agent ?? template.agent;
    const messages = c.messages ?? template.messages;
    const researcher = c.researcher ?? template.researcher;
    runs.push({ id: condition + '-s' + seed + combo.id.replace(/[^a-z0-9_-]/gi, ''), condition, lab: template.lab,
      args: mergeArgs(template.args ?? [], c.args ?? [], combo.args, ['--seed', String(seed)]),
      ...(researcher ? { researcher } : {}), ...(agent ? { agent } : {}), ...(messages ? { messages } : {}) });
  }
  return runs;
}

/** Arguments laid one over another: what a condition or the variation sets replaces what the template set (a flag given
    twice would be read once, and not as declared). A flag without a value is one followed by another flag, or by nothing. */
export function mergeArgs(...lists: readonly (readonly string[])[]): string[] {
  const out: [string, string | null][] = [];
  for (const list of lists) for (let i = 0; i < list.length; i++) {
    const flag = list[i];
    const value = i + 1 < list.length && !list[i + 1].startsWith('--') ? list[++i] : null;
    const at = out.findIndex(([f]) => f === flag);
    if (at >= 0) out.splice(at, 1);
    out.push([flag, value]);
  }
  return out.flatMap(([f, v]) => (v === null ? [f] : [f, v]));
}

const BUDGETS = ['--attempts', '--max-tokens', '--max-minutes'];

/** What a design covers of the perturbations of §7, and what it leaves uncovered - said, never silently. */
export function coverage(template: BatchTemplate, vary: Variation): { covered: string[]; uncovered: string[] } {
  const lab = LABS[template.lab];
  const varied = Object.keys(vary.args ?? {});
  const conditions = Object.values(vary.conditions);
  const agentOf = (c: Variation['conditions'][string]) => (c.agent === null ? undefined : c.agent ?? template.agent);
  const seniors = conditions.map(agentOf).map((a) => a?.role === 'senior');
  const openings = conditions.map(agentOf).filter((a) => a?.role === 'senior').map((a) => a!.opening !== false);
  const worldOptions = new Set(['--family', ...(lab?.options ?? []).map((o) => '--' + o.name)]);
  const condArgs = conditions.flatMap((c) => c.args ?? []);
  const checks: [string, boolean][] = [
    ['seeds: at least 3 per group', vary.seeds.length >= 3],
    ['places or families of the world', varied.some((k) => worldOptions.has(k)) || condArgs.some((a) => worldOptions.has(a))],
    ...((lab?.options ?? []).some((o) => o.name === 'names') ? [['real names and neutral ones', varied.includes('--names') || condArgs.includes('--names')] as [string, boolean]] : []),
    ['with a senior and without', seniors.includes(true) && seniors.includes(false)],
    ['with an opening hypothesis and without', openings.includes(true) && openings.includes(false)],
    ['budgets', varied.some((k) => BUDGETS.includes(k)) || condArgs.some((a) => BUDGETS.includes(a))]
  ];
  return { covered: checks.filter(([, ok]) => ok).map(([w]) => w), uncovered: checks.filter(([, ok]) => !ok).map(([w]) => w) };
}
