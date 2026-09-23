import test from 'node:test';
import assert from 'node:assert/strict';
import { Observer } from '../src/core/observer.ts';
import { nodeVmRunner } from '../src/runtime/node-vm.ts';
import { foxhounds } from '../src/worlds/foxhounds/world.ts';
import { foxhoundsDialect } from '../src/worlds/foxhounds/dialect.ts';
import type { MeasureDecl } from '../src/core/types.ts';
import { sampleStates } from './support.ts';

const states = sampleStates(80, 7);
const dsl = (op: string, args: Record<string, number> = {}): MeasureDecl => ({ spec: { kind: 'dsl', dialect: 'foxhounds@1', op, args } });

/* Eval mode can express the designer's catalogue from the RULES alone: these sources use only
   ctx.view and ctx.world (actions/step/outcome), never the foxhounds@1 dialect. That is the point
   of the mode - the strategic features become discoverable instead of given. */
const CODE: Record<string, string> = {
  cat_row_spread: `(ctx) => {
    const ys = ctx.view.entities.filter(e => e.type === 'cat').map(e => e.y);
    return Math.max(...ys) - Math.min(...ys);
  }`,
  mouse_mobility: `(ctx) => ctx.world.actions(ctx.state, 'mouse').length`,
  covered_mouse_moves: `function (ctx) {
    const cats = ctx.view.entities.filter(e => e.type === 'cat');
    return ctx.world.actions(ctx.state, 'mouse')
      .filter(m => cats.some(c => c.y === m.to[1] - 1 && Math.abs(c.x - m.to[0]) === 1)).length;
  }`,
  mouse_routes: `function (ctx) {
    const cap = 8, size = ctx.view.scalars.board_size;
    const cats = ctx.view.entities.filter(e => e.type === 'cat');
    const mouse = ctx.view.entities.find(e => e.type === 'mouse');
    const occupied = (x, y) => ctx.view.entities.some(e => e.x === x && e.y === y);
    const attacked = (x, y) => !occupied(x, y) && cats.some(c => c.y === y - 1 && Math.abs(c.x - x) === 1);
    const memo = new Map();
    const count = (x, y) => {
      if (y === 0) return 1;
      const k = x + ',' + y;
      if (memo.has(k)) return memo.get(k);
      let total = 0;
      for (const dx of [-1, 1]) {
        const nx = x + dx, ny = y - 1;
        if (nx < 0 || nx >= size || (nx + ny) % 2 !== 1 || occupied(nx, ny) || attacked(nx, ny)) continue;
        total += count(nx, ny);
        if (total >= cap) { total = cap; break; }
      }
      memo.set(k, total);
      return total;
    };
    return Math.min(count(mouse.x, mouse.y), cap);
  }`
};
const RANGES: Record<string, [number, number]> = { cat_row_spread: [0, 7], mouse_mobility: [0, 4], covered_mouse_moves: [0, 4], mouse_routes: [0, 8] };

for (const runnerName of ['function', 'node-vm'] as const) {
  test('Eval mode (' + runnerName + ' runner) rediscovers catalogue measures from the rules alone', () => {
    const observer = new Observer(foxhounds, { dialects: [foxhoundsDialect], runners: runnerName === 'node-vm' ? [nodeVmRunner()] : [] });
    const code: Record<string, MeasureDecl> = {};
    const catalogue: Record<string, MeasureDecl> = {};
    for (const id of Object.keys(CODE)) {
      code[id] = { spec: { kind: 'code', lang: 'js', source: CODE[id] }, range: RANGES[id] };
      catalogue[id] = dsl(id, id === 'mouse_routes' ? { cap: 8 } : {});
    }
    for (const s of states) {
      const a = observer.observe(s, code);
      const b = observer.observe(s, catalogue);
      assert.deepEqual(a.errors, []);
      assert.deepEqual(a.values, b.values);
    }
  });
}

