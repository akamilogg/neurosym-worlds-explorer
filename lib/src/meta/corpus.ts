import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { LABS } from '../worlds/labs.ts';
import { worldOptionsIn } from '../orchestra/reader.ts';
import { runResults } from '../orchestra/results.ts';

/* ============================================================================
 * The CORPUS of earlier investigations (SPEC-METAPOLITICA-INVESTIGACION §7, M2): an index of the records we have, made
 * without touching them - each run's world and realization, its researcher's model and tools, the help it had, its
 * budget, where it came from and what it reached, and whether its record is enough to read it, rebuild it or run it
 * again. Records are experience, not labels of the right decision nor counterfactual experiments.
 *
 * A LINEAGE is a run with everything derived from it - its continuations, its branches, runs given its experience are
 * not: they read it, they are not it. A lineage is never split between experience and evaluation as if its pieces were
 * independent investigations: `partition` assigns whole lineages, and refuses a split.
 * ========================================================================== */

type J = Record<string, any>;

export interface CorpusEntry {
  /** Its path under the runs' folder, with forward slashes. */
  readonly id: string;
  readonly sha256: string;
  readonly world: string;
  readonly realization: { readonly seed: unknown; readonly options: Readonly<Record<string, string>> };
  readonly researcher: string;
  readonly model: string | null;
  readonly reasoning: unknown;
  readonly tools: unknown;
  /** Help and who gave it: the operator's orders, the messages delivered by author, a senior beside it, a research policy. */
  readonly help: { readonly orders: number; readonly delivered: Readonly<Record<string, number>>; readonly senior: boolean; readonly research_policy: string | null };
  readonly budget: { readonly max_tokens: unknown; readonly max_minutes: unknown; readonly help_budget: unknown; readonly attempts: unknown };
  readonly provenance: { readonly commit: string | null; readonly started: string | null };
  /** What it continues (a resumed run) or what asked for it (a branch), as ids in this index; null where it began. */
  readonly continues: string | null;
  readonly branch_of: string | null;
  readonly lineage: string;
  /** What it reached, as far as its record says, and how it stopped. */
  readonly results: { readonly ended: boolean; readonly stopped_by: string | null; readonly model_accepted: boolean | null; readonly artifact_accepted: boolean | null };
  /** What its record is enough for: reading it (always), rebuilding it offline (its replay log), running it again (its
      arguments and a laboratory of this code). */
  readonly material: { readonly read: true; readonly rebuild: boolean; readonly rerun: boolean };
}

export interface CorpusIndex { readonly format: 'research-corpus@1'; readonly made: string; readonly entries: readonly CorpusEntry[]; readonly lineages: Readonly<Record<string, readonly string[]>> }

const SKIP = /\.(finding(\.researcher)?|status|method|agent-[^.]+|cut|evolve|manifest|search\.manifest)\.json$/;

/** The journals of runs under a folder: files of JSON with an experiment and events, the files beside them left out. */
export function runJournals(runsDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.isSymbolicLink() || d.name.startsWith('.')) continue;
      const f = path.join(dir, d.name);
      if (d.isDirectory()) { walk(f); continue; }
      if (d.name.endsWith('.json') && !SKIP.test(d.name)) out.push(f);
    }
  };
  walk(runsDir);
  return out.sort();
}

