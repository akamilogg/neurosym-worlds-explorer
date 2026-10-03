import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { gridLab } from '../src/worlds/grid/lab.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';
import { Experience } from '../src/learn/assisted/experience.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';

/* SPEC-INVESTIGADOR-ASISTIDO §12: the assisted researcher may read the records of earlier runs - only what their researchers
   saw - in two modes kept apart: transfer (other worlds only) and meta (this same world too). */

/** A finished journal with something of every kind, and secrets only the operator holds. */
const journal = (over: Record<string, unknown> = {}) => ({
  experiment: 'cells@1', researcher: 'assisted', config: { seed: 7, level: 1, llm_model: 'm' },
  hidden_from_the_learner: { truth: 'SECRET-TRUTH' },
  events: [
    /* As the runner logs them: the id, and beside it what only the operator's journal keeps of the episode. */
    { type: 'exploration_episode', episode: 'ep1', place: 'lab1', from: 'the environment', rows: ['SECRET-ROWS'] },
    { type: 'exploration_launch', launch: 'L1', setup: 'lab1', from: 'the environment', table: 'SECRET-TABLE' },
    { type: 'investigation', round: 1, requests: [{ view: 'ep1', from: 0, to: 2 }], results: [{ rows: ['..#'] }], notes: [{ do: 'write', id: 'edge', text: 'the right edge grows' }] },
    { type: 'methods', round: 1, methods: [{ do: 'write', id: 'pair', text: 'change one thing at a time from the same point' }] },
    { type: 'operator_message', question: 2, messages: [{ id: 'm1', text: 'SECRET-HINT' }] },
    { type: 'proposal', round: 1, law: { rule: 'r' }, fingerprint: 'f1', rationale: 'the edge grows', beliefs: [{ id: 'grow', stance: 'new', statement: 'cells at the right edge grow', evidence: ['ep1@1'] }], lessons: ['l'] },
    { type: 'check', round: 1, laboratories: [{ place: 'lab1', holds: true, points: 3 }], operator_analysis: { surprises: 'SECRET-ANALYSIS' } },
    { type: 'operator_rule_recovery', score: 1, grades: [{ id: 'x', evidence: 'SECRET-GRADE' }] },
    { type: 'end', stoppedBy: 'budget' }
  ],
  ...over
});

test('it reads what the researchers saw, by a label, and nothing only the operator holds', async () => {
  const x = new Experience([{ label: 'exp1', journal: journal(), sameWorld: false }, { label: 'exp2', journal: journal({ researcher: 'unknown-world' }), sameWorld: true }]);
  const runs = await x.run({ experience: 'runs' }) as any;
  assert.deepEqual(runs.runs.map((r: any) => [r.run, r.environment, r.researcher]), [['exp1', 'another', 'assisted'], ['exp2', 'this same one', 'unaided']]);
  const listed = await x.run({ experience: 'list', run: 'exp1', of: 'beliefs' }) as any;
  assert.deepEqual(listed.index.map((i: any) => i.id), ['belief:grow']);
  const opened = await x.run({ experience: 'open', run: 'exp1', items: ['note:edge', 'investigation:r1.1', 'check:r1', 'episode:ep1', 'episode:L1'] }) as any;
  assert.equal(opened.items.filter((i: any) => i.item).length, 5, 'every item there, the exploration episodes of a world of laws too');
  const episodes = await x.run({ experience: 'list', run: 'exp1', of: 'episodes' }) as any;
  assert.deepEqual(episodes.index.map((i: any) => i.id), ['episode:ep1', 'episode:L1']);
  const found = await x.run({ experience: 'find', words: 'edge' }) as any;
  assert.deepEqual(found.runs.map((r: any) => r.run), ['exp1', 'exp2'], 'a find with no run reads every run');
  assert.ok(found.runs[0].matches >= 2);
  assert.match(JSON.stringify(await x.run({ experience: 'list', run: 'exp9', of: 'notes' })), /no such run/);
  assert.match(JSON.stringify(await x.run({ experience: 'open', items: ['note:edge'] })), /which run \(exp1, exp2\)/);
  /* Everything it could be answered: never the truth, the operator's messages, measures or grades, nor a file name. */
  const all = JSON.stringify([runs, listed, opened, found, episodes, ...await Promise.all(['beliefs', 'notes', 'methods', 'episodes', 'models', 'reflections', 'investigations', 'checks']
    .map(async (of) => { const l = await x.run({ experience: 'list', run: 'exp1', of }) as any; return x.run({ experience: 'open', run: 'exp1', items: (l.index ?? []).map((i: any) => i.id), whole: true }); }))]);
  assert.ok(!/SECRET/.test(all), 'nothing hidden reaches it');
});

