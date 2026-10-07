"""SPEC-C302-LAZO-CERRADO L0: the fidelity of NEURON against jNeuroML in open loop, case by case.

Each case (a protocol's stimuli, and an intervention on the network) is built once by the worker's own `generate_network`
and simulated by both engines in the same folder: jNeuroML as the service does, NEURON from the script jNeuroML generates
(its mods compiled with NEURON's nrnivmodl). Compared: the two signals as c302nav reads them (R²), the first half-rise of
the calcium of the readout cells after the drive starts (ms), the calcium's largest relative difference, and the time.

    python l0_suite.py <cases.json> <out.json> [dt_ms ...]

<cases.json>: [{"id", "stimuli": [...], "changes": {...}?}]; run with the EurekaBench venv's python, NEURONHOME set and
NEURON's bin in PATH. Writes the results as it goes (a long run can be read while it runs).
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
from pyneuroml import pynml

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("simulate", str(HERE / "simulate.py"))
simulate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(simulate)

PANEL = ['AWCL', 'AWCR', 'AIAL', 'AIAR', 'AIBL', 'AIBR', 'AIYL', 'AIYR', 'AIZL', 'AIZR', 'RIAL', 'RIAR',
         'RIML', 'RIMR', 'AVEL', 'AVER', 'RIBL', 'RIBR', 'AVAL', 'AVAR', 'AVBL', 'AVBR', 'SMDDL', 'SMDDR', 'SMDVL', 'SMDVR', 'RIVL', 'RIVR']
DURATION = 9000.0


def ca(res, cell):
    return np.asarray(res[next(x for x in res if x.startswith(cell + "/") and x.endswith("caConc"))], dtype=float)


def onepole(x, tau=200.0, d=5.0):
    a = np.exp(-d / tau)
    out, run = np.zeros_like(x), 0.0
    for i, v in enumerate(x):
        run = a * run + (1 - a) * v
        out[i] = run
    return out


def signals(res, step):
    ava = (ca(res, "AVAL") + ca(res, "AVAR")) / 2
    avb = (ca(res, "AVBL") + ca(res, "AVBR")) / 2
    return (onepole(onepole((ava - avb)[::step])) * 1e8, onepole(onepole((ca(res, "RIAL") - ca(res, "RIAR"))[::step])) * 1e8)


def r2(y, x):
    tot = np.sum((y - np.mean(y)) ** 2)
    return None if tot <= 0 else float(1 - np.sum((y - x) ** 2) / tot)


def first_rise(t, x, start_ms):
    base = x[np.searchsorted(t, start_ms)]
    top = np.max(x[t >= start_ms])
    if top - base <= 1e-12:
        return None
    above = np.nonzero((t >= start_ms) & (x > base + 0.5 * (top - base)))[0]
    return float(t[above[0]]) if len(above) else None


def run_case(case, dt):
    work = Path(tempfile.mkdtemp(prefix="l0_"))
    req = {"cells": PANEL, "stimuli": case["stimuli"], "duration_ms": DURATION, "dt_ms": dt, **(case.get("changes") or {})}
    simulate.generate_network(req, work)
    t0 = time.time()
    a = pynml.run_lems_with_jneuroml("LEMS_net.xml", exec_in_dir=str(work), max_memory="4G", nogui=True, load_saved_data=True, verbose=False, exit_on_fail=False)
    t_jnml = time.time() - t0
    pynml.run_lems_with_jneuroml_neuron("LEMS_net.xml", exec_in_dir=str(work), max_memory="4G", nogui=True, only_generate_scripts=True, compile_mods=False, verbose=False, exit_on_fail=False)
    c = subprocess.run(["cmd", "/c", os.path.join(os.environ["NEURONHOME"], "bin", "nrnivmodl.bat")], cwd=str(work), capture_output=True, text=True)
    if c.returncode != 0:
        return {"id": case["id"], "dt": dt, "error": "nrnivmodl: " + c.stdout[-300:]}
    t0 = time.time()
    r = subprocess.run([sys.executable, "LEMS_net_nrn.py", "-nogui"], cwd=str(work), capture_output=True, text=True)
    t_neuron = time.time() - t0
    if r.returncode != 0 or not isinstance(a, dict):
        return {"id": case["id"], "dt": dt, "error": "jnml " + ("ok" if isinstance(a, dict) else "failed") + "; neuron " + (r.stdout + r.stderr)[-300:]}
    b = pynml.reload_saved_data("LEMS_net.xml", base_dir=str(work), simulator="jNeuroML_NEURON", plot=False)
    step = int(round(5.0 / dt))
    (ra, sa), (rb, sb) = signals(a, step), signals(b, step)
    t = np.asarray(a["t"], dtype=float) * 1000
    start = min(float(s["delay_ms"]) for s in case["stimuli"]) if case["stimuli"] else 0.0
    rises = {}
    for cell in ("AIYL", "RIAL", "RIAR", "AVAL", "AVBL"):
        ja, jb = first_rise(t, ca(a, cell), start), first_rise(t, ca(b, cell), start)
        rises[cell] = None if ja is None or jb is None else round(jb - ja, 3)
    rel = {cell: float(np.max(np.abs(ca(a, cell) - ca(b, cell))) / max(np.max(np.abs(ca(a, cell))), 1e-30)) for cell in ("AVAL", "AVBL", "RIAL", "RIAR")}
    return {"id": case["id"], "dt": dt, "r2": {"reorientation": r2(ra, rb), "steering": r2(sa, sb)}, "rise_diff_ms": rises,
            "calcium_max_rel_diff": {k: round(v, 4) for k, v in rel.items()}, "seconds": {"jnml": round(t_jnml, 1), "neuron": round(t_neuron, 1)}}


if __name__ == "__main__":
    cases = json.load(open(sys.argv[1], encoding="utf-8"))
    out = sys.argv[2]
    dts = [float(x) for x in sys.argv[3:]] or [0.05]
    results = []
    for dt in dts:
        for case in cases if dt == dts[0] else cases[:3]:
            res = run_case(case, dt)
            results.append(res)
            print(json.dumps(res), flush=True)
            json.dump(results, open(out, "w", encoding="utf-8"), indent=1)
