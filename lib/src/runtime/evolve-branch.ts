import fs from 'node:fs';
import path from 'node:path';
import { artifactsLab, latestVersionOf } from '../worlds/artifacts/lab.ts';
import type { Delegations } from '../learn/assisted/delegation.ts';
import { ArtifactWorld } from '../artifacts/world.ts';
import { artifactEvaluator } from '../learn/evolve/artifacts.ts';
import { runSearch, type Evaluator, type Mutator, type SearchEvent, type SearchManifest, type Seed } from '../learn/evolve/engine.ts';
import { balanced } from '../learn/evolve/policy.ts';

/* ============================================================================
 * THE SUPERVISOR OF AN EVOLUTIONARY BRANCH (SPEC-DELEGACION-EVOLUTIVA §3, §9, §12-§14): one branch, two phases - a search
 * of programs, then a consolidation by the general assisted researcher, who reads the search as experience through its
 * own adapter - never two delegations. It keeps the lifecycle every branch has, so the delegation reads it as it reads
 * any branch:
 *
 *   <branch>.json            its record: the request, and an event per transition (search_finished, consolidation_
 *                            requested, ... end)
 *   <branch>.status.json     its heartbeat and its process, its phase, what it has spent so far
 *   <branch>.inbox.jsonl     a stop from its requester: obeyed before the next attempt
 *   <branch>.finding.json    its cost, BOTH phases in one total, what is not known declared
 *   <branch>.search.jsonl / .search.manifest.json     the search's record and its sealed manifest
 *   <branch>.consolidation.json                       the consolidation's run
 *
 * Resumed, it recovers each transition from its record: a search finished is never searched again, a consolidation
 * requested is never launched twice - one that began and stopped is resumed.
 * ========================================================================== */

export interface EvolveBranchSpec {
  readonly format: 'evolution-branch@1';
  readonly id: string;
  readonly question: string;
  readonly expected: string | null;
  readonly refs: readonly string[];
  /** The requester's record as it stood, readable by the consolidation as experience. */
  readonly cut: string;
  readonly seed: number;
  readonly options: Readonly<Record<string, string>>;
  /** The arguments of its world, as a run of it is started (the consolidation's). */
  readonly worldArgs: readonly string[];
  /** Where the search starts: a program of the requester's (its content), or the base. */
  readonly start: { readonly hash: string; readonly files: Readonly<Record<string, string>> } | null;
  /** A sealed search to continue (its manifest's file), instead of a start. */
  readonly continueFrom: string | null;
  /** Seeds to start from besides the start, resolved by content when the request was accepted (§8). */
  readonly seeds?: readonly Seed[];
  readonly exploration: { readonly workloads: number; readonly seed: number };
  readonly limits: { readonly evaluations: number; readonly attempts: number; readonly tokens: number; readonly machineSeconds?: number };
  /** Seconds of the clock the whole branch may take, from its start: the search stops there, the consolidation is given the rest. */
  readonly wallSeconds?: number;
  readonly consolidation: { readonly tokens: number; readonly rounds: number };
}

type J = Record<string, any>;

/** The evolutionary mode as a run's configuration keeps it, as the delegation reads it. */
export function evolveConfigOf(e: J): NonNullable<ConstructorParameters<typeof Delegations>[0]['config']['evolve']> {
  return { evaluations: Number(e.evaluations), workloads: Number(e.workloads) || 1, ...(e.machine_seconds ? { machineSeconds: Number(e.machine_seconds) } : {}),
    ...(e.wall_seconds ? { wallSeconds: Number(e.wall_seconds) } : {}), ...(e.isolated ? { isolated: true } : {}),
    ...(e.seeds ? { seeds: { max: Number(e.seeds.max), sources: e.seeds.sources } } : {}) };
}

/** What a requester's delegation needs for an evolutionary branch: its world's seed and options, and where a search starts
    - a version of the requester's by its name, or its latest - by its content. Only in a world with an evaluator. */
