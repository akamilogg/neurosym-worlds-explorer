import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serveC302 } from '../src/worlds/c302/service.ts';
import { c302NavLab, holdR2Of, insightsOf, parseC302NavAct } from '../src/worlds/c302nav/lab.ts';
import { c302NavInterface } from '../src/worlds/c302nav/interface.ts';
import { C302NAV_PERCEPT_DOC, inputTraces, onepole, signalsOf } from '../src/worlds/c302nav/world.ts';
import { r2 } from '../src/worlds/c302nav/objective.ts';
import { LABS } from '../src/worlds/labs.ts';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { fetchJson, type FetchLike } from '../src/core/net.ts';
import { mulberry32 } from '../src/worlds/grid/gen.ts';
import type { LabContext } from '../src/learn/lab.ts';
import { userOf } from './support.ts';

/* SPEC-EUREKA-NAVEGACION N2: navigation-goals as a laboratory of our harness, on the c302 service. A stand-in worker plays
   c302 (the real one needs Java and pyNeuroML): the calcium of AVA follows the total current into the panel, that of RIAL
   and RIAR the current into AWCL and AWCR, AVB stays at 0 - so the two signals are the drive, filtered as the world reads it. */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c302nav-'));
const stub = path.join(dir, 'worker.mjs');
fs.writeFileSync(stub, `
let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  const req = JSON.parse(raw);
  const out = (a) => process.stdout.write('\\n@@C302@@' + JSON.stringify(a));
  if ((req.cells ?? []).includes('NOPE') || (req.stimuli ?? []).some((s) => s.amplitude_pa > 500)) return out({ error: 'refused', bad_request: true });
  if (req.wiring) return out({ cells: req.cells, connections: [{ name: 'AWCL-AIYL', pre: 'AWCL', post: 'AIYL', kind: 'chemical', neurotransmitter: 'Glutamate', number: 3 }] });
  const n = Math.floor(req.duration_ms / req.save_every_ms) + 1;
  const t = Array.from({ length: n }, (_, k) => k * req.save_every_ms);
  const on = (cell) => t.map((tk) => (req.stimuli ?? []).filter((s) => s.cell === cell && tk > s.delay_ms && tk <= s.delay_ms + s.duration_ms).reduce((a, s) => a + s.amplitude_pa, 0));
  const L = on('AWCL'), R = on('AWCR'), zero = t.map(() => 0);
  const all = { AVAL: L.map((v, k) => (v + R[k]) * 1e-8), AVAR: L.map((v, k) => (v + R[k]) * 1e-8), AVBL: zero, AVBR: zero,
    RIAL: L.map((v) => v * 1e-8), RIAR: R.map((v) => v * 1e-8), AIYL: L.map((v) => v * 2e-8) };
  out({ t, calcium: Object.fromEntries((req.record ?? Object.keys(all)).map((c) => [c, all[c] ?? zero])), cells: req.cells, n_connections: 204, seconds: 0 });
});
`);
const worker = [process.execPath, stub];

test('the signals are read as the world says: the difference of the calcium, filtered twice, in units of 1e-8 mM', () => {
  const ca = { AVAL: [0, 1e-8, 1e-8], AVAR: [0, 3e-8, 3e-8], AVBL: [0, 0, 0], AVBR: [0, 2e-8, 2e-8], RIAL: [1e-8, 1e-8, 1e-8], RIAR: [0, 0, 0] };
  const s = signalsOf(ca, 5);
  const twice = (x: number[]) => onepole(onepole(x, 200, 5), 200, 5);
  assert.deepEqual(s.reorientation.map((v) => Number(v.toFixed(4))), twice([0, 1, 1]).map((v) => Number(v.toFixed(4))));
  assert.deepEqual(s.steering.map((v) => Number(v.toFixed(4))), twice([1, 1, 1]).map((v) => Number(v.toFixed(4))));
  assert.deepEqual(inputTraces([{ cell: 'AWCL', delay_ms: 5, duration_ms: 10, amplitude_pa: 2 }], [0, 5, 10, 15, 20]).AWCL, [0, 0, 2, 2, 0], 'a pulse shows after it starts, until it ends');
  assert.equal(r2([{ answer: 1, came: 1 }, { answer: 2, came: 2 }]), 1);
  assert.equal(r2([{ answer: 0, came: 1 }, { answer: 0, came: 1 }]), null, 'no spread, no R²');
  assert.deepEqual(holdR2Of({ 'hold-r2': '0.6,0.2' }), { reorientation: 0.6, steering: 0.2 });
});

