import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { bundleText, embed, BEGIN, END } from '../scripts/harness-bundle.mjs';
import { ROOT, sampleStates } from './support.ts';
import { foxhounds, SIDE_CATS, SIDE_MOUSE } from '../src/worlds/foxhounds/world.ts';

/* The working harness consumes this library through an embedded bundle. Two guarantees:
   the bundle it carries is the one lib/src builds today, and the harness still runs on it. */

const htmlPath = path.join(ROOT, 'fox-hounds-harness.html');

test('the harness embeds the CURRENT bundle, exactly once, inside its single inline script', async () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  assert.equal(html.split(BEGIN).length - 1, 1);
  assert.equal(html.split(END).length - 1, 1);
  assert.equal((html.match(/<script>/g) || []).length, 1);
  assert.equal(embed(html, await bundleText()), html, 'stale bundle: run node scripts/harness-bundle.mjs');
});

test('the working harness runs its rules and vocabulary through the library', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const source = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  const sandbox: Record<string, unknown> = { console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, setInterval, clearInterval,
    performance: { now: () => Date.now() }, AbortController, fetch: () => Promise.reject(new Error('offline')) };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source + ';globalThis.__api = { legalMovesForSide, isTerminal, stateKey, computeObservations, OBSERVATION_OPS, FOX };', sandbox);
  const api = sandbox.__api as any;
  assert.equal(typeof api.FOX.foxhounds, 'object');
  const decls: Record<string, unknown> = {};
  for (const op of Object.keys(api.OBSERVATION_OPS)) decls[op] = { spec: { kind: 'op', op, args: op === 'mouse_routes' ? { cap: 8 } : {} } };
  for (const s of sampleStates(20, 5)) {
    for (const side of [SIDE_CATS, SIDE_MOUSE]) {
      assert.deepEqual(JSON.parse(JSON.stringify(api.legalMovesForSide(s, side))), JSON.parse(JSON.stringify(foxhounds.actions(s, side))));
    }
    assert.deepEqual({ ...api.isTerminal(s) }, foxhounds.outcome(s));
    assert.equal(api.stateKey(s), foxhounds.key(s));
    assert.deepEqual(api.computeObservations(s, decls).errors.length, 0);
  }
});
