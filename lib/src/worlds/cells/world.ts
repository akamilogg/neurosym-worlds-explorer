import { hashString } from '../../core/hash.ts';
import type { World } from '../../core/types.ts';
import { mulberry32 } from '../grid/gen.ts';

/* ============================================================================
 * cells@1: a third environment, built to test that a world connects to the common prompt
 * and protocol with only its world, senses, actions and objective (SPEC-OBJETIVO O5).
 *
 * A row of cells, each showing one of two symbols, closed into a ring. Every step each
 * cell takes a symbol that depends only on the cells near it (a hidden local rule). The
 * learner perceives only the rows, as strings of symbols; it answers the NEXT row.
 *
 *   level 1   the next symbol depends on the cell and its two neighbours (an elementary rule)
 *   level 2   on how many cells show the second symbol within two cells either side
 *   level 3   on how many of the cell and its two neighbours show the second symbol, AND on the
 *             cell's own symbol in the row before (second order: the present row is not enough)
 *   level 4   TWO LAYERS: the cells at even positions form a ring of their own, and so do the
 *             cells at odd positions, each under an elementary rule of its own - two dynamics in
 *             one row, for a task that may care about only one of them (a FACET, SPEC-
 *             INVESTIGADOR-ASISTIDO §6.2)
 *
 * The FAMILY: the same rule and symbols; other ring lengths and other mixes of symbols at
 * the start. Nothing here is told to the learner: the hidden rule is the operator's.
 * ========================================================================== */

export interface CellsSpec {
  readonly id: string;
  readonly seed: number;
  readonly level: number;
  /** Cells in the ring. */
  readonly width: number;
  /** Cells either side a cell's next symbol depends on. */
  readonly radius: 1 | 2;
  /** Rows the next one depends on: 1 the present row; 2 also the row before it. */
  readonly order?: 1 | 2;
  /** Level 1: the elementary rule (0-255; bit n is the next state of the neighbourhood read as the number n).
      Level 2: bit n is the next state when n cells of the neighbourhood show the second symbol.
      Level 3: bit (n + 4 p) is the next state when n cells of the three show the second symbol and the cell showed p
      (0 or 1) in the row before. */
  readonly rule: number;
  /** The two symbols, as the learner sees them. */
  readonly glyphs: readonly [string, string];
  /** The share of cells showing the second symbol at an episode's start. */
  readonly density: number;
  /** Rows after the first in an episode. */
  readonly steps: number;
  /** Level 4: the elementary rules of the two interleaved rings - the cells at even positions, and at odd ones. */
  readonly layers?: readonly [number, number];
}

/* Rules whose rows keep changing in ways worth modelling (neither dying out nor freezing at once). */
const ELEMENTARY = [30, 45, 54, 57, 60, 62, 73, 75, 86, 89, 90, 99, 101, 105, 106, 110, 120, 122, 124, 126, 135, 137, 146, 147, 149, 150, 153, 154, 169, 182, 193, 195, 225];
const GLYPHS = ['.', '#', 'o', 'x', '+', '-', '*', '=', '~', '^', ':', '%'];

export function generateCells(seed: number, level = 1): CellsSpec {
  const rnd = mulberry32(seed * 7919 + level * 104729);
  if (level === 4) {
    /* Two lively elementary rules, different; a ring of even length, so that both layers are rings. */
    const a = ELEMENTARY[Math.floor(rnd() * ELEMENTARY.length)];
    let b = a;
    while (b === a) b = ELEMENTARY[Math.floor(rnd() * ELEMENTARY.length)];
    const g0 = Math.floor(rnd() * GLYPHS.length);
    let g1 = Math.floor(rnd() * (GLYPHS.length - 1));
    if (g1 >= g0) g1++;
    return { id: 'cells@1:s' + seed + 'L4', seed, level, width: 2 * (8 + Math.floor(rnd() * 5)), radius: 1, rule: a, layers: [a, b], glyphs: [GLYPHS[g0], GLYPHS[g1]], density: 0.3 + rnd() * 0.4, steps: 24 };
  }
  const radius: 1 | 2 = level === 2 ? 2 : 1;
  const order: 1 | 2 = level >= 3 ? 2 : 1;
  /* A rule whose rows keep changing (lively): one that empties or freezes the rows leaves every check trivial - "the
     same row again" or "an empty row" would hold. A second-order rule must also depend on both rows. */
  let rule = -1;
  for (let tries = 0; tries < 400; tries++) {
    const candidate = order === 2 ? Math.floor(rnd() * 256) : radius === 1 ? ELEMENTARY[Math.floor(rnd() * ELEMENTARY.length)] : Math.floor(rnd() * 64);
    if (order === 2 && ((candidate & 15) === (candidate >> 4) || !dependsOnPresent(candidate))) continue;
    if (lively({ radius, order, rule: candidate })) { rule = candidate; break; }
  }
  if (rule < 0) throw new Error('no lively rule for seed ' + seed + ' level ' + level);
  const a = Math.floor(rnd() * GLYPHS.length);
  let b = Math.floor(rnd() * (GLYPHS.length - 1));
  if (b >= a) b++;
  return { id: 'cells@1:s' + seed + 'L' + level, seed, level, width: 16 + Math.floor(rnd() * 9), radius, ...(order === 2 ? { order } : {}), rule, glyphs: [GLYPHS[a], GLYPHS[b]], density: 0.3 + rnd() * 0.4, steps: 24 };
}

