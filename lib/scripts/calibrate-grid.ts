/* OPERATOR TOOL. Which generated games leave room to LEARN? A seed is usable at a given opponent level when:
     - side A can force the win (the truth),
     - a heuristic that KNOWS the rules wins it at the experiment's depth (the ceiling: it can be learned),
     - a formula that knows nothing (flat Judge) does not (the floor: it must be learned),
     - and it does not look like a known game (a checkerboard with diagonal pieces reads as draughts / Fox & Hounds).
   No network. Nothing here reaches System 2.

     node --experimental-strip-types scripts/calibrate-grid.ts [fromSeed] [toSeed] [depth] [levels] [epsilon]
     e.g. scripts/calibrate-grid.ts 1 30 2 2,4 0.15 */
import { Observer } from '../src/core/observer.ts';
import { Evaluator } from '../src/core/evaluate.ts';
import { makeFormula } from '../src/core/formula.ts';
import { searchBestMove, PLAY_PV_ALPHA_BETA } from '../src/core/search.ts';
import { createPlanner, solveAgainstModel } from '../src/core/truth.ts';
import { noisyOpponent, playEpisode } from '../src/learn/episodes.ts';
import { asciiSense, bFallback, createGridWorld, generateSpec, mulberry32, readPicture, type GridMove, type GridState } from '../src/worlds/grid/index.ts';
import { ceilingOf, tightness } from '../src/worlds/grid/informed.ts';
import type { Judge } from '../src/core/types.ts';

const [from, to, depth] = [Number(process.argv[2] || 1), Number(process.argv[3] || 12), Number(process.argv[4] || 2)];
const levels = (process.argv[5] || '2,4').split(',').map(Number);
const epsilon = Number(process.argv[6] ?? 0.15);
const GAMES = 4;

const flat: Judge = {
  id: 'flat',
  async judge(request) {
    return Object.fromEntries(Object.keys(request.questions).map((id) => [id, { value: 0.5, confidence: null }]));
  }
};

const usable: string[] = [];
for (let seed = from; seed <= to; seed++) {
  let generated;
  try { generated = generateSpec(seed); } catch { console.log('seed ' + seed + ': no playable game'); continue; }
  const { spec } = generated;
  const world = createGridWorld(spec);
  const sense = asciiSense(spec);
  const observer = new Observer<GridState>(world, { kinds: ['sense'], senses: { ascii: (s) => sense.render(s) }, perceive: (_s, p) => readPicture(Object.values(p)[0]) });
  const formula = makeFormula({ world: world.id, observations: { picture: { spec: { kind: 'sense', sense: 'ascii' } } },
    rules: { flat: { type: 'noul', used_as: 'value', instructions: '-', criteria: { yes: '-', no: '-' } } }, weights: { flat: 1 } });
  /* Draughts / Fox & Hounds: a checkerboard, or pieces that only step diagonally forward and win by trapping. */
  const diagonalForwardOnly = spec.A.moves.length > 0 && spec.A.moves.every(([dx, dy]) => dy > 0 && dx !== 0);
  const known = spec.shape === 'checker' || (spec.winA === 'trap' && diagonalForwardOnly);
  const rows: string[] = [];
  for (const level of levels) {
    const planner = createPlanner(world, 'B', level, { fallback: bFallback(spec) });
    const truth = solveAgainstModel(world, world.initial(), 'A', (s) => planner.respond(s), { budget: 300000 });
    const forced = truth.known && truth.winner === 'A';
    let flatWins = 0;
    for (let g = 0; g < GAMES; g++) {
      const evaluator = new Evaluator<GridState>(observer, flat, { maximizer: 'A' });
      const opponent = noisyOpponent(world, (s) => planner.respond(s), epsilon, mulberry32(seed * 31 + level * 7 + g));
      const ep = await playEpisode(world, async (s, actor) => actor === 'B' ? opponent(s)
        : (await searchBestMove<GridState, GridMove>(evaluator, s, { formula, depth, profile: PLAY_PV_ALPHA_BETA })).best.bestMove ?? world.actions(s)[0]);
      if (ep.outcome.winner === 'A') flatWins++;
    }
    const ceiling = forced ? await ceilingOf(spec, { depth, level, epsilon, games: GAMES }) : null;
    const tight = forced ? tightness(spec, level) : null;
    const ok = forced && !known && ceiling!.wins >= Math.ceil(GAMES * 0.75) && flatWins <= Math.floor(GAMES / 4);
    if (ok) usable.push(seed + '@L' + level);
    rows.push('L' + level + ': forced ' + (forced ? 'A in ' + truth.plies : truth.known ? 'no' : '?') +
      (ceiling ? ' | informed ' + ceiling.wins + '/' + GAMES + ' (still winning ' + ceiling.turnsStillWinning.join(',') + ')' : '') +
      ' | flat ' + flatWins + '/' + GAMES +
      (tight ? ' | keep/legal ' + tight.perTurn.join(' ') : '') + (ok ? '   <== room to learn' : ''));
  }
  console.log('seed ' + seed + ' (' + spec.width + 'x' + spec.height + ' ' + spec.shape + ', A' + spec.A.count + ' ' + spec.winA + ' / B' + spec.B.count + ' ' + spec.winB +
    (known ? ', LOOKS LIKE A KNOWN GAME' : '') + ')\n  ' + rows.join('\n  '));
}
console.log('\nusable: ' + (usable.join(', ') || 'none'));
