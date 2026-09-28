/* The LABORATORY API (SPEC-OBJETIVO O7): what an operator needs to connect a world and run the protocol on it - the
   objective and the protocol every world uses, the System-2 session over a law with its interface and prompt, the model
   (a law) and its prediction, and the operator's measures. Node-side: it is not part of the harness's browser bundle,
   which stays the world-neutral core of index.ts. Worlds come from their own entries (neurosym/orbit, /grid, /cells,
   /messages). */
export * from './index.ts';
export * from './core/output.ts';
export * from './core/predict.ts';
export * from './learn/objective.ts';
export * from './learn/protocol.ts';
export * from './learn/prompt.ts';
export * from './learn/law-explorer.ts';
export * from './learn/law-session.ts';
export * from './learn/law-ablation.ts';
export * from './learn/operator.ts';
/* Two pairs of names meet. The explorer's score of a game and the grid explorer's instruments keep theirs (they are in
   index.ts); the environment's verdict on a predicted point and the common list of instruments get others. */
export { scoreOf, INVESTIGATION_TOOLS } from './index.ts';
export { scoreOf as pointVerdictOf } from './core/predict.ts';
export { INVESTIGATION_TOOLS as COMMON_INVESTIGATION_TOOLS } from './learn/prompt.ts';
