import vm from 'node:vm';
import type { CodeRunner, MeasureFn } from '../core/types.ts';

/** Runs the learner's code in a fresh V8 context with a timeout, no Math.random and no Date (deterministic, and nothing of
    the host reachable). What crosses into the context is TEXT only: the point is handed in as JSON and parsed inside, so the
    code never holds an object or a function of the host - through which `x.constructor.constructor("return process")()`
    reached the host's process (an external review, 14/10/2026). What it returns comes back as it is. */
export function nodeVmRunner(options: { timeoutMs?: number } = {}): CodeRunner {
  const timeout = options.timeoutMs ?? 5000;
  return {
    lang: 'js',
    compile(source: string): MeasureFn {
      const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
      vm.runInContext('"use strict"; delete Math.random; delete globalThis.Date;', context);
      /* The call, defined before the learner's code and never writable: it parses the point inside the context. */
      const install = new vm.Script('"use strict"; (fn) => { const parse = JSON.parse; Object.defineProperty(globalThis, "__call", { value: (text) => fn(parse(text)), writable: false, configurable: false }); }',
        { filename: 'measure-install.js' }).runInContext(context, { timeout });
      const fn = new vm.Script('"use strict"; (' + String(source).trim() + '\n)', { filename: 'measure.js' }).runInContext(context, { timeout });
      if (typeof fn !== 'function') throw new Error('the source must evaluate to a function (ctx) => number');
      install(fn);
      const call = new vm.Script('__call(__in)', { filename: 'measure-call.js' });
      return (ctx) => {
        context.__in = JSON.stringify(ctx ?? null);
        try {
          return call.runInContext(context, { timeout }) as number;
        } finally {
          context.__in = undefined;
        }
      };
    }
  };
}
