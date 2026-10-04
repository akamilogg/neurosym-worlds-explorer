import fs from 'node:fs';
import path from 'node:path';
import type { FetchLike } from '../../core/net.ts';
import type { LineSelector, SelectionRecord } from './sources.ts';

/* ============================================================================
 * The BOARD of a team (SPEC-INVESTIGACION-PARALELA §5.2): what members of a team publish for one
 * another, and nothing else. A member's notebook, beliefs and models never leave its run; only
 * what it chooses to publish does (E4).
 *
 * The contracts that make a team's results readable afterwards (§5.2, §5.4):
 *
 *   VERSIONS   The board is read by WINDOWS of `window` rounds. Version w holds every entry
 *              published in windows 1..w; it is SEALED once every member has finished round
 *              w x window (or ended), written once and never changed. A member reads version
 *              w in round w x window + 1, the round that opens it, and every read names the
 *              version it read. Reading waits for the version to be sealed.
 *   IDEMPOTENT A member's n-th publication is `<member>#<n>`. Publishing it again - a resumed
 *              run replaying its history - finds it there and adds nothing; the same key with
 *              other words is a conflict, logged, and the first stays.
 *   EVIDENCE   An entry carries the records of the laboratory behind it (an episode, a point,
 *              an act, an investigation step, as the laboratory answered them), so whoever
 *              reads it can tell what the colleague concludes from what the world returned.
 *   THE EXAM   The blind boards of a team are taken from one ledger: none is consulted twice
 *              in the team, and the team's blind confirmations are counted (`confirmations`).
 *
 * The board is a directory, written with synchronous calls: the members of a team run in one
 * process (orchestra/team.ts), so no two writes interleave. Reads by a member go through its
 * run's log (channel "peer", E7): a resumed run reads what it read, whatever was published since.
 *
 * What the operator keeps of an entry (the keys of the interventions behind its evidence, to
 * measure duplication and dead ends avoided) is kept apart, in operator/, and never served.
 * ========================================================================== */

export const ENTRY_KINDS = ['result', 'dead_end', 'method'] as const;
export type EntryKind = typeof ENTRY_KINDS[number];

/** A team, as its board knows it. */
export interface TeamSpec {
  readonly id: string;
  readonly members: readonly string[];
  /** Rounds per window of exchange. */
  readonly window: number;
  /** Whether the members read and publish (the condition "communicated") or not ("independent"). */
  readonly exchange: boolean;
  /** Blind confirmations the whole team may spend (null: no limit beyond each member's validations). */
  readonly confirmations: number | null;
}

/** What a member asks to publish, as it wrote it. */
export interface Publication {
  readonly kind: EntryKind;
  readonly claim: string;
  readonly intervention?: string;
  readonly observed?: string;
  readonly scope?: string;
  /** Its references to its own records (episodes, points, acts, investigation steps). */
  readonly evidence: readonly string[];
}

/** An entry as the board keeps it and serves it. */
export interface BoardEntry extends Omit<Publication, 'evidence'> {
  readonly id: string;
  readonly member: string;
  readonly n: number;
  readonly round: number;
  readonly window: number;
  /** Where it was observed, as the laboratory describes the places of its evidence (never the member's words). */
  readonly world: readonly Readonly<Record<string, unknown>>[];
  /** Each reference with the laboratory's record behind it. */
  readonly evidence: readonly { readonly ref: string; readonly record: unknown }[];
}

export interface BoardVersion {
  readonly format: 'board-version@1';
  readonly team: string;
  readonly version: number;
  readonly entries: readonly BoardEntry[];
}

interface Progress { members: Record<string, { round: number; ended: boolean }> }
interface Exam { next: number; blind: Record<string, number[]>; confirmations: Record<string, { member: string; round: number }> }

const readJson = <T>(file: string, fallback: T): T => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return fallback; } };
const writeJson = (file: string, value: unknown): void => { fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2)); fs.renameSync(file + '.tmp', file); };
const MEMBER = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

/** The first blind board of a team's ledger (the family's blind stretch: worlds/grid/family.ts). */
export const FIRST_BLIND = 1001;

export class TeamBoard {
  readonly dir: string;
  readonly spec: TeamSpec;

