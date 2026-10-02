import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';
import { journalReader, stuckSignals } from '../src/orchestra/reader.ts';
import { runAgentOperator, SENIOR_HEAD, SENIOR_ROLE } from '../src/orchestra/agent-operator.ts';
import { juniorBrief } from '../src/orchestra/reader.ts';
import { system2Prompt } from '../src/learn/prompt.ts';
import { explorerSystem } from '../src/learn/explorer.ts';
import { cellsInterface } from '../src/worlds/cells/interface.ts';
import type { ChatClient } from '../src/learn/system2.ts';
import type { FetchLike } from '../src/core/net.ts';

/* SPEC-ORQUESTADOR §3.3: the senior - it reads the junior's record (exactly what the junior saw) when the junior is stuck,
   and proposes a hypothesis its data suggest. */

/** A grid-like journal, by hand: what the junior did and was answered, and what it was never shown. */
const JOURNAL = {
  experiment: 'unknown-world@1', researcher: 'assisted',
  hidden_from_the_learner: { truth: 'SECRET the other wins at column 4' },
  events: [
    { type: 'exploration_game', game: 'g1', winner: 'B', reason: 'reach', plies: 8, frames: [] },
    { type: 'investigation', round: 1, requests: [{ act: 'g1@0', from: [0, 4], to: [0, 3] }], results: [{ act: 'g1@0', accepted: true }],
      notes: [{ do: 'write', id: 'acts', text: 'left was accepted at g1@0' }] },
    { type: 'proposal', round: 1, beliefs: [{ id: 'corner', stance: 'new', statement: 'losses end at the upper-right corner' }], rationale: 'r', lessons: ['l'], next_experiment: 'n',
      formula: { observations: { d: { definition: 'distance', spec: { kind: 'code', source: '(p) => 1' }, range: [0, 1] } }, rules: {}, weights: {}, output: { kind: 'code', source: '(p, m) => 0.5' } } },
    { type: 'check', round: 1, laboratories: [{ place: 'lab1', holds: false, wins: 3, total: 8, rerun: { went_up: 0, went_down: 1 }, action_accuracy: { rate: 0.5 } }],
      operator_analysis: { surprises: 'SECRET operator measure' } },
    { type: 'played_by_the_learner', round: 2, game: 'g9', from: 'g1@0', how: 'a draft model', result: 'won', turns: 12, reason: 'trap' },
    { type: 'operator_rule_recovery', truth: [{ statement: 'SECRET you win by trapping' }] }
  ]
};

test('the senior reads exactly what the junior saw: its answers and verdicts, never the hidden part, the operator\'s measures nor how an episode ended', async () => {
  const reader = journalReader(JOURNAL);
  const opened = await reader.run({ memory: 'open', items: ['investigation:r1.1', 'check:r1', 'model:r1', 'belief:corner', 'note:acts', 'episode:g1', 'episode:g9'] }) as { items: { id: string; item: any }[] };
  const by = Object.fromEntries(opened.items.map((i) => [i.id, i.item]));
  assert.deepEqual(by['investigation:r1.1'].results, [{ act: 'g1@0', accepted: true }], 'what an act answered');
  assert.deepEqual(by['check:r1'].laboratories, [{ place: 'lab1', holds: false, scored_1: 3, of: 8, rerun: { went_up: 0, went_down: 1 } }], 'the verdicts as given');
  assert.ok(by['model:r1'].model.observations.d.source, 'its model in its own words');
  assert.equal(by['belief:corner'].statement, 'losses end at the upper-right corner');
  assert.equal(by['note:acts'].text, 'left was accepted at g1@0');
  assert.deepEqual([by['episode:g1'].score, by['episode:g9'].score], [-1, 1]);
  const everything = JSON.stringify(await reader.run({ memory: 'find', words: 'secret' })) + JSON.stringify(opened);
  assert.doesNotMatch(everything, /SECRET|trap|reach|action_accuracy/, 'nothing it was not shown');
});

test('signs of being stuck are facts of the record', () => {
  const nowhere = (round: number) => ({ type: 'check', round, laboratories: [{ place: 'lab1', holds: false }] });
  const same = { view: 'g1', from: 0, to: 8 };
  const s = stuckSignals({ events: [nowhere(1), nowhere(2), nowhere(3),
    { type: 'investigation', round: 3, requests: [same, same, same] }, { type: 'investigation_refused', round: 3 }, { type: 'investigation_refused', round: 3 }] });
  assert.equal(s.holding_nowhere_in_a_row, 3);
  assert.equal(s.repeated_requests, 2);
  assert.equal(s.signs.length, 3);
  assert.deepEqual(stuckSignals({ events: [nowhere(1), { type: 'check', round: 2, laboratories: [{ place: 'lab1', holds: true }] }] }).signs, []);
});

