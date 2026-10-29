import fs from 'node:fs';
import { appendRecord } from './jsonl.ts';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { stableStringify } from '../core/hash.ts';
import { LABS } from '../worlds/labs.ts';
import { runLaboratory, type LabConnection } from '../runtime/lab-runner.ts';
import { offlineConnection } from '../runtime/package.ts';
import type { FetchLike } from '../core/net.ts';
import type { JuniorSessionClient } from './client.ts';
import type { CompetenceManifest, Component, Observation, ProbeCase } from './competence.ts';
import { probeRepetitions, seedOf } from './competence.ts';
import type { JuniorPackage } from './package.ts';

/* ============================================================================
 * COMPETENCE PROBES (SPEC-METAPOLITICA-APRENDIZAJE §6.4): one answer asked under a visible task, from a cut of a
 * development run, checked by the harness's own contract - never by a parser written here.
 *
 * A CUT is a run resumed from its own record up to System 2's question k: its replay log is kept up to the answer of that
 * question and no further, so the resumed run replays everything before it and asks question k live. A stand-in takes
 * that request:
 *   - to CAPTURE it: what System 2 is asked there (its system message and user parts) is the probe's prefix;
 *   - to CHECK an answer: it answers the candidate's text, and the run goes on until it asks System 2 again. What the
 *     harness recorded in between - the investigation run in the world as it was, the proposal parsed and checked, or
 *     nothing accepted - is what the checker reads.
 * The world, the notebook and the protocol are the run's own at that point: the request is executed in a copy of the world.
 *
 * Checkers (version 1), over the events the harness logged for the injected answer:
 *   protocol  accepted at once: an investigation, a proposal, a reflection, a closing or a consolidation was logged
 *   request   an investigation holding a request of the component's kind whose result carries no error
 *   rules     accepted, and no request of it answered with an error
 *   proposal  a proposal logged and checked
 * A failure of the providers (a Judge's call that failed, a divergence, an error of the run) measures nothing.
 * ========================================================================== */

type J = Record<string, any>;

const sha = (v: unknown): string => createHash('sha256').update(typeof v === 'string' ? v : stableStringify(v)).digest('hex');

/** The files of a run (its journal and everything beside it with its name) copied to a scratch folder, its replay log cut
    before the answer to System 2's question `question` (0-based). */
function stage(run: string, question: number): { dir: string; journal: string; journalHash: string; kept: number } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
  const base = path.basename(run, '.json');
  for (const f of fs.readdirSync(path.dirname(run))) if (f === base + '.json' || f.startsWith(base + '.')) {
    const from = path.join(path.dirname(run), f);
    if (fs.statSync(from).isFile()) fs.copyFileSync(from, path.join(dir, f));
    else fs.cpSync(from, path.join(dir, f), { recursive: true });
  }
  const log = path.join(dir, base + '.replay.jsonl');
  if (!fs.existsSync(log)) throw new Error('the run has no replay log: it cannot be cut');
  const lines = fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.trim());
  let llm = -1, cutAt = -1;
  for (let i = 0; i < lines.length; i++) {
    let e: J;
    try { e = JSON.parse(lines[i]); } catch { break; }
    if (e.channel === 'llm' && !e.closing && ++llm === question) { cutAt = i; break; }
  }
  if (cutAt < 0) throw new Error('the run never answered question ' + question + ' (' + (llm + 1) + ' answers of System 2 in its log)');
  fs.writeFileSync(log, lines.slice(0, cutAt).map((l) => l + '\n').join(''));
  return { dir, journal: path.join(dir, base + '.json'), journalHash: sha(fs.readFileSync(run, 'utf8')), kept: cutAt };
}

/** System 2's request as content of a junior's question: its system message, its user parts. */
export function contentOf(body: { messages?: { role: string; content: unknown }[] }): { system: string; user: { parts: string[] } } {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const text = (c: unknown): string => (typeof c === 'string' ? c : JSON.stringify(c));
  return { system: msgs.filter((m) => m.role === 'system').map((m) => text(m.content)).join('\n\n'), user: { parts: msgs.filter((m) => m.role !== 'system').map((m) => text(m.content)) } };
}

