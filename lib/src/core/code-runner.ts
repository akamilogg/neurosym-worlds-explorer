import type { CodeRunner, MeasureFn } from './types.ts';

/* ============================================================================
 * "code" measures in JavaScript - the Eval mode.
 *
 * The source is a function expression over the measure context:
 *     (ctx) => ctx.view.entities.filter(e => e.type === 'cat').length
 *     function (ctx) { const moves = ctx.world.actions(ctx.state, 'mouse'); ... }
 *
 * There is NO compute limit by design: a code measure may search, simulate, count
 * routes - anything deterministic. What it must be is a pure function of its context,
 * because a measure is a fact about the state that caches and replays rely on. So the
 * runner removes the ambient sources of nondeterminism and of side effects from the
 * function's scope (Math.random, Date, timers, network, globals). This is a HYGIENE
 * boundary for code written by our own System 2, not a security sandbox for hostile
 * code; a host that needs isolation registers a different runner for "js"
 * (see runtime/node-vm.ts).
 * ========================================================================== */

const DETERMINISTIC_MATH: Math = Object.freeze(Object.assign(
  Object.create(Object.getPrototypeOf(Math)),
  Object.fromEntries(Object.getOwnPropertyNames(Math).filter((k) => k !== 'random').map((k) => [k, (Math as unknown as Record<string, unknown>)[k]]))
)) as Math;

/* Names shadowed as undefined inside the measure's scope. */
const SHADOWED = [
  'globalThis', 'window', 'self', 'global', 'process', 'require', 'module', 'exports',
  'fetch', 'XMLHttpRequest', 'WebSocket', 'importScripts', 'Worker',
  'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask', 'requestAnimationFrame',
  'Date', 'performance', 'crypto', 'localStorage', 'sessionStorage', 'indexedDB', 'document', 'navigator',
  'Function'
];
/* `eval` cannot be shadowed by a parameter in strict code; it is covered by the hygiene
   contract above, like `(() => {}).constructor`: reachable, and not for our own System 2 to use. */

export function jsFunctionRunner(): CodeRunner {
  return {
    lang: 'js',
    compile(source: string): MeasureFn {
      const text = String(source ?? '').trim();
      if (!text) throw new Error('empty source');
      /* eslint-disable-next-line no-new-func */
      const factory = new Function('Math', ...SHADOWED, '"use strict";\nreturn (' + text + '\n);');
      const fn = factory(DETERMINISTIC_MATH, ...SHADOWED.map(() => undefined));
      if (typeof fn !== 'function') throw new Error('the source must evaluate to a function (ctx) => number');
      return fn as MeasureFn;
    }
  };
}
