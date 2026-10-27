import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stableStringify } from '../src/core/hash.ts';
import { labCli } from '../src/runtime/cli.ts';
import { packRun } from '../src/runtime/package.ts';
import { artifactsLab } from '../src/worlds/artifacts/lab.ts';
import { runEvolutionBranch, branchFiles, type EvolveBranchSpec } from '../src/runtime/evolve-branch.ts';
import { Delegations } from '../src/learn/assisted/delegation.ts';
import { runSearch, type Evaluator, type Mutator } from '../src/learn/evolve/engine.ts';
import { balanced } from '../src/learn/evolve/policy.ts';
import { artifactEvaluator } from '../src/learn/evolve/artifacts.ts';
import { verifySearch } from '../src/learn/evolve/verify.ts';
import { ArtifactWorld } from '../src/artifacts/world.ts';
import { processSandbox } from '../src/artifacts/sandbox.ts';
import { threesumSubquadraticTask } from '../src/artifacts/tasks/threesum.ts';

/* An external review of the evolutionary search (25/10/2026), reconciled - each finding with the case that reproduced it. */

function fakeEvaluator(identity = 'fake'): Evaluator & { calls: number } {
  const versions = new Map<string, Record<string, string>>();
  const hashOf = (f: Record<string, string>) => createHash('sha256').update(stableStringify(f)).digest('hex').slice(0, 12);
  const start = { 'main.py': 'name=A q=1 ok=yes' };
  versions.set(hashOf(start), start);
  const ev = { calls: 0, async identity() { return identity; }, contract: () => ({}), start: () => ({ hash: hashOf(start), files: start }), validate: () => null,
    materialize(from: string, files: Readonly<Record<string, string | null>>) { const m: Record<string, string> = { ...versions.get(from)! }; for (const [k, v] of Object.entries(files)) { if (v === null) delete m[k]; else m[k] = v; } const h = hashOf(m); versions.set(h, m); return { hash: h, files: m }; },
    adopt(h: string, files: Readonly<Record<string, string>>) { versions.set(h, { ...files }); return null; },
    async evaluate(h: string) {
      ev.calls++;
      const t = versions.get(h)!['main.py'];
      const q = /q=(\S+)/.exec(t)?.[1], ok = /ok=(\w+)/.exec(t)?.[1] ?? 'yes';
      return { executable: true, correct: (ok === 'yes' ? 'yes' : 'no') as 'yes' | 'no', quality: [Number(q ?? 1)], descriptor: null, feedback: null, diagnostics: ok === 'yes' ? [] : ['wrong'], evaluator: identity };
    } };
  return ev;
}
const answer = (main: string) => JSON.stringify({ files: { 'main.py': main }, why: 'w' });
const textOf = (ctx: any): string => ctx.parent?.files?.['main.py'] ?? ctx.program?.files?.['main.py'] ?? ctx.parents?.[0]?.files?.['main.py'] ?? '';
const scripted = (rule: (ctx: any, n: number) => string): Mutator & { calls: number } => { const m = { calls: 0, async propose(ctx: any) { m.calls++; return { text: rule(ctx, m.calls), tokens: 10 }; } }; return m; };
const counting = () => { const c = { calls: [] as string[][], signals: [] as AbortSignal[], async run(a: readonly string[], signal: AbortSignal) { c.calls.push([...a]); c.signals.push(signal); const out = a[a.indexOf('--out') + 1];
  fs.writeFileSync(out, JSON.stringify({ events: [{ type: 'end', stoppedBy: 'budget', notebook: { beliefs: [], notes: [] } }] }));
  fs.writeFileSync(out.replace(/\.json$/, '.finding.json'), JSON.stringify({ cost: { total: { llm_tokens: 70 } } })); } };
  return c; };
const spec = (dir: string, extra: Partial<EvolveBranchSpec> = {}): EvolveBranchSpec => {
  const cut = path.join(dir, 'cut.json');
  fs.writeFileSync(cut, JSON.stringify({ events: [{ type: 'end' }] }));
  return { format: 'evolution-branch@1', id: 'delegation:r1.1', question: 'q', expected: null, refs: [], cut, seed: 1, options: { artifact: 'dedup', scale: '0.1', acts: '3', tolerance: '0.25', workloads: '1' },
    worldArgs: [], start: null, continueFrom: null, exploration: { workloads: 1, seed: 5 }, limits: { evaluations: 4, attempts: 8, tokens: 10000 }, consolidation: { tokens: 1000, rounds: 1 }, ...extra };
};

