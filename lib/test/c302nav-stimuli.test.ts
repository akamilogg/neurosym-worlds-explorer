import test from 'node:test';
import assert from 'node:assert/strict';
import { DURATION_MS, protocolOf, stimuliOf, tracesOf } from '../src/worlds/c302nav/stimuli.ts';

/* SPEC-EUREKA-NAVEGACION N1: the two families of odor drive, from a seed, with the statistics of the problem's protocols
   (measured 05/10/2026: pulses per run, widths, gaps, totals, splits, the share of time with current). */

const quantiles = (v: number[]): number[] => { const s = [...v].sort((a, b) => a - b); return [0, 0.5, 1].map((p) => s[Math.floor(p * (s.length - 1))]); };

test('the same seed, the same protocol; another seed, another', () => {
  assert.deepEqual(protocolOf('steps', 7), protocolOf('steps', 7));
  assert.notDeepEqual(protocolOf('steps', 7), protocolOf('steps', 8));
  assert.notDeepEqual(protocolOf('rotating', 7).pulses, protocolOf('steps', 7).pulses);
});

test('steps: irregular trains drawn from a few values, within the run', () => {
  const ps = Array.from({ length: 300 }, (_, k) => protocolOf('steps', k + 1));
  const all = ps.flatMap((p) => p.pulses);
  assert.deepEqual([...new Set(all.map((x) => x.width_ms))].sort((a, b) => a - b), [60, 120, 200, 320, 400]);
  assert.deepEqual([...new Set(all.map((x) => x.total_pa))].sort((a, b) => a - b), [2.5, 3.5, 4.5, 5.5, 6]);
  assert.deepEqual([...new Set(all.map((x) => x.split))].sort((a, b) => a - b), [0, 0.25, 0.5, 0.75, 1]);
  assert.deepEqual([...new Set(ps.map((p) => p.pulses[0].start_ms))].sort((a, b) => a - b), [200, 350, 500]);
  assert.ok(all.every((x) => x.start_ms + x.width_ms <= DURATION_MS));
  const [lo, mid, hi] = quantiles(ps.map((p) => p.pulses.length));
  assert.ok(lo >= 8 && mid === 13 && hi <= 19, 'about 13 pulses a run, as in its protocols (10-18)');
});

test('rotating: one width and one period, the total and the split turning smoothly, the last pulse 100 ms before the end', () => {
  const ps = Array.from({ length: 300 }, (_, k) => protocolOf('rotating', k + 1));
  for (const p of ps) {
    assert.equal(new Set(p.pulses.map((x) => x.width_ms)).size, 1);
    assert.equal(new Set(p.pulses.slice(1).map((x, k) => x.start_ms - p.pulses[k].start_ms)).size, 1);
    assert.equal(p.pulses[0].start_ms, 200);
    assert.ok(p.pulses.at(-1)!.start_ms + p.pulses.at(-1)!.width_ms <= DURATION_MS - 100);
    assert.ok(p.pulses.every((x) => x.total_pa >= 0.5 - 1e-9 && x.total_pa <= 6 + 1e-9 && x.split >= 0.05 - 1e-9 && x.split <= 0.95 + 1e-9));
  }
  /* Its protocols have 7 pulses (period 1200, width 350) to 18 (period 500, width 150). */
  const [lo, , hi] = quantiles(ps.map((p) => p.pulses.length));
  assert.deepEqual([lo, hi], [7, 18]);
});

test('as the service takes it, and as the researcher perceives it', () => {
  const p = protocolOf('steps', 3);
  const s = stimuliOf(p);
  const x = p.pulses[0];
  const left = s.find((y) => y.cell === 'AWCL' && y.delay_ms === x.start_ms);
  assert.equal(left?.amplitude_pa ?? 0, Math.round(x.total_pa * x.split * 1e4) / 1e4);
  assert.ok(s.every((y) => y.amplitude_pa > 0), 'no pulse of zero current');
  const tr = tracesOf(p);
  assert.equal(tr.t.length, 1801);
  const k = tr.t.findIndex((t) => t > x.start_ms);
  assert.equal(tr.AWCL[k] + tr.AWCR[k], x.total_pa);
  assert.equal(tr.AWCL[0] + tr.AWCR[0], 0);
});
