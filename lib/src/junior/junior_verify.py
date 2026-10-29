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
    return {"twin_after": base64.b64encode(json.dumps(mem, sort_keys=True, separators=(",", ":")).encode("utf8")).decode("ascii"), "ops": ops}


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
    return {"twin_after": base64.b64encode(pickle.dumps(lock.dev, protocol=4)).decode("ascii"), "ops": ops}


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