  /** Opens the board of the team in `dir` (its team.json), or creates it with `spec`. */
  constructor(dir: string, spec?: TeamSpec) {
    this.dir = dir;
    const file = path.join(dir, 'team.json');
    const known = readJson<TeamSpec | null>(file, null);
    if (spec && known && JSON.stringify(TeamBoard.core(known)) !== JSON.stringify(TeamBoard.core(spec)))
      throw new Error('the team in ' + dir + ' was declared otherwise (' + JSON.stringify(TeamBoard.core(known)) + ')');
    const s = known ?? spec;
    if (!s) throw new Error('no team in ' + dir + ' (team.json)');
    if (!s.members.length || s.members.some((m) => !MEMBER.test(m)) || new Set(s.members).size !== s.members.length) throw new Error('a team needs members with ids of their own (letters, digits, - and _)');
    if (!(Number.isInteger(s.window) && s.window >= 1)) throw new Error('a team\'s window is a number of rounds (1 or more)');
    this.spec = { id: s.id, members: [...s.members], window: s.window, exchange: s.exchange !== false, confirmations: s.confirmations ?? null };
    for (const d of ['entries', 'versions', 'operator']) fs.mkdirSync(path.join(dir, 'board', d), { recursive: true });
    if (!known) writeJson(file, this.spec);
  }

  private static core(s: TeamSpec): unknown { return { members: s.members, window: s.window, exchange: s.exchange !== false, confirmations: s.confirmations ?? null }; }

  private file(...parts: string[]): string { return path.join(this.dir, 'board', ...parts); }
  private member(m: string): void { if (!this.spec.members.includes(m)) throw new Error('no member ' + m + ' in team ' + this.spec.id); }

  /** The window a round belongs to. */
  windowOf(round: number): number { return Math.max(1, Math.ceil(round / this.spec.window)); }

  /** The version a member may read in this round: the one its round opens, or null (the board is closed this round). */
  readableAt(round: number): number | null {
    return round > 1 && (round - 1) % this.spec.window === 0 ? (round - 1) / this.spec.window : null;
  }

  /* --- Progress and sealing ------------------------------------------------------------- */

  private progress(): Progress { return readJson<Progress>(this.file('progress.json'), { members: {} }); }

  /** A member begins a round: the furthest it has reached is kept, and what can be sealed is sealed. */
  reach(member: string, round: number): void {
    this.member(member);
    const p = this.progress();
    const was = p.members[member] ?? { round: 0, ended: false };
    p.members[member] = { round: Math.max(was.round, round), ended: false };
    writeJson(this.file('progress.json'), p);
    this.seal();
  }

  /** A member ended (it reads and publishes nothing more): it no longer holds a window open. */
  end(member: string): void {
    this.member(member);
    const p = this.progress();
    p.members[member] = { round: p.members[member]?.round ?? 0, ended: true };
    writeJson(this.file('progress.json'), p);
    this.seal();
  }

  /** Every version every member has passed, sealed (once). */
  seal(): void {
    const p = this.progress();
    const k = this.spec.window;
    const live = this.spec.members.filter((m) => !p.members[m]?.ended);
    /* A member in round r has passed the versions up to (r - 1) / window; once every member ended, every version anyone
       reached is passed. */
    const last = live.length ? Math.min(...live.map((m) => Math.floor(((p.members[m]?.round ?? 0) - 1) / k)))
      : Math.max(1, ...this.spec.members.map((m) => Math.ceil((p.members[m]?.round ?? 0) / k)));
    for (let w = 1; w <= last; w++) {
      const file = this.file('versions', 'v' + w + '.json');
      if (fs.existsSync(file)) continue;
      const version: BoardVersion = { format: 'board-version@1', team: this.spec.id, version: w,
        entries: this.entries().filter((e) => e.window <= w) };
      try { fs.writeFileSync(file, JSON.stringify(version, null, 2), { flag: 'wx' }); } catch { /* sealed meanwhile: it stays as it was */ }
    }
  }

  /** A sealed version, or null. */
  sealed(w: number): BoardVersion | null { return readJson<BoardVersion | null>(this.file('versions', 'v' + w + '.json'), null); }

  /** Version w, once sealed: waits for it (every member must have passed it). */
  async version(w: number, options: { signal?: AbortSignal; pollMs?: number; timeoutMs?: number } = {}): Promise<BoardVersion> {
    const until = Date.now() + (options.timeoutMs ?? 6 * 3600_000);
    for (;;) {
      this.seal();
      const v = this.sealed(w);
      if (v) return v;
      if (options.signal?.aborted) throw new Error('stopped while waiting for version ' + w + ' of the board');
      if (Date.now() >= until) throw new Error('version ' + w + ' of the board was not sealed in time');
      await new Promise((r) => setTimeout(r, options.pollMs ?? 500));
    }
  }

  /* --- Entries ------------------------------------------------------------------------------ */

