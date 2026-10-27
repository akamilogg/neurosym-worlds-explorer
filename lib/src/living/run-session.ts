import fs from 'node:fs';
import path from 'node:path';
import { runLaboratory, type LabConnection, type LabResult } from '../runtime/lab-runner.ts';
import type { FetchLike } from '../core/net.ts';
import type { LawLab } from '../learn/lab.ts';
import { WorldJournal, type ActorDecl, type SessionClock, type SessionLimits } from './world.ts';
import { actorSlug } from './bridge.ts';
import type { ProgramDecl, SignalDecl, WatchDecl } from './events.ts';
import { nodeVmRunner } from '../runtime/node-vm.ts';
import { runAgentOperator } from '../orchestra/agent-operator.ts';
import type { ChatClient } from '../learn/system2.ts';

/* ============================================================================
 * A SHARED SESSION (SPEC-ACONTECIMIENTOS-DEL-MUNDO §4, §8): one living world, several members - researchers, each the
 * assisted one in a run of its own, and actors that are not researchers, whose policies the session runs - in one process.
 * The session's journal and its closing are this runner's; each researcher's run keeps its own journal, and leaves the
 * session when it ends. The windows are applied once every member sealed, in the order the seed fixes: who answered first
 * changes nothing (§5.1).
 * ========================================================================== */

/** A researcher of the session: its budget as a run's. */
export interface ResearcherDecl extends ActorDecl {
  readonly kind: 'researcher';
  readonly rounds: number;
  readonly steps: number;
  readonly acts: number;
  readonly max_tokens?: number;
  readonly max_minutes?: number;
  /** Its senior (SPEC-ORQUESTADOR §3.3): the strategic half of the same researcher, never a member of the world - it reads
      what its junior was given and writes to it; called by its signs and, as declared, by what reached its junior (§9). */
  readonly senior?: { readonly patience?: number; readonly max_orders?: number; readonly activation?: { readonly on_observation?: boolean; readonly on_message?: boolean; readonly max: number } };
  /** Its branches (§12): a fund, its limits, and the modes allowed - an isolated realization, a member of this world. */
  readonly delegation?: { readonly fund: number; readonly tokens?: number; readonly rounds?: number; readonly max_rounds?: number; readonly branches?: readonly ('isolated' | 'shared')[] };
}

export interface SessionPlan {
  readonly seed: number;
  readonly clock: SessionClock;
  readonly limits: SessionLimits;
  readonly actors: readonly (ResearcherDecl | ActorDecl)[];
  readonly explore?: number;
  readonly check_episodes?: number;
  /** The operator's programs, the signals they read, the instruments installed before the start (§7, §10). */
  readonly programs?: readonly ProgramDecl[];
  readonly signals?: readonly SignalDecl[];
  readonly sensors?: readonly (WatchDecl & { readonly actor: string })[];
}

export interface SessionRun {
  /** The session's journal. */
  readonly world: string;
  /** Each researcher's run: its journal and how it ended, or why it failed. */
  readonly runs: Readonly<Record<string, { journal: string | null; stoppedBy?: string; error?: string }>>;
  readonly summary: Record<string, unknown>;
}

/** The world options a plan sets, over the laboratory's defaults. */
export function planOptions(lab: LawLab, plan: SessionPlan): Record<string, string> {
  const l = plan.limits;
  return { ...Object.fromEntries(lab.options.map((o) => [o.name, o.default])), interval: String(plan.clock.decision_interval), horizon: String(plan.clock.horizon),
    'window-calls': String(l.calls_per_window), 'window-intents': String(l.intents_per_window),
    ...(l.messages_per_window !== undefined ? { messages: String(l.messages_per_window), 'message-chars': String(l.message_chars), delivery: String(l.delivery_per_decision ?? 8) } : {}),
    ...(l.window_ms !== undefined ? { 'window-ms': String(l.window_ms) } : {}), ...(plan.clock.mode === 'realtime' ? { 'tick-ms': String(plan.clock.tick_ms) } : {}) };
}

