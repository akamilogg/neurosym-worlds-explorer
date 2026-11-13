import fs from 'node:fs';
import path from 'node:path';
import { Channel, applyPins, type ChannelPublication, type PinOp } from '../learn/assisted/channel.ts';
import { roundsAt } from '../learn/lab.ts';
import type { LabContext, LabOptions, LabRunConfig, LawLab } from '../learn/lab.ts';
import { Delegations, type Launcher } from '../learn/assisted/delegation.ts';
import type { OperatorMessage } from '../learn/assisted/session.ts';
import { capabilityAt } from '../learn/lab.ts';
import type { ExperienceRun } from '../learn/assisted/experience.ts';
import { PeerChannel, parsePublication, type BoardEntry, type TeamBoard } from '../learn/assisted/board.ts';
import { WorldJournal, type LivingSession } from '../living/world.ts';
import { LivingBridge } from '../living/bridge.ts';
import type { ArtifactWorld } from '../artifacts/world.ts';
import type { JevJudge } from '../core/jev.ts';
import type { FetchLike } from '../core/net.ts';
import { evolveCapability, evolveConfigOf } from './evolve-branch.ts';
import type { LabConnection, OpenRun } from './lab-runner.ts';
import { LabError } from './lab-error.ts';

/* ============================================================================
 * runLawLab BY ITS SEAMS (SPEC-CONSOLIDACION §5.1, CC3): the parts of a run of a world of laws that already had a frontier
 * in the code, each taken out with an explicit context instead of the variables of a closure, in the order the spec gives:
 *
 *   1. resumption         what is served from the record and what is asked again (`recorded`, `effects`): the context a
 *                         laboratory computes with
 *   2. the channel        the researcher's channel, its budget pinned, its pins, and what the world publishes in it
 *   3. delegation         its branches, their fund and their results delivered as messages
 *   4. the team           its board: publications with their evidence, readings, the keys of each intervention
 *   5. the living world   its session and bridge, the operator's control of its programs, the signals sampled per round
 *
 * Each is made where runLawLab made it, so no event moves (K3); what remains of runLawLab orders the phases of a round.
 * A part reads what is made later (the session, the branches) through getters, never before it exists.
 * ========================================================================== */

type J = Record<string, any>;
type Log = (type: string, data?: Record<string, unknown>) => void;
type Say = (line: string) => void;

/* --- 1. Resumption ------------------------------------------------------------------------------------------------ */

/** The context a laboratory computes with (LabContext): what it computes itself given again from the run's record when
    resumed (`recorded`), its effects on services outside it (`effects`), the texts it keeps whole, its episodes by id, and
    - where the researcher has a channel - what it publishes there. */
export function labContextOf(o: { readonly base: LabContext; readonly run: Pick<OpenRun, 'effects' | 'recorded'>; readonly keep: (text: string) => string;
  readonly episodeOf: (id: string) => unknown; readonly publish?: (m: ChannelPublication) => void }): LabContext {
  return { ...o.base, ...(o.run.effects ? { effects: o.run.effects } : {}), recorded: o.run.recorded, keep: o.keep, episodeOf: o.episodeOf,
    ...(o.publish ? { publish: o.publish } : {}) };
}

/* --- 2. The channel ----------------------------------------------------------------------------------------------- */

export interface ResearcherChannel {
  /** Whether this run's researcher has a channel at all (the assisted one's, in a run that starts with it). */
  readonly on: boolean;
  readonly channel: Channel;
  /** The channel once the assisted researcher is helped (its budget pinned then), else none. */
  now(): Channel | null;
  /** Whether it pins itself (with --no-pins, the condition without). */
  pinning(): boolean;
  /** Its own pins applied: a document of its notebook in its latest version, a notice, a text. */
  applyPins(ops: readonly PinOp[]): string[];
  /** What the world publishes in it. */
  publishWorld(m: ChannelPublication): void;
}

