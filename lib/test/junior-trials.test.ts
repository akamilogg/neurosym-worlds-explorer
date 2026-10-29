import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BlobStore, executionHash, normalizePackage } from '../src/junior/package.ts';
import { SessionServer, type JuniorWorker, type WorkerResult } from '../src/junior/sessions.ts';
import { serveJunior } from '../src/junior/http.ts';
import { JuniorSessionClient } from '../src/junior/client.ts';
import { investigationObservations, juniorCandidate, juniorTrials } from '../src/junior/trials.ts';
import { measure, type CompetenceManifest } from '../src/junior/competence.ts';
import { inProcessLauncher } from '../src/meta/lab.ts';

/* SPEC-METAPOLITICA-APRENDIZAJE §6, MA2: a junior package as the candidate of M2 trials, the harness's own laboratory
   talking to it through its server's OpenAI route. */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'junior-trials-'));

/** The stand-in researcher of the meta tests, as a junior worker: it looks, then proposes a model that repeats the last row. */
function standIn(calls: { n: number }): JuniorWorker {
  return {
    async run(job): Promise<WorkerResult> {
      calls.n++;
      const c = job.content as { system: string; user: { parts: string[] } };
      const ps = c.user.parts.map((p) => { try { return JSON.parse(p); } catch { return {}; } });
      const first = ps[0] ?? {};
      const answer = 'task' in first ? { rationale: 'r', beliefs: [{ id: 'same', stance: 'keep', why: 'w' }], lessons: ['l'], next_experiment: 'n' }
        : !ps.some((p) => p.investigation_step) ? { investigate: [{ view: 'ep1', from: 0, to: 2 }] }
        : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]', validate: false,
          beliefs: [{ id: 'same', stance: first.round === 1 ? 'new' : 'keep', statement: 'the row repeats', evidence: [] }], lessons: ['l'], next_experiment: 'n' };
      const text = JSON.stringify(answer);
      return { served: job.execution, terminal: 'answered', text, trace: '{}', ops: [], after: { neural: null, twin: null }, usage: { prompt_tokens: 10, text_tokens: 10, circuit_tokens: 0, gpu_ms: 0 } };
    }
  };
}

test('a junior package runs a real laboratory as System 2 through its session; its trial is measured and never run twice', async () => {
  const dir = tmp();
  const store = new BlobStore(path.join(dir, 'blobs'));
  const base = path.join(dir, 'base');
  fs.mkdirSync(base);
  fs.writeFileSync(path.join(base, 'w'), 'w');
  const b = (s: string) => store.put(s);
  const pkg = normalizePackage({ format: 'junior-package@1', name: 'stand-in', base: store.putTree(base), prompt: '',
    execution: { firmware: b('f'), tokenizer: b('t'), chat_template: b('c'), driver: b('d'), verifier: b('v'), circuit: {}, precision: 'bf16' } });
  const execution = executionHash(pkg);
  const calls = { n: 0 };
  const server = new SessionServer({ root: path.join(dir, 'junior'), store, worker: standIn(calls) });
  const h = await serveJunior(server);
  try {
    const m: CompetenceManifest = {
      format: 'junior-competence-manifest@1', id: 'e2e', reference: execution,
      components: [{ id: 'cells-L1', rung: 6, lab: 'cells', level: 'L1', extractor: { id: 'model_accepted', version: 1 }, unit: 'solved', direction: 'up', target: 1, bad: 0, tolerance: 0 }],
      cases: [{ id: 'cells-1', kind: 'investigation', lab: 'cells', args: ['--seed', '1'], partition: 'development', group: 'g1', components: ['cells-L1'] }],
      investigation_repetitions: 1, execution: {}, sampling: { seed: 1 },
      promotion: { procedure: 'paired-cases@1', alpha: 0.05, permutations: 1000, seed: 1 },
      limits: { junior_args: ['--level', '1', '--flat', '--no-grade', '--tools', 'view', '--attempts', '2', '--max-tokens', '100000', '--max-judge-calls', '100000'], probe_max_tokens: 1000, timeout_ms: 60000 }
    };
    const trials = juniorTrials(path.join(dir, 'meta'), m, inProcessLauncher({ root: dir, llm: { url: '', model: undefined } }));
    const candidate = juniorCandidate({ pkg, execution, client: new JuniorSessionClient(h.url) });
    const ran = await trials.runCandidate(candidate, 'development');
    assert.equal(ran.length, 1);
    assert.equal(ran[0].result.state, 'ended', ran[0].result.why ?? '');
    const asked = calls.n;
    assert.ok(asked >= 2, 'the laboratory asked the junior');
    const journal = JSON.parse(fs.readFileSync(path.join(dir, 'meta', 'trials', ran[0].trial + '.json'), 'utf8'));
    assert.equal(journal.config.llm_model, execution, 'the child ran with the junior as System 2');
    const sessions = fs.readdirSync(path.join(dir, 'junior', 'sessions'));
    assert.deepEqual(sessions, [ran[0].trial + '.L0.jsonl']);
    const obs = investigationObservations(m, ran);
    assert.equal(obs[0].state, 'measured');
    assert.equal(measure(m, 'development', 0, obs).complete, true);
    // Asked again: the ledger answers, the junior is not asked.
    const again = await trials.runCandidate(candidate, 'development');
    assert.deepEqual(again[0].result, ran[0].result);
    assert.equal(calls.n, asked);
  } finally { server.stop(); await h.close(); }
});