test('a search resumed past its deadline recovers its whole record first, and its file is never cut', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evrev-deadline-'));
  const out = path.join(dir, 's.jsonl');
  const first = await runSearch({ evaluator: fakeEvaluator(), mutator: scripted((_c, n) => answer('name=J' + n + ' q=' + (2 + n))), profile: balanced(0.05), question: 'q',
    limits: { evaluations: 3, attempts: 3, tokens: 1e9 }, out });
  const recorded = fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(first.manifest.state.order.length, 3);
  const never = scripted(() => { throw new Error('nothing new past the deadline'); });
  const again = await runSearch({ evaluator: fakeEvaluator(), mutator: never, profile: balanced(0.05), question: 'q', limits: { evaluations: 3, attempts: 3, tokens: 1e9 }, out,
    recorded, live: true, deadline: 0, now: () => 1 });
  assert.equal(again.manifest.state.order.length, 3, 'its 3 candidates');
  assert.equal(again.manifest.cost.tokens, first.manifest.cost.tokens, 'its tokens');
  assert.equal(stableStringify(again.manifest.state), stableStringify(first.manifest.state));
  const after = fs.readFileSync(out, 'utf8').split('\n').filter(Boolean);
  assert.ok(after.length >= recorded.length && after.slice(0, recorded.length).every((l, i) => l === JSON.stringify(recorded[i])), 'what it held, kept as it was');
});

test('lab verify fails where a search does not hold, and says why; a broken seal or an altered cost is not verified', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evrev-verify-'));
  const journal = path.join(dir, 'run.branches', 'delegation-r1.1.json');
  fs.mkdirSync(path.dirname(journal), { recursive: true });
  const s = spec(dir);
  fs.writeFileSync(journal.replace(/\.json$/, '.evolve.json'), JSON.stringify(s));
  await runEvolutionBranch({ journal, spec: s, mutator: scripted((c, n) => answer(textOf(c) + '\n# v' + n + '\n')), consolidate: counting().run });
  const f = branchFiles(journal);
  const world = artifactsLab.generate(1, s.options as never).world as ArtifactWorld;
  assert.equal((await verifySearch(f.search, f.manifest, () => null, world.task)).holds, true, 'its verdicts computed again from their evidence');
  const sealed = JSON.parse(fs.readFileSync(f.manifest, 'utf8'));
  fs.writeFileSync(f.manifest, JSON.stringify({ ...sealed, cost: { ...sealed.cost, tokens: 0 } }));
  assert.match((await verifySearch(f.search, f.manifest, () => null)).why, /seal is broken/);
  /* An evaluation whose evidence was altered: its verdict computed again is not the one recorded. */
  fs.writeFileSync(f.manifest, JSON.stringify(sealed));
  const lines = fs.readFileSync(f.search, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const ev = lines.find((e) => e.type === 'evaluation');
  for (const w of ev.evidence[0].runs) for (const r of w.candidate) if (r.output) r.output = { text: 'not the answer' };
  const tampered = path.join(dir, 'tampered.jsonl');
  fs.writeFileSync(tampered, lines.map((e) => JSON.stringify(e)).join('\n') + '\n');
  assert.match((await verifySearch(tampered, f.manifest, () => null, world.task)).why, /not the one recorded/);
  /* The command: its result counts the searches. */
  const run = path.join(dir, 'run.json');
  fs.writeFileSync(run, JSON.stringify({ experiment: 'nowhere@1', config: {}, events: [{ type: 'delegation_requested', id: 'delegation:r1.1', journal: 'run.branches/delegation-r1.1.json' }, { type: 'end', stoppedBy: 'budget' }] }));
  const pack = packRun(run, path.join(os.tmpdir(), 'evrev-pack-' + path.basename(dir))).dir;
  const packedManifest = path.join(pack, 'run.branches', 'delegation-r1.1.search.manifest.json');
  fs.writeFileSync(packedManifest, JSON.stringify({ ...sealed, cost: { ...sealed.cost, tokens: 0 } }));
  const said: string[] = [];
  await labCli(['verify', pack], { root: dir, out: (l) => said.push(l), env: {} });
  assert.ok(said.some((l) => /evolutionary search .*does NOT hold - its seal is broken/.test(l)), said.join('\n'));
});

