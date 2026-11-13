import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BlobStore, editionHash, executionHash, normalizePackage, type JuniorPackage } from '../src/junior/package.ts';
import { selectionOverlap } from '../src/junior/distill.ts';
import type { CompetenceManifest } from '../src/junior/competence.ts';

/* SPEC-VALIDEZ-MEDIDA, VM4: one rule keeps the uses of data apart, and the lineage of what a junior learned travels with its
   package to the confirmation, which refuses what overlaps its reserved cases - without saying which. */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'junior-groups-'));
const H = 'a'.repeat(64);

function manifest(): CompetenceManifest {
  const probe = { id: 'p1', kind: 'probe' as const, partition: 'development' as const, group: 'g-probe', component: 'format', lab: 'cells', mode: 'start' as const,
    cut: { run: 'runs/a.json', question: 1, hash: H }, competence: 'c', instruction: 'Do it.', checker: { id: 'protocol', version: 1 } };
  const inv = (id: string, group: string, partition: 'development' | 'confirmation', seed: string) => ({ id, kind: 'investigation' as const, lab: 'cells', args: ['--seed', seed, '--level', '1'], partition, group, components: ['cells-L1'] });
  return {
    format: 'junior-competence-manifest@1', id: 'vm4', reference: H,
    components: [
      { id: 'format', rung: 1, mode: 'start', extractor: { id: 'probe', version: 1 }, unit: 'share', direction: 'up', target: 1, bad: 0, tolerance: 0 },
      { id: 'cells-L1', rung: 6, lab: 'cells', level: 'L1', extractor: { id: 'model_accepted', version: 1 }, unit: 'solved', direction: 'up', target: 1, bad: 0, tolerance: 0 }],
    cases: [probe, inv('i1', 'g-inv', 'development', '3'), inv('c1', 'g-conf', 'confirmation', '9')],
    investigation_repetitions: 1, execution: {}, sampling: { seed: 1 },
    promotion: { procedure: 'paired-cases@1', alpha: 0.05, permutations: 1000, seed: 1 },
    limits: { junior_args: ['--max-tokens', '100', '--max-judge-calls', '10'], probe_max_tokens: 100, timeout_ms: 1000 },
    weight_lab: { diagnosis: { 'g-diag': ['runs/d.json'] }, limits: { queries: 1, tokens: 1, seconds: 1, memory_mb: 1, response_bytes: 1 } } as never
  };
}

test('VM4: one function says each group\'s uses; a dataset sharing a group with any case of selection or confirmation is refused for training', async () => {
  const { usesOf } = await import('../src/junior/groups.ts');
  const uses = usesOf(manifest());
  assert.deepEqual(Object.fromEntries([...uses].map(([g, u]) => [g, [...u].sort()])),
    { 'g-probe': ['selection_probe'], 'g-inv': ['selection_investigation'], 'g-conf': ['confirmation'], 'g-diag': ['diagnosis'] });
  assert.deepEqual(selectionOverlap({ groups: ['g-probe', 'g-diag', 'g-free'] }, manifest()), ['g-probe']);
  assert.deepEqual(selectionOverlap({ groups: ['g-inv'] }, manifest()), ['g-inv'], 'a case of investigation selects too');
  assert.deepEqual(selectionOverlap({ groups: ['g-conf'] }, manifest()), ['g-conf'], 'and confirmation is never trained on');
});

test('VM4: a realization is the world and its arguments, the same read from a case and from the record of a run', async () => {
  const { realizationOf, realizationOfRun } = await import('../src/junior/groups.ts');
  const dir = tmp();
  const run = path.join(dir, 'r.json');
  fs.writeFileSync(run, JSON.stringify({ experiment: 'cells@1', argv: ['--researcher', 'assisted', '--level', '1', '--seed', '9', '--attempts', '3'], events: [] }));
  assert.equal(realizationOfRun(run), realizationOf('cells', ['--seed', '9', '--level', '1']), 'what the researcher was given aside: the same world');
  assert.notEqual(realizationOf('cells', ['--seed', '9', '--level', '1']), realizationOf('cells', ['--seed', '10', '--level', '1']));
  assert.notEqual(realizationOf('cells', ['--seed', '9']), realizationOf('orbit', ['--seed', '9']));
});

