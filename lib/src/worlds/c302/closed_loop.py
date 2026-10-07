"""c302 in CLOSED LOOP for the c302 service (SPEC-C302-LAZO-CERRADO §3, L2): the network simulated by NEURON step by step,
its two signals moving a body in an odor field (closed_body.py), and the current into AWCL and AWCR coming, every control
step, from what the body smells. Or, `replay`: a current given step by step into the two cells in open loop, on the same
engine (§9's control of the instrument's consistency).

  request  {"closed_loop": true, "cells": [...], "parameter_set": "C1", "dt_ms": 0.025, "control_ms": 5,
            "duration_ms": 60000, "record": [...], the changes of /simulate (remove_connections, ...),
            "field": {...}, "body": {...}, "start": {"x", "y", "heading"}, "seed": 1, "blocked": false}
           or the same with "replay": {"left": [...pA], "right": [...pA]} (one value per control step) instead of a body
  answer   {"t": [...ms], "x", "y", "heading", "c", "left", "right" (pA), "reorientation", "steering" (per control step:
            at its start for the body, at its end for the signals), "turns": [[k, angle]], "calcium": {cell: [...mM]} at
            the control steps' ends, "end": {...}, "seconds", "compiled": bool}
           or {"error", "bad_request" | "unstable"}

The network is generated as /simulate's (`generate_network`), exported by jNeuroML to NEURON without its recorders (an
episode of minutes would fill the memory), its mods compiled once by NEURON's nrnivmodl and kept by what it is (cells,
changes, parameter set, dt): the next episode on the same network starts at once. It needs NEURON (NEURONHOME set).
"""
import hashlib
import importlib
import importlib.util
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import closed_body  # noqa: E402

READOUT = ("AVAL", "AVAR", "AVBL", "AVBR", "RIAL", "RIAR")
MAX_DURATION_MS = 600000.0