test('the branch\'s budget and time bound its confirmations and its consolidation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evrev-limits-'));
  const journal = path.join(dir, 'b.json');
  let evaluations = 0;
  const counted = (): Evaluator => { const e = fakeEvaluator(); const inner = e.evaluate.bind(e); return { ...e, async evaluate(h: string) { evaluations++; return inner(h); } }; };
  await runEvolutionBranch({ journal, spec: spec(dir, { limits: { evaluations: 3, attempts: 8, tokens: 10000 }, confirmations: 1 }), mutator: scripted((c, n) => answer(textOf(c) + ' #' + n)), consolidate: counting().run, evaluator: counted });
  assert.ok(evaluations <= 4, 'the search and its confirmations within the 4 granted: ' + evaluations);
  const done = JSON.parse(fs.readFileSync(journal, 'utf8')).events.find((e: any) => e.type === 'search_finished');
  assert.equal(done.cost.evaluations, evaluations, 'every one counted');
  assert.ok(done.confirmations.some((c: any) => c.not_confirmed === 'its evaluations are spent'), 'a candidate beyond them: not confirmed, and why');
  /* Its wall time spent when its search ends: no consolidation, delivered unreviewed. */
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'evrev-wall-'));
  const j2 = path.join(dir2, 'b.json');
  const c = counting();
  const slow = scripted((ctx, n) => { const until = Date.now() + 40; while (Date.now() < until) { /* time passes */ } return answer(textOf(ctx) + ' #' + n); });
  await runEvolutionBranch({ journal: j2, spec: spec(dir2, { wallSeconds: 0.05 }), mutator: slow, consolidate: c.run, evaluator: () => fakeEvaluator() });
  const ev2 = JSON.parse(fs.readFileSync(j2, 'utf8')).events;
  assert.equal(c.calls.length, 0, 'never a consolidation past its wall time');
  assert.ok(ev2.some((e: any) => e.type === 'consolidation_skipped'));
  assert.equal(ev2.find((e: any) => e.type === 'end').consolidation.state, 'unreviewed');
});

test('a branch\'s stop reaches its consolidation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evrev-stop-'));
  const journal = path.join(dir, 'b.json');
  const consolidate = async (a: readonly string[], signal: AbortSignal) => {
    fs.appendFileSync(branchFiles(journal).inbox, JSON.stringify({ kind: 'stop', by: 'requester' }) + '\n');
    const until = Date.now() + 5000;
    while (!signal.aborted && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
    assert.ok(signal.aborted, 'the stop reached it');
    const out = a[a.indexOf('--out') + 1];
    fs.writeFileSync(out, JSON.stringify({ events: [{ type: 'end', stoppedBy: 'cancelled', notebook: { beliefs: [], notes: [] } }] }));
  };
  await runEvolutionBranch({ journal, spec: spec(dir), mutator: scripted((c, n) => answer(textOf(c) + ' #' + n)), consolidate, evaluator: () => fakeEvaluator(), heartbeatMs: 10 });
  assert.equal(JSON.parse(fs.readFileSync(journal, 'utf8')).events.find((e: any) => e.type === 'end').stoppedBy, 'cancelled');
});

