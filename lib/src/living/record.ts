import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { stableStringify } from '../core/hash.ts';

/* ============================================================================
 * A LIVING WORLD'S RECORD, READ (SPEC-ACONTECIMIENTOS-DEL-MUNDO §14, §15.1, §16): what the results, the traces, the console
 * and the package make of a session's journal.
 *
 *   identity      §15.1: the generator's part (what the researcher was given to work with: clock, limits, reactivity,
 *                 communication, delegation, the signals and reactions that read it) and the world's condition (adapter, its
 *                 regime, the policies of its other actors, the instruments installed, the agenda, the evaluator) - each a
 *                 hash of its own; the realization (seed, initial state) apart; names, paths and times never part of them;
 *                 a run whose programs the operator changed during it, `adapted`
 *   verification  §14: every transition prepared then committed, revisions in order, every delivery and receipt of something
 *                 published to its recipient, every firing applied or refused, counters that add up
 *   comparison    a world derived again against its record: the same entries, what names the stretch of execution aside
 *   timeline      §16: what happened as the auditor sees it, or as one member perceived it - never the one for the other
 *   cost, traces  §15.1 K1, K4: what the world cost and how it went - descriptions, never scores
 * ========================================================================== */

type J = Record<string, any>;
const hash = (x: unknown): string => createHash('sha256').update(stableStringify(x)).digest('hex').slice(0, 12);

/** A session's journal: its entries in order (a line cut by a crash is no entry). */
export function readWorld(file: string): J[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}

/** Where a run's world is recorded: its own journal beside it, or the shared session's it names. Null: no living world. */
export function worldFileOf(journalFile: string, journal: J): string | null {
  const w = journal?.world;
  if (!w || typeof w.journal !== 'string') return null;
  return path.resolve(path.dirname(journalFile), w.journal);
}

/** What names a stretch of execution in a key (a closing's, a retirement's): set aside where records are compared. */
export const keyOf = (key: string): string => key.replace(/\.[^.@~]+~[0-9a-z]+$/, '');

/* --- Identity (§15.1) -------------------------------------------------------------------------------------------------- */

const AGENDA = new Set(['at', 'every']);

/** Members as roles, never names: researchers in their order, the others by kind and policy - their permissions and their
    connections kept. */
function roles(actors: readonly J[]): { generator: J[]; condition: J[]; names: Map<string, string> } {
  const names = new Map<string, string>();
  let r = 0, o = 0;
  for (const a of actors) names.set(a.id, a.kind === 'researcher' ? 'researcher#' + (++r) : a.kind + '#' + (++o));
  const generator = actors.filter((a) => a.kind === 'researcher').map((a) => ({ role: names.get(a.id), actions: [...(a.actions ?? [])].sort(), history: a.history ?? true, activation: a.activation ?? null }));
  const condition = actors.filter((a) => a.kind !== 'researcher').map((a) => ({ role: names.get(a.id), kind: a.kind, policy: a.policy, params: a.params ?? {}, actions: [...(a.actions ?? [])].sort() }));
  return { generator, condition, names };
}

const renamed = (x: unknown, names: Map<string, string>): unknown => JSON.parse(JSON.stringify(x ?? null), (_k, v) => (typeof v === 'string' && names.has(v) ? names.get(v) : v));

