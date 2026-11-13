import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';
import { JEV_DEFAULT_URL } from '../src/core/jev.ts';
import { trialResult } from '../src/meta/lab.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';

/* SPEC-VALIDEZ-MEDIDA §7, VM5: a check in which the Judge failed is no verdict - measured again once on the same cases; failed
   again, it is void: no round spent, no place's role changed, no paired regression, and the researcher told the instrument
   failed, as a fact. */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'check-void-'));

function jevAnswer(body: Record<string, any>): string {
  const answers = Object.fromEntries(Object.entries((body.questions ?? {}) as Record<string, any>).map(([id, rule]) => [id,
    rule.type === 'choice' ? { type: 'choice', probabilities: { [rule.option ?? 'yes']: 0.5 }, confidence: 0.5 } : rule.type === 'score' ? { type: 'score', score: 1, confidence: 0.5 } : { type: rule.type, noul: 0.9 }]));
  return JSON.stringify({ answers });
}

/** System 2 proposing a model whose output reads its rule (so a check asks the Judge at every point); `seen`: what it was
    given, each request. The Judge answers unless `down(n)` says its n-th call fails. */
function world(down: (n: number) => boolean, seen: unknown[]): FetchLike {
  let calls = 0;
  return async (url, init) => {
    if (url.startsWith(JEV_DEFAULT_URL)) {
      calls++;
      if (down(calls)) return { ok: false, status: 404, statusText: 'Not Found', text: async () => 'down', headers: { get: () => null } };
      const text = jevAnswer(JSON.parse(String(init.body)));
      return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
    }
    const user = JSON.parse(userOf(JSON.parse(String(init.body))));
    seen.push(user);
    const content = 'task' in user ? { rationale: 'r', beliefs: [], lessons: ['l'], next_experiment: 'n' }
      : { rationale: 'r', observations: { last: { definition: 'the last row', source: '(p) => p.rows[p.rows.length - 1]' } },
        rules: { same: { type: 'noul', used_as: 'value', instructions: 'Row {{last}}: does it stay as it is?', criteria: { yes: 'it stays', no: 'it changes' } } }, weights: { same: 1 },
        output: '(p, m) => (m.same >= 0 ? p.rows[p.rows.length - 1] : p.rows[0])', validate: false, lessons: ['l'], next_experiment: 'n', beliefs: [] };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
}

const run = (dir: string, fetch: FetchLike, attempts = 2) => runLaboratory(cellsLab, { args: ['--seed', '1', '--level', '1', '--researcher', 'assisted', '--attempts', String(attempts), '--steps', '0',
  '--no-grade', '--no-reflection', '--no-ablation', '--out', path.join(dir, 'run.json')], root: dir, llm: { url: 'http://x.test/v1/chat/completions', model: 's' }, judge: { url: JEV_DEFAULT_URL, key: 'test-key' }, fetch, print: () => {} });

test('VM5: the Judge failing once in a check - measured again on the same cases, the verdict of the second', async () => {
  const dir = tmp();
  const seen: unknown[] = [];
  const r = await run(dir, world((n) => n === 1, seen), 1);
  const events = JSON.parse(fs.readFileSync(r.journal, 'utf8')).events as Record<string, any>[];
  assert.equal(events.filter((e) => e.type === 'check_void').length, 0);
  const check = events.find((e) => e.type === 'check')!;
  assert.ok(check, 'a check with a verdict');
  assert.equal(check.instrument?.measured_again, 1, JSON.stringify(check.instrument));
});

test('VM5: the Judge down in a check - void: no round spent, nothing changed, the researcher told; down for good, the run stops as the provider\'s failure', async () => {
  const dir = tmp();
  const seen: Record<string, any>[] = [];
  const r = await run(dir, world(() => true, seen), 2);
  const j = JSON.parse(fs.readFileSync(r.journal, 'utf8'));
  const events = j.events as Record<string, any>[];
  const voids = events.filter((e) => e.type === 'check_void');
  assert.equal(events.filter((e) => e.type === 'check').length, 0, 'no verdict');
  assert.equal(voids.length, 3, 'three void checks in a row, then it stops');
  const end = events.filter((e) => e.type === 'end').at(-1)!;
  assert.equal(end.stoppedBy, 'judge_unavailable');
  assert.ok(voids.every((v) => v.failures > 0 && v.purpose === 'check'), JSON.stringify(voids));
  /* What the researcher was told after a void check: a fact, no verdict. */
  const told = seen.find((u) => JSON.stringify(u).includes('not_counted'));
  assert.ok(told, 'the researcher is told');
  const said = JSON.stringify(told);
  assert.doesNotMatch(said, /your_model_holds_here/, 'no verdict');
  assert.match(said, /the instrument that measures your model failed/);
  /* For the meta-laboratory, a trial its Judge failed for good is the provider's failure: no measure. */
  const t = trialResult(r.journal, 'model_accepted');
  assert.deepEqual([t.state, t.cause], ['infra', 'provider']);
});

test('VM5: a run resumed after a void check replays it as it was - the Judge\'s failures from its log, the same void, no divergence', async () => {
  const dir = tmp();
  let judgeLive = 0;
  const seen: unknown[] = [];
  /* The Judge down through the first run (its check and the measure again: void), up when it is resumed - where what it
     failed before comes from the run's log. */
  let up = false;
  const fetch = world(() => !up, seen);
  const counting: FetchLike = async (url, init) => { if (url.startsWith(JEV_DEFAULT_URL)) judgeLive++; return fetch(url, init); };
  const first = await runLaboratory(cellsLab, { args: ['--seed', '1', '--level', '1', '--researcher', 'assisted', '--attempts', '2', '--steps', '0', '--max-tokens', '100',
    '--no-grade', '--no-reflection', '--no-ablation', '--out', path.join(dir, 'run.json')], root: dir, llm: { url: 'http://x.test/v1/chat/completions', model: 's' }, judge: { url: JEV_DEFAULT_URL, key: 'test-key' }, fetch: counting, print: () => {} });
  const a = JSON.parse(fs.readFileSync(first.journal, 'utf8'));
  assert.equal(a.events.filter((e: any) => e.type === 'check_void').length, 1, 'the first check void');
  assert.equal(a.events.filter((e: any) => e.type === 'end').at(-1).stoppedBy, 'token_budget', 'cut by its budget after it');
  const liveBefore = judgeLive;
  up = true;
  const again = await runLaboratory(cellsLab, { args: ['--resume', first.journal, '--max-tokens', '100000', '--out', path.join(dir, 'resumed.json')],
    root: dir, llm: { url: 'http://x.test/v1/chat/completions', model: 's' }, judge: { url: JEV_DEFAULT_URL, key: 'test-key' }, fetch: counting, print: () => {} });
  const b = JSON.parse(fs.readFileSync(again.journal, 'utf8'));
  const end = b.events.filter((e: any) => e.type === 'end').at(-1);
  assert.notEqual(end.stoppedBy, 'diverged', JSON.stringify(end.replay));
  const voids = b.events.filter((e: any) => e.type === 'check_void');
  assert.deepEqual(voids.map((v: any) => [v.round, v.failures]), a.events.filter((e: any) => e.type === 'check_void').map((v: any) => [v.round, v.failures]), 'the same void, replayed');
  assert.ok(b.events.some((e: any) => e.type === 'check'), 'then a check with its verdict, live');
  assert.ok(judgeLive > liveBefore, 'the Judge asked live only after what was replayed');
});

test('VM5: a run with no finding has no datum of what it reached - never "not accepted"', async () => {
  const { runResults } = await import('../src/orchestra/results.ts');
  const dir = tmp();
  const journal = path.join(dir, 'r.json');
  fs.writeFileSync(journal, JSON.stringify({ experiment: 'cells@1', config: {}, events: [{ type: 'check', round: 1, laboratories: [] }, { type: 'end', stoppedBy: 'budget' }] }));
  assert.equal(runResults(journal).o1_predictive_acceptance.model, null);
  const t = trialResult(journal, 'model_accepted');
  assert.deepEqual([t.state, t.cause, t.solved], ['infra', 'harness', null], 'a trial that cannot say what it reached measures nothing');
  fs.writeFileSync(journal.replace(/\.json$/, '.finding.json'), JSON.stringify({ outcome: { status: 'rejected' } }));
  assert.equal(runResults(journal).o1_predictive_acceptance.model, false);
});

test('VM5 review: a question the Judge refuses (400, 422) is the model\'s defect - the check stands, its points fail, the trial ended', async () => {
  const dir = tmp();
  const seen: Record<string, any>[] = [];
  /* The Judge up, refusing this model's question as malformed: the instrument works, the rule does not. */
  const base = world(() => false, seen);
  const refusing: FetchLike = async (url, init) => (url.startsWith(JEV_DEFAULT_URL)
    ? { ok: false, status: 422, statusText: 'Unprocessable', text: async () => '{"error":"the question cannot be answered as declared"}', headers: { get: () => null } }
    : base(url, init));
  const r = await run(dir, refusing, 2);
  const events = JSON.parse(fs.readFileSync(r.journal, 'utf8')).events as Record<string, any>[];
  assert.equal(events.filter((e) => e.type === 'check_void').length, 0, 'not the instrument down');
  const checks = events.filter((e) => e.type === 'check');
  assert.equal(checks.length, 2, 'its rounds checked, and spent');
  assert.ok(checks.every((c) => c.jev.refused > 0), JSON.stringify(checks.map((c) => c.jev)));
  assert.notEqual(r.stoppedBy, 'judge_unavailable');
  const t = trialResult(r.journal, 'model_accepted');
  assert.equal(t.state, 'ended', 'a trial whose model asked what the Judge refuses measured that model: ' + JSON.stringify(t));
});