/** The researcher's channel (SPEC-CANAL-MENSAJES): from its first question as the assisted researcher (after a hand-over,
    from then), its budget pinned by the harness and read as it stands when delivered (SPEC-INVESTIGADOR-ASISTIDO §15). */
export function researcherChannel(o: { readonly run: Pick<OpenRun, 'log' | 'journal' | 'services'>; readonly cfg: LabRunConfig & J; readonly helping: () => boolean; readonly attempt: () => number;
  readonly document: (id: string) => { text: string; versions: number } | undefined }): ResearcherChannel {
  const on = o.run.journal.researcher === 'assisted' && (o.cfg as { capabilities_from?: Record<string, number> }).capabilities_from?.channel === 0;
  const channel = new Channel(o.run.log);
  let opened = false;
  const now = (): Channel | null => {
    if (!on || !o.helping()) return null;
    if (!opened) {
      opened = true;
      if (o.run.services.budget) channel.publish('harness', { kind: 'pinned', key: 'budget', body: () => o.run.services.budget!(o.attempt(), roundsAt(o.cfg, o.attempt())) });
    }
    return channel;
  };
  return { on, channel, now,
    pinning: () => on && o.helping() && (o.cfg as { pins?: boolean }).pins !== false,
    applyPins: (ops) => applyPins(channel, ops, o.document),
    publishWorld: (m) => { now()?.publish('world', m); } };
}

/* --- 3. Delegation ------------------------------------------------------------------------------------------------ */

export interface RunBranches {
  readonly delegations: Delegations | null;
  readonly config: { fund: number; tokens: number; rounds: number; max_rounds: number; ledger?: string } | undefined;
  /** Whether it may delegate now: the assisted researcher, helped, investigating, with a fund, from when this code gives it. */
  delegating(): boolean;
  /** The results of its branches, delivered as they end: messages of their own, never help. */
  results(): OperatorMessage[];
}

/** Its branches (SPEC-DELEGACION-INVESTIGACIONES): the assisted researcher's, where the operator gives it a fund, from when
    this code gives it; one at a time, none delegating in turn, never in a world whose environment is outside the harness.
    A living world's: a realization of its own, or a member of this one (SPEC-ACONTECIMIENTOS-DEL-MUNDO §12). */