/** A session's identity, from its journal (§15.1). */
export function livingIdentity(entries: readonly J[], extra: { evaluator?: J; delegation?: J } = {}): { generator: string; condition: string; realization: string; adapted: boolean;
  parts: { generator: J; condition: J; realization: J } } {
  const m = entries.find((e) => e.key === 'manifest') ?? {};
  const ev = entries.find((e) => e.key === 'events') ?? {};
  const { generator: researchers, condition: others, names } = roles((m.actors ?? []) as J[]);
  const programs = (ev.programs ?? []) as J[];
  const agenda = programs.filter((p) => AGENDA.has(p.trigger?.kind));
  const reactive = programs.filter((p) => !AGENDA.has(p.trigger?.kind));
  /* The realization: its seed and the plate it was given, never part of the condition. */
  const { layout: _layout, ...regime } = (m.config ?? {}) as J;
  const generator = { clock: m.clock ?? null, limits: m.limits ?? null, researchers, signals: renamed(ev.signals ?? [], names), reactions: renamed(reactive, names),
    delegation: extra.delegation ?? null };
  const condition = { adapter: m.adapter ?? null, regime, guarantees: m.guarantees ?? null, actions: m.actions ?? null, others, sensors: renamed(ev.sensors ?? [], names),
    agenda: renamed(agenda, names), evaluator: extra.evaluator ?? null };
  const realization = { seed: m.seed ?? null, config: m.config ?? null, state: m.state ?? null, ...(m.lineage ? { lineage: { revision: m.lineage.revision, tick: m.lineage.tick, randomness: m.lineage.randomness } } : {}) };
  return { generator: hash(generator), condition: hash(condition), realization: hash(realization), adapted: entries.some((e) => String(e.key).startsWith('prog.')),
    parts: { generator, condition, realization } };
}

/** The labels of what the environment did (§15.1 K2): never mixed in a comparison; none when nothing intervened. */
export function interventionLabels(entries: readonly J[]): string[] {
  const labels = new Set(entries.filter((e) => String(e.key).startsWith('fire.')).map((e) => String(e.label)));
  return labels.size ? [...labels].sort() : ['none'];
}

/* --- Verification (§14) -------------------------------------------------------------------------------------------------- */

/** Whether a session's journal holds together: its transitions, its deliveries and receipts, its firings, its counters. */
export function verifyWorld(entries: readonly J[]): { holds: boolean; transitions: number; messages: number; receipts: number; deliveries: number; firings: number; problems: string[] } {
  const problems: string[] = [];
  const keys = entries.map((e) => String(e.key));
  if (new Set(keys).size !== keys.length) problems.push('an entry written twice');
  if (keys[0] !== 'manifest') problems.push('it does not begin with its manifest');
  const commits = entries.filter((e) => /^w\d+\.commit$/.test(e.key));
  let revision = 0;
  for (const c of commits) {
    const p = keys.indexOf('w' + c.window + '.prepare');
    if (p < 0 || p > keys.indexOf(c.key)) problems.push('window ' + c.window + ' committed without being prepared before');
    if (c.revision !== revision + 1) problems.push('window ' + c.window + ': revision ' + c.revision + ' after ' + revision);
    revision = c.revision;
  }
  const prepared = entries.filter((e) => /^w\d+\.prepare$/.test(e.key));
  const closed = entries.some((e) => String(e.key).startsWith('close@'));
  for (const p of prepared) if (!keys.includes('w' + p.window + '.commit') && closed) problems.push('window ' + p.window + ' prepared and never committed, and the session closed');
  const messages = new Map(entries.filter((e) => String(e.key).startsWith('m.')).map((e) => [String(e.id), e]));
  const receipts = entries.filter((e) => /^r\./.test(e.key));
  for (const r of receipts) {
    const m = messages.get(String(r.message));
    if (!m) { problems.push('a receipt of ' + r.message + ', never published'); continue; }
    if (!(m.recipients ?? []).includes(r.actor)) problems.push(r.actor + ' received ' + r.message + ', not addressed to it');
    if (Number(r.window) < Number(m.window)) problems.push(r.message + ' received before its window was committed');
  }
  const deliveries = entries.filter((e) => /^d\./.test(e.key));
  for (const d of deliveries) if (Number(d.window) > revision) problems.push('a delivery after the last committed window');
  const fired = entries.filter((e) => String(e.key).startsWith('fire.'));
  const effects = new Set(commits.flatMap((c) => (c.effects ?? []) as J[]).map((x) => String(x.firing)));
  const lastTick = commits.length ? Number(commits[commits.length - 1].to) : 0;
  for (const f of fired) if (Number(f.at) < lastTick && !effects.has(String(f.id))) problems.push('firing ' + f.id + ' due at tick ' + f.at + ' neither applied nor refused');
  const close = [...entries].reverse().find((e) => String(e.key).startsWith('close@'));
  if (close?.use) {
    if (close.use.windows !== commits.length) problems.push('the closing counts ' + close.use.windows + ' windows; ' + commits.length + ' were committed');
    if (close.use.messages !== [...messages.values()].filter((m) => !String(m.from).startsWith('instrument:') && m.from !== 'operator').length) problems.push('the closing\'s count of messages does not add up');
    if (close.use.deliveries !== receipts.length) problems.push('the closing counts ' + close.use.deliveries + ' receipts; ' + receipts.length + ' were written');
  }
  return { holds: !problems.length, transitions: commits.length, messages: messages.size, receipts: receipts.length, deliveries: deliveries.length, firings: fired.length, problems };
}

