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
import hashlib


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def sha_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def loaded_identity(job, chat=None):
    """What this worker loaded, by digest: the tokenizer and chat template it reads, the firmware it runs, the driver it
    imported, the circuit's configuration and the precision of the weights - checked by the server against the package."""
    files = job["files"]
    drv = files["driver"]
    if os.path.isdir(drv):
        driver = {}
        for d, _, names in os.walk(drv):
            for n in names:
                full = os.path.join(d, n)
                driver[os.path.relpath(full, drv).replace(os.sep, "/")] = sha_file(full)
    else:
        driver = sha_file(drv)
    template = chat.tok.chat_template if chat is not None else open(files["chat_template"], encoding="utf8").read()
    meta_file = os.path.join(files["base"], "chipformer.json")
    circuit = chat.meta if chat is not None else (json.load(open(meta_file)) if os.path.exists(meta_file) else None)
    precision = None
    if chat is not None:
        precision = {"torch.bfloat16": "bf16", "torch.float16": "fp16", "torch.float32": "fp32"}.get(str(next(chat.model.parameters()).dtype), str(next(chat.model.parameters()).dtype))
    return {"tokenizer": sha_file(os.path.join(files["base"], "tokenizer.json")), "chat_template": hashlib.sha256(template.encode("utf8")).hexdigest(),
            "firmware": sha_file(files["firmware"]), "driver": driver, "circuit": circuit, "precision": precision}


def load_driver(path):
    """The package's driver, imported from its own folder: a chipformer imported from anywhere else is not its driver."""
    if path not in sys.path:
        sys.path.insert(0, path)
    import chipformer
    where = os.path.realpath(os.path.dirname(chipformer.__file__))
    if not where.startswith(os.path.realpath(path)):
        raise RuntimeError("the driver imported is " + where + ", not the package's")


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
        wanted = float(user.split("sleep", 1)[1].split()[0])
        budget = job["limits"]["timeout_ms"] / 1000.0
        time.sleep(min(wanted, budget))
        if wanted > budget:
            # Its own time ran out: what it emitted is kept and measured, the memory before it stays.
            return {"terminal": "limit_reached", "text": text[:3], "trace": json.dumps({"fake": user}), "ops": [], "after": None,
                    "usage": {"prompt_tokens": len(user), "text_tokens": 3, "circuit_tokens": 0, "gpu_ms": int(budget * 1000)}, "reason": "timeout"}
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


class TimeLimit(Exception):
    """The declared time of an answer reached (§5.1): a limit of the junior, never a failure of the worker."""


def apply_adapter(chat, adapter_dir, chip_layers):
    """A LoRA adapter added into Qwen's weights in place (W += alpha/r * B A), never into the circuit's layers."""
    import torch
    from safetensors.torch import load_file
    cfg = json.load(open(os.path.join(adapter_dir, "adapter_config.json")))
    sd = load_file(os.path.join(adapter_dir, "adapter_model.safetensors"))
    scale = float(cfg["lora_alpha"]) / float(cfg["r"])
    for key, A in sd.items():
        if ".lora_A." not in key:
            continue
        name = key.replace("base_model.model.", "").split(".lora_A.")[0]
        parts = name.split(".")
        layer = int(parts[parts.index("layers") + 1]) if "layers" in parts else None
        if layer is None or layer < chip_layers:
            raise RuntimeError("the adapter reaches the circuit: " + name)
        B = sd[key.replace(".lora_A.", ".lora_B.")]
        W = chat.model.get_submodule(name).weight
        with torch.no_grad():
            W.add_((scale * (B.float() @ A.float())).to(W.dtype).to(W.device))


def qwenputer_chat(job):
    load_driver(job["files"]["driver"])
    from chipformer.rv.chat import RvChat
    if _resident["execution"] != job["execution"]:
        _resident["chat"] = None
        _resident["execution"] = None
        chat = RvChat(job["files"]["base"])
        # The package's chat template, in place of the checkpoint's.
        chat.tok.chat_template = open(job["files"]["chat_template"], encoding="utf8").read()
        if job["files"].get("adapter"):
            apply_adapter(chat, job["files"]["adapter"], int(chat.meta["chip_layers"]))
        _resident["chat"] = chat
        _resident["execution"] = job["execution"]
    return _resident["chat"]


