import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobLedger, JobRefused } from '../src/junior/jobs.ts';

/* SPEC-METAPOLITICA-APRENDIZAJE §7.1, MA2: jobs by operation_id, reserved from their bags, cancelled and reconciled. */

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'junior-jobs-')), 'jobs.jsonl');

test('one operation_id is one job: asked again it is the same, with other inputs refused; consulting never charges again', async () => {
  const file = tmp();
  const ledger = new JobLedger(file, { trials: 100 });
  let runs = 0;
  const op = { operation_id: 'op1', op: 'run', inputs: { pkg: 'x' }, reserve: { trials: 60 }, run: async () => { runs++; return { spent: { trials: 40 }, result: { solved: false } }; } };
  const a = ledger.start(op);
  const again = ledger.start(op);
  assert.equal(again.again, true);
  const j = await a.done;
  assert.equal(j.state, 'completed');
  assert.deepEqual(j.result, { solved: false }, 'completed is the operation ending; its verdict is in its result');
  await again.done;
  assert.equal(runs, 1);
  assert.throws(() => ledger.start({ ...op, inputs: { pkg: 'y' } }), (e: JobRefused) => e.code === 'operation_conflict');
  assert.deepEqual(ledger.bags().trials, { limit: 100, spent: 40, held: 0, uncertain: 0, free: 60 });
  assert.throws(() => ledger.start({ ...op, operation_id: 'op2', reserve: { trials: 61 } }), (e: JobRefused) => e.code === 'budget');
});

test('cancelled, a job keeps what it did; unknown spending stays reserved; a job cut by a stop is uncertain, its reserve held', async () => {
  const file = tmp();
  const ledger = new JobLedger(file, { gpu: 10 });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { done } = ledger.start({ operation_id: 'train1', op: 'train', inputs: {}, reserve: { gpu: 4 }, run: async (signal) => { await gate; return { spent: signal.aborted ? null : { gpu: 3 }, products: { checkpoint: 'c1' } }; } });
  ledger.cancel('train1');
  assert.equal(ledger.get('train1')!.state, 'running', 'it stays running until its worker returns');
  assert.equal(ledger.bags().gpu.held, 4);
  release();
  const j = await done;
  assert.equal(j.state, 'cancelled');
  assert.deepEqual(j.products, { checkpoint: 'c1' });
  assert.equal(ledger.bags().gpu.uncertain, 4);
  // A job left running by a process that stopped.
  const never = ledger.start({ operation_id: 'run2', op: 'run', inputs: {}, reserve: { gpu: 2 }, run: () => new Promise(() => {}) });
  assert.equal(never.job.state, 'running');
  const back = new JobLedger(file, { gpu: 10 });
  assert.equal(back.get('run2')!.state, 'uncertain');
  assert.deepEqual(back.bags().gpu, { limit: 10, spent: 0, held: 0, uncertain: 6, free: 4 });
  assert.equal(back.start({ operation_id: 'run2', op: 'run', inputs: {}, reserve: { gpu: 2 }, run: async () => ({ spent: {} }) }).again, true, 'never replaced by another job');
});