test('core@1 expressions are world-neutral and can call a designer op', () => {
  const observer = new Observer(foxhounds, { dialects: [foxhoundsDialect] });
  const decls: Record<string, MeasureDecl> = {
    spread_expr: { spec: { kind: 'dsl', dialect: 'core@1', expr: { op: 'aggregate', group: 'cat', reduce: 'spread', field: 'y' } }, range: [0, 7] },
    spread_op: dsl('cat_row_spread'),
    gap_expr: { spec: { kind: 'dsl', dialect: 'core@1', expr: { op: 'sub', args: [
      { op: 'aggregate', group: 'cat', reduce: 'min', field: 'y' }, { op: 'call', dialect: 'foxhounds@1', name: 'mouse_row' }] } }, range: [-7, 7] },
    gap_op: dsl('cat_mouse_row_gap')
  };
  for (const s of states) {
    const o = observer.observe(s, decls);
    assert.equal(o.values.spread_expr, o.values.spread_op);
    assert.equal(o.values.gap_expr, o.values.gap_op);
  }
});

test('the experiment admits only the kinds it declares, and refuses the rest WITH A REASON', () => {
  const s = states[3];
  const codeOnly = new Observer(foxhounds, { kinds: ['code'], dialects: [foxhoundsDialect] });
  const o1 = codeOnly.observe(s, { a: dsl('mouse_row') });
  assert.match(o1.errors[0].error, /not admitted by this experiment/);
  const dslOnly = new Observer(foxhounds, { kinds: ['dsl'] });
  const o2 = dslOnly.observe(s, { b: { spec: { kind: 'code', lang: 'js', source: '() => 1' }, range: [0, 1] } });
  assert.match(o2.errors[0].error, /not admitted/);
  const o3 = dslOnly.observe(s, { c: dsl('mouse_row') });
  assert.match(o3.errors[0].error, /dialect "foxhounds@1" is not registered/);
  const both = new Observer(foxhounds);
  assert.match(both.observe(s, { d: { spec: { kind: 'code', lang: 'js', source: '() => 1' } } }).errors[0].error, /must declare a finite range/);
  assert.match(both.observe(s, { e: { spec: { kind: 'code', lang: 'py', source: 'lambda c: 1' }, range: [0, 1] } }).errors[0].error, /no runner for language "py"/);
  assert.match(both.observe(s, { f: { spec: { kind: 'dsl', dialect: 'core@1', expr: { op: 'const', value: 1 } } } }).errors[0].error, /declared finite range/);
});

test('a code measure is a pure fact: no randomness, no clock, no host globals; failures are reported, not neutralised', () => {
  for (const runners of [[], [nodeVmRunner()]]) {
    const observer = new Observer(foxhounds, { runners });
    const s = states[5];
    const o = observer.observe(s, {
      rnd: { spec: { kind: 'code', lang: 'js', source: '() => Math.random()' }, range: [0, 1] },
      clock: { spec: { kind: 'code', lang: 'js', source: '() => Date.now()' }, range: [0, 1] },
      proc: { spec: { kind: 'code', lang: 'js', source: '() => process.pid' }, range: [0, 1e9] },
      nan: { spec: { kind: 'code', lang: 'js', source: '() => NaN' }, range: [0, 1] },
      mutate: { spec: { kind: 'code', lang: 'js', source: '(ctx) => { ctx.state.cats[0][1] = 7; return 1; }' }, range: [0, 1] },
      ok: { spec: { kind: 'code', lang: 'js', source: '(ctx) => ctx.view.entities.length' }, range: [0, 10] }
    });
    assert.deepEqual(Object.keys(o.values), ['ok']);
    assert.equal(o.values.ok, 5);
    assert.deepEqual(o.errors.map((e) => e.id).sort(), ['clock', 'mutate', 'nan', 'proc', 'rnd']);
    assert.equal(s.cats[0][1] === 7, false, 'the caller\'s state is untouched');
  }
});

test('describe() tells the author exactly the vocabulary of this experiment', () => {
  const text = new Observer(foxhounds, { dialects: [foxhoundsDialect] }).describe();
  assert.match(text, /Admitted measure kinds: code, dsl/);
  assert.match(text, /core@1 expression/);
  assert.match(text, /mouse_routes \[0,8\] \(args: cap in \[1,8\] default 3\)/);
  const codeOnly = new Observer(foxhounds, { kinds: ['code'], dialects: [foxhoundsDialect] }).describe();
  assert.doesNotMatch(codeOnly, /mouse_routes/);
});
