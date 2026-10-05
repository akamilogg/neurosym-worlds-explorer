"""One simulation of c302 (OpenWorm's model of the nervous system of C. elegans), for the c302 service (service.ts).

It reads one request as JSON on stdin and writes one answer as JSON on stdout:

  request  {"wiring": true, "cells": [...]}   the connections among those cells (see `wiring`); or a simulation:
           {"cells": [...] | null, "stimuli": [...], "record": [...] | null, "parameter_set": "C1",
            "duration_ms": 9000, "dt_ms": 0.05, "save_every_ms": 5,
            "remove_connections": [...], "connection_number_scaling": {...}, "connection_polarity_override": {...},
            "param_overrides": {...}}
  answer   {"t": [...ms], "calcium": {cell: [...mM]}, "cells": [...], "n_connections": n, "seconds": s}
           or {"error": "...", "bad_request": true|false}

A stimulus is a square pulse {"cell", "delay_ms", "duration_ms", "amplitude_pa"} or a sine {"kind": "sine", ...,
"period_ms", "phase_rad"}. Nothing here belongs to any one problem: which cells, which stimuli and what is read from the
calcium are the laboratory's. It needs c302, pyNeuroML and Java (jNeuroML).
"""
import importlib
import json
import shutil
import sys
import tempfile
import time
from pathlib import Path

PARAMETER_SETS = ("A", "B", "C", "C0", "C1", "C2")
MAX_DURATION_MS = 20000.0
MAX_AMPLITUDE_PA = 1000.0


class BadRequest(Exception):
    pass


def check(req, known):
    cells = req.get("cells")
    if cells is not None:
        unknown = sorted(set(cells) - set(known))
        if unknown:
            raise BadRequest("unknown cells: %s" % unknown)
    included = set(known) if cells is None else set(cells)
    for s in req.get("stimuli") or []:
        if s.get("cell") not in included:
            raise BadRequest("a stimulus into a cell that is not in the network: %r" % s.get("cell"))
        if abs(float(s.get("amplitude_pa", 0))) > MAX_AMPLITUDE_PA:
            raise BadRequest("|amplitude_pa| <= %g" % MAX_AMPLITUDE_PA)
        if s.get("kind", "pulse") not in ("pulse", "sine"):
            raise BadRequest("a stimulus is a pulse or a sine")
        if s.get("kind") == "sine" and not float(s.get("period_ms", 0)) > 0:
            raise BadRequest("a sine needs period_ms > 0")
    for c in req.get("record") or []:
        if c not in included:
            raise BadRequest("cannot record a cell that is not in the network: %r" % c)
    if str(req.get("parameter_set", "C1")) not in PARAMETER_SETS:
        raise BadRequest("parameter_set is one of %s" % list(PARAMETER_SETS))
    if not 0 < float(req.get("duration_ms", 0)) <= MAX_DURATION_MS:
        raise BadRequest("duration_ms in (0, %g]" % MAX_DURATION_MS)
    if not 0.01 <= float(req.get("dt_ms", 0.05)) <= 1.0:
        raise BadRequest("dt_ms in [0.01, 1]")
    for k, v in (req.get("param_overrides") or {}).items():
        if not isinstance(v, str):
            raise BadRequest("param_overrides[%r] is a string with its unit" % k)


def wiring(req):
    """The connections among the cells of a network, as c302 reads them: chemical (with the transmitter of the presynaptic
    cell, which sets its sign: GABA inhibits) or gap junctions, and the number of contacts (the connection's weight). Each
    is named as the simulation's changes name it: "PRE-POST", or "PRE-POST_GJ" for a gap junction."""
    import c302
    known, conns = c302.get_cell_names_and_connection(c302.DEFAULT_DATA_READER)
    cells = req.get("cells") or sorted(known)
    unknown = sorted(set(cells) - set(known))
    if unknown:
        raise BadRequest("unknown cells: %s" % unknown)
    inside = set(cells)
    out = []
    for c in conns:
        if c.pre_cell in inside and c.post_cell in inside:
            gap = "_GJ" in c.synclass
            out.append({"name": "%s-%s%s" % (c.pre_cell, c.post_cell, "_GJ" if gap else ""), "pre": c.pre_cell, "post": c.post_cell, "kind": "gap_junction" if gap else "chemical",
                        "neurotransmitter": None if gap else c.synclass, "number": c.number})
    return {"cells": sorted(inside), "connections": out}