test('a spending its branch does not know is held at its grant, never released', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evrev-held-'));
  const launched: { journal: string; evolve: string }[] = [];
  const d = new Delegations({ config: { fund: 5000, tokens: 1000, rounds: 1, maxRounds: 1, evolve: { evaluations: 3, workloads: 1 } }, journalFile: path.join(dir, 'run.json'), snapshot: () => ({ events: [] }), lab: 'artifacts@1',
    worldArgs: [], launcher: (l) => { launched.push({ journal: l.journal, evolve: l.evolve! }); }, log: () => {}, history: [], unsupported: null,
    evolve: { seed: 1, options: spec(dir).options, isolated: false, resolveStart: () => ({ hash: 'base', files: { 'main.py': 'name=A q=1 ok=yes' } }) } });
  await d.run({ delegate: { mode: 'evolve', question: 'q' } }, 1);
  const noUsage: Mutator = { async propose(ctx: any) { return { text: answer(textOf(ctx) + ' #'), tokens: null }; } };
  await runEvolutionBranch({ journal: launched[0].journal, spec: JSON.parse(fs.readFileSync(launched[0].evolve, 'utf8')), mutator: noUsage, evaluator: () => fakeEvaluator(), consolidate: async () => { throw new Error('refused'); } });
  const [r] = d.results();
  assert.deepEqual(r.result_spent_uncertain, { at_least: 0, held: 1000 }, 'held, not released');
  assert.equal(d.fundLeft(), 4000, 'the fund still holds its grant');
});

test('a restart is given the whole contract of the input and the output, without the parent\'s code', async () => {
  const world = new ArtifactWorld(threesumSubquadraticTask({ scale: 0.05 }), processSandbox());
  const ev = artifactEvaluator(world, { families: ['ladder'], workloads: 1, seed: 3 });
  await ev.identity();
  const c = ev.contract() as any;
  assert.match(c.io.command, /python src\/main\.py/);
  assert.ok(c.io.inputs['input.txt'].text.length > 0, 'an input as it is given');
  assert.deepEqual(c.io.outputs, ['out.txt']);
  assert.match(String(c.io.example.reference_answers.text), /^(yes|no)$/, 'what the reference answers there');
  assert.ok(!JSON.stringify(c).includes('lo, hi'), 'never the code');
});

test('a failing chain of repairs gets one slot, never one after another', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evrev-repair-'));
  const m = scripted((ctx, n) => {
    const t = textOf(ctx);
    if (ctx.operator === 'repair') return answer('name=F' + n + ' q=0.1 ok=no');
    if (t.startsWith('name=A ') && n === 1) return answer('name=F0 q=0.1 ok=no');
    return answer('name=J' + n + ' q=' + (3 + n));
  });
  const { manifest } = await runSearch({ evaluator: fakeEvaluator(), mutator: m, profile: balanced(0.05), question: 'q', limits: { evaluations: 30, attempts: 30, tokens: 1e9 }, out: path.join(dir, 's.jsonl') });
  const log = manifest.state.log;
  assert.equal(log.filter((e) => e.event === 'repair_admitted').length, 1, 'one slot for the chain: ' + JSON.stringify(log.filter((e) => String(e.event).startsWith('repair'))));
  assert.ok(log.some((e) => e.event === 'repair_exhausted'), 'its quota ran out: no slot of its own after');
});

test('a continuation with another evaluator keeps its elites until they are measured again', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evrev-elites-'));
  const first = await runSearch({ evaluator: fakeEvaluator('fake@1'), mutator: scripted((_c, n) => answer('name=J' + n + ' q=' + (0.5 / n))), profile: balanced(0.05), question: 'q',
    limits: { evaluations: 5, attempts: 5, tokens: 1e9 }, out: path.join(dir, 'a.jsonl') });
  const elites = first.manifest.state.elites;
  assert.ok(elites.length >= 2);
  const moved = await runSearch({ evaluator: fakeEvaluator('fake@2'), mutator: scripted((_c, n) => answer('name=K' + n + ' q=9')), profile: balanced(0.05), question: 'q',
    limits: { evaluations: 20, attempts: 1, tokens: 1e9 }, out: path.join(dir, 'b.jsonl'), continueFrom: first.manifest });
  const remeasured = moved.events.filter((e) => e.type === 'evaluation_planned' && e.reevaluation).map((e) => e.hash);
  for (const h of elites) assert.ok(remeasured.includes(h), 'elite ' + h + ' measured again');
  assert.deepEqual(moved.manifest.state.elites.slice(0, elites.length), elites, 'still its elites, measured again');
});

/* A second review of the same changes (25/10/2026), reconciled. */

