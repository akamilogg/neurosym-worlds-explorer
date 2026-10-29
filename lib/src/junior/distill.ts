import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { stableStringify } from '../core/hash.ts';
import { UserParts, type ChatClient } from '../learn/system2.ts';
import type { LabConnection } from '../runtime/lab-runner.ts';
import type { JuniorSessionClient } from './client.ts';
import type { CompetenceManifest, Mode } from './competence.ts';
import { executionHash, type JuniorPackage } from './package.ts';
import { captureCut, checkAtCut, type CheckOutcome, type Cut } from './probes.ts';
import type { MemoryState } from './sessions.ts';

/* ============================================================================
 * DISTILLATION FROM A CUT (SPEC-METAPOLITICA-APRENDIZAJE §8, §8.1): the junior and the strong model answer from the same
 * state of a development run, each in a copy, and their answers are compared by a criterion fixed before the teacher is
 * asked - the harness's own checker at that cut.
 *
 * The TEACHER sees what the junior saw there (the same system message and user parts) and may use a memory like the
 * junior's: its put, append, get, list and delete are answered by the package's reference simulator on a copy of the cut's
 * memory (POST /memory), never by the junior's weights. Asking for one is a JSON answer of its own; the translation is
 * written in the record (TEACHER_TOOLS). What it writes exists only in its copy.
 *
 * Acceptance (§8.1), per example:
 *   verified       the teacher's answer passes the checker where the junior's fails: a supervised target for that competence
 *   unverified     both pass (no proof the teacher's is better), or a provider failed: material to investigate, never a target
 *   rejected       the teacher's answer fails the checker: a diagnosis, never an answer to imitate
 * `demonstration` needs an explicit judgment on its merit; no criterion here makes one, so none is produced yet.
 * Every example is kept whether or not the teacher did better.
 *
 * A DATASET is an artifact by its content: its examples by id, the states it admits (verified by default), their
 * proportions, and the groups (lineages) they come from - checked against the selection groups before any training.
 * ========================================================================== */

export const TEACHER_TOOLS = 'teacher-memory-json@1';
const MAX_MEMORY_CALLS = 8;

export type ExampleState = 'verified' | 'demonstration' | 'unverified' | 'rejected';

export interface MemoryCallRecord { readonly op: string; readonly name?: string; readonly text?: string; readonly result: string; readonly twin_after: string }

export interface Example {
  readonly format: 'junior-example@1';
  readonly id: string;
  readonly cut: { readonly run: string; readonly question: number; readonly hash: string };
  readonly group: string;
  readonly mode: Mode;
  /** The input as the junior is asked it (and the teacher), the task included when there is one. */
  readonly input: { readonly system: string; readonly user: { readonly parts: readonly string[] } };
  /** The answer to train on (the teacher's), or null when it is no target. */
  readonly target: string | null;
  /** What trains the junior's decisions: its final answer, and the memory calls it made on the way when it made any
      ('decisions'): each call in the loss, each result as context, never loss. */
  readonly span: 'answer' | 'decisions';
  readonly state: ExampleState;
  readonly competence: { readonly checker: { readonly id: string; readonly version: number }; readonly request?: string };
  readonly junior: { readonly execution: string; readonly answer: string | null; readonly outcome: Pick<CheckOutcome, 'state' | 'pass' | 'detail'> | null; readonly receipt: string | null };
  readonly teacher: { readonly identity: Readonly<Record<string, unknown>>; readonly answer: string | null; readonly outcome: Pick<CheckOutcome, 'state' | 'pass' | 'detail'> | null;
    readonly memory: { readonly start: string | null; readonly calls: readonly MemoryCallRecord[] }; readonly translation: string; readonly why?: string };
  readonly provenance: { readonly from: 'distillation'; readonly teacher_model: unknown; readonly junior: string; readonly corrects: boolean };
}

const sha = (v: unknown): string => createHash('sha256').update(stableStringify(v)).digest('hex');

const TEACHER_NOTE = (n: number) => 'YOUR MEMORY: you have a memory of your own, kept between your investigations, with tools put, append, get, list and delete. '
  + 'To use one, answer only {"memory_call": {"op": "put" | "append" | "get" | "list" | "delete", "name": "<file>", "text": "<text>"}} - its result comes back to you, and then you answer as you are asked. '
  + 'At most ' + n + ' calls before your answer.';

const asParts = (parts: readonly string[]): unknown[] => parts.map((p) => { try { return JSON.parse(p); } catch { return p; } });

