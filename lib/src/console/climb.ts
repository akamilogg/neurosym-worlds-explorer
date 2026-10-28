import fs from 'node:fs';
import path from 'node:path';
import { LABS } from '../worlds/labs.ts';
import { generatorOf } from '../runtime/generators.ts';
import { adoptedOf } from '../orchestra/traces.ts';
import { interventionLabels, livingIdentity, readWorld, worldFileOf } from '../living/record.ts';
import { DEFAULT_PROGRESS, axisOf, feeds, type LabProgress, type ProgressMetric } from '../learn/progress.ts';
import { hash, read, type Entry, type Json, type Profile, type ResearchStore } from './store.ts';

/* ============================================================================
 * The climb (SPEC-VISTA-ESCALADA §10): several researchers on the same mountain, read only from their records.
 *
 * Each researcher is a climber, the world's metric its mountain, and improving is going up. A climber's samples are only
 * the protocol's verdicts (§3.3), read from its events as the profile reading them received them - what a profile was not
 * given cannot be read from them. Climbers are grouped by what makes them comparable (§3.4): two worlds, two conditions,
 * are never on the same axis. Ropes (§5) join climbers only where a delivery is in the record, at the moment it was
 * delivered; the world's, the operator's and the harness's events (§6) are bands in time. `climbAt` is the climb at an
 * instant (§8): the same function the page runs to replay it, so what a replay shows is what a cut at that instant holds.
 * ========================================================================== */

export type SampleKind = 'check' | 'validation' | 'blind' | 'artifact';
export interface ClimbSample { metric: string; t: number; tokens: number | null; round: number | null; value: number; kind: SampleKind; ref: string; accepted?: boolean }
export interface Climber {
  id: string; label: string; kind: 'run' | 'branch'; parent?: string;
  /** Seconds from the start of the space. */
  joined_at: number;
  samples: ClimbSample[];
  /** What it was doing (§2): observes, acts, waits, delegates, proposes, checks, closes a round, stopped. */
  states: { t: number; state: string; ref: string }[];
  budget: { tokens_used: number | null; tokens_limit: number | null };
  /** Stretches where it did not improve (§2): from the sample that set its best to the last that did not beat it. */
  plateaus: { metric: string; from: number; to: number; samples: number }[];
  /** Verdicts it was given at no known time: never placed on the axis (C9). */
  untimed: number;
  /** Where its record was at each moment: [seconds, how many of its events], for a cut at an instant (§8). */
  positions: [number, number][];
}
export interface ClimbMetric extends ProgressMetric {
  samples: number;
  /** Drawn from `bottom` at the foot to `top` at the summit: improving is going up, whatever the metric's direction (§3.2). */
  axis: { bottom: number; top: number; scale: 'linear' | 'log' } | null;
  /** The best reached by the group up to each moment, where it changed. */
  crest: { t: number; value: number; climber: string; ref: string }[];
  summit: { value: number; climber: string; t: number; ref: string } | null;
}
/** A delivery from one to another (§5): `from` and `to` are climbers, or who is not one - "senior", "operator",
    "branch:<id>", "evolve:<id>". It says something arrived, never that it influenced. */
export interface Rope { kind: 'message' | 'material' | 'board' | 'directive' | 'advice' | 'branch_opened' | 'branch_result' | 'adoption' | 'announcement'; from: string; to: string; t: number; ref: string; label?: string }
export interface ClimbEvent { kind: string; origin: 'world' | 'operator' | 'harness'; t: number; to?: number; label: string; ref: string; climber?: string; profile: 'operator' | 'researcher'; data?: Json }
export interface ClimbGroup {
  key: Json;
  metrics: ClimbMetric[];
  climbers: Climber[];
  ropes: Rope[];
  events: ClimbEvent[];
}
export interface ClimbView { format: 'climb@1'; profile: Profile; origin: string | null; clock: number; at: number | null; groups: ClimbGroup[]; cursor: string; historical: boolean; notes: string[] }

/** The climb at an instant (§8): what had happened by `t` seconds - verdicts, states, ropes and events up to then, each
    climber's plateaus, the group's crest and summit as they were; spending unknown before the end (C9). Self-contained:
    the page runs this very function to replay a climb. The axes stay those of the whole climb, so that a replay does not
    move its mountain. */