def _simulate_module():
    spec = importlib.util.spec_from_file_location("c302_simulate", str(HERE / "simulate.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def network_key(req):
    """What a compiled network is: its cells, its changes, its parameter set and its integration step."""
    what = {k: req.get(k) for k in ("cells", "parameter_set", "dt_ms", "remove_connections", "connection_number_scaling", "connection_polarity_override", "param_overrides")}
    return hashlib.sha256(json.dumps(what, sort_keys=True).encode()).hexdigest()[:20]


def cache_root():
    return Path(os.environ.get("C302_NEURON_CACHE") or (Path(tempfile.gettempdir()) / "c302_neuron_cache"))


def compiled_network(req, sim):
    """The folder of the network compiled for NEURON (built once, then kept); and whether it was built now."""
    folder = cache_root() / network_key(req)
    if (folder / "nrnmech.dll").exists() or (folder / "x86_64").exists():
        return folder, False
    work = Path(tempfile.mkdtemp(prefix="c302cl_"))
    net_req = {k: v for k, v in req.items() if k not in ("stimuli", "field", "body", "start", "replay")}
    net_req["duration_ms"] = 1000.0
    sim.generate_network({**net_req, "stimuli": []}, work)
    lems = work / "LEMS_net.xml"
    # No recorders: what is read is the readout's calcium, every control step.
    text = lems.read_text(encoding="utf-8")
    text = re.sub(r"<OutputFile[^>]*>.*?</OutputFile>", "", text, flags=re.S)
    text = re.sub(r"<OutputFile[^>]*/>", "", text)
    text = re.sub(r"<Display[^>]*>.*?</Display>", "", text, flags=re.S)
    lems.write_text(text, encoding="utf-8")
    from pyneuroml import pynml
    pynml.run_lems_with_jneuroml_neuron("LEMS_net.xml", exec_in_dir=str(work), max_memory="4G", nogui=True, only_generate_scripts=True,
                                        compile_mods=False, verbose=False, exit_on_fail=False)
    if not (work / "LEMS_net_nrn.py").exists():
        raise RuntimeError("jNeuroML did not export the network to NEURON")
    home = os.environ.get("NEURONHOME")
    if not home:
        raise RuntimeError("NEURONHOME is not set: NEURON is needed for closed loop")
    tool = os.path.join(home, "bin", "nrnivmodl.bat" if os.name == "nt" else "nrnivmodl")
    c = subprocess.run(["cmd", "/c", tool] if os.name == "nt" else [tool], cwd=str(work), capture_output=True, text=True)
    if c.returncode != 0:
        raise RuntimeError("nrnivmodl failed: " + (c.stdout + c.stderr)[-400:])
    folder.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.replace(str(work), str(folder))
    except OSError:
        shutil.rmtree(work, ignore_errors=True)  # another worker built it meanwhile: the same network
    return folder, True


class NeuronCircuit:
    """The network in NEURON as the body's circuit: the current into the two odor cells over a step in, the signals at the
    end of it out (the incremental readout)."""

    def __init__(self, h, ctrl_ms, record):
        self.h, self.ctrl = h, ctrl_ms
        self.clamp = {}
        for cell in ("AWCL", "AWCR"):
            ic = h.IClamp(getattr(h, "a_" + cell)[0].soma(0.5))
            ic.delay, ic.dur, ic.amp = 0, 1e9, 0
            self.clamp[cell] = ic
        self.readout = closed_body.Readout(ctrl_ms)
        self.record = list(record)
        self.calcium = {c: [] for c in self.record}
        h.stdinit()
        self.t = 0.0
        self.initial = self.readout.step(self.ca(READOUT))

    def ca(self, cells):
        return {c: getattr(self.h, "a_" + c)[0].soma(0.5).cai for c in cells}

    def step(self, left, right, dt_ms):
        self.clamp["AWCL"].amp, self.clamp["AWCR"].amp = left / 1000.0, right / 1000.0  # pA -> nA
        self.t += dt_ms
        self.h.continuerun(self.t)
        now = self.ca(set(READOUT) | set(self.record))
        if not all(math.isfinite(v) for v in now.values()):
            raise FloatingPointError("non-finite calcium")
        for c in self.record:
            self.calcium[c].append(now[c])
        return self.readout.step(now)


def check(req, sim):
    known = None
    try:
        import c302
        known, _ = c302.get_cell_names_and_connection(c302.DEFAULT_DATA_READER)
    except Exception:
        pass
    cells = req.get("cells")
    if not cells or not {"AWCL", "AWCR", *READOUT} <= set(cells):
        return "a closed loop needs AWCL, AWCR and the readout cells (%s) among its cells" % ", ".join(READOUT)
    if known is not None:
        try:
            sim.check({**req, "stimuli": []}, known)
        except Exception as e:  # its BadRequest
            return str(e)
    if not 0 < float(req.get("duration_ms", 0)) <= MAX_DURATION_MS:
        return "duration_ms in (0, %g]" % MAX_DURATION_MS
    if not 0.5 <= float(req.get("control_ms", 5)) <= 50:
        return "control_ms in [0.5, 50]"
    if "replay" in req:
        r = req["replay"]
        if not (isinstance(r, dict) and isinstance(r.get("left"), list) and isinstance(r.get("right"), list) and len(r["left"]) == len(r["right"])):
            return "replay is {left: [...], right: [...]} of the same length (pA per control step)"
    elif not all(isinstance(req.get(k), dict) for k in ("field", "body", "start")):
        return "a closed loop needs field, body and start (or a replay)"
    return None


def run(req):
    sim = _simulate_module()
    why = check(req, sim)
    if why:
        return {"error": why, "bad_request": True}
    t0 = time.time()
    folder, built = compiled_network(req, sim)
    # NEURON loads the compiled mechanisms of the folder it starts in.
    os.chdir(str(folder))
    sys.path.insert(0, str(folder))
    from neuron import h
    mod = importlib.import_module("LEMS_net_nrn")
    dt, ctrl = float(req.get("dt_ms", 0.05)), float(req.get("control_ms", 5.0))
    mod.NeuronSimulation(tstop=float(req["duration_ms"]), dt=dt)
    record = [c for c in (req.get("record") or []) if c in req["cells"]]
    circuit = NeuronCircuit(h, ctrl, record)
    out = {"compiled": built}
    try:
        if "replay" in req:
            sig = [circuit.initial]
            for left, right in zip(req["replay"]["left"], req["replay"]["right"]):
                sig.append(circuit.step(float(left), float(right), ctrl))
            n = len(sig) - 1
            out.update({"t": [round(k * ctrl, 6) for k in range(n + 1)], "left": req["replay"]["left"], "right": req["replay"]["right"],
                        "reorientation": [s["reorientation"] for s in sig], "steering": [s["steering"] for s in sig]})
        else:
            ep = closed_body.run_episode(req["field"], req["body"], circuit, req["start"], float(req["duration_ms"]), ctrl,
                                         rnd=closed_body.mulberry32(int(req.get("seed", 1))), blocked=bool(req.get("blocked")))
            steps = ep["steps"]
            col = lambda f: [f(s) for s in steps]  # noqa: E731
            out.update({"t": col(lambda s: round(s["t"], 6)), "x": col(lambda s: s["pose"]["x"]), "y": col(lambda s: s["pose"]["y"]),
                        "heading": col(lambda s: s["pose"]["heading"]), "c": col(lambda s: s["c"]), "left": col(lambda s: s["left"]), "right": col(lambda s: s["right"]),
                        "reorientation": [circuit.initial["reorientation"]] + col(lambda s: s["signals"]["reorientation"]),
                        "steering": [circuit.initial["steering"]] + col(lambda s: s["signals"]["steering"]),
                        "turns": [[k, s["turn"]] for k, s in enumerate(steps) if "turn" in s], "end": ep["end"]})
    except FloatingPointError:
        return {"error": "the simulation diverged (non-finite calcium)", "bad_request": False, "unstable": True}
    out["calcium"] = {c: [float("%.9g" % v) for v in vs] for c, vs in circuit.calcium.items()}
    out["seconds"] = round(time.time() - t0, 1)
    return out
