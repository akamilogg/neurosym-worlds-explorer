/** A configuration the runner cannot run: bad arguments, a journal that cannot be resumed, a missing endpoint. Apart from
    the runner, so its parts (law-run.ts) raise it without importing it. */
export class LabError extends Error {
  readonly code: number;
  constructor(message: string, code = 2) { super(message); this.name = 'LabError'; this.code = code; }
}