def circuit_digest(chat):
    """The digest of the compiled layers' parameters as served: the same for a child whose training never reached them."""
    chip = int(chat.meta["chip_layers"])
    h = hashlib.sha256()
    for name, p in sorted(chat.model.named_parameters(), key=lambda x: x[0]):
        parts = name.split(".")
        if "layers" in parts and int(parts[parts.index("layers") + 1]) < chip:
            h.update(name.encode("utf8"))
            h.update(p.detach().float().cpu().numpy().tobytes())
    return h.hexdigest()


VALIDITY_TASKS = [
    ("calc", "Use calc: what is 123456789 * 987654321?"),
    ("put", "Save a file named suite1 with the text alpha beta, using put."),
    ("get", "Read the file named suite1 with get and tell me its text."),
    ("delete", "Delete the file named suite1."),
]


def validity(job):
    """The circuit's suite (§10.1): each task generated under the reference lock; a task counts as exercised only when the
    reference saw the operation; any token where the circuit and the reference differ is a mismatch. The memory of each
    task is the one the task before left, saved and loaded again (the restore exercised)."""
    if job["backend"] == "fake":
        touches = False
        if job["files"].get("adapter"):
            touches = json.load(open(os.path.join(job["files"]["adapter"], "adapter_config.json"))).get("touches_circuit", False)
        return {"exercised": {"calc": True, "put": True, "get": True, "delete": True, "restore": True}, "mismatches": 0,
                "circuit_digest": hashlib.sha256(b"fake-circuit" + (b"-touched" if touches else b"")).hexdigest(), "details": []}
    from chipformer.rv import bridge as BR, elf, ref
    from chipformer.rv import store as ST
    from chipformer.rv.chat import CALC_TOOL, load_store_file, save_store_file
    import tempfile
    chat = qwenputer_chat(job)
    exercised = {"calc": False, "put": False, "get": False, "delete": False, "restore": False}
    mismatches, details, dev, snap = 0, [], None, None
    tmp = tempfile.mkdtemp()
    for i, (kind, ask) in enumerate(VALIDITY_TASKS):
        m = ref.Machine.from_program(elf.program(job["files"]["firmware"])); BR.park(m)
        m2 = ref.Machine.from_program(elf.program(job["files"]["firmware"])); BR.park(m2)
        ids = chat.prompt_ids([{"role": "system", "content": ST.MEM_SYSTEM}, {"role": "user", "content": ask}], (CALC_TOOL, *ST.TOOLS))
        if snap is not None:
            path = os.path.join(tmp, "m%d.npz" % i)
            save_store_file(path, snap)
            chat.store_snap = load_store_file(path)
            exercised["restore"] = True
        else:
            chat.store_snap = None
        lock = ST.StoreSession(chat.T, m2, chat.store_cfg, dev=copy.deepcopy(dev) if dev is not None else None)
        lock.history(ids)
        r = chat.generate(ids, m, 400, lock=lock)
        ops = [a[0] if isinstance(a, (list, tuple)) else a for a in lock.answers]
        if kind == "calc" and getattr(lock, "runs", None):
            exercised["calc"] = True
        if kind in ops:
            exercised[kind] = True
        if r.get("lock_error") is not None:
            mismatches += 1
        details.append({"task": kind, "ops": [str(o) for o in ops], "lock_error": r.get("lock_error")})
        dev, snap = lock.dev, chat.save_store()
    return {"exercised": exercised, "mismatches": mismatches, "circuit_digest": circuit_digest(chat), "details": details}


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

    started = time.time()
    deadline = started + job["limits"]["timeout_ms"] / 1000.0

    def timed(qids, *a, **k):
        # The declared time is the worker's own limit: past it the generation stops where it is, a measured end.
        if time.time() > deadline:
            raise TimeLimit()
        return recorded(qids, *a, **k)

    lock.qwen = timed
    try:
        r = chat.generate(ids, m, job["limits"]["max_tokens"], max_chip=job["limits"]["max_circuit_tokens"], lock=lock)
    except TimeLimit:
        emitted = [int(q) for call in fed for q in call["qids"]]
        trace = json.dumps({"prompt_ids": [int(i) for i in ids], "tokens": emitted, "fed": fed, "stream": [int(t) for t in lock.toks], "lock_error": None, "timeout": True})
        return {"terminal": "limit_reached", "text": chat.text_of(emitted), "trace": trace, "ops": [list(a) if isinstance(a, tuple) else a for a in lock.answers],
                "after": None, "reason": "timeout",
                "usage": {"prompt_tokens": len(ids), "text_tokens": len(emitted), "circuit_tokens": 0, "gpu_ms": int((time.time() - started) * 1000)}}
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


