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
  /** With series: the percept and what came at step k, built over (a copy of) them - its arrays views of the series' prefix,
      never copies, so reading every point of an episode costs the episode once. Its number of steps is `series.steps`. */
  perceptAt?(series: Record<string, unknown>, k: number, prefix: <T>(a: readonly T[], n: number) => readonly T[]): { readonly p: unknown; readonly came: unknown };
}

/** The first n elements of an array, as an array that reads them where they are: its length, its indices, its methods and
    `Array.isArray` as an array's; it cannot be written. A point's history is a view of its episode's, never a copy. */
export function prefixView<T>(arr: readonly T[], n: number): readonly T[] {
  const len = Math.max(0, Math.min(Math.floor(n), arr.length));
  const index = (prop: PropertyKey): number | null => {
    if (typeof prop !== 'string') return null;
    const i = Number(prop);
    return Number.isInteger(i) && i >= 0 && String(i) === prop ? i : null;
  };
  return new Proxy([] as T[], {
    get: (t, prop, r) => (prop === 'length' ? len : index(prop) !== null ? (index(prop)! < len ? arr[index(prop)!] : undefined) : Reflect.get(t, prop, r)),
    has: (t, prop) => (index(prop) !== null ? index(prop)! < len : Reflect.has(t, prop)),
    ownKeys: () => [...Array.from({ length: len }, (_, i) => String(i)), 'length'],
    getOwnPropertyDescriptor: (t, prop) => (prop === 'length' ? { value: len, writable: true, enumerable: false, configurable: false }
      : index(prop) !== null && index(prop)! < len ? { value: arr[index(prop)!], writable: false, enumerable: true, configurable: true } : undefined),
    set: () => false, defineProperty: () => false, deleteProperty: () => false
  });
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
    /* Each episode's series copied once a use, and read through views: what it costs is the episodes, not the points. */
    let numbers = INSTRUMENT_NUMBERS_MAX;
    const copies = new Map<string, Record<string, unknown>>();
    const copyOf = (id: string): Record<string, unknown> => {
      const had = copies.get(id);
      if (had) return had;
      const raw = this.data.series?.(id) ?? null;
      if (raw === null) throw new Error('no episode of yours "' + id + '"');
      const copy = clone(raw);
      numbers -= leaves(copy);
      if (numbers < 0) throw new Error('more than ' + INSTRUMENT_NUMBERS_MAX + ' numbers of your episodes read in one use: read fewer episodes');
      copies.set(id, copy);
      return copy;
    };
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
    const context = sandbox();
    const fn = compile(v.source, context);
    if (typeof fn === 'string') return refuse(fn);
    const env = {
      episodes: () => clone(this.data.episodes()),
      points: (ref: string, every = 1) => {
        const step = Math.max(1, Math.floor(Number(every) || 1));
        if (this.data.series && this.data.perceptAt) {
          const m = /^([a-z][a-z0-9-]*)(?:@(\d+)-(\d+))?$/.exec(String(ref).trim());
          if (!m) throw new Error('no episode of yours "' + ref + '"');
          const copy = copyOf(m[1]);
          const steps = Number(copy.steps) || 0;
          const from = m[2] ? Number(m[2]) : 0, to = Math.min(steps - 1, m[3] ? Number(m[3]) : steps - 1);
          const out: { point: string; p: unknown; came: unknown }[] = [];
          for (let k = from; k <= to; k++) if (k % step === 0) out.push({ point: m[1] + '@' + k, ...this.data.perceptAt(copy, k, prefixView) });
          return out;
        }
        const pts = this.data.points(String(ref), step);
        if (pts === null) throw new Error('no episode of yours "' + ref + '"');
        budget -= pts.length;
        if (budget < 0) throw new Error('more than ' + INSTRUMENT_POINTS_MAX + ' points read in one use: read fewer, or with a larger "every"');
        return clone(pts);
      },
      ...(this.data.series ? { series: (id: string) => copyOf(String(id)) } : {}),
      answers: (model: unknown, ref: string, every = 1) => {
        const got = answers.get(JSON.stringify([model, String(ref), Math.max(1, Math.floor(Number(every) || 1))]));
        if (got === undefined) throw new Error('the answers of model ' + JSON.stringify(model) + ' on "' + ref + '" were not asked in this use ("answers")');
        return clone(got);
      },
      random: (seed: number) => mulberry32(Math.floor(Number(seed) || 0))
    };
    const started = Date.now();
    let result: unknown;
    try {
      context.__fn = fn;
      context.__args = clone(q.args ?? {});
      context.__env = env;
      result = new vm.Script('__fn(__args, __env)', { filename: 'instrument-call.js' }).runInContext(context, { timeout: this.timeoutMs });
      if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('an instrument runs synchronously: return its result, not a promise');
    } catch (e) {
      const error = String((e as Error)?.message ?? e);
      this.log('instrument_used', { round, id: v.id, version: v.version, args: q.args ?? {}, ...(q.answers ? { answers: q.answers } : {}), error, ms: Date.now() - started });
      return { use: v.id + '@' + v.version, error };
    }
    let text: string;
    try { text = JSON.stringify(result ?? null); } catch { text = JSON.stringify(String(result)); }
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
