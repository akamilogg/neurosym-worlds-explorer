import test from 'node:test';
import assert from 'node:assert/strict';
import { lawFingerprint, normalizeCode } from '../src/learn/law-session.ts';
import type { Law } from '../src/core/predict.ts';

/* SPEC-CALIBRACION-INSTRUMENTOS §11.1: a model's fingerprint ignores the whitespace that does not change it (version 2);
   version 1, of the journals before, is the text as written. */

const law = (source: string, definition = 'the sum'): Law => ({ world: 'w', observations: { s: { definition, spec: { kind: 'code', source } } as never },
  rules: {}, weights: {}, output: { kind: 'code', lang: 'js', source: '(p, m) => m.observations.s' } } as unknown as Law);

test('whitespace outside literals does not change the code; words and literals keep what they say', () => {
  assert.equal(normalizeCode('(p) => {  return   p.a +  p.b ; }'), '(p)=>{return p.a+p.b;}');
  assert.equal(normalizeCode('a +  +b'), 'a+ +b', 'two signs that would join keep a space');
  assert.equal(normalizeCode("x = 'a  b'"), "x='a  b'", 'a string literal as written');
  assert.equal(normalizeCode('x = `a  ${ b }`'), 'x=`a  ${ b }`', 'a template literal as written');
  assert.equal(normalizeCode("x = 'it\\'s  ok'  ;"), "x='it\\'s  ok';", 'an escaped quote does not end it');
});

test('version 2: one space more is the same model; another literal or another word is not; version 1 tells them apart', () => {
  const a = law('(p) => [0.0692421/2.5, -0.274346][0] * p.x'), b = law('(p) => [0.0692421/2.5,-0.274346][0] * p.x');
  assert.equal(lawFingerprint(a), lawFingerprint(b));
  assert.notEqual(lawFingerprint(a, 1), lawFingerprint(b, 1));
  assert.equal(lawFingerprint(law('p => 1', 'the  sum ')), lawFingerprint(law('p => 1', 'the sum')), 'words: whitespace only');
  assert.notEqual(lawFingerprint(law("p => 'a b'")), lawFingerprint(law("p => 'a  b'")));
  assert.notEqual(lawFingerprint(law('p => 1', 'the sum')), lawFingerprint(law('p => 1', 'the difference')));
});

test('grader v2: a false belief is kept only with the learner\'s own words (SPEC-CALIBRACION-INSTRUMENTOS §11.2)', async () => {
  const { quotedFalseBeliefs, FALSE_BELIEF_RULE } = await import('../src/learn/operator.ts');
  assert.match(FALSE_BELIEF_RULE, /FORM of its model is not a claim/);
  const learner = { beliefs: [{ id: 'b1', statement: 'Steering is a continuous signal with no "regimes" at all.' }], notes: ['line one\nline two'] };
  const out = quotedFalseBeliefs([
    { claim: 'no regimes', quote: 'steering is a continuous signal with no regimes at all', contradicted_by: 'I2' },
    { claim: 'the model computes continuous outputs', contradicted_by: 'I2' },
    { claim: 'made up', quote: 'the worm swims backwards', contradicted_by: 'I3' },
    { claim: 'a line', quote: 'line one line two' }
  ], learner);
  assert.deepEqual(out.false_beliefs.map((b: any) => b.claim), ['no regimes', 'a line'], 'quotes found, case, quotes and line breaks aside');
  assert.deepEqual(out.false_beliefs_discarded.map((b: any) => b.claim), ['the model computes continuous outputs', 'made up']);
  assert.equal(out.grader_version, 2);
});
