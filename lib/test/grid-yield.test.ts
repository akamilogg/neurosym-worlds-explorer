import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { gridLab } from '../src/worlds/grid/lab.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';


/* A check of the grid can run for many minutes; meanwhile the process must still breathe: the heartbeat, the inbox, what is
   printed. A timer has to fire while the episodes are played. */
test('the grid\'s checks let the process breathe: timers fire while episodes are played', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grid-yield-'));
  const fetch: FetchLike = async (_url, init) => {
    const b = JSON.parse(String(init.body));
    const user = JSON.parse(userOf(b));
    const content = { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p, m) => 0.5', validate: false, beliefs: [{ id: 'b', stance: user.round === 1 ? 'new' : 'keep', statement: 's' }], lessons: ['l'] };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
  /* Counted from the first episode of the check to the verdict: before the fix, not one tick in between. */
  let ticks = 0, counting = false, seen = 0;
  const timer = setInterval(() => { if (counting) ticks++; }, 5);
  const print = (line: string): void => {
    if (/lab1 attempt 1 /.test(line)) { seen++; counting = true; }
    if (/check in lab1/.test(line)) counting = false;
  };
  try {
    await runLaboratory(gridLab, { args: ['--seed', '22', '--attempts', '1', '--explore', '1', '--variants', '3', '--family', '1', '--family-variants', '1', '--confirm-places', '1',
      '--levels', '2', '--depth', '1', '--steps', '0', '--flat', '--no-grade', '--no-reflection', '--no-ablation', '--out', path.join(dir, 'run.json')], root: dir,
      llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch, print });
  } finally { clearInterval(timer); }
  assert.ok(seen >= 3, 'episodes were played');
  assert.ok(ticks >= 3, 'the timer fired ' + ticks + ' times while the episodes were played');
});
