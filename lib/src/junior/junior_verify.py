"""The reference verifier of a junior's memory (SPEC-METAPOLITICA-APRENDIZAJE §5.2), the package's own program.

Given on stdin {"twin_before": base64 | null, "content", "trace", "circuit"}, it rebuilds the memory after one answer
without the model: it answers on stdout {"twin_after": base64 | null, "ops"} or {"error"}.

  fake       the toy of junior_worker.py.
  qwenputer  a reference store session (chipformer.rv.store.StoreSession) started from the twin before, the prompt given
             as history, then exactly the calls the driver made to it while it answered (the trace's `fed`). Its stream
             must be the one recorded; its device, pickled, is the twin after.

Usage: junior_verify.py --backend fake|qwenputer [--firmware path] [--tokenizer path/to/tokenizer.json]
"""
import argparse
import base64
import os
import sys as _sys
_sys.dont_write_bytecode = True
import copy
import json
import pickle
import sys


def fake(inp):
    mem = json.loads(base64.b64decode(inp["twin_before"]).decode("utf8")) if inp["twin_before"] else {}
    user = json.loads(inp["trace"])["fake"]
    ops = []
    for line in user.splitlines():
        line = line.strip()
        if line.startswith("remember ") and "=" in line:
            k, v = line[len("remember "):].split("=", 1)
            mem[k.strip()] = v.strip()
            ops.append({"op": "put", "name": k.strip(), "result": "ok"})
    twin = json.dumps(mem, sort_keys=True, separators=(",", ":")).encode("utf8")
    neural = base64.b64decode(inp["neural_after"]) if inp.get("neural_after") else None
    # The toy's neural snapshot is its twin marked: anything else is not the memory its twin is.
    ok = neural == b"neural:" + twin
    return {"twin_after": base64.b64encode(twin).decode("ascii"), "ops": ops,
            "neural": {"ok": ok, **({} if ok else {"why": "the neural snapshot is not the toy store of its twin"})}}


def qwenputer(inp, args):
    from chipformer.rv import bridge as BR, elf, ref
    from chipformer.rv import store as ST
    trace = json.loads(inp["trace"])
    dev = pickle.loads(base64.b64decode(inp["twin_before"])) if inp["twin_before"] else None
    cfg = ST.Config(**(inp["circuit"] or {}).get("store", {}))
    m2 = ref.Machine.from_program(elf.program(args.firmware))
    BR.park(m2)
    text = BR.Text(args.tokenizer)  # tokenizer.json, as RvChat builds its T: no weights needed
    lock = ST.StoreSession(text, m2, cfg, dev=copy.deepcopy(dev) if dev is not None else None)
    lock.history(trace["prompt_ids"])
    for call in trace["fed"]:
        lock.qwen(call["qids"], *call["args"], **call["kwargs"])
    if [int(t) for t in lock.toks] != trace["stream"]:
        return {"error": "the reference stream differs from the one recorded"}
    ops = [list(a) if isinstance(a, tuple) else a for a in lock.answers]
    return {"twin_after": base64.b64encode(pickle.dumps(lock.dev, protocol=4)).decode("ascii"), "ops": ops, "neural": neural_check(inp, lock.dev, cfg)}


def neural_check(inp, dev, cfg):
    """The neural snapshot published after the answer (memory.npz) against its twin. What can be refused here is refused:
    a snapshot that is not readable as the store's, or whose rows contradict its twin (rows with no live file, none with
    some). What would make it the SAME memory - its rows, value by value, those the store's writes of the twin's files make
    - has no offline mapping yet: so it is never answered ok, only `checked: false`, and the session's verification is
    incomplete until that mapping exists."""
    import tempfile
    from chipformer.rv.chat import load_store_file
    if not inp.get("neural_after"):
        return {"ok": False, "why": "no neural snapshot"}
    path = os.path.join(tempfile.mkdtemp(), "after.npz")
    with open(path, "wb") as f:
        f.write(base64.b64decode(inp["neural_after"]))
    try:
        snap = load_store_file(path)
    except Exception as e:
        return {"ok": False, "why": "not a store snapshot: " + type(e).__name__ + ": " + str(e)}
    if not isinstance(snap, dict):
        return {"ok": False, "why": "not a store snapshot"}
    rows = sum(len(r) for heads in snap.values() for r in heads)
    live = len(list(dev.names())) if dev is not None else 0
    if (rows == 0) != (live == 0):
        return {"ok": False, "why": "its rows (%d) do not match its twin's live files (%d)" % (rows, live)}
    return {"ok": False, "checked": False, "why": "readable and not contradicting its twin; its equivalence to the twin's files is not checked (no offline mapping from the twin to the store's rows)"}


def load_driver(path):
    """The package's driver, imported from its own folder before anything of chipformer is."""
    if not path or not os.path.isdir(path):
        raise RuntimeError("--driver: the package's driver folder is needed")
    sys.path.insert(0, path)
    import chipformer
    if not os.path.realpath(os.path.dirname(chipformer.__file__)).startswith(os.path.realpath(path)):
        raise RuntimeError("the driver imported is not the package's")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", required=True, choices=["fake", "qwenputer"])
    ap.add_argument("--firmware")
    ap.add_argument("--tokenizer")
    ap.add_argument("--driver")
    args = ap.parse_args()
    inp = json.loads(sys.stdin.read())
    try:
        if args.backend == "qwenputer":
            # The package's driver first: nothing of chipformer is imported before its path is set.
            load_driver(args.driver)
        out = fake(inp) if args.backend == "fake" else qwenputer(inp, args)
    except Exception as e:
        out = {"error": type(e).__name__ + ": " + str(e)}
    sys.stdout.write(json.dumps(out) + "\n")


if __name__ == "__main__":
    main()