test('only methods: everything else of the runs is not there to read, not even an observation', async () => {
  const x = new Experience([{ label: 'exp1', journal: journal(), sameWorld: false }], { scope: 'methods' });
  const runs = await x.run({ experience: 'runs' }) as any;
  assert.deepEqual(runs.runs[0].items, { methods: 1 });
  const listed = await x.run({ experience: 'list', run: 'exp1' }) as any;
  assert.deepEqual(listed.index.map((i: any) => i.id), ['method:pair']);
  assert.match(JSON.stringify(await x.run({ experience: 'list', run: 'exp1', of: 'beliefs' })), /only the methods/);
  const opened = await x.run({ experience: 'open', run: 'exp1', items: ['method:pair', 'belief:grow'] }) as any;
  assert.equal(opened.items[0].item.text, 'change one thing at a time from the same point');
  assert.match(JSON.stringify(opened.items[1]), /only the methods/);
  const found = await x.run({ experience: 'find', words: 'edge' }) as any;
  assert.equal(found.runs[0].matches, 0, 'the observation about the edge is not found');
  assert.ok(!/edge grows|SECRET/.test(JSON.stringify([runs, listed, opened, found])));
  const all = new Experience([{ label: 'exp1', journal: journal(), sameWorld: false }]);
  assert.ok((await all.run({ experience: 'find', words: 'edge' }) as any).runs[0].matches >= 2, 'with all, observations too');
});

