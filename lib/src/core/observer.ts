import { clamp, cloneJson, deepFreeze, round, specHash } from './hash.ts';
import { coreDialect } from './core-dialect.ts';
import { jsFunctionRunner } from './code-runner.ts';
import type {
  CodeRunner, Compiled, CompileEnv, Dialect, MeasureContext, MeasureDecl, MeasureKind, MeasureSpec, View, World
} from './types.ts';

/* ============================================================================
 * The Observer: O(s). The single seam where HOW a measure is computed is decided.
 *
 * The experiment designer chooses which measure kinds exist in the experiment:
 *   kinds: ["code"]          Eval mode only - System 2 writes functions
 *   kinds: ["dsl"]           DSL mode only  - core@1 + the designer's dialects
 *   kinds: ["code", "dsl"]   both (default)
 * A spec of a kind or dialect the experiment does not admit is REFUSED with a reason,
 * never replaced by a neutral number.
 * ========================================================================== */

export interface ObserverOptions {
  readonly kinds?: readonly MeasureKind[];
  /** Designer dialects. core@1 is always registered unless `core: false`. */
  readonly dialects?: readonly Dialect[];
  readonly core?: boolean;
  /** Runners for code measures. A "js" runner is registered by default. */
  readonly runners?: readonly CodeRunner[];
  readonly compileCacheLimit?: number;
}

export interface MeasureError {
  readonly id: string;
  readonly error: string;
}

export interface Observation {
  readonly values: Readonly<Record<string, number>>;
  readonly errors: readonly MeasureError[];
  /** Canonical `id=value#specHash|...`: the key under which a judgment can be reused. */
  readonly vector: string;
  readonly count: number;
  readonly view: View;
  /** Wall time per measure (ms): the observable cost of each fact. */
  readonly timings: Readonly<Record<string, number>>;
}

