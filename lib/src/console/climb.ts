import fs from 'node:fs';
import path from 'node:path';
import { LABS } from '../worlds/labs.ts';
import { generatorOf } from '../runtime/generators.ts';
import { interventionLabels, livingIdentity, readWorld, worldFileOf } from '../living/record.ts';
import { DEFAULT_PROGRESS, axisOf, better, feeds, type LabProgress, type ProgressMetric } from '../learn/progress.ts';
import { hash, read, type Entry, type Json, type Profile, type ResearchStore } from './store.ts';

/* ============================================================================
 * The climb (SPEC-VISTA-ESCALADA §10): several researchers on the same mountain, read only from their records.
 *
 * Each researcher is a climber, the world's metric its mountain, and improving is going up. A climber's samples are only
 * the protocol's verdicts (§3.3), read from its events as the profile reading them received them - what a profile was not
 * given cannot be read from them. Climbers are grouped by what makes them comparable (§3.4): two worlds, two conditions,
 * are never on the same axis. Ropes and the world's events (§5, §6) are not read yet: they are said to be unread, never
 * drawn as absent.
 * ========================================================================== */

export type SampleKind = 'check' | 'validation' | 'blind' | 'artifact';
export interface ClimbSample { metric: string; t: number; tokens: number | null; round: number | null; value: number; kind: SampleKind; ref: string; accepted?: boolean }
export interface Climber {
  id: string; label: string; kind: 'run' | 'branch'; parent?: string;
  /** Seconds from the start of the space. */
  joined_at: number;
  samples: ClimbSample[];
  states: { t: number; state: string; ref: string }[];
  budget: { tokens_used: number | null; tokens_limit: number | null };
  /** Stretches where it did not improve (§2): from the sample that set its best to the last that did not beat it. */
  plateaus: { metric: string; from: number; to: number; samples: number }[];
  /** Verdicts it was given at no known time: never placed on the axis (C9). */
  untimed: number;
}
export interface ClimbMetric extends ProgressMetric {
  samples: number;
  /** Drawn from `bottom` at the foot to `top` at the summit: improving is going up, whatever the metric's direction (§3.2). */
  axis: { bottom: number; top: number; scale: 'linear' | 'log' } | null;
  /** The best reached by the group up to each moment, where it changed. */
  crest: { t: number; value: number; climber: string; ref: string }[];
  summit: { value: number; climber: string; t: number; ref: string } | null;
}
export interface ClimbGroup {
  key: Json;
  metrics: ClimbMetric[];
  climbers: Climber[];
  ropes: never[];
  events: never[];
  /** What of the record this view does not read yet (§5, §6): unread, not absent. */
  unread: string[];
}
export interface ClimbView { format: 'climb@1'; profile: Profile; origin: string | null; clock: number; groups: ClimbGroup[]; cursor: string; historical: boolean; notes: string[] }

/** How many verdicts in a row without beating its best make a plateau. */
export const PLATEAU = 3;

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
  investigation: 'investiga', exploration_episode: 'observa', proposal: 'propone', reflection: 'propone', check: 'comprueba', artifact_check: 'comprueba',
  round_closed: 'cierra ronda', delegation_requested: 'delega', awaiting_opening: 'espera', world_wait: 'espera', end: 'parado'
};

/** Its plateaus on one metric: stretches of at least PLATEAU verdicts that did not beat its best. */
export function plateausOf(metric: ProgressMetric, samples: readonly ClimbSample[]): Climber['plateaus'] {
  const out: Climber['plateaus'] = [];
  let best: ClimbSample | null = null, flat: ClimbSample[] = [];
  const close = () => { if (best && flat.length >= PLATEAU) out.push({ metric: metric.id, from: best.t, to: flat[flat.length - 1].t, samples: flat.length }); flat = []; };
  for (const s of samples) {
    if (!best || better(metric, s.value, best.value)) { close(); best = s; } else flat.push(s);
  }
  close();
  return out;
}

