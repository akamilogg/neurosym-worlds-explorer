import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LABS } from '../src/worlds/labs.ts';
import { isGameLab, type LabContext, type LawLab } from '../src/learn/lab.ts';
import { fetchJson } from '../src/core/net.ts';
import { serveC302 } from '../src/worlds/c302/service.ts';
import { serveTank } from '../src/worlds/tank/service.ts';
import { labUsage } from '../src/runtime/lab-runner.ts';
import { mulberry32 } from '../src/worlds/grid/gen.ts';
import { departureAsNext } from '../src/worlds/orbit/predict.ts';
import { toPercept } from '../src/worlds/orbit/world.ts';

/* SPEC-OBJETIVO O9: a world connects as one declaration. What every declaration must keep consistent. */

/* The laboratories whose world runs here (tank@1's runs in a service of its own: test/tank.test.ts). */
const LAW_LABS = Object.entries(LABS).filter(([, l]) => !isGameLab(l) && !(l as LawLab).external) as [string, LawLab][];

for (const [name, lab] of LAW_LABS) {
  const options = Object.fromEntries(lab.options.map((o) => [o.name, o.default]));
  const spec = lab.generate(1, options);

  test(name + ': the interface offers act and simulate exactly when the laboratory declares them', () => {
    const tools = lab.interface({}).tools;
    assert.equal(tools.includes('act'), Boolean(lab.act));
    assert.equal(tools.includes('simulate'), Boolean(lab.simulate));
  });

  test(name + ': every case of an episode is a point the learner can name, with the same state', () => {
    const e = lab.episode(spec, mulberry32(7));
    const cases = lab.cases(spec, 'ep1', e, 1);
    assert.ok(cases.length > 0);
    for (const c of cases) {
      const at = lab.at(e, Number(c.point.split('@')[1]));
      assert.ok(at, c.point);
      assert.deepEqual(at.state, c.state);
    }
    assert.equal(lab.at(e, -1), null);
    assert.equal(lab.at(e, 10_000), null);
  });

  test(name + ': the family and the blind places are of the same world, and a place is described for the journal', () => {
    for (const index of [1, 2, 1001]) {
      const place = lab.placeOf(spec, index, options);
      assert.ok(lab.cases(place, 'x', lab.episode(place, mulberry32(index)), 1).length > 0);
      assert.equal(typeof lab.placeInfo(place), 'object');
    }
  });

  test(name + ': the operator has baselines and an agreement that a known answer passes (and, a world written here, its truth)', () => {
    if (lab.truth) assert.ok(lab.truth(spec, options).length > 0);
    assert.equal(Boolean(lab.truth), Boolean(lab.grading), 'a grader only where there is a truth to grade against');
    assert.ok(lab.baselines(spec).length > 0);
    const e = lab.episode(spec, mulberry32(3));
    const [c] = lab.cases(spec, 'ep1', e, 1);
    /* What happened, as an answer: the next row, the mark, or (orbit) the pair the next row showed. */
    const right = 'next' in c ? c.next : 'mark' in c ? c.mark : departureAsNext(c.target, c.state);
    assert.equal(lab.answerIssue(right), null);
    if (lab.compare) assert.deepEqual((lab.compare(right, c.state) as number[]).map((v) => Math.round(v * 1e9)), c.target.map((v: number) => Math.round(v * 1e9)));
    if (!lab.operator?.ablate) assert.ok(lab.agrees(right, c));
    assert.ok(lab.answerIssue({ not: 'an answer' }) !== null);
  });

  test(name + ': --help lists the world options and the common ones', () => {
    const usage = labUsage(lab, 'run');
    for (const o of lab.options) assert.match(usage, new RegExp('--' + o.name));
    assert.match(usage, /--validations/);
  });
}

test('cells: an act the world cannot read is refused without saying why; one it can starts an episode', () => {
  const lab = LABS.cells as LawLab;
  const spec = lab.generate(1, { level: '1', acts: '4' });
  assert.equal(typeof lab.act!.parse({}), 'string');
  const width = lab.at(lab.episode(spec, mulberry32(1)), 0)!.state.rows[0].length;
  const glyph = spec.glyphs[0];
  assert.equal(lab.act!.start(spec, { rows: ['?'.repeat(width)] }, 'act1', undefined as never), null);
  const e = lab.act!.start(spec, lab.act!.parse({ row: glyph.repeat(width) }), 'act1', undefined as never);
  assert.ok(e && lab.steps(e) > 0);
});

