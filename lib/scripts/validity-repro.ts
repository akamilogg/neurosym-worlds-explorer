/* Reproduces, on the code as it is, the findings of REPASO-2026-11-10.md §4.3 marked as checked (V1, V2, V3, V9, V10, V11, V13).
   Run from lib/: node --experimental-strip-types --no-warnings scripts/validity-repro.ts
   SPEC-VALIDEZ-MEDIDA §12.15: each becomes a test of the suite, failing before its fix and passing after. */
const root = new URL('../src/', import.meta.url).href;
const { measureOf } = await import(root + 'meta/lab.ts');
const { pairedComparison } = await import(root + 'runtime/statistics.ts');
const { signFlipP, promote } = await import(root + 'junior/competence.ts');
const { linksOf } = await import(root + 'audit/links.ts');
const { stuckSignals } = await import(root + 'orchestra/reader.ts');

// M1: one solved trial that ended, nine infra, against ten ended of which five solved.
const t = (state: string, solved: boolean | null) => ({ kind: 'grid', result: { state, solved, stopped_by: null, policy_errors: 0, advice: 0, tokens: 0 } });
const survivor = measureOf([t('ended', true), ...Array.from({ length: 9 }, () => t('infra', null))] as never, 10);
const honest = measureOf([...Array.from({ length: 5 }, () => t('ended', true)), ...Array.from({ length: 5 }, () => t('ended', false))] as never, 10);
console.log('M1 survivor:', JSON.stringify({ complete: survivor.complete, correct: survivor.correct, quality: survivor.quality }));
console.log('M1 honest  :', JSON.stringify({ complete: honest.complete, correct: honest.correct, quality: honest.quality }));

// O4: eight seeds, the new condition solves all, the old none.
const before = new Map(Array.from({ length: 8 }, (_, i) => ['s' + i, 0] as [string, number]));
const now = new Map(Array.from({ length: 8 }, (_, i) => ['s' + i, 1] as [string, number]));
const pc = pairedComparison(before, now, { margin: 0.2, binary: true });
console.log('O4 8/8 vs 0/8:', pc.conclusion, 'effect', pc.effect);

// J2: the least p of the sign-flip test by number of cases, all of them better.
for (const n of [1, 3, 5, 6, 7, 8]) console.log('J2 n=' + n, 'p=', signFlipP(Array.from({ length: n }, () => 1), 10000, 1));

// J1: a component improves, another, not protected, goes from perfect to the worst.
const comp = (id: string, extra: Record<string, unknown> = {}) => ({ id, rung: 1, mode: 'start', extractor: { id: 'x', version: 1 }, unit: 'share', direction: 'up', target: 1, bad: 0, tolerance: 0, ...extra });
const m = { components: [comp('format'), comp('worlds')], promotion: { procedure: 'paired-cases@1', alpha: 0.05, permutations: 10000, seed: 1 } };
const meas = (a: number, b: number) => ({ complete: true, vector: [], components: [
  { id: 'format', quality: a, complete: true, missing: [], cases: Object.fromEntries(Array.from({ length: 8 }, (_, i) => ['f' + i, { deficit: a, value: 1 - a, reps: 1 }])) },
  { id: 'worlds', quality: b, complete: true, missing: [], cases: Object.fromEntries(Array.from({ length: 8 }, (_, i) => ['w' + i, { deficit: b, value: 1 - b, reps: 1 }])) }] });
const pr = promote(m as never, meas(1, 0) as never, meas(0, 1) as never);
console.log('J1:', pr.verdict, '-', pr.why, JSON.stringify(pr.components.map((c: any) => ({ id: c.id, delta: c.mean_delta, improves: c.improves, regresses: c.regresses }))));

// A1, A2: an own test, a wait of a living world, and a round closed without a model.
const journal = { events: [
  { type: 'investigation', round: 1, requests: [{ test: { protocol: {} } }], results: [{ registered: 't1' }] },
  { type: 'investigation', round: 1, requests: [{ wait: 3 }], results: [{ name: 'ep1', accepted: true }] },
  { type: 'investigation', round: 1, requests: [{ table: 'ep1' }], results: [{ rows: [] }] },
  { type: 'round_closed', round: 1, why: 'nothing new' },
  { type: 'investigation', round: 2, requests: [{ act: { x: 1 } }], results: [{ name: 'ep2', accepted: true }] },
  { type: 'proposal', round: 2, rationale: 'see ep2', beliefs: [] }
] };
const rec = linksOf(journal);
console.log('A1 kinds:', rec.links.map((l: any) => l.id + ':' + l.instruments[0] + '=' + l.kind).join('  '));
console.log('A2 segments:', rec.rounds.map((s: any) => s.id + '[' + s.links.join(',') + ']').join('  '));
// O1: the same answer read by the senior's signs: a round of a table only.
const j2 = { events: [{ type: 'investigation', round: 2, requests: [{ table: 'ep1' }], results: [{}] }, { type: 'investigation', round: 2, requests: [{ table: 'ep1', on: 'x' }], results: [{}] }, { type: 'investigation', round: 2, requests: [{ measure: {} }], results: [{}] }] };
console.log('O1 only_looking (reader says a table is an experiment):', stuckSignals(j2).only_looking, '| audit kind:', linksOf(j2).links.map((l: any) => l.kind).join(','));