export interface ObserverStats {
  compilations: number;
  computations: number;
  errors: number;
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class Observer<S = unknown> {
  readonly world: World<S>;
  readonly kinds: readonly MeasureKind[];
  readonly stats: ObserverStats = { compilations: 0, computations: 0, errors: 0 };
  private readonly dialects = new Map<string, Dialect>();
  private readonly runners = new Map<string, CodeRunner>();
  private readonly cache = new Map<string, Compiled>();
  private readonly cacheLimit: number;

  constructor(world: World<S>, options: ObserverOptions = {}) {
    this.world = world;
    this.kinds = options.kinds && options.kinds.length ? options.kinds.slice() : ['code', 'dsl'];
    this.cacheLimit = options.compileCacheLimit ?? 4000;
    if (options.core !== false) this.registerDialect(coreDialect());
    for (const d of options.dialects ?? []) this.registerDialect(d);
    this.registerRunner(jsFunctionRunner());
    for (const r of options.runners ?? []) this.registerRunner(r);
  }

  registerDialect(dialect: Dialect): void {
    if (dialect.worlds && !dialect.worlds.includes(this.world.id)) {
      throw new Error('dialect ' + dialect.id + ' does not support world ' + this.world.id);
    }
    this.dialects.set(dialect.id, dialect);
    this.cache.clear();
  }

  registerRunner(runner: CodeRunner): void {
    this.runners.set(runner.lang, runner);
    this.cache.clear();
  }

  dialectIds(): string[] { return [...this.dialects.keys()]; }
  languages(): string[] { return [...this.runners.keys()]; }

  /** The vocabulary of this experiment, as the author (System 2 or a human) should read it. */
  describe(): string {
    const parts: string[] = ['Admitted measure kinds: ' + this.kinds.join(', ') + '.'];
    if (this.kinds.includes('code')) {
      parts.push('code: {kind:"code", lang:' + this.languages().map((l) => '"' + l + '"').join('|') +
        ', source:"(ctx) => number"} with ctx = {view, state, world}; pure and deterministic; declare a range.');
    }
    if (this.kinds.includes('dsl')) {
      for (const d of this.dialects.values()) parts.push('dsl ' + d.id + ':\n' + d.describe());
    }
    return parts.join('\n');
  }

  /** Compile one spec. The range of the declaration wins over the dialect's own. */
  compile(spec: MeasureSpec, declaredRange?: readonly [number, number]): Compiled {
    const key = specHash(spec) + '|' + (declaredRange ? declaredRange.join(',') : '');
    const hit = this.cache.get(key);
    if (hit) return hit;
    const compiled = this.compileUncached(spec, declaredRange);
    if (this.cache.size >= this.cacheLimit) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(key, compiled);
    return compiled;
  }

  private compileUncached(spec: MeasureSpec, declaredRange?: readonly [number, number]): Compiled {
    const hash = specHash(spec);
    if (!spec || typeof spec !== 'object') return { ok: false, kind: null, hash, error: 'the measure spec is not an object' };
    if (spec.kind !== 'code' && spec.kind !== 'dsl') {
      const unknownKind = String((spec as { kind?: unknown }).kind);
      return { ok: false, kind: unknownKind, hash, error: 'measure kind "' + unknownKind + '" is unknown (kinds: code, dsl)' };
    }
    const kind = spec.kind;
    if (!this.kinds.includes(kind)) {
      return { ok: false, kind, hash, error: 'measure kind "' + kind + '" is not admitted by this experiment (admitted: ' + this.kinds.join(', ') + ')' };
    }
    const range = validRange(declaredRange);
    this.stats.compilations++;
    if (kind === 'code') {
      const runner = this.runners.get(spec.lang);
      if (!runner) return { ok: false, kind, hash, error: 'no runner for language "' + spec.lang + '" in this host (it runs: ' + this.languages().join(', ') + ')' };
      if (!range) return { ok: false, kind, hash, error: 'a code measure must declare a finite range [min,max]' };
      try {
        return { ok: true, kind, fn: runner.compile(spec.source), range, hash, warnings: [] };
      } catch (error) {
        return { ok: false, kind, hash, error: 'the code does not compile: ' + message(error) };
      }
    }
    const dialect = this.dialects.get(spec.dialect);
    if (!dialect) return { ok: false, kind, hash, error: 'dialect "' + spec.dialect + '" is not registered (registered: ' + this.dialectIds().join(', ') + ')' };
    const env: CompileEnv = { resolve: (inner, innerRange) => this.compile(inner, innerRange) };
    const compiled = dialect.compile(spec, env);
    if (!compiled.ok) return compiled;
    const settled = range ?? compiled.range;
    if (!settled) return { ok: false, kind, hash, error: dialect.id + ' measures need a declared finite range [min,max]' };
    return { ...compiled, range: settled };
  }

  /** Measure one state. Pure: no network, no judge. A measure that fails is REPORTED and left out. */
  observe(state: S, observations: Readonly<Record<string, MeasureDecl>>): Observation {
    const frozen = deepFreeze(cloneJson(state));
    const view = deepFreeze(this.world.view(frozen));
    const ctx: MeasureContext<S> = Object.freeze({ view, state: frozen, world: this.world });
    const values: Record<string, number> = {};
    const errors: MeasureError[] = [];
    const timings: Record<string, number> = {};
    const parts: string[] = [];
    for (const id of Object.keys(observations || {})) {
      const decl = observations[id];
      const compiled = this.compile(decl?.spec, decl?.range);
      if (!compiled.ok) { errors.push({ id, error: compiled.error }); this.stats.errors++; continue; }
      const started = now();
      let value: unknown = null;
      let failure: string | null = null;
      try { value = compiled.fn(ctx as MeasureContext); } catch (error) { failure = message(error); }
      timings[id] = round(now() - started, 3);
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push({ id, error: failure ?? 'the measure produced no finite number' });
        this.stats.errors++;
        continue;
      }
      const r = compiled.range!;
      const bounded = round(clamp(value, r[0], r[1]), 4);
      values[id] = bounded;
      parts.push(id + '=' + bounded + '#' + compiled.hash);
      this.stats.computations++;
    }
    parts.sort();
    return { values, errors, vector: parts.join('|'), count: parts.length, view, timings };
  }
}

function validRange(range?: readonly [number, number]): readonly [number, number] | null {
  return Array.isArray(range) && range.length === 2 && Number.isFinite(range[0]) && Number.isFinite(range[1]) && range[0] <= range[1]
    ? [range[0], range[1]] : null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