def simulate(req):
    import c302
    import numpy as np
    import neuroml.writers as writers
    from neuroml import SineGenerator
    from pyneuroml import pynml

    known, _ = c302.get_cell_names_and_connection(c302.DEFAULT_DATA_READER)
    check(req, known)
    params = importlib.import_module("c302.parameters_" + str(req.get("parameter_set", "C1"))).ParameterisedModel()
    dt, duration = float(req.get("dt_ms", 0.05)), float(req["duration_ms"])
    work = Path(tempfile.mkdtemp(prefix="c302svc_"))
    try:
        t0 = time.time()
        doc = c302.generate(
            "net", params, cells=req.get("cells"), cells_to_stimulate=[], muscles_to_include=[],
            conns_to_exclude=list(req.get("remove_connections") or []),
            conn_number_scaling={k: float(v) for k, v in (req.get("connection_number_scaling") or {}).items()} or None,
            conn_polarity_override=req.get("connection_polarity_override") or None,
            param_overrides=req.get("param_overrides") or {},
            duration=duration, dt=dt, target_directory=str(work), verbose=False)
        net = doc.networks[0]
        n_connections = len(net.projections) + len(net.electrical_projections) + len(net.continuous_projections)
        for s in req.get("stimuli") or []:
            delay, length, amp = "%gms" % float(s["delay_ms"]), "%gms" % float(s["duration_ms"]), "%gpA" % float(s["amplitude_pa"])
            if s.get("kind", "pulse") == "pulse":
                c302.add_new_input(doc, s["cell"], delay, length, amp, params)
            else:
                k = 1 + sum(1 for g in doc.sine_generators if g.id.startswith("sine_%s_" % s["cell"]))
                gen = SineGenerator(id="sine_%s_%d" % (s["cell"], k), delay=delay, duration=length, amplitude=amp,
                                    period="%gms" % float(s["period_ms"]), phase=str(float(s.get("phase_rad", 0.0))))
                doc.sine_generators.append(gen)
                c302.append_input_to_nml_input_list(gen, doc, s["cell"], params)
        writers.NeuroMLWriter.write(doc, str(work / "net.net.nml"))
        res = pynml.run_lems_with_jneuroml("LEMS_net.xml", exec_in_dir=str(work), max_memory="4G", nogui=True,
                                           load_saved_data=True, verbose=False, exit_on_fail=False)
        if not isinstance(res, dict):
            return {"error": "the simulation did not complete (an unstable integration: a smaller dt_ms often helps)", "bad_request": False}
        step = max(int(round(float(req.get("save_every_ms", 5.0)) / dt)), 1)
        t = (np.asarray(res["t"], dtype=float) * 1000.0)[::step]
        calcium = {k.split("/")[0]: np.asarray(v, dtype=float)[::step] for k, v in res.items() if k.endswith("/caConc")}
        record = req.get("record") or sorted(calcium)
        return {"t": [round(float(x), 6) for x in t], "calcium": {c: [float("%.9g" % x) for x in calcium[c]] for c in record if c in calcium},
                "cells": sorted(calcium), "n_connections": n_connections, "seconds": round(time.time() - t0, 1)}
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    try:
        request = json.loads(sys.stdin.read())
        answer = wiring(request) if request.get("wiring") else simulate(request)
    except BadRequest as e:
        answer = {"error": str(e), "bad_request": True}
    except Exception as e:  # anything else is the service's, not the request's
        answer = {"error": "%s: %s" % (type(e).__name__, e), "bad_request": False}
    sys.stdout.write("\n@@C302@@" + json.dumps(answer))
    sys.stdout.flush()
