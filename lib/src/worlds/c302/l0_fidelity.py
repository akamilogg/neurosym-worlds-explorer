"""SPEC-C302-LAZO-CERRADO L0: the c302 panel with one pulse into AWCL, simulated by jNeuroML and by NEURON (the script
jNeuroML generates, its mods compiled with NEURON's nrnivmodl), compared: the calcium, the two signals (R²) and the first
rise after the pulse. Run with the EurekaBench venv's python, NEURONHOME set and NEURON's bin in PATH:

    python l0_fidelity.py <duration_ms> <dt_ms>
"""
import importlib, sys, time, tempfile, os
from pathlib import Path
import numpy as np
import c302
import neuroml.writers as writers
from pyneuroml import pynml

PANEL = ['AWCL', 'AWCR', 'AIAL', 'AIAR', 'AIBL', 'AIBR', 'AIYL', 'AIYR', 'AIZL', 'AIZR', 'RIAL', 'RIAR',
         'RIML', 'RIMR', 'AVEL', 'AVER', 'RIBL', 'RIBR', 'AVAL', 'AVAR', 'AVBL', 'AVBR', 'SMDDL', 'SMDDR', 'SMDVL', 'SMDVR', 'RIVL', 'RIVR']
duration = float(sys.argv[1]) if len(sys.argv) > 1 else 3000.0
dt = float(sys.argv[2]) if len(sys.argv) > 2 else 0.05
params = importlib.import_module("c302.parameters_C1").ParameterisedModel()
work = Path(tempfile.mkdtemp(prefix="l0_"))
print("work", work, flush=True)
doc = c302.generate("net", params, cells=PANEL, cells_to_stimulate=[], muscles_to_include=[], duration=duration, dt=dt, target_directory=str(work), verbose=False)
c302.add_new_input(doc, "AWCL", "500ms", "1000ms", "4pA", params)
writers.NeuroMLWriter.write(doc, str(work / "net.net.nml"))

t0 = time.time()
a = pynml.run_lems_with_jneuroml("LEMS_net.xml", exec_in_dir=str(work), max_memory="4G", nogui=True, load_saved_data=True, verbose=False, exit_on_fail=False)
ta = time.time() - t0
print("jnml", "ok" if isinstance(a, dict) else a, round(ta, 1), "s", flush=True)
import subprocess
t0 = time.time()
ok = pynml.run_lems_with_jneuroml_neuron("LEMS_net.xml", exec_in_dir=str(work), max_memory="4G", nogui=True, only_generate_scripts=True, compile_mods=False, verbose=False, exit_on_fail=False)
print("generated", ok, sorted(p.name for p in work.iterdir() if p.suffix in (".py", ".mod"))[:6], flush=True)
nrnhome = os.environ["NEURONHOME"]
c = subprocess.run(["cmd", "/c", os.path.join(nrnhome, "bin", "nrnivmodl.bat")], cwd=str(work), capture_output=True, text=True)
print("nrnivmodl", c.returncode, (c.stdout + c.stderr)[-600:], flush=True)
print("dll", [p.name for p in work.iterdir() if p.suffix == ".dll"], flush=True)
t1 = time.time()
r = subprocess.run([sys.executable, "LEMS_net_nrn.py", "-nogui"], cwd=str(work), capture_output=True, text=True)
print("run", r.returncode, (r.stdout + r.stderr)[-800:], flush=True)
tb = time.time() - t1
print("compile+generate", round(t1 - t0, 1), "s", flush=True)
b = pynml.reload_saved_data("LEMS_net.xml", base_dir=str(work), simulator="jNeuroML_NEURON", plot=False) if r.returncode == 0 else False
print("neuron", "ok" if isinstance(b, dict) else b, round(tb, 1), "s", flush=True)
if isinstance(a, dict) and isinstance(b, dict):
    for cell in ["AWCL", "AIYL", "AVAL", "AVBL", "RIAL", "RIAR"]:
        k = cell + "/0/GenericNeuronCell/caConc" if cell + "/0/GenericNeuronCell/caConc" in a else next(x for x in a if x.startswith(cell + "/") and x.endswith("caConc"))
        x, y = np.asarray(a[k]), np.asarray(b[k]) if k in b else None
        if y is None:
            print(cell, "not in neuron output; keys like", list(b)[:3]); continue
        n = min(len(x), len(y))
        err = np.max(np.abs(x[:n] - y[:n])) / max(np.max(np.abs(x[:n])), 1e-30)
        print(cell, "len", len(x), len(y), "max rel err %.3g" % err, "peak %.3g %.3g" % (np.max(x), np.max(y)), flush=True)

    def ca(res, cell):
        k = next(x for x in res if x.startswith(cell + "/") and x.endswith("caConc"))
        return np.asarray(res[k])
    step = int(round(5.0 / dt))
    def onepole(x, tau=200.0, d=5.0):
        a_ = np.exp(-d / tau); out = np.zeros_like(x); run = 0.0
        for i, v in enumerate(x): run = a_ * run + (1 - a_) * v; out[i] = run
        return out
    def signals(res):
        ava = (ca(res, "AVAL") + ca(res, "AVAR")) / 2; avb = (ca(res, "AVBL") + ca(res, "AVBR")) / 2
        reo = onepole(onepole((ava - avb)[::step])) * 1e8; ste = onepole(onepole((ca(res, "RIAL") - ca(res, "RIAR"))[::step])) * 1e8
        return reo, ste
    def r2(y, x):
        return 1 - np.sum((y - x) ** 2) / np.sum((y - np.mean(y)) ** 2)
    (ra, sa), (rb, sb) = signals(a), signals(b)
    print("dt", dt, "R2 reorientation %.5f steering %.5f" % (r2(ra, rb), r2(sa, sb)), flush=True)
    t = np.asarray(a["t"]) * 1000
    for cell in ["AIYL", "RIAL", "AVAL"]:
        x, y = ca(a, cell), ca(b, cell)
        base = x[int(400 / dt)]
        thr = base + 0.5 * (np.max(x) - base)
        ja = t[np.argmax(x > thr)]; jb = t[np.argmax(y > thr)]
        print(cell, "first half-rise after the pulse: jnml %.2f ms, neuron %.2f ms, diff %.2f ms" % (ja, jb, jb - ja), flush=True)
