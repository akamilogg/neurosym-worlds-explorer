import type { SearchEvent, SearchManifest } from './engine.ts';

/* ============================================================================
 * An evolutionary search read as experience (SPEC-DELEGACION-EVOLUTIVA §9): its candidates, attempts and the policy's
 * decisions as items to list, open and find - the same requests as any experience, through an adapter of its own, never
 * pretending its record is an assisted researcher's journal. What a mutator declared stays a declaration.
 * ========================================================================== */

interface Item { readonly id: string; readonly kind: string; readonly head: string; readonly body: unknown }

/** What `Experience` asks of a record it reads: how many items of each kind, and a request (list, open, find) answered. */
export interface ExperienceReader {
  counts(): Record<string, number>;
  run(q: Record<string, unknown>): Promise<unknown>;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export function searchReader(manifest: SearchManifest, events: readonly SearchEvent[] = []): ExperienceReader {
  const s = manifest.state;
  const why = new Map<string, string>();
  for (const e of events) if (e.type === 'candidate' && e.result === 'new' && e.hash && e.why) why.set(e.hash, e.why);
  const role = (h: string) => [s.elites.includes(h) ? 'elite' : '', s.development.some((d) => d.hash === h) ? 'in development' : '', s.pending.includes(h) ? 'waiting for development' : '',
    s.repairs.some((r) => r.work === h) ? 'under repair' : '', Object.entries(s.cells).filter(([, c]) => c.occupants.includes(h)).map(([k]) => 'cell ' + k).join(' ')].filter(Boolean);
  const items: Item[] = [
    ...s.order.map((h) => {
      const c = s.candidates[h];
      return { id: 'candidate:' + h, kind: 'candidates', head: (c.evaluation?.correct ?? 'unchecked') + ', quality ' + JSON.stringify(c.evaluation?.quality ?? null) + (role(h).length ? ', ' + role(h).join(', ') : '') + ', from ' + c.origin,
        body: { program: h, files: c.files, parents: c.parents, lineage_roots: c.roots, origin: c.origin, ...(why.has(h) ? { declared_why: why.get(h) } : {}),
          evaluation: c.evaluation, stale: c.stale, roles: role(h), diagnostics: c.diagnostics } };
    }),
    ...events.filter((e) => e.type === 'attempt_planned').map((e) => {
      const made = events.find((x) => x.type === 'candidate' && x.attempt === e.attempt);
      return { id: e.attempt as string, kind: 'attempts', head: e.plan.turn + ', ' + e.plan.operator + (e.plan.parents.length ? ' from ' + e.plan.parents.join(' + ') : '') + (e.plan.recovery ? ' (' + e.plan.recovery + ' recovery)' : '') + ': ' + (made ? made.result + (made.hash ? ' ' + made.hash : '') : 'no program'),
        body: { plan: e.plan, result: made ? { result: made.result, ...(made.hash ? { program: made.hash } : {}), ...(made.why ? { why: made.why } : {}) } : null } };
    }),
    ...s.log.map((d, i) => ({ id: 'decision:' + (i + 1), kind: 'decisions', head: clip(JSON.stringify(d), 140), body: d }))
  ];
  const kinds = ['candidates', 'attempts', 'decisions'];
  const counts = () => Object.fromEntries(kinds.map((k) => [k, items.filter((i) => i.kind === k).length]));
  return {
    counts,
    async run(q) {
      const what = String(q.memory);
      const of = typeof q.of === 'string' ? q.of : null;
      if (of !== null && !kinds.includes(of)) return { memory: what, error: '"of" is one of ' + kinds.join(', ') };
      const pool = items.filter((i) => of === null || i.kind === of);
      if (what === 'list') {
        if (of === null) return { memory: 'list', items: counts(), note: 'add "of": <kind> for the index of a kind' };
        const shown = pool.slice(-60);
        return { memory: 'list', of, total: pool.length, index: shown.map((i) => ({ id: i.id, first_words: i.head })), ...(pool.length > shown.length ? { note: 'the latest ' + shown.length + ' of ' + pool.length + '; find reaches every one' } : {}) };
      }
      if (what === 'open') {
        const ids = (Array.isArray(q.items) ? q.items : typeof q.item === 'string' ? [q.item] : []).map(String).slice(0, 8);
        if (!ids.length) return { memory: 'open', error: '"items": the ids to open' };
        return { memory: 'open', items: ids.map((id) => { const it = items.find((i) => i.id === id); return it ? { id, item: it.body } : { id, error: 'no such item' }; }) };
      }
      if (what === 'find') {
        const words = typeof q.words === 'string' ? q.words : '';
        const terms = fold(words).split(/\s+/).filter(Boolean);
        if (!terms.length) return { memory: 'find', error: '"words": what to find' };
        const found = pool.filter((i) => { const t = fold(JSON.stringify(i.body)); return terms.every((x) => t.includes(x)); });
        return { memory: 'find', words, found: found.slice(0, 20).map((i) => ({ id: i.id, first_words: i.head })), total: found.length };
      }
      return { memory: what, error: '"list", "open" or "find"' };
    }
  };
}
