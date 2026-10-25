import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stableStringify } from '../src/core/hash.ts';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { artifactsLab } from '../src/worlds/artifacts/lab.ts';
import { runEvolutionBranch, branchFiles, consolidationTask, evolveCapability, type EvolveBranchSpec } from '../src/runtime/evolve-branch.ts';
import { processTraces } from '../src/orchestra/traces.ts';
import { runSearch } from '../src/learn/evolve/engine.ts';
import { balanced } from '../src/learn/evolve/policy.ts';
import { verifySearch } from '../src/learn/evolve/verify.ts';
import { Delegations } from '../src/learn/assisted/delegation.ts';
import type { Evaluator, Mutator } from '../src/learn/evolve/engine.ts';
import { runResults } from '../src/orchestra/results.ts';
import { packRun, verifyPackage } from '../src/runtime/package.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';

/* SPEC-DELEGACION-EVOLUTIVA H2: an evolutionary branch through the delegation - its supervisor, its two phases, its report,
   its cost, its crashes and its continuation. */

const llm = { url: 'http://x.test/v1/chat/completions', model: 's' };
const reply = (content: unknown, tokens = 100) => { const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: tokens } }); return { ok: true, status: 200, text: async () => text, headers: { get: () => null } }; };
const MODEL = { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => 100', validate: false, beliefs: [], lessons: ['l'], next_experiment: 'n' };
/** Every string in a value: where a research result's text is. */
const strings = (v: unknown): string[] => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []);
const resultIn = (user: unknown): any | null => {
  const t = strings(user).find((s) => s.startsWith('RESEARCH RESULT of your branch'));
  return t ? JSON.parse(t.slice(t.indexOf('environment): ') + 'environment): '.length)) : null;
};
const variant = (): Mutator & { calls: number } => {
  const m = { calls: 0, async propose(ctx: any) {
    m.calls++;
    const from = ctx.parent?.files ?? ctx.program?.files ?? ctx.parents?.[0]?.files ?? null;
    const main = from?.['main.py'];
    if (!main) return { text: JSON.stringify({ files: {}, why: 'nothing' }), tokens: 20 };
    return { text: JSON.stringify({ files: { 'main.py': main + '\n# variant ' + m.calls + '\n' }, why: 'a variant' }), tokens: 20 };
  } };
  return m;
};
/** The consolidation standing in: it reads the search's candidates, writes what it found, and closes its round. */
const consolidator: FetchLike = async (_url, init) => {
  const user = JSON.parse(userOf(JSON.parse(String(init.body))));
  if ('task' in user) return reply({ rationale: 'r', beliefs: [], lessons: ['l'], next_experiment: 'n' }, 30);
  if (!(user.investigation ?? []).length) return reply({ investigate: [{ experience: 'list', run: 'search', of: 'candidates' }] }, 30);
  return reply({ close_round: { why: 'the variants keep the answers; adopt the first' }, notes: [{ do: 'write', id: 'adopt', text: 'the first candidate keeps every answer' }] }, 30);
};