test('a branch whose consolidation was skipped still delivers its result', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evrev2-skip-'));
  const launched: { journal: string; evolve: string }[] = [];
  const d = new Delegations({ config: { fund: 5000, tokens: 1000, rounds: 1, maxRounds: 1, evolve: { evaluations: 3, workloads: 1, wallSeconds: 0.05 } }, journalFile: path.join(dir, 'run.json'), snapshot: () => ({ events: [] }), lab: 'artifacts@1',
    worldArgs: [], launcher: (l) => { launched.push({ journal: l.journal, evolve: l.evolve! }); }, log: () => {}, history: [], unsupported: null,
    evolve: { seed: 1, options: spec(dir).options, isolated: false, resolveStart: () => ({ hash: 'base', files: { 'main.py': 'name=A q=1 ok=yes' } }) } });
  await d.run({ delegate: { mode: 'evolve', question: 'q' } }, 1);
  const slow = scripted((ctx, n) => { const until = Date.now() + 40; while (Date.now() < until) { /* time passes */ } return answer(textOf(ctx) + ' #' + n); });
  await runEvolutionBranch({ journal: launched[0].journal, spec: JSON.parse(fs.readFileSync(launched[0].evolve, 'utf8')), mutator: slow, evaluator: () => fakeEvaluator(), consolidate: counting().run });
  const [r] = d.results();
  const report = JSON.parse(r.text.slice(r.text.indexOf('environment): ') + 14));
  assert.equal(report.consolidation.state, 'unreviewed');
  assert.match(report.consolidation.why, /wall time/);
});

test('a call whose answer is not known keeps its spending not known: the grant held, never released', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evrev2-uncertain-'));
  const launched: { journal: string; evolve: string }[] = [];
  const d = new Delegations({ config: { fund: 5000, tokens: 1000, rounds: 1, maxRounds: 1, evolve: { evaluations: 4, workloads: 1 } }, journalFile: path.join(dir, 'run.json'), snapshot: () => ({ events: [] }), lab: 'artifacts@1',
    worldArgs: [], launcher: (l) => { launched.push({ journal: l.journal, evolve: l.evolve! }); }, log: () => {}, history: [], unsupported: null,
    evolve: { seed: 1, options: spec(dir).options, isolated: false, resolveStart: () => ({ hash: 'base', files: { 'main.py': 'name=A q=1 ok=yes' } }) } });
  await d.run({ delegate: { mode: 'evolve', question: 'q' } }, 1);
  const s = JSON.parse(fs.readFileSync(launched[0].evolve, 'utf8'));
  const journal = launched[0].journal;
  await runEvolutionBranch({ journal, spec: s, mutator: scripted((c, n) => answer(textOf(c) + ' #' + n)), evaluator: () => fakeEvaluator(), consolidate: counting().run });
  /* It fell after planning its first attempt, before the answer. */
  const f = branchFiles(journal);
  const lines = fs.readFileSync(f.search, 'utf8').split('\n').filter(Boolean);
  const cut = lines.findIndex((l) => JSON.parse(l).type === 'attempt_planned');
  fs.writeFileSync(f.search, lines.slice(0, cut + 1).join('\n') + '\n');
  const rec = JSON.parse(fs.readFileSync(journal, 'utf8')); rec.events = rec.events.filter((e: any) => e.type === 'branch_started'); fs.writeFileSync(journal, JSON.stringify(rec));
  for (const x of [f.manifest, f.finding]) fs.rmSync(x, { force: true });
  await runEvolutionBranch({ journal, spec: s, mutator: scripted((c, n) => answer(textOf(c) + ' #' + n)), evaluator: () => fakeEvaluator(), consolidate: counting().run });
  const done = JSON.parse(fs.readFileSync(journal, 'utf8')).events.find((e: any) => e.type === 'search_finished');
  assert.ok(done.cost.tokens_unknown >= 1, 'not known, never zero');
  const [r] = d.results();
  assert.equal(r.result_spent_uncertain?.held, 1000, 'its grant held');
  assert.equal(d.fundLeft(), 4000);
});

