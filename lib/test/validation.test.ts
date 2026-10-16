import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { artifactsLab } from '../src/worlds/artifacts/lab.ts';
import { approveRevision, openRevision, reviseRun, validationState } from '../src/runtime/validation.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';

/* SPEC-RIESGO-MODELOS M1 (§6, §7.3, §7.4): a validation report in revisions that do not change - closed, its evidence copied
   by content to a store only read, its manifest's hash the revision; recomputed, the same revision or a new one, compared by a
   rule with the one approved; a person's conclusion in a file of its own, refused where the evidence does not hold. */

async function aRun(dir: string): Promise<string> {
  const answers: FetchLike = async (_url, init) => {
    const b = JSON.parse(String(init.body));
    const user = JSON.parse(userOf(b));
    const content = 'task' in user ? { rationale: 'r', beliefs: [], lessons: ['l'], next_experiment: 'n' }
      : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => 100', validate: false, lessons: ['l'], next_experiment: 'n',
        beliefs: [{ id: 'cubic_is_slow', stance: 'new', statement: 'the base is cubic', evidence: [] }] };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
  const r = await runLaboratory(artifactsLab, { args: ['--artifact', 'threesum', '--scale', '0.2', '--seed', '1', '--researcher', 'assisted', '--attempts', '2', '--flat', '--no-grade', '--no-reflection', '--no-ablation', '--out', path.join(dir, 'run.json')],
    root: dir, llm: { url: 'http://x.test/c', model: 's' }, fetch: answers });
  return r.journal;
}

test('revisions: closed, by their manifest\'s hash, evidence by content; a person signs one; a recomputation that contradicts it suspends it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'validation-'));
  const evidenceDir = path.join(dir, 'runs', 'models', 'evidence');
  const journal = await aRun(dir);

  const first = await reviseRun(journal, { evidenceDir, use: 'anticipate the time of a run', criteria: 'within 25%' });
  assert.equal(first.created, true);
  assert.equal(first.report.format, 'validation_report@1');
  assert.equal(first.report.proposed_conclusion.draft, true, 'the code proposes, by its rule; it never concludes');
  assert.deepEqual(first.report.description.assumptions.map((b: any) => b.id), ['cubic_is_slow']);
  assert.equal(first.report.process_verification.reconstruction.holds, true);
  assert.equal(first.report.independence.organisational, 'declared by a person, never computed: not declared');
  const manifest = JSON.parse(fs.readFileSync(path.join(evidenceDir, first.revision), 'utf8'));
  assert.equal(createHash('sha256').update(fs.readFileSync(path.join(evidenceDir, first.revision))).digest('hex'), first.revision, 'the revision is its manifest\'s hash');
  assert.deepEqual(manifest.evidence.map((e: any) => e.role).sort(), ['finding', 'finding_researcher', 'journal', 'replay_log']);
  for (const e of manifest.evidence) assert.ok(fs.existsSync(path.join(evidenceDir, e.sha256)), e.role + ' copied by its content');

  /* Computed again, nothing changed: the same revision. */
  const again = await reviseRun(journal, { evidenceDir });
  assert.equal(again.created, false);
  assert.equal(again.revision, first.revision, 'the context of use carried from the revision before');

  /* A person signs it; an agent cannot. */
  assert.throws(() => approveRevision(journal, first.revision.slice(0, 16), { by: 'agent:senior', conclusion: 'approved', evidenceDir }), /a person/);
  assert.throws(() => approveRevision(journal, first.revision.slice(0, 16), { by: 'Ana', conclusion: 'fine', evidenceDir }), /one of/);
  const signed = approveRevision(journal, first.revision.slice(0, 16), { by: 'Ana', conclusion: 'approved_with_limitations', note: 'only for this use', evidenceDir });
  assert.equal(signed.revision, first.revision);
  assert.equal(validationState(journal, evidenceDir).status, 'approved_with_limitations');
  const reportBefore = fs.readFileSync(path.join(evidenceDir, manifest.report));

  /* The finding written again (a regrade, a verdict): a limitation it did not have - a new revision, and the approval suspended. */
  const findingFile = journal.replace(/\.json$/, '.finding.json');
  const f = JSON.parse(fs.readFileSync(findingFile, 'utf8'));
  f.counterexamples = [...(f.counterexamples ?? []), { place: 'family:large', facts: { error: 0.6 } }];
  fs.writeFileSync(findingFile, JSON.stringify(f));
  const later = await reviseRun(journal, { evidenceDir });
  assert.equal(later.created, true);
  assert.notEqual(later.revision, first.revision);
  assert.equal(later.comparison?.contradicts, true);
  assert.equal(later.comparison?.new_limitations.length, 1);
  const state = validationState(journal, evidenceDir);
  assert.equal(state.status, 'revalidate', JSON.stringify(state.note));
  assert.deepEqual(fs.readFileSync(path.join(evidenceDir, manifest.report)), reportBefore, 'what was signed, as it was');
  assert.equal(openRevision(journal, first.revision, evidenceDir).integrity.holds, true, 'and it still opens whole');

  /* Another context of use: another revision. */
  const otherUse = await reviseRun(journal, { evidenceDir, use: 'design interventions' });
  assert.equal(otherUse.created, true);

  /* A copy in the store altered: opening it says so, and nothing is signed on it. */
  const target = path.join(evidenceDir, manifest.evidence.find((e: any) => e.role === 'journal').sha256);
  fs.chmodSync(target, 0o644);
  fs.writeFileSync(target, '{}');
  const opened = openRevision(journal, first.revision, evidenceDir);
  assert.equal(opened.integrity.holds, false);
  assert.match(opened.integrity.problems.join(' '), /journal/);
  assert.throws(() => approveRevision(journal, first.revision, { by: 'Ana', conclusion: 'approved', evidenceDir }), /does not hold/);
});

test('a revision with nothing contradicted leaves the approval standing, with a note of the later one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'validation-stands-'));
  const evidenceDir = path.join(dir, 'runs', 'models', 'evidence');
  const journal = await aRun(dir);
  const first = await reviseRun(journal, { evidenceDir, use: 'u' });
  approveRevision(journal, first.revision, { by: 'Ana', conclusion: 'approved_with_limitations', evidenceDir });
  const later = await reviseRun(journal, { evidenceDir, criteria: 'within 30%' });
  assert.equal(later.comparison?.contradicts, false);
  const state = validationState(journal, evidenceDir);
  assert.equal(state.status, 'approved_with_limitations');
  assert.match(String(state.note), /later revision, unsigned, contradicts nothing/);
  /* Its evidence altered in the store: the signature stays as signed, and is no longer in force. */
  const m = JSON.parse(fs.readFileSync(path.join(evidenceDir, first.revision), 'utf8'));
  const copy = path.join(evidenceDir, m.evidence.find((e: any) => e.role === 'journal').sha256);
  fs.chmodSync(copy, 0o644);
  fs.writeFileSync(copy, '{}');
  const broken = validationState(journal, evidenceDir);
  assert.equal(broken.status, 'revalidate');
  assert.match(String(broken.note), /evidence of the signed revision .* does not hold/);
  assert.equal(broken.approval?.conclusion, 'approved_with_limitations', 'what was signed, as it was');
});
