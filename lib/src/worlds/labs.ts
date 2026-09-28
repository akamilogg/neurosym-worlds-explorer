import type { AnyLab } from '../learn/lab.ts';
import { cellsLab } from './cells/lab.ts';
import { messagesLab } from './messages/lab.ts';

/** The worlds declared as laboratories (SPEC-OBJETIVO O9), by the name `run-lab.ts --lab` takes. orbit and the grid
    still have their own runners. */
export const LABS: Readonly<Record<string, AnyLab>> = { cells: cellsLab, messages: messagesLab };
