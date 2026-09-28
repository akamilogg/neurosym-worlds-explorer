import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExplorerTurn } from '../src/learn/explorer.ts';
import { parseLawTurn } from '../src/learn/law-explorer.ts';

/* Seen in real runs: System 2 put "on" inside "measure", and asked for a table without a range. Both are read. */

const ask = (investigate: unknown[]) => JSON.stringify({ investigate });

test('law requests: "on" beside or inside measure and table; a table without a range composes a text', () => {
  const t = parseLawTurn(ask([
    { measure: { source: '(p) => 1', on: ['ep1@1'] } },
    { measure: { source: '(p) => 1', range: [0, 2] }, on: ['ep1@2'] },
    { table: { source: '(p) => "x"' }, on: 'checks' },
    { table: { source: '(p) => 1', range: [0, 1], on: 'checks' } },
    { table: { source: '(p) => 1', range: 'wide' } }
  ]), { world: 'cells@1', parseAct: () => 'no act here' });
  assert.equal(t.kind, 'investigate');
  if (t.kind !== 'investigate') return;
  assert.deepEqual(t.requests, [
    { measure: { source: '(p) => 1', range: null }, on: ['ep1@1'] },
    { measure: { source: '(p) => 1', range: [0, 2] }, on: ['ep1@2'] },
    { table: { source: '(p) => "x"', range: null }, on: 'checks' },
    { table: { source: '(p) => 1', range: [0, 1] }, on: 'checks' }
  ]);
  assert.match(t.warnings[0], /table needs "source" \(and a valid "range"/);
});

test('grid requests: the same tolerance', () => {
  const t = parseExplorerTurn(ask([
    { measure: { source: '(p) => 1', on: ['g1@1'] } },
    { table: { source: '(p) => 1', on: 'final' } }
  ]), { world: 'grid@1:x', senses: {} });
  assert.equal(t.kind, 'investigate');
  if (t.kind !== 'investigate') return;
  assert.deepEqual(t.requests, [
    { measure: { source: '(p) => 1', range: null }, on: ['g1@1'] },
    { table: { source: '(p) => 1', range: null }, on: 'final' }
  ]);
  assert.deepEqual(t.warnings, []);
});