/** The session of a plan, its journal given: its members, limits, programs, signals, instruments and sandbox. */
function openShared(lab: LawLab, plan: SessionPlan, journal: WorldJournal) {
  const options = planOptions(lab, plan);
  const spec = lab.generate(plan.seed, options);
  return lab.living!.open(spec, { journal, actors: plan.actors.map(({ ...d }) => {
    const { rounds: _r, steps: _s, acts: _a, max_tokens: _t, max_minutes: _m, senior: _sn, delegation: _dl, ...decl } = d as ResearcherDecl;
    return decl;
  }), options, limits: { ...(plan.limits.watchers !== undefined ? { watchers: plan.limits.watchers } : {}),
    /* Room for a shared branch of each researcher that may open one, where no limit of members is declared. */
    actors: plan.limits.actors ?? plan.actors.length + plan.actors.filter((a) => (a as ResearcherDecl).delegation?.branches?.includes('shared')).length },
  /* Watchers and state predicates run in the sandbox, never in the host. */
  events: { ...(plan.programs ? { programs: plan.programs } : {}), ...(plan.signals ? { signals: plan.signals } : {}), ...(plan.sensors ? { sensors: plan.sensors } : {}),
    compile: (source: string) => { const fn = nodeVmRunner({ timeoutMs: 500 }).compile(source); return (input: unknown) => fn(input as never); } } });
}

/** The stops that leave a record short: a reconstruction stops where they did. */
const SHORT = new Set(['token_budget', 'time_budget', 'cancelled']);

/** A shared session REBUILT from its record (§14: the whole of it, not only one researcher): its world derived again against
    the journal it continues, every researcher resumed from its own log at once, in this process - each stopped where its record
    stopped. With an offline connection, nothing goes out: an answer the record does not hold is a failure, never asked. */
export async function rebuildLivingSession(lab: LawLab, o: { sessionFile: string; dir: string; name: string; root: string;
  connection: (actor: string) => { llm: LabConnection; judge?: LabConnection; fetch?: FetchLike }; signal?: AbortSignal;
  /** `continue`: the session goes on from its record - each researcher's run resumed, asking live once its log is spent, given
      `moreRounds` more where its rounds ran out - a session of its own in `dir`, its record naming where it came from. By
      default a reconstruction: each stopped where its record stopped. */
  mode?: 'rebuild' | 'continue'; moreRounds?: number; args?: readonly string[] }): Promise<SessionRun> {
  const recorded = JSON.parse(fs.readFileSync(o.sessionFile, 'utf8'));
  const going = o.mode === 'continue';
  /* In real time what each member was answered depended on when it answered: never derived again (§5.2). */
  if ((recorded.plan as SessionPlan).clock.mode === 'realtime') throw new Error('a session in real time is never reproduced nor continued from its record: what each member was answered depended on when it answered (§5.2)');
  const from = path.dirname(o.sessionFile);
  const plan = recorded.plan as SessionPlan;
  fs.mkdirSync(o.dir, { recursive: true });
  const worldFile = path.join(o.dir, o.name + '.world.jsonl');
  const session = openShared(lab, plan, new WorldJournal(worldFile, { from: path.join(from, String(recorded.world)) }));
  const runs: Record<string, { journal: string | null; stoppedBy?: string; error?: string }> = {};
  await Promise.all(Object.entries((recorded.runs ?? {}) as Record<string, { journal: string | null; stoppedBy?: string }>).map(async ([id, r]) => {
    if (!r.journal) { session.retire(id, 'failed'); runs[id] = { journal: null, error: 'its record holds no run' }; return; }
    const out = path.join(o.dir, o.name + '.' + actorSlug(id) + '.json');
    const c = o.connection(id);
    const was = path.join(from, r.journal);
    if (!fs.existsSync(was)) { session.retire(id, 'never started'); runs[id] = { journal: null, error: 'its run never wrote a record' }; return; }
    /* Its rounds ran out: given more, where the session goes on and more were asked. */
    const rounds = (plan.actors.find((a) => a.id === id) as ResearcherDecl | undefined)?.rounds ?? 0;
    const end = [...((JSON.parse(fs.readFileSync(was, 'utf8')).events ?? []) as Record<string, any>[])].reverse().find((e) => e.type === 'end');
    const more = going && o.moreRounds && end?.stoppedBy === 'budget' ? ['--attempts', String(rounds + o.moreRounds)] : [];
    try {
      const result = await runLaboratory(lab, { args: ['--resume', was, ...more, ...(going ? o.args ?? [] : []), '--out', out], root: o.root, llm: c.llm, ...(c.judge ? { judge: c.judge } : {}), ...(c.fetch ? { fetch: c.fetch } : {}),
        ...(o.signal ? { signal: o.signal } : {}), living: { session, actor: id }, ...(!going && r.stoppedBy && SHORT.has(r.stoppedBy) ? { stopAsRecorded: r.stoppedBy } : {}) });
      runs[id] = { journal: result.journal, stoppedBy: result.stoppedBy };
    } catch (e) { session.retire(id, 'failed'); runs[id] = { journal: fs.existsSync(out) ? out : null, error: String((e as Error).message ?? e) }; }
  }));
  const summary = session.close('every researcher left');
  if (going) fs.writeFileSync(path.join(o.dir, o.name + '.session.json'), JSON.stringify({ format: 'living-session@1', adapter: lab.id, state: 'ended',
    plan: o.moreRounds ? { ...plan, actors: plan.actors.map((a) => (a.kind === 'researcher' ? { ...a, rounds: (a as ResearcherDecl).rounds + o.moreRounds! } : a)) } : plan,
    world: path.basename(worldFile), continued_from: path.relative(o.dir, o.sessionFile).split(path.sep).join('/'),
    runs: Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, { ...v, journal: v.journal ? path.relative(o.dir, v.journal).split(path.sep).join('/') : null }])), summary }, null, 2));
  return { world: worldFile, runs, summary };
}

