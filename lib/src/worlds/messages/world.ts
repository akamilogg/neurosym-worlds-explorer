import { hashString } from '../../core/hash.ts';
import type { World } from '../../core/types.ts';
import { mulberry32 } from '../grid/gen.ts';

/* ============================================================================
 * messages@1: a world whose percept is TEXT - built to put the Judge to the test (H3,
 * SPEC-OBJETIVO §8). In the other worlds everything perceived is formal (symbols, numbers),
 * so exact code does all the work and the Judge's rules stay decorative. Here each point
 * is a short message written in varied words, and the environment gives each a MARK, 0 or
 * 1, by a hidden rule over what the message SAYS:
 *
 *   big   it asks for at least k items          (a number in digits, words or idioms)
 *   pos   its writer is pleased                  (plain words, negations, idioms)
 *   urg   it asks for haste                      (plain words or idioms)
 *
 * The rule is a boolean formula over those three, and k, both drawn per seed. Sentences
 * come in any order, among distractors that also carry numbers.
 *
 * The FAMILY keeps the rule and changes the WORDING: the laboratory writes plainly (digits,
 * plain adjectives); places of the family use held-out phrasings (number words and idioms,
 * negated and idiomatic moods, other nouns and sentence shapes). Code written against the
 * laboratory's wording breaks there; a reader of meaning does not. Whether the learner
 * hands meaning to the Judge, and whether that is what carries its model, is what the
 * operator measures (the flat-judge ablation). Nothing here is told to the learner.
 * ========================================================================== */

export type Pool = 'plain' | 'varied';

export interface MessagesSpec {
  readonly id: string;
  readonly seed: number;
  /** Index into RULES. */
  readonly rule: number;
  /** "big" means at least this many items. */
  readonly k: number;
  /** The wordings a place writes with. */
  readonly pools: readonly Pool[];
  /** Distractor sentences per message, at most. */
  readonly distractors: number;
  /** Messages per episode. */
  readonly steps: number;
}

export interface Latent { readonly n: number; readonly pos: boolean; readonly urg: boolean }

type Pred = (x: { big: boolean; pos: boolean; urg: boolean }) => boolean;
/** The hidden rules, and how the operator's grader reads them. */
export const RULES: readonly { readonly holds: Pred; readonly words: string }[] = [
  { holds: (x) => x.big && x.pos, words: 'it asks for at least K items AND its writer is pleased' },
  { holds: (x) => (x.big && x.pos) || x.urg, words: 'it asks for haste, OR it asks for at least K items and its writer is pleased' },
  { holds: (x) => x.pos && !x.urg, words: 'its writer is pleased AND it does not ask for haste (the number of items does not matter)' },
  { holds: (x) => (x.big || x.urg) && x.pos, words: 'its writer is pleased AND (it asks for at least K items OR it asks for haste)' },
  { holds: (x) => x.urg && !x.big, words: 'it asks for haste AND for fewer than K items (the writer\'s mood does not matter)' },
  { holds: (x) => x.big !== x.pos, words: 'exactly one of these holds: it asks for at least K items; its writer is pleased' }
];

export const markOf = (spec: Pick<MessagesSpec, 'rule' | 'k'>, x: Latent): 0 | 1 => (RULES[spec.rule].holds({ big: x.n >= spec.k, pos: x.pos, urg: x.urg }) ? 1 : 0);

export function drawLatent(rnd: () => number): Latent {
  return { n: 1 + Math.floor(rnd() * 12), pos: rnd() < 0.5, urg: rnd() < 0.4 };
}

export function generateMessages(seed: number): MessagesSpec {
  const rnd = mulberry32(seed * 6151 + 17);
  for (let tries = 0; tries < 200; tries++) {
    const rule = Math.floor(rnd() * RULES.length), k = 4 + Math.floor(rnd() * 6);
    /* Marks must be mixed (neither nearly all 0 nor nearly all 1), so that knowing nothing cannot hold. */
    const check = mulberry32(seed * 31 + tries);
    let ones = 0;
    for (let i = 0; i < 400; i++) ones += markOf({ rule, k }, drawLatent(check));
    if (ones / 400 >= 0.3 && ones / 400 <= 0.7) return { id: 'messages@1:s' + seed, seed, rule, k, pools: ['plain'], distractors: 1, steps: 12 };
  }
  throw new Error('no balanced rule for seed ' + seed);
}

/** Place `index` of the family (index 0 is the laboratory): the same rule and k, other wordings. */
export function placeOf(base: MessagesSpec, index: number): MessagesSpec {
  if (index === 0) return base;
  const pools: Pool[][] = [['plain', 'varied'], ['varied'], ['varied']];
  return { ...base, pools: pools[(index - 1) % pools.length], distractors: 1 + ((index + base.seed) % 2) };
}

/* --- The wordings ------------------------------------------------------------------------ */

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const IDIOMS: Readonly<Record<number, readonly string[]>> = { 1: ['a single'], 2: ['a pair of', 'a couple of'], 3: ['a trio of'], 6: ['half a dozen'], 12: ['a dozen'] };

interface Wording {
  readonly count: (n: number, r: () => number) => string;
  readonly nouns: readonly (readonly [string, string])[];
  readonly items: readonly string[];
  readonly pleased: readonly string[];
  readonly displeased: readonly string[];
  readonly hasty: readonly string[];
  readonly calm: readonly string[];
  readonly distractors: readonly ((r: () => number) => string)[];
}

const pick = <T>(xs: readonly T[], r: () => number): T => xs[Math.floor(r() * xs.length)];
const NAMES = ['Ana', 'Luis', 'Mei', 'Omar', 'Ines', 'Tomas'];