export function climbAt(view: ClimbView, t: number): ClimbView {
  const PLATEAU = 3;
  const before = (x: { t: number }) => x.t <= t;
  const better = (m: { direction: string }, a: number, b: number) => (m.direction === 'higher' ? a > b : a < b);
  const groups = view.groups.map((g) => {
    const climbers = g.climbers.filter((c) => c.joined_at <= t).map((c) => {
      const samples = c.samples.filter(before);
      const plateaus: { metric: string; from: number; to: number; samples: number }[] = [];
      for (const m of g.metrics) {
        let best: ClimbSample | null = null, flat: ClimbSample[] = [];
        const close = () => { if (best && flat.length >= PLATEAU) plateaus.push({ metric: m.id, from: best.t, to: flat[flat.length - 1].t, samples: flat.length }); flat = []; };
        for (const s of samples.filter((x) => x.metric === m.id)) { if (!best || better(m, s.value, best.value)) { close(); best = s; } else flat.push(s); }
        close();
      }
      return { ...c, samples, states: c.states.filter(before), plateaus, positions: c.positions.filter((p) => p[0] <= t),
        budget: t >= view.clock ? c.budget : { tokens_used: null, tokens_limit: c.budget.tokens_limit } };
    });
    const metrics = g.metrics.map((m) => {
      const all = climbers.flatMap((c) => c.samples.filter((s) => s.metric === m.id).map((s) => ({ s, climber: c.id }))).sort((a, b) => a.s.t - b.s.t);
      const crest: { t: number; value: number; climber: string; ref: string }[] = [];
      for (const x of all) if (!crest.length || better(m, x.s.value, crest[crest.length - 1].value)) crest.push({ t: x.s.t, value: x.s.value, climber: x.climber, ref: x.s.ref });
      const top = crest[crest.length - 1];
      return { ...m, samples: all.length, crest, summit: top ? { value: top.value, climber: top.climber, t: top.t, ref: top.ref } : null };
    });
    return { ...g, metrics, climbers, ropes: g.ropes.filter(before), events: g.events.filter(before).map((e) => (e.to !== undefined && e.to > t ? { ...e, to: t } : e)) };
  });
  return { ...view, at: t >= view.clock ? null : t, groups };
}

/** The positions of a cut at an instant: how many of each climber's events had been written by then. */
export function positionsAt(view: ClimbView, t: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const g of view.groups) for (const c of g.climbers) out[c.id] = c.positions.filter((p) => p[0] <= t).reduce((n, p) => Math.max(n, p[1]), 0);
  return out;
}

export function progressOf(experiment: unknown): LabProgress {
  const lab = Object.values(LABS).find((l) => l.id === experiment) as { progress?: LabProgress } | undefined;
  return lab?.progress ?? DEFAULT_PROGRESS;
}

/** The verdicts an event is, each with its kind (§3.3): a check, its validation in the family, its blind confirmations, an
    artifact's check. */
export function verdictsOf(type: string, data: Json): { kind: SampleKind; event: Json; accepted?: boolean }[] {
  if (type === 'artifact_check') return [{ kind: 'artifact', event: { ...data, type }, accepted: data.accepted === true }];
  if (type !== 'check') return [];
  const out: { kind: SampleKind; event: Json; accepted?: boolean }[] = [{ kind: 'check', event: { ...data, type }, accepted: data.accepted === true }];
  const v = data.validation;
  if (v && Array.isArray(v.family) && v.family.length) out.push({ kind: 'validation', event: { type: 'check', laboratories: v.family } });
  const sets = v?.blind_confirmation?.sets;
  if (Array.isArray(sets)) for (const s of sets) if (Array.isArray(s?.places)) out.push({ kind: 'blind', event: { type: 'check', laboratories: s.places } });
  return out;
}

const STATE: Readonly<Record<string, string>> = {
  exploration_episode: 'observa', proposal: 'propone', reflection: 'propone', check: 'comprueba', artifact_check: 'comprueba',
  round_closed: 'cierra ronda', delegation_requested: 'delega', awaiting_opening: 'espera', awaiting_approval: 'espera', end: 'parado', halted: 'parado'
};
/* What a step asked: acting on its world (or its artifact), or only looking at it. */
const ACTS = new Set(['act', 'try', 'replay', 'register_test', 'simulate', 'launch', 'play', 'change', 'run', 'perturb']);
export function stateOf(type: string, data: Json): string | null {
  if (type === 'world_window') return data.by === 'wait' ? 'espera' : null;
  if (type !== 'investigation') return STATE[type] ?? null;
  const asked = (Array.isArray(data.requests) ? data.requests : []).map((r: unknown) => (r && typeof r === 'object' ? Object.keys(r)[0] : ''));
  return asked.some((k: string) => ACTS.has(k)) ? 'actúa' : 'observa';
}

