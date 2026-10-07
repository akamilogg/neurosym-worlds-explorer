import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { C302_BODY, DEFAULT_BODY, runEpisode, type BodySpec, type FieldSpec } from '../src/worlds/c302closed/body.ts';
import { toyCircuit } from '../src/worlds/c302closed/circuits.ts';
import { mulberry32 } from '../src/worlds/grid/gen.ts';

/* SPEC-C302-LAZO-CERRADO L2: the body the c302 service runs in closed loop (closed_body.py) is the reference's (body.ts) -
   driven by the same signals, the same course, currents and turns. Any Python 3 runs it (the standard library only):
   C302_PYTHON, or `python`; without one the test is skipped. */

const PY = process.env.C302_PYTHON || 'python';
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'worlds', 'c302', 'closed_body.py');
const available = spawnSync(PY, ['--version']).status === 0;

function inPython(input: unknown, args: string[] = ['--replay']): any {
  const r = spawnSync(PY, [SCRIPT, ...args], { input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 1 << 28 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const FIELD: FieldSpec = { source: [0, 0], peak: 1, length: 5, shape: 'exp', arena: 15 };

for (const [mode, pulses] of [['deterministic', false], ['stochastic', false], ['deterministic', true]] as const) {
  test('parity, ' + mode + ' body' + (pulses ? ' smelling in pulses' : '') + ': the service\'s body, driven by the reference\'s signals, takes the same course', { skip: !available && 'no Python' }, () => {
    const body: BodySpec = { ...(pulses ? C302_BODY : DEFAULT_BODY), mode };
    const start = { x: 8, y: 1, heading: 2.5 };
    const ref = runEpisode({ field: FIELD, body, circuit: toyCircuit(), start, durationMs: 20000, dtMs: 5, rnd: mulberry32(9) });
    const py = inPython({ field: FIELD, body, start, durationMs: 20000, dtMs: 5, seed: 9, initial: toyCircuit().initial, signals: ref.steps.map((s) => s.signals) });
    assert.equal(py.steps.length, ref.steps.length);
    let worst = 0;
    for (let k = 0; k < ref.steps.length; k++) {
      const a = ref.steps[k], b = py.steps[k];
      worst = Math.max(worst, Math.abs(a.pose.x - b.pose.x), Math.abs(a.pose.y - b.pose.y), Math.abs(a.pose.heading - b.pose.heading), Math.abs(a.left - b.left), Math.abs(a.right - b.right));
      assert.equal(b.turn !== undefined, a.turn !== undefined, 'a turn at ' + k);
    }
    assert.ok(worst < 1e-9, 'the largest difference: ' + worst);
    assert.equal(py.end.reached, ref.end.reached);
  });
}

test('parity: the same generator, the same numbers', { skip: !available && 'no Python' }, () => {
  const r = spawnSync(PY, ['-c', 'import importlib.util,sys,json; s=importlib.util.spec_from_file_location("b", sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); r=m.mulberry32(42); print(json.dumps([r() for _ in range(1000)]))', SCRIPT], { encoding: 'utf8' });
  const ts = mulberry32(42);
  assert.deepEqual(JSON.parse(r.stdout), Array.from({ length: 1000 }, () => ts()));
});
