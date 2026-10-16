import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';
import { juniorBrief } from '../src/orchestra/reader.ts';
import { ASSISTED_SECTION, ASSISTED_SECTION_CHANNEL, DIRECTIVES_SECTION, DIRECTIVES_SECTION_CHANNEL, SOURCES_SECTION, SOURCES_SECTION_CHANNEL } from '../src/learn/assisted/session.ts';
import type { FetchLike } from '../src/core/net.ts';

/* The assisted researcher's task is the one the environment and its operator state - a model of the environment is part of
   it, not the whole of it - and its prompt describes its channel as it works. The unknown-world researcher's prompt, frozen,
   keeps the task as a model. */

const STATED = /YOUR TASK is the one this environment's interface and its operator state/;
const MODEL_ONLY = /YOUR TASK is to write a MODEL that gives the ANSWER/;

function standIn(systems: string[]): FetchLike {
  return async (_url, init) => {
    const b = JSON.parse(String(init.body));
    const sys = b.messages[0].content as string;
    if (!sys.startsWith('You grade')) systems.push(sys);
    const content = sys.startsWith('You grade') ? { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' }
      : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]', validate: false, beliefs: [], lessons: ['l'], next_experiment: 'n' };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
}
const ARGS = ['--seed', '1', '--level', '1', '--flat', '--no-grade', '--no-reflection', '--tools', 'none', '--attempts', '1'];

test('the assisted researcher: its task as stated, a model a part of it; its prompt describes its channel - and its senior is given the same brief', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stated-'));
  const systems: string[] = [];
  const r = await runLaboratory(cellsLab, { args: [...ARGS, '--researcher', 'assisted', '--task', 'Find the rule of the rows.', '--out', path.join(dir, 'run.json')], root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch: standIn(systems) });
  assert.ok(systems.length > 0);
  for (const s of systems) {
    assert.match(s, STATED);
    assert.doesNotMatch(s, MODEL_ONLY);
    assert.ok(s.includes(ASSISTED_SECTION_CHANNEL), 'its operator section describes its channel');
    assert.ok(!s.includes('operator_messages') && !s.includes('`operator_task`'), 'no field that no longer exists');
  }
  const journal = JSON.parse(fs.readFileSync(r.journal, 'utf8'));
  assert.equal(journal.config.capabilities_from.stated_task, 0);
  assert.match(juniorBrief(journal)!, STATED, 'its senior reads the brief it was given');
});

test('the unknown-world researcher keeps its prompt: the task as a model, no channel', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stated-pure-'));
  const systems: string[] = [];
  await runLaboratory(cellsLab, { args: [...ARGS, '--out', path.join(dir, 'run.json')], root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch: standIn(systems) });
  assert.ok(systems.length > 0 && systems.every((s) => MODEL_ONLY.test(s) && !STATED.test(s)));
});

test('each section with a channel differs from the one before it where the channel changed what it says', () => {
  assert.notEqual(ASSISTED_SECTION_CHANNEL, ASSISTED_SECTION);
  assert.match(SOURCES_SECTION_CHANNEL, /harness:sources/);
  assert.notEqual(SOURCES_SECTION_CHANNEL, SOURCES_SECTION);
  assert.match(DIRECTIVES_SECTION_CHANNEL, /strategic half/);
  assert.notEqual(DIRECTIVES_SECTION_CHANNEL, DIRECTIVES_SECTION);
});
