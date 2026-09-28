import test from 'node:test';
import assert from 'node:assert/strict';
import { createTankService, serveTank, tankStep, TANK_CAPACITY } from '../src/worlds/tank/service.ts';
import { tankLab } from '../src/worlds/tank/lab.ts';
import { tankInterface } from '../src/worlds/tank/interface.ts';
import { TANK_PERCEPT_DOC } from '../src/worlds/tank/world.ts';
import { system2Prompt } from '../src/learn/prompt.ts';
import { fetchJson } from '../src/core/net.ts';
import { mulberry32 } from '../src/worlds/grid/gen.ts';
import type { LabContext } from '../src/learn/lab.ts';

/* SPEC-OBJETIVO O12: a laboratory whose environment is outside the harness, keeps state and acts. */

test('the service acts once per key: a request answered before is answered again, and nothing is done twice', () => {
  const s = createTankService({ seed: 3 });
  const e = s.handle('POST', '/episode', { place: 'p0', start: 20 }, 'run#1').body as { episode: string; level: number };
  assert.equal(e.level, 20);
  const first = s.handle('POST', '/step', { episode: e.episode, inflow: 4 }, 'run#2').body;
  const again = s.handle('POST', '/step', { episode: e.episode, inflow: 4 }, 'run#2').body;
  assert.deepEqual(again, first);
  assert.deepEqual(first, { level: tankStep(20, 4) });
  assert.deepEqual(s.stats(), { steps: 1, episodes: 1, answered_again: 1 });
  s.handle('POST', '/step', { episode: e.episode, inflow: 4 }, 'run#3');
  assert.equal(s.stats().steps, 2, 'another key is another step');
});

test('the service refuses without saying why, and keeps the tank within its bounds', () => {
  const s = createTankService();
  assert.deepEqual(s.handle('POST', '/episode', { place: 'p0', start: 99 }, null).body, { refused: true });
  const e = s.handle('POST', '/episode', { place: 'p0', start: TANK_CAPACITY }, null).body as { episode: string };
  assert.deepEqual(s.handle('POST', '/step', { episode: e.episode, inflow: 12 }, null).body, { refused: true });
  assert.equal(tankStep(TANK_CAPACITY, 9), TANK_CAPACITY - 15 + 9);
  assert.equal(tankStep(0, 0), 0);
});

test('what this world adds to the prompt (its interface and its percept) says nothing of what the world is', () => {
  const text = [...tankInterface({ regression: true }).lines.map((l) => (typeof l === 'string' ? l : Array.isArray(l) ? l[1] : '')), TANK_PERCEPT_DOC].join('\n');
  assert.ok(system2Prompt(tankInterface()).includes(tankInterface().lines[0] as string));
  for (const w of ['tank', 'water', 'drain', 'leak', 'quarter', 'capacity', 'inflow', 'level']) assert.doesNotMatch(text, new RegExp('\\b' + w, 'i'), w);
});

test('the laboratory learns the world only by asking the service: episodes, acts and refusals come over HTTP', async () => {
  const served = await serveTank({ port: 0, seed: 5 });
  try {
    let n = 0;
    const ctx = { seed: 1, options: { service: served.url, acts: '3' }, family: 2, every: 1, checkEpisodes: 2, confirmPlaces: 1, explore: 2,
      effects: { request: async (route: string, body: unknown) => (await fetchJson(served.url + route, { body, headers: { 'Idempotency-Key': 'test#' + (++n) } })).data } } as LabContext;
    const spec = tankLab.generate(1, ctx.options);
    const e = await tankLab.episode(spec, mulberry32(2), ctx);
    assert.equal(tankLab.steps(e), 12);
    for (let t = 0; t < 12; t++) assert.equal(e.rows[t + 1].value, tankStep(e.rows[t].value, e.rows[t + 1].input!), 'what the service answered follows its rule');
    const cases = tankLab.cases(spec, 'ep1', e, 1);
    assert.deepEqual(tankLab.at(e, 3)!.state, cases[3].state);
    assert.equal(tankLab.answerIssue(cases[3].next), null);
    assert.ok(tankLab.agrees(cases[3].next, cases[3]));
    const acted = await tankLab.act!.start(spec, tankLab.act!.parse({ inputs: [9, 9], start: 50 }) as never, 'act1', ctx);
    assert.deepEqual(acted!.rows.map((r) => r.value), [50, tankStep(50, 9), tankStep(tankStep(50, 9), 9)]);
    assert.equal(await tankLab.act!.start(spec, { inputs: [1], start: 99 }, 'act2', ctx), null, 'refused');
    assert.equal(typeof tankLab.act!.parse({ inputs: [] }), 'string');
    assert.equal(served.service.stats().steps, 14);
    await assert.rejects(Promise.resolve().then(() => tankLab.episode(spec, mulberry32(2))), /needs its service/);
  } finally { await served.close(); }
});
