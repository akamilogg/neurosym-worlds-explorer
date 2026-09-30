import { INVESTIGATION_TOOLS as INVESTIGATION, type WorldInterface } from '../../learn/prompt.ts';
import { objectiveLines } from '../../learn/objective.ts';
import { P3_ANSWER, p3Verdict } from './objective.ts';

/** particles3d@1's interface to the common prompt: its objective's lines, then the parameters of its instruments.
    Interface words only (SPEC-MUNDO-FISICO I5): nothing says what the columns are, nor what the world is. */
export function p3Interface(options: { regression?: boolean } = {}): WorldInterface {
  return {
    tools: ['view', 'inspect', 'act', 'measure', 'simulate', 'table'],
    features: ['check'],
    lines: [
      ...objectiveLines({ answer: P3_ANSWER, verdictForm: p3Verdict(options) }),
      [INVESTIGATION, 'Requests:'],
      [['view'], '  {"view": "<episode>", "from": <row>, "to": <row>}   rows of one of your tables (at most 60 per request)'],
      [['act'], '  {"act": {"launch": [{"name": "<column>", "x": <number>, "y": <number>, "z": <number>, "vx": <number>, "vy": <number>, "vz": <number>}, ...], "place": "<laboratory>"}}   start an episode yourself in one of your laboratories (default: the first), with only the columns you list (each at most once): each starts at (x, y, z) and changes at first by (vx, vy, vz) per unit of the first column. The columns that never move in your tables cannot be launched. You get its table (named "act<n>"). It may be refused, and you are not told why. At most `acts_left` this round.'],
      [['inspect'], '  {"inspect": "<episode>@<row>", "model": <round> | <draft> }   what a model (without "model": your latest) answered at that point, part by part: what each observation measured, what each rule answered, V, its answer and the named values its output returned - and the next row that was observed'],
      [['measure'], '  {"measure": {"source": "(p) => ...", "range": [min, max]}, "on": ["<episode>@<row>", ...]}'],
      [['simulate'], '  {"simulate": "<episode>@<row>", "model": <round> | <draft>, "steps": <n>}   each next row is the model\'s answer, row after row (at most 40), next to what was observed there if anything was'],
      [['table'], '  {"table": {"source": "(p) => ...", "range": [min, max]}, "on": "episodes" | "checks"}   the points of your own episodes, or of the checks, each with the value of the code, the next row observed, and what the next row showed minus the answer of your latest model']
    ]
  };
}

export interface P3Launch { readonly name: string; readonly x: number; readonly y: number; readonly z: number; readonly vx: number; readonly vy: number; readonly vz: number }
export interface P3Act { readonly launch: readonly P3Launch[]; readonly place?: string }

/** An act's parameters, or why they cannot be read. */
export function parseP3Act(raw: Record<string, unknown>): P3Act | string {
  const list = Array.isArray(raw.launch) ? raw.launch : null;
  const usage = 'act needs "launch": a list of {"name", "x", "y", "z", "vx", "vy", "vz"} (numbers), each name at most once';
  if (!list || !list.length || list.length > 12) return usage;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const launch: P3Launch[] = [];
  for (const l of list) {
    const o = (l && typeof l === 'object' ? l : {}) as Record<string, unknown>;
    const vals = ['x', 'y', 'z', 'vx', 'vy', 'vz'].map((k) => num(o[k] ?? (k.startsWith('v') ? 0 : undefined)));
    if (typeof o.name !== 'string' || vals.some((v) => v === null) || launch.some((x) => x.name === o.name)) return usage;
    const [x, y, z, vx, vy, vz] = vals as number[];
    launch.push({ name: o.name, x, y, z, vx, vy, vz });
  }
  return { launch, ...(typeof raw.place === 'string' ? { place: raw.place } : {}) };
}