def memory_call(job):
    """One memory operation on a copy of a twin (§8: the teacher's memory tools): the answer the circuit would print, and
    the twin after. fake: the toy's JSON map. qwenputer: the store's reference session started from the twin, the call
    made with StoreSession.call(op, name, text), its printed body decoded with the package's tokenizer."""
    import base64
    raw = base64.b64decode(job["twin"]) if job.get("twin") else None
    c = job["call"]
    op, name, text = c["op"], c.get("name"), c.get("text")
    if job["backend"] == "fake":
        mem = json.loads(raw.decode("utf8")) if raw else {}
        if op == "put":
            mem[name] = text; result = "ok"
        elif op == "append":
            mem[name] = mem.get(name, "") + text; result = "ok"
        elif op == "get":
            result = mem.get(name, "not found")
        elif op == "list":
            result = "\n".join(mem.keys()) if mem else "empty"
        else:
            result = "ok" if mem.pop(name, None) is not None else "not found"
        twin = json.dumps(mem, sort_keys=True, separators=(",", ":")).encode("utf8")
        return {"result": result, "twin": base64.b64encode(twin).decode("ascii")}
    from chipformer.rv import bridge as BR, elf, ref
    from chipformer.rv import store as ST
    dev = pickle.loads(raw) if raw else None
    m = ref.Machine.from_program(elf.program(job["files"]["firmware"]))
    BR.park(m)
    T = BR.Text(os.path.join(job["files"]["base"], "tokenizer.json"))
    sess = ST.StoreSession(T, m, ST.Config(**(job["circuit"] or {}).get("store", {})), dev=copy.deepcopy(dev) if dev is not None else None)
    start = len(sess.toks)
    sess.call(op, name or "", text or "")
    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(job["files"]["base"])
    bodies = sess.printed(start)
    last = bodies[-1] if bodies else []
    result = last if isinstance(last, str) else tok.decode([int(t) for t in last])
    return {"result": result, "twin": base64.b64encode(pickle.dumps(sess.dev, protocol=4)).decode("ascii")}


def render(job):
    """A memory read as files (§4): from its reference twin, name to text."""
    import base64
    raw = base64.b64decode(job["twin"]) if job.get("twin") else None
    if job["backend"] == "fake":
        return json.loads(raw.decode("utf8")) if raw else {}
    if raw is None:
        return {}
    dev = pickle.loads(raw)
    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(job["files"]["base"])
    files = {}
    # Device.names(): the live names in creation order; Device.text(key): a live file's tokens (chipformer.rv.store).
    for name in dev.names():
        tokens = [int(t) for t in (name if isinstance(name, (list, tuple)) else [name])]
        text = dev.text(name)
        files[tok.decode(tokens)] = tok.decode([int(t) for t in text])
    return files


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
            if job.get("op") == "validity":
                emit({"validity": validity(job), "id": job["id"]})
                continue
            if job.get("op") == "memory_call":
                emit({**memory_call(job), "id": job["id"]})
                continue
            if job.get("op") == "render":
                emit({"files": render(job), "id": job["id"]})
                continue
            if job.get("op") == "probe":
                out = {"probe": probe(job)}
                emit({**out, "id": job["id"]})
                continue
            out = BACKENDS[job["backend"]](job)
            # What it loaded, said by digest: the server checks it against the package (it never takes this hash back).
            out["loaded"] = loaded_identity(job, _resident["chat"] if job["backend"] == "qwenputer" else None)
            out["served"] = job["execution"]
        except Exception as e:  # the worker failed: never an answer of the junior
            out = {"terminal": "infra_failed", "text": "", "trace": "", "ops": [], "after": None, "usage": None,
                   "served": _resident["execution"] or job["execution"], "reason": type(e).__name__ + ": " + str(e)}
        out["id"] = job["id"]
        emit(out)


if __name__ == "__main__":
    main()