export function runBranches(o: { readonly lab: LawLab; readonly run: Pick<OpenRun, 'outFile' | 'journal' | 'log'>; readonly cfg: LabRunConfig & J; readonly worldOptions: LabOptions;
  readonly spec: unknown; readonly previous: J | null; readonly resumeFrom: string | null; readonly helping: () => boolean; readonly investigative: boolean; readonly attempt: () => number;
  readonly delegate?: Launcher; readonly connection?: { readonly root: string; readonly llm: LabConnection; readonly judge?: LabConnection; readonly fetch?: FetchLike };
  readonly living: LivingSession<unknown, unknown> | null; readonly actor: string; readonly sharedRuns: Promise<unknown>[];
  /** The requester's external sources, from which a branch's bags are granted (SPEC-INVESTIGACION-EXTERNA §4). */
  readonly external?: () => import('../learn/assisted/external-sources.ts').ExternalSources | null;
  /** A run of this laboratory in this process (a shared branch's): given, so this module never imports the runner. */
  readonly runShared: (args: readonly string[], c: { root: string; llm: LabConnection; judge?: LabConnection; fetch?: FetchLike }, living: { session: LivingSession<unknown, unknown>; actor: string }, stopAs?: string) => Promise<unknown> }): RunBranches {
  const { cfg, run, previous, resumeFrom, living, lab, worldOptions } = o;
  const journal = run.journal;
  const config = (cfg as { delegation?: { fund: number; tokens: number; rounds: number; max_rounds: number; ledger?: string } }).delegation;
  const delegating = (): boolean => journal.researcher === 'assisted' && o.helping() && o.investigative && config !== undefined && capabilityAt(cfg as never, 'delegation', o.attempt());
  /* The fund's ledger, beside the journal of the run that began the lineage, shared by its junior and its senior (one fund). */
  if (config && !config.ledger) {
    (config as { ledger?: string }).ledger = path.basename(run.outFile).replace(/\.json$/, '') + '.delegation-fund.jsonl';
    if (journal.config?.delegation) journal.config.delegation.ledger = config.ledger;
  }
  const delegations = config ? new Delegations({
    config: { fund: config.fund, tokens: config.tokens, rounds: config.rounds, maxRounds: config.max_rounds,
      ...((config as { evolve?: Record<string, any> }).evolve ? { evolve: evolveConfigOf((config as { evolve?: Record<string, any> }).evolve!) } : {}) },
    journalFile: run.outFile, snapshot: () => JSON.parse(JSON.stringify(journal)), lab: lab.id,
    ...((config as { evolve?: unknown }).evolve ? { evolve: evolveCapability(lab.id, cfg.seed, worldOptions as Record<string, string>, () => (o.spec as { world: ArtifactWorld }).world,
      () => (cfg as { __experienceRuns?: ExperienceRun[] }).__experienceRuns ?? []) } : {}),
    worldArgs: ['--seed', String(cfg.seed), ...Object.entries(worldOptions).flatMap(([k, v]) => ['--' + k, String(v)]),
      ...(cfg.flat ? ['--flat'] : []), ...(cfg.memory === 'selective' ? ['--memory', 'selective'] : [])],
    /* A run in a process of its own, with the keys of this process's environment (loaded when first needed: control.ts reads
       every laboratory). */
    launcher: o.delegate ?? (async (l) => { const c = await import('./control.ts'); return { pid: (l.evolve ? c.startEvolveAt(l.journal, l.evolve) : c.startRunAt(l.journal, c.labNameOf(l.lab), l.args)).pid }; }), log: run.log,
    /* The run that begins the lineage's fund opens it (a new run, or a continuation given one now); a run resumed finds it -
       or its loss, said so. */
    ...(config.ledger ? { ledger: path.resolve(path.dirname(run.outFile), config.ledger), requester: 'junior', opens: !previous?.config?.delegation } : {}),
    history: (previous?.events ?? []) as Record<string, any>[],
    /* Its history was written beside the run it resumes, wherever that is. */
    ...(previous && resumeFrom ? { historyDir: path.dirname(path.resolve(resumeFrom)) } : {}),
    unsupported: lab.external ? 'its environment is outside the harness: a branch would share it, not have its own' : null,
    ...(living ? { living: {
      modes: String(worldOptions.branches ?? 'isolated').split(',').map((x) => x.trim()).filter((x): x is 'isolated' | 'shared' => x === 'isolated' || x === 'shared'),
      fork: (file: string, randomness: 'same' | 'fresh', by: string) => {
        const at = living.forkPoint(by);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(at));
        return { args: ['--fork', file, '--fork-randomness', randomness], revision: at.from.revision, tick: at.from.tick };
      },
      join: (b: { id: string; actor: string; journal: string; args: readonly string[]; resume: string | null; stopAs?: string }) => {
        const c = o.connection;
        if (!c) return 'this run cannot start a run in its own process';
        const joined = living.join({ id: b.actor, kind: 'researcher', ...(living.actionsOf(o.actor) ? { actions: living.actionsOf(o.actor)! } : {}) });
        if (!joined.accepted) return joined.reason;
        /* Resumed: a record of its own, derived from the one it continues - never the same file written twice. */
        let out = b.journal;
        if (b.resume) {
          /* The first number no record has: never the record it resumes, never one written by an earlier resumption. */
          const base = b.resume.replace(/(\.resumed-\d+)?\.json$/, '');
          let k = 1;
          while (fs.existsSync(base + '.resumed-' + k + '.json') || path.resolve(base + '.resumed-' + k + '.json') === path.resolve(b.resume)) k++;
          out = base + '.resumed-' + k + '.json';
        }
        const args = b.resume ? ['--resume', b.resume, '--out', out] : [...b.args, '--out', out];
        const done = o.runShared(args, { root: c.root, llm: c.llm, ...(c.judge ? { judge: c.judge } : {}), ...(c.fetch ? { fetch: c.fetch } : {}) }, { session: living, actor: b.actor }, b.stopAs)
          .catch((e) => { living.retire(b.actor, 'failed'); run.log('delegation_branch_failed', { id: b.id, error: String((e as Error)?.message ?? e).slice(0, 300) }); });
        o.sharedRuns.push(done);
        return { journal: out, done };
      }
    } } : {}),
    experience: (cfg as { __experienceFiles?: string[] }).__experienceFiles ?? [],
    ...(o.external ? { external: o.external } : {})
  }) : null;
  return { delegations, config, delegating,
    results: () => (delegations && delegating() ? delegations.results().map((r) => ({ ...r, by: 'agent:' + r.research_result, at: new Date().toISOString() })) : []) };
}