/* The events of its record that are the operator's or the harness's (§6), as the profile reading it received them. */
function eventOf(type: string, d: Json): { kind: string; origin: ClimbEvent['origin']; label: string } | null {
  switch (type) {
    case 'operator_command': return d.accepted === false ? null : { kind: 'operator_command', origin: 'operator', label: 'orden del operador' + (d.kind ? ': ' + d.kind : '') };
    case 'focus_changed': return { kind: 'focus_changed', origin: 'operator', label: 'foco cambiado' + (d.facet ? ': ' + d.facet : '') };
    case 'sources_allowed': return { kind: 'sources_allowed', origin: 'operator', label: 'fuente permitida' + (d.origin ? ': ' + d.origin : '') };
    case 'budget_extended': return { kind: 'budget_extended', origin: 'harness', label: 'rondas añadidas' + (d.to_attempts ? ' hasta ' + d.to_attempts : '') };
    case 'halted': return { kind: 'halted', origin: 'harness', label: 'detenido' + (d.why ? ': ' + d.why : '') };
    case 'end': return { kind: 'end', origin: 'harness', label: 'parada' + (d.stoppedBy ? ': ' + d.stoppedBy : '') };
    case 'world_closed': return { kind: 'world_closed', origin: 'world', label: 'el mundo cerró' };
    case 'world_diverged': return { kind: 'world_diverged', origin: 'world', label: 'el mundo divergió de su registro' };
    case 'world_window': return Array.isArray(d.timeouts) && d.timeouts.length ? { kind: 'window_timeout', origin: 'world', label: 'ventana ' + d.window + ': no decidieron a tiempo ' + d.timeouts.join(', ') } : null;
    default: return null;
  }
}

/* A living world's own record, for the operator only (§6, §9): what happened that nobody asked for, the operator's firings
   and programs, members joining and leaving. Its ticks are placed on the clock by the windows its members logged. */
function worldEvents(file: string, windows: ReadonlyMap<number, number>): ClimbEvent[] {
  const entries = readWorld(file), out: ClimbEvent[] = [];
  const ticks: { from: number; to: number; window: number }[] = entries.filter((e) => /^w\d+\.commit$/.test(String(e.key))).map((e) => ({ from: Number(e.from), to: Number(e.to), window: Number(e.window) }));
  const timeOfWindow = (w: number): number | null => windows.get(w) ?? null;
  const timeOfTick = (tick: number): number | null => { const w = ticks.find((x) => tick >= x.from && tick <= x.to); return w ? timeOfWindow(w.window) : null; };
  const push = (t: number | null, kind: string, origin: ClimbEvent['origin'], label: string, key: string, data: Json) => { if (t !== null) out.push({ kind, origin, t, label, ref: 'world:' + key, profile: 'operator', data }); };
  for (const e of entries) {
    const k = String(e.key);
    if (/^w\d+\.commit$/.test(k)) {
      const t = timeOfWindow(Number(e.window));
      for (const o of (e.occurred ?? []) as Json[]) push(t, 'world_occurred', 'world', 'ocurrió: ' + o.kind + (o.well ? ' en ' + o.well : ''), k, o);
      for (const x of (e.effects ?? []) as Json[]) push(t, 'operator_firing', 'operator', 'disparo del operador ' + x.firing + (x.refused ? ' rechazado' : ''), k, x);
    } else if (k.startsWith('fire.')) push(timeOfTick(Number(e.at)), 'operator_fire', 'operator', 'disparo ' + e.program + ' (' + e.mode + ', ' + e.label + ')', k, e);
    else if (k.startsWith('prog.')) push(timeOfTick(Number(e.tick)), 'operator_program', 'operator', 'programa ' + (e.order?.op ?? '') + ' ' + (e.order?.program?.id ?? e.order?.target ?? ''), k, e);
    else if (k.startsWith('join.')) push(timeOfTick(Number(e.tick)), 'member_joined', 'harness', (e.id ?? 'un actor') + ' se unió', k, e);
    else if (k.startsWith('retire.')) push(timeOfTick(Number(e.tick)), 'member_left', 'harness', 'un miembro se retiró: ' + (e.reason ?? ''), k, e);
  }
  return out;
}