interface Resumed { events: J[]; stoppedBy: string; asked: { body: J }[] }

/** The run resumed from the cut: `answer` gives the text to answer System 2's first live question, or null to stop there;
    the second live question always stops it. The Judge is the one given, or none (its calls then fail: no measure). */
async function resumeAtCut(run: string, question: number, answer: (body: J) => string | null, o: { judge?: LabConnection; timeoutMs?: number } = {}): Promise<Resumed & { journalHash: string; kept: number }> {
  const s = stage(run, question);
  try {
    const original = JSON.parse(fs.readFileSync(s.journal, 'utf8'));
    const lab = Object.values(LABS).find((l) => l.id === original.experiment);
    if (!lab) throw new Error('no laboratory "' + original.experiment + '" in this code');
    const llm = offlineConnection(original.config ?? {});
    const llmUrl = llm.url.replace('http://offline.invalid', 'http://probe-llm.invalid');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), o.timeoutMs ?? 10 * 60_000);
    const asked: { body: J }[] = [];
    const network: FetchLike = async (url, init) => {
      if (String(url).startsWith('http://probe-llm.invalid')) {
        const body = JSON.parse(String(init.body ?? '{}'));
        asked.push({ body });
        const text = asked.length === 1 ? answer(body) : null;
        if (text === null) { controller.abort(); throw new Error('the probe stops here'); }
        const out = JSON.stringify({ choices: [{ message: { content: text } }], usage: { total_tokens: 0 } });
        return { ok: true, status: 200, text: async () => out, headers: { get: () => null } };
      }
      if (String(url).startsWith('http://probe-judge.invalid')) throw new Error('no Judge for this probe');
      return (globalThis.fetch as unknown as FetchLike)(url, init);
    };
    let stoppedBy = 'unknown';
    const out = path.join(s.dir, 'probe.json');
    try {
      const r = await runLaboratory(lab, { args: ['--resume', s.journal, '--out', out], root: s.dir, llm: { ...llm, url: llmUrl }, fetch: network, signal: controller.signal, print: () => {},
        ...(original.config?.flat ? {} : { judge: o.judge ?? { url: 'http://probe-judge.invalid' + (original.config?.jev_path ?? '/v1/chat/completions'), key: 'none', ...(original.config?.jev_model ? { model: String(original.config.jev_model) } : {}) } }) });
      stoppedBy = r.stoppedBy;
    } catch (e) { stoppedBy = 'error: ' + String((e as Error).message ?? e).slice(0, 200); } finally { clearTimeout(timer); }
    const events = fs.existsSync(out) ? (JSON.parse(fs.readFileSync(out, 'utf8')).events ?? []) as J[] : [];
    return { events, stoppedBy, asked, journalHash: s.journalHash, kept: s.kept };
  } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
}

export interface Cut {
  readonly run: string;
  readonly question: number;
  /** sha256 of the run's journal, the question, the replay entries kept and what System 2 is asked there. */
  readonly hash: string;
  readonly lab: string;
  readonly content: { readonly system: string; readonly user: { readonly parts: readonly string[] } };
  /** Events the run logged before the question: what follows them in a check is the answer's reaction. */
  readonly events_before: number;
}

/** A cut taken: the run resumed to its question, what System 2 is asked there captured. A run that cannot be cut there
    (no such question, a divergence) is refused - before any candidate is evaluated. */
export async function captureCut(run: string, question: number, o: { timeoutMs?: number } = {}): Promise<Cut> {
  const r = await resumeAtCut(run, question, () => null, o);
  if (!r.asked.length) throw new Error('the run resumed to question ' + question + ' never asked it (' + r.stoppedBy + ')');
  const content = contentOf(r.asked[0].body);
  const experiment = JSON.parse(fs.readFileSync(run, 'utf8')).experiment;
  const lab = Object.entries(LABS).find(([, l]) => l.id === experiment)?.[0] ?? String(experiment);
  return { run, question, lab, content, events_before: beforeTail(r.events),
    hash: sha({ journal: r.journalHash, question, kept: r.kept, asked: r.asked[0].body }) };
}