/** A second-order rule whose next symbol changes with the present count, for some previous symbol. */
const dependsOnPresent = (rule: number) => [0, 4].some((p) => new Set([0, 1, 2, 3].map((n) => (rule >> (n + p)) & 1)).size > 1);

/** Whether a rule keeps its rows changing: from most random starts (a few ring lengths, half of each symbol), after as
    many steps as an episode, the row still changes within two steps and neither symbol has taken nearly all the cells. */
export function lively(rule: Pick<CellsSpec, 'radius' | 'rule' | 'order'>, steps = 24): boolean {
  const rnd = mulberry32(rule.rule * 31 + rule.radius * 7 + (rule.order ?? 1) * 1009 + 1);
  let ok = 0, total = 0;
  for (const width of [12, 20, 31]) {
    for (let k = 0; k < 4; k++, total++) {
      const draw = () => Array.from({ length: width }, () => (rnd() < 0.5 ? 1 : 0));
      let prev: number[] = draw(), row: number[] = draw();
      const seen: number[][] = [row];
      for (let t = 0; t < steps; t++) { const next = stepCells(rule, row, prev); prev = row; row = next; seen.push(row); }
      const [a, b, c] = seen.slice(-3).map((r) => r.join(''));
      const share = row.reduce((n, v) => n + v, 0) / width;
      if (c !== b && c !== a && share >= 0.1 && share <= 0.9) ok++;
    }
  }
  return ok >= Math.ceil(total * 0.75);
}

/** One step of the ring: every cell's next state from its neighbourhood (and, second order, its state in the row before). */
export function stepCells(spec: Pick<CellsSpec, 'radius' | 'rule' | 'order'> & { readonly layers?: CellsSpec['layers'] }, row: readonly number[], prev: readonly number[] = row): number[] {
  const n = row.length;
  if (spec.layers) {
    /* Two rings in one row: the cells at even positions, and at odd ones, each stepped under its own rule. */
    const out = new Array<number>(n);
    for (const parity of [0, 1] as const) {
      const ring = row.filter((_, i) => i % 2 === parity);
      const next = stepCells({ radius: 1, rule: spec.layers[parity] }, ring);
      next.forEach((v, k) => { out[2 * k + parity] = v; });
    }
    return out;
  }
  return row.map((_, i) => {
    if (spec.order === 2) {
      const sum = row[(i - 1 + n) % n] + row[i] + row[(i + 1) % n];
      return (spec.rule >> (sum + 4 * prev[i])) & 1;
    }
    if (spec.radius === 1) {
      const k = (row[(i - 1 + n) % n] << 2) | (row[i] << 1) | row[(i + 1) % n];
      return (spec.rule >> k) & 1;
    }
    let sum = 0;
    for (let d = -2; d <= 2; d++) sum += row[(i + d + n) % n];
    return (spec.rule >> sum) & 1;
  });
}

export const renderRow = (spec: CellsSpec, row: readonly number[]): string => row.map((v) => spec.glyphs[v]).join('');

/** A row as states, or null when it is not a row of this ring (length, symbols). */
export function readRow(spec: CellsSpec, text: string): number[] | null {
  if (typeof text !== 'string' || text.length !== spec.width) return null;
  const row: number[] = [];
  for (const ch of text) {
    const v = spec.glyphs.indexOf(ch);
    if (v < 0) return null;
    row.push(v);
  }
  return row;
}

/** An episode's rows, as perceived: from a start (drawn with `rnd`, or given rows - the last is the present), then
    `spec.steps` steps. A second-order ring drawn at random starts from two rows drawn at random; given a single row, the
    row before it is taken to be the same. */
export function runEpisode(spec: CellsSpec, start: readonly (readonly number[])[] | readonly number[] | (() => number)): string[] {
  const draw = (r: () => number) => Array.from({ length: spec.width }, () => (r() < spec.density ? 1 : 0));
  const given: number[][] = typeof start === 'function' ? (spec.order === 2 ? [draw(start), draw(start)] : [draw(start)])
    : Array.isArray(start[0]) ? (start as readonly (readonly number[])[]).map((r) => [...r]) : [[...(start as readonly number[])]];
  const rows = given.map((r) => renderRow(spec, r));
  let prev = given.length > 1 ? given[given.length - 2] : given[0], row = given[given.length - 1];
  for (let t = 0; t < spec.steps; t++) { const next = stepCells(spec, row, prev); prev = row; row = next; rows.push(renderRow(spec, row)); }
  return rows;
}

