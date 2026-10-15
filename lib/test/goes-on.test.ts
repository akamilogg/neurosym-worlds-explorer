import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';
import { generateCells } from '../src/worlds/cells/world.ts';
import type { LawLab } from '../src/learn/lab.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';

/* A world whose investigation goes on after its model is accepted (Lab.goesOnAfterAcceptance: the artifacts' world, whose
   product is the artifact): the acceptance is kept, a new stage starts, and the run ends when its budget does. */

const SEED = 2;
function evenLayer(): string {
  const spec = generateCells(SEED, 4);
  const [g0, g1] = spec.glyphs, rule = spec.layers![0];
  return '(p) => { const row = p.rows[p.rows.length - 1].split(""); const n = row.length, out = row.slice();'
    + ' for (let i = 0; i < n; i += 2) { const v = (j) => row[((j % n) + n) % n] === ' + JSON.stringify(g1) + ' ? 1 : 0;'
    + ' const k = v(i - 2) * 4 + v(i) * 2 + v(i + 2); out[i] = ((' + rule + ' >> k) & 1) ? ' + JSON.stringify(g1) + ' : ' + JSON.stringify(g0) + '; }'
    + ' return out.join(""); }';
}

test('a world that goes on after an acceptance: the model accepted is kept, a new stage starts and the researcher is told, the run goes on to its last round', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goes-on-'));
  const asked: Record<string, any>[] = [];
  const system2: FetchLike = async (_url, init) => {
    const b = JSON.parse(String(init.body));
    const sys = b.messages[0].content as string;
    const user = sys.startsWith('You grade') ? {} : JSON.parse(userOf(b));
    if (!sys.startsWith('You grade')) asked.push(user);
    const content = sys.startsWith('You grade') ? { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' }
      : 'task' in user ? { rationale: 'r', beliefs: [{ id: 'b', stance: 'keep', why: 'w' }], lessons: ['l'], next_experiment: 'n' }
      : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: evenLayer(), validate: true, beliefs: [{ id: 'b', stance: user.round === 1 ? 'new' : 'keep', statement: 's', evidence: [] }], lessons: ['l'] };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
  const lab = { ...(cellsLab as LawLab), goesOnAfterAcceptance: true } as LawLab;
  const r = await runLaboratory(lab, { args: ['--seed', String(SEED), '--level', '4', '--focus', 'even', '--researcher', 'assisted', '--flat', '--no-grade', '--no-reflection', '--validations', '4', '--attempts', '4', '--out', path.join(dir, 'run.json')],
    root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch: system2 });
  const events = JSON.parse(fs.readFileSync(r.journal, 'utf8')).events as Record<string, any>[];
  const accepted = events.filter((e) => e.type === 'accepted').map((e) => e.round);
  assert.ok(accepted.length >= 1, 'accepted');
  assert.ok(events.some((e) => e.type === 'stage_after_acceptance' && e.goes_on), 'a new stage');
  assert.equal(Math.max(...events.filter((e) => e.type === 'proposal').map((e) => e.round)), 4, 'on to its last round: ' + events.map((e) => e.type + (e.round ?? '')).join(' '));
  /* Told through its channel, at the round after. */
  const told = asked.find((u) => (u.channel?.notices ?? []).some((n: any) => n.from === 'harness' && n.body.model_accepted));
  assert.equal(told?.round, accepted[0] + 1);
  /* The run's model: the latest accepted. */
  assert.equal(r.stoppedBy, 'accepted');
  assert.equal(r.finding.outcome.round, accepted[accepted.length - 1]);
});

test('without the declaration, an acceptance ends the run as before', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goes-on-not-'));
  const system2: FetchLike = async (_url, init) => {
    const b = JSON.parse(String(init.body));
    const sys = b.messages[0].content as string;
    const user = sys.startsWith('You grade') ? {} : JSON.parse(userOf(b));
    const content = sys.startsWith('You grade') ? { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' }
      : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: evenLayer(), validate: true, beliefs: [{ id: 'b', stance: user.round === 1 ? 'new' : 'keep', statement: 's', evidence: [] }], lessons: ['l'] };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
  const r = await runLaboratory(cellsLab, { args: ['--seed', String(SEED), '--level', '4', '--focus', 'even', '--researcher', 'assisted', '--flat', '--no-grade', '--no-reflection', '--validations', '4', '--attempts', '4', '--out', path.join(dir, 'run.json')],
    root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch: system2 });
  const events = JSON.parse(fs.readFileSync(r.journal, 'utf8')).events as Record<string, any>[];
  const first = events.find((e) => e.type === 'accepted')!.round;
  assert.equal(Math.max(...events.filter((e) => e.type === 'proposal').map((e) => e.round)), first, 'it stops at its acceptance');
});
