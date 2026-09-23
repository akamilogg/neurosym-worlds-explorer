import vm from 'node:vm';
import type { CodeRunner, MeasureFn } from '../core/types.ts';

/* Node-only runner for "js" code measures: each measure lives in its own V8 context with no
   host globals (no require, process, timers, network), Math.random removed, and a wall-clock
   timeout per call. The timeout is a guard against a hung measure, not a compute budget:
   set it as high as the experiment needs. */
export function nodeVmRunner(options: { timeoutMs?: number } = {}): CodeRunner {
  const timeout = options.timeoutMs ?? 5000;
  return {
    lang: 'js',
    compile(source: string): MeasureFn {
      const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
      vm.runInContext('"use strict"; delete Math.random; delete globalThis.Date;', context);
      const fn = new vm.Script('"use strict"; (' + String(source).trim() + '\n)', { filename: 'measure.js' })
        .runInContext(context, { timeout });
      if (typeof fn !== 'function') throw new Error('the source must evaluate to a function (ctx) => number');
      const call = new vm.Script('__fn(__ctx)', { filename: 'measure-call.js' });
      return (ctx) => {
        context.__fn = fn;
        context.__ctx = ctx;
        try {
          return call.runInContext(context, { timeout }) as number;
        } finally {
          context.__ctx = undefined;
        }
      };
    }
  };
}