/** Place `index` of the family of `base` (index 0 is the base world): another ring length and mix, the same rule. */
export function placeOf(base: CellsSpec, index: number): CellsSpec {
  if (index === 0) return base;
  const rnd = mulberry32(base.seed * 92821 + base.level * 613 + index * 2654435761);
  const width = 9 + Math.floor(rnd() * 32);
  /* Two layers need a ring of even length. */
  return { ...base, width: base.layers ? width + (width % 2) : width, density: 0.2 + rnd() * 0.6 };
}

/* --- What the learner perceives at a point ------------------------------------------ */

/** A point of an episode: the rows seen up to it (the last is the present). */
export interface CellsPoint { readonly rows: readonly string[] }

export const CELLS_PERCEPT_DOC = 'At a point of an episode your code receives p = { rows }: `p.rows` is the list of rows seen so far in that episode, oldest first - the last one is the present row. Each row is a string of symbols, all rows of an episode of the same length.';

export const perceiveCells = (point: CellsPoint): { rows: string[] } => ({ rows: [...point.rows] });

/** The world a point belongs to, for the Observer: points come from episodes, nothing moves here. */
export function cellsPointWorld(): World<CellsPoint, never> {
  return {
    id: 'cells@1',
    actors: ['nature'],
    initial: () => { throw new Error('cells@1 has no initial state: points come from episodes'); },
    toMove: () => 'nature',
    actions: () => [],
    step: (s) => s,
    outcome: () => ({ over: false, winner: null, reason: null }),
    key: (s) => hashString(s.rows.join('\n')),
    view: () => ({ entities: [], scalars: {} }),
    describeRules: () => '',
    actionKey: () => ''
  };
}

/* --- Operator only ----------------------------------------------------------------------- */

/** The hidden rule, stated in the symbols the learner sees: for the operator's grading. Never shown to the learner. */
export function describeCellsTruth(spec: CellsSpec): { id: string; statement: string }[] {
  const [g0, g1] = spec.glyphs;
  const out = [{ id: 'ring', statement: 'The row wraps around: the first and the last cell are neighbours.' }];
  const elementary = (rule: number) => Array.from({ length: 8 }, (_, k) => [(k >> 2) & 1, (k >> 1) & 1, k & 1].map((v) => (v ? g1 : g0)).join('') + ' -> ' + (((rule >> k) & 1) ? g1 : g0)).join('; ');
  if (spec.layers) {
    out.push({ id: 'layers', statement: 'The cells at even positions form a ring of their own, and so do the cells at odd positions: a cell\'s neighbours are the nearest cells of the same parity (two positions away), and the two rings do not affect each other.' });
    out.push({ id: 'rule_even', statement: 'At even positions, the next symbol for each neighbourhood (left, itself, right, within that ring): ' + elementary(spec.layers[0]) + '.' });
    out.push({ id: 'rule_odd', statement: 'At odd positions, the next symbol for each neighbourhood (left, itself, right, within that ring): ' + elementary(spec.layers[1]) + '.' });
    return out;
  }
  if (spec.order === 2) {
    const table = [0, 1].flatMap((p) => [0, 1, 2, 3].map((n) => n + ' "' + g1 + '" now, "' + (p ? g1 : g0) + '" before -> ' + (((spec.rule >> (n + 4 * p)) & 1) ? g1 : g0)));
    out.push({ id: 'locality', statement: 'A cell\'s next symbol depends only on how many of the three cells centred on it (left, itself, right) show "' + g1 + '" in the present row, and on the cell\'s own symbol in the row before.' });
    out.push({ id: 'history', statement: 'The present row alone does not determine the next: the row before it matters (the process is of second order).' });
    out.push({ id: 'rule', statement: 'The next symbol for each count of "' + g1 + '" among those three cells and the cell\'s symbol in the row before: ' + table.join('; ') + '.' });
  } else if (spec.radius === 1) {
    const table = Array.from({ length: 8 }, (_, k) => [(k >> 2) & 1, (k >> 1) & 1, k & 1].map((v) => (v ? g1 : g0)).join('') + ' -> ' + (((spec.rule >> k) & 1) ? g1 : g0));
    out.push({ id: 'locality', statement: 'A cell\'s next symbol depends only on its own symbol and its two neighbours\' (left, itself, right) in the present row.' });
    out.push({ id: 'rule', statement: 'The next symbol for each neighbourhood (left, itself, right): ' + table.join('; ') + '.' });
  } else {
    const table = Array.from({ length: 6 }, (_, n) => n + ' -> ' + (((spec.rule >> n) & 1) ? g1 : g0));
    out.push({ id: 'locality', statement: 'A cell\'s next symbol depends only on how many of the five cells centred on it (two either side and itself) show "' + g1 + '" in the present row.' });
    out.push({ id: 'rule', statement: 'The next symbol for each count of "' + g1 + '" among those five cells: ' + table.join('; ') + '.' });
  }
  return out;
}