/** The teacher at a cut: the cut's prefix, its memory calls answered by the reference simulator on a copy, its answer. */
export async function teacherAtCut(o: { content: Cut['content']; teacher: ChatClient; client: JuniorSessionClient; pkg: JuniorPackage; start: MemoryState; signal?: AbortSignal }): Promise<{ answer: string; calls: MemoryCallRecord[] }> {
  const parts = asParts(o.content.user.parts);
  const calls: MemoryCallRecord[] = [];
  let twin = o.start.twin;
  for (let i = 0; ; i++) {
    const a = await o.teacher.complete({ system: o.content.system + '\n\n' + TEACHER_NOTE(MAX_MEMORY_CALLS), user: new UserParts(parts), signal: o.signal ?? null });
    let call: { op?: string; name?: string; text?: string } | null = null;
    try { const j = JSON.parse(a.content); if (j && typeof j === 'object' && j.memory_call && Object.keys(j).length === 1) call = j.memory_call; } catch { /* an answer */ }
    if (!call || i >= MAX_MEMORY_CALLS) return { answer: a.content, calls };
    let result: string;
    try {
      const r = await o.client.memory(o.pkg, twin, { op: String(call.op), ...(call.name !== undefined ? { name: String(call.name) } : {}), ...(call.text !== undefined ? { text: String(call.text) } : {}) });
      result = r.result; twin = r.twin;
    } catch (e) { result = 'error: ' + String((e as Error).message ?? e); }
    calls.push({ op: String(call.op), ...(call.name !== undefined ? { name: String(call.name) } : {}), ...(call.text !== undefined ? { text: String(call.text) } : {}), result, twin_after: twin ?? '' });
    parts.push({ memory_call: call }, { memory_result: result });
  }
}

/** The junior at a cut, in a session of its own opened on the cut's memory: its answer and its receipt. */
async function juniorAtCut(client: JuniorSessionClient, pkg: JuniorPackage, content: Cut['content'], start: MemoryState, mode: Mode, key: string, origin: unknown): Promise<{ answer: string | null; receipt: string | null; why?: string }> {
  const sid = 'd-' + key.slice(0, 24);
  try {
    try { await client.info(sid); } catch { await client.open({ run_id: 'distill:' + key.slice(0, 16), pkg, session_id: sid, ...(mode === 'cut' ? { state: start, origin } : {}) }); }
    const { head_id } = await client.restore(sid);
    const r = await client.ask(sid, { request_id: 'answer', content, expected: head_id });
    if (r.terminal === 'cancelled' || r.terminal === 'infra_failed') return { answer: null, receipt: r.request_id, why: 'the junior did not answer: ' + (r.reason ?? r.terminal) };
    return { answer: r.text, receipt: r.request_id };
  } catch (e) { return { answer: null, receipt: null, why: String((e as Error).message ?? e) }; }
}

export interface DistillRequest {
  readonly run: string;
  readonly question: number;
  readonly group: string;
  readonly mode: Mode;
  /** Cut mode: the memory at the cut (the junior's own, from its session; or one declared). */
  readonly snapshot?: MemoryState;
  readonly checker: { readonly id: string; readonly version: number };
  readonly request?: string;
  /** The visible task, given to both after the prefix (§6.4), when the competence is asked explicitly. */
  readonly instruction?: string;
}

