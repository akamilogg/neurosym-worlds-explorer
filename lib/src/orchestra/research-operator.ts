import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseJsonLoose } from '../core/net.ts';
import type { ChatClient } from '../learn/system2.ts';
import { runStatus, send } from '../runtime/control.ts';
import { researcherEvents, runDigest } from './view.ts';
import { stuckSignals } from './reader.ts';
import { LABS } from '../worlds/labs.ts';
import { Sources } from '../learn/assisted/sources.ts';
import { ExternalSources, EXTERNAL_SOURCES_SECTION } from '../learn/assisted/external-sources.ts';
import { environmentPdfExtractor, readExternalConfig, type ExternalResearchConfig, type PdfExtractor, type WebTransport } from '../learn/assisted/external.ts';
import { braveProvider, type SearchProvider } from '../learn/assisted/source-search.ts';
import { exposed, exposureOf, type ExternalExposure } from '../learn/assisted/exposure.ts';

/* ============================================================================
 * THE RESEARCHING OPERATOR (SPEC-INVESTIGACION-EXTERNA §6.3, §7, IE4): an agent that accompanies one or more runs, is
 * woken by what it declared (an opening, a sign of being stuck, a message, a branch's result, a number of rounds, a clock),
 * investigates with the junior's instruments - its sources, its own notes - and decides: wait, or deliver a CONTRIBUTION.
 *
 *   operator-research@1     its file: id, task, targets, its external research, `wake`, `budget`, `max_messages`,
 *                           `concurrency` (1), `lifetime` ("targets" or "project")
 *   research-contribution@1 what it delivers: a free report kept by its content, its refs and artifacts, the cut of
 *                           each target it read, its state (complete, partial, no_result) and its exposure to external
 *                           sources (written by the host from its record, never by it)
 *
 * It has no authority: a contribution is never a directive, never changes what holds, and its recipient may adopt,
 * question or ignore it. Delivery is keyed by (contribution, recipient): resumed, it never delivers twice; a recipient
 * that ended is never reopened by a late result, which stays in its record. Nothing here diagnoses: a number of rounds or
 * a clock is a schedule, and the agent decides whether anything is worth saying.
 * ========================================================================== */

export type Wake = 'opening' | 'stuck' | 'message' | 'branch_result' | 'every_rounds' | 'interval_ms';

export interface OperatorResearchSpec {
  readonly format: 'operator-research@1';
  readonly id: string;
  readonly task: string;
  readonly targets: readonly string[];
  readonly external_research?: string;
  readonly wake: { readonly opening?: boolean; readonly stuck?: boolean; readonly message?: boolean; readonly branch_result?: boolean; readonly every_rounds?: number; readonly interval_ms?: number };
  readonly budget: { readonly tokens: number; readonly calls: number; readonly minutes: number; readonly activations: number };
  readonly max_messages: number;
  readonly concurrency?: 1;
  readonly lifetime?: 'targets' | 'project';
  readonly steps?: number;
}

const count = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;