export function evolveCapability(labId: string, seed: number, options: Readonly<Record<string, string>>, world: () => ArtifactWorld,
  experience: () => readonly { readonly label: string; readonly journal: J }[] = () => []): ConstructorParameters<typeof Delegations>[0]['evolve'] {
  if (labId !== artifactsLab.id) return undefined;
  const versionOf = (w: ArtifactWorld, name: string): { hash: string; files: Readonly<Record<string, string>> } | { error: string } => {
    const v = w.store.get(name);
    return v ? { hash: name, files: Object.fromEntries(v.files) } : { error: 'no version "' + name + '"' };
  };
  return { seed, options, get isolated() { return world().isolated; },
    /* A version of a run read as experience: its world made again from its record, the version found there. */
    resolveExperience(label, version) {
      const run = experience().find((r) => r.label === label);
      if (!run) return { error: 'no run "' + label + '" read as experience' };
      if (run.journal.experiment !== artifactsLab.id) return { error: 'run "' + label + '" is not of this world' };
      const cfg = run.journal.config ?? {};
      return versionOf(worldFromJournal(run.journal, Number(cfg.seed), { artifact: String(cfg.artifact ?? options.artifact), scale: String(cfg.scale ?? options.scale ?? '1'),
        acts: String(cfg.acts ?? '3'), tolerance: String(cfg.tolerance ?? '0.25'), workloads: String(cfg.workloads ?? '2') }), version);
    },
    resolveStart(start) {
    const w = world();
    const name = start ?? latestVersionOf(w);
    const v = w.store.get(name);
    if (!v) return { error: 'no version "' + name + '" of yours' };
    return { hash: name, files: Object.fromEntries(v.files) };
  } };
}

/** The requester's world as its record leaves it (for a senior, who has no world of its own): made from its archived base,
    its versions made again from the changes its record holds. */
export function worldFromJournal(journal: J, seed: number, options: Readonly<Record<string, string>>): ArtifactWorld {
  const spec = artifactsLab.generate(seed, options as never, journal.world_archive);
  artifactsLab.rebuild?.(spec as never, (journal.events ?? []) as never);
  return spec.world as ArtifactWorld;
}
const readJson = (f: string): J | null => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const endOf = (j: J | null): J | null => (j ? [...(j.events ?? [])].reverse().find((e: J) => e.type === 'end') ?? null : null);
const lines = (f: string): SearchEvent[] => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : []);

export const branchFiles = (journal: string) => {
  const base = journal.replace(/\.json$/, '');
  return { base, status: base + '.status.json', inbox: base + '.inbox.jsonl', finding: base + '.finding.json', search: base + '.search.jsonl',
    manifest: base + '.search.manifest.json', consolidation: base + '.consolidation.json' };
};

/** What the consolidation is asked: to make the search's delivery usable, not a theory of every candidate. */
export function consolidationTask(spec: EvolveBranchSpec): string {
  return ['THE CONSOLIDATION OF AN EVOLUTIONARY SEARCH. Another researcher, investigating this same environment, delegated a search of programs. Its question:', spec.question,
    ...(spec.expected ? ['What it wants back: ' + spec.expected] : []),
    ...(spec.refs.length ? ['Where it suggested starting, in its record: ' + spec.refs.join(', ')] : []),
    'The search is readable as experience (run "search"): its candidates (each program whole, its parents, its measures on the exploration workloads, its roles: elite, in development, under repair), its attempts and the decisions of its policy. What a mutator declared of a change is its declaration, not a fact. The requester\'s record, as it stood when it asked, is readable too (run "exp1").',
    'Make the delivery USABLE: reproduce what matters - a candidate becomes a version of yours with a change of its files, and you can run it - detect shortcuts or losses, say which candidates deserve adoption and why, and propose the next experiment. You may explain a mechanism where a decision depends on it; you need not write a theory of each candidate. Write down what you find as you go; close your rounds when a model would add nothing.'].join('\n');
}

export interface EvolveBranchOptions {
  readonly journal: string;
  readonly spec: EvolveBranchSpec;
  readonly mutator: Mutator;
  /** Runs the consolidation: a run of the general assisted researcher with these arguments (its own process's laboratory). */
  readonly consolidate: (args: readonly string[]) => Promise<void>;
  /** The evaluator over the branch's world (tests give their own). */
  readonly evaluator?: (world: ArtifactWorld, seed: number) => Evaluator;
  readonly heartbeatMs?: number;
}