test('the act: stimuli into any cell of the panel, cells recorded, connections and parameters changed, or the wiring; its form checked', () => {
  const a = parseC302NavAct({ stimuli: [{ cell: 'AIYL', delay_ms: 100, duration_ms: 200, amplitude_pa: 3 }, { cell: 'AWCR', kind: 'sine', delay_ms: 0, duration_ms: 1000, amplitude_pa: 2, period_ms: 400 }],
    record: ['AIYL'], remove: ['AIYL-RIAL_GJ'], scale: { 'AWCL-AIYL': 2 }, polarity: { 'AIYL-RIAL': 'inh' }, parameters: { 'neuron_to_neuron_chem_exc_syn_gbase': '1nS' }, duration_ms: 3000 });
  assert.equal(typeof a, 'object');
  assert.deepEqual((a as { changes: unknown }).changes, { remove_connections: ['AIYL-RIAL_GJ'], connection_number_scaling: { 'AWCL-AIYL': 2 },
    connection_polarity_override: { 'AIYL-RIAL': 'inh' }, param_overrides: { neuron_to_neuron_chem_exc_syn_gbase: '1nS' } });
  assert.deepEqual(parseC302NavAct({ wiring: true }), { wiring: true });
  for (const bad of [{}, { stimuli: [{ cell: 'XYZ', delay_ms: 0, duration_ms: 1, amplitude_pa: 1 }] }, { stimuli: [], record: ['XYZ'] }, { stimuli: [], remove: ['nope'] },
    { stimuli: [], polarity: { 'AWCL-AIYL': 'both' } }, { stimuli: [], parameters: { x: 1 } }, { stimuli: [], duration_ms: 20000 },
    { stimuli: [{ cell: 'AWCL', kind: 'sine', delay_ms: 0, duration_ms: 1, amplitude_pa: 1 }] }]) assert.equal(typeof parseC302NavAct(bad), 'string', JSON.stringify(bad));
});

test('what this world adds to the prompt says nothing of what the cells do', () => {
  const text = [...c302NavInterface({ regression: true }).lines.map((l) => (typeof l === 'string' ? l : Array.isArray(l) ? l[1] : '')), C302NAV_PERCEPT_DOC].join('\n');
  for (const w of ['odor', 'olfact', 'navigat', 'chemotax', 'turn', 'command', 'interneuron', 'sensory', 'forward', 'backward', 'worm', 'elegans']) assert.doesNotMatch(text, new RegExp('\b' + w, 'i'), w);
  assert.ok(LABS.c302nav === c302NavLab);
});