/** What is wrong with an operator-research@1 file (empty when nothing). */
export function researchSpecProblems(raw: unknown): string[] {
  const s = raw as Record<string, any>;
  if (!s || s.format !== 'operator-research@1') return ['"format": "operator-research@1"'];
  const p: string[] = [];
  for (const k of Object.keys(s)) if (!['format', 'id', 'task', 'targets', 'external_research', 'wake', 'budget', 'max_messages', 'concurrency', 'lifetime', 'steps'].includes(k)) p.push('"' + k + '": unknown');
  if (typeof s.id !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(s.id)) p.push('"id": lowercase letters, digits, - and _');
  if (typeof s.task !== 'string' || !s.task.trim()) p.push('"task": what it is asked to look into');
  if (!Array.isArray(s.targets) || !s.targets.length || !s.targets.every((t: unknown) => typeof t === 'string' && t)) p.push('"targets": the journals of the runs it accompanies');
  if (s.external_research !== undefined && typeof s.external_research !== 'string') p.push('"external_research": a file');
  const w = s.wake ?? {};
  for (const k of Object.keys(w)) if (!['opening', 'stuck', 'message', 'branch_result', 'every_rounds', 'interval_ms'].includes(k)) p.push('"wake.' + k + '": unknown (opening, stuck, message, branch_result, every_rounds, interval_ms)');
  for (const k of ['opening', 'stuck', 'message', 'branch_result']) if (w[k] !== undefined && typeof w[k] !== 'boolean') p.push('"wake.' + k + '": true or false');
  if (w.every_rounds !== undefined && !(count(w.every_rounds) && w.every_rounds > 0)) p.push('"wake.every_rounds": a whole number above 0');
  if (w.interval_ms !== undefined && !(count(w.interval_ms) && w.interval_ms >= 1000)) p.push('"wake.interval_ms": at least 1000');
  if (!Object.values(w).some((v) => v)) p.push('"wake": at least one condition');
  const b = s.budget ?? {};
  for (const k of ['tokens', 'calls', 'minutes', 'activations']) if (!(count(b[k]) && b[k] > 0)) p.push('"budget.' + k + '": a whole number above 0 (no session is endless)');
  if (!(count(s.max_messages))) p.push('"max_messages": a whole number, per recipient');
  if (s.concurrency !== undefined && s.concurrency !== 1) p.push('"concurrency": 1');
  if (s.lifetime !== undefined && s.lifetime !== 'targets' && s.lifetime !== 'project') p.push('"lifetime": "targets" or "project"');
  if (s.steps !== undefined && !(count(s.steps) && s.steps > 0)) p.push('"steps": readings an activation may make, above 0');
  return p;
}

export interface ResearchContribution {
  readonly format: 'research-contribution@1';
  readonly id: string;
  readonly from: string;
  readonly to: readonly string[];
  readonly task: string;
  readonly report: { readonly sha256: string; readonly kept: true; readonly chars: number };
  readonly refs: readonly string[];
  readonly artifacts: readonly string[];
  /** Where it read each target: the number of its events. */
  readonly cut: Readonly<Record<string, number>>;
  readonly state: 'complete' | 'partial' | 'no_result';
  readonly external_exposure: ExternalExposure;
  readonly activation: number;
}

export const OPERATOR_RESEARCH_SYSTEM = [
  'You are a RESEARCHING AGENT that accompanies one or more researchers. Each is an AI investigating an environment nobody described to it; you see what each did and what its environment answered - never more than it knows. You know nothing of their environments either, and you cannot know the answer.',
  'Your TASK is the operator\'s, below. You are woken when something you were told to watch happens (`woken_by`, with the facts) - or by a clock, which is a schedule and never says anything is wrong. Most of the time the right answer is to wait.',
  'You may investigate before you decide, with the same instruments a researcher has: your sources, as described below, and {"read": "<target>"} for a target\'s latest rounds as its researcher lived them. Each reading costs one of your `steps_left`.',
  'When you found something worth a researcher\'s attention - a mechanism of another problem its data might fit, a method, a counterexample, a reproduction, a lead not yet tested - deliver it as a CONTRIBUTION: {"decision": "contribute", "to": ["<target>", ...] or "all", "summary": "<what to tell them, briefly>", "report": "<your report, as long as it needs: what you read (cite src:<snapshot>#L<a>-<b>), what you infer, what you have NOT tested>", "refs": ["<snapshots, searches, items>"], "state": "complete" | "partial" | "no_result", "why": "<for the record>"}.',
  'Keep apart what you read, what you infer and what you tested: you test nothing in their environments, so never present a lead as evidence. A contribution is a colleague\'s suggestion they may ignore, never an order, and it changes nothing of what holds.',
  'Otherwise {"decision": "wait", "why": "..."}. While you read: {"investigate": [ ...requests ]}. Answer ONE JSON object.'
].join('\n');

