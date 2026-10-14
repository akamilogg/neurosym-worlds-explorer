import vm from 'node:vm';
import { mulberry32 } from '../../worlds/grid/gen.ts';

/* ============================================================================
 * The researcher's OWN INSTRUMENTS (SPEC-INSTRUMENTOS-PROPIOS): code it writes and registers, run
 * by the environment over what it has already observed - its episodes, the points of its checks,
 * what its models answered there - and returning what it computes. The environment gives
 * primitives only (read its data, a seeded generator); every analysis - a fit, a statistic, a
 * comparison - is the researcher's own code. An instrument observes nothing new (no act, no
 * service, no Judge) and never reads the places of the exam (the family, the blind sets).
 *
 * It runs synchronously in a sandbox (no Date, no Math.random, no code from strings, a time limit
 * the VM enforces), so the same use on the same data answers the same: a run is replayed and
 * resumed with it. What its models answered is asked for in the use itself and computed before
 * the instrument runs.
 * ========================================================================== */

/** The size of an instrument's code and of what one use answers, at most. */
export const INSTRUMENT_SOURCE_MAX = 12000;
export const INSTRUMENT_RESULT_MAX = 20000;
/** Points one use may read or have answered, at most (over all its calls), where each point is copied whole. */
export const INSTRUMENT_POINTS_MAX = 3000;
/** Numbers one use may copy of its episodes' series, at most: each episode once, whatever it reads of it. */
export const INSTRUMENT_NUMBERS_MAX = 5_000_000;
/** The time one use may run (ms). */
export const INSTRUMENT_TIMEOUT_MS = 30000;

export interface InstrumentVersion { readonly id: string; readonly version: number; readonly about: string; readonly source: string; readonly round: number }
export interface InstrumentOp { readonly do: 'write' | 'forget'; readonly id: string; readonly about?: string; readonly source?: string }

/** What a laboratory lets an instrument read: its data, in the learner's names, copied - never the host's own objects. */
export interface InstrumentData {
  /** The index of its episodes an instrument may read (no place of the exam). */
  episodes(): readonly Record<string, unknown>[];
  /** The points of an episode (or a stretch "ep@a-b"), each with its percept and what came there; null: no such episode. */
  points(ref: string, every: number): readonly { readonly point: string; readonly p: unknown; readonly came: unknown }[] | null;
  /** The whole of an episode as plain series, when the laboratory has them (compact: one array per quantity). */
  series?(id: string): Record<string, unknown> | null;
  /** With series: the SOURCE of `(series, k, prefix) => ({ p, came })`, the percept and what came at step k built over the
      series - its arrays views of their prefix (`prefix(array, n)`), never copies, so reading every point of an episode costs
      the episode once. It is compiled inside the sandbox: nothing of the host is ever handed to the researcher's code. Its
      number of steps is `series.steps`. */
  readonly perceptAtSource?: string;
}

/** How many numbers (and other leaves) a copy holds. */
const leaves = (x: unknown): number => (Array.isArray(x) ? x.reduce((n: number, v) => n + leaves(v), 0) : x && typeof x === 'object' ? Object.values(x).reduce((n: number, v) => n + leaves(v), 0) : 1);

const ID = /^[a-z][a-z0-9_]*$/;
const clone = <T>(x: T): T => (x === undefined ? x : JSON.parse(JSON.stringify(x)));

/** Its instrument operations as written: [{"do": "write" | "forget", "id", "about", "source"}] (a "source" without "do" is a write). */
export function parseInstruments(raw: unknown, warnings: string[]): InstrumentOp[] {
  const out: InstrumentOp[] = [];
  (Array.isArray(raw) ? raw : []).forEach((d, i) => {
    const o = d && typeof d === 'object' ? d as Record<string, unknown> : null;
    const act = o && o.do === undefined && typeof o.source === 'string' ? 'write' : o?.do;
    if (!o || (act !== 'write' && act !== 'forget') || typeof o.id !== 'string') { warnings.push('instrument #' + i + ' ignored: needs "id" and "do": write | forget'); return; }
    out.push({ do: act, id: o.id, ...(typeof o.about === 'string' ? { about: o.about } : {}), ...(typeof o.source === 'string' ? { source: o.source } : {}) });
  });
  return out;
}