/* --- 4. The team -------------------------------------------------------------------------------------------------- */

export interface TeamParts {
  /** Whether its researcher exchanges on the board. */
  readonly exchange: boolean;
  /** The run's log with each investigation step kept as it was asked and answered (what a publication may cite). */
  readonly logged: Log;
  /** An intervention of the step in course, keyed (to measure a team), with the episode it made. */
  noteIntervention(kind: string, place: string, key: string, episode: string): void;
  /** What an act answered, by its episode (the record behind evidence that cites it). */
  readonly actAnswers: Map<string, unknown>;
  publish(raw: unknown): unknown;
  readPeers(q: Record<string, unknown>, round: number): Promise<unknown>;
}

/** Its team's board (SPEC-INVESTIGACION-PARALELA §5.2): what it publishes carries the records behind its evidence as the world
    answered them; what it reads is the version its round opens, through its run's log. The operator keeps, apart, the key
    of each intervention (to measure a team). */
export function teamParts(o: { readonly team: { board: TeamBoard; member: string; channel: PeerChannel } | null; readonly journal: J; readonly log: Log; readonly say: Say;
  readonly lab: Pick<LawLab, 'steps' | 'view'>; readonly episodes: ReadonlyMap<string, { id: string; place: string; by: string; data: unknown }>;
  readonly roleOf: (place: string) => string | undefined; readonly round: () => number }): TeamParts {
  const { team, log, say, lab, episodes } = o;
  const actAnswers = new Map<string, unknown>();
  const stepAnswers = new Map<string, { requests: unknown; results: unknown }>();
  const stepsInRound = new Map<number, number>();
  let stepInterventions: { kind: string; place: string; key: string }[] = [];
  const stepKeys = new Map<string, string[]>();
  const keyOfEpisode = new Map<string, string>();
  /* Every investigation step, as it was asked and answered: what a publication may cite ("r<round>.<step>"). */
  const logged: Log = (type, data = {}) => {
    if (type === 'investigation' && typeof data.round === 'number') {
      const step = (stepsInRound.get(data.round) ?? 0) + 1;
      stepsInRound.set(data.round, step);
      const id = 'r' + data.round + '.' + step;
      stepAnswers.set(id, { requests: data.requests, results: data.results });
      if (stepInterventions.length) {
        stepKeys.set(id, stepInterventions.map((x) => x.key));
        log('operator_interventions', { round: data.round, step, interventions: stepInterventions });
        stepInterventions = [];
      }
    }
    log(type, data);
  };
  /** Where an entry was observed, as the environment can say it (a team shares its laboratories and its family). */
  const placeOfTeam = (placeId: string): Record<string, unknown> => ({ place: placeId, same_place_for_the_whole_team: o.roleOf(placeId) !== 'confirmation' });
  /** The record of the environment behind one of its references, as it answered it; null when there is none. */
  function evidenceOf(ref: string): { record: Record<string, unknown>; place: string | null; keys: string[] } | null {
    const r = ref.trim();
    const step = /^(?:investigation:)?r(\d+)\.(\d+)$/.exec(r);
    if (step) {
      const id = 'r' + step[1] + '.' + step[2];
      const s = stepAnswers.get(id);
      return s ? { record: { step: id, ...s }, place: null, keys: stepKeys.get(id) ?? [] } : null;
    }
    const point = /^(.+)@(\d+)$/.exec(r);
    if (point) {
      const e = episodes.get(point[1]);
      const k = Number(point[2]);
      if (!e || k > lab.steps(e.data)) return null;
      return { record: { point: r, place: e.place, episode: e.id, step: k, ...lab.view(e.data, k, k) }, place: e.place, keys: [] };
    }
    const e = episodes.get(r);
    if (!e) return null;
    return { record: { episode: e.id, place: e.place, chosen_by: e.by, steps: lab.steps(e.data), ...(actAnswers.has(e.id) ? { act: actAnswers.get(e.id) } : {}),
      ...lab.view(e.data, 0, lab.steps(e.data)) }, place: e.place, keys: keyOfEpisode.has(e.id) ? [keyOfEpisode.get(e.id)!] : [] };
  }
  /** A publication: checked, its evidence's records attached, put on the board under its number (the same number when a
      resumed run publishes it again: nothing is added). What it is answered is the same live or resumed. */
  function publish(raw: unknown): unknown {
    const p = parsePublication(raw);
    if (typeof p === 'string') return { publish: 'refused', error: p };
    const found = p.evidence.map((ref) => ({ ref, at: evidenceOf(ref) }));
    const missing = found.filter((x) => !x.at).map((x) => x.ref);
    if (missing.length) return { publish: 'refused', error: 'no record of yours behind ' + missing.join(', ') + ' (an episode, a point "<episode>@<step>", an act "act<n>", an investigation step "r<round>.<step>" already answered)' };
    const peers = team!.channel;
    const n = peers.published + 1;
    const seenIn = [...new Set(found.flatMap((x) => (x.at!.place ? [x.at!.place] : [])))];
    const { evidence: _refs, ...said } = p;
    const entry: BoardEntry = { id: team!.member + '#' + n, member: team!.member, n, round: o.round(), window: peers.board.windowOf(o.round()), ...said,
      world: seenIn.map(placeOfTeam), evidence: found.map((x) => ({ ref: x.ref, record: x.at!.record })) };
    const put = peers.board.publish(entry, { places: seenIn.map((id) => ({ id })), keys: [...new Set(found.flatMap((x) => x.at!.keys))] });
    peers.published = n;
    log('peer_publish', { round: o.round(), id: entry.id, kind: entry.kind, claim: entry.claim, evidence: p.evidence, window: entry.window,
      ...(put.replayed ? { replayed: true } : {}), ...(put.conflict ? { conflict: put.conflict } : {}) });
    say('  publishes ' + entry.id + ' (' + entry.kind + ')' + (put.replayed ? ' [already on the board]' : '') + (put.conflict ? ' [CONFLICT: ' + put.conflict + ']' : ''));
    return { publish: 'published', id: entry.id, window: entry.window, readable_in_round: entry.window * peers.board.spec.window + 1 };
  }
  async function readPeers(q: Record<string, unknown>, round: number): Promise<unknown> {
    const answer = await team!.channel.run(q, round) as Record<string, unknown>;
    log('peer_read', { round, peers: q.peers, ...(answer.version !== undefined ? { version: answer.version } : {}),
      ...(q.items !== undefined || q.item !== undefined ? { items: Array.isArray(q.items) ? q.items.map(String) : [String(q.item)] } : {}),
      ...(typeof q.evidence === 'string' ? { evidence: q.evidence } : {}), ...(typeof q.words === 'string' ? { words: q.words } : {}),
      ...(Array.isArray(answer.entries) ? { shown: (answer.entries as { id: string }[]).map((e) => e.id) } : {}),
      ...(answer.error ? { error: answer.error } : {}) });
    return answer;
  }
  return { exchange: team !== null && team.board.spec.exchange && o.journal.researcher === 'assisted', logged, actAnswers, publish, readPeers,
    noteIntervention: (kind, place, key, episode) => { stepInterventions.push({ kind, place, key }); keyOfEpisode.set(episode, key); } };
}

