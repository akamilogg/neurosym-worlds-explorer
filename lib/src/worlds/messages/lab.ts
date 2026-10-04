import { ruleGradingSystem, type Lab } from '../../learn/lab.ts';
import { MESSAGES_PERCEPT_DOC, describeMessagesTruth, generateMessages, messagesPointWorld, perceiveMessage, placeOf, runEpisode, type MessagePoint, type MessagesSpec } from './world.ts';
import { messagesObjective, sideOf, type MessagesCase } from './objective.ts';
import { messagesInterface } from './interface.ts';

/* messages@1 as a LABORATORY (SPEC-OBJETIVO O9): a world whose percept is TEXT - the test of the Judge (H3). System 2
   perceives short messages and the mark the environment gave each (0 or 1), and must write a model that answers the
   mark. The laboratory writes plainly; the places of the family use other wordings. There is no act: the environment
   writes the texts. */

type Episode = { readonly texts: string[]; readonly marks: (0 | 1)[] };

export const messagesLab: Lab<MessagesSpec, MessagePoint, Episode, MessagesCase> = {
  id: 'messages@1',
  about: 'System 2 perceives short messages and the mark the environment gave each (0 or 1), and must write a model that answers the mark. '
    + "The laboratory writes plainly; the places of the family use other wordings, so code written against the laboratory's words breaks there and a reader of meaning does not.",
  options: [{ name: 'tolerance', default: '1', help: 'misses allowed in a place for the model to hold there' }],
  defaults: { every: '1' },
  generate: (seed) => generateMessages(seed),
  placeOf,
  teams: true,
  runName: (seed) => 'messages-s' + seed,
  headline: (spec) => '(rule ' + spec.rule + ', k ' + spec.k + ')',
  placeInfo: (spec) => ({ pools: spec.pools }),
  truth: describeMessagesTruth,
  explorationSeed: (seed) => seed * 1013 + 7,

  world: messagesPointWorld,
  perceive: perceiveMessage,
  perceptDoc: MESSAGES_PERCEPT_DOC,
  interface: messagesInterface,

  episode: (spec, rnd) => runEpisode(spec, rnd),
  steps: (e) => e.texts.length,
  explored: (e) => ({ messages: e.texts.map((text, step) => ({ step, text, mark: e.marks[step] })) }),
  at: (e, step) => (step >= 0 && step < e.texts.length ? { state: { text: e.texts[step] }, shown: { the_mark_was: e.marks[step] } } : null),
  cases: (_base, id, e, every) => e.texts.map((text, t): MessagesCase => ({ point: id + '@' + t, state: { text }, mark: e.marks[t] })).filter((_, t) => t % every === 0),
  ownEvery: 1,
  view: (e, from, to) => {
    const last = Math.min(to, from + 29);
    return { steps: e.texts.length, messages: e.texts.slice(from, last + 1).map((text, i) => ({ step: from + i, text, mark: e.marks[from + i] })) };
  },
  shown: (c) => ({ mark: c.mark }),

  objective: (host, o) => messagesObjective({ ...host, tolerance: Math.max(0, Number(o.tolerance)) }),
  answerIssue: (a) => (sideOf(a) === null ? 'the answer must be a number (it was ' + JSON.stringify(a)?.slice(0, 60) + ')' : null),
  agrees: (a, c) => sideOf(a) === c.mark,
  agreement: 'agreed',
  baselines: () => [{ name: 'always 0', source: '(p) => 0' }, { name: 'always 1', source: '(p) => 1' }],
  grading: { system: ruleGradingSystem(
    'by which an environment marks short texts 0 or 1; the learner saw only the texts and their marks',
    'Read its model as code and as the questions its rules ask a judge: what its observations, rules and output compute is what it claims.') }
};