export interface ResearchOperatorOptions {
  readonly spec: OperatorResearchSpec;
  /** Where its record goes (default: beside its first target, <target>.research-<id>.json). */
  readonly record?: string;
  readonly root?: string;
  readonly llm: ChatClient;
  readonly pollMs?: number;
  readonly signal?: AbortSignal;
  readonly say?: (line: string) => void;
  readonly now?: () => number;
  /** Its external research, already read (else from the spec's file); its provider, transport, extractor (tests). */
  readonly external?: { readonly config?: ExternalResearchConfig; readonly provider?: SearchProvider | null; readonly transport?: WebTransport; readonly pdf?: PdfExtractor };
  /** Within a project (§6.3): its targets as the project knows them now (run ids resolved to their journals, "*" every run of
      the project), whether every target it names is known yet, whether the project is closed, and its tray, where a result
      that reaches a recipient already ended is kept. Its record and its texts then live in the project's folder. */
  readonly project?: ProjectSide;
  /** Where the texts it keeps go (default: beside its first target). */
  readonly blobs?: string;
}

export interface ProjectSide {
  targets(): readonly string[];
  all(): boolean;
  closed(): boolean;
  keep(c: ResearchContribution, to: string, why: string): void;
}

type J = Record<string, any>;
const readJson = (f: string): J | null => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((r) => { const t = setTimeout(r, ms); signal?.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });
const tokensOf = (raw: unknown, text: string): number => Number((raw as { usage?: { total_tokens?: number } } | null)?.usage?.total_tokens) || Math.ceil(text.length / 4);

export const researchRecordOf = (target: string, id: string): string => target.replace(/\.json$/, '') + '.research-' + id + '.json';

