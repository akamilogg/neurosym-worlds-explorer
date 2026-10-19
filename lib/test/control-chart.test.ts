import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { controlCharts } from '../src/orchestra/control-chart.ts';

/* SPEC-CONTROL-ARNES K5 (§6.3): a control chart only where a group has gathered enough comparable runs and its assumptions are
   checked - said one by one; its signals are indications of a special cause to investigate, never a diagnosis; no label of
   control is ever given. */

/** A batch of runs of one condition, written as their records would be: `accepted[i]` and `tokens[i]` for its i-th run. */
function batch(dir: string, id: string, day: number, accepted: boolean[], o: { tokens?: number[]; seeds?: number[] } = {}): string {
  const runs = accepted.map((a, i) => {
    const journal = path.join(dir, id + '-' + i + '.json');
    fs.writeFileSync(journal, JSON.stringify({ experiment: 'cells@1', config: { seed: o.seeds?.[i] ?? i + 1, level: 1, llm_model: 'm' }, events: [{ t: 10, type: 'end', stoppedBy: 'budget' }] }));
    fs.writeFileSync(journal.replace(/\.json$/, '.finding.json'), JSON.stringify({ outcome: { status: a ? 'accepted' : 'budget' }, cost: { total: { llm_tokens: o.tokens?.[i] ?? 1000 } } }));
    return { id: 'r' + i, condition: 'c', journal };
  });
  const file = path.join(dir, id + '.batch.json');
  fs.writeFileSync(file, JSON.stringify({ format: 'batch@1', id, started: new Date(Date.UTC(2026, 9, day)).toISOString(), definition: { id, runs: runs.map((r) => ({ id: r.id, condition: 'c', lab: 'cells' })) }, runs }));
  return file;
}
const half = (shift = 0, n = 12) => Array.from({ length: n }, (_, i) => (i + shift) % 2 === 0);

test('fewer comparable subgroups than asked, or runs not independent: no chart, the assumption that fails said', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'control-few-'));
  const few = Array.from({ length: 5 }, (_, d) => batch(dir, 'b' + d, d + 1, half(d)));
  const [c] = controlCharts(few, { condition: 'c' }) as Record<string, any>[];
  assert.equal(c.chart, null);
  assert.deepEqual(c.assumptions.find((a: any) => a.assumption === 'enough comparable subgroups').holds, false);
  assert.match(c.reading, /description of §6.2, no chart/);
  const same = Array.from({ length: 22 }, (_, d) => batch(dir, 's' + d, d + 1, half(d), { seeds: Array(12).fill(7) }));
  const [s] = controlCharts(same, { condition: 'c' }) as Record<string, any>[];
  assert.equal(s.assumptions.find((a: any) => a.assumption === 'independence between runs').holds, false, 'the same seed ten times in a batch');
  assert.equal(s.chart, null);
});

test('a p chart: its assumptions checked, a batch beyond its limit an indication to investigate - no label of control', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'control-p-'));
  /* Batches of 12 runs, 5 or 7 accepted in turn - around their centre - and then one with none. */
  const some = (k: number) => Array.from({ length: 12 }, (_, i) => i < k);
  const files = [...Array.from({ length: 21 }, (_, d) => batch(dir, 'b' + String(d).padStart(2, '0'), d + 1, some(d % 2 ? 7 : 5))), batch(dir, 'b21', 25, Array(12).fill(false))];
  const [c] = controlCharts(files, { condition: 'c' }) as Record<string, any>[];
  assert.ok(c.assumptions.every((a: any) => a.holds !== false), JSON.stringify(c.assumptions));
  assert.equal(c.assumptions.find((a: any) => a.assumption === 'a stable probability').holds, 'assumed');
  assert.equal(c.chart.kind, 'p chart');
  assert.equal(c.chart.points.length, 22);
  assert.deepEqual(c.signals.map((s: any) => [s.at, s.rule]), [['b21', 'beyond a limit (3 sigma)']]);
  assert.match(c.signals[0].reading, /to investigate - not a diagnosis/);
  assert.ok(!/in control|out of control/i.test(JSON.stringify(c)));
  /* Every batch at 6 of 12, then one with none: the centre falls below all the others - eight in a row on one side. */
  const shifted = [...Array.from({ length: 21 }, (_, d) => batch(dir, 'h' + String(d).padStart(2, '0'), d + 1, some(6))), batch(dir, 'h21', 25, Array(12).fill(false))];
  const [h] = controlCharts(shifted, { condition: 'c' }) as Record<string, any>[];
  assert.ok(h.signals.some((x: any) => x.rule === 'eight in a row on one side of the centre' && x.at === 'h07'), JSON.stringify(h.signals));
});

test('an individuals chart for a continuous result, its runs in the order they ran', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'control-x-'));
  const files = Array.from({ length: 6 }, (_, d) => batch(dir, 'b' + d, d + 1, half(d).slice(0, 4), { tokens: d === 5 ? [1000, 1010, 9000, 990] : [1000 + d * 3, 1005, 995, 1002] }));
  const [c] = controlCharts(files, { condition: 'c', metric: 'tokens' }) as Record<string, any>[];
  assert.equal(c.chart.kind, 'individuals and moving range chart');
  assert.equal(c.chart.points.length, 24);
  assert.ok(c.signals.some((s: any) => s.at === 'b5/b5-2' && /beyond a limit/.test(s.rule)), JSON.stringify(c.signals));
});
