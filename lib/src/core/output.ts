import { jsFunctionRunner } from './code-runner.ts';
import type { CodeRunner, CodeSpec } from './types.ts';

/* ============================================================================
 * OUTPUT: how a model turns what it measured and what the Judge answered into the
 * answer the environment asks for.
 *
 *     V(s)   = Σ_i w_i · r_i(O(s))                 (the weights over the rules)
 *     answer = output(p, { observations: O(s), rules: r_i, V })
 *
 * `output` is optional code written by the learner, `(p, m) => answer`, over what is
 * perceived (`p`, the same object its observations read) and `m`. Without it the answer
 * is V(s). With it the learner can combine, transform or reduce as it sees fit: logic
 * over its rules, a threshold, a network of nodes, a pair of numbers. Nothing here says
 * how - the environment only states the FORM of the answer.
 *
 * It may return the answer itself, or { answer, ...named intermediate values }: the
 * named values are shown back to it by `inspect`, so a model in code stays readable.
 *
 * Output never changes what the Judge is asked: the judgment hash, and so the cache,
 * depend on the observations and the rules only. It decides WHETHER the Judge is asked:
 * an output that never reads `m.rules` nor `m.V` answers without it (runIfJudgeUnread).
 * ========================================================================== */

export interface OutputInputs {
  /** O(s): each observation's number, or its text. */
  readonly observations: Readonly<Record<string, number | string>>;
  /** r_i(O(s)): each rule's answer, 0..1. */
  readonly rules: Readonly<Record<string, number>>;
  /** V(s) = Σ w_i r_i, or null when the model has no rules. */
  readonly V: number | null;
}

export interface OutputResult {
  readonly answer: unknown;
  /** Named intermediate values the output chose to show. */
  readonly parts: Readonly<Record<string, unknown>>;
}

/** Compiles `output` code once per source, in the runner for its language (the same sandbox as the observations). */
export class OutputRunner {
  private readonly runners = new Map<string, CodeRunner>();
  private readonly compiled = new Map<string, (a: unknown) => unknown>();

  constructor(runners: readonly CodeRunner[] = []) {
    for (const r of [jsFunctionRunner(), ...runners]) this.runners.set(r.lang, r);
  }

  run(spec: CodeSpec, p: unknown, m: OutputInputs): OutputResult {
    const key = spec.lang + '|' + spec.source;
    let fn = this.compiled.get(key);
    if (!fn) {
      const runner = this.runners.get(spec.lang);
      if (!runner) throw new Error('no runner for language "' + spec.lang + '"');
      /* Runners call a function with one argument: the two are handed over in one. */
      fn = runner.compile('(__a) => (' + String(spec.source).trim() + '\n)(__a.p, __a.m)') as unknown as (a: unknown) => unknown;
      this.compiled.set(key, fn);
    }
    const out = fn({ p, m });
    if (out && typeof out === 'object' && !Array.isArray(out) && 'answer' in (out as object)) {
      const { answer, ...parts } = out as Record<string, unknown>;
      return { answer, parts };
    }
    return { answer: out, parts: {} };
  }

  /** Runs `output` before anything is asked of the Judge: `m.rules` and `m.V` are only read on demand. When the code
      reads neither, this is its answer and the Judge need not be asked at all; when it reads either (even inside a
      try/catch, or by spreading `m`), null: ask the Judge, then run it with the answers. The answer is the same either
      way - the Judge is only spared the questions nobody reads. */
  runIfJudgeUnread(spec: CodeSpec, p: unknown, observations: OutputInputs['observations']): OutputResult | null {
    let read = false;
    const unread = (): never => { read = true; throw new Error('the output reads the rules: ask the Judge first'); };
    const m = Object.defineProperties({ observations } as object, {
      rules: { enumerable: true, get: unread },
      V: { enumerable: true, get: unread }
    }) as OutputInputs;
    try {
      const out = this.run(spec, p, m);
      return read ? null : out;
    } catch (e) {
      if (read) return null;
      throw e;
    }
  }
}

/** What `output` reads as `m.observations`: each observation's number, or its text. */
export function outputObservations(values: Readonly<Record<string, number>>, texts: Readonly<Record<string, string>>): OutputInputs['observations'] {
  return { ...values, ...texts };
}

/** The inputs of `output` from an observation and the Judge's answers. */
export function outputInputs(values: Readonly<Record<string, number>>, texts: Readonly<Record<string, string>>,
  answers: Readonly<Record<string, number | undefined>>, V: number | null): OutputInputs {
  const rules: Record<string, number> = {};
  for (const [id, v] of Object.entries(answers)) if (typeof v === 'number' && Number.isFinite(v)) rules[id] = v;
  return { observations: outputObservations(values, texts), rules, V };
}
