import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Instruments, instrumentsSection, parseInstruments, type InstrumentData } from '../src/learn/assisted/instruments.ts';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';
import { runDigest } from '../src/orchestra/view.ts';
import { journalReader } from '../src/learn/assisted/record.ts';
import type { FetchLike } from '../src/core/net.ts';
import { userOf } from './support.ts';

/* SPEC-INSTRUMENTOS-PROPIOS: the researcher writes and registers its own instruments; the environment runs them over what it
   has observed, from primitives only, deterministically, within limits. */

/** A world of two episodes: at step k the percept is { k }, and what came is 2k + 1 (a law to be fitted). */
const data: InstrumentData = {
  episodes: () => [{ episode: 'ep1', steps: 10 }, { episode: 'act2', steps: 10 }],
  points: (ref, every) => {
    const m = /^([a-z0-9]+)(?:@(\d+)-(\d+))?$/.exec(ref);
    if (!m || !['ep1', 'act2'].includes(m[1])) return null;
    const from = m[2] ? Number(m[2]) : 0, to = m[3] ? Number(m[3]) : 9;
    return Array.from({ length: 10 }, (_, k) => k).filter((k) => k % every === 0 && k >= from && k <= to).map((k) => ({ point: m[1] + '@' + k, p: { k }, came: 2 * k + 1 }));
  },
  series: (id) => (id === 'ep1' ? { k: [0, 1, 2], came: [1, 3, 5] } : null)
};
const make = (logged: Record<string, any>[] = [], timeoutMs?: number) => new Instruments({ data, log: (type, d) => logged.push({ type, ...d }), ...(timeoutMs ? { timeoutMs } : {}),
  answerAt: async (model, refs, every) => (model === 1 ? refs.flatMap((r) => (data.points(r, every) ?? []).map((x) => ({ point: x.point, answer: 2 * (x.p as { k: number }).k }))) : '"model" is a round of yours') });

/* A least-squares line through what came: the researcher's own fit, written in its own code. */
const FIT = '(args, env) => { const pts = env.points(args.on, 1); let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;'
  + ' for (const q of pts) { const x = q.p.k, y = q.came; n++; sx += x; sy += y; sxx += x * x; sxy += x * y; }'
  + ' const a = (n * sxy - sx * sy) / (n * sxx - sx * sx); return { slope: a, intercept: (sy - a * sx) / n, n }; }';

test('registered and used: its own fit over its own points, versions kept, and the same use answering the same', async () => {
  const logged: Record<string, any>[] = [];
  const ins = make(logged);
  const warnings: string[] = [];
  const ops = parseInstruments([{ id: 'line_fit', about: 'least squares', source: FIT }, { do: 'write', id: 'Bad Id', source: '() => 1' }, { do: 'write', id: 'broken', source: '(a, e) => {' }], warnings);
  assert.deepEqual(ins.apply(1, ops).map((w) => w.split(':')[0].split(' ')[0]), ['instrument', 'instrument']);
  assert.deepEqual(ins.current().map((v) => v.id + '@' + v.version), ['line_fit@1']);
  const r = await ins.use({ use: 'line_fit', args: { on: 'ep1' } }, 2) as { result: { slope: number; intercept: number; n: number } };
  assert.deepEqual([r.result.slope, r.result.intercept, r.result.n], [2, 1, 10], 'its own code found the law of what came');
  assert.deepEqual(await ins.use({ use: 'line_fit', args: { on: 'ep1' } }, 2), r, 'deterministic');
  ins.apply(3, [{ do: 'write', id: 'line_fit', source: '(args, env) => env.points(args.on, 5).length' }]);
  assert.equal((await ins.use({ use: 'line_fit', args: { on: 'ep1' } }, 3) as { result: number }).result, 2, 'its latest version');
  assert.equal((await ins.use({ use: 'line_fit@1', args: { on: 'act2@2-5' } }, 3) as { result: { n: number } }).result.n, 4, 'or a version it names, on a stretch');
  assert.deepEqual(logged.filter((e) => e.type === 'instrument_registered').map((e) => e.version), [1, 2]);
  assert.equal(logged.filter((e) => e.type === 'instrument_used').length, 4);
});