/** `cut`: the positions of a snapshot - the climb as it was then, of what the snapshot holds: a branch it does not hold is
    not added, for its record would run past the cut (C4). */
export function climb(store: ResearchStore, ids: readonly string[], profile: Profile, cut?: Record<string, number>): ClimbView {
  const positions = cut ?? {};
  const sources = store.sources();
  /* A run with its delegated branches (§4): each branch, run in a folder of its own beside its requester, hangs from it. */
  const requesterOf = new Map<string, string>();
  const runIdOf = new Map<string, string>([...sources.entries()].map(([id, s]) => [path.resolve(s.file), id]));
  const want = [...ids];
  for (let i = 0; i < want.length; i++) {
    const s = sources.get(want[i]);
    if (!s || !s.journal.experiment) continue;
    const dir = s.file.replace(/\.json$/, '.branches');
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const id = runIdOf.get(path.resolve(dir, f));
      if (!id || !sources.get(id)!.journal.experiment) continue;
      if (cut && !want.includes(id)) continue;
      requesterOf.set(id, want[i]);
      if (!want.includes(id)) want.push(id);
    }
  }
  /* The record a branch started from (its `.cut`) is a copy of its requester's past, not a climber. */
  const runs = want.filter((id) => sources.get(id)?.journal.experiment && !/\.cut\.json$/.test(sources.get(id)!.file));
  const notes: string[] = [];
  if (cut) notes.push('Un corte muestra lo que el corte contiene: sus ramas sólo si se seleccionaron al fijarlo.');
  if (runs.length < ids.length) notes.push('Sólo los runs escalan: proyectos y agentes no son investigadores del mundo (§4).');
  if (!runs.length) return { format: 'climb@1', profile, origin: null, clock: 0, at: null, groups: [], cursor: hash([profile, []]), historical: false, notes };
  const snap = store.capture(runs, profile, positions, false);
  const startOf = (id: string): number => Date.parse(sources.get(id)!.journal.started ?? '');
  const starts = runs.map(startOf).filter(Number.isFinite);
  const origin = starts.length ? Math.min(...starts) : NaN;
  const secs = (at: string | null): number | null => (at && Number.isFinite(origin) && Number.isFinite(Date.parse(at)) ? (Date.parse(at) - origin) / 1000 : null);
  const byEntity = new Map<string, Entry[]>();
  for (const e of snap.events) { const xs = byEntity.get(e.entity) ?? []; xs.push(e); byEntity.set(e.entity, xs); }
  const branchIdOf = (requester: string, delegation: unknown): string | null =>
    runs.find((id) => requesterOf.get(id) === requester && path.basename(sources.get(id)!.file, '.json') === String(delegation ?? '').replace(':', '-')) ?? null;
  /* In a living world, who each climber is there. */
  const actorOf = new Map<string, string>();
  for (const id of runs) { const a = sources.get(id)!.journal.world?.actor; if (typeof a === 'string') actorOf.set(a, id); }

  /* A climber's group is its root's: a branch climbs its requester's mountain. */
  const rootOf = (id: string): string => (requesterOf.has(id) ? rootOf(requesterOf.get(id)!) : id);
  const keyOf = (id: string): Json => {
    const s = sources.get(id)!, j = s.journal, folder = path.dirname(s.file), base = path.basename(s.file, '.json');
    const batch = read(path.join(folder, 'batch.json'));
    const condition = (batch?.definition?.runs ?? []).find((r: Json) => r.id === base)?.condition ?? null;
    const wf = worldFileOf(s.file, j), entries = wf ? readWorld(wf) : [];
    const living = entries.length ? livingIdentity(entries) : null;
    return { condition, world: String(j.experiment), code_version: j.commit ?? null, generator: generatorOf(j, folder, base).id,
      ...(living ? { world_condition: living.condition, adapted: living.adapted, interventions: interventionLabels(entries) } : {}) };
  };

  type G = { key: Json; progress: LabProgress; climbers: Climber[]; ropes: Rope[]; events: ClimbEvent[]; worlds: Set<string> };
  const groups = new Map<string, G>();
  const groupOf = new Map<string, G>();
  let clock = 0;
  /* What was sent, published and delivered, for ropes once every record is read. */
  const sent = new Map<string, { from: string; kind: 'message' | 'material' }>();
  const delivered: { id: string; to: string; t: number; ref: string }[] = [];
  const published = new Map<string, string>();
  const reads: { ids: string[]; to: string; t: number; ref: string }[] = [];
  const windows = new Map<number, number>();
  for (const id of runs) {
    const s = sources.get(id)!, j = s.journal, progress = progressOf(j.experiment);
    const ent = snap.entities.find((e) => e.id === id)!;
    const evs = byEntity.get(id) ?? [];
    const requester = requesterOf.get(id);
    const key = keyOf(rootOf(id)), k = JSON.stringify(key);
    const g = groups.get(k) ?? { key, progress, climbers: [], ropes: [], events: [], worlds: new Set<string>() };
    groups.set(k, g); groupOf.set(id, g);
    const wf = worldFileOf(s.file, j);
    if (wf) g.worlds.add(wf);
    /* A branch joins at the moment it was asked for (§4), where its requester's record says so. */
    let joined = Number.isFinite(startOf(id)) && Number.isFinite(origin) ? (startOf(id) - origin) / 1000 : 0;
    if (requester) {
      const asked = (byEntity.get(requester) ?? []).find((e) => e.type === 'delegation_requested' && branchIdOf(requester, e.data.id) === id);
      const t = asked ? secs(asked.at) : null;
      if (t !== null) joined = t;
    }
    if (j.resumed && (positions[id] ?? Infinity) > 0) g.events.push({ kind: 'resumed', origin: 'harness', t: joined, label: 'continúa un run anterior', ref: evs[0]?.id ?? '', climber: id, profile });
    const samples: ClimbSample[] = [], states: Climber['states'] = [], pos: [number, number][] = [];
    let untimed = 0;
    for (const e of evs) {
      const t = secs(e.at), d = e.data;
      if (t === null) { untimed += verdictsOf(e.type, d).length ? 1 : 0; continue; }
      clock = Math.max(clock, t);
      pos.push([t, e.sequence + 1]);
      const st = stateOf(e.type, d);
      if (st) states.push({ t, state: st, ref: e.id });
      for (const v of verdictsOf(e.type, d)) for (const m of progress.metrics) {
        if (!feeds(m, v.kind)) continue;
        const value = progress.sample(m.id, v.event);
        if (value === null || !Number.isFinite(value)) continue;
        samples.push({ metric: m.id, t, tokens: null, round: e.round, value, kind: v.kind, ref: e.id, ...(v.accepted && v.kind !== 'validation' && v.kind !== 'blind' ? { accepted: true } : {}) });
      }
      const ev = eventOf(e.type, d);
      if (ev) g.events.push({ ...ev, t, ref: e.id, climber: id, profile });
      /* Ropes (§5), each at the moment of its delivery. */
      if ((e.type === 'message_sent' || e.type === 'material_shared') && typeof d.id === 'string') sent.set(d.id, { from: id, kind: e.type === 'message_sent' ? 'message' : 'material' });
      if (e.type === 'messages_delivered') for (const m of d.messages ?? []) if (typeof m === 'string') delivered.push({ id: m, to: id, t, ref: e.id });
      if (e.type === 'peer_publish' && typeof d.id === 'string') published.set(d.id, id);
      if (e.type === 'peer_read' && Array.isArray(d.shown)) reads.push({ ids: d.shown.map(String), to: id, t, ref: e.id });
      if (e.type === 'world_window' && Number.isFinite(d.window) && !windows.has(d.window)) windows.set(d.window, t);
      if (e.type === 'world_help') g.ropes.push({ kind: 'announcement', from: 'operator', to: id, t, ref: e.id, label: String(d.text ?? '').slice(0, 120) });
      if (e.type === 'delegation_requested' && typeof d.id === 'string') g.ropes.push({ kind: 'branch_opened', from: id, to: branchIdOf(id, d.id) ?? (d.mode === 'evolve' ? 'evolve:' : 'branch:') + d.id, t, ref: e.id, label: String(d.question ?? '').slice(0, 120) });
      if (e.type === 'operator_message') for (const m of (d.messages ?? []) as Json[]) {
        if (m.research_result) g.ropes.push({ kind: 'branch_result', from: branchIdOf(id, m.research_result) ?? 'branch:' + m.research_result, to: id, t, ref: e.id, label: String(m.text ?? '').slice(0, 120) });
        else if (m.by === 'agent:research-policy') g.ropes.push({ kind: 'advice', from: 'research-policy', to: id, t, ref: e.id, label: String(m.text ?? '').slice(0, 120) });
        else if (m.directive || String(m.by ?? '').startsWith('agent:')) g.ropes.push({ kind: 'directive', from: 'senior', to: id, t, ref: e.id, label: String(m.text ?? '').slice(0, 120) });
        else g.events.push({ kind: 'operator_message', origin: 'operator', t, label: 'mensaje del operador: ' + String(m.text ?? '').slice(0, 80), ref: e.id, climber: id, profile });
      }
    }
    /* What it adopted of its evolutionary branches' candidates: from the step where it made that version its own. */
    const adopted = new Set(adoptedOf(s.file, evs.map((e) => ({ type: e.type, ...e.data }))));
    for (const e of evs) if (e.type === 'investigation' && adopted.size) for (const r of (e.data.results ?? []) as Json[]) if (r && adopted.has(r.version) && secs(e.at) !== null) {
      g.ropes.push({ kind: 'adoption', from: 'evolve', to: id, t: secs(e.at)!, ref: e.id, label: 'adopta ' + r.version });
      adopted.delete(r.version);
    }
    /* Its spending, as it is now - a cut of the past does not know what it had spent then (C9). */
    const status = read(s.file.replace(/\.json$/, '.status.json'));
    const used = snap.historical ? null : status?.cost?.llm_tokens_live ?? [...(j.events ?? [])].reverse().find((e: Json) => e.type === 'end')?.console_usage?.llm_tokens_live ?? null;
    g.climbers.push({ id, label: ent.label, kind: requester ? 'branch' : 'run', ...(requester ? { parent: requester } : {}), joined_at: joined, samples, states,
      budget: { tokens_used: typeof used === 'number' ? used : null, tokens_limit: typeof j.limits?.max_tokens === 'number' ? j.limits.max_tokens : null },
      plateaus: [], untimed, positions: pos });
  }
  /* A member's word or material reached another where the receiver's record says so; a board entry, where it was read. */
  for (const d of delivered) {
    const from = sent.get(d.id), g = groupOf.get(d.to)!;
    if (from) g.ropes.push({ kind: from.kind, from: from.from, to: d.to, t: d.t, ref: d.ref, label: d.id });
  }
  const seen = new Set<string>();
  for (const r of reads) for (const id of r.ids) {
    const from = published.get(id);
    if (!from || from === r.to || seen.has(id + '>' + r.to)) continue;
    seen.add(id + '>' + r.to);
    groupOf.get(r.to)!.ropes.push({ kind: 'board', from, to: r.to, t: r.t, ref: r.ref, label: id });
  }
  /* The living world's own record: the operator's profile only, and in a cut only up to where the cut reaches. */
  for (const g of groups.values()) {
    if (profile === 'operator') for (const f of g.worlds) g.events.push(...worldEvents(f, windows).filter((e) => !snap.historical || e.t <= clock));
    g.ropes.sort((a, b) => a.t - b.t); g.events.sort((a, b) => a.t - b.t);
  }
  if (profile === 'researcher') notes.push('Perfil de investigadores: sólo lo que recibieron. Lo que el protocolo guardó para el operador (el detalle del check de un artefacto, lo ocurrido en el mundo sin percibirse) no aparece.');
  const view: ClimbView = { format: 'climb@1', profile, origin: Number.isFinite(origin) ? new Date(origin).toISOString() : null, clock, at: null,
    groups: [...groups.values()].map(({ key, progress, climbers, ropes, events }) => ({
      key, climbers, ropes, events,
      metrics: progress.metrics.map((m) => {
        const values = climbers.flatMap((c) => c.samples.filter((s) => s.metric === m.id).map((s) => s.value));
        return { ...m, samples: values.length, axis: values.length ? axisOf(m, values) : null, crest: [], summit: null };
      })
    })),
    cursor: hash([profile, snap.hashes]).slice(0, 24), historical: snap.historical, notes };
  /* Crest, summits and plateaus by the very function a replay uses. */
  return climbAt(view, Infinity);
}
