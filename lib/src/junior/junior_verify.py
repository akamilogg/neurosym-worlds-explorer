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
    return {"twin_after": base64.b64encode(pickle.dumps(lock.dev, protocol=4)).decode("ascii"), "ops": ops, "neural": neural_check(inp, lock.dev, cfg, args)}


def read_snapshot(b64):
    """A store snapshot (memory.npz) from its bytes, as the driver reads it; None when there is none."""
    import tempfile
    from chipformer.rv.chat import load_store_file
    if not b64:
        return None
    path = os.path.join(tempfile.mkdtemp(), "snap.npz")
    with open(path, "wb") as f:
        f.write(base64.b64decode(b64))
    return load_store_file(path)


def rows_equal(a, b):
    try:
        import numpy as np
        return np.array_equal(np.asarray(a), np.asarray(b))
    except ImportError:
        return list(a) == list(b)


def snapshot_diff(want, got):
    """Where two store snapshots differ: heads, value heads, rows, values. Empty: the same memory, value by value."""
    out = []
    if set(want) != set(got):
        return ["heads %s against %s" % (sorted(want), sorted(got))]
    for head in sorted(want):
        if len(want[head]) != len(got[head]):
            out.append(head + ": %d value heads against %d" % (len(want[head]), len(got[head])))
            continue
        for x, (w, g) in enumerate(zip(want[head], got[head])):
            if set(map(int, w)) != set(map(int, g)):
                out.append("%s[%d]: rows %s against %s" % (head, x, sorted(map(int, w)), sorted(map(int, g))))
                continue
            for r in w:
                if not rows_equal(w[r], g[int(r)] if int(r) in g else g[r]):
                    out.append("%s[%d] row %s differs" % (head, x, r))
    return out


def circuit_state(inp, args):
    """The store's state after the answer as the compiled circuit computes it - its executor, never Qwen's layers - from
    the state published before it and the recorded stream, the way chipformer.rv.storecheck checks its store: reset
    (core.snapshot), the memory before loaded (load_store), the prompt started, every token after it stepped (as model
    ids), the rows read (save_store of the executor). It needs the package's checkpoint (the circuit is built from its
    configuration and its token embeddings) and a GPU: without them, None and why."""
    if not args.base:
        return None, "no --base: the circuit is built from the package's checkpoint"
    try:
        import torch
        if not torch.cuda.is_available():
            return None, "no GPU: the circuit's executor runs on CUDA"
    except ImportError:
        return None, "no torch: the circuit's executor runs on CUDA"
    from chipformer.rv import bridge as BR, core, elf, ref
    from chipformer.rv import spec as S
    chat = _chat_of(args.base)
    if getattr(chat, "erow", None) is None:
        return None, "the checkpoint built no executor"
    trace = json.loads(inp["trace"])
    ids, stream = [int(i) for i in trace["prompt_ids"]], [int(t) for t in trace["stream"]]
    m = ref.Machine.from_program(elf.program(args.firmware))
    BR.park(m)
    core.snapshot(chat.c, m)
    chat.load_store(read_snapshot(inp.get("neural_before")))
    chat.erow.start(ids)
    for t in stream[len(ids):]:
        chat.erow.step(t + chat.v0 if t < S.VOCAB else t - S.TEXT_TOKEN)
    return chat.save_store(("exec", chat.erow)), None


_chats = {}


def _chat_of(base):
    from chipformer.rv.chat import RvChat
    if base not in _chats:
        _chats[base] = RvChat(base, executor=True)
    return _chats[base]


def neural_check(inp, dev, cfg, args=None):
    """The neural snapshot published after the answer (memory.npz) against its twin. Refused when it is not readable as
    the store's or its rows contradict its twin. The SAME memory, value by value, when the circuit's own executor, run on
    the recorded stream from the state before, leaves exactly its rows (circuit_state) - the stream itself was rebuilt by
    the reference from the twin, so a snapshot equal to the circuit's is its twin's memory. Where the circuit cannot be
    run here (no checkpoint or no GPU) it is `checked: false`: the verification is incomplete, never ok."""
    if not inp.get("neural_after"):
        return {"ok": False, "why": "no neural snapshot"}
    try:
        snap = read_snapshot(inp["neural_after"])
    except Exception as e:
        return {"ok": False, "why": "not a store snapshot: " + type(e).__name__ + ": " + str(e)}
    if not isinstance(snap, dict):
        return {"ok": False, "why": "not a store snapshot"}
    rows = sum(len(r) for heads in snap.values() for r in heads)
    live = len(list(dev.names())) if dev is not None else 0
    if (rows == 0) != (live == 0):
        return {"ok": False, "why": "its rows (%d) do not match its twin's live files (%d)" % (rows, live)}
    if args is None:
        return {"ok": False, "checked": False, "why": "the circuit was not run"}
    try:
        state, why = circuit_state(inp, args)
    except Exception as e:
        return {"ok": False, "checked": False, "why": "the circuit could not be run: " + type(e).__name__ + ": " + str(e)}
    if state is None:
        return {"ok": False, "checked": False, "why": "readable and not contradicting its twin; not compared with the circuit's own state: " + why}
    diff = snapshot_diff(state, snap)
    if diff:
        return {"ok": False, "why": "its rows are not those the circuit leaves: " + "; ".join(diff[:5])}
    return {"ok": True}


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
    ap.add_argument("--base", help="the package's checkpoint (materialized): the circuit is built from it to check the neural snapshot")
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