test('a search ended by its wall time or a cancellation is verified, ending as it did', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evrev2-verify-'));
  for (const how of ['wall_time', 'cancelled'] as const) {
    const journal = path.join(dir, how, 'b.json');
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    const s = spec(path.dirname(journal), how === 'wall_time' ? { wallSeconds: 0.3, limits: { evaluations: 50, attempts: 50, tokens: 1e9 } } : { limits: { evaluations: 50, attempts: 50, tokens: 1e9 } });
    let n = 0;
    const m = scripted((c, k) => {
      n++;
      if (how === 'cancelled' && n === 3) fs.appendFileSync(branchFiles(journal).inbox, JSON.stringify({ kind: 'stop' }) + '\n');
      const until = Date.now() + (how === 'wall_time' ? 60 : 30); while (Date.now() < until) { /* time passes */ }
      return answer(textOf(c) + '\n# ' + k + '\n');
    });
    await runEvolutionBranch({ journal, spec: s, mutator: m, consolidate: counting().run, heartbeatMs: 5 });
    const f = branchFiles(journal);
    const sealed = JSON.parse(fs.readFileSync(f.manifest, 'utf8'));
    assert.equal(sealed.stoppedBy, how);
    const v = await verifySearch(f.search, f.manifest, () => null);
    assert.equal(v.holds, true, how + ': ' + v.why);
  }
});

test('elites waiting to be measured again stay queued while the selection is computed again', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evrev2-queue-'));
  /* B better than A; out of development by the end, in no archive. */
  const profile = { ...balanced(0.05), developmentQuota: 1 };
  const first = await runSearch({ evaluator: fakeEvaluator('fake@1'), mutator: scripted((_c, n) => answer(n === 1 ? 'name=B q=0.5' : 'name=J' + n + ' q=' + (5 + n))), profile, question: 'q',
    limits: { evaluations: 6, attempts: 6, tokens: 1e9 }, out: path.join(dir, 'a.jsonl') });
  const s = first.manifest.state;
  const B = s.order.find((h) => s.candidates[h].files['main.py'].startsWith('name=B '))!;
  assert.ok(s.elites.includes(B) && !s.development.some((d) => d.hash === B), JSON.stringify([s.elites, s.development]));
  const moved = await runSearch({ evaluator: fakeEvaluator('fake@2'), mutator: scripted(() => answer('name=K q=9')), profile, question: 'q',
    limits: { evaluations: 20, attempts: 1, tokens: 1e9 }, out: path.join(dir, 'b.jsonl'), continueFrom: first.manifest });
  const remeasured = moved.events.filter((e) => e.type === 'evaluation_planned' && e.reevaluation).map((e) => e.hash);
  for (const h of s.elites) assert.ok(remeasured.includes(h), 'measured again: ' + h);
  assert.equal(moved.manifest.state.elites[0], B, 'B still the best, measured again');
});

test('a consolidation is never given a bound of zero: with too little time left it is not started', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evrev2-zero-'));
  const journal = path.join(dir, 'b.json');
  const c = counting();
  /* Its search ends with about half a second left of its wall time. */
  const m = scripted((ctx, n) => { if (n === 1) { const until = Date.now() + 500; while (Date.now() < until) { /* time passes */ } } return answer(textOf(ctx) + ' #' + n); });
  await runEvolutionBranch({ journal, spec: spec(dir, { wallSeconds: 1, limits: { evaluations: 2, attempts: 1, tokens: 1e9 } }), mutator: m, consolidate: c.run, evaluator: () => fakeEvaluator() });
  for (const a of c.calls) { const i = a.indexOf('--max-minutes'); assert.ok(i < 0 || Number(a[i + 1]) > 0, 'never a bound of zero: ' + a[i + 1]); }
  const evs = JSON.parse(fs.readFileSync(journal, 'utf8')).events;
  if (!c.calls.length) assert.ok(evs.some((e: any) => e.type === 'consolidation_skipped'));
});

/* A review of the battery (25/10/2026): a branch reads the runs its requester reads, under the same labels. */