/* What the sandbox builds for itself, before the researcher's code: its `env`, from a bridge to the host that only takes and
   gives TEXT (JSON) and is never reachable from that code - a host object or function inside the context would lead out of it
   (`env.episodes.constructor("return process")()`: an external review, 14/10/2026). The bridge never throws into the
   context: its errors come back as text, and are thrown here as the context's own. */
export const BOOTSTRAP = `"use strict";
(bridge, perceptAt, hasSeries) => {
  const parse = JSON.parse, text = JSON.stringify;
  const call = (op, arg) => { const r = parse(bridge(op, text(arg === undefined ? null : arg))); if (r.error !== undefined) throw new Error(r.error); return r.value; };
  const index = (prop) => { if (typeof prop !== "string") return null; const i = Number(prop); return Number.isInteger(i) && i >= 0 && String(i) === prop ? i : null; };
  /* The first n elements of an array as an array that reads them where they are: never a copy, never writable. */
  const prefix = (arr, n) => {
    const len = Math.max(0, Math.min(Math.floor(n), arr.length));
    return new Proxy([], {
      get: (t, p, r) => (p === "length" ? len : index(p) !== null ? (index(p) < len ? arr[index(p)] : undefined) : Reflect.get(t, p, r)),
      has: (t, p) => (index(p) !== null ? index(p) < len : Reflect.has(t, p)),
      ownKeys: () => [...Array.from({ length: len }, (_, i) => String(i)), "length"],
      getOwnPropertyDescriptor: (t, p) => (p === "length" ? { value: len, writable: true, enumerable: false, configurable: false }
        : index(p) !== null && index(p) < len ? { value: arr[index(p)], writable: false, enumerable: true, configurable: true } : undefined),
      set: () => false, defineProperty: () => false, deleteProperty: () => false
    });
  };
  const copies = new Map();
  const series = (id) => { id = String(id); if (!copies.has(id)) copies.set(id, call("series", id)); return copies.get(id); };
  const env = {
    episodes: () => call("episodes"),
    points: (ref, every = 1) => {
      const step = Math.max(1, Math.floor(Number(every) || 1));
      if (!perceptAt) return call("points", { ref: String(ref), every: step });
      const m = /^([a-z][a-z0-9-]*)(?:@(\\d+)-(\\d+))?$/.exec(String(ref).trim());
      if (!m) throw new Error("no episode of yours \\"" + ref + "\\"");
      const s = series(m[1]);
      const steps = Number(s.steps) || 0;
      const from = m[2] ? Number(m[2]) : 0, to = Math.min(steps - 1, m[3] ? Number(m[3]) : steps - 1);
      const out = [];
      for (let k = from; k <= to; k++) if (k % step === 0) out.push(Object.assign({ point: m[1] + "@" + k }, perceptAt(s, k, prefix)));
      return out;
    },
    answers: (model, ref, every = 1) => call("answers", { model, ref: String(ref), every: Math.max(1, Math.floor(Number(every) || 1)) }),
    random: (seed) => {
      let a = Math.floor(Number(seed) || 0) >>> 0;
      return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    }
  };
  if (hasSeries) env.series = series;
  Object.freeze(env);
  /* The run: its arguments parsed here, its result made text here - within the time limit, as the run itself. */
  Object.defineProperty(globalThis, "__run", { value: (fn, input) => {
    const r = fn(parse(input), env);
    if (r !== null && (typeof r === "object" || typeof r === "function") && typeof r.then === "function") return "\\u0001promise";
    const out = text(r);
    return out === undefined ? "\\u0001nothing" : out;
  }, writable: false, configurable: false });
}`;

