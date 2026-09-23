import { clamp, specHash } from './hash.ts';
import type { Compiled, CompileEnv, Dialect, DslSpec, Entity, MeasureContext } from './types.ts';

/* ============================================================================
 * core@1 - the world-neutral expression language.
 *
 * A JSON AST over the View, so the same formula text runs in any host that implements
 * core@1. It knows nothing about any game: it aggregates entity attributes, reads
 * scalars, does arithmetic, and can CALL a named op of another registered dialect.
 *
 *   number | {op:"const", value}
 *   {op:"aggregate", group:<entity type>|"all", reduce:count|min|max|sum|mean|spread, field?}
 *   {op:"scalar", name}
 *   {op:"call", dialect, name, args?}
 *   {op:"abs"|"neg", arg}
 *   {op:"clamp", value, min, max}
 *   {op:"add"|"mul"|"min"|"max"|"mean", args:[...]}   {op:"sub"|"div", args:[a,b]}
 *
 * Size limits exist for READABILITY (a declarative formula nobody can read defeats
 * its purpose), not for compute: unbounded computation belongs to "code" measures.
 * ========================================================================== */

export const CORE_DIALECT_ID = 'core@1';
export const CORE_REDUCERS = ['count', 'min', 'max', 'sum', 'mean', 'spread'] as const;

export interface CoreDialectOptions {
  readonly maxNodes?: number;
  readonly maxDepth?: number;
}

type Node = (ctx: MeasureContext) => number;

function numericAttr(entity: Entity, field: string): number {
  const value = entity[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('entity ' + entity.type + '#' + entity.id + ' has no numeric "' + field + '"');
  }
  return value;
}

export function coreDialect(options: CoreDialectOptions = {}): Dialect {
  const maxNodes = options.maxNodes ?? 64;
  const maxDepth = options.maxDepth ?? 8;

  const compileExpression = (expression: unknown, env: CompileEnv): { fn: Node; nodes: number } => {
    let nodes = 0;
    const compileNode = (node: unknown, depth: number): Node => {
      nodes++;
      if (nodes > maxNodes) throw new Error('expression exceeds ' + maxNodes + ' nodes');
      if (depth > maxDepth) throw new Error('expression exceeds depth ' + maxDepth);
      if (typeof node === 'number' && Number.isFinite(node)) return () => node;
      if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error('every expression node must be an object or a finite number');
      const n = node as Record<string, unknown>;
      const op = String(n.op ?? '');
      switch (op) {
        case 'const': {
          const value = n.value;
          if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('const.value must be finite');
          return () => value;
        }
        case 'aggregate': {
          const group = String(n.group ?? 'all');
          const reduce = String(n.reduce ?? 'count');
          const field = n.field === undefined ? null : String(n.field);
          if (!(CORE_REDUCERS as readonly string[]).includes(reduce)) throw new Error('aggregate.reduce must be one of ' + CORE_REDUCERS.join(', '));
          if (reduce !== 'count' && !field) throw new Error('aggregate.' + reduce + ' needs a field');
          return (ctx) => {
            const selected = group === 'all' ? ctx.view.entities : ctx.view.entities.filter((e) => e.type === group);
            if (reduce === 'count') return selected.length;
            if (!selected.length) throw new Error('aggregate over an empty group "' + group + '"');
            const values = selected.map((e) => numericAttr(e, field!));
            if (reduce === 'min') return Math.min(...values);
            if (reduce === 'max') return Math.max(...values);
            const sum = values.reduce((a, b) => a + b, 0);
            if (reduce === 'sum') return sum;
            if (reduce === 'mean') return sum / values.length;
            return Math.max(...values) - Math.min(...values);
          };
        }
        case 'scalar': {
          const name = String(n.name ?? '');
          return (ctx) => {
            const value = ctx.view.scalars[name];
            if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('scalar "' + name + '" is not numeric');
            return value;
          };
        }
        case 'call': {
          const called = env.resolve({ kind: 'dsl', dialect: String(n.dialect ?? ''), op: n.name, args: n.args ?? {} });
          if (!called.ok) throw new Error('call to ' + String(n.dialect) + '/' + String(n.name) + ' is invalid: ' + called.error);
          return called.fn as Node;
        }
        case 'abs':
        case 'neg': {
          const child = compileNode(n.arg, depth + 1);
          return op === 'abs' ? (ctx) => Math.abs(child(ctx)) : (ctx) => -child(ctx);
        }
        case 'clamp': {
          const min = n.min, max = n.max;
          if (typeof min !== 'number' || typeof max !== 'number' || !Number.isFinite(min) || !Number.isFinite(max) || min > max) {
            throw new Error('clamp needs finite min <= max');
          }
          const child = compileNode(n.value, depth + 1);
          return (ctx) => clamp(child(ctx), min, max);
        }
        case 'add': case 'sub': case 'mul': case 'div': case 'min': case 'max': case 'mean': {
          const args = Array.isArray(n.args) ? n.args : [];
          if ((op === 'sub' || op === 'div') && args.length !== 2) throw new Error(op + ' needs exactly two args');
          if (args.length < 1) throw new Error(op + ' needs at least one arg');
          const children = args.map((a) => compileNode(a, depth + 1));
          return (ctx) => {
            const v = children.map((c) => c(ctx));
            if (v.some((x) => !Number.isFinite(x))) throw new Error(op + ' produced a non-finite operand');
            switch (op) {
              case 'add': return v.reduce((a, b) => a + b, 0);
              case 'sub': return v[0] - v[1];
              case 'mul': return v.reduce((a, b) => a * b, 1);
              case 'div': if (v[1] === 0) throw new Error('division by zero'); return v[0] / v[1];
              case 'min': return Math.min(...v);
              case 'max': return Math.max(...v);
              default: return v.reduce((a, b) => a + b, 0) / v.length;
            }
          };
        }
        default:
          throw new Error('unknown expression op "' + op + '"');
      }
    };
    return { fn: compileNode(expression, 0), nodes };
  };

  return {
    id: CORE_DIALECT_ID,
    describe() {
      return [
        'core@1 expression (JSON AST over the view: entities with numeric attributes, and scalars):',
        '  number | {op:"const",value} | {op:"scalar",name}',
        '  {op:"aggregate",group:<entity type>|"all",reduce:' + CORE_REDUCERS.join('|') + ',field?}',
        '  {op:"call",dialect,name,args?}  - a named op of another registered dialect',
        '  {op:"abs"|"neg",arg} | {op:"clamp",value,min,max}',
        '  {op:"add"|"mul"|"min"|"max"|"mean",args:[...]} | {op:"sub"|"div",args:[a,b]}',
        '  limits: ' + maxNodes + ' nodes, depth ' + maxDepth + '; the declaration must carry a finite range.'
      ].join('\n');
    },
    compile(spec: DslSpec, env: CompileEnv): Compiled {
      const hash = specHash(spec);
      try {
        const { fn } = compileExpression(spec.expr, env);
        return { ok: true, kind: 'dsl', fn, range: null, hash, warnings: [] };
      } catch (error) {
        return { ok: false, kind: 'dsl', hash, error: 'invalid core@1 expression: ' + (error instanceof Error ? error.message : String(error)) };
      }
    }
  };
}
