import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { auditMethod } from '../src/audit/audit.ts';
import { agreement, kappa, labelPage, sample } from '../src/audit/calibration.ts';
import { labCli } from '../src/runtime/cli.ts';
import type { Judge } from '../src/core/types.ts';

/* SPEC-AUDITORIA-METODO MA4: a blind sample of what the Judge judged, labelled by the operator with the same texts and
   questions, and the agreement measured per question. */

const frames = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => ({ step: from + i, picture: 'board ' + (from + i) }));

function journal() {
  return {
    experiment: 'unknown-world@1', researcher: 'assisted', config: { seed: 22, llm_model: 'm' },
    hidden_from_the_learner: { truth: [{ id: 'moves', statement: 'SECRET-TRUTH' }] },
    events: [
      { type: 'exploration_game', game: 'g1', winner: 'B', plies: 8 },
      { type: 'investigation', round: 1, requests: [{ view: 'g1', from: 0, to: 3 }], results: [{ view: 'g1', frames: frames(0, 3) }] },
      { type: 'investigation', round: 1, requests: [{ act: 'g1@0', from: [0, 4], to: [1, 4] }, { act: 'g1@0', from: [0, 4], to: [2, 4] }],
        results: [{ act: 'g1@0', accepted: true, name: 'act1', picture: 'after' }, { act: 'g1@0', accepted: false }] },
      { type: 'proposal', round: 1, rationale: 'In round 1 investigation step 2 the long move was refused; g1@3 shows the end.', beliefs: [{ id: 'moves', stance: 'new', statement: 'one cell', evidence: ['g1@3'] }] },
      { type: 'check', round: 1, laboratories: [{ place: 'lab1', holds: false, wins: 3, total: 8 }] },
      { type: 'investigation', round: 2, requests: [{ replay: 'g1@0', formula: 1 }], results: [{ replay: 'g1@0', episode: 'g3', score: 1, steps: 6 }] },
      { type: 'proposal', round: 2, rationale: 'g3 won.', beliefs: [{ id: 'moves', stance: 'keep' }] },
      { type: 'end', stoppedBy: 'budget' }
    ]
  };
}

/** A Judge stand-in that always prefers the option given for each question. */
function judge(prefer: Record<string, string>): Judge & { id: string } {
  return { id: 'jev:stand-in', async judge(request) {
    return Object.fromEntries(Object.entries(request.questions).map(([id, rule]) => {
      const options = Object.keys(rule.criteria as Record<string, string>);
      const best = prefer[id] ?? options[0];
      return [id, { value: 0.8, confidence: 0.8, raw: { type: 'choice', probabilities: Object.fromEntries(options.map((o) => [o, o === best ? 0.8 : 0.2 / (options.length - 1)])) } }];
    }));
  } };
}

test('kappa: perfect agreement is 1, chance agreement is 0', () => {
  assert.equal(kappa([['a', 'a'], ['b', 'b'], ['a', 'a'], ['b', 'b']]), 1);
  assert.equal(kappa([['a', 'a'], ['a', 'b'], ['b', 'a'], ['b', 'b']]), 0);
  assert.equal(kappa([]), null);
});

test('a blind sample, a page to label it, and the agreement of the labels with the Judge per question', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calibration-'));
  fs.mkdirSync(path.join(dir, 'runs'));
  const file = path.join(dir, 'runs', 'run.json');
  fs.writeFileSync(file, JSON.stringify(journal()));
  await auditMethod(file, judge({ reading: 'overreads' }));
  /* The sample: every unit in turn, the reference case named first; no answer of the Judge in it, nothing hidden. */
  const labels = sample([file], { n: 4, seed: 7, references: ['r1.s2'] });
  assert.equal(labels.items[0].ref, 'r1.s2');
  assert.equal(labels.items[0].reference, true);
  assert.deepEqual(new Set(labels.items.map((i) => i.unit)), new Set(['experiment', 'observation', 'stretch']));
  assert.ok(!/SECRET|overreads".*0\.8|"p":/.test(JSON.stringify(labels.items.map((i) => ({ ...i, questions: {} })))), 'blind: no answers, nothing hidden');
  assert.deepEqual(sample([file], { n: 4, seed: 7, references: ['r1.s2'] }).items.map((i) => i.id), labels.items.map((i) => i.id), 'the same seed, the same sample');
  const page = labelPage(labels);
  assert.match(page, /Descargar etiquetas/);
  assert.ok(!/SECRET/.test(page));
  /* The operator labels: agrees with the Judge on purpose, disagrees on reading. */
  for (const item of labels.items) for (const [q, def] of Object.entries(item.questions)) item.operator[q] = q === 'reading' ? 'correct' : Object.keys(def.options)[0];
  const a = agreement(labels, () => file);
  assert.equal(a.labelled, 4);
  const reading = a.questions.find((q) => q.question === 'experiment.reading')!;
  assert.deepEqual([reading.n, reading.agreement, reading.confusion], [2, 0, { correct: { overreads: 2 } }]);
  assert.equal(reading.reading, 'too_few');
  assert.equal(a.questions.find((q) => q.question === 'experiment.purpose')!.agreement, 1);
  /* A run audited again after the sample: its items are left out, said so. */
  await new Promise((r) => setTimeout(r, 5));
  await auditMethod(file, judge({}));
  assert.equal(agreement(labels, () => file).stale.length, 4);
});

test('lab audit sample and lab audit agreement', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calibration-'));
  fs.mkdirSync(path.join(dir, 'runs'));
  const file = path.join(dir, 'runs', 'run.json');
  fs.writeFileSync(file, JSON.stringify(journal()));
  await auditMethod(file, judge({}));
  const lines: string[] = [];
  assert.equal(await labCli(['audit', 'sample', 'run', '--n', '3', '--out', path.join(dir, 'labels.json')], { root: dir, out: (l) => lines.push(l), env: {} }), 0);
  assert.ok(fs.existsSync(path.join(dir, 'labels.html')));
  const labels = JSON.parse(fs.readFileSync(path.join(dir, 'labels.json'), 'utf8'));
  for (const item of labels.items) for (const [q, def] of Object.entries(item.questions as Record<string, { options: Record<string, string> }>)) item.operator[q] = Object.keys(def.options)[0];
  fs.writeFileSync(path.join(dir, 'labels.json'), JSON.stringify(labels));
  assert.equal(await labCli(['audit', 'agreement', path.join(dir, 'labels.json')], { root: dir, out: (l) => lines.push(l), env: {} }), 0);
  assert.match(lines.join('\n'), /3 items labelled/);
  assert.ok(fs.existsSync(path.join(dir, 'labels.agreement.json')));
});
