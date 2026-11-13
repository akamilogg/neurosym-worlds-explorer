import type { AnyLab } from '../learn/lab.ts';
import { COMMON_REQUESTS, type RequestClass } from '../learn/requests.ts';
import { LivingBridge } from '../living/bridge.ts';
import { cellsLab } from './cells/lab.ts';
import { messagesLab } from './messages/lab.ts';
import { orbitLab } from './orbit/lab.ts';
import { gridLab } from './grid/lab.ts';
import { tankLab } from './tank/lab.ts';
import { particles3dLab } from './particles3d/lab.ts';
import { c302NavLab } from './c302nav/lab.ts';
import { closedLab } from './c302closed/lab.ts';
import { artifactsLab } from './artifacts/lab.ts';
import { platesLab } from './plates/lab.ts';
import { juniorLab } from './junior/lab.ts';
/* What the runtime needs of a world beyond its laboratory, reached through this registry (SPEC-CONSOLIDACION §5.3). */
export { JuniorWorld } from './junior/lab.ts';

/** The worlds declared as laboratories (SPEC-OBJETIVO O9), by the name `run-lab.ts --lab` takes. The grid has a loop of
    its own (its model is a formula a search plays with) and runs with the services every laboratory shares. */
export const LABS: Readonly<Record<string, AnyLab>> = { cells: cellsLab, messages: messagesLab, orbit: orbitLab, grid: gridLab, tank: tankLab, particles3d: particles3dLab, c302nav: c302NavLab, c302closed: closedLab, artifacts: artifactsLab, plates: platesLab,
  /* Read when it is asked for, not when this registry is made: the junior's world imports the competence manifest, which
     reads this registry - a cycle that loading the junior's world first would otherwise break. */
  get junior() { const problems = labRequestProblems(juniorLab); if (problems.length) throw new Error('laboratory junior: ' + problems.join('; ')); return juniorLab; } };

/** The classes of every request a laboratory's researcher may make (SPEC-VALIDEZ-MEDIDA §6.1): the common ones, a living
    world's own (its bridge's), and those the laboratory declares. */
export function requestTableOf(lab: AnyLab): Readonly<Record<string, RequestClass>> {
  const own = (lab as { requests?: Readonly<Record<string, RequestClass>> }).requests ?? {};
  return { ...COMMON_REQUESTS, ...((lab as { living?: unknown }).living ? LivingBridge.REQUESTS : {}), ...own };
}

/** How a living world's adapter names what the generic layer shows (SPEC-VALIDEZ-MEDIDA §9), by the adapter's id as a
    world's record names it; none when no laboratory here has that adapter. */
export function livingNaming(adapter: unknown): NonNullable<import('../living/world.ts').LivingWorldAdapter<unknown, unknown>['naming']> {
  for (const name of Object.keys(LABS)) {
    if (name === 'junior') continue;
    const living = (LABS[name] as { living?: { adapter?: { id?: string; naming?: unknown } } }).living;
    const a = living?.adapter;
    if (a && a.id === adapter) return (a.naming ?? {}) as never;
  }
  return {};
}

/** What is wrong with a laboratory's own requests: one declared with no class is an error, never a recall by default. */
export function labRequestProblems(lab: AnyLab): string[] {
  const own = (lab as { requests?: Readonly<Record<string, unknown>> }).requests ?? {};
  const classes = ['experiment', 'observation', 'recall', 'exchange'];
  return Object.entries(own).filter(([, c]) => !classes.includes(String(c))).map(([k]) => 'requests: "' + k + '" has no class (experiment, observation, recall or exchange)');
}

/* Loading the registry checks every laboratory's (the junior's when it is first read: see its getter). */
for (const name of Object.keys(LABS)) {
  if (name === 'junior') continue;
  const problems = labRequestProblems(LABS[name]);
  if (problems.length) throw new Error('laboratory ' + name + ': ' + problems.join('; '));
}

/** The same, for a run's record: by its experiment's id ("cells@1"); the common table when no laboratory here is it. */
export function requestTableFor(experiment: unknown): Readonly<Record<string, RequestClass>> {
  const lab = Object.values(LABS).find((l) => l.id === experiment);
  return lab ? requestTableOf(lab) : COMMON_REQUESTS;
}
