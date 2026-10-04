import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export type Json = Record<string, any>;
export type Profile = 'researcher' | 'operator';
export const hash = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const read = (file: string): Json | null => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
export function write(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + randomUUID() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}
export function assertId(id: string): void { if (!/^[\w-]{1,100}$/.test(id)) throw new Error('Invalid record id'); }
const pick = (v: Json, keys: string[]): Json => Object.fromEntries(keys.filter(k => v[k] !== undefined).map(k => [k, v[k]]));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
/** Private transport credentials are not evidence, even in the operator's export. */
export function redact(v: any): any {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !/^(api[-_]?key|authorization|password|access_token|secret|env)$/i.test(k)).map(([k, x]) => [k, redact(x)]));
  return v;
}
const places = (xs: any) => Array.isArray(xs) ? xs.map(x => pick(x, ['place', 'holds', 'wins', 'total', 'exact', 'points', 'agreed', 'rerun'])) : [];
/** The observer receives only fields the researcher received. Unknown event types fail closed. */
export function researcherEvent(e: Json): Json | null {
  const base = pick(e, ['type', 'round', 't', 'at', 'question']);
  switch (e.type) {
    case 'investigation': return { ...base, ...pick(e, ['requests', 'results', 'notes', 'warnings']) };
    case 'investigation_refused': case 'proposal_refused': return { ...base, ...pick(e, ['requests', 'reason', 'errors']) };
    case 'proposal': case 'reflection': return { ...base, ...pick(e, ['rationale', 'beliefs', 'notes', 'law', 'formula', 'fingerprint', 'lessons', 'next_experiment']) };
    case 'methods': case 'consolidated': return { ...base, ...pick(e, ['methods', 'notes']) };
    case 'operator_message': return { ...base, messages: (e.messages ?? []).map((m: Json) => pick(m, ['id', 'text', 'by', 'at'])) };
    case 'exploration_game': return { ...base, ...pick(e, ['game', 'winner', 'plies']) };
    case 'exploration_episode': case 'exploration_launch': return { ...base, ...pick(e, ['episode', 'launch', 'place', 'setup']) };
    case 'played_by_the_learner': return { ...base, ...pick(e, ['game', 'from', 'how', 'result', 'turns']) };
    case 'check': return { ...base, laboratories: places(e.laboratories), ...(e.accepted ? { accepted: true } : {}),
      ...(e.validation ? { validation: { family: places(e.validation.family), refused: e.validation.refused,
        became_laboratories: e.validation.became_laboratories, blind: (e.validation.blind_confirmation?.sets ?? []).map((s: Json) => ({ ok: Boolean(s.ok) })) } } : {}) };
    case 'end': return { ...base, ...pick(e, ['stoppedBy']) };
    default: return null;
  }
}
export interface Entry {
  id: string; entity: string; sequence: number; type: string; at: string | null; round: number | null; data: Json;
}
export interface Entity {
  id: string; label: string; kind: 'run' | 'project' | 'agent'; model: string | null; researcher: string | null;
  parent: string | null; state: string; round: number | null; heartbeat: string | null; stale: boolean;
  revision: string; started: string | null; cost: Json | null; task: string | null; path: string;
  capabilities: { message: boolean; stop: boolean; resume: boolean; branch: boolean };
}
export interface Snapshot {
  format: 'research_snapshot@1'; id: string; created: string; profile: Profile; entities: Entity[]; events: Entry[];
  positions: Record<string, number>; hashes: Record<string, string>; historical: boolean;
  relations: { kind: string; from: string; to: string }[];
  incomplete: string[];
}
type Source = { file: string; journal: Json; stale: boolean };