test('H2.1 the requester delegates a search, gets its result once, imports a candidate by its content and runs it - never help', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-deleg-'));
  let branch: Promise<unknown> | null = null;
  const mutator = variant();
  const st = { adopted: null as null | { program: string; files: Record<string, string>; start: string }, made: null as string | null, ran: false, seenResult: 0 };
  const parent: FetchLike = async (_url, init) => {
    const user = JSON.parse(userOf(JSON.parse(String(init.body))));
    if ('task' in user) return reply({ rationale: 'r', beliefs: [], lessons: ['l'], next_experiment: 'n' });
    const done = (user.investigation ?? []).length;
    for (const i of user.investigation ?? []) for (const x of i.results ?? []) if (x.accepted && typeof x.version === 'string' && !('runs' in x)) st.made = x.version;
    const result = resultIn(user);
    if (result) st.seenResult++;
    if (result && !st.adopted) {
      const c = result.candidates[0];
      st.adopted = { program: c.program, files: c.files, start: result.start.program };
      return reply({ investigate: [{ act: { change: { from: result.start.program, files: c.files, why: 'adopt the branch\'s candidate', expect: 'the same answers' } } }] });
    }
    if (st.made && !st.ran) { st.ran = true; return reply({ investigate: [{ act: { run: { version: st.made, workloads: 1 } } }] }); }
    if (user.round === 1 && done === 0) return reply({ investigate: [{ delegate: { mode: 'evolve', question: 'find variants of the base worth trying', budget: { evaluations: 3 } } }] });
    /* In its second round it waits for the branch, then asks once more, so the result reaches it. */
    if (user.round === 2 && done === 0 && branch) { await branch; return reply({ investigate: [{ view: 'ep1', from: 0, to: 0 }] }); }
    return reply(MODEL);
  };
  const args = ['--artifact', 'dedup', '--scale', '0.1', '--workloads', '1', '--seed', '1', '--researcher', 'assisted', '--attempts', '3', '--flat', '--no-grade', '--no-reflection', '--no-ablation',
    '--delegation-fund', '100000', '--delegation-tokens', '40000', '--delegation-evolve', '4', '--delegation-evolve-workloads', '1', '--out', path.join(dir, 'run.json')];
  const r = await runLaboratory(artifactsLab, { args, root: dir, llm, fetch: parent,
    delegate: (l) => {
      assert.ok(l.evolve, 'an evolutionary branch is its supervisor, not a run');
      branch = runEvolutionBranch({ journal: l.journal, spec: JSON.parse(fs.readFileSync(l.evolve!, 'utf8')), mutator, heartbeatMs: 50,
        consolidate: async (a) => { await runLaboratory(artifactsLab, { args: a, root: dir, llm, fetch: consolidator }); } });
    } });
  await branch;
  const events = JSON.parse(fs.readFileSync(r.journal, 'utf8')).events as any[];
  const req = events.find((e) => e.type === 'delegation_requested');
  assert.equal(req.mode, 'evolve');
  assert.equal(req.granted.evaluations, 3);
  const delivered = events.filter((e) => e.type === 'operator_message').flatMap((e) => e.messages).filter((m: any) => m.research_result);
  assert.equal(delivered.length, 1, 'once');
  const report = JSON.parse(delivered[0].text.slice(delivered[0].text.indexOf('environment): ') + 14));
  assert.equal(report.mode, 'evolve');
  assert.ok(report.candidates.length >= 1 && report.candidates.every((c: any) => c.files['main.py']), 'candidates whole');
  assert.ok(report.candidates.every((c: any) => c.program !== report.start.program), 'what it found, never its start');
  assert.equal(report.consolidation.notes?.[0]?.id, 'adopt', 'its consolidation reviewed them');
  assert.ok(report.candidates[0].confirmation.correct, 'confirmed on new workloads');
  assert.match(String(report.search.continue_with), /continue_from/);
  /* Adopted by its content: the parent's change is the very program the branch made. */
  assert.equal(st.made, st.adopted!.program, 'the same content, the same version');
  const ran = events.filter((e) => e.type === 'investigation').flatMap((e) => e.results).find((x: any) => x.runs !== undefined && x.version === st.made);
  assert.ok(ran && ran.correct === ran.runs, 'run in its own laboratory, correct');
  assert.equal(r.finding.assistance?.messages.length ?? 0, 0, 'a contribution, never help');
  /* Its cost: both phases in one total, delegated apart. */
  const bf = JSON.parse(fs.readFileSync(branchFiles(path.join(path.dirname(r.journal), req.journal)).finding, 'utf8'));
  assert.equal(bf.cost.total.llm_tokens, bf.cost.search.llm_tokens + bf.cost.consolidation.llm_tokens);
  assert.ok(bf.cost.search.llm_tokens > 0 && bf.cost.consolidation.llm_tokens > 0);
  assert.equal(runResults(r.journal).cost.tokens.delegated, bf.cost.total.llm_tokens);
  /* Packed with its branch (search, manifest, consolidation), and rebuilt offline: nothing asked, nothing launched. */
  const packed = packRun(r.journal);
  const rel = req.journal.replace(/\.json$/, '');
  for (const suffix of ['.search.jsonl', '.search.manifest.json', '.consolidation.json', '.finding.json']) assert.ok(packed.manifest.files.some((f) => f.path === rel + suffix), rel + suffix);
  const v = await verifyPackage(packed.dir);
  assert.equal(v.reconstruction.holds, true, JSON.stringify(v.reconstruction));
  /* Its search rebuilt from its record, without a model or a measure. */
  assert.equal(v.searches.length, 1);
  assert.equal(v.searches[0].holds, true, v.searches[0].why);
  /* K1 and the traces read the evolutionary branch apart: by phase, what it searched, exported and what was adopted. */
  const evo = runResults(r.journal).cost.tokens.evolutionary!;
  assert.equal(evo.branches, 1);
  assert.equal(evo.search + (evo.consolidation ?? 0), bf.cost.total.llm_tokens, 'its phases add up to what it was settled at');
  assert.ok(evo.evaluations >= 1 && evo.exported >= 1 && evo.machine_seconds > 0);
  assert.equal(evo.adopted, 1);
  const traces = processTraces(r.journal).branches;
  assert.deepEqual([traces.evolutionary, traces.candidates_adopted], [1, 1]);
});