test('a branch reads what its requester reads as experience, under the same labels, its requester\'s record after them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evrev3-exp-'));
  const files = [path.join(dir, 'run6.json'), path.join(dir, 'run7.json')];
  const launched: { args: readonly string[]; evolve?: string }[] = [];
  const d = new Delegations({ config: { fund: 50000, tokens: 1000, rounds: 1, maxRounds: 1, evolve: { evaluations: 3, workloads: 1 } }, journalFile: path.join(dir, 'run.json'), snapshot: () => ({ events: [] }), lab: 'artifacts@1',
    worldArgs: [], launcher: (l) => { launched.push({ args: l.args, ...(l.evolve ? { evolve: l.evolve } : {}) }); }, log: () => {}, history: [], unsupported: null, experience: files,
    evolve: { seed: 1, options: spec(dir).options, isolated: false, resolveStart: () => ({ hash: 'base', files: { 'main.py': 'name=A q=1 ok=yes' } }) } });
  assert.equal((await d.run({ delegate: { question: 'find a direction past the stall' } }, 1)).state, 'accepted');
  const args = launched[0].args;
  const given = args[args.indexOf('--experience') + 1].split(',');
  assert.deepEqual(given.slice(0, 2), files, 'the same runs, in the same order: exp1 and exp2 as its requester calls them');
  assert.match(given[2], /delegation-r1\.1\.cut\.json$/, 'its requester\'s record after them');
  const task = args[args.indexOf('--task') + 1];
  assert.match(task, /readable as experience \(run "exp3"\)/);
  assert.match(task, /under the same labels it uses: exp1, exp2/);
  /* An evolutionary branch: its consolidation reads them too. */
  d.results();
  const dd = new Delegations({ config: { fund: 50000, tokens: 1000, rounds: 1, maxRounds: 1, evolve: { evaluations: 3, workloads: 1 } }, journalFile: path.join(dir, 'run2.json'), snapshot: () => ({ events: [] }), lab: 'artifacts@1',
    worldArgs: [], launcher: (l) => { launched.push({ args: l.args, ...(l.evolve ? { evolve: l.evolve } : {}) }); }, log: () => {}, history: [], unsupported: null, experience: files,
    evolve: { seed: 1, options: spec(dir).options, isolated: false, resolveStart: () => ({ hash: 'base', files: { 'main.py': 'name=A q=1 ok=yes' } }) } });
  assert.equal((await dd.run({ delegate: { mode: 'evolve', question: 'q' } }, 1)).state, 'accepted');
  const s = JSON.parse(fs.readFileSync(launched[1].evolve!, 'utf8')) as EvolveBranchSpec;
  assert.deepEqual(s.experience, files);
  const c = counting();
  await runEvolutionBranch({ journal: path.join(dir, 'b.json'), spec: { ...s, cut: spec(dir).cut }, mutator: scripted((x, n) => answer(textOf(x) + ' #' + n)), evaluator: () => fakeEvaluator(), consolidate: c.run });
  const ca = c.calls[0];
  assert.deepEqual(ca[ca.indexOf('--experience') + 1].split(',').slice(0, 2), files);
  assert.match(ca[ca.indexOf('--task') + 1], /run "exp3"/);
});

test('the senior takes seeds from the runs its junior reads, under the junior\'s labels', async () => {
  const { juniorExperienceOf } = await import('../src/orchestra/agent-operator.ts');
  const { evolveCapability } = await import('../src/runtime/evolve-branch.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evrev3-senior-'));
  const options = spec(dir).options;
  const w = artifactsLab.generate(1, options as never).world;
  const files = { 'main.py': w.store.get(w.reference)!.files.get('main.py')! + '\n# an earlier run\n' };
  const made = w.change(w.reference, { files }) as { version: string };
  fs.writeFileSync(path.join(dir, 'earlier.json'), JSON.stringify({ experiment: 'artifacts@1', config: { seed: 1, ...options }, world_archive: w.archiveBase(),
    events: [{ type: 'investigation', round: 1, requests: [{ act: { change: { from: w.reference, files, why: 'w', exploratory: true } } }] }, { type: 'end' }] }));
  const { files: read, catalog } = juniorExperienceOf({ experience: 'earlier.json' }, dir);
  assert.deepEqual(read, [path.join(dir, 'earlier.json')], 'resolved as the junior resolved it');
  const cap = evolveCapability('artifacts@1', 1, options, () => w, catalog)!;
  const got = cap.resolveExperience!('exp1', made.version);
  assert.ok('hash' in got && got.hash === made.version, JSON.stringify(got).slice(0, 120));
});
