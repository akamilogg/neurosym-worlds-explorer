import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { artifactsLab, type ArtifactSpec } from '../src/worlds/artifacts/lab.ts';
import { ArtifactWorld } from '../src/artifacts/world.ts';
import { ArtifactStore } from '../src/artifacts/store.ts';
import { processSandbox } from '../src/artifacts/sandbox.ts';
import { dedupTask } from '../src/artifacts/tasks/dedup.ts';
import { threesumTask } from '../src/artifacts/tasks/threesum.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';
import type { LawLab } from '../src/learn/lab.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';

/* An external review of the artifacts' world (16/10/2026): four guarantees of the harness, each as it reproduced its fault. */

const here = path.dirname(fileURLToPath(import.meta.url));

test('provenance: the same content reached from another branch keeps the origin of that change - content once, every transition', () => {
  const store = new ArtifactStore(new Map([['main.py', 'print(1)\n']]));
  const a = store.apply(store.base, { files: { 'main.py': 'print(2)\n' } }) as { hash: string };
  const b = store.apply(store.base, { files: { 'main.py': 'print(3)\n' } }) as { hash: string };
  const again = store.apply(b.hash, { files: { 'main.py': 'print(2)\n' } }) as { hash: string };
  assert.equal(again.hash, a.hash, 'the same content is the same version');
  assert.deepEqual(store.transitions.map((t) => [t.from, t.to]), [[store.base, a.hash], [store.base, b.hash], [b.hash, a.hash]], 'every way it was reached');
  const world = new ArtifactWorld(threesumTask({ scale: 0.1 }), processSandbox());
  const x = world.change(world.reference, { files: { 'NOTE.md': 'x' } }) as { version: string; parent: string };
  const y = world.change(world.reference, { files: { 'NOTE.md': 'y' } }) as { version: string; parent: string };
  const back = world.change(y.version, { files: { 'NOTE.md': 'x' } }) as { version: string; parent: string };
  assert.equal(back.version, x.version);
  assert.equal(back.parent, y.version, 'its parent is where THIS change came from');
});

test('a check keeps its evidence: every run of reference and candidate, interleaved, with what it measured - hidden from the researcher', async () => {
  const world = new ArtifactWorld(threesumTask({ scale: 0.1 }), processSandbox());
  const [r] = await world.check(world.reference, ['mixed'], 2, 1);
  assert.equal(r.evidence.length, 2, 'per workload');
  const reps = world.task.objective.repetitions;
  for (const e of r.evidence) {
    assert.equal(e.reference.length, reps);
    assert.equal(e.candidate.length, reps);
    assert.ok(e.candidate.every((c) => typeof c.metrics?.wall_ms === 'number' && c.output && 'text' in c.output), 'its measures and its (short) output');
    assert.deepEqual(e.reference.map((c) => c.first), e.candidate.map((c) => !c.first), 'who went first, alternating');
  }
  /* What is too long to hold inline is kept whole, by its content, where the run keeps it. */
  const kept = new Map<string, string>();
  const source = 'import sys\nsys.stderr.write("x" * 3000)\n' + world.store.get(world.reference)!.files.get('main.py');
  const noisy = world.change(world.reference, { files: { 'main.py': source } }) as { version: string };
  const [loud] = await world.check(noisy.version, ['mixed'], 1, 2, undefined, (text) => { const sha = 'h' + kept.size; kept.set(sha, text); return sha; });
  const whole = loud.evidence[0].candidate[0].stderr_whole!;
  assert.equal(whole.kept, true);
  assert.equal(kept.get(whole.sha256)!.length, whole.chars, 'the whole stderr, read again');
});