/** The index of the runs under `runsDir`, read only. */
export function indexCorpus(runsDir: string): CorpusIndex {
  const files = runJournals(runsDir);
  const idOf = (f: string) => path.relative(runsDir, f).split(path.sep).join('/').replace(/\.json$/, '');
  const read = new Map<string, { file: string; text: string; j: J }>();
  for (const f of files) {
    let text: string, j: J;
    try { text = fs.readFileSync(f, 'utf8'); j = JSON.parse(text); } catch { continue; }
    if (!j || typeof j.experiment !== 'string' || !Array.isArray(j.events)) continue;
    read.set(idOf(f), { file: f, text, j });
  }
  /* What a run continues, by its record: the journal it resumed, beside it (or the one of that name that began when it says). */
  const continuesOf = (id: string, file: string, j: J): string | null => {
    const from = j.resumed?.from;
    if (typeof from !== 'string') return null;
    const beside = idOf(path.resolve(path.dirname(file), from));
    if (read.has(beside)) return beside;
    const named = [...read.entries()].filter(([, x]) => path.basename(x.file) === path.basename(from) && x.j.started === j.resumed?.from_started);
    return named.length === 1 ? named[0][0] : null;
  };
  /* A branch runs in a folder of its own beside its requester: <requester>.branches/. */
  const branchOf = (file: string): string | null => {
    const dir = path.dirname(file);
    if (!dir.endsWith('.branches')) return null;
    const requester = idOf(dir.replace(/\.branches$/, '.json'));
    return read.has(requester) ? requester : null;
  };
  const parent = new Map<string, string | null>();
  for (const [id, { file, j }] of read) parent.set(id, continuesOf(id, file, j) ?? branchOf(file));
  const rootOf = (id: string, seen = new Set<string>()): string => {
    const p = parent.get(id);
    if (!p || seen.has(p)) return id;
    seen.add(id);
    return rootOf(p, seen);
  };
  const entries: CorpusEntry[] = [];
  for (const [id, { file, text, j }] of read) {
    const c = (j.config ?? {}) as J;
    const lab = Object.values(LABS).find((l) => l.id === j.experiment);
    const events = j.events as J[];
    const end = [...events].reverse().find((e) => e.type === 'end');
    const delivered: Record<string, number> = {};
    for (const e of events) if (e.type === 'operator_message') for (const m of (e.messages ?? []) as J[]) if (!m.research_result) delivered[m.by ?? 'operator'] = (delivered[m.by ?? 'operator'] ?? 0) + 1;
    const base = file.replace(/\.json$/, '');
    let results: CorpusEntry['results'];
    try {
      const r = runResults(file);
      results = { ended: Boolean(end), stopped_by: end?.stoppedBy ?? null, model_accepted: end ? r.o1_predictive_acceptance.model : null,
        artifact_accepted: end ? r.o1_predictive_acceptance.artifact ?? null : null };
    } catch { results = { ended: Boolean(end), stopped_by: end?.stoppedBy ?? null, model_accepted: null, artifact_accepted: null }; }
    entries.push({
      id, sha256: createHash('sha256').update(text).digest('hex'), world: j.experiment,
      realization: { seed: c.seed ?? null, options: lab ? worldOptionsIn(lab.options, c) : {} },
      researcher: String(j.researcher ?? 'unknown-world'), model: c.llm_model ?? null, reasoning: c.llm_tuning?.reasoning_effort ?? null, tools: c.tools ?? null,
      help: { orders: events.filter((e) => e.type === 'operator_command' && e.accepted).length, delivered,
        senior: fs.existsSync(base + '.agent-senior.json'), research_policy: c.research_policy?.hash ?? null },
      budget: { max_tokens: j.limits?.max_tokens ?? null, max_minutes: j.limits?.max_minutes ?? null, help_budget: j.help_budget ?? null, attempts: c.attempts ?? null },
      provenance: { commit: j.commit ?? null, started: j.started ?? null },
      continues: continuesOf(id, file, j), branch_of: branchOf(file), lineage: rootOf(id),
      results,
      material: { read: true, rebuild: fs.existsSync(base + '.replay.jsonl'), rerun: Boolean(lab) && Array.isArray(j.argv) }
    });
  }
  const lineages: Record<string, string[]> = {};
  for (const e of entries) (lineages[e.lineage] ??= []).push(e.id);
  return { format: 'research-corpus@1', made: new Date().toISOString(), entries, lineages };
}

export type Partition = 'experience' | 'development' | 'confirmation';

/** Whole lineages to partitions: every run of a lineage goes where its root goes. A run assigned apart from its lineage is
    refused - its continuations and branches are not independent investigations. */
export function partition(index: CorpusIndex, assign: Readonly<Record<string, Partition>>): Record<Partition, string[]> {
  const out: Record<Partition, string[]> = { experience: [], development: [], confirmation: [] };
  const byId = new Map(index.entries.map((e) => [e.id, e]));
  for (const [id, part] of Object.entries(assign)) {
    const e = byId.get(id);
    if (!e) throw new Error('no run "' + id + '" in the corpus');
    for (const other of index.lineages[e.lineage]) if (assign[other] !== undefined && assign[other] !== part)
      throw new Error('"' + id + '" and "' + other + '" are one lineage (' + e.lineage + '): it goes whole to one partition, never split');
  }
  const lineagesDone = new Set<string>();
  for (const [id, part] of Object.entries(assign)) {
    const lineage = byId.get(id)!.lineage;
    if (lineagesDone.has(lineage)) continue;
    lineagesDone.add(lineage);
    out[part].push(...index.lineages[lineage]);
  }
  return out;
}

/** How many independent investigations a set of runs is: its lineages, never its files. */
export const independent = (index: CorpusIndex, ids: readonly string[]): number => new Set(ids.map((id) => index.entries.find((e) => e.id === id)?.lineage ?? id)).size;
