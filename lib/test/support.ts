import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { foxhounds, type FoxMove, type FoxState } from '../src/worlds/foxhounds/world.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..', '..');

/* The REFERENCE harness: fox-hounds-harness.html as committed in the baseline (the code that produced the
   21/09 run), read from git and loaded exactly as its own selftest does. The working copy now delegates
   to this library, so comparing against it would compare the library with itself. */
export const BASELINE_COMMIT = '55c0944';
export function baselineHarnessHtml(): string {
  return execFileSync('git', ['show', BASELINE_COMMIT + ':fox-hounds-harness.html'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}
export interface HarnessApi {
  createInitialState(col: number): FoxState;
  legalMovesForSide(state: FoxState, side: string): FoxMove[];
  applyMove(state: FoxState, move: FoxMove): FoxState;
  passTurn(state: FoxState): FoxState;
  isTerminal(state: FoxState): { over: boolean; winner: string | null; reason: string | null };
  stateKey(state: FoxState): string;
  computeObservations(state: FoxState, observations: unknown): { values: Record<string, number>; errors: unknown[]; vector: string };
  OBSERVATION_OPS: Record<string, unknown>;
  planMouseMove(state: FoxState, depth: number): FoxMove | null;
  solveAgainstModel(state: FoxState, depth: number, options?: { budget?: number }): { winner: string | null; plies: number | null; reason: string | null; exhausted: boolean };
  searchBestMove(state: FoxState, rules: unknown, options: Record<string, unknown>): Promise<{ result: any; ctx: any }>;
  normalizeRules(raw: unknown, options?: unknown): { rules: any; warnings: string[] };
  rulesFromFormula(formula: unknown): unknown;
  moveKey(move: FoxMove): string;
  config: Record<string, any>;
  resetCaches(): void;
  /** PLAY mode with a human Mouse, as the page sets it (only `humanSide` is read by the opponent model). */
  setHumanMouse(on: boolean): void;
  learner: any;
}

/** The harness's fetch is routed here, so a test can install the same Jev stub on both sides. */
export const harnessNet: { fetch: (url: string, init: any) => Promise<any> } = {
  fetch: () => Promise.reject(new Error('network disabled in parity tests'))
};

let cached: HarnessApi | null = null;
export function loadHarness(): HarnessApi {
  if (cached) return cached;
  const html = baselineHarnessHtml();
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('no inline <script> in the harness');
  const sandbox: Record<string, unknown> = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    performance: { now: () => Date.now() }, AbortController,
    fetch: (url: string, init: any) => harnessNet.fetch(url, init)
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(match[1] + ';globalThis.__api = { createInitialState, legalMovesForSide, applyMove, passTurn, isTerminal, ' +
    'stateKey, computeObservations, OBSERVATION_OPS, planMouseMove, solveAgainstModel, searchBestMove, normalizeRules, ' +
    'rulesFromFormula, moveKey, config, resetCaches: function () { [jevAnswerCache, jevVectorCache, jevValueCache, mousePlanCache, ' +
    'oracleCache, jevBeliefBaseline].forEach(function (m) { m.clear(); }); }, ' +
    'setHumanMouse: function (on) { match.play = on ? { humanSide: SIDE_MOUSE } : null; }, ' +
    'learner: { diffRuleSets, ruleChangeKinds, describeRuleChange, toRuleDiff, narrowRuleSet, judgeRuleDiffMeasured, prefilterCandidate, ' +
    'validateEvidenceRef, normalizeRules, DEFAULT_RULES, setLedger: function (list) { match.rulesHistory = list; }, ' +
    'recordRevision, jevBeliefBaseline, oracleCache, oracleCacheKey, viewRevisions, truthLabelCounts, buildAtomWitness, ' +
    'selectPathCases, courseCorrectionTrigger, recordReflection, describeValueAgainstTruth, createSearchContext, config, ' +
    'setRevisions: function (list) { match.revisions = list; }, setReflections: function (list) { match.reflections = list; }, ' +
    'getReflections: function () { return match.reflections; }, setMatch: function (state, rules) { match.state = state; match.rules = rules; }, ' +
    'judgeRuleDiffConsensus, buildJudgeSystemPrompt, requestMetaReasoning, Telemetry } };', sandbox, { filename: 'harness-inline.js' });
  cached = sandbox.__api as HarnessApi;
  return cached;
}

/* Deterministic PRNG so every failure reproduces. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random playouts in the library world: a varied, reproducible sample of reachable states. */
export function sampleStates(games: number, seed = 20260921): FoxState[] {
  const rnd = mulberry32(seed);
  const states: FoxState[] = [];
  for (let g = 0; g < games; g++) {
    let s = foxhounds.initial({ mouseStartCol: [0, 2, 4, 6][g % 4] });
    for (let guard = 0; guard < 400; guard++) {
      states.push(s);
      if (foxhounds.outcome(s).over) break;
      const moves = foxhounds.actions(s);
      s = moves.length ? foxhounds.step(s, moves[Math.floor(rnd() * moves.length)]) : foxhounds.pass!(s);
    }
  }
  return states;
}

export function readJson(relative: string): any {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
}