/* --- The supervisor alone, with an evaluator of its own (fast): crashes, cancellation, partial deliveries -------------- */

function fakeEvaluator(): Evaluator & { calls: number } {
  const versions = new Map<string, Record<string, string>>();
  const hashOf = (f: Record<string, string>) => createHash('sha256').update(stableStringify(f)).digest('hex').slice(0, 12);
  const start = { 'main.py': 'q=1' };
  versions.set(hashOf(start), start);
  const ev = { calls: 0, async identity() { return 'fake'; }, contract: () => ({}), start: () => ({ hash: hashOf(start), files: start }), validate: () => null,
    materialize(from: string, files: Readonly<Record<string, string | null>>) { const m: Record<string, string> = { ...versions.get(from)! }; for (const [k, v] of Object.entries(files)) { if (v === null) delete m[k]; else m[k] = v; } const h = hashOf(m); versions.set(h, m); return { hash: h, files: m }; },
    adopt(h: string, files: Readonly<Record<string, string>>) { versions.set(h, { ...files }); return null; },
    async evaluate(h: string) { ev.calls++; const n = (versions.get(h)!['main.py'].match(/#/g) ?? []).length; return { executable: true, correct: 'yes' as const, quality: [1 / (1 + n)], descriptor: null, feedback: null, diagnostics: [], evaluator: 'fake' }; } };
  return ev;
}
const spec = (dir: string, extra: Partial<EvolveBranchSpec> = {}): EvolveBranchSpec => {
  const cut = path.join(dir, 'cut.json');
  fs.writeFileSync(cut, JSON.stringify({ events: [{ type: 'end' }] }));
  return { format: 'evolution-branch@1', id: 'delegation:r1.1', question: 'q', expected: null, refs: [], cut, seed: 1, options: { artifact: 'dedup', scale: '0.1', acts: '3', tolerance: '0.25', workloads: '1' },
    worldArgs: [], start: null, continueFrom: null, exploration: { workloads: 1, seed: 5 }, limits: { evaluations: 4, attempts: 8, tokens: 10000 }, consolidation: { tokens: 1000, rounds: 1 }, ...extra };
};
const counting = () => { const c = { calls: [] as string[][], async run(a: readonly string[]) { c.calls.push([...a]); const out = a[a.indexOf('--out') + 1];
  fs.writeFileSync(out, JSON.stringify({ events: [{ type: 'end', stoppedBy: 'budget', notebook: { beliefs: [], notes: [{ id: 'n', text: 'reviewed' }] } }] }));
  fs.writeFileSync(out.replace(/\.json$/, '.finding.json'), JSON.stringify({ cost: { total: { llm_tokens: 70 } } })); } };
  return c; };
const ev = (s: EvolveBranchSpec) => fakeEvaluator();

test('H2.2 crashes before and after each transition duplicate nothing; a cancellation during the search never consolidates', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-crash-'));
  const journal = path.join(dir, 'b.json');
  const c1 = counting();
  await runEvolutionBranch({ journal, spec: spec(dir), mutator: variant(), consolidate: c1.run, evaluator: () => ev(spec(dir)) });
  const full = JSON.parse(fs.readFileSync(journal, 'utf8'));
  const cutAt = (type: string) => { const j = JSON.parse(JSON.stringify(full)); j.events = j.events.slice(0, j.events.findIndex((e: any) => e.type === type) + 1); fs.writeFileSync(journal, JSON.stringify(j)); };

  /* After the search was sealed, before the consolidation was asked: the search is never done again. */
  cutAt('search_finished');
  fs.rmSync(branchFiles(journal).consolidation, { force: true });
  const never: Mutator = { async propose() { throw new Error('never asked again'); } };
  const c2 = counting();
  await runEvolutionBranch({ journal, spec: spec(dir), mutator: never, consolidate: c2.run, evaluator: () => ev(spec(dir)) });
  let j = JSON.parse(fs.readFileSync(journal, 'utf8'));
  assert.equal(j.events.filter((e: any) => e.type === 'search_finished').length, 1);
  assert.equal(c2.calls.length, 1, 'the consolidation launched once');
  assert.equal(j.events.filter((e: any) => e.type === 'end').length, 1);

  /* After the consolidation was asked and began (its record without an end): resumed, not launched again. */
  cutAt('consolidation_requested');
  fs.writeFileSync(branchFiles(journal).consolidation, JSON.stringify({ events: [{ type: 'start' }] }));
  const c3 = counting();
  await runEvolutionBranch({ journal, spec: spec(dir), mutator: never, consolidate: c3.run, evaluator: () => ev(spec(dir)) });
  assert.deepEqual(c3.calls.map((a) => a[0]), ['--resume'], 'resumed from where it stopped');
  j = JSON.parse(fs.readFileSync(journal, 'utf8'));
  assert.equal(j.events.filter((e: any) => e.type === 'consolidation_requested').length, 1);

  /* After the consolidation ended, before the branch's end: nothing launched, one end. */
  cutAt('consolidation_requested');
  const c4 = counting();
  await runEvolutionBranch({ journal, spec: spec(dir), mutator: never, consolidate: c4.run, evaluator: () => ev(spec(dir)) });
  assert.equal(c4.calls.length, 1, 'a consolidation record without an end is resumed');

  /* In the middle of the search: what has a receipt is not asked again. */
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-crash2-'));
  const j2 = path.join(dir2, 'b.json');
  await runEvolutionBranch({ journal: j2, spec: spec(dir2), mutator: variant(), consolidate: counting().run, evaluator: () => ev(spec(dir2)) });
  const searchLines = fs.readFileSync(branchFiles(j2).search, 'utf8').split('\n').filter(Boolean);
  const half = searchLines.findIndex((l) => JSON.parse(l).type === 'attempt_answered' && JSON.parse(l).attempt === 'attempt:2');
  fs.writeFileSync(branchFiles(j2).search, searchLines.slice(0, half + 1).join('\n') + '\n');
  const rec = JSON.parse(fs.readFileSync(j2, 'utf8')); rec.events = rec.events.filter((e: any) => e.type === 'branch_started'); fs.writeFileSync(j2, JSON.stringify(rec));
  const m2 = variant();
  await runEvolutionBranch({ journal: j2, spec: spec(dir2), mutator: m2, consolidate: counting().run, evaluator: () => ev(spec(dir2)) });
  const answered = fs.readFileSync(branchFiles(j2).search, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'attempt_answered');
  assert.equal(new Set(answered.map((e) => e.attempt)).size, answered.length, 'no attempt answered twice');
  assert.equal(m2.calls, answered.length - 2, 'only the attempts after the crash were asked');

  /* Cancelled during the search: it stops, keeps what it made, and never consolidates. */
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-cancel-'));
  const j3 = path.join(dir3, 'b.json');
  fs.writeFileSync(branchFiles(j3).inbox, JSON.stringify({ kind: 'stop', by: 'requester' }) + '\n');
  const c5 = counting();
  await runEvolutionBranch({ journal: j3, spec: spec(dir3), mutator: variant(), consolidate: c5.run, evaluator: () => ev(spec(dir3)) });
  const e3 = JSON.parse(fs.readFileSync(j3, 'utf8')).events;
  assert.equal(e3.find((e: any) => e.type === 'end').stoppedBy, 'cancelled');
  assert.equal(c5.calls.length, 0, 'no consolidation after a cancellation');
  assert.ok(!e3.some((e: any) => e.type === 'consolidation_requested'));
});

test('H2.3 settled with both phases; a failed consolidation or a partial search still delivers its candidates', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-settle-'));
  const journalFile = path.join(dir, 'run.json');
  const launched: string[] = [];
  const evolve = { seed: 1, options: spec(dir).options, isolated: false, resolveStart: () => ({ hash: 'base', files: { 'main.py': 'q=1' } }) };
  const d = new Delegations({ config: { fund: 10000, tokens: 4000, rounds: 1, maxRounds: 2, evolve: { evaluations: 3, workloads: 1 } }, journalFile, snapshot: () => ({ events: [] }), lab: 'artifacts@1',
    worldArgs: [], launcher: (l) => { launched.push(l.evolve!); }, log: () => {}, history: [], unsupported: null, evolve });
  const a = await d.run({ delegate: { mode: 'evolve', question: 'q', budget: { evaluations: 2 } } }, 1);
  assert.equal(a.state, 'accepted', JSON.stringify(a));
  const s = JSON.parse(fs.readFileSync(launched[0], 'utf8')) as EvolveBranchSpec;
  assert.equal(s.limits.evaluations, 2);
  assert.equal(s.limits.tokens + s.consolidation.tokens, 4000, 'the search\'s part and the consolidation\'s, protected');
  /* Its supervisor runs: the consolidation fails, the search stops at its evaluations. */
  const journal = path.join(dir, 'run.branches', 'delegation-r1.1.json');
  await runEvolutionBranch({ journal, spec: s, mutator: variant(), evaluator: () => fakeEvaluator(), consolidate: async () => { throw new Error('the model refused'); } });
  assert.equal(d.hasResults(), true);
  const [r] = d.results();
  const report = JSON.parse(r.text.slice(r.text.indexOf('environment): ') + 14));
  assert.ok(report.candidates.length >= 1, 'its candidates, though its consolidation failed');
  assert.equal(report.consolidation.state, 'unreviewed');
  assert.match(report.consolidation.why, /refused/);
  assert.equal(report.search.stoppedBy, 'evaluations', 'a partial search');
  const bf = JSON.parse(fs.readFileSync(branchFiles(journal).finding, 'utf8'));
  assert.equal(r.result_spent, bf.cost.total.llm_tokens, 'settled with what its finding totals');
  assert.ok(bf.cost.unknown.some((u: string) => /consolidation/.test(u)), 'the consolidation\'s cost said not known');

  /* Refused before anything is reserved. */
  assert.match(String((await d.run({ delegate: { mode: 'grow', question: 'q' } }, 2)).error), /"mode"/);
  assert.match(String((await d.run({ delegate: { mode: 'evolve', question: 'q', start: 'x', continue_from: 'y' } }, 2)).error), /not both/);
  assert.match(String((await d.run({ delegate: { mode: 'evolve', question: 'q', continue_from: 'nothing' } }, 2)).error), /continue_from/);
  const off = new Delegations({ config: { fund: 10000, tokens: 4000, rounds: 1, maxRounds: 2 }, journalFile: path.join(dir, 'other.json'), snapshot: () => ({ events: [] }), lab: 'cells@1',
    worldArgs: [], launcher: () => {}, log: () => {}, history: [], unsupported: null });
  assert.match(String((await off.run({ delegate: { mode: 'evolve', question: 'q' } }, 1)).error), /not enabled/);
  /* A capability not implemented in this delivery, or a field it does not know: refused, never ignored. */
  assert.match(String((await d.run({ delegate: { mode: 'evolve', question: 'q', analogies: ['a'] } }, 3)).error), /not implemented in this delivery: "analogies"/);
  assert.match(String((await d.run({ delegate: { question: 'q', analogies: ['a'] } }, 3)).error), /not implemented in this delivery/);
  assert.match(String((await d.run({ delegate: { mode: 'evolve', question: 'q', seeds: ['artifact:x'] } }, 3)).error), /"seeds": not enabled in this run/);
  assert.match(String((await d.run({ delegate: { question: 'q', seeds: ['artifact:x'] } }, 3)).error), /are of "mode": "evolve"/);
  assert.match(String((await d.run({ delegate: { mode: 'evolve', question: 'q', budget: { generations: 9 } } }, 3)).error), /unknown field\(s\): budget\.generations/);
  /* Isolation required where the sandbox gives none: refused before anything is spent. */
  const strict = new Delegations({ config: { fund: 10000, tokens: 4000, rounds: 1, maxRounds: 2, evolve: { evaluations: 3, workloads: 1, isolated: true } }, journalFile: path.join(dir, 'strict.json'),
    snapshot: () => ({ events: [] }), lab: 'artifacts@1', worldArgs: [], launcher: () => { throw new Error('never launched'); }, log: () => {}, history: [], unsupported: null, evolve });
  assert.match(String((await strict.run({ delegate: { mode: 'evolve', question: 'q' } }, 1)).error), /isolates files and network/);
  assert.equal(strict.fundLeft(), 10000, 'nothing reserved');
  /* What the requester suggested starting from reaches the consolidation's task. */
  assert.match(consolidationTask({ ...spec(dir), refs: ['model:r4', 'note:x'] }), /model:r4, note:x/);
});

test('H2.5 the branch\'s machine time and wall time bound the search; a sealed search tampered with is not verified', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-limits-'));
  const slow: Evaluator = { ...fakeEvaluator(), async evaluate(h: string) { await new Promise((r) => setTimeout(r, 30)); return { executable: true, correct: 'yes', quality: [1], descriptor: null, feedback: null, diagnostics: [], evaluator: 'fake' }; } };
  const m = await runSearch({ evaluator: slow, mutator: variant(), profile: balanced(0.05), question: 'q', limits: { evaluations: 50, attempts: 50, tokens: 1e9, machineSeconds: 0.08 }, out: path.join(dir, 's.jsonl') });
  assert.equal(m.manifest.stoppedBy, 'machine_seconds');
  assert.ok(m.manifest.cost.machine_seconds! >= 0.08);
  let clock = 1000;
  const w = await runSearch({ evaluator: fakeEvaluator(), mutator: { async propose(ctx: any) { clock += 400; return variant().propose(ctx); } }, profile: balanced(0.05), question: 'q',
    limits: { evaluations: 50, attempts: 50, tokens: 1e9 }, out: path.join(dir, 'w.jsonl'), deadline: 2000, now: () => clock });
  assert.equal(w.manifest.stoppedBy, 'wall_time');
  assert.ok(w.manifest.cost.attempts <= 3);
  /* Verified from its record; with its sealed state changed, not. */
  fs.writeFileSync(path.join(dir, 's.manifest.json'), JSON.stringify(m.manifest));
  assert.equal((await verifySearch(path.join(dir, 's.jsonl'), path.join(dir, 's.manifest.json'), () => null)).holds, false, 'a fake evaluator\'s programs are not artifacts: their hashes do not match');
  const journal = path.join(dir, 'b.json');
  await runEvolutionBranch({ journal, spec: spec(dir), mutator: variant(), consolidate: counting().run });
  const f = branchFiles(journal);
  const ok = await verifySearch(f.search, f.manifest, () => null);
  assert.equal(ok.holds, true, ok.why);
  const tampered = JSON.parse(fs.readFileSync(f.manifest, 'utf8'));
  tampered.state.elites = [];
  fs.writeFileSync(f.manifest, JSON.stringify(tampered));
  assert.equal((await verifySearch(f.search, f.manifest, () => null)).holds, false);
});

test('H2.4 a sealed search continued by a new delegation: its own reserve, the earlier cost apart, both packed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-continue-'));
  const journalFile = path.join(dir, 'run.json');
  const logged: any[] = [];
  const launched: { journal: string; evolve: string }[] = [];
  const evolve = { seed: 1, options: spec(dir).options, isolated: false, resolveStart: () => ({ hash: 'base', files: { 'main.py': 'q=1' } }) };
  const d = new Delegations({ config: { fund: 20000, tokens: 4000, rounds: 1, maxRounds: 2, evolve: { evaluations: 3, workloads: 1 } }, journalFile, snapshot: () => ({ events: [] }), lab: 'artifacts@1',
    worldArgs: [], launcher: (l) => { launched.push({ journal: l.journal, evolve: l.evolve! }); }, log: (type, data) => logged.push({ type, ...data }), history: [], unsupported: null, evolve });
  await d.run({ delegate: { mode: 'evolve', question: 'q' } }, 1);
  await runEvolutionBranch({ journal: launched[0].journal, spec: JSON.parse(fs.readFileSync(launched[0].evolve, 'utf8')), mutator: variant(), evaluator: () => fakeEvaluator(), consolidate: counting().run });
  const [first] = d.results();
  const sealed = JSON.parse(first.text.slice(first.text.indexOf('environment): ') + 14)).search.sealed;
  const b = await d.run({ delegate: { mode: 'evolve', question: 'go on', continue_from: sealed } }, 2);
  assert.equal(b.state, 'accepted', JSON.stringify(b));
  assert.equal(b.continue_from, sealed);
  const s2 = JSON.parse(fs.readFileSync(launched[1].evolve, 'utf8')) as EvolveBranchSpec;
  assert.ok(s2.continueFrom && s2.start === null);
  await runEvolutionBranch({ journal: launched[1].journal, spec: s2, mutator: variant(), evaluator: () => fakeEvaluator(), consolidate: counting().run });
  const m2 = JSON.parse(fs.readFileSync(branchFiles(launched[1].journal).manifest, 'utf8'));
  const m1 = JSON.parse(fs.readFileSync(branchFiles(launched[0].journal).manifest, 'utf8'));
  assert.deepEqual(m2.inherited, m1.cost, 'the earlier cost apart, never charged again');
  assert.equal(m2.state.attempts, m1.state.attempts + m2.cost.attempts, 'its attempts go on');
  /* Packed with the parent: both branches, their searches and manifests. */
  fs.writeFileSync(journalFile, JSON.stringify({ experiment: 'artifacts@1', config: {}, events: logged }));
  const files = packRun(journalFile, path.join(os.tmpdir(), 'evolve-pack-' + path.basename(dir))).manifest.files.map((f) => f.path);
  for (const j of launched) {
    const rel = path.relative(dir, j.journal).split(path.sep).join('/');
    for (const suffix of ['.json', '.search.jsonl', '.search.manifest.json', '.evolve.json']) assert.ok(files.includes(rel.replace(/\.json$/, suffix)), rel + suffix + ' packed');
  }
});

