import type { AnyLab } from '../learn/lab.ts';
import { cellsLab } from './cells/lab.ts';
import { messagesLab } from './messages/lab.ts';
import { orbitLab } from './orbit/lab.ts';
import { gridLab } from './grid/lab.ts';
import { tankLab } from './tank/lab.ts';

/** The worlds declared as laboratories (SPEC-OBJETIVO O9), by the name `run-lab.ts --lab` takes. The grid has a loop of
    its own (its model is a formula a search plays with) and runs with the services every laboratory shares. */
export const LABS: Readonly<Record<string, AnyLab>> = { cells: cellsLab, messages: messagesLab, orbit: orbitLab, grid: gridLab, tank: tankLab };