function pkg(store: BlobStore, over: Partial<JuniorPackage> = {}): JuniorPackage {
  const base = tmp();
  fs.writeFileSync(path.join(base, 'w'), 'w');
  const b = (s: string) => store.put(s);
  return normalizePackage({ format: 'junior-package@1', name: 'p', base: store.putTree(base), prompt: 'Be brief.',
    execution: { firmware: b('f'), tokenizer: b('t'), chat_template: b('c'), driver: b('d'), verifier: b('v'), circuit: {}, precision: 'bf16' }, ...over });
}

test('VM4: the realizations a package learned from travel in its provenance, never in what it serves', () => {
  const store = new BlobStore(path.join(tmp(), 'blobs'));
  const plain = pkg(store);
  const declared = normalizePackage({ ...plain, provenance: { ...plain.provenance, realizations: ['b'.repeat(64)] } });
  assert.deepEqual(declared.provenance.realizations, ['b'.repeat(64)]);
  assert.equal(executionHash(declared), executionHash(plain));
  assert.equal(plain.provenance.realizations, undefined, 'a package that declares none keeps no field');
  assert.equal(editionHash(normalizePackage(JSON.parse(JSON.stringify(plain)))), editionHash(plain), 'its edition as it was');
});

test('VM4: the confirmation refuses a trained package that declares no realizations, and one that overlaps its reserved cases - without saying which', async () => {
  const { ConfirmationService } = await import('../src/junior/confirm.ts');
  const { realizationOf } = await import('../src/junior/groups.ts');
  const store = new BlobStore(path.join(tmp(), 'blobs'));
  const m = { ...manifest(), cases: manifest().cases.filter((c) => c.kind === 'investigation'), components: [manifest().components[1]], weight_lab: undefined };
  const svc = new ConfirmationService({ root: tmp(), manifest: m as CompetenceManifest, client: {} as never, launcher: {} as never });
  const untouched = pkg(store);
  assert.equal(svc.refusalOf(untouched), null, 'nothing learned: nothing to declare');
  const trained = normalizePackage({ ...untouched, adapter: store.put('adapter'), provenance: { parents: [], reason: 'trained', sources: ['dataset:x', 'training:y'] } });
  assert.match(String(svc.refusalOf(trained)), /declares no realizations/);
  const clean = normalizePackage({ ...trained, provenance: { ...trained.provenance, realizations: [realizationOf('cells', ['--seed', '3', '--level', '1'])] } });
  assert.equal(svc.refusalOf(clean), null, 'learned from a case of development: its own business');
  const leaked = normalizePackage({ ...trained, provenance: { ...trained.provenance, realizations: [realizationOf('cells', ['--level', '1', '--seed', '9'])] } });
  const why = String(svc.refusalOf(leaked));
  assert.match(why, /overlap/);
  assert.doesNotMatch(why, /c1|seed|9|g-conf/, 'the reserved cases never leave the service');
  const edited = normalizePackage({ ...untouched, adapter: store.put('set'), provenance: { parents: [], reason: 'edited', sources: ['edit-set:z'], realizations: [] } });
  assert.equal(svc.refusalOf(edited), null, 'an edit written by hand declares none, and says so');
});

test('VM4: a case of the training partition is run only to be learned from - it selects nothing, and a dataset from it may be trained on', async () => {
  const { usesOf } = await import('../src/junior/groups.ts');
  const { competenceProblems, needs } = await import('../src/junior/competence.ts');
  const base = manifest();
  const m = { ...base, weight_lab: undefined, cases: [...base.cases, { id: 't1', kind: 'investigation' as const, lab: 'cells', args: ['--seed', '5', '--level', '1'], partition: 'training' as const, group: 'g-train', components: ['cells-L1'] }] } as CompetenceManifest;
  assert.deepEqual(competenceProblems(m), []);
  assert.deepEqual([...usesOf(m).get('g-train')!], ['training']);
  assert.deepEqual(selectionOverlap({ groups: ['g-train'] }, m), [], 'what it learns from a training case selects nothing');
  assert.ok(![...needs(m, 'development', 0).values()].some((cases) => cases.has('t1')), 'never measured');
  const shared = { ...m, cases: [...m.cases, { ...(m.cases.at(-1) as object), id: 't2', group: 'g-inv' } as never] };
  assert.match(competenceProblems(shared).join(), /group g-inv is in both partitions/, 'a training case never shares a group with one that selects');
});