export async function runEvolutionBranch(o: EvolveBranchOptions): Promise<J> {
  const f = branchFiles(o.journal);
  const spec = o.spec;
  const record: J = readJson(o.journal) ?? { format: 'evolution-branch@1', id: spec.id, started: new Date().toISOString(), spec, events: [] };
  const events = record.events as J[];
  const save = () => { fs.mkdirSync(path.dirname(o.journal), { recursive: true }); fs.writeFileSync(o.journal, JSON.stringify(record, null, 2)); };
  const log = (type: string, data: J = {}) => { events.push({ t: new Date().toISOString(), type, ...data }); save(); };
  const has = (type: string) => events.find((e) => e.type === type);
  if (endOf(record)) return record;
  if (!events.length) log('branch_started', { mode: 'evolve' });
  else log('branch_resumed', {});

  /* Its heartbeat and its process; a stop in its inbox, obeyed before the next attempt. */
  const controller = new AbortController();
  let phase = 'searching', spentSoFar = 0;
  const status = (state: string) => fs.writeFileSync(f.status, JSON.stringify({ state, pid: process.pid, heartbeat: new Date().toISOString(), phase, cost: { llm_tokens: spentSoFar } }));
  const poll = () => {
    if (!fs.existsSync(f.inbox)) return;
    if (fs.readFileSync(f.inbox, 'utf8').split('\n').some((l) => { try { return JSON.parse(l).kind === 'stop'; } catch { return false; } })) controller.abort();
  };
  status('running');
  const beat = setInterval(() => { poll(); status('running'); }, o.heartbeatMs ?? 2000);
  beat.unref?.();
  const rel = (p: string) => path.relative(path.dirname(o.journal), p).split(path.sep).join('/');
  /* Its wall time counts from when it began, across resumptions. */
  const deadline = spec.wallSeconds ? Date.parse(record.started) + spec.wallSeconds * 1000 : undefined;
  const minutesLeft = () => (deadline === undefined ? [] : ['--max-minutes', String(Math.max(1, Math.ceil((deadline - Date.now()) / 60000)))]);

  try {
    const world = artifactsLab.generate(spec.seed, spec.options as never).world as ArtifactWorld;
    const laboratories = world.task.families.filter((x) => x.role === 'laboratory').map((x) => x.id);
    const evaluatorAt = (seed: number) => o.evaluator ? o.evaluator(world, seed) : artifactEvaluator(world, { families: laboratories, workloads: spec.exploration.workloads, seed, ...(spec.start ? { start: spec.start } : {}) });

    /* --- The search: never searched again once it finished ------------------------------------------------------- */
    let finished = has('search_finished');
    if (!finished) {
      poll();
      const continueFrom = spec.continueFrom ? readJson(spec.continueFrom) as SearchManifest : undefined;
      const recorded = lines(f.search);
      const evaluator = evaluatorAt(spec.exploration.seed);
      const { manifest } = await runSearch({ evaluator, mutator: o.mutator, profile: balanced(world.task.objective.margin), question: spec.question,
        limits: spec.limits, out: f.search, ...(recorded.length ? { recorded, live: true } : {}), ...(continueFrom ? { continueFrom } : {}), signal: controller.signal,
        ...(deadline !== undefined ? { deadline } : {}), ...(spec.seeds?.length ? { seeds: spec.seeds } : {}) });
      spentSoFar = manifest.cost.tokens;
      fs.writeFileSync(f.manifest, JSON.stringify(manifest, null, 2));
      /* What it exports, confirmed on NEW realizations of the same families (§5): selected on fixed workloads, a program
         may fit them; the delivery says whether the confirmation held it. */
      const s = manifest.state;
      /* What the search found - never its start, which the report gives apart, as what each candidate is measured against. */
      const exported = [...new Set([...s.elites, ...s.development.map((d) => d.hash)])].filter((h) => h !== s.order[0]).slice(0, 6);
      const confirmations: J[] = [];
      if (!controller.signal.aborted && manifest.stoppedBy !== 'cancelled') {
        const confirm = evaluatorAt(spec.exploration.seed + 7919);
        for (const h of exported) {
          if (s.candidates[h]?.evaluation?.correct !== 'yes') continue;
          confirm.adopt(h, s.candidates[h].files);
          const e = await confirm.evaluate(h);
          confirmations.push({ program: h, correct: e.correct, quality: e.quality, feedback: e.feedback });
        }
      }
      log('search_finished', { manifest: rel(f.manifest), hash: manifest.hash, stoppedBy: manifest.stoppedBy, cost: manifest.cost, inherited: manifest.inherited, exported, confirmations });
      finished = has('search_finished');
    }
    spentSoFar = Number(finished!.cost?.tokens) || 0;
    if (controller.signal.aborted || finished!.stoppedBy === 'cancelled') return finish('cancelled');

    /* --- The consolidation: requested once, launched once, resumed if it began and stopped --------------------------- */
    phase = 'consolidating';
    if (!has('consolidation_requested')) log('consolidation_requested', { journal: rel(f.consolidation), tokens: spec.consolidation.tokens, rounds: spec.consolidation.rounds });
    const current = (): string => path.resolve(path.dirname(o.journal), [...events].reverse().find((e) => e.type === 'consolidation_resumed' || e.type === 'consolidation_requested')!.journal);
    const consolidation = readJson(current());
    if (!endOf(consolidation)) {
      try {
        if (consolidation) {
          const derived = f.base + '.consolidation.r' + (events.filter((e) => e.type === 'consolidation_resumed').length + 1) + '.json';
          const from = current();
          log('consolidation_resumed', { from: rel(from), journal: rel(derived) });
          await o.consolidate(['--resume', from, '--out', derived]);
        } else {
          await o.consolidate([...spec.worldArgs, '--researcher', 'assisted', '--attempts', String(spec.consolidation.rounds), '--max-tokens', String(spec.consolidation.tokens),
            '--task', consolidationTask(spec), '--experience', spec.cut, '--experience-mode', 'meta', '--experience-scope', 'all', '--evolution-search', f.manifest,
            '--no-grade', '--no-ablation', ...minutesLeft(), '--out', current()]);
        }
      } catch (e) { log('consolidation_failed', { why: String((e as Error)?.message ?? e).slice(0, 300) }); }
    }
    return finish(controller.signal.aborted ? 'cancelled' : 'completed');
  } catch (e) {
    log('branch_failed', { why: String((e as Error)?.message ?? e).slice(0, 300) });
    return finish('failed');
  } finally {
    clearInterval(beat);
  }

  /** Its end: the record closed, its finding with both phases' cost in one total (what is not known, said so). */
  function finish(stoppedBy: string): J {
    const done = has('search_finished');
    const req = has('consolidation_requested');
    const consJournal = req ? path.resolve(path.dirname(o.journal), [...events].reverse().find((e) => e.type === 'consolidation_resumed' || e.type === 'consolidation_requested')!.journal) : null;
    const consEnded = consJournal ? endOf(readJson(consJournal)) : null;
    /* Every journal of the consolidation (a resumed one replays its history: its finding counts the whole). */
    const consTokens = consJournal ? readJson(consJournal.replace(/\.json$/, '.finding.json'))?.cost?.total?.llm_tokens : undefined;
    const search = done?.cost ?? { attempts: 0, evaluations: 0, tokens: lines(f.search).filter((e) => e.type === 'attempt_answered').reduce((a, e) => a + (Number(e.tokens) || 0), 0), tokens_unknown: 0 };
    const unknown: string[] = [];
    if (search.tokens_unknown) unknown.push(search.tokens_unknown + ' answer(s) of the search reported no tokens');
    if (req && typeof consTokens !== 'number') unknown.push('the consolidation\'s tokens (' + (consEnded ? 'its finding did not say' : 'it did not end') + ')');
    const total = (Number(search.tokens) || 0) + (typeof consTokens === 'number' ? consTokens : 0);
    fs.writeFileSync(f.finding, JSON.stringify({ format: 'evolution-branch-finding@1', branch: spec.id,
      cost: { total: { llm_tokens: total }, search: { llm_tokens: Number(search.tokens) || 0, attempts: search.attempts, evaluations: search.evaluations },
        consolidation: { llm_tokens: typeof consTokens === 'number' ? consTokens : null }, ...(unknown.length ? { unknown } : {}) } }, null, 2));
    log('end', { stoppedBy, search: done ? { manifest: done.manifest, hash: done.hash, stoppedBy: done.stoppedBy } : null,
      consolidation: consJournal ? { journal: rel(consJournal), state: consEnded ? 'reviewed' : 'unreviewed' } : null, spent: total });
    phase = 'ended';
    status('ended');
    return record;
  }
}
