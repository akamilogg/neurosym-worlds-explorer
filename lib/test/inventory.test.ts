import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { artifactsLab } from '../src/worlds/artifacts/lab.ts';
import { approveRevision, reviseRun } from '../src/runtime/validation.ts';
import { checkModels, instrumentOf, inventoryFile, readInventory, registerModel, retireModel } from '../src/runtime/inventory.ts';
import { writeVerdict } from '../src/learn/anomalies.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';

/* SPEC-RIESGO-MODELOS M3 (§4, §5, §8.1): the inventory of models - three layers, an owner who is a person, a context of use,
   criticality on two axes, a state with its history; what triggers validating again (a dependency, the instrument, the
   context, the date, a fault confirmed), and how a person's signature after it clears it. */

async function aRun(dir: string): Promise<string> {
  const answers: FetchLike = async (_url, init) => {
    const user = JSON.parse(userOf(JSON.parse(String(init.body))));
    const content = 'task' in user ? { rationale: 'r', beliefs: [], lessons: ['l'], next_experiment: 'n' }
      : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => 100', validate: false, lessons: ['l'], next_experiment: 'n', beliefs: [] };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
  return (await runLaboratory(artifactsLab, { args: ['--artifact', 'threesum', '--scale', '0.2', '--seed', '1', '--researcher', 'assisted', '--attempts', '2', '--flat', '--no-grade', '--no-reflection', '--no-ablation', '--out', path.join(dir, 'run.json')],
    root: dir, llm: { url: 'http://x.test/c', model: 's' }, fetch: answers })).journal;
}

const tick = () => new Promise((r) => setTimeout(r, 5));
const edit = (root: string, f: (m: any) => void) => { const inv = readInventory(root); f(inv.models[0]); fs.writeFileSync(inventoryFile(root), JSON.stringify(inv)); };

test('the instrument of a world is its code and what it uses outside the harness', () => {
  const i = instrumentOf(artifactsLab.id)!;
  assert.ok(i.paths.includes('lib/src/worlds/artifacts') && i.paths.includes('lib/src/artifacts'), i.paths.join(', '));
  assert.ok(!i.paths.some((p) => /\/(learn|runtime|orchestra|core)$/.test(p)), 'never the harness');
  assert.match(i.fingerprint, /^[0-9a-f]{16}$/);
});

test('the inventory: registered by a person for a use; its state follows what is signed and what changes, each change with its cause', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-'));
  const evidenceDir = path.join(root, 'runs', 'models', 'evidence');
  const journal = await aRun(root);
  await assert.rejects(registerModel(root, journal, { owner: 'Ana', evidenceDir }), /for a use/);
  await assert.rejects(registerModel(root, journal, { owner: 'agent:senior', use: 'u', evidenceDir }), /a person/);
  await assert.rejects(registerModel(root, journal, { owner: 'Ana', use: 'u', influence: 'huge', evidenceDir }), /influence/);

  const r1 = await reviseRun(journal, { evidenceDir, use: 'anticipate the time of a run', criteria: 'within 25%' });
  const m = await registerModel(root, journal, { owner: 'Ana', influence: 'medium', consequence: 'low', reviewDays: 30, evidenceDir });
  assert.equal(m.use_context, 'anticipate the time of a run', 'its use, from the revision that declares it');
  assert.equal(m.status, 'in_validation');
  const deps = m.layers.execution_dependencies as any;
  assert.equal(deps.runtime.node, process.version);
  assert.match(String(deps.judge), /no rules/);
  assert.equal(deps.instrument.lab, 'artifacts');
  assert.match(String(deps.environment), /^[0-9a-f]{16}$/, 'what its world says it needs');
  assert.deepEqual(m.criticality, { influence: 'medium', consequence: 'low' });
  await assert.rejects(registerModel(root, journal, { owner: 'Ana', use: 'u', evidenceDir }), /already/);

  /* Signed: the state is the person's conclusion, with the revision. */
  approveRevision(journal, r1.revision, { by: 'Ana', conclusion: 'approved_with_limitations', evidenceDir });
  let [c] = await checkModels(root, { evidenceDir });
  assert.equal(c.entry.status, 'approved_with_limitations');
  assert.equal(c.entry.history.at(-1)!.by, 'Ana');
  assert.equal(c.entry.history.at(-1)!.revision, r1.revision);

  /* A dependency changed (the runtime it was inventoried with): validate again, by the harness, with its cause - once. */
  edit(root, (x) => { x.layers.execution_dependencies.runtime = { node: 'v0.0.0' }; });
  [c] = await checkModels(root, { evidenceDir });
  assert.equal(c.entry.status, 'revalidate');
  assert.match(c.causes.join(), /^dependency: runtime was/);
  const triggers = () => readInventory(root).models[0].history.filter((h) => h.trigger).length;
  await checkModels(root, { evidenceDir });
  assert.equal(triggers(), 1, 'the same cause told once');
  /* Signed again after it: the model as it is now is inventoried again. */
  await tick();
  approveRevision(journal, r1.revision, { by: 'Ana', conclusion: 'approved', note: 'checked on this runtime', evidenceDir });
  [c] = await checkModels(root, { evidenceDir });
  assert.equal(c.entry.status, 'approved');
  assert.equal((c.entry.layers.execution_dependencies as any).runtime.node, process.version);
  assert.ok(c.entry.history.some((h) => h.rebaselined));

  /* The instrument: its code changed, or a fault of it confirmed by the operator. */
  edit(root, (x) => { x.layers.execution_dependencies.instrument = { lab: 'artifacts', fingerprint: '0000000000000000' }; });
  [c] = await checkModels(root, { evidenceDir });
  assert.match(c.causes.join(), /^instrument: instrument was/);
  await tick();
  approveRevision(journal, r1.revision, { by: 'Ana', conclusion: 'approved', evidenceDir });
  [c] = await checkModels(root, { evidenceDir });
  assert.equal(c.entry.status, 'approved');
  writeVerdict(journal, { report: 'ir-1', verdict: 'bug' });
  [c] = await checkModels(root, { evidenceDir });
  assert.equal(c.entry.status, 'revalidate');
  assert.match(c.causes.join(), /fault\(s\) of the instrument confirmed/);
  await tick();
  approveRevision(journal, r1.revision, { by: 'Ana', conclusion: 'approved', evidenceDir });
  assert.equal((await checkModels(root, { evidenceDir }))[0].entry.status, 'approved');

  /* Another context of use in its latest revision. */
  await reviseRun(journal, { evidenceDir, use: 'design interventions' });
  [c] = await checkModels(root, { evidenceDir });
  assert.equal(c.entry.status, 'revalidate');
  assert.ok(c.causes.some((x) => x.startsWith('context:')), c.causes.join());

  /* Its review date. */
  const late = await checkModels(root, { evidenceDir, now: new Date(Date.now() + 40 * 86400000) });
  assert.ok(late[0].causes.some((x) => x.startsWith('date:')));

  /* Retired by a person; then left as it is. */
  assert.throws(() => retireModel(root, m.id, 'agent:coach'), /a person/);
  assert.equal(retireModel(root, m.id, 'Ana', 'replaced').status, 'retired');
  assert.equal((await checkModels(root, { evidenceDir }))[0].entry.status, 'retired');
});
