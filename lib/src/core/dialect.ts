import { clamp, specHash } from './hash.ts';
import type { Compiled, Dialect, DslSpec, MeasureContext } from './types.ts';

/* The typical way a designer adds a vocabulary: a table of named, documented, pure operations.
   `opDialect` turns that table into a Dialect whose payload is { op, args }. */

export interface OpArg {
  readonly min: number;
  readonly max: number;
  readonly default: number;
}

export interface OpDef<S = unknown> {
  readonly name: string;
  readonly definition: string;
  readonly range: readonly [number, number];
  readonly args?: Readonly<Record<string, OpArg>>;
  fn(ctx: MeasureContext<S>, args: Readonly<Record<string, number>>): number;
}

export function opDialect<S>(id: string, ops: Readonly<Record<string, OpDef<S>>>, worlds?: readonly string[]): Dialect {
  return {
    id,
    worlds,
    describe() {
      return Object.keys(ops).map((name) => {
        const op = ops[name];
        const args = Object.keys(op.args || {}).map((a) => {
          const d = op.args![a];
          return a + ' in [' + d.min + ',' + d.max + '] default ' + d.default;
        });
        return '- ' + name + ' [' + op.range.join(',') + ']' + (args.length ? ' (args: ' + args.join('; ') + ')' : '') + ': ' + op.definition;
      }).join('\n');
    },
    compile(spec: DslSpec): Compiled {
      const hash = specHash(spec);
      const name = String(spec.op ?? '');
      const op = ops[name];
      if (!op) {
        return { ok: false, kind: 'dsl', hash,
          error: 'unknown op "' + name + '" in ' + id + ' (it declares: ' + Object.keys(ops).join(', ') + ')' };
      }
      const given = (spec.args && typeof spec.args === 'object') ? spec.args as Record<string, unknown> : {};
      const settled: Record<string, number> = {};
      const warnings: string[] = [];
      for (const argName of Object.keys(op.args || {})) {
        const declared = op.args![argName];
        const value = given[argName];
        if (typeof value === 'number' && Number.isFinite(value)) {
          const bounded = clamp(value, declared.min, declared.max);
          if (bounded !== value) warnings.push('arg "' + argName + '" of ' + name + ' was clamped to ' + bounded);
          settled[argName] = Math.round(bounded);
        } else {
          settled[argName] = declared.default;
          if (value !== undefined) warnings.push('arg "' + argName + '" of ' + name + ' was not a finite number; default ' + declared.default + ' used');
        }
      }
      Object.freeze(settled);
      return { ok: true, kind: 'dsl', hash, range: op.range, warnings,
        fn: (ctx) => op.fn(ctx as MeasureContext<S>, settled) };
    }
  };
}