/** A fresh sandbox: nothing of the host, no clock, no unseeded randomness, no code from strings. */
function sandbox(): vm.Context {
  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext('"use strict"; delete Math.random; delete globalThis.Date;', context);
  return context;
}

/** Its code, compiled in a sandbox: the function, or why not. */
function compile(source: string, context: vm.Context): Function | string {
  if (source.length > INSTRUMENT_SOURCE_MAX) return 'its code is ' + source.length + ' characters, at most ' + INSTRUMENT_SOURCE_MAX;
  try {
    const fn = new vm.Script('"use strict"; (' + source.trim() + '\n)', { filename: 'instrument.js' }).runInContext(context, { timeout: 2000 });
    return typeof fn === 'function' ? fn : 'its code must be a function (args, env) => result';
  } catch (e) { return 'its code does not compile: ' + String((e as Error)?.message ?? e); }
}

export class Instruments {
  private readonly versions = new Map<string, InstrumentVersion[]>();
  private readonly forgotten = new Set<string>();
  private readonly data: InstrumentData;
  /** What a model of its own answers at points (asked in the use, computed before it runs). */
  private readonly answerAt: (model: unknown, refs: readonly string[], every: number) => Promise<{ point: string; answer?: unknown; error?: string }[] | string>;
  private readonly log: (type: string, data: Record<string, unknown>) => void;
  private readonly timeoutMs: number;

  constructor(o: { data: InstrumentData; answerAt: Instruments['answerAt']; log: Instruments['log']; timeoutMs?: number }) {
    this.data = o.data;
    this.timeoutMs = o.timeoutMs ?? INSTRUMENT_TIMEOUT_MS;
    this.answerAt = o.answerAt;
    this.log = o.log;
  }

  static accepts(q: Record<string, unknown>): boolean { return typeof q.use === 'string'; }

  /** Its instruments as they are now: the latest version of each it has not forgotten. */
  current(): InstrumentVersion[] {
    return [...this.versions.entries()].filter(([id]) => !this.forgotten.has(id)).map(([, vs]) => vs[vs.length - 1]);
  }

  /** All the versions of all its instruments (its memory, its senior). */
  all(): InstrumentVersion[] { return [...this.versions.values()].flat(); }

  /** Write (a new version) or forget its instruments; what was refused, as warnings. Compiled, never run. */
  apply(round: number, ops: readonly InstrumentOp[]): string[] {
    const warnings: string[] = [];
    for (const op of ops) {
      if (!ID.test(op.id)) { warnings.push('instrument id "' + op.id + '" must be lowercase snake_case'); continue; }
      if (op.do === 'forget') {
        if (!this.versions.has(op.id) || this.forgotten.has(op.id)) { warnings.push('instrument "' + op.id + '" does not exist'); continue; }
        this.forgotten.add(op.id);
        this.log('instrument_forgotten', { round, id: op.id });
        continue;
      }
      if (typeof op.source !== 'string' || !op.source.trim()) { warnings.push('instrument "' + op.id + '" has no source'); continue; }
      const fn = compile(op.source, sandbox());
      if (typeof fn === 'string') { warnings.push('instrument "' + op.id + '" not registered: ' + fn); continue; }
      const list = this.versions.get(op.id) ?? [];
      const v: InstrumentVersion = { id: op.id, version: list.length + 1, about: op.about ?? list[list.length - 1]?.about ?? '', source: op.source, round };
      list.push(v);
      this.versions.set(op.id, list);
      this.forgotten.delete(op.id);
      this.log('instrument_registered', { round, id: v.id, version: v.version, about: v.about, source: v.source });
    }
    return warnings;
  }

