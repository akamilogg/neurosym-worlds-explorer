/* ============================================================================
 * THE VOCABULARY OF REQUESTS (SPEC-VALIDEZ-MEDIDA §6.1): every request a researcher can make, with its class - one table
 * for everyone who reads an investigation (the method audit, the senior's signs of being stuck, a follow-up of a directive).
 * Before it, three lists said three different things of the same request: a table was an experiment for the senior and
 * an observation for the audit; an own test, a living world's wait and a junior's edit were nothing for the audit.
 *
 *   experiment   asks the world for something that did not exist before (an episode, a version, a test run)
 *   observation  reads or computes over what the world already recorded
 *   recall       reads its own record or its sources
 *   exchange     speaks with others (its peers, its branches)
 *
 * A laboratory adds its own when it is declared (`Lab.requests`: its acts' kinds, its own requests); a request a
 * laboratory accepts and no table classes is an error found when the laboratories are loaded, never a recall by default.
 * ========================================================================== */

export type RequestClass = 'experiment' | 'observation' | 'recall' | 'exchange';

/** The requests every laboratory's researcher may make: the common parser's, and the assisted researcher's own instruments. */
export const COMMON_REQUESTS: Readonly<Record<string, RequestClass>> = {
  /* The world's instruments. */
  act: 'experiment', launch: 'experiment', try: 'experiment', replay: 'experiment', play: 'experiment', simulate: 'experiment',
  view: 'observation', inspect: 'observation', table: 'observation', measure: 'observation',
  /* The assisted researcher's: a test of its own runs an act; its own instrument reads what was recorded. */
  register_test: 'experiment', use: 'observation',
  memory: 'recall', experience: 'recall', list: 'recall', open: 'recall', find: 'recall',
  /* External sources (SPEC-INVESTIGACION-EXTERNA §5.3): they read sources, not the world. */
  search: 'recall', links: 'recall',
  peers: 'exchange', publish: 'exchange', delegate: 'exchange', delegation: 'exchange'
};

/** Keys of a request that qualify it (where from, which model, how much), never what it asks for. */
const AUXILIARY = new Set(['from', 'to', 'on', 'range', 'as', 'model', 'formula', 'of', 'items', 'item', 'words', 'select', 'whole', 'run', 'in', 'steps', 'place']);

/** What a request asks for: its first key that does not qualify it. The one way to read it. */
export function requestKey(q: unknown): string {
  return Object.keys((q && typeof q === 'object' ? q : {}) as object).find((k) => !AUXILIARY.has(k)) ?? '?';
}

/** A request's class by a laboratory's table (`table`: the common one with the laboratory's own). An act is classed by its
    kind where the table knows it (a junior's `edit`, `inspect_weights`), else as an act. Null: a request no table classes. */
export function classOf(q: unknown, table: Readonly<Record<string, RequestClass>> = COMMON_REQUESTS): RequestClass | null {
  const key = requestKey(q);
  if (key === 'act' || key === 'launch') {
    const act = (q as Record<string, unknown>)[key];
    const kind = act && typeof act === 'object' ? Object.keys(act as object).find((k) => Object.hasOwn(table, k) && !Object.hasOwn(COMMON_REQUESTS, k)) : undefined;
    if (kind) return table[kind];
  }
  return Object.hasOwn(table, key) ? table[key] : null;
}

/** The kind a request is named by in a record: its act's kind where its table knows it, else its key. */
export function requestKind(q: unknown, table: Readonly<Record<string, RequestClass>> = COMMON_REQUESTS): string {
  const key = requestKey(q);
  if (key === 'act' || key === 'launch') {
    const act = (q as Record<string, unknown>)[key];
    const kind = act && typeof act === 'object' ? Object.keys(act as object).find((k) => Object.hasOwn(table, k) && !Object.hasOwn(COMMON_REQUESTS, k)) : undefined;
    if (kind) return kind;
  }
  return key;
}
