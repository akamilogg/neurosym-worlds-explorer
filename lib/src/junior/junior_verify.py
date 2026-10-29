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
    """The neural snapshot published after the answer (memory.npz): readable as the store's snapshot, with one entry per
    persistent head of the store, and holding rows exactly when its twin holds live files - an empty store's snapshot is
    empty, a store with files is not. The finer correspondence of rows to the twin's chunks is confirmed with the real
    driver (MA1's run on the junior's machine)."""
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
    return {"ok": True}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", required=True, choices=["fake", "qwenputer"])
    ap.add_argument("--firmware")
    ap.add_argument("--tokenizer")
    args = ap.parse_args()
    inp = json.loads(sys.stdin.read())
    try:
        out = fake(inp) if args.backend == "fake" else qwenputer(inp, args)
    except Exception as e:
        out = {"error": type(e).__name__ + ": " + str(e)}
    sys.stdout.write(json.dumps(out) + "\n")


if __name__ == "__main__":
    main()