/** Runs a shared session to its end: every researcher's run at once, the session closed when the last has left. */
export async function runLivingSession(lab: LawLab, o: { plan: SessionPlan; dir: string; name: string; root: string;
  connection: (actor: string) => { llm: LabConnection; judge?: LabConnection; fetch?: FetchLike }; args?: readonly string[]; signal?: AbortSignal;
  /** The LLM of a researcher's senior: where a researcher declares one, it is required. */
  seniorLlm?: (actor: string) => ChatClient }): Promise<SessionRun> {
  if (!lab.living) throw new Error(lab.id + ' is not a living world');
  const withSenior = o.plan.actors.filter((a) => a.kind === 'researcher' && (a as ResearcherDecl).senior);
  if (withSenior.length && !o.seniorLlm) throw new Error('a senior is declared for ' + withSenior.map((a) => a.id).join(', ') + ' and no model is given for it');
  const { plan } = o;
  const options = planOptions(lab, plan);
  fs.mkdirSync(o.dir, { recursive: true });
  const worldFile = path.join(o.dir, o.name + '.world.jsonl');
  const session = openShared(lab, plan, new WorldJournal(worldFile));
  const researchers = plan.actors.filter((a): a is ResearcherDecl => a.kind === 'researcher');
  const runs: Record<string, { journal: string | null; stoppedBy?: string; error?: string }> = {};
  /* Its record from the start - its plan, its world, where each researcher's run will be: a session cut short can be
     continued from it. Completed at its end. */
  const record = (state: 'running' | 'ended', summary?: Record<string, unknown>) => fs.writeFileSync(path.join(o.dir, o.name + '.session.json'), JSON.stringify({ format: 'living-session@1', adapter: lab.id, state, plan,
    world: path.basename(worldFile), runs: Object.fromEntries(researchers.map((r) => { const v = runs[r.id] ?? { journal: path.join(o.dir, o.name + '.' + actorSlug(r.id) + '.json') };
      return [r.id, { ...v, journal: v.journal ? path.relative(o.dir, v.journal).split(path.sep).join('/') : null }]; })), ...(summary ? { summary } : {}) }, null, 2));
  record('running');
  /* The operator's orders to the session (`lab world <session> ...`): its inbox beside its record, read as they come; what
     came of each written back. */
  const inbox = path.join(o.dir, o.name + '.inbox.jsonl'), acks = path.join(o.dir, o.name + '.orders.jsonl');
  let consumed = 0;
  const poll = () => {
    if (!fs.existsSync(inbox)) return;
    const lines = fs.readFileSync(inbox, 'utf8').split('\n');
    for (const line of lines.slice(consumed, -1)) {
      consumed++;
      let order: Record<string, any>;
      try { order = JSON.parse(line); } catch { fs.appendFileSync(acks, JSON.stringify({ refused: 'not an order (not JSON)' }) + '\n'); continue; }
      const why = session.control({ ...order, id: String(order.id ?? 'order-' + consumed), by: String(order.by ?? 'operator') } as never);
      fs.appendFileSync(acks, JSON.stringify({ id: order.id ?? null, op: order.op, ...(why ? { refused: why } : { accepted: true }), at: new Date().toISOString() }) + '\n');
    }
  };
  const poller = setInterval(poll, 500);
  await Promise.all(researchers.map(async (r) => {
    /* One file for each researcher, even where the file system does not tell capitals apart. */
    const out = path.join(o.dir, o.name + '.' + actorSlug(r.id) + '.json');
    const c = o.connection(r.id);
    /* Its own before the session's: its branches' modes, its fund. */
    const dl = r.delegation;
    const own = dl ? ['--branches', (dl.branches ?? ['isolated']).join(','), '--delegation-fund', String(dl.fund), ...(dl.tokens ? ['--delegation-tokens', String(dl.tokens)] : []),
      ...(dl.rounds ? ['--delegation-rounds', String(dl.rounds)] : []), ...(dl.max_rounds ? ['--delegation-max-rounds', String(dl.max_rounds)] : [])] : [];
    const args = [...own, '--seed', String(plan.seed), '--researcher', 'assisted', ...Object.entries(options).flatMap(([k, v]) => ['--' + k, v]),
      '--attempts', String(r.rounds), '--steps', String(r.steps), '--acts', String(r.acts),
      ...(r.max_tokens !== undefined ? ['--max-tokens', String(r.max_tokens)] : []), ...(r.max_minutes !== undefined ? ['--max-minutes', String(r.max_minutes)] : []),
      ...(plan.explore !== undefined ? ['--explore', String(plan.explore)] : []), ...(plan.check_episodes !== undefined ? ['--check-episodes', String(plan.check_episodes)] : []),
      ...(r.senior ? ['--agents', 'senior=message'] : []), ...(o.args ?? []), '--out', out];
    /* Its senior follows its run from beside it, in this process, as `lab agent` would: it leaves when its run ends. */
    const stopSenior = new AbortController();
    const senior = r.senior ? runAgentOperator({ id: 'senior', role: 'senior', journal: out, root: o.root, llm: o.seniorLlm!(r.id), signal: stopSenior.signal, pollMs: 500,
      ...(r.senior.max_orders !== undefined ? { maxOrders: r.senior.max_orders } : {}), ...(r.senior.patience !== undefined ? { patience: r.senior.patience } : {}),
      ...(r.senior.activation ? { activation: r.senior.activation } : {}) }).catch(() => null) : null;
    try {
      const result: LabResult = await runLaboratory(lab, { args, root: o.root, llm: c.llm, ...(c.judge ? { judge: c.judge } : {}), ...(c.fetch ? { fetch: c.fetch } : {}),
        ...(o.signal ? { signal: o.signal } : {}), living: { session, actor: r.id } });
      runs[r.id] = { journal: result.journal, stoppedBy: result.stoppedBy };
      stopSenior.abort();
      await senior;
    } catch (e) {
      /* A run that failed leaves the session all the same: the others are never left waiting for it. */
      session.retire(r.id, 'failed');
      runs[r.id] = { journal: fs.existsSync(out) ? out : null, error: String((e as Error).message ?? e) };
      stopSenior.abort();
      await senior;
    }
  }));
  clearInterval(poller);
  poll();
  const summary = session.close('every researcher left');
  record('ended', summary);
  return { world: worldFile, runs, summary };
}
