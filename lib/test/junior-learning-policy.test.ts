import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readPolicyConfig } from '../src/learn/assisted/research-policy.ts';
import { catalog, compareImprovements, expandLearningPolicy, learningPolicyProblems, productOf, scopeProblems, writeExpansion, type Improvement, type LearningPolicy } from '../src/junior/learning-policy.ts';
import type { CompetenceManifest, Observation } from '../src/junior/competence.ts';
import type { Evaluation } from '../src/junior/evaluate.ts';

/* SPEC-METAPOLITICA-APRENDIZAJE §14.1-§14.2, MA7: learning-policy@1 - checked, expanded for M1, in a catalog - and the
   comparison of improvement investigations that measures a procedure. */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'junior-lp-'));
const EXAMPLE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'learning-policies', 'distill-before-train.json');
const example = (): LearningPolicy => JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');

test('a learning policy expanded for M1: each template and its procedures in order, read as any research policy', () => {
  const lp = example();
  assert.deepEqual(learningPolicyProblems(lp), []);
  const x = expandLearningPolicy(lp, { max_advice_chars: 2000, limits: { advice: 4 } });
  assert.ok(!('errors' in x), JSON.stringify(x));
  assert.equal(x.config.policy.templates.distill_first.text, lp.policy.templates.distill_first.text + '\n\n' + lp.procedures.distill_from_cuts.text);
  assert.equal(x.algorithm, 'expansion@1');
  const dir = tmp();
  const w = writeExpansion(x, dir);
  const read = readPolicyConfig(fs.readFileSync(w.policy, 'utf8'), (f) => fs.readFileSync(path.join(dir, f), 'utf8'));
  assert.equal(read.policy.templates.cheap_first.text, x.config.policy.templates.cheap_first.text, 'what a run reads with --research-policy');
  assert.deepEqual(read.limits, { advice: 4 });
  const record = JSON.parse(fs.readFileSync(w.record, 'utf8'));
  assert.deepEqual([record.package.id, record.original.length, record.execution], [lp.id, 64, x.execution], 'the package as given, kept with what it became');
  /* Its identity: everything that changes what it does. */
  const same = expandLearningPolicy(lp, { max_advice_chars: 2000, limits: { advice: 4 } });
  const other = expandLearningPolicy(lp, { max_advice_chars: 2000, limits: { advice: 5 } });
  assert.ok(!('errors' in same) && !('errors' in other));
  assert.equal(same.execution, x.execution);
  assert.notEqual(other.execution, x.execution);
});

test('a package is refused, never patched: a procedure altered or missing, a parameter undeclared, an advice too long, a world out of scope', () => {
  const lp = example();
  const altered = { ...lp, procedures: { ...lp.procedures, cheap_first: { ...lp.procedures.cheap_first, text: lp.procedures.cheap_first.text + ' Always.' } } };
  assert.match(learningPolicyProblems(altered).join(), /cheap_first: its text does not match its sha256/);
  const missing = { ...lp, template_procedures: { ...lp.template_procedures, cheap_first: ['cheap_first', 'nowhere'] } };
  assert.match(learningPolicyProblems(missing).join(), /names a procedure that is not there: nowhere/);
  const text = 'Look at {{place}} first.';
  const undeclared = { ...lp, procedures: { ...lp.procedures, extra: { text, sha256: sha(text) } }, template_procedures: { ...lp.template_procedures, cheap_first: ['cheap_first', 'extra'] } };
  assert.match(learningPolicyProblems(undeclared).join(), /uses \{\{place\}\}, which template cheap_first does not declare/);
  const long = expandLearningPolicy(lp, { max_advice_chars: 100 });
  assert.ok('errors' in long);
  assert.match(long.errors.join(), /expands to \d+ characters, past the largest advice \(100\)/);
  assert.deepEqual(scopeProblems(lp, { id: 'cells@1' }), ['its scope is junior-competence@1, not cells@1']);
  assert.deepEqual(scopeProblems({ ...lp, scope: { ...lp.scope, instruments: ['table'] } }, { id: 'junior-competence@1' }), ['it needs the instrument table']);
});

test('the catalog: the packages of a folder usable in a world, and why the others are not', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify(example()));
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ ...example(), id: 'elsewhere', scope: { worlds: ['cells@1'] } }));
  fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify({ format: 'research-policy@1' }));
  const c = catalog(dir, { id: 'junior-competence@1' });
  assert.deepEqual(c.map((e) => [e.id, e.usable]), [['distill-before-train', true], ['elsewhere', false]]);
  assert.match(c[1].why.join(), /not junior-competence@1/);
});

