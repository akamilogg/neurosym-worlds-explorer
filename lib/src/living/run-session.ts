import fs from 'node:fs';
import path from 'node:path';
import { runLaboratory, type LabConnection, type LabResult } from '../runtime/lab-runner.ts';
import type { FetchLike } from '../core/net.ts';
import type { LawLab } from '../learn/lab.ts';
import { WorldJournal, type ActorDecl, type SessionClock, type SessionLimits } from './world.ts';
import type { ProgramDecl, SignalDecl, WatchDecl } from './events.ts';
import { nodeVmRunner } from '../runtime/node-vm.ts';

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
    ...(l.window_ms !== undefined ? { 'window-ms': String(l.window_ms) } : {}) };
}

/** Runs a shared session to its end: every researcher's run at once, the session closed when the last has left. */
export async function runLivingSession(lab: LawLab, o: { plan: SessionPlan; dir: string; name: string; root: string;
  connection: (actor: string) => { llm: LabConnection; judge?: LabConnection; fetch?: FetchLike }; args?: readonly string[]; signal?: AbortSignal }): Promise<SessionRun> {
  if (!lab.living) throw new Error(lab.id + ' is not a living world');
  const { plan } = o;
  const options = planOptions(lab, plan);
  fs.mkdirSync(o.dir, { recursive: true });
  const worldFile = path.join(o.dir, o.name + '.world.jsonl');
  const spec = lab.generate(plan.seed, options);
  const session = lab.living.open(spec, { journal: new WorldJournal(worldFile), actors: plan.actors.map(({ ...d }) => {
    const { rounds: _r, steps: _s, acts: _a, max_tokens: _t, max_minutes: _m, ...decl } = d as ResearcherDecl;
    return decl;
  }), options, limits: { ...(plan.limits.watchers !== undefined ? { watchers: plan.limits.watchers } : {}) },
  /* Watchers and state predicates run in the sandbox, never in the host. */
  events: { ...(plan.programs ? { programs: plan.programs } : {}), ...(plan.signals ? { signals: plan.signals } : {}), ...(plan.sensors ? { sensors: plan.sensors } : {}),
    compile: (source: string) => { const fn = nodeVmRunner({ timeoutMs: 500 }).compile(source); return (input: unknown) => fn(input as never); } } });
  const researchers = plan.actors.filter((a): a is ResearcherDecl => a.kind === 'researcher');
  const runs: Record<string, { journal: string | null; stoppedBy?: string; error?: string }> = {};
  await Promise.all(researchers.map(async (r) => {
    const out = path.join(o.dir, o.name + '.' + r.id.replace(/[^A-Za-z0-9_-]+/g, '-') + '.json');
    const c = o.connection(r.id);
    const args = ['--seed', String(plan.seed), '--researcher', 'assisted', ...Object.entries(options).flatMap(([k, v]) => ['--' + k, v]),
      '--attempts', String(r.rounds), '--steps', String(r.steps), '--acts', String(r.acts),
      ...(r.max_tokens !== undefined ? ['--max-tokens', String(r.max_tokens)] : []), ...(r.max_minutes !== undefined ? ['--max-minutes', String(r.max_minutes)] : []),
      ...(plan.explore !== undefined ? ['--explore', String(plan.explore)] : []), ...(plan.check_episodes !== undefined ? ['--check-episodes', String(plan.check_episodes)] : []),
      ...(o.args ?? []), '--out', out];
    try {
      const result: LabResult = await runLaboratory(lab, { args, root: o.root, llm: c.llm, ...(c.judge ? { judge: c.judge } : {}), ...(c.fetch ? { fetch: c.fetch } : {}),
        ...(o.signal ? { signal: o.signal } : {}), living: { session, actor: r.id } });
      runs[r.id] = { journal: result.journal, stoppedBy: result.stoppedBy };
    } catch (e) {
      /* A run that failed leaves the session all the same: the others are never left waiting for it. */
      session.retire(r.id, 'failed');
      runs[r.id] = { journal: fs.existsSync(out) ? out : null, error: String((e as Error).message ?? e) };
    }
  }));
  const summary = session.close('every researcher left');
  fs.writeFileSync(path.join(o.dir, o.name + '.session.json'), JSON.stringify({ format: 'living-session@1', adapter: lab.id, plan, world: path.basename(worldFile),
    runs: Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, { ...v, journal: v.journal ? path.relative(o.dir, v.journal).split(path.sep).join('/') : null }])), summary }, null, 2));
  return { world: worldFile, runs, summary };
}
