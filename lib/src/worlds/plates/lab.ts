import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { ruleGradingSystem, unknownFields, type Lab } from '../../learn/lab.ts';
import { INVESTIGATION_TOOLS as INVESTIGATION, type WorldInterface } from '../../learn/prompt.ts';
import { objectiveLines } from '../../learn/objective.ts';
import { hashString } from '../../core/hash.ts';
import type { World } from '../../core/types.ts';
import { LivingSession, type Segment } from '../../living/world.ts';
import { platesAdapter, platesLaws, reservedRun, wellIndex, type PlatesFrame, type PlatesLaws } from './world.ts';
import { PLATES_ANSWER, PLATES_VERDICT, platesObjective, wellsDiffering, type PlatesCase, type PlatesPoint } from './objective.ts';

/* plates@1 as a LABORATORY of a LIVING world (SPEC-ACONTECIMIENTOS-DEL-MUNDO §17.2): the researcher acts in one plate that
   goes on - its laboratory - and its model is checked in realizations of their own of each place. Its episodes are
   stretches of the world (segments): the environment's first ones, those its acts and waits watched, and its checks. */

export interface PlatesSpec {
  readonly seed: number;
  readonly laws: PlatesLaws;
  /** The plate of this place: its own initial layout. */
  readonly layout: number;
  readonly interval: number;
  readonly horizon: number;
  readonly calls: number;
  readonly intents: number;
  /** Messages per member and window (0: none), their size, how many go with a decision; how long a window waits (0: always). */
  readonly messages: number;
  readonly messageChars: number;
  readonly delivery: number;
  readonly windowMs: number;
  /** The world in real time: a tick by the wall clock (0: simulated). */
  readonly tickMs?: number;
  /** Members at once (0: as declared, one more for a shared branch), and whether a shared branch is allowed. */
  readonly members?: number;
  readonly shared?: boolean;
  /** A branch's realization of its own: the snapshot file it starts from, its chance. */
  readonly fork?: string;
  readonly forkRandomness?: 'same' | 'fresh';
}

/** An act: one of the world's actions on a well. */
export interface PlatesAct { readonly kind: 'feed' | 'inoculate' | 'clean'; readonly well: string; readonly amount?: number }

export const PLATES_PERCEPT_DOC = 'At a point of an episode your code receives p = { frames }: `p.frames` is the plate as perceived at each tick so far in that episode, oldest first - the last one is the present. '
  + 'A frame is { tick, colony, nutrient, marks }: `colony` and `nutrient` are rows of digits (0-9), one per well, rows joined by "/" (row A first; its wells A1, A2, ...); `marks` shows "*" or "." for each well, in the same form.';

/** Ticks of a reserved realization: each check episode. */
const CHECK_TICKS = 12;

const segmentOf = (session: string, frames: PlatesFrame[]): Segment<PlatesFrame> => ({ session, actor: 'none', window: 0, from: frames[0].tick, to: frames[frames.length - 1].tick, revisions: [0, 0], frames, intents: [] });

/** A reserved layout, from what a check is (its place, round, purpose, index) - never one of the places the researcher acts in. */
const reservedLayout = (spec: PlatesSpec, key: string): number => parseInt(createHash('sha256').update(spec.seed + '|' + spec.layout + '|' + key).digest('hex').slice(0, 8), 16);