test('H4 seeds: from authorized sources by their ids, by content, measured again in the branch, roots of their own, verified', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-seeds-'));
  const journalFile = path.join(dir, 'run.json');
  const launched: { journal: string; evolve: string }[] = [];
  const base = artifactsLab.generate(1, spec(dir).options as never).world;
  const baseMain = base.store.get(base.reference)!.files.get('main.py')!;
  const mine = base.change(base.reference, { files: { 'main.py': baseMain + '\n# a version of mine\n' } }) as { version: string };
  const evolve = { seed: 1, options: spec(dir).options, isolated: false,
    resolveStart: (v?: string) => { const x = base.store.get(v ?? base.reference); return x ? { hash: v ?? base.reference, files: Object.fromEntries(x.files) } : { error: 'no version "' + v + '"' }; } };
  const d = new Delegations({ config: { fund: 50000, tokens: 4000, rounds: 1, maxRounds: 2, evolve: { evaluations: 4, workloads: 1, seeds: { max: 2, sources: ['own', 'searches'] } } }, journalFile,
    snapshot: () => ({ events: [] }), lab: 'artifacts@1', worldArgs: [], launcher: (l) => { launched.push({ journal: l.journal, evolve: l.evolve! }); }, log: () => {}, history: [], unsupported: null, evolve });
  /* Refused before anything is reserved: an unknown id, a source not authorized, too many. */
  assert.match(String((await d.run({ delegate: { mode: 'evolve', question: 'q', seeds: ['nonsense'] } }, 1)).error), /no such id/);
  assert.match(String((await d.run({ delegate: { mode: 'evolve', question: 'q', seeds: ['exp:exp1#artifact:x'] } }, 1)).error), /not authorized/);
  assert.match(String((await d.run({ delegate: { mode: 'evolve', question: 'q', seeds: ['artifact:a', 'artifact:b', 'artifact:c'] } }, 1)).error), /at most 2/);
  assert.match(String((await d.run({ delegate: { mode: 'evolve', question: 'q', seeds: ['artifact:missing'] } }, 1)).error), /no version "missing"/);
  assert.equal(d.fundLeft(), 50000, 'nothing reserved');
  const a = await d.run({ delegate: { mode: 'evolve', question: 'q', seeds: ['artifact:' + mine.version] } }, 1);
  assert.equal(a.state, 'accepted', JSON.stringify(a));
  const s = JSON.parse(fs.readFileSync(launched[0].evolve, 'utf8')) as EvolveBranchSpec;
  assert.deepEqual(s.seeds!.map((x) => [x.id, x.source, x.hash, x.knows_task]), [['artifact:' + mine.version, 'requester', mine.version, true]]);
  /* The supervisor: the seed measured in the branch's own laboratory, a root of its own lineage. */
  await runEvolutionBranch({ journal: launched[0].journal, spec: s, mutator: variant(), consolidate: counting().run });
  const f = branchFiles(launched[0].journal);
  const m = JSON.parse(fs.readFileSync(f.manifest, 'utf8'));
  const seeded = m.state.candidates[mine.version];
  assert.equal(seeded.origin, 'seed:artifact:' + mine.version);
  assert.deepEqual(seeded.roots, [mine.version], 'a root of its own');
  assert.ok(seeded.evaluation, 'measured here');
  assert.ok(fs.readFileSync(f.search, 'utf8').includes('"origin":"seed"'));
  assert.equal((await verifySearch(f.search, f.manifest, () => null)).holds, true, 'verified with its seeds');
  /* A candidate of that sealed search, as a seed of the next branch. */
  d.results();
  const other = m.state.order.find((h: string) => h !== m.state.order[0] && h !== mine.version);
  const b = await d.run({ delegate: { mode: 'evolve', question: 'q2', seeds: ['search:' + m.hash + '#candidate:' + other] } }, 2);
  assert.equal(b.state, 'accepted', JSON.stringify(b));
  assert.equal((JSON.parse(fs.readFileSync(launched[1].evolve, 'utf8')) as EvolveBranchSpec).seeds![0].hash, other);
  /* A seed whose content is not what it says is refused by the branch, the search goes on without it. */
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-seeds2-'));
  const j2 = path.join(dir2, 'b.json');
  await runEvolutionBranch({ journal: j2, spec: spec(dir2, { seeds: [{ id: 'artifact:fake', source: 'requester', hash: 'f'.repeat(16), files: { 'main.py': 'x' }, knows_task: true }] }), mutator: variant(), consolidate: counting().run });
  assert.ok(fs.readFileSync(branchFiles(j2).search, 'utf8').includes('"type":"seed_refused"'));
  /* Not enabled in a run without seeds: refused. */
  const off = new Delegations({ config: { fund: 50000, tokens: 4000, rounds: 1, maxRounds: 2, evolve: { evaluations: 4, workloads: 1 } }, journalFile: path.join(dir, 'o.json'),
    snapshot: () => ({ events: [] }), lab: 'artifacts@1', worldArgs: [], launcher: () => {}, log: () => {}, history: [], unsupported: null, evolve });
  assert.match(String((await off.run({ delegate: { mode: 'evolve', question: 'q', seeds: ['artifact:' + mine.version] } }, 1)).error), /not enabled/);
});