  /** Every entry published, in order of window, member, number. */
  entries(): BoardEntry[] {
    const dir = this.file('entries');
    const all = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJson<BoardEntry | null>(path.join(dir, f), null)).filter((e): e is BoardEntry => !!e);
    const order = (m: string) => this.spec.members.indexOf(m);
    return all.sort((a, b) => a.window - b.window || order(a.member) - order(b.member) || a.n - b.n);
  }

  /** A member's n-th publication. Published again (a resumed run), it is found and nothing is added; with other words, the
      first stays and the conflict is said. `operator`: what only the operator keeps of it. */
  publish(entry: BoardEntry, operator?: Record<string, unknown>): { id: string; window: number; replayed?: true; conflict?: string } {
    this.member(entry.member);
    if (entry.id !== entry.member + '#' + entry.n) throw new Error('an entry\'s id is <member>#<n>');
    const file = this.file('entries', entry.member + '.' + entry.n + '.json');
    const canonical = JSON.stringify(entry);
    if (fs.existsSync(file)) {
      const before = fs.readFileSync(file, 'utf8');
      return { id: entry.id, window: (JSON.parse(before) as BoardEntry).window, ...(before === canonical ? { replayed: true as const }
        : { conflict: 'an entry ' + entry.id + ' was published before with other words: the first stays' }) };
    }
    fs.writeFileSync(file, canonical, { flag: 'wx' });
    if (operator) fs.writeFileSync(this.file('operator', entry.member + '.' + entry.n + '.json'), JSON.stringify(operator));
    return { id: entry.id, window: entry.window };
  }

  /** Operator only: what was kept apart of each entry. */
  operatorOf(id: string): Record<string, unknown> | null {
    const [m, n] = id.split('#');
    return readJson<Record<string, unknown> | null>(this.file('operator', m + '.' + n + '.json'), null);
  }

  /* --- The exam: blind boards and confirmations, team-wide ---------------------------------- */

  private exam(): Exam { return readJson<Exam>(this.file('exam.json'), { next: FIRST_BLIND, blind: {}, confirmations: {} }); }

  /** `count` blind boards never consulted by anyone in the team, under a key the member gives (the same key, the same
      boards: a resumed run is given what it was given). */
  blindBoards(member: string, key: string, count: number): number[] {
    this.member(member);
    const e = this.exam();
    const k = member + '#' + key;
    if (!e.blind[k]) {
      e.blind[k] = Array.from({ length: count }, (_, i) => e.next + i);
      e.next += count;
      writeJson(this.file('exam.json'), e);
    }
    return e.blind[k];
  }

  /** Spends one of the team's blind confirmations under a key (the same key again: granted again, nothing spent), or says
      why it cannot (null: granted). */
  confirm(member: string, key: string, round: number): string | null {
    this.member(member);
    const e = this.exam();
    const k = member + '#' + key;
    if (e.confirmations[k]) return null;
    const spent = Object.keys(e.confirmations).length;
    if (this.spec.confirmations !== null && spent >= this.spec.confirmations) return 'the team has spent its ' + this.spec.confirmations + ' blind confirmation' + (this.spec.confirmations === 1 ? '' : 's');
    e.confirmations[k] = { member, round };
    writeJson(this.file('exam.json'), e);
    return null;
  }

  /** Operator only: the ledger of the exam. */
  examLedger(): Exam { return this.exam(); }
}

/* ============================================================================
 * A member's side of the board: its publications and its reads, as instruments of the assisted
 * researcher.
 *
 *   {"publish": {"kind": "result" | "dead_end" | "method", "claim": "...", "intervention": "...",
 *                "observed": "...", "scope": "...", "evidence": ["<ref>", ...]}}
 *   {"peers": "list"}                                       the entries of the version open now
 *   {"peers": "open", "items": ["<member>#<n>", ...]}       entries whole, with their evidence refs
 *   {"peers": "open", "item": "<member>#<n>", "evidence": "<ref>"}   the laboratory's record behind one
 *   {"peers": "find", "words": "...", "select"?: "what you need"}
 * ========================================================================== */