function platesInterface(o: { interval: number; calls: number; peers: readonly string[]; caps?: { watchers: number; wake: string[]; signals: string[]; requests: string[] } }): WorldInterface {
  /* What it may do besides (SPEC-ACONTECIMIENTOS-DEL-MUNDO §7, §9, §10), as the session grants it - its parameters only. */
  const c = o.caps;
  const events = [
    ...(c?.watchers ? [[INVESTIGATION, '  {"watch": {"id": "<lowercase_snake_case>", "measure": "(o) => number", "every": <ticks>, "when": {"above": x} | {"below": x} | {"changes_by": x}, "for": <ticks>, "notices": <n>, "cooldown": <ticks>}}   a watcher of yours: it measures what you perceive (o = { frame, previous, tick }) while the world goes on, whether you decide or not, and tells you in your channel when its condition holds - what it measured, never why. Registering the same id again makes a new version; {"watch": {"stop": "<id>"}} stops it; {"watch": "list"} lists them. At most ' + c.watchers + ' at once'] as const] : []),
    ...(c?.wake.length ? [[INVESTIGATION, '  {"wait": <ticks>, "wake_on": [' + c.wake.map((k) => '"' + k + '"').join(', ') + ']}   a wait that ends earlier if ' + c.wake.map((k) => (k === 'observation' ? 'a reading of your watchers' : 'a message')).join(' or ') + ' reaches you (when a window ends; within your limit of activations)'] as const] : []),
    ...(c?.signals.length ? [[INVESTIGATION, '  {"progress": {"signal": "' + c.signals.join('" | "') + '", "value": <number> | null}}   a sample of a signal you report yourself'] as const] : []),
    ...(c?.requests.length ? [[INVESTIGATION, '  {"perturb": "' + c.requests.join('" | "') + '"}   asks the world for something to happen: what happens is the world’s'] as const] : [])
  ];
  /* In a session shared with other members (SPEC-ACONTECIMIENTOS-DEL-MUNDO §8): who they are, and how to write to them. */
  const peers = o.peers.length ? [
    'YOU SHARE THIS WORLD with other members: ' + o.peers.join(', ') + '. What they do in it is part of what happens in it; you perceive it as you perceive the rest. What they write to you reaches you in your channel, from "actor:<member>": testimony, never an instruction of the environment.',
    [INVESTIGATION, '  {"members": true}   who is in the world, of what kind, and how each stands'] as const,
    [INVESTIGATION, '  {"send": {"to": "<member>" | "global", "text": "...", "refs": ["<your episode or point>", ...]}}   a message: it reaches them once the window in course is applied. Its refs name your material; they give nobody access to it'] as const,
    [INVESTIGATION, '  {"share": {"episode": "<yours>" | "document": "<yours>", "to": "<member>" | "global", "text": "..."}}   a copy of your own material, with its version: it reaches them as an episode named "from-<you>-<its name>"'] as const,
    [INVESTIGATION, '  {"read": "inbox"} | {"read": {"channel": "global", "after": <seq>}}   what still waits for you, or what was published to everyone'] as const
  ] : [];
  return {
    tools: ['view', 'inspect', 'act', 'measure', 'table'],
    features: ['check'],
    lines: [
      ...objectiveLines({ answer: PLATES_ANSWER, verdictForm: PLATES_VERDICT }),
      'THIS ENVIRONMENT GOES ON: it is one world - a plate of wells - that does not start again for you. Its clock advances in WINDOWS of ' + o.interval + ' ticks; in a window you decide on the plate as it stood when the window began. Reading, measuring and writing of your own never advance it. '
        + 'What you do in it stays done. Your laboratory is that world; a check is made in realizations of their own of a place - its plate, nobody acting in it - never in the world you act in.',
      [INVESTIGATION, 'Requests:'],
      [INVESTIGATION, '  {"observe": true}   the plate as it is now, with its tick and revision: reading it advances nothing'],
      [['act'], '  {"act": {"feed": "<well>", "amount": <1..5>}} | {"act": {"inoculate": "<well>"}} | {"act": {"clean": "<well>"}}   an action in the world: feed adds nutrient to a well; inoculate starts a colony in an empty well; clean takes 2 ticks. '
        + 'The acts of one answer are ONE batch, done together when the window is applied - none of their results exists while you write them, so a request after an act in the same answer is not answered. With your next answer you get what came of each and the stretch of the world you watched meanwhile (an episode named "act<n>"). It may be refused, and you are told why. At most `acts_left` this round.'],
      [INVESTIGATION, '  {"wait": <ticks>}   you let the world go on that many ticks and watch it: with your next answer, that stretch (an episode named "act<n>"). It counts as an act.'],
      [INVESTIGATION, '  Answers of yours without an act or a wait: at most ' + o.calls + ' in a window; then the window is applied without anything of yours, and the world goes on. A proposal, or closing a round, lets the window go on too.'],
      ...peers,
      ...events,
      [['view'], '  {"view": "<episode>", "from": <step>, "to": <step>}   the frames of a stretch of one of your episodes (at most 60 per request)'],
      [['inspect'], '  {"inspect": "<episode>@<step>", "model": <round> | <draft> }   what a model (without "model": your latest) answered at that point, part by part - and the colony layer that came next'],
      [['measure'], '  {"measure": {"source": "(p) => ...", "range": [min, max]}, "on": ["<episode>@<step>", ...]}'],
      [['table'], '  {"table": {"source": "(p) => ...", "range": [min, max]}, "on": "episodes" | "checks"}   the points of your own episodes, or of the checks, each with the value of the code and the colony layer that came next there']
    ]
  };
}

