import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { foxhounds, type FoxMove, type FoxState } from '../src/worlds/foxhounds/world.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..', '..');

/* The ORIGINAL harness, loaded from fox-hounds-harness.html exactly as its own selftest does: the
   parity tests compare the library against the code that produced the 21/09 run, not against a copy. */
export interface HarnessApi {
  createInitialState(col: number): FoxState;
  legalMovesForSide(state: FoxState, side: string): FoxMove[];
  applyMove(state: FoxState, move: FoxMove): FoxState;
  passTurn(state: FoxState): FoxState;
  isTerminal(state: FoxState): { over: boolean; winner: string | null; reason: string | null };
  stateKey(state: FoxState): string;
  computeObservations(state: FoxState, observations: unknown): { values: Record<string, number>; errors: unknown[]; vector: string };
  OBSERVATION_OPS: Record<string, unknown>;
}

let cached: HarnessApi | null = null;
export function loadHarness(): HarnessApi {
  if (cached) return cached;
  const html = fs.readFileSync(path.join(ROOT, 'fox-hounds-harness.html'), 'utf8');
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('no inline <script> in the harness');
  const sandbox: Record<string, unknown> = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    performance: { now: () => Date.now() }, AbortController,
    fetch: () => Promise.reject(new Error('network disabled in parity tests'))
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(match[1] + ';globalThis.__api = { createInitialState, legalMovesForSide, applyMove, passTurn, isTerminal, ' +
    'stateKey, computeObservations, OBSERVATION_OPS };', sandbox, { filename: 'harness-inline.js' });
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
