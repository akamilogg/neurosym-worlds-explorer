/* ============================================================================
 * EXTERNAL EXPOSURE (SPEC-INVESTIGACION-EXTERNA §4.1.1): what reached an actor from outside, derived from its record -
 * never from what it cites. An actor is exposed DIRECTLY from its first read of an external source (an origin of the
 * operator's allowlist or the web: a search, a page acquired, a document of an allowed origin opened, listed or searched),
 * and INDIRECTLY from the first thing it receives or reads of an exposed actor (`via`). What it produces afterwards
 * carries its exposure, whether it cites or not.
 *
 * Read from a journal here; each channel that carries work between actors joins the exposure of what it carried to its
 * reader's (`via`): the runs given as experience (a branch's cut among them), branch results and contributions (in the
 * messages that deliver them), and what the team's board showed (`peer_read`, from what its authors had when publishing).
 * ========================================================================== */

type J = Record<string, any>;

export interface ExternalExposure {
  readonly direct: boolean;
  /** The actors (runs, branches, agents) or readings through which external material reached it. */
  readonly via: readonly string[];
  /** Where it began: the index of the first event that exposed it, and its type. */
  readonly since: { readonly event: number; readonly type: string } | null;
}

export const NO_EXPOSURE: ExternalExposure = { direct: false, via: [], since: null };

const READS = new Set(['list', 'open', 'find', 'search', 'links']);
const failed = (r: unknown): boolean => {
  const x = r as J | null;
  return !x || typeof x !== 'object' || typeof x.error === 'string' || ['not_allowed', 'unavailable', 'refused', 'budget_exhausted', 'provider_error', 'network_error', 'http_error', 'unsupported_media', 'too_many_redirects'].includes(String(x.state ?? ''));
};

/** The exposure a journal's record says its run had: its own reads, and what its events say reached it from others. */
export function exposureOf(journal: J | null | undefined): ExternalExposure {
  const events: J[] = Array.isArray(journal?.events) ? journal!.events : [];
  let direct: { event: number; type: string } | null = null;
  const via = new Set<string>();
  let first: { event: number; type: string } | null = null;
  const mark = (i: number, type: string) => { if (!first) first = { event: i, type }; };
  /* A read of the allowlist's (A6) counts where the run had sources at all: another world's requests named alike do not. */
  const hadSources = Boolean(journal?.config?.sources_allow || journal?.config?.external_research) || events.some((e) => e.type === 'sources_allowed');
  events.forEach((e, i) => {
    if (e.type === 'source_search' && e.state === 'answered') { direct ??= { event: i, type: e.type }; mark(i, e.type); }
    else if (e.type === 'source_acquired' && e.state === 'acquired') { direct ??= { event: i, type: e.type }; mark(i, e.type); }
    else if (hadSources && e.type === 'investigation' && Array.isArray(e.requests)) {
      e.requests.forEach((q: J, k: number) => {
        const key = q && typeof q === 'object' ? Object.keys(q).find((x) => READS.has(x)) : undefined;
        if (key && !failed(Array.isArray(e.results) ? e.results[k] : null)) { direct ??= { event: i, type: 'investigation:' + key }; mark(i, 'investigation:' + key); }
      });
    }
    /* What reached it from an exposed actor, as the channel that carried it recorded its exposure: an event's own, or each
       message an operator_message delivered. */
    const carriers: J[] = [e, ...(e.type === 'operator_message' && Array.isArray(e.messages) ? e.messages : []), ...(e.type === 'experience' && Array.isArray(e.runs) ? e.runs : [])];
    for (const c of carriers) {
      const carried = c.external_exposure as J | undefined;
      if (carried && (carried.direct || (Array.isArray(carried.via) && carried.via.length))) {
        via.add(String(c.from ?? c.by ?? c.run ?? c.branch ?? e.type));
        for (const v of carried.via ?? []) via.add(String(v));
        mark(i, e.type);
      }
    }
  });
  return { direct: direct !== null, via: [...via].sort(), since: first };
}

/** Whether an exposure is any at all. */
export const exposed = (x: ExternalExposure | null | undefined): boolean => !!x && (x.direct || x.via.length > 0);