test('VM4 review: the same world under another label is the same world - by realization, in every manifest', async () => {
  const { realizationOf } = await import('../src/junior/groups.ts');
  const { manifestProblems } = await import('../src/meta/lab.ts');
  const { competenceProblems } = await import('../src/junior/competence.ts');
  /* As the runner reads its arguments: the first one given wins. */
  assert.equal(realizationOf('cells', ['--seed', '4', '--seed', '9']), realizationOf('cells', ['--seed', '4']));
  /* A meta-laboratory: --seed 1 in development, --seed 1 --level 1 (its default) in confirmation. */
  const meta = { format: 'meta-lab@1', id: 'm', junior: { args: ['--max-tokens', '10', '--max-judge-calls', '5'] }, cases: [
    { id: 'd', lab: 'cells', args: ['--seed', '1'], partition: 'development', criterion: 'model_accepted' },
    { id: 'c', lab: 'cells', args: ['--seed', '1', '--level', '1'], partition: 'confirmation', criterion: 'model_accepted' }] };
  assert.ok(manifestProblems(meta).some((p) => /"d" and "c"/.test(p) && /same world/.test(p)), manifestProblems(meta).join('; '));
  /* A competence manifest: a training case of the realization of a confirmation case, under another group. */
  const base = manifest();
  const leak = { ...base, weight_lab: undefined, cases: [...base.cases, { id: 't1', kind: 'investigation' as const, lab: 'cells', args: ['--level', '1', '--seed', '9'], partition: 'training' as const, group: 'g-other', components: ['cells-L1'] }] } as CompetenceManifest;
  assert.ok(competenceProblems(leak).some((p) => /t1/.test(p) && /c1/.test(p) && /same world/.test(p)), competenceProblems(leak).join('; '));
  const dev = { ...leak, cases: [...base.cases, { id: 't1', kind: 'investigation' as const, lab: 'cells', args: ['--seed', '3', '--level', '1'], partition: 'training' as const, group: 'g-other', components: ['cells-L1'] }] } as CompetenceManifest;
  assert.ok(competenceProblems(dev).some((p) => /t1/.test(p) && /i1/.test(p)), 'nor of a development one');
});

test('VM4 review 2: a world is what its generator reads - a budget of the researcher (acts) never makes another world', async () => {
  const { realizationOf } = await import('../src/junior/groups.ts');
  const { competenceProblems } = await import('../src/junior/competence.ts');
  assert.equal(realizationOf('cells', ['--seed', '9', '--level', '1', '--acts', '4']), realizationOf('cells', ['--seed', '9', '--level', '1', '--acts', '5']));
  assert.notEqual(realizationOf('cells', ['--seed', '9', '--level', '1']), realizationOf('cells', ['--seed', '9', '--level', '2']));
  /* Normalized as the generator reads it: particles3d's condition in any case, its level clamped. */
  assert.equal(realizationOf('particles3d', ['--seed', '2', '--condition', 'b']), realizationOf('particles3d', ['--seed', '2', '--condition', 'B']));
  const base = manifest();
  const leak = { ...base, weight_lab: undefined, cases: [...base.cases, { id: 't1', kind: 'investigation' as const, lab: 'cells', args: ['--seed', '9', '--level', '1', '--acts', '5'], partition: 'training' as const, group: 'g-other', components: ['cells-L1'] }] } as CompetenceManifest;
  assert.ok(competenceProblems(leak).some((p) => /t1/.test(p) && /c1/.test(p)), competenceProblems(leak).join('; '));
});

/* --- An external review of 0bec9b3 (13/11/2026) -------------------------------------------------------------------------- */

