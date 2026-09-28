import type { Lab } from '../../learn/lab.ts';
import { CELLS_PERCEPT_DOC, cellsPointWorld, describeCellsTruth, generateCells, perceiveCells, placeOf, readRow, runEpisode, type CellsPoint, type CellsSpec } from './world.ts';
import { cellsObjective, differences, type CellsCase } from './objective.ts';
import { cellsInterface } from './interface.ts';

/* cells@1 as a LABORATORY (SPEC-OBJETIVO O9): a ring of symbols whose next row follows a hidden local rule. System 2
   perceives rows and must write a model that answers the next row. */

/** An act: the row to start from - or several, oldest first, the last being the present. */
export interface CellsAct { readonly rows: readonly string[]; readonly place?: string }

export const cellsLab: Lab<CellsSpec, CellsPoint, string[], CellsCase, CellsAct> = {
  id: 'cells@1',
  about: 'System 2 perceives rows of symbols and must write a model that answers the next row.',
  options: [
    { name: 'level', default: '1', help: '1 the next symbol depends on a cell and its neighbours; 2 on a count within two cells; 3 also on the row before' },
    { name: 'acts', default: '4', help: 'episodes System 2 may start itself per round' }
  ],
  generate: (seed, o) => generateCells(seed, Number(o.level)),
  placeOf,
  runName: (seed, o) => 'cells-s' + seed + 'L' + o.level,
  headline: (spec) => 'level ' + spec.level + ' (width ' + spec.width + ', rule ' + spec.rule + ', radius ' + spec.radius + ')',
  placeInfo: (spec) => ({ width: spec.width, density: spec.density }),
  truth: describeCellsTruth,
  explorationSeed: (seed, o) => seed * 1013 + Number(o.level),

  world: cellsPointWorld,
  perceive: perceiveCells,
  perceptDoc: CELLS_PERCEPT_DOC,
  interface: cellsInterface,

  episode: (spec, rnd) => runEpisode(spec, rnd),
  steps: (rows) => rows.length - 1,
  explored: (rows) => ({ rows }),
  at: (rows, step) => (step >= 0 && step < rows.length ? { state: { rows: rows.slice(0, step + 1) }, shown: { the_next_row_was: rows[step + 1] ?? null } } : null),
  /* Every `every`-th step from the start (the first steps carry the most), each with a next row. A point needs as many
     rows as the next one depends on (the operator's `order`; never told). */
  cases: (base, id, rows, every) => {
    const first = (base.order ?? 1) - 1;
    return Array.from({ length: rows.length - 1 }, (_, t) => t).filter((t) => t >= first && (t - first) % every === 0)
      .map((t) => ({ point: id + '@' + t, state: { rows: rows.slice(0, t + 1) }, next: rows[t + 1] }));
  },
  ownEvery: 2,
  view: (rows, from, to) => ({ steps: rows.length - 1, rows: rows.slice(from, to + 1).map((row, i) => ({ step: from + i, row })) }),
  shown: (c) => ({ the_next_row_was: c.next }),

  act: {
    parse: (raw) => {
      const rows = typeof raw.row === 'string' ? [raw.row]
        : Array.isArray(raw.rows) && raw.rows.length && raw.rows.length <= 4 && raw.rows.every((r) => typeof r === 'string') ? raw.rows as string[] : null;
      return rows ? { rows, ...(typeof raw.place === 'string' ? { place: raw.place } : {}) } : 'act needs "row" (a string) or "rows" (a list of strings)';
    },
    place: (act) => act.place,
    start: (spec, act) => {
      const rows = act.rows.map((r) => readRow(spec, r));
      return rows.some((r) => !r) ? null : runEpisode(spec, rows as number[][]);
    },
    shown: (rows) => ({ rows })
  },
  simulate: {
    advance: (state, answer) => (typeof answer === 'string' ? { rows: [...state.rows, answer] } : 'the answer was not a string'),
    seen: (rows, step) => rows[step] ?? null
  },

  objective: (host) => cellsObjective(host),
  answerIssue: (a) => (typeof a === 'string' ? null : 'the answer must be a string (it was ' + JSON.stringify(a)?.slice(0, 60) + ')'),
  agrees: (a, c) => differences(a, c.next)?.length === 0,
  agreement: 'exact',
  baselines: (spec) => [
    { name: 'the same row again', source: '(p) => p.rows[p.rows.length - 1]' },
    { name: 'the row before it', source: '(p) => p.rows[Math.max(0, p.rows.length - 2)]' },
    ...spec.glyphs.map((g) => ({ name: 'a row of "' + g + '" only', source: '(p) => ' + JSON.stringify(g) + '.repeat(p.rows[p.rows.length - 1].length)' }))
  ],
  grading: {
    subject: 'of an environment it could only perceive as rows of symbols',
    reading: 'Read its model as code: what its observations, rules and output compute is what it claims.'
  }
};