test('a resumed run is rebuilt from the base its journal archived, whatever its directory holds now', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-base-'));
  const base = path.join(dir, 'base');
  fs.cpSync(path.join(here, '..', 'examples', 'artifacts', 'threesum', 'base'), base, { recursive: true });
  /* The artifacts' world, on a base of its own (a copy of 3SUM's). */
  const lab = { ...artifactsLab, generate: (seed: number, o: Record<string, string>, archived?: unknown) => {
    const spec = artifactsLab.generate(seed, o, archived) as ArtifactSpec;
    return archived ? spec : { ...spec, world: new ArtifactWorld({ ...threesumTask({ scale: 0.1 }), base }, processSandbox()) };
  } } as unknown as LawLab;
  const answers: FetchLike = async (_url, init) => {
    const b = JSON.parse(String(init.body));
    const sys = b.messages[0].content as string;
    const user = sys.startsWith('You grade') ? {} : JSON.parse(userOf(b));
    const done = (user.investigation ?? []).length;
    const content = sys.startsWith('You grade') ? { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' }
      : user.round === 1 && done === 0 ? { investigate: [{ act: { run: { version: (user.notebook?.episodes ?? []).find((e: any) => e.version)?.version, workloads: 1 } } }] }
      : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => 100', validate: false, beliefs: [], lessons: ['l'], next_experiment: 'n' };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
  const args = ['--artifact', 'threesum', '--scale', '0.1', '--seed', '1', '--researcher', 'assisted', '--attempts', '3', '--flat', '--no-grade', '--no-reflection', '--no-ablation'];
  const cut = await runLaboratory(lab, { args: [...args, '--max-tokens', '150', '--out', path.join(dir, 'cut.json')], root: dir, llm: { url: 'http://x.test/c', model: 's' }, fetch: answers });
  assert.equal(cut.stoppedBy, 'token_budget');
  const archived = JSON.parse(fs.readFileSync(cut.journal, 'utf8')).world_archive;
  assert.ok(archived?.files?.['main.py'], 'the base, whole, in the journal');
  /* Its directory changes after the run. */
  fs.writeFileSync(path.join(base, 'main.py'), '# changed since\n' + fs.readFileSync(path.join(base, 'main.py'), 'utf8'));
  const resumed = await runLaboratory(lab, { args: ['--resume', cut.journal, '--out', path.join(dir, 'resumed.json')], root: dir, llm: { url: 'http://x.test/c', model: 's' }, fetch: answers });
  assert.notEqual(resumed.stoppedBy, 'diverged', 'rebuilt from its archive');
  assert.equal(JSON.parse(fs.readFileSync(resumed.journal, 'utf8')).world_archive.base, archived.base);
  /* And with its directory gone. */
  fs.rmSync(base, { recursive: true, force: true });
  const again = await runLaboratory(lab, { args: ['--resume', cut.journal, '--out', path.join(dir, 'again.json')], root: dir, llm: { url: 'http://x.test/c', model: 's' }, fetch: answers });
  assert.notEqual(again.stoppedBy, 'diverged', 'its directory gone: rebuilt from its archive alone');
});

test('a place the artifact\'s validation opened is open to experiment in: the two protocols keep their verdicts, experimenting is shared', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-shared-'));
  /* A world with an artifact: it holds in the laboratory and not in the family, so a validation opens a family place. Its act
     draws an episode in the place it names. */
  const lab = { ...(cellsLab as LawLab), act: { ...(cellsLab as LawLab).act!,
      parse: (raw: Record<string, unknown>) => ({ place: String(raw.place ?? '') }) as never,
      place: (a: { place: string }) => a.place || undefined,
      start: async (spec: unknown) => (cellsLab as LawLab).episode(spec as never, () => 0.5),
      asWritten: (a: unknown) => a, varies: () => null, examples: () => [] },
    artifact: { known: () => true,
      check: async (_spec: unknown, _version: string, c: { purpose: string }) => ({ holds: c.purpose === 'check', view: { correct: true }, journal: {} }) } } as unknown as LawLab;
  const told: Record<string, any>[] = [];
  const answers: FetchLike = async (_url, init) => {
    const b = JSON.parse(String(init.body));
    const sys = b.messages[0].content as string;
    const user = sys.startsWith('You grade') ? {} : JSON.parse(userOf(b));
    if (!sys.startsWith('You grade')) told.push(user);
    const opened = told.flatMap((u) => u.last_check?.artifact?.validation?.now_your_laboratories ?? []);
    const done = (user.investigation ?? []).length;
    const content = sys.startsWith('You grade') ? { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' }
      : user.round === 2 && done === 0 && opened.length ? { investigate: [{ act: { place: opened[0] } },
        { register_test: { protocol: { place: opened[0] }, model: 1, rival: { observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[0]' }, claim: 'it repeats there too', kind: 'new' } }] }
      : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]', validate: false, beliefs: [], lessons: ['l'], next_experiment: 'n',
        ...(user.round === 1 ? { artifact: 'v1', validate_artifact: true } : {}) };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
  const r = await runLaboratory(lab, { args: ['--seed', '1', '--level', '1', '--flat', '--no-grade', '--no-reflection', '--tools', 'view,act', '--researcher', 'assisted', '--attempts', '2', '--out', path.join(dir, 'run.json')],
    root: dir, llm: { url: 'http://x.test/c', model: 's' }, fetch: answers });
  const events = JSON.parse(fs.readFileSync(r.journal, 'utf8')).events as Record<string, any>[];
  const opened = events.find((e) => e.type === 'artifact_check')?.validation?.became_laboratories ?? [];
  assert.ok(opened.length >= 1, 'the artifact\'s validation opened a place: ' + JSON.stringify(opened));
  const act = events.filter((e) => e.type === 'investigation' && e.round === 2).flatMap((e) => e.results)[0];
  assert.equal(act?.accepted, true, 'it may experiment there: ' + JSON.stringify(act));
  const registered = events.filter((e) => e.type === 'investigation' && e.round === 2).flatMap((e) => e.results)[1];
  assert.ok(registered, 'it asked to register a test there');
  assert.doesNotMatch(String(registered.error ?? ''), /a test runs in one of your laboratories/, 'and may register a test of its own there: ' + JSON.stringify(registered));
});

/* A third review (16/10/2026): the guarantee of reconstruction, where it still had gaps. */

test('a stream is captured whole before it is clipped for display: a long stderr kept as evidence is the whole of it', async () => {
  const world = new ArtifactWorld(threesumTask({ scale: 0.1 }), processSandbox());
  const source = 'import sys\nsys.stderr.write("y" * 30000)\n' + world.store.get(world.reference)!.files.get('main.py');
  const noisy = world.change(world.reference, { files: { 'main.py': source } }) as { version: string };
  const kept = new Map<string, string>();
  const [r] = await world.check(noisy.version, ['mixed'], 1, 3, undefined, (text) => { const sha = 'k' + kept.size; kept.set(sha, text); return sha; });
  const whole = r.evidence[0].candidate[0].stderr_whole!;
  assert.equal(whole.chars, 30000, 'not the 20000 shown');
  assert.equal(kept.get(whole.sha256)!.length, 30000);
  assert.equal(whole.dropped, undefined, 'nothing dropped by the capture');
});

test('a resumed run carries the blobs of its history into its own folder, each checked against its digest; what is cited and missing is said', async () => {
  const { carryBlobs } = await import('../src/runtime/lab-runner.ts');
  const { createHash } = await import('node:crypto');
  const sha = (t: string) => createHash('sha256').update(t).digest('hex');
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'blobs-a-')), b = fs.mkdtempSync(path.join(os.tmpdir(), 'blobs-b-'));
  fs.mkdirSync(path.join(a, 'blobs'));
  fs.writeFileSync(path.join(a, 'blobs', sha('good')), 'good');
  fs.writeFileSync(path.join(a, 'blobs', sha('meant')), 'tampered');
  const gone = sha('gone');
  fs.writeFileSync(path.join(a, 'run.json'), JSON.stringify({ events: [{ evidence: { stderr_whole: { sha256: sha('good'), chars: 4, kept: true } } }, { output: { sha256: gone, chars: 4, kept: true } }] }, null, 2));
  const r = carryBlobs(path.join(a, 'run.json'), path.join(b, 'resumed.json'));
  assert.equal(r.carried, 1);
  assert.equal(fs.readFileSync(path.join(b, 'blobs', sha('good')), 'utf8'), 'good');
  assert.deepEqual(r.corrupt, [sha('meant')], 'a file whose content is not its name is not carried');
  assert.deepEqual(r.missing, [gone], 'cited, and not there');
  /* In a run: resumed into another folder, its journal says what it carried. */
  const cells = (await import('../src/worlds/cells/lab.ts')).cellsLab;
  const answers: FetchLike = async () => { const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify({ rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[0]', validate: false, beliefs: [], lessons: ['l'], next_experiment: 'n' }) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } }; };
  const args = ['--seed', '1', '--level', '1', '--flat', '--no-grade', '--no-reflection', '--tools', 'none', '--attempts', '3'];
  const cut = await runLaboratory(cells, { args: [...args, '--max-tokens', '150', '--out', path.join(a, 'cut.json')], root: a, llm: { url: 'http://x.test/c', model: 's' }, fetch: answers });
  const resumed = await runLaboratory(cells, { args: ['--resume', cut.journal, '--out', path.join(b, 'later', 'resumed.json')], root: b, llm: { url: 'http://x.test/c', model: 's' }, fetch: answers });
  assert.notEqual(resumed.stoppedBy, 'diverged');
  assert.ok(fs.existsSync(path.join(b, 'later', 'blobs', sha('good'))), 'carried into its own folder');
  assert.equal(JSON.parse(fs.readFileSync(resumed.journal, 'utf8')).blobs_carried.carried, 1);
});