/** What a run logs when it is stopped at a question (its failed call, its halt, its end): not part of what came before it. */
const STOP_TAIL = new Set(['end', 'halted', 'proposal_failed', 'reflection_failed']);
const beforeTail = (events: readonly J[]): number => { let n = events.length; while (n > 0 && STOP_TAIL.has(events[n - 1].type)) n--; return n; };

export const ACCEPTED = new Set(['investigation', 'proposal', 'reflection', 'round_closed', 'consolidated']);

export interface CheckOutcome { readonly state: 'measured' | 'infra'; readonly pass: boolean; readonly detail: string; readonly events: readonly J[] }

/** The harness's reaction to an answer at a cut, read by a checker. The cut is taken again and must be the one declared. */
export async function checkAtCut(cut: Pick<Cut, 'run' | 'question' | 'hash'> & { readonly events_before?: number }, text: string, checker: { id: string; version: number }, component: Pick<Component, 'request'>, o: { judge?: LabConnection; timeoutMs?: number } = {}): Promise<CheckOutcome> {
  if (checker.version !== 1) return { state: 'infra', pass: false, detail: 'no checker ' + checker.id + '@' + checker.version + ' in this code', events: [] };
  const r = await resumeAtCut(cut.run, cut.question, () => text, o);
  if (!r.asked.length) return { state: 'infra', pass: false, detail: 'the cut was never asked again (' + r.stoppedBy + ')', events: [] };
  if (sha({ journal: r.journalHash, question: cut.question, kept: r.kept, asked: r.asked[0].body }) !== cut.hash) return { state: 'infra', pass: false, detail: 'the cut is not the one declared', events: [] };
  if (r.stoppedBy === 'diverged' || r.stoppedBy.startsWith('error')) return { state: 'infra', pass: false, detail: 'the run ' + r.stoppedBy, events: [] };
  /* Its reaction: what was logged after the events before the cut, up to the run's end. */
  const before = cut.events_before ?? (await captureCut(cut.run, cut.question, o)).events_before;
  const reaction = r.events.slice(before, beforeTail(r.events));
  const check = reaction.find((e) => e.type === 'check');
  if (check && Number(check.jev?.errors) > 0) return { state: 'infra', pass: false, detail: 'the Judge failed in its check', events: reaction };
  const accepted = reaction.some((e) => ACCEPTED.has(e.type));
  const investigations = reaction.filter((e) => e.type === 'investigation');
  const errored = investigations.some((e) => (e.results ?? []).some((x: J) => x && typeof x === 'object' && x.error));
  let pass: boolean, detail: string;
  switch (checker.id) {
    case 'protocol': pass = accepted; detail = accepted ? 'accepted: ' + reaction.filter((e) => ACCEPTED.has(e.type)).map((e) => e.type).join(', ') : 'not accepted: ' + (reaction.map((e) => e.type).join(', ') || 'nothing logged'); break;
    case 'request': {
      const kind = component.request ?? '';
      pass = investigations.some((e) => (e.requests ?? []).some((q: J, i: number) => Object.keys(q ?? {})[0] === kind && !(e.results?.[i]?.error)));
      detail = pass ? 'a ' + kind + ' request answered' : 'no ' + kind + ' request answered without error';
      break;
    }
    case 'rules': pass = accepted && !errored; detail = !accepted ? 'not accepted' : errored ? 'a request was answered with an error' : 'accepted, no request refused'; break;
    case 'proposal': pass = reaction.some((e) => e.type === 'proposal') && !!check; detail = pass ? 'proposed and checked' : 'no proposal checked'; break;
    default: return { state: 'infra', pass: false, detail: 'no checker ' + checker.id, events: reaction };
  }
  return { state: 'measured', pass, detail, events: reaction };
}

/* --- A candidate's probes ------------------------------------------------------------------------------------------- */

export interface ProbeRecord { readonly case: string; readonly rep: number; readonly execution: string; readonly manifest: string; readonly receipt: string | null; readonly terminal: string | null; readonly outcome: CheckOutcome; readonly answer: string }

