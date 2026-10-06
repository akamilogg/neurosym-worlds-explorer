import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { anomalyFile, holding, parseVerdict, placesQuestioned, readVerdicts, reportStates, runAnomalies, writeVerdict, type ReportRecord } from '../src/learn/anomalies.ts';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { labCli } from '../src/runtime/cli.ts';
import { send } from '../src/runtime/control.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';
import { generateCells } from '../src/worlds/cells/world.ts';
import { findingText } from '../src/learn/finding.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';

/* SPEC-CALIBRACION-INSTRUMENTOS §5 (A4): the life of an anomaly - questioned, the acceptance that waits, the operator's
   verdict - and `lab anomaly`. */

const report = (id: string, evidence: string[]): ReportRecord => ({ id, by: 'junior', what: 'w', evidence, kind: 'other' });
const placeOf = (ref: string): string | null => ({ ep1: 'lab1', act2: 'lab2', setup1: 'setup1' } as Record<string, string>)[ref] ?? null;

test('what a report questions: the places of the episodes it cites, or every place when it cites none; a world lifts it, a bug does not', () => {
  assert.deepEqual(placesQuestioned(report('ir1', ['ep1@4', 'act2', 'investigation:r2.1']), placeOf), ['lab1', 'lab2']);
  assert.equal(placesQuestioned(report('ir2', ['investigation:r2.1']), placeOf), 'all');
  const states = reportStates([report('ir1', ['ep1@4']), report('ir2', ['act2']), report('ir3', ['setup1'])],
    [{ report: 'ir1', verdict: 'world' }, { report: 'ir2', verdict: 'unclear' }, { report: 'ir3', verdict: 'world' }, { report: 'ir3', verdict: 'bug' }]);
  assert.deepEqual(states.map((s) => s.state), ['world', 'unclear', 'bug'], 'the latest verdict counts');
  assert.deepEqual(holding(states, ['lab1', 'lab2', 'setup1'], placeOf), ['ir2', 'ir3']);
  assert.deepEqual(holding(states, ['lab1'], placeOf), []);
  assert.equal(typeof parseVerdict({ report: 'ir1', verdict: 'maybe' }), 'string');
});

/* --- A run whose model is right (cells level 4, the even layer under --focus even), and whose first proposal reports the
   instrument on ep1 (its laboratory). `verdict` is what the operator answers, and after which question. */
