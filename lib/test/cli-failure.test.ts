import test from 'node:test';
import assert from 'node:assert/strict';
import { failureText } from '../src/runtime/cli.ts';
import { LabError } from '../src/runtime/lab-runner.ts';

/* A command that fails never ends without a trace: a configuration error by its message, anything else with its kind and
   where it came from - even an error whose message is empty. */
test('a failure is said with its trace; a configuration error by its message', () => {
  assert.equal(failureText(new LabError('--seed: a number')), '--seed: a number');
  const silent = new Error('');
  assert.match(failureText(silent), /^Error\n\s+at /, 'an empty message still says where');
  assert.match(failureText(new TypeError('x is undefined')), /TypeError: x is undefined/);
  assert.equal(failureText(undefined), 'a failure that says nothing: undefined');
  assert.equal(failureText('plain'), 'plain');
});