/** A world derived again against its record: every entry of the record found the same in it (its wall time and the name of
    its stretch aside), in the same order. */
export function compareWorlds(recorded: readonly J[], rebuilt: readonly J[]): { holds: boolean; compared: number; first_difference?: string; missing?: string[] } {
  const norm = (e: J) => { const { at: _a, ...x } = e; return stableStringify({ ...x, key: keyOf(String(e.key)) }); };
  const now = new Map(rebuilt.map((e) => [keyOf(String(e.key)), norm(e)]));
  const missing: string[] = [];
  for (const e of recorded) {
    const k = keyOf(String(e.key));
    if (!now.has(k)) { missing.push(k); continue; }
    if (now.get(k) !== norm(e)) return { holds: false, compared: recorded.length, first_difference: k };
  }
  return missing.length ? { holds: false, compared: recorded.length, missing } : { holds: true, compared: recorded.length };
}

/* --- Timeline (§16) ---------------------------------------------------------------------------------------------------- */

/** What happened, line by line: as the auditor sees it (everything, what happened unperceived included), or as one member
    perceived it (its own acts and their outcomes, what reached it, its wakes) - never the one for the other. */
export function livingTimeline(entries: readonly J[], view: 'auditor' | { actor: string }): { at: number; window?: number; line: string }[] {
  const auditor = view === 'auditor';
  const me = auditor ? null : view.actor;
  const out: { at: number; window?: number; line: string }[] = [];
  const mine = (id: unknown) => typeof id === 'string' && id.startsWith(me + ':');
  for (const e of entries) {
    const k = String(e.key);
    if (/^w\d+\.commit$/.test(k)) {
      const outcomes = ((e.outcomes ?? []) as J[]).filter((o) => auditor || mine(o.intent));
      const acts = outcomes.map((o) => o.intent + ' ' + o.outcome + (o.reason ? ' (' + o.reason + ')' : '')).join('; ');
      if (auditor || outcomes.length) out.push({ at: Number(e.to), window: e.window, line: 'window ' + e.window + ' ticks ' + e.from + '-' + e.to + (acts ? ': ' + acts : '') });
      if (auditor) for (const o of (e.occurred ?? []) as J[]) out.push({ at: Number(o.tick), window: e.window, line: 'happened (restricted record): ' + o.kind + (o.well ? ' at ' + o.well : '') });
      if (auditor) for (const x of (e.effects ?? []) as J[]) out.push({ at: Number(x.tick), window: e.window, line: 'the operator\'s ' + x.firing + (x.refused ? ' refused: ' + x.refused : ' applied') });
      if (auditor && e.timeouts?.length) out.push({ at: Number(e.from), window: e.window, line: 'timed out: ' + e.timeouts.join(', ') });
    } else if (k.startsWith('fire.') && auditor) out.push({ at: Number(e.decided_at ?? e.at), line: 'fired ' + e.program + ' (' + e.mode + ', ' + e.label + ') for tick ' + e.at });
    else if (k.startsWith('m.')) {
      if (auditor || e.from === me) out.push({ at: Number(e.window), line: 'published ' + e.id + ' by ' + e.from + ' to ' + ('actor' in (e.to ?? {}) ? e.to.actor : 'global') });
    } else if (k.startsWith('r.')) {
      if (auditor || e.actor === me) out.push({ at: Number(e.window), line: e.actor + ' received ' + e.message + ' (' + e.how + ')' });
    } else if (k.startsWith('wake.')) {
      if (auditor || e.actor === me) out.push({ at: Number(e.tick), line: e.actor + ' woken by ' + (e.by ?? []).join(', ') });
    } else if (k.startsWith('watch.')) {
      if (auditor || e.actor === me) out.push({ at: Number(e.tick), line: e.actor + ' watches ' + e.id + ' (version ' + e.version + ')' });
    } else if (k.startsWith('join.') || k.startsWith('retire.')) {
      if (auditor) out.push({ at: Number(e.tick), line: k.startsWith('join.') ? e.id + ' joined' : k.split('@')[0].slice(7) + ' left: ' + e.reason });
    } else if (k.startsWith('prog.') && auditor) out.push({ at: Number(e.tick), line: 'the operator ' + e.order?.op + ' ' + (e.order?.program?.id ?? e.order?.target) + (e.order?.why ? ': ' + e.order.why : '') });
  }
  return out;
}