/* --- A whole run: the junior (System 2 standing in) is stuck; the senior is called, reads its record, and writes once. */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stuck: FetchLike = async (_url, init) => {
  await sleep(40);
  const b = JSON.parse(String(init.body));
  const sys = b.messages[0].content as string, raw = b.messages[b.messages.length - 1].content as string;
  const user = sys.startsWith('You grade') ? {} : JSON.parse(raw);
  const content = sys.startsWith('You grade') ? { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' }
    : 'task' in user ? { rationale: 'r', beliefs: [{ id: 'same', stance: 'keep', why: 'w' }], lessons: ['l'], next_experiment: 'n' }
    : { rationale: 'the row stays the same', observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]', validate: false,
      beliefs: [{ id: 'same', stance: user.round === 1 ? 'new' : 'keep', statement: 'the row repeats', evidence: [] }], lessons: ['l'], next_experiment: 'test whether the row depends on its neighbours' };
  const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
  return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
};

function senior(seen: { system: string; user: any }[]): ChatClient {
  return { complete: async (r) => {
    seen.push({ system: r.system, user: r.user });
    const content = !(r.user as { investigation?: unknown }).investigation ? { investigate: [{ memory: 'find', words: 'repeats', of: 'beliefs' }, { memory: 'list', of: 'checks' }] }
      : { decision: 'message', text: 'Hypothesis: the row depends on its neighbours (belief:same never changed while no place held). Test it: measure each cell against its neighbours one step earlier.',
        evidence: ['belief:same', 'check:r1'], why: 'the same model every round, holding nowhere' };
    return { content: JSON.stringify(content), latencyMs: 0, raw: null };
  } };
}

test('a senior is called only when the junior is stuck, reads its record, proposes a hypothesis with its evidence; the junior gets it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'senior-'));
  const out = path.join(dir, 'run.json');
  const seen: { system: string; user: any }[] = [];
  const controller = new AbortController();
  const run = runLaboratory(cellsLab, { args: ['--seed', '1', '--level', '1', '--flat', '--tools', 'none', '--researcher', 'assisted', '--attempts', '6', '--agents', 'senior=message', '--out', out],
    root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch: stuck });
  const agent = runAgentOperator({ id: 'senior', role: 'senior', patience: 2, journal: out, llm: senior(seen), pollMs: 15, maxOrders: 1, signal: controller.signal });
  const r = await run;
  controller.abort();
  const { decisions, file } = await agent;
  assert.ok(seen.length >= 2);
  /* Its prompt: its role, then the junior's brief word for word (without the shape of a proposal), then its instructions. */
  const brief = juniorBrief(JSON.parse(fs.readFileSync(out, 'utf8')))!;
  for (const s of seen) {
    assert.ok(s.system.startsWith(SENIOR_HEAD) && s.system.endsWith(SENIOR_ROLE));
    assert.ok(s.system.includes(brief));
  }
  assert.match(seen[0].user.signals.join(' '), /held in no place/, 'called for a sign of being stuck');
  assert.ok(seen[1].user.investigation[0].results[0].items.some((i: { id: string }) => i.id === 'belief:same'), 'it read the record');
  const message = decisions.find((d) => d.decision === 'message')!;
  assert.deepEqual(message.evidence, ['belief:same', 'check:r1']);
  assert.ok(message.read && message.read.length === 1);
  assert.match(message.outcome!, /accepted/);
  const events = JSON.parse(fs.readFileSync(r.journal, 'utf8')).events as Record<string, any>[];
  const delivered = events.filter((e) => e.type === 'operator_message').flatMap((e) => e.messages);
  assert.ok(delivered.some((m: { by: string; text: string }) => m.by === 'agent:senior' && /Hypothesis/.test(m.text)), 'the junior received it');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).role, 'senior');
  const journal = JSON.parse(fs.readFileSync(r.journal, 'utf8'));
  const inputs = JSON.stringify(seen.map((s) => s.user));
  for (const t of journal.hidden_from_the_learner.truth as { statement: string }[]) assert.ok(!inputs.includes(t.statement), 'never the truth');
});

test('the junior\'s brief is its prompt word for word, its world\'s interface included, without the shape of a proposal', () => {
  const grid = juniorBrief({ experiment: 'unknown-world@1', config: { tools: ['view', 'act', 'table'] } })!;
  const full = explorerSystem(new Set(['view', 'act', 'table']) as never);
  assert.ok(full.startsWith(grid), 'the same text');
  assert.match(grid, /THIS ENVIRONMENT'S INTERFACE/);
  assert.match(grid, /"act": "<point>"/, 'what an act is');
  assert.doesNotMatch(grid, /When you propose, answer with ONE JSON object/);
  const cells = juniorBrief({ experiment: 'cells@1', config: { tools: ['view'], regression: true } });
  if (cells) assert.ok(system2Prompt(cellsInterface({ regression: true }), new Set(['view'])).startsWith(cells));
  assert.equal(juniorBrief({ experiment: 'nowhere@1' }), null);
});