export class ResearchStore {
  readonly root: string;
  readonly dir: string;
  private cached = new Map<string, Source>();
  private stamps = new Map<string, string>();
  constructor(root: string) { this.root = root; this.dir = path.join(root, 'runs', '.console'); }
  /** Directory traversal is a catalogue operation; user input is never a filesystem path. */
  sources(): Map<string, Source> {
    const out = new Map<string, Source>();
    const walk = (dir: string): void => {
      if (!fs.existsSync(dir)) return;
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        if (d.isSymbolicLink() || d.name.startsWith('.')) continue;
        const f = path.join(dir, d.name);
        if (d.isDirectory()) { walk(f); continue; }
        if (!d.name.endsWith('.json') || /\.(finding(?:\.researcher)?|status|method)\.json$/.test(d.name)) continue;
        const id = path.relative(path.join(this.root, 'runs'), f).replaceAll('\\', '/').replace(/\.json$/, '');
        const st = fs.statSync(f), stamp = st.mtimeMs + ':' + st.size;
        if (this.stamps.get(id) === stamp && this.cached.has(id)) { out.set(id, this.cached.get(id)!); continue; }
        const j = read(f);
        if (j && (j.experiment || j.format === 'project@1' || j.format === 'agent@1')) {
          const s = { file: f, journal: j, stale: false }; this.cached.set(id, s); this.stamps.set(id, stamp); out.set(id, s);
        } else if (!j && this.cached.has(id)) out.set(id, { ...this.cached.get(id)!, stale: true });
      }
    };
    walk(path.join(this.root, 'runs'));
    return out;
  }
  source(id: string): Source { const s = this.sources().get(id); if (!s) throw new Error('No such research entity'); return s; }
  projectEvents(j: Json): Json[] {
    return [...(j.events ?? []), ...(j.iterations ?? []).flatMap((it: Json) => ['hypotheses', 'plan', 'approval', 'synthesis', 'criterion'].filter(k => it[k] !== undefined).map(k => ({ type: 'project_' + k, round: it.n, [k]: it[k] })))];
  }
  rawEvents(j: Json): Json[] {
    if (j.format === 'project@1') return this.projectEvents(j);
    // Agent decisions are already in events on current journals; support older decisions arrays too.
    return Array.isArray(j.events) ? j.events : (j.decisions ?? []).map((e: Json) => ({ type: 'agent_decision', ...e }));
  }
  catalogue(): Entity[] {
    const sources = this.sources();
    const parentOf = (s: Source): string | null => {
      const from = s.journal.resumed?.from ?? s.journal.run ?? s.journal.junior ?? s.journal.journal;
      if (typeof from !== 'string') return null;
      const candidates = [...sources.entries()].filter(([, x]) => x.file === path.resolve(path.dirname(s.file), from) || x.file === path.resolve(from));
      if (candidates.length === 1) return candidates[0][0];
      const byName = [...sources.entries()].filter(([, x]) => path.basename(x.file) === path.basename(from) && x.journal.started === s.journal.resumed?.from_started);
      return byName.length === 1 ? byName[0][0] : null;
    };
    return [...sources.entries()].map(([id, s]) => {
      const j = s.journal, events = this.rawEvents(j), run = !!j.experiment;
      const status = run ? read(s.file.replace(/\.json$/, '.status.json')) : null;
      const end = [...events].reverse().find(e => e.type === 'end');
      const heartbeat = status?.heartbeat ?? null;
      const alive = heartbeat && Date.now() - Date.parse(heartbeat) < 15000;
      const st = run ? { state: end || status?.state === 'ended' ? 'ended' : alive ? (status?.state === 'stopping' ? 'stopping' : 'running') : 'interrupted',
        round: status?.round, heartbeat, cost: status?.cost ?? end?.console_usage ?? null } : null;
      const state = st?.state ?? (j.ended ? 'ended' : 'unknown');
      const lastRound = [...events].reverse().find(e => typeof e.round === 'number')?.round ?? null;
      const kind = run ? 'run' : j.format === 'project@1' ? 'project' : 'agent';
      const live = state === 'running';
      return { id, label: j.id ?? path.basename(s.file, '.json'), kind, model: j.config?.llm_model ?? j.model ?? null,
        researcher: j.researcher ?? null, parent: parentOf(s), state, round: st?.round ?? lastRound, heartbeat: st?.heartbeat ?? null,
        stale: s.stale, revision: hash(j), started: j.started ?? null, cost: st?.cost ?? j.spent ?? j.usage ?? null,
        task: j.goal?.question ?? j.config?.task ?? null, path: id,
        capabilities: { message: live && j.researcher === 'assisted', stop: live, resume: run && ['ended', 'interrupted'].includes(state),
          branch: run && state === 'ended' && events.at(-1)?.stoppedBy === 'budget' } } as Entity;
    }).sort((a, b) => (b.started ?? '').localeCompare(a.started ?? ''));
  }
  capture(ids: string[], profile: Profile, positions: Record<string, number> = {}, save = true): Snapshot {
    if (!['researcher', 'operator'].includes(profile)) throw new Error('Unknown reading profile');
    if (!ids.length || ids.length > 100 || new Set(ids).size !== ids.length) throw new Error('Select 1–100 distinct entities');
    const sources = this.sources(), catalogue = this.catalogue();
    const entities: Entity[] = [], events: Entry[] = [], pos: Record<string, number> = {}, hashes: Record<string, string> = {};
    let historical = false;
    for (const id of ids) {
      const s = sources.get(id), ent = catalogue.find(x => x.id === id);
      if (!s || !ent) throw new Error('No such research entity: ' + id);
      if (s.stale) throw new Error('The journal is being written; retry after a valid read');
      const all = this.rawEvents(s.journal), limit = positions[id] ?? all.length;
      if (!Number.isInteger(limit) || limit < 0 || limit > all.length) throw new Error('Invalid snapshot position');
      if (limit < all.length) historical = true;
      const prefix = all.slice(0, limit);
      pos[id] = limit; hashes[id] = hash(prefix);
      // A snapshot never contains the live/final notebook, current cost or current state as historical evidence.
      entities.push({ ...ent, state: prefix.some(e => e.type === 'end') ? 'ended' : 'at-cut', round: [...prefix].reverse().find(e => Number.isInteger(e.round))?.round ?? null,
        revision: hash(prefix), cost: null, heartbeat: null, task: null, capabilities: { message: false, stop: false, resume: false, branch: false } });
      const generation = hash([id, s.journal.started ?? '', s.journal.experiment ?? s.journal.format]).slice(0, 16);
      prefix.forEach((e, i) => {
        const data = profile === 'operator' ? redact(e) : ent.kind === 'run' ? researcherEvent(e) : null;
        if (!data) return;
        const at = typeof e.at === 'string' ? e.at : typeof e.t === 'number' && Number.isFinite(Date.parse(ent.started ?? '')) ? new Date(Date.parse(ent.started!) + e.t * 1000).toISOString() : null;
        events.push({ id: generation + ':' + i, entity: id, sequence: i, type: String(e.type ?? 'unknown'), at, round: typeof e.round === 'number' ? e.round : null, data: clone(data) });
      });
      // Private truth only at a current cut, never added retrospectively to a historical one.
      if (profile === 'operator' && limit === all.length && s.journal.hidden_from_the_learner) events.push({ id: generation + ':private', entity: id,
        sequence: all.length, at: null, round: null, type: 'operator_context', data: redact(s.journal.hidden_from_the_learner) });
      if (profile === 'operator' && limit === all.length) {
        const audit = read(s.file.replace(/\.json$/, '.method.json'));
        if (audit) events.push({ id: generation + ':audit:' + hash(audit).slice(0, 10), entity: id, sequence: all.length,
          at: audit.audited ?? null, round: null, type: 'method_audit', data: redact(audit) });
      }
    }
    const relations: Snapshot['relations'] = entities.filter(e => e.parent).map(e => ({ kind: e.kind === 'agent' ? 'supervises' : 'continued_from', from: e.id, to: e.parent! }));
    const sent = new Map<string, string>();
    for (const e of events) {
      if (e.type === 'operator_command' && e.data.id) sent.set(e.data.id, e.id);
      if (e.type === 'agent_decision' && e.data.order) sent.set(e.data.order, e.id);
    }
    for (const e of events) if (e.type === 'operator_message') for (const m of e.data.messages ?? []) {
      const from = sent.get(m.id); if (from) relations.push({ kind: 'delivered', from, to: e.id });
    }
    const incomplete: string[] = [];
    if (profile === 'researcher' && entities.some(e => e.kind !== 'run')) incomplete.push('Los diarios privados de planificación y supervisión no son parte del registro del investigador; sólo sus mensajes entregados.');
    for (const e of events) if (e.type === 'operator_message') for (const m of e.data.messages ?? []) {
      if (!sent.has(m.id)) incomplete.push('Entrega ' + e.id + ': origen no incluido en este corte/perfil (' + m.id + ').');
    }
    const snap: Snapshot = { format: 'research_snapshot@1', id: randomUUID(), created: new Date().toISOString(), profile, entities, events, positions: pos, hashes, historical, relations, incomplete };
    if (save) write(path.join(this.dir, 'snapshots', snap.id + '.json'), snap);
    return snap;
  }
  snapshot(id: string): Snapshot { assertId(id); const s = read(path.join(this.dir, 'snapshots', id + '.json')); if (!s || s.format !== 'research_snapshot@1') throw new Error('Snapshot not found'); return s as Snapshot; }
  evidence(snapshot: Snapshot, words = '', type = '', offset = 0, limit = 100): { total: number; events: Entry[] } {
    const terms = words.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    const found = snapshot.events.filter(e => (!type || e.type === type) && terms.every(t => JSON.stringify(e.data).toLocaleLowerCase().includes(t)));
    return { total: found.length, events: found.slice(Math.max(0, offset), Math.max(0, offset) + Math.min(200, Math.max(1, limit))) };
  }
  /** No LLM, no money, no fabricated interpretation. Every match links back to the frozen evidence. */
  query(snapshot: Snapshot, question: string): Json {
    if (/^(estado|resumen de estado|qué están haciendo|que estan haciendo)/i.test(question.trim())) return {
      kind: 'status', snapshot: snapshot.id, at: snapshot.created, note: 'Estado reconstruido en el corte. No describe razonamiento interno.',
      total: snapshot.entities.length, events: snapshot.entities.flatMap(entity => snapshot.events.filter(e => e.entity === entity.id && e.sequence < snapshot.positions[entity.id]).slice(-1))
    };
    const found = this.evidence(snapshot, question, '', 0, 30);
    return { kind: 'literal', snapshot: snapshot.id, at: snapshot.created, question, note: 'Búsqueda literal: coincidencias en el registro, sin interpretación.', ...found };
  }
  costs(ids: string[]): Json {
    const entities = this.catalogue().filter(e => ids.includes(e.id));
    const known = entities.filter(e => e.kind === 'run' && Number.isFinite(e.cost?.llm_tokens_live) && !e.cost?.usage_unknown);
    return { tokens_live_known: known.reduce((n, e) => n + Number(e.cost!.llm_tokens_live), 0),
      tokens_inherited: known.reduce((n, e) => n + Number(e.cost!.llm_tokens_replayed ?? 0), 0),
      unknown_entities: entities.filter(e => !known.includes(e)).map(e => e.id),
      note: 'Los totales conocidos no incluyen gasto desconocido ni duplican el prefijo reproducido. Jev, coordinación antigua y precios no se infieren.' };
  }
  export(snapshot: Snapshot): string {
    const safe = JSON.stringify(snapshot, null, 2).replaceAll('<', '\u003c');
    return '<!doctype html><html lang="es"><meta charset="utf-8"><title>Registro de investigación</title><style>body{max-width:1100px;margin:2rem auto;font:16px system-ui}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:1rem;background:#f4f4f1}h1{font-size:24px}</style><h1>Registro de investigación · ' + snapshot.profile + '</h1><p>Corte: ' + snapshot.created + ' · Exportación sin controles vivos</p><pre>' + safe.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') + '</pre></html>';
  }
}
