import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stableStringify } from '../../core/hash.ts';
import { ArtifactStore } from '../../artifacts/store.ts';
import { qualityOf, rejudge, validatePatch } from './artifacts.ts';
import type { ArtifactTask } from '../../artifacts/task.ts';
import { createHash } from 'node:crypto';
import { runSearch, type Evaluator, type SearchEvent, type SearchManifest } from './engine.ts';

/* ============================================================================
 * An evolutionary search verified from its record (SPEC-DELEGACION-EVOLUTIVA §13): its selection and its delivery rebuilt
 * without a model or a measure - every answer and every measure served from the record, the programs made again from
 * their patches by content - and the rebuilt state compared with the one it sealed. Measuring again would be a
 * re-execution; evolving again, another search.
 * ========================================================================== */

const sha = (v: unknown): string => createHash('sha256').update(stableStringify(v)).digest('hex').slice(0, 16);
const lines = (f: string): SearchEvent[] => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

/** An evaluator that measures nothing: its identity, contract and start as the record has them, its programs made again
    by content. */
function recordedEvaluator(events: readonly SearchEvent[], startFiles: Readonly<Record<string, string>>, start: string): Evaluator {
  const started = events.find((e) => e.type === 'search_started');
  const contract = events.find((e) => e.type === 'attempt_planned')?.context?.task ?? null;
  const store = new ArtifactStore(new Map(Object.entries(startFiles)));
  const adopt = (hash: string, files: Readonly<Record<string, string>>): string | null => {
    if (store.get(hash)) return null;
    const patch: Record<string, string | null> = { ...files };
    for (const p of store.get(store.base)!.files.keys()) if (!(p in files)) patch[p] = null;
    const v = store.apply(store.base, { files: patch });
    return typeof v === 'string' ? v : v.hash === hash ? null : 'its content hashes to ' + v.hash;
  };
  return {
    identity: async () => String(started?.evaluator ?? ''),
    contract: () => contract,
    start: () => ({ hash: start, files: startFiles }),
    validate: (files) => validatePatch(files),
    materialize(from, files) {
      const v = store.apply(from, { files });
      return typeof v === 'string' ? { error: v } : { hash: v.hash, files: Object.fromEntries(v.files) };
    },
    adopt,
    evaluate: async () => { throw new Error('verification is offline: a measure the record does not hold is not taken'); }
  };
}

/** The search of `eventsFile` rebuilt and compared with its sealed manifest, whole - its seal checked first; a search it
    continued found by its hash. With its task, each verdict is computed again from the evidence the record kept, and must
    give the quality and correctness the policy read. */
export async function verifySearch(eventsFile: string, manifestFile: string, manifestByHash: (hash: string) => SearchManifest | null, task?: ArtifactTask,
  /** How its candidates are made again where they are not artifacts' programs (a search over research policies). */
  rebuild: (events: readonly SearchEvent[], startFiles: Readonly<Record<string, string>>, start: string) => Evaluator = recordedEvaluator): Promise<{ holds: boolean; why: string }> {
  const events = lines(eventsFile);
  const sealed = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as SearchManifest;
  const { hash: _h, ...body } = sealed;
  if (sha(body) !== sealed.hash) return { holds: false, why: 'its seal is broken: its manifest does not hash to ' + sealed.hash };
  if (task) {
    for (const e of events.filter((x) => x.type === 'evaluation')) {
      if (e.evidence === undefined) return { holds: false, why: e.evaluation + ' kept no evidence: its verdict cannot be computed again' };
      const checks = rejudge(task, e.evidence);
      const q = qualityOf(checks), correct = checks.every((c) => c.verdict.correct) ? 'yes' : 'no';
      if (stableStringify(q) !== stableStringify(e.result.quality) || correct !== e.result.correct) return { holds: false, why: e.evaluation + ': computed again from its evidence, its verdict is not the one recorded' };
    }
  }
  const started = events.find((e) => e.type === 'search_started');
  if (!started) return { holds: false, why: 'its record has no start' };
  const continueFrom = started.continues ? manifestByHash(started.continues) : undefined;
  if (started.continues && !continueFrom) return { holds: false, why: 'the search it continues (' + started.continues + ') is not in the package' };
  const startEvent = events.find((e) => e.type === 'candidate' && e.origin === 'start');
  const first = continueFrom ? continueFrom.state.candidates[continueFrom.state.order[0]] : null;
  const startFiles = startEvent?.files ?? first?.files;
  const start = startEvent?.hash ?? first?.hash;
  if (!startFiles || !start) return { holds: false, why: 'its start is not in its record' };
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'verify-search-')), 'rebuilt.jsonl');
  try {
    const { manifest } = await runSearch({ evaluator: rebuild(events, startFiles, start), mutator: { propose: async () => { throw new Error('verification is offline: an answer the record does not hold is not asked'); } },
      profile: started.profile, question: started.question, limits: started.limits, out, recorded: events, live: false, ...(continueFrom ? { continueFrom } : {}),
      ...(started.seeds ? { seeds: started.seeds } : {}) });
    const differs = (Object.keys({ ...manifest, ...sealed }) as (keyof SearchManifest)[]).filter((k) => stableStringify(manifest[k]) !== stableStringify(sealed[k]));
    if (differs.length) return { holds: false, why: 'rebuilt from its record, its manifest differs from the one it sealed in: ' + differs.join(', ') };
    return { holds: true, why: 'rebuilt from its record without a model or a measure: the same manifest it sealed (candidates, selection, quotas, cursors, cost)' + (task ? ', every verdict computed again from its evidence' : '') };
  } catch (e) {
    return { holds: false, why: String((e as Error)?.message ?? e).slice(0, 300) };
  } finally { fs.rmSync(path.dirname(out), { recursive: true, force: true }); }
}
