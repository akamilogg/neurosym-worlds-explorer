"""The junior's worker (SPEC-METAPOLITICA-APRENDIZAJE §5): one long-lived process that keeps a model resident and answers
one question at a time. It keeps no session: every job carries the files of its package and of the memory to start from,
and the worker answers the text, its trace and the memory after, written to files the server stores by their hash.

Protocol: one JSON object per line on stdin, one per line on stdout, each answer naming the id of its job.

  {"id", "execution", "backend", "files": {"base", "adapter", "firmware"}, "circuit", "prompt", "decoding",
   "memory": {"neural": path | null, "twin": path | null}, "content": {"system", "user"}, "limits", "seed", "out"}
  -> {"id", "served", "terminal", "text", "trace", "ops", "after": {"neural", "twin"} | null, "usage", "reason"}

Backends:
  fake       a toy for the harness's tests: its memory is a JSON map; `remember K=V` in the question writes it.
  qwenputer  the Qwenputer driver (chipformer.rv): greedy decoding, the store's reference session locked token by token
             against the circuit, started from the twin of the memory loaded. Every call the driver makes to that
             reference session is recorded in the trace, so the verifier replays exactly those calls (junior_verify.py).

The qwenputer backend has not been run against the real checkpoint yet: MA1 closes with that run on the junior's machine.
"""
import json
import os
import sys
import time
import pickle
import copy


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def text_of_user(user):
    if isinstance(user, str):
        return user
    if isinstance(user, dict) and isinstance(user.get("parts"), list):
        return "\n\n".join(p if isinstance(p, str) else json.dumps(p) for p in user["parts"])
    return json.dumps(user)


def system_of(job, extra=None):
    parts = [p for p in (extra, job.get("prompt") or "", (job.get("content") or {}).get("system") or "") if p]
    return "\n\n".join(parts)


# --- fake -------------------------------------------------------------------------------------------------------------

def run_fake(job):
    mem = {}
    if job["memory"]["twin"]:
        with open(job["memory"]["twin"], "rb") as f:
            mem = json.loads(f.read().decode("utf8"))
    user = text_of_user(job["content"].get("user"))
    ops = []
    for line in user.splitlines():
        line = line.strip()
        if line.startswith("remember ") and "=" in line:
            k, v = line[len("remember "):].split("=", 1)
            mem[k.strip()] = v.strip()
            ops.append({"op": "put", "name": k.strip(), "result": "ok"})
    text = "ok " + json.dumps(sorted(mem.items()))
    if "sleep" in user:
        time.sleep(float(user.split("sleep", 1)[1].split()[0]))
    if "overflow" in user or len(text) > job["limits"]["max_tokens"]:
        return {"terminal": "limit_reached", "text": text[: job["limits"]["max_tokens"]], "trace": json.dumps({"fake": user}),
                "ops": [], "after": None, "usage": {"prompt_tokens": len(user), "text_tokens": job["limits"]["max_tokens"], "circuit_tokens": 0, "gpu_ms": 0},
                "reason": "max_tokens"}
    twin = json.dumps(mem, sort_keys=True, separators=(",", ":")).encode("utf8")
    out = job["out"]
    with open(os.path.join(out, "twin"), "wb") as f:
        f.write(twin)
    with open(os.path.join(out, "neural"), "wb") as f:
        f.write(b"neural:" + twin)
    return {"terminal": "answered", "text": text, "trace": json.dumps({"fake": user}), "ops": ops,
            "after": {"neural": os.path.join(out, "neural"), "twin": os.path.join(out, "twin")},
            "usage": {"prompt_tokens": len(user), "text_tokens": len(text), "circuit_tokens": 0, "gpu_ms": 0}}


# --- qwenputer --------------------------------------------------------------------------------------------------------

_resident = {"execution": None, "chat": None}


def qwenputer_chat(job):
    from chipformer.rv.chat import RvChat
    if _resident["execution"] != job["execution"]:
        _resident["chat"] = None
        _resident["execution"] = None
        if job["files"].get("adapter"):
            raise RuntimeError("unsupported: adapters are served from MA5 on")
        _resident["chat"] = RvChat(job["files"]["base"])
        _resident["execution"] = job["execution"]
    return _resident["chat"]