/** The group's crest on one metric: the best of its climbers up to each moment, where it changed. */
export function crestOf(metric: ProgressMetric, climbers: readonly Climber[]): ClimbMetric['crest'] {
  const all = climbers.flatMap((c) => c.samples.filter((s) => s.metric === metric.id).map((s) => ({ s, climber: c.id }))).sort((a, b) => a.s.t - b.s.t);
  const out: ClimbMetric['crest'] = [];
  for (const { s, climber } of all) if (!out.length || better(metric, s.value, out[out.length - 1].value)) out.push({ t: s.t, value: s.value, climber, ref: s.ref });
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
  for (let i = 0; i < want.length && !cut; i++) {
    const s = sources.get(want[i]);
    if (!s || !s.journal.experiment) continue;
    const dir = s.file.replace(/\.json$/, '.branches');
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const id = runIdOf.get(path.resolve(dir, f));
      if (!id || !sources.get(id)!.journal.experiment) continue;
      requesterOf.set(id, want[i]);
      if (!want.includes(id)) want.push(id);
    }
  }
  /* The record a branch started from (its `.cut`) is a copy of its requester's past, not a climber. */
  const runs = want.filter((id) => sources.get(id)?.journal.experiment && !/\.cut\.json$/.test(sources.get(id)!.file));
  const notes: string[] = [];
  if (cut) notes.push('Un corte muestra lo que el corte contiene: sus ramas sólo si se seleccionaron al fijarlo.');
  if (runs.length < ids.length) notes.push('Sólo los runs escalan: proyectos y agentes no son investigadores del mundo (§4).');
  if (!runs.length) return { format: 'climb@1', profile, origin: null, clock: 0, groups: [], cursor: hash([profile, []]), historical: false, notes };
  const snap = store.capture(runs, profile, positions, false);
  const startOf = (id: string): number => Date.parse(sources.get(id)!.journal.started ?? '');
  const starts = runs.map(startOf).filter(Number.isFinite);
  const origin = starts.length ? Math.min(...starts) : NaN;
  const secs = (at: string | null): number | null => (at && Number.isFinite(origin) && Number.isFinite(Date.parse(at)) ? (Date.parse(at) - origin) / 1000 : null);
  const byEntity = new Map<string, Entry[]>();
  for (const e of snap.events) { const xs = byEntity.get(e.entity) ?? []; xs.push(e); byEntity.set(e.entity, xs); }

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

  const groups = new Map<string, { key: Json; progress: LabProgress; climbers: Climber[] }>();
  let clock = 0;
  for (const id of runs) {
    const s = sources.get(id)!, j = s.journal, progress = progressOf(j.experiment);
    const ent = snap.entities.find((e) => e.id === id)!;
    const evs = byEntity.get(id) ?? [];
    const requester = requesterOf.get(id);
    /* A branch joins at the moment it was asked for (§4), where its requester's record says so. */
    let joined = Number.isFinite(startOf(id)) && Number.isFinite(origin) ? (startOf(id) - origin) / 1000 : 0;
    if (requester) {
      const asked = (byEntity.get(requester) ?? []).find((e) => e.type === 'delegation_requested' && String(e.data.id ?? '').replace(':', '-') === path.basename(s.file, '.json'));
      const t = asked ? secs(asked.at) : null;
      if (t !== null) joined = t;
    }
    const samples: ClimbSample[] = [], states: Climber['states'] = [];
    let untimed = 0;
    for (const e of evs) {
      const t = secs(e.at);
      if (STATE[e.type] && t !== null) states.push({ t, state: STATE[e.type], ref: e.id });
      if (t !== null) clock = Math.max(clock, t);
      for (const v of verdictsOf(e.type, e.data)) for (const m of progress.metrics) {
        if (!feeds(m, v.kind)) continue;
        const value = progress.sample(m.id, v.event);
        if (value === null || !Number.isFinite(value)) continue;
        if (t === null) { untimed++; continue; }
        samples.push({ metric: m.id, t, tokens: null, round: e.round, value, kind: v.kind, ref: e.id, ...(v.accepted && v.kind !== 'validation' && v.kind !== 'blind' ? { accepted: true } : {}) });
      }
    }
    /* Its spending, as it is now - a cut of the past does not know what it had spent then (C9). */
    const status = read(s.file.replace(/\.json$/, '.status.json'));
    const used = snap.historical ? null : status?.cost?.llm_tokens_live ?? [...(j.events ?? [])].reverse().find((e: Json) => e.type === 'end')?.console_usage?.llm_tokens_live ?? null;
    const climber: Climber = { id, label: ent.label, kind: requester ? 'branch' : 'run', ...(requester ? { parent: requester } : {}), joined_at: joined, samples, states,
      budget: { tokens_used: typeof used === 'number' ? used : null, tokens_limit: typeof j.limits?.max_tokens === 'number' ? j.limits.max_tokens : null },
      plateaus: progress.metrics.flatMap((m) => plateausOf(m, samples.filter((x) => x.metric === m.id))), untimed };
    const key = keyOf(rootOf(id)), k = JSON.stringify(key);
    const g = groups.get(k) ?? { key, progress, climbers: [] };
    g.climbers.push(climber);
    groups.set(k, g);
  }
  if (profile === 'researcher') notes.push('Perfil de investigadores: sólo las muestras de los veredictos que recibieron; lo que el protocolo guardó para el operador (p. ej. el detalle del check de un artefacto) no da muestras.');
  const out: ClimbGroup[] = [...groups.values()].map(({ key, progress, climbers }) => ({
    key,
    metrics: progress.metrics.map((m) => {
      const values = climbers.flatMap((c) => c.samples.filter((s) => s.metric === m.id).map((s) => s.value));
      const crest = crestOf(m, climbers), top = crest[crest.length - 1];
      return { ...m, samples: values.length, axis: values.length ? axisOf(m, values) : null, crest, summit: top ? { value: top.value, climber: top.climber, t: top.t, ref: top.ref } : null };
    }),
    climbers, ropes: [], events: [], unread: ['ropes', 'events']
  }));
  return { format: 'climb@1', profile, origin: Number.isFinite(origin) ? new Date(origin).toISOString() : null, clock, groups: out,
    cursor: hash([profile, snap.hashes]).slice(0, 24), historical: snap.historical, notes };
}