test('H4 a seed from a run read as experience: its world made again from its record, the version found there by content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-expseed-'));
  const options = spec(dir).options;
  const w = artifactsLab.generate(1, options as never).world;
  const files = { 'main.py': w.store.get(w.reference)!.files.get('main.py')! + '\n# from an earlier run\n' };
  const made = w.change(w.reference, { files }) as { version: string };
  const journal = { experiment: 'artifacts@1', config: { seed: 1, ...options }, world_archive: w.archiveBase(),
    events: [{ type: 'investigation', round: 1, requests: [{ act: { change: { from: w.reference, files, why: 'w', exploratory: true } } }] }] };
  const cap = evolveCapability('artifacts@1', 1, options, () => w, () => [{ label: 'exp1', journal }])!;
  const got = cap.resolveExperience!('exp1', made.version);
  assert.ok('hash' in got && got.hash === made.version && got.files['main.py'] === files['main.py'], JSON.stringify(got).slice(0, 200));
  assert.match(String((cap.resolveExperience!('exp2', made.version) as { error: string }).error), /no run "exp2"/);
  assert.match(String((cap.resolveExperience!('exp1', 'nope') as { error: string }).error), /no version "nope"/);
  assert.equal(evolveCapability('cells@1', 1, {}, () => w), undefined, 'no evaluator for an evolutionary search there');
});

