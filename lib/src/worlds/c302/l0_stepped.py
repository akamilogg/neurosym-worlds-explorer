"""SPEC-C302-LAZO-CERRADO L0, the crux: NEURON stepped every 5 ms with a current changed between steps reproduces the fixed pulse.
Builds the panel twice in its own folders: (a) with the pulse (jnml -neuron, run whole); (b) without input, driven step by step.
Run as l0_fidelity.py (NEURONHOME, NEURON's bin in PATH):  python l0_stepped.py <dt_ms>"""
import importlib, os, subprocess, sys, tempfile, time
from pathlib import Path
import numpy as np
import c302
import neuroml.writers as writers
from pyneuroml import pynml

PANEL = ['AWCL', 'AWCR', 'AIAL', 'AIAR', 'AIBL', 'AIBR', 'AIYL', 'AIYR', 'AIZL', 'AIZR', 'RIAL', 'RIAR',
         'RIML', 'RIMR', 'AVEL', 'AVER', 'RIBL', 'RIBR', 'AVAL', 'AVAR', 'AVBL', 'AVBR', 'SMDDL', 'SMDDR', 'SMDVL', 'SMDVR', 'RIVL', 'RIVR']
READ = ["AVAL", "AVAR", "AVBL", "AVBR", "RIAL", "RIAR", "AIYL"]
DT, DUR, CTRL = float(sys.argv[1]) if len(sys.argv) > 1 else 0.05, 3000.0, 5.0
params = importlib.import_module("c302.parameters_C1").ParameterisedModel()


def build(pulse):
    work = Path(tempfile.mkdtemp(prefix="l0s_"))
    doc = c302.generate("net", params, cells=PANEL, cells_to_stimulate=[], muscles_to_include=[], duration=DUR, dt=DT, target_directory=str(work), verbose=False)
    if pulse:
        c302.add_new_input(doc, "AWCL", "500ms", "1000ms", "4pA", params)
    writers.NeuroMLWriter.write(doc, str(work / "net.net.nml"))
    pynml.run_lems_with_jneuroml_neuron("LEMS_net.xml", exec_in_dir=str(work), max_memory="4G", nogui=True, only_generate_scripts=True, compile_mods=False, verbose=False, exit_on_fail=False)
    c = subprocess.run(["cmd", "/c", os.path.join(os.environ["NEURONHOME"], "bin", "nrnivmodl.bat")], cwd=str(work), capture_output=True, text=True)
    assert c.returncode == 0, c.stdout[-500:]
    return work


if sys.argv[-1] == "--child":
    # In the folder of a network without input: driven step by step.
    work = Path(os.getcwd())
    sys.path.insert(0, str(work))
    from neuron import h
    mod = importlib.import_module("LEMS_net_nrn")
    sim = mod.NeuronSimulation(tstop=DUR, dt=DT)
    clamp = {}
    for cell in ("AWCL", "AWCR"):
        sec = getattr(h, "a_" + cell)[0].soma
        ic = h.IClamp(sec(0.5)); ic.delay = 0; ic.dur = 1e9; ic.amp = 0
        clamp[cell] = ic
    rec = {c: [] for c in READ}
    h.stdinit()
    t0 = time.time()
    n = int(round(DUR / CTRL))
    for k in range(n):
        t = k * CTRL
        for c in READ: rec[c].append(getattr(h, "a_" + c)[0].soma(0.5).cai)
        # The current over (t_k, t_k+1]: the pulse's, as a controller would set it (pA -> nA).
        clamp["AWCL"].amp = 0.004 if 500 <= t < 1500 else 0.0
        h.continuerun(t + CTRL)
    for c in READ: rec[c].append(getattr(h, "a_" + c)[0].soma(0.5).cai)
    np.savez(str(work / "stepped.npz"), seconds=time.time() - t0, **{c: np.asarray(v) for c, v in rec.items()})
    sys.exit(0)

a = build(True)
r = subprocess.run([sys.executable, "LEMS_net_nrn.py", "-nogui"], cwd=str(a), capture_output=True, text=True)
assert r.returncode == 0, r.stdout[-800:]
whole = pynml.reload_saved_data("LEMS_net.xml", base_dir=str(a), simulator="jNeuroML_NEURON", plot=False)
b = build(False)
r = subprocess.run([sys.executable, os.path.abspath(__file__), str(DT), "--child"], cwd=str(b), capture_output=True, text=True)
assert r.returncode == 0, (r.stdout + r.stderr)[-1500:]
st = np.load(str(b / "stepped.npz"))
step = int(round(CTRL / DT))
print("dt", DT, "stepped run", round(float(st["seconds"]), 1), "s", flush=True)
for c in READ:
    k = next(x for x in whole if x.startswith(c + "/") and x.endswith("caConc"))
    x = np.asarray(whole[k])[::step]; y = st[c]
    m = min(len(x), len(y))
    print(c, "max rel diff whole vs stepped %.3g" % (np.max(np.abs(x[:m] - y[:m])) / np.max(np.abs(x[:m]))), flush=True)