test('orbit: its laboratories and family are named as before, and an act is refused where no body can start', () => {
  const lab = LABS.orbit as LawLab;
  const options = Object.fromEntries([...lab.options.map((o) => [o.name, o.default]), ...(lab.flags ?? []).map((f) => [f.name, 'false'])]);
  const spec = lab.generate(3, options);
  const ctx = { seed: 3, options: { ...options, labs: '2' }, family: 4, every: 8, checkEpisodes: 2, confirmPlaces: 3, explore: 4 };
  const places = lab.places!(spec, ctx);
  assert.deepEqual(places.laboratories.map((p) => p.id), ['lab1', 'lab2']);
  assert.equal(places.laboratories[0].spec, spec, 'the first laboratory is the base world');
  assert.deepEqual(places.family.map((p) => p.id), ['setup1', 'setup2', 'setup3', 'setup4']);
  assert.deepEqual(lab.blindPlaces!(spec, 1, 2, ctx).map((p) => p.id), ['blind200020', 'blind200021', 'blind200022']);
  const [x, y] = toPercept.pos(spec.frame, spec.sources[0].pos);
  assert.equal(lab.act!.start(spec, { x, y, vx: 0, vy: 0, m: 1 }, 'act1', ctx), null, 'on top of a body');
  assert.equal(labUsage(lab, 'run').includes('--vary-strength'), true);
});

test('grid: a laboratory with a loop of its own - its options, its tools and its help, with the common ones it uses', () => {
  const lab = LABS.grid;
  assert.ok(isGameLab(lab));
  assert.deepEqual([...lab.tools], ['view', 'inspect', 'act', 'measure', 'replay', 'table']);
  assert.equal(lab.runName(22, {}), 'grid-s22');
  const usage = labUsage(lab, 'run');
  for (const name of ['levels', 'depth', 'variants', 'family-variants', 'reveal-choices', 'resume', 'max-tokens', 'no-regression']) assert.match(usage, new RegExp('--' + name));
  assert.doesNotMatch(usage, /--every|--check-episodes/, 'the points of an episode are not its');
  assert.equal(lab.aliases?.['confirm-boards'], 'confirm-places', 'the earlier runner\'s name still works');
});

/* --- SPEC-CALIBRACION-INSTRUMENTOS §3: the instrument's contract ------------------------------------------------------
   What every laboratory that acts must keep before anything is investigated in it, its environment outside included: those
   run against a stand-in (c302's service with a worker that writes down what it was asked, tank's own service, and a
   Blender that holds every particle still). */

const contractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-'));
const c302Asked = path.join(contractDir, 'asked.jsonl');
const c302Worker = path.join(contractDir, 'worker.mjs');
fs.writeFileSync(c302Worker, [
  "import fs from 'node:fs';",
  "let raw = '';",
  "process.stdin.on('data', (c) => { raw += c; });",
  "process.stdin.on('end', () => {",
  "  const req = JSON.parse(raw);",
  "  fs.appendFileSync(process.argv[2], JSON.stringify(req) + '\\n');",
  "  const out = (a) => process.stdout.write('\\n@@C302@@' + JSON.stringify(a));",
  "  if (req.wiring) return out({ cells: req.cells, connections: [{ name: 'AWCL-AIYL', pre: 'AWCL', post: 'AIYL', kind: 'chemical', neurotransmitter: 'Glutamate', number: 3 }] });",
  "  const n = Math.floor(req.duration_ms / req.save_every_ms) + 1;",
  "  const t = Array.from({ length: n }, (_, k) => k * req.save_every_ms);",
  "  const on = (cell) => t.map((tk) => (req.stimuli ?? []).filter((s) => s.cell === cell && tk > s.delay_ms && tk <= s.delay_ms + s.duration_ms).reduce((a, s) => a + s.amplitude_pa, 0) * 1e-8);",
  "  out({ t, calcium: Object.fromEntries(req.record.map((c) => [c, on(c)])), cells: req.cells, n_connections: 204, seconds: 0 });",
  "});"
].join('\n'));

/** The context a laboratory acts in, on its stand-in when its environment is outside. */
async function contractContext(name: string, lab: LawLab, options: Record<string, string>): Promise<{ ctx: LabContext; close(): Promise<void> }> {
  const base = { seed: 1, family: 2, every: 1, checkEpisodes: 2, confirmPlaces: 1, explore: 2 };
  if (!lab.external) return { ctx: { ...base, options }, close: async () => {} };
  let key = 0;
  const over = (url: string) => ({ request: async (route: string, body: unknown) => (await fetchJson(url + route, { body, headers: { 'Idempotency-Key': name + '#' + (++key) }, timeoutMs: 30_000 })).data });
  if (name === 'c302nav') {
    const served = await serveC302({ port: 0, worker: [process.execPath, c302Worker, c302Asked], concurrency: 2 });
    return { ctx: { ...base, options: { ...options, service: served.url }, effects: over(served.url) }, close: () => served.close() };
  }
  if (name === 'tank') {
    const served = await serveTank({ port: 0, seed: 5 });
    return { ctx: { ...base, options: { ...options, service: served.url }, effects: over(served.url) }, close: () => served.close() };
  }
  if (name === 'particles3d') {
    const still = { request: async (_route: string, body: unknown) => {
      const b = body as { scene: { particles: { location: number[] }[] }; frames: number };
      return { rows: Array.from({ length: b.frames }, () => b.scene.particles.map((p) => [...p.location])) };
    } };
    return { ctx: { ...base, options, effects: still }, close: async () => {} };
  }
  throw new Error(name + ': a laboratory outside with no stand-in in the contract');
}

