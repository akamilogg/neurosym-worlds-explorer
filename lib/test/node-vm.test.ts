import test from 'node:test';
import assert from 'node:assert/strict';
import { nodeVmRunner } from '../src/runtime/node-vm.ts';

/* The learner's code never holds an object of the host: the point crosses as text (an external review, 14/10/2026). */
test('an observation reads its point, and nothing of the host through it', () => {
  const run = nodeVmRunner({ timeoutMs: 500 });
  assert.equal((run.compile('(p) => p.rows.length + p.t[2]') as (c: unknown) => number)({ rows: ['a', 'b'], t: [0, 5, 10] }), 12);
  const escape = run.compile('(p) => { try { return typeof p.constructor.constructor("return process")(); } catch (e) { return "blocked"; } }') as (c: unknown) => unknown;
  assert.equal(escape({ x: 1 }), 'blocked');
  const nested = run.compile('(p) => { try { return typeof p.a.b.constructor.constructor("return process")(); } catch (e) { return "blocked"; } }') as (c: unknown) => unknown;
  assert.equal(nested({ a: { b: [1] } }), 'blocked');
  const clock = run.compile('() => typeof Date + "/" + typeof Math.random') as (c: unknown) => unknown;
  assert.equal(clock({}), 'undefined/undefined');
  const spin = run.compile('() => { for (;;) {} }') as (c: unknown) => unknown;
  assert.throws(() => spin({}), /timed out/i);
});