  /** One use: {"use": "<id>" | "<id>@<version>", "args": {...}, "answers": [{"model": <round>, "on": ["<episode or stretch>", ...], "every": n}]}. */
  async use(q: Record<string, unknown>, round: number): Promise<Record<string, unknown>> {
    const asked = String(q.use);
    const m = /^([a-z][a-z0-9_]*)(?:@(\d+))?$/.exec(asked);
    const refuse = (why: string) => ({ use: asked, error: why });
    if (!m) return refuse('"use": "<instrument>" or "<instrument>@<version>"');
    const list = this.versions.get(m[1]);
    if (!list || (!m[2] && this.forgotten.has(m[1]))) return refuse('you have no instrument "' + m[1] + '"' + (this.current().length ? ' (yours: ' + this.current().map((v) => v.id).join(', ') + ')' : ''));
    const v = m[2] ? list[Number(m[2]) - 1] : list[list.length - 1];
    if (!v) return refuse('instrument "' + m[1] + '" has ' + list.length + ' version(s)');
    let budget = INSTRUMENT_POINTS_MAX;
    let numbers = INSTRUMENT_NUMBERS_MAX;
    /* What its models answered, asked in the use: computed first (the instrument runs synchronously). */
    const answers = new Map<string, unknown>();
    for (const a of (Array.isArray(q.answers) ? q.answers : []) as Record<string, unknown>[]) {
      const refs = (Array.isArray(a?.on) ? a.on : typeof a?.on === 'string' ? [a.on] : []).map(String);
      const every = Math.max(1, Math.floor(Number(a?.every) || 1));
      for (const ref of refs) {
        const got = await this.answerAt(a?.model, [ref], every);
        if (typeof got === 'string') return refuse('answers: ' + got);
        budget -= got.length;
        if (budget < 0) return refuse('answers: more than ' + INSTRUMENT_POINTS_MAX + ' points in one use: ask for fewer, or with a larger "every"');
        answers.set(JSON.stringify([a?.model, ref, every]), got);
      }
    }
    /* The bridge: text in, text out, never a throw. What it reads it accounts for. */
    const bridge = (op: string, argText: string): string => {
      try {
        const arg = JSON.parse(String(argText)) as Record<string, unknown> | string | null;
        const ok = (value: unknown) => JSON.stringify({ value: value === undefined ? null : value });
        if (op === 'episodes') return ok(this.data.episodes());
        if (op === 'series') {
          const raw = this.data.series?.(String(arg)) ?? null;
          if (raw === null) return JSON.stringify({ error: 'no episode of yours "' + String(arg) + '"' });
          numbers -= leaves(raw);
          if (numbers < 0) return JSON.stringify({ error: 'more than ' + INSTRUMENT_NUMBERS_MAX + ' numbers of your episodes read in one use: read fewer episodes' });
          return ok(raw);
        }
        if (op === 'points') {
          const a = (arg ?? {}) as { ref?: string; every?: number };
          const pts = this.data.points(String(a.ref), Math.max(1, Math.floor(Number(a.every) || 1)));
          if (pts === null) return JSON.stringify({ error: 'no episode of yours "' + String(a.ref) + '"' });
          budget -= pts.length;
          if (budget < 0) return JSON.stringify({ error: 'more than ' + INSTRUMENT_POINTS_MAX + ' points read in one use: read fewer, or with a larger "every"' });
          return ok(pts);
        }
        if (op === 'answers') {
          const a = (arg ?? {}) as { model?: unknown; ref?: string; every?: number };
          const got = answers.get(JSON.stringify([a.model, String(a.ref), a.every]));
          return got === undefined ? JSON.stringify({ error: 'the answers of model ' + JSON.stringify(a.model) + ' on "' + a.ref + '" were not asked in this use ("answers")' }) : ok(got);
        }
        return JSON.stringify({ error: 'no such primitive "' + op + '"' });
      } catch (e) { return JSON.stringify({ error: String((e as Error)?.message ?? e) }); }
    };
    const context = sandbox();
    const started = Date.now();
    let out: unknown;
    try {
      /* Its env first, then its code: nothing of the host but the bridge's text ever reaches the context. */
      const perceptAt = this.data.series && this.data.perceptAtSource
        ? new vm.Script('"use strict"; (' + this.data.perceptAtSource + ')', { filename: 'percept.js' }).runInContext(context, { timeout: 2000 }) : null;
      (new vm.Script(BOOTSTRAP, { filename: 'instrument-env.js' }).runInContext(context, { timeout: 2000 }) as Function)(bridge, perceptAt, Boolean(this.data.series));
      const fn = compile(v.source, context);
      if (typeof fn === 'string') return refuse(fn);
      context.__fn = fn;
      context.__in = JSON.stringify(q.args ?? {});
      out = new vm.Script('__run(__fn, __in)', { filename: 'instrument-call.js' }).runInContext(context, { timeout: this.timeoutMs });
      if (typeof out !== 'string') throw new Error('what it returned could not be read');
      if (out === '\u0001promise') throw new Error('an instrument runs synchronously: return its result, not a promise');
      if (out === '\u0001nothing') throw new Error('it returned nothing that can be written as JSON (a function, or undefined)');
    } catch (e) {
      const error = String((e as Error)?.message ?? e);
      this.log('instrument_used', { round, id: v.id, version: v.version, args: q.args ?? {}, ...(q.answers ? { answers: q.answers } : {}), error, ms: Date.now() - started });
      return { use: v.id + '@' + v.version, error };
    }
    const text = out as string;
    const clipped = text.length > INSTRUMENT_RESULT_MAX;
    const answer = clipped ? text.slice(0, INSTRUMENT_RESULT_MAX) : JSON.parse(text);
    this.log('instrument_used', { round, id: v.id, version: v.version, args: q.args ?? {}, ...(q.answers ? { answers: q.answers } : {}), result: answer, ...(clipped ? { clipped: text.length } : {}), ms: Date.now() - started });
    return { use: v.id + '@' + v.version, result: answer, ...(clipped ? { note: 'what it returned is ' + text.length + ' characters: only the first ' + INSTRUMENT_RESULT_MAX + ' are shown, as text' } : {}) };
  }
}