/** A candidate's answers to the manifest's probes, each asked once in a session of its own and checked at its cut; kept in
    `ledger` so a probe answered is never asked again. Answers the observations of their components. */
export async function runProbes(m: CompetenceManifest, manifestHash: string, o: { pkg: JuniorPackage; execution: string; client: JuniorSessionClient; ledger: string; judge?: LabConnection; signal?: AbortSignal }): Promise<Observation[]> {
  const done = new Map<string, ProbeRecord>();
  if (fs.existsSync(o.ledger)) for (const l of fs.readFileSync(o.ledger, 'utf8').split('\n')) { try { const r = JSON.parse(l) as ProbeRecord; done.set(r.manifest + '|' + r.execution + '|' + r.case + '|' + r.rep, r); } catch { /* cut line */ } }
  const out: Observation[] = [];
  const reps = probeRepetitions(o.pkg.decoding.temperature);
  for (const c of m.cases.filter((x): x is ProbeCase => x.kind === 'probe')) {
    const comp = m.components.find((k) => k.id === c.component)!;
    for (let rep = 0; rep < reps; rep++) {
      if (o.signal?.aborted) return out;
      const key = manifestHash + '|' + o.execution + '|' + c.id + '|' + rep;
      let rec = done.get(key);
      if (!rec) {
        rec = await oneProbe(m, manifestHash, c, comp, rep, o);
        if (rec.outcome.state === 'measured') { appendRecord(o.ledger, rec); done.set(key, rec); }
      }
      out.push({ component: c.component, case: c.id, rep, value: rec.outcome.state === 'measured' ? (rec.outcome.pass ? 1 : 0) : null, state: rec.outcome.state === 'measured' ? 'measured' : 'infra', why: rec.outcome.detail });
    }
  }
  return out;
}

async function oneProbe(m: CompetenceManifest, manifestHash: string, c: ProbeCase, comp: Component, rep: number, o: { pkg: JuniorPackage; execution: string; client: JuniorSessionClient; judge?: LabConnection }): Promise<ProbeRecord> {
  const infra = (detail: string): ProbeRecord => ({ case: c.id, rep, execution: o.execution, manifest: manifestHash, receipt: null, terminal: null, answer: '', outcome: { state: 'infra', pass: false, detail, events: [] } });
  let cut: Cut;
  try { cut = await captureCut(c.cut.run, c.cut.question); } catch (e) { return infra('the cut cannot be taken: ' + (e as Error).message); }
  if (cut.hash !== c.cut.hash) return infra('the cut is not the one declared (' + cut.hash.slice(0, 12) + ')');
  /* The task is visible (§6.4): the evaluator's message after the prefix, before the answer scored. */
  const content = { system: cut.content.system, user: { parts: [...cut.content.user.parts, JSON.stringify({ evaluator_message: c.instruction })] } };
  const sid = 'p-' + sha([manifestHash, o.execution, c.id, rep]).slice(0, 24);
  try {
    try { await o.client.info(sid); } catch {
      await o.client.open({ run_id: 'probe:' + c.id, pkg: o.pkg, session_id: sid, ...(c.mode === 'cut' ? { state: c.snapshot, origin: { probe: c.id, cut: c.cut } } : {}) });
    }
    const { head_id } = await o.client.restore(sid);
    const r = await o.client.ask(sid, { request_id: 'probe', content, expected: head_id, limits: { max_tokens: m.limits.probe_max_tokens, timeout_ms: m.limits.timeout_ms }, seed: seedOf(m, c.id, rep) });
    if (r.terminal === 'cancelled' || r.terminal === 'infra_failed') return { ...infra('the junior did not answer: ' + (r.reason ?? r.terminal)), receipt: r.request_id, terminal: r.terminal };
    /* A limit reached is an answer: its prefix is checked as it is (§6.3). */
    const outcome = await checkAtCut(cut, r.text, c.checker, comp, o.judge ? { judge: o.judge } : {});
    return { case: c.id, rep, execution: o.execution, manifest: manifestHash, receipt: r.request_id, terminal: r.terminal, answer: r.text, outcome };
  } catch (e) { return infra('the junior server failed: ' + String((e as Error).message ?? e)); }
}
