import { INVESTIGATION_TOOLS as INVESTIGATION, system2Prompt, type WorldInterface } from '../../learn/prompt.ts';
import { objectiveLines } from '../../learn/objective.ts';
import { ORBIT_ANSWER, orbitVerdict } from './objective.ts';

/* orbit@1's side of the law explorer (learn/law-explorer.ts): its interface to the common prompt, its instruments, and
   the parameters of its act. The session and the parser in learn/ know none of this (SPEC-OBJETIVO O8). */

/** The physical world's interface to the common prompt (learn/prompt.ts): what its model produces, how its parts combine,
    the parameters of its instruments and the form of a verdict. Interface words only (SPEC-MUNDO-FISICO I5). */
export function orbitInterface(options: { regression?: boolean } = {}): WorldInterface {
  return {
    tools: ['view', 'inspect', 'act', 'measure', 'simulate', 'table'],
    features: ['check'],
    lines: [
      /* The objective's: the form of the answer and of a verdict (worlds/orbit/objective.ts). */
      ...objectiveLines({ answer: ORBIT_ANSWER, verdictForm: orbitVerdict(options) }),
      [INVESTIGATION, 'Requests:'],
      [['view'], '  {"view": "<episode>", "from": <step>, "to": <step>}   rows of one of your tables (at most 60 per request)'],
      [['act'], '  {"act": {"x": <number>, "y": <number>, "vx": <number>, "vy": <number>, "m": <number>, "place": "<laboratory>"}}   start an episode yourself in one of your laboratories (default: the first): its last pair of columns starts at (x, y) and changes at first by (vx, vy) per unit of the first column; "m" is a positive number you choose (default 1). You get its table (named "act<n>"). It may be refused, and you are not told why. At most `acts_left` this round.'],
      [['inspect'], '  {"inspect": "<episode>@<step>", "model": <round> | <draft> }   what a model (without "model": your latest) answered at that point, part by part: what each observation measured, what each rule answered, V, its answer and the named values its output returned - and what was observed in the next row'],
      [['measure'], '  {"measure": {"source": "(p) => ...", "range": [min, max]}, "on": ["<episode>@<step>", ...]}'],
      [['simulate'], '  {"simulate": "<episode>@<step>", "model": <round> | <draft>, "steps": <n>}   each next row of the last pair is the model\'s answer, row after row (at most 40), next to what was observed there if anything was'],
      [['table'], '  {"table": {"source": "(p) => ...", "range": [min, max]}, "on": "episodes" | "checks"}   the points of your own episodes, or of the checks, each with the RESIDUAL of your latest model there (what the next row showed minus your answer) and the environment\'s verdict at that point']
    ]
  };
}

export const ORBIT_INTERFACE: WorldInterface = orbitInterface();

export const ORBIT_TOOLS = ['view', 'inspect', 'act', 'measure', 'simulate', 'table'] as const;
export type OrbitTool = typeof ORBIT_TOOLS[number];
type Tools = ReadonlySet<OrbitTool>;

/** orbit@1's system prompt for the instruments it is given (all of them by default): the common prompt. */
export function orbitSystem(tools: Tools = new Set(ORBIT_TOOLS), options: { regression?: boolean } = {}): string {
  return system2Prompt(options.regression ? orbitInterface(options) : ORBIT_INTERFACE, tools);
}

/** orbit@1's act: start an episode at (x, y), changing at first by (vx, vy), with m, in a laboratory. */
export interface OrbitAct { readonly x: number; readonly y: number; readonly vx: number; readonly vy: number; readonly m: number; readonly setup?: string }

/** orbit@1's act parameters, or why they cannot be read. */
export function parseOrbitAct(l: Record<string, unknown>): OrbitAct | string {
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const [x, y, vx, vy] = [num(l.x), num(l.y), num(l.vx), num(l.vy)];
  const m = l.m === undefined ? 1 : num(l.m);
  if (x === null || y === null || vx === null || vy === null || m === null || !(m > 0)) return 'act needs numbers x, y, vx, vy (and a positive m)';
  const place = l.place ?? l.setup;
  return { x, y, vx, vy, m, ...(typeof place === 'string' ? { setup: place } : {}) };
}