/* --- A System 2 stand-in: in round 1 it reads its experience, then proposes. */
function system2(seen: { systems: string[]; users: any[] }, propose: object): FetchLike {
  return async (_url, init) => {
    const b = JSON.parse(String(init.body));
    const sys = b.messages[0].content as string;
    const u = JSON.parse(userOf(b));
    seen.systems.push(sys); seen.users.push(u);
    const content = sys.startsWith('You grade') ? { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' }
      : 'task' in u ? { rationale: 'r', beliefs: [{ id: 'b', stance: 'keep', why: 'w' }], lessons: ['l'], next_experiment: 'n' }
      : u.round === 1 && (u.investigation ?? []).length < 2
        ? { investigate: (u.investigation ?? []).length === 0 ? [{ experience: 'runs' }] : [{ experience: 'find', words: 'the' }] }
      : { rationale: 'r', ...propose, validate: false, beliefs: [{ id: 'b', stance: u.round === 1 ? 'new' : 'keep', statement: 's', evidence: ['exp:exp1#belief:b'] }], lessons: ['l'] };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 10 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
}
const LAW = { observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]' };
const cells = (seed: number, more: string[], dir: string, name: string) =>
  ['--seed', String(seed), '--level', '1', '--attempts', '1', '--flat', '--no-grade', '--no-reflection', '--researcher', 'assisted', ...more, '--out', path.join(dir, name)];
const llm = { url: 'http://x.test/chat', model: 'm' };

test('a world of laws: transfer refuses a run of this same world, and one that read it; meta takes it, and the finding says so', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'experience-'));
  const seen = () => ({ systems: [] as string[], users: [] as any[] });
  const one = await runLaboratory(cellsLab, { args: cells(1, [], dir, 'one.json'), root: dir, llm, fetch: system2(seen(), LAW) });
  const two = await runLaboratory(cellsLab, { args: cells(2, [], dir, 'two.json'), root: dir, llm, fetch: system2(seen(), LAW) });
  await assert.rejects(runLaboratory(cellsLab, { args: cells(1, ['--experience', 'one.json'], dir, 'x.json'), root: dir, llm, fetch: system2(seen(), LAW) }), /this same world.*--experience-mode meta/);
  await assert.rejects(runLaboratory(cellsLab, { args: cells(1, ['--experience', 'one.json'], dir, 'x.json').filter((a) => a !== '--researcher' && a !== 'assisted'), root: dir, llm, fetch: system2(seen(), LAW) }), /only the assisted researcher/);
  await assert.rejects(runLaboratory(cellsLab, { args: cells(1, ['--experience-mode', 'meta'], dir, 'x.json'), root: dir, llm, fetch: system2(seen(), LAW) }), /give the runs/);

  /* Transfer: seed 3 reads the run of seed 2. */
  const s = seen();
  const t = await runLaboratory(cellsLab, { args: cells(3, ['--experience', path.basename(two.journal)], dir, 'transfer.json'), root: dir, llm, fetch: system2(s, LAW) });
  assert.match(s.systems.find((x) => !x.startsWith('You grade'))!, /EXPERIENCE\. .*OTHER environments/);
  const tj = JSON.parse(fs.readFileSync(t.journal, 'utf8'));
  const given = tj.events.find((e: any) => e.type === 'experience');
  assert.deepEqual([given.mode, given.runs[0].label, given.runs[0].same_world, given.runs[0].knows_this_world], ['transfer', 'exp1', false, false]);
  assert.equal(given.runs[0].sha256.length, 64);
  const reads = tj.events.filter((e: any) => e.type === 'investigation').flatMap((e: any) => e.results);
  assert.equal(reads[0].runs[0].environment, 'another');
  const finding = JSON.parse(fs.readFileSync(t.journal.replace(/\.json$/, '.finding.json'), 'utf8'));
  assert.equal(finding.assistance.experience.prior_knowledge_of_this_world, false);
  assert.deepEqual(finding.assistance.experience.read, ['runs', 'find "the"']);
  assert.ok(finding.claims.some((c: any) => c.grounded.includes('experience')), 'a belief citing exp: is grounded on experience');

  /* Only methods: said in its prompt, its journal and its finding. */
  const ms = seen();
  const only = await runLaboratory(cellsLab, { args: cells(4, ['--experience', path.basename(two.journal), '--experience-scope', 'methods'], dir, 'methods.json'), root: dir, llm, fetch: system2(ms, LAW) });
  assert.match(ms.systems.find((x) => !x.startsWith('You grade'))!, /read the METHODS/);
  assert.equal(JSON.parse(fs.readFileSync(only.journal, 'utf8')).events.find((e: any) => e.type === 'experience').scope, 'methods');
  assert.equal(JSON.parse(fs.readFileSync(only.journal.replace(/\.json$/, '.finding.json'), 'utf8')).assistance.experience.scope, 'methods');
  assert.equal(finding.assistance.experience.scope, 'all');
  await assert.rejects(runLaboratory(cellsLab, { args: cells(4, ['--experience', path.basename(two.journal), '--experience-scope', 'some'], dir, 'x.json'), root: dir, llm, fetch: system2(seen(), LAW) }), /"all" or "methods"/);

  /* The run of seed 3 read seed 2's: given to seed 2 in transfer, it is refused (it carries what it read); in meta it is not. */
  await assert.rejects(runLaboratory(cellsLab, { args: cells(2, ['--experience', path.basename(t.journal)], dir, 'x.json'), root: dir, llm, fetch: system2(seen(), LAW) }), /read the experience of a run of this same world/);
  const m = seen();
  const meta = await runLaboratory(cellsLab, { args: cells(1, ['--experience', path.basename(one.journal) + ',' + path.basename(t.journal), '--experience-mode', 'meta'], dir, 'meta.json'), root: dir, llm, fetch: system2(m, LAW) });
  assert.match(m.systems.find((x) => !x.startsWith('You grade'))!, /this same environment/);
  const mj = JSON.parse(fs.readFileSync(meta.journal, 'utf8'));
  const runs = mj.events.filter((e: any) => e.type === 'investigation').flatMap((e: any) => e.results)[0].runs;
  assert.deepEqual(runs.map((r: any) => r.environment), ['this same one', 'another']);
  const mf = JSON.parse(fs.readFileSync(meta.journal.replace(/\.json$/, '.finding.researcher.json'), 'utf8'));
  assert.equal(mf.assistance.experience.prior_knowledge_of_this_world, true, 'both views say it, as provenance');
});