const WORDINGS: Readonly<Record<Pool, Wording>> = {
  plain: {
    count: (n) => String(n),
    nouns: [['box', 'boxes'], ['crate', 'crates'], ['parcel', 'parcels']],
    items: ['I need {c} {noun}.', 'Please send {c} {noun}.', 'We want {c} {noun}.'],
    pleased: ['I am pleased with your service.', 'This is great news.', 'We are delighted.', 'I am happy with the last order.'],
    displeased: ['I am unhappy with your service.', 'This is disappointing.', 'We are annoyed.', 'I am upset about the last order.'],
    hasty: ['It is urgent.', 'Please send them today.', 'We need them immediately.'],
    calm: ['There is no rush.', 'Send them whenever you can.', 'Any day next month is fine.'],
    distractors: [(r) => 'My desk is on floor ' + (1 + Math.floor(r() * 9)) + '.', (r) => 'My order number is ' + (100 + Math.floor(r() * 900)) + '.',
      (r) => 'Say hi to ' + pick(NAMES, r) + '.', (r) => 'It is ' + pick(['cloudy', 'sunny', 'windy'], r) + ' here today.']
  },
  varied: {
    count: (n, r) => (IDIOMS[n] && r() < 0.7 ? pick(IDIOMS[n], r) : NUMBER_WORDS[n]),
    nouns: [['package', 'packages'], ['carton', 'cartons'], ['bundle', 'bundles'], ['sack', 'sacks']],
    items: ['Could you get {c} {noun} ready for us?', '{C} {noun} is what we are after.', 'Put aside {c} {noun}, if you would.', 'Our list says {c} {noun}.'],
    pleased: ['Honestly, we could not be happier.', 'I am not unhappy at all.', 'Far from disappointed, we are thrilled.', 'Your team has outdone itself.'],
    displeased: ['We are hardly pleased.', 'Frankly, I am fed up.', 'This is less than satisfying.', 'Not thrilled, to be honest.'],
    hasty: ['Time is of the essence.', 'We needed these yesterday.', 'Without delay, please.', 'Every hour counts.'],
    calm: ['Take your time.', 'There is no hurry at all.', 'At your leisure.', 'Whenever suits you is fine.'],
    distractors: [(r) => 'Room ' + NUMBER_WORDS[2 + Math.floor(r() * 10)] + ' is where I sit.', (r) => 'We opened ' + NUMBER_WORDS[3 + Math.floor(r() * 9)] + ' years ago.',
      (r) => pick(NAMES, r) + ' sends regards.', (r) => 'Our cat, ' + pick(['Pip', 'Moss', 'Tofu'], r) + ', says hello.']
  }
};

/** A message saying what `x` is, in one of the place's wordings. */
export function renderMessage(spec: MessagesSpec, x: Latent, r: () => number): string {
  const w = WORDINGS[pick(spec.pools, r)];
  const [one, many] = pick(w.nouns, r);
  const c = w.count(x.n, r);
  const noun = x.n === 1 ? one : many;
  const item = pick(w.items, r).replace('{c}', c).replace('{C}', c[0].toUpperCase() + c.slice(1)).replace('{noun}', noun);
  const sentences = [item, pick(x.pos ? w.pleased : w.displeased, r), pick(x.urg ? w.hasty : w.calm, r)];
  const d = Math.floor(r() * (spec.distractors + 1));
  for (let i = 0; i < d; i++) sentences.push(pick(w.distractors, r)(r));
  for (let i = sentences.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [sentences[i], sentences[j]] = [sentences[j], sentences[i]]; }
  return sentences.join(' ');
}

/** An episode: `spec.steps` messages, each with its mark. */
export function runEpisode(spec: MessagesSpec, r: () => number): { texts: string[]; marks: (0 | 1)[] } {
  const texts: string[] = [], marks: (0 | 1)[] = [];
  for (let t = 0; t < spec.steps; t++) { const x = drawLatent(r); texts.push(renderMessage(spec, x, r)); marks.push(markOf(spec, x)); }
  return { texts, marks };
}

/* --- What the learner perceives at a point ------------------------------------------ */

export interface MessagePoint { readonly text: string }

export const MESSAGES_PERCEPT_DOC = 'At a point of an episode your code receives p = { text }: `p.text` is what was perceived at that step, a text.';

export const perceiveMessage = (point: MessagePoint): { text: string } => ({ text: point.text });

export function messagesPointWorld(): World<MessagePoint, never> {
  return {
    id: 'messages@1',
    actors: ['nature'],
    initial: () => { throw new Error('messages@1 has no initial state: points come from episodes'); },
    toMove: () => 'nature',
    actions: () => [],
    step: (s) => s,
    outcome: () => ({ over: false, winner: null, reason: null }),
    key: (s) => hashString(s.text),
    view: () => ({ entities: [], scalars: {} }),
    describeRules: () => '',
    actionKey: () => ''
  };
}

/* --- Operator only ----------------------------------------------------------------------- */

export function describeMessagesTruth(spec: MessagesSpec): { id: string; statement: string }[] {
  return [
    { id: 'factors', statement: 'The mark depends only on what the message says about three things: how many items it asks for, whether its writer is pleased, and whether it asks for haste - not on its wording, its other sentences or their order.' },
    { id: 'threshold', statement: 'What matters about the number of items is whether it is at least ' + spec.k + ', whether it is written in digits, words or an idiom such as "half a dozen".' },
    { id: 'rule', statement: 'The mark is 1 exactly when ' + RULES[spec.rule].words.replace('K', String(spec.k)) + '; otherwise it is 0.' },
    { id: 'meaning', statement: 'Mood and haste are read by meaning, including negations and idioms ("not unhappy at all" is pleased; "take your time" is not hasty).' }
  ];
}