/** One example from a cut, kept in `dir/examples` by its id; the same request on the same junior and teacher is made once. */
export async function distill(o: { dir: string; req: DistillRequest; pkg: JuniorPackage; client: JuniorSessionClient; teacher: ChatClient; teacherIdentity: Readonly<Record<string, unknown>>; judge?: LabConnection; signal?: AbortSignal }): Promise<Example> {
  const execution = executionHash(o.pkg);
  const key = sha({ req: o.req, junior: execution, teacher: o.teacherIdentity, tools: TEACHER_TOOLS });
  const file = path.join(o.dir, 'examples', key + '.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const cut = await captureCut(o.req.run, o.req.question);
  const content = o.req.instruction ? { system: cut.content.system, user: { parts: [...cut.content.user.parts, JSON.stringify({ evaluator_message: o.req.instruction })] } } : cut.content;
  const start: MemoryState = o.req.mode === 'cut' ? (o.req.snapshot ?? { neural: null, twin: null }) : o.pkg.memory;
  const checkOpts = o.judge ? { judge: o.judge } : {};
  /* The criterion is fixed before the teacher is asked: the checker at this cut, run on the junior's answer first. */
  const j = await juniorAtCut(o.client, o.pkg, content, start, o.req.mode, key, { distill: { run: o.req.run, question: o.req.question } });
  const jOut = j.answer === null ? null : await checkAtCut(cut, j.answer, o.req.checker, { ...(o.req.request ? { request: o.req.request } : {}) }, checkOpts);
  let t: { answer: string; calls: MemoryCallRecord[] } | null = null, why: string | undefined;
  try { t = await teacherAtCut({ content, teacher: o.teacher, client: o.client, pkg: o.pkg, start, ...(o.signal ? { signal: o.signal } : {}) }); } catch (e) { why = 'the teacher did not answer: ' + String((e as Error).message ?? e); }
  const tOut = t ? await checkAtCut(cut, t.answer, o.req.checker, { ...(o.req.request ? { request: o.req.request } : {}) }, checkOpts) : null;
  const measured = (x: CheckOutcome | null) => x !== null && x.state === 'measured';
  const state: ExampleState = !measured(tOut) || !measured(jOut) ? 'unverified' : !tOut!.pass ? 'rejected' : jOut!.pass ? 'unverified' : 'verified';
  const slim = (x: CheckOutcome | null) => (x ? { state: x.state, pass: x.pass, detail: x.detail } : null);
  const body = {
    format: 'junior-example@1' as const, cut: { run: o.req.run, question: o.req.question, hash: cut.hash }, group: o.req.group, mode: o.req.mode, input: content,
    target: state === 'verified' ? t!.answer : null, span: (t?.calls.length ? 'decisions' : 'answer') as 'answer' | 'decisions', state,
    competence: { checker: o.req.checker, ...(o.req.request ? { request: o.req.request } : {}) },
    junior: { execution, answer: j.answer, outcome: slim(jOut), receipt: j.receipt },
    teacher: { identity: o.teacherIdentity, answer: t?.answer ?? null, outcome: slim(tOut), memory: { start: start.twin, calls: t?.calls ?? [] }, translation: TEACHER_TOOLS, ...(why ?? j.why ? { why: why ?? j.why } : {}) },
    provenance: { from: 'distillation' as const, teacher_model: o.teacherIdentity.model ?? null, junior: execution, corrects: state === 'verified' }
  };
  const ex: Example = { ...body, id: sha(body) };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(ex, null, 2));
  return ex;
}

/* --- Datasets ------------------------------------------------------------------------------------------------------- */

export interface Dataset {
  readonly format: 'junior-dataset@1';
  readonly id: string;
  readonly examples: readonly string[];
  /** The states it admits as targets: verified by default; a mix with demonstration is another recipe, named so. */
  readonly admits: readonly ExampleState[];
  readonly proportions: Readonly<Record<string, number>>;
  readonly groups: readonly string[];
  readonly competences: readonly string[];
}

/** A dataset from examples kept in `dir/examples`: refused with an example it does not admit or without a target. */
export function makeDataset(dir: string, ids: readonly string[], admits: readonly ExampleState[] = ['verified']): Dataset | { error: string } {
  if (!ids.length) return { error: 'a dataset holds at least one example' };
  if (admits.some((a) => a !== 'verified' && a !== 'demonstration')) return { error: 'a dataset admits verified examples, and demonstrations only when it says so: never unverified or rejected ones as targets' };
  const examples: Example[] = [];
  for (const id of [...new Set(ids)].sort()) {
    const f = fs.existsSync(path.join(dir, 'examples')) ? fs.readdirSync(path.join(dir, 'examples')).map((n) => path.join(dir, 'examples', n)).find((p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')).id === id; } catch { return false; } }) : undefined;
    if (!f) return { error: 'no example ' + id };
    const e = JSON.parse(fs.readFileSync(f, 'utf8')) as Example;
    if (!admits.includes(e.state)) return { error: 'example ' + id + ' is ' + e.state + ', which this dataset does not admit' };
    if (e.target === null) return { error: 'example ' + id + ' has no target' };
    examples.push(e);
  }
  const proportions: Record<string, number> = {};
  for (const e of examples) proportions[e.state] = (proportions[e.state] ?? 0) + 1 / examples.length;
  const body = { format: 'junior-dataset@1' as const, examples: examples.map((e) => e.id), admits: [...admits].sort(), proportions,
    groups: [...new Set(examples.map((e) => e.group))].sort(), competences: [...new Set(examples.map((e) => e.competence.checker.id + (e.competence.request ? ':' + e.competence.request : '')))].sort() };
  const ds: Dataset = { ...body, id: sha(body) };
  fs.mkdirSync(path.join(dir, 'datasets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'datasets', ds.id + '.json'), JSON.stringify(ds, null, 2));
  return ds;
}

/** The groups a dataset shares with the probes of selection of a manifest (§6.4): a training on it is refused while any is
    shared; the examples are kept, never deleted. */
export function selectionOverlap(ds: Pick<Dataset, 'groups'>, m: CompetenceManifest): string[] {
  const selection = new Set(m.cases.filter((c) => c.kind === 'probe' && c.partition === 'development').map((c) => c.group));
  return ds.groups.filter((g) => selection.has(g));
}