/** What a member of a team that exchanges is told (appended to its system prompt). */
export const PEERS_SECTION = (window: number): string => [
  'YOUR TEAM. Other researchers investigate environments of the same family as yours at the same time, each in its own places. You may share what you find with them, and read what they share, on a board.',
  'Publishing: {"publish": {"kind": "result" | "dead_end" | "method", "claim": "...", "intervention": "what you did", "observed": "what came out", "scope": "where it holds, as far as you know", "evidence": ["<episode>", "<episode>@<step>", "act<n>", "r<round>.<step>"]}} goes inside "investigate" like any request. Only what you publish leaves your investigation: nothing else of yours is shared. The environment attaches to it the records behind each piece of evidence, as it answered them, and where they were observed. A "dead_end" says what you tried, where, what came out and why you discard it: say under which conditions, a dead end in one place is not one everywhere. "result" and "dead_end" need evidence.',
  'Reading: the board opens every ' + window + ' round' + (window === 1 ? '' : 's') + ' (in rounds ' + [1, 2, 3].map((k) => k * window + 1).join(', ') + ', ...), with what everyone published until then. {"peers": "list"} answers its entries; {"peers": "open", "items": ["<member>#<n>", ...]} answers entries whole; {"peers": "open", "item": "<member>#<n>", "evidence": "<ref>"} answers the record the environment gave behind one piece of its evidence; {"peers": "find", "words": "...", "select": "what you need" (optional)} answers the entries that hold all the words. Each answer that holds them counts as a step.',
  'What a colleague publishes is their reading of their environment, not evidence about yours: their places differ from yours in size, pieces and starts, and they may be wrong. Tell what they concluded from what their environment returned (open the evidence), and test it here. When a belief of yours comes from the board, cite it in its evidence as "peer:<member>#<n>", next to the points of your episodes that support it.'
].join('\n');

/** A member's reader of the board, over the versions it fetched through its run's log. */
export class PeerChannel {
  readonly board: TeamBoard;
  readonly member: string;
  private readonly fetch: FetchLike;
  private readonly selector?: LineSelector;
  private readonly onSelect?: (record: SelectionRecord & Record<string, unknown>) => void;
  private readonly versions = new Map<number, BoardVersion | { error: string }>();
  /** Its publications so far (the n of the next is this + 1). */
  published = 0;

  constructor(board: TeamBoard, member: string, options: { fetch: FetchLike; selector?: LineSelector; onSelect?: (record: SelectionRecord & Record<string, unknown>) => void }) {
    this.board = board;
    this.member = member;
    this.fetch = options.fetch;
    if (options.selector) this.selector = options.selector;
    if (options.onSelect) this.onSelect = options.onSelect;
  }

  static acceptsRead(q: Record<string, unknown>): boolean { return typeof q.peers === 'string'; }
  static acceptsPublish(q: Record<string, unknown>): boolean { return !!q.publish && typeof q.publish === 'object' && !Array.isArray(q.publish); }

  /** The member's fetch of a version, served from its run's log when it was read before (E7). Waits until it is sealed. */
  static boardFetch(board: TeamBoard, signal?: AbortSignal): FetchLike {
    return async (url) => {
      const w = Number(/\/version\/(\d+)$/.exec(url)?.[1]);
      let text: string;
      try { text = JSON.stringify(await board.version(w, signal ? { signal } : {})); } catch (e) { text = JSON.stringify({ error: String((e as Error)?.message ?? e) }); }
      return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
    };
  }

  /** Version w, as this member read it (once per run). */
  private async read(w: number): Promise<BoardVersion | { error: string }> {
    if (!this.versions.has(w)) {
      const response = await this.fetch('peer://' + this.board.spec.id + '/version/' + w, { method: 'GET', headers: {}, signal: new AbortController().signal });
      this.versions.set(w, JSON.parse(await response.text()));
    }
    return this.versions.get(w)!;
  }