/** Follows its targets until its lifetime ends, its budget is spent or the signal aborts. */
export async function runResearchOperator(o: ResearchOperatorOptions): Promise<J> {
  const spec = o.spec;
  const problems = researchSpecProblems(spec);
  if (problems.length) throw new Error('operator-research: ' + problems.join('; '));
  const root = o.root ?? process.cwd();
  if (!o.project && spec.targets.includes('*')) throw new Error('operator-research: "*" (every run of a project) belongs to a project: give the journals of its targets');
  if (o.project && !o.record) throw new Error('operator-research: within a project its record goes in the folder of the project');
  const fixed = spec.targets.map((t) => path.resolve(root, t));
  /* Its targets now: fixed, or as its project knows them (runs added as the project plans them). */
  const targetsNow = (): string[] => (o.project ? [...o.project.targets()] : fixed);
  const file = o.record ?? researchRecordOf(fixed[0], spec.id);
  const now = o.now ?? Date.now;
  const say = o.say ?? (() => {});
  /* Its record, resumed where it was: its activations, its spending, its contributions and where each was delivered. */
  const record: J = readJson(file) ?? { format: 'operator-research-record@1', agent: 'agent:' + spec.id, spec, started: new Date(now()).toISOString(),
    activations: [], contributions: [], deliveries: [], sources_log: [], spent: { tokens: 0, calls: 0, activations: 0 }, seen: {}, state: 'running' };
  const save = () => { record.heartbeat = new Date(now()).toISOString(); fs.writeFileSync(file, JSON.stringify(record, null, 2)); };
  record.state = 'running';
  save();
  const startedAt = Date.parse(record.started);
  /* Its sources: its own bags, kept in its record; refused for a target whose world admits none - it may then read there
     only if it is not exposed (a contribution of an exposed actor is never delivered to such a world). */
  const config = o.external?.config ?? (spec.external_research ? readExternalConfig(path.resolve(root, spec.external_research)) : null);
  const blobs = o.blobs ?? path.join(path.dirname(o.project ? file : fixed[0]), 'blobs');
  const keep = (text: string): string => {
    const sha = createHash('sha256').update(text).digest('hex');
    if (!fs.existsSync(path.join(blobs, sha))) { fs.mkdirSync(blobs, { recursive: true }); fs.writeFileSync(path.join(blobs, sha), text); }
    return sha;
  };
  const external = config ? new ExternalSources({ config, actor: 'op-' + spec.id, keep, log: (type, data) => { record.sources_log.push({ at: new Date(now()).toISOString(), type, ...data }); save(); },
    provider: o.external?.provider !== undefined ? o.external.provider : config.search?.provider === 'brave' ? braveProvider({ fetch: globalThis.fetch as never, key: process.env.WEB_SEARCH_KEY }) : null,
    ...(o.external?.transport ? { transport: o.external.transport } : {}), ...((o.external?.pdf ?? environmentPdfExtractor()) ? { pdf: (o.external?.pdf ?? environmentPdfExtractor())! } : {}) }) : null;
  external?.restore(record.sources_log, (sha) => { try { return fs.readFileSync(path.join(blobs, sha), 'utf8'); } catch { return null; } });
  const sources = external ? new Sources({ allow: [], fetch: async () => { throw new Error('no allowlist of A6 here'); }, external }) : null;
  const ownExposure = (): ExternalExposure => {
    const direct = (record.sources_log as J[]).some((e) => (e.type === 'source_search' && e.state === 'answered') || (e.type === 'source_acquired' && e.state === 'acquired'));
    const via = new Set<string>();
    for (const t of targetsNow()) { const x = exposureOf(readJson(t)); if (exposed(x)) { via.add('run:' + path.basename(t)); for (const v of x.via) via.add(v); } }
    return { direct, via: [...via].sort(), since: null };
  };
  const ended = (t: string): boolean => { const s = fs.existsSync(t) ? runStatus(t) : null; return s?.state === 'ended' || s?.state === 'interrupted'; };
  const left = () => ({ tokens: spec.budget.tokens - record.spent.tokens, calls: spec.budget.calls - record.spent.calls, activations: spec.budget.activations - record.spent.activations,
    ms: spec.budget.minutes * 60_000 - (now() - startedAt) });
  /* Its activations are counted before one starts; within one, its tokens, calls and time. */
  const outOfBudget = (activations = true): string | null => { const l = left(); return l.tokens <= 0 ? 'tokens' : l.calls <= 0 ? 'calls' : activations && l.activations <= 0 ? 'activations' : l.ms <= 0 ? 'time' : null; };
  let lastClock = record.last_clock ?? 0;

  /** The facts that wake it now, coalesced into one pending activation (never a copy of the same session). */
  const facts = (): J[] => {
    const out: J[] = [];
    for (const t of targetsNow()) {
      const j = readJson(t);
      if (!j || ended(t)) continue;
      const key = path.basename(t);
      const seen = record.seen[key] ?? { rounds: 0, messages: 0, branches: 0, opening: false, stuck: 0 };
      const events = researcherEvents(j);
      const rounds = events.filter((e: J) => e.type === 'check' || e.type === 'round_closed').length;
      if (spec.wake.opening && !seen.opening && (j.events ?? []).length > 0) { out.push({ target: key, fact: 'opening' }); seen.opening = true; }
      if (spec.wake.every_rounds && rounds - seen.rounds >= spec.wake.every_rounds) { out.push({ target: key, fact: 'every_rounds', rounds }); seen.rounds = rounds; }
      if (spec.wake.stuck) {
        const s = stuckSignals(j, 3, 3, 2, 2);
        if (s.signs.length && rounds > seen.stuck) { out.push({ target: key, fact: 'stuck', signs: s.signs }); seen.stuck = rounds; }
      }
      if (spec.wake.message) {
        const msgs = (j.events ?? []).filter((e: J) => e.type === 'operator_message').length;
        if (msgs > seen.messages) { out.push({ target: key, fact: 'message', messages: msgs - seen.messages }); seen.messages = msgs; }
      }
      if (spec.wake.branch_result) {
        const res = (j.events ?? []).filter((e: J) => e.type === 'operator_message' && (e.messages ?? []).some((m: J) => m.research_result)).length;
        if (res > seen.branches) { out.push({ target: key, fact: 'branch_result' }); seen.branches = res; }
      }
      record.seen[key] = seen;
    }
    if (spec.wake.interval_ms && now() - lastClock >= spec.wake.interval_ms) { out.push({ fact: 'interval_ms', note: 'a schedule: nothing is said to be wrong' }); lastClock = now(); record.last_clock = lastClock; }
    return out;
  };

  /** One activation: it reads and decides, within its steps and its budget. */
  const activate = async (woken: J[]): Promise<J> => {
    const n = record.activations.length + 1;
    const steps = spec.steps ?? 6;
    const a: J = { n, at: new Date(now()).toISOString(), woken_by: woken, readings: [], decision: null };
    record.activations.push(a);
    record.spent.activations++;
    save();
    const system = OPERATOR_RESEARCH_SYSTEM + '\n\nTHE OPERATOR\'S TASK: ' + spec.task + (sources?.external ? '\n\n' + EXTERNAL_SOURCES_SECTION + '\nYour inventory: ' + JSON.stringify(sources.external.inventory(false)) : '');
    const targets = targetsNow();
    const parts: J[] = [{ you_are: 'agent:' + spec.id, targets: targets.map((t) => ({ target: path.basename(t), ended: ended(t), digest: (() => { const j = readJson(t); return j ? runDigest(j, { rounds: 2 }) : null; })() })),
      woken_by: woken, messages_left: Object.fromEntries(targets.map((t) => [path.basename(t), spec.max_messages - record.deliveries.filter((d: J) => d.to === path.basename(t)).length])), steps_left: steps,
      your_earlier_contributions: record.contributions.map((c: J) => ({ id: c.id, to: c.to, state: c.state })) }];
    for (let turn = 0; turn < steps + 3; turn++) {
      const why = outOfBudget(false);
      if (why) { a.decision = { decision: 'stopped', why: 'its budget of ' + why + ' is spent' }; break; }
      let answer;
      try { answer = await o.llm.complete({ system, user: { parts } as never }); } catch (e) { a.decision = { decision: 'error', why: String((e as Error).message ?? e) }; break; }
      record.spent.calls++;
      record.spent.tokens += tokensOf(answer.raw, answer.content);
      const parsed = (parseJsonLoose(answer.content) ?? {}) as J;
      if (Array.isArray(parsed.investigate) && a.readings.length < steps) {
        const results: unknown[] = [];
        for (const q of parsed.investigate.slice(0, 4) as J[]) {
          if (typeof q?.read === 'string') {
            const t = targets.find((x) => path.basename(x) === q.read || path.basename(x, '.json') === q.read);
            const j = t ? readJson(t) : null;
            results.push(j ? { read: q.read, digest: runDigest(j, { rounds: 4 }) } : { read: q.read, error: 'not one of your targets' });
          } else if (sources && q && typeof q === 'object' && sources.handles(q)) results.push(await sources.answer(q));
          else results.push({ request: q, error: 'not one of your instruments' });
        }
        a.readings.push({ requests: parsed.investigate.slice(0, 4), results });
        parts.push({ investigation_step: a.readings.at(-1), steps_left: steps - a.readings.length });
        save();
        continue;
      }
      if (parsed.decision === 'contribute' && typeof parsed.report === 'string' && parsed.report.trim()) {
        a.decision = { decision: 'contribute', why: String(parsed.why ?? '') };
        const c = contribute(parsed, n);
        a.decision.contribution = c?.id ?? null;
        break;
      }
      if (parsed.decision === 'wait' || turn >= steps + 2) { a.decision = { decision: 'wait', why: String(parsed.why ?? (parsed.decision === 'wait' ? '' : 'it gave no decision')) }; break; }
      parts.push({ reminder: 'Decide: {"decision": "wait"} or {"decision": "contribute", ...}; or read with {"investigate": [...]} while you have steps.' });
    }
    a.decision ??= { decision: 'wait', why: 'no decision' };
    save();
    say('agent:' + spec.id + ' activation ' + n + ' (' + woken.map((w) => w.fact).join(', ') + '): ' + a.decision.decision + (a.decision.contribution ? ' ' + a.decision.contribution : ''));
    return a;
  };

  /** A contribution made and delivered: kept by its content, then given to each recipient once (`(contribution, recipient)`). */
  const contribute = (p: J, activation: number): ResearchContribution | null => {
    const targets = targetsNow();
    const all = targets.map((t) => path.basename(t));
    const to = p.to === 'all' ? all : (Array.isArray(p.to) ? p.to.map(String) : []).map((t: string) => (t.endsWith('.json') ? t : t + '.json')).filter((t: string) => all.includes(t));
    if (!to.length) return null;
    const report = String(p.report);
    const id = 'C' + (record.contributions.length + 1) + '-' + spec.id;
    const c: ResearchContribution = { format: 'research-contribution@1', id, from: 'agent:' + spec.id, to, task: spec.task, report: { sha256: keep(report), kept: true, chars: report.length },
      refs: (Array.isArray(p.refs) ? p.refs : []).map(String), artifacts: [], cut: Object.fromEntries(targets.map((t) => [path.basename(t), (readJson(t)?.events ?? []).length])),
      state: p.state === 'partial' || p.state === 'no_result' ? p.state : 'complete', external_exposure: ownExposure(), activation };
    record.contributions.push(c);
    save();
    deliver(c, String(p.summary ?? '').trim() || report.slice(0, 280), report);
    return c;
  };
  const deliver = (c: ResearchContribution, summary: string, report: string): void => {
    for (const to of c.to) {
      if (record.deliveries.some((d: J) => d.contribution === c.id && d.to === to)) continue;
      const t = targetsNow().find((x) => path.basename(x) === to);
      const sent = record.deliveries.filter((d: J) => d.to === to && d.order).length;
      /* A recipient that ended is never reopened: the result stays in the record - and in its project's tray. Its quota of
         messages is kept. */
      if (!t || ended(t)) { record.deliveries.push({ contribution: c.id, to, state: 'kept_recipient_ended' }); o.project?.keep(c, to, 'its recipient had ended'); continue; }
      if (sent >= spec.max_messages) { record.deliveries.push({ contribution: c.id, to, state: 'kept_no_messages_left' }); continue; }
      const text = 'A contribution of agent:' + spec.id + ' (' + c.id + ', ' + c.state + '): ' + summary + '\n\nIts report:\n' + (report.length > 6000 ? report.slice(0, 6000) + '\n[...]' : report)
        + '\n\nIt is a colleague\'s suggestion: adopt, question or ignore it; cite it with "because": "' + c.id + '" where you act on it.';
      const { id } = send(t, { kind: 'message', text, by: 'agent:' + spec.id, contribution: { id: c.id, report: c.report.sha256, state: c.state }, ...(exposed(c.external_exposure) ? { external_exposure: c.external_exposure } : {}) });
      record.deliveries.push({ contribution: c.id, to, order: id, at: new Date(now()).toISOString() });
    }
    save();
  };

  /* Any contribution whose delivery was cut short by a stop: delivered now, each recipient once. */
  for (const c of record.contributions as ResearchContribution[]) {
    const report = (() => { try { return fs.readFileSync(path.join(blobs, c.report.sha256), 'utf8'); } catch { return ''; } })();
    if (c.to.some((to) => !record.deliveries.some((d: J) => d.contribution === c.id && d.to === to))) deliver(c, report.slice(0, 280), report);
  }

  while (!o.signal?.aborted) {
    const why = outOfBudget();
    if (why) { record.state = 'ended'; record.ended_by = 'budget:' + why; break; }
    /* Its project closed or cancelled: what is pending is cancelled, what it reached stays. */
    if (o.project?.closed()) { record.state = 'ended'; record.ended_by = 'project_ended'; break; }
    if ((spec.lifetime ?? 'targets') === 'targets' && (o.project ? o.project.all() : true) && targetsNow().length && targetsNow().every((t) => fs.existsSync(t) && ended(t))) { record.state = 'ended'; record.ended_by = 'targets_ended'; break; }
    const woken = facts();
    save();
    if (woken.length) await activate(woken);
    await sleep(o.pollMs ?? 2000, o.signal);
  }
  if (record.state !== 'ended') { record.state = 'cancelled'; record.ended_by = 'signal'; }
  save();
  return record;
}

/** Reads an operator-research@1 file. */
export function readResearchSpec(file: string): OperatorResearchSpec {
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error('--research: ' + file + ' is not JSON (' + String((e as Error).message ?? e) + ')'); }
  const p = researchSpecProblems(raw);
  if (p.length) throw new Error('--research: ' + p.join('; '));
  return raw as OperatorResearchSpec;
}

/** Whether a world refuses what an exposed contribution carries: never delivered there (§4.1.1). */
export const refusesExposed = (experiment: string): string | null => {
  const lab = Object.values(LABS).find((l) => l.id === experiment);
  return lab?.externalSources?.admitted === false ? lab.externalSources.why : null;
};