test('review 0bec9b3: a realization names its identity - one under another, or a bare hash of before, is an unknown origin the confirmation refuses; made again from its recorded runs it is compared', async () => {
  const { ConfirmationService } = await import('../src/junior/confirm.ts');
  const { realizationOf, currentRealizations, isCurrentRealization, REALIZATION } = await import('../src/junior/groups.ts');
  const { createHash } = await import('node:crypto');
  const { stableStringify } = await import('../src/core/hash.ts');
  const store = new BlobStore(path.join(tmp(), 'blobs'));
  const m = { ...manifest(), cases: manifest().cases.filter((c) => c.kind === 'investigation'), components: [manifest().components[1]], weight_lab: undefined };
  const svc = new ConfirmationService({ root: tmp(), manifest: m as CompetenceManifest, client: {} as never, launcher: {} as never });
  const reserved = ['--level', '1', '--seed', '9'];
  const now = realizationOf('cells', reserved);
  assert.ok(isCurrentRealization(now) && now.startsWith(REALIZATION + ':'));
  /* The reserved world as realization@1 hashed it (the experiment and every option, budgets included): a bare hash. */
  const before = createHash('sha256').update(stableStringify(['realization@1', 'cells@1', { seed: 9, level: '1' }])).digest('hex');
  const trained = normalizePackage({ ...pkg(store), adapter: store.put('adapter'), provenance: { parents: [], reason: 'trained', sources: ['dataset:x', 'training:y'] } });
  const declare = (r: string[]) => normalizePackage({ ...trained, provenance: { ...trained.provenance, realizations: r } });
  assert.match(String(svc.refusalOf(declare([now]))), /overlap/, 'the new hash: refused');
  const old = String(svc.refusalOf(declare([before])));
  assert.match(old, /not under realization@2/, 'the old hash of the same world: refused too, never admitted');
  assert.doesNotMatch(old, /seed|9|c1/);
  assert.match(String(svc.refusalOf(declare([now.replace(REALIZATION, 'realization@3')]))), /not under realization@2/, 'another identity: not compared');
  /* Recorded under another identity, made again from the capture recorded with it; unknown where none was. */
  const capture = { experiment: 'cells@1', argv: reserved, run_id: 'r9' };
  assert.deepEqual(currentRealizations([before], [capture]), [now]);
  assert.equal(currentRealizations([before]), undefined, 'nothing to make it again from: unknown');
  assert.deepEqual(currentRealizations([now]), [now]);
});

test('review 2 of 0bec9b3: a realization is made again from the capture of its run taken when it was cut, never from the path read again - a file reused by another run is not the run it was', async () => {
  const { currentRealizations, datasetCaptures, datasetRealizations, realizationOf } = await import('../src/junior/groups.ts');
  const { ConfirmationService } = await import('../src/junior/confirm.ts');
  const dir = tmp();
  const run = path.join(dir, 'run.json');
  /* An example cut from a run of seed 9, its capture taken then; the file later reused by a run of seed 3. */
  const capture = { experiment: 'cells@1', argv: ['--seed', '9', '--level', '1'], run_id: 'nine' };
  fs.mkdirSync(path.join(dir, 'examples'));
  fs.writeFileSync(path.join(dir, 'examples', 'e1.json'), JSON.stringify({ id: 'e1', cut: { run, question: 0, hash: 'h', capture } }));
  fs.writeFileSync(run, JSON.stringify({ experiment: 'cells@1', argv: ['--seed', '3', '--level', '1'], run_id: 'three', events: [] }));
  const nine = realizationOf('cells', ['--seed', '9', '--level', '1']);
  assert.deepEqual(datasetRealizations(path.join(dir, 'examples'), { examples: ['e1'] }), [nine], 'the run it was cut from, not the file as it is now');
  const legacy = 'a'.repeat(64);
  assert.deepEqual(currentRealizations([legacy], datasetCaptures(path.join(dir, 'examples'), { examples: ['e1'] })!), [nine]);
  /* An example of before captures were kept: its origin unknown, never read from the reused path. */
  fs.writeFileSync(path.join(dir, 'examples', 'e2.json'), JSON.stringify({ id: 'e2', cut: { run, question: 0, hash: 'h' } }));
  assert.equal(datasetRealizations(path.join(dir, 'examples'), { examples: ['e1', 'e2'] }), null);
  /* So the confirmation on seed 9 refuses what learned from it. */
  const store = new BlobStore(path.join(tmp(), 'blobs'));
  const m = { ...manifest(), cases: manifest().cases.filter((c) => c.kind === 'investigation'), components: [manifest().components[1]], weight_lab: undefined };
  const svc = new ConfirmationService({ root: tmp(), manifest: m as CompetenceManifest, client: {} as never, launcher: {} as never });
  const trained = normalizePackage({ ...pkg(store), adapter: store.put('adapter'), provenance: { parents: [], reason: 'trained', sources: ['dataset:x'], realizations: currentRealizations([legacy], [capture])! } });
  assert.match(String(svc.refusalOf(trained)), /overlap/);
});