/* --- 5. The living world ------------------------------------------------------------------------------------------ */

export interface LivingParts {
  readonly living: LivingSession<unknown, unknown> | null;
  readonly bridge: LivingBridge<unknown> | null;
  readonly actor: string;
  readonly shared: { readonly session: LivingSession<unknown, unknown>; readonly actor: string } | null;
  /** The operator's changes to the programs, taken as they come. */
  controlWorld(): void;
  /** Asked before every question: the world closed by the operator stops its researcher (once said). */
  closedNow(round: number): boolean;
  /** What its checks say, and what a judge the operator configured says, sampled per round (§10). */
  checkSample(round: number, laboratories: readonly Record<string, any>[] | null): void;
  judgeSample(round: number, laboratories: readonly Record<string, any>[] | null): Promise<void>;
  /** Its session left or closed, its timer stopped: what it ended with. */
  end(stoppedBy: string): unknown;
}

const LIVING_ACTOR = 'researcher';

/** A living world (SPEC-ACONTECIMIENTOS-DEL-MUNDO): its one session, the researcher an actor in it. Its journal beside the
    run's, written ahead; a resumed run derives it again against the one it continues. A session shared with other members
    is its runner's (its journal, its closing); a session of its own, the run's. */
export function livingParts(o: { readonly lab: LawLab; readonly spec: unknown; readonly worldOptions: LabOptions; readonly run: Pick<OpenRun, 'outFile' | 'journal' | 'log' | 'operator'>; readonly say: Say;
  readonly previous: J | null; readonly resumeFrom: string | null; readonly shared: { readonly session: LivingSession<unknown, unknown>; readonly actor: string } | null;
  /** Whether a session of its own is opened (a documentary investigation starts no simulator). */
  readonly open?: boolean;
  readonly channelOn: boolean; readonly channelNow: () => Channel | null; readonly judge: JevJudge;
  readonly store: (seg: unknown, round: number, by: string, name?: string) => string; readonly actAnswers: Map<string, unknown>;
  readonly episodes: ReadonlyMap<string, { id: string; by: string; data: unknown }>;
  readonly notebook: () => { documents: Map<string, { id: string; versions: number; text: string }>; brief(): unknown };
  readonly round: () => number; readonly delegations: () => Delegations | null }): LivingParts {
  const { lab, spec, worldOptions, run, say, previous, resumeFrom, shared } = o;
  const log = run.log;
  const outFile = run.outFile;
  const worldJournalOf = (f: string) => f.replace(/\.json$/, '') + '.world.jsonl';
  /* Its identity and its actions as declared (a manifest's, a world option's), alone as in a shared session. */
  const actor = shared?.actor ?? (worldOptions.actor || LIVING_ACTOR);
  const declared = String(worldOptions.actions ?? '*');
  const alone = { id: actor, kind: 'researcher' as const, ...(declared === '*' ? {} : { actions: declared === 'none' ? [] : declared.split(',').map((x) => x.trim()).filter(Boolean) }) };
  if (shared && !o.channelOn) throw new LabError('a shared living world delivers its members\' messages through the researcher\'s channel: this run has none');
  const opened = (): LivingSession<unknown, unknown> | null => {
    if (shared || !lab.living || o.open === false) return null;
    try { return lab.living.open(spec, { actors: [alone], options: worldOptions,
    journal: new WorldJournal(worldJournalOf(outFile), { ...(previous && resumeFrom ? { from: worldJournalOf(resumeFrom) } : {}),
      onDiverge: (d) => { log('world_diverged', { key: d.key }); say('  the world diverged from the record it continues, at ' + d.key); } }) }); }
    catch (e) { throw new LabError(lab.id + ': ' + String((e as Error).message ?? e)); }
  };
  const living = shared ? shared.session : opened();
  /* Its own material it may share: its episodes and the environment's, its checks' - never a validation's, never what another
     member shared with it - and its documents in their latest version. */
  const shareable = (id: string) => { const e = o.episodes.get(id); return e && (e.by === 'you' || e.by === 'the environment' || e.by.startsWith('the check')) ? e : null; };
  const bridge = living && lab.living ? new LivingBridge<unknown>({ session: living, actor,
    intent: (a) => lab.living!.intent(a), asWritten: (a) => (lab.act?.asWritten ? lab.act.asWritten(a) : a), shown: (seg) => lab.act!.shown(seg),
    store: (seg, round, by, answer, name) => {
      const id = o.store(seg, round, by, name);
      if (answer) o.actAnswers.set(id, answer(id));
      return id;
    },
    material: (ref) => {
      if (ref.document !== undefined) {
        const d = o.notebook().documents.get(ref.document);
        return d ? { kind: 'document' as const, id: d.id, version: d.versions, text: d.text } : 'no document "' + ref.document + '" of yours';
      }
      const e = o.episodes.get(String(ref.episode));
      if (!e) return 'no episode "' + ref.episode + '" of yours';
      return shareable(e.id) ? { kind: 'episode' as const, name: e.id, segment: e.data as never } : 'share what is yours: ' + e.id + ' is ' + (e.by.startsWith('actor:') ? 'what ' + e.by.slice(6) + ' shared with you' : 'not yours to share (' + e.by + ')');
    },
    own: (ref) => { const r = ref.trim(); return shareable(r.split('@')[0]) !== null || o.notebook().documents.has(r); },
    deliver: (messages, waiting) => {
      /* Each with its provenance: a member's word, an instrument's reading (the world, as measured), the operator's announcement. */
      for (const m of messages) {
        if (m.from === 'operator' && typeof m.pin === 'string') { o.channelNow()?.publish('operator', { kind: 'pinned', key: m.pin as string, body: m.text }); continue; }
        o.channelNow()?.publish((m.reading ? 'world' : m.from === 'operator' ? 'operator' : 'actor:' + m.from) as never, { kind: 'notice', body: m });
        /* The operator's word reached it: help, counted apart from the operator's interventions on the world. */
        if (m.help) log('world_help', { round: o.round(), message: m.message, text: m.text });
      }
      if (waiting) o.channelNow()?.publish('harness', { kind: 'notice', body: { messages_waiting: waiting, read_them: '{"read": "inbox"}' } });
      log('messages_delivered', { round: o.round(), messages: messages.map((m) => m.message), ...(waiting ? { waiting } : {}) });
    }, log, say }) : null;
  /* The operator's changes to the programs (`lab world`), taken before each question: applied when the next window opens. */
  let worldClosedSaid = false;
  const controlWorld = (): void => {
    for (const w of run.operator.world()) {
      const who = { id: w.id ?? null, kind: 'world', ...(w.by ? { by: w.by } : {}) };
      /* A shared branch made a member of its own: its requester's, not the world's (§12). */
      if (w.op === 'promote') {
        const delegations = o.delegations();
        const why = !delegations ? 'this run has no branches' : delegations.promote(String(w.target), String(w.by ?? 'operator'), typeof w.budget === 'number' ? w.budget : undefined);
        log(why ? 'operator_command_refused' : 'operator_command', { ...who, ...(why ? { reason: why } : { accepted: true, op: 'promote' }) });
        continue;
      }
      const why = !living ? 'this run has no living world' : living.control({ id: String(w.id), op: w.op as never, ...(w.program ? { program: w.program as never } : {}),
        ...(typeof w.target === 'string' ? { target: w.target } : {}), ...(w.actor ? { actor: w.actor as never } : {}), ...(typeof w.to === 'string' ? { to: w.to } : {}),
        ...(typeof w.text === 'string' ? { text: w.text } : {}), ...(typeof w.key === 'string' ? { key: w.key } : {}),
        by: String(w.by ?? 'operator'), ...(typeof w.why === 'string' ? { why: w.why } : {}) });
      log(why ? 'operator_command_refused' : 'operator_command', { ...who, ...(why ? { reason: why } : { accepted: true, op: w.op }) });
    }
  };
  /* What its checks say, as a signal the operator declared on them (§10): a sample per round; none for a round without one. */
  const checkSample = (round: number, laboratories: readonly Record<string, any>[] | null): void => {
    if (!living) return;
    const pts = laboratories?.reduce((n, l) => n + (typeof l.points === 'number' ? l.points : 0), 0) ?? 0;
    const value = !laboratories ? null : pts > 0 ? laboratories.reduce((n, l) => n + (Number(l.exact) || 0), 0) / pts : laboratories.filter((l) => l.holds).length / Math.max(1, laboratories.length);
    for (const sg of living.signalsFrom(actor, 'checks')) living.sample(sg, 'r' + round, value, { harness: true });
  };
  /* A judge the operator configured, asked of each round (§10): what it was given, its rule, its answer and its cost kept
     with the sample; its failure a missing sample, never a reading. */
  const judgeSample = async (round: number, laboratories: readonly Record<string, any>[] | null): Promise<void> => {
    if (!living) return;
    const judge = o.judge;
    for (const sg of living.signalsFrom(actor, 'judge')) {
      const j = living.signalOf(sg)!.judge!;
      const inputs = j.inputs ?? ['check'];
      const brief = o.notebook().brief() as Record<string, any>;
      const texts: Record<string, string> = {
        ...(inputs.includes('check') ? { last_check: JSON.stringify(laboratories ? laboratories.map((l) => ({ place: l.place, holds: l.holds, exact: l.exact, points: l.points })) : 'no check this round') } : {}),
        ...(inputs.includes('beliefs') ? { beliefs: JSON.stringify((brief.beliefs_held ?? []).map((b: Record<string, unknown>) => b.statement)) } : {}) };
      const rule = { type: 'score' as const, instructions: j.instructions, criteria: [...j.criteria] };
      const before = judge.stats.calls;
      try {
        const answers = await judge.judge({ world: lab.id, rulesOfTheWorld: '', sideToMove: 'nature', measurements: {}, texts, questions: { signal: rule } });
        const a = answers.signal;
        living.sample(sg, 'r' + round, a && Number.isFinite(a.value) ? a.value : null, { harness: true }, { inputs: texts, rule, answer: { value: a?.value ?? null, confidence: a?.confidence ?? null }, judge_calls: judge.stats.calls - before });
      } catch (e) { living.sample(sg, 'r' + round, null, { harness: true }, { inputs: texts, rule, error: String((e as Error).message ?? e).slice(0, 200), judge_calls: judge.stats.calls - before }); }
    }
  };
  /* The operator's orders to the world are taken as they come, not only before a question: a world paused waits for one. */
  const worldTimer = living ? setInterval(controlWorld, 500) : null;
  if (living) run.journal.world = { session: living.id, adapter: living.adapter.id, actor, ...(shared ? { shared: true, journal: living.journal.file ? path.relative(path.dirname(outFile), living.journal.file).split(path.sep).join('/') : null }
    : { journal: path.basename(worldJournalOf(outFile)) }), clock: living.clock, limits: living.limits };
  return { living, bridge, actor, shared, controlWorld, checkSample, judgeSample,
    closedNow: (round) => {
      /* A world the operator closed: its researcher stops, as a cancellation does (its closing kept). */
      if (living && living.status === 'completed' && !worldClosedSaid) { worldClosedSaid = true; log('world_closed', { round }); }
      return Boolean(living && living.status === 'completed');
    },
    end: (stoppedBy) => {
      if (worldTimer) clearInterval(worldTimer);
      return living ? (shared ? { ...living.summary(), left: stoppedBy } : living.close(stoppedBy)) : null;
    } };
}