/** Where a value shown to the learner is not a finite number, or null. */
function notFinite(x: unknown, at = ''): string | null {
  if (typeof x === 'number') return Number.isFinite(x) ? null : at + ' = ' + x;
  if (Array.isArray(x)) { for (const [i, v] of x.entries()) { const w = notFinite(v, at + '[' + i + ']'); if (w) return w; } return null; }
  if (x && typeof x === 'object') { for (const [k, v] of Object.entries(x)) { const w = notFinite(v, at + '.' + k); if (w) return w; } return null; }
  return null;
}

/** An act as the learner reads it back and writes it again. */
const echoed = (lab: LawLab, act: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(lab.act!.asWritten ? lab.act!.asWritten(act) : act));

const ACT_LABS = Object.entries(LABS).filter(([, l]) => !isGameLab(l) && (l as LawLab).act) as [string, LawLab][];

test('every laboratory that acts is in the contract', () => {
  assert.deepEqual(ACT_LABS.map(([n]) => n).sort(), ['c302nav', 'cells', 'orbit', 'particles3d', 'tank']);
});

for (const [name, lab] of ACT_LABS) {
  const options = Object.fromEntries([...lab.options.map((o) => [o.name, o.default]), ...(lab.flags ?? []).map((f) => [f.name, 'false'])]) as Record<string, string>;
  const spec = lab.generate(1, options);
  const examples = lab.act!.examples(spec);

  test(name + ' I1: what the environment echoes of an act is what the learner can write again', () => {
    assert.ok(examples.length > 0);
    for (const x of examples) {
      const act = lab.act!.parse(x);
      assert.notEqual(typeof act, 'string', JSON.stringify(x) + ': ' + act);
      assert.deepEqual(lab.act!.parse(echoed(lab, act)), act, JSON.stringify(x));
    }
  });

  test(name + ' I2: a field the act does not know is refused, saying which, at the top and in its lists', () => {
    for (const x of examples) {
      const top = lab.act!.parse({ ...x, not_a_field: 1 });
      assert.equal(typeof top, 'string');
      assert.match(top as string, /not_a_field/);
      for (const [k, v] of Object.entries(x)) {
        if (!Array.isArray(v) || !v.length || !v[0] || typeof v[0] !== 'object') continue;
        const inner = lab.act!.parse({ ...x, [k]: [{ ...v[0], not_a_field: 1 }, ...v.slice(1)] });
        assert.equal(typeof inner, 'string', name + ': "' + k + '" took a field it does not know');
        assert.match(inner as string, /not_a_field/);
      }
    }
  });

  test(name + ' I4 and I5: each example starts the same episode twice, and what the learner is shown of it is finite', async () => {
    const { ctx, close } = await contractContext(name, lab, options);
    try {
      for (const x of examples) {
        const act = lab.act!.parse(x);
        const once = await lab.act!.start(spec, act, 'act1', ctx);
        const again = await lab.act!.start(spec, act, 'act1', ctx);
        assert.ok(once, JSON.stringify(x) + ': refused');
        if (!lab.act!.varies?.(act)) assert.deepEqual(again, once, JSON.stringify(x) + ': not the same episode');
        const shown = [lab.act!.shown(once), echoed(lab, act)];
        if (lab.steps(once) > 0) shown.push(lab.view(once, 0, lab.steps(once)), lab.at(once, 0)!.state, lab.at(once, lab.steps(once) - 1)!.state);
        for (const s of shown) assert.equal(notFinite(s), null, JSON.stringify(x));
      }
    } finally { await close(); }
  });
}

test('c302nav I3a: an intervention in neutral names reaches the worker in the real names and the service\'s form', async () => {
  const lab = LABS.c302nav as LawLab;
  const options = { ...Object.fromEntries(lab.options.map((o) => [o.name, o.default])), names: 'neutral' } as Record<string, string>;
  const spec = lab.generate(1, options);
  const intervention = lab.act!.examples(spec).find((x) => 'remove' in x)!;
  assert.ok(!JSON.stringify(intervention).includes('AWC'), 'the example is in the run\'s names');
  const { ctx, close } = await contractContext('c302nav', lab, options);
  try {
    fs.rmSync(c302Asked, { force: true });
    assert.ok(await lab.act!.start(spec, lab.act!.parse(intervention), 'act1', ctx));
    const asked = fs.readFileSync(c302Asked, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(asked.length, 1);
    const [req] = asked;
    assert.deepEqual(req.remove_connections, ['AWCL-AIYL']);
    assert.deepEqual(req.connection_number_scaling, { 'AWCR-AIYR': 2 });
    assert.deepEqual(req.connection_polarity_override, { 'AIYL-RIAL': 'inh' });
    assert.deepEqual(req.param_overrides, { neuron_to_neuron_chem_exc_syn_gbase: '1nS' });
    assert.deepEqual(req.stimuli.map((s: { cell: string }) => s.cell), ['AWCR']);
    assert.ok(req.record.includes('AIYL'));
  } finally { await close(); }
});