const SEED = 2;
function evenLayer(): string {
  const spec = generateCells(SEED, 4);
  const [g0, g1] = spec.glyphs, rule = spec.layers![0];
  return '(p) => { const row = p.rows[p.rows.length - 1].split(""); const n = row.length, out = row.slice();'
    + ' for (let i = 0; i < n; i += 2) { const v = (j) => row[((j % n) + n) % n] === ' + JSON.stringify(g1) + ' ? 1 : 0;'
    + ' const k = v(i - 2) * 4 + v(i) * 2 + v(i + 2); out[i] = ((' + rule + ' >> k) & 1) ? ' + JSON.stringify(g1) + ' : ' + JSON.stringify(g0) + '; }'
    + ' return out.join(""); }';
}
function system2(asked: Record<string, any>[], onAsk: (n: number) => void): FetchLike {
  const EVEN = evenLayer();
  let reported = false;
  return async (_url, init) => {
    const b = JSON.parse(String(init.body));
    const sys = b.messages[0].content as string;
    const user = sys.startsWith('You grade') ? {} : JSON.parse(userOf(b));
    if (!sys.startsWith('You grade')) { asked.push(user); onAsk(asked.length); }
    const proposal = { rationale: 'r', observations: {}, rules: {}, weights: {}, output: EVEN, validate: !reported, beliefs: [{ id: 'b', stance: 'new', statement: 's', evidence: ['ep1@2'] }], lessons: ['l'],
      ...(reported ? {} : { instrument_report: { what: 'ep1 shows a row no rule could give', evidence: ['ep1@3'], kind: 'impossible_value' } }) };
    const content = sys.startsWith('You grade') ? { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' }
      : 'task' in user ? { rationale: 'r', beliefs: [{ id: 'b', stance: 'confirm', why: 'w' }], lessons: ['l'], next_experiment: 'n' }
      : (reported = true, proposal);
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
}
const ARGS = ['--seed', String(SEED), '--level', '4', '--focus', 'even', '--researcher', 'assisted', '--flat', '--no-grade', '--no-reflection', '--validations', '4'];
const llm = { url: 'http://system2.test/chat', model: 'stand-in' };
const eventsOf = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8')).events as Record<string, any>[];

test('a confirmed model on a questioned laboratory waits; the operator finds it is the world: accepted as of its round, and the researcher told only that', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anomaly-'));
  const out = path.join(dir, 'run.json');
  const asked: Record<string, any>[] = [];
  const r = await runLaboratory(cellsLab, { args: [...ARGS, '--attempts', '4', '--out', out], root: dir, llm,
    fetch: system2(asked, (n) => { if (n === 2) writeVerdict(out, { report: 'ir1', verdict: 'world', text: 'the rows are right' }); }) });
  const events = eventsOf(out);
  const first = events.find((e) => e.type === 'check')!;
  assert.equal(first.accepted, false);
  assert.deepEqual(first.acceptance_held_for, ['ir1']);
  assert.match(JSON.stringify(asked[1]), /acceptance_waits/, 'the researcher is told its acceptance waits');
  assert.equal(r.stoppedBy, 'accepted');
  const verdict = events.find((e) => e.type === 'anomaly_verdict')!;
  assert.equal(verdict.verdict, 'world');
  const accepted = events.find((e) => e.type === 'accepted')!;
  assert.deepEqual(accepted.released_by, ['ir1']);
  assert.equal(r.finding.outcome.round, accepted.round);
  assert.doesNotMatch(JSON.stringify(asked), /the rows are right/, 'never the operator\'s note: only whether the instrument failed');
});

test('never answered: the run ends not accepted and says why; `lab anomaly` lists the report, and a bug is kept for the finding', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anomaly-'));
  fs.mkdirSync(path.join(dir, 'runs'));
  const out = path.join(dir, 'runs', 'never.json');
  /* Its senior's report reaches the run through its inbox (an agent's, whatever the run's policy): it cites nothing, so it
     questions every place. */
  send(out, { kind: 'instrument_report', what: 'the episodes repeat', evidence: [], report_kind: 'inconsistent_answer', by: 'agent:senior' });
  const r = await runLaboratory(cellsLab, { args: [...ARGS, '--attempts', '2', '--out', out], root: dir, llm, fetch: system2([], () => {}) });
  assert.equal(r.stoppedBy, 'budget');
  const end = eventsOf(out).find((e) => e.type === 'end')!;
  assert.deepEqual(end.instrument.reports.map((x: Record<string, unknown>) => [x.id, x.by, x.state]), [['ir-senior-1', 'senior', 'pending'], ['ir1', 'junior', 'pending']]);
  assert.deepEqual(end.instrument.acceptance_held.reports, ['ir-senior-1', 'ir1']);
  assert.match(findingText(r.finding), /NOT ACCEPTED/);
  const lines: string[] = [];
  assert.equal(await labCli(['anomaly', out], { root: dir, out: (l) => lines.push(l) }), 0);
  assert.match(lines.join('\n'), /^ir1 \[pending\] by junior/m);
  assert.equal(await labCli(['anomaly', out, 'ir9', 'bug'], { root: dir, out: () => {} }), 1, 'no such report');
  assert.equal(await labCli(['anomaly', out, 'ir1', 'maybe'], { root: dir, out: () => {} }), 2);
  assert.equal(await labCli(['anomaly', out, 'ir1', 'bug', 'the', 'echo', 'dropped', 'it'], { root: dir, out: () => {} }), 0);
  assert.deepEqual(readVerdicts(out).map((v) => [v.report, v.verdict, v.text]), [['ir1', 'bug', 'the echo dropped it']]);
  assert.equal(runAnomalies(out).find((x) => x.id === 'ir1')!.state, 'bug');
  assert.ok(fs.existsSync(anomalyFile(out)));
});

test('a fault of the instrument: the waiting acceptance is void, and nothing through its place is accepted again in the run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anomaly-'));
  const out = path.join(dir, 'run.json');
  const asked: Record<string, any>[] = [];
  const r = await runLaboratory(cellsLab, { args: [...ARGS, '--attempts', '4', '--out', out], root: dir, llm,
    fetch: system2(asked, (n) => { if (n === 2) writeVerdict(out, { report: 'ir1', verdict: 'bug', text: 'the echo dropped it' }); }) });
  const events = eventsOf(out);
  const told = JSON.stringify(asked.slice(2));
  assert.match(told, /it was a fault of the instrument/, 'the researcher is told, at its next question');
  assert.doesNotMatch(told, /the echo dropped it/, 'never the operator\'s note');
  assert.notEqual(r.stoppedBy, 'accepted');
  assert.ok(events.some((e) => e.type === 'acceptance_void'));
  assert.deepEqual(events.find((e) => e.type === 'anomaly_verdict')!.invalidated, ['ep1@3']);
});
