import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';
import { regrade } from '../src/runtime/regrade.ts';
import type { ChatClient } from '../src/learn/system2.ts';
import { providerOf } from '../src/runtime/provider.ts';
import { declareIndependence, reviseRun } from '../src/runtime/validation.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';

/* SPEC-RIESGO-MODELOS M4 (§7.2): the three dimensions of independence, recorded apart and never summed up as a yes or a no -
   technical diversity (each validator's model and provider against the developer's and the directors'), the separation of the
   evaluation (what each validator saw, its reasoning included or not, who framed its task, whether it took part), and the
   organisational one, declared by a person. A provider is an identity, never an address. */

const GRADE = { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' };

async function aRun(dir: string): Promise<string> {
  const answers: FetchLike = async (_url, init) => {
    const b = JSON.parse(String(init.body));
    const sys = b.messages[0].content as string;
    const user = sys.startsWith('You grade') ? {} : JSON.parse(userOf(b));
    const content = sys.startsWith('You grade') ? GRADE : 'task' in user ? { rationale: 'r', beliefs: [], lessons: ['l'], next_experiment: 'n' }
      : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]', validate: false, lessons: ['l'], next_experiment: 'n',
        beliefs: [{ id: 'b', stance: 'new', statement: 's', evidence: [] }] };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
  return (await runLaboratory(cellsLab, { args: ['--seed', '1', '--level', '1', '--researcher', 'assisted', '--attempts', '1', '--flat', '--no-reflection', '--no-ablation', '--out', path.join(dir, 'run.json')],
    root: dir, llm: { url: 'http://system2.test/v1/chat/completions', model: 'junior-model' }, fetch: answers })).journal;
}

test('independence in three dimensions: who validated with what, what each saw, and what a person declares', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'independence-'));
  const evidenceDir = path.join(dir, 'runs', 'models', 'evidence');
  const journal = await aRun(dir);
  const j = JSON.parse(fs.readFileSync(journal, 'utf8'));
  assert.equal(j.config.llm_provider, providerOf('http://system2.test/x'), 'its provider, as an identity');
  assert.ok(!JSON.stringify(j.config).includes('system2.test'), 'never its address');
  const graded = j.events.find((e: any) => e.type === 'operator_rule_recovery');
  assert.ok(graded, 'graded in the run');
  assert.equal(graded.saw_reasoning, true, 'the in-run grader is given its notes and reflections: ' + JSON.stringify(graded.saw));
  assert.equal(graded.grader_provider, j.config.llm_provider);
  /* A senior directed it, with a model of its own. */
  fs.writeFileSync(journal.replace(/\.json$/, '.agent-senior.json'), JSON.stringify({ format: 'agent@1', agent: 'agent:senior', role: 'senior', llm_config: { model: 'senior-model' }, llm_provider: 'aaaaaaaaaaaaaaaa', decisions: [] }));

  const first = (await reviseRun(journal, { evidenceDir, use: 'u' })).report;
  const ind = first.independence;
  assert.ok(!('independent' in ind), 'never a yes or a no');
  assert.deepEqual(ind.roles.directors.agents.map((a: any) => [a.role, a.model]), [['senior', 'senior-model']]);
  const grader = (rows: any[]) => rows.find((r) => r.role === 'grader');
  assert.equal(grader(ind.technical_diversity).same_model_as_developer, true);
  assert.equal(grader(ind.technical_diversity).same_provider_as_developer, true);
  assert.equal(grader(ind.separation_of_the_evaluation).took_part_in_development, 'its model is the developer\'s');
  assert.equal(grader(ind.separation_of_the_evaluation).saw_reasoning, true);
  assert.equal(ind.separation_of_the_evaluation.find((r: any) => r.role === 'the environment\'s checks').saw_reasoning, false);
  assert.equal(ind.organisational, 'declared by a person, never computed: not declared');

  /* Graded again by another model of another provider, given the same: more diversity, the same separation. */
  const other: ChatClient = { endpoint: 'https://grader.example/v1', complete: async () => ({ content: JSON.stringify(GRADE) }) as never };
  await regrade(journal, other, 'grader-model');
  assert.throws(() => declareIndependence(journal, { by: 'agent:senior', validator: 'x' }), /a person/);
  declareIndependence(journal, { by: 'Ana', validator: 'Luis, model risk', reportsTo: 'the risk committee', separate: 'yes', canChallenge: 'yes' });
  const later = await reviseRun(journal, { evidenceDir });
  assert.equal(later.created, true);
  assert.equal(later.report.process_verification.reconstruction.holds, true, 'a regrade is a later reading, not a change of the run: ' + JSON.stringify(later.report.process_verification.reconstruction));
  assert.equal(later.report.process_verification.reconstruction.later_readings, 1);
  const ind2 = later.report.independence;
  assert.equal(grader(ind2.technical_diversity).same_model_as_developer, false);
  assert.equal(grader(ind2.technical_diversity).same_provider_as_developer, false);
  assert.match(grader(ind2.technical_diversity).reading, /diversity, not independence/);
  assert.equal(grader(ind2.separation_of_the_evaluation).took_part_in_development, false);
  assert.equal(grader(ind2.separation_of_the_evaluation).saw_reasoning, true, 'yet it read the developer\'s reasoning');
  assert.equal(ind2.organisational.declared.validator, 'Luis, model risk');
  assert.equal(ind2.organisational.declared.separate_from_development, true);
  const roles = JSON.parse(fs.readFileSync(path.join(evidenceDir, later.revision), 'utf8')).evidence.map((e: any) => e.role);
  assert.ok(roles.includes('independence_declarations') && roles.includes('agent_record'), roles.join());
});