test('the product of an improvement investigation: its last junior accepted, or its start; an interrupted one says so', () => {
  const dir = tmp();
  const j = (events: unknown[]) => { const f = path.join(dir, Math.random().toString(36).slice(2) + '.json'); fs.writeFileSync(f, JSON.stringify({ events })); return f; };
  assert.deepEqual(productOf(j([{ type: 'artifact_accepted', version: 'v1' }, { type: 'artifact_check', version: 'v2' }, { type: 'artifact_accepted', version: 'v3' }, { type: 'end', stoppedBy: 'budget' }]), 'ref'),
    { product: 'v3', state: 'ended' });
  assert.deepEqual(productOf(j([{ type: 'end', stoppedBy: 'token_budget' }]), 'ref'), { product: 'ref', state: 'ended' });
  assert.deepEqual(productOf(j([{ type: 'artifact_accepted', version: 'v1' }, { type: 'end', stoppedBy: 'cancelled' }]), 'ref'), { product: 'v1', state: 'interrupted' });
  assert.equal(productOf(j([]), 'ref').state, 'interrupted');
});

test('comparing improvement investigations: each pair\'s products case by case; an unfinished one is never credited to the method', () => {
  const probes = Array.from({ length: 6 }, (_, i) => ({ id: 'p' + i, kind: 'probe' as const, partition: 'development' as const, group: 'g' + i, component: 'protocol', lab: 'cells', mode: 'start' as const,
    cut: { run: 'r', question: 0, hash: 'h' }, competence: 'protocol', instruction: 'x', checker: { id: 'protocol', version: 1 } }));
  const m = { format: 'junior-competence-manifest@1', id: 'm', reference: 'a'.repeat(64), cases: probes, investigation_repetitions: 1, execution: {}, sampling: { seed: 1 },
    components: [{ id: 'protocol', rung: 1, mode: 'start', extractor: { id: 'probe', version: 1 }, unit: 'share', direction: 'up', target: 1, bad: 0, tolerance: 0 }],
    promotion: { procedure: 'paired-cases@1', alpha: 0.05, permutations: 1000, seed: 1 }, limits: { junior_args: [], probe_max_tokens: 1, timeout_ms: 1 } } as unknown as CompetenceManifest;
  const evaluation = (v: number[], execution: string): Evaluation => ({ format: 'junior-evaluation@1', manifest: 'm', execution, partition: 'development', temperature: 0,
    observations: v.map((x, i): Observation => ({ component: 'protocol', case: 'p' + i, rep: 0, value: x, state: 'measured' })), measure: null as never });
  const imp = (condition: string, product: string, v: number[], state: 'ended' | 'interrupted' = 'ended'): Improvement => ({ condition, state, product, evaluation: evaluation(v, product), cost: { tokens: 1000 } });
  const r = compareImprovements(m, [
    { reference: imp('none', 'j1', [0, 0, 0, 0, 0, 0]), candidate: imp('policy', 'j2', [1, 1, 1, 1, 1, 1]) },
    { reference: imp('none', 'j3', [1, 1, 1, 1, 1, 1]), candidate: imp('policy', 'j4', [1, 1, 1, 1, 1, 1], 'interrupted') },
    { reference: imp('none', 'j5', [0, 1, 0, 1, 0, 1]), candidate: imp('policy', 'j5', [0, 1, 0, 1, 0, 1]) },
    { reference: imp('none', 'j6', [1, 0, 0, 0, 0, 0]), candidate: imp('policy', 'j7', [0, 0, 0, 0, 0, 0].map((x, i) => (i === 1 ? 1 : x))) }
  ]);
  assert.deepEqual(r.pairs.map((p) => p.verdict), ['promoted', 'incomplete', 'inconclusive', 'inconclusive']);
  assert.deepEqual([r.improved, r.worse, r.inconclusive, r.incomplete], [1, 0, 2, 1]);
  assert.deepEqual(r.pairs[0].cost, [{ tokens: 1000 }, { tokens: 1000 }], 'the cost of each is kept');
});

test('lab junior policy: checked and expanded, the file a run gives to --research-policy', async () => {
  const { labCli } = await import('../src/runtime/cli.ts');
  const dir = tmp();
  const lines: string[] = [];
  const ctx = { root: dir, out: (l: string) => { lines.push(l); } } as never;
  assert.equal(await labCli(['junior', 'policy', EXAMPLE, '--max-advice', '2000', '--out', dir], ctx), 0);
  assert.match(lines.find((l) => l.startsWith('--research-policy'))!, /learning-policy\.[0-9a-f]{16}\.policy\.json/);
  assert.equal(await labCli(['junior', 'policy', EXAMPLE, '--max-advice', '50', '--out', dir], ctx), 2);
  assert.equal(await labCli(['junior', 'policy', EXAMPLE, '--max-advice', '2000', '--world', 'cells@1', '--out', dir], ctx), 2);
});

