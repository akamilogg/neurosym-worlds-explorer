import test from 'node:test';
import assert from 'node:assert/strict';
import { RULES, drawLatent, generateMessages, markOf, placeOf, renderMessage, runEpisode, describeMessagesTruth } from '../src/worlds/messages/world.ts';
import { messagesObjective, sideOf, MESSAGES_ANSWER, messagesVerdict } from '../src/worlds/messages/objective.ts';
import { messagesInterface } from '../src/worlds/messages/interface.ts';
import { system2Prompt } from '../src/learn/prompt.ts';
import { mulberry32 } from '../src/worlds/grid/gen.ts';
import type { Place } from '../src/learn/objective.ts';

/* messages@1: text percepts, a hidden rule over what they say; the family changes the wording, not the rule. */

test('marks are mixed and follow the hidden rule over the three things a message says', () => {
  for (let s = 1; s <= 8; s++) {
    const spec = generateMessages(s);
    const r = mulberry32(s);
    let ones = 0;
    for (let i = 0; i < 300; i++) ones += markOf(spec, drawLatent(r));
    assert.ok(ones > 60 && ones < 240, 'seed ' + s + ': ' + ones + '/300');
  }
  const spec = { ...generateMessages(1), rule: 0, k: 5 };
  assert.equal(RULES.length, 6);
  assert.equal(markOf(spec, { n: 5, pos: true, urg: false }), 1);
  assert.equal(markOf(spec, { n: 4, pos: true, urg: false }), 0);
  assert.equal(markOf(spec, { n: 9, pos: false, urg: true }), 0);
  assert.match(describeMessagesTruth(spec)[2].statement, /at least 5 items AND its writer is pleased/);
});

test('the laboratory writes plainly; the family keeps the rule and uses other wordings', () => {
  const spec = generateMessages(1);
  const plain = renderMessage(spec, { n: 6, pos: true, urg: true }, mulberry32(1));
  assert.match(plain, /\b6\b/, 'digits in the laboratory');
  const varied = placeOf(spec, 2);
  assert.deepEqual(varied.pools, ['varied']);
  assert.equal(varied.rule, spec.rule);
  assert.equal(varied.k, spec.k);
  const texts = runEpisode(varied, mulberry32(9)).texts.join(' ');
  assert.doesNotMatch(texts.replace(/\b(Room|years)\b[^.]*\./g, ''), /\b\d+\b/, 'no digits in the held-out wording');
  const e = runEpisode(spec, mulberry32(4));
  assert.equal(e.texts.length, spec.steps);
  assert.ok(e.marks.every((m) => m === 0 || m === 1));
});

test('the verdict: the mark and whether the answer was on its side; one miss is allowed', async () => {
  assert.equal(sideOf(0.5), 1);
  assert.equal(sideOf(0.49), 0);
  assert.equal(sideOf('1'), null);
  const lab: Place = { id: 'lab1', role: 'laboratory', seen: true };
  const cases = [0, 1, 1, 0].map((mark, i) => ({ point: 'e@' + i, state: { text: 't' + i }, mark: mark as 0 | 1 }));
  const o = messagesObjective<(t: string) => unknown, Place>({ casesIn: () => cases, answer: async (m, s) => m(s.text) });
  const run = async (m: (t: string) => unknown) => (await o.run(m, [{ place: lab, cases }], { round: 1, attempt: 1, purpose: 'check' })).byPlace[0];
  const exact = await run((t) => [0, 1, 1, 0][Number(t.slice(1))]);
  const oneMiss = await run((t) => [1, 1, 1, 0][Number(t.slice(1))]);
  const twoMiss = await run(() => 1);
  assert.equal(o.holds(exact, { place: lab }), true);
  assert.equal(o.holds(oneMiss, { place: lab }), true);
  assert.equal(o.holds(twoMiss, { place: lab }), false);
  assert.deepEqual((o.view(await run(() => 'x'), lab).points as { not_a_number?: boolean }[])[0].not_a_number, true);
});

test('its interface is the common prompt\'s, with no word about what the texts are about', () => {
  const i = messagesInterface();
  assert.deepEqual(i.lines.slice(0, 3), [...MESSAGES_ANSWER.form, ...messagesVerdict()]);
  assert.ok(!i.tools.includes('act'));
  const text = system2Prompt(messagesInterface());
  for (const w of ['message', 'parcel', 'item', 'mood', 'haste', 'urgent', 'pleased', 'writer', 'customer']) assert.doesNotMatch(text, new RegExp('\\b' + w, 'i'), w);
});
