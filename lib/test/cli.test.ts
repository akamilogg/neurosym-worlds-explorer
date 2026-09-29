import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { describeEvent, labCli, resolveRun } from '../src/runtime/cli.ts';
import { runStatus } from '../src/runtime/control.ts';

/* SPEC-INVESTIGADOR-ASISTIDO A2: a run started, followed, stopped, resumed and read with the command line alone. */

const draft = { observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]' };
const answer = (body: string): string => {
  const b = JSON.parse(body);
  const sys = b.messages[0].content as string, user = b.messages[b.messages.length - 1].content as string;
  const content = sys.startsWith('You grade') ? { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' }
    : /"task"/.test(user) ? { rationale: 'r', beliefs: [{ id: 'b', stance: 'confirm', why: 'w' }], lessons: ['l'], next_experiment: 'n' }
    : !JSON.parse(user).investigation && JSON.parse(user).round % 2 === 1 ? { investigate: [{ view: 'ep1', from: 0, to: 3 }] }
    : { rationale: 'r', ...draft, validate: false, beliefs: [{ id: 'b', stance: 'new', statement: 's' }], lessons: ['l'] };
  return JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
};

const until = async (ok: () => boolean, ms = 60000): Promise<void> => {
  const t = Date.now();
  while (!ok()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 200)); }
};

test('the command line alone: start, list, status, watch, send (refused), stop, resume, finding', { timeout: 180000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-'));
  /* System 2 over HTTP, slow enough that the run is still going when the operator acts. */
  const server = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => setTimeout(() => res.end(answer(b)), 300)); });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  const env = { ...process.env, LLM_URL: 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1/chat/completions', LLM_MODEL: 'stand-in', LLM_KEY: '', JEV_KEY: '' };
  const lines: string[] = [];
  const cli = (...argv: string[]) => { lines.length = 0; return labCli(argv, { root, env, out: (l) => lines.push(l), ackMs: 30000 }); };
  try {
    assert.equal(await cli('start', 'cells', '--seed', '1', '--level', '1', '--attempts', '8', '--flat', '--no-grade', '--no-reflection'), 0);
    const name = /^started (\S+)/.exec(lines[0])![1];
    /* The run writes its journal as soon as its process is up. */
    const journal = path.join(root, 'runs', name + '.json');
    await until(() => fs.existsSync(journal) && runStatus(journal).state === 'running');
    assert.equal(resolveRun(root, name), journal);
    assert.equal(resolveRun(root, 'last'), journal);

    assert.equal(await cli('list'), 0);
    assert.match(lines.join('\n'), new RegExp(name + '.*cells@1.*unknown-world.*running'));
    assert.equal(await cli('status', name.slice(0, 12)), 0, 'a prefix names it');
    assert.match(lines[0], /unknown-world researcher, running/);

    /* Help is refused by the unknown-world researcher, and the command line says so (exit 1). */
    assert.equal(await cli('send', name, 'look at step 0'), 1);
    assert.match(lines[0], /message refused: the unknown-world researcher learns only from what the world answers/);

    assert.equal(await cli('stop', name), 0);
    assert.equal(lines[0], 'stop accepted');
    assert.equal(await cli('watch', name), 0);
    assert.match(lines.at(-1)!, /^\[\d+s\] ended: cancelled/);
    assert.ok(lines.some((l) => /the operator's stop \(operator\): accepted/.test(l)));
    assert.equal(await cli('send', name, 'too late'), 1, 'an ended run reads no orders');

    assert.equal(await cli('resume', name), 0);
    const derived = /^resumed as (\S+)/.exec(lines[0])![1];
    await until(() => fs.existsSync(path.join(root, 'runs', derived + '.json')));
    assert.equal(await cli('watch', derived), 0);
    assert.match(lines.at(-1)!, /ended: (budget|accepted)/);
    assert.equal(runStatus(resolveRun(root, derived)).state, 'ended');

    assert.equal(await cli('finding', derived, '--view', 'researcher'), 0);
    assert.match(lines[0], /researcher view, unknown-world researcher/);
    assert.equal(await cli('list'), 0);
    assert.equal(lines.filter((l) => l.includes('cells@1')).length, 2, 'the run and the run derived from it');
  } finally { server.close(); }
});

test('the command line refuses what it cannot do, and says why', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-'));
  const lines: string[] = [];
  const cli = (...argv: string[]) => { lines.length = 0; return labCli(argv, { root, out: (l) => lines.push(l) }); };
  assert.equal(await cli(), 2);
  assert.equal(await cli('frobnicate'), 2);
  assert.equal(await cli('status', 'nothing'), 1);
  assert.match(lines[0], /no run named nothing/);
  assert.equal(await cli('list'), 0);
  assert.equal(lines[0], 'no runs yet');
  assert.equal(describeEvent({ t: 3, type: 'operator_command_refused', kind: 'message', reason: 'no' }), "[3s] the operator's message: refused - no");
  assert.equal(describeEvent({ t: 4, type: 'operator_message', question: 3, messages: [{ text: 'look at step 0' }] }), '[4s] with question 3, System 2 is given the operator\'s message: "look at step 0"');
});