def run_qwenputer(job):
    from chipformer.rv import bridge as BR, elf, ref
    from chipformer.rv import store as ST
    from chipformer.rv.chat import CALC_TOOL, load_store_file, save_store_file
    if job["decoding"]["temperature"] != 0:
        raise RuntimeError("unsupported: the driver decodes greedily (temperature 0)")
    if job["decoding"].get("forced_format"):
        raise RuntimeError("unsupported: a forced format")
    chat = qwenputer_chat(job)
    if chat.store_cfg is None:
        raise RuntimeError("unsupported: a checkpoint without its store")
    m = ref.Machine.from_program(elf.program(job["files"]["firmware"]))
    BR.park(m)
    msgs = [{"role": "system", "content": system_of(job, ST.MEM_SYSTEM)},
            {"role": "user", "content": text_of_user(job["content"].get("user"))}]
    ids = chat.prompt_ids(msgs, (CALC_TOOL, *ST.TOOLS))
    chat.store_snap = load_store_file(job["memory"]["neural"]) if job["memory"]["neural"] else None
    dev = None
    if job["memory"]["twin"]:
        with open(job["memory"]["twin"], "rb") as f:
            dev = pickle.load(f)
    m2 = ref.Machine.from_program(elf.program(job["files"]["firmware"]))
    BR.park(m2)
    # The reference starts from the twin of the memory loaded: the lock holds for a preloaded store too.
    lock = ST.StoreSession(chat.T, m2, chat.store_cfg, dev=copy.deepcopy(dev) if dev is not None else None)
    lock.history(ids)
    fed = []
    original = lock.qwen

    def recorded(qids, *a, **k):
        fed.append({"qids": [int(q) for q in qids], "args": list(a), "kwargs": k})
        return original(qids, *a, **k)

    lock.qwen = recorded
    started = time.time()
    r = chat.generate(ids, m, job["limits"]["max_tokens"], max_chip=job["limits"]["max_circuit_tokens"], lock=lock)
    gpu_ms = int((time.time() - started) * 1000)
    tokens = [int(t) for t in r["tokens"]]
    text = chat.text_of(tokens)
    eos = bool(tokens) and tokens[-1] in chat.eos
    trace = json.dumps({"prompt_ids": [int(i) for i in ids], "tokens": tokens, "fed": fed,
                        "stream": [int(t) for t in lock.toks], "lock_error": r.get("lock_error")})
    usage = {"prompt_tokens": len(ids), "text_tokens": int(r["text_tokens"]), "circuit_tokens": int(r["chip_tokens"]), "gpu_ms": gpu_ms}
    ops = [list(a) if isinstance(a, tuple) else a for a in lock.answers]
    if not eos:
        return {"terminal": "limit_reached", "text": text, "trace": trace, "ops": ops, "after": None, "usage": usage,
                "reason": "max_circuit_tokens" if r["chip_tokens"] >= job["limits"]["max_circuit_tokens"] else "max_tokens"}
    out = job["out"]
    save_store_file(os.path.join(out, "neural.npz"), chat.save_store())
    with open(os.path.join(out, "twin"), "wb") as f:
        pickle.dump(lock.dev, f, protocol=4)
    return {"terminal": "answered", "text": text, "trace": trace, "ops": ops,
            "after": {"neural": os.path.join(out, "neural.npz"), "twin": os.path.join(out, "twin")}, "usage": usage,
            "reason": None if r.get("lock_error") is None else "circuit_mismatch: " + json.dumps(r["lock_error"], default=str)}


BACKENDS = {"fake": run_fake, "qwenputer": run_qwenputer}


def probe(job):
    """The driver's resources measured, never assumed (§2, §11): for each context length, the peak GPU memory of one
    answer with the package's limits. A length that does not fit is reported as such, with its error."""
    if job["backend"] == "fake":
        return {"device": "fake", "lengths": [{"length": n, "ok": True, "peak_bytes": 1000 * n} for n in job["lengths"]]}
    import torch
    from chipformer.rv import bridge as BR, elf, ref
    chat = qwenputer_chat(job)
    out = []
    for n in job["lengths"]:
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()
        try:
            m = ref.Machine.from_program(elf.program(job["files"]["firmware"]))
            BR.park(m)
            filler = chat.prompt_ids([{"role": "user", "content": "x " * max(1, n // 2)}], ())
            started = time.time()
            r = chat.generate(filler[-n:] if len(filler) > n else filler, m, min(64, job["limits"]["max_tokens"]),
                              max_chip=job["limits"]["max_circuit_tokens"])
            out.append({"length": n, "ok": True, "peak_bytes": int(torch.cuda.max_memory_allocated()),
                        "seconds": round(time.time() - started, 3), "text_tokens": int(r["text_tokens"])})
        except Exception as e:
            out.append({"length": n, "ok": False, "peak_bytes": int(torch.cuda.max_memory_allocated()), "error": type(e).__name__ + ": " + str(e)})
    props = torch.cuda.get_device_properties(0)
    return {"device": props.name, "total_bytes": int(props.total_memory), "lengths": out}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        job = json.loads(line)
        try:
            if job.get("op") == "probe":
                out = {"probe": probe(job)}
                emit({**out, "id": job["id"]})
                continue
            out = BACKENDS[job["backend"]](job)
            out["served"] = job["execution"]
        except Exception as e:  # the worker failed: never an answer of the junior
            out = {"terminal": "infra_failed", "text": "", "trace": "", "ops": [], "after": None, "usage": None,
                   "served": _resident["execution"] or job["execution"], "reason": type(e).__name__ + ": " + str(e)}
        out["id"] = job["id"]
        emit(out)


if __name__ == "__main__":
    main()
