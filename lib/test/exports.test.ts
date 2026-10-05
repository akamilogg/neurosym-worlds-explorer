import test from 'node:test';
import assert from 'node:assert/strict';
import * as lab from '../src/lab.ts';
import * as core from '../src/index.ts';
import * as orbit from '../src/worlds/orbit/index.ts';
import * as grid from '../src/worlds/grid/index.ts';
import * as cells from '../src/worlds/cells/index.ts';
import * as messages from '../src/worlds/messages/index.ts';
import * as tank from '../src/worlds/tank/index.ts';
import * as c302nav from '../src/worlds/c302nav/index.ts';
import { scoreOf as verdict } from '../src/core/predict.ts';
import { INVESTIGATION_TOOLS as common } from '../src/learn/prompt.ts';

/* SPEC-OBJETIVO O7: an operator connects a world and runs the protocol from the package's entries, not from deep paths. */

test('the laboratory entry exposes the protocol, the session, the prompt, the model and the operator measures', () => {
  for (const name of ['Protocol', 'objectiveLines', 'LawSession', 'lawFingerprint', 'system2Prompt', 'commonPrompt', 'parseLawTurn',
    'testPredictions', 'fitLawCodeOnly', 'operatorSummary', 'judgeContribution'])
    assert.equal(typeof (lab as Record<string, unknown>)[name], 'function', name);
});

test('the laboratory entry keeps the core names and renames the two that meet', () => {
  assert.equal(lab.scoreOf, core.scoreOf);
  assert.equal(lab.INVESTIGATION_TOOLS, core.INVESTIGATION_TOOLS);
  assert.equal(lab.pointVerdictOf, verdict);
  assert.equal(lab.COMMON_INVESTIGATION_TOOLS, common);
});

test('the core entry (the browser bundle) stays without the laboratory API', () => {
  assert.equal((core as Record<string, unknown>).Protocol, undefined);
  assert.equal((core as Record<string, unknown>).LawSession, undefined);
});

test('each world entry exposes its world, its family and its objective', () => {
  for (const [world, names] of [
    [orbit, ['environmentOf', 'orbitObjective']],
    [grid, ['boardOf', 'checkRulesAt', 'gridObjective']],
    [cells, ['generateCells', 'placeOf', 'cellsObjective', 'cellsInterface']],
    [messages, ['messagesObjective', 'messagesInterface']],
    [tank, ['tankObjective', 'tankInterface', 'serveTank', 'createTankService']],
    [c302nav, ['c302NavObjective', 'c302NavInterface', 'protocolOf', 'signalsOf']]
  ] as const)
    for (const name of names) assert.equal(typeof (world as Record<string, unknown>)[name], 'function', name);
});