test('a resumed run reads the same records: if one changed, it is not resumed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'experience-'));
  const s = () => ({ systems: [] as string[], users: [] as any[] });
  const two = await runLaboratory(cellsLab, { args: cells(2, [], dir, 'two.json'), root: dir, llm, fetch: system2(s(), LAW) });
  const t = await runLaboratory(cellsLab, { args: cells(3, ['--experience', path.basename(two.journal)], dir, 't.json'), root: dir, llm, fetch: system2(s(), LAW) });
  const again = await runLaboratory(cellsLab, { args: ['--resume', t.journal, '--out', path.join(dir, 'again.json')], root: dir, llm, fetch: system2(s(), LAW) });
  assert.equal(JSON.parse(fs.readFileSync(again.journal, 'utf8')).events.find((e: any) => e.type === 'end').replay.unused, 0);
  fs.appendFileSync(two.journal, '\n');
  await assert.rejects(runLaboratory(cellsLab, { args: ['--resume', t.journal, '--out', path.join(dir, 'later.json')], root: dir, llm, fetch: system2(s(), LAW) }), /changed since/);
});

test('the grid: the same instruments, each read a step, and the same refusals', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'experience-'));
  const GRID = (seed: number, more: string[], name: string) => ['--seed', String(seed), '--attempts', '1', '--explore', '1', '--variants', '1', '--family', '1', '--family-variants', '1',
    '--confirm-places', '1', '--levels', '2', '--depth', '1', '--flat', '--no-grade', '--no-reflection', '--no-ablation', '--researcher', 'assisted', ...more, '--out', path.join(dir, name)];
  const FORMULA = { observations: {}, rules: {}, weights: {}, output: '(p, m) => 0.5' };
  const s = () => ({ systems: [] as string[], users: [] as any[] });
  const other = await runLaboratory(gridLab, { args: GRID(21, [], 'other.json'), root: dir, llm, fetch: system2(s(), FORMULA) });
  const same = await runLaboratory(gridLab, { args: GRID(22, [], 'same.json'), root: dir, llm, fetch: system2(s(), FORMULA) });
  await assert.rejects(runLaboratory(gridLab, { args: GRID(22, ['--experience', path.basename(same.journal)], 'x.json'), root: dir, llm, fetch: system2(s(), FORMULA) }), /this same world/);
  const seen = s();
  const r = await runLaboratory(gridLab, { args: GRID(22, ['--experience', path.basename(other.journal)], 'r.json'), root: dir, llm, fetch: system2(seen, FORMULA) });
  assert.match(seen.systems[0], /EXPERIENCE\./);
  const j = JSON.parse(fs.readFileSync(r.journal, 'utf8'));
  const inv = j.events.filter((e: any) => e.type === 'investigation');
  assert.deepEqual(inv.map((e: any) => Object.keys(e.requests[0])[0]), ['experience', 'experience']);
  assert.equal(inv[0].results[0].runs[0].environment, 'another');
  assert.ok(!inv.some((e: any) => e.free), 'a read of experience is a step, not free');
  const second = seen.users.find((u) => (u.investigation ?? []).length === 1);
  assert.equal(second.steps_left, 2, 'the first read spent a step');
});
