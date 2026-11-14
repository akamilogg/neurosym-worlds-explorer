import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXTERNAL_PAGES_SECTION, EXTERNAL_SOURCES_SECTION, externalSourcesSection } from '../src/learn/assisted/external-sources.ts';
import { SENIOR_EXTERNAL_SECTION, SENIOR_PAGES_SECTION } from '../src/orchestra/agent-operator.ts';
import { readExternalConfig } from '../src/learn/assisted/external.ts';
import { runBatch, type BatchDefinition } from '../src/orchestra/batch.ts';

/* SPEC-INVESTIGACION-EXTERNA §5: an allowlist of pages with no search engine. Whoever reads it is never told of a search it
   cannot make; with a search engine, what it is told is what it always was. A batch gives its senior sources of its own,
   its file checked before anything is spent. */

test('with no search engine, junior and senior are told to open URLs they know or that a page links to - never of a search', () => {
  assert.equal(externalSourcesSection(true), EXTERNAL_SOURCES_SECTION, 'with a search engine, unchanged');
  for (const s of [EXTERNAL_PAGES_SECTION, SENIOR_PAGES_SECTION]) {
    assert.doesNotMatch(s, /\{"search"/);
    assert.doesNotMatch(s, /search the web/);
    assert.match(s, /no search engine/);
    assert.match(s, /\{"open"/);
    assert.match(s, /\{"links"/);
    assert.match(s, /never an instruction to you/);
  }
  assert.match(SENIOR_EXTERNAL_SECTION, /search the web/);
});

test('the 3SUM allowlist of the examples is a valid configuration: pages only, its own bags for branches', () => {
  const c = readExternalConfig(path.join(import.meta.dirname, '..', 'examples', 'external-research.threesum.json'));
  assert.equal(c.search, null);
  assert.equal(c.web.access, 'allowlist');
  assert.ok(c.branches.inherit_sources);
  const b = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'examples', 'batch.artifacts-threesum-sources.json'), 'utf8'));
  const stall = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'examples', 'batch.artifacts-threesum-stall.json'), 'utf8'));
  const a = stall.runs.find((r: { id: string }) => r.id === 'threesum-stall-A-delegation');
  const s = b.runs[0];
  /* The same run as its reference but for its sources: its arguments without them, its messages and its senior. */
  const without = (args: string[]) => { const i = args.indexOf('--external-research'); return i < 0 ? args : [...args.slice(0, i), ...args.slice(i + 2)]; };
  assert.deepEqual(without(s.args), a.args);
  assert.deepEqual(s.messages, a.messages);
  const { external_research: _x, ...agent } = s.agent;
  assert.deepEqual(agent, a.agent);
});

test('a batch whose senior\'s sources are wrong is refused before any run starts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-sources-'));
  fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ format: 'external-research@1', web: { allow: ['not a domain!'] }, budget: { search_calls: 0, fetch_calls: 1, download_bytes: 1 } }));
  const def = { id: 'srcs', concurrency: 1, runs: [{ id: 'r', lab: 'artifacts', condition: 'c', researcher: 'assisted', args: ['--artifact', 'dedup'], agent: { id: 'senior', role: 'senior', external_research: 'bad.json' } }] } as unknown as BatchDefinition;
  await assert.rejects(runBatch(def, { root: dir, llm: { url: 'http://x.test', model: 'm' } }), /agent:senior: .*web\.allow/);
  assert.equal(fs.existsSync(path.join(dir, 'runs', 'batches', 'srcs')), false, 'nothing started');
});