const platesWorld = (): World<PlatesPoint, never> => ({
  id: 'plates@1', actors: ['nature'],
  initial: () => { throw new Error('plates@1 has no initial state here: points come from episodes'); },
  toMove: () => 'nature', actions: () => [], step: (s) => s,
  outcome: () => ({ over: false, winner: null, reason: null }),
  key: (s) => hashString(JSON.stringify(s.frames[s.frames.length - 1])),
  view: () => ({ entities: [], scalars: {} }), describeRules: () => '', actionKey: () => ''
});

export const platesLab: Lab<PlatesSpec, PlatesPoint, Segment<PlatesFrame>, PlatesCase, PlatesAct> = {
  id: 'plates@1',
  about: 'A living world: System 2 acts in one plate of wells that goes on, perceives its colonies, nutrients and marks, and must write a model that answers the next colony layer.',
  options: [
    { name: 'interval', default: '3', help: 'ticks per window: how often the researcher decides' },
    { name: 'horizon', default: '600', help: 'the tick the world ends at' },
    { name: 'window-calls', default: '4', help: 'answers of the researcher without an act or a wait in one window, before the window goes on without it' },
    { name: 'window-intents', default: '4', help: 'acts in one batch' },
    { name: 'acts', default: '4', help: 'acts and waits per round' },
    { name: 'actor', default: 'researcher', help: 'the id of the researcher in the world (as a manifest names it)' },
    { name: 'actions', default: '*', help: 'the actions it may take, comma-separated ("*": the defaults of the world; "none": none)' },
    { name: 'messages', default: '0', help: 'messages a member may publish in one window, in a shared session (0: none)' },
    { name: 'message-chars', default: '600', help: 'the size of the words of a message, in characters' },
    { name: 'delivery', default: '8', help: 'messages delivered with one decision; the rest wait, read by cursor' },
    { name: 'tick-ms', default: '0', help: 'the world in real time: how long a tick lasts by the wall clock (0: simulated - a window waits for its members)' },
    { name: 'members', default: '0', help: 'members of the world at once (0: those declared, and one more where a shared branch is allowed)' },
    { name: 'branches', default: 'isolated', help: 'the modes of a branch the run allows: isolated, shared, or both (comma-separated)' },
    { name: 'fork', default: '', help: 'an isolated realization: the snapshot file of the world it starts from (a branch of a living world)' },
    { name: 'fork-randomness', default: 'fresh', help: '"same": its chance as the world it was forked from; "fresh": a stream of its own' },
    { name: 'window-ms', default: '0', help: 'wall time a window waits for its researchers once one sealed (0: it waits for every one)' }
  ],
  generate: (seed, o) => ({ seed, laws: platesLaws(seed), layout: seed, interval: Number(o.interval), horizon: Number(o.horizon), calls: Number(o['window-calls']), intents: Number(o['window-intents']),
    tickMs: Number(o['tick-ms'] ?? 0), members: Number(o.members ?? 0), shared: String(o.branches ?? '').split(',').map((x) => x.trim()).includes('shared'),
    fork: String(o.fork ?? ''), forkRandomness: o['fork-randomness'] === 'same' ? 'same' as const : 'fresh' as const,
    messages: Number(o.messages ?? 0), messageChars: Number(o['message-chars'] ?? 600), delivery: Number(o.delivery ?? 8), windowMs: Number(o['window-ms'] ?? 0) }),
  placeOf: (spec, index) => ({ ...spec, layout: spec.seed * 1000 + index }),
  runName: (seed) => 'plates-s' + seed,
  headline: (spec) => 'grows every ' + spec.laws.grow_every + ' tick(s), seeds at ' + spec.laws.seed_at + ' (window ' + spec.interval + ' ticks, horizon ' + spec.horizon + ')',
  placeInfo: (spec) => ({ layout: spec.layout }),
  truth: (spec) => [
    { id: 'growth', statement: 'A colony in a well with nutrient grows by one ' + (spec.laws.grow_every === 1 ? 'every tick' : 'on every tick whose number is a multiple of ' + spec.laws.grow_every) + ' (up to 9), eating one unit of nutrient when it grows.' },
    { id: 'starving', statement: 'A colony in a well without nutrient shrinks by one each tick.' },
    { id: 'seeding', statement: 'An empty well with nutrient next to (same row or column) a colony of at least ' + spec.laws.seed_at + ' starts a colony of 1.' },
    { id: 'contamination', statement: 'Some wells are contaminated, which is not perceived: there a colony falls by two each tick, never grows and is never seeded; cleaning ends it.' },
    { id: 'marks', statement: 'The marks have no effect on anything.' }
  ],
  explorationSeed: (seed) => seed,

  world: platesWorld,
  perceive: (p) => ({ frames: p.frames.map((f) => ({ ...f })) }),
  perceptDoc: PLATES_PERCEPT_DOC,
  interface: (o) => platesInterface({ interval: Number(o.world?.interval ?? 3), calls: Number(o.world?.['window-calls'] ?? 4), peers: ((o.world as { __peers?: string[] } | undefined)?.__peers ?? []),
    caps: (o.world as { __caps?: { watchers: number; wake: string[]; signals: string[]; requests: string[] } } | undefined)?.__caps }),

  /* An episode outside the shared world: a reserved realization (the default of a check). */
  episode: (spec, rnd) => segmentOf('reserved:' + spec.layout, reservedRun(spec.laws, Math.floor(rnd() * 2 ** 31), CHECK_TICKS)),
  checkEpisodes: (spec, c, ctx) => Array.from({ length: ctx.checkEpisodes }, (_, k) => {
    const key = c.purpose + '|' + c.round + '|' + c.index + '|' + (c.set ?? 0) + '|' + k;
    return segmentOf('reserved:' + key, reservedRun(spec.laws, reservedLayout(spec, key), CHECK_TICKS));
  }),
  steps: (seg) => seg.frames.length - 1,
  indexInfo: (seg) => ({ ticks: [seg.from, seg.to], ...(seg.session.startsWith('reserved:') ? { realization: 'reserved' } : { world: 'shared', window: seg.window }) }),
  explored: (seg) => ({ session: seg.session, from: seg.from, to: seg.to, frames: seg.frames }),
  at: (seg, step) => (step >= 0 && step < seg.frames.length ? { state: { frames: seg.frames.slice(0, step + 1) }, shown: { the_next_colony_was: seg.frames[step + 1]?.colony ?? null } } : null),
  /* Every `every`-th step from the first with a frame before it: a point needs where it came from. */
  cases: (_spec, id, seg, every) => Array.from({ length: seg.frames.length - 1 }, (_, t) => t).filter((t) => t >= 1 && (t - 1) % every === 0)
    .map((t) => ({ point: id + '@' + t, state: { frames: seg.frames.slice(0, t + 1) }, next: seg.frames[t + 1].colony })),
  ownEvery: 1,
  view: (seg, from, to) => ({ steps: seg.frames.length - 1, ticks: [seg.from, seg.to], frames: seg.frames.slice(from, Math.min(to, from + 59) + 1).map((f, i) => ({ step: from + i, ...f })) }),
  shown: (c) => ({ the_next_colony_was: c.next }),

  act: {
    parse: (raw) => {
      const unknown = unknownFields(raw, ['feed', 'inoculate', 'clean', 'amount']);
      if (unknown) return unknown;
      const kinds = (['feed', 'inoculate', 'clean'] as const).filter((k) => k in raw);
      if (kinds.length !== 1) return 'an act is one of {"feed": "<well>", "amount": <1..5>}, {"inoculate": "<well>"}, {"clean": "<well>"}';
      const kind = kinds[0];
      if (typeof raw[kind] !== 'string' || wellIndex({ rows: 8, cols: 9 }, raw[kind]) === null) return kind + ' names a well (e.g. "B4")';
      if (kind === 'feed') return Number.isInteger(raw.amount) ? { kind, well: String(raw[kind]).toUpperCase(), amount: Number(raw.amount) } : 'feed asks for "amount": a whole number from 1 to 5';
      return 'amount' in raw ? '"amount" goes with feed only' : { kind, well: String(raw[kind]).toUpperCase() };
    },
    place: () => undefined,
    start: () => { throw new Error('plates@1 is a living world: its acts are intents of its session, never episodes started afresh'); },
    shown: (seg) => ({ ticks: [seg.from, seg.to], frames: seg.frames }),
    asWritten: (a) => (a.kind === 'feed' ? { feed: a.well, amount: a.amount } : { [a.kind]: a.well }),
    examples: () => [{ feed: 'A1', amount: 1 }, { inoculate: 'A1' }, { clean: 'A1' }]
  },
  living: {
    open: (spec, o) => new LivingSession({ adapter: platesAdapter as never, id: 'world:plates-s' + spec.seed + (spec.fork ? '/fork' : ''), config: { layout: spec.layout }, seed: spec.seed, actors: o.actors,
      /* A branch's: the world as it was when it was asked for, never a plate made afresh. */
      ...(spec.fork ? { fork: (() => { const f = JSON.parse(fs.readFileSync(spec.fork, 'utf8')); return { snapshot: f.snapshot, randomness: spec.forkRandomness ?? 'fresh', from: f.from }; })() } : {}),
      clock: { decision_interval: spec.interval, horizon: spec.horizon, ...(spec.tickMs ? { mode: 'realtime' as const, tick_ms: spec.tickMs } : {}) }, journal: o.journal,
      limits: { calls_per_window: spec.calls, intents_per_window: spec.intents, actors: spec.members ? spec.members : o.actors.length + (spec.shared ? 1 : 0), ...(spec.messages > 0 ? { messages_per_window: spec.messages, message_chars: spec.messageChars, delivery_per_decision: spec.delivery } : {}),
        ...(spec.windowMs > 0 ? { window_ms: spec.windowMs } : {}), ...(o.limits ?? {}) }, ...(o.events ?? {}) }),
    intent: (a) => ({ kind: a.kind, params: { well: a.well, ...(a.amount !== undefined ? { amount: a.amount } : {}) } }),
    adapter: platesAdapter as never
  },

  objective: (host) => platesObjective({ casesIn: (p, c) => host.casesIn(p as never, c) as never, answer: (m, s) => host.answer(m, s) }),
  answerIssue: (a) => (typeof a === 'string' && /^[0-9/]+$/.test(a.trim()) ? null : 'the answer must be a colony layer: rows of digits joined by "/" (it was ' + JSON.stringify(a)?.slice(0, 60) + ')'),
  agrees: (a, c) => wellsDiffering(a, c.next)?.length === 0,
  agreement: 'exact',
  baselines: () => [
    { name: 'the same colonies again', source: '(p) => p.frames[p.frames.length - 1].colony' },
    { name: 'no colony anywhere', source: '(p) => p.frames[p.frames.length - 1].colony.replace(/[0-9]/g, "0")' }
  ],
  grading: { system: ruleGradingSystem(
    'of a plate of wells it could only perceive as layers of digits (colonies, nutrients) and marks',
    'Read its model as code: what its observations, rules and output compute is what it claims.') }
};