/** What the assisted researcher is told of its own instruments, with what this laboratory lets them read. */
export function instrumentsSection(seriesDoc: string | null, words?: { readonly points: string; readonly answers: string }): string {
  return [
    'YOUR OWN INSTRUMENTS. You may write the tools you analyse your data with, and the environment runs them for you over what you have already observed. Register one in any of your answers (it costs nothing, like a note): "instruments": [{"do": "write" | "forget", "id": "<lowercase_snake_case>", "about": "what it computes", "source": "(args, env) => { ... return result; }"}] - a write of an id you have is its next version. Use one as an investigation request (it costs a step): {"use": "<id>" | "<id>@<version>", "args": { ... }, "answers": [{"model": <a round of yours>, "on": ["<episode>" | "<episode>@<from>-<to>", ...], "every": <n>}]}.',
    'What `env` gives your code - primitives only; any fit, statistic or comparison is yours to write: `env.episodes()` the index of your episodes; `env.points("<episode>" | "<episode>@<from>-<to>", every)` ' + (words?.points ?? 'each point with the percept `p` your models receive there and what `came` there')
    + (seriesDoc ? '; `env.series("<episode>")` ' + seriesDoc : '')
    + '; `env.answers(<round>, "<episode or stretch>", every)` ' + (words?.answers ?? 'what that model of yours answered at those points') + ' - asked in the use\'s "answers", computed before your instrument runs; `env.random(seed)` a seeded generator (there is no Math.random and no clock).',
    'An instrument analyses what you have observed; it observes nothing new: it cannot act, simulate or ask the Judge, and it reads neither the places of your validations nor the confirmations. It runs synchronously, at most ' + (INSTRUMENT_TIMEOUT_MS / 1000) + ' s and ' + INSTRUMENT_POINTS_MAX + ' points a use; what it returns is shown to you (at most ' + INSTRUMENT_RESULT_MAX + ' characters). The same use on the same data answers the same.',
    'It is your instrument and your responsibility: before you trust what it says, try it where you know the answer. What you find with it is evidence only as far as your checks confirm it.'
  ].join('\n');
}