test('the laboratory learns the world only by asking the service: episodes of either family, acts, the wiring and refusals', async () => {
  const served = await serveC302({ worker, concurrency: 4 });
  try {
    let n = 0;
    const options = { service: served.url, acts: '2', 'hold-r2': '0.5,0.3', eureka: '' };
    const ctx = { seed: 1, options, family: 2, every: 20, checkEpisodes: 2, confirmPlaces: 1, explore: 2,
      effects: { request: async (route: string, body: unknown) => (await fetchJson(served.url + route, { body, headers: { 'Idempotency-Key': 'test#' + (++n) }, retries: 0 })).data } } as LabContext;
    const spec = c302NavLab.generate(1, options);
    const e = await c302NavLab.episode(spec, mulberry32(2), ctx);
    assert.equal(c302NavLab.steps(e), 1800);
    assert.deepEqual(Object.keys(e.inputs), ['AWCL', 'AWCR']);
    /* The stand-in's calcium follows the drive: the signals are the drive filtered twice. */
    const total = e.inputs.AWCL.map((v, k) => v + e.inputs.AWCR[k]);
    assert.ok(Math.abs(e.signals.reorientation[900] - onepole(onepole(total, 200, 5), 200, 5)[900]) < 1e-3);
    const cases = c302NavLab.cases(spec, 'ep1', e, 20);
    assert.equal(cases.length, 91);
    assert.deepEqual(c302NavLab.at(e, 40)!.state, cases[2].state);
    assert.equal(cases[2].state.t.length, 41, 'a point perceives up to its step, nothing after');
    assert.ok(c302NavLab.agrees(cases[2].came, cases[2]));
    assert.equal(c302NavLab.answerIssue(5), 'the answer must be {"reorientation": <number>, "steering": <number>} (it was 5)');
    const rows = c302NavLab.view(e, 0, 500) as { rows: unknown[] };
    assert.equal(rows.rows.length, 60, 'at most 60 rows a view');
    assert.equal(c302NavLab.placeOf(spec, 1, options).family, 'rotating', 'the family\'s places draw the drive never seen');
    assert.deepEqual([1000, 1001].map((i) => c302NavLab.placeOf(spec, i, options).family), ['steps', 'rotating']);
    const v = await c302NavLab.checkEpisodes!(c302NavLab.placeOf(spec, 1, options), { round: 1, attempt: 1, purpose: 'validation', index: 0 }, ctx);
    assert.equal(v.length, 2);
    assert.equal(v[0].protocol!.family, 'rotating');

    const acted = await c302NavLab.act!.start(spec, parseC302NavAct({ stimuli: [{ cell: 'AWCL', delay_ms: 100, duration_ms: 200, amplitude_pa: 4 }], record: ['AIYL'], duration_ms: 1000 }) as never, 'act1', ctx);
    assert.equal(c302NavLab.steps(acted!), 200);
    assert.deepEqual(c302NavLab.act!.shown(acted!), { steps: 200, stimulated: ['AWCL'], recorded: ['AVAL', 'AVAR', 'AVBL', 'AVBR', 'RIAL', 'RIAR', 'AIYL'] });
    assert.equal(acted!.calcium.AIYL[30], 8, 'the calcium of a cell recorded, in units of 1e-8 mM');
    const wiring = await c302NavLab.act!.start(spec, { wiring: true }, 'act2', ctx);
    assert.deepEqual((c302NavLab.act!.shown(wiring!) as { wiring: { name: string }[] }).wiring.map((c) => c.name), ['AWCL-AIYL']);
    assert.equal(c302NavLab.steps(wiring!), 0);
    assert.deepEqual(c302NavLab.cases(spec, 'act2', wiring!, 20), []);
    assert.equal(await c302NavLab.act!.start(spec, { stimuli: [{ cell: 'AWCL', delay_ms: 0, duration_ms: 10, amplitude_pa: 900 }] }, 'act3', ctx), null, 'refused, never saying why');
  } finally { await served.close(); }
});

test('the insights come from a local copy of EurekaBench, for the operator only', () => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'eureka-'));
  const rubric = path.join(copy, 'domains', 'neuroscience', 'navigation-goals', 'tests');
  fs.mkdirSync(rubric, { recursive: true });
  fs.writeFileSync(path.join(rubric, 'rubric.yaml'), 'completeness:\n  criteria:\n  - id: C1\n    criterion: c\ninsights:\n  criteria:\n  - id: I1\n    criterion: Does it explain A?\n    kind: finding\n  - id: I2\n    criterion: Does it explain B?\n    kind: limitation\n');
  assert.deepEqual(insightsOf(copy), [{ id: 'I1', statement: '[finding] Does it explain A?' }, { id: 'I2', statement: '[limitation] Does it explain B?' }]);
  assert.deepEqual(c302NavLab.truth!(c302NavLab.generate(1, {}), { eureka: '' }), []);
});