  /** A read of the board in a round. */
  async run(q: Record<string, unknown>, round: number): Promise<unknown> {
    const what = String(q.peers);
    const w = this.board.readableAt(round);
    if (!this.board.spec.exchange) return { peers: what, error: 'there is no board in this experiment' };
    if (w === null) {
      const next = (Math.floor((round - 1) / this.board.spec.window) + 1) * this.board.spec.window + 1;
      return { peers: what, error: 'the board is closed this round: it opens in round ' + next };
    }
    const v = await this.read(w);
    if ('error' in v) return { peers: what, version: w, error: v.error };
    const head = { peers: what, version: w };
    const brief = (e: BoardEntry) => ({ id: e.id, member: e.member, ...(e.member === this.member ? { yours: true } : {}), kind: e.kind, window: e.window,
      claim: clip(e.claim, 160), world: e.world, evidence: e.evidence.map((x) => x.ref) });
    if (what === 'list') return { ...head, entries: v.entries.map(brief), ...(v.entries.length ? {} : { note: 'nobody had published anything by then' }) };
    if (what === 'open') {
      const one = typeof q.item === 'string' ? q.item : null;
      if (one && typeof q.evidence === 'string') {
        const e = v.entries.find((x) => x.id === one);
        const ev = e?.evidence.find((x) => x.ref === q.evidence);
        return e ? (ev ? { ...head, item: one, evidence: ev.ref, record: ev.record } : { ...head, item: one, error: 'no such evidence in ' + one + ' (' + e.evidence.map((x) => x.ref).join(', ') + ')' })
          : { ...head, item: one, error: 'no such entry in version ' + w };
      }
      const ids = (Array.isArray(q.items) ? q.items : one ? [one] : []).map(String).slice(0, 8);
      if (!ids.length) return { ...head, error: '"items": the entries to open' };
      return { ...head, items: ids.map((id) => {
        const e = v.entries.find((x) => x.id === id);
        return e ? { ...e, evidence: e.evidence.map((x) => ({ ref: x.ref, what: describe(x.record) })) } : { id, error: 'no such entry in version ' + w };
      }) };
    }
    if (what === 'find') {
      const words = typeof q.words === 'string' ? q.words : '';
      const terms = fold(words).split(/\s+/).filter(Boolean);
      if (!terms.length) return { ...head, error: '"words": what to find' };
      const text = (e: BoardEntry) => [e.kind, e.claim, e.intervention ?? '', e.observed ?? '', e.scope ?? ''].join(' | ');
      const found = v.entries.filter((e) => terms.every((t) => fold(text(e)).includes(t)));
      const select = typeof q.select === 'string' && q.select.trim() ? q.select : null;
      if (select && this.selector && found.length) {
        try {
          const scores = await this.selector(select, found.map((e) => clip(text(e), 400)));
          const picked = found.map((e, k) => ({ e, s: Number.isFinite(scores[k]) ? scores[k] : 0 })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.e);
          this.onSelect?.({ need: select, lines: found.length, scores, items: found.map((e) => e.id), kept: picked.map((e) => e.id) });
          return { ...head, words, select, matches: found.length, selected: picked.length, entries: picked.map(brief) };
        } catch (e) {
          return { ...head, words, matches: found.length, entries: found.map(brief), note: 'the Judge could not select (' + String((e as Error)?.message ?? e).slice(0, 80) + ')' };
        }
      }
      return { ...head, words, matches: found.length, entries: found.map(brief), ...(select && !this.selector ? { note: 'there is no Judge in this run: "select" is not available' } : {}) };
    }
    return { peers: what, error: 'peers is "list", "open" or "find"' };
  }
}

/** A publication as written, checked: what it may be published as, or why not. */
export function parsePublication(raw: unknown): Publication | string {
  const o = (raw ?? {}) as Record<string, unknown>;
  const kind = o.kind as EntryKind;
  if (!ENTRY_KINDS.includes(kind)) return '"kind" is "result", "dead_end" or "method"';
  const claim = typeof o.claim === 'string' ? o.claim.trim() : '';
  if (!claim) return '"claim": what you publish, in a sentence';
  const evidence = (Array.isArray(o.evidence) ? o.evidence : []).map(String).map((r) => r.trim()).filter(Boolean).slice(0, 12);
  if (kind !== 'method' && !evidence.length) return 'a ' + kind + ' needs "evidence": the episodes, points, acts or investigation steps behind it';
  const text = (k: string) => (typeof o[k] === 'string' && (o[k] as string).trim() ? { [k]: (o[k] as string).trim() } : {});
  return { kind, claim, ...text('intervention'), ...text('observed'), ...text('scope'), evidence };
}

const clip = (text: string, n: number): string => (text.length > n ? text.slice(0, n - 1) + '…' : text);
const fold = (s: string): string => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

/** One line of what a record is (its kind and size), for an entry's index. */
function describe(record: unknown): string {
  const r = (record ?? {}) as Record<string, unknown>;
  if (typeof r.episode === 'string' && Array.isArray(r.frames)) return 'episode ' + r.episode + ' in ' + String(r.place ?? '?') + ', score ' + String(r.score) + ', ' + String(r.steps) + ' steps';
  if (typeof r.point === 'string') return 'the point ' + r.point + ' in ' + String(r.place ?? '?');
  if (typeof r.act === 'string') return 'the act ' + String(r.name ?? r.act) + (r.accepted === false ? ' (refused)' : '');
  if (typeof r.step === 'string') return 'the investigation step ' + r.step;
  return clip(JSON.stringify(record) ?? '', 80);
}