test('a learning policy advises the strong researcher of a real run of the junior\'s world, through M1', async () => {
  const { runLaboratory } = await import('../src/runtime/lab-runner.ts');
  const { cellsLab } = await import('../src/worlds/cells/lab.ts');
  const { juniorLab } = await import('../src/worlds/junior/lab.ts');
  const { captureCut } = await import('../src/junior/probes.ts');
  const { BlobStore, executionHash, normalizePackage } = await import('../src/junior/package.ts');
  const { SessionServer } = await import('../src/junior/sessions.ts');
  const { serveJunior } = await import('../src/junior/http.ts');
  const dir = tmp();
  const LOOK = { investigate: [{ view: 'ep1', from: 0, to: 2 }] };
  const reply = (content: unknown) => { const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 10 } }); return { ok: true, status: 200, text: async () => text, headers: { get: () => null } }; };
  const src = await runLaboratory(cellsLab, { args: ['--seed', '1', '--level', '1', '--flat', '--no-grade', '--tools', 'view', '--attempts', '1', '--out', path.join(dir, 'src.json')],
    root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch: (async () => reply(LOOK)) as never, print: () => {} });
  const q0 = await captureCut(src.journal, 0);
  const store = new BlobStore(path.join(dir, 'blobs'));
  const base = path.join(dir, 'base');
  fs.mkdirSync(base);
  fs.writeFileSync(path.join(base, 'w'), 'w');
  const b = (s: string) => store.put(s);
  const pkg = normalizePackage({ format: 'junior-package@1', name: 'j', base: store.putTree(base), prompt: '',
    execution: { firmware: b('f'), tokenizer: b('t'), chat_template: b('c'), driver: b('d'), verifier: b('v'), circuit: {}, precision: 'bf16' } });
  const server = new SessionServer({ root: path.join(dir, 'junior'), store, worker: { async run(job) {
    return { served: job.execution, terminal: 'answered', text: 'Let me think.', trace: '{}', ops: [], after: { neural: null, twin: null }, usage: null };
  } } });
  const h = await serveJunior(server);
  try {
    const m = { format: 'junior-competence-manifest@1', id: 'lp-run', reference: executionHash(pkg),
      components: [{ id: 'protocol-start', rung: 1, mode: 'start', extractor: { id: 'probe', version: 1 }, unit: 'share', direction: 'up', target: 1, bad: 0, tolerance: 0 }],
      cases: [{ id: 'p0', kind: 'probe', partition: 'development', group: 'g', component: 'protocol-start', lab: 'cells', mode: 'start', cut: { run: src.journal, question: 0, hash: q0.hash },
        competence: 'protocol', instruction: 'Answer in the protocol.', checker: { id: 'protocol', version: 1 } }],
      investigation_repetitions: 1, execution: {}, sampling: { seed: 1 }, promotion: { procedure: 'paired-cases@1', alpha: 0.05, permutations: 1000, seed: 1 },
      limits: { junior_args: ['--max-tokens', '1', '--max-judge-calls', '1'], probe_max_tokens: 100, timeout_ms: 60000 } };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
    const x = expandLearningPolicy(example(), { max_advice_chars: 2000 });
    assert.ok(!('errors' in x));
    const w = writeExpansion(x, dir);
    /* The strong researcher, a stand-in: it looks at the baseline, then puts forward a model of its observations. */
    const strong = (async (_url: string, init: { body?: string }) => {
      const parts = (JSON.parse(String(init.body)).messages as { content: string }[]).slice(1).map((mm) => { try { return JSON.parse(mm.content); } catch { return {}; } });
      const first = parts[0] ?? {};
      return reply('task' in first ? { rationale: 'r', beliefs: [{ id: 'b', stance: 'keep', why: 'w' }], lessons: ['l'], next_experiment: 'n' }
        : !parts.some((p) => p.investigation_step) ? { investigate: [{ view: 'ep2', from: 0, to: 0 }] }
        : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => 1', validate: false, beliefs: [{ id: 'b', stance: first.round === 1 ? 'new' : 'keep', statement: 's', evidence: [] }], lessons: ['l'], next_experiment: 'n' });
    }) as never;
    const r = await runLaboratory(juniorLab, { args: ['--manifest', path.join(dir, 'manifest.json'), '--package', path.join(dir, 'package.json'), '--blobs', path.join(dir, 'blobs'), '--server', h.url,
      '--work', path.join(dir, 'work'), '--evaluations', '3', '--flat', '--no-grade', '--attempts', '2', '--researcher', 'assisted', '--research-policy', w.policy, '--out', path.join(dir, 'run.json')],
      root: dir, llm: { url: 'http://strong.test/chat', model: 'strong' }, fetch: strong, print: () => {} });
    const events = JSON.parse(fs.readFileSync(r.journal, 'utf8')).events as { type: string; message?: unknown }[];
    const delivered = events.filter((e) => e.type === 'research_policy_delivered' && e.message);
    assert.ok(delivered.length >= 1, 'the policy advised: ' + events.map((e) => e.type).join(' '));
    const said = events.filter((e) => JSON.stringify(e).includes('Try the cheapest levers first'));
    assert.ok(said.length >= 1, 'its procedure went with its advice, in what the researcher was told');
  } finally { server.stop(); await h.close(); }
});