/* --- Cost and traces (§15.1 K1, K4) ------------------------------------------------------------------------------------- */

/** What the world cost and did, from its closing (or its entries): windows, ticks, intents, messages and their deliveries,
    instruments, the operator's interventions by mode and label - apart from the help a researcher was given. */
export function livingCost(entries: readonly J[]): J | null {
  if (!entries.length) return null;
  const close = [...entries].reverse().find((e) => String(e.key).startsWith('close@'));
  const commits = entries.filter((e) => /^w\d+\.commit$/.test(e.key));
  const fired = entries.filter((e) => String(e.key).startsWith('fire.'));
  const by = (f: (e: J) => string) => fired.reduce((o, e) => ({ ...o, [f(e)]: (o[f(e)] ?? 0) + 1 }), {} as Record<string, number>);
  return { windows: commits.length, ticks: commits.reduce((n, c) => n + Number(c.to) - Number(c.from), 0), intents: close?.use?.intents ?? null, conflicts: close?.use?.conflicts ?? null,
    messages: close?.use?.messages ?? entries.filter((e) => String(e.key).startsWith('m.')).length, deliveries: entries.filter((e) => /^r\./.test(e.key)).length,
    watchers: entries.filter((e) => String(e.key).startsWith('watch.')).length, readings: entries.filter((e) => String(e.key).startsWith('m.') && String(e.from).startsWith('instrument:')).length,
    interventions: { firings: fired.length, by_mode: by((e) => String(e.mode)), by_label: by((e) => String(e.label)), changes_during_the_run: entries.filter((e) => String(e.key).startsWith('prog.')).length },
    timeouts: close?.use?.timeouts ?? 0 };
}

/** How a member's life in the world went (K4): its windows by what ended them, its batches and conflicts, its messages, its
    instruments, its wakes, its timeouts, what it read later - a description, never a score. */
export function livingTraces(events: readonly J[], entries: readonly J[], actor: string): J {
  const windows = events.filter((e) => e.type === 'world_window');
  const by = windows.reduce((o, e) => ({ ...o, [e.by]: (o[e.by] ?? 0) + 1 }), {} as Record<string, number>);
  const outcomes = windows.flatMap((e) => (e.outcomes ?? []) as J[]);
  return {
    windows: windows.length, windows_by: by, batches: by.acts ?? 0, intents: outcomes.length, conflicts: outcomes.filter((o) => o.outcome === 'conflict').length,
    messages_sent: events.filter((e) => e.type === 'message_sent' && e.id).length, shared: events.filter((e) => e.type === 'material_shared' && e.id).length,
    received: entries.filter((e) => /^r\./.test(e.key) && e.actor === actor).length,
    read_later: events.filter((e) => e.type === 'investigation').flatMap((e) => (e.requests ?? []) as J[]).filter((r) => r && 'read' in r).length,
    watchers: events.filter((e) => e.type === 'watcher' && e.version).length, wakes: entries.filter((e) => String(e.key).startsWith('wake.' + actor + '.')).length,
    timeouts: windows.filter((e) => (e.timeouts ?? []).includes(actor)).length,
    perturbations_asked: events.filter((e) => e.type === 'perturbation_asked' && !e.refused).length
  };
}