test('primitives only, and limits: no clock, no unseeded randomness, no host; answers asked in the use; time, points and size bounded', async () => {
  const ins = make([], 300);
  ins.apply(1, parseInstruments([
    { id: 'clock', source: '() => typeof Date + "/" + typeof Math.random + "/" + typeof process + "/" + typeof require' },
    { id: 'seeded', source: '(args, env) => { const r = env.random(7); return [r(), r()]; }' },
    { id: 'compare', source: '(args, env) => env.answers(1, "ep1").map((a, i) => a.answer - env.points("ep1", 1)[i].came)' },
    { id: 'unasked', source: '(args, env) => env.answers(1, "act2")' },
    { id: 'spin', source: '() => { for (;;) {} }' },
    { id: 'greedy', source: '(args, env) => { let n = 0; for (let i = 0; i < 400; i++) n += env.points("ep1", 1).length; return n; }' },
    { id: 'huge', source: '() => "x".repeat(50000)' },
    { id: 'series', source: '(args, env) => env.series("ep1").came' },
    { id: 'mutate', source: '(args, env) => { const e = env.episodes(); e[0].episode = "gone"; return env.episodes()[0].episode; }' }
  ], []));
  assert.equal((await ins.use({ use: 'clock' }, 2) as { result: string }).result, 'undefined/undefined/undefined/undefined');
  const a = await ins.use({ use: 'seeded' }, 2), b = await ins.use({ use: 'seeded' }, 2);
  assert.deepEqual(a, b, 'seeded: the same');
  assert.deepEqual((await ins.use({ use: 'compare', answers: [{ model: 1, on: ['ep1'] }] }, 2) as { result: number[] }).result, Array(10).fill(-1), 'what model 1 answered, against what came');
  assert.match(String((await ins.use({ use: 'unasked', answers: [{ model: 1, on: ['ep1'] }] }, 2) as { error: string }).error), /were not asked in this use/);
  assert.match(String((await ins.use({ use: 'compare', answers: [{ model: 9, on: ['ep1'] }] }, 2) as { error: string }).error), /a round of yours/);
  assert.match(String((await ins.use({ use: 'spin' }, 2) as { error: string }).error), /timed out/i);
  assert.match(String((await ins.use({ use: 'greedy' }, 2) as { error: string }).error), /more than \d+ points/);
  const huge = await ins.use({ use: 'huge' }, 2) as { result: string; note: string };
  assert.match(huge.note, /only the first/);
  assert.deepEqual((await ins.use({ use: 'series' }, 2) as { result: number[] }).result, [1, 3, 5]);
  assert.equal((await ins.use({ use: 'mutate' }, 2) as { result: string }).result, 'ep1', 'it reads copies: the host\'s data never changes');
  assert.match(String((await ins.use({ use: 'nothing' }, 2) as { error: string }).error), /no instrument "nothing"/);
  assert.match(instrumentsSection('the whole episode'), /env\.series\("<episode>"\)` the whole episode/);
  assert.doesNotMatch(instrumentsSection(null), /env\.series/);
});

/* --- A whole assisted run: registered in an answer, used as a request, read by its senior and its finding. */
function system2(seen: { system: string; user: any }[]): FetchLike {
  return async (_url, init) => {
    const b = JSON.parse(String(init.body));
    const sys = b.messages[0].content as string;
    const grading = sys.startsWith('You grade');
    const user = grading ? {} : JSON.parse(userOf(b));
    seen.push({ system: sys, user });
    const done = (user.investigation ?? []).length;
    const content = grading ? { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' }
      : 'task' in user ? { rationale: 'r', beliefs: [{ id: 'b', stance: 'keep', why: 'w' }], lessons: ['l'], next_experiment: 'n' }
      : user.round === 2 && done === 0 ? { investigate: [{ use: 'count_points', args: { on: 'ep1' }, answers: [{ model: 1, on: ['ep1'], every: 5 }] }] }
      : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]', validate: false, beliefs: [{ id: 'b', stance: user.round === 1 ? 'new' : 'keep', statement: 's', evidence: [] }], lessons: ['l'],
        ...(user.round === 1 ? { instruments: [{ id: 'count_points', about: 'how many points, and what model 1 answered at a few', source: '(args, env) => ({ n: env.points(args.on, 1).length, answered: env.answers(1, args.on, 5).length })' }] } : {}) };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
}

test('in a run: registered in any answer, used as an investigation step, shown back, and read by its senior and its finding', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instruments-'));
  const seen: { system: string; user: any }[] = [];
  const r = await runLaboratory(cellsLab, { args: ['--seed', '1', '--level', '1', '--flat', '--researcher', 'assisted', '--memory', 'selective', '--steps', '2', '--attempts', '2', '--out', path.join(dir, 'run.json')], root: dir,
    llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch: system2(seen) });
  const asked = seen.filter((q) => !q.system.startsWith('You grade'));
  assert.ok(asked[0].system.includes('YOUR OWN INSTRUMENTS'));
  const journal = JSON.parse(fs.readFileSync(r.journal, 'utf8'));
  const used = journal.events.find((e: any) => e.type === 'instrument_used');
  assert.ok(used && !used.error, JSON.stringify(used));
  assert.equal(used.result.answered, Math.ceil(used.result.n / 5), 'what its model of round 1 answered, asked in the use');
  assert.match(JSON.stringify(asked.map((q) => q.user)), /"your_instruments"/, 'its index travels in its notebook');
  assert.deepEqual(r.finding.assistance!.instruments, [{ id: 'count_points', versions: 1, uses: 1, failed: 0 }]);
  const round2 = runDigest(journal).latest_rounds.find((x: any) => x.round === 2);
  assert.match(JSON.stringify(round2.instruments_used), /count_points@1/, 'its senior sees the use');
  const listed = await journalReader(journal).run({ memory: 'list', of: 'instruments' }) as { index: { id: string }[] };
  assert.deepEqual(listed.index.map((i) => i.id), ['instrument:count_points@1'], 'and can open it');
});

/* --- The grid: its games point by point, the picture its code receives, how each ended; what a formula of its own valued. */
import { gridLab } from '../src/worlds/grid/lab.ts';

test('the grid: an instrument over its games - the picture at each point, how the episode ended, and what its model valued there', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instruments-grid-'));
  const seen: { system: string; user: any }[] = [];
  const fetch: FetchLike = async (_url, init) => {
    const b = JSON.parse(String(init.body));
    const sys = b.messages[0].content as string;
    const grading = sys.startsWith('You grade');
    const user = grading ? {} : JSON.parse(userOf(b));
    seen.push({ system: sys, user });
    const done = (user.investigation ?? []).length;
    const content = grading ? { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' }
      : 'task' in user ? { rationale: 'r', beliefs: [{ id: 'b', stance: 'keep', why: 'w' }], lessons: ['l'], next_experiment: 'n' }
      : user.round === 2 && done === 0 ? { investigate: [{ use: 'by_ending', args: { on: 'g1' }, answers: [{ model: 1, on: ['g1'] }] }] }
      : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p, m) => 0.25', validate: false, beliefs: [{ id: 'b', stance: user.round === 1 ? 'new' : 'keep', statement: 's' }], lessons: ['l'],
        ...(user.round === 1 ? { instruments: [{ id: 'by_ending', about: 'points of a game, how it ended, what my model valued',
          source: '(args, env) => { const pts = env.points(args.on, 1); return { n: pts.length, width: pts[0].p.width, score: pts[0].came.episode_score, valued: env.answers(1, args.on, 1).map((a) => a.answer) }; }' }] } : {}) };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
  const GRID = ['--seed', '22', '--explore', '1', '--variants', '1', '--family', '1', '--family-variants', '1', '--confirm-places', '1', '--levels', '2', '--depth', '1',
    '--steps', '2', '--flat', '--no-ablation', '--no-grade', '--no-reflection', '--attempts', '3', '--researcher', 'assisted'];
  const r = await runLaboratory(gridLab, { args: [...GRID, '--out', path.join(dir, 'run.json')], root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch });
  assert.ok(seen.find((q) => !q.system.startsWith('You grade'))!.system.includes('YOUR OWN INSTRUMENTS'));
  const used = JSON.parse(fs.readFileSync(r.journal, 'utf8')).events.find((e: any) => e.type === 'instrument_used');
  assert.ok(used && !used.error, JSON.stringify(used));
  assert.ok(used.result.n > 1 && used.result.width > 0 && [1, 0, -1].includes(used.result.score));
  assert.equal(used.result.valued.length, used.result.n);
  assert.ok(used.result.valued.every((v: number) => v === 0.25), 'its output code, without the Judge');
  assert.deepEqual(r.finding.assistance!.instruments, [{ id: 'by_ending', versions: 1, uses: 1, failed: 0 }]);
});

/* --- What it costs to read an episode: its series once, its points as views - the same percept the checks give. */
import { closedLab } from '../src/worlds/c302closed/lab.ts';

test('c302closed\'s points, built inside the sandbox over its series, are its checks\' percepts; views read as arrays and never copy; an episode read whole costs it once', async () => {
  const n = 4000;
  const e = { left: Array.from({ length: n }, (_, k) => (k % 50 < 10 ? 4 : 0)), right: Array.from({ length: n }, (_, k) => (k % 70 < 5 ? 3 : 0)),
    reorientation: Array.from({ length: n + 1 }, (_, k) => Math.sin(k / 30)), steering: Array.from({ length: n + 1 }, (_, k) => Math.cos(k / 40)),
    names: { left: 'AWCL', right: 'AWCR', signals: ['reorientation', 'steering'] } } as never;
  const lab = closedLab as any;
  const series = lab.series(e);
  const cases = lab.cases(null, 'act1', e, 1);
  const ins = new Instruments({ data: { episodes: () => [{ episode: 'act1' }], points: () => null, series: (id) => (id === 'act1' ? series : null), perceptAtSource: lab.perceptAtSource },
    answerAt: async () => [], log: () => {} });
  ins.apply(1, parseInstruments([
    { id: 'some_points', source: '(args, env) => args.at.map((k) => { const q = env.points("act1@" + k + "-" + k, 1)[0]; const d = (x) => [x.length, x.reduce((a, b) => a + b, 0), x[x.length - 1]];'
      + ' return { p: { step: q.p.step, t: d(q.p.t), AWCL: d(q.p.inputs.AWCL), AWCR: d(q.p.inputs.AWCR), keys: Object.keys(q.p) }, came: q.came }; })' },
    { id: 'views', source: '(args, env) => { const v = env.points("act1@1-1", 1)[0].p.inputs.AWCL; let wrote = true; try { v[0] = 9; wrote = v[0] === 9; } catch (e) { wrote = false; } return [Array.isArray(v), v.length, [...v], v.map((x) => x + 1), v.slice(1), wrote]; }' },
    { id: 'all_points', source: '(args, env) => { let s = 0; for (const q of env.points("act1", 1)) s += q.p.inputs.AWCL.length; return s; }' }
  ], []));
  const at = [0, 1, 7, 1234, n - 1];
  const got = (await ins.use({ use: 'some_points', args: { at } }, 2) as { result: { p: unknown; came: unknown }[] }).result;
  const d = (x: number[]) => [x.length, x.reduce((a, b) => a + b, 0), x[x.length - 1]];
  at.forEach((k, i) => {
    const st = cases[k].state;
    assert.deepEqual(got[i].p, { step: st.step, t: d(st.t), AWCL: d(st.inputs.AWCL), AWCR: d(st.inputs.AWCR), keys: Object.keys(st) }, 'the percept at ' + k);
    assert.deepEqual(got[i].came, lab.shown(cases[k]), 'what came at ' + k);
  });
  assert.deepEqual((await ins.use({ use: 'views' }, 2) as { result: unknown }).result, [true, 2, [0, 4], [1, 5], [4], false]);
  const t0 = Date.now();
  const r = await ins.use({ use: 'all_points' }, 2) as { result: number; error?: string };
  assert.equal(r.error, undefined);
  assert.equal(r.result, n * (n + 1) / 2, 'every point saw its whole history');
  assert.ok(Date.now() - t0 < 10000, 'and it cost the episode, not the square of it');
});

test('nothing of the host is reachable: not through env, its arguments, its errors or its results; a result is made text within the limit', async () => {
  const ins = make([], 1000);
  ins.apply(1, parseInstruments([
    { id: 'via_env', source: '(a, env) => { try { return typeof env.episodes.constructor("return process")(); } catch (e) { return "blocked"; } }' },
    { id: 'via_args', source: '(a, env) => { try { return typeof a.constructor.constructor("return process")(); } catch (e) { return "blocked"; } }' },
    { id: 'via_data', source: '(a, env) => { try { return typeof env.points("ep1", 1)[0].constructor.constructor("return process")(); } catch (e) { return "blocked"; } }' },
    { id: 'via_error', source: '(a, env) => { try { env.points("nothing", 1); } catch (e) { try { return typeof e.constructor.constructor("return process")(); } catch (f) { return "blocked"; } } }' },
    { id: 'loop_json', source: '() => ({ toJSON() { for (;;) {} } })' },
    { id: 'a_function', source: '() => () => 1' }
  ], []));
  for (const id of ['via_env', 'via_args', 'via_data', 'via_error']) assert.equal((await ins.use({ use: id, args: {} }, 2) as { result: unknown }).result, 'blocked', id);
  assert.match(String((await ins.use({ use: 'loop_json' }, 2) as { error: string }).error), /timed out/i, 'its result made text within the limit');
  assert.match(String((await ins.use({ use: 'a_function' }, 2) as { error: string }).error), /nothing that can be written as JSON/);
});

test('--no-instruments: the condition without them - no section, nothing registered, a use not understood', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instruments-off-'));
  const seen: { system: string; user: any }[] = [];
  const r = await runLaboratory(cellsLab, { args: ['--seed', '1', '--level', '1', '--flat', '--researcher', 'assisted', '--steps', '2', '--attempts', '2', '--no-instruments', '--out', path.join(dir, 'run.json')], root: dir,
    llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch: system2(seen) });
  assert.ok(seen.filter((q) => !q.system.startsWith('You grade')).every((q) => !q.system.includes('YOUR OWN INSTRUMENTS')));
  const events = JSON.parse(fs.readFileSync(r.journal, 'utf8')).events;
  assert.ok(!events.some((e: any) => e.type === 'instrument_registered' || e.type === 'instrument_used'));
  assert.equal(r.finding.assistance!.instruments, undefined);
  assert.equal(JSON.parse(fs.readFileSync(r.journal, 'utf8')).config.instruments, false);
});

test('a journal made before the instruments (review_from 0, no capabilities_from): resumed as it was, given them only from its new rounds when continued', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instruments-old-'));
  const llm = { url: 'http://system2.test/chat', model: 'stand-in' };
  const args = ['--seed', '1', '--level', '1', '--flat', '--researcher', 'assisted', '--steps', '2', '--no-grade'];
  /* Made as before them: no section, no switch, no capabilities_from - only review_from 0. */
  const first = await runLaboratory(cellsLab, { args: [...args, '--attempts', '2', '--max-tokens', '350', '--no-instruments', '--budget-hidden', '--out', path.join(dir, 'old.json')], root: dir, llm, fetch: system2([]) });
  const j = JSON.parse(fs.readFileSync(first.journal, 'utf8'));
  assert.deepEqual(j.config.capabilities_from, { instruments: 0, fixed_system: 0, budget: 0 }, 'a new journal says where its capabilities start');
  delete j.config.capabilities_from;
  delete j.config.instruments;
  j.argv = j.argv.filter((a: string) => a !== '--no-instruments');
  fs.writeFileSync(first.journal, JSON.stringify(j));
  const seen: { system: string; user: any }[] = [];
  const resumed = await runLaboratory(cellsLab, { args: ['--resume', first.journal, '--out', path.join(dir, 'resumed.json')], root: dir, llm, fetch: system2(seen) });
  assert.notEqual(resumed.stoppedBy, 'diverged', 'its history asked as it was');
  assert.ok(seen.every((q) => !q.system.includes('YOUR OWN INSTRUMENTS')), 'and no instruments when only resumed');
  assert.equal(JSON.parse(fs.readFileSync(resumed.journal, 'utf8')).config.capabilities_from.instruments, undefined);
  /* Continued: from its new rounds on. */
  const ended = await runLaboratory(cellsLab, { args: ['--resume', resumed.journal, '--out', path.join(dir, 'ended.json')], root: dir, llm, fetch: system2([]) });
  assert.equal(ended.stoppedBy, 'budget', 'it used up its rounds: it can be continued');
  const seen2: { system: string; user: any }[] = [];
  const more = await runLaboratory(cellsLab, { args: ['--resume', ended.journal, '--attempts', '4', '--out', path.join(dir, 'more.json')], root: dir, llm, fetch: system2(seen2) });
  assert.notEqual(more.stoppedBy, 'diverged');
  assert.equal(JSON.parse(fs.readFileSync(more.journal, 'utf8')).config.capabilities_from.instruments, 2);
  assert.ok(seen2.some((q) => q.system.includes('YOUR OWN INSTRUMENTS')), 'its new rounds have them');
  /* The visible budget (SPEC-INVESTIGADOR-ASISTIDO §15) only in a run made with it: neither resumed nor continued here. */
  assert.ok([...seen, ...seen2].every((q) => !q.system.includes('YOUR BUDGET') && !JSON.stringify(q.user).includes('"budget"')), 'no budget in a journal made before it');
});