/* A model that reads the drive as the stand-in makes the signals: it holds in the laboratory and in the family. */
const HOLDING = {
  rationale: 'r', observations: {}, rules: {}, weights: {}, validate: true, beliefs: [{ id: 'b', stance: 'new', statement: 's' }], lessons: ['l'],
  output: '(p) => { const f = (x) => { const a = Math.exp(-5 / 200); let r = 0; return x.map((v) => (r = a * r + (1 - a) * v)); }; '
    + 'const L = p.inputs.AWCL || [], R = p.inputs.AWCR || []; const tot = L.map((v, k) => v + (R[k] || 0)), d = L.map((v, k) => v - (R[k] || 0)); '
    + 'return { reorientation: f(f(tot))[p.step], steering: f(f(d))[p.step] }; }'
};

test('a run: episodes from the service, a check, a validation in the drive never seen, an act - and resumed, nothing simulated again', async () => {
  const served = await serveC302({ worker, concurrency: 4 });
  try {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'c302nav-run-'));
    const fetch: FetchLike = async (url, init) => {
      if (String(url).startsWith(served.url)) return globalThis.fetch(url as string, init as RequestInit) as never;
      const b = JSON.parse(String(init.body));
      const sys = b.messages[0].content as string;
      const user = JSON.parse(userOf(b));
      const done = (user.investigation ?? []).length;
      const content = sys.startsWith('You grade') ? { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' }
        : 'task' in user ? { rationale: 'r', beliefs: [{ id: 'b', stance: 'keep', why: 'w' }], lessons: ['l'], next_experiment: 'n' }
        : user.round === 1 && done === 0 ? { investigate: [{ view: 'ep1', from: 0, to: 3 }, { act: { stimuli: [{ cell: 'AWCL', delay_ms: 0, duration_ms: 500, amplitude_pa: 3 }], duration_ms: 1000 } }] }
        : HOLDING;
      const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
      return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
    };
    const out = path.join(work, 'run.json');
    const args = ['--seed', '1', '--attempts', '1', '--explore', '1', '--check-episodes', '1', '--family', '1', '--confirm-places', '1', '--flat', '--no-grade', '--no-reflection', '--no-ablation', '--service', served.url];
    await runLaboratory(c302NavLab, { args: [...args, '--out', out], root: work, llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch });
    const journal = JSON.parse(fs.readFileSync(out, 'utf8'));
    const end = journal.events.find((e: { type: string }) => e.type === 'end');
    assert.equal(end.stoppedBy, 'accepted');
    assert.deepEqual(end.places.map((p: { id: string; family: string }) => [p.id, p.family]), [['lab1', 'steps'], ['place1', 'rotating']], 'validated in the drive never seen');
    assert.deepEqual(end.operator_summary.validations[0].held_in, ['place1']);
    assert.equal(end.operator_summary.validations[0].blind_confirmed, true);
    const check = journal.events.find((e: { type: string }) => e.type === 'check');
    assert.deepEqual([check.laboratories[0].holds, check.laboratories[0].r2, check.laboratories[0].points], [true, { reorientation: 1, steering: 1 }, 91]);
    assert.deepEqual(end.episodes.map((e: { episode: string }) => e.episode), ['ep1', 'act2', 'check1-lab1-1', 'valid1-place1-1']);
    /* exploration, the act, the check, the validation and the blind place: each simulated once */
    assert.equal(end.replay.live.env, 6);
    assert.equal(served.service.stats().simulations, 6);
    /* Resumed: every simulation is replayed from the log, none asked again. */
    await runLaboratory(c302NavLab, { args: [...args.filter((_, i) => i !== 2 && i !== 3), '--resume', out, '--out', path.join(work, 'resumed.json')], root: work, llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch });
    const again = JSON.parse(fs.readFileSync(path.join(work, 'resumed.json'), 'utf8')).events.find((e: { type: string }) => e.type === 'end');
    assert.equal(again.replay.replayed.env, 6);
    assert.equal(served.service.stats().simulations, 6, 'nothing simulated again');
  } finally { await served.close(); }
});
